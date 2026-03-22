import { BaseSubModule } from "../basesubmodule.js";
import { getAreaByShortcode, resolveAreaPath } from "../../models/fileAreas.js";
import { getGroupByShortcode } from "../../models/fileGroups.js";
import { getEntriesForArea, getEntryCount, searchEntries, getMaxIdForArea, incrementDownloadCount } from "../../models/fileEntries.js";
import * as userFilePointers from "../../models/userFilePointers.js";
import * as alogger from "../../utils/alogger.js";
import { NativeZmodemProtocol } from "../../protocols/zmodem_native.js";
import { NativeXmodemProtocol } from "../../protocols/xmodem_native.js";
import * as path from "path";

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

function checkReadFlags(userRecord, item) {
	if (!userRecord || !item) return false;
	var userSecurity = parseInt(userRecord.security) || 0;
	if (item.read_security && userSecurity < item.read_security) return false;
	var userPerms  = parseFlags(userRecord.permissionflags);
	var userRestrs = parseFlags(userRecord.restrictionflags);
	var reqFlags   = parseFlags(item.read_perm_flags);
	var restFlags  = parseFlags(item.read_rest_flags);
	if (reqFlags.length > 0 && !reqFlags.every(function(f) { return userPerms.includes(f); })) return false;
	if (restFlags.length > 0 && restFlags.some(function(f) { return userRestrs.includes(f); })) return false;
	return true;
}

// --- Constants ---

const STATE = {
	LOADING: 0,
	FILE_LIST: 1,
	FILE_DETAIL: 2,
};

const FILE_BATCH = 50;
const MAX_BODY_WIDTH = 100;

// Colors
const CLR_TITLE = 14;
const CLR_FILE = 15;
const CLR_FILE_NEW = 10;
const CLR_BAR_FG = 15;
const CLR_BAR_BG = 4;
const CLR_COL_HEADER = 3;
const CLR_STATUS = 8;
const CLR_NAV = 11;
const CLR_NAV_LABEL = 7;
const CLR_ERROR = 9;
const CLR_HDR_LABEL = 6;
const CLR_HDR_VALUE = 10;
const CLR_HDR_SUBJ = 3;
const CLR_SEPARATOR = 4;
const CLR_BODY = 11;
const CLR_DOWNLOAD = 14;
const CLR_TAGGED = 13;    // magenta for batch-tagged files

// CP437 safe glyphs
const CP437_HLINE  = 0xC4;
const CP437_CORNER = 0xDA;
const CP437_ARROW  = 0xAF;
const CP437_LARROW = 0x3C;  // < as safe left arrow for CP437 (0x1B is ESC)
const CP437_RARROW = 0x3E;  // > as safe right arrow for CP437 (0x1A is SUB)

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// =========================================================================

class fileBrowser extends BaseSubModule {
	constructor(call) {
		super(call, "FileBrowser");

		// Encoding
		var enc = (call.term_encoding || "").toLowerCase();
		this._isUTF8 = (enc === "utf8" || enc === "utf-8");

		// Area config
		this._areaShortcode = call.file_area || "";
		this._areaName = call.file_area_title || call.file_area || "";
		this._areaConfig = null;
		this._userId = null;
		if (call.user_record) {
			this._userId = call.user_record.id || call.user_record.user_id || null;
		}

		// State machine
		this._state = STATE.LOADING;

		// Geometry
		this._termW = call.term_width || 80;
		this._termH = call.term_height || 24;
		this._bodyWidth = 0;
		this._bodyLeft = 0;
		this._bodyRight = 0;
		this._listViewStart = 4;
		this._listViewEnd = 0;
		this._listViewHeight = 0;
		this._statusRow = 0;
		this._navRow = 0;
		this._detailBodyStart = 8;
		this._detailBodyEnd = 0;
		this._detailBodyHeight = 0;

		// File list state
		this._files = [];
		this._fileCursor = 0;
		this._fileScroll = 0;
		this._fileTotal = 0;
		this._scanPointer = 0;  // user's scan pointer for this area

		// Search
		this._searchMode = false;
		this._searchBuf = "";
		this._filteredFiles = [];

		// Detail state
		this._detailLines = [];
		this._detailScroll = 0;

		// Dumb terminal state
		this._dumbPageLines = 0;
		this._dumbInputMode = false;
		this._dumbInputBuffer = "";

		this.loggingId = "FileBrowser (Node " + call.nodenum + ")";
	}

	// --- Encoding helpers ---

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

	_sendArrowNav() {
		if (!this.call) return;
		this.call.cmds.setfgcolor(CLR_NAV);
		this._sendGlyph("\u2190", CP437_LARROW);
		this.call.cmds.senddata("/");
		this._sendGlyph("\u2192", CP437_RARROW);
		this.call.cmds.setfgcolor(CLR_NAV_LABEL);
		this.call.cmds.senddata(" Prev/Next");
	}

	// --- Geometry ---

	_calcGeometry() {
		this._bodyWidth = Math.min(this._termW, MAX_BODY_WIDTH);
		this._bodyLeft = Math.floor((this._termW - this._bodyWidth) / 2) + 1;
		this._bodyRight = this._bodyLeft + this._bodyWidth - 1;

		this._navRow = this._termH;
		this._statusRow = this._termH - 1;

		// File list: row 1 title, row 2 info, row 3 col headers, row 4+ content, H-1 status, H nav
		this._listViewStart = 4;
		this._listViewEnd = this._termH - 2;
		this._listViewHeight = this._listViewEnd - this._listViewStart + 1;
		if (this._listViewHeight < 3) this._listViewHeight = 3;

		// Detail view: rows 1-7 header, row 8+ body, H-1 status, H nav
		this._detailBodyStart = 8;
		this._detailBodyEnd = this._termH - 2;
		this._detailBodyHeight = this._detailBodyEnd - this._detailBodyStart + 1;
		if (this._detailBodyHeight < 3) this._detailBodyHeight = 3;
	}

	// --- String / format helpers ---

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

	_formatFileSize(bytes) {
		if (!bytes || bytes === 0) return "0 B";
		var b = parseInt(bytes);
		if (b < 1024) return b + " B";
		if (b < 1048576) return (b / 1024).toFixed(0) + " KB";
		if (b < 1073741824) return (b / 1048576).toFixed(1) + " MB";
		return (b / 1073741824).toFixed(1) + " GB";
	}

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

	_isNewFile(file) {
		return file.id > this._scanPointer;
	}

	_wordWrap(text, maxWidth) {
		if (!text) return [""];
		text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		var sourceLines = text.split("\n");
		var result = [];

		for (var i = 0; i < sourceLines.length; i++) {
			var line = sourceLines[i];
			if (line.length <= maxWidth) {
				result.push(line);
				continue;
			}
			var remaining = line;
			while (remaining.length > maxWidth) {
				var breakAt = remaining.lastIndexOf(" ", maxWidth);
				if (breakAt <= 0) {
					breakAt = maxWidth;
				}
				result.push(remaining.substring(0, breakAt));
				remaining = remaining.substring(breakAt);
				if (remaining.charAt(0) === " ") remaining = remaining.substring(1);
			}
			result.push(remaining);
		}

		return result;
	}

