import { BaseSubModule } from "../basesubmodule.js";
import { listMsgGroups, getAreasInGroup } from "../../models/messages.js";
import * as alogger from "../../utils/alogger.js";

// Lazy-import pointer and reader modules
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

var _readerMod = null;
async function getReaderMod() {
	if (!_readerMod) {
		try {
			_readerMod = await import("./msgReader.js");
		} catch (_) {
			_readerMod = null;
		}
	}
	return _readerMod;
}

// --- Constants ---

const STATE = {
	LOADING: 0,
	SUMMARY: 1,
	READING: 2,
	COMPLETE: 3,
};

const CLR_TITLE = 14;
const CLR_GROUP = 11;
const CLR_AREA = 15;
const CLR_UNREAD = 10;
const CLR_NONE = 8;
const CLR_STATUS = 8;
const CLR_NAV = 11;
const CLR_HIGHLIGHT_FG = 15;
const CLR_HIGHLIGHT_BG = 4;
const CLR_PROGRESS = 14;

const CP437_ARROW = 0xAF;
const CP437_CORNER = 0xDA;

// =========================================================================

class newscan extends BaseSubModule {
	constructor(call, options) {
		super(call, "Newscan");

		var opts = options || {};

		// Encoding
		var enc = (call.term_encoding || "").toLowerCase();
		this._isUTF8 = (enc === "utf8" || enc === "utf-8");

		// Mode: "all" scans all groups, "group" scans only current group
		this._scanMode = opts.scanMode || "all";

		this._userId = (call.user_record && call.user_record.id) ? call.user_record.id : null;

		// Saved state to restore after scan
		this._savedMsgGroup = call.msg_group;
		this._savedMsgGroupTitle = call.msg_group_title;
		this._savedMsgArea = call.msg_area;
		this._savedMsgAreaTitle = call.msg_area_title;

		// Scan data: array of { groupName, groupShortcode, areaName, areaShortcode, unreadCount }
		this._scanAreas = [];
		this._totalUnread = 0;
		this._areasWithUnread = 0;

		// State machine
		this._state = STATE.LOADING;
		this._scanIdx = 0;
		this._areasScanned = 0;
		this._activeReader = null;

		// Summary lightbar
		this._summaryCursor = 0;
		this._summaryScroll = 0;

		// Geometry
		this._termW = call.term_width || 80;
		this._termH = call.term_height || 24;
		this._bodyWidth = Math.min(this._termW, 100);
		this._bodyLeft = Math.floor((this._termW - this._bodyWidth) / 2) + 1;
		this._listStart = 4;
		this._listHeight = 0;
		this._statusRow = 0;
		this._navRow = 0;

		this.loggingId = "Newscan (Node " + call.nodenum + ")";
	}

	_sendGlyph(utf8Char, cp437Byte) {
		if (!this.call) return;
		if (this._isUTF8) {
			this.call.cmds.senddata(utf8Char);
		} else {
			this.call.cmds.senddata(Buffer.from([cp437Byte]));
		}
	}

	_calcGeometry() {
		this._navRow = this._termH;
		this._statusRow = this._termH - 1;
		this._listHeight = this._statusRow - this._listStart;
		if (this._listHeight < 3) this._listHeight = 3;
	}

	_truncate(str, len) {
		if (!str) return "";
		return str.length > len ? str.substring(0, len) : str;
	}

	_padRight(str, len) {
		while (str.length < len) str += " ";
		return str.length > len ? str.substring(0, len) : str;
	}

	_padLeft(str, len) {
		while (str.length < len) str = " " + str;
		return str.length > len ? str.substring(0, len) : str;
	}

	// ===========================================================================
	// DATA LOADING
	// ===========================================================================

