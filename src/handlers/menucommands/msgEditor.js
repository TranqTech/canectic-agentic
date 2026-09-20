import { BaseSubModule } from "../basesubmodule.js";
import { saveMessage } from "../../models/messages.js";
import { getAreaByShortcode } from "../../models/msgAreas.js";
import * as alogger from "../../utils/alogger.js";

// --- Flag helpers ---

function parseFlags(val) {
	if (!val) return [];
	if (Array.isArray(val)) return val;
	if (typeof val === "string") {
		try { var p = JSON.parse(val); return Array.isArray(p) ? p : []; }
		catch (_) { return []; }
	}
	return [];
}

function checkPostAccess(userRecord, areaConfig) {
	if (!userRecord || !areaConfig) return false;
	var userSecurity = parseInt(userRecord.security) || 0;
	if (areaConfig.post_security && userSecurity < areaConfig.post_security) return false;
	var userPerms  = parseFlags(userRecord.permissionflags);
	var userRestrs = parseFlags(userRecord.restrictionflags);
	var reqFlags   = parseFlags(areaConfig.post_perm_flags);
	var restFlags  = parseFlags(areaConfig.post_rest_flags);
	if (reqFlags.length > 0 && !reqFlags.every(function(f) { return userPerms.includes(f); })) return false;
	if (restFlags.length > 0 && restFlags.some(function(f) { return userRestrs.includes(f); })) return false;
	return true;
}

// --- Constants ---

const STATE = {
	FIELD_TO: 0,
	FIELD_SUBJECT: 1,
	BODY: 2,
	QUOTING: 3,
	CONFIRM_SAVE: 4,
	CONFIRM_ABORT: 5,
};

const MAX_BODY_WIDTH = 79;   // Hard wrap for FTN/QWK compatibility
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

// Default body semantic colors (overridable via theme, matching reader)
const DF_CLR_BODY = 11;      // Editing text — bright yellow
const DF_CLR_QUOTE = 14;     // Quote lines — bright cyan

// CP437 safe glyphs
const CP437_HLINE = 0xC4;

// =========================================================================

class msgEditor extends BaseSubModule {
	constructor(call, options) {
		super(call, "MsgEditor");

		var opts = options || {};

		// Encoding
		var enc = (call.term_encoding || "").toLowerCase();
		this._isUTF8 = (enc === "utf8" || enc === "utf-8");

		// Mode
		this._mode = opts.mode || "new";          // "new" or "reply"
		this._areaShortcode = opts.shortcode || call.msg_area || "";
		this._areaName = call.msg_area_title || call.msg_area || "";
		this._areaConfig = null;
		this._threadUUID = opts.threadUUID || null;
		this._replyToMsg = opts.replyToMsg || null;

		// Resolved from name
		this._fromName = "";

		// Field values
		this._toValue = "";
		this._subjectValue = "";
		this._toPos = 0;
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
		this._quoteSelected = {};  // index -> true

		// State
		this._state = STATE.FIELD_TO;
		this._saved = false;

		// Geometry
		this._termW = call.term_width || 80;
		this._termH = call.term_height || 24;
		this._bodyWidth = 0;
		this._bodyLeft = 0;
		this._bodyViewStart = 5;
		this._bodyViewEnd = 0;
		this._bodyViewHeight = 0;
		this._statusRow = 0;
		this._navRow = 0;

		// Dumb terminal state
		this._dumbMode = "to";
		this._dumbBuf = "";
		this._dumbLines = [];

		// Body semantic colors (from theme, with defaults matching reader)
		var theme = call.theme || {};
		this._clrBody = theme.msg_body_clr !== undefined ? theme.msg_body_clr : DF_CLR_BODY;
		this._clrQuote = theme.msg_quote_clr !== undefined ? theme.msg_quote_clr : DF_CLR_QUOTE;

		this.loggingId = "MsgEditor (Node " + call.nodenum + ")";
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

	// Detect quote lines — same patterns as termMsgFormat.classifyLine
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
		this._bodyViewStart = 5;
		this._bodyViewEnd = this._termH - 2;
		this._bodyViewHeight = this._bodyViewEnd - this._bodyViewStart + 1;
		if (this._bodyViewHeight < 3) this._bodyViewHeight = 3;
	}

	// --- Name resolution ---

	async _resolveFromName() {
		// Load area config to check post_as
		this._areaConfig = await getAreaByShortcode(this._areaShortcode);
		if (!this._areaConfig) {
			this._fromName = this.call.caller_username;
			return;
		}
		this._areaName = this._areaConfig.name || this._areaShortcode;
		var postAs = this._areaConfig.post_as || "username";
		if (postAs === "realname") {
			this._fromName = this.call.caller_fullname || this.call.caller_username;
		} else {
			this._fromName = this.call.caller_username;
		}
	}