	// ===========================================================================
	// DATA LOADING
	// ===========================================================================

	async _loadAreaConfig() {
		if (!this._areaShortcode) return false;
		this._areaConfig = await getAreaByShortcode(this._areaShortcode);
		if (!this._areaConfig) return false;

		// Access check
		if (this.call.user_record && !checkReadFlags(this.call.user_record, this._areaConfig)) {
			return false;
		}

		this._areaName = this._areaConfig.name || this._areaShortcode;

		// Load user's scan pointer
		if (this._userId) {
			try {
				this._scanPointer = await userFilePointers.getPointer(this._userId, this._areaShortcode);
			} catch (_) {
				this._scanPointer = 0;
			}
		}

		return true;
	}

	async _loadFileList() {
		if (!this._areaConfig) return;
		this._fileTotal = await getEntryCount(this._areaConfig.id);
		this._files = await getEntriesForArea(this._areaConfig.id, {
			limit: FILE_BATCH,
			offset: 0,
			orderBy: "upload_date DESC"
		});
		this._filteredFiles = this._files.slice();
		this._fileCursor = 0;
		this._fileScroll = 0;
	}

	async _loadMoreFiles() {
		if (!this._areaConfig) return;
		if (this._files.length >= this._fileTotal) return;
		var more = await getEntriesForArea(this._areaConfig.id, {
			limit: FILE_BATCH,
			offset: this._files.length,
			orderBy: "upload_date DESC"
		});
		if (more && more.length > 0) {
			this._files = this._files.concat(more);
			this._applyFilter();
		}
	}

	async _searchFiles(term) {
		if (!this._areaConfig) return;
		var results = await searchEntries(term, {
			areaId: this._areaConfig.id,
			limit: FILE_BATCH
		});
		this._filteredFiles = results || [];
		this._fileCursor = 0;
		this._fileScroll = 0;
	}

	// ===========================================================================
	// FILTERING
	// ===========================================================================

	_applyFilter() {
		if (!this._searchBuf || this._searchBuf.length === 0) {
			this._filteredFiles = this._files.slice();
			return;
		}
		var term = this._searchBuf.toLowerCase();
		this._filteredFiles = this._files.filter(function(f) {
			return (f.filename && f.filename.toLowerCase().includes(term)) ||
				(f.short_desc && f.short_desc.toLowerCase().includes(term)) ||
				(f.long_desc && f.long_desc.toLowerCase().includes(term));
		});
	}

	// ===========================================================================
	// POINTER MANAGEMENT
	// ===========================================================================

	async _advancePointerToFile(file) {
		if (!this._userId || !file) return;
		try {
			await userFilePointers.advancePointer(this._userId, this._areaShortcode, file.id);
			// Update local pointer if we moved forward
			if (file.id > this._scanPointer) {
				this._scanPointer = file.id;
			}
		} catch (err) {
			alogger.writeAlog(3, this.loggingId + " pointer advance error: " + (err?.stack || err), "redbright");
		}
	}

	async _markAreaRead() {
		if (!this._userId) return;
		try {
			await userFilePointers.markAreaRead(this._userId, this._areaShortcode);
			// Update local pointer to max
			if (this._areaConfig) {
				this._scanPointer = await getMaxIdForArea(this._areaConfig.id);
			}
		} catch (err) {
			alogger.writeAlog(3, this.loggingId + " markAreaRead error: " + (err?.stack || err), "redbright");
		}
	}

	// ===========================================================================
	// STATE MANAGEMENT
	// ===========================================================================

	_setState(newState) {
		this._state = newState;
		if (!this.call || !this.active) return;

		switch (newState) {
			case STATE.FILE_LIST:
				this._drawFileListScreen();
				break;
			case STATE.FILE_DETAIL:
				this._showCurrentFileDetail();
				break;
		}
	}

	_showCurrentFileDetail() {
		if (this._fileCursor < 0 || this._fileCursor >= this._filteredFiles.length) return;
		var file = this._filteredFiles[this._fileCursor];
		this._prepareDetailLines(file);
		this._drawFileDetailScreen(file);
		this._advancePointerToFile(file);
	}

	// ===========================================================================
	// FILE LIST DRAWING
	// ===========================================================================

	_drawFileListScreen() {
		if (!this.call) return;
		if (this.dumb) {
			this._drawFileListDumb();
			return;
		}
		this.call.cmds.clearscreen();

		// Row 1: area title + stats
		this.call.cmds.movecursor(this._bodyLeft, 1);
		this.call.cmds.setfgcolor(CLR_TITLE);
		this._sendGlyph("\u250C", CP437_CORNER);
		this.call.cmds.senddata(" " + this._truncate(this._areaName, this._bodyWidth - 30));
		// Right-aligned stats
		var newCount = 0;
		for (var i = 0; i < this._filteredFiles.length; i++) {
			if (this._isNewFile(this._filteredFiles[i])) newCount++;
		}
		var stats = this._fileTotal + " files";
		if (newCount > 0) stats += "  " + newCount + " new";
		var statsX = this._bodyRight - stats.length;
		if (statsX > this._bodyLeft + this._areaName.length + 4) {
			this.call.cmds.movecursor(statsX, 1);
			this.call.cmds.setfgcolor(CLR_STATUS);
			this.call.cmds.senddata(stats);
		}

		// Row 2: info / search
		this._drawFileInfoLine();

		// Row 3: column headers
		this._drawFileColumnHeader();

		// Rows 4+: file list
		this._drawFileRows();

		// Status + nav
		this._drawFileStatusBar();
		this._drawFileNavBar();

		this.call.cmds.resetcolors();
	}

	_drawFileInfoLine() {
		if (this.dumb) return;
		this.call.cmds.movecursor(this._bodyLeft, 2);
		this.call.cmds.cleartoeol();
		if (this._searchMode) {
			this.call.cmds.setfgcolor(CLR_TITLE);
			this.call.cmds.senddata("Search: " + this._searchBuf + "_");
		}
		this.call.cmds.resetcolors();
	}

	_calcFileColumns() {
		var sizeW = 8;
		var dateW = 6;
		var fixedW = 2 + sizeW + 1 + dateW + 1 + 1; // prefix + gaps
		var remaining = this._bodyWidth - fixedW;
		// Split remaining between filename and description
		var filenameW = Math.floor(remaining * 0.35);
		if (filenameW < 12) filenameW = 12;
		if (filenameW > 30) filenameW = 30;
		var descW = remaining - filenameW - 1; // 1 for gap
		if (descW < 10) descW = 10;
		return { filenameW: filenameW, sizeW: sizeW, dateW: dateW, descW: descW };
	}

	_drawFileColumnHeader() {
		if (this.dumb) return;
		var cols = this._calcFileColumns();
		this.call.cmds.movecursor(this._bodyLeft, 3);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(CLR_COL_HEADER);
		var hdr = "  " +
			this._padRight("Filename", cols.filenameW) + " " +
			this._padRight("Desc", cols.descW) + " " +
			this._padLeft("Size", cols.sizeW) + " " +
			this._padRight("Date", cols.dateW);
		this.call.cmds.senddata(this._truncate(hdr, this._bodyWidth));
		this.call.cmds.resetcolors();
	}

