import { BaseSubModule } from "../basesubmodule.js";
import * as privateMessages from "../../models/privateMessages.js";
import * as alogger from "../../utils/alogger.js";

// Lazy-import PM editor
var _editorMod = null;
async function getEditorMod() {
	if (!_editorMod) {
		try {
			_editorMod = await import("./pmEditor.js");
		} catch (_) {
			_editorMod = null;
		}
	}
	return _editorMod;
}

// Lazy-import terminal message formatter
var _fmtMod = null;
async function getFmtMod() {
	if (!_fmtMod) {
		try {
			_fmtMod = await import("../../utils/termMsgFormat.js");
		} catch (_) {
			_fmtMod = null;
		}
	}
	return _fmtMod;
}

// --- Helpers ---

function parseFlags(val) {
	if (!val) return [];
	if (Array.isArray(val)) return val;
	if (typeof val === "string") {
		try { var p = JSON.parse(val); return Array.isArray(p) ? p : []; }
		catch (_) { return []; }
	}
	return [];
}

// --- Constants ---

const STATE = {
	LOADING: 0,
	MESSAGE_LIST: 1,
	MESSAGE_VIEW: 2,
};

const FOLDER = {
	INBOX: "inbox",
	SENT: "sent",
	TRASH: "trash",
};

const MSG_BATCH = 50;
const MAX_BODY_WIDTH = 100;

// Colors
const CLR_TITLE = 14;
const CLR_FOLDER = 11;
const CLR_MSG = 15;
const CLR_MSG_UNREAD = 10;
const CLR_BAR_FG = 15;
const CLR_BAR_BG = 4;
const CLR_HDR_LABEL = 6;
const CLR_HDR_FROM = 10;
const CLR_HDR_FROM_ME = 11;
const CLR_HDR_TO = 10;
const CLR_HDR_TO_ME = 11;
const CLR_HDR_SUBJ = 3;
const CLR_HDR_TRANSPORT = 5;
const CLR_HDR_DATE = 10;
const CLR_HDR_MSG = 11;
const CLR_STATUS = 8;
const CLR_NAV = 11;
const CLR_NAV_LABEL = 7;
const CLR_ERROR = 9;
const CLR_SEPARATOR = 4;
const CLR_COL_HEADER = 3;

// Default body semantic colors
const DF_CLR_BODY = 11;
const DF_CLR_QUOTE = 14;
const DF_CLR_TEAR = 15;
const DF_CLR_TAGLINE = 10;
const DF_CLR_ORIGIN = 12;

// CP437 safe glyphs
const CP437_HLINE  = 0xC4;
const CP437_CORNER = 0xDA;
const CP437_ARROW  = 0xAF;
const CP437_BULLET = 0xF9;

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const MONTHS_FULL = ["January","February","March","April","May","June",
	"July","August","September","October","November","December"];

const FOLDER_LABELS = {
	inbox: "Inbox",
	sent: "Sent",
	trash: "Trash",
};

// =========================================================================