	// --- Pre-fill fields ---

	_prefillFields() {
		if (this._mode === "reply" && this._replyToMsg) {
			this._toValue = this._replyToMsg.from_user || "All";
			var subj = this._replyToMsg.subject || "";
			if (!subj.toLowerCase().startsWith("re:")) {
				subj = "Re: " + subj;
			}
			this._subjectValue = subj.substring(0, MAX_FIELD_LEN);
		} else {
			this._toValue = "All";
			this._subjectValue = "";
		}
		this._toPos = this._toValue.length;
		this._subjectPos = this._subjectValue.length;
	}

	// --- Quote preparation ---

	_prepareQuoteLines() {
		if (!this._replyToMsg) {
			this._quoteLines = [];
			return;
		}
		var rawText = this._replyToMsg.body_text || "";
		rawText = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		var sourceLines = rawText.split("\n");

		this._quoteLines = [];
		for (var i = 0; i < sourceLines.length; i++) {
			var line = sourceLines[i];
			if (line.length <= MAX_QUOTE_WIDTH) {
				this._quoteLines.push(line);
			} else {
				// Word-wrap long lines
				var remaining = line;
				while (remaining.length > MAX_QUOTE_WIDTH) {
					var breakAt = remaining.lastIndexOf(" ", MAX_QUOTE_WIDTH);
					if (breakAt <= 0) breakAt = MAX_QUOTE_WIDTH;
					this._quoteLines.push(remaining.substring(0, breakAt));
					remaining = remaining.substring(breakAt);
					if (remaining.charAt(0) === " ") remaining = remaining.substring(1);
				}
				this._quoteLines.push(remaining);
			}
		}
	}

	// --- String helpers ---

	_truncate(str, len) {
		if (!str) return "";
		return str.length > len ? str.substring(0, len) : str;
	}

	// ===========================================================================
	// DRAWING — FULLSCREEN
	// ===========================================================================

	_drawScreen() {
		if (!this.call || this.dumb) return;
		this.call.cmds.clearscreen();
		this._drawHeader();
		this._drawSeparator();
		this._drawBodyViewport();
		this._drawStatusBar();
		this._drawCommandBar();
		this._positionCursor();
	}

	_drawHeader() {
		if (this.dumb) return;
		// Row 1: From (display-only) + Area
		this.call.cmds.movecursor(1, 1);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(CLR_HEADER_LABEL);
		this.call.cmds.senddata(" From: ");
		this.call.cmds.setfgcolor(CLR_HEADER_DIM);
		this.call.cmds.senddata(this._truncate(this._fromName, this._termW - 30));
		var areaLabel = "Area: " + this._areaName;
		var areaX = this._termW - areaLabel.length;
		if (areaX > 0) {
			this.call.cmds.movecursor(areaX, 1);
			this.call.cmds.setfgcolor(CLR_HEADER_LABEL);
			this.call.cmds.senddata("Area: ");
			this.call.cmds.setfgcolor(CLR_HEADER_DIM);
			this.call.cmds.senddata(this._areaName);
		}

		// Row 2: To (editable)
		this._drawToField();

		// Row 3: Subject (editable)
		this._drawSubjectField();
	}

	_drawToField() {
		if (this.dumb) return;
		this.call.cmds.movecursor(1, 2);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(CLR_HEADER_LABEL);
		this.call.cmds.senddata("   To: ");
		var clr = (this._state === STATE.FIELD_TO) ? CLR_FIELD_ACTIVE : CLR_FIELD_INACTIVE;
		this.call.cmds.setfgcolor(clr);
		this.call.cmds.senddata(this._toValue);
		this.call.cmds.resetcolors();
	}

	_drawSubjectField() {
		if (this.dumb) return;
		this.call.cmds.movecursor(1, 3);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(CLR_HEADER_LABEL);
		this.call.cmds.senddata(" Subj: ");
		var clr = (this._state === STATE.FIELD_SUBJECT) ? CLR_FIELD_ACTIVE : CLR_FIELD_INACTIVE;
		this.call.cmds.setfgcolor(clr);
		this.call.cmds.senddata(this._subjectValue);
		this.call.cmds.resetcolors();
	}

	_drawSeparator() {
		if (this.dumb) return;
		this.call.cmds.movecursor(1, 4);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(CLR_SEPARATOR);
		var count = this._termW - 1;
		for (var i = 0; i < count; i++) {
			this._sendGlyph("\u2500", CP437_HLINE);
		}
		this.call.cmds.resetcolors();
	}

