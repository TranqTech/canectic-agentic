import { BaseSubModule } from "./basesubmodule.js";
import { getActiveAnnouncements } from "../models/announcements.js";

// Default terminal colors (ANSI color numbers)
var TITLE_CLR = 14;       // bright cyan
var TITLE_BG = 4;          // blue background
var HEADING_CLR = 11;      // bright yellow
var PINNED_CLR = 13;       // bright magenta
var BODY_CLR = 6;          // cyan
var AUTHOR_CLR = 10;       // bright green
var SEPARATOR_CLR = 4;     // blue
var NAV_KEY_CLR = 11;      // bright yellow
var NAV_LABEL_CLR = 7;     // grey
var SCROLL_CLR = 11;       // bright yellow

class AnnouncementHandler extends BaseSubModule {
	constructor(call) {
		super(call, "Announcements");
		this.announcements = [];
		this.currentIdx = 0;
		this.bodyLines = [];
		this.bodyScroll = 0;
		this._atEnd = false;

		// Layout rows
		this._titleRow = 1;
		this._headingRow = 3;
		this._authorRow = 4;
		this._sepRow = 5;
		this._bodyTop = 6;
		this._navRow = 0;
		this._bodyHeight = 0;

		// Encoding detection
		var enc = (call.term_encoding || '').toLowerCase();
		this._isUTF8 = (enc === 'utf8' || enc === 'utf-8');

		this.loggingId = "Announcements (Node " + call.nodenum + ")";
	}

	// --- Encoding helper ---
	_sendGlyph(utf8Char, cp437Byte) {
		if (!this.call) return;
		if (this._isUTF8) {
			this.call.cmds.senddata(utf8Char);
		} else {
			this.call.cmds.senddata(Buffer.from([cp437Byte]));
		}
	}

	// Nav bar helpers: hotkey in bright yellow, label in grey
	_navKey(key, label) {
		this.call.cmds.setfgcolor(NAV_KEY_CLR);
		this.call.cmds.senddata(key);
		this.call.cmds.setfgcolor(NAV_LABEL_CLR);
		this.call.cmds.senddata(label + '  ');
	}

	// --- Geometry ---
	_calcPos() {
		this._navRow = this.call.term_height - 1;
		this._bodyHeight = this._navRow - this._bodyTop - 1;
	}

