import { BaseHandler } from "./basehandler.js";
import * as alogger from "../utils/alogger.js";

// Sub-module commands (simple, stay within menu)
import { userList } from "./menucommands/userlist.js";
import { LastCallers } from "./lastcallers.js";
import { msgGroupChange } from "./menucommands/msggroups.js";
import { msgAreaChange } from "./menucommands/msgareas.js";
import { listMessages } from "./menucommands/msglister.js";
import { readMessages } from "./menucommands/msgreader.js";
import { writeMessage } from "./menucommands/writemsg.js";
import { testDownloader } from "./menucommands/testdownload.js";

// Models
import { getMenu } from "../models/menus.js";

class MenuHandler extends BaseHandler {
	constructor(call) {
		super(call, "Menu");
		this.dumb = (call.term_type === "Dumb");
		this.theme = call.theme;

		// Load menu config based on call's current menu
		this.menuName = call.currentMenu || "Main";
		this.menuConfig = null;
		this.title = "";
		this.menu_options = [];
		this.display_options = false;
		this.display_file = "";
		this.display_file_type = "";
		this.options_x_offset = 0;
		this.options_y_offset = 0;

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

	// --- Config loading ---
	_applyConfig(config) {
		this.menuConfig = config;
		this.title = config.title || this.menuName;
		this.menu_options = config.menu_options || [];
		this.display_options = config.display_options || false;
		this.display_file = config.display_file || "";
		this.display_file_type = config.display_file_type || "";
		this.options_x_offset = config.menu_options_x_offset || 0;
		this.options_y_offset = config.menu_options_y_offset || 0;
		this.menu_prompt = this.title + " -> " + this.call.caller_username + ":";

		// Override theme colors from config if present
		if (config.title_clr !== undefined) this.title_clr = config.title_clr;
		if (config.input_clr !== undefined) this.input_clr = config.input_clr;
		if (config.prompt_clr !== undefined) this.prompt_clr = config.prompt_clr;
		if (config.error_clr !== undefined) this.error_clr = config.error_clr;
		if (config.hotkey_clr !== undefined) this.hotkey_clr = config.hotkey_clr;

		this._popHotkeys();
		this._calcMenuPos();
	}

	// --- Hotkeys ---
	_popHotkeys() {
		this.hotkey_arr = [];
		this.hotkey_msg = "Active Hotkeys: ";
		for (var i = 0; i < this.menu_options.length; i++) {
			var hk = this.menu_options[i].hotkey;
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
	}

	// --- Drawing ---
	_drawMenu() {
		if (this.dumb) {
			this.call.cmds.senddata("\r\n\r\n\r\n");
			this.call.cmds.senddata(this.title);
			this.call.cmds.senddata("\r\n");
			for (var i = 0; i < this.menu_options.length; i++) {
				if (this.menu_options[i].display) {
					this.call.cmds.senddata("\r\n");
					this.call.cmds.senddata(this.menu_options[i].display);
				}
			}
			this.call.cmds.senddata("\r\n\r\n");
			this.call.cmds.senddata(this.hotkey_msg);
			this.call.cmds.senddata("\r\n");
			this.call.cmds.senddata(this.menu_prompt);
			return;
		}

		// Draw display file if configured
		if (this.display_file.length > 0) {
			this.call.cmds.drawscreen(this.display_file, this.display_file_type, true);
			if (!this.display_options) {
				// File-only menu, skip option rendering
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
		currY += 2;

		// Menu options
		for (var i = 0; i < this.menu_options.length; i++) {
			var menopt = this.menu_options[i];
			if (menopt.display) {
				this.call.cmds.movecursor(currX, currY);
				if (menopt.bg_clr !== undefined) this.call.cmds.setbgcolor(menopt.bg_clr);
				if (menopt.fg_clr !== undefined) this.call.cmds.setfgcolor(menopt.fg_clr);
				this.call.cmds.senddata(menopt.display);
				currY++;
			}
		}

		this.call.cmds.resetcolors();
		this._drawPromptArea();
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

	// --- Input handling ---
	handleInput(inputArray) {
		if (!this.active) return;

		// Route to sub-module if running
		if (this.running_module && this.currentModule) {
			if (this.currentModule.active === false) {
				// Module was cleared but flag not reset — clean up
				this._doModuleReturn();
			} else if (this.currentModule.handleInput) {
				this.currentModule.handleInput(inputArray);
				return;
			} else if (this.currentModule.input_array) {
				// Legacy sub-module fallback
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
		super.handleInput(inputArray);
	}

	onKey(key) {
		// No key-based navigation for now — hotkeys are character-based
	}

	onChar(ch) {
		if (this.hotkey_arr.includes(ch.toUpperCase())) {
			var hotkey_opt = this.menu_options.find(obj => {
				return obj.hotkey && obj.hotkey.toUpperCase() === ch.toUpperCase();
			});
			if (hotkey_opt) {
				this._doMenuCommand(hotkey_opt);
			}
		}
	}

	// --- Command dispatch ---
	_doMenuCommand(menu_option) {
		var cmd = menu_option.command_name;
		alogger.writeAlog(5, this.loggingId + "\n  Command: " + cmd, "green");

		switch (cmd) {
			// --- Heavy commands: delegate to call flow ---
			case "logOff":
				this.finished = true;
				this.emitter.emit("HangupSignal");
				return;

			case "runXtrn":
				// Use call.launchDoor with the slug name
				if (menu_option.command_arg) {
					this.call.launchDoor(menu_option.command_arg);
				} else {
					this._drawError("No door configured");
				}
				return;

			case "loadMenu":
				// Navigate to a different menu
				if (menu_option.command_arg) {
					this.call.previousMenu = this.call.currentMenu;
					this.call.currentMenu = menu_option.command_arg;
					this.emitter.emit("NextStage", "menu");
				} else {
					this._drawError("No menu specified");
				}
				return;

			case "exitStage":
				this.finished = true;
				return;

			case "redrawMenu":
				if (!this.dumb) this.call.cmds.clearscreen();
				this._drawMenu();
				return;

			// --- Simple commands: run as sub-modules ---
			case "msgGroupChange":
				this._runSubModule(new msgGroupChange(this.call));
				return;

			case "msgAreaChange":
				this._runSubModule(new msgAreaChange(this.call));
				return;

			case "listMessages":
				this._runSubModule(new listMessages(this.call));
				return;

			case "readMessages":
				this._runSubModule(new readMessages(this.call));
				return;

			case "postMessage":
				// TODO: move to loadHandler when a full MessageEditorHandler is built
				this._runSubModule(new writeMessage(this.call, true, "Menu", "Message", this.call.msg_area, false));
				return;

			case "userList":
				this._runSubModule(new userList(this.call));
				return;

			case "lastCallers":
				this._runSubModule(new LastCallers(this.call));
				return;

			case "testDownload":
				this._runSubModule(new testDownloader(this.call));
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
		this.setInactivityTimeouts();
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
				// Fall back to previous menu or hang up
				if (this.call.previousMenu && this.call.previousMenu !== this.menuName) {
					this.call.currentMenu = this.call.previousMenu;
					this.emitter.emit("NextStage", "menu");
				} else {
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
		super.clearHandler();
	}
}

export { MenuHandler };