	_drawBodyViewport() {
		if (this.dumb) return;
		for (var vi = 0; vi < this._bodyViewHeight; vi++) {
			var lineIdx = this._scrollOffset + vi;
			var screenY = this._bodyViewStart + vi;

			this.call.cmds.movecursor(this._bodyLeft, screenY);
			this.call.cmds.cleartoeol();

			if (lineIdx < this._lines.length) {
				var displayLine = this._lines[lineIdx];
				if (this._isQuoteLine(displayLine)) {
					this.call.cmds.setfgcolor(this._clrQuote);
				} else {
					this.call.cmds.setfgcolor(this._clrBody);
				}
				this.call.cmds.senddata(" " + this._truncate(displayLine, this._bodyWidth - 2));
			}
		}
		this.call.cmds.resetcolors();
	}

	_drawBodyLine(lineIdx) {
		if (this.dumb) return;
		var vi = lineIdx - this._scrollOffset;
		if (vi < 0 || vi >= this._bodyViewHeight) return;
		var screenY = this._bodyViewStart + vi;

		this.call.cmds.movecursor(this._bodyLeft, screenY);
		this.call.cmds.cleartoeol();

		if (lineIdx < this._lines.length) {
			var displayLine = this._lines[lineIdx];
			if (this._isQuoteLine(displayLine)) {
				this.call.cmds.setfgcolor(this._clrQuote);
			} else {
				this.call.cmds.setfgcolor(this._clrBody);
			}
			this.call.cmds.senddata(" " + this._truncate(displayLine, this._bodyWidth - 2));
		}
		this.call.cmds.resetcolors();
	}

	_drawStatusBar() {
		if (this.dumb) return;
		this.call.cmds.movecursor(1, this._statusRow);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(CLR_STATUS);

		if (this._state === STATE.CONFIRM_SAVE) {
			this.call.cmds.setfgcolor(CLR_PROMPT);
			this.call.cmds.senddata(" Save message? (Y/N): ");
		} else if (this._state === STATE.CONFIRM_ABORT) {
			this.call.cmds.setfgcolor(CLR_ERROR);
			this.call.cmds.senddata(" Abort message? (Y/N): ");
		} else if (this._state === STATE.BODY) {
			var line = this._cursorLine + 1;
			var col = this._cursorCol + 1;
			var total = this._lines.length;
			var canUp = this._scrollOffset > 0;
			var canDown = this._scrollOffset + this._bodyViewHeight < this._lines.length;
			var scrollInd = "";
			if (canUp && canDown) scrollInd = "  ^v";
			else if (canUp) scrollInd = "  ^";
			else if (canDown) scrollInd = "  v";
			this.call.cmds.senddata(" Line " + line + "/" + total + "  Col " + col + scrollInd);
		} else if (this._state === STATE.QUOTING) {
			var sel = Object.keys(this._quoteSelected).length;
			this.call.cmds.setfgcolor(CLR_PROMPT);
			this.call.cmds.senddata(" Quote: [Enter] Toggle  [Ctrl+Q/ESC] Insert " + sel + " selected  [A] All  [N] None");
		} else {
			this.call.cmds.senddata(" Editing...");
		}
		this.call.cmds.resetcolors();
	}

	_drawCommandBar() {
		if (this.dumb) return;
		this.call.cmds.movecursor(1, this._navRow);
		this.call.cmds.cleartoeol();

		if (this._state === STATE.QUOTING) {
			this.call.cmds.senddata(" ");
			this._navKey("Enter", "Toggle");
			this.call.cmds.senddata("  ");
			this._navKey("A", "Select All");
			this.call.cmds.senddata("  ");
			this._navKey("N", "Clear");
			this.call.cmds.senddata("  ");
			this._navKey("Esc", "Insert & Return");
		} else {
			this.call.cmds.senddata(" ");
			this._navKey("^Z", "Save");
			this.call.cmds.senddata("  ");
			this._navKey("^A", "Abort");
			if (this._mode === "reply" && this._quoteLines.length > 0) {
				this.call.cmds.senddata("  ");
				this._navKey("^Q", "Quote");
			}
			this.call.cmds.senddata("  ");
			this._navKey("Tab", "Fields");
		}
		this.call.cmds.resetcolors();
	}

	// --- Cursor positioning ---

	_positionCursor() {
		if (this.dumb || !this.call) return;

		switch (this._state) {
			case STATE.FIELD_TO:
				this.call.cmds.movecursor(8 + this._toPos, 2);
				break;
			case STATE.FIELD_SUBJECT:
				this.call.cmds.movecursor(8 + this._subjectPos, 3);
				break;
			case STATE.BODY: {
				var screenLine = this._cursorLine - this._scrollOffset;
				var screenY = this._bodyViewStart + screenLine;
				var screenX = this._bodyLeft + 1 + this._cursorCol;
				this.call.cmds.movecursor(screenX, screenY);
				break;
			}
		}
	}

	_ensureCursorVisible() {
		if (this._cursorLine < this._scrollOffset) {
			this._scrollOffset = this._cursorLine;
		} else if (this._cursorLine >= this._scrollOffset + this._bodyViewHeight) {
			this._scrollOffset = this._cursorLine - this._bodyViewHeight + 1;
		}
	}