	_drawFileRows() {
		if (this.dumb) return;
		var cols = this._calcFileColumns();

		for (var vi = 0; vi < this._listViewHeight; vi++) {
			var fidx = this._fileScroll + vi;
			var screenY = this._listViewStart + vi;
			this.call.cmds.movecursor(this._bodyLeft, screenY);
			this.call.cmds.cleartoeol();

			if (fidx >= this._filteredFiles.length) continue;

			var file = this._filteredFiles[fidx];
			var isHighlighted = (fidx === this._fileCursor);
			this._drawSingleFileRow(file, screenY, cols, isHighlighted);
			this.call.cmds.resetcolors();
		}
	}

	_drawSingleFileRow(file, screenY, cols, isHighlighted) {
		this.call.cmds.movecursor(this._bodyLeft, screenY);

		var isNew = this._isNewFile(file);
		var isTagged = this._isInBatch(file);

		if (isHighlighted) {
			this.call.cmds.setfgcolor(CLR_BAR_FG);
			this.call.cmds.setbgcolor(CLR_BAR_BG);
		} else if (isTagged) {
			this.call.cmds.setfgcolor(CLR_TAGGED);
		} else if (isNew) {
			this.call.cmds.setfgcolor(CLR_FILE_NEW);
		} else {
			this.call.cmds.setfgcolor(CLR_FILE);
		}

		// Prefix (2 columns): arrow for highlighted, + for tagged, space otherwise
		if (isHighlighted) {
			this.call.cmds.senddata(isTagged ? "+" : " ");
			this._sendGlyph("\u25BA", CP437_ARROW);
		} else if (isTagged) {
			this.call.cmds.senddata("+ ");
		} else {
			this.call.cmds.senddata("  ");
		}

		var filename = this._padRight(this._truncate(file.filename || "", cols.filenameW), cols.filenameW);
		var desc = this._padRight(this._truncate(file.short_desc || "", cols.descW), cols.descW);
		var size = this._padLeft(this._formatFileSize(file.file_size), cols.sizeW);
		var date = this._padRight(this._formatShortDate(file.upload_date), cols.dateW);

		var rowText = filename + " " + desc + " " + size + " " + date;
		this.call.cmds.senddata(rowText);

		// Pad bar to full width
		if (isHighlighted) {
			var written = 2 + rowText.length;
			var remaining = this._bodyWidth - written;
			if (remaining > 0) {
				var pad = "";
				for (var p = 0; p < remaining; p++) pad += " ";
				this.call.cmds.senddata(pad);
			}
		}
	}

	_redrawFileRow(fidx) {
		if (this.dumb) return;
		var vi = fidx - this._fileScroll;
		if (vi < 0 || vi >= this._listViewHeight) return;
		var screenY = this._listViewStart + vi;
		this.call.cmds.movecursor(this._bodyLeft, screenY);
		this.call.cmds.cleartoeol();
		if (fidx >= this._filteredFiles.length) return;
		var cols = this._calcFileColumns();
		this._drawSingleFileRow(this._filteredFiles[fidx], screenY, cols, fidx === this._fileCursor);
		this.call.cmds.resetcolors();
	}

	_drawFileStatusBar() {
		if (this.dumb) return;
		this.call.cmds.movecursor(1, this._statusRow);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(CLR_STATUS);
		var pos = this._filteredFiles.length > 0
			? " File " + (this._fileCursor + 1) + "/" + this._filteredFiles.length
			: " No files";
		this.call.cmds.senddata(pos);
		this.call.cmds.resetcolors();
	}

	_drawFileNavBar() {
		if (this.dumb) return;
		this.call.cmds.movecursor(1, this._navRow);
		this.call.cmds.cleartoeol();
		this.call.cmds.senddata(" ");
		this._navKey("Enter", "Details");
		this.call.cmds.senddata("  ");
		this._navKey("D", "Download");
		this.call.cmds.senddata("  ");
		this._navKey("T", "Tag");
		if (this.call && this.call.file_batch && this.call.file_batch.length > 0) {
			this.call.cmds.senddata("  ");
			this._navKey("B", "Batch(" + this.call.file_batch.length + ")");
		}
		this.call.cmds.senddata("  ");
		this._navKey("S", "Search");
		this.call.cmds.senddata("  ");
		this._navKey("M", "Mark Read");
		this.call.cmds.senddata("  ");
		this._navKey("Q", "Back");
		this.call.cmds.resetcolors();
	}

	// --- File list navigation ---

	_fileMoveUp() {
		if (this._fileCursor <= 0) return;
		var prev = this._fileCursor;
		var prevScroll = this._fileScroll;
		this._fileCursor--;
		this._ensureFileVisible();
		if (this._fileScroll !== prevScroll) {
			this._drawFileRows();
		} else {
			this._redrawFileRow(prev);
			this._redrawFileRow(this._fileCursor);
		}
		this._drawFileStatusBar();
	}

	_fileMoveDown() {
		if (this._fileCursor >= this._filteredFiles.length - 1) {
			// Try to load more if at the end of loaded files
			if (this._files.length < this._fileTotal && !this._searchBuf) {
				this._loadMoreFiles().then(() => {
					if (!this.active) return;
					if (this._fileCursor < this._filteredFiles.length - 1) {
						this._fileCursor++;
						this._ensureFileVisible();
						this._drawFileRows();
						this._drawFileStatusBar();
					}
				});
			}
			return;
		}
		var prev = this._fileCursor;
		var prevScroll = this._fileScroll;
		this._fileCursor++;
		this._ensureFileVisible();
		if (this._fileScroll !== prevScroll) {
			this._drawFileRows();
		} else {
			this._redrawFileRow(prev);
			this._redrawFileRow(this._fileCursor);
		}
		this._drawFileStatusBar();
	}

	_filePageUp() {
		var moves = this._listViewHeight - 1;
		for (var i = 0; i < moves; i++) {
			if (this._fileCursor <= 0) break;
			this._fileCursor--;
		}
		this._ensureFileVisible();
		this._drawFileRows();
		this._drawFileStatusBar();
	}

	_filePageDown() {
		var moves = this._listViewHeight - 1;
		for (var i = 0; i < moves; i++) {
			if (this._fileCursor >= this._filteredFiles.length - 1) break;
			this._fileCursor++;
		}
		this._ensureFileVisible();
		this._drawFileRows();
		this._drawFileStatusBar();

		// Trigger load-ahead
		if (this._fileCursor >= this._files.length - 5 && this._files.length < this._fileTotal && !this._searchBuf) {
			this._loadMoreFiles().then(() => {
				if (this.active) this._applyFilter();
			});
		}
	}

	_fileJumpFirst() {
		this._fileCursor = 0;
		this._fileScroll = 0;
		this._drawFileRows();
		this._drawFileStatusBar();
	}

