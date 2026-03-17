import { BaseSubModule } from "../basesubmodule.js";
import { updateUserMsgGroup, updateUserMsgArea } from "../../models/useraccounts.js";
import { listMsgGroups, getAreasInGroup } from "../../models/messages.js";
import * as alogger from "../../utils/alogger.js";

// Lazy-import subscription module
var _subsMod = null;
async function getSubsMod() {
	if (!_subsMod) {
		try {
			_subsMod = await import("../../models/userAreaSubs.js");
		} catch (_) {
			_subsMod = {};
		}
	}
	return _subsMod;
}

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

// Check if user has read access to an area (flag check only — security level
// is already filtered by the DB query in listMsgGroups / getAreasInGroup)
function checkReadFlags(userRecord, area) {
	var userPerms  = parseFlags(userRecord.permissionflags);
	var userRestrs = parseFlags(userRecord.restrictionflags);
	var reqFlags   = parseFlags(area.read_perm_flags);
	var restFlags  = parseFlags(area.read_rest_flags);
	if (reqFlags.length > 0 && !reqFlags.every(function(f) { return userPerms.includes(f); })) return false;
	if (restFlags.length > 0 && restFlags.some(function(f) { return userRestrs.includes(f); })) return false;
	return true;
}

// Check if user has post access to an area (security level + flags)
function checkPostAccess(userRecord, area) {
	var userSecurity = parseInt(userRecord.security) || 0;
	if (area.post_security && userSecurity < area.post_security) return false;
	var userPerms  = parseFlags(userRecord.permissionflags);
	var userRestrs = parseFlags(userRecord.restrictionflags);
	var reqFlags   = parseFlags(area.post_perm_flags);
	var restFlags  = parseFlags(area.post_rest_flags);
	if (reqFlags.length > 0 && !reqFlags.every(function(f) { return userPerms.includes(f); })) return false;
	if (restFlags.length > 0 && restFlags.some(function(f) { return userRestrs.includes(f); })) return false;
	return true;
}

// Default colors
const df_title_clr = 14;
const df_group_clr = 11;
const df_area_clr = 15;
const df_highlight_fg = 15;   // Bright white text on the bar
const df_highlight_bg = 4;    // Blue background bar
const df_current_clr = 10;
const df_prompt_clr = 11;
const df_search_clr = 14;
const df_status_clr = 8;
const df_nav_clr = 11;
const df_nav_label_clr = 7;
const df_error_clr = 9;

// CP437 bytes (extended range 0x80-0xFF — safe, won't be interpreted as control codes)
// 0xDA = ┌  (box drawing top-left corner)
// 0xAF = »  (right-pointing double angle — arrow indicator)
// 0xF9 = ∙  (bullet operator — current marker)
const CP437_CORNER = 0xDA;
const CP437_ARROW  = 0xAF;
const CP437_BULLET = 0xF9;

class msgAreaSelector extends BaseSubModule {
	constructor(call) {
		super(call, "MsgAreaSelector");

		// Full data
		this.allRows = [];        // Flattened: { type, name, shortcode, groupShortcode?, groupName?, description? }
		this.filteredRows = [];   // Currently displayed (filtered or full)
		this.areaCount = 0;

		// Lightbar state
		this.cursorIdx = 0;       // Index into filteredRows (always points to an area row)
		this.scrollOffset = 0;    // First visible row in the viewport

		// Search
		this.searchMode = false;
		this.searchBuffer = "";

		// Geometry
		this.titleRow = 1;
		this.infoRow = 2;
		this.listStartRow = 3;
		this.listStartCol = 2;
		this.statusRow = 0;       // Calculated
		this.viewportHeight = 0;  // Calculated

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

		this.loggingId = "MsgAreaSelector (Node " + call.nodenum + ")";

		// Encoding — determines which character set to use for glyphs
		var enc = (call.term_encoding || "").toLowerCase();
		this._isUTF8 = (enc === "utf8" || enc === "utf-8");

		// User ID for subscription lookups
		this._userId = null;
		if (call.user_record) {
			this._userId = call.user_record.id || call.user_record.user_id || null;
		}

		// Subscription state: { shortcode: true/false }
		this._subMap = {};
	}

