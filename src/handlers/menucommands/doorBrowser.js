import { BaseSubModule } from "../basesubmodule.js";
import { getActiveCollections, getDoorsInCollection, getCollectionCounts } from "../../models/doorCollections.js";
import { getAllDoors } from "../../models/doors.js";
import { htmlToTerminalText } from "../../models/announcements.js";

var CLR_TITLE = 14;
var CLR_BORDER = 4;
var CLR_SELECTED = 15;
var CLR_SELECTED_BG = 4;
var CLR_NORMAL = 7;
var CLR_DESC = 6;
var CLR_DESC_LABEL = 11;
var CLR_NAV_KEY = 11;
var CLR_NAV_LABEL = 7;

var STATE_COLLECTIONS = 'collections';
var STATE_DOORS = 'doors';

class doorBrowser extends BaseSubModule {
	constructor(call) {
		super(call, "DoorBrowser");

		this._state = STATE_COLLECTIONS;
		this._collections = [];
		this._doors = [];
		this._selectedIdx = 0;
		this._scrollOffset = 0;
		this._currentCollection = null;

		// Layout
		this._listWidth = 0;
		this._descLeft = 0;
		this._listTop = 4;
		this._listHeight = 0;
		this._navRow = 0;

		// Encoding
		var enc = (call.term_encoding || '').toLowerCase();
		this._isUTF8 = (enc === 'utf8' || enc === 'utf-8');

		this.loggingId = "DoorBrowser (Node " + call.nodenum + ")";
	}

	_sendGlyph(utf8Char, cp437Byte) {
		if (!this.call) return;
		if (this._isUTF8) {
			this.call.cmds.senddata(utf8Char);
		} else {
			this.call.cmds.senddata(Buffer.from([cp437Byte]));
		}
	}

	_calcPos() {
		var w = this.call.term_width || 80;
		var h = this.call.term_height || 24;
		this._listWidth = Math.floor(w * 0.35);
		if (this._listWidth < 20) this._listWidth = 20;
		if (this._listWidth > 40) this._listWidth = 40;
		this._descLeft = this._listWidth + 2;
		this._listHeight = h - this._listTop - 2;
		this._navRow = h - 1;
	}

	// --- Drawing ---

	_drawScreen() {
		if (this.dumb) {
			this._drawDumb();
			return;
		}

		this.call.cmds.clearscreen();
		this.call.cmds.resetcolors();

		// Title
		var title = (this._state === STATE_COLLECTIONS) ? 'Door Collections' : this._currentCollection.name;
		this.call.cmds.movecursor(2, 2);
		this.call.cmds.setfgcolor(CLR_TITLE);
		this.call.cmds.senddata(title);

		// Separator under title
		this.call.cmds.movecursor(1, 3);
		this.call.cmds.setfgcolor(CLR_BORDER);
		var w = this.call.term_width || 80;
		for (var i = 0; i < w; i++) this._sendGlyph('\u2500', 0xC4);

		// Vertical divider
		for (var row = this._listTop; row < this._listTop + this._listHeight; row++) {
			this.call.cmds.movecursor(this._listWidth + 1, row);
			this.call.cmds.setfgcolor(CLR_BORDER);
			this._sendGlyph('\u2502', 0xB3);
		}

		// Separator above nav
		this.call.cmds.movecursor(1, this._navRow - 1);
		this.call.cmds.setfgcolor(CLR_BORDER);
		for (var i = 0; i < w; i++) this._sendGlyph('\u2500', 0xC4);

		this._drawList();
		this._drawDescription();
		this._drawNav();
	}