	_fileJumpLast() {
		this._fileCursor = this._filteredFiles.length > 0 ? this._filteredFiles.length - 1 : 0;
		this._ensureFileVisible();
		this._drawFileRows();
		this._drawFileStatusBar();
	}

	_ensureFileVisible() {
		if (this._fileCursor < this._fileScroll) {
			this._fileScroll = this._fileCursor;
		} else if (this._fileCursor >= this._fileScroll + this._listViewHeight) {
			this._fileScroll = this._fileCursor - this._listViewHeight + 1;
		}
	}

	// ===========================================================================
	// FILE DETAIL DRAWING
	// ===========================================================================

	_prepareDetailLines(file) {
		var wrapWidth = this._bodyWidth - 4;
		if (wrapWidth < 20) wrapWidth = 20;
		this._detailLines = [];
		var desc = file.long_desc || file.short_desc || "";
		if (desc) {
			this._detailLines = this._wordWrap(desc, wrapWidth);
		}
		this._detailScroll = 0;
	}

	_drawFileDetailScreen(file) {
		if (!this.call) return;
		if (this.dumb) {
			this._drawFileDetailDumb(file);
			return;
		}
		this.call.cmds.clearscreen();

		// Row 1: filename + tagged indicator
		var isTagged = this._isInBatch(file);
		this.call.cmds.movecursor(this._bodyLeft, 1);
		this.call.cmds.setfgcolor(CLR_HDR_LABEL);
		this.call.cmds.senddata("File: ");
		this.call.cmds.setfgcolor(isTagged ? CLR_TAGGED : CLR_TITLE);
		this.call.cmds.senddata(this._truncate(file.filename || "", this._bodyWidth - 20));
		if (isTagged) {
			this.call.cmds.senddata(" ");
			this.call.cmds.setfgcolor(CLR_TAGGED);
			this.call.cmds.senddata("<Tagged>");
		}

		// Row 2: size + date
		this.call.cmds.movecursor(this._bodyLeft, 2);
		this.call.cmds.setfgcolor(CLR_HDR_LABEL);
		this.call.cmds.senddata("Size: ");
		this.call.cmds.setfgcolor(CLR_HDR_VALUE);
		this.call.cmds.senddata(this._formatFileSize(file.file_size));
		this.call.cmds.senddata("   ");
		this.call.cmds.setfgcolor(CLR_HDR_LABEL);
		this.call.cmds.senddata("Date: ");
		this.call.cmds.setfgcolor(CLR_HDR_VALUE);
		this.call.cmds.senddata(this._formatFullDate(file.upload_date));

		// Row 3: uploader + downloads
		this.call.cmds.movecursor(this._bodyLeft, 3);
		this.call.cmds.setfgcolor(CLR_HDR_LABEL);
		this.call.cmds.senddata("From: ");
		this.call.cmds.setfgcolor(CLR_HDR_VALUE);
		this.call.cmds.senddata(this._truncate(file.uploader_name || "Unknown", 30));
		this.call.cmds.senddata("   ");
		this.call.cmds.setfgcolor(CLR_HDR_LABEL);
		this.call.cmds.senddata("Downloads: ");
		this.call.cmds.setfgcolor(CLR_HDR_VALUE);
		this.call.cmds.senddata(String(file.download_count || 0));

		// Row 4: short description
		if (file.short_desc) {
			this.call.cmds.movecursor(this._bodyLeft, 4);
			this.call.cmds.setfgcolor(CLR_HDR_LABEL);
			this.call.cmds.senddata("Desc: ");
			this.call.cmds.setfgcolor(CLR_HDR_SUBJ);
			this.call.cmds.senddata(this._truncate(file.short_desc, this._bodyWidth - 8));
		}

		// Row 5: area
		this.call.cmds.movecursor(this._bodyLeft, 5);
		this.call.cmds.setfgcolor(CLR_HDR_LABEL);
		this.call.cmds.senddata("Area: ");
		this.call.cmds.setfgcolor(CLR_HDR_VALUE);
		this.call.cmds.senddata(this._truncate(this._areaName, this._bodyWidth - 8));

		// Row 6: new indicator
		if (this._isNewFile(file)) {
			this.call.cmds.movecursor(this._bodyLeft, 6);
			this.call.cmds.setfgcolor(CLR_FILE_NEW);
			this.call.cmds.senddata("** NEW **");
		}

		// Row 7: separator
		this._drawSeparator(7);

		// Body: long description
		this._drawDetailBody();

		// Status + nav
		this._drawDetailStatusBar(file);
		this._drawDetailNavBar();

		this.call.cmds.resetcolors();
	}

	_drawSeparator(row) {
		if (this.dumb) return;
		this.call.cmds.movecursor(this._bodyLeft, row);
		this.call.cmds.setfgcolor(CLR_SEPARATOR);
		for (var i = 0; i < this._bodyWidth; i++) {
			this._sendGlyph("\u2500", CP437_HLINE);
		}
	}

	_drawDetailBody() {
		if (this.dumb) return;
		for (var vi = 0; vi < this._detailBodyHeight; vi++) {
			var lineIdx = this._detailScroll + vi;
			var screenY = this._detailBodyStart + vi;
			this.call.cmds.movecursor(this._bodyLeft + 1, screenY);
			this.call.cmds.cleartoeol();

			if (lineIdx < this._detailLines.length) {
				this.call.cmds.setfgcolor(CLR_BODY);
				this.call.cmds.senddata(this._detailLines[lineIdx]);
			}
		}
		this.call.cmds.resetcolors();
	}

	_drawDetailStatusBar(file) {
		if (this.dumb) return;
		this.call.cmds.movecursor(1, this._statusRow);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(CLR_STATUS);
		var pos = " File " + (this._fileCursor + 1) + "/" + this._filteredFiles.length;
		if (this._detailLines.length > this._detailBodyHeight) {
			var pct = Math.round((this._detailScroll + this._detailBodyHeight) / this._detailLines.length * 100);
			if (pct > 100) pct = 100;
			pos += "  " + pct + "%";
		}
		this.call.cmds.senddata(pos);
		this.call.cmds.resetcolors();
	}

	_drawDetailNavBar() {
		if (this.dumb) return;
		this.call.cmds.movecursor(1, this._navRow);
		this.call.cmds.cleartoeol();
		this.call.cmds.senddata(" ");
		this._navKey("D", "Download");
		this.call.cmds.senddata("  ");
		this._navKey("T", "Tag");
		this.call.cmds.senddata("  ");
		this._sendArrowNav();
		this.call.cmds.senddata("  ");
		this._navKey("Q", "Back to List");
		if (this.call && this.call.file_batch && this.call.file_batch.length > 0) {
			this.call.cmds.senddata("  ");
			this._navKey("B", "Batch(" + this.call.file_batch.length + ")");
		}
		this.call.cmds.resetcolors();
	}

	// --- Detail body scroll ---

	_scrollDetailUp(page) {
		if (this._detailScroll <= 0) return false;
		var amount = page ? this._detailBodyHeight : 1;
		this._detailScroll = Math.max(0, this._detailScroll - amount);
		this._drawDetailBody();
		var file = this._filteredFiles[this._fileCursor];
		if (file) this._drawDetailStatusBar(file);
		return true;
	}

