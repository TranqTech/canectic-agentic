import { BaseHandler } from "./basehandler.js";
import * as alogger from "../utils/alogger.js";

// Sub-module commands (simple, stay within menu)
import { userList } from "./menucommands/userlist.js";
import { LastCallers } from "./lastcallers.js";
import { AnnouncementHandler } from "./announcementhandler.js";
import { mailVerify } from "./menucommands/mailVerify.js";
import { passwordReset } from "./menucommands/passwordReset.js";
import { doorBrowser } from "./menucommands/doorBrowser.js";
import { WhosOnline } from "./whosonline.js";
import { msgAreaSelector } from "./menucommands/msgAreaSelector.js";
import { msgReader } from "./menucommands/msgReader.js";
import { msgEditor } from "./menucommands/msgEditor.js";
import { newscan } from "./menucommands/newscan.js";
import { testDownloader } from "./menucommands/testdownload.js";
import { pmReader } from "./menucommands/pmReader.js";
import { pmCheck } from "./menucommands/pmCheck.js";
import { fileAreaSelector } from "./menucommands/fileAreaSelector.js";
import { fileBrowser } from "./menucommands/fileBrowser.js";
import { fileBatchDownload } from "./menucommands/fileBatchDownload.js";
import { fileUpload } from "./menucommands/fileUpload.js";
import { fileSearch } from "./menucommands/fileSearch.js";
import { goodbye } from "./menucommands/goodbye.js";
import { nodeSpy } from "./menucommands/nodeSpy.js";
import { WallHandler } from "./menucommands/wallHandler.js";
import { SysInfo } from "./menucommands/sysInfo.js";
import { BulletinViewer } from "./menucommands/bulletinViewer.js";
import { QwkTransfer } from "./menucommands/qwkTransfer.js";
import { NewsViewer } from "./menucommands/newsViewer.js";
import { NotificationReader } from "./menucommands/notificationReader.js";
import { FileNewscan } from "./menucommands/fileNewscan.js";
import { DisplayScreen } from "./menucommands/displayScreen.js";
import { FireEvent } from "./menucommands/fireEvent.js";

// Models
import { getMenu, menuExists } from "../models/menus.js";

class MenuHandler extends BaseHandler {
	constructor(call) {
		super(call, "Menu");
		this.dumb = (call.term_type === "Dumb");
		this.theme = call.theme;

		// Load menu config based on call's current menu
		this.menuName = call.currentMenu || "Main";
		this.menuConfig = null;
		this.title = "";
		this.menu_entries = [];
		this.visible_entries = [];
		this.display_entries = 'off';
		this.display_file = "";
		this.display_file_type = "";
		this.margin_top = 3;
		this.margin_bottom = 3;
		this.margin_left = 2;
		this.margin_right = 2;
		this.fill_order = 'columns';
		this.center_vertical = false;
		this.max_columns = 3;
		this.col_gap = 2;

		// Computed layout
		this.layout_columns = 1;
		this.layout_col_width = 0;
		this.layout_rows_per_page = 0;
		this.layout_pages = [];
		this.currentPage = 0;
		this.paged = false;

		// Art-defined mode slot map (populated by drawfileWithCodes)
		this.artSlotMap = null;

		// Menu type
		this.menu_type = 'Hotkey';

		// Hotkeys
		this.hotkey_arr = [];
		this.hotkey_msg = "Active Hotkeys: ";

		// Lightbar state
		this.lb_index = 0;          // selected index within displayable entries
		this.lb_displayable = [];   // cached displayable entries for lightbar

		// Geometry (recalculated in _calcMenuPos from margins)
		this.max_y = call.term_height;
		this.hotkey_x = 3;
		this.hotkey_y = this.max_y - 2;
		this.prompt_x = 3;
		this.prompt_y = this.max_y - 1;
		this.input_x = 3;
		this.input_y = this.prompt_y;
		this.error_x = 3;
		this.error_y = this.hotkey_y;
		this.haserror = false;
		this.hasstatus = false;
		this.haswarn = false;
		this.menu_prompt = "";

		// Sub-module tracking
		this.running_module = false;
		this.currentModule = null;

		// Colors (from theme, with fallbacks)
		this.title_clr = this.theme?.title_clr || 15;
		this.input_clr = this.theme?.input_clr || 14;
		this.prompt_clr = this.theme?.prompt_clr || 11;
		this.error_clr = this.theme?.error_clr || 1;
		this.hotkey_clr = this.theme?.hotkey_clr || 13;
		this.menu_prompt_clr = this.theme?.menu_prompt_clr || 11;
		this.featured_clr = this.theme?.featured_clr || 10;
		this.lb_clr = this.theme?.lb_clr || 12;
		this.lb_cmd_clr = this.theme?.lb_cmd_clr || 11;
		this.lb_opt_clr = this.theme?.lb_opt_clr || 15;
		this.df_clr = this.theme?.df_clr || 7;

		this.loggingId = "Menu:" + this.menuName + " (Node " + this.call.nodenum + ")";
	}

	// --- Access control ---
	// Check if a menu entry is accessible to the current caller.
	// An entry is accessible if:
	//   - The caller's security level meets min_security (if set)
	//   - The caller has ALL required_flags (if any)
	//   - The caller has NONE of the prohibited_flags
	_isEntryAccessible(entry) {
		var callerSecurity = this.call.security || 0;
		var callerPerms = this.call.permissionflags || [];
		var callerRestrictions = this.call.restrictionflags || [];
		// Ensure arrays (may be JSON strings from session/DB)
		if (typeof callerPerms === 'string') {
			try { callerPerms = JSON.parse(callerPerms); } catch (_) { callerPerms = []; }
		}
		if (typeof callerRestrictions === 'string') {
			try { callerRestrictions = JSON.parse(callerRestrictions); } catch (_) { callerRestrictions = []; }
		}
		if (!Array.isArray(callerPerms)) callerPerms = [];
		if (!Array.isArray(callerRestrictions)) callerRestrictions = [];

		// Check minimum security level
		if (entry.min_security !== undefined && entry.min_security !== null) {
			if (callerSecurity < entry.min_security) return false;
		}

		// Check required flags — caller must have ALL of them
		var required = entry.required_flags || [];
		for (var i = 0; i < required.length; i++) {
			if (!callerPerms.includes(required[i])) return false;
		}

		// Check prohibited flags — if the caller has ANY (in either perms or restrictions), deny
		var prohibited = entry.prohibited_flags || [];
		for (var i = 0; i < prohibited.length; i++) {
			if (callerPerms.includes(prohibited[i]) || callerRestrictions.includes(prohibited[i])) {
				return false;
			}
		}

		return true;
	}