	_drawList() {
		if (this.dumb) return;
		var items = (this._state === STATE_COLLECTIONS) ? this._collections : this._doors;

		for (var row = 0; row < this._listHeight; row++) {
			var idx = this._scrollOffset + row;
			this.call.cmds.movecursor(2, this._listTop + row);
			this.call.cmds.cleartoeol();

			// Redraw divider
			this.call.cmds.movecursor(this._listWidth + 1, this._listTop + row);
			this.call.cmds.setfgcolor(CLR_BORDER);
			this._sendGlyph('\u2502', 0xB3);

			if (idx >= items.length) continue;

			this.call.cmds.movecursor(2, this._listTop + row);
			if (idx === this._selectedIdx) {
				this.call.cmds.setfgcolor(CLR_SELECTED);
				this.call.cmds.setbgcolor(CLR_SELECTED_BG);
				this._sendGlyph('\u25BA', 0x10);
				this.call.cmds.senddata(' ');
			} else {
				this.call.cmds.setfgcolor(CLR_NORMAL);
				this.call.cmds.senddata('  ');
			}

			var label = items[idx].name || '';
			if (label.length > this._listWidth - 4) label = label.substring(0, this._listWidth - 4);
			this.call.cmds.senddata(label);

			// Pad to clear selection highlight
			var pad = this._listWidth - 3 - label.length;
			if (pad > 0) this.call.cmds.senddata(' '.repeat(pad));

			this.call.cmds.resetcolors();
		}
	}

