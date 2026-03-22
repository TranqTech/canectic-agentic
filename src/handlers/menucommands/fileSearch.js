// fileSearch.js - Terminal file search
//
// Prompts for search scope (current area, current group, or global),
// then a search term. Displays results in a lightbar list with file
// detail view. Filters by browse permission.

import { BaseSubModule } from "../basesubmodule.js";
import { getAreaByShortcode } from "../../models/fileAreas.js";
import { getGroupByShortcode } from "../../models/fileGroups.js";
import { searchEntries, incrementDownloadCount } from "../../models/fileEntries.js";
import { resolveAreaPath } from "../../models/fileAreas.js";
import { getAreasInGroup, getActiveAreas } from "../../models/fileAreas.js";
import { ZmodemProtocol } from "../../protocols/zmodem.js";
import * as alogger from "../../utils/alogger.js";
import * as path from "path";

// --- Access control ---

function parseFlags(val) {
	if (!val) return [];
	if (Array.isArray(val)) return val;
	if (typeof val === "string") {
		try { var p = JSON.parse(val); return Array.isArray(p) ? p : []; }
		catch (_) { return []; }
	}
	return [];
}

function checkBrowseAccess(userRecord, item) {
	if (!item) return false;
	var userSecurity = parseInt(userRecord.security) || 0;
	var browseSec = item.browse_security !== null && item.browse_security !== undefined
		? parseInt(item.browse_security)
		: (item.read_security ? parseInt(item.read_security) : 0);
	if (userSecurity < browseSec) return false;
	var userPerms  = parseFlags(userRecord.permissionflags);
	var userRestrs = parseFlags(userRecord.restrictionflags);
	var reqFlags   = parseFlags(item.browse_perm_flags || item.read_perm_flags);
	var restFlags  = parseFlags(item.browse_rest_flags || item.read_rest_flags);
	if (reqFlags.length > 0 && !reqFlags.every(function(f) { return userPerms.includes(f); })) return false;
	if (restFlags.length > 0 && restFlags.some(function(f) { return userRestrs.includes(f); })) return false;
	return true;
}

function checkDownloadAccess(userRecord, item) {
	if (!item) return false;
	var userSecurity = parseInt(userRecord.security) || 0;
	if (item.read_security && userSecurity < parseInt(item.read_security)) return false;
	var userPerms  = parseFlags(userRecord.permissionflags);
	var userRestrs = parseFlags(userRecord.restrictionflags);
	var reqFlags   = parseFlags(item.read_perm_flags);
	var restFlags  = parseFlags(item.read_rest_flags);
	if (reqFlags.length > 0 && !reqFlags.every(function(f) { return userPerms.includes(f); })) return false;
	if (restFlags.length > 0 && restFlags.some(function(f) { return userRestrs.includes(f); })) return false;
	return true;
}

// Colors
const CLR_TITLE = 14;
const CLR_PROMPT = 11;
const CLR_INPUT = 15;
const CLR_FILE = 15;
const CLR_BAR_FG = 15;
const CLR_BAR_BG = 4;
const CLR_STATUS = 8;
const CLR_NAV = 11;
const CLR_NAV_LABEL = 7;
const CLR_HDR_LABEL = 6;
const CLR_HDR_VALUE = 10;
const CLR_ERROR = 9;
const CLR_AREA = 3;

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const STATE = {
	SCOPE: 'scope',
	INPUT: 'input',
	RESULTS: 'results',
	DETAIL: 'detail'
};