	async _loadScanData() {
		var pm = await getPointerMod();
		if (!pm.getUnreadCount || !this._userId) {
			return;
		}

		var groups;
		if (this._scanMode === "group" && this.call.msg_group) {
			// Scan only the current group
			var areas = await getAreasInGroup(this.call.msg_group, this.call.security);
			if (areas && areas.length > 0) {
				for (var a = 0; a < areas.length; a++) {
					var area = areas[a];
					try {
						var count = await pm.getUnreadCount(this._userId, area.shortcode);
						this._scanAreas.push({
							groupName: this.call.msg_group_title || this.call.msg_group,
							groupShortcode: this.call.msg_group,
							areaName: area.name,
							areaShortcode: area.shortcode,
							unreadCount: count || 0
						});
					} catch (_) {
						this._scanAreas.push({
							groupName: this.call.msg_group_title || this.call.msg_group,
							groupShortcode: this.call.msg_group,
							areaName: area.name,
							areaShortcode: area.shortcode,
							unreadCount: 0
						});
					}
				}
			}
		} else {
			// Scan all groups
			groups = await listMsgGroups(this.call.security);
			if (groups) {
				for (var g = 0; g < groups.length; g++) {
					var group = groups[g];
					var areas = await getAreasInGroup(group.shortcode, this.call.security);
					if (!areas || areas.length === 0) continue;

					for (var a = 0; a < areas.length; a++) {
						var area = areas[a];
						try {
							var count = await pm.getUnreadCount(this._userId, area.shortcode);
							this._scanAreas.push({
								groupName: group.name,
								groupShortcode: group.shortcode,
								areaName: area.name,
								areaShortcode: area.shortcode,
								unreadCount: count || 0
							});
						} catch (_) {
							this._scanAreas.push({
								groupName: group.name,
								groupShortcode: group.shortcode,
								areaName: area.name,
								areaShortcode: area.shortcode,
								unreadCount: 0
							});
						}
					}
				}
			}
		}

		// Calculate totals
		this._totalUnread = 0;
		this._areasWithUnread = 0;
		for (var i = 0; i < this._scanAreas.length; i++) {
			if (this._scanAreas[i].unreadCount > 0) {
				this._totalUnread += this._scanAreas[i].unreadCount;
				this._areasWithUnread++;
			}
		}
	}

	// ===========================================================================
	// SUMMARY SCREEN
	// ===========================================================================

	_drawSummary() {
		if (this.dumb) {
			this._drawSummaryDumb();
			return;
		}
		this.call.cmds.clearscreen();

		// Title
		this.call.cmds.movecursor(this._bodyLeft, 1);
		this.call.cmds.setfgcolor(CLR_TITLE);
		var modeStr = (this._scanMode === "group") ? "Newscan — " + (this.call.msg_group_title || this.call.msg_group) : "Newscan — All Groups";
		this.call.cmds.senddata(this._truncate(modeStr, this._bodyWidth - 20));

		// Stats right-aligned
		var statsStr = this._areasWithUnread + " areas  " + this._totalUnread + " unread";
		var statsX = this._bodyLeft + this._bodyWidth - statsStr.length - 1;
		if (statsX > this._bodyLeft + modeStr.length + 2) {
			this.call.cmds.movecursor(statsX, 1);
			this.call.cmds.setfgcolor(CLR_STATUS);
			this.call.cmds.senddata(statsStr);
		}

		// Column header
		this.call.cmds.movecursor(this._bodyLeft, 3);
		this.call.cmds.setfgcolor(CLR_STATUS);
		var hdr = "  " + this._padRight("Area", this._bodyWidth - 12) + this._padLeft("New", 8);
		this.call.cmds.senddata(this._truncate(hdr, this._bodyWidth));

		// List
		this._drawSummaryRows();

		// Status + nav
		this._drawSummaryStatusBar();
		this._drawSummaryNavBar();

		this.call.cmds.resetcolors();
	}

	_drawSummaryRows() {
		if (this.dumb) return;
		var lastGroup = "";

		for (var vi = 0; vi < this._listHeight; vi++) {
			var idx = this._summaryScroll + vi;
			var screenY = this._listStart + vi;

			this.call.cmds.movecursor(this._bodyLeft, screenY);
			this.call.cmds.cleartoeol();

			if (idx >= this._scanAreas.length) continue;

			var entry = this._scanAreas[idx];

			// Insert group header when group changes
			// We handle this by checking if we need to show it inline
			// For simplicity, areas are listed flat with group name as context
			var isHighlighted = (idx === this._summaryCursor);

			if (isHighlighted) {
				this.call.cmds.setfgcolor(CLR_HIGHLIGHT_FG);
				this.call.cmds.setbgcolor(CLR_HIGHLIGHT_BG);
			} else if (entry.unreadCount > 0) {
				this.call.cmds.setfgcolor(CLR_AREA);
			} else {
				this.call.cmds.setfgcolor(CLR_NONE);
			}

			var prefix = isHighlighted ? " " : "  ";
			if (isHighlighted) {
				this.call.cmds.senddata(" ");
				this._sendGlyph("\u25BA", CP437_ARROW);
			} else {
				this.call.cmds.senddata("  ");
			}

			var nameCol = this._bodyWidth - 12;
			var areaStr = this._truncate(entry.areaName, nameCol - 2);
			this.call.cmds.senddata(this._padRight(areaStr, nameCol));

			// Unread count
			if (entry.unreadCount > 0 && !isHighlighted) {
				this.call.cmds.setfgcolor(CLR_UNREAD);
			}
			this.call.cmds.senddata(this._padLeft(entry.unreadCount > 0 ? String(entry.unreadCount) : "-", 8));

			// Pad bar
			if (isHighlighted) {
				var written = 2 + nameCol + 8;
				var pad = this._bodyWidth - written;
				if (pad > 0) {
					var padStr = "";
					for (var p = 0; p < pad; p++) padStr += " ";
					this.call.cmds.senddata(padStr);
				}
			}

			this.call.cmds.resetcolors();
		}
	}