	// Filter the full entry list down to what this caller can see/use
	_filterEntries() {
		this.visible_entries = [];
		for (var i = 0; i < this.menu_entries.length; i++) {
			if (this._isEntryAccessible(this.menu_entries[i])) {
				this.visible_entries.push(this.menu_entries[i]);
			}
		}
	}

	// --- Config loading ---
	_applyConfig(config) {
		this.menuConfig = config;
		this.title = config.title || this.menuName;
		this.menu_entries = config.menu_entries || [];
		this.menu_type = config.menu_type || 'Hotkey';
		this.display_title = config.display_title !== false;
		this.display_entries = config.display_entries || 'auto';
		this.display_file = config.display_file || "";
		this.display_file_type = config.display_file_type || "";
		this.margin_top = (config.margin_top !== null && config.margin_top !== undefined) ? config.margin_top : 3;
		this.margin_bottom = (config.margin_bottom !== null && config.margin_bottom !== undefined) ? config.margin_bottom : 3;
		this.margin_left = (config.margin_left !== null && config.margin_left !== undefined) ? config.margin_left : 2;
		this.margin_right = (config.margin_right !== null && config.margin_right !== undefined) ? config.margin_right : 2;
		this.fill_order = config.fill_order || 'columns';
		this.center_vertical = config.center_vertical || false;
		this.max_columns = config.max_columns || 3;
		this.col_gap = config.col_gap || 2;
		this.menu_prompt = this.title + " -> " + this.call.caller_username + ":";

		// Override theme colors from config if present
		if (config.title_clr !== undefined) this.title_clr = config.title_clr;
		if (config.input_clr !== undefined) this.input_clr = config.input_clr;
		if (config.prompt_clr !== undefined) this.prompt_clr = config.prompt_clr;
		if (config.error_clr !== undefined) this.error_clr = config.error_clr;
		if (config.hotkey_clr !== undefined) this.hotkey_clr = config.hotkey_clr;
		if (config.menu_prompt_clr !== undefined) this.menu_prompt_clr = config.menu_prompt_clr;
		if (config.featured_clr !== undefined) this.featured_clr = config.featured_clr;

		this._filterEntries();
		this._popHotkeys();
		this._calcMenuPos();
	}

	// --- Hotkeys ---
	_popHotkeys() {
		this.hotkey_arr = [];
		for (var i = 0; i < this.visible_entries.length; i++) {
			var hk = this.visible_entries[i].hotkey;
			if (hk && !this.hotkey_arr.includes(hk.toUpperCase())) {
				this.hotkey_arr.push(hk.toUpperCase());
			}
		}
		this.hotkey_arr.sort();
		this.hotkey_msg = "Active Hotkeys: " + this.hotkey_arr.join(",");
	}

	// --- Geometry ---
	_calcMenuPos() {
		if (this.dumb) return;
		// Prompt area always pins to screen bottom, independent of margins
		this.hotkey_x = 3;
		this.hotkey_y = this.max_y - 2;
		this.prompt_x = 3;
		this.prompt_y = this.max_y - 1;
		this.input_y = this.prompt_y;
		this.input_x = this.prompt_x + this.menu_prompt.length + 1;
		this.error_x = this.hotkey_x + this.hotkey_msg.length + 2;
		this.error_y = this.hotkey_y;

		this._calcLayout();
	}

	// Calculate column count, column width, rows per page, and paginate entries.
	// Margins define a preferred entry region but are relaxed if entries don't fit.
	_calcLayout() {
		this.layout_pages = [];
		this.currentPage = 0;
		this.paged = false;

		var displayable = this.visible_entries.filter(e => e.display);
		if (displayable.length === 0) return;

		if (this.dumb) {
			this.layout_columns = 1;
			this.layout_pages = [displayable];
			return;
		}

		var termWidth = this.call.term_width || 80;

		// Start with margin-defined region
		var entryStartY = this.margin_top + 1;
		var entryEndY = this.max_y - this.margin_bottom;
		// Hard limits: entries can't overlap prompt (row max_y-2) or go above row 2
		var hardTopMin = 2;
		var hardBottomMax = this.max_y - 3;  // leave room for hotkey + prompt rows
		if (entryStartY < hardTopMin) entryStartY = hardTopMin;
		if (entryEndY > hardBottomMax) entryEndY = hardBottomMax;
		var availRows = entryEndY - entryStartY + 1;
		if (availRows < 1) availRows = 1;

		var regionLeft = this.margin_left;
		var regionRight = this.margin_right;
		var regionWidth = termWidth - regionLeft - regionRight;
		if (regionWidth < 10) regionWidth = 10;

		// Find widest entry (with hotkey prefix if auto mode)
		var hotkeyPrefix = (this.display_entries === 'auto') ? 2 : 0;
		var maxDisplayLen = 0;
		for (var i = 0; i < displayable.length; i++) {
			var entryWidth = displayable[i].display.length;
			if (hotkeyPrefix && displayable[i].hotkey && displayable[i].display) {
				entryWidth += hotkeyPrefix;
			}
			if (entryWidth > maxDisplayLen) maxDisplayLen = entryWidth;
		}

		// Auto column calculation: fit as many as width allows
		var colWidthWithGap = maxDisplayLen + this.col_gap;
		var fitCols = Math.floor((regionWidth + this.col_gap) / colWidthWithGap);
		if (fitCols < 1) fitCols = 1;
		if (fitCols > this.max_columns) fitCols = this.max_columns;

		// Step 1: Determine initial column count
		// Row-first: use all available columns (spread horizontally)
		// Column-first: use minimum columns needed (stack vertically)
		var neededCols;
		if (this.fill_order === 'rows') {
			neededCols = Math.min(fitCols, displayable.length);
		} else {
			neededCols = Math.min(fitCols, Math.ceil(displayable.length / availRows));
		}
		if (neededCols < 1) neededCols = 1;
		var entriesPerPage = availRows * neededCols;

		// Step 2: If entries don't fit, try adding more columns within the margin region first
		if (displayable.length > entriesPerPage && neededCols < fitCols) {
			for (var tryCol = neededCols + 1; tryCol <= fitCols; tryCol++) {
				if (availRows * tryCol >= displayable.length) {
					neededCols = tryCol;
					entriesPerPage = availRows * neededCols;
					break;
				}
			}
		}

		// Step 3: If still doesn't fit, try expanding vertically toward hard limits
		if (displayable.length > entriesPerPage) {
			var expandedStartY = hardTopMin;
			var expandedEndY = hardBottomMax;
			var expandedRows = expandedEndY - expandedStartY + 1;

			// Try fitting with current columns in expanded space first
			if (expandedRows * neededCols >= displayable.length) {
				// Current columns work, just need more rows
				entryStartY = expandedStartY;
				entryEndY = expandedEndY;
				availRows = expandedRows;
				entriesPerPage = availRows * neededCols;
			} else {
				// Need both more rows and more columns
				var expandedCols = Math.min(fitCols, Math.ceil(displayable.length / expandedRows));
				if (expandedCols < 1) expandedCols = 1;
				entryStartY = expandedStartY;
				entryEndY = expandedEndY;
				availRows = expandedRows;
				neededCols = expandedCols;
				entriesPerPage = availRows * neededCols;
			}
		}

		// Store computed region for _drawEntryPage
		this._entryStartY = entryStartY;
		this._entryEndY = entryEndY;

		this.layout_columns = neededCols;
		this.layout_col_width = maxDisplayLen;
		this.layout_rows_per_page = availRows;

		if (displayable.length <= entriesPerPage) {
			this.layout_pages = [displayable];
		} else {
			this.paged = true;
			for (var start = 0; start < displayable.length; start += entriesPerPage) {
				this.layout_pages.push(displayable.slice(start, start + entriesPerPage));
			}
		}
	}