class fileSearch extends BaseSubModule {
	constructor(call) {
		super(call, "FileSearch");

		var enc = (call.term_encoding || "").toLowerCase();
		this._isUTF8 = (enc === "utf8" || enc === "utf-8");
		this._state = null;
		this._scope = null;      // 'area', 'group', 'global'
		this._searchTerm = "";
		this._inputBuffer = "";
		this._results = [];
		this._cursor = 0;
		this._scroll = 0;
		this._userRecord = call.user_record || {};

		// Geometry
		this._bodyWidth = Math.min(call.term_width || 80, 100);
		this._bodyLeft = Math.floor(((call.term_width || 80) - this._bodyWidth) / 2) + 1;
		this._listStart = 4;
		this._listHeight = (call.term_height || 24) - 6;  // header(3) + status(1) + nav(1) + 1
		this._statusRow = (call.term_height || 24) - 1;
		this._navRow = call.term_height || 24;

		this._downloadInfoShown = false;
	}

	async run() {
		if (this.dumb) {
			this._runDumb();
			return;
		}
		this._setState(STATE.SCOPE);
	}

	_setState(state) {
		this._state = state;
		switch (state) {
			case STATE.SCOPE:
				this._drawScopeScreen();
				break;
			case STATE.INPUT:
				this._drawInputScreen();
				break;
			case STATE.RESULTS:
				this._drawResultsScreen();
				break;
			case STATE.DETAIL:
				this._drawDetailScreen();
				break;
		}
	}

	// ===== SCOPE SELECTION =====

	_drawScopeScreen() {
		this.call.cmds.clearscreen();
		this.call.cmds.movecursor(this._bodyLeft, 1);
		this.call.cmds.setfgcolor(CLR_TITLE);
		this.call.cmds.senddata("File Search");

		this.call.cmds.movecursor(this._bodyLeft, 3);
		this.call.cmds.setfgcolor(CLR_PROMPT);
		this.call.cmds.senddata("Search scope:");

		this.call.cmds.movecursor(this._bodyLeft + 2, 5);
		this.call.cmds.setfgcolor(CLR_NAV);
		this.call.cmds.senddata("A");
		this.call.cmds.setfgcolor(CLR_NAV_LABEL);
		this.call.cmds.senddata(" - Current area");
		if (this.call.file_area) {
			this.call.cmds.setfgcolor(CLR_AREA);
			this.call.cmds.senddata(" (" + this.call.file_area + ")");
		}

		this.call.cmds.movecursor(this._bodyLeft + 2, 6);
		this.call.cmds.setfgcolor(CLR_NAV);
		this.call.cmds.senddata("G");
		this.call.cmds.setfgcolor(CLR_NAV_LABEL);
		this.call.cmds.senddata(" - Current group");
		if (this.call.file_group) {
			this.call.cmds.setfgcolor(CLR_AREA);
			this.call.cmds.senddata(" (" + this.call.file_group + ")");
		}

		this.call.cmds.movecursor(this._bodyLeft + 2, 7);
		this.call.cmds.setfgcolor(CLR_NAV);
		this.call.cmds.senddata("S");
		this.call.cmds.setfgcolor(CLR_NAV_LABEL);
		this.call.cmds.senddata(" - Search all areas");

		this.call.cmds.movecursor(this._bodyLeft + 2, 9);
		this.call.cmds.setfgcolor(CLR_NAV);
		this.call.cmds.senddata("Q");
		this.call.cmds.setfgcolor(CLR_NAV_LABEL);
		this.call.cmds.senddata(" - Cancel");

		this.call.cmds.resetcolors();
	}

	// ===== SEARCH INPUT =====

	_drawInputScreen() {
		this.call.cmds.clearscreen();
		this.call.cmds.movecursor(this._bodyLeft, 1);
		this.call.cmds.setfgcolor(CLR_TITLE);
		var scopeLabel = this._scope === 'area' ? "Area: " + (this.call.file_area || "?")
			: this._scope === 'group' ? "Group: " + (this.call.file_group || "?")
			: "All Areas";
		this.call.cmds.senddata("File Search - " + scopeLabel);

		this.call.cmds.movecursor(this._bodyLeft, 3);
		this.call.cmds.setfgcolor(CLR_PROMPT);
		this.call.cmds.senddata("Enter search term: ");
		this.call.cmds.setfgcolor(CLR_INPUT);

		this._inputBuffer = "";
	}

