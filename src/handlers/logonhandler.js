import { BaseHandler } from "./basehandler.js";
import { LoginHandler } from "./loginhandler.js";
import { RegistrationHandler } from "./registrationhandler.js";
import { PwResetHandler } from "./pwresethandler.js";
import { getSystemInfo } from "../utils/systeminfo.js";
import * as alogger from "../utils/alogger.js";

const menuoptions = [
	{ display: "Login",              destination: "Login" },
	{ display: "New User (Register)", destination: "Registration" },
	{ display: "Reset Password",     destination: "PasswordReset" },
	{ display: "Disconnect",         destination: "Goodbye" },
];

const spacebuffer = 2;
const disconnectmsg = "Ok, Goodbye!";

class LogonHandler extends BaseHandler {
	constructor(call) {
		super(call, "Logon");
		this.dumb = (call.term_type === "Dumb");
		this.sysinfo = getSystemInfo();

		if (this.sysinfo.boardname) {
			this.system_name = this.sysinfo.boardname;
		} else {
			this.system_name = "Default BBS";
		}

		// Menu state
		this.menuposition = 0;
		this.prevmenupos = 0;

		// Menu geometry
		this.menuwidth = 0;
		this.menuheight = 0;
		this.lbwidth = 0;
		this.menustartx = 10;
		this.menustarty = 8;
		this.lightbarx = this.menustartx + 1;

		// Sysinfo position
		this.sysinfox = 0;
		this.sysinfoy = 0;

		// Error/warning position
		this.errorx = 0;
		this.errory = 0;
		this.warnx = 0;
		this.warny = 25;
		this.haswarning = false;

		// Sub-module tracking
		this.running_module = false;
		this.currentModule = null;

		this.theme = this.call.theme;
		this.loggingId = "Logon (Node " + this.call.nodenum + ")";
	}

	// --- Menu geometry ---
	_calcMenuPos() {
		for (var mo = 0; mo < menuoptions.length; mo++) {
			var optwidth = menuoptions[mo].display.length + spacebuffer;
			if (optwidth > this.lbwidth) {
				this.menuwidth = optwidth + 2;
				this.lbwidth = optwidth;
			}
		}
		this.menuheight = menuoptions.length + 2;

		if (!this.dumb) {
			this.menustartx = Math.round(this.call.term_width / 2) - Math.round(this.menuwidth / 2);
			this.menustarty = Math.round(this.call.term_height / 2) - Math.round(this.menuheight / 2);
			this.lightbarx = this.menustartx + 1;

			if (this.sysinfo.longestline + 1 < this.call.term_width) {
				this.sysinfox = this.call.term_width - (this.sysinfo.longestline + 1);
			} else {
				this.sysinfox = 0;
			}
			this.sysinfoy = this.call.term_height - this.sysinfo.validlines;

			this.errory = this.menustarty + this.menuheight + 2;
			this.errorx = this.menustartx;
			this.warnx = this.errorx;
			this.warny = this.errory;
		}
	}

	// --- Drawing ---
	_drawOpt(opti) {
		this.call.cmds.resetcolors();
		this.call.cmds.senddata(Buffer.from(" "));
		this.call.cmds.setfgcolor(this.theme.lb_cmd_clr);
		this.call.cmds.senddata(Buffer.from(menuoptions[opti].display.substr(0, 1)));
		this.call.cmds.setfgcolor(this.theme.opt_clr);
		var menuline = menuoptions[opti].display.slice(1);
		for (var si = (menuoptions[opti].display.length + 3); si < this.menuwidth; si++) {
			menuline += " ";
		}
		this.call.cmds.senddata(menuline);
	}

	_drawLitOpt(opti) {
		this.call.cmds.resetcolors();
		this.call.cmds.setbgcolor(this.theme.lb_clr);
		this.call.cmds.senddata(Buffer.from(" "));
		this.call.cmds.setfgcolor(this.theme.lb_cmd_clr);
		this.call.cmds.senddata(Buffer.from(menuoptions[opti].display.substr(0, 1)));
		this.call.cmds.setfgcolor(this.theme.lb_opt_clr);
		var menuline = menuoptions[opti].display.slice(1);
		for (var si = (menuoptions[opti].display.length + 3); si < this.menuwidth; si++) {
			menuline += " ";
		}
		this.call.cmds.senddata(menuline);
	}

