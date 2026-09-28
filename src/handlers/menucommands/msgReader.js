import { BaseSubModule } from "../basesubmodule.js";
import { getRecentThreadsForArea, getThreadsPage, getThreadCount,
	getMessages, getMessageCount, countMessagesBefore, getMessage,
	moderationForArea, attachModeration, buildMoveTargets, threadOriginSummary,
	moderationFor, deleteMessageByUUID, deleteThreadByUUID,
	moveMessageToArea, moveThreadToArea } from "../../models/messages.js";
import { getAreaByShortcode } from "../../models/msgAreas.js";
import * as alogger from "../../utils/alogger.js";

// Lazy-import pointer module (may not be available in all deployments)
var _pointerMod = null;
async function getPointerMod() {
	if (!_pointerMod) {
		try {
			_pointerMod = await import("../../models/userMsgPointers.js");
		} catch (err) {
			alogger.writeAlog(3, "MsgReader: pointer module load failed: " + (err?.message || err), "redbright");
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

// Lazy-import area selector module
var _selectorMod = null;
async function getSelectorMod() {
	if (!_selectorMod) {
		try {
			_selectorMod = await import("./msgAreaSelector.js");
		} catch (_) {
			_selectorMod = null;
		}
	}
	return _selectorMod;
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
	LOADING: 0,
	THREAD_LIST: 1,
	MESSAGE_VIEW: 2,
	MODERATE: 3,
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
const CLR_HDR_LABEL = 6;     // Header labels + colons + "of" — cyan
const CLR_HDR_FROM = 10;     // From field — bright green (default)
const CLR_HDR_FROM_ME = 11;  // From field when matches user — bright yellow
const CLR_HDR_TO = 10;       // To field — bright green (default)
const CLR_HDR_TO_ME = 11;    // To field when matches user or "All" — bright yellow
const CLR_HDR_SUBJ = 3;      // Subject — yellow (dark)
const CLR_HDR_AREA = 5;      // Area — magenta
const CLR_HDR_DATE = 10;     // Date/Time — bright green
const CLR_HDR_MODE = 3;      // Mode — yellow (dark)
const CLR_HDR_MSG = 11;      // Msg position — bright yellow
const CLR_STATUS = 8;
const CLR_NAV = 11;
const CLR_NAV_LABEL = 7;
const CLR_ERROR = 9;
const CLR_SEPARATOR = 4;       // Blue separator lines
const CLR_SCROLL_IND = 11;    // Yellow scroll indicator block
const CLR_COL_HEADER = 3;

// Default body semantic colors (overridable via theme)
const DF_CLR_BODY = 11;      // Normal text — bright yellow
const DF_CLR_QUOTE = 14;     // Quote lines — bright cyan
const DF_CLR_TEAR = 15;      // Tear lines — bright white
const DF_CLR_TAGLINE = 10;   // Tagline separator lines — bright green
const DF_CLR_ORIGIN = 12;    // Origin lines — bright blue

// CP437 safe glyphs (extended range only)
const CP437_HLINE  = 0xC4;
const CP437_CORNER = 0xDA;
const CP437_ARROW  = 0xAF;
const CP437_BULLET = 0xF9;

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const MONTHS_FULL = ["January","February","March","April","May","June",
	"July","August","September","October","November","December"];

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
		this._userId = null;
		if (call.user_record) {
			this._userId = call.user_record.id || call.user_record.user_id || null;
		}

		// Post permission — resolved after area config loads
		this._canPost = false;

		// Moderation. The area answer and the destination list come from the
		// model once per area; each message carries its own answer in
		// message.moderation. Nothing here decides policy.
		this._moderation = { enabled: false, targets: [] };
		this._modPrompt = null;   // active prompt: { text, hint, onChar, onKey }
		this._modPickIdx = 0;     // cursor within the destination list

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
		this._totalMsgCount = 0;      // Total messages in area
		this._threadMsgTotal = 0;     // Total messages in current thread
		this._msgOffset = 0;          // Messages before our loaded batch (for absolute position)

		// Body scroll state
		this._bodyLines = [];   // Array of { text, type, colorPrefix }
		this._bodyScroll = 0;
		this._fmtModRef = null; // Cached reference to termMsgFormat module

		// Body semantic colors (from theme, with defaults)
		var theme = call.theme || {};
		this._clrBody = theme.msg_body_clr !== undefined ? theme.msg_body_clr : DF_CLR_BODY;
		this._clrQuote = theme.msg_quote_clr !== undefined ? theme.msg_quote_clr : DF_CLR_QUOTE;
		this._clrTear = theme.msg_tear_clr !== undefined ? theme.msg_tear_clr : DF_CLR_TEAR;
		this._clrTagline = theme.msg_tagline_clr !== undefined ? theme.msg_tagline_clr : DF_CLR_TAGLINE;
		this._clrOrigin = theme.msg_origin_clr !== undefined ? theme.msg_origin_clr : DF_CLR_ORIGIN;

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

	// Nav bar helpers: hotkey in bright yellow, label in grey
	_navKey(key, label) {
		if (!this.call) return;
		this.call.cmds.setfgcolor(CLR_NAV);
		this.call.cmds.senddata(key);
		if (label) {
			this.call.cmds.setfgcolor(CLR_NAV_LABEL);
			this.call.cmds.senddata(" " + label);
		}
	}

	_navArrow(utf8Char, cp437Byte) {
		if (!this.call) return;
		this.call.cmds.setfgcolor(CLR_NAV);
		this._sendGlyph(utf8Char, cp437Byte);
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

	// "Today", "Yesterday", or "January 15, 2024"
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

	// "14:32" (24hr)
	_formatTimePart(date) {
		if (!date) return "";
		var d = new Date(date);
		if (isNaN(d.getTime())) return "";
		return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
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

	async _prepareBodyLines(msg) {
		var wrapWidth = this._bodyWidth - 2;
		if (wrapWidth < 20) wrapWidth = 20;

		var fmtMod = await getFmtMod();
		this._fmtModRef = fmtMod; // Stash for _sendBodyText to use
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
			// Fallback — no formatter available, basic display with body color
			var rawText = msg.body_text || "";
			rawText = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
			var lines = rawText.split("\n");
			this._bodyLines = [];
			// Build a basic color prefix from the body color setting
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
		this._canPost = this.call.user_record ? checkPostAccess(this.call.user_record, this._areaConfig) : false;
		await this._loadModeration();
		return true;
	}

	// Same question the web views ask, answered in the same place. Destinations
	// are resolved once when the area opens rather than per message.
	async _loadModeration() {
		this._moderation = { enabled: false, targets: [] };
		var user = this.call && this.call.user_record;
		if (!user || !this._areaConfig) return;

		try {
			var targets = await buildMoveTargets(user, this._areaShortcode, checkPostAccess);
			this._moderation = moderationForArea(user, this._areaConfig, targets);
		} catch (err) {
			alogger.writeAlog(3, this.loggingId + " moderation load failed: " +
				(err?.message || err), "redbright");
		}
	}

	// Called after any load that replaces this._messages.
	_decorateMessages() {
		if (!this._areaConfig) return;
		attachModeration(this.call && this.call.user_record, this._areaConfig,
			this._messages, this._moderation.targets);
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

		// Get thread total from the thread list data
		if (this._filteredThreads[this._threadCursor] &&
			this._filteredThreads[this._threadCursor].id === threadDbId) {
			this._threadMsgTotal = this._filteredThreads[this._threadCursor].message_count || 0;
		} else {
			this._threadMsgTotal = 0;
		}

		// Find starting position from user's read pointer
		var startAfterId = 0;
		var allRead = false;
		if (this._userId) {
			var pm = await getPointerMod();
			if (pm.getFirstUnreadInThread) {
				try {
					var firstUnread = await pm.getFirstUnreadInThread(
						this._userId, this._areaShortcode, threadDbId
					);
					if (firstUnread > 0) {
						startAfterId = firstUnread - 1;
					} else {
						allRead = true;
					}
				} catch (err) {
					alogger.writeAlog(3, this.loggingId + " getFirstUnreadInThread error: " + (err?.message || err), "redbright");
				}
			}
		}

		if (allRead) {
			// Everything read — load the most recent batch, position at last message
			this._messages = await getMessages(this._areaShortcode, {
				threadId: threadDbId,
				limit: MSG_BATCH,
				order: "DESC"
			});
			this._messages.reverse();
			this._msgIdx = this._messages.length > 0 ? this._messages.length - 1 : 0;
		} else {
			this._messages = await getMessages(this._areaShortcode, {
				threadId: threadDbId,
				afterId: startAfterId > 0 ? startAfterId : undefined,
				limit: MSG_BATCH,
				order: "ASC"
			});
			if (this._messages.length === 0 && startAfterId > 0) {
				this._messages = await getMessages(this._areaShortcode, {
					threadId: threadDbId,
					limit: MSG_BATCH,
					order: "ASC"
				});
			}
			this._msgIdx = 0;
		}
		this._updateMessageBounds();

		// Compute absolute offset — how many messages exist before our batch
		this._msgOffset = 0;
		if (this._messages.length > 0 && this._oldestId) {
			try {
				this._msgOffset = await countMessagesBefore(
					this._areaShortcode, this._oldestId, threadDbId
				);
			} catch (_) {}
		}

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
		this._threadMsgTotal = 0;

		var startAfterId = 0;
		var allRead = false;
		if (this._userId) {
			var pm = await getPointerMod();
			if (pm.getFirstUnreadInArea) {
				try {
					var firstUnread = await pm.getFirstUnreadInArea(
						this._userId, this._areaShortcode
					);
					if (firstUnread > 0) {
						startAfterId = firstUnread - 1;
					} else {
						allRead = true;
					}
				} catch (err) {
					alogger.writeAlog(3, this.loggingId + " getFirstUnreadInArea error: " + (err?.message || err), "redbright");
				}
			}
		}

		if (allRead) {
			// Everything read — load the most recent batch, position at last message
			this._messages = await getMessages(this._areaShortcode, {
				limit: MSG_BATCH,
				order: "DESC"
			});
			this._messages.reverse();
			this._msgIdx = this._messages.length > 0 ? this._messages.length - 1 : 0;
		} else {
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
		}

		this._updateMessageBounds();
		await this._checkMessageBounds();
		this._totalMsgCount = await getMessageCount(this._areaShortcode);

		// Compute absolute offset
		this._msgOffset = 0;
		if (this._messages.length > 0 && this._oldestId) {
			try {
				this._msgOffset = await countMessagesBefore(
					this._areaShortcode, this._oldestId
				);
			} catch (_) {}
		}
	}

	_updateMessageBounds() {
		// Every path that replaces or extends this._messages ends here, so this
		// is where the moderation answer gets attached. Doing it at each load
		// site instead is how a newly added one ends up undecorated.
		this._decorateMessages();

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
		this._msgOffset = Math.max(0, this._msgOffset - older.length);
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
			alogger.writeAlog(3, this.loggingId + " pointer advance error: " + (err?.stack || err), "redbright");
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
			case STATE.MODERATE:
				this._drawModPrompt();
				break;
		}
	}

	async _showCurrentMessage() {
		if (this._msgIdx < 0 || this._msgIdx >= this._messages.length) return;
		var msg = this._messages[this._msgIdx];
		await this._prepareBodyLines(msg);
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
		this.call.cmds.senddata(" ");
		this._navKey("Enter", "Read");
		this.call.cmds.senddata("  ");
		this._navKey("F", "Flat View");
		this.call.cmds.senddata("  ");
		this._navKey("S", "Search");
		this.call.cmds.senddata("  ");
		this._navKey("M", "Mark Read");
		this.call.cmds.senddata("  ");
		this._navKey("J", "Jump");
		this.call.cmds.senddata("  ");
		this._navKey("Q", "Back");
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
		this._drawBodyViewport();
		this._drawSeparator();
		this._drawMessageNavBar();

		this.call.cmds.resetcolors();
	}

	_drawMessageHeader(msg) {
		if (this.dumb) return;
		var datePart = this._formatDatePart(msg.system_time);
		var timePart = this._formatTimePart(msg.system_time);
		var modeStr = (this._viewMode === "threaded") ? "Threaded" : "Flat";
		var absPos = this._msgOffset + this._msgIdx + 1;
		var total = (this._viewMode === "threaded" && this._threadMsgTotal > 0)
			? this._threadMsgTotal
			: (this._totalMsgCount || this._messages.length);
		var msgVal = absPos + " of " + total;

		// Determine from/to colors — highlight if matches current user
		var fromVal = msg.from_user || "";
		var toVal = msg.to_user || "All";
		var fromClr = CLR_HDR_FROM;
		var toClr = CLR_HDR_TO;
		var uname = (this.call.caller_username || "").toLowerCase();
		var rname = (this.call.caller_fullname || "").toLowerCase();
		if (uname && (fromVal.toLowerCase() === uname || fromVal.toLowerCase() === rname)) {
			fromClr = CLR_HDR_FROM_ME;
		}
		if (toVal.toLowerCase() === "all" ||
			(uname && (toVal.toLowerCase() === uname || toVal.toLowerCase() === rname))) {
			toClr = CLR_HDR_TO_ME;
		}

		// Left column: [label, value, valueColor]
		var leftItems = [
			["From", fromVal, fromClr],
			["To", toVal, toClr],
			["Subj", msg.subject || "", CLR_HDR_SUBJ],
			["Area", this._areaName || "", CLR_HDR_AREA],
		];

		// Right column: [label, value, valueColor, parts?]
		// parts is an optional array of {text, color} for multi-colored values
		var rightItems = [
			["Date", datePart, CLR_HDR_DATE],
			["Time", timePart, CLR_HDR_DATE],
			["Mode", modeStr, CLR_HDR_MODE],
			["Msg", msgVal, CLR_HDR_MSG, [
				{ text: String(absPos), color: CLR_HDR_MSG },
				{ text: " of ", color: CLR_HDR_LABEL },
				{ text: String(total), color: CLR_HDR_MSG },
			]],
		];

		// Pad labels within each column so colons align
		var leftLabelLen = 0;
		for (var i = 0; i < leftItems.length; i++) {
			if (leftItems[i][0].length > leftLabelLen) leftLabelLen = leftItems[i][0].length;
		}
		var rightLabelLen = 0;
		for (var i = 0; i < rightItems.length; i++) {
			if (rightItems[i][0].length > rightLabelLen) rightLabelLen = rightItems[i][0].length;
		}

		// Find max right-column width to compute start position
		// Format: "Label : Value" where label is padded
		var maxRightLen = 0;
		for (var i = 0; i < rightItems.length; i++) {
			var len = rightLabelLen + 3 + rightItems[i][1].length; // "Label : Value"
			if (len > maxRightLen) maxRightLen = len;
		}

		var rightX = this._termW - maxRightLen;
		if (rightX < 30) rightX = 30;

		// Left column value max length: gap between left label end and right column start
		var leftPrefixLen = 1 + leftLabelLen + 3; // " Label : "
		var leftValMax = rightX - leftPrefixLen - 2; // 2 char gap
		if (leftValMax < 10) leftValMax = 10;

		// Draw all 4 rows
		for (var row = 0; row < 4; row++) {
			var screenRow = row + 1;
			this.call.cmds.movecursor(1, screenRow);
			this.call.cmds.cleartoeol();

			// Left side
			var lItem = leftItems[row];
			var lLabel = this._padRight(lItem[0], leftLabelLen);
			this.call.cmds.setfgcolor(CLR_HDR_LABEL);
			this.call.cmds.senddata(" " + lLabel + " : ");
			this.call.cmds.setfgcolor(lItem[2]);
			this.call.cmds.senddata(this._truncate(lItem[1], leftValMax));

			// Right side
			var rItem = rightItems[row];
			var rLabel = this._padRight(rItem[0], rightLabelLen);
			this.call.cmds.movecursor(rightX, screenRow);
			this.call.cmds.setfgcolor(CLR_HDR_LABEL);
			this.call.cmds.senddata(rLabel + " : ");
			if (rItem[3]) {
				// Multi-colored value — render each part
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

	// Draw a horizontal separator line with scroll indicator box at right end
	// Format: ─────────────────────────────────────────────────────────[█]─
	// The box contains a yellow block when hasMore is true, empty space when false
	_drawSepLine(row, hasMore) {
		if (this.dumb) return;
		this.call.cmds.movecursor(1, row);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(CLR_SEPARATOR);

		// Draw line chars up to the bracket position
		var lineCount = this._termW - 5; // room for [X]─ at end
		for (var i = 0; i < lineCount; i++) {
			this._sendGlyph("\u2500", CP437_HLINE);
		}

		// Draw [indicator]─
		this.call.cmds.senddata("[");
		if (hasMore) {
			this.call.cmds.setfgcolor(CLR_SCROLL_IND);
			this._sendGlyph("\u25A0", 0xFE);
			this.call.cmds.setfgcolor(CLR_SEPARATOR);
		} else {
			this.call.cmds.senddata(" ");
		}
		this.call.cmds.senddata("]");
		this._sendGlyph("\u2500", CP437_HLINE);
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

			if (lineIdx >= this._bodyLines.length) continue;

			var lineObj = this._bodyLines[lineIdx];
			var text = lineObj.text || "";
			var prefix = lineObj.colorPrefix || "";

			// Reset colors before each line to prevent bleed from previous line's codes
			this.call.cmds.resetcolors();
			this.call.cmds.movecursor(margin, screenY);

			// Send semantic color prefix (pure ASCII ANSI SGR — safe for any encoding)
			if (prefix) {
				this.call.cmds.senddata(prefix);
			}

			// Send line content with encoding conversion
			this.call.cmds.senddata(" ");
			this._sendBodyText(text);
		}
		this.call.cmds.resetcolors();
	}

	// Send message body text with correct encoding.
	// For UTF-8 terminals: send as-is (string → Buffer.from encodes as UTF-8).
	// For CP437 terminals: convert Unicode chars to CP437 bytes so box drawing
	// and accented characters display correctly instead of as UTF-8 garbage.
	_sendBodyText(text) {
		if (!this.call || !text) return;
		if (this._isUTF8) {
			this.call.cmds.senddata(text);
		} else if (this._fmtModRef && this._fmtModRef.convertUTF8toCP437) {
			this.call.cmds.senddata(this._fmtModRef.convertUTF8toCP437(text));
		} else {
			// No formatter — send as-is, may show garbled extended chars
			this.call.cmds.senddata(text);
		}
	}

	// Build absolute message position string for display
	_getMsgPositionStr() {
		var absPos = this._msgOffset + this._msgIdx + 1;
		if (this._viewMode === "threaded" && this._threadMsgTotal > 0) {
			return "Msg " + absPos + " of " + this._threadMsgTotal;
		}
		var total = this._totalMsgCount || this._messages.length;
		return "Msg " + absPos + " of " + total;
	}

	_drawMessageNavBar() {
		if (this.dumb) return;
		this.call.cmds.movecursor(1, this._navRow);
		this.call.cmds.cleartoeol();
		this.call.cmds.senddata(" ");
		this._navArrow("\u2190", 0x3C);  // ← or <
		this.call.cmds.senddata("  ");
		this._navArrow("\u2192", 0x3E);  // → or >
		this.call.cmds.senddata("  ");
		if (this._canPost) {
			this._navKey("R", "Reply");
			this.call.cmds.senddata("  ");
		}
		// Read off the message on screen, not worked out here.
		var mod = (this._currentMessage() || {}).moderation;
		if (mod && mod.canDelete) {
			this._navKey("D", "Del");
			this.call.cmds.senddata("  ");
		}
		if (mod && mod.canMove) {
			this._navKey("M", "Move");
			this.call.cmds.senddata("  ");
		}
		this._navKey("L", "Last");

		if (this._viewMode === "threaded") {
			this.call.cmds.senddata("  ");
			this._navKey("[", "PrevThd");
			this.call.cmds.senddata("  ");
			this._navKey("]", "NextThd");
		}

		if (this._threadMode === "standard") {
			this.call.cmds.senddata("  ");
			if (this._viewMode === "threaded") {
				this._navKey("F", "Flat");
			} else {
				this._navKey("T", "Threaded");
			}
		}

		this.call.cmds.senddata("  ");
		this._navKey("J", "Jump");
		this.call.cmds.senddata("  ");
		this._navKey("Q", "Quit");
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
		this._drawSeparator();
	}

	_scrollBodyDown(pages) {
		var amount = pages ? this._bodyViewHeight : 1;
		var maxScroll = Math.max(0, this._bodyLines.length - this._bodyViewHeight);
		if (this._bodyScroll >= maxScroll) return false; // signals "at bottom"
		this._bodyScroll = Math.min(maxScroll, this._bodyScroll + amount);
		this._drawBodyViewport();
		this._drawSeparator();
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
			}).catch(err => { alogger.writeAlog(3, "MsgReader catch: " + (err?.stack || err), "redbright"); });
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
			}).catch(err => { alogger.writeAlog(3, "MsgReader catch: " + (err?.stack || err), "redbright"); });
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
			})().catch(err => { alogger.writeAlog(3, "MsgReader catch: " + (err?.stack || err), "redbright"); });
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
		}).catch(err => { alogger.writeAlog(3, "MsgReader catch: " + (err?.stack || err), "redbright"); });
	}

	_prevThread() {
		if (this._viewMode !== "threaded") return;
		if (this._threadCursor <= 0) return;
		this._threadCursor--;
		var thread = this._filteredThreads[this._threadCursor];
		this._loadMessagesForThread(thread.id).then(() => {
			if (!this.active) return;
			this._setState(STATE.MESSAGE_VIEW);
		}).catch(err => { alogger.writeAlog(3, "MsgReader catch: " + (err?.stack || err), "redbright"); });
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
		}).catch(err => { alogger.writeAlog(3, "MsgReader catch: " + (err?.stack || err), "redbright"); });
	}

	_switchToThreaded() {
		if (this._threadMode !== "standard") return;
		this._setState(STATE.THREAD_LIST);
	}

	// ===========================================================================
	// INPUT HANDLING
	// ===========================================================================

	onKey(key) {
		if (this._state === STATE.MODERATE) {
			this._onKeyModerate(key);
		} else if (this._state === STATE.THREAD_LIST) {
			this._onKeyThreadList(key);
		} else if (this._state === STATE.MESSAGE_VIEW) {
			this._onKeyMessageView(key);
		}
	}

	onChar(ch) {
		if (this._state === STATE.MODERATE) {
			this._onCharModerate(ch);
		} else if (this._state === STATE.THREAD_LIST) {
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
			case "j":
				this._launchJump();
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
				// Launch reply editor (only if user has post access)
				if (this._canPost) {
					this._launchReply();
				}
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
			case "j":
				this._launchJump();
				return;
			case "d":
				this._beginDelete();
				return;
			case "m":
				this._beginMove();
				return;
		}
	}

	// ===========================================================================
	// MODERATION
	// ===========================================================================
	//
	// Delete and move for a moderator, matching the web views. What may be done
	// is read off message.moderation and this._moderation, both filled in by
	// messages.js, so the rules live in one place and the terminal cannot drift
	// from the browser.
	//
	// Prompts are data driven: one state, one draw, one dispatch. Everything is
	// confirmed, since none of it can be undone from here.

	_currentMessage() {
		if (this._msgIdx < 0 || this._msgIdx >= this._messages.length) return null;
		return this._messages[this._msgIdx];
	}

	_currentThread() {
		if (!this._currentThreadId) return null;
		for (var t of this._filteredThreads) {
			if (t.id === this._currentThreadId) return t;
		}
		return null;
	}

	// Thread level operations only make sense in a threaded view, and only when
	// the thread is actually on hand.
	_threadOpsAvailable() {
		return this._viewMode === "threaded" && !!this._currentThread();
	}

	_openModPrompt(prompt) {
		this._modPrompt = prompt;
		this._setState(STATE.MODERATE);
	}

	_closeModPrompt() {
		this._modPrompt = null;
		this._modPickIdx = 0;
		this._setState(STATE.MESSAGE_VIEW);
	}

	_modStatus(text, isError) {
		if (this.dumb) {
			this.call.cmds.senddata("\r\n  " + text + "\r\n");
			return;
		}
		this.call.cmds.movecursor(1, this._navRow);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(isError ? CLR_ERROR : CLR_NAV);
		this.call.cmds.senddata(" " + this._truncate(text, this._termW - 2));
		this.call.cmds.resetcolors();
	}

	_drawModPrompt() {
		var p = this._modPrompt;
		if (!p) return;

		if (this.dumb) {
			this.call.cmds.senddata("\r\n  " + p.text + "\r\n");
			if (p.list) {
				for (var d = 0; d < p.list.length; d++) {
					this.call.cmds.senddata("  " + (d + 1) + ") " + p.list[d].label + "\r\n");
				}
			}
			if (p.hint) this.call.cmds.senddata("  " + p.hint + "\r\n");
			return;
		}

		// A destination list needs room, so it takes over the body viewport.
		// A plain question only needs the nav row.
		if (p.list) {
			this.call.cmds.clearscreen();
			this.call.cmds.movecursor(2, 2);
			this.call.cmds.setfgcolor(CLR_TITLE);
			this.call.cmds.senddata(this._truncate(p.text, this._termW - 3));
			this.call.cmds.resetcolors();

			var rows = Math.max(1, this._bodyViewEnd - this._bodyViewStart + 1);
			var first = Math.max(0, Math.min(this._modPickIdx - Math.floor(rows / 2),
				p.list.length - rows));
			if (first < 0) first = 0;

			for (var i = 0; i < rows && (first + i) < p.list.length; i++) {
				var idx = first + i;
				var sel = (idx === this._modPickIdx);
				this.call.cmds.movecursor(2, this._bodyViewStart + i);
				this.call.cmds.cleartoeol();
				if (sel) {
					this.call.cmds.setbgcolor(CLR_BAR_BG);
					this.call.cmds.setfgcolor(CLR_BAR_FG);
				} else {
					this.call.cmds.setfgcolor(CLR_THREAD);
				}
				this.call.cmds.senddata(this._padRight(
					(sel ? "> " : "  ") + p.list[idx].label, this._termW - 4));
				this.call.cmds.resetcolors();
			}
		}

		this.call.cmds.movecursor(1, this._navRow);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(CLR_NAV);
		this.call.cmds.senddata(" " + this._truncate(
			p.list ? (p.hint || "") : (p.text + "  " + (p.hint || "")), this._termW - 2));
		this.call.cmds.resetcolors();
	}

	// --- entry points from the message view ---

	_beginDelete() {
		var msg = this._currentMessage();
		if (!msg || !msg.moderation || !msg.moderation.canDelete) return;

		if (this._threadOpsAvailable()) {
			this._openModPrompt({
				text: "Delete (M)essage or the whole (T)hread?",
				hint: "Esc cancels",
				onChar: (ch) => {
					var c = ch.toLowerCase();
					if (c === "m") return this._confirmDeleteMessage();
					if (c === "t") return this._confirmDeleteThread();
					if (c === "n" || c === "q") return this._closeModPrompt();
				}
			});
			return;
		}
		this._confirmDeleteMessage();
	}

	_confirmDeleteMessage() {
		var msg = this._currentMessage();
		if (!msg) return this._closeModPrompt();
		this._openModPrompt({
			text: "Delete the message from " + (msg.from_user || "this user") + "?",
			hint: "(Y/N)  Local only: peers keep what they already have",
			onChar: (ch) => {
				var c = ch.toLowerCase();
				if (c === "y") return this._doDeleteMessage(msg);
				if (c === "n" || c === "q") return this._closeModPrompt();
			}
		});
	}

	_confirmDeleteThread() {
		var thread = this._currentThread();
		if (!thread) return this._closeModPrompt();
		this._openModPrompt({
			text: "Delete \"" + this._truncate(thread.subject || "this thread", 40) +
				"\" and every message in it?",
			hint: "(Y/N)  Local only: peers keep what they already have",
			onChar: (ch) => {
				var c = ch.toLowerCase();
				if (c === "y") return this._doDeleteThread(thread);
				if (c === "n" || c === "q") return this._closeModPrompt();
			}
		});
	}

	_beginMove() {
		var msg = this._currentMessage();
		if (!msg || !msg.moderation || !msg.moderation.canMove) return;

		if (this._threadOpsAvailable()) {
			this._openModPrompt({
				text: "Move (M)essage or the whole (T)hread?",
				hint: "Esc cancels",
				onChar: (ch) => {
					var c = ch.toLowerCase();
					if (c === "m") return this._pickDestinationForMessage(msg);
					if (c === "t") return this._pickDestinationForThread();
					if (c === "n" || c === "q") return this._closeModPrompt();
				}
			});
			return;
		}
		this._pickDestinationForMessage(msg);
	}

	_pickDestination(text, targets, onPick) {
		if (!targets || targets.length === 0) {
			this._closeModPrompt();
			this._modStatus("Nothing to move it to.", true);
			return;
		}
		this._modPickIdx = 0;
		this._openModPrompt({
			text: text,
			hint: "Up/Down to choose, Enter to move, Esc to cancel",
			list: targets.map(function (t) {
				return {
					label: (t.group_shortcode ? t.group_shortcode + " / " : "") + t.name +
						(t.networked ? "  (networked)" : ""),
					target: t
				};
			}),
			onKey: (key) => {
				var p = this._modPrompt;
				if (!p) return;
				if (key === "UpArrow") {
					this._modPickIdx = Math.max(0, this._modPickIdx - 1);
					this._drawModPrompt();
				} else if (key === "DownArrow") {
					this._modPickIdx = Math.min(p.list.length - 1, this._modPickIdx + 1);
					this._drawModPrompt();
				} else if (key === "PgUp") {
					this._modPickIdx = 0;
					this._drawModPrompt();
				} else if (key === "PgDn") {
					this._modPickIdx = p.list.length - 1;
					this._drawModPrompt();
				} else if (key === "Enter") {
					onPick(p.list[this._modPickIdx].target);
				}
			},
			// Dumb terminals get a numbered list, so accept digits there.
			onChar: (ch) => {
				var p = this._modPrompt;
				if (!p) return;
				if (ch === "\r" || ch === "\n") return onPick(p.list[this._modPickIdx].target);
				var n = parseInt(ch, 10);
				if (!isNaN(n) && n >= 1 && n <= p.list.length) {
					this._modPickIdx = n - 1;
					return onPick(p.list[n - 1].target);
				}
				if (ch.toLowerCase() === "q") this._closeModPrompt();
			}
		});
	}

	// A message carries its own usable destinations; the model has already
	// dropped the ones its origin forbids.
	_pickDestinationForMessage(msg) {
		this._pickDestination("Move the message from " + (msg.from_user || "this user") + " to:",
			msg.moderation.targets, (target) => this._doMoveMessage(msg, target));
	}

	// A thread is as restricted as its most restricted message, so its own
	// answer has to be asked for rather than borrowed from the message on screen.
	async _pickDestinationForThread() {
		var thread = this._currentThread();
		if (!thread) return this._closeModPrompt();

		var mod;
		try {
			var origin = await threadOriginSummary(thread.uuid, this._areaShortcode);
			thread.anyFromNetwork = !!(origin && origin.anyFromNetwork);
			mod = moderationFor(this.call.user_record, this._areaConfig, thread,
				this._moderation.targets);
		} catch (err) {
			alogger.writeAlog(3, this.loggingId + " thread origin lookup failed: " +
				(err?.message || err), "redbright");
			this._closeModPrompt();
			this._modStatus("Could not check where that thread came from.", true);
			return;
		}
		if (!this.active) return;

		if (!mod.canMove) {
			this._closeModPrompt();
			this._modStatus("Part of that thread came from a network, so it can only " +
				"go to a local area, and there is none you can post to.", true);
			return;
		}
		this._pickDestination("Move \"" + this._truncate(thread.subject || "this thread", 30) +
			"\" to:", mod.targets, (target) => this._doMoveThread(thread, target));
	}

	// --- the actions themselves ---

	async _doDeleteMessage(msg) {
		this._closeModPrompt();
		try {
			var result = await deleteMessageByUUID(msg.uuid, this._areaShortcode);
			if (!this.active) return;
			if (!result || !result.status) {
				this._modStatus("Could not delete that message.", true);
				return;
			}
			alogger.writeAlog(2, "Moderation: " + (this.call.user_record.username || "?") +
				" deleted a message in " + this._areaShortcode + " from the terminal", "yellowbright");
			await this._reloadAfterModeration("Message deleted.");
		} catch (err) {
			alogger.writeAlog(3, this.loggingId + " delete failed: " + (err?.stack || err), "redbright");
			if (this.active) this._modStatus("Could not delete that message.", true);
		}
	}

	async _doDeleteThread(thread) {
		this._closeModPrompt();
		try {
			var result = await deleteThreadByUUID(thread.uuid, this._areaShortcode);
			if (!this.active) return;
			if (!result || !result.status) {
				this._modStatus("Could not delete that thread.", true);
				return;
			}
			alogger.writeAlog(2, "Moderation: " + (this.call.user_record.username || "?") +
				" deleted a thread in " + this._areaShortcode + " from the terminal", "yellowbright");
			// The thread is gone, so there is nothing to return to.
			this._currentThreadId = null;
			this._messages = [];
			await this._loadThreadList();
			if (this.active) this._setState(STATE.THREAD_LIST);
		} catch (err) {
			alogger.writeAlog(3, this.loggingId + " thread delete failed: " + (err?.stack || err), "redbright");
			if (this.active) this._modStatus("Could not delete that thread.", true);
		}
	}

	async _doMoveMessage(msg, target) {
		this._closeModPrompt();
		try {
			var result = await moveMessageToArea(msg.uuid, this._areaShortcode, target.shortcode);
			if (!this.active) return;
			if (!result || !result.status) {
				this._modStatus("Could not move that message: " +
					((result && result.errormessages) || []).join(", "), true);
				return;
			}
			alogger.writeAlog(2, "Moderation: " + (this.call.user_record.username || "?") +
				" moved a message from " + this._areaShortcode + " to " + target.shortcode +
				" from the terminal", "yellowbright");
			await this._reloadAfterModeration("Moved to " + target.name + ".");
		} catch (err) {
			alogger.writeAlog(3, this.loggingId + " move failed: " + (err?.stack || err), "redbright");
			if (this.active) this._modStatus("Could not move that message.", true);
		}
	}

	async _doMoveThread(thread, target) {
		this._closeModPrompt();
		try {
			var result = await moveThreadToArea(thread.uuid, this._areaShortcode, target.shortcode);
			if (!this.active) return;
			if (!result || !result.status) {
				this._modStatus("Could not move that thread: " +
					((result && result.errormessages) || []).join(", "), true);
				return;
			}
			alogger.writeAlog(2, "Moderation: " + (this.call.user_record.username || "?") +
				" moved a thread from " + this._areaShortcode + " to " + target.shortcode +
				" from the terminal (" + result.moved + " message(s))", "yellowbright");
			this._currentThreadId = null;
			this._messages = [];
			await this._loadThreadList();
			if (this.active) {
				this._setState(STATE.THREAD_LIST);
				this._modStatus("Thread moved to " + target.name + ".");
			}
		} catch (err) {
			alogger.writeAlog(3, this.loggingId + " thread move failed: " + (err?.stack || err), "redbright");
			if (this.active) this._modStatus("Could not move that thread.", true);
		}
	}

	// After a message goes, the batch on screen is stale. Reload the same view
	// and keep the cursor near where it was rather than snapping to the top.
	async _reloadAfterModeration(note) {
		var wasIdx = this._msgIdx;
		if (this._currentThreadId) {
			await this._loadMessagesForThread(this._currentThreadId);
		} else {
			await this._loadMessagesFlat();
		}
		if (!this.active) return;

		if (this._messages.length === 0) {
			// The last message went with it, so the thread did too.
			if (this._viewMode === "threaded" || this._threadMode === "standard") {
				this._currentThreadId = null;
				await this._loadThreadList();
				if (this.active) this._setState(STATE.THREAD_LIST);
				return;
			}
			this._setState(STATE.MESSAGE_VIEW);
			return;
		}

		this._msgIdx = Math.max(0, Math.min(wasIdx, this._messages.length - 1));
		this._setState(STATE.MESSAGE_VIEW);
		this._modStatus(note);
	}

	// What the dumb prompt line should offer, read off the message on screen.
	_dumbModKeys() {
		var mod = (this._currentMessage() || {}).moderation;
		var out = "";
		if (mod && mod.canDelete) out += ", D=Delete";
		if (mod && mod.canMove) out += ", M=Move";
		return out;
	}

	_onKeyModerate(key) {
		if (key === "ESC") return this._closeModPrompt();
		if (this._modPrompt && this._modPrompt.onKey) this._modPrompt.onKey(key);
	}

	_onCharModerate(ch) {
		if (this._modPrompt && this._modPrompt.onChar) this._modPrompt.onChar(ch);
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

	async _launchJump() {
		if (!this.call) return;
		var selMod = await getSelectorMod();
		if (!selMod || !selMod.msgAreaSelector) {
			return;
		}

		var selector = new selMod.msgAreaSelector(this.call);
		this._editorActive = true;
		this._activeEditor = selector;

		selector.emitter.on("ModuleReturn", () => {
			this._editorActive = false;
			this._activeEditor = null;
			try { selector.clearHandler(); } catch (_) {}
			if (!this.active || !this.call) return;

			// Check if the user changed area
			var newShortcode = this.call.msg_area || "";
			if (newShortcode && newShortcode !== this._areaShortcode) {
				// Area changed — reload everything
				this._areaShortcode = newShortcode;
				this._areaName = this.call.msg_area_title || newShortcode;
				this._threads = [];
				this._filteredThreads = [];
				this._messages = [];
				this._bodyLines = [];
				this._threadUnreads = {};
				this._threadCursor = 0;
				this._threadScroll = 0;
				this._msgIdx = 0;

				this._loadAreaConfig()
					.then(ok => {
						if (!this.active || !ok) return;
						if (this._threadMode === "no_threads") {
							return this._loadMessagesFlat().then(() => {
								if (this.active) this._setState(STATE.MESSAGE_VIEW);
							});
						} else {
							return this._loadThreadList().then(() => {
								if (this.active) this._setState(STATE.THREAD_LIST);
							});
						}
					})
					.catch(err => {
						alogger.writeAlog(3, this.loggingId + " jump reload error: " + (err?.stack || err), "redbright");
						if (this.active) this.signalReturn();
					});
			} else {
				// Same area — just redraw current state
				if (this._state === STATE.MESSAGE_VIEW) {
					this._drawMessageScreen();
				} else {
					this._drawThreadListScreen();
				}
			}
		});

		selector.emitter.on("HangupSignal", () => {
			this._editorActive = false;
			this._activeEditor = null;
			try { selector.clearHandler(); } catch (_) {}
			this.signalHangup();
		});

		selector.startStage();
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

	async _drawMessageDumb() {
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
		this.call.cmds.senddata("  -------------------\r\n");

		// body_text is canonical Unicode for every source (migration 0006).
		var rawText = msg.body_text || "";

		// Apply codepage conversions
		var fmtMod = await getFmtMod();
		this._fmtModRef = fmtMod;
		if (fmtMod) {
			// Convert pipe/ctrl-a codes (they produce pure ASCII ANSI sequences)
			if (fmtMod.hasPipeCodes(rawText)) rawText = fmtMod.convertPipeCodes(rawText);
			if (fmtMod.hasCtrlACodes(rawText)) rawText = fmtMod.convertCtrlACodes(rawText);
		}

		rawText = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		var lines = rawText.split("\n");
		this._dumbPageLines = 0;
		for (var i = 0; i < lines.length; i++) {
			this.call.cmds.senddata("  ");
			this._sendBodyText(lines[i]);
			this.call.cmds.senddata("\r\n");
			this._dumbPageLines++;
			if (this._dumbPageLines >= this._termH - 4) {
				this.call.cmds.senddata("  [More - Enter] ");
				this._dumbMode = "more";
				this._dumbMoreLines = lines.slice(i + 1);
				return;
			}
		}
		this.call.cmds.senddata("\r\n  " + this._getMsgPositionStr());
		this.call.cmds.senddata("\r\n  [Right=Next, Left=Prev, L=Last" +
			this._dumbModKeys() + ", Q=Quit]: ");
		this._dumbMode = "msgprompt";
		this._dumbBuf = "";
		this._advancePointers(msg);
	}

	_handleDumbInput(inputArray) {
		for (var i = 0; i < inputArray.length; i++) {
			if (!this.active) return;
			var token = inputArray[i];

			// A moderation prompt owns the keyboard until it is answered, on a
			// dumb terminal the same as anywhere else. Without this the yes/no
			// falls through to the reader's own keys and the question is left
			// hanging while the screen moves on.
			if (this._modPrompt) {
				if (token.startsWith("KEY_")) {
					this._onKeyModerate(token.slice(4));
				} else if (token.startsWith("CHAR_")) {
					this._onCharModerate(token.slice(5));
				}
				continue;
			}

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
			this.call.cmds.senddata("\r\n  " + this._getMsgPositionStr());
			this.call.cmds.senddata("\r\n  [Right=Next, Left=Prev, L=Last" +
				this._dumbModKeys() + ", Q=Quit]: ");
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
		this.call.cmds.senddata("\r\n  " + this._getMsgPositionStr());
		this.call.cmds.senddata("\r\n  [Right=Next, Left=Prev, L=Last" +
			this._dumbModKeys() + ", Q=Quit]: ");
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
			} else if (lower === "d") {
				this._beginDelete();
			} else if (lower === "m") {
				this._beginMove();
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
		this._canPost = false;
		super.clearHandler();
	}
}

export { msgReader };
