// wallHandler.js -- The Wall / Oneliners
//
// Displays recent one-liner messages and prompts the user to leave one.
// Used as both a call flow stage (via SubModuleAdapter) and a menu command.

import { BaseSubModule } from "../basesubmodule.js";
import { getRecentMessages, addMessage, canPost } from "../../models/wall.js";
import appConfig from "../../config/appConfig.js";

const TITLE_CLR = 10;     // bright green
const DIVIDER_CLR = 4;    // blue
const UNAME_CLR = 14;     // bright cyan
const MSG_CLR = 7;        // white/grey
const PROMPT_CLR = 11;    // bright yellow
const INPUT_CLR = 15;     // bright white

// CP437 horizontal line byte vs Unicode
const HLINE_UTF8 = "\u2500";

class WallHandler extends BaseSubModule {
	constructor(call) {
		super(call, "Wall");
		this._state = 'display';
		this._inputBuf = '';
		this._maxLen = appConfig.getNumber('wall_max_length', 78);
		this._displayCount = appConfig.getNumber('wall_display_count', 15);
		this.loggingId = "Wall (Node " + call.nodenum + ")";
	}

	_isUTF8() {
		var enc = this.call?.term_encoding || 'CP437';
		return (enc === 'UTF8' || enc === 'utf-8' || enc === 'utf8');
	}

	_drawHLine() {
		var cmds = this.call.cmds;
		var cols = this.call.term_width || 80;
		cmds.setfgcolor(DIVIDER_CLR);
		if (this._isUTF8()) {
			cmds.senddata(HLINE_UTF8.repeat(cols));
		} else {
			cmds.senddata(Buffer.alloc(cols, 0xC4));
		}
		cmds.resetcolors();
	}

	async run() {
		if (!this.call) { this.signalReturn(); return; }

		this._canPost = canPost(this.call);
		var messages = await getRecentMessages(this._displayCount);
		var cmds = this.call.cmds;
		var cols = this.call.term_width || 80;

		if (this.dumb) {
			this._showDumb(messages);
			return;
		}

		cmds.clearscreen();
		cmds.resetcolors();

		// Title
		var title = "The Wall";
		var titleX = Math.round(cols / 2) - Math.round(title.length / 2);
		cmds.movecursor(titleX, 2);
		cmds.senddata("\x1b[1m"); // bold
		cmds.setfgcolor(TITLE_CLR);
		cmds.senddata(title);
		cmds.resetcolors();

		// Top divider
		cmds.movecursor(1, 3);
		this._drawHLine();

		// Messages
		var startRow = 4;
		if (messages.length === 0) {
			cmds.movecursor(3, startRow);
			cmds.setfgcolor(MSG_CLR);
			cmds.senddata("No messages yet. Be the first!");
			startRow++;
		} else {
			for (var i = 0; i < messages.length; i++) {
				var msg = messages[i];
				cmds.movecursor(3, startRow + i);
				cmds.setfgcolor(UNAME_CLR);
				cmds.senddata(msg.username);
				cmds.setfgcolor(MSG_CLR);
				cmds.senddata(": " + msg.message);
			}
			startRow += messages.length;
		}

		// Bottom divider
		var dividerRow = startRow + 1;
		cmds.movecursor(1, dividerRow);
		this._drawHLine();

		// Prompt
		this._promptRow = dividerRow + 1;
		this._inputBuf = '';
		if (this._canPost) {
			this._state = 'input';
			this._drawPrompt();
		} else {
			this._state = 'readonly';
			cmds.movecursor(3, this._promptRow);
			cmds.setfgcolor(PROMPT_CLR);
			cmds.senddata("Press any key to continue...");
			cmds.resetcolors();
		}
	}

	_showDumb(messages) {
		var cmds = this.call.cmds;
		cmds.senddata("\r\n\r\n  The Wall\r\n\r\n");
		if (messages.length === 0) {
			cmds.senddata("  No messages yet. Be the first!\r\n");
		} else {
			for (var i = 0; i < messages.length; i++) {
				var msg = messages[i];
				cmds.senddata("  " + msg.username + ": " + msg.message + "\r\n");
			}
		}
		if (this._canPost) {
			cmds.senddata("\r\n  Leave a message (or Enter to skip): ");
			this._state = 'input';
		} else {
			cmds.senddata("\r\n  Press any key to continue...");
			this._state = 'readonly';
		}
		this._inputBuf = '';
	}

	_drawPrompt() {
		if (this.dumb) return;
		var cmds = this.call.cmds;
		cmds.movecursor(3, this._promptRow);
		cmds.clearfullline();
		cmds.setfgcolor(PROMPT_CLR);
		cmds.senddata("Leave a message: ");
		cmds.setfgcolor(INPUT_CLR);
		cmds.senddata(this._inputBuf);
	}

	onKey(key) {
		if (!this.active || !this.call) return;

		if (this._state === 'readonly') {
			this.signalReturn();
			return;
		}

		if (this._state === 'input') {
			if (key === 'ESC') {
				this.signalReturn();
				return;
			}
			if (key === 'Enter') {
				if (this._inputBuf.length > 0) {
					this._submitMessage();
				} else {
					this.signalReturn();
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

		if (this._state === 'readonly') {
			this.signalReturn();
			return;
		}

		if (this._state === 'input') {
			if (this._inputBuf.length < this._maxLen) {
				this._inputBuf += ch;
				this._drawPrompt();
			}
		}
	}

	async _submitMessage() {
		var username = this.call.caller_username || 'Anonymous';
		var userId = this.call.caller_user_id || null;
		var text = this._inputBuf.trim();

		if (text.length > 0) {
			await addMessage(userId, username, text);
		}

		this.signalReturn();
	}
}

export { WallHandler };