	_drawLightbar() {
		if (this.dumb) return;

		// Previous line y location
		var pldy = this.prevmenupos + 1 + this.menustarty;
		// Current line y location
		var nldy = this.menuposition + 1 + this.menustarty;

		// Redraw previous position as unlit
		this.call.cmds.movecursor(this.lightbarx, pldy);
		this.call.cmds.resetcolors();
		this._drawOpt(this.prevmenupos);

		// Draw new position as lit
		this.call.cmds.movecursor(this.lightbarx, nldy);
		this._drawLitOpt(this.menuposition);
		this.call.cmds.movecursor(this.lightbarx + menuoptions[this.menuposition].display.length + 1, nldy);
		this.call.cmds.resetcolors();
	}

	_drawSysInfo() {
		if (this.dumb) {
			this.call.cmds.senddata("\r\n\r\n\r\n");
			this.call.cmds.senddata(this.sysinfo.systemver);
			this.call.cmds.senddata("\r\n");
			this.call.cmds.senddata(this.sysinfo.boardname || "Default BBS");
			this.call.cmds.senddata("\r\n");
			this.call.cmds.senddata(this.sysinfo.location);
			this.call.cmds.senddata("\r\n");
			this.call.cmds.senddata(this.sysinfo.connecttime);
			this.call.cmds.senddata("\r\n");
			return;
		}

		var currY = this.sysinfoy;
		this.call.cmds.resetcolors();

		if (this.sysinfo.systemver) {
			this.call.cmds.movecursor(2, 1);
			this.call.cmds.setfgcolor(this.theme.ver_clr);
			this.call.cmds.senddata(this.sysinfo.systemver);
		}

		this.call.cmds.movecursor(this.sysinfox, this.sysinfoy);
		this.call.cmds.setfgcolor(this.theme.board_name_clr);
		this.call.cmds.senddata(this.sysinfo.boardname || "Default BBS");

		if (this.sysinfo.location) {
			currY++;
			this.call.cmds.movecursor(this.sysinfox, currY);
			this.call.cmds.setfgcolor(this.theme.board_loc_clr);
			this.call.cmds.senddata(this.sysinfo.location);
		}

		if (this.sysinfo.connecttime) {
			currY++;
			this.call.cmds.movecursor(this.sysinfox, currY);
			this.call.cmds.setfgcolor(this.theme.time_clr);
			this.call.cmds.senddata(this.sysinfo.connecttime);
		}

		this.call.cmds.resetcolors();
	}

	_drawMenu() {
		if (this.dumb) {
			this.call.cmds.senddata("\r\n");
			for (var i = 0; i < menuoptions.length; i++) {
				this.call.cmds.senddata("\r\n  ");
				this.call.cmds.senddata(Buffer.from(menuoptions[i].display.substr(0, 1)));
				this.call.cmds.senddata(") ");
				this.call.cmds.senddata(Buffer.from(menuoptions[i].display));
			}
			this.call.cmds.senddata("\r\n");
			return;
		}

		this.call.cmds.resetcolors();
		var menubarchar = this.call.charset.getBoxBuff(26);
		var menuvertchar = this.call.charset.getBoxBuff(7);
		var menuTL = this.call.charset.getBoxBuff(22);
		var menuTR = this.call.charset.getBoxBuff(8);
		var menuBL = this.call.charset.getBoxBuff(21);
		var menuBR = this.call.charset.getBoxBuff(9);

		// Top border
		this.call.cmds.movecursor(this.menustartx, this.menustarty);
		this.call.cmds.setfgcolor(this.theme.box_border_clr);
		this.call.cmds.senddata(menuTL);
		for (var i = 0; i < this.lbwidth; i++) {
			this.call.cmds.senddata(menubarchar);
		}
		this.call.cmds.senddata(menuTR);

		// Menu options
		for (var i = 0; i < menuoptions.length; i++) {
			this.call.cmds.movecursor(this.menustartx, this.menustarty + 1 + i);
			this.call.cmds.setfgcolor(this.theme.box_border_clr);
			this.call.cmds.senddata(menuvertchar);
			this._drawOpt(i);
			this.call.cmds.setfgcolor(this.theme.box_border_clr);
			this.call.cmds.senddata(menuvertchar);
		}

		// Bottom border
		this.call.cmds.movecursor(this.menustartx, this.menustarty + menuoptions.length + 1);
		this.call.cmds.setfgcolor(this.theme.box_border_clr);
		this.call.cmds.senddata(menuBL);
		for (var i = 0; i < this.lbwidth; i++) {
			this.call.cmds.senddata(menubarchar);
		}
		this.call.cmds.senddata(menuBR);
	}