	_redrawSummaryRow(idx) {
		if (this.dumb) return;
		var vi = idx - this._summaryScroll;
		if (vi < 0 || vi >= this._listHeight) return;
		// Redraw by drawing just that one row position
		// For simplicity, redraw all rows (summary lists are usually short)
		this._drawSummaryRows();
	}

	_drawSummaryStatusBar() {
		if (this.dumb) return;
		this.call.cmds.movecursor(1, this._statusRow);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(CLR_STATUS);
		if (this._scanAreas.length > 0) {
			this.call.cmds.senddata(" Area " + (this._summaryCursor + 1) + "/" + this._scanAreas.length);
		} else {
			this.call.cmds.senddata(" No areas to scan");
		}
		this.call.cmds.resetcolors();
	}

	_drawSummaryNavBar() {
		if (this.dumb) return;
		this.call.cmds.movecursor(1, this._navRow);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(CLR_NAV);
		this.call.cmds.senddata(" [Enter] Start Scan  [G] Go to Area  [M] Mark All Read  [ESC/Q] Back");
		this.call.cmds.resetcolors();
	}

	_summaryMoveUp() {
		if (this._summaryCursor <= 0) return;
		this._summaryCursor--;
		this._ensureSummaryVisible();
		this._drawSummaryRows();
		this._drawSummaryStatusBar();
	}

	_summaryMoveDown() {
		if (this._summaryCursor >= this._scanAreas.length - 1) return;
		this._summaryCursor++;
		this._ensureSummaryVisible();
		this._drawSummaryRows();
		this._drawSummaryStatusBar();
	}

	_ensureSummaryVisible() {
		if (this._summaryCursor < this._summaryScroll) {
			this._summaryScroll = this._summaryCursor;
		} else if (this._summaryCursor >= this._summaryScroll + this._listHeight) {
			this._summaryScroll = this._summaryCursor - this._listHeight + 1;
		}
	}

	// ===========================================================================
	// SCAN EXECUTION
	// ===========================================================================

	_findNextUnread(startIdx) {
		for (var i = startIdx; i < this._scanAreas.length; i++) {
			if (this._scanAreas[i].unreadCount > 0) return i;
		}
		return -1;
	}

	_startScan() {
		// Find first area with unreads
		var idx = this._findNextUnread(0);
		if (idx < 0) {
			this._showComplete();
			return;
		}
		this._scanIdx = idx;
		this._areasScanned = 0;
		this._openReaderForArea(idx);
	}

	_startScanFromCursor() {
		// Start scanning from the selected area
		var idx = this._summaryCursor;
		// If the selected area has no unreads, find next one with unreads
		if (this._scanAreas[idx].unreadCount <= 0) {
			idx = this._findNextUnread(idx);
			if (idx < 0) {
				this._showComplete();
				return;
			}
		}
		this._scanIdx = idx;
		this._areasScanned = 0;
		this._openReaderForArea(idx);
	}

