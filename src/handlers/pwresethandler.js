import { BaseHandler } from "./basehandler.js";
import * as alogger from "../utils/alogger.js";

// Input validation
const validunamechars = new RegExp("[A-Za-z0-9 ]");

// Colors
const border_clr = 4;
const unameclr = 11;
const unamelabel = 10;
const logonmsgclr = 15;
const logonmsgbg = 2;
const prompt_clr = 14;

class PwResetHandler extends BaseHandler {
	constructor(call, system_name) {
		super(call, "PwReset");
		this.system_name = system_name;
		this.dumb = (call.term_type === "Dumb");

		// State
		this.username = "";
		this.current_field = "Username";

		// Box geometry
		this.logonmessage = " Reset Password ";
		this.logonmessagex = 0;
		this.logonmessagey = 0;
		this.box_start_x = 0;
		this.box_start_y = 0;
		this.box_end_x = 0;
		this.box_width = 48;
		this.resultheight = 6;
		this.box_height = this.resultheight + 4;
		this.exitmsg = "Press Enter to Exit";
		this.exitmsgx = 0;
		this.exitmsgy = 0;
		this.resultx = 0;
		this.resulty = 0;
		this.usernamex = 0;
		this.usernamey = 0;

		// Box drawing characters
		if (!this.dumb && call.charset) {
			this.menuTL = call.charset.getBoxBuff(22);
			this.menuTR = call.charset.getBoxBuff(8);
			this.menuBL = call.charset.getBoxBuff(21);
			this.menuBR = call.charset.getBoxBuff(9);
			this.menuLT = call.charset.getBoxBuff(25);
			this.menuRT = call.charset.getBoxBuff(6);
			this.menu_hz_block = call.charset.getBoxBuff(26);
			this.menu_vert_block = call.charset.getBoxBuff(7);
		}

		// Pre-built line buffers (populated in _calcMenuPos)
		this.menu_top_line = null;
		this.menu_mid_line = null;
		this.menu_bottom_line = null;

		this.loggingId = "PwReset (Node " + this.call.nodenum + ")";
	}

	// --- Geometry ---
	_calcMenuPos() {
		if (this.dumb) return;
		if (this.call.term_width <= 0) return;

		this.box_start_x = Math.round(this.call.term_width / 2) - Math.round(this.box_width / 2);
		this.box_start_y = Math.round(this.call.term_height / 2) - Math.round(this.box_height / 2);
		this.box_end_x = this.box_start_x + this.box_width;
		this.resultx = this.box_start_x + 2;
		this.usernamex = this.box_start_x + 12;
		this.usernamey = this.box_start_y + 2;
		this.resulty = this.usernamey + 2;
		this.exitmsgx = Math.round(this.call.term_width / 2) - Math.round(this.exitmsg.length / 2);
		this.exitmsgy = this.resulty + this.resultheight - 1;
		this.logonmessagex = Math.round(this.call.term_width / 2) - Math.round(this.logonmessage.length / 2);

		if ((this.box_start_y - 2) > 0) {
			this.logonmessagey = this.box_start_y - 2;
		} else {
			this.logonmessagey = 1;
		}

		// Build box line buffers
		this.menu_top_line = this.menuTL;
		this.menu_mid_line = this.menuLT;
		this.menu_bottom_line = this.menuBL;

		for (var i = 0; i < (this.box_width - 1); i++) {
			this.menu_top_line = Buffer.concat([this.menu_top_line, this.menu_hz_block]);
			this.menu_mid_line = Buffer.concat([this.menu_mid_line, this.menu_hz_block]);
			this.menu_bottom_line = Buffer.concat([this.menu_bottom_line, this.menu_hz_block]);
		}
		this.menu_top_line = Buffer.concat([this.menu_top_line, this.menuTR]);
		this.menu_mid_line = Buffer.concat([this.menu_mid_line, this.menuRT]);
		this.menu_bottom_line = Buffer.concat([this.menu_bottom_line, this.menuBR]);
	}