	// --- Drawing ---
	async _drawMenu() {
		if (this.dumb) {
			this._drawMenuDumb();
			return;
		}

		// Art-defined mode
		if (this.display_entries === 'art' && this.display_file.length > 0) {
			await this._drawMenuArtDefined();
			return;
		}

		// Draw display file if configured
		if (this.display_file.length > 0) {
			await this.call.cmds.drawscreenWithCodes(
				this.display_file, this.display_file_type,
				{ doscreenclear: true }
			);
			if (this.display_entries === 'off') {
				this._drawPromptArea();
				return;
			}
		} else {
			this.call.cmds.clearscreen();
		}

		// Title
		this.call.cmds.resetcolors();
		if (this.display_title) {
			var titleY = Math.max(1, this.margin_top - 1);
			var titleX = this.margin_left + 1;
			this.call.cmds.movecursor(titleX, titleY);
			this.call.cmds.setfgcolor(this.title_clr);
			this.call.cmds.senddata(this.title);
		}

		this._drawEntryPage();
		this.call.cmds.resetcolors();
		this._drawPromptArea();

		// Initialise lightbar highlight
		if (this.menu_type === 'Lightbar' && !this.dumb) {
			this.lb_displayable = this.visible_entries.filter(e => e.display);
			this.lb_index = 0;
			if (this.lb_displayable.length > 0) {
				this._lbDrawEntry(this.lb_index, true);
			}
		}
	}

	// --- Art-defined mode rendering ---
	async _drawMenuArtDefined() {
		this.artSlotMap = null;

		// Determine if the selected art file is sixel
		var subdir;
		switch (this.display_file_type) {
			case "Screen":  subdir = "screens"; break;
			case "Header":  subdir = "headers"; break;
			default:        subdir = "misc"; break;
		}
		var artfile = this.call.cmds._findArtFile(subdir, this.display_file);
		if (!artfile) {
			// Fallback to auto mode
			this.call.cmds.clearscreen();
			this._drawEntryPage();
			this._drawPromptArea();
			return;
		}

		var isSixelArt = artfile.endsWith('.six');

		if (isSixelArt) {
			// Sixel art: render sixel visually, scan companion .ans for slot positions
			var overlayPath = this.call.cmds.findSixelOverlay(artfile);
			if (overlayPath) {
				this.artSlotMap = this.call.cmds.scanOverlaySlotMap(overlayPath);
			}
			// Render the sixel art (with universal code processing -- though sixel has none)
			this.call.cmds.drawfile(artfile, true);
		} else {
			// ANSI/ASCII art: process for both universal and menu codes
			var result = await this.call.cmds.drawfileWithCodes(artfile, {
				doscreenclear: true,
				menuMode: true
			});
			this.artSlotMap = result.slotMap;
		}

		if (!this.artSlotMap) {
			// No slot map found -- fall back to auto layout
			this._drawEntryPage();
			this._drawPromptArea();
			return;
		}

		// Apply UI position overrides from slot map
		if (this.artSlotMap.title) {
			// Title position from art -- row is 0-based in slotMap, terminal is 1-based
			var tpos = this.artSlotMap.title;
			if (this.display_title) {
				this.call.cmds.movecursor(tpos.col + 1, tpos.row + 1);
				this.call.cmds.setfgcolor(this.title_clr);
				var titleText = this.title;
				if (titleText.length > tpos.width) titleText = titleText.substring(0, tpos.width);
				this.call.cmds.senddata(titleText);
			}
		} else if (this.display_title) {
			// Default title position
			var titleY = Math.max(1, this.margin_top - 1);
			var titleX = this.margin_left + 1;
			this.call.cmds.movecursor(titleX, titleY);
			this.call.cmds.setfgcolor(this.title_clr);
			this.call.cmds.senddata(this.title);
		}

		// Draw entries at slot positions
		this._drawArtEntries();

		// Apply prompt/hotkey/error positions
		if (this.artSlotMap.hotkeys) {
			this.hotkey_x = this.artSlotMap.hotkeys.col + 1;
			this.hotkey_y = this.artSlotMap.hotkeys.row + 1;
		}
		if (this.artSlotMap.prompt) {
			this.prompt_x = this.artSlotMap.prompt.col + 1;
			this.prompt_y = this.artSlotMap.prompt.row + 1;
			this.input_y = this.prompt_y;
			this.input_x = this.prompt_x + this.menu_prompt.length + 1;
		}
		if (this.artSlotMap.error) {
			this.error_x = this.artSlotMap.error.col + 1;
			this.error_y = this.artSlotMap.error.row + 1;
		} else {
			this.error_x = this.hotkey_x + this.hotkey_msg.length + 2;
			this.error_y = this.hotkey_y;
		}

		this.call.cmds.resetcolors();
		this._drawPromptArea();
	}

