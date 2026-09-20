import { BaseSubModule } from "../basesubmodule.js";
import * as privateMessages from "../../models/privateMessages.js";
import * as alogger from "../../utils/alogger.js";

// --- Constants ---

const STATE = {
	FIELD_FROM: 0,        // Cycle between username/fullname
	FIELD_TO: 1,
	FIELD_ADDRESS: 2,     // Network address (only shown for non-LOCAL)
	FIELD_SUBJECT: 3,
	BODY: 4,
	QUOTING: 5,
	CONFIRM_SAVE: 6,
	CONFIRM_ABORT: 7,
};

const MAX_BODY_WIDTH = 79;   // Hard wrap for network compatibility
const MAX_QUOTE_WIDTH = 76;  // 79 minus "> " prefix (2) minus safety (1)
const MAX_FIELD_LEN = 72;

// Colors
const CLR_HEADER_LABEL = 11;
const CLR_HEADER_VALUE = 15;
const CLR_HEADER_DIM = 8;
const CLR_FIELD_ACTIVE = 14;
const CLR_FIELD_INACTIVE = 7;
const CLR_STATUS = 8;
const CLR_NAV = 11;
const CLR_NAV_LABEL = 7;
const CLR_SEPARATOR = 8;
const CLR_ERROR = 9;
const CLR_PROMPT = 14;
const CLR_QUOTE_BAR_FG = 15;
const CLR_QUOTE_BAR_BG = 4;

// Default body semantic colors
const DF_CLR_BODY = 11;
const DF_CLR_QUOTE = 14;

// CP437 safe glyphs
const CP437_HLINE = 0xC4;

// =========================================================================