	// --- Drawing ---
	_drawBox() {
		if (this.dumb) return;

		// Title banner
		this.call.cmds.movecursor(this.logonmessagex, this.logonmessagey);
		this.call.cmds.setbgcolor(logonmsgbg);
		this.call.cmds.setfgcolor(logonmsgclr);
		this.call.cmds.senddata(this.logonmessage);
		this.call.cmds.resetcolors();

		var currY = this.box_start_y + 1;

		// Top line
		this.call.cmds.movecursor(this.box_start_x, currY);
		this.call.cmds.setfgcolor(border_clr);
		this.call.cmds.senddata(this.menu_top_line);
		currY++;

		// Username row
		this.call.cmds.movecursor(this.box_start_x, currY);
		this.call.cmds.senddata(this.menu_vert_block);
		this.call.cmds.setfgcolor(unamelabel);
		this.call.cmds.senddata(" Username: ");
		this.call.cmds.movecursor(this.box_end_x, currY);
		this.call.cmds.setfgcolor(border_clr);
		this.call.cmds.senddata(this.menu_vert_block);
		currY++;

		// Mid separator
		this.call.cmds.movecursor(this.box_start_x, currY);
		this.call.cmds.setfgcolor(border_clr);
		this.call.cmds.senddata(this.menu_mid_line);
		currY++;

		// Result area rows
		for (var rl = 0; rl < this.resultheight; rl++) {
			this.call.cmds.movecursor(this.box_start_x, currY);
			this.call.cmds.senddata(this.menu_vert_block);
			this.call.cmds.movecursor(this.box_end_x, currY);
			this.call.cmds.setfgcolor(border_clr);
			this.call.cmds.senddata(this.menu_vert_block);
			currY++;
		}

		// Bottom line
		this.call.cmds.movecursor(this.box_start_x, currY);
		this.call.cmds.setfgcolor(border_clr);
		this.call.cmds.senddata(this.menu_bottom_line);

		// Position cursor in username field
		this.call.cmds.movecursor(this.usernamex, this.usernamey);
		this.call.cmds.setfgcolor(unameclr);
	}

	_sendUnamePrompt() {
		if (!this.dumb) {
			this.call.cmds.movecursor(this.usernamex, this.usernamey);
			this.call.cmds.cleartoeol();
			this.call.cmds.setfgcolor(border_clr);
			this.call.cmds.movecursor(this.box_end_x, this.usernamey);
			this.call.cmds.senddata(this.menu_vert_block);
			this.call.cmds.movecursor(this.usernamex, this.usernamey);
			this.call.cmds.setfgcolor(unameclr);
		} else {
			this.call.cmds.senddata("\r\n Username: ");
		}
	}

	_sendExitPrompt() {
		if (this.dumb) {
			this.call.cmds.senddata("\r\nIf there is an account for \"" + this.username + "\", a password reset message will be sent.\r\n");
			this.call.cmds.senddata(this.exitmsg + "\r\n");
			return;
		}

		this.call.cmds.movecursor(this.resultx, this.resulty);
		this.call.cmds.setfgcolor(prompt_clr);

		// Word-wrap the result message within the box
		var msgstring = "If there is an account for \"" + this.username + "\", a password reset message will be sent.";
		var msgstringarr = msgstring.split(" ");
		var xpos = this.resultx;
		var currY = this.resulty;

		for (var ma = 0; ma < msgstringarr.length; ma++) {
			if (ma > 0) {
				if (xpos + 1 < this.box_end_x - 1) {
					this.call.cmds.senddata(" ");
					xpos++;
				} else {
					xpos = this.resultx;
					currY++;
					this.call.cmds.movecursor(this.resultx, currY);
				}
			}
			if ((xpos + msgstringarr[ma].length) < (this.box_end_x - 1)) {
				this.call.cmds.senddata(msgstringarr[ma]);
				xpos += msgstringarr[ma].length;
			} else {
				xpos = this.resultx;
				currY++;
				this.call.cmds.movecursor(this.resultx, currY);
				this.call.cmds.senddata(msgstringarr[ma]);
				xpos += msgstringarr[ma].length;
			}
		}

		this.call.cmds.movecursor(this.exitmsgx, this.exitmsgy);
		this.call.cmds.setfgcolor(11);
		this.call.cmds.senddata(this.exitmsg);
	}

	// --- Input handling ---
	onKey(key) {
		if (this.current_field === "WaitForExit") {
			this.finished = true;
			return;
		}

		switch (key) {
			case "Enter":
				if (this.username.length > 0) {
					this._doReset();
				} else {
					this.call.cmds.sendbeep();
				}
				return;
			case "Backspace":
				if (this.username.length > 0) {
					this.username = this.username.slice(0, -1);
					this.call.cmds.senddata("\b \b");
				}
				return;
			case "ESC":
			case "^A":
				this.finished = true;
				return;
		}
	}

	onChar(ch) {
		if (this.current_field === "WaitForExit") {
			this.finished = true;
			return;
		}

		if (validunamechars.test(ch)) {
			this.username += ch;
			this.call.cmds.senddata(ch);
		}
	}

	// --- Reset action ---
	_doReset() {
		// TODO: actual password reset logic (send netmail, generate token, etc.)
		this.current_field = "WaitForExit";
		this._sendExitPrompt();
	}

	// --- Lifecycle ---
	signalReturn() {
		this.emitter.emit("ModuleReturn");
	}

	startStage() {
		if (!this.call) return;
		try {
			this._calcMenuPos();
			this.call.cmds.clearscreen();
			this.emitter.emit("DrawSysInfo");

			if (!this.dumb) {
				this._drawBox();
			} else {
				this.call.cmds.movecursor(2, 3);
				this._sendUnamePrompt();
			}

			this.setInactivityTimeouts();
		} catch (err) {
			this._handleError("startStage error", err);
		}
	}
}

export { PwResetHandler };