	// Draw entries into art-defined slot positions
	_drawArtEntries() {
		if (!this.artSlotMap) return;

		var displayable = this.visible_entries.filter(e => e.display);
		if (displayable.length === 0) return;

		// Separate featured and non-featured entries
		var featuredEntries = displayable.filter(e => e.featured);
		var regularEntries = displayable.filter(e => !e.featured);

		// Sort slot maps by slot number
		var fSlots = this.artSlotMap.featured.slice().sort(function(a, b) { return a.slot - b.slot; });
		var eSlots = this.artSlotMap.entries.slice().sort(function(a, b) { return a.slot - b.slot; });

		// Assign featured entries to F slots; overflow spills to E slots
		var featuredOverflow = [];
		for (var fi = 0; fi < featuredEntries.length; fi++) {
			if (fi < fSlots.length) {
				this._drawArtSlotEntry(featuredEntries[fi], fSlots[fi]);
			} else {
				featuredOverflow.push(featuredEntries[fi]);
			}
		}
		// Blank unused F slots
		for (var fj = featuredEntries.length; fj < fSlots.length; fj++) {
			this._blankArtSlot(fSlots[fj]);
		}

		// Merge overflow featured entries with regular entries by sort_order
		var merged = [];
		var ri = 0;
		var oi = 0;
		while (ri < regularEntries.length || oi < featuredOverflow.length) {
			if (oi < featuredOverflow.length && (ri >= regularEntries.length ||
				(featuredOverflow[oi].sort_order || 0) <= (regularEntries[ri].sort_order || 0))) {
				merged.push(featuredOverflow[oi]);
				oi++;
			} else if (ri < regularEntries.length) {
				merged.push(regularEntries[ri]);
				ri++;
			}
		}

		// Assign merged entries to E slots
		for (var ei = 0; ei < eSlots.length; ei++) {
			if (ei < merged.length) {
				this._drawArtSlotEntry(merged[ei], eSlots[ei]);
			} else {
				this._blankArtSlot(eSlots[ei]);
			}
		}
	}

	// Draw a single entry at an art-defined slot position
	_drawArtSlotEntry(entry, slot) {
		// Terminal coordinates are 1-based; slotMap is 0-based
		this.call.cmds.movecursor(slot.col + 1, slot.row + 1);

		var defaultFg = entry.featured ? this.featured_clr : (this.theme?.opt_clr || 7);
		var entryFg = entry.fg_clr !== undefined ? entry.fg_clr : defaultFg;
		var entryBg = entry.bg_clr;

		if (entryBg !== undefined) this.call.cmds.setbgcolor(entryBg);
		this.call.cmds.setfgcolor(entryFg);

		// Build entry text: hotkey prefix + display
		var text = '';
		if (entry.hotkey && entry.display) {
			this.call.cmds.setfgcolor(this.hotkey_clr);
			text += entry.hotkey.toUpperCase() + ' ';
		}

		// Remaining width for the display text
		var prefixLen = text.length;
		var displayText = entry.display || '';
		var availWidth = slot.width - prefixLen;

		if (displayText.length > availWidth) {
			displayText = displayText.substring(0, availWidth);
		}

		// Send hotkey prefix
		if (prefixLen > 0) {
			this.call.cmds.senddata(text);
			this.call.cmds.setfgcolor(entryFg);
		}

		this.call.cmds.senddata(displayText);

		// Pad remaining width
		var padLen = availWidth - displayText.length;
		if (padLen > 0) {
			this.call.cmds.senddata(' '.repeat(padLen));
		}

		this.call.cmds.resetcolors();
	}

	// Blank an unused art slot
	_blankArtSlot(slot) {
		this.call.cmds.movecursor(slot.col + 1, slot.row + 1);
		this.call.cmds.senddata(' '.repeat(slot.width));
	}

	_drawEntryPage() {
		if (this.layout_pages.length === 0) return;
		var page = this.layout_pages[this.currentPage] || [];
		if (page.length === 0) return;

		// Entry region (computed by _calcLayout, may be relaxed from margins)
		var entryStartY = this._entryStartY || (this.margin_top + 1);
		var entryStartX = this.margin_left + 1;
		var entryEndY = this._entryEndY || (this.max_y - this.margin_bottom);

		// Clear the entry region
		if (!this.dumb) {
			for (var clearY = entryStartY; clearY <= entryEndY; clearY++) {
				this.call.cmds.movecursor(entryStartX, clearY);
				this.call.cmds.cleartoeol();
			}
		}

		var rowsThisPage = Math.ceil(page.length / this.layout_columns);

		// Vertical centering offset
		var vOffset = 0;
		if (this.center_vertical) {
			var regionHeight = entryEndY - entryStartY + 1;
			var usableHeight = this.paged ? regionHeight - 1 : regionHeight;
			vOffset = Math.floor((usableHeight - rowsThisPage) / 2);
			if (vOffset < 0) vOffset = 0;
		}

		for (var i = 0; i < page.length; i++) {
			var col, row;
			if (this.fill_order === 'rows') {
				col = i % this.layout_columns;
				row = Math.floor(i / this.layout_columns);
			} else {
				col = Math.floor(i / rowsThisPage);
				row = i % rowsThisPage;
			}
			var drawX = entryStartX + col * (this.layout_col_width + this.col_gap);
			var drawY = entryStartY + vOffset + row;
			var entry = page[i];

			this.call.cmds.movecursor(drawX, drawY);
			var defaultFg = entry.featured ? this.featured_clr : (this.theme?.opt_clr || 7);
			var entryFg = entry.fg_clr !== undefined ? entry.fg_clr : defaultFg;
			var entryBg = entry.bg_clr;

			if (this.display_entries === 'auto' && entry.hotkey && entry.display) {
				if (entryBg !== undefined) this.call.cmds.setbgcolor(entryBg);
				this.call.cmds.setfgcolor(this.hotkey_clr);
				this.call.cmds.senddata(entry.hotkey.toUpperCase());
				this.call.cmds.setfgcolor(entryFg);
				this.call.cmds.senddata(' ');
			} else {
				if (entryBg !== undefined) this.call.cmds.setbgcolor(entryBg);
				this.call.cmds.setfgcolor(entryFg);
			}
			this.call.cmds.senddata(entry.display);
			this.call.cmds.resetcolors();
		}

		// Page indicator at the bottom of the entry region
		if (this.paged) {
			var pageY = entryEndY;
			this.call.cmds.movecursor(entryStartX, pageY);
			this.call.cmds.setfgcolor(this.prompt_clr);
			var pageMsg = "Page " + (this.currentPage + 1) + "/" + this.layout_pages.length + "  [PgUp/PgDn to navigate]";
			this.call.cmds.senddata(pageMsg);
			this.call.cmds.resetcolors();
		}
	}

