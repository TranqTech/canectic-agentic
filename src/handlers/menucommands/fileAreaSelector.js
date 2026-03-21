import { BaseSubModule } from "../basesubmodule.js";
import { updateUserFileGroup, updateUserFileArea } from "../../models/useraccounts.js";
import { getActiveGroups } from "../../models/fileGroups.js";
import { getAreasInGroup } from "../../models/fileAreas.js";
import * as userFilePointers from "../../models/userFilePointers.js";
import * as alogger from "../../utils/alogger.js";

// Row types in the flattened list
const ROW_GROUP = "group";
const ROW_AREA = "area";

// Parse JSONB flags from DB — may be JSON string, array, or null
function parseFlags(val) {
	if (!val) return [];
	if (Array.isArray(val)) return val;
	if (typeof val === "string") {
		try { var p = JSON.parse(val); return Array.isArray(p) ? p : []; }
		catch (_) { return []; }
	}
	return [];
}

// Check if user has read access to a group or area
function checkBrowseFlags(userRecord, item) {
	var userSecurity = parseInt(userRecord.security) || 0;
	// browse_security gates visibility; falls back to read_security if not set
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

// Default colors
const df_title_clr = 14;
const df_group_clr = 11;
const df_area_clr = 15;
const df_highlight_fg = 15;
const df_highlight_bg = 4;
const df_current_clr = 10;
const df_prompt_clr = 11;
const df_search_clr = 14;
const df_status_clr = 8;
const df_nav_clr = 11;
const df_nav_label_clr = 7;
const df_error_clr = 9;
const df_new_clr = 10;

// CP437 bytes (extended range 0x80-0xFF)
const CP437_CORNER = 0xDA;
const CP437_ARROW  = 0xAF;
const CP437_BULLET = 0xF9;

class fileAreaSelector extends BaseSubModule {
	constructor(call) {
		super(call, "FileAreaSelector");

		// Full data
		this.allRows = [];
		this.filteredRows = [];
		this.areaCount = 0;

		// Lightbar state
		this.cursorIdx = 0;
		this.scrollOffset = 0;

		// Search
		this.searchMode = false;
		this.searchBuffer = "";

		// Geometry
		this.titleRow = 1;
		this.infoRow = 2;
		this.listStartRow = 3;
		this.listStartCol = 2;
		this.statusRow = 0;
		this.viewportHeight = 0;

		// Colors (could come from theme)
		var theme = call.theme || {};
		this.title_clr = theme.title_clr || df_title_clr;
		this.group_clr = theme.group_clr || df_group_clr;
		this.area_clr = theme.area_clr || df_area_clr;
		this.highlight_fg = theme.highlight_fg || df_highlight_fg;
		this.highlight_bg = theme.highlight_bg || df_highlight_bg;
		this.current_clr = theme.current_clr || df_current_clr;
		this.prompt_clr = theme.prompt_clr || df_prompt_clr;
		this.search_clr = theme.search_clr || df_search_clr;
		this.status_clr = theme.status_clr || df_status_clr;
		this.nav_clr = theme.nav_clr || df_nav_clr;
		this.nav_label_clr = theme.nav_label_clr || df_nav_label_clr;
		this.error_clr = theme.error_clr || df_error_clr;
		this.new_clr = theme.new_clr || df_new_clr;

		this.loggingId = "FileAreaSelector (Node " + call.nodenum + ")";

		// Encoding
		var enc = (call.term_encoding || "").toLowerCase();
		this._isUTF8 = (enc === "utf8" || enc === "utf-8");

		// User ID for pointer lookups
		this._userId = null;
		if (call.user_record) {
			this._userId = call.user_record.id || call.user_record.user_id || null;
		}
	}

	// Send a display glyph that respects terminal encoding.
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
		this.call.cmds.setfgcolor(this.nav_clr);
		this.call.cmds.senddata(key);
		if (label) {
			this.call.cmds.setfgcolor(this.nav_label_clr);
			this.call.cmds.senddata(" " + label);
		}
	}

	// --- Data loading ---

	async _loadData() {
		var groups = await getActiveGroups();
		if (!groups || groups.length === 0) {
			return false;
		}

		var userRec = this.call.user_record || {};

		// Filter groups by security level + read flags
		groups = groups.filter(function(g) { return checkBrowseFlags(userRec, g); });

		this.allRows = [];
		this.areaCount = 0;

		for (var g = 0; g < groups.length; g++) {
			var group = groups[g];
			var areas = await getAreasInGroup(group.shortcode);

			// Filter to active areas accessible to user
			areas = (areas || []).filter(function(a) {
				if (!a.active) return false;
				return checkBrowseFlags(userRec, a);
			});

			// Only show groups that have at least one accessible area
			if (!areas || areas.length === 0) continue;

			this.allRows.push({
				type: ROW_GROUP,
				name: group.name,
				shortcode: group.shortcode,
				description: group.description || ""
			});

			for (var a = 0; a < areas.length; a++) {
				var area = areas[a];

				// Get new file count for this area
				var newCount = 0;
				if (this._userId) {
					try {
						newCount = await userFilePointers.getNewCount(this._userId, area.shortcode, area.id);
					} catch (_) {}
				}

				this.allRows.push({
					type: ROW_AREA,
					name: area.name,
					shortcode: area.shortcode,
					groupShortcode: group.shortcode,
					groupName: group.name,
					description: area.description || "",
					fileCount: area.file_count || 0,
					newCount: newCount,
					areaId: area.id
				});
				this.areaCount++;
			}
		}

		return this.areaCount > 0;
	}

	// --- Filtering ---

	_applyFilter() {
		if (!this.searchBuffer || this.searchBuffer.length === 0) {
			this.filteredRows = this.allRows.slice();
			return;
		}

		var term = this.searchBuffer.toLowerCase();
		this.filteredRows = [];

		var lastGroupRow = null;
		for (var i = 0; i < this.allRows.length; i++) {
			var row = this.allRows[i];
			if (row.type === ROW_GROUP) {
				lastGroupRow = row;
				continue;
			}
			if (row.name.toLowerCase().includes(term) ||
				row.shortcode.toLowerCase().includes(term) ||
				row.description.toLowerCase().includes(term) ||
				row.groupName.toLowerCase().includes(term)) {

				if (lastGroupRow && (this.filteredRows.length === 0 ||
					this.filteredRows[this.filteredRows.length - 1] !== lastGroupRow)) {
					this.filteredRows.push(lastGroupRow);
				}
				this.filteredRows.push(row);
			}
		}
	}

	_firstAreaIdx() {
		for (var i = 0; i < this.filteredRows.length; i++) {
			if (this.filteredRows[i].type === ROW_AREA) return i;
		}
		return -1;
	}

	_findCurrentAreaIdx() {
		if (!this.call.file_area) return this._firstAreaIdx();
		var currentShort = this.call.file_area.toUpperCase();
		for (var i = 0; i < this.filteredRows.length; i++) {
			if (this.filteredRows[i].type === ROW_AREA &&
				this.filteredRows[i].shortcode.toUpperCase() === currentShort) {
				return i;
			}
		}
		return this._firstAreaIdx();
	}

	_moveToNextArea(direction) {
		var idx = this.cursorIdx + direction;
		while (idx >= 0 && idx < this.filteredRows.length) {
			if (this.filteredRows[idx].type === ROW_AREA) {
				this.cursorIdx = idx;
				this._ensureVisible();
				return true;
			}
			idx += direction;
		}
		return false;
	}

	_pageMove(direction) {
		var moves = this.viewportHeight - 1;
		for (var i = 0; i < moves; i++) {
			if (!this._moveToNextArea(direction)) break;
		}
	}

	_jumpToFirst() {
		var idx = this._firstAreaIdx();
		if (idx >= 0) {
			this.cursorIdx = idx;
			this._ensureVisible();
		}
	}

	_jumpToLast() {
		for (var i = this.filteredRows.length - 1; i >= 0; i--) {
			if (this.filteredRows[i].type === ROW_AREA) {
				this.cursorIdx = i;
				this._ensureVisible();
				return;
			}
		}
	}

	_ensureVisible() {
		if (this.cursorIdx < this.scrollOffset) {
			this.scrollOffset = this.cursorIdx;
			if (this.scrollOffset > 0 && this.filteredRows[this.scrollOffset - 1].type === ROW_GROUP) {
				this.scrollOffset--;
			}
		} else if (this.cursorIdx >= this.scrollOffset + this.viewportHeight) {
			this.scrollOffset = this.cursorIdx - this.viewportHeight + 1;
		}
	}

	// --- Geometry ---

	_calcGeometry() {
		if (this.dumb) return;
		var termH = this.call.term_height || 24;
		this.statusRow = termH;
		this.viewportHeight = this.statusRow - this.listStartRow;
		if (this.viewportHeight < 3) this.viewportHeight = 3;
	}

	// --- Drawing ---

	_drawScreen() {
		if (this.dumb) {
			this._drawDumb();
			return;
		}
		this.call.cmds.clearscreen();
		this._drawTitle();
		this._drawInfoLine();
		this._drawList();
		this._drawStatusLine();
	}

	_drawTitle() {
		if (this.dumb) return;
		this.call.cmds.movecursor(this.listStartCol, this.titleRow);
		this.call.cmds.setfgcolor(this.title_clr);
		this.call.cmds.senddata("File Area Selector");
		this.call.cmds.resetcolors();
	}

	_drawInfoLine() {
		if (this.dumb) return;
		this.call.cmds.movecursor(this.listStartCol, this.infoRow);
		this.call.cmds.cleartoeol();

		if (this.searchMode) {
			this.call.cmds.setfgcolor(this.search_clr);
			this.call.cmds.senddata("Search: " + this.searchBuffer + "_");
		} else if (this.call.file_area) {
			this.call.cmds.setfgcolor(this.status_clr);
			this.call.cmds.senddata("Current: ");
			this.call.cmds.setfgcolor(this.current_clr);
			this.call.cmds.senddata((this.call.file_group_title || this.call.file_group || "") +
				" / " + (this.call.file_area_title || this.call.file_area || ""));
		} else {
			this.call.cmds.setfgcolor(this.status_clr);
			this.call.cmds.senddata("No area selected");
		}
		this.call.cmds.resetcolors();
	}

	_drawList() {
		if (this.dumb) return;
		var termW = this.call.term_width || 80;
		var maxNameLen = termW - this.listStartCol - 4;
		if (maxNameLen < 10) maxNameLen = 10;

		for (var vi = 0; vi < this.viewportHeight; vi++) {
			var rowIdx = this.scrollOffset + vi;
			var screenY = this.listStartRow + vi;

			this.call.cmds.movecursor(this.listStartCol, screenY);
			this.call.cmds.cleartoeol();

			if (rowIdx >= this.filteredRows.length) continue;

			var row = this.filteredRows[rowIdx];
			var isHighlighted = (rowIdx === this.cursorIdx);

			if (row.type === ROW_GROUP) {
				this._drawGroupRow(row, screenY, maxNameLen);
			} else {
				this._drawAreaRow(row, screenY, maxNameLen, isHighlighted);
			}

			this.call.cmds.resetcolors();
		}
	}

	_drawGroupRow(row, screenY, maxLen) {
		this.call.cmds.movecursor(this.listStartCol, screenY);
		this.call.cmds.setfgcolor(this.group_clr);
		this._sendGlyph("\u250C", CP437_CORNER);
		var text = " " + row.name;
		if (text.length + 1 > maxLen) text = text.substring(0, maxLen - 1);
		this.call.cmds.senddata(text);
	}

	_drawAreaRow(row, screenY, maxLen, isHighlighted) {
		this.call.cmds.movecursor(this.listStartCol, screenY);

		var isCurrent = (this.call.file_area &&
			row.shortcode.toUpperCase() === this.call.file_area.toUpperCase());

		if (isHighlighted) {
			this.call.cmds.setfgcolor(this.highlight_fg);
			this.call.cmds.setbgcolor(this.highlight_bg);
		} else if (isCurrent) {
			this.call.cmds.setfgcolor(this.current_clr);
		} else {
			this.call.cmds.setfgcolor(this.area_clr);
		}

		// Prefix (3 visual columns)
		var usedCols = 0;
		if (isHighlighted) {
			this.call.cmds.senddata(" ");
			this._sendGlyph("\u25BA", CP437_ARROW);
			this.call.cmds.senddata(" ");
		} else {
			this.call.cmds.senddata("   ");
		}
		usedCols += 3;

		// Current-area marker (2 visual columns)
		if (isCurrent) {
			this._sendGlyph("\u2022", CP437_BULLET);
			this.call.cmds.senddata(" ");
		} else {
			this.call.cmds.senddata("  ");
		}
		usedCols += 2;

		// Right-side info: file count + new count
		var infoStr = "";
		if (row.fileCount > 0) {
			infoStr = " [" + row.fileCount + " files";
			if (row.newCount > 0) {
				infoStr += ", " + row.newCount + " new";
			}
			infoStr += "]";
		} else if (row.newCount > 0) {
			infoStr = " [" + row.newCount + " new]";
		}

		var remainingCols = maxLen - usedCols;
		var nameDescLen = remainingCols - infoStr.length;
		if (nameDescLen < 10) nameDescLen = 10;

		// Build text part (name + optional description)
		var textPart = row.name;
		if (row.description && textPart.length + 3 + row.description.length <= nameDescLen) {
			textPart = textPart + " - " + row.description;
		}
		if (textPart.length > nameDescLen) {
			textPart = textPart.substring(0, nameDescLen);
		}
		this.call.cmds.senddata(textPart);
		usedCols += textPart.length;

		// New count in distinct color (unless highlighted)
		if (infoStr.length > 0) {
			if (!isHighlighted && row.newCount > 0) {
				this.call.cmds.setfgcolor(this.new_clr);
			} else if (!isHighlighted) {
				this.call.cmds.setfgcolor(this.status_clr);
			}
			this.call.cmds.senddata(infoStr);
			usedCols += infoStr.length;
		}

		// Pad highlighted row so the blue bar spans the full width
		if (isHighlighted && usedCols < maxLen) {
			var pad = "";
			for (var p = usedCols; p < maxLen; p++) pad += " ";
			this.call.cmds.senddata(pad);
		}
	}

	_drawStatusLine() {
		if (this.dumb) return;
		this.call.cmds.movecursor(this.listStartCol, this.statusRow);
		this.call.cmds.cleartoeol();

		var areaIdx = this._countAreasBefore(this.cursorIdx) + 1;
		var posStr = this.areaCount > 0 ? " " + areaIdx + "/" + this.areaCount : "";

		if (this.searchMode) {
			this._navKey("Enter", "Select");
			this.call.cmds.senddata("  ");
			this._navKey("Esc", "Cancel Search");
		} else {
			this._navKey("Enter", "Select");
			this.call.cmds.senddata("  ");
			this._navKey("S", "Search");
			this.call.cmds.senddata("  ");
			this._navKey("Q", "Cancel");
		}

		if (posStr) {
			this.call.cmds.setfgcolor(this.status_clr);
			this.call.cmds.senddata(posStr);
		}

		this.call.cmds.resetcolors();
	}

	_countAreasBefore(idx) {
		var count = 0;
		for (var i = 0; i <= idx && i < this.filteredRows.length; i++) {
			if (this.filteredRows[i].type === ROW_AREA) count++;
		}
		return count;
	}

	_redrawRow(rowIdx) {
		if (this.dumb) return;
		var vi = rowIdx - this.scrollOffset;
		if (vi < 0 || vi >= this.viewportHeight) return;

		var screenY = this.listStartRow + vi;
		var row = this.filteredRows[rowIdx];
		if (!row) return;

		var termW = this.call.term_width || 80;
		var maxNameLen = termW - this.listStartCol - 4;
		if (maxNameLen < 10) maxNameLen = 10;

		this.call.cmds.movecursor(this.listStartCol, screenY);
		this.call.cmds.cleartoeol();

		var isHighlighted = (rowIdx === this.cursorIdx);

		if (row.type === ROW_GROUP) {
			this._drawGroupRow(row, screenY, maxNameLen);
		} else {
			this._drawAreaRow(row, screenY, maxNameLen, isHighlighted);
		}

		this.call.cmds.resetcolors();
	}

	// --- Dumb terminal fallback ---

	_drawDumb() {
		this.call.cmds.senddata("\r\n\r\n  File Area Selector\r\n");
		if (this.call.file_area) {
			this.call.cmds.senddata("  Current: " +
				(this.call.file_group_title || this.call.file_group || "") +
				" / " + (this.call.file_area_title || this.call.file_area || "") + "\r\n");
		}
		this.call.cmds.senddata("\r\n");

		var num = 0;
		for (var i = 0; i < this.filteredRows.length; i++) {
			var row = this.filteredRows[i];
			if (row.type === ROW_GROUP) {
				this.call.cmds.senddata("\r\n  -- " + row.name + " --\r\n");
			} else {
				num++;
				var marker = (this.call.file_area &&
					row.shortcode.toUpperCase() === this.call.file_area.toUpperCase())
					? "*" : " ";
				var line = "  " + marker + num + ") " + row.name;
				if (row.description) {
					line += " - " + row.description;
				}
				if (row.fileCount > 0) {
					line += " [" + row.fileCount + " files]";
				}
				if (row.newCount > 0) {
					line += " (" + row.newCount + " new)";
				}
				this.call.cmds.senddata(line + "\r\n");
			}
		}

		this.call.cmds.senddata("\r\n  Enter number to select, Q to quit: ");
		this._dumbInputMode = true;
		this._dumbInputBuffer = "";
		this._dumbAreaList = this.filteredRows.filter(r => r.type === ROW_AREA);
	}

	// --- Selection ---

	_selectCurrent() {
		if (this.cursorIdx < 0 || this.cursorIdx >= this.filteredRows.length) return;
		var row = this.filteredRows[this.cursorIdx];
		if (row.type !== ROW_AREA) return;

		this.call.file_group = row.groupShortcode;
		this.call.file_group_title = row.groupName;
		this.call.file_area = row.shortcode;
		this.call.file_area_title = row.name;

		// Persist to user record
		updateUserFileGroup(this.call.caller_username, row.groupShortcode);
		updateUserFileArea(this.call.caller_username, row.shortcode);

		alogger.writeAlog(5, this.loggingId + " Selected: " + row.groupShortcode + "/" + row.shortcode, "greenbright");
		this.signalReturn();
	}

	// --- Search mode ---

	_enterSearch() {
		this.searchMode = true;
		this.searchBuffer = "";
		this._drawInfoLine();
		this._drawStatusLine();
	}

	_exitSearch() {
		this.searchMode = false;
		this.searchBuffer = "";
		this._applyFilter();
		this.cursorIdx = this._findCurrentAreaIdx();
		if (this.cursorIdx < 0) this.cursorIdx = this._firstAreaIdx();
		this._ensureVisible();
		this._drawInfoLine();
		this._drawList();
		this._drawStatusLine();
	}

	_updateSearch() {
		this._applyFilter();
		var firstArea = this._firstAreaIdx();
		if (firstArea >= 0) {
			this.cursorIdx = firstArea;
		} else {
			this.cursorIdx = 0;
		}
		this.scrollOffset = 0;
		this._drawInfoLine();
		this._drawList();
		this._drawStatusLine();
	}

	// --- Input ---

	onKey(key) {
		if (this.dumb && this._dumbInputMode) {
			this._onKeyDumb(key);
			return;
		}

		if (this.searchMode) {
			this._onKeySearch(key);
			return;
		}

		switch (key) {
			case "UpArrow": {
				var prevIdx = this.cursorIdx;
				var prevScroll = this.scrollOffset;
				if (this._moveToNextArea(-1)) {
					if (this.scrollOffset !== prevScroll) {
						this._drawList();
					} else {
						this._redrawRow(prevIdx);
						this._redrawRow(this.cursorIdx);
					}
					this._drawStatusLine();
				}
				return;
			}
			case "DownArrow": {
				var prevIdx = this.cursorIdx;
				var prevScroll = this.scrollOffset;
				if (this._moveToNextArea(1)) {
					if (this.scrollOffset !== prevScroll) {
						this._drawList();
					} else {
						this._redrawRow(prevIdx);
						this._redrawRow(this.cursorIdx);
					}
					this._drawStatusLine();
				}
				return;
			}
			case "PgUp":
				this._pageMove(-1);
				this._drawList();
				this._drawStatusLine();
				return;
			case "PgDn":
				this._pageMove(1);
				this._drawList();
				this._drawStatusLine();
				return;
			case "Home":
				this._jumpToFirst();
				this._drawList();
				this._drawStatusLine();
				return;
			case "End":
				this._jumpToLast();
				this._drawList();
				this._drawStatusLine();
				return;
			case "Enter":
				this._selectCurrent();
				return;
			case "ESC":
				this.signalReturn();
				return;
		}
	}

	onChar(ch) {
		if (this.dumb && this._dumbInputMode) {
			this._onCharDumb(ch);
			return;
		}

		if (this.searchMode) {
			this._onCharSearch(ch);
			return;
		}

		var lower = ch.toLowerCase();
		if (lower === "q") {
			this.signalReturn();
			return;
		}
		if (lower === "s") {
			this._enterSearch();
			return;
		}
	}

	_onKeySearch(key) {
		switch (key) {
			case "ESC":
				this._exitSearch();
				return;
			case "Enter":
				if (this._firstAreaIdx() >= 0) {
					this.searchMode = false;
					this._selectCurrent();
				} else {
					this._exitSearch();
				}
				return;
			case "Backspace":
				if (this.searchBuffer.length > 0) {
					this.searchBuffer = this.searchBuffer.slice(0, -1);
					this._updateSearch();
				}
				return;
			case "UpArrow": {
				var prevIdx = this.cursorIdx;
				var prevScroll = this.scrollOffset;
				if (this._moveToNextArea(-1)) {
					if (this.scrollOffset !== prevScroll) {
						this._drawList();
					} else {
						this._redrawRow(prevIdx);
						this._redrawRow(this.cursorIdx);
					}
					this._drawStatusLine();
				}
				return;
			}
			case "DownArrow": {
				var prevIdx = this.cursorIdx;
				var prevScroll = this.scrollOffset;
				if (this._moveToNextArea(1)) {
					if (this.scrollOffset !== prevScroll) {
						this._drawList();
					} else {
						this._redrawRow(prevIdx);
						this._redrawRow(this.cursorIdx);
					}
					this._drawStatusLine();
				}
				return;
			}
		}
	}

	_onCharSearch(ch) {
		this.searchBuffer += ch;
		this._updateSearch();
	}

	// --- Dumb terminal input ---

	_onKeyDumb(key) {
		switch (key) {
			case "Enter":
				if (this._dumbInputBuffer.length > 0) {
					this._dumbTrySelect();
				}
				return;
			case "Backspace":
				if (this._dumbInputBuffer.length > 0) {
					this.call.cmds.senddata("\b \b");
					this._dumbInputBuffer = this._dumbInputBuffer.slice(0, -1);
				}
				return;
			case "ESC":
				this.signalReturn();
				return;
		}
	}

	_onCharDumb(ch) {
		if (ch.toLowerCase() === "q") {
			this.signalReturn();
			return;
		}
		if (/[0-9]/.test(ch)) {
			this._dumbInputBuffer += ch;
			this.call.cmds.senddata(ch);
			return;
		}
	}

	_dumbTrySelect() {
		var num = parseInt(this._dumbInputBuffer);
		this._dumbInputBuffer = "";
		if (isNaN(num) || num < 1 || num > this._dumbAreaList.length) {
			this.call.cmds.senddata("\r\n  Invalid selection.\r\n  Enter number to select, Q to quit: ");
			return;
		}
		var row = this._dumbAreaList[num - 1];
		this.call.file_group = row.groupShortcode;
		this.call.file_group_title = row.groupName;
		this.call.file_area = row.shortcode;
		this.call.file_area_title = row.name;
		updateUserFileGroup(this.call.caller_username, row.groupShortcode);
		updateUserFileArea(this.call.caller_username, row.shortcode);
		this.call.cmds.senddata("\r\n  Selected: " + row.groupName + " / " + row.name + "\r\n");
		alogger.writeAlog(5, this.loggingId + " Selected: " + row.groupShortcode + "/" + row.shortcode, "greenbright");
		this.signalReturn();
	}

	// --- Lifecycle ---

	run() {
		this._loadData()
			.then(hasAreas => {
				if (!this.active) return;
				if (!hasAreas) {
					if (this.dumb) {
						this.call.cmds.senddata("\r\n  No file areas available.\r\n");
					} else {
						this.call.cmds.clearscreen();
						this.call.cmds.movecursor(this.listStartCol, this.listStartRow);
						this.call.cmds.setfgcolor(this.error_clr);
						this.call.cmds.senddata("No file areas available.");
						this.call.cmds.resetcolors();
					}
					setTimeout(() => {
						if (this.active) this.signalReturn();
					}, 1500);
					return;
				}

				this._applyFilter();
				this._calcGeometry();
				this.cursorIdx = this._findCurrentAreaIdx();
				if (this.cursorIdx < 0) this.cursorIdx = this._firstAreaIdx();
				this._ensureVisible();
				this._drawScreen();
			})
			.catch(err => {
				if (!this.active) return;
				alogger.writeAlog(3, this.loggingId + " load error: " + (err?.stack || err), "redbright");
				this.signalReturn();
			});
	}
}

export { fileAreaSelector };
