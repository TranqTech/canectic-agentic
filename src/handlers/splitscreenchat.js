// splitscreenchat.js -- Reusable split-screen chat engine
//
// Sysop layout (showPeekLine: true):
//   Row 1:         blank
//   Row 2:         title ("Sysop Breaking In To Chat")
//   Row 3:         peek line (shows what the remote user is typing)
//   Row 4:         divider line
//   Rows 5..N-3:   conversation history (DECSTBM scroll region)
//   Row N-2:       divider line
//   Row N-1:       input line ("> ...")
//   Row N:         blank
//
// Target layout (showPeekLine: false):
//   Row 1:         blank
//   Row 2:         title
//   Row 3:         divider line
//   Rows 4..N-3:   conversation history (DECSTBM scroll region)
//   Row N-2:       divider line
//   Row N-1:       input line ("> ...")
//   Row N:         blank
//
// The caller wires input, message injection, and the peek line via callbacks.

const DEFAULT_SYSOP_CLR = 14;   // bright cyan
const DEFAULT_USER_CLR = 11;    // bright yellow
const DEFAULT_DIVIDER_CLR = 8;  // dark grey
const DEFAULT_INPUT_CLR = 15;   // bright white
const DEFAULT_SYSTEM_CLR = 10;  // bright green
const TITLE_CLR = 13;           // bright magenta
const PEEK_LABEL_CLR = 8;       // dark grey
const PEEK_TEXT_CLR = 7;         // white (normal)

// Unicode horizontal line U+2500
const HLINE_UTF8 = "\u2500";

class SplitScreenChat {
	constructor(call, options) {
		this.call = call;
		this.active = false;

		this.sysopLabel = options?.sysopLabel || "Sysop";
		this.userLabel = options?.userLabel || call?.caller_username || "User";
		this.sysopClr = options?.sysopClr || DEFAULT_SYSOP_CLR;
		this.userClr = options?.userClr || DEFAULT_USER_CLR;
		this.dividerClr = options?.dividerClr || DEFAULT_DIVIDER_CLR;
		this.inputClr = options?.inputClr || DEFAULT_INPUT_CLR;
		this.systemClr = options?.systemClr || DEFAULT_SYSTEM_CLR;
		this.exitLabel = options?.exitLabel || "ESC to exit";
		this.allowExit = options?.allowExit !== undefined ? options.allowExit : true;
		this.showPeekLine = options?.showPeekLine || false;

		this.cols = call?.term_width || 80;
		this.rows = call?.term_height || 25;

		// Encoding
		var enc = call?.term_encoding || 'CP437';
		this._isUTF8 = (enc === 'UTF8' || enc === 'utf-8' || enc === 'utf8');

		// Layout depends on whether we show the peek line
		this.titleRow = 2;
		if (this.showPeekLine) {
			this.peekRow = 3;
			this.topDividerRow = 4;
			this.chatTop = 5;
		} else {
			this.peekRow = null;
			this.topDividerRow = 3;
			this.chatTop = 4;
		}
		this.chatBottom = this.rows - 3;
		this.bottomDividerRow = this.rows - 2;
		this.inputRow = this.rows - 1;

		// Input buffer
		this._inputBuf = '';
		this._maxInputLen = this.cols - 4;  // room for "> " prompt and padding

		// Callbacks
		this.onSend = options?.onSend || null;      // function(text) -- called when user presses Enter
		this.onExit = options?.onExit || null;       // function() -- called when user presses ESC
		this.onTyping = options?.onTyping || null;   // function(inputBuf) -- called on every keystroke
	}

	// --- Setup / teardown ---

	start() {
		if (!this.call) return;
		this.active = true;
		this._inputBuf = '';

		var cmds = this.call.cmds;
		cmds.clearscreen();
		cmds.resetcolors();

		// Draw title
		this._drawTitle();

		// Draw dividers
		this._drawHLine(this.topDividerRow);
		this._drawHLine(this.bottomDividerRow);

		// Set scroll region to conversation area
		cmds.setscrollregion(this.chatTop, this.chatBottom);

		// Position cursor at bottom of conversation region
		cmds.movecursor(1, this.chatBottom);

		// Draw input prompt and park cursor there
		this._parkCursor();
	}

	stop() {
		if (!this.call) return;
		this.active = false;
		this._inputBuf = '';

		var cmds = this.call.cmds;

		// Reset scroll region to full screen
		cmds.resetscrollregion();
		cmds.resetcolors();
	}

	// --- Display ---

