// bulletinViewer.js -- Bulletin selection menu and viewer
//
// States: list -> viewing -> list (or return)
// List: numbered menu of active bulletins, user enters a number
// Viewing: displays art file (if set) or body_text, any key returns to list

import { BaseSubModule } from "../basesubmodule.js";
import { getActiveBulletins } from "../../models/bulletins.js";

const TITLE_CLR = 10;     // bright green
const NUM_CLR = 11;        // bright yellow
const ENTRY_CLR = 14;      // bright cyan
const BODY_CLR = 6;        // cyan
const PROMPT_CLR = 11;     // bright yellow
const INPUT_CLR = 15;      // bright white
const DIVIDER_CLR = 4;     // blue

const HLINE_UTF8 = "\u2500";

class BulletinViewer extends BaseSubModule {
	constructor(call) {
		super(call, "Bulletins");
		this._state = 'list';
		this._bulletins = [];
		this._inputBuf = '';
		this._viewScroll = 0;
		this._viewLines = [];
		this.loggingId = "Bulletins (Node " + call.nodenum + ")";
	}

	_isUTF8() {
		var enc = this.call?.term_encoding || 'CP437';
		return (enc === 'UTF8' || enc === 'utf-8' || enc === 'utf8');
	}

	_drawHLine(row) {
		var cmds = this.call.cmds;
		var cols = this.call.term_width || 80;
		cmds.movecursor(1, row);
		cmds.setfgcolor(DIVIDER_CLR);
		if (this._isUTF8()) {
			cmds.senddata(HLINE_UTF8.repeat(cols));
		} else {
			cmds.senddata(Buffer.alloc(cols, 0xC4));
		}
		cmds.resetcolors();
	}

	// --- List state ---

	async run() {
		if (!this.call) { this.signalReturn(); return; }
		await this._showList();
	}

	async _showList() {
		this._state = 'list';
		this._inputBuf = '';
		this._bulletins = await getActiveBulletins();

		var cmds = this.call.cmds;
		var cols = this.call.term_width || 80;

		if (this.dumb) {
			this._showListDumb();
			return;
		}

		cmds.clearscreen();
		cmds.resetcolors();

		// Title
		var title = "Bulletins";
		var titleX = Math.round(cols / 2) - Math.round(title.length / 2);
		cmds.movecursor(titleX, 2);
		cmds.senddata("\x1b[1m");
		cmds.setfgcolor(TITLE_CLR);
		cmds.senddata(title);
		cmds.resetcolors();

		this._drawHLine(3);

		if (this._bulletins.length === 0) {
			cmds.movecursor(5, 5);
			cmds.setfgcolor(BODY_CLR);
			cmds.senddata("No bulletins available.");
			cmds.movecursor(5, 7);
			cmds.setfgcolor(PROMPT_CLR);
			cmds.senddata("Press any key to continue...");
			cmds.resetcolors();
			this._state = 'empty';
			return;
		}

		var row = 5;
		for (var i = 0; i < this._bulletins.length; i++) {
			cmds.movecursor(5, row);
			cmds.setfgcolor(NUM_CLR);
			cmds.senddata(String(i + 1).padStart(2) + ". ");
			cmds.setfgcolor(ENTRY_CLR);
			cmds.senddata(this._bulletins[i].title);
			row++;
		}

		this._drawHLine(row + 1);

		this._promptRow = row + 2;
		this._drawPrompt();
	}

	_showListDumb() {
		var cmds = this.call.cmds;
		cmds.senddata("\r\n\r\n  Bulletins\r\n\r\n");

		if (this._bulletins.length === 0) {
			cmds.senddata("  No bulletins available.\r\n\r\n");
			cmds.senddata("  Press any key to continue...");
			this._state = 'empty';
			return;
		}

		for (var i = 0; i < this._bulletins.length; i++) {
			cmds.senddata("  " + String(i + 1).padStart(2) + ". " + this._bulletins[i].title + "\r\n");
		}
		cmds.senddata("\r\n  Enter number (ESC to exit): ");
	}

	_drawPrompt() {
		if (this.dumb) return;
		var cmds = this.call.cmds;
		cmds.movecursor(5, this._promptRow);
		cmds.clearfullline();
		cmds.setfgcolor(PROMPT_CLR);
		cmds.senddata("Enter number (ESC to exit): ");
		cmds.setfgcolor(INPUT_CLR);
		cmds.senddata(this._inputBuf);
	}