	// --- Lightbar helpers ---

	// Get the screen position (x, y) for a displayable entry by its index within the current page
	_lbEntryPos(pageIndex) {
		var entryStartY = this._entryStartY || (this.margin_top + 1);
		var entryStartX = this.margin_left + 1;
		var rowsThisPage = Math.ceil((this.layout_pages[this.currentPage] || []).length / this.layout_columns);
		var vOffset = 0;
		if (this.center_vertical) {
			var entryEndY = this._entryEndY || (this.max_y - this.margin_bottom);
			var regionHeight = entryEndY - entryStartY + 1;
			var usableHeight = this.paged ? regionHeight - 1 : regionHeight;
			vOffset = Math.floor((usableHeight - rowsThisPage) / 2);
			if (vOffset < 0) vOffset = 0;
		}
		var col, row;
		if (this.fill_order === 'rows') {
			col = pageIndex % this.layout_columns;
			row = Math.floor(pageIndex / this.layout_columns);
		} else {
			col = Math.floor(pageIndex / rowsThisPage);
			row = pageIndex % rowsThisPage;
		}
		return {
			x: entryStartX + col * (this.layout_col_width + this.col_gap),
			y: entryStartY + vOffset + row
		};
	}

	// Draw a single entry at its position, either highlighted or normal
	_lbDrawEntry(lbIdx, highlighted) {
		var page = this.layout_pages[this.currentPage] || [];
		// lbIdx is index into lb_displayable; find the page-local index
		var entriesPerPage = this.layout_rows_per_page * this.layout_columns;
		var pageStart = this.currentPage * entriesPerPage;
		var pageIndex = lbIdx - pageStart;
		if (pageIndex < 0 || pageIndex >= page.length) return;

		var entry = page[pageIndex];
		var pos = this._lbEntryPos(pageIndex);

		var hasPrefix = (this.display_entries === 'auto' && entry.hotkey && entry.display);
		var prefixLen = hasPrefix ? 2 : 0;

		if (highlighted) {
			// Highlighted: draw 1 col before and 1 col after for clean padding
			this.call.cmds.movecursor(pos.x - 1, pos.y);
			this.call.cmds.setbgcolor(this.lb_clr);
			this.call.cmds.senddata(' '); // leading pad
			if (hasPrefix) {
				this.call.cmds.setfgcolor(this.lb_cmd_clr);
				this.call.cmds.senddata(entry.hotkey.toUpperCase());
				this.call.cmds.setfgcolor(this.lb_opt_clr);
				this.call.cmds.senddata(' ');
			} else {
				this.call.cmds.setfgcolor(this.lb_opt_clr);
			}
			var padLen = this.layout_col_width - entry.display.length - prefixLen;
			this.call.cmds.senddata(entry.display);
			// Fill to column width + 1 trailing pad
			this.call.cmds.senddata(' '.repeat((padLen > 0 ? padLen : 0) + 1));
		} else {
			// Normal: clear the padding columns and redraw entry
			this.call.cmds.movecursor(pos.x - 1, pos.y);
			this.call.cmds.senddata(' '); // clear leading pad
			var defaultFg = entry.featured ? this.featured_clr : (this.theme?.opt_clr || 7);
			var entryFg = entry.fg_clr !== undefined ? entry.fg_clr : defaultFg;
			var entryBg = entry.bg_clr;
			if (hasPrefix) {
				if (entryBg !== undefined) this.call.cmds.setbgcolor(entryBg);
				this.call.cmds.setfgcolor(this.hotkey_clr);
				this.call.cmds.senddata(entry.hotkey.toUpperCase());
				this.call.cmds.setfgcolor(entryFg);
				this.call.cmds.senddata(' ');
			} else {
				if (entryBg !== undefined) this.call.cmds.setbgcolor(entryBg);
				this.call.cmds.setfgcolor(entryFg);
			}
			var padLen = this.layout_col_width - entry.display.length - prefixLen;
			this.call.cmds.senddata(entry.display);
			this.call.cmds.resetcolors();
			// Clear trailing pad area
			this.call.cmds.senddata(' '.repeat((padLen > 0 ? padLen : 0) + 1));
		}
		this.call.cmds.resetcolors();
		// Park cursor at the input prompt
		this.call.cmds.movecursor(this.input_x, this.input_y);
	}

	// Move the lightbar selection by delta, handling wrapping and page changes
	_lbMove(delta) {
		if (this.lb_displayable.length === 0) return;
		var oldIdx = this.lb_index;
		var newIdx = oldIdx + delta;

		// Wrap around
		if (newIdx < 0) newIdx = this.lb_displayable.length - 1;
		if (newIdx >= this.lb_displayable.length) newIdx = 0;

		this.lb_index = newIdx;

		// Check if we need a page change
		var entriesPerPage = this.layout_rows_per_page * this.layout_columns;
		var newPage = Math.floor(newIdx / entriesPerPage);
		if (newPage !== this.currentPage) {
			this.currentPage = newPage;
			this._drawEntryPage();
			this._lbDrawEntry(this.lb_index, true);
		} else {
			// Same page: just redraw old and new
			this._lbDrawEntry(oldIdx, false);
			this._lbDrawEntry(newIdx, true);
		}
	}