class pmReader extends BaseSubModule {
	constructor(call) {
		super(call, "PmReader");

		var enc = (call.term_encoding || "").toLowerCase();
		this._isUTF8 = (enc === "utf8" || enc === "utf-8");

		this._userId = null;
		if (call.user_record) {
			this._userId = call.user_record.id || call.user_record.user_id || null;
		}
		this._username = (call.caller_username || "").toLowerCase();
		this._fullname = (call.caller_fullname || "").toLowerCase();
		this._userSession = call.user_record || null;

		// PM access
		this._canCompose = false;
		this._allowedTransports = [];

		// Folder state
		this._folder = FOLDER.INBOX;
		this._messages = [];
		this._listCursor = 0;
		this._listScroll = 0;
		this._unreadCount = 0;

		// Message view state
		this._state = STATE.LOADING;
		this._bodyLines = [];
		this._bodyScroll = 0;
		this._fmtModRef = null;
		this._currentMsg = null; // full message loaded for reading

		// Geometry
		this._termW = call.term_width || 80;
		this._termH = call.term_height || 24;
		this._bodyWidth = 0;
		this._bodyLeft = 0;
		this._bodyRight = 0;
		this._bodyViewStart = 6;
		this._bodyViewEnd = 0;
		this._bodyViewHeight = 0;
		this._listViewStart = 4;
		this._listViewEnd = 0;
		this._listViewHeight = 0;
		this._statusRow = 0;
		this._navRow = 0;

		// Dumb terminal
		this._dumbPageLines = 0;

		// Editor sub-module
		this._editorActive = false;
		this._activeEditor = null;

		// Body semantic colors
		var theme = call.theme || {};
		this._clrBody = theme.msg_body_clr !== undefined ? theme.msg_body_clr : DF_CLR_BODY;
		this._clrQuote = theme.msg_quote_clr !== undefined ? theme.msg_quote_clr : DF_CLR_QUOTE;
		this._clrTear = theme.msg_tear_clr !== undefined ? theme.msg_tear_clr : DF_CLR_TEAR;
		this._clrTagline = theme.msg_tagline_clr !== undefined ? theme.msg_tagline_clr : DF_CLR_TAGLINE;
		this._clrOrigin = theme.msg_origin_clr !== undefined ? theme.msg_origin_clr : DF_CLR_ORIGIN;

		this.loggingId = "PmReader (Node " + call.nodenum + ")";
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

	// --- Geometry ---

	_calcGeometry() {
		this._bodyWidth = Math.min(this._termW, MAX_BODY_WIDTH);
		this._bodyLeft = Math.floor((this._termW - this._bodyWidth) / 2) + 1;
		this._bodyRight = this._bodyLeft + this._bodyWidth - 1;

		this._navRow = this._termH;
		this._statusRow = this._termH - 1;

		// Message view: header rows 1-4, separator row 5, body 6 to H-2
		this._bodyViewStart = 6;
		this._bodyViewEnd = this._termH - 2;
		this._bodyViewHeight = this._bodyViewEnd - this._bodyViewStart + 1;
		if (this._bodyViewHeight < 3) this._bodyViewHeight = 3;

		// Message list: row 1 title, row 2 info, row 3 col headers, row 4+ content, H-1 status, H nav
		this._listViewStart = 4;
		this._listViewEnd = this._termH - 2;
		this._listViewHeight = this._listViewEnd - this._listViewStart + 1;
		if (this._listViewHeight < 3) this._listViewHeight = 3;
	}

	// --- Date formatting ---

	_formatShortDate(date) {
		if (!date) return "         ";
		var d = new Date(date);
		if (isNaN(d.getTime())) return "         ";

		var now = new Date();
		var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		var msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
		var diff = today.getTime() - msgDay.getTime();

		if (diff === 0) {
			// Today — show time: "15:45    " (9 chars)
			var h = String(d.getHours()).padStart(2, "0");
			var m = String(d.getMinutes()).padStart(2, "0");
			return h + ":" + m + "    ";
		}
		if (diff === 86400000) {
			return "Yesterday";
		}
		// "Mar 18'25" (9 chars)
		var yr = String(d.getFullYear() % 100).padStart(2, "0");
		return MONTHS[d.getMonth()] + " " + String(d.getDate()).padStart(2, " ") + "'" + yr;
	}

	_formatFullDate(date) {
		if (!date) return "";
		var d = new Date(date);
		if (isNaN(d.getTime())) return "";
		return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" +
			String(d.getDate()).padStart(2, "0") + " " +
			String(d.getHours()).padStart(2, "0") + ":" +
			String(d.getMinutes()).padStart(2, "0");
	}

	_formatDatePart(date) {
		if (!date) return "";
		var d = new Date(date);
		if (isNaN(d.getTime())) return "";
		var now = new Date();
		var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		var msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
		var diff = today.getTime() - msgDay.getTime();
		if (diff === 0) return "Today";
		if (diff === 86400000) return "Yesterday";
		return MONTHS_FULL[d.getMonth()] + " " + d.getDate() + ", " + d.getFullYear();
	}

	_formatTimePart(date) {
		if (!date) return "";
		var d = new Date(date);
		if (isNaN(d.getTime())) return "";
		var h = d.getHours(); var m = d.getMinutes();
		var ampm = h >= 12 ? "pm" : "am";
		h = h % 12 || 12;
		return h + ":" + String(m).padStart(2, "0") + " " + ampm;
	}

	// --- Word wrap ---

	_wordWrap(text, maxWidth) {
		if (!text) return [""];
		text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		var sourceLines = text.split("\n");
		var result = [];
		for (var i = 0; i < sourceLines.length; i++) {
			var line = sourceLines[i];
			if (line.length <= maxWidth) { result.push(line); continue; }
			var remaining = line;
			while (remaining.length > maxWidth) {
				var breakAt = remaining.lastIndexOf(" ", maxWidth);
				if (breakAt <= 0) breakAt = maxWidth;
				result.push(remaining.substring(0, breakAt));
				remaining = remaining.substring(breakAt);
				if (remaining.charAt(0) === " ") remaining = remaining.substring(1);
			}
			result.push(remaining);
		}
		return result;
	}

	// --- Prepare body lines ---

	async _prepareBodyLines(msg) {
		var wrapWidth = this._bodyWidth - 2;
		if (wrapWidth < 20) wrapWidth = 20;

		var fmtMod = await getFmtMod();
		this._fmtModRef = fmtMod;
		if (fmtMod && fmtMod.processMessageBody) {
			this._bodyLines = fmtMod.processMessageBody(msg, {
				isUTF8: this._isUTF8,
				wrapWidth: wrapWidth,
				colors: {
					body: this._clrBody,
					quote: this._clrQuote,
					tear: this._clrTear,
					tagline: this._clrTagline,
					origin: this._clrOrigin,
				}
			});
		} else {
			var rawText = msg.body_text || "";
			rawText = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
			var lines = rawText.split("\n");
			this._bodyLines = [];
			var bodyClr = this._clrBody;
			var fallbackPrefix = bodyClr > 7
				? "\x1b[1;" + (bodyClr + 30 - 8) + "m"
				: "\x1b[" + (bodyClr + 30) + "m";
			for (var i = 0; i < lines.length; i++) {
				var wrapped = this._wordWrap(lines[i], wrapWidth);
				for (var w = 0; w < wrapped.length; w++) {
					this._bodyLines.push({ text: wrapped[w], type: "normal", colorPrefix: fallbackPrefix });
				}
			}
		}
		// Attachment indicator for fullscreen view
		if (msg.has_attachments) {
			this._bodyLines.push({ text: '', type: 'normal', colorPrefix: '' });
			this._bodyLines.push({ text: '[Attachments available -- use web or IMAP to download]', type: 'normal', colorPrefix: '\x1b[1;36m' });
		}
		this._bodyScroll = 0;
	}

	// --- String helpers ---

	_padRight(str, len) {
		while (str.length < len) str += " ";
		return str.length > len ? str.substring(0, len) : str;
	}

	_padLeft(str, len) {
		while (str.length < len) str = " " + str;
		return str.length > len ? str.substring(0, len) : str;
	}

	_truncate(str, len) {
		if (!str) return "";
		return str.length > len ? str.substring(0, len) : str;
	}

	// ===========================================================================
	// DATA LOADING
	// ===========================================================================

	async _loadFolder() {
		this._messages = [];
		this._listCursor = 0;
		this._listScroll = 0;

		try {
			switch (this._folder) {
				case FOLDER.INBOX:
					this._messages = await privateMessages.getInbox(this._userId, { limit: MSG_BATCH }) || [];
					break;
				case FOLDER.SENT:
					this._messages = await privateMessages.getSentMessages(this._userId, { limit: MSG_BATCH }) || [];
					break;
				case FOLDER.TRASH:
					this._messages = await privateMessages.getTrash(this._userId, { limit: MSG_BATCH }) || [];
					break;
			}
		} catch (err) {
			alogger.writeAlog(3, this.loggingId + " loadFolder error: " + (err?.message || err), "redbright");
		}

		// Reverse to chronological order (queries return DESC)
		this._messages.reverse();

		// Position cursor on first unread, or last message if all read
		var firstUnread = -1;
		if (this._folder === FOLDER.INBOX) {
			for (var i = 0; i < this._messages.length; i++) {
				if (!this._messages[i].read) {
					firstUnread = i;
					break;
				}
			}
		}
		if (firstUnread >= 0) {
			this._listCursor = firstUnread;
		} else if (this._messages.length > 0) {
			this._listCursor = this._messages.length - 1;
		}
		this._ensureListVisible();

		try {
			this._unreadCount = await privateMessages.getUnreadCount(this._userId) || 0;
		} catch (_) {}
	}

	async _loadFullMessage(uuid) {
		try {
			if (this._folder === FOLDER.SENT) {
				this._currentMsg = await privateMessages.getSentMessage(this._userId, uuid);
			} else {
				// getMessage marks read automatically for inbox
				this._currentMsg = await privateMessages.getMessage(this._userId, uuid);
			}
		} catch (err) {
			alogger.writeAlog(3, this.loggingId + " loadFullMessage error: " + (err?.message || err), "redbright");
			this._currentMsg = null;
		}

		// Sync read state back to the list entry so it displays correctly on return
		if (this._folder === FOLDER.INBOX && this._currentMsg) {
			var listMsg = this._messages[this._listCursor];
			if (listMsg && listMsg.uuid === uuid && !listMsg.read) {
				listMsg.read = true;
				listMsg.read_at = new Date();
			}
		}

		// Update unread count after marking read
		if (this._folder === FOLDER.INBOX) {
			try {
				this._unreadCount = await privateMessages.getUnreadCount(this._userId) || 0;
			} catch (_) {}
		}
	}

	// ===========================================================================
	// STATE MANAGEMENT
	// ===========================================================================

	_setState(newState) {
		this._state = newState;
		if (!this.call || !this.active) return;

		switch (newState) {
			case STATE.MESSAGE_LIST:
				this._drawListScreen();
				break;
			case STATE.MESSAGE_VIEW:
				if (this._currentMsg) {
					this._drawMessageScreen();
				}
				break;
		}
	}

	// ===========================================================================
	// MESSAGE LIST DRAWING
	// ===========================================================================

	_drawListScreen() {
		if (!this.call) return;
		if (this.dumb) { this._drawListDumb(); return; }

		this.call.cmds.clearscreen();

		// Row 1: title + unread count
		this.call.cmds.movecursor(this._bodyLeft, 1);
		this.call.cmds.setfgcolor(CLR_TITLE);
		this._sendGlyph("\u250C", CP437_CORNER);
		this.call.cmds.senddata(" Private Mail");

		var folderLabel = FOLDER_LABELS[this._folder] || "Inbox";
		this.call.cmds.setfgcolor(CLR_FOLDER);
		this.call.cmds.senddata(" ");
		this._sendGlyph("\u2014", 0x2D); // em dash or hyphen
		this.call.cmds.senddata(" " + folderLabel);

		// Right-aligned stats
		var stats = this._messages.length + " message(s)";
		if (this._unreadCount > 0) stats += "  " + this._unreadCount + " unread";
		var statsX = this._bodyRight - stats.length;
		if (statsX > this._bodyLeft + 30) {
			this.call.cmds.movecursor(statsX, 1);
			this.call.cmds.setfgcolor(CLR_STATUS);
			this.call.cmds.senddata(stats);
		}

		// Row 2: empty (reserved for search/filter in future)
		// Row 3: column headers
		this._drawListColumnHeader();

		// Row 4+: messages
		this._drawListRows();

		// Status + nav
		this._drawListStatusBar();
		this._drawListNavBar();

		this.call.cmds.resetcolors();
	}

	_drawListColumnHeader() {
		if (this.dumb) return;
		var cols = this._calcListColumns();
		this.call.cmds.movecursor(this._bodyLeft, 3);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(CLR_COL_HEADER);

		var hdr;
		if (this._folder === FOLDER.SENT) {
			hdr = "  " +
				this._padRight("To", cols.nameW) + " " +
				this._padRight("Subject", cols.subjectW) + " " +
				this._padRight("Date", cols.dateW) + " " +
				this._padRight("Status", cols.statusW);
		} else if (this._folder === FOLDER.TRASH) {
			hdr = "  " +
				this._padRight("Type", 5) + " " +
				this._padRight("From/To", cols.nameW - 2) + " " +
				this._padRight("Subject", cols.subjectW) + " " +
				this._padRight("Deleted", cols.dateW);
		} else {
			hdr = "  " +
				this._padRight("From", cols.nameW) + " " +
				this._padRight("Subject", cols.subjectW) + " " +
				this._padRight("Date", cols.dateW) + " " +
				this._padRight("Type", cols.statusW);
		}
		this.call.cmds.senddata(this._truncate(hdr, this._bodyWidth));
		this.call.cmds.resetcolors();
	}

	_calcListColumns() {
		var nameW = 18;
		var dateW = 9;
		var statusW = 5;
		var fixedW = 2 + nameW + 1 + dateW + 1 + statusW + 1;
		var subjectW = this._bodyWidth - fixedW;
		if (subjectW < 10) subjectW = 10;
		return { nameW, subjectW, dateW, statusW };
	}

	_drawListRows() {
		if (this.dumb) return;
		var cols = this._calcListColumns();

		for (var vi = 0; vi < this._listViewHeight; vi++) {
			var midx = this._listScroll + vi;
			var screenY = this._listViewStart + vi;
			this.call.cmds.movecursor(this._bodyLeft, screenY);
			this.call.cmds.cleartoeol();

			if (midx >= this._messages.length) continue;

			var msg = this._messages[midx];
			var isHighlighted = (midx === this._listCursor);
			this._drawSingleListRow(msg, screenY, cols, isHighlighted);
			this.call.cmds.resetcolors();
		}
	}

	_drawSingleListRow(msg, screenY, cols, isHighlighted) {
		this.call.cmds.movecursor(this._bodyLeft, screenY);

		var isUnread = (this._folder === FOLDER.INBOX && !msg.read);

		if (isHighlighted) {
			this.call.cmds.setbgcolor(CLR_BAR_BG);
			this.call.cmds.setfgcolor(CLR_BAR_FG);
		} else {
			this.call.cmds.setfgcolor(isUnread ? CLR_MSG_UNREAD : CLR_MSG);
		}

		// Unread indicator
		if (isUnread) {
			this._sendGlyph("\u2022", CP437_BULLET); // bullet
		} else {
			this.call.cmds.senddata(" ");
		}

		var name, subject, dateStr, statusStr;

		if (this._folder === FOLDER.SENT) {
			name = this._padRight(this._truncate(msg.to_user || "", cols.nameW), cols.nameW);
			subject = this._padRight(this._truncate(msg.subject || "", cols.subjectW), cols.subjectW);
			dateStr = this._formatShortDate(msg.system_time || msg.sent_at);
			statusStr = msg.sent ? "Sent " : (msg.queued ? "Queue" : "Draft");
		} else if (this._folder === FOLDER.TRASH) {
			var typeStr = (msg.source === "sent") ? "Sent " : "In   ";
			var nameVal = (msg.source === "sent") ? (msg.to_user || "") : (msg.from_user || "");
			name = this._padRight(this._truncate(nameVal, cols.nameW - 2), cols.nameW - 2);
			subject = this._padRight(this._truncate(msg.subject || "", cols.subjectW), cols.subjectW);
			dateStr = this._formatShortDate(msg.deleted_at);
			var line = typeStr + name + " " + subject + " " + dateStr;
			this.call.cmds.senddata(this._truncate(line, this._bodyWidth - 1));
			return;
		} else {
			name = this._padRight(this._truncate(msg.from_user || "", cols.nameW), cols.nameW);
			subject = this._padRight(this._truncate(msg.subject || "", cols.subjectW), cols.subjectW);
			dateStr = this._formatShortDate(msg.system_time);
			statusStr = this._padRight(this._truncate(msg.transport_type || "LOCAL", cols.statusW), cols.statusW);
		}

		var line = " " + name + " " + subject + " " + dateStr;
		if (this._folder !== FOLDER.TRASH) {
			line += " " + statusStr;
		}
		this.call.cmds.senddata(this._truncate(line, this._bodyWidth));
	}

	_drawListStatusBar() {
		if (this.dumb) return;
		this.call.cmds.movecursor(1, this._statusRow);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(CLR_STATUS);
		if (this._messages.length > 0) {
			this.call.cmds.senddata(" " + (this._listCursor + 1) + " of " + this._messages.length);
		} else {
			this.call.cmds.senddata(" No messages");
		}
		this.call.cmds.resetcolors();
	}

	_drawListNavBar() {
		if (this.dumb) return;
		this.call.cmds.movecursor(1, this._navRow);
		this.call.cmds.cleartoeol();
		this.call.cmds.senddata(" ");
		this._navKey("Enter", "Read");
		this.call.cmds.senddata("  ");
		if (this._canCompose) {
			this._navKey("C", "Compose");
			this.call.cmds.senddata("  ");
		}
		this._navKey("I", "Inbox");
		this.call.cmds.senddata(" ");
		this._navKey("S", "Sent");
		this.call.cmds.senddata(" ");
		this._navKey("T", "Trash");
		this.call.cmds.senddata("  ");
		if (this._folder === FOLDER.INBOX) {
			this._navKey("D", "Del");
			this.call.cmds.senddata(" ");
			this._navKey("M", "Mark Read");
		} else if (this._folder === FOLDER.TRASH) {
			this._navKey("U", "Restore");
		} else {
			this._navKey("D", "Del");
		}
		this.call.cmds.senddata("  ");
		this._navKey("Q", "Quit");
		this.call.cmds.resetcolors();
	}

	_redrawListRow(idx) {
		if (this.dumb) return;
		var vi = idx - this._listScroll;
		if (vi < 0 || vi >= this._listViewHeight) return;
		var screenY = this._listViewStart + vi;
		var cols = this._calcListColumns();
		this.call.cmds.movecursor(this._bodyLeft, screenY);
		this.call.cmds.cleartoeol();
		if (idx < this._messages.length) {
			this._drawSingleListRow(this._messages[idx], screenY, cols, idx === this._listCursor);
		}
		this.call.cmds.resetcolors();
	}

	// --- List navigation ---

	_listMoveUp() {
		if (this._listCursor <= 0) return;
		var prev = this._listCursor;
		this._listCursor--;
		this._ensureListVisible();
		if (this._listScroll !== this._listScroll) {
			this._drawListRows();
		} else {
			this._redrawListRow(prev);
			this._redrawListRow(this._listCursor);
		}
		this._drawListStatusBar();
	}

	_listMoveDown() {
		if (this._listCursor >= this._messages.length - 1) return;
		var prev = this._listCursor;
		this._listCursor++;
		this._ensureListVisible();
		this._redrawListRow(prev);
		this._redrawListRow(this._listCursor);
		this._drawListStatusBar();
	}

	_ensureListVisible() {
		var prevScroll = this._listScroll;
		if (this._listCursor < this._listScroll) {
			this._listScroll = this._listCursor;
		} else if (this._listCursor >= this._listScroll + this._listViewHeight) {
			this._listScroll = this._listCursor - this._listViewHeight + 1;
		}
		if (this._listScroll !== prevScroll) {
			this._drawListRows();
		}
	}

	_listPageUp() {
		var moves = this._listViewHeight - 1;
		this._listCursor = Math.max(0, this._listCursor - moves);
		this._ensureListVisible();
		this._drawListRows();
		this._drawListStatusBar();
	}

	_listPageDown() {
		var moves = this._listViewHeight - 1;
		this._listCursor = Math.min(this._messages.length - 1, this._listCursor + moves);
		this._ensureListVisible();
		this._drawListRows();
		this._drawListStatusBar();
	}

	_listJumpFirst() {
		this._listCursor = 0;
		this._listScroll = 0;
		this._drawListRows();
		this._drawListStatusBar();
	}

	_listJumpLast() {
		this._listCursor = Math.max(0, this._messages.length - 1);
		this._ensureListVisible();
		this._drawListRows();
		this._drawListStatusBar();
	}

	// ===========================================================================
	// MESSAGE VIEW DRAWING
	// ===========================================================================

	_drawMessageScreen() {
		if (!this.call) return;
		if (this.dumb) { this._drawMessageDumb(); return; }
		if (!this._currentMsg) return;

		this.call.cmds.clearscreen();
		this._drawMessageHeader(this._currentMsg);
		this._drawBodyViewport();
		this._drawSeparator();
		this._drawMessageNavBar();
		this.call.cmds.resetcolors();
	}

	_drawMessageHeader(msg) {
		if (this.dumb) return;

		var datePart = this._formatDatePart(msg.system_time);
		var timePart = this._formatTimePart(msg.system_time);
		var transportStr = (msg.transport_type || "LOCAL").toUpperCase();
		var msgPos = (this._listCursor + 1) + " of " + this._messages.length;

		// Determine from/to highlight
		var fromVal = msg.from_user || "";
		var toVal = msg.to_user || "";
		var fromClr = CLR_HDR_FROM;
		var toClr = CLR_HDR_TO;
		if (this._username && (fromVal.toLowerCase() === this._username || fromVal.toLowerCase() === this._fullname)) {
			fromClr = CLR_HDR_FROM_ME;
		}
		if (this._username && (toVal.toLowerCase() === this._username || toVal.toLowerCase() === this._fullname)) {
			toClr = CLR_HDR_TO_ME;
		}

		// For network messages, append address to from/to fields
		var isNetwork = (transportStr !== "LOCAL");
		var fromDisplay = fromVal;
		var toDisplay = toVal;
		if (isNetwork && msg.from_address && msg.from_address !== fromVal) {
			fromDisplay = fromVal + " @ " + msg.from_address;
		}
		if (isNetwork && msg.to_address && msg.to_address !== toVal) {
			toDisplay = toVal + " @ " + msg.to_address;
		}

		var leftItems = [
			["From", fromDisplay, fromClr],
			["To", toDisplay, toClr],
			["Subj", msg.subject || "", CLR_HDR_SUBJ],
			["Via", transportStr, CLR_HDR_TRANSPORT],
		];

		var rightItems = [
			["Date", datePart, CLR_HDR_DATE],
			["Time", timePart, CLR_HDR_DATE],
			["Folder", FOLDER_LABELS[this._folder] || "Inbox", CLR_FOLDER],
			["Msg", msgPos, CLR_HDR_MSG, [
				{ text: String(this._listCursor + 1), color: CLR_HDR_MSG },
				{ text: " of ", color: CLR_HDR_LABEL },
				{ text: String(this._messages.length), color: CLR_HDR_MSG },
			]],
		];

		// Compute label widths
		var leftLabelLen = 0;
		for (var i = 0; i < leftItems.length; i++) {
			if (leftItems[i][0].length > leftLabelLen) leftLabelLen = leftItems[i][0].length;
		}
		var rightLabelLen = 0;
		for (var i = 0; i < rightItems.length; i++) {
			if (rightItems[i][0].length > rightLabelLen) rightLabelLen = rightItems[i][0].length;
		}
		var maxRightLen = 0;
		for (var i = 0; i < rightItems.length; i++) {
			var len = rightLabelLen + 3 + rightItems[i][1].length;
			if (len > maxRightLen) maxRightLen = len;
		}
		var rightX = this._termW - maxRightLen;
		if (rightX < 30) rightX = 30;
		var leftPrefixLen = 1 + leftLabelLen + 3;
		var leftValMax = rightX - leftPrefixLen - 2;
		if (leftValMax < 10) leftValMax = 10;

		for (var row = 0; row < 4; row++) {
			var screenRow = row + 1;
			this.call.cmds.movecursor(1, screenRow);
			this.call.cmds.cleartoeol();

			var lItem = leftItems[row];
			var lLabel = this._padRight(lItem[0], leftLabelLen);
			this.call.cmds.setfgcolor(CLR_HDR_LABEL);
			this.call.cmds.senddata(" " + lLabel + " : ");
			this.call.cmds.setfgcolor(lItem[2]);
			this.call.cmds.senddata(this._truncate(lItem[1], leftValMax));

			var rItem = rightItems[row];
			var rLabel = this._padRight(rItem[0], rightLabelLen);
			this.call.cmds.movecursor(rightX, screenRow);
			this.call.cmds.setfgcolor(CLR_HDR_LABEL);
			this.call.cmds.senddata(rLabel + " : ");
			if (rItem[3]) {
				for (var p = 0; p < rItem[3].length; p++) {
					this.call.cmds.setfgcolor(rItem[3][p].color);
					this.call.cmds.senddata(rItem[3][p].text);
				}
			} else {
				this.call.cmds.setfgcolor(rItem[2]);
				this.call.cmds.senddata(rItem[1]);
			}
		}
	}

	_drawSeparator() {
		if (this.dumb) return;
		var canUp = this._bodyScroll > 0;
		var canDown = this._bodyScroll + this._bodyViewHeight < this._bodyLines.length;
		this._drawSepLine(5, canUp);
		this._drawSepLine(this._statusRow, canDown);
	}

	_drawSepLine(row, hasMore) {
		this.call.cmds.movecursor(this._bodyLeft, row);
		this.call.cmds.setfgcolor(CLR_SEPARATOR);
		for (var i = 0; i < this._bodyWidth; i++) {
			this._sendGlyph("\u2500", CP437_HLINE);
		}
		if (hasMore) {
			this.call.cmds.movecursor(this._bodyRight, row);
			this.call.cmds.setfgcolor(CLR_NAV);
			this._sendGlyph("\u25BC", 0x19);
		}
		this.call.cmds.resetcolors();
	}

	_drawBodyViewport() {
		if (this.dumb) return;
		for (var vi = 0; vi < this._bodyViewHeight; vi++) {
			var lineIdx = this._bodyScroll + vi;
			var screenY = this._bodyViewStart + vi;
			this.call.cmds.movecursor(this._bodyLeft, screenY);
			this.call.cmds.cleartoeol();

			if (lineIdx >= 0 && lineIdx < this._bodyLines.length) {
				var lineObj = this._bodyLines[lineIdx];
				if (lineObj.colorPrefix) {
					this.call.cmds.senddata(lineObj.colorPrefix);
				}
				this.call.cmds.senddata(lineObj.text || "");
			}
		}
		this.call.cmds.resetcolors();
	}

	_drawMessageNavBar() {
		if (this.dumb) return;
		this.call.cmds.movecursor(1, this._navRow);
		this.call.cmds.cleartoeol();
		this.call.cmds.senddata(" ");

		// Arrows for scrolling
		this.call.cmds.setfgcolor(CLR_NAV);
		this._sendGlyph("\u2191", 0x18);
		this._sendGlyph("\u2193", 0x19);
		this.call.cmds.setfgcolor(CLR_NAV_LABEL);
		this.call.cmds.senddata(" Scroll");
		this.call.cmds.senddata("  ");
		this.call.cmds.setfgcolor(CLR_NAV);
		this._sendGlyph("\u2190", 0x1B);
		this._sendGlyph("\u2192", 0x1A);
		this.call.cmds.setfgcolor(CLR_NAV_LABEL);
		this.call.cmds.senddata(" Prev/Next");
		this.call.cmds.senddata("  ");
		this._navKey("Space", "PgDn");
		this.call.cmds.senddata("  ");

		if (this._folder === FOLDER.INBOX) {
			this._navKey("R", "Reply");
			this.call.cmds.senddata("  ");
			this._navKey("D", "Del");
		} else if (this._folder === FOLDER.TRASH) {
			this._navKey("U", "Restore");
		} else {
			this._navKey("D", "Del");
		}
		this.call.cmds.senddata("  ");
		this._navKey("L", "Last");
		this.call.cmds.senddata("  ");
		this._navKey("Q", "List");
		this.call.cmds.resetcolors();
	}

	// --- Body scrolling ---

	_scrollBodyUp(page) {
		if (this._bodyScroll <= 0) return false;
		var amount = page ? this._bodyViewHeight : 1;
		this._bodyScroll = Math.max(0, this._bodyScroll - amount);
		this._drawBodyViewport();
		this._drawSeparator();
		return true;
	}

	_scrollBodyDown(page) {
		var maxScroll = Math.max(0, this._bodyLines.length - this._bodyViewHeight);
		if (this._bodyScroll >= maxScroll) return false;
		var amount = page ? this._bodyViewHeight : 1;
		this._bodyScroll = Math.min(maxScroll, this._bodyScroll + amount);
		this._drawBodyViewport();
		this._drawSeparator();
		return true;
	}

	// --- Message navigation within view ---

	async _prevMessage() {
		if (this._listCursor <= 0) return;
		this._listCursor--;
		var msg = this._messages[this._listCursor];
		if (!msg) return;
		await this._loadFullMessage(msg.uuid);
		if (this._currentMsg) {
			await this._prepareBodyLines(this._currentMsg);
			this._drawMessageScreen();
		}
	}

	async _nextMessage() {
		if (this._listCursor >= this._messages.length - 1) return;
		this._listCursor++;
		var msg = this._messages[this._listCursor];
		if (!msg) return;
		await this._loadFullMessage(msg.uuid);
		if (this._currentMsg) {
			await this._prepareBodyLines(this._currentMsg);
			this._drawMessageScreen();
		}
	}

	async _jumpToLast() {
		if (this._messages.length === 0) return;
		this._listCursor = this._messages.length - 1;
		var msg = this._messages[this._listCursor];
		if (!msg) return;
		await this._loadFullMessage(msg.uuid);
		if (this._currentMsg) {
			await this._prepareBodyLines(this._currentMsg);
			this._drawMessageScreen();
		}
	}

	// --- Actions ---

	async _deleteCurrentMessage() {
		if (this._messages.length === 0) return;
		var msg = this._messages[this._listCursor];
		if (!msg) return;

		try {
			if (this._folder === FOLDER.SENT) {
				await privateMessages.deleteSentMessage(this._userId, msg.uuid);
			} else if (this._folder === FOLDER.INBOX) {
				await privateMessages.deleteMessage(this._userId, msg.uuid);
			}
		} catch (err) {
			alogger.writeAlog(3, this.loggingId + " delete error: " + (err?.message || err), "redbright");
		}

		await this._loadFolder();
		if (this._listCursor >= this._messages.length) {
			this._listCursor = Math.max(0, this._messages.length - 1);
		}
	}

	async _restoreCurrentMessage() {
		if (this._folder !== FOLDER.TRASH) return;
		if (this._messages.length === 0) return;
		var msg = this._messages[this._listCursor];
		if (!msg) return;

		try {
			if (msg.source === "sent") {
				await privateMessages.restoreSentMessage(this._userId, msg.uuid);
			} else {
				await privateMessages.restoreMessage(this._userId, msg.uuid);
			}
		} catch (err) {
			alogger.writeAlog(3, this.loggingId + " restore error: " + (err?.message || err), "redbright");
		}

		await this._loadFolder();
		if (this._listCursor >= this._messages.length) {
			this._listCursor = Math.max(0, this._messages.length - 1);
		}
	}

	async _markAllRead() {
		if (this._folder !== FOLDER.INBOX) return;
		try {
			await privateMessages.markAllRead(this._userId);
			this._unreadCount = 0;
		} catch (err) {
			alogger.writeAlog(3, this.loggingId + " markAllRead error: " + (err?.message || err), "redbright");
		}
		await this._loadFolder();
	}

	async _openCurrentMessage() {
		if (this._messages.length === 0) return;
		var msg = this._messages[this._listCursor];
		if (!msg) return;

		await this._loadFullMessage(msg.uuid);
		if (!this._currentMsg) return;

		// For trash, use the list entry directly since we don't have full message on both tables
		if (this._folder === FOLDER.TRASH && !this._currentMsg) {
			this._currentMsg = msg;
		}

		await this._prepareBodyLines(this._currentMsg);
		this._setState(STATE.MESSAGE_VIEW);
	}

	async _switchFolder(newFolder) {
		if (newFolder === this._folder) return;
		this._folder = newFolder;
		await this._loadFolder();
		this._setState(STATE.MESSAGE_LIST);
	}

	// --- Editor launch ---

	async _launchCompose() {
		if (!this.call || !this._canCompose) return;
		var editorMod = await getEditorMod();
		if (!editorMod || !editorMod.pmEditor) {
			this._showError("PM editor not available.");
			return;
		}

		var editor = new editorMod.pmEditor(this.call, {
			mode: "new",
			allowedTransports: this._allowedTransports,
		});

		this._editorActive = true;
		this._activeEditor = editor;

		editor.emitter.on("ModuleReturn", () => {
			this._editorActive = false;
			this._activeEditor = null;
			try { editor.clearHandler(); } catch (_) {}
			if (!this.active || !this.call) return;
			// Reload folder and redraw
			this._loadFolder().then(() => {
				if (this.active) this._setState(STATE.MESSAGE_LIST);
			});
		});

		editor.emitter.on("HangupSignal", () => {
			this._editorActive = false;
			this._activeEditor = null;
			try { editor.clearHandler(); } catch (_) {}
			this.signalHangup();
		});

		editor.startStage();
	}

	async _launchReply() {
		if (!this.call || !this._currentMsg) return;
		// Check if user can reply via the transport type of the original
		var transportType = this._currentMsg.transport_type || "LOCAL";
		var accessCheck = privateMessages.checkTransportAccess(this._userSession, transportType);
		if (!accessCheck.allowed) {
			this._showError("No permission to reply via " + transportType);
			return;
		}

		var editorMod = await getEditorMod();
		if (!editorMod || !editorMod.pmEditor) {
			this._showError("PM editor not available.");
			return;
		}

		var editor = new editorMod.pmEditor(this.call, {
			mode: "reply",
			replyToMsg: this._currentMsg,
			transportType: transportType,
		});

		this._editorActive = true;
		this._activeEditor = editor;

		editor.emitter.on("ModuleReturn", () => {
			this._editorActive = false;
			this._activeEditor = null;
			try { editor.clearHandler(); } catch (_) {}
			if (!this.active || !this.call) return;
			this._loadFolder().then(() => {
				if (this.active) this._setState(STATE.MESSAGE_VIEW);
			});
		});

		editor.emitter.on("HangupSignal", () => {
			this._editorActive = false;
			this._activeEditor = null;
			try { editor.clearHandler(); } catch (_) {}
			this.signalHangup();
		});

		editor.startStage();
	}

	_showError(text) {
		if (!this.call) return;
		if (this.dumb) {
			this.call.cmds.senddata("\r\n  " + text + "\r\n");
		} else {
			this.call.cmds.movecursor(1, this._statusRow);
			this.call.cmds.cleartoeol();
			this.call.cmds.setfgcolor(CLR_ERROR);
			this.call.cmds.senddata(" " + text);
			this.call.cmds.resetcolors();
		}
	}

	// ===========================================================================
	// DUMB TERMINAL SUPPORT
	// ===========================================================================

	_drawListDumb() {
		if (!this.call) return;
		this.call.cmds.senddata("\r\n  === Private Mail - " + FOLDER_LABELS[this._folder] + " ===\r\n");
		if (this._unreadCount > 0) {
			this.call.cmds.senddata("  " + this._unreadCount + " unread\r\n");
		}
		this.call.cmds.senddata("\r\n");

		if (this._messages.length === 0) {
			this.call.cmds.senddata("  No messages.\r\n\r\n");
		} else {
			for (var i = 0; i < this._messages.length && i < 20; i++) {
				var msg = this._messages[i];
				var unreadMark = (this._folder === FOLDER.INBOX && !msg.read) ? "*" : " ";
				var nameField = (this._folder === FOLDER.SENT) ? (msg.to_user || "") : (msg.from_user || "");
				this.call.cmds.senddata("  " + unreadMark + String(i + 1).padStart(3, " ") + ". " +
					this._padRight(this._truncate(nameField, 16), 16) + " " +
					this._truncate(msg.subject || "", 40) + "\r\n");
			}
			this.call.cmds.senddata("\r\n");
		}
		this.call.cmds.senddata("  [#] Read  [C] Compose  [I] Inbox  [S] Sent  [T] Trash  [Q] Quit\r\n");
		this.call.cmds.senddata("  > ");
		this._dumbPageLines = 0;
	}

	_drawMessageDumb() {
		if (!this.call || !this._currentMsg) return;
		var msg = this._currentMsg;
		var isNetwork = msg.transport_type && msg.transport_type !== "LOCAL";
		this.call.cmds.senddata("\r\n");
		var fromLine = "  From: " + (msg.from_user || "");
		if (isNetwork && msg.from_address) fromLine += " @ " + msg.from_address;
		this.call.cmds.senddata(fromLine + "\r\n");
		var toLine = "  To: " + (msg.to_user || "");
		if (isNetwork && msg.to_address) toLine += " @ " + msg.to_address;
		this.call.cmds.senddata(toLine + "\r\n");
		this.call.cmds.senddata("  Subject: " + (msg.subject || "") + "\r\n");
		this.call.cmds.senddata("  Date: " + this._formatFullDate(msg.system_time) +
			"  Via: " + (msg.transport_type || "LOCAL") + "\r\n");
		this.call.cmds.senddata("\r\n");

		var bodyText = msg.body_text || "";
		bodyText = bodyText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		var lines = bodyText.split("\n");
		for (var i = 0; i < lines.length; i++) {
			this.call.cmds.senddata("  " + lines[i] + "\r\n");
		}
		// Attachment indicator
		if (msg.has_attachments) {
			this.call.cmds.senddata("\r\n");
			this.call.cmds.setfgcolor(14);
			this.call.cmds.senddata("  [Attachments available -- use web or IMAP to download]\r\n");
			this.call.cmds.resetcolors();
		}
		this.call.cmds.senddata("\r\n  [R] Reply  [D] Delete  [Q] Back to list\r\n  > ");
	}

	// ===========================================================================
	// INPUT HANDLING
	// ===========================================================================

	onKey(key) {
		if (this._state === STATE.MESSAGE_LIST) {
			this._onKeyList(key);
		} else if (this._state === STATE.MESSAGE_VIEW) {
			this._onKeyMessageView(key);
		}
	}

	onChar(ch) {
		if (this._state === STATE.MESSAGE_LIST) {
			this._onCharList(ch);
		} else if (this._state === STATE.MESSAGE_VIEW) {
			this._onCharMessageView(ch);
		}
	}

	_onKeyList(key) {
		switch (key) {
			case "UpArrow":
				this._listMoveUp();
				return;
			case "DownArrow":
				this._listMoveDown();
				return;
			case "PgUp":
				this._listPageUp();
				return;
			case "PgDn":
				this._listPageDown();
				return;
			case "Home":
				this._listJumpFirst();
				return;
			case "End":
				this._listJumpLast();
				return;
			case "Enter":
				this._openCurrentMessage();
				return;
			case "ESC":
				this.signalReturn();
				return;
		}
	}

	_onCharList(ch) {
		var lower = ch.toLowerCase();
		switch (lower) {
			case "q":
				this.signalReturn();
				return;
			case "c":
				if (this._canCompose) this._launchCompose();
				return;
			case "i":
				this._switchFolder(FOLDER.INBOX);
				return;
			case "s":
				this._switchFolder(FOLDER.SENT);
				return;
			case "t":
				this._switchFolder(FOLDER.TRASH);
				return;
			case "d":
				if (this._folder !== FOLDER.TRASH) {
					this._deleteCurrentMessage().then(() => {
						if (this.active) this._setState(STATE.MESSAGE_LIST);
					});
				}
				return;
			case "u":
				if (this._folder === FOLDER.TRASH) {
					this._restoreCurrentMessage().then(() => {
						if (this.active) this._setState(STATE.MESSAGE_LIST);
					});
				}
				return;
			case "m":
				if (this._folder === FOLDER.INBOX) {
					this._markAllRead().then(() => {
						if (this.active) this._setState(STATE.MESSAGE_LIST);
					});
				}
				return;
			case "\r":
			case "\n":
				this._openCurrentMessage();
				return;
		}
	}

	_onKeyMessageView(key) {
		switch (key) {
			case "UpArrow":
				this._scrollBodyUp(false);
				return;
			case "DownArrow":
				this._scrollBodyDown(false);
				return;
			case "PgUp":
				this._scrollBodyUp(true);
				return;
			case "PgDn":
				this._scrollBodyDown(true);
				return;
			case "LeftArrow":
				this._prevMessage();
				return;
			case "RightArrow":
				this._nextMessage();
				return;
			case "ESC":
				this._setState(STATE.MESSAGE_LIST);
				return;
		}
	}

	_onCharMessageView(ch) {
		var lower = ch.toLowerCase();
		switch (lower) {
			case "q":
				this._setState(STATE.MESSAGE_LIST);
				return;
			case " ":
				var scrolled = this._scrollBodyDown(true);
				if (!scrolled) this._nextMessage();
				return;
			case "r":
				if (this._folder === FOLDER.INBOX) {
					this._launchReply();
				}
				return;
			case "d":
				if (this._folder !== FOLDER.TRASH) {
					this._deleteCurrentMessage().then(() => {
						if (this.active) this._setState(STATE.MESSAGE_LIST);
					});
				}
				return;
			case "u":
				if (this._folder === FOLDER.TRASH) {
					this._restoreCurrentMessage().then(() => {
						if (this.active) this._setState(STATE.MESSAGE_LIST);
					});
				}
				return;
			case "l":
				this._jumpToLast();
				return;
		}
	}

	// ===========================================================================
	// HANDLE INPUT DELEGATION
	// ===========================================================================

	handleInput(inputArray) {
		if (this._editorActive && this._activeEditor) {
			this._activeEditor.handleInput(inputArray);
			return;
		}
		super.handleInput(inputArray);
	}

	// ===========================================================================
	// ENTRY POINT
	// ===========================================================================

	run() {
		if (!this._userId) {
			if (this.dumb) {
				this.call.cmds.senddata("\r\n  You must be logged in to access private mail.\r\n");
			}
			setTimeout(() => { if (this.active) this.signalReturn(); }, 1000);
			return;
		}

		this._calcGeometry();

		// Check compose access
		this._allowedTransports = privateMessages.getAllowedTransports(this._userSession);
		this._canCompose = this._allowedTransports.length > 0;

		this._loadFolder()
			.then(() => {
				if (!this.active) return;
				this._setState(STATE.MESSAGE_LIST);
			})
			.catch(err => {
				if (!this.active) return;
				alogger.writeAlog(3, this.loggingId + " run error: " + (err?.stack || err), "redbright");
				this.signalReturn();
			});
	}

	clearHandler() {
		if (!this.active) return;
		if (this._activeEditor) {
			try { this._activeEditor.clearHandler(); } catch (_) {}
			this._activeEditor = null;
			this._editorActive = false;
		}
		this._messages = [];
		this._bodyLines = [];
		this._currentMsg = null;
		super.clearHandler();
	}
}

export { pmReader };