	// ===========================================================================
	// FIELD EDITING
	// ===========================================================================

	_handleFieldKey(key) {
		var isTo = (this._state === STATE.FIELD_TO);
		var value = isTo ? this._toValue : this._subjectValue;
		var pos = isTo ? this._toPos : this._subjectPos;

		switch (key) {
			case "LeftArrow":
				if (pos > 0) pos--;
				break;
			case "RightArrow":
				if (pos < value.length) pos++;
				break;
			case "Home":
				pos = 0;
				break;
			case "End":
				pos = value.length;
				break;
			case "Backspace":
				if (pos > 0) {
					value = value.substring(0, pos - 1) + value.substring(pos);
					pos--;
				}
				break;
			case "Delete":
				if (pos < value.length) {
					value = value.substring(0, pos) + value.substring(pos + 1);
				}
				break;
			case "Tab":
			case "Enter":
				if (isTo) {
					this._state = STATE.FIELD_SUBJECT;
					this._drawToField();
					this._drawSubjectField();
					this._drawStatusBar();
					this._positionCursor();
				} else {
					this._state = STATE.BODY;
					this._drawSubjectField();
					this._drawStatusBar();
					this._drawCommandBar();
					this._positionCursor();
				}
				if (isTo) { this._toValue = value; this._toPos = pos; }
				else { this._subjectValue = value; this._subjectPos = pos; }
				return;
			case "ESC":
				this._state = STATE.CONFIRM_ABORT;
				this._drawStatusBar();
				return;
			default:
				if (isTo) { this._toValue = value; this._toPos = pos; }
				else { this._subjectValue = value; this._subjectPos = pos; }
				return;
		}

		if (isTo) {
			this._toValue = value;
			this._toPos = pos;
			this._drawToField();
		} else {
			this._subjectValue = value;
			this._subjectPos = pos;
			this._drawSubjectField();
		}
		this._positionCursor();
	}

	_handleFieldChar(ch) {
		var isTo = (this._state === STATE.FIELD_TO);
		var value = isTo ? this._toValue : this._subjectValue;
		var pos = isTo ? this._toPos : this._subjectPos;

		if (value.length >= MAX_FIELD_LEN) return;

		value = value.substring(0, pos) + ch + value.substring(pos);
		pos++;

		if (isTo) {
			this._toValue = value;
			this._toPos = pos;
			this._drawToField();
		} else {
			this._subjectValue = value;
			this._subjectPos = pos;
			this._drawSubjectField();
		}
		this._positionCursor();
	}

	// ===========================================================================
	// BODY EDITING
	// ===========================================================================

	_insertChar(ch) {
		var line = this._lines[this._cursorLine];
		if (this._insertMode) {
			line = line.substring(0, this._cursorCol) + ch + line.substring(this._cursorCol);
		} else {
			// Overwrite mode
			line = line.substring(0, this._cursorCol) + ch + line.substring(this._cursorCol + 1);
		}
		this._lines[this._cursorLine] = line;
		this._cursorCol++;

		// Auto word-wrap
		if (line.length > MAX_BODY_WIDTH) {
			this._doWordWrap(this._cursorLine);
		} else {
			this._drawBodyLine(this._cursorLine);
		}

		this._positionCursor();
	}

	_doWordWrap(lineIdx) {
		var line = this._lines[lineIdx];
		if (line.length <= MAX_BODY_WIDTH) return;

		// Find the last space before the wrap point
		var breakAt = line.lastIndexOf(" ", MAX_BODY_WIDTH);
		if (breakAt <= 0) {
			// No good break — hard wrap
			breakAt = MAX_BODY_WIDTH;
		}

		var keep = line.substring(0, breakAt);
		var overflow = line.substring(breakAt);
		if (overflow.charAt(0) === " ") overflow = overflow.substring(1);

		this._lines[lineIdx] = keep;

		// Push overflow to next line
		if (lineIdx + 1 < this._lines.length) {
			// Prepend to the existing next line
			var nextLine = this._lines[lineIdx + 1];
			// Only merge if the next line isn't a blank separator or quote
			if (nextLine.length > 0 && !this._isQuoteLine(nextLine)) {
				this._lines[lineIdx + 1] = overflow + " " + nextLine;
			} else {
				// Insert a new line
				this._lines.splice(lineIdx + 1, 0, overflow);
			}
		} else {
			this._lines.push(overflow);
		}

		// Adjust cursor if it was in the overflow region
		if (this._cursorLine === lineIdx && this._cursorCol > keep.length) {
			this._cursorLine++;
			this._cursorCol = this._cursorCol - breakAt;
			if (overflow.charAt(0) === " ") this._cursorCol--; // account for stripped space
			if (this._cursorCol < 0) this._cursorCol = 0;
		}

		// Recursively wrap the next line if it's now too long
		if (this._lines[lineIdx + 1] && this._lines[lineIdx + 1].length > MAX_BODY_WIDTH) {
			this._doWordWrap(lineIdx + 1);
		}

		this._ensureCursorVisible();
		this._drawBodyViewport();
		this._drawStatusBar();
	}