	_drawMenuDumb() {
		this.call.cmds.senddata("\r\n\r\n\r\n");
		this.call.cmds.senddata(this.title);
		this.call.cmds.senddata("\r\n");

		var page = this.layout_pages[this.currentPage] || this.visible_entries;
		var lineCount = 0;
		for (var i = 0; i < page.length; i++) {
			if (page[i].display) {
				this.call.cmds.senddata("\r\n");
				if (this.display_entries === 'auto' && page[i].hotkey) {
					this.call.cmds.senddata(page[i].hotkey.toUpperCase() + " ");
				}
				this.call.cmds.senddata(page[i].display);
				lineCount++;
				// Pause on dumb terminals if we run out of space
				if (this.paged && lineCount >= 22) {
					this.call.cmds.senddata("\r\n[More - Enter to continue]");
					return;
				}
			}
		}

		if (this.paged) {
			this.call.cmds.senddata("\r\nPage " + (this.currentPage + 1) + "/" + this.layout_pages.length);
		}
		this.call.cmds.senddata("\r\n\r\n");
		this.call.cmds.senddata(this.hotkey_msg);
		this.call.cmds.senddata("\r\n");
		this.call.cmds.senddata(this.menu_prompt);
	}

	_drawPromptArea() {
		if (this.dumb) return;
		this.call.cmds.movecursor(this.hotkey_x, this.hotkey_y);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(this.menu_prompt_clr);
		if (this.menu_type === 'Lightbar' && !this.dumb) {
			this.call.cmds.senddata("Use \x1b[1m\x18\x19\x1a\x1b\x1b[0m");
			this.call.cmds.setfgcolor(this.menu_prompt_clr);
			this.call.cmds.senddata(" to navigate, ");
			this.call.cmds.senddata("\x1b[1mEnter\x1b[0m");
			this.call.cmds.setfgcolor(this.menu_prompt_clr);
			this.call.cmds.senddata(" to select");
		} else {
			this.call.cmds.senddata(this.hotkey_msg);
		}
		this.call.cmds.movecursor(this.prompt_x, this.prompt_y);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(this.prompt_clr);
		this.call.cmds.senddata(this.menu_prompt);
		this.call.cmds.setfgcolor(this.input_clr);
		this.call.cmds.movecursor(this.input_x, this.input_y);
	}

	_drawError(errormsg) {
		this.haserror = true;
		if (this.dumb) {
			this.call.cmds.senddata("\r\n  " + errormsg + "\r\n");
			return;
		}
		this.call.cmds.movecursor(this.error_x, this.error_y);
		this.call.cmds.setfgcolor(this.error_clr);
		this.call.cmds.senddata(errormsg);
		this.call.cmds.movecursor(this.input_x, this.input_y);
		this.call.cmds.setfgcolor(this.input_clr);
	}

	_eraseError() {
		if (!this.haserror) return;
		this.haserror = false;
		if (this.dumb) return;
		this.call.cmds.movecursor(this.error_x, this.error_y);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(this.input_clr);
		this.call.cmds.movecursor(this.input_x, this.input_y);
	}

	_drawStatus(msg) {
		this.hasstatus = true;
		if (this.dumb) {
			this.call.cmds.senddata("\r\n  " + msg + "\r\n");
			return;
		}
		this.call.cmds.movecursor(this.error_x, this.error_y);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(this.error_clr);
		this.call.cmds.senddata(msg);
		this.call.cmds.setfgcolor(this.input_clr);
		this.call.cmds.movecursor(this.input_x, this.input_y);
	}

	_eraseStatus() {
		if (!this.hasstatus) return;
		this.hasstatus = false;
		if (this.dumb) return;
		this.call.cmds.movecursor(this.error_x, this.error_y);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(this.input_clr);
		this.call.cmds.movecursor(this.input_x, this.input_y);
	}

	_drawWarn(msg) {
		this.haswarn = true;
		if (this.dumb) {
			this.call.cmds.senddata("\r\n  " + msg + "\r\n");
			return;
		}
		this.call.cmds.movecursor(this.error_x, this.error_y);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(this.error_clr);
		this.call.cmds.senddata(msg);
		this.call.cmds.setfgcolor(this.input_clr);
		this.call.cmds.movecursor(this.input_x, this.input_y);
	}

	_eraseWarn() {
		if (!this.haswarn) return;
		this.haswarn = false;
		if (this.dumb) return;
		this.call.cmds.movecursor(this.error_x, this.error_y);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(this.input_clr);
		this.call.cmds.movecursor(this.input_x, this.input_y);
	}

	onInactivityWarn() {
		if (!this.call || !this.active) return;
		this._drawWarn(this.warnMsg);
	}

	// --- Input handling ---
	handleInput(inputArray) {
		if (!this.active) return;

		// Route to sub-module if running
		if (this.running_module && this.currentModule) {
			if (this.currentModule.active === false) {
				// Module was cleared but flag not reset — clean up
				this._doModuleReturn();
			} else if (this.currentModule.handleInput) {
				// Reset the menu's inactivity timeouts on every input,
				// even when a sub-module is handling it — the menu handler
				// owns the inactivity lifecycle for the entire session
				this.resetInactivityTimeouts();
				if (this.haswarn) this._eraseWarn();
				this.currentModule.handleInput(inputArray);
				return;
			} else if (this.currentModule.input_array) {
				// Legacy sub-module fallback
				this.resetInactivityTimeouts();
				if (this.haswarn) this._eraseWarn();
				for (var i = 0; i < inputArray.length; i++) {
					this.currentModule.input_array.push(inputArray[i]);
				}
				if (this.currentModule.handleData) this.currentModule.handleData();
				return;
			}
		}

		if (this.haserror) {
			this._eraseError();
		}
		if (this.hasstatus) {
			this._eraseStatus();
		}
		if (this.haswarn) {
			this._eraseWarn();
		}
		super.handleInput(inputArray);
	}