	// --- Viewing state ---

	_viewBulletin(idx) {
		if (idx < 0 || idx >= this._bulletins.length) return;
		var bulletin = this._bulletins[idx];

		// Try art file first
		if (bulletin.art_file) {
			var drawn = this.call.cmds.drawscreen(bulletin.art_file, null, true);
			if (drawn) {
				this._state = 'viewing';
				return;
			}
		}

		// Fall back to body_text
		var cmds = this.call.cmds;
		var cols = this.call.term_width || 80;
		var maxRows = (this.call.term_height || 25) - 4;

		cmds.clearscreen();
		cmds.resetcolors();

		// Title
		var titleX = Math.round(cols / 2) - Math.round(bulletin.title.length / 2);
		cmds.movecursor(titleX, 2);
		cmds.senddata("\x1b[1m");
		cmds.setfgcolor(TITLE_CLR);
		cmds.senddata(bulletin.title);
		cmds.resetcolors();

		this._drawHLine(3);

		var bodyText = bulletin.body_text || '(no content)';
		this._viewLines = bodyText.split(/\r?\n/);
		this._viewScroll = 0;
		this._drawViewPage(4, maxRows);

		this._state = 'viewing';
	}

	_drawViewPage(startRow, maxRows) {
		var cmds = this.call.cmds;
		var rows = this.call.term_height || 25;
		var end = Math.min(this._viewScroll + maxRows, this._viewLines.length);

		for (var i = this._viewScroll; i < end; i++) {
			cmds.movecursor(3, startRow + (i - this._viewScroll));
			cmds.setfgcolor(BODY_CLR);
			cmds.senddata(this._viewLines[i]);
		}

		// Prompt at bottom
		cmds.movecursor(3, rows - 1);
		cmds.setfgcolor(PROMPT_CLR);
		if (end < this._viewLines.length) {
			cmds.senddata("More... (Space/Enter) or ESC to return");
		} else {
			cmds.senddata("Press any key to return...");
		}
		cmds.resetcolors();
	}

	// --- Input ---

	onKey(key) {
		if (!this.active || !this.call) return;

		if (this._state === 'empty') {
			this.signalReturn();
			return;
		}

		if (this._state === 'viewing') {
			var maxRows = (this.call.term_height || 25) - 4;
			var end = this._viewScroll + maxRows;

			if (key === 'ESC' || end >= this._viewLines.length) {
				this._showList();
				return;
			}
			if (key === 'Enter' || key === 'DownArrow') {
				this._viewScroll += maxRows;
				this.call.cmds.clearscreen();
				this._drawHLine(3);
				this._drawViewPage(4, maxRows);
				return;
			}
			return;
		}

		if (this._state === 'list') {
			if (key === 'ESC') {
				this.signalReturn();
				return;
			}
			if (key === 'Enter') {
				var num = parseInt(this._inputBuf);
				this._inputBuf = '';
				if (num >= 1 && num <= this._bulletins.length) {
					this._viewBulletin(num - 1);
				} else {
					this._drawPrompt();
				}
				return;
			}
			if (key === 'Backspace') {
				if (this._inputBuf.length > 0) {
					this._inputBuf = this._inputBuf.slice(0, -1);
					this._drawPrompt();
				}
				return;
			}
		}
	}

	onChar(ch) {
		if (!this.active || !this.call) return;

		if (this._state === 'empty') {
			this.signalReturn();
			return;
		}

		if (this._state === 'viewing') {
			var maxRows = (this.call.term_height || 25) - 4;
			var end = this._viewScroll + maxRows;

			if (end >= this._viewLines.length) {
				this._showList();
				return;
			}
			if (ch === ' ') {
				this._viewScroll += maxRows;
				this.call.cmds.clearscreen();
				this._drawHLine(3);
				this._drawViewPage(4, maxRows);
			}
			return;
		}

		if (this._state === 'list') {
			if (ch >= '0' && ch <= '9' && this._inputBuf.length < 3) {
				this._inputBuf += ch;
				this._drawPrompt();
			}
		}
	}
}

export { BulletinViewer };