	_scrollDetailDown(page) {
		var maxScroll = this._detailLines.length - this._detailBodyHeight;
		if (maxScroll < 0) maxScroll = 0;
		if (this._detailScroll >= maxScroll) return false;
		var amount = page ? this._detailBodyHeight : 1;
		this._detailScroll = Math.min(maxScroll, this._detailScroll + amount);
		this._drawDetailBody();
		var file = this._filteredFiles[this._fileCursor];
		if (file) this._drawDetailStatusBar(file);
		return true;
	}

	// --- Detail prev/next ---

	_prevFile() {
		if (this._fileCursor <= 0) return;
		this._fileCursor--;
		this._showCurrentFileDetail();
	}

	_nextFile() {
		if (this._fileCursor >= this._filteredFiles.length - 1) return;
		this._fileCursor++;
		this._showCurrentFileDetail();
	}

	// --- File download ---

	async _startDownload(file) {
		if (!file || !this.call) return;
		this._pendingDownloadFile = file;
		this._pendingBatchDownload = false;
		this._showProtocolPrompt();
	}

	async _doFileTransfer(file) {
		if (!file || !this.call) return;

		// Resolve the full filesystem path
		var group = this._areaConfig ? await getGroupByShortcode(this._areaConfig.group_shortcode) : null;
		var areaPath = resolveAreaPath(group, this._areaConfig);
		var fullPath = path.join(areaPath, file.disk_path || file.filename);

		// Check file exists
		var fs = await import("fs");
		if (!fs.existsSync(fullPath)) {
			this._showTransferMessage("File not found on disk: " + file.filename, true);
			this._downloadInfoShown = true;
			return;
		}

		var protoName = this._useXmodem ? "XMODEM" : "ZMODEM";
		if (this.dumb) {
			this.call.cmds.senddata("\r\n  Starting " + protoName + " download: " + file.filename + "\r\n");
			this.call.cmds.senddata("  Your terminal should auto-detect the transfer.\r\n\r\n");
		} else {
			this._showTransferMessage("Starting " + protoName + " transfer: " + file.filename + "...", false, true);
		}

		// Pause inactivity timeouts during transfer
		this._transferring = true;

		var protocol = this._useXmodem ? new NativeXmodemProtocol(this.call) : new NativeZmodemProtocol(this.call);
		var result = await protocol.send([fullPath]);

		this._transferring = false;

		if (result.success) {
			await incrementDownloadCount(file.id);
			alogger.writeAlog(3, "File downloaded via ZMODEM: " + file.filename + " by " + (this.call.caller_username || "unknown"), "greenbright");

			if (this._hangupAfter) {
				if (this.dumb) {
					this.call.cmds.senddata("\r\n  Transfer complete! Disconnecting...\r\n");
				} else {
					this._showTransferMessage("Transfer complete! Disconnecting...", false);
				}
				var self = this;
				setTimeout(function() { self.signalHangup(); }, 1500);
				return;
			}

			if (this.dumb) {
				this.call.cmds.senddata("\r\n  Transfer complete: " + file.filename + ". Press any key...\r\n\r\n");
			} else {
				this._showTransferMessage("Transfer complete: " + file.filename + ". Press any key...", false);
			}
		} else {
			alogger.writeAlog(3, "ZMODEM download failed for " + file.filename + ": " + (result.error || "unknown"), "yellow");

			if (this.dumb) {
				this.call.cmds.senddata("\r\n  Transfer failed: " + (result.error || "unknown") + ". Press any key...\r\n\r\n");
			} else {
				this._showTransferMessage("Transfer failed: " + (result.error || "unknown"), true);
			}
		}

		// After transfer, show "press any key" before redrawing
		this._hangupResult = !this._hangupAfter;
		this._downloadInfoShown = true;
	}

	_showTransferMessage(msg, isError, noPrompt) {
		if (this.dumb) return;

		var msgRow = this._detailBodyStart || 5;
		for (var i = 0; i < (this._detailBodyHeight || 10); i++) {
			this.call.cmds.movecursor(this._bodyLeft || 1, msgRow + i);
			this.call.cmds.cleartoeol();
		}

		this.call.cmds.movecursor((this._bodyLeft || 1) + 1, msgRow + 2);
		this.call.cmds.setfgcolor(isError ? CLR_DOWNLOAD : CLR_STATUS);
		this.call.cmds.senddata(msg);
		if (!noPrompt) {
			this.call.cmds.movecursor((this._bodyLeft || 1) + 1, msgRow + 4);
			this.call.cmds.setfgcolor(CLR_STATUS);
			this.call.cmds.senddata("Press any key to continue...");
		}
		this.call.cmds.resetcolors();
	}

	// --- Protocol prompt ---

	_showProtocolPrompt() {
		this._protocolPrompt = true;
		this._useXmodem = false;
		if (this.dumb) {
			this.call.cmds.senddata("\r\n  Protocol: x/[Z]: ");
		} else {
			var msgRow = this._detailBodyStart || 5;
			for (var i = 0; i < (this._detailBodyHeight || 10); i++) {
				this.call.cmds.movecursor(this._bodyLeft || 1, msgRow + i);
				this.call.cmds.cleartoeol();
			}
			this.call.cmds.movecursor((this._bodyLeft || 1) + 1, msgRow + 2);
			this.call.cmds.setfgcolor(11);
			this.call.cmds.senddata("Protocol: [X]modem / [Z]modem (default)");
			this.call.cmds.resetcolors();
		}
	}

	// --- Hangup prompt ---

	_showHangupPrompt() {
		this._hangupPrompt = true;
		this._hangupAfter = false;
		if (this.dumb) {
			this.call.cmds.senddata("\r\n  Hang up after transfer? [Y/n]: ");
		} else {
			var msgRow = this._detailBodyStart || 5;
			for (var i = 0; i < (this._detailBodyHeight || 10); i++) {
				this.call.cmds.movecursor(this._bodyLeft || 1, msgRow + i);
				this.call.cmds.cleartoeol();
			}
			this.call.cmds.movecursor((this._bodyLeft || 1) + 1, msgRow + 2);
			this.call.cmds.setfgcolor(11);
			this.call.cmds.senddata("Hang up after transfer? [Y/n]");
			this.call.cmds.resetcolors();
		}
	}

	_runPendingDownload() {
		if (this._pendingBatchDownload) {
			this._pendingBatchDownload = false;
			this._doBatchTransfer();
		} else if (this._pendingDownloadFile) {
			var file = this._pendingDownloadFile;
			this._pendingDownloadFile = null;
			this._doFileTransfer(file);
		}
	}

	// --- Batch tagging ---