	// --- Word-wrap text, preserving ANSI escape sequences ---
	_wrapText(text, width) {
		if (!text) return [];
		var lines = [];
		var rawLines = text.split(/\r?\n/);
		for (var ri = 0; ri < rawLines.length; ri++) {
			var line = rawLines[ri];
			var visibleLen = line.replace(/\x1b\[[0-9;]*m/g, '').length;
			if (visibleLen <= width) {
				lines.push(line);
			} else {
				var words = line.split(' ');
				var current = '';
				var currentVisible = 0;
				for (var wi = 0; wi < words.length; wi++) {
					var wordVisible = words[wi].replace(/\x1b\[[0-9;]*m/g, '').length;
					var spaceNeeded = currentVisible > 0 ? 1 : 0;
					if (currentVisible + wordVisible + spaceNeeded > width && currentVisible > 0) {
						lines.push(current);
						current = words[wi];
						currentVisible = wordVisible;
					} else {
						current += (currentVisible > 0 ? ' ' : '') + words[wi];
						currentVisible += wordVisible + spaceNeeded;
					}
				}
				if (current.length > 0) lines.push(current);
			}
		}
		return lines;
	}

	// --- Build body lines for current announcement ---
	_buildBodyLines() {
		var ann = this.announcements[this.currentIdx];
		if (!ann) { this.bodyLines = []; return; }

		var width = this.dumb ? 79 : (this.call.term_width - 4);
		var bodyText = ann.body_text || '';
		this.bodyLines = this._wrapText(bodyText, width);
		this.bodyScroll = 0;
	}

	// --- Scroll indicators ---
	_drawSeparator() {
		if (this.dumb) return;
		var width = this.call.term_width - 4;

		// Top separator (below author)
		this.call.cmds.movecursor(2, this._sepRow);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(SEPARATOR_CLR);
		for (var i = 0; i < width; i++) {
			this._sendGlyph('\u2500', 0xC4);
		}

		// Bottom separator (above nav)
		this.call.cmds.movecursor(2, this._navRow - 1);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(SEPARATOR_CLR);
		for (var i = 0; i < width; i++) {
			this._sendGlyph('\u2500', 0xC4);
		}

		// Scroll indicators
		if (this.bodyScroll > 0) {
			this.call.cmds.movecursor(this.call.term_width - 3, this._sepRow);
			this.call.cmds.setfgcolor(SCROLL_CLR);
			this._sendGlyph('\u25B2', 0x1E); // up arrow
		}
		var maxScroll = Math.max(0, this.bodyLines.length - this._bodyHeight);
		if (this.bodyScroll < maxScroll) {
			this.call.cmds.movecursor(this.call.term_width - 3, this._navRow - 1);
			this.call.cmds.setfgcolor(SCROLL_CLR);
			this._sendGlyph('\u25BC', 0x1F); // down arrow
		}
		this.call.cmds.resetcolors();
	}

	// --- Body viewport ---
	_drawBodyViewport() {
		if (this.dumb) return;
		var startLine = this.bodyScroll;
		var endLine = Math.min(startLine + this._bodyHeight, this.bodyLines.length);

		for (var row = 0; row < this._bodyHeight; row++) {
			var lineIdx = startLine + row;
			this.call.cmds.movecursor(2, this._bodyTop + row);
			this.call.cmds.cleartoeol();
			if (lineIdx < endLine) {
				this.call.cmds.setfgcolor(BODY_CLR);
				this.call.cmds.senddata(this.bodyLines[lineIdx]);
				this.call.cmds.resetcolors();
			}
		}
	}

	// --- Scrolling ---
	_scrollUp(pages) {
		var amount = pages ? this._bodyHeight : 1;
		if (this.bodyScroll <= 0) return;
		this.bodyScroll = Math.max(0, this.bodyScroll - amount);
		this._drawBodyViewport();
		this._drawSeparator();
	}

	_scrollDown(pages) {
		var amount = pages ? this._bodyHeight : 1;
		var maxScroll = Math.max(0, this.bodyLines.length - this._bodyHeight);
		if (this.bodyScroll >= maxScroll) return false;
		this.bodyScroll = Math.min(maxScroll, this.bodyScroll + amount);
		this._drawBodyViewport();
		this._drawSeparator();
		return true;
	}

	// --- Display: ANSI ---
	_showAnnouncement() {
		if (this.dumb) {
			this._showAnnouncementDumb();
			return;
		}

		var ann = this.announcements[this.currentIdx];
		if (!ann) return;

		this.call.cmds.clearscreen();
		this.call.cmds.resetcolors();

		// Title bar
		var titleText = ' Announcements (' + (this.currentIdx + 1) + '/' + this.announcements.length + ') ';
		var titleX = Math.round(this.call.term_width / 2) - Math.round(titleText.length / 2);
		this.call.cmds.movecursor(titleX, this._titleRow);
		this.call.cmds.setbgcolor(TITLE_BG);
		this.call.cmds.setfgcolor(TITLE_CLR);
		this.call.cmds.senddata(titleText);
		this.call.cmds.resetcolors();

		// Announcement title
		this.call.cmds.movecursor(2, this._headingRow);
		if (ann.pinned) {
			this.call.cmds.setfgcolor(PINNED_CLR);
			this._sendGlyph('\u2022', 0xF9);
			this.call.cmds.senddata(' ');
		}
		this.call.cmds.setfgcolor(HEADING_CLR);
		this.call.cmds.senddata(ann.title);

		// Author line (left) and date (right-justified)
		this.call.cmds.movecursor(2, this._authorRow);
		this.call.cmds.setfgcolor(AUTHOR_CLR);
		this.call.cmds.senddata(ann.author_name || 'System');
		if (ann.created_at) {
			var d = new Date(ann.created_at);
			var months = ['January','February','March','April','May','June',
				'July','August','September','October','November','December'];
			var dateStr = months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
			var dateX = this.call.term_width - dateStr.length - 2;
			this.call.cmds.movecursor(dateX, this._authorRow);
			this.call.cmds.senddata(dateStr);
		}

		// Separators + body + nav
		this._drawSeparator();
		this._drawBodyViewport();
		this._drawNavBar();
	}

	_drawNavBar() {
		if (this.dumb) return;
		this.call.cmds.movecursor(2, this._navRow);
		this.call.cmds.cleartoeol();

		this.call.cmds.setfgcolor(NAV_KEY_CLR);
		this._sendGlyph('\u2191\u2193', 0x18);
		if (!this._isUTF8) this.call.cmds.senddata(Buffer.from([0x19]));
		this.call.cmds.setfgcolor(NAV_LABEL_CLR);
		this.call.cmds.senddata('Scroll  ');

		if (this.currentIdx > 0) {
			this.call.cmds.setfgcolor(NAV_KEY_CLR);
			this._sendGlyph('\u2190', 0x1B);
			this.call.cmds.setfgcolor(NAV_LABEL_CLR);
			this.call.cmds.senddata('Prev  ');
		}
		if (this.currentIdx < this.announcements.length - 1) {
			this.call.cmds.setfgcolor(NAV_KEY_CLR);
			this._sendGlyph('\u2192', 0x1A);
			this.call.cmds.setfgcolor(NAV_LABEL_CLR);
			this.call.cmds.senddata('Next  ');
		}

		this._navKey('Q', 'uit');
		this.call.cmds.resetcolors();
	}

	// --- Display: Dumb terminal ---
	_showAnnouncementDumb() {
		var ann = this.announcements[this.currentIdx];
		if (!ann) return;

		this.call.cmds.senddata('\r\n');
		this.call.cmds.senddata('=== Announcement ' + (this.currentIdx + 1) + '/' + this.announcements.length + ' ===\r\n');
		if (ann.pinned) this.call.cmds.senddata('[Pinned] ');
		this.call.cmds.senddata(ann.title + '\r\n');
		var authorPart = (ann.author_name || 'System');
		if (ann.created_at) authorPart += ' -- ' + new Date(ann.created_at).toLocaleDateString();
		this.call.cmds.senddata(authorPart + '\r\n');
		this.call.cmds.senddata('---\r\n');

		this._buildBodyLines();
		this._dumbLineIdx = 0;
		this._showDumbPage();
	}

	_showDumbPage() {
		var maxLines = 20;
		var endLine = Math.min(this._dumbLineIdx + maxLines, this.bodyLines.length);

		for (var i = this._dumbLineIdx; i < endLine; i++) {
			this.call.cmds.senddata(this.bodyLines[i] + '\r\n');
		}
		this._dumbLineIdx = endLine;

		if (endLine < this.bodyLines.length) {
			this.call.cmds.senddata('[More -- press Enter] ');
		} else if (this.currentIdx < this.announcements.length - 1) {
			this.call.cmds.senddata('[Enter for next, Q to continue] ');
		} else {
			this.call.cmds.senddata('[Press Enter to continue] ');
		}
	}

	// --- Input ---
	onKey(key) {
		if (this.dumb) {
			this._handleDumbInput();
			return;
		}

		if (this._atEnd) {
			// At end prompt — any key exits, except left arrow goes back
			if (key === 'LeftArrow') {
				this._prevAnnouncement();
			} else {
				this.finished = true;
			}
			return;
		}

		switch (key) {
			case 'UpArrow':
				this._scrollUp(false);
				return;
			case 'DownArrow':
				this._scrollDown(false);
				return;
			case 'PgUp':
				this._scrollUp(true);
				return;
			case 'PgDn':
				this._scrollDown(true);
				return;
			case 'LeftArrow':
				this._prevAnnouncement();
				return;
			case 'RightArrow':
				this._nextAnnouncement();
				return;
			case 'Enter':
				this._nextAnnouncement();
				return;
			case 'ESC':
				this.finished = true;
				return;
		}
	}

	onChar(ch) {
		if (this.dumb) {
			if (ch.toLowerCase() === 'q') { this.finished = true; return; }
			this._handleDumbInput();
			return;
		}

		if (this._atEnd) {
			this.finished = true;
			return;
		}

		var lower = ch.toLowerCase();
		if (lower === 'q') {
			this.finished = true;
			return;
		}
		if (lower === ' ') {
			// Space = page down, advance at end
			var scrolled = this._scrollDown(true);
			if (!scrolled) {
				this._nextAnnouncement();
			}
			return;
		}
	}

	// --- Dumb terminal input ---
	_handleDumbInput() {
		if (this._atEnd) {
			this.finished = true;
			return;
		}
		if (this._dumbLineIdx < this.bodyLines.length) {
			this._showDumbPage();
			return;
		}
		if (this.currentIdx < this.announcements.length - 1) {
			this.currentIdx++;
			this._showAnnouncementDumb();
		} else {
			this._showEndPrompt();
		}
	}

	// --- End of announcements prompt ---
	_showEndPrompt() {
		this._atEnd = true;
		if (this.dumb) {
			this.call.cmds.senddata('\r\nEnd of Announcements. Press Enter to continue.\r\n');
			return;
		}
		// Redraw nav bar with end prompt
		this.call.cmds.movecursor(2, this._navRow);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(HEADING_CLR);
		this.call.cmds.senddata('End of Announcements.  ');
		this.call.cmds.setfgcolor(NAV_LABEL_CLR);
		this.call.cmds.senddata('Press any key to continue.');
		this.call.cmds.resetcolors();
	}

	// --- Announcement navigation ---
	_nextAnnouncement() {
		if (this.currentIdx < this.announcements.length - 1) {
			this._atEnd = false;
			this.currentIdx++;
			this._buildBodyLines();
			this._showAnnouncement();
		} else if (!this._atEnd) {
			this._showEndPrompt();
		} else {
			this.finished = true;
		}
	}

	_prevAnnouncement() {
		if (this.currentIdx > 0) {
			this._atEnd = false;
			this.currentIdx--;
			this._buildBodyLines();
			this._showAnnouncement();
		}
	}

	// --- Lifecycle ---
	run() {
		if (!this.call) return;
		this._calcPos();

		getActiveAnnouncements(20)
			.then(res => {
				if (!this.active) return;
				this.announcements = res || [];
				if (this.announcements.length === 0) {
					this.signalReturn();
					return;
				}
				this._buildBodyLines();
				this._showAnnouncement();
			})
			.catch(err => {
				if (!this.active) return;
				this.signalReturn();
			});
	}
}

export { AnnouncementHandler };