	onKey(key) {
		if (this.menu_type === 'Lightbar' && !this.dumb) {
			// Lightbar navigation
			if (key === 'UpArrow') {
				if (this.fill_order === 'rows') {
					this._lbMove(-this.layout_columns);
				} else {
					this._lbMove(-1);
				}
				return;
			}
			if (key === 'DownArrow') {
				if (this.fill_order === 'rows') {
					this._lbMove(this.layout_columns);
				} else {
					this._lbMove(1);
				}
				return;
			}
			if (key === 'LeftArrow') {
				if (this.fill_order === 'rows') {
					this._lbMove(-1);
				} else {
					this._lbMove(-this.layout_rows_per_page);
				}
				return;
			}
			if (key === 'RightArrow') {
				if (this.fill_order === 'rows') {
					this._lbMove(1);
				} else {
					this._lbMove(this.layout_rows_per_page);
				}
				return;
			}
			if (key === 'Enter') {
				if (this.lb_displayable.length > 0 && this.lb_displayable[this.lb_index]) {
					this._doMenuCommand(this.lb_displayable[this.lb_index]);
				}
				return;
			}
			if (key === 'Home') { this._lbMove(-this.lb_index); return; }
			if (key === 'End') { this._lbMove(this.lb_displayable.length - 1 - this.lb_index); return; }
			if (key === 'PgDn') {
				var perPage = this.layout_rows_per_page * this.layout_columns;
				this._lbMove(perPage);
				return;
			}
			if (key === 'PgUp') {
				var perPage = this.layout_rows_per_page * this.layout_columns;
				this._lbMove(-perPage);
				return;
			}
			return;
		}

		// Hotkey mode: page navigation only
		if (!this.paged) return;
		if (key === "PgDn" || key === "DownArrow") {
			if (this.currentPage < this.layout_pages.length - 1) {
				this.currentPage++;
				this._drawEntryPage();
			}
			return;
		}
		if (key === "PgUp" || key === "UpArrow") {
			if (this.currentPage > 0) {
				this.currentPage--;
				this._drawEntryPage();
			}
			return;
		}
	}

	onChar(ch) {
		// Hotkey dispatch works in both modes (quick access even in lightbar)
		if (this.hotkey_arr.includes(ch.toUpperCase())) {
			var matched_entry = this.menu_entries.find(obj => {
				return obj.hotkey && obj.hotkey.toUpperCase() === ch.toUpperCase();
			});
			if (matched_entry) {
				if (!this._isEntryAccessible(matched_entry)) {
					this._drawStatus("Access denied");
					return;
				}
				this._doMenuCommand(matched_entry);
			}
		}
	}

	// --- Command dispatch ---
	async _doMenuCommand(entry) {
		var cmd = entry.command_name;
		alogger.writeAlog(5, this.loggingId + "\n  Command: " + cmd, "green");

		switch (cmd) {
			// --- Heavy commands: delegate to call flow ---
			case "logOff":
				this.finished = true;
				this.emitter.emit("HangupSignal");
				return;

			case "goodbye":
				this._runSubModule(new goodbye(this.call));
				return;

			case "nodeSpy":
				this._runSubModule(new nodeSpy(this.call));
				return;

			case "wall":
				this._runSubModule(new WallHandler(this.call));
				return;

			case "sysInfo":
				this._runSubModule(new SysInfo(this.call));
				return;

			case "bulletins":
				this._runSubModule(new BulletinViewer(this.call));
				return;

			case "fileNewscan":
				this._runSubModule(new FileNewscan(this.call));
				return;

			case "qwkTransfer":
				this._runSubModule(new QwkTransfer(this.call));
				return;

			case "newsViewer":
				this._runSubModule(new NewsViewer(this.call));
				return;

			case "displayScreen":
				this._runSubModule(new DisplayScreen(this.call, { arg: entry.command_arg }));
				return;

			case "fireEvent":
				this._runSubModule(new FireEvent(this.call, { arg: entry.command_arg }));
				return;

			case "notifications":
				this._runSubModule(new NotificationReader(this.call));
				return;

			case "runXtrn":
				if (entry.command_arg) {
					this.call.launchDoor(entry.command_arg, true);
				} else {
					this._drawError("No door configured");
				}
				return;

			case "loadMenu":
				if (entry.command_arg) {
					var exists = await menuExists(entry.command_arg);
					if (!exists) {
						this._drawStatus("Menu not found");
						return;
					}
					this._navigateToMenu(entry.command_arg);
				} else {
					this._drawError("No menu specified");
				}
				return;

			case "previousMenu":
				this._navigateBack();
				return;

			case "exitStage":
				this.finished = true;
				return;

			case "redrawMenu":
				if (!this.dumb) this.call.cmds.clearscreen();
				await this._drawMenu();
				return;

			// --- Simple commands: run as sub-modules ---
			// In _doMenuCommand(), both cases use the same module:

			case "msgAreaChange":
				this._runSubModule(new msgAreaSelector(this.call));
				return;

		    case "msgGroupChange":
		    	this._runSubModule(new msgAreaSelector(this.call));
				return;

			case "listMessages":
				this._runSubModule(new msgReader(this.call));
				return;

			case "readMessages":
				this._runSubModule(new msgReader(this.call));
				return;

			case "postMessage":
				this._runSubModule(new msgEditor(this.call, {
					mode: "new",
					shortcode: this.call.msg_area,
				}));
				return;

			case "newScan":
				this._runSubModule(new newscan(this.call, { scanMode: "all" }));
				return;

			case "newScanGroup":
				this._runSubModule(new newscan(this.call, { scanMode: "group" }));
				return;

			case "userList":
				this._runSubModule(new userList(this.call));
				return;

			case "lastCallers":
				this._runSubModule(new LastCallers(this.call));
				return;

			case "announcements":
				this._runSubModule(new AnnouncementHandler(this.call));
				return;

			case "whosOnline":
				this._runSubModule(new WhosOnline(this.call));
				return;

			case "testDownload":
				this._runSubModule(new testDownloader(this.call));
				return;
			case "email":
				this._runSubModule(new pmReader(this.call));
				return;
			case "checkEmail":
				this._runSubModule(new pmCheck(this.call));
				return;

			case "verifyMail":
				this._runSubModule(new mailVerify(this.call));
				return;

			case "passwordReset":
				this._runSubModule(new passwordReset(this.call));
				return;

			case "doorBrowser": {
				var browser = new doorBrowser(this.call);
				browser.emitter.on("LaunchDoor", (slug) => {
					this._doModuleReturn();
					this.call.launchDoor(slug, true);
				});
				this._runSubModule(browser);
				return;
			}

			case "fileGroupChange":
			case "fileAreaChange":
				this._runSubModule(new fileAreaSelector(this.call));
				return;

			case "fileBrowser":
			case "fileList":
				this._runSubModule(new fileBrowser(this.call));
				return;

			case "downloadBatch":
				this._runSubModule(new fileBatchDownload(this.call));
				return;

			case "fileUpload":
				this._runSubModule(new fileUpload(this.call));
				return;

			case "fileSearch":
				this._runSubModule(new fileSearch(this.call));
				return;

			default:
				alogger.writeAlog(4, this.loggingId + "\n  Unknown command: " + cmd, "yellow");
				this._drawError("Unknown command");
				return;
		}
	}