	_drawDescription() {
		if (this.dumb) return;
		var items = (this._state === STATE_COLLECTIONS) ? this._collections : this._doors;
		var item = items[this._selectedIdx];
		if (!item) return;

		var descWidth = (this.call.term_width || 80) - this._descLeft - 1;
		var startRow = this._listTop;

		// Clear description area
		for (var row = 0; row < this._listHeight; row++) {
			this.call.cmds.movecursor(this._descLeft, startRow + row);
			this.call.cmds.cleartoeol();
		}

		// Name
		this.call.cmds.movecursor(this._descLeft, startRow);
		this.call.cmds.setfgcolor(CLR_DESC_LABEL);
		this.call.cmds.senddata(item.name || '');

		// Description - use long_desc_html with ANSI colors if available, else description
		var desc = '';
		if (item.long_desc_html) {
			desc = htmlToTerminalText(item.long_desc_html);
		} else if (item.description) {
			desc = htmlToTerminalText(item.description);
		} else {
			desc = '(no description)';
		}

		// Word-wrap (strip ANSI for width calculation, but send with ANSI)
		var lines = desc.split(/\r?\n/);
		var lineRow = startRow + 2;

		this.call.cmds.setfgcolor(CLR_DESC);
		for (var li = 0; li < lines.length; li++) {
			var rawLine = lines[li];
			var visibleLen = rawLine.replace(/\x1b\[[0-9;]*m/g, '').length;

			if (visibleLen <= descWidth) {
				if (lineRow >= startRow + this._listHeight - 2) break;
				this.call.cmds.movecursor(this._descLeft, lineRow);
				this.call.cmds.senddata(rawLine);
				this.call.cmds.resetcolors();
				this.call.cmds.setfgcolor(CLR_DESC);
				lineRow++;
			} else {
				// Simple word wrap for lines with potential ANSI codes
				var words = rawLine.split(' ');
				var wrapLine = '';
				var wrapVisible = 0;
				for (var wi = 0; wi < words.length; wi++) {
					var wordVisible = words[wi].replace(/\x1b\[[0-9;]*m/g, '').length;
					if (wrapVisible + wordVisible + (wrapVisible > 0 ? 1 : 0) > descWidth && wrapVisible > 0) {
						if (lineRow >= startRow + this._listHeight - 2) break;
						this.call.cmds.movecursor(this._descLeft, lineRow);
						this.call.cmds.senddata(wrapLine);
						this.call.cmds.resetcolors();
						this.call.cmds.setfgcolor(CLR_DESC);
						lineRow++;
						wrapLine = words[wi];
						wrapVisible = wordVisible;
					} else {
						wrapLine += (wrapVisible > 0 ? ' ' : '') + words[wi];
						wrapVisible += wordVisible + (wrapVisible > 0 ? 1 : 0);
					}
				}
				if (wrapLine.length > 0 && lineRow < startRow + this._listHeight - 2) {
					this.call.cmds.movecursor(this._descLeft, lineRow);
					this.call.cmds.senddata(wrapLine);
					this.call.cmds.resetcolors();
					this.call.cmds.setfgcolor(CLR_DESC);
					lineRow++;
				}
			}
		}

		// Door-specific info
		if (this._state === STATE_DOORS && item.launch_type) {
			var infoRow = startRow + this._listHeight - 2;
			this.call.cmds.movecursor(this._descLeft, infoRow);
			this.call.cmds.setfgcolor(CLR_DESC_LABEL);
			this.call.cmds.senddata('Type: ');
			this.call.cmds.setfgcolor(CLR_DESC);
			this.call.cmds.senddata(item.launch_type);
		}

		this.call.cmds.resetcolors();
	}

	_drawNav() {
		if (this.dumb) return;
		this.call.cmds.movecursor(2, this._navRow);
		this.call.cmds.cleartoeol();

		this.call.cmds.setfgcolor(CLR_NAV_KEY);
		this._sendGlyph('\u2191\u2193', 0x18);
		if (!this._isUTF8) this.call.cmds.senddata(Buffer.from([0x19]));
		this.call.cmds.setfgcolor(CLR_NAV_LABEL);
		this.call.cmds.senddata('Navigate  ');

		if (this._state === STATE_DOORS) {
			this.call.cmds.setfgcolor(CLR_NAV_KEY);
			this.call.cmds.senddata('Enter');
			this.call.cmds.setfgcolor(CLR_NAV_LABEL);
			this.call.cmds.senddata(' Play  ');

			this.call.cmds.setfgcolor(CLR_NAV_KEY);
			this._sendGlyph('\u2190', 0x1B);
			this.call.cmds.setfgcolor(CLR_NAV_LABEL);
			this.call.cmds.senddata('Back  ');
		} else {
			this.call.cmds.setfgcolor(CLR_NAV_KEY);
			this.call.cmds.senddata('Enter');
			this.call.cmds.setfgcolor(CLR_NAV_LABEL);
			this.call.cmds.senddata(' Open  ');
		}

		this.call.cmds.setfgcolor(CLR_NAV_KEY);
		this.call.cmds.senddata('Q');
		this.call.cmds.setfgcolor(CLR_NAV_LABEL);
		this.call.cmds.senddata('uit');
		this.call.cmds.resetcolors();
	}

	// --- Dumb terminal ---

	_drawDumb() {
		var items = (this._state === STATE_COLLECTIONS) ? this._collections : this._doors;
		var title = (this._state === STATE_COLLECTIONS) ? 'Door Collections' : this._currentCollection.name;
		this.call.cmds.senddata('\r\n  ' + title + '\r\n');

		for (var i = 0; i < items.length; i++) {
			var marker = (i === this._selectedIdx) ? '> ' : '  ';
			this.call.cmds.senddata(marker + (i + 1) + ') ' + items[i].name + '\r\n');
		}

		if (this._state === STATE_DOORS) {
			this.call.cmds.senddata('\r\n  Enter # to play, B to go back, Q to quit: ');
		} else {
			this.call.cmds.senddata('\r\n  Enter # to open, Q to quit: ');
		}
	}

	// --- Scrolling ---

	_ensureVisible() {
		if (this._selectedIdx < this._scrollOffset) {
			this._scrollOffset = this._selectedIdx;
		}
		if (this._selectedIdx >= this._scrollOffset + this._listHeight) {
			this._scrollOffset = this._selectedIdx - this._listHeight + 1;
		}
	}

	// --- Input ---

	onKey(key) {
		switch (key) {
			case 'UpArrow':
				this._moveSelection(-1);
				return;
			case 'DownArrow':
				this._moveSelection(1);
				return;
			case 'Enter':
			case 'RightArrow':
				this._select();
				return;
			case 'LeftArrow':
				if (this._state === STATE_DOORS) {
					this._goBack();
				}
				return;
			case 'ESC':
				if (this._state === STATE_DOORS) {
					this._goBack();
				} else {
					this.signalReturn();
				}
				return;
		}
	}

	onChar(ch) {
		var lower = ch.toLowerCase();
		if (lower === 'q') {
			this.signalReturn();
			return;
		}
		if (lower === 'b' && this._state === STATE_DOORS) {
			this._goBack();
			return;
		}
	}

	_moveSelection(delta) {
		var items = (this._state === STATE_COLLECTIONS) ? this._collections : this._doors;
		var newIdx = this._selectedIdx + delta;
		if (newIdx < 0 || newIdx >= items.length) return;
		this._selectedIdx = newIdx;
		this._ensureVisible();
		if (this.dumb) {
			this._drawDumb();
		} else {
			this._drawList();
			this._drawDescription();
		}
	}

	_select() {
		if (this._state === STATE_COLLECTIONS) {
			var col = this._collections[this._selectedIdx];
			if (!col) return;
			this._currentCollection = col;
			getDoorsInCollection(col.id)
				.then(doorsResult => {
					if (!this.active) return;
					this._doors = doorsResult || [];
					this._state = STATE_DOORS;
					this._selectedIdx = 0;
					this._scrollOffset = 0;
					this._drawScreen();
				})
				.catch(() => {
					if (!this.active) return;
					this._doors = [];
					this._state = STATE_DOORS;
					this._drawScreen();
				});
		} else {
			var door = this._doors[this._selectedIdx];
			if (!door) return;
			// Save browse state on the call so we can resume after door exit
			if (this.call) {
				this.call._doorBrowserState = {
					collectionSlug: this._currentCollection ? this._currentCollection.slug : null,
					selectedIdx: this._selectedIdx,
					scrollOffset: this._scrollOffset
				};
				this.call.doorTarget = door.slug;
				this.finished = true;
				this.emitter.emit("LaunchDoor", door.slug);
			}
		}
	}

	_goBack() {
		this._state = STATE_COLLECTIONS;
		this._selectedIdx = 0;
		this._scrollOffset = 0;
		this._drawScreen();
	}

	// --- Lifecycle ---

	run() {
		if (!this.call) return;
		this._calcPos();

		// Check for saved state from a previous door launch
		var savedState = this.call._doorBrowserState || null;
		this.call._doorBrowserState = null;

		getActiveCollections()
			.then(async (collections) => {
				if (!this.active) return;
				this._collections = collections || [];

				// If no collections, fall back to flat door list as a single "collection"
				if (this._collections.length === 0) {
					var allDoorList = await getAllDoors();
					this._doors = (allDoorList || []).filter(function(d) { return d.active; });
					this._state = STATE_DOORS;
					this._currentCollection = { name: 'Door Games', description: '' };
				} else if (savedState && savedState.collectionSlug) {
					// Resume into the saved collection
					var savedCol = this._collections.find(function(c) { return c.slug === savedState.collectionSlug; });
					if (savedCol) {
						this._currentCollection = savedCol;
						this._doors = await getDoorsInCollection(savedCol.id);
						this._state = STATE_DOORS;
						this._selectedIdx = Math.min(savedState.selectedIdx || 0, this._doors.length - 1);
						this._scrollOffset = savedState.scrollOffset || 0;
						this._ensureVisible();
					}
				} else if (this._collections.length === 1) {
					// Single collection - skip to doors directly
					this._currentCollection = this._collections[0];
					this._doors = await getDoorsInCollection(this._currentCollection.id);
					this._state = STATE_DOORS;
				}

				this._drawScreen();
			})
			.catch(() => {
				if (!this.active) return;
				this.signalReturn();
			});
	}
}

export { doorBrowser };