	_doEnter() {
		var line = this._lines[this._cursorLine];
		var before = line.substring(0, this._cursorCol);
		var after = line.substring(this._cursorCol);
		this._lines[this._cursorLine] = before;
		this._lines.splice(this._cursorLine + 1, 0, after);
		this._cursorLine++;
		this._cursorCol = 0;
		this._ensureCursorVisible();
		this._drawBodyViewport();
		this._drawStatusBar();
		this._positionCursor();
	}

	_doBackspace() {
		if (this._cursorCol > 0) {
			var line = this._lines[this._cursorLine];
			this._lines[this._cursorLine] = line.substring(0, this._cursorCol - 1) + line.substring(this._cursorCol);
			this._cursorCol--;
			this._drawBodyLine(this._cursorLine);
			this._positionCursor();
		} else if (this._cursorLine > 0) {
			// Merge with previous line
			var prevLine = this._lines[this._cursorLine - 1];
			var currLine = this._lines[this._cursorLine];
			this._cursorCol = prevLine.length;
			this._lines[this._cursorLine - 1] = prevLine + currLine;
			this._lines.splice(this._cursorLine, 1);
			this._cursorLine--;
			this._ensureCursorVisible();
			// Check if merged line needs wrapping
			if (this._lines[this._cursorLine].length > MAX_BODY_WIDTH) {
				this._doWordWrap(this._cursorLine);
			} else {
				this._drawBodyViewport();
			}
			this._drawStatusBar();
			this._positionCursor();
		}
	}

	_doDelete() {
		var line = this._lines[this._cursorLine];
		if (this._cursorCol < line.length) {
			this._lines[this._cursorLine] = line.substring(0, this._cursorCol) + line.substring(this._cursorCol + 1);
			this._drawBodyLine(this._cursorLine);
			this._positionCursor();
		} else if (this._cursorLine < this._lines.length - 1) {
			// Merge next line into current
			this._lines[this._cursorLine] = line + this._lines[this._cursorLine + 1];
			this._lines.splice(this._cursorLine + 1, 1);
			if (this._lines[this._cursorLine].length > MAX_BODY_WIDTH) {
				this._doWordWrap(this._cursorLine);
			} else {
				this._drawBodyViewport();
			}
			this._drawStatusBar();
			this._positionCursor();
		}
	}

	_moveCursorUp() {
		if (this._cursorLine > 0) {
			this._cursorLine--;
			if (this._cursorCol > this._lines[this._cursorLine].length) {
				this._cursorCol = this._lines[this._cursorLine].length;
			}
			this._ensureCursorVisible();
			this._drawBodyViewport();
			this._drawStatusBar();
			this._positionCursor();
		}
	}

	_moveCursorDown() {
		if (this._cursorLine < this._lines.length - 1) {
			this._cursorLine++;
			if (this._cursorCol > this._lines[this._cursorLine].length) {
				this._cursorCol = this._lines[this._cursorLine].length;
			}
			this._ensureCursorVisible();
			this._drawBodyViewport();
			this._drawStatusBar();
			this._positionCursor();
		}
	}

	_moveCursorLeft() {
		if (this._cursorCol > 0) {
			this._cursorCol--;
			this._positionCursor();
		} else if (this._cursorLine > 0) {
			this._cursorLine--;
			this._cursorCol = this._lines[this._cursorLine].length;
			this._ensureCursorVisible();
			this._drawBodyViewport();
			this._drawStatusBar();
			this._positionCursor();
		}
	}

	_moveCursorRight() {
		var lineLen = this._lines[this._cursorLine].length;
		if (this._cursorCol < lineLen) {
			this._cursorCol++;
			this._positionCursor();
		} else if (this._cursorLine < this._lines.length - 1) {
			this._cursorLine++;
			this._cursorCol = 0;
			this._ensureCursorVisible();
			this._drawBodyViewport();
			this._drawStatusBar();
			this._positionCursor();
		}
	}

	_pageUp() {
		this._cursorLine = Math.max(0, this._cursorLine - this._bodyViewHeight);
		if (this._cursorCol > this._lines[this._cursorLine].length) {
			this._cursorCol = this._lines[this._cursorLine].length;
		}
		this._ensureCursorVisible();
		this._drawBodyViewport();
		this._drawStatusBar();
		this._positionCursor();
	}