class pmEditor extends BaseSubModule {
	constructor(call, options) {
		super(call, "PmEditor");

		var opts = options || {};

		// Encoding
		var enc = (call.term_encoding || "").toLowerCase();
		this._isUTF8 = (enc === "utf8" || enc === "utf-8");

		// Mode
		this._mode = opts.mode || "new";          // "new" or "reply"
		this._replyToMsg = opts.replyToMsg || null;
		this._transportType = opts.transportType || "LOCAL";
		this._userSession = call.user_record || null;

		// Allowed transports for cycling (new compose only)
		this._allowedTransports = opts.allowedTransports || ["LOCAL"];
		this._transportLocked = (this._mode === "reply"); // reply locks transport
		this._transportIdx = Math.max(0, this._allowedTransports.indexOf(this._transportType));
		if (this._transportIdx < 0) this._transportIdx = 0;
		if (!this._transportLocked && this._allowedTransports.length > 0) {
			this._transportType = this._allowedTransports[this._transportIdx];
		}

		// Resolved from name — cycleable between username and fullname
		this._fromName = "";
		this._fromOptions = [];  // populated in _resolveFromName
		this._fromIdx = 0;
		this._userId = null;
		if (call.user_record) {
			this._userId = call.user_record.id || call.user_record.user_id || null;
		}

		// Field values
		this._toValue = "";
		this._toAddress = "";          // Network address (FTN address, QWK ID, etc.)
		this._fromAddress = "";        // Our network address (for replies)
		this._subjectValue = "";
		this._toPos = 0;
		this._toAddressPos = 0;
		this._subjectPos = 0;

		// Body buffer
		this._lines = [""];
		this._cursorLine = 0;
		this._cursorCol = 0;
		this._scrollOffset = 0;
		this._insertMode = true;

		// Quote state
		this._quoteLines = [];
		this._quoteCursor = 0;
		this._quoteScroll = 0;
		this._quoteSelected = {};

		// State
		this._state = STATE.FIELD_FROM;
		this._saved = false;
		this._saving = false;

		// Geometry
		this._termW = call.term_width || 80;
		this._termH = call.term_height || 24;
		this._bodyWidth = 0;
		this._bodyLeft = 0;
		this._bodyViewStart = 6;
		this._bodyViewEnd = 0;
		this._bodyViewHeight = 0;
		this._statusRow = 0;
		this._navRow = 0;

		// Dumb terminal
		this._dumbMode = "to";
		this._dumbBuf = "";
		this._dumbLines = [];

		// Body semantic colors
		var theme = call.theme || {};
		this._clrBody = theme.msg_body_clr !== undefined ? theme.msg_body_clr : DF_CLR_BODY;
		this._clrQuote = theme.msg_quote_clr !== undefined ? theme.msg_quote_clr : DF_CLR_QUOTE;

		this.loggingId = "PmEditor (Node " + call.nodenum + ")";
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

	_navKey(key, label) {
		if (!this.call) return;
		this.call.cmds.setfgcolor(CLR_NAV);
		this.call.cmds.senddata(key);
		if (label) {
			this.call.cmds.setfgcolor(CLR_NAV_LABEL);
			this.call.cmds.senddata(" " + label);
		}
	}

	// Quote line detection
	_isQuoteLine(line) {
		if (!line) return false;
		var trimmed = line.trimStart();
		if (/^\s*>/.test(trimmed)) return true;
		if (/^\s*[A-Za-z]{1,3}>{1,2}\s/.test(trimmed)) return true;
		if (/^\s*[-=]+>\s/.test(trimmed)) return true;
		return false;
	}

	// --- Geometry ---

	_calcGeometry() {
		this._bodyWidth = Math.min(this._termW, MAX_BODY_WIDTH);
		this._bodyLeft = Math.floor((this._termW - this._bodyWidth) / 2) + 1;

		this._navRow = this._termH;
		this._statusRow = this._termH - 1;

		// Header: rows 1-4 (From, To, Addr/Via, Subject)
		// Separator: row 5
		// Body: rows 6 to H-2
		this._bodyViewStart = 6;
		this._bodyViewEnd = this._termH - 2;
		this._bodyViewHeight = this._bodyViewEnd - this._bodyViewStart + 1;
		if (this._bodyViewHeight < 3) this._bodyViewHeight = 3;
	}

	// --- String helpers ---

	_padRight(str, len) {
		while (str.length < len) str += " ";
		return str.length > len ? str.substring(0, len) : str;
	}

	_truncate(str, len) {
		if (!str) return "";
		return str.length > len ? str.substring(0, len) : str;
	}

	_titleCase(str) {
		if (!str) return "";
		return str.replace(/\S+/g, function(word) {
			return word.charAt(0).toUpperCase() + word.substring(1).toLowerCase();
		});
	}

	// ===========================================================================
	// INITIALIZATION
	// ===========================================================================

	_resolveFromName() {
		var uname = this.call.caller_username || "";
		var fname = this.call.caller_fullname || "";

		this._fromOptions = [];
		if (uname) this._fromOptions.push(uname);
		if (fname && fname.toLowerCase() !== uname.toLowerCase()) {
			this._fromOptions.push(fname);
		}
		if (this._fromOptions.length === 0) {
			this._fromOptions.push("Unknown");
		}

		this._fromIdx = 0;
		this._fromName = this._fromOptions[0];
	}

	_cycleFromName(direction) {
		if (this._fromOptions.length <= 1) return;
		this._fromIdx += direction;
		if (this._fromIdx < 0) this._fromIdx = this._fromOptions.length - 1;
		if (this._fromIdx >= this._fromOptions.length) this._fromIdx = 0;
		this._fromName = this._fromOptions[this._fromIdx];
		this._drawHeader();
		this._positionCursor();
	}

	_prefillFields() {
		if (this._mode === "reply" && this._replyToMsg) {
			this._toValue = this._replyToMsg.from_user || "";
			this._toPos = this._toValue.length;

			// Pre-fill network address from original message
			if (this._transportType !== "LOCAL") {
				this._toAddress = this._replyToMsg.from_address || "";
				this._toAddressPos = this._toAddress.length;
				this._fromAddress = this._replyToMsg.to_address || "";
			}

			var origSubj = this._replyToMsg.subject || "";
			if (!/^re:/i.test(origSubj.trim())) {
				this._subjectValue = "Re: " + origSubj;
			} else {
				this._subjectValue = origSubj;
			}
			this._subjectPos = this._subjectValue.length;
		}
	}

	_prepareQuoteLines() {
		if (this._mode !== "reply" || !this._replyToMsg) return;

		var bodyText = this._replyToMsg.body_text || "";
		bodyText = bodyText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		var rawLines = bodyText.split("\n");

		this._quoteLines = [];
		for (var i = 0; i < rawLines.length; i++) {
			var line = rawLines[i];
			// Word wrap long lines for quoting
			if (line.length > MAX_QUOTE_WIDTH) {
				var remaining = line;
				while (remaining.length > MAX_QUOTE_WIDTH) {
					var breakAt = remaining.lastIndexOf(" ", MAX_QUOTE_WIDTH);
					if (breakAt <= 0) breakAt = MAX_QUOTE_WIDTH;
					this._quoteLines.push(remaining.substring(0, breakAt));
					remaining = remaining.substring(breakAt);
					if (remaining.charAt(0) === " ") remaining = remaining.substring(1);
				}
				this._quoteLines.push(remaining);
			} else {
				this._quoteLines.push(line);
			}
		}
	}

	// ===========================================================================
	// SCREEN DRAWING
	// ===========================================================================

	_drawScreen() {
		if (!this.call || this.dumb) return;
		this.call.cmds.clearscreen();
		this._drawHeader();
		this._drawSeparator();
		this._drawBody();
		this._drawStatusBar();
		this._drawNavBar();
		this._positionCursor();
	}

	_drawHeader() {
		if (this.dumb) return;
		var fieldW = this._bodyWidth - 12;
		if (fieldW < 10) fieldW = 10;
		var isNetwork = (this._transportType !== "LOCAL");

		// Row 1: From (cycleable)
		this.call.cmds.movecursor(this._bodyLeft, 1);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(CLR_HEADER_LABEL);
		this.call.cmds.senddata("   From : ");
		var onFromField = (this._state === STATE.FIELD_FROM);
		this.call.cmds.setfgcolor(onFromField ? CLR_FIELD_ACTIVE : CLR_HEADER_VALUE);
		this.call.cmds.senddata(this._truncate(this._fromName, fieldW - 12));
		if (onFromField && this._fromOptions.length > 1) {
			this.call.cmds.senddata("  ");
			this.call.cmds.setfgcolor(CLR_NAV);
			this._sendGlyph("\u2190", 0x1B);
			this._sendGlyph("\u2192", 0x1A);
			this.call.cmds.setfgcolor(CLR_HEADER_DIM);
			this.call.cmds.senddata(" change");
		}

		// Row 2: To (editable)
		this.call.cmds.movecursor(this._bodyLeft, 2);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(CLR_HEADER_LABEL);
		this.call.cmds.senddata("     To : ");
		this.call.cmds.setfgcolor(this._state === STATE.FIELD_TO ? CLR_FIELD_ACTIVE : CLR_FIELD_INACTIVE);
		this.call.cmds.senddata(this._padRight(this._truncate(this._toValue, fieldW), fieldW));

		// Row 3: Via/Address — always editable for new compose, locked for reply
		this.call.cmds.movecursor(this._bodyLeft, 3);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(CLR_HEADER_LABEL);
		var onAddrField = (this._state === STATE.FIELD_ADDRESS);
		if (isNetwork) {
			this.call.cmds.senddata("   Addr : ");
			this.call.cmds.setfgcolor(onAddrField ? CLR_FIELD_ACTIVE : CLR_FIELD_INACTIVE);
			var addrDisplay = this._truncate(this._toAddress, fieldW - 6);
			this.call.cmds.senddata(addrDisplay);
			// Show transport badge after address
			this.call.cmds.setfgcolor(CLR_HEADER_DIM);
			var pad = fieldW - addrDisplay.length - 5;
			if (pad > 0) this.call.cmds.senddata(" ".repeat(pad));
			this.call.cmds.senddata("(" + this._transportType + ")");
		} else {
			this.call.cmds.senddata("    Via : ");
			this.call.cmds.setfgcolor(onAddrField ? CLR_FIELD_ACTIVE : CLR_HEADER_DIM);
			this.call.cmds.senddata(this._transportType);
			if (onAddrField && !this._transportLocked && this._allowedTransports.length > 1) {
				this.call.cmds.setfgcolor(CLR_HEADER_DIM);
				this.call.cmds.senddata("  ");
				this.call.cmds.setfgcolor(CLR_NAV);
				this._sendGlyph("\u2190", 0x1B);
				this._sendGlyph("\u2192", 0x1A);
				this.call.cmds.setfgcolor(CLR_HEADER_DIM);
				this.call.cmds.senddata(" change");
			}
		}

		// Row 4: Subject (editable)
		this.call.cmds.movecursor(this._bodyLeft, 4);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(CLR_HEADER_LABEL);
		this.call.cmds.senddata("Subject : ");
		this.call.cmds.setfgcolor(this._state === STATE.FIELD_SUBJECT ? CLR_FIELD_ACTIVE : CLR_FIELD_INACTIVE);
		this.call.cmds.senddata(this._padRight(this._truncate(this._subjectValue, fieldW), fieldW));

		this.call.cmds.resetcolors();
	}

	_drawSeparator() {
		if (this.dumb) return;
		this.call.cmds.movecursor(this._bodyLeft, 5);
		this.call.cmds.setfgcolor(CLR_SEPARATOR);
		for (var i = 0; i < this._bodyWidth; i++) {
			this._sendGlyph("\u2500", CP437_HLINE);
		}
		this.call.cmds.resetcolors();
	}

	_drawBody() {
		if (this.dumb) return;
		var bodyClr = this._clrBody;
		var quoteClr = this._clrQuote;

		for (var vi = 0; vi < this._bodyViewHeight; vi++) {
			var lineIdx = this._scrollOffset + vi;
			var screenY = this._bodyViewStart + vi;
			this.call.cmds.movecursor(this._bodyLeft, screenY);
			this.call.cmds.cleartoeol();

			if (lineIdx >= 0 && lineIdx < this._lines.length) {
				var lineText = this._lines[lineIdx];
				var isQuote = this._isQuoteLine(lineText);
				this.call.cmds.setfgcolor(isQuote ? quoteClr : bodyClr);
				this.call.cmds.senddata(this._truncate(lineText, this._bodyWidth));
			}
		}
		this.call.cmds.resetcolors();
	}

	_drawStatusBar() {
		if (this.dumb) return;
		this.call.cmds.movecursor(1, this._statusRow);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(CLR_STATUS);

		switch (this._state) {
			case STATE.FIELD_FROM:
				if (this._fromOptions.length > 1) {
					this.call.cmds.senddata(" Left/Right to change sender name  |  Tab/Enter to advance");
				} else {
					this.call.cmds.senddata(" Tab/Enter to advance  |  ESC to abort");
				}
				break;
			case STATE.FIELD_TO:
			case STATE.FIELD_SUBJECT:
				this.call.cmds.senddata(" Tab/Enter to advance  |  ESC to abort");
				break;
			case STATE.FIELD_ADDRESS:
				if (this._transportType === "LOCAL") {
					if (!this._transportLocked && this._allowedTransports.length > 1) {
						this.call.cmds.senddata(" Left/Right to change transport  |  Tab/Enter to advance");
					} else {
						this.call.cmds.senddata(" Tab/Enter to advance  |  ESC to abort");
					}
				} else {
					var hint = " Enter " + this._transportType + " destination address";
					if (!this._transportLocked && this._allowedTransports.length > 1) {
						hint += "  |  Left/Right at start to change transport";
					}
					this.call.cmds.senddata(hint);
				}
				break;
			case STATE.BODY:
				var lineNum = this._cursorLine + 1;
				var totalLines = this._lines.length;
				var col = this._cursorCol + 1;
				this.call.cmds.senddata(" Line " + lineNum + "/" + totalLines +
					"  Col " + col + "  " +
					(this._insertMode ? "INS" : "OVR") +
					"  |  Via " + this._transportType);
				break;
			case STATE.QUOTING: {
				var sel = Object.keys(this._quoteSelected).length;
				this.call.cmds.setfgcolor(CLR_PROMPT);
				this.call.cmds.senddata(" Quote: [Enter] Toggle  [Ctrl+Q/ESC] Insert " + sel + " selected  [A] All  [N] None");
				break;
			}
			case STATE.CONFIRM_SAVE:
				this.call.cmds.setfgcolor(CLR_PROMPT);
				this.call.cmds.senddata(" Send this message? (Y/N)");
				break;
			case STATE.CONFIRM_ABORT:
				this.call.cmds.setfgcolor(CLR_PROMPT);
				this.call.cmds.senddata(" Abort message? (Y/N)");
				break;
		}
		this.call.cmds.resetcolors();
	}

	_drawNavBar() {
		if (this.dumb) return;
		this.call.cmds.movecursor(1, this._navRow);
		this.call.cmds.cleartoeol();

		if (this._state === STATE.BODY) {
			this.call.cmds.senddata(" ");
			this._navKey("Ctrl-S", "Send");
			this.call.cmds.senddata("  ");
			this._navKey("Ctrl-A", "Abort");
			this.call.cmds.senddata("  ");
			if (this._quoteLines.length > 0) {
				this._navKey("Ctrl-Q", "Quote");
				this.call.cmds.senddata("  ");
			}
			this._navKey("Ctrl-Z", "Save+Send");
		} else if (this._state === STATE.QUOTING) {
			this.call.cmds.senddata(" ");
			this._navKey("Enter", "Toggle");
			this.call.cmds.senddata("  ");
			this._navKey("Ctrl+Q", "Insert");
			this.call.cmds.senddata("  ");
			this._navKey("ESC", "Insert");
			this.call.cmds.senddata("  ");
			this._navKey("A", "All");
			this.call.cmds.senddata("  ");
			this._navKey("N", "None");
		}
		this.call.cmds.resetcolors();
	}

	_positionCursor() {
		if (this.dumb || !this.call) return;
		var fieldStartX = this._bodyLeft + 10; // after "Subject : "

		switch (this._state) {
			case STATE.FIELD_FROM:
				this.call.cmds.movecursor(fieldStartX + this._fromName.length, 1);
				break;
			case STATE.FIELD_TO:
				this.call.cmds.movecursor(fieldStartX + this._toPos, 2);
				break;
			case STATE.FIELD_ADDRESS:
				if (this._transportType === "LOCAL") {
					// Position after "LOCAL" text to show we're on this row
					this.call.cmds.movecursor(fieldStartX + this._transportType.length, 3);
				} else {
					this.call.cmds.movecursor(fieldStartX + this._toAddressPos, 3);
				}
				break;
			case STATE.FIELD_SUBJECT:
				this.call.cmds.movecursor(fieldStartX + this._subjectPos, 4);
				break;
			case STATE.BODY: {
				var screenLine = this._cursorLine - this._scrollOffset;
				if (screenLine >= 0 && screenLine < this._bodyViewHeight) {
					this.call.cmds.movecursor(this._bodyLeft + this._cursorCol, this._bodyViewStart + screenLine);
				}
				break;
			}
		}
	}

	_showError(text) {
		if (!this.call) return;
		if (this.dumb) {
			this.call.cmds.senddata("\r\n  " + text + "\r\n");
			return;
		}
		this.call.cmds.movecursor(1, this._statusRow);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(CLR_ERROR);
		this.call.cmds.senddata(" " + text);
		this.call.cmds.resetcolors();
	}

	_ensureCursorVisible() {
		if (this._cursorLine < this._scrollOffset) {
			this._scrollOffset = this._cursorLine;
			this._drawBody();
		} else if (this._cursorLine >= this._scrollOffset + this._bodyViewHeight) {
			this._scrollOffset = this._cursorLine - this._bodyViewHeight + 1;
			this._drawBody();
		}
	}

	// ===========================================================================
	// QUOTING
	// ===========================================================================

	_enterQuoteMode() {
		if (this._mode !== "reply" || this._quoteLines.length === 0) return;
		this._state = STATE.QUOTING;
		this._quoteCursor = 0;
		this._quoteScroll = 0;
		this._quoteSelected = {};
		this._drawQuotePanel();
		this._drawStatusBar();
		this._drawNavBar();
	}

	_exitQuoteMode() {
		// Insert selected lines at cursor position
		this._insertQuotedLines();
		this._state = STATE.BODY;
		this._drawBody();
		this._drawStatusBar();
		this._drawNavBar();
		this._positionCursor();
	}

	_drawQuotePanel() {
		if (this.dumb || !this.call) return;
		for (var vi = 0; vi < this._bodyViewHeight; vi++) {
			var lineIdx = this._quoteScroll + vi;
			var screenY = this._bodyViewStart + vi;

			this.call.cmds.movecursor(this._bodyLeft, screenY);
			this.call.cmds.cleartoeol();

			if (lineIdx >= this._quoteLines.length) continue;

			var isHighlighted = (lineIdx === this._quoteCursor);
			var isSelected = !!this._quoteSelected[lineIdx];

			if (isHighlighted) {
				this.call.cmds.setfgcolor(CLR_QUOTE_BAR_FG);
				this.call.cmds.setbgcolor(CLR_QUOTE_BAR_BG);
			} else {
				this.call.cmds.setfgcolor(isSelected ? CLR_QUOTE_BAR_FG : this._clrQuote);
			}

			var marker = isSelected ? "* " : "  ";
			var text = marker + this._truncate(this._quoteLines[lineIdx], this._bodyWidth - 4);

			// Pad highlighted rows to fill the bar
			if (isHighlighted) {
				while (text.length < this._bodyWidth - 2) text += " ";
			}

			this.call.cmds.senddata(" " + text);
			this.call.cmds.resetcolors();
		}
	}

	_quoteMoveUp() {
		if (this._quoteCursor <= 0) return;
		this._quoteCursor--;
		if (this._quoteCursor < this._quoteScroll) {
			this._quoteScroll = this._quoteCursor;
		}
		this._drawQuotePanel();
	}

	_quoteMoveDown() {
		if (this._quoteCursor >= this._quoteLines.length - 1) return;
		this._quoteCursor++;
		if (this._quoteCursor >= this._quoteScroll + this._bodyViewHeight) {
			this._quoteScroll = this._quoteCursor - this._bodyViewHeight + 1;
		}
		this._drawQuotePanel();
	}

	_quoteToggle() {
		if (this._quoteSelected[this._quoteCursor]) {
			delete this._quoteSelected[this._quoteCursor];
		} else {
			this._quoteSelected[this._quoteCursor] = true;
		}
		this._quoteMoveDown();
		this._drawStatusBar();
	}

	_quoteSelectAll() {
		for (var i = 0; i < this._quoteLines.length; i++) {
			this._quoteSelected[i] = true;
		}
		this._drawQuotePanel();
		this._drawStatusBar();
	}

	_quoteClearAll() {
		this._quoteSelected = {};
		this._drawQuotePanel();
		this._drawStatusBar();
	}

	_insertQuotedLines() {
		var indices = Object.keys(this._quoteSelected).map(Number).sort(function(a, b) { return a - b; });
		if (indices.length === 0) return;

		var quotedLines = [];
		for (var i = 0; i < indices.length; i++) {
			var line = this._quoteLines[indices[i]] || "";
			quotedLines.push("> " + line);
		}
		// Add a blank line after the quote block
		quotedLines.push("");

		// Insert at cursor position
		var beforeCursor = this._lines[this._cursorLine].substring(0, this._cursorCol);
		var afterCursor = this._lines[this._cursorLine].substring(this._cursorCol);

		// Split current line, insert quote block
		this._lines[this._cursorLine] = beforeCursor;
		var insertIdx = this._cursorLine + 1;
		for (var j = 0; j < quotedLines.length; j++) {
			this._lines.splice(insertIdx + j, 0, quotedLines[j]);
		}
		// If there was text after cursor, it's now on the line after the quotes
		if (afterCursor.length > 0) {
			this._lines.splice(insertIdx + quotedLines.length, 0, afterCursor);
		}

		// Move cursor to after the inserted block
		this._cursorLine = insertIdx + quotedLines.length;
		if (this._cursorLine >= this._lines.length) {
			this._cursorLine = this._lines.length - 1;
		}
		this._cursorCol = 0;
		this._ensureCursorVisible();
	}

	// ===========================================================================
	// SAVE
	// ===========================================================================

	async _doSave() {
		alogger.writeAlog(5, this.loggingId + " _doSave: starting", "cyan");

		var bodyText = this._lines.join("\r\n").trim();
		var isNetwork = (this._transportType !== "LOCAL");

		if (!this._toValue || this._toValue.trim().length === 0) {
			alogger.writeAlog(5, this.loggingId + " _doSave: empty recipient", "yellow");
			this._showError("Recipient cannot be blank!");
			this._state = STATE.FIELD_TO;
			this._positionCursor();
			return;
		}

		if (isNetwork && (!this._toAddress || this._toAddress.trim().length === 0)) {
			alogger.writeAlog(5, this.loggingId + " _doSave: empty address", "yellow");
			this._showError("Destination address is required for " + this._transportType + " messages!");
			this._state = STATE.FIELD_ADDRESS;
			this._positionCursor();
			return;
		}

		if (!this._subjectValue || this._subjectValue.trim().length === 0) {
			alogger.writeAlog(5, this.loggingId + " _doSave: empty subject", "yellow");
			this._showError("Subject cannot be blank!");
			this._state = STATE.FIELD_SUBJECT;
			this._positionCursor();
			return;
		}

		if (!bodyText || bodyText.length === 0) {
			alogger.writeAlog(5, this.loggingId + " _doSave: empty body", "yellow");
			this._showError("Cannot send an empty message!");
			this._state = STATE.BODY;
			this._positionCursor();
			return;
		}

		this._saving = true;
		alogger.writeAlog(5, this.loggingId + " _doSave: to='" + this._toValue.trim() +
			"' addr='" + (this._toAddress || "").trim() +
			"' subj='" + this._subjectValue.trim() + "' bodyLen=" + bodyText.length +
			" transport=" + this._transportType + " userId=" + this._userId, "cyan");

		try {
			var messageObj = {
				user_id: this._userId,
				to_user: this._titleCase(this._toValue.trim()),
				from_user: this._fromName,
				from_address: this._fromAddress || this._fromName,
				to_address: "",
				subject: this._subjectValue.trim(),
				body_text: bodyText,
				transport_type: this._transportType,
				transport_data: {},
			};

			if (isNetwork) {
				// --- Network path: no local user resolution needed ---
				var toAddr = this._toAddress.trim();
				messageObj.to_address = toAddr;
				messageObj.transport_data = {
					destination: toAddr,
				};

				if (this._transportType === "FTN") {
					// Parse FTN address components
					var ftnMatch = toAddr.match(/^(\d+):(\d+)\/(\d+)/);
					if (ftnMatch) {
						messageObj.transport_data.destination_zone = parseInt(ftnMatch[1]);
						messageObj.transport_data.destination_net = parseInt(ftnMatch[2]);
						messageObj.transport_data.destination_node = parseInt(ftnMatch[3]);
						messageObj.transport_data.source = this._fromAddress || "";
					} else {
						this._showError("Invalid FTN address format (expected zone:net/node)");
						this._saving = false;
						this._state = STATE.FIELD_ADDRESS;
						this._positionCursor();
						return;
					}
				}

				alogger.writeAlog(5, this.loggingId + " _doSave: network message, addr=" + toAddr, "cyan");

			} else {
				// --- LOCAL path: resolve recipient to a local user ---
				alogger.writeAlog(5, this.loggingId + " _doSave: resolving recipient '" + this._toValue.trim() + "'", "cyan");
				var resolution = await privateMessages.resolveRecipient(this._toValue.trim());
				alogger.writeAlog(5, this.loggingId + " _doSave: resolveRecipient result: " +
					JSON.stringify(resolution), "cyan");

				if (!resolution.resolved) {
					var reason = resolution.reason || "not found";
					if (reason === "ambiguous_match") {
						this._showError("Multiple users match \"" + this._toValue.trim() + "\". Be more specific.");
					} else {
						this._showError("User \"" + this._toValue.trim() + "\" not found.");
					}
					this._saving = false;
					this._state = STATE.FIELD_TO;
					this._positionCursor();
					return;
				}

				// Keep what the user typed as to_user for display
				// Use resolved username for to_address (routing)
				messageObj.to_address = resolution.username;
				messageObj.transport_data = {
					sender_user_id: this._userId,
					recipient_user_id: resolution.userId,
				};
			}

			alogger.writeAlog(5, this.loggingId + " _doSave: calling queueMessage, to_user=" +
				messageObj.to_user + " to_address=" + messageObj.to_address +
				" transport=" + messageObj.transport_type, "cyan");

			var result = await privateMessages.queueMessage(messageObj, this._userSession);

			alogger.writeAlog(5, this.loggingId + " _doSave: queueMessage result: " +
				JSON.stringify({ status: result?.status, errormessages: result?.errormessages }), "cyan");

			if (result && result.status === true) {
				this._saved = true;
				this._saving = false;
				if (this.dumb) {
					this.call.cmds.senddata("\r\n  Message sent.\r\n");
				} else {
					this.call.cmds.movecursor(1, this._statusRow);
					this.call.cmds.cleartoeol();
					this.call.cmds.setfgcolor(CLR_PROMPT);
					this.call.cmds.senddata(" Message sent successfully.");
					this.call.cmds.resetcolors();
				}
				setTimeout(() => { if (this.active) this.signalReturn(); }, 1000);
			} else {
				var errMsg = (result && result.errormessages && result.errormessages.length > 0)
					? result.errormessages[0]
					: "Send failed (no error detail)";
				alogger.writeAlog(3, this.loggingId + " _doSave: queueMessage failed: " + errMsg, "redbright");
				this._showError(errMsg);
				this._saving = false;
				this._state = STATE.BODY;
				this._positionCursor();
			}
		} catch (err) {
			alogger.writeAlog(3, this.loggingId + " _doSave: exception: " + (err?.stack || err), "redbright");
			this._showError("Error sending message.");
			this._saving = false;
			this._state = STATE.BODY;
			this._positionCursor();
		}
	}

	// ===========================================================================
	// INPUT HANDLING
	// ===========================================================================

	onKey(key) {
		if (this._saving) return;
		switch (this._state) {
			case STATE.FIELD_FROM:
			case STATE.FIELD_TO:
			case STATE.FIELD_ADDRESS:
			case STATE.FIELD_SUBJECT:
				if (key === "^Z") { this._state = STATE.CONFIRM_SAVE; this._drawStatusBar(); return; }
				if (key === "^A") { this._state = STATE.CONFIRM_ABORT; this._drawStatusBar(); return; }
				this._onKeyField(key);
				break;
			case STATE.BODY:
				this._onKeyBody(key);
				break;
			case STATE.QUOTING:
				this._onKeyQuoting(key);
				break;
			case STATE.CONFIRM_SAVE:
			case STATE.CONFIRM_ABORT:
				// Handled by onChar
				break;
		}
	}

	onChar(ch) {
		// Block input while async save is in progress
		if (this._saving) return;

		// Confirm states — any key that isn't Y cancels back to body (matches msgEditor)
		if (this._state === STATE.CONFIRM_SAVE) {
			if (ch.toLowerCase() === "y") {
				this._doSave().catch(err => {
					alogger.writeAlog(3, this.loggingId + " _doSave unhandled: " + (err?.stack || err), "redbright");
					this._saving = false;
					this._showError("Unexpected error during save.");
					this._state = STATE.BODY;
					this._positionCursor();
				});
			} else {
				this._state = STATE.BODY;
				this._drawStatusBar();
				this._drawNavBar();
				this._positionCursor();
			}
			return;
		}
		if (this._state === STATE.CONFIRM_ABORT) {
			if (ch.toLowerCase() === "y") {
				this.signalReturn();
			} else {
				this._state = STATE.BODY;
				this._drawStatusBar();
				this._drawNavBar();
				this._positionCursor();
			}
			return;
		}

		switch (this._state) {
			case STATE.FIELD_FROM:
				// From field: no text input, only ctrl chars
				if (ch === "\x1a" || ch === "\x13") { this._state = STATE.CONFIRM_SAVE; this._drawStatusBar(); return; }
				if (ch === "\x01") { this._state = STATE.CONFIRM_ABORT; this._drawStatusBar(); return; }
				return;
			case STATE.FIELD_TO:
			case STATE.FIELD_ADDRESS:
			case STATE.FIELD_SUBJECT:
				// Ctrl chars in field states (safety — also handled by onKey ^Z/^A)
				if (ch === "\x1a" || ch === "\x13") { this._state = STATE.CONFIRM_SAVE; this._drawStatusBar(); return; }
				if (ch === "\x01") { this._state = STATE.CONFIRM_ABORT; this._drawStatusBar(); return; }
				this._onCharField(ch);
				return;
			case STATE.BODY:
				this._onCharBody(ch);
				return;
			case STATE.QUOTING:
				this._onCharQuoting(ch);
				return;
		}
	}

	onCmd(cmd) {
		// Ctrl combos handled as raw chars in onChar
	}

	// --- Field helpers ---

	_getFieldState() {
		switch (this._state) {
			case STATE.FIELD_TO:      return { val: this._toValue, pos: this._toPos };
			case STATE.FIELD_ADDRESS: return { val: this._toAddress, pos: this._toAddressPos };
			case STATE.FIELD_SUBJECT: return { val: this._subjectValue, pos: this._subjectPos };
			default: return null;
		}
	}

	_setFieldState(val, pos) {
		switch (this._state) {
			case STATE.FIELD_TO:      this._toValue = val; this._toPos = pos; break;
			case STATE.FIELD_ADDRESS: this._toAddress = val; this._toAddressPos = pos; break;
			case STATE.FIELD_SUBJECT: this._subjectValue = val; this._subjectPos = pos; break;
		}
	}

	// --- Field editing ---

	_onKeyField(key) {
		switch (key) {
			case "Enter":
			case "Tab":
				if (this._state === STATE.FIELD_FROM) {
					this._state = STATE.FIELD_TO;
				} else if (this._state === STATE.FIELD_TO) {
					this._state = STATE.FIELD_ADDRESS;
				} else if (this._state === STATE.FIELD_ADDRESS) {
					this._state = STATE.FIELD_SUBJECT;
				} else {
					this._state = STATE.BODY;
				}
				this._drawHeader();
				this._drawStatusBar();
				this._drawNavBar();
				this._positionCursor();
				return;
			case "ESC":
				this._state = STATE.CONFIRM_ABORT;
				this._drawStatusBar();
				return;
			case "Backspace":
			case "Delete": {
				// No editing on From field or address field when LOCAL
				if (this._state === STATE.FIELD_FROM) return;
				if (this._state === STATE.FIELD_ADDRESS && this._transportType === "LOCAL") return;
				var fs = this._getFieldState();
				if (!fs) return;
				var val = fs.val, pos = fs.pos;
				if (key === "Backspace") {
					if (pos > 0) {
						val = val.substring(0, pos - 1) + val.substring(pos);
						pos--;
					}
				} else {
					if (pos < val.length) {
						val = val.substring(0, pos) + val.substring(pos + 1);
					}
				}
				this._setFieldState(val, pos);
				this._drawHeader();
				this._positionCursor();
				return;
			}
			case "LeftArrow": {
				// In FIELD_FROM: cycle from name
				if (this._state === STATE.FIELD_FROM) {
					this._cycleFromName(-1);
					return;
				}
				// In FIELD_ADDRESS: cycle transport if not locked and address empty or LOCAL
				if (this._state === STATE.FIELD_ADDRESS && !this._transportLocked &&
					this._allowedTransports.length > 1 &&
					(this._transportType === "LOCAL" || this._toAddress.length === 0 || this._toAddressPos === 0)) {
					this._cycleTransport(-1);
					return;
				}
				var fs = this._getFieldState();
				if (fs && fs.pos > 0) {
					this._setFieldState(fs.val, fs.pos - 1);
					this._positionCursor();
				}
				return;
			}
			case "RightArrow": {
				// In FIELD_FROM: cycle from name
				if (this._state === STATE.FIELD_FROM) {
					this._cycleFromName(1);
					return;
				}
				// In FIELD_ADDRESS: cycle transport if not locked and address empty or LOCAL
				if (this._state === STATE.FIELD_ADDRESS && !this._transportLocked &&
					this._allowedTransports.length > 1 &&
					(this._transportType === "LOCAL" || this._toAddress.length === 0 || this._toAddressPos >= this._toAddress.length)) {
					this._cycleTransport(1);
					return;
				}
				var fs = this._getFieldState();
				if (fs && fs.pos < fs.val.length) {
					this._setFieldState(fs.val, fs.pos + 1);
					this._positionCursor();
				}
				return;
			}
			case "Home": {
				if (this._state === STATE.FIELD_FROM) return;
				if (this._state === STATE.FIELD_ADDRESS && this._transportType === "LOCAL") return;
				this._setFieldState(this._getFieldState().val, 0);
				this._positionCursor();
				return;
			}
			case "End": {
				if (this._state === STATE.FIELD_FROM) return;
				if (this._state === STATE.FIELD_ADDRESS && this._transportType === "LOCAL") return;
				var fs = this._getFieldState();
				this._setFieldState(fs.val, fs.val.length);
				this._positionCursor();
				return;
			}
		}
	}

	_cycleTransport(direction) {
		this._transportIdx += direction;
		if (this._transportIdx < 0) this._transportIdx = this._allowedTransports.length - 1;
		if (this._transportIdx >= this._allowedTransports.length) this._transportIdx = 0;
		var oldType = this._transportType;
		this._transportType = this._allowedTransports[this._transportIdx];
		// Clear address if switching to LOCAL
		if (this._transportType === "LOCAL" && oldType !== "LOCAL") {
			this._toAddress = "";
			this._toAddressPos = 0;
		}
		this._drawHeader();
		this._drawStatusBar();
		this._positionCursor();
	}

	_onCharField(ch) {
		var code = ch.charCodeAt(0);
		if (code < 32 || code === 127) return;

		// No text input on From field (cycle only) or address field when LOCAL
		if (this._state === STATE.FIELD_FROM) return;
		if (this._state === STATE.FIELD_ADDRESS && this._transportType === "LOCAL") return;

		var fs = this._getFieldState();
		if (!fs) return;
		var val = fs.val, pos = fs.pos;

		if (val.length >= MAX_FIELD_LEN) return;

		val = val.substring(0, pos) + ch + val.substring(pos);
		pos++;

		this._setFieldState(val, pos);
		this._drawHeader();
		this._positionCursor();
	}

	// --- Body editing ---

	_onKeyBody(key) {
		switch (key) {
			case "UpArrow":
				if (this._cursorLine > 0) {
					this._cursorLine--;
					if (this._cursorCol > this._lines[this._cursorLine].length) {
						this._cursorCol = this._lines[this._cursorLine].length;
					}
					this._ensureCursorVisible();
					this._positionCursor();
				}
				return;
			case "DownArrow":
				if (this._cursorLine < this._lines.length - 1) {
					this._cursorLine++;
					if (this._cursorCol > this._lines[this._cursorLine].length) {
						this._cursorCol = this._lines[this._cursorLine].length;
					}
					this._ensureCursorVisible();
					this._positionCursor();
				}
				return;
			case "LeftArrow":
				if (this._cursorCol > 0) {
					this._cursorCol--;
				} else if (this._cursorLine > 0) {
					this._cursorLine--;
					this._cursorCol = this._lines[this._cursorLine].length;
					this._ensureCursorVisible();
				}
				this._positionCursor();
				return;
			case "RightArrow":
				if (this._cursorCol < this._lines[this._cursorLine].length) {
					this._cursorCol++;
				} else if (this._cursorLine < this._lines.length - 1) {
					this._cursorLine++;
					this._cursorCol = 0;
					this._ensureCursorVisible();
				}
				this._positionCursor();
				return;
			case "Home":
				this._cursorCol = 0;
				this._positionCursor();
				return;
			case "End":
				this._cursorCol = this._lines[this._cursorLine].length;
				this._positionCursor();
				return;
			case "PgUp":
				this._cursorLine = Math.max(0, this._cursorLine - this._bodyViewHeight);
				if (this._cursorCol > this._lines[this._cursorLine].length) {
					this._cursorCol = this._lines[this._cursorLine].length;
				}
				this._ensureCursorVisible();
				this._positionCursor();
				return;
			case "PgDn":
				this._cursorLine = Math.min(this._lines.length - 1, this._cursorLine + this._bodyViewHeight);
				if (this._cursorCol > this._lines[this._cursorLine].length) {
					this._cursorCol = this._lines[this._cursorLine].length;
				}
				this._ensureCursorVisible();
				this._positionCursor();
				return;
			case "Backspace":
				if (this._cursorCol > 0) {
					var line = this._lines[this._cursorLine];
					this._lines[this._cursorLine] = line.substring(0, this._cursorCol - 1) + line.substring(this._cursorCol);
					this._cursorCol--;
					this._drawBody();
					this._positionCursor();
				} else if (this._cursorLine > 0) {
					// Join with previous line
					var prevLen = this._lines[this._cursorLine - 1].length;
					this._lines[this._cursorLine - 1] += this._lines[this._cursorLine];
					this._lines.splice(this._cursorLine, 1);
					this._cursorLine--;
					this._cursorCol = prevLen;
					this._ensureCursorVisible();
					this._drawBody();
					this._positionCursor();
				}
				return;
			case "Delete": {
				var line = this._lines[this._cursorLine];
				if (this._cursorCol < line.length) {
					this._lines[this._cursorLine] = line.substring(0, this._cursorCol) + line.substring(this._cursorCol + 1);
					this._drawBody();
					this._positionCursor();
				} else if (this._cursorLine < this._lines.length - 1) {
					this._lines[this._cursorLine] += this._lines[this._cursorLine + 1];
					this._lines.splice(this._cursorLine + 1, 1);
					this._drawBody();
					this._positionCursor();
				}
				return;
			}
			case "Enter": {
				var line = this._lines[this._cursorLine];
				var before = line.substring(0, this._cursorCol);
				var after = line.substring(this._cursorCol);
				this._lines[this._cursorLine] = before;
				this._lines.splice(this._cursorLine + 1, 0, after);
				this._cursorLine++;
				this._cursorCol = 0;
				this._ensureCursorVisible();
				this._drawBody();
				this._drawStatusBar();
				this._positionCursor();
				return;
			}
			case "ESC":
				this._state = STATE.CONFIRM_ABORT;
				this._drawStatusBar();
				return;
			case "^Z":
				this._state = STATE.CONFIRM_SAVE;
				this._drawStatusBar();
				return;
			case "^A":
				this._state = STATE.CONFIRM_ABORT;
				this._drawStatusBar();
				return;
			case "Tab":
				// Insert a few spaces
				var spaces = "    ";
				var line = this._lines[this._cursorLine];
				this._lines[this._cursorLine] = line.substring(0, this._cursorCol) + spaces + line.substring(this._cursorCol);
				this._cursorCol += spaces.length;
				this._drawBody();
				this._positionCursor();
				return;
		}
	}

	_onCharBody(ch) {
		// Ctrl key combos (raw character codes)
		if (ch === "\x1a" || ch === "\x13") { // Ctrl+Z or Ctrl+S
			this._state = STATE.CONFIRM_SAVE;
			this._drawStatusBar();
			return;
		}
		if (ch === "\x01") { // Ctrl+A
			this._state = STATE.CONFIRM_ABORT;
			this._drawStatusBar();
			return;
		}
		if (ch === "\x11") { // Ctrl+Q
			if (this._quoteLines.length > 0) {
				this._enterQuoteMode();
			}
			return;
		}

		var code = ch.charCodeAt(0);
		if (code < 32 || code === 127) return;

		var line = this._lines[this._cursorLine];

		// Auto-wrap at MAX_BODY_WIDTH
		if (line.length >= MAX_BODY_WIDTH) {
			// Word wrap: find last space
			var wrapAt = line.lastIndexOf(" ");
			if (wrapAt > 0) {
				var overflow = line.substring(wrapAt + 1);
				this._lines[this._cursorLine] = line.substring(0, wrapAt);
				this._lines.splice(this._cursorLine + 1, 0, overflow + ch);
				this._cursorLine++;
				this._cursorCol = overflow.length + 1;
			} else {
				this._lines.splice(this._cursorLine + 1, 0, ch);
				this._cursorLine++;
				this._cursorCol = 1;
			}
		} else {
			if (this._insertMode) {
				this._lines[this._cursorLine] = line.substring(0, this._cursorCol) + ch + line.substring(this._cursorCol);
			} else {
				this._lines[this._cursorLine] = line.substring(0, this._cursorCol) + ch + line.substring(this._cursorCol + 1);
			}
			this._cursorCol++;
		}

		this._ensureCursorVisible();
		this._drawBody();
		this._drawStatusBar();
		this._positionCursor();
	}

	// --- Quoting input ---

	_onKeyQuoting(key) {
		switch (key) {
			case "UpArrow":   this._quoteMoveUp(); return;
			case "DownArrow": this._quoteMoveDown(); return;
			case "PgUp":
				this._quoteCursor = Math.max(0, this._quoteCursor - this._bodyViewHeight);
				if (this._quoteCursor < this._quoteScroll) this._quoteScroll = this._quoteCursor;
				this._drawQuotePanel();
				return;
			case "PgDn":
				this._quoteCursor = Math.min(this._quoteLines.length - 1, this._quoteCursor + this._bodyViewHeight);
				if (this._quoteCursor >= this._quoteScroll + this._bodyViewHeight) {
					this._quoteScroll = this._quoteCursor - this._bodyViewHeight + 1;
				}
				this._drawQuotePanel();
				return;
			case "Enter":     this._quoteToggle(); return;
			case "ESC":       this._exitQuoteMode(); return;
		}
	}

	_onCharQuoting(ch) {
		var lower = ch.toLowerCase();
		if (ch === "\x11") { this._exitQuoteMode(); return; } // Ctrl+Q exits + inserts
		if (lower === "a") { this._quoteSelectAll(); return; }
		if (lower === "n") { this._quoteClearAll(); return; }
	}

	// ===========================================================================
	// DUMB TERMINAL
	// ===========================================================================

	_startDumb() {
		this.call.cmds.senddata("\r\n");
		if (this._mode === "reply") {
			this.call.cmds.senddata("  Reply to: " + (this._replyToMsg?.from_user || "") + "\r\n");
		} else {
			this.call.cmds.senddata("  New Private Message\r\n");
		}
		this.call.cmds.senddata("  From: " + this._fromName + "\r\n");
		this.call.cmds.senddata("To [" + this._toValue + "]: ");
		this._dumbMode = "to";
		this._dumbBuf = "";
		this._dumbLines = [];
	}

	_handleDumbInput(ch) {
		if (!this.call) return;

		if (ch === "\r" || ch === "\n") {
			switch (this._dumbMode) {
				case "to":
					if (this._dumbBuf.trim()) this._toValue = this._dumbBuf.trim();
					this.call.cmds.senddata("\r\nSubject [" + this._subjectValue + "]: ");
					this._dumbMode = "subject";
					this._dumbBuf = "";
					return;
				case "subject":
					if (this._dumbBuf.trim()) this._subjectValue = this._dumbBuf.trim();
					this.call.cmds.senddata("\r\n  Enter message (blank line + /s to send, /a to abort):\r\n");
					this._dumbMode = "body";
					this._dumbBuf = "";
					return;
				case "body": {
					var line = this._dumbBuf;
					this._dumbBuf = "";
					if (line.trim() === "/s") {
						this._lines = this._dumbLines;
						this._doSave();
						return;
					}
					if (line.trim() === "/a") {
						this.call.cmds.senddata("  Aborted.\r\n");
						setTimeout(() => { if (this.active) this.signalReturn(); }, 500);
						return;
					}
					this._dumbLines.push(line);
					this.call.cmds.senddata("\r\n");
					return;
				}
			}
		} else if (ch === "\x08" || ch === "\x7f") {
			if (this._dumbBuf.length > 0) {
				this._dumbBuf = this._dumbBuf.substring(0, this._dumbBuf.length - 1);
				this.call.cmds.senddata("\x08 \x08");
			}
		} else {
			var code = ch.charCodeAt(0);
			if (code >= 32) {
				this._dumbBuf += ch;
				this.call.cmds.senddata(ch);
			}
		}
	}

	// ===========================================================================
	// ENTRY POINT
	// ===========================================================================

	handleInput(inputArray) {
		if (this.dumb) {
			// Dumb terminal: raw character handling
			for (var i = 0; i < inputArray.length; i++) {
				var token = inputArray[i];
				if (token.startsWith && token.startsWith("CHAR_")) {
					this._handleDumbInput(token.substring(5));
				} else if (token === "KEY_Enter") {
					this._handleDumbInput("\r");
				} else if (token === "KEY_Backspace") {
					this._handleDumbInput("\x08");
				}
			}
			return;
		}
		super.handleInput(inputArray);
	}

	run() {
		if (!this._userId) {
			if (this.dumb) {
				this.call.cmds.senddata("\r\n  You must be logged in.\r\n");
			}
			setTimeout(() => { if (this.active) this.signalReturn(); }, 1000);
			return;
		}

		this._calcGeometry();
		this._resolveFromName();

		// Check transport access
		var accessCheck = privateMessages.checkTransportAccess(this._userSession, this._transportType);
		if (!accessCheck.allowed) {
			if (this.dumb) {
				this.call.cmds.senddata("\r\n  " + (accessCheck.reason || "No permission") + "\r\n");
			} else {
				this.call.cmds.clearscreen();
				this.call.cmds.movecursor(1, 3);
				this.call.cmds.setfgcolor(CLR_ERROR);
				this.call.cmds.senddata("  " + (accessCheck.reason || "No permission to send messages."));
				this.call.cmds.resetcolors();
			}
			setTimeout(() => { if (this.active) this.signalReturn(); }, 2000);
			return;
		}

		this._prefillFields();
		this._prepareQuoteLines();

		if (this.dumb) {
			this._startDumb();
		} else {
			this._state = STATE.FIELD_FROM;
			this._drawScreen();
		}
	}

	clearHandler() {
		if (!this.active) return;
		this._lines = [];
		this._quoteLines = [];
		this._quoteSelected = {};
		this._replyToMsg = null;
		super.clearHandler();
	}
}

export { pmEditor };
