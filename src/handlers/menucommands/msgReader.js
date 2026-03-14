import { BaseSubModule } from "../basesubmodule.js";
import { getRecentThreadsForArea, getThreadsPage, getThreadCount,
	getMessages, getMessageCount, getMessage } from "../../models/messages.js";
import { getAreaByShortcode } from "../../models/msgAreas.js";
import * as alogger from "../../utils/alogger.js";

// Lazy-import pointer module (may not be available in all deployments)
var _pointerMod = null;
async function getPointerMod() {
	if (!_pointerMod) {
		try {
			_pointerMod = await import("../../models/userMsgPointers.js");
		} catch (_) {
			_pointerMod = {};
		}
	}
	return _pointerMod;
}

// Lazy-import editor module
var _editorMod = null;
async function getEditorMod() {
	if (!_editorMod) {
		try {
			_editorMod = await import("./msgEditor.js");
		} catch (_) {
			_editorMod = null;
		}
	}
	return _editorMod;
}

// --- Constants ---

const STATE = {
	LOADING: 0,
	THREAD_LIST: 1,
	MESSAGE_VIEW: 2,
};

const MSG_BATCH = 30;
const THREAD_BATCH = 30;
const MAX_BODY_WIDTH = 100;

// Colors
const CLR_TITLE = 14;
const CLR_GROUP = 11;
const CLR_THREAD = 15;
const CLR_THREAD_UNREAD = 10;
const CLR_BAR_FG = 15;
const CLR_BAR_BG = 4;
const CLR_HEADER_LABEL = 11;
const CLR_HEADER_VALUE = 15;
const CLR_HEADER_DIM = 8;
const CLR_BODY = 7;
const CLR_STATUS = 8;
const CLR_NAV = 11;
const CLR_ERROR = 9;
const CLR_SEPARATOR = 8;
const CLR_COL_HEADER = 3;

// CP437 safe glyphs (extended range only)
const CP437_HLINE  = 0xC4;
const CP437_CORNER = 0xDA;
const CP437_ARROW  = 0xAF;
const CP437_BULLET = 0xF9;

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// =========================================================================