	async _toggleBatchTag(file) {
		if (!file || !this.call) return;
		var batch = this.call.file_batch;
		var userId = this._userId;
		var idx = batch.findIndex(function(b) { return b.uuid === file.uuid; });
		if (idx >= 0) {
			batch.splice(idx, 1);
			// Persist removal
			if (userId) {
				try { var bm = await import("../../models/userFileBatch.js"); await bm.removeFromBatch(userId, file.uuid); } catch (_) {}
			}
		} else {
			if (batch.length >= 50) return; // max batch size
			var item = {
				uuid: file.uuid,
				id: file.id,
				filename: file.filename,
				file_size: file.file_size,
				area_shortcode: file.area_shortcode || this._areaShortcode,
				disk_path: file.disk_path || file.filename
			};
			batch.push(item);
			// Persist addition
			if (userId) {
				try { var bm2 = await import("../../models/userFileBatch.js"); await bm2.addToBatch(userId, item); } catch (_) {}
			}
		}
	}

	_isInBatch(file) {
		if (!file || !this.call || !this.call.file_batch) return false;
		return this.call.file_batch.some(function(b) { return b.uuid === file.uuid; });
	}

	// --- Batch download ---

	async _startBatchDownload() {
		if (!this.call || !this.call.file_batch || this.call.file_batch.length === 0) {
			if (this.dumb) {
				this.call.cmds.senddata("\r\n  No files tagged for download.\r\n\r\n");
			} else {
				this._showTransferMessage("No files tagged for download.", true);
				this._downloadInfoShown = true;
			}
			return;
		}

		this._pendingDownloadFile = null;
		this._pendingBatchDownload = true;
		this._showProtocolPrompt();
	}

	async _doBatchTransfer() {
		var batch = this.call.file_batch;
		var filePaths = [];
		var fileIds = [];
		var fs = await import("fs");

		// Resolve all file paths
		for (var item of batch) {
			var area = await getAreaByShortcode(item.area_shortcode);
			if (!area) continue;
			var group = area.group_shortcode ? await (await import("../../models/fileGroups.js")).getGroupByShortcode(area.group_shortcode) : null;
			var areaPath = resolveAreaPath(group, area);
			var fullPath = path.join(areaPath, item.disk_path || item.filename);
			if (fs.existsSync(fullPath)) {
				filePaths.push(fullPath);
				fileIds.push(item.id);
			} else {
				alogger.writeAlog(3, this.loggingId + " Batch skip - file not on disk: " + item.filename, "yellow");
			}
		}

		if (filePaths.length === 0) {
			if (this.dumb) {
				this.call.cmds.senddata("\r\n  No tagged files found on disk.\r\n\r\n");
			} else {
				this._showTransferMessage("No tagged files found on disk.", true);
				this._downloadInfoShown = true;
			}
			return;
		}

		var protoName = this._useXmodem ? "XMODEM" : "ZMODEM";
		if (this.dumb) {
			this.call.cmds.senddata("\r\n  Starting " + protoName + " batch download (" + filePaths.length + " files)...\r\n\r\n");
		} else {
			this._showTransferMessage("Starting " + protoName + " batch: " + filePaths.length + " files...", false, true);
		}

		this._transferring = true;

		// ZMODEM sz supports multiple files in one invocation
		var protocol = this._useXmodem ? new NativeXmodemProtocol(this.call) : new NativeZmodemProtocol(this.call);
		var result = await protocol.send(filePaths);

		this._transferring = false;

		if (result.success) {
			// Increment download counts for all files
			for (var fid of fileIds) {
				await incrementDownloadCount(fid);
			}
			alogger.writeAlog(3, "Batch download complete: " + filePaths.length + " files by " + (this.call.caller_username || "unknown"), "greenbright");

			// Clear the batch (memory + DB)
			this.call.file_batch = [];
			if (this._userId) {
				try { var bmc = await import("../../models/userFileBatch.js"); await bmc.clearBatch(this._userId); } catch (_) {}
			}

			if (this._hangupAfter) {
				if (this.dumb) {
					this.call.cmds.senddata("\r\n  Batch complete! Disconnecting...\r\n");
				} else {
					this._showTransferMessage("Batch complete! Disconnecting...", false);
				}
				var self = this;
				setTimeout(function() { self.signalHangup(); }, 1500);
				return;
			}

			if (this.dumb) {
				this.call.cmds.senddata("\r\n  Batch transfer complete: " + filePaths.length + " files. Press any key...\r\n\r\n");
			} else {
				this._showTransferMessage("Batch complete: " + filePaths.length + " files. Press any key...", false);
			}
		} else {
			alogger.writeAlog(3, "Batch download failed: " + (result.error || "unknown"), "yellow");
			if (this.dumb) {
				this.call.cmds.senddata("\r\n  Batch transfer failed: " + (result.error || "unknown") + ". Press any key...\r\n\r\n");
			} else {
				this._showTransferMessage("Batch failed: " + (result.error || "unknown"), true);
			}
		}

		this._hangupResult = !this._hangupAfter;
		this._downloadInfoShown = true;
	}

	// ===========================================================================
	// DUMB TERMINAL RENDERING
	// ===========================================================================

	_drawFileListDumb() {
		this.call.cmds.senddata("\r\n\r\n  File Browser - " + this._areaName + "\r\n");
		this.call.cmds.senddata("  " + this._fileTotal + " files");
		var newCount = 0;
		for (var i = 0; i < this._filteredFiles.length; i++) {
			if (this._isNewFile(this._filteredFiles[i])) newCount++;
		}
		if (newCount > 0) this.call.cmds.senddata(", " + newCount + " new");
		this.call.cmds.senddata("\r\n\r\n");

		var lineCount = 0;
		for (var i = 0; i < this._filteredFiles.length; i++) {
			var file = this._filteredFiles[i];
			var marker = this._isNewFile(file) ? "*" : " ";
			var line = "  " + marker + (i + 1) + ") " + file.filename;
			line += "  " + this._formatFileSize(file.file_size);
			line += "  " + this._formatShortDate(file.upload_date);
			if (file.short_desc) {
				line += "  " + this._truncate(file.short_desc, 40);
			}
			this.call.cmds.senddata(line + "\r\n");
			lineCount++;

			if (lineCount >= 20 && i < this._filteredFiles.length - 1) {
				this.call.cmds.senddata("\r\n  [More - Enter to continue, # for detail, D# for download, Q to quit]: ");
				this._dumbInputMode = true;
				this._dumbInputBuffer = "";
				this._dumbPageStart = i + 1;
				return;
			}
		}

		this.call.cmds.senddata("\r\n  [# for detail, D# for download, S to search, M mark read, Q to quit]: ");
		this._dumbInputMode = true;
		this._dumbInputBuffer = "";
		this._dumbPageStart = -1; // No more pages
	}

