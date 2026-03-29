import { BaseHandler } from "./basehandler.js";
import * as alogger from "../utils/alogger.js";

// Sub-module commands (simple, stay within menu)
import { userList } from "./menucommands/userlist.js";
import { LastCallers } from "./lastcallers.js";
import { AnnouncementHandler } from "./announcementhandler.js";
import { mailVerify } from "./menucommands/mailVerify.js";
import { passwordReset } from "./menucommands/passwordReset.js";
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
		this.display_entries = false;
		this.display_file = "";
		this.display_file_type = "";
		this.entries_x_offset = 0;
		this.entries_y_offset = 0;
		this.max_columns = 3;
		this.col_gap = 2;

		// Computed layout
		this.layout_columns = 1;
		this.layout_col_width = 0;
		this.layout_rows_per_page = 0;
		this.layout_pages = [];
		this.currentPage = 0;
		this.paged = false;

		// Hotkeys
		this.hotkey_arr = [];
		this.hotkey_msg = "Active Hotkeys: ";

		// Geometry
		this.max_y = call.term_height;
		this.menu_start_x = 3;
		this.menu_start_y = 2;
		this.prompt_x = this.menu_start_x;
		this.prompt_y = this.menu_start_y + 2;
		this.hotkey_x = this.menu_start_x;
		this.hotkey_y = this.menu_start_y + 1;
		this.input_x = this.menu_start_x;
		this.input_y = this.prompt_y + 2;
		this.error_x = this.menu_start_x;
		this.error_y = this.menu_start_y + 3;
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
		this.display_entries = config.display_entries || false;
		this.display_file = config.display_file || "";
		this.display_file_type = config.display_file_type || "";
		this.entries_x_offset = config.entries_x_offset || 0;
		this.entries_y_offset = config.entries_y_offset || 0;
		this.max_columns = config.max_columns || 3;
		this.col_gap = config.col_gap || 2;
		this.menu_prompt = this.title + " -> " + this.call.caller_username + ":";

		// Override theme colors from config if present
		if (config.title_clr !== undefined) this.title_clr = config.title_clr;
		if (config.input_clr !== undefined) this.input_clr = config.input_clr;
		if (config.prompt_clr !== undefined) this.prompt_clr = config.prompt_clr;
		if (config.error_clr !== undefined) this.error_clr = config.error_clr;
		if (config.hotkey_clr !== undefined) this.hotkey_clr = config.hotkey_clr;

		this._filterEntries();
		this._popHotkeys();
		this._calcMenuPos();
	}

	// --- Hotkeys ---
	_popHotkeys() {
		this.hotkey_arr = [];
		this.hotkey_msg = "Active Hotkeys: ";
		for (var i = 0; i < this.visible_entries.length; i++) {
			var hk = this.visible_entries[i].hotkey;
			if (hk && !this.hotkey_arr.includes(hk.toUpperCase())) {
				if (this.hotkey_arr.length > 0) {
					this.hotkey_msg += ",";
				}
				this.hotkey_arr.push(hk.toUpperCase());
				this.hotkey_msg += hk.toUpperCase();
			}
		}
	}

	// --- Geometry ---
	_calcMenuPos() {
		if (this.dumb) return;
		this.hotkey_x = this.menu_start_x;
		this.hotkey_y = this.max_y - 2;
		this.prompt_x = this.menu_start_x;
		this.prompt_y = this.hotkey_y + 1;
		this.input_y = this.prompt_y;
		this.input_x = this.prompt_x + this.menu_prompt.length + 1;
		this.error_x = this.hotkey_x + this.hotkey_msg.length + 2;
		this.error_y = this.hotkey_y;

		this._calcLayout();
	}

	// Calculate column count, column width, rows per page, and paginate entries
	_calcLayout() {
		this.layout_pages = [];
		this.currentPage = 0;
		this.paged = false;

		// Get displayable entries only (those with display text)
		var displayable = this.visible_entries.filter(e => e.display);
		if (displayable.length === 0) return;

		if (this.dumb) {
			// Dumb terminals get a single page of everything
			this.layout_columns = 1;
			this.layout_pages = [displayable];
			return;
		}

		var termWidth = this.call.term_width || 80;

		// Available area for entries
		// entries_y_offset shifts the start down (for header/display file space)
		// Reserve: title (2 lines) + offset + 3 bottom lines (hotkey, prompt, status)
		var entryStartY = this.menu_start_y + 2 + this.entries_y_offset;
		var availRows = this.hotkey_y - entryStartY - 1;
		if (availRows < 1) availRows = 1;

		// Available width for entries (account for x offset and margins)
		var entryStartX = this.menu_start_x + this.entries_x_offset;
		var availWidth = termWidth - entryStartX - 1;
		if (availWidth < 10) availWidth = 10;

		// Find the widest display string (account for hotkey prefix "X " = 2 chars)
		var hotkeyPrefix = (this.display_entries) ? 2 : 0;
		var maxDisplayLen = 0;
		for (var i = 0; i < displayable.length; i++) {
			var entryWidth = displayable[i].display.length;
			if (hotkeyPrefix && displayable[i].hotkey && displayable[i].display) {
				entryWidth += hotkeyPrefix;
			}
			if (entryWidth > maxDisplayLen) {
				maxDisplayLen = entryWidth;
			}
		}

		// Determine how many columns we can fit without truncating any entry
		// Each column needs maxDisplayLen width plus col_gap (except the last)
		var colWidthWithGap = maxDisplayLen + this.col_gap;
		var fitCols = Math.floor((availWidth + this.col_gap) / colWidthWithGap);
		if (fitCols < 1) fitCols = 1;
		if (fitCols > this.max_columns) fitCols = this.max_columns;

		// Now determine how many columns we actually need
		// Start with 1 column, increase only if entries don't fit in available rows
		var neededCols = 1;
		while (neededCols < fitCols) {
			var rowsNeeded = Math.ceil(displayable.length / neededCols);
			if (rowsNeeded <= availRows) break;
			neededCols++;
		}

		this.layout_columns = neededCols;
		this.layout_col_width = maxDisplayLen;

		// Rows per page with this column count
		this.layout_rows_per_page = availRows;
		var entriesPerPage = this.layout_rows_per_page * this.layout_columns;

		// Build pages
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
	_drawMenu() {
		if (this.dumb) {
			this._drawMenuDumb();
			return;
		}

		// Draw display file if configured
		if (this.display_file.length > 0) {
			this.call.cmds.drawscreen(this.display_file, this.display_file_type, true);
			if (!this.display_entries) {
				this._drawPromptArea();
				return;
			}
		} else {
			this.call.cmds.clearscreen();
		}

		// Title
		var currY = this.menu_start_y;
		var currX = this.menu_start_x;
		this.call.cmds.resetcolors();
		this.call.cmds.movecursor(currX, currY);
		this.call.cmds.setfgcolor(this.title_clr);
		this.call.cmds.senddata(this.title);

		this._drawEntryPage();
		this.call.cmds.resetcolors();
		this._drawPromptArea();
	}

	_drawEntryPage() {
		if (this.layout_pages.length === 0) return;
		var page = this.layout_pages[this.currentPage] || [];
		if (page.length === 0) return;

		var entryStartY = this.menu_start_y + 2 + this.entries_y_offset;
		var entryStartX = this.menu_start_x + this.entries_x_offset;

		// Clear the entry area (for redraws / page changes)
		if (!this.dumb) {
			for (var clearY = entryStartY; clearY < this.hotkey_y - 1; clearY++) {
				this.call.cmds.movecursor(entryStartX, clearY);
				this.call.cmds.cleartoeol();
			}
		}

		// Lay entries out column-first: fill column 0 top-to-bottom, then column 1, etc.
		var rowsThisPage = Math.ceil(page.length / this.layout_columns);

		for (var i = 0; i < page.length; i++) {
			var col = Math.floor(i / rowsThisPage);
			var row = i % rowsThisPage;
			var drawX = entryStartX + col * (this.layout_col_width + this.col_gap);
			var drawY = entryStartY + row;
			var entry = page[i];

			this.call.cmds.movecursor(drawX, drawY);
			// Show hotkey prefix if display_entries is on, entry has display text and a hotkey
			if (this.display_entries && entry.hotkey && entry.display) {
				var hasBg = (entry.bg_clr !== undefined && entry.bg_clr !== 0);
				if (hasBg) this.call.cmds.setbgcolor(entry.bg_clr);
				this.call.cmds.setfgcolor(this.hotkey_clr);
				this.call.cmds.senddata(entry.hotkey.toUpperCase());
				if (entry.fg_clr !== undefined) this.call.cmds.setfgcolor(entry.fg_clr);
				this.call.cmds.senddata(' ');
			} else {
				if (entry.bg_clr !== undefined) this.call.cmds.setbgcolor(entry.bg_clr);
				if (entry.fg_clr !== undefined) this.call.cmds.setfgcolor(entry.fg_clr);
			}
			this.call.cmds.senddata(entry.display);
			this.call.cmds.resetcolors();
		}

		// Page indicator if paged
		if (this.paged) {
			var pageY = this.hotkey_y - 1;
			this.call.cmds.movecursor(entryStartX, pageY);
			this.call.cmds.setfgcolor(this.prompt_clr);
			var pageMsg = "Page " + (this.currentPage + 1) + "/" + this.layout_pages.length + "  [PgUp/PgDn to navigate]";
			this.call.cmds.senddata(pageMsg);
			this.call.cmds.resetcolors();
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
				if (this.display_entries && page[i].hotkey) {
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
		this.call.cmds.setfgcolor(this.hotkey_clr);
		this.call.cmds.senddata(this.hotkey_msg);
		this.call.cmds.movecursor(this.prompt_x, this.prompt_y);
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
		if (this.hotkey_arr.includes(ch.toUpperCase())) {
			// Find from the FULL entry list so we can distinguish
			// "not accessible" from "doesn't exist"
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
				this._drawMenu();
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

	_restartMenu() {
		if (!this.active || !this.call) return;
		this._drawMenu();
		this.resetInactivityTimeouts();
	}

	// --- Menu navigation ---
	// Root menus clear the history stack when landed on
	_isRootMenu(menuName) {
		return menuName === "Main";
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
			this._drawMenu();
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