	// ===== RESULTS LIST =====

	_drawResultsScreen() {
		this.call.cmds.clearscreen();

		// Header
		this.call.cmds.movecursor(this._bodyLeft, 1);
		this.call.cmds.setfgcolor(CLR_TITLE);
		this.call.cmds.senddata("Search: \"" + this._truncate(this._searchTerm, 30) + "\" - " + this._results.length + " result(s)");

		// Column header
		this.call.cmds.movecursor(this._bodyLeft, 3);
		this.call.cmds.setfgcolor(CLR_STATUS);
		var colHdr = "  " + this._padRight("Filename", 25) + " " + this._padRight("Area", 15) + " " + this._padLeft("Size", 8) + " " + this._padRight("Description", 20);
		this.call.cmds.senddata(this._truncate(colHdr, this._bodyWidth));

		this._drawResultRows();
		this._drawResultNav();
		this.call.cmds.resetcolors();
	}

	_drawResultRows() {
		for (var vi = 0; vi < this._listHeight; vi++) {
			var idx = this._scroll + vi;
			var screenY = this._listStart + vi;
			this.call.cmds.movecursor(this._bodyLeft, screenY);
			this.call.cmds.cleartoeol();

			if (idx >= this._results.length) continue;

			var r = this._results[idx];
			var isHl = (idx === this._cursor);

			if (isHl) {
				this.call.cmds.setfgcolor(CLR_BAR_FG);
				this.call.cmds.setbgcolor(CLR_BAR_BG);
			} else {
				this.call.cmds.setfgcolor(CLR_FILE);
			}

			if (isHl) {
				this.call.cmds.senddata(" ");
				this._sendGlyph("\u25BA", 0xAF);
			} else {
				this.call.cmds.senddata("  ");
			}
			var prefix = null;

			var fname = this._padRight(this._truncate(r.filename || "", 25), 25);
			var area = this._padRight(this._truncate(r._areaName || r.area_shortcode || "", 15), 15);
			var size = this._padLeft(this._formatSize(r.file_size), 8);
			var desc = this._padRight(this._truncate(r.short_desc || "", 20), 20);

			this.call.cmds.senddata(fname + " " + area + " " + size + " " + desc);

			if (isHl) {
				var written = 2 + fname.length + 1 + area.length + 1 + size.length + 1 + desc.length;
				var pad = this._bodyWidth - written;
				if (pad > 0) this.call.cmds.senddata(" ".repeat(pad));
			}

			this.call.cmds.resetcolors();
		}
	}

	_drawResultNav() {
		this.call.cmds.movecursor(1, this._navRow);
		this.call.cmds.cleartoeol();
		this.call.cmds.senddata(" ");
		this._navKey("Enter", "Detail");
		this.call.cmds.senddata("  ");
		this._navKey("D", "Download");
		this.call.cmds.senddata("  ");
		this._navKey("T", "Tag");
		this.call.cmds.senddata("  ");
		this._navKey("N", "New Search");
		this.call.cmds.senddata("  ");
		this._navKey("Q", "Back");
		if (this.call.file_batch && this.call.file_batch.length > 0) {
			this.call.cmds.senddata("  ");
			this._navKey("B", "Batch(" + this.call.file_batch.length + ")");
		}
		this.call.cmds.resetcolors();
	}

	// ===== DETAIL VIEW =====