	// --- Menu navigation ---
	_moveNextOption() {
		this.prevmenupos = this.menuposition;
		if (this.menuposition < (menuoptions.length - 1)) {
			this.menuposition++;
		} else {
			this.menuposition = 0;
		}
		this._drawLightbar();
	}

	_movePrevOption() {
		this.prevmenupos = this.menuposition;
		if (this.menuposition > 0) {
			this.menuposition--;
		} else {
			this.menuposition = menuoptions.length - 1;
		}
		this._drawLightbar();
	}

	// --- Input handling ---
	handleInput(inputArray) {
		if (!this.active) return;

		// Route input to sub-module if one is running
		if (this.running_module && this.currentModule && this.currentModule.active) {
			this.currentModule.handleInput(inputArray);
			return;
		}

		if (this.haswarning) {
			this._clearWarning();
		}
		super.handleInput(inputArray);
	}

	onKey(key) {
		switch (key) {
			case "Enter":
				this._doCmd();
				return;
			case "DownArrow":
			case "RightArrow":
				this._moveNextOption();
				return;
			case "UpArrow":
			case "LeftArrow":
				this._movePrevOption();
				return;
		}
	}

	onChar(ch) {
		switch (ch.toUpperCase()) {
			case "L":
				this._doLogin();
				return;
			case "N":
				this._doRegistration();
				return;
			case "D":
				this._doDisconnect();
				return;
			case "R":
				this._doPwReset();
				return;
		}
	}

	// --- Command dispatch ---
	_doCmd() {
		var dest = menuoptions[this.menuposition].destination;
		switch (dest) {
			case "Login":
				this._doLogin();
				break;
			case "Registration":
				this._doRegistration();
				break;
			case "PasswordReset":
				this._doPwReset();
				break;
			case "Goodbye":
				this._doDisconnect();
				break;
			default:
				alogger.writeAlog(4, this.loggingId + "\n  Unknown menu destination: " + dest, "yellow");
				break;
		}
	}

	// --- Sub-modules ---
	_showModuleLoading(label) {
		if (!this.dumb) {
			this.call.cmds.movecursor(this.lightbarx, this.menustarty + this.menuheight);
			this.call.cmds.resetcolors();
			this.call.cmds.setfgcolor(this.theme.cmd_clr);
			this.call.cmds.senddata(label);
			this.call.cmds.movecursor(this.lightbarx, this.menustarty + this.menuheight + 1);
			this.call.cmds.senddata("Loading. Please Wait...");
			this.call.cmds.resetcolors();
		} else {
			this.call.cmds.senddata("\r\n  " + label + "\r\n");
			this.call.cmds.senddata("  Loading. Please Wait...\r\n");
		}
	}

	_startModule(module) {
		this._clearAllTimeouts();
		this.running_module = true;
		this.currentModule = module;
		module.startStage();
	}

	_doModuleReturn() {
		if (this.currentModule) {
			try {
				this.currentModule.clearHandler();
			} catch (err) {
				alogger.writeAlog(4, this.loggingId + "\n  Module cleanup error: " + err, "yellow");
			}
		}
		this.running_module = false;
		this.currentModule = null;
	}

	_doLogin() {
		if (!this.call) return;
		alogger.writeAlog(5, this.loggingId + "\n  Starting Login Sub-Module", "green");
		this._showModuleLoading("Login");

		var module = new LoginHandler(this.call, this.system_name);

		module.emitter.on("ModuleReturn", () => {
			this._doModuleReturn();
			this._restartStage();
		});

		module.emitter.on("DrawSysInfo", () => {
			if (this.currentModule && this.currentModule.type === "Login") {
				this._drawSysInfo();
			}
		});

		module.emitter.on("LoginOK", () => {
			console.log("Login Good!")
			if (this.currentModule && this.currentModule.type === "Login") {
				this._doModuleReturn();
				this.emitter.emit("LogCallStart");
				this.finished = true;
				this.emitter.emit("LoginOK");
			}
		});

		module.emitter.on("LoginLimit", () => {
			if (this.currentModule && this.currentModule.type === "Login") {
				this._doModuleReturn();
				this.emitter.emit("HangupSignal");
			}
		});

		this._startModule(module);
	}