class msgReader extends BaseSubModule {
	constructor(call) {
		super(call, "MsgReader");

		// Encoding
		var enc = (call.term_encoding || "").toLowerCase();
		this._isUTF8 = (enc === "utf8" || enc === "utf-8");

		// Area config
		this._areaShortcode = call.msg_area || "";
		this._areaName = call.msg_area_title || call.msg_area || "";
		this._areaConfig = null;     // loaded from DB
		this._threadMode = "standard";
		this._userId = (call.user_record && call.user_record.id) ? call.user_record.id : null;

		// State machine
		this._state = STATE.LOADING;
		this._viewMode = "threaded"; // "threaded" or "flat" — tracks which mode MESSAGE_VIEW is in

		// Geometry — computed in _calcGeometry()
		this._termW = call.term_width || 80;
		this._termH = call.term_height || 24;
		this._bodyWidth = 0;
		this._bodyLeft = 0;
		this._bodyRight = 0;
		this._bodyViewStart = 5;     // first row of body viewport
		this._bodyViewEnd = 0;       // last row of body viewport
		this._bodyViewHeight = 0;
		this._listViewStart = 3;     // first row of thread list content
		this._listViewEnd = 0;
		this._listViewHeight = 0;
		this._statusRow = 0;
		this._navRow = 0;

		// Thread list state
		this._threads = [];
		this._threadUnreads = {};    // thread.id -> unread count
		this._threadCursor = 0;      // lightbar index
		this._threadScroll = 0;      // scroll offset
		this._threadTotal = 0;
		this._threadSearchMode = false;
		this._threadSearchBuf = "";
		this._filteredThreads = [];

		// Message list state
		this._messages = [];
		this._msgIdx = 0;
		this._hasOlder = false;
		this._hasNewer = false;
		this._oldestId = null;
		this._newestId = null;
		this._currentThreadId = null; // DB thread.id for current threaded view
		this._totalMsgCount = 0;

		// Body scroll state
		this._bodyLines = [];
		this._bodyScroll = 0;

		// Dumb terminal state
		this._dumbPageLines = 0;

		// Editor sub-module state
		this._editorActive = false;
		this._activeEditor = null;

		this.loggingId = "MsgReader (Node " + call.nodenum + ")";
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

	// --- Geometry ---

	_calcGeometry() {
		this._bodyWidth = Math.min(this._termW, MAX_BODY_WIDTH);
		this._bodyLeft = Math.floor((this._termW - this._bodyWidth) / 2) + 1;
		this._bodyRight = this._bodyLeft + this._bodyWidth - 1;

		this._navRow = this._termH;
		this._statusRow = this._termH - 1;

		// Message view: header rows 1-3, separator row 4, body 5 to H-2
		this._bodyViewStart = 5;
		this._bodyViewEnd = this._termH - 2;
		this._bodyViewHeight = this._bodyViewEnd - this._bodyViewStart + 1;
		if (this._bodyViewHeight < 3) this._bodyViewHeight = 3;

		// Thread list: row 1 title, row 2 info, row 3 col headers, row 4+ content, H-1 status, H nav
		this._listViewStart = 4;
		this._listViewEnd = this._termH - 2;
		this._listViewHeight = this._listViewEnd - this._listViewStart + 1;
		if (this._listViewHeight < 3) this._listViewHeight = 3;
	}

	// --- Date formatting ---

	_formatShortDate(date) {
		if (!date) return "      ";
		var d = new Date(date);
		if (isNaN(d.getTime())) return "      ";
		return MONTHS[d.getMonth()] + " " + String(d.getDate()).padStart(2, " ");
	}

	_formatFullDate(date) {
		if (!date) return "";
		var d = new Date(date);
		if (isNaN(d.getTime())) return "";
		var yr = d.getFullYear();
		var mo = String(d.getMonth() + 1).padStart(2, "0");
		var dy = String(d.getDate()).padStart(2, "0");
		var hr = String(d.getHours()).padStart(2, "0");
		var mn = String(d.getMinutes()).padStart(2, "0");
		return yr + "-" + mo + "-" + dy + " " + hr + ":" + mn;
	}

	// --- Word wrap ---

	_wordWrap(text, maxWidth) {
		if (!text) return [""];
		// Normalize line endings
		text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		var sourceLines = text.split("\n");
		var result = [];

		for (var i = 0; i < sourceLines.length; i++) {
			var line = sourceLines[i];
			if (line.length <= maxWidth) {
				result.push(line);
				continue;
			}
			// Wrap long lines on word boundaries
			var remaining = line;
			while (remaining.length > maxWidth) {
				var breakAt = remaining.lastIndexOf(" ", maxWidth);
				if (breakAt <= 0) {
					// No good break point — hard break
					breakAt = maxWidth;
				}
				result.push(remaining.substring(0, breakAt));
				remaining = remaining.substring(breakAt);
				// Strip leading space from continuation
				if (remaining.charAt(0) === " ") remaining = remaining.substring(1);
			}
			result.push(remaining);
		}

		return result;
	}

	// --- Prepare body lines for a message ---

	_prepareBodyLines(msg) {
		var rawText = msg.utf8 || msg.body_text || "";
		var isAnsi = msg.isAnsi || false;

		if (isAnsi) {
			// ANSI messages sent as-is; split on lines but don't wrap
			rawText = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
			this._bodyLines = rawText.split("\n");
		} else {
			var wrapWidth = this._bodyWidth - 2;
			if (wrapWidth < 20) wrapWidth = 20;
			this._bodyLines = this._wordWrap(rawText, wrapWidth);
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

	async _loadAreaConfig() {
		if (!this._areaShortcode) return false;
		this._areaConfig = await getAreaByShortcode(this._areaShortcode);
		if (!this._areaConfig) return false;
		this._threadMode = this._areaConfig.thread_mode || "standard";
		this._areaName = this._areaConfig.name || this._areaShortcode;
		return true;
	}

	async _loadThreadList() {
		this._threads = await getRecentThreadsForArea(this._areaShortcode);
		this._threadTotal = await getThreadCount(this._areaShortcode);

		// Load unread counts
		if (this._userId && this._threads.length > 0) {
			var pm = await getPointerMod();
			if (pm.getThreadUnreadCounts) {
				var threadIds = this._threads.map(t => t.id);
				try {
					this._threadUnreads = await pm.getThreadUnreadCounts(
						this._userId, this._areaShortcode, threadIds
					);
				} catch (_) {
					this._threadUnreads = {};
				}
			}
		}

		this._filteredThreads = this._threads.slice();
	}

	async _loadMoreThreads() {
		if (this._threads.length === 0) return;
		var last = this._threads[this._threads.length - 1];
		var more = await getThreadsPage(this._areaShortcode, {
			beforeDate: last.last_message,
			beforeId: last.id,
			limit: THREAD_BATCH
		});
		if (more && more.length > 0) {
			this._threads = this._threads.concat(more);
			// Load unread counts for new threads
			if (this._userId) {
				var pm = await getPointerMod();
				if (pm.getThreadUnreadCounts) {
					var newIds = more.map(t => t.id);
					try {
						var newUnreads = await pm.getThreadUnreadCounts(
							this._userId, this._areaShortcode, newIds
						);
						for (var tid in newUnreads) {
							this._threadUnreads[tid] = newUnreads[tid];
						}
					} catch (_) {}
				}
			}
			this._applyThreadFilter();
		}
	}

	async _loadMessagesForThread(threadDbId) {
		this._currentThreadId = threadDbId;
		this._viewMode = "threaded";

		// Find first unread position
		var startAfterId = 0;
		if (this._userId) {
			var pm = await getPointerMod();
			if (pm.getFirstUnreadInThread) {
				try {
					var firstUnread = await pm.getFirstUnreadInThread(
						this._userId, this._areaShortcode, threadDbId
					);
					if (firstUnread) startAfterId = firstUnread - 1;
				} catch (_) {}
			}
		}

		this._messages = await getMessages(this._areaShortcode, {
			threadId: threadDbId,
			afterId: startAfterId > 0 ? startAfterId : undefined,
			limit: MSG_BATCH,
			order: "ASC"
		});

		// If we got nothing (pointer is past end), load from the start
		if (this._messages.length === 0 && startAfterId > 0) {
			this._messages = await getMessages(this._areaShortcode, {
				threadId: threadDbId,
				limit: MSG_BATCH,
				order: "ASC"
			});
		}

		this._msgIdx = 0;
		this._updateMessageBounds();

		// Check if there are older/newer messages
		if (this._messages.length > 0) {
			var older = await getMessages(this._areaShortcode, {
				threadId: threadDbId,
				beforeId: this._oldestId,
				limit: 1,
				order: "DESC"
			});
			this._hasOlder = (older && older.length > 0);

			var newer = await getMessages(this._areaShortcode, {
				threadId: threadDbId,
				afterId: this._newestId,
				limit: 1,
				order: "ASC"
			});
			this._hasNewer = (newer && newer.length > 0);
		}

		this._totalMsgCount = await getMessageCount(this._areaShortcode);
	}

	async _loadMessagesFlat() {
		this._currentThreadId = null;
		this._viewMode = "flat";

		var startAfterId = 0;
		if (this._userId) {
			var pm = await getPointerMod();
			if (pm.getFirstUnreadInArea) {
				try {
					var firstUnread = await pm.getFirstUnreadInArea(
						this._userId, this._areaShortcode
					);
					if (firstUnread) startAfterId = firstUnread - 1;
				} catch (_) {}
			}
		}

		this._messages = await getMessages(this._areaShortcode, {
			afterId: startAfterId > 0 ? startAfterId : undefined,
			limit: MSG_BATCH,
			order: "ASC"
		});

		if (this._messages.length === 0 && startAfterId > 0) {
			this._messages = await getMessages(this._areaShortcode, {
				limit: MSG_BATCH,
				order: "ASC"
			});
		}

		this._msgIdx = 0;
		this._updateMessageBounds();
		await this._checkMessageBounds();
		this._totalMsgCount = await getMessageCount(this._areaShortcode);
	}

	_updateMessageBounds() {
		if (this._messages.length > 0) {
			this._oldestId = this._messages[0].id;
			this._newestId = this._messages[this._messages.length - 1].id;
		} else {
			this._oldestId = null;
			this._newestId = null;
		}
	}

	async _checkMessageBounds() {
		if (this._messages.length === 0) {
			this._hasOlder = false;
			this._hasNewer = false;
			return;
		}
		var opts = this._currentThreadId
			? { threadId: this._currentThreadId, beforeId: this._oldestId, limit: 1, order: "DESC" }
			: { beforeId: this._oldestId, limit: 1, order: "DESC" };
		var older = await getMessages(this._areaShortcode, opts);
		this._hasOlder = (older && older.length > 0);

		var opts2 = this._currentThreadId
			? { threadId: this._currentThreadId, afterId: this._newestId, limit: 1, order: "ASC" }
			: { afterId: this._newestId, limit: 1, order: "ASC" };
		var newer = await getMessages(this._areaShortcode, opts2);
		this._hasNewer = (newer && newer.length > 0);
	}

	async _loadOlderMessages() {
		if (!this._hasOlder || !this._oldestId) return false;
		var opts = {
			beforeId: this._oldestId,
			limit: MSG_BATCH,
			order: "DESC"
		};
		if (this._currentThreadId) opts.threadId = this._currentThreadId;

		var older = await getMessages(this._areaShortcode, opts);
		if (!older || older.length === 0) {
			this._hasOlder = false;
			return false;
		}
		older.reverse();
		this._messages = older.concat(this._messages);
		this._msgIdx += older.length;
		this._updateMessageBounds();
		// Check if there's still more
		var check = { beforeId: this._oldestId, limit: 1, order: "DESC" };
		if (this._currentThreadId) check.threadId = this._currentThreadId;
		var more = await getMessages(this._areaShortcode, check);
		this._hasOlder = (more && more.length > 0);
		return true;
	}

	async _loadNewerMessages() {
		if (!this._hasNewer || !this._newestId) return false;
		var opts = {
			afterId: this._newestId,
			limit: MSG_BATCH,
			order: "ASC"
		};
		if (this._currentThreadId) opts.threadId = this._currentThreadId;

		var newer = await getMessages(this._areaShortcode, opts);
		if (!newer || newer.length === 0) {
			this._hasNewer = false;
			return false;
		}
		this._messages = this._messages.concat(newer);
		this._updateMessageBounds();
		var check = { afterId: this._newestId, limit: 1, order: "ASC" };
		if (this._currentThreadId) check.threadId = this._currentThreadId;
		var more = await getMessages(this._areaShortcode, check);
		this._hasNewer = (more && more.length > 0);
		return true;
	}

	// ===========================================================================
	// THREAD LIST FILTERING
	// ===========================================================================

	_applyThreadFilter() {
		if (!this._threadSearchBuf || this._threadSearchBuf.length === 0) {
			this._filteredThreads = this._threads.slice();
			return;
		}
		var term = this._threadSearchBuf.toLowerCase();
		this._filteredThreads = this._threads.filter(t => {
			return (t.subject && t.subject.toLowerCase().includes(term)) ||
				(t.started_by && t.started_by.toLowerCase().includes(term)) ||
				(t.last_message_from && t.last_message_from.toLowerCase().includes(term));
		});
	}

	// ===========================================================================
	// POINTER MANAGEMENT
	// ===========================================================================

	async _advancePointers(msg) {
		if (!this._userId || !msg) return;
		var pm = await getPointerMod();
		try {
			if (this._viewMode === "threaded" && this._currentThreadId && pm.advanceThreadPointer) {
				await pm.advanceThreadPointer(this._userId, this._areaShortcode, this._currentThreadId, msg.id);
			} else if (pm.advancePointer) {
				await pm.advancePointer(this._userId, this._areaShortcode, msg.id);
			}
		} catch (err) {
			alogger.writeAlog(4, this.loggingId + " pointer advance error: " + (err?.message || err), "yellow");
		}
	}

	async _markAreaRead() {
		if (!this._userId) return;
		var pm = await getPointerMod();
		if (pm.markAreaRead) {
			try {
				await pm.markAreaRead(this._userId, this._areaShortcode);
				// Clear unread counts
				this._threadUnreads = {};
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
			case STATE.THREAD_LIST:
				this._drawThreadListScreen();
				break;
			case STATE.MESSAGE_VIEW:
				if (this._messages.length > 0) {
					this._showCurrentMessage();
				} else {
					this._drawEmptyArea();
				}
				break;
		}
	}

	_showCurrentMessage() {
		if (this._msgIdx < 0 || this._msgIdx >= this._messages.length) return;
		var msg = this._messages[this._msgIdx];
		this._prepareBodyLines(msg);
		this._drawMessageScreen();
		this._advancePointers(msg);
	}

	// ===========================================================================
	// THREAD LIST DRAWING
	// ===========================================================================

	_drawThreadListScreen() {
		if (!this.call) return;
		if (this.dumb) {
			this._drawThreadListDumb();
			return;
		}
		this.call.cmds.clearscreen();

		// Row 1: area title + stats
		this.call.cmds.movecursor(this._bodyLeft, 1);
		this.call.cmds.setfgcolor(CLR_TITLE);
		this._sendGlyph("\u250C", CP437_CORNER);
		this.call.cmds.senddata(" " + this._truncate(this._areaName, this._bodyWidth - 30));
		// Right-aligned stats
		var stats = this._threadTotal + " threads";
		var totalUnread = 0;
		for (var tid in this._threadUnreads) {
			totalUnread += (this._threadUnreads[tid] || 0);
		}
		if (totalUnread > 0) stats += "  " + totalUnread + " unread";
		var statsX = this._bodyRight - stats.length;
		if (statsX > this._bodyLeft + this._areaName.length + 4) {
			this.call.cmds.movecursor(statsX, 1);
			this.call.cmds.setfgcolor(CLR_STATUS);
			this.call.cmds.senddata(stats);
		}

		// Row 2: info / search
		this._drawThreadInfoLine();

		// Row 3: column headers
		this._drawThreadColumnHeader();

		// Rows 4+: thread list
		this._drawThreadRows();

		// Status + nav
		this._drawThreadStatusBar();
		this._drawThreadNavBar();

		this.call.cmds.resetcolors();
	}

	_drawThreadInfoLine() {
		if (this.dumb) return;
		this.call.cmds.movecursor(this._bodyLeft, 2);
		this.call.cmds.cleartoeol();
		if (this._threadSearchMode) {
			this.call.cmds.setfgcolor(CLR_TITLE);
			this.call.cmds.senddata("Search: " + this._threadSearchBuf + "_");
		}
		this.call.cmds.resetcolors();
	}

	_drawThreadColumnHeader() {
		if (this.dumb) return;
		var cols = this._calcThreadColumns();
		this.call.cmds.movecursor(this._bodyLeft, 3);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(CLR_COL_HEADER);
		var hdr = "  " +
			this._padRight("Subject", cols.subjectW) + " " +
			this._padRight("From", cols.fromW) + " " +
			this._padLeft("Msgs", cols.msgsW) + " " +
			this._padRight("Last", cols.lastW) + " " +
			this._padLeft("New", cols.newW);
		this.call.cmds.senddata(this._truncate(hdr, this._bodyWidth));
		this.call.cmds.resetcolors();
	}

	_calcThreadColumns() {
		var fromW = 16;
		var msgsW = 5;
		var lastW = 6;
		var newW = 4;
		var fixedW = 2 + fromW + 1 + msgsW + 1 + lastW + 1 + newW + 1; // prefix + gaps
		var subjectW = this._bodyWidth - fixedW;
		if (subjectW < 10) subjectW = 10;
		return { subjectW: subjectW, fromW: fromW, msgsW: msgsW, lastW: lastW, newW: newW };
	}

	_drawThreadRows() {
		if (this.dumb) return;
		var cols = this._calcThreadColumns();

		for (var vi = 0; vi < this._listViewHeight; vi++) {
			var tidx = this._threadScroll + vi;
			var screenY = this._listViewStart + vi;
			this.call.cmds.movecursor(this._bodyLeft, screenY);
			this.call.cmds.cleartoeol();

			if (tidx >= this._filteredThreads.length) continue;

			var thread = this._filteredThreads[tidx];
			var isHighlighted = (tidx === this._threadCursor);
			this._drawSingleThreadRow(thread, screenY, cols, isHighlighted);
			this.call.cmds.resetcolors();
		}
	}

	_drawSingleThreadRow(thread, screenY, cols, isHighlighted) {
		this.call.cmds.movecursor(this._bodyLeft, screenY);

		var unread = this._threadUnreads[thread.id] || 0;

		if (isHighlighted) {
			this.call.cmds.setfgcolor(CLR_BAR_FG);
			this.call.cmds.setbgcolor(CLR_BAR_BG);
		} else {
			this.call.cmds.setfgcolor(CLR_THREAD);
		}

		// Build the row string
		var prefix = isHighlighted ? " " : "  ";
		if (isHighlighted) {
			this.call.cmds.senddata(" ");
			this._sendGlyph("\u25BA", CP437_ARROW);
		} else {
			this.call.cmds.senddata("  ");
		}

		var subject = this._padRight(this._truncate(thread.subject || "(no subject)", cols.subjectW), cols.subjectW);
		var from = this._padRight(this._truncate(thread.last_message_from || thread.started_by || "", cols.fromW), cols.fromW);
		var msgs = this._padLeft(String(thread.message_count || 0), cols.msgsW);
		var last = this._padRight(this._formatShortDate(thread.last_message), cols.lastW);
		var newStr = unread > 0 ? this._padLeft(String(unread), cols.newW) : this._padRight("", cols.newW);

		var rowText = subject + " " + from + " " + msgs + " " + last + " ";
		this.call.cmds.senddata(rowText);

		// Unread count in a distinct color (unless highlighted, where bar color takes priority)
		if (unread > 0 && !isHighlighted) {
			this.call.cmds.setfgcolor(CLR_THREAD_UNREAD);
		}
		this.call.cmds.senddata(newStr);

		// Pad bar to full width
		if (isHighlighted) {
			var written = 2 + rowText.length + newStr.length;
			var remaining = this._bodyWidth - written;
			if (remaining > 0) {
				var pad = "";
				for (var p = 0; p < remaining; p++) pad += " ";
				this.call.cmds.senddata(pad);
			}
		}
	}

	_redrawThreadRow(tidx) {
		if (this.dumb) return;
		var vi = tidx - this._threadScroll;
		if (vi < 0 || vi >= this._listViewHeight) return;
		var screenY = this._listViewStart + vi;
		this.call.cmds.movecursor(this._bodyLeft, screenY);
		this.call.cmds.cleartoeol();
		if (tidx >= this._filteredThreads.length) return;
		var cols = this._calcThreadColumns();
		this._drawSingleThreadRow(this._filteredThreads[tidx], screenY, cols, tidx === this._threadCursor);
		this.call.cmds.resetcolors();
	}

	_drawThreadStatusBar() {
		if (this.dumb) return;
		this.call.cmds.movecursor(1, this._statusRow);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(CLR_STATUS);
		var pos = this._filteredThreads.length > 0
			? " Thread " + (this._threadCursor + 1) + "/" + this._filteredThreads.length
			: " No threads";
		this.call.cmds.senddata(pos);
		this.call.cmds.resetcolors();
	}

	_drawThreadNavBar() {
		if (this.dumb) return;
		this.call.cmds.movecursor(1, this._navRow);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(CLR_NAV);
		var nav = " [Enter] Read  [F] Flat View  [S] Search  [M] Mark Read  [ESC/Q] Back";
		this.call.cmds.senddata(this._truncate(nav, this._termW));
		this.call.cmds.resetcolors();
	}

	// --- Thread list navigation ---

	_threadMoveUp() {
		if (this._threadCursor <= 0) return;
		var prev = this._threadCursor;
		var prevScroll = this._threadScroll;
		this._threadCursor--;
		this._ensureThreadVisible();
		if (this._threadScroll !== prevScroll) {
			this._drawThreadRows();
		} else {
			this._redrawThreadRow(prev);
			this._redrawThreadRow(this._threadCursor);
		}
		this._drawThreadStatusBar();
	}

	_threadMoveDown() {
		if (this._threadCursor >= this._filteredThreads.length - 1) {
			// Try to lazy-load more
			if (this._threads.length < this._threadTotal) {
				this._loadMoreThreads().then(() => {
					if (!this.active) return;
					this._applyThreadFilter();
					if (this._threadCursor < this._filteredThreads.length - 1) {
						this._threadCursor++;
						this._ensureThreadVisible();
						this._drawThreadRows();
						this._drawThreadStatusBar();
					}
				});
			}
			return;
		}
		var prev = this._threadCursor;
		var prevScroll = this._threadScroll;
		this._threadCursor++;
		this._ensureThreadVisible();
		if (this._threadScroll !== prevScroll) {
			this._drawThreadRows();
		} else {
			this._redrawThreadRow(prev);
			this._redrawThreadRow(this._threadCursor);
		}
		this._drawThreadStatusBar();
	}

	_ensureThreadVisible() {
		if (this._threadCursor < this._threadScroll) {
			this._threadScroll = this._threadCursor;
		} else if (this._threadCursor >= this._threadScroll + this._listViewHeight) {
			this._threadScroll = this._threadCursor - this._listViewHeight + 1;
		}
	}

	_threadPageUp() {
		var moves = this._listViewHeight - 1;
		this._threadCursor = Math.max(0, this._threadCursor - moves);
		this._ensureThreadVisible();
		this._drawThreadRows();
		this._drawThreadStatusBar();
	}

	_threadPageDown() {
		var moves = this._listViewHeight - 1;
		this._threadCursor = Math.min(this._filteredThreads.length - 1, this._threadCursor + moves);
		this._ensureThreadVisible();
		this._drawThreadRows();
		this._drawThreadStatusBar();
	}

	_threadJumpFirst() {
		this._threadCursor = 0;
		this._threadScroll = 0;
		this._drawThreadRows();
		this._drawThreadStatusBar();
	}

	_threadJumpLast() {
		this._threadCursor = this._filteredThreads.length - 1;
		this._ensureThreadVisible();
		this._drawThreadRows();
		this._drawThreadStatusBar();
	}

	// ===========================================================================
	// MESSAGE VIEW DRAWING
	// ===========================================================================

	_drawMessageScreen() {
		if (!this.call) return;
		if (this.dumb) {
			this._drawMessageDumb();
			return;
		}
		if (this._messages.length === 0) {
			this._drawEmptyArea();
			return;
		}

		this.call.cmds.clearscreen();
		var msg = this._messages[this._msgIdx];

		this._drawMessageHeader(msg);
		this._drawSeparator();
		this._drawBodyViewport();
		this._drawMessageStatusBar();
		this._drawMessageNavBar();

		this.call.cmds.resetcolors();
	}

	_drawMessageHeader(msg) {
		if (this.dumb) return;
		var dateStr = this._formatFullDate(msg.system_time);

		// Row 1: From + Date
		this.call.cmds.movecursor(1, 1);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(CLR_HEADER_LABEL);
		this.call.cmds.senddata(" From: ");
		this.call.cmds.setfgcolor(CLR_HEADER_VALUE);
		this.call.cmds.senddata(this._truncate(msg.from_user || "", this._termW - 30));
		// Right-aligned date
		if (dateStr) {
			var dateLabel = "Date: " + dateStr;
			var dateX = this._termW - dateLabel.length;
			if (dateX > 0) {
				this.call.cmds.movecursor(dateX, 1);
				this.call.cmds.setfgcolor(CLR_HEADER_LABEL);
				this.call.cmds.senddata("Date: ");
				this.call.cmds.setfgcolor(CLR_HEADER_DIM);
				this.call.cmds.senddata(dateStr);
			}
		}

		// Row 2: To + Area
		this.call.cmds.movecursor(1, 2);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(CLR_HEADER_LABEL);
		this.call.cmds.senddata("   To: ");
		this.call.cmds.setfgcolor(CLR_HEADER_VALUE);
		this.call.cmds.senddata(this._truncate(msg.to_user || "All", this._termW - 30));
		var areaLabel = "Area: " + this._areaName;
		var areaX = this._termW - areaLabel.length;
		if (areaX > 0) {
			this.call.cmds.movecursor(areaX, 2);
			this.call.cmds.setfgcolor(CLR_HEADER_LABEL);
			this.call.cmds.senddata("Area: ");
			this.call.cmds.setfgcolor(CLR_HEADER_DIM);
			this.call.cmds.senddata(this._areaName);
		}

		// Row 3: Subject
		this.call.cmds.movecursor(1, 3);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(CLR_HEADER_LABEL);
		this.call.cmds.senddata(" Subj: ");
		this.call.cmds.setfgcolor(CLR_HEADER_VALUE);
		this.call.cmds.senddata(this._truncate(msg.subject || "", this._termW - 8));
	}

	_drawSeparator() {
		if (this.dumb) return;
		this.call.cmds.movecursor(1, 4);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(CLR_SEPARATOR);
		for (var i = 0; i < this._termW; i++) {
			this._sendGlyph("\u2500", CP437_HLINE);
		}
		this.call.cmds.resetcolors();
	}

	_drawBodyViewport() {
		if (this.dumb) return;
		var margin = this._bodyLeft;

		for (var vi = 0; vi < this._bodyViewHeight; vi++) {
			var lineIdx = this._bodyScroll + vi;
			var screenY = this._bodyViewStart + vi;

			this.call.cmds.movecursor(margin, screenY);
			this.call.cmds.cleartoeol();

			if (lineIdx < this._bodyLines.length) {
				this.call.cmds.setfgcolor(CLR_BODY);
				this.call.cmds.senddata(" " + this._truncate(this._bodyLines[lineIdx], this._bodyWidth - 2));
			}
		}
		this.call.cmds.resetcolors();
	}

	_drawMessageStatusBar() {
		if (this.dumb) return;
		this.call.cmds.movecursor(1, this._statusRow);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(CLR_STATUS);

		var parts = [];
		parts.push("Msg " + (this._msgIdx + 1) + "/" + this._messages.length);

		if (this._viewMode === "threaded" && this._filteredThreads.length > 0) {
			var threadIdx = this._threadCursor + 1;
			var threadSubj = this._filteredThreads[this._threadCursor]
				? this._filteredThreads[this._threadCursor].subject || ""
				: "";
			if (threadSubj.length > 25) threadSubj = threadSubj.substring(0, 22) + "...";
			parts.push("Thread: \"" + threadSubj + "\" (" + threadIdx + "/" + this._filteredThreads.length + ")");
		} else {
			parts.push("Area: " + this._areaName);
		}

		// Scroll indicators
		var canUp = this._bodyScroll > 0;
		var canDown = this._bodyScroll + this._bodyViewHeight < this._bodyLines.length;
		var scrollInd = "";
		if (canUp && canDown) scrollInd = " ^v";
		else if (canUp) scrollInd = " ^";
		else if (canDown) scrollInd = " v";

		var statusStr = " " + parts.join(" | ") + scrollInd;
		this.call.cmds.senddata(this._truncate(statusStr, this._termW));
		this.call.cmds.resetcolors();
	}

	_drawMessageNavBar() {
		if (this.dumb) return;
		this.call.cmds.movecursor(1, this._navRow);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(CLR_NAV);

		var parts = ["[Left]Prev", "[Right]Next", "[R]eply", "[L]ast"];

		if (this._viewMode === "threaded") {
			parts.push("[[]PrevThd");
			parts.push("[]]NextThd");
		}

		if (this._threadMode === "standard") {
			if (this._viewMode === "threaded") {
				parts.push("[F]lat");
			} else {
				parts.push("[T]hreaded");
			}
		}

		parts.push("[Q]uit");

		var nav = " " + parts.join("  ");
		this.call.cmds.senddata(this._truncate(nav, this._termW));
		this.call.cmds.resetcolors();
	}

	_drawEmptyArea() {
		if (this.dumb) {
			this.call.cmds.senddata("\r\n  No messages in this area.\r\n");
			return;
		}
		this.call.cmds.clearscreen();
		this.call.cmds.movecursor(this._bodyLeft, this._bodyViewStart);
		this.call.cmds.setfgcolor(CLR_STATUS);
		this.call.cmds.senddata("No messages in this area.");
		this._drawMessageNavBar();
		this.call.cmds.resetcolors();
	}

	// --- Body scrolling ---

	_scrollBodyUp(pages) {
		var amount = pages ? this._bodyViewHeight : 1;
		if (this._bodyScroll <= 0) return;
		this._bodyScroll = Math.max(0, this._bodyScroll - amount);
		this._drawBodyViewport();
		this._drawMessageStatusBar();
	}

	_scrollBodyDown(pages) {
		var amount = pages ? this._bodyViewHeight : 1;
		var maxScroll = Math.max(0, this._bodyLines.length - this._bodyViewHeight);
		if (this._bodyScroll >= maxScroll) return false; // signals "at bottom"
		this._bodyScroll = Math.min(maxScroll, this._bodyScroll + amount);
		this._drawBodyViewport();
		this._drawMessageStatusBar();
		return true;
	}

	// ===========================================================================
	// MESSAGE NAVIGATION
	// ===========================================================================

	_nextMessage() {
		if (this._msgIdx < this._messages.length - 1) {
			this._msgIdx++;
			this._showCurrentMessage();
		} else if (this._hasNewer) {
			this._loadNewerMessages().then(loaded => {
				if (!this.active) return;
				if (loaded && this._msgIdx < this._messages.length - 1) {
					this._msgIdx++;
					this._showCurrentMessage();
				}
			}).catch(() => {});
		}
	}

	_prevMessage() {
		if (this._msgIdx > 0) {
			this._msgIdx--;
			this._showCurrentMessage();
		} else if (this._hasOlder) {
			this._loadOlderMessages().then(loaded => {
				if (!this.active) return;
				// After loading older, _msgIdx was shifted by the insert count
				// and now points to the same message. We want the one before it.
				if (loaded && this._msgIdx > 0) {
					this._msgIdx--;
					this._showCurrentMessage();
				}
			}).catch(() => {});
		}
	}

	_jumpToLast() {
		// Load newest messages
		if (this._hasNewer) {
			// Keep loading until we reach the end
			var self = this;
			(async function loadAll() {
				while (self.active && self._hasNewer) {
					var loaded = await self._loadNewerMessages();
					if (!loaded) break;
				}
				if (!self.active) return;
				self._msgIdx = self._messages.length - 1;
				self._showCurrentMessage();
			})().catch(() => {});
		} else {
			this._msgIdx = this._messages.length - 1;
			this._showCurrentMessage();
		}
	}

	_nextThread() {
		if (this._viewMode !== "threaded") return;
		if (this._threadCursor >= this._filteredThreads.length - 1) return;
		this._threadCursor++;
		var thread = this._filteredThreads[this._threadCursor];
		this._loadMessagesForThread(thread.id).then(() => {
			if (!this.active) return;
			this._setState(STATE.MESSAGE_VIEW);
		}).catch(() => {});
	}

	_prevThread() {
		if (this._viewMode !== "threaded") return;
		if (this._threadCursor <= 0) return;
		this._threadCursor--;
		var thread = this._filteredThreads[this._threadCursor];
		this._loadMessagesForThread(thread.id).then(() => {
			if (!this.active) return;
			this._setState(STATE.MESSAGE_VIEW);
		}).catch(() => {});
	}

	_openSelectedThread() {
		if (this._filteredThreads.length === 0) return;
		var thread = this._filteredThreads[this._threadCursor];
		if (!thread) return;
		this._loadMessagesForThread(thread.id).then(() => {
			if (!this.active) return;
			this._setState(STATE.MESSAGE_VIEW);
		}).catch(err => {
			alogger.writeAlog(3, this.loggingId + " open thread error: " + (err?.stack || err), "redbright");
		});
	}

	_switchToFlat() {
		this._loadMessagesFlat().then(() => {
			if (!this.active) return;
			this._setState(STATE.MESSAGE_VIEW);
		}).catch(() => {});
	}

	_switchToThreaded() {
		if (this._threadMode !== "standard") return;
		this._setState(STATE.THREAD_LIST);
	}

	// ===========================================================================
	// INPUT HANDLING
	// ===========================================================================

	onKey(key) {
		if (this._state === STATE.THREAD_LIST) {
			this._onKeyThreadList(key);
		} else if (this._state === STATE.MESSAGE_VIEW) {
			this._onKeyMessageView(key);
		}
	}

	onChar(ch) {
		if (this._state === STATE.THREAD_LIST) {
			this._onCharThreadList(ch);
		} else if (this._state === STATE.MESSAGE_VIEW) {
			this._onCharMessageView(ch);
		}
	}

	// --- Thread list input ---

	_onKeyThreadList(key) {
		if (this._threadSearchMode) {
			this._onKeyThreadSearch(key);
			return;
		}

		switch (key) {
			case "UpArrow":
				this._threadMoveUp();
				return;
			case "DownArrow":
				this._threadMoveDown();
				return;
			case "PgUp":
				this._threadPageUp();
				return;
			case "PgDn":
				this._threadPageDown();
				return;
			case "Home":
				this._threadJumpFirst();
				return;
			case "End":
				this._threadJumpLast();
				return;
			case "Enter":
				this._openSelectedThread();
				return;
			case "ESC":
				this.signalReturn();
				return;
		}
	}

	_onCharThreadList(ch) {
		if (this._threadSearchMode) {
			this._onCharThreadSearch(ch);
			return;
		}

		var lower = ch.toLowerCase();
		switch (lower) {
			case "q":
				this.signalReturn();
				return;
			case "f":
				this._switchToFlat();
				return;
			case "s":
				this._enterThreadSearch();
				return;
			case "m":
				this._markAreaRead().then(() => {
					if (!this.active) return;
					this._drawThreadRows();
					this._drawThreadStatusBar();
				});
				return;
		}
	}

	_enterThreadSearch() {
		this._threadSearchMode = true;
		this._threadSearchBuf = "";
		this._drawThreadInfoLine();
		this._drawThreadStatusBar();
	}

	_exitThreadSearch() {
		this._threadSearchMode = false;
		this._threadSearchBuf = "";
		this._applyThreadFilter();
		this._threadCursor = 0;
		this._threadScroll = 0;
		this._drawThreadInfoLine();
		this._drawThreadRows();
		this._drawThreadStatusBar();
	}

	_updateThreadSearch() {
		this._applyThreadFilter();
		this._threadCursor = 0;
		this._threadScroll = 0;
		this._drawThreadInfoLine();
		this._drawThreadRows();
		this._drawThreadStatusBar();
	}

	_onKeyThreadSearch(key) {
		switch (key) {
			case "ESC":
				this._exitThreadSearch();
				return;
			case "Enter":
				this._threadSearchMode = false;
				this._drawThreadInfoLine();
				if (this._filteredThreads.length > 0) {
					this._openSelectedThread();
				}
				return;
			case "Backspace":
				if (this._threadSearchBuf.length > 0) {
					this._threadSearchBuf = this._threadSearchBuf.slice(0, -1);
					this._updateThreadSearch();
				}
				return;
			case "UpArrow":
				this._threadMoveUp();
				return;
			case "DownArrow":
				this._threadMoveDown();
				return;
		}
	}

	_onCharThreadSearch(ch) {
		this._threadSearchBuf += ch;
		this._updateThreadSearch();
	}

	// --- Message view input ---

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
				if (this._viewMode === "threaded" || this._threadMode === "standard") {
					this._setState(STATE.THREAD_LIST);
				} else {
					this.signalReturn();
				}
				return;
		}
	}

	_onCharMessageView(ch) {
		var lower = ch.toLowerCase();
		switch (lower) {
			case "q":
				if (this._viewMode === "threaded" || this._threadMode === "standard") {
					this._setState(STATE.THREAD_LIST);
				} else {
					this.signalReturn();
				}
				return;
			case " ":
				// Space = page down, advance to next message at end
				var scrolled = this._scrollBodyDown(true);
				if (!scrolled) {
					this._nextMessage();
				}
				return;
			case "l":
				this._jumpToLast();
				return;
			case "r":
				// Launch reply editor
				this._launchReply();
				return;
			case "t":
				if (this._threadMode === "standard") {
					this._switchToThreaded();
				}
				return;
			case "f":
				if (this._threadMode === "standard" && this._viewMode === "threaded") {
					this._switchToFlat();
				}
				return;
			case "]":
				this._nextThread();
				return;
			case "[":
				this._prevThread();
				return;
		}
	}

	async _launchReply() {
		if (!this.call) return;
		var editorMod = await getEditorMod();
		if (!editorMod || !editorMod.msgEditor) {
			if (this.dumb) {
				this.call.cmds.senddata("\r\n  Reply editor not available.\r\n");
			} else {
				this.call.cmds.movecursor(1, this._statusRow);
				this.call.cmds.cleartoeol();
				this.call.cmds.setfgcolor(CLR_ERROR);
				this.call.cmds.senddata(" Reply editor not available.");
				this.call.cmds.resetcolors();
			}
			return;
		}

		var currentMsg = this._messages[this._msgIdx] || null;
		var threadUUID = null;

		// Resolve thread UUID for the reply
		if (this._viewMode === "threaded" && this._filteredThreads[this._threadCursor]) {
			threadUUID = this._filteredThreads[this._threadCursor].uuid;
		} else if (currentMsg && currentMsg.thread_id) {
			// In flat mode, need to look up the thread UUID from the thread_id
			// For now, pass null — saveMessage handles threaduuid=null as new thread
			// This is a known limitation until we add a getThreadById lookup
			threadUUID = null;
		}

		var editor = new editorMod.msgEditor(this.call, {
			mode: "reply",
			shortcode: this._areaShortcode,
			threadUUID: threadUUID,
			replyToMsg: currentMsg,
		});

		// The editor is a sub-module — we run it and redraw when it returns
		this._editorActive = true;
		this._activeEditor = editor;

		editor.emitter.on("ModuleReturn", () => {
			this._editorActive = false;
			this._activeEditor = null;
			try { editor.clearHandler(); } catch (_) {}
			if (!this.active || !this.call) return;
			// Redraw the current state
			if (this._state === STATE.MESSAGE_VIEW) {
				this._drawMessageScreen();
			} else {
				this._drawThreadListScreen();
			}
		});

		editor.emitter.on("HangupSignal", () => {
			this._editorActive = false;
			this._activeEditor = null;
			try { editor.clearHandler(); } catch (_) {}
			this.signalHangup();
		});

		editor.startStage();
	}

	// ===========================================================================
	// DUMB TERMINAL FALLBACK
	// ===========================================================================

	_drawThreadListDumb() {
		this.call.cmds.senddata("\r\n\r\n  " + this._areaName + " — Threads\r\n\r\n");
		for (var i = 0; i < this._filteredThreads.length; i++) {
			var t = this._filteredThreads[i];
			var unread = this._threadUnreads[t.id] || 0;
			var line = "  " + (i + 1) + ") " + (t.subject || "(no subject)");
			line += " [" + (t.message_count || 0) + " msgs";
			if (unread > 0) line += ", " + unread + " new";
			line += "] " + this._formatShortDate(t.last_message);
			this.call.cmds.senddata(line + "\r\n");
		}
		this.call.cmds.senddata("\r\n  Enter #, F=Flat, Q=Quit: ");
		this._dumbMode = "threadlist";
		this._dumbBuf = "";
	}

	_drawMessageDumb() {
		if (this._messages.length === 0) {
			this.call.cmds.senddata("\r\n  No messages.\r\n");
			return;
		}
		var msg = this._messages[this._msgIdx];
		this.call.cmds.senddata("\r\n");
		this.call.cmds.senddata("  From: " + (msg.from_user || "") + "\r\n");
		this.call.cmds.senddata("    To: " + (msg.to_user || "All") + "\r\n");
		this.call.cmds.senddata("  Subj: " + (msg.subject || "") + "\r\n");
		this.call.cmds.senddata("  Date: " + this._formatFullDate(msg.system_time) + "\r\n");
		this.call.cmds.senddata("  ─────────────────\r\n");

		var rawText = msg.utf8 || msg.body_text || "";
		rawText = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		var lines = rawText.split("\n");
		this._dumbPageLines = 0;
		for (var i = 0; i < lines.length; i++) {
			this.call.cmds.senddata("  " + lines[i] + "\r\n");
			this._dumbPageLines++;
			if (this._dumbPageLines >= this._termH - 4) {
				this.call.cmds.senddata("  [More - Enter] ");
				this._dumbMode = "more";
				this._dumbMoreLines = lines.slice(i + 1);
				return;
			}
		}
		this.call.cmds.senddata("\r\n  Msg " + (this._msgIdx + 1) + "/" + this._messages.length);
		this.call.cmds.senddata("\r\n  [Right=Next, Left=Prev, L=Last, Q=Quit]: ");
		this._dumbMode = "msgprompt";
		this._dumbBuf = "";
		this._advancePointers(msg);
	}

	_handleDumbInput(inputArray) {
		for (var i = 0; i < inputArray.length; i++) {
			if (!this.active) return;
			var token = inputArray[i];

			if (this._dumbMode === "more") {
				// Any key continues
				this._dumbContinueMore();
				return;
			}

			if (token.startsWith("KEY_")) {
				var key = token.slice(4);
				this._onKeyDumb(key);
			} else if (token.startsWith("CHAR_")) {
				var ch = token.slice(5);
				this._onCharDumb(ch);
			}
		}
	}

	_dumbContinueMore() {
		if (!this._dumbMoreLines || this._dumbMoreLines.length === 0) {
			var msg = this._messages[this._msgIdx];
			this.call.cmds.senddata("\r\n  Msg " + (this._msgIdx + 1) + "/" + this._messages.length);
			this.call.cmds.senddata("\r\n  [Right=Next, Left=Prev, L=Last, Q=Quit]: ");
			this._dumbMode = "msgprompt";
			this._advancePointers(msg);
			return;
		}
		this._dumbPageLines = 0;
		var remaining = this._dumbMoreLines;
		this._dumbMoreLines = null;
		for (var i = 0; i < remaining.length; i++) {
			this.call.cmds.senddata("  " + remaining[i] + "\r\n");
			this._dumbPageLines++;
			if (this._dumbPageLines >= this._termH - 4 && i < remaining.length - 1) {
				this.call.cmds.senddata("  [More - Enter] ");
				this._dumbMode = "more";
				this._dumbMoreLines = remaining.slice(i + 1);
				return;
			}
		}
		var msg = this._messages[this._msgIdx];
		this.call.cmds.senddata("\r\n  Msg " + (this._msgIdx + 1) + "/" + this._messages.length);
		this.call.cmds.senddata("\r\n  [Right=Next, Left=Prev, L=Last, Q=Quit]: ");
		this._dumbMode = "msgprompt";
		this._advancePointers(msg);
	}

	_onKeyDumb(key) {
		if (this._dumbMode === "threadlist") {
			switch (key) {
				case "Enter":
					if (this._dumbBuf.length > 0) this._dumbSelectThread();
					return;
				case "ESC":
					this.signalReturn();
					return;
			}
		} else if (this._dumbMode === "msgprompt") {
			switch (key) {
				case "RightArrow":
				case "Enter":
					if (this._msgIdx < this._messages.length - 1) {
						this._msgIdx++;
						this._drawMessageDumb();
					} else {
						this.call.cmds.senddata("\r\n  End of messages.\r\n");
						if (this._threadMode === "standard") {
							this._drawThreadListDumb();
						} else {
							this.signalReturn();
						}
					}
					return;
				case "LeftArrow":
					if (this._msgIdx > 0) {
						this._msgIdx--;
						this._drawMessageDumb();
					}
					return;
				case "ESC":
					if (this._threadMode === "standard") {
						this._drawThreadListDumb();
					} else {
						this.signalReturn();
					}
					return;
			}
		}
	}

	_onCharDumb(ch) {
		var lower = ch.toLowerCase();
		if (this._dumbMode === "threadlist") {
			if (/[0-9]/.test(ch)) {
				this._dumbBuf += ch;
				this.call.cmds.senddata(ch);
			} else if (lower === "q") {
				this.signalReturn();
			} else if (lower === "f") {
				this._loadMessagesFlat().then(() => {
					if (!this.active) return;
					this._drawMessageDumb();
				});
			}
		} else if (this._dumbMode === "msgprompt") {
			if (lower === "q") {
				if (this._threadMode === "standard") {
					this._drawThreadListDumb();
				} else {
					this.signalReturn();
				}
			} else if (lower === "l") {
				this._msgIdx = this._messages.length - 1;
				this._drawMessageDumb();
			}
		}
	}

	_dumbSelectThread() {
		var num = parseInt(this._dumbBuf);
		this._dumbBuf = "";
		if (isNaN(num) || num < 1 || num > this._filteredThreads.length) {
			this.call.cmds.senddata("\r\n  Invalid.\r\n  Enter #, F=Flat, Q=Quit: ");
			return;
		}
		var thread = this._filteredThreads[num - 1];
		this._threadCursor = num - 1;
		this._loadMessagesForThread(thread.id).then(() => {
			if (!this.active) return;
			this._drawMessageDumb();
		});
	}

	// ===========================================================================
	// INPUT DISPATCH (override BaseSubModule)
	// ===========================================================================

	handleInput(inputArray) {
		if (!this.active) return;
		// Route to editor if it's running
		if (this._editorActive && this._activeEditor) {
			this._activeEditor.handleInput(inputArray);
			return;
		}
		if (this.dumb) {
			this._handleDumbInput(inputArray);
			return;
		}
		// Use default dispatch (onKey/onChar/onCmd)
		super.handleInput(inputArray);
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

		this._loadAreaConfig()
			.then(ok => {
				if (!this.active) return;
				if (!ok) {
					if (this.dumb) {
						this.call.cmds.senddata("\r\n  Could not load area config.\r\n");
					}
					setTimeout(() => { if (this.active) this.signalReturn(); }, 1000);
					return;
				}

				if (this._threadMode === "no_threads") {
					return this._loadMessagesFlat().then(() => {
						if (!this.active) return;
						this._setState(STATE.MESSAGE_VIEW);
					});
				} else {
					return this._loadThreadList().then(() => {
						if (!this.active) return;
						this._setState(STATE.THREAD_LIST);
					});
				}
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
		this._threads = [];
		this._filteredThreads = [];
		this._messages = [];
		this._bodyLines = [];
		this._threadUnreads = {};
		this._areaConfig = null;
		super.clearHandler();
	}
}

export { msgReader };