	// --- Sub-module management ---
	_runSubModule(module) {
		this._clearAllTimeouts();
		this.running_module = true;
		this.currentModule = module;

		module.emitter.on("ModuleReturn", () => {
			this._doModuleReturn();
		});

		module.emitter.on("HangupSignal", () => {
			this._doModuleReturn();
			this.emitter.emit("HangupSignal");
		});

		module.startStage();

		// Menu handler owns the inactivity lifecycle — keep
		// timeouts running even while a sub-module is active
		if (this.active && !this.finished) {
			this.setInactivityTimeouts();
		}
	}

	_doModuleReturn() {
		if (this.currentModule) {
			try {
				this.currentModule.clearHandler();
			} catch (err) {
				alogger.writeAlog(4, this.loggingId + "\n  Sub-module cleanup error: " + err, "yellow");
			}
		}
		this.currentModule = null;
		this.running_module = false;

		if (!this.call || !this.active) {
			this.emitter.emit("HangupSignal");
			return;
		}

		// Redraw and restart timeouts
		this._restartMenu();
	}

	async _restartMenu() {
		if (!this.active || !this.call) return;
		await this._drawMenu();
		this.resetInactivityTimeouts();
	}

	async _loadAndDrawMenu() {
		if (!this.active || !this.call) return;
		try {
			var config = await getMenu(this.menuName);
			if (!this.active) return;
			if (!config) {
				this._navigateBack();
				return;
			}
			this._applyConfig(config);
			await this._drawMenu();
			this.setInactivityTimeouts();
		} catch (err) {
			this._handleError("_loadAndDrawMenu error", err);
		}
	}

	// --- Menu navigation ---
	// Root menus clear the history stack when landed on
	_isRootMenu(menuName) {
		return menuName.toLowerCase() === "main";
	}

	_navigateToMenu(targetMenu) {
		// Push current menu onto history
		var history = this.call.menuHistory;
		var maxLen = this.call.menuHistoryMax || 20;

		// Don't push if already navigating to the same menu
		if (targetMenu !== this.call.currentMenu) {
			history.push(this.call.currentMenu);
			// Cap the stack — drop oldest if exceeded
			while (history.length > maxLen) {
				history.shift();
			}
		}

		this.call.currentMenu = targetMenu;

		// Root menus clear the breadcrumb trail
		if (this._isRootMenu(targetMenu)) {
			this.call.menuHistory = [];
		}

		this.emitter.emit("NextStage", "menu");
	}

	_navigateBack() {
		var history = this.call.menuHistory;

		if (history.length > 0) {
			this.call.currentMenu = history.pop();
			this.emitter.emit("NextStage", "menu");
		} else {
			// Nothing to go back to — go to Main if we're not already there
			if (this.call.currentMenu !== "Main") {
				this.call.currentMenu = "Main";
				this.call.menuHistory = [];
				this.emitter.emit("NextStage", "menu");
			} else {
				this._drawStatus("Already at top menu");
			}
		}
	}

	// --- Lifecycle ---
	signalReturn() {
		this.emitter.emit("ModuleReturn");
	}

	async startStage() {
		if (!this.call) return;

		// Auto-resume door browser if returning from a door launched via the browser
		if (this.call._doorBrowserState) {
			var self = this;
			var browser = new doorBrowser(this.call);
			browser.emitter.on("LaunchDoor", (slug) => {
				self._doModuleReturn();
				self.call.launchDoor(slug, true);
			});
			browser.emitter.on("ModuleReturn", () => {
				self.currentModule = null;
				self.running_module = false;
				// Now load the menu config normally
				self._loadAndDrawMenu();
			});
			this._clearAllTimeouts();
			this.running_module = true;
			this.currentModule = browser;
			browser.startStage();
			return;
		}

		try {
			// Load the menu config
			var config = await getMenu(this.menuName);
			if (!this.active) return;

			if (!config) {
				alogger.writeAlog(3, this.loggingId + "\n  No config found for menu: " + this.menuName, "redbright");
				// Fall back to previous menu in history, or hang up
				this._navigateBack();
				if (this.call.currentMenu === this.menuName) {
					// navigateBack had nowhere to go — hang up
					this.emitter.emit("HangupSignal");
				}
				return;
			}

			this._applyConfig(config);
			await this._drawMenu();
			this.setInactivityTimeouts();
		} catch (err) {
			this._handleError("startStage error", err);
		}
	}

	clearHandler() {
		if (!this.active) return;
		if (this.running_module && this.currentModule) {
			try {
				this.currentModule.clearHandler();
			} catch (err) {
				alogger.writeAlog(4, this.loggingId + "\n  Sub-module cleanup on clear: " + err, "yellow");
			}
			this.currentModule = null;
			this.running_module = false;
		}
		this.theme = null;
		this.menuConfig = null;
		this.menu_entries = [];
		this.visible_entries = [];
		this.layout_pages = [];
		super.clearHandler();
	}
}

export { MenuHandler };