	_drawDetailScreen() {
		if (this._cursor < 0 || this._cursor >= this._results.length) return;
		var f = this._results[this._cursor];

		this.call.cmds.clearscreen();

		var isTagged = this._isInBatch(f);

		this.call.cmds.movecursor(this._bodyLeft, 1);
		this.call.cmds.setfgcolor(CLR_HDR_LABEL);
		this.call.cmds.senddata("File: ");
		this.call.cmds.setfgcolor(isTagged ? 13 : CLR_TITLE);
		this.call.cmds.senddata(this._truncate(f.filename || "", this._bodyWidth - 20));
		if (isTagged) {
			this.call.cmds.senddata(" ");
			this.call.cmds.setfgcolor(13);
			this.call.cmds.senddata("<Tagged>");
		}

		this.call.cmds.movecursor(this._bodyLeft, 2);
		this.call.cmds.setfgcolor(CLR_HDR_LABEL);
		this.call.cmds.senddata("Area: ");
		this.call.cmds.setfgcolor(CLR_HDR_VALUE);
		this.call.cmds.senddata((f._groupName ? f._groupName + " / " : "") + (f._areaName || f.area_shortcode || ""));
		this.call.cmds.senddata("   ");
		this.call.cmds.setfgcolor(CLR_HDR_LABEL);
		this.call.cmds.senddata("Size: ");
		this.call.cmds.setfgcolor(CLR_HDR_VALUE);
		this.call.cmds.senddata(this._formatSize(f.file_size));

		this.call.cmds.movecursor(this._bodyLeft, 3);
		this.call.cmds.setfgcolor(CLR_HDR_LABEL);
		this.call.cmds.senddata("From: ");
		this.call.cmds.setfgcolor(CLR_HDR_VALUE);
		this.call.cmds.senddata(f.uploader_name || "Unknown");
		this.call.cmds.senddata("   ");
		this.call.cmds.setfgcolor(CLR_HDR_LABEL);
		this.call.cmds.senddata("Downloads: ");
		this.call.cmds.setfgcolor(CLR_HDR_VALUE);
		this.call.cmds.senddata(String(f.download_count || 0));

		// Separator
		this.call.cmds.movecursor(1, 4);
		for (var i = 0; i < (this.call.term_width || 80); i++) {
			if (this._isUTF8) { this.call.cmds.senddata("\u2500"); }
			else { this.call.cmds.senddata(Buffer.from([0xC4])); }
		}

		// Description
		if (f.short_desc || f.long_desc) {
			this.call.cmds.movecursor(this._bodyLeft, 6);
			this.call.cmds.setfgcolor(CLR_PROMPT);
			if (f.long_desc) {
				var lines = f.long_desc.split('\n');
				for (var li = 0; li < lines.length && li < this._listHeight; li++) {
					this.call.cmds.movecursor(this._bodyLeft, 6 + li);
					this.call.cmds.senddata(this._truncate(lines[li], this._bodyWidth - 2));
				}
			} else {
				this.call.cmds.senddata(f.short_desc);
			}
		}

		// Nav
		this.call.cmds.movecursor(1, this._navRow);
		this.call.cmds.cleartoeol();
		this.call.cmds.senddata(" ");
		this._navKey("D", "Download");
		this.call.cmds.senddata("  ");
		this._navKey("T", "Tag");
		this.call.cmds.senddata("  ");
		this.call.cmds.setfgcolor(CLR_NAV);
		this._sendGlyph("\u2190", 0x3C);  // ← or < for CP437
		this.call.cmds.senddata("/");
		this._sendGlyph("\u2192", 0x3E);  // → or > for CP437
		this.call.cmds.setfgcolor(CLR_NAV_LABEL);
		this.call.cmds.senddata(" Prev/Next");
		this.call.cmds.senddata("  ");
		this._navKey("Q", "Back to Results");
		this.call.cmds.resetcolors();
	}

	// ===== HELPERS =====

	_navKey(key, label) {
		this.call.cmds.setfgcolor(CLR_NAV);
		this.call.cmds.senddata(key);
		this.call.cmds.setfgcolor(CLR_NAV_LABEL);
		this.call.cmds.senddata(" " + label);
	}

	_sendGlyph(utf8Char, cp437Byte) {
		if (this._isUTF8) { this.call.cmds.senddata(utf8Char); }
		else { this.call.cmds.senddata(Buffer.from([cp437Byte])); }
	}