	async _openReaderForArea(idx) {
		if (idx < 0 || idx >= this._scanAreas.length) {
			this._showComplete();
			return;
		}

		var entry = this._scanAreas[idx];
		this._scanIdx = idx;

		// Set the call's area context for the reader
		this.call.msg_group = entry.groupShortcode;
		this.call.msg_group_title = entry.groupName;
		this.call.msg_area = entry.areaShortcode;
		this.call.msg_area_title = entry.areaName;

		// Show progress before launching reader
		if (!this.dumb) {
			this.call.cmds.movecursor(1, this._statusRow);
			this.call.cmds.cleartoeol();
			this.call.cmds.setfgcolor(CLR_PROGRESS);
			this.call.cmds.senddata(" Scanning: " + entry.areaName +
				" (" + entry.unreadCount + " unread) — " +
				(this._areasScanned + 1) + "/" + this._areasWithUnread);
			this.call.cmds.resetcolors();
		} else {
			this.call.cmds.senddata("\r\n  Scanning: " + entry.areaName +
				" (" + entry.unreadCount + " unread)\r\n");
		}

		var readerMod = await getReaderMod();
		if (!readerMod || !readerMod.msgReader) {
			alogger.writeAlog(3, this.loggingId + " could not load msgReader", "redbright");
			this._advanceScan();
			return;
		}

		this._state = STATE.READING;
		var reader = new readerMod.msgReader(this.call);
		this._activeReader = reader;

		reader.emitter.on("ModuleReturn", () => {
			this._activeReader = null;
			try { reader.clearHandler(); } catch (_) {}
			if (!this.active) return;
			this._areasScanned++;
			this._advanceScan();
		});

		reader.emitter.on("HangupSignal", () => {
			this._activeReader = null;
			try { reader.clearHandler(); } catch (_) {}
			this._restoreCallState();
			this.signalHangup();
		});

		reader.startStage();
	}

	_advanceScan() {
		// Find next area with unreads after current
		var nextIdx = this._findNextUnread(this._scanIdx + 1);
		if (nextIdx < 0) {
			this._showComplete();
		} else {
			this._openReaderForArea(nextIdx);
		}
	}

	// ===========================================================================
	// COMPLETE / MARK ALL
	// ===========================================================================

	_showComplete() {
		this._restoreCallState();
		this._state = STATE.COMPLETE;

		if (this.dumb) {
			this.call.cmds.senddata("\r\n  Newscan complete. " + this._areasScanned + " area(s) scanned.\r\n");
			setTimeout(() => { if (this.active) this.signalReturn(); }, 1500);
			return;
		}

		this.call.cmds.clearscreen();
		this.call.cmds.movecursor(this._bodyLeft, Math.floor(this._termH / 2) - 1);
		this.call.cmds.setfgcolor(CLR_TITLE);
		this.call.cmds.senddata("Newscan Complete");
		this.call.cmds.movecursor(this._bodyLeft, Math.floor(this._termH / 2) + 1);
		this.call.cmds.setfgcolor(CLR_STATUS);
		this.call.cmds.senddata(this._areasScanned + " area(s) scanned.");
		this.call.cmds.movecursor(this._bodyLeft, Math.floor(this._termH / 2) + 3);
		this.call.cmds.setfgcolor(CLR_NAV);
		this.call.cmds.senddata("Press any key to return.");
		this.call.cmds.resetcolors();
	}

	async _markAllRead() {
		if (!this._userId) return;
		var pm = await getPointerMod();
		if (!pm.markAreaRead) return;

		for (var i = 0; i < this._scanAreas.length; i++) {
			if (this._scanAreas[i].unreadCount > 0) {
				try {
					await pm.markAreaRead(this._userId, this._scanAreas[i].areaShortcode);
					this._scanAreas[i].unreadCount = 0;
				} catch (_) {}
			}
		}

		this._totalUnread = 0;
		this._areasWithUnread = 0;

		if (this.dumb) {
			this.call.cmds.senddata("\r\n  All areas marked as read.\r\n");
		} else {
			this._drawSummaryRows();
			this.call.cmds.movecursor(1, this._statusRow);
			this.call.cmds.cleartoeol();
			this.call.cmds.setfgcolor(CLR_PROGRESS);
			this.call.cmds.senddata(" All areas marked as read.");
			this.call.cmds.resetcolors();
		}
	}

	_restoreCallState() {
		if (!this.call) return;
		this.call.msg_group = this._savedMsgGroup;
		this.call.msg_group_title = this._savedMsgGroupTitle;
		this.call.msg_area = this._savedMsgArea;
		this.call.msg_area_title = this._savedMsgAreaTitle;
	}