	// Send a display glyph that respects terminal encoding.
	// UTF-8 terminals get the Unicode character; CP437 terminals get the raw byte.
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
		var groups = await listMsgGroups(this.call.security);
		if (!groups || groups.length === 0) {
			return false;
		}

		// Filter groups by read flags (security level already filtered by DB query)
		var userRec = this.call.user_record || {};
		if (userRec.permissionflags || userRec.restrictionflags) {
			groups = groups.filter(function(g) { return checkReadFlags(userRec, g); });
		}

		this.allRows = [];
		this.areaCount = 0;

		for (var g = 0; g < groups.length; g++) {
			var group = groups[g];
			var areas = await getAreasInGroup(group.shortcode, this.call.security);

			// Filter areas by read flags
			if (userRec.permissionflags || userRec.restrictionflags) {
				areas = (areas || []).filter(function(a) { return checkReadFlags(userRec, a); });
			}

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
				this.allRows.push({
					type: ROW_AREA,
					name: area.name,
					shortcode: area.shortcode,
					groupShortcode: group.shortcode,
					groupName: group.name,
					description: area.description || "",
					msgCount: area.msg_count || 0,
					lastFrom: area.last_from || "",
					lastMessage: area.last_message || null,
					newscan_default: (area.newscan_default === undefined || area.newscan_default === null) ? true : area.newscan_default
				});
				this.areaCount++;
			}
		}

		// Load subscription state
		if (this._userId) {
			var subsMod = await getSubsMod();
			if (subsMod.getSubscriptionMap) {
				try {
					var areasWithDefaults = this.allRows
						.filter(r => r.type === ROW_AREA)
						.map(r => ({ shortcode: r.shortcode, newscan_default: r.newscan_default }));
					this._subMap = await subsMod.getSubscriptionMap(this._userId, areasWithDefaults);
				} catch (_) {
					this._subMap = {};
				}
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

		// Find areas that match, and include their parent group headers
		var lastGroupRow = null;
		for (var i = 0; i < this.allRows.length; i++) {
			var row = this.allRows[i];
			if (row.type === ROW_GROUP) {
				lastGroupRow = row;
				continue;
			}
			// Area row — check if name, shortcode, or description matches
			if (row.name.toLowerCase().includes(term) ||
				row.shortcode.toLowerCase().includes(term) ||
				row.description.toLowerCase().includes(term) ||
				row.groupName.toLowerCase().includes(term)) {

				// Include the parent group header if not already added
				if (lastGroupRow && (this.filteredRows.length === 0 ||
					this.filteredRows[this.filteredRows.length - 1] !== lastGroupRow)) {
					this.filteredRows.push(lastGroupRow);
				}
				this.filteredRows.push(row);
			}
		}
	}

	// Find the index of the first area row in filteredRows
	_firstAreaIdx() {
		for (var i = 0; i < this.filteredRows.length; i++) {
			if (this.filteredRows[i].type === ROW_AREA) return i;
		}
		return -1;
	}

	// Find the index of the area matching the user's current area
	_findCurrentAreaIdx() {
		if (!this.call.msg_area) return this._firstAreaIdx();
		var currentShort = this.call.msg_area.toUpperCase();
		for (var i = 0; i < this.filteredRows.length; i++) {
			if (this.filteredRows[i].type === ROW_AREA &&
				this.filteredRows[i].shortcode.toUpperCase() === currentShort) {
				return i;
			}
		}
		return this._firstAreaIdx();
	}

	// Move cursor to the next area row in a direction (1 = down, -1 = up)
	_moveToNextArea(direction) {
		var startIdx = this.cursorIdx;
		var idx = startIdx + direction;
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

	// Page up/down by viewport height
	_pageMove(direction) {
		var moves = this.viewportHeight - 1;
		for (var i = 0; i < moves; i++) {
			if (!this._moveToNextArea(direction)) break;
		}
	}

	// Jump to first/last area
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

	// Ensure the cursor is within the visible viewport
	_ensureVisible() {
		if (this.cursorIdx < this.scrollOffset) {
			this.scrollOffset = this.cursorIdx;
			// Scroll up a bit more to show context (group header above if possible)
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
		this.call.cmds.senddata("Message Area Selector");
		this.call.cmds.resetcolors();
	}

	_drawInfoLine() {
		if (this.dumb) return;
		this.call.cmds.movecursor(this.listStartCol, this.infoRow);
		this.call.cmds.cleartoeol();

		if (this.searchMode) {
			this.call.cmds.setfgcolor(this.search_clr);
			this.call.cmds.senddata("Search: " + this.searchBuffer + "_");
		} else if (this.call.msg_area) {
			this.call.cmds.setfgcolor(this.status_clr);
			this.call.cmds.senddata("Current: ");
			this.call.cmds.setfgcolor(this.current_clr);
			this.call.cmds.senddata((this.call.msg_group_title || this.call.msg_group || "") +
				" / " + (this.call.msg_area_title || this.call.msg_area || ""));
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
		// Send box-drawing corner glyph as encoding-appropriate byte(s)
		this._sendGlyph("\u250C", CP437_CORNER);
		// Then send the rest as plain ASCII
		var text = " " + row.name;
		if (text.length + 1 > maxLen) text = text.substring(0, maxLen - 1);
		this.call.cmds.senddata(text);
	}

	_drawAreaRow(row, screenY, maxLen, isHighlighted) {
		this.call.cmds.movecursor(this.listStartCol, screenY);

		var isCurrent = (this.call.msg_area &&
			row.shortcode.toUpperCase() === this.call.msg_area.toUpperCase());
		var isSubscribed = this._subMap[row.shortcode] !== undefined ? this._subMap[row.shortcode] : true;

		if (isHighlighted) {
			this.call.cmds.setfgcolor(this.highlight_fg);
			this.call.cmds.setbgcolor(this.highlight_bg);
		} else if (isCurrent) {
			this.call.cmds.setfgcolor(this.current_clr);
		} else if (!isSubscribed) {
			this.call.cmds.setfgcolor(this.status_clr); // Dim unsubscribed areas
		} else {
			this.call.cmds.setfgcolor(this.area_clr);
		}

		// Send prefix (3 visual columns): " » " for highlighted, "   " otherwise
		var usedCols = 0;
		if (isHighlighted) {
			this.call.cmds.senddata(" ");
			this._sendGlyph("\u25BA", CP437_ARROW);
			this.call.cmds.senddata(" ");
		} else {
			this.call.cmds.senddata("   ");
		}
		usedCols += 3;

		// Send current-area marker (2 visual columns): "* " or "  "
		if (isCurrent) {
			this._sendGlyph("\u2022", CP437_BULLET);
			this.call.cmds.senddata(" ");
		} else {
			this.call.cmds.senddata("  ");
		}
		usedCols += 2;

		// Build text part from plain ASCII (name + optional description)
		var remainingCols = maxLen - usedCols;
		var textPart = row.name;
		if (row.description && textPart.length + 3 + row.description.length <= remainingCols) {
			textPart = textPart + " - " + row.description;
		}
		if (textPart.length > remainingCols) {
			textPart = textPart.substring(0, remainingCols);
		}
		this.call.cmds.senddata(textPart);
		usedCols += textPart.length;

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
			// Show toggle label based on current area's subscription state
			var curRow = this.filteredRows[this.cursorIdx];
			if (curRow && curRow.type === ROW_AREA) {
				var isSub = this._subMap[curRow.shortcode] !== undefined ? this._subMap[curRow.shortcode] : true;
				this._navKey("T", isSub ? "Unsub" : "Sub");
				this.call.cmds.senddata("  ");
			}
			this._navKey("Q", "Cancel");
		}

		if (posStr) {
			this.call.cmds.setfgcolor(this.status_clr);
			this.call.cmds.senddata(posStr);
		}

		this.call.cmds.resetcolors();
	}

	// Count how many area rows appear before (and including) the given index
	_countAreasBefore(idx) {
		var count = 0;
		for (var i = 0; i <= idx && i < this.filteredRows.length; i++) {
			if (this.filteredRows[i].type === ROW_AREA) count++;
		}
		return count;
	}

	// Redraw just the changed rows after a cursor move (efficient partial redraw)
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
		this.call.cmds.senddata("\r\n\r\n  Message Area Selector\r\n");
		if (this.call.msg_area) {
			this.call.cmds.senddata("  Current: " +
				(this.call.msg_group_title || this.call.msg_group || "") +
				" / " + (this.call.msg_area_title || this.call.msg_area || "") + "\r\n");
		}
		this.call.cmds.senddata("\r\n");

		var num = 0;
		for (var i = 0; i < this.filteredRows.length; i++) {
			var row = this.filteredRows[i];
			if (row.type === ROW_GROUP) {
				this.call.cmds.senddata("\r\n  -- " + row.name + " --\r\n");
			} else {
				num++;
				var marker = (this.call.msg_area &&
					row.shortcode.toUpperCase() === this.call.msg_area.toUpperCase())
					? "*" : " ";
				this.call.cmds.senddata("  " + marker + num + ") " + row.name);
				if (row.description) {
					this.call.cmds.senddata(" - " + row.description);
				}
				this.call.cmds.senddata("\r\n");
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

		this.call.msg_group = row.groupShortcode;
		this.call.msg_group_title = row.groupName;
		this.call.msg_area = row.shortcode;
		this.call.msg_area_title = row.name;

		// Persist to user record
		updateUserMsgGroup(this.call.caller_username, row.groupShortcode);
		updateUserMsgArea(this.call.caller_username, row.shortcode);

		alogger.writeAlog(5, this.loggingId + " Selected: " + row.groupShortcode + "/" + row.shortcode, "greenbright");
		this.signalReturn();
	}

	// --- Subscription toggle ---

	async _toggleSubscription() {
		if (!this._userId) return;
		if (this.cursorIdx < 0 || this.cursorIdx >= this.filteredRows.length) return;
		var row = this.filteredRows[this.cursorIdx];
		if (row.type !== ROW_AREA) return;

		var subsMod = await getSubsMod();
		if (!subsMod.toggleSubscription) return;

		try {
			var newState = await subsMod.toggleSubscription(this._userId, row.shortcode);
			this._subMap[row.shortcode] = newState;
			this._drawList();
			this._drawStatusLine();
		} catch (err) {
			alogger.writeAlog(3, this.loggingId + " toggle subscription error: " + (err?.message || err), "redbright");
		}
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
		if (lower === "t") {
			this._toggleSubscription();
			return;
		}
	}

	_onKeySearch(key) {
		switch (key) {
			case "ESC":
				this._exitSearch();
				return;
			case "Enter":
				// Select current in filtered results
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
		// Printable characters go into search buffer
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
		this.call.msg_group = row.groupShortcode;
		this.call.msg_group_title = row.groupName;
		this.call.msg_area = row.shortcode;
		this.call.msg_area_title = row.name;
		updateUserMsgGroup(this.call.caller_username, row.groupShortcode);
		updateUserMsgArea(this.call.caller_username, row.shortcode);
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
						this.call.cmds.senddata("\r\n  No message areas available.\r\n");
					} else {
						this.call.cmds.clearscreen();
						this.call.cmds.movecursor(this.listStartCol, this.listStartRow);
						this.call.cmds.setfgcolor(this.error_clr);
						this.call.cmds.senddata("No message areas available.");
						this.call.cmds.resetcolors();
					}
					// Brief pause then return
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

export { msgAreaSelector };