	_pageDown() {
		this._cursorLine = Math.min(this._lines.length - 1, this._cursorLine + this._bodyViewHeight);
		if (this._cursorCol > this._lines[this._cursorLine].length) {
			this._cursorCol = this._lines[this._cursorLine].length;
		}
		this._ensureCursorVisible();
		this._drawBodyViewport();
		this._drawStatusBar();
		this._positionCursor();
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
		this._drawCommandBar();
	}

	_exitQuoteMode() {
		// Insert selected lines at cursor position
		this._insertQuotedLines();
		this._state = STATE.BODY;
		this._drawBodyViewport();
		this._drawStatusBar();
		this._drawCommandBar();
		this._positionCursor();
	}

	_drawQuotePanel() {
		if (this.dumb) return;
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
				// All source text in quote color — selected lines get bright white
				// to distinguish "toggled on" from "not yet toggled"
				this.call.cmds.setfgcolor(isSelected ? CLR_QUOTE_BAR_FG : this._clrQuote);
			}

			var marker = isSelected ? "* " : "  ";
			var text = marker + this._truncate(this._quoteLines[lineIdx], this._bodyWidth - 4);

			// Pad highlighted rows
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
		var indices = Object.keys(this._quoteSelected).map(Number).sort((a, b) => a - b);
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
	// SAVE / ABORT
	// ===========================================================================

	async _doSave() {
		// Build body text from lines
		var bodyText = this._lines.join("\r\n").trim();

		if (!this._subjectValue || this._subjectValue.trim().length === 0) {
			this._showError("Subject cannot be blank!");
			this._state = STATE.FIELD_SUBJECT;
			this._drawStatusBar();
			this._positionCursor();
			return;
		}

		if (!bodyText || bodyText.length === 0) {
			this._showError("Cannot send an empty message!");
			this._state = STATE.BODY;
			this._drawStatusBar();
			this._positionCursor();
			return;
		}

		var formObj = {
			from_user: this._fromName,
			to_user: this._toValue || "All",
			subject: this._subjectValue.trim(),
			body_text: bodyText,
		};

		// Identify the parent message by its DB uuid; replyToThread looks
		// up msg_id / msg_orig_addr from the authoritative row so the
		// @REPLY kludge tuple always matches what's stored.
		if (this._mode === "reply" && this._replyToMsg && this._replyToMsg.uuid) {
			formObj.reply_to_uuid = this._replyToMsg.uuid;
		}

		try {
			var result = await saveMessage(formObj, this._areaShortcode, this._threadUUID);
			if (result.status === true) {
				this._saved = true;
				if (this.dumb) {
					this.call.cmds.senddata("\r\n  Message saved.\r\n");
				} else {
					this.call.cmds.movecursor(1, this._statusRow);
					this.call.cmds.cleartoeol();
					this.call.cmds.setfgcolor(CLR_PROMPT);
					this.call.cmds.senddata(" Message saved successfully.");
					this.call.cmds.resetcolors();
				}
				setTimeout(() => { if (this.active) this.signalReturn(); }, 1000);
			} else {
				var errMsg = (result.errormessages && result.errormessages.length > 0)
					? result.errormessages[0]
					: "Save failed";
				this._showError(errMsg);
				this._state = STATE.BODY;
				this._drawStatusBar();
				this._positionCursor();
			}
		} catch (err) {
			alogger.writeAlog(3, this.loggingId + " save error: " + (err?.stack || err), "redbright");
			this._showError("Error saving message.");
			this._state = STATE.BODY;
			this._drawStatusBar();
			this._positionCursor();
		}
	}

	_showError(msg) {
		if (this.dumb) {
			this.call.cmds.senddata("\r\n  " + msg + "\r\n");
			return;
		}
		this.call.cmds.movecursor(1, this._statusRow);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(CLR_ERROR);
		this.call.cmds.senddata(" " + msg);
		this.call.cmds.resetcolors();
	}

	// ===========================================================================
	// INPUT HANDLING
	// ===========================================================================

	onKey(key) {
		switch (this._state) {
			case STATE.FIELD_TO:
			case STATE.FIELD_SUBJECT:
				if (key === "^Z") { this._state = STATE.CONFIRM_SAVE; this._drawStatusBar(); return; }
				if (key === "^A") { this._state = STATE.CONFIRM_ABORT; this._drawStatusBar(); return; }
				this._handleFieldKey(key);
				return;

			case STATE.BODY:
				this._onKeyBody(key);
				return;

			case STATE.QUOTING:
				this._onKeyQuoting(key);
				return;

			case STATE.CONFIRM_SAVE:
			case STATE.CONFIRM_ABORT:
				// Handled by onChar
				return;
		}
	}