	// ===========================================================================
	// DUMB TERMINAL
	// ===========================================================================

	_drawSummaryDumb() {
		var modeStr = (this._scanMode === "group")
			? "Newscan — " + (this.call.msg_group_title || this.call.msg_group)
			: "Newscan — All Groups";
		this.call.cmds.senddata("\r\n\r\n  " + modeStr + "\r\n");
		this.call.cmds.senddata("  " + this._areasWithUnread + " areas with " + this._totalUnread + " unread messages\r\n\r\n");

		for (var i = 0; i < this._scanAreas.length; i++) {
			var entry = this._scanAreas[i];
			if (entry.unreadCount > 0) {
				this.call.cmds.senddata("  " + entry.areaName + " — " + entry.unreadCount + " new\r\n");
			}
		}

		this.call.cmds.senddata("\r\n  [Enter] Start scan  [Q] Quit: ");
		this._dumbMode = "summary";
	}

	// ===========================================================================
	// INPUT HANDLING
	// ===========================================================================

	handleInput(inputArray) {
		if (!this.active) return;

		// Route to active reader — user exits with ESC/Q to advance scan
		if (this._state === STATE.READING && this._activeReader) {
			this._activeReader.handleInput(inputArray);
			return;
		}

		if (this.dumb) {
			this._handleDumbInput(inputArray);
			return;
		}

		super.handleInput(inputArray);
	}

	onKey(key) {
		if (this._state === STATE.SUMMARY) {
			switch (key) {
				case "UpArrow":
					this._summaryMoveUp();
					return;
				case "DownArrow":
					this._summaryMoveDown();
					return;
				case "Enter":
					this._startScan();
					return;
				case "ESC":
					this._restoreCallState();
					this.signalReturn();
					return;
			}
		} else if (this._state === STATE.COMPLETE) {
			// Any key returns
			this.signalReturn();
		}
	}

	onChar(ch) {
		if (this._state === STATE.SUMMARY) {
			var lower = ch.toLowerCase();
			switch (lower) {
				case "q":
					this._restoreCallState();
					this.signalReturn();
					return;
				case "g":
					// Go to selected area directly
					this._startScanFromCursor();
					return;
				case "m":
					this._markAllRead();
					return;
			}
		} else if (this._state === STATE.COMPLETE) {
			this.signalReturn();
		}
	}

	_handleDumbInput(inputArray) {
		for (var i = 0; i < inputArray.length; i++) {
			if (!this.active) return;
			var token = inputArray[i];
			if (token === "KEY_Enter") {
				if (this._dumbMode === "summary") {
					this._startScan();
				} else {
					this.signalReturn();
				}
				return;
			}
			if (token === "KEY_ESC" || token === "CHAR_q" || token === "CHAR_Q") {
				this._restoreCallState();
				this.signalReturn();
				return;
			}
		}
	}

	// ===========================================================================
	// LIFECYCLE
	// ===========================================================================

	run() {
		if (!this._userId) {
			if (this.dumb) {
				this.call.cmds.senddata("\r\n  Not logged in.\r\n");
			}
			setTimeout(() => { if (this.active) this.signalReturn(); }, 1000);
			return;
		}

		this._calcGeometry();

		this._loadScanData()
			.then(() => {
				if (!this.active) return;

				if (this._areasWithUnread === 0) {
					if (this.dumb) {
						this.call.cmds.senddata("\r\n  No new messages.\r\n");
					} else {
						this.call.cmds.clearscreen();
						this.call.cmds.movecursor(this._bodyLeft, Math.floor(this._termH / 2));
						this.call.cmds.setfgcolor(CLR_STATUS);
						this.call.cmds.senddata("No new messages. Press any key.");
						this.call.cmds.resetcolors();
					}
					this._state = STATE.COMPLETE;
					return;
				}

				this._state = STATE.SUMMARY;
				this._drawSummary();
			})
			.catch(err => {
				if (!this.active) return;
				alogger.writeAlog(3, this.loggingId + " run error: " + (err?.stack || err), "redbright");
				this._restoreCallState();
				this.signalReturn();
			});
	}

	clearHandler() {
		if (!this.active) return;
		if (this._activeReader) {
			try { this._activeReader.clearHandler(); } catch (_) {}
			this._activeReader = null;
		}
		this._restoreCallState();
		this._scanAreas = [];
		super.clearHandler();
	}
}

export { newscan };