	_drawFileDetailDumb(file) {
		this.call.cmds.senddata("\r\n\r\n  ---- File Detail ----\r\n");
		this.call.cmds.senddata("  File: " + (file.filename || "") + "\r\n");
		this.call.cmds.senddata("  Size: " + this._formatFileSize(file.file_size) + "\r\n");
		this.call.cmds.senddata("  Date: " + this._formatFullDate(file.upload_date) + "\r\n");
		this.call.cmds.senddata("  From: " + (file.uploader_name || "Unknown") + "\r\n");
		this.call.cmds.senddata("  Downloads: " + (file.download_count || 0) + "\r\n");
		if (file.short_desc) {
			this.call.cmds.senddata("  Desc: " + file.short_desc + "\r\n");
		}
		if (this._isNewFile(file)) {
			this.call.cmds.senddata("  ** NEW **\r\n");
		}
		if (file.long_desc) {
			this.call.cmds.senddata("\r\n");
			var lines = this._wordWrap(file.long_desc, 76);
			for (var i = 0; i < lines.length; i++) {
				this.call.cmds.senddata("  " + lines[i] + "\r\n");
			}
		}
		this.call.cmds.senddata("\r\n  Download URL: /files/download/" + file.uuid + "\r\n");
		this.call.cmds.senddata("\r\n  [Enter to go back]: ");
		this._dumbInputMode = true;
		this._dumbInputBuffer = "";
		this._dumbDetailMode = true;
	}

	// ===========================================================================
	// SEARCH MODE
	// ===========================================================================

	_enterSearch() {
		this._searchMode = true;
		this._searchBuf = "";
		this._drawFileInfoLine();
		this._drawFileStatusBar();
	}

	_exitSearch() {
		this._searchMode = false;
		this._searchBuf = "";
		this._applyFilter();
		this._fileCursor = 0;
		this._fileScroll = 0;
		this._drawFileInfoLine();
		this._drawFileRows();
		this._drawFileStatusBar();
	}

	_updateSearch() {
		if (this._searchBuf.length >= 2) {
			// Use DB-backed search for better results
			this._searchFiles(this._searchBuf).then(() => {
				if (!this.active) return;
				this._drawFileInfoLine();
				this._drawFileRows();
				this._drawFileStatusBar();
			});
		} else {
			this._applyFilter();
			this._fileCursor = 0;
			this._fileScroll = 0;
			this._drawFileInfoLine();
			this._drawFileRows();
			this._drawFileStatusBar();
		}
	}

	// ===========================================================================
	// INPUT HANDLING
	// ===========================================================================

	onKey(key) {
		if (this._protocolPrompt) {
			if (key === 'Enter') {
				this._useXmodem = false;
				this._protocolPrompt = false;
				this._showHangupPrompt();
			}
			return;
		}
		if (this._hangupPrompt) {
			if (key === 'Enter') {
				this._hangupAfter = true;
				this._hangupPrompt = false;
				this._runPendingDownload();
			}
			return;
		}

		if (this._hangupResult) {
			if (this._hangupAfter) {
				this.signalHangup();
			} else {
				this._hangupResult = false;
				if (this._state === STATE.FILE_DETAIL) {
					this._showCurrentFileDetail();
				} else {
					this._drawFileRows();
					this._drawFileStatusBar();
				}
			}
			return;
		}

		if (this.dumb && this._dumbInputMode) {
			this._onKeyDumb(key);
			return;
		}

		if (this._state === STATE.FILE_LIST) {
			this._onKeyFileList(key);
		} else if (this._state === STATE.FILE_DETAIL) {
			this._onKeyFileDetail(key);
		}
	}

	onChar(ch) {
		if (this._protocolPrompt) {
			var lower = ch.toLowerCase();
			if (lower === 'z' || ch === '\r' || ch === '\n') {
				this._useXmodem = false;
				this._protocolPrompt = false;
				this._showHangupPrompt();
			} else if (lower === 'x') {
				this._useXmodem = true;
				this._protocolPrompt = false;
				this._showHangupPrompt();
			}
			return;
		}

		if (this._hangupPrompt) {
			var lower = ch.toLowerCase();
			if (lower === 'y' || ch === '\r' || ch === '\n') {
				this._hangupAfter = true;
				this._hangupPrompt = false;
				this._runPendingDownload();
			} else if (lower === 'n') {
				this._hangupAfter = false;
				this._hangupPrompt = false;
				this._runPendingDownload();
			}
			return;
		}

		if (this._hangupResult) {
			if (this._hangupAfter) {
				this.signalHangup();
			} else {
				this._hangupResult = false;
				if (this._state === STATE.FILE_DETAIL) {
					this._showCurrentFileDetail();
				} else {
					this._drawFileRows();
					this._drawFileStatusBar();
				}
			}
			return;
		}

		if (this.dumb && this._dumbInputMode) {
			this._onCharDumb(ch);
			return;
		}

		if (this._state === STATE.FILE_LIST) {
			this._onCharFileList(ch);
		} else if (this._state === STATE.FILE_DETAIL) {
			this._onCharFileDetail(ch);
		}
	}

	// --- File list input ---

	_onKeyFileList(key) {
		if (this._searchMode) {
			this._onKeySearch(key);
			return;
		}

		switch (key) {
			case "UpArrow":
				this._fileMoveUp();
				return;
			case "DownArrow":
				this._fileMoveDown();
				return;
			case "PgUp":
				this._filePageUp();
				return;
			case "PgDn":
				this._filePageDown();
				return;
			case "Home":
				this._fileJumpFirst();
				return;
			case "End":
				this._fileJumpLast();
				return;
			case "Enter":
				if (this._filteredFiles.length > 0) {
					this._setState(STATE.FILE_DETAIL);
				}
				return;
			case "ESC":
				this.signalReturn();
				return;
		}
	}

	_onCharFileList(ch) {
		if (this._searchMode) {
			this._onCharSearch(ch);
			return;
		}

		var lower = ch.toLowerCase();
		switch (lower) {
			case "q":
				this.signalReturn();
				return;
			case "d": {
				var dlFile = this._filteredFiles[this._fileCursor];
				if (dlFile) this._startDownload(dlFile);
				return;
			}
			case "t": {
				var tagFile = this._filteredFiles[this._fileCursor];
				if (tagFile) {
					this._toggleBatchTag(tagFile);
					this._redrawFileRow(this._fileCursor);
					this._drawFileStatusBar();
				}
				return;
			}
			case "b":
				this._startBatchDownload();
				return;
			case "s":
				this._enterSearch();
				return;
			case "m":
				this._markAreaRead().then(() => {
					if (!this.active) return;
					this._drawFileRows();
					this._drawFileStatusBar();
				});
				return;
		}
	}

	// --- Search input ---

	_onKeySearch(key) {
		switch (key) {
			case "ESC":
				this._exitSearch();
				return;
			case "Enter":
				this._searchMode = false;
				this._drawFileInfoLine();
				if (this._filteredFiles.length > 0) {
					this._drawFileStatusBar();
				}
				return;
			case "Backspace":
				if (this._searchBuf.length > 0) {
					this._searchBuf = this._searchBuf.slice(0, -1);
					this._updateSearch();
				}
				return;
			case "UpArrow":
				this._fileMoveUp();
				return;
			case "DownArrow":
				this._fileMoveDown();
				return;
		}
	}

	_onCharSearch(ch) {
		this._searchBuf += ch;
		this._updateSearch();
	}

	// --- File detail input ---