	onChar(ch) {
		switch (this._state) {
			case STATE.FIELD_TO:
			case STATE.FIELD_SUBJECT:
				if (ch === "\x1a") { this._state = STATE.CONFIRM_SAVE; this._drawStatusBar(); return; } // Ctrl+Z
				if (ch === "\x01") { this._state = STATE.CONFIRM_ABORT; this._drawStatusBar(); return; } // Ctrl+A
				this._handleFieldChar(ch);
				return;

			case STATE.BODY:
				this._onCharBody(ch);
				return;

			case STATE.QUOTING:
				this._onCharQuoting(ch);
				return;

			case STATE.CONFIRM_SAVE:
				if (ch.toLowerCase() === "y") {
					this._doSave();
				} else {
					this._state = STATE.BODY;
					this._drawStatusBar();
					this._positionCursor();
				}
				return;

			case STATE.CONFIRM_ABORT:
				if (ch.toLowerCase() === "y") {
					this.signalReturn();
				} else {
					this._state = STATE.BODY;
					this._drawStatusBar();
					this._positionCursor();
				}
				return;
		}
	}

	_onKeyBody(key) {
		switch (key) {
			case "UpArrow":    this._moveCursorUp(); return;
			case "DownArrow":  this._moveCursorDown(); return;
			case "LeftArrow":  this._moveCursorLeft(); return;
			case "RightArrow": this._moveCursorRight(); return;
			case "Home":
				this._cursorCol = 0;
				this._positionCursor();
				return;
			case "End":
				this._cursorCol = this._lines[this._cursorLine].length;
				this._positionCursor();
				return;
			case "PgUp":       this._pageUp(); return;
			case "PgDn":       this._pageDown(); return;
			case "Enter":      this._doEnter(); return;
			case "Backspace":  this._doBackspace(); return;
			case "Delete":     this._doDelete(); return;
			case "Tab":
				this._state = STATE.FIELD_TO;
				this._drawToField();
				this._drawSubjectField();
				this._drawStatusBar();
				this._drawCommandBar();
				this._positionCursor();
				return;
			case "^Z":
				this._state = STATE.CONFIRM_SAVE;
				this._drawStatusBar();
				return;
			case "^A":
				this._state = STATE.CONFIRM_ABORT;
				this._drawStatusBar();
				return;
			case "ESC":
				this._state = STATE.CONFIRM_ABORT;
				this._drawStatusBar();
				return;
		}
	}

	_onCharBody(ch) {
		// Check for Ctrl characters
		if (ch === "\x1a") { this._state = STATE.CONFIRM_SAVE; this._drawStatusBar(); return; }  // Ctrl+Z
		if (ch === "\x01") { this._state = STATE.CONFIRM_ABORT; this._drawStatusBar(); return; } // Ctrl+A
		if (ch === "\x11") { this._enterQuoteMode(); return; } // Ctrl+Q

		// Printable character
		if (ch.length === 1 && ch.charCodeAt(0) >= 32) {
			this._insertChar(ch);
		}
	}

	_onKeyQuoting(key) {
		switch (key) {
			case "UpArrow":   this._quoteMoveUp(); return;
			case "DownArrow": this._quoteMoveDown(); return;
			case "Enter":     this._quoteToggle(); return;
			case "ESC":       this._exitQuoteMode(); return;
		}
	}

	_onCharQuoting(ch) {
		var lower = ch.toLowerCase();
		if (ch === "\x11") { this._exitQuoteMode(); return; } // Ctrl+Q exits too
		if (lower === "a") { this._quoteSelectAll(); return; }
		if (lower === "n") { this._quoteClearAll(); return; }
	}

	// ===========================================================================
	// DUMB TERMINAL FALLBACK
	// ===========================================================================

	handleInput(inputArray) {
		if (!this.active) return;
		if (this.dumb) {
			this._handleDumbInput(inputArray);
			return;
		}
		super.handleInput(inputArray);
	}

	_handleDumbInput(inputArray) {
		for (var i = 0; i < inputArray.length; i++) {
			if (!this.active) return;
			var token = inputArray[i];
			if (token.startsWith("KEY_")) {
				this._onKeyDumb(token.slice(4));
			} else if (token.startsWith("CHAR_")) {
				this._onCharDumb(token.slice(5));
			}
		}
	}

	_onKeyDumb(key) {
		if (key === "Enter") {
			this._dumbProcessLine();
		} else if (key === "Backspace") {
			if (this._dumbBuf.length > 0) {
				this.call.cmds.senddata("\b \b");
				this._dumbBuf = this._dumbBuf.slice(0, -1);
			}
		} else if (key === "ESC") {
			this.signalReturn();
		}
	}

	_onCharDumb(ch) {
		if (ch.length === 1 && ch.charCodeAt(0) >= 32) {
			this._dumbBuf += ch;
			this.call.cmds.senddata(ch);
		}
	}