	_doRegistration() {
		if (!this.call) return;
		alogger.writeAlog(5, this.loggingId + "\n  Starting Registration Sub-Module", "green");
		this._showModuleLoading("Registration");

		var module = new RegistrationHandler(this.call, this.system_name);

		module.emitter.on("InvalidReg", () => {
			if (this.currentModule && this.currentModule.type === "Registration") {
				this._doModuleReturn();
				this.emitter.emit("HangupSignal");
			}
		});

		module.emitter.on("HangupSignal", () => {
			if (this.currentModule && this.currentModule.type === "Registration") {
				this._doModuleReturn();
				this.emitter.emit("HangupSignal");
			}
		});

		module.emitter.on("DrawSysInfo", () => {
			if (this.currentModule && this.currentModule.type === "Registration") {
				this._drawSysInfo();
			}
		});

		module.emitter.on("ModuleReturn", () => {
			if (this.currentModule && this.currentModule.type === "Registration") {
				this._doModuleReturn();
				this._restartStage();
			}
		});

		module.emitter.on("RegistrationOK", () => {
			if (this.currentModule && this.currentModule.type === "Registration") {
				this._doModuleReturn();
				this.emitter.emit("LogCallStart");
				this.finished = true;
				this.signalReturn();
			}
		});

		this._startModule(module);
	}

	_doPwReset() {
		if (!this.call) return;
		alogger.writeAlog(5, this.loggingId + "\n  Starting PW Reset Sub-Module", "green");
		this._showModuleLoading("PW Reset");

		var module = new PwResetHandler(this.call, this.system_name);

		module.emitter.on("ModuleReturn", () => {
			if (this.currentModule && this.currentModule.type === "PwReset") {
				this._doModuleReturn();
				this._restartStage();
			}
		});

		this._startModule(module);
	}

	_doDisconnect() {
		this._clearAllTimeouts();
		if (!this.dumb) {
			this.call.cmds.movecursor(this.lightbarx, this.menustarty + this.menuheight);
			this.call.cmds.resetcolors();
			this.call.cmds.setfgcolor(this.theme.cmd_clr);
			this.call.cmds.senddata("Disconnect");
			this.call.cmds.movecursor(this.lightbarx, this.menustarty + this.menuheight + 1);
			this.call.cmds.senddata(disconnectmsg);
			this.call.cmds.resetcolors();
		} else {
			this.call.cmds.senddata("\r\nDisconnect\r\n");
		}
		this.emitter.emit("HangupSignal");
	}

	// --- Warning display ---
	_clearWarning() {
		if (!this.haswarning) return;
		this.haswarning = false;
		if (this.dumb) return;
		this.call.cmds.movecursor(this.warnx, this.warny);
		this.call.cmds.cleartoeol();
	}

	// Override BaseHandler to position warning below the menu
	onInactivityWarn() {
		if (!this.call || this.running_module) return;
		this.haswarning = true;
		if (!this.dumb) {
			this.call.cmds.movecursor(this.warnx, this.warny);
			this.call.cmds.cleartoeol();
			this.call.cmds.setfgcolor(this.theme.warn_clr);
		}
		this.call.cmds.senddata(this.warnMsg);
	}

	// Override BaseHandler to position kick message and hang up
	onInactivityKick() {
		if (!this.call) return;
		if (this.running_module) return;
		if (!this.dumb) {
			this.call.cmds.movecursor(this.warnx, this.warny);
			this.call.cmds.setfgcolor(this.theme.warn_clr);
			this.call.cmds.cleartoeol();
		}
		this.call.cmds.senddata(this.inactiveMsg);
		var logmsg = this.loggingId + "\n  Inactivity disconnect.";
		alogger.writeAlog(3, logmsg, "cyan");
		this._clearAllTimeouts();
		this.emitter.emit("HangupSignal");
	}

	// --- Restart after sub-module return ---
	_restartStage() {
		if (this.finished || !this.active || !this.call) return;
		this.menuposition = 0;
		this.prevmenupos = 0;
		this._calcMenuPos();
		this.call.cmds.clearscreen();
		this.call.cmds.drawrandomscreen("Logon");
		this._drawSysInfo();
		this._drawMenu();
		this._drawLightbar();
		this.setInactivityTimeouts();
	}

	// --- Lifecycle ---
	signalReturn() {
		this.emitter.emit("ModuleReturn");
	}

	startStage() {
		if (this.finished) return;
		if (!this.call) return;

		try {
			this._calcMenuPos();
			this.call.cmds.clearscreen();
			this.call.cmds.drawrandomscreen("Logon");
			this._drawSysInfo();
			this._drawMenu();
			this._drawLightbar();
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
				alogger.writeAlog(4, this.loggingId + "\n  Module cleanup error on clear: " + err, "yellow");
			}
			this.currentModule = null;
			this.running_module = false;
		}
		this.theme = null;
		super.clearHandler();
	}
}

export { LogonHandler };