	_truncate(s, len) { return s.length > len ? s.substring(0, len) : s; }
	_padRight(s, len) { while (s.length < len) s += " "; return s; }
	_padLeft(s, len) { while (s.length < len) s = " " + s; return s; }

	_formatSize(bytes) {
		var n = parseInt(bytes) || 0;
		if (n <= 0) return "0 B";
		var sizes = ['B', 'KB', 'MB', 'GB'];
		var i = Math.floor(Math.log(n) / Math.log(1024));
		if (i >= sizes.length) i = sizes.length - 1;
		return (n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + sizes[i];
	}

	_isInBatch(file) {
		if (!file || !this.call || !this.call.file_batch) return false;
		return this.call.file_batch.some(function(b) { return b.uuid === file.uuid; });
	}

	async _toggleBatchTag(file) {
		if (!file || !this.call) return;
		var batch = this.call.file_batch;
		var userId = this._userRecord ? this._userRecord.id : null;
		var idx = batch.findIndex(function(b) { return b.uuid === file.uuid; });
		if (idx >= 0) {
			batch.splice(idx, 1);
			if (userId) {
				try { var bm = await import("../../models/userFileBatch.js"); await bm.removeFromBatch(userId, file.uuid); } catch (_) {}
			}
		} else {
			if (batch.length >= 50) return;
			var item = {
				uuid: file.uuid,
				id: file.id,
				filename: file.filename,
				file_size: file.file_size,
				area_shortcode: file.area_shortcode,
				disk_path: file.disk_path || file.filename
			};
			batch.push(item);
			if (userId) {
				try { var bm2 = await import("../../models/userFileBatch.js"); await bm2.addToBatch(userId, item); } catch (_) {}
			}
		}
	}

	_ensureVisible() {
		if (this._cursor < this._scroll) this._scroll = this._cursor;
		if (this._cursor >= this._scroll + this._listHeight) this._scroll = this._cursor - this._listHeight + 1;
	}

	// ===== SEARCH EXECUTION =====

	async _executeSearch() {
		var term = this._inputBuffer.trim();
		if (term.length === 0) {
			this._setState(STATE.INPUT);
			return;
		}
		this._searchTerm = term;
		this._results = [];

		var userRec = this._userRecord;
		var allResults = [];

		if (this._scope === 'area' && this.call.file_area) {
			var area = await getAreaByShortcode(this.call.file_area);
			if (area) {
				allResults = await searchEntries(term, { limit: 200, areaId: area.id });
				for (var r of allResults) {
					r._areaName = area.name;
					r._areaShortcode = area.shortcode;
					r._groupName = "";
				}
			}
		} else if (this._scope === 'group' && this.call.file_group) {
			var areas = await getAreasInGroup(this.call.file_group);
			areas = (areas || []).filter(function(a) { return a.active && checkBrowseAccess(userRec, a); });
			for (var a of areas) {
				var areaResults = await searchEntries(term, { limit: 100, areaId: a.id });
				for (var ar of areaResults) {
					ar._areaName = a.name;
					ar._areaShortcode = a.shortcode;
					ar._groupName = this.call.file_group;
				}
				allResults = allResults.concat(areaResults);
			}
		} else {
			allResults = await searchEntries(term, { limit: 200 });
		}

		// Filter by browse access
		for (var entry of allResults) {
			if (this._scope === 'area') {
				// Already scoped to a single area
				this._results.push(entry);
			} else {
				var entryArea = entry._areaShortcode ? await getAreaByShortcode(entry._areaShortcode) : (entry.area_shortcode ? await getAreaByShortcode(entry.area_shortcode) : null);
				if (entryArea && checkBrowseAccess(userRec, entryArea)) {
					if (!entry._areaName) entry._areaName = entryArea.name;
					if (!entry._areaShortcode) entry._areaShortcode = entryArea.shortcode;
					if (!entry._groupName && entryArea.group_shortcode) {
						var grp = await getGroupByShortcode(entryArea.group_shortcode);
						entry._groupName = grp ? grp.name : "";
					}
					this._results.push(entry);
				}
			}
		}

		if (this._results.length > 100) this._results = this._results.slice(0, 100);

		this._cursor = 0;
		this._scroll = 0;

		if (this._results.length === 0) {
			this.call.cmds.clearscreen();
			this.call.cmds.movecursor(this._bodyLeft, 3);
			this.call.cmds.setfgcolor(CLR_ERROR);
			this.call.cmds.senddata("No results found for \"" + this._searchTerm + "\"");
			this.call.cmds.movecursor(this._bodyLeft, 5);
			this.call.cmds.setfgcolor(CLR_STATUS);
			this.call.cmds.senddata("Press any key...");
			this.call.cmds.resetcolors();
			this._downloadInfoShown = true;
			this._returnToInput = true;
			return;
		}

		this._setState(STATE.RESULTS);
	}

	// ===== DOWNLOAD =====

	async _doDownload(file) {
		if (!file) return;
		var area = file._areaShortcode ? await getAreaByShortcode(file._areaShortcode) : null;
		if (!area || !checkDownloadAccess(this._userRecord, area)) {
			this.call.cmds.movecursor(this._bodyLeft, this._statusRow);
			this.call.cmds.cleartoeol();
			this.call.cmds.setfgcolor(CLR_ERROR);
			this.call.cmds.senddata("  You do not have download access to this area.");
			this.call.cmds.resetcolors();
			return;
		}

		this._pendingDownloadFile = file;
		this._hangupPrompt = true;
		this._hangupAfter = false;

		if (this.dumb) {
			this.call.cmds.senddata("\r\n  Hang up after transfer? [Y/n]: ");
		} else {
			this.call.cmds.movecursor(this._bodyLeft, this._statusRow);
			this.call.cmds.cleartoeol();
			this.call.cmds.setfgcolor(CLR_PROMPT);
			this.call.cmds.senddata("  Hang up after transfer? [Y/n]");
			this.call.cmds.resetcolors();
		}
	}

	async _doFileTransfer(file) {
		if (!file) return;
		this._pendingDownloadFile = null;

		var area = file._areaShortcode ? await getAreaByShortcode(file._areaShortcode) : null;
		if (!area) return;

		var group = area.group_shortcode ? await getGroupByShortcode(area.group_shortcode) : null;
		var areaPath = resolveAreaPath(group, area);
		var fullPath = path.join(areaPath, file.disk_path || file.filename);

		var fs = await import("fs");
		if (!fs.existsSync(fullPath)) {
			this.call.cmds.movecursor(this._bodyLeft, this._statusRow);
			this.call.cmds.cleartoeol();
			this.call.cmds.setfgcolor(CLR_ERROR);
			this.call.cmds.senddata("  File not found on disk.");
			this.call.cmds.resetcolors();
			return;
		}

		var protocol = new ZmodemProtocol(this.call);
		var result = await protocol.send([fullPath]);

		if (result.success) {
			await incrementDownloadCount(file.id);
			alogger.writeAlog(3, "File downloaded via search: " + file.filename + " by " + (this.call.caller_username || "unknown"), "greenbright");

			if (this._hangupAfter) {
				if (this.dumb) {
					this.call.cmds.senddata("\r\n  Transfer complete! Disconnecting...\r\n");
				} else {
					this.call.cmds.movecursor(this._bodyLeft, this._statusRow);
					this.call.cmds.cleartoeol();
					this.call.cmds.setfgcolor(10);
					this.call.cmds.senddata("  Transfer complete! Disconnecting...");
					this.call.cmds.resetcolors();
				}
				var self = this;
				setTimeout(function() { self.signalHangup(); }, 1500);
				return;
			}

			if (this.dumb) {
				this.call.cmds.senddata("\r\n  Transfer complete. Press any key...\r\n");
			} else {
				this.call.cmds.movecursor(this._bodyLeft, this._statusRow);
				this.call.cmds.cleartoeol();
				this.call.cmds.setfgcolor(10);
				this.call.cmds.senddata("  Transfer complete. Press any key...");
				this.call.cmds.resetcolors();
			}
		} else {
			alogger.writeAlog(3, "Search download failed: " + file.filename + ": " + (result.error || "unknown"), "yellow");
			if (this.dumb) {
				this.call.cmds.senddata("\r\n  Transfer failed. Press any key...\r\n");
			} else {
				this.call.cmds.movecursor(this._bodyLeft, this._statusRow);
				this.call.cmds.cleartoeol();
				this.call.cmds.setfgcolor(CLR_ERROR);
				this.call.cmds.senddata("  Transfer failed: " + (result.error || "unknown") + ". Press any key...");
				this.call.cmds.resetcolors();
			}
		}

		this._hangupResult = !this._hangupAfter;
		this._downloadInfoShown = true;
	}

	// ===== INPUT HANDLING =====

	onKey(key) {
		if (!this.active || !this.call) return;

		if (this._hangupPrompt) return;

		if (this._hangupResult) {
			if (this._hangupAfter) {
				this.signalHangup();
			} else {
				this._hangupResult = false;
				if (this._state === STATE.RESULTS) {
					this._drawResultsScreen();
				} else if (this._state === STATE.DETAIL) {
					this._drawDetailScreen();
				}
			}
			return;
		}

		if (this._downloadInfoShown) {
			this._downloadInfoShown = false;
			if (this._returnToInput) {
				this._returnToInput = false;
				this._setState(STATE.INPUT);
			} else if (this._state === STATE.RESULTS) {
				this._drawResultsScreen();
			} else if (this._state === STATE.DETAIL) {
				this._drawDetailScreen();
			}
			return;
		}

		if (this._state === STATE.INPUT) {
			if (key === "Enter") {
				this._executeSearch();
			} else if (key === "ESC") {
				this.signalReturn();
			} else if (key === "Backspace") {
				if (this._inputBuffer.length > 0) {
					this._inputBuffer = this._inputBuffer.slice(0, -1);
					this.call.cmds.senddata("\b \b");
				}
			}
			return;
		}

		if (this._state === STATE.RESULTS) {
			switch (key) {
				case "UpArrow":
					if (this._cursor > 0) { this._cursor--; this._ensureVisible(); this._drawResultRows(); }
					return;
				case "DownArrow":
					if (this._cursor < this._results.length - 1) { this._cursor++; this._ensureVisible(); this._drawResultRows(); }
					return;
				case "PgUp":
					this._cursor = Math.max(0, this._cursor - this._listHeight);
					this._ensureVisible(); this._drawResultRows();
					return;
				case "PgDn":
					this._cursor = Math.min(this._results.length - 1, this._cursor + this._listHeight);
					this._ensureVisible(); this._drawResultRows();
					return;
				case "Home":
					this._cursor = 0; this._ensureVisible(); this._drawResultRows();
					return;
				case "End":
					this._cursor = this._results.length - 1; this._ensureVisible(); this._drawResultRows();
					return;
				case "Enter":
					this._setState(STATE.DETAIL);
					return;
				case "ESC":
					this.signalReturn();
					return;
			}
			return;
		}

		if (this._state === STATE.DETAIL) {
			switch (key) {
				case "LeftArrow":
					if (this._cursor > 0) { this._cursor--; this._drawDetailScreen(); }
					return;
				case "RightArrow":
					if (this._cursor < this._results.length - 1) { this._cursor++; this._drawDetailScreen(); }
					return;
				case "ESC":
					this._setState(STATE.RESULTS);
					return;
			}
			return;
		}
	}

	onChar(ch) {
		if (!this.active || !this.call) return;

		if (this._hangupPrompt) {
			var lower = ch.toLowerCase();
			if (lower === 'y' || ch === '\r' || ch === '\n') {
				this._hangupAfter = true;
				this._hangupPrompt = false;
				this._doFileTransfer(this._pendingDownloadFile);
			} else if (lower === 'n') {
				this._hangupAfter = false;
				this._hangupPrompt = false;
				this._doFileTransfer(this._pendingDownloadFile);
			}
			return;
		}

		if (this._hangupResult) {
			if (this._hangupAfter) {
				this.signalHangup();
			} else {
				this._hangupResult = false;
				if (this._state === STATE.RESULTS) {
					this._drawResultsScreen();
				} else if (this._state === STATE.DETAIL) {
					this._drawDetailScreen();
				}
			}
			return;
		}

		if (this._downloadInfoShown) {
			this._downloadInfoShown = false;
			if (this._returnToInput) {
				this._returnToInput = false;
				this._setState(STATE.INPUT);
			} else if (this._state === STATE.RESULTS) {
				this._drawResultsScreen();
			} else if (this._state === STATE.DETAIL) {
				this._drawDetailScreen();
			}
			return;
		}

		if (this._state === STATE.SCOPE) {
			var lower = ch.toLowerCase();
			if (lower === 'a') { this._scope = 'area'; this._setState(STATE.INPUT); }
			else if (lower === 'g') { this._scope = 'group'; this._setState(STATE.INPUT); }
			else if (lower === 's') { this._scope = 'global'; this._setState(STATE.INPUT); }
			else if (lower === 'q') { this.signalReturn(); }
			return;
		}

		if (this._state === STATE.INPUT) {
			if (ch.length === 1 && ch.charCodeAt(0) >= 32) {
				this._inputBuffer += ch;
				this.call.cmds.setfgcolor(CLR_INPUT);
				this.call.cmds.senddata(ch);
			}
			return;
		}

		if (this._state === STATE.RESULTS) {
			var lower2 = ch.toLowerCase();
			switch (lower2) {
				case 'q':
					this.signalReturn();
					return;
				case 'd': {
					var file = this._results[this._cursor];
					if (file) this._doDownload(file);
					return;
				}
				case 't': {
					var tFile = this._results[this._cursor];
					if (tFile) {
						this._toggleBatchTag(tFile);
						this._drawResultRows();
						this._drawResultNav();
					}
					return;
				}
				case 'n':
					this._setState(STATE.INPUT);
					return;
				case 'b':
					// Delegate to batch download in fileBrowser if tagged
					// For now just show count
					if (this.call.file_batch && this.call.file_batch.length > 0) {
						this.call.cmds.movecursor(this._bodyLeft, this._statusRow);
						this.call.cmds.cleartoeol();
						this.call.cmds.setfgcolor(CLR_STATUS);
						this.call.cmds.senddata("  " + this.call.file_batch.length + " file(s) tagged. Use Download Batch from menu.");
						this.call.cmds.resetcolors();
					}
					return;
			}
			return;
		}

		if (this._state === STATE.DETAIL) {
			var lower3 = ch.toLowerCase();
			switch (lower3) {
				case 'q':
					this._setState(STATE.RESULTS);
					return;
				case 'd': {
					var dFile = this._results[this._cursor];
					if (dFile) this._doDownload(dFile);
					return;
				}
				case 't': {
					var tFile2 = this._results[this._cursor];
					if (tFile2) {
						this._toggleBatchTag(tFile2);
						this._drawDetailScreen();
					}
					return;
				}
			}
			return;
		}
	}

	// ===== DUMB TERMINAL =====

	async _runDumb() {
		this.call.cmds.senddata("\r\n  File Search\r\n");
		this.call.cmds.senddata("  [A]rea, [G]roup, [S]earch All, [Q]uit: ");
		this._state = STATE.SCOPE;
	}
}

export { fileSearch };