	_drawTitle() {
		var cmds = this.call.cmds;
		var title = "Sysop Breaking In To Chat";
		var titleX = Math.round(this.cols / 2) - Math.round(title.length / 2);

		cmds.movecursor(titleX, this.titleRow);
		cmds.senddata("\x1b[1m");  // bold
		cmds.setfgcolor(TITLE_CLR);
		cmds.senddata(title);
		cmds.resetcolors();

		// ESC hint in top right for sysop
		if (this.allowExit) {
			var hint = this.exitLabel;
			cmds.movecursor(this.cols - hint.length, this.titleRow);
			cmds.setfgcolor(PEEK_LABEL_CLR);
			cmds.senddata(hint);
			cmds.resetcolors();
		}
	}

	_drawHLine(row) {
		var cmds = this.call.cmds;
		cmds.movecursor(1, row);
		cmds.setfgcolor(this.dividerClr);

		if (this._isUTF8) {
			cmds.senddata(HLINE_UTF8.repeat(this.cols));
		} else {
			cmds.senddata(Buffer.alloc(this.cols, 0xC4));
		}

		cmds.resetcolors();
	}

	// Park cursor at the end of the current input text on the input row
	_parkCursor() {
		var cmds = this.call.cmds;
		cmds.movecursor(1, this.inputRow);
		cmds.clearfullline();
		cmds.setfgcolor(this.inputClr);
		cmds.senddata("> " + this._inputBuf);
		// Cursor is now at col 3 + inputBuf.length -- exactly where the user types next
	}

	// Update the peek line with the remote user's current typing buffer
	updatePeekLine(text) {
		if (!this.peekRow || !this.call || !this.active) return;
		var cmds = this.call.cmds;
		cmds.savecursor();
		cmds.movecursor(1, this.peekRow);
		cmds.clearfullline();
		cmds.setfgcolor(PEEK_LABEL_CLR);
		cmds.senddata(this.userLabel + " is typing: ");
		cmds.setfgcolor(PEEK_TEXT_CLR);
		// Truncate to fit
		var labelLen = this.userLabel.length + 13; // " is typing: "
		var maxText = this.cols - labelLen;
		cmds.senddata(text.length > maxText ? text.substring(text.length - maxText) : text);
		cmds.resetcolors();
		cmds.restorecursor();
	}

	// Clear the peek line (after message is sent)
	clearPeekLine() {
		if (!this.peekRow || !this.call || !this.active) return;
		var cmds = this.call.cmds;
		cmds.savecursor();
		cmds.movecursor(1, this.peekRow);
		cmds.clearfullline();
		cmds.restorecursor();
	}

	// Append a message to the conversation region
	_appendToChat(colour, prefix, text) {
		if (!this.call || !this.active) return;
		var cmds = this.call.cmds;

		// Move into scroll region at the bottom row and push a new line
		cmds.savecursor();
		cmds.movecursor(1, this.chatBottom);
		cmds.senddata("\r\n");  // scrolls the region up
		cmds.setfgcolor(colour);
		cmds.senddata(prefix);
		cmds.resetcolors();
		cmds.senddata(" " + text);
		cmds.restorecursor();
	}

	// --- Public message methods ---

	// Display a message from the sysop
	sysopMessage(text) {
		this._appendToChat(this.sysopClr, this.sysopLabel + ":", text);
	}

	// Display a message from the user
	userMessage(text) {
		this._appendToChat(this.userClr, this.userLabel + ":", text);
	}

	// Display a system message (joins, exits, etc.)
	_systemMessage(text) {
		this._appendToChat(this.systemClr, "***", text);
	}

	// --- Input handling ---

	// Call this with raw key tokens from the input parser
	handleKey(key) {
		if (!this.active || !this.call) return;

		if (key === 'ESC') {
			if (this.allowExit && this.onExit) this.onExit();
			return;
		}

		if (key === 'Enter') {
			if (this._inputBuf.length > 0) {
				var text = this._inputBuf;
				this._inputBuf = '';
				this._parkCursor();
				if (this.onSend) this.onSend(text);
			}
			return;
		}

		if (key === 'Backspace') {
			if (this._inputBuf.length > 0) {
				this._inputBuf = this._inputBuf.slice(0, -1);
				this._parkCursor();
				if (this.onTyping) this.onTyping(this._inputBuf);
			}
			return;
		}
	}

	// Call this with printable characters
	handleChar(ch) {
		if (!this.active || !this.call) return;

		if (this._inputBuf.length < this._maxInputLen) {
			this._inputBuf += ch;
			this._parkCursor();
			if (this.onTyping) this.onTyping(this._inputBuf);
		}
	}
}

export { SplitScreenChat };