	_dumbProcessLine() {
		var line = this._dumbBuf;
		this._dumbBuf = "";
		this.call.cmds.senddata("\r\n");

		switch (this._dumbMode) {
			case "to":
				this._toValue = line || "All";
				this.call.cmds.senddata("Subject: ");
				if (this._subjectValue) {
					this.call.cmds.senddata("[" + this._subjectValue + "] ");
				}
				this._dumbMode = "subject";
				return;

			case "subject":
				if (line.length > 0) this._subjectValue = line;
				if (!this._subjectValue) {
					this.call.cmds.senddata("Subject cannot be blank.\r\nSubject: ");
					return;
				}
				this.call.cmds.senddata("---\r\nEnter message. /S=Save /A=Abort /Q=Quote /D=Delete last\r\n");
				this._dumbMode = "body";
				return;

			case "body":
				if (line.toLowerCase() === "/s") {
					this.call.cmds.senddata("Save message? (Y/N): ");
					this._dumbMode = "confirmsave";
					return;
				}
				if (line.toLowerCase() === "/a") {
					this.call.cmds.senddata("Abort message? (Y/N): ");
					this._dumbMode = "confirmabort";
					return;
				}
				if (line.toLowerCase() === "/q") {
					this._dumbShowQuotes();
					return;
				}
				if (line.toLowerCase() === "/d") {
					if (this._dumbLines.length > 0) {
						this._dumbLines.pop();
						this.call.cmds.senddata("  (Last line deleted)\r\n");
					}
					return;
				}
				this._dumbLines.push(line);
				return;

			case "quote":
				if (line.toLowerCase() === "d" || line.toLowerCase() === "") {
					this._dumbMode = "body";
					return;
				}
				var nums = line.split(/[,\s]+/);
				for (var n of nums) {
					var idx = parseInt(n) - 1;
					if (idx >= 0 && idx < this._quoteLines.length) {
						var ql = "> " + this._quoteLines[idx];
						this._dumbLines.push(ql);
						this.call.cmds.senddata("  " + ql + "\r\n");
					}
				}
				this._dumbMode = "body";
				return;

			case "confirmsave":
				if (line.toLowerCase() === "y") {
					this._lines = this._dumbLines;
					this._doSave();
				} else {
					this._dumbMode = "body";
				}
				return;

			case "confirmabort":
				if (line.toLowerCase() === "y") {
					this.signalReturn();
				} else {
					this._dumbMode = "body";
				}
				return;
		}
	}

	_dumbShowQuotes() {
		if (this._quoteLines.length === 0) {
			this.call.cmds.senddata("  No message to quote.\r\n");
			return;
		}
		this.call.cmds.senddata("  Quote lines (enter numbers separated by commas, D=done):\r\n");
		for (var i = 0; i < this._quoteLines.length; i++) {
			this.call.cmds.senddata("  " + (i + 1) + ") " + this._quoteLines[i] + "\r\n");
		}
		this.call.cmds.senddata("  > ");
		this._dumbMode = "quote";
	}

	// ===========================================================================
	// LIFECYCLE
	// ===========================================================================

	run() {
		if (!this._areaShortcode) {
			if (this.dumb) {
				this.call.cmds.senddata("\r\n  No message area selected.\r\n");
			}
			setTimeout(() => { if (this.active) this.signalReturn(); }, 1000);
			return;
		}

		this._calcGeometry();

		this._resolveFromName()
			.then(() => {
				if (!this.active) return;

				// Check post access after area config is loaded
				if (this._areaConfig && !checkPostAccess(this.call.user_record, this._areaConfig)) {
					if (this.dumb) {
						this.call.cmds.senddata("\r\n  You do not have permission to post in this area.\r\n");
					} else {
						this.call.cmds.clearscreen();
						this.call.cmds.movecursor(1, 3);
						this.call.cmds.setfgcolor(12); // bright red
						this.call.cmds.senddata("  You do not have permission to post in this area.");
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
					this._state = STATE.FIELD_TO;
					this._drawScreen();
				}
			})
			.catch(err => {
				alogger.writeAlog(3, this.loggingId + " run error: " + (err?.stack || err), "redbright");
				if (this.active) this.signalReturn();
			});
	}

	_startDumb() {
		this.call.cmds.senddata("\r\n");
		if (this._mode === "reply") {
			this.call.cmds.senddata("  Reply in " + this._areaName + "\r\n");
		} else {
			this.call.cmds.senddata("  New Message in " + this._areaName + "\r\n");
		}
		this.call.cmds.senddata("  From: " + this._fromName + "\r\n");
		this.call.cmds.senddata("To [" + this._toValue + "]: ");
		this._dumbMode = "to";
		this._dumbBuf = "";
		this._dumbLines = [];
	}

	clearHandler() {
		if (!this.active) return;
		this._lines = [];
		this._quoteLines = [];
		this._quoteSelected = {};
		this._areaConfig = null;
		this._replyToMsg = null;
		super.clearHandler();
	}
}

export { msgEditor };