	_onKeyFileDetail(key) {
		// If download info is shown, any key goes back to the detail view
		if (this._downloadInfoShown) {
			this._downloadInfoShown = false;
			if (this._hangupResult) {
				this._hangupResult = false;
				if (this._hangupAfter) { this.signalHangup(); return; }
			}
			this._showCurrentFileDetail();
			return;
		}

		switch (key) {
			case "UpArrow":
				this._scrollDetailUp(false);
				return;
			case "DownArrow":
				this._scrollDetailDown(false);
				return;
			case "PgUp":
				this._scrollDetailUp(true);
				return;
			case "PgDn":
				this._scrollDetailDown(true);
				return;
			case "LeftArrow":
				this._prevFile();
				return;
			case "RightArrow":
				this._nextFile();
				return;
			case "ESC":
				this._setState(STATE.FILE_LIST);
				return;
		}
	}

	_onCharFileDetail(ch) {
		// If download info is shown, any key goes back
		if (this._downloadInfoShown) {
			this._downloadInfoShown = false;
			if (this._hangupResult) {
				this._hangupResult = false;
				if (this._hangupAfter) { this.signalHangup(); return; }
			}
			this._showCurrentFileDetail();
			return;
		}

		var lower = ch.toLowerCase();
		switch (lower) {
			case "q":
				this._setState(STATE.FILE_LIST);
				return;
			case "d": {
				var dlFile2 = this._filteredFiles[this._fileCursor];
				if (dlFile2) this._startDownload(dlFile2);
				return;
			}
			case "t": {
				var tagFile2 = this._filteredFiles[this._fileCursor];
				if (tagFile2) {
					this._toggleBatchTag(tagFile2);
					this._showCurrentFileDetail();
				}
				return;
			}
			case "b":
				this._startBatchDownload();
				return;
			case " ":
				// Space = page down
				this._scrollDetailDown(true);
				return;
		}
	}

	// --- Dumb terminal input ---

	_onKeyDumb(key) {
		switch (key) {
			case "Enter":
				if (this._dumbDetailMode) {
					this._dumbDetailMode = false;
					this._setState(STATE.FILE_LIST);
					return;
				}
				if (this._dumbInputBuffer.length > 0) {
					this._dumbProcessInput();
				} else if (this._dumbPageStart >= 0) {
					// Continue pagination
					this._dumbContinuePaging();
				}
				return;
			case "Backspace":
				if (this._dumbInputBuffer.length > 0) {
					this.call.cmds.senddata("\b \b");
					this._dumbInputBuffer = this._dumbInputBuffer.slice(0, -1);
				}
				return;
			case "ESC":
				if (this._dumbDetailMode) {
					this._dumbDetailMode = false;
					this._setState(STATE.FILE_LIST);
				} else {
					this.signalReturn();
				}
				return;
		}
	}

	_onCharDumb(ch) {
		if (this._dumbDetailMode) {
			// Any char goes back to list
			this._dumbDetailMode = false;
			this._setState(STATE.FILE_LIST);
			return;
		}
		var lower = ch.toLowerCase();
		if (lower === "q") {
			this.signalReturn();
			return;
		}
		if (lower === "m") {
			this._markAreaRead().then(() => {
				if (!this.active) return;
				this.call.cmds.senddata("\r\n  All files marked as read.\r\n");
				this._setState(STATE.FILE_LIST);
			});
			return;
		}
		if (lower === "s") {
			this.call.cmds.senddata("\r\n  Search: ");
			this._dumbSearchMode = true;
			this._dumbInputBuffer = "";
			return;
		}
		// Accumulate input (number or 'd' prefix)
		this._dumbInputBuffer += ch;
		this.call.cmds.senddata(ch);
	}

	_dumbProcessInput() {
		var input = this._dumbInputBuffer.trim();
		this._dumbInputBuffer = "";

		if (this._dumbSearchMode) {
			this._dumbSearchMode = false;
			if (input.length > 0) {
				this._searchFiles(input).then(() => {
					if (!this.active) return;
					this._drawFileListDumb();
				});
			} else {
				this._applyFilter();
				this._drawFileListDumb();
			}
			return;
		}

		// Check for "d#" download command
		if (input.toLowerCase().startsWith("d")) {
			var numStr = input.substring(1);
			var num = parseInt(numStr);
			if (!isNaN(num) && num >= 1 && num <= this._filteredFiles.length) {
				var file = this._filteredFiles[num - 1];
				this.call.cmds.senddata("\r\n\r\n  Download: " + file.filename + "\r\n");
				this._startDownload(file);
			} else {
				this.call.cmds.senddata("\r\n  Invalid file number.\r\n");
			}
			this.call.cmds.senddata("\r\n  [# for detail, D# for download, Q to quit]: ");
			this._dumbInputMode = true;
			return;
		}

		// Try as a number for detail view
		var num = parseInt(input);
		if (!isNaN(num) && num >= 1 && num <= this._filteredFiles.length) {
			this._fileCursor = num - 1;
			var file = this._filteredFiles[this._fileCursor];
			this._advancePointerToFile(file);
			this._setState(STATE.FILE_DETAIL);
			return;
		}

		this.call.cmds.senddata("\r\n  Invalid input.\r\n");
		this.call.cmds.senddata("  [# for detail, D# for download, Q to quit]: ");
		this._dumbInputMode = true;
	}

	_dumbContinuePaging() {
		// Continue displaying from where we left off
		var start = this._dumbPageStart;
		var lineCount = 0;
		for (var i = start; i < this._filteredFiles.length; i++) {
			var file = this._filteredFiles[i];
			var marker = this._isNewFile(file) ? "*" : " ";
			var line = "  " + marker + (i + 1) + ") " + file.filename;
			line += "  " + this._formatFileSize(file.file_size);
			line += "  " + this._formatShortDate(file.upload_date);
			if (file.short_desc) {
				line += "  " + this._truncate(file.short_desc, 40);
			}
			this.call.cmds.senddata(line + "\r\n");
			lineCount++;

			if (lineCount >= 20 && i < this._filteredFiles.length - 1) {
				this.call.cmds.senddata("\r\n  [More - Enter to continue, # for detail, D# for download, Q to quit]: ");
				this._dumbPageStart = i + 1;
				return;
			}
		}

		this.call.cmds.senddata("\r\n  [# for detail, D# for download, S to search, M mark read, Q to quit]: ");
		this._dumbPageStart = -1;
	}

	// ===========================================================================
	// LIFECYCLE
	// ===========================================================================

	run() {
		if (!this._areaShortcode) {
			if (this.dumb) {
				this.call.cmds.senddata("\r\n  No file area selected.\r\n");
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
						this.call.cmds.senddata("\r\n  Could not load file area.\r\n");
					}
					setTimeout(() => { if (this.active) this.signalReturn(); }, 1000);
					return;
				}

				return this._loadFileList().then(() => {
					if (!this.active) return;
					this._setState(STATE.FILE_LIST);
				});
			})
			.catch(err => {
				if (!this.active) return;
				alogger.writeAlog(3, this.loggingId + " run error: " + (err?.stack || err), "redbright");
				this.signalReturn();
			});
	}

	clearHandler() {
		if (!this.active) return;
		this._files = [];
		this._filteredFiles = [];
		this._detailLines = [];
		this._areaConfig = null;
		super.clearHandler();
	}
}

export { fileBrowser };
