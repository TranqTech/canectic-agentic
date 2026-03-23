import { BaseHandler } from "./basehandler.js";
import * as alogger from "../utils/alogger.js";
import { DateTime } from "luxon";
import { checkUsernameAvailable, createNewUser, getUserRecord } from "../models/useraccounts.js";
import { checkRegMailAddress } from "../utils/evalmailaddresses.js";
import appConfig from "../config/appConfig.js";

// Input validation
const validunamechars = new RegExp("[A-Za-z0-9 ]");
const validnamechars = new RegExp("[A-Za-z ]");
const validlocationchars = new RegExp("[A-Za-z0-9, ]");
const validrnamechars = new RegExp("[A-Za-z]");
const validnetmailchars = new RegExp("[A-Za-z0-9:/\\.@]");
const validpwchars = new RegExp("[A-Za-z0-9]");
const validdatechars = new RegExp("[0-9]");

// Config (read at point of use via appConfig)

// Colors
const border_clr = 4;
const label_clr = 15;
const progress_clr = 14;
const title_clr = 15;
const title_bg_clr = 2;
const error_clr = 1;
const success_clr = 2;
const input_clr = 14;
const esc_clr = 13;
const nav_clr = 15;
const pwl_clr = 13;
const warn_clr = 2;

// Registration stages
const regstages = [
	{ display: "Age Verification",    field_name: "AgeVerification", prompt: "Are you over the age of 13?", prompt2: "Enter Y/N", inputtype: "YesNo",    continueonno: false, prompt_clr: "11" },
	{ display: "Username",            field_name: "Username",        prompt: "Please enter your desired Username/Alias",           inputtype: "Username", prompt_clr: "11" },
	{ display: "Password",            field_name: "Password",        prompt: "Please enter your desired Password",                 inputtype: "Password", prompt_clr: "11" },
	{ display: "Password Confirmation", field_name: "PasswordConfirm", prompt: "Please re-enter your password",                    inputtype: "Password", prompt_clr: "11" },
	{ display: "First Name",          field_name: "Firstname",       prompt: "Please enter your full First (given) name",          inputtype: "RealName", prompt_clr: "11" },
	{ display: "Last Name",           field_name: "Lastname",        prompt: "Please enter your full Last (family) name",          inputtype: "RealName", prompt_clr: "11" },
	{ display: "Location",            field_name: "Location",        prompt: "Where are you calling from?",                        inputtype: "Location", prompt_clr: "11" },
	{ display: "Netmail",             field_name: "Netmail",         prompt: "Please enter an Email or Netmail address you can be reached at", inputtype: "Netmail", prompt_clr: "11" },
	{ display: "Birthdate",           field_name: "Birthdate",       prompt: "Please enter your birthdate as YYYY/MM/DD",          inputtype: "Date",     prompt_clr: "11" },
];

class RegistrationHandler extends BaseHandler {
	constructor(call, system_name) {
		super(call, "Registration");
		this.system_name = system_name;
		this.dumb = (call.term_type === "Dumb");

		// Use shorter inactivity timeout for input fields
		this.inactivityTO = appConfig.getNumber('inputTO', 20) * 1000; // seconds → ms

		// User data
		this.firstname = "";
		this.lastname = "";
		this.fullname = "";
		this.username = "";
		this.password = "";
		this.location = "";
		this.birth_month = "";
		this.birth_day = "";
		this.birth_year = "";
		this.birthdate = "";
		this.mailaddress = "";
		this.mailtype = "";

		// Form state
		this.inputbuffer = "";
		this.current_field = 0;
		this.current_input_type = "";
		this.field_name = "";
		this.entries = 0;
		this.last_completed = null;
		this.validRegistration = false;
		this.fatal_error = false;
		this.escPending = false;

		// Box geometry
		this.box_width = 42;
		this.box_height = 12;
		this.box_start_x = 0;
		this.box_start_y = 0;
		this.box_end_x = 0;
		this.prompt_height = 3;
		this.label_x = 0;
		this.label_y = 0;
		this.prompt_x = 0;
		this.prompt_y = 0;
		this.input_x = 0;
		this.input_y = 0;
		this.title_x = 0;
		this.title_y = 0;
		this.errorx = 0;
		this.errory = 0;
		this.cursor_x = 0;
		this.cursor_y = 0;
		this.confirm_x = 3;
		this.confirm_y = 3;
		this.warnx = 0;
		this.warny = 25;
		this.haswarning = false;
		this.nav_x = 3;
		this.nav_y = 0;
		this.nav_msg = "Arrows move forward and back";
		this.esc_msg = "ESC Twice to abort";
		this.title = " " + system_name + " - New User Registration ";

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

		this.loggingId = "Registration (Node " + this.call.nodenum + ")";
	}

	// --- Geometry ---
	_calcMenuPos() {
		if (this.dumb) return;
		if (this.call.term_width <= 0) return;

		this.box_start_x = Math.round(this.call.term_width / 2) - Math.round(this.box_width / 2);
		this.box_start_y = Math.round(this.call.term_height / 2) - Math.round(this.box_height / 2);
		this.box_end_x = this.box_start_x + this.box_width;
		this.title_x = Math.round(this.call.term_width / 2) - Math.round(this.title.length / 2);
		this.title_y = this.box_start_y - 2;
		this.label_x = this.box_start_x + 2;
		this.label_y = this.box_start_y + 1;
		this.prompt_x = this.box_start_x + 2;
		this.prompt_y = this.label_y + 2;
		this.input_x = this.box_start_x + 2;
		this.input_y = this.prompt_y + this.prompt_height + 1;
		this.errorx = this.box_start_x + 1;
		this.errory = this.input_y + 2;
		this.warnx = this.errorx;
		this.warny = this.errory;
		this.nav_y = this.call.term_height - 3;

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

	// --- Box drawing ---
	_drawBox() {
		if (this.dumb) return;

		this.call.cmds.clearscreen();
		this.emitter.emit("DrawSysInfo");

		// Title banner
		this.call.cmds.movecursor(this.title_x, this.title_y);
		this.call.cmds.setbgcolor(title_bg_clr);
		this.call.cmds.setfgcolor(title_clr);
		this.call.cmds.senddata(this.title);
		this.call.cmds.resetcolors();

		var currY = this.box_start_y;
		this.call.cmds.movecursor(this.box_start_x, currY);
		this.call.cmds.setfgcolor(border_clr);
		this.call.cmds.senddata(this.menu_top_line);

		// Label row
		currY++;
		this.call.cmds.movecursor(this.box_start_x, currY);
		this.call.cmds.senddata(this.menu_vert_block);
		this.call.cmds.movecursor(this.box_end_x, currY);
		this.call.cmds.senddata(this.menu_vert_block);

		// Mid separator
		currY++;
		this.call.cmds.movecursor(this.box_start_x, currY);
		this.call.cmds.senddata(this.menu_mid_line);

		// Prompt rows
		for (var ph = 0; ph < this.prompt_height; ph++) {
			currY++;
			this.call.cmds.movecursor(this.box_start_x, currY);
			this.call.cmds.senddata(this.menu_vert_block);
			this.call.cmds.movecursor(this.box_end_x, currY);
			this.call.cmds.senddata(this.menu_vert_block);
		}

		// Mid separator
		currY++;
		this.call.cmds.movecursor(this.box_start_x, currY);
		this.call.cmds.senddata(this.menu_mid_line);

		// Input row
		currY++;
		this.call.cmds.movecursor(this.box_start_x, currY);
		this.call.cmds.senddata(this.menu_vert_block);
		this.call.cmds.movecursor(this.box_end_x, currY);
		this.call.cmds.senddata(this.menu_vert_block);

		// Bottom line
		currY++;
		this.call.cmds.movecursor(this.box_start_x, currY);
		this.call.cmds.senddata(this.menu_bottom_line);
	}

	_drawCmds() {
		if (this.dumb) return;
		var currY = this.nav_y;
		this.call.cmds.movecursor(this.nav_x, currY);
		this.call.cmds.setfgcolor(nav_clr);
		this.call.cmds.senddata(this.nav_msg);
		currY++;
		this.call.cmds.movecursor(this.nav_x, currY);
		this.call.cmds.setfgcolor(esc_clr);
		this.call.cmds.senddata(this.esc_msg);
	}

	// --- Field clear helpers ---
	_clearLabel() {
		if (this.dumb) return;
		this.call.cmds.movecursor(this.label_x, this.label_y);
		this.call.cmds.cleartoeol();
		this.call.cmds.movecursor(this.box_end_x, this.label_y);
		this.call.cmds.setfgcolor(border_clr);
		this.call.cmds.senddata(this.menu_vert_block);
		this.call.cmds.resetcolors();
	}

	_clearPrompt() {
		if (this.dumb) return;
		var currY = this.prompt_y;
		for (var i = 0; i < this.prompt_height; i++) {
			this.call.cmds.movecursor(this.prompt_x, currY);
			this.call.cmds.cleartoeol();
			this.call.cmds.movecursor(this.box_end_x, currY);
			this.call.cmds.setfgcolor(border_clr);
			this.call.cmds.senddata(this.menu_vert_block);
			currY++;
		}
		this.call.cmds.resetcolors();
	}

	_clearInput() {
		if (this.dumb) return;
		this.call.cmds.movecursor(this.input_x, this.input_y);
		this.call.cmds.cleartoeol();
		this.call.cmds.movecursor(this.box_end_x, this.input_y);
		this.call.cmds.setfgcolor(border_clr);
		this.call.cmds.senddata(this.menu_vert_block);
		this.call.cmds.resetcolors();
	}

	_showError(msg) {
		if (this.dumb) {
			this.call.cmds.senddata("\r\n  " + msg + "\r\n");
			return;
		}
		this.call.cmds.movecursor(this.errorx, this.errory);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(error_clr);
		this.call.cmds.senddata(msg);
		this.call.cmds.resetcolors();
	}

	_showSuccess(msg) {
		if (this.dumb) {
			if (msg) this.call.cmds.senddata("\r\n  " + msg + "\r\n");
			return;
		}
		this.call.cmds.movecursor(this.errorx, this.errory);
		this.call.cmds.cleartoeol();
		if (msg) {
			this.call.cmds.setfgcolor(success_clr);
			this.call.cmds.senddata(msg);
		}
		this.call.cmds.resetcolors();
	}

	// --- Prompt display ---
	_fillPrompt() {
		switch (this.field_name) {
			case "Username":
				if (this.username) {
					this.inputbuffer = this.username;
					this.call.cmds.senddata(this.username);
					this.cursor_x += this.username.length;
				}
				break;
			case "Firstname":
				if (this.firstname) {
					this.inputbuffer = this.firstname;
					this.call.cmds.senddata(this.firstname);
					this.cursor_x += this.firstname.length;
				}
				break;
			case "Lastname":
				if (this.lastname) {
					this.inputbuffer = this.lastname;
					this.call.cmds.senddata(this.lastname);
					this.cursor_x += this.lastname.length;
				}
				break;
			case "Password":
				if (!this.dumb) {
					var minlmsg = "Min length: " + appConfig.getNumber('pwmin', 12);
					this.call.cmds.movecursor(this.input_x, this.input_y - 2);
					this.call.cmds.setfgcolor(pwl_clr);
					this.call.cmds.senddata(minlmsg);
					this.call.cmds.movecursor(this.input_x, this.input_y);
					this.call.cmds.setfgcolor(input_clr);
				}
				if (this.password) {
					this.inputbuffer = this.password;
					var pwstring = "*".repeat(this.password.length);
					this.call.cmds.senddata(pwstring);
					this.cursor_x += pwstring.length;
				}
				break;
			case "Birthdate":
				if (this.birthdate) {
					this.inputbuffer = this.birthdate;
					this.call.cmds.senddata(this.birthdate);
					this.cursor_x += this.birthdate.length;
				}
				break;
			case "Location":
				if (this.location) {
					this.inputbuffer = this.location;
					this.call.cmds.senddata(this.location);
					this.cursor_x += this.location.length;
				}
				break;
			case "Netmail":
				if (this.mailaddress) {
					this.inputbuffer = this.mailaddress;
					this.call.cmds.senddata(this.mailaddress);
					this.cursor_x += this.mailaddress.length;
				}
				break;
		}
	}

	_sendPrompt() {
		if (this.current_field >= regstages.length) {
			this._confirmEntries();
			return;
		}

		if (this.current_field > 0) {
			if (this.last_completed === null) {
				this.last_completed = this.current_field - 1;
			} else if (this.current_field - 1 > this.last_completed) {
				this.last_completed = this.current_field - 1;
			}
		}

		if (this.entries > 0) {
			this._clearLabel();
			this._clearPrompt();
			this._clearInput();
		}

		this.current_input_type = regstages[this.current_field].inputtype;
		this.field_name = regstages[this.current_field].field_name;
		this.inputbuffer = "";

		if (this.dumb) {
			this.call.cmds.senddata("\r\n" + regstages[this.current_field].display + ": ");
			this.call.cmds.senddata(regstages[this.current_field].prompt + "\r\n");
			if (regstages[this.current_field].prompt2) {
				this.call.cmds.senddata(regstages[this.current_field].prompt2 + "\r\n");
			}
			this.call.cmds.senddata("> ");
			this.cursor_x = 0;
			this.cursor_y = 0;
			this._fillPrompt();
			return;
		}

		// Progress percentage
		var completepcnt = this.current_field > 0
			? Math.round(this.current_field / regstages.length * 100) + "%"
			: "0%";
		var percentx = this.box_end_x - (completepcnt.length + 2);

		// Label
		this.call.cmds.movecursor(this.label_x, this.label_y);
		this.call.cmds.setfgcolor(label_clr);
		this.call.cmds.senddata(regstages[this.current_field].display);
		this.call.cmds.movecursor(percentx, this.label_y);
		this.call.cmds.setfgcolor(progress_clr);
		this.call.cmds.senddata(completepcnt);

		// Prompt text with word-wrap
		var currY = this.prompt_y;
		this.call.cmds.movecursor(this.prompt_x, currY);
		this.call.cmds.setfgcolor(regstages[this.current_field].prompt_clr);
		var promptwordarr = regstages[this.current_field].prompt.split(" ");
		var xpos = this.prompt_x;
		for (var pri = 0; pri < promptwordarr.length; pri++) {
			if (pri !== 0) {
				if (xpos < (this.box_end_x - 1)) {
					this.call.cmds.senddata(" ");
					xpos++;
				} else {
					xpos = this.prompt_x;
					currY++;
					this.call.cmds.movecursor(xpos, currY);
				}
			}
			if ((xpos + promptwordarr[pri].length) < this.box_end_x) {
				this.call.cmds.senddata(promptwordarr[pri]);
				xpos += promptwordarr[pri].length;
			} else {
				xpos = this.prompt_x;
				currY++;
				this.call.cmds.movecursor(xpos, currY);
				this.call.cmds.senddata(promptwordarr[pri]);
				xpos += promptwordarr[pri].length;
			}
		}

		if (regstages[this.current_field].prompt2) {
			currY++;
			if (currY < this.prompt_y + (this.prompt_height - 1)) {
				currY = this.prompt_y + (this.prompt_height - 1);
			}
			this.call.cmds.movecursor(this.prompt_x, currY);
			this.call.cmds.senddata(regstages[this.current_field].prompt2);
		}

		// Input line
		this.call.cmds.movecursor(this.input_x, this.input_y);
		this.cursor_x = this.input_x;
		this.cursor_y = this.input_y;
		this.call.cmds.setfgcolor(input_clr);
		this._fillPrompt();
	}

	// --- Confirmation screen ---
	_confirmEntries() {
		this.field_name = "Confirmation";
		this.current_input_type = "YesNoQuit";
		this.inputbuffer = "";

		if (this.dumb) {
			this.call.cmds.senddata("\r\nConfirm User Data:\r\n");
			this.call.cmds.senddata("  Real Name: " + this.fullname + "\r\n");
			this.call.cmds.senddata("  Username : " + this.username + "\r\n");
			this.call.cmds.senddata("  Location : " + this.location + "\r\n");
			this.call.cmds.senddata("  Password : *********\r\n");
			this.call.cmds.senddata("  Netmail  : " + this.mailaddress + "\r\n");
			this.call.cmds.senddata("  Birthday : " + this.birthdate + "\r\n");
			this.call.cmds.senddata("\r\nDo you wish to complete registration?\r\n");
			this.call.cmds.senddata("Y/N/Q: ");
			return;
		}

		this.call.cmds.clearscreen();
		var currY = this.confirm_y;

		this.call.cmds.movecursor(this.confirm_x, currY);
		this.call.cmds.setfgcolor(11);
		this.call.cmds.senddata("Confirm User Data:");
		currY += 2;

		var fields = [
			{ label: "Real Name: ", value: this.fullname },
			{ label: "Username : ", value: this.username },
			{ label: "Location : ", value: this.location },
			{ label: "Password : ", value: "*********" },
			{ label: "Netmail  : ", value: this.mailaddress },
			{ label: "Birthday : ", value: this.birthdate },
		];

		for (var fi = 0; fi < fields.length; fi++) {
			this.call.cmds.movecursor(this.confirm_x, currY);
			this.call.cmds.setfgcolor(2);
			this.call.cmds.senddata(fields[fi].label);
			this.call.cmds.setfgcolor(14);
			this.call.cmds.senddata(fields[fi].value);
			currY++;
		}

		currY += 1;
		this.call.cmds.movecursor(this.confirm_x, currY);
		this.call.cmds.setfgcolor(11);
		this.call.cmds.senddata("Do you wish to complete registration?");
		currY++;
		this.call.cmds.movecursor(this.confirm_x, currY);
		this.call.cmds.senddata("Y/N/Q:");
	}

	// --- Input handling ---
	handleInput(inputArray) {
		if (this.haswarning) {
			this._clearWarning();
		}
		super.handleInput(inputArray);
	}

	onKey(key) {
		if (key !== "ESC") this.escPending = false;

		switch (key) {
			case "Enter":
				this._checkEnter();
				return;
			case "Backspace":
				if (this.current_input_type === "Date") {
					this._doDateBackspace();
				} else {
					this._doBackspace();
				}
				return;
			case "UpArrow":
			case "LeftArrow":
				this._prevField();
				return;
			case "DownArrow":
			case "RightArrow":
			case "Tab":
				this._nextField();
				return;
			case "ESC":
				if (this.escPending) {
					// Double ESC — abort registration
					this.finished = true;
				} else {
					// Single ESC — clear current input
					this.escPending = true;
					this.inputbuffer = "";
					this._clearInput();
					if (!this.dumb) {
						this.call.cmds.movecursor(this.input_x, this.input_y);
						this.call.cmds.setfgcolor(input_clr);
						this.cursor_x = this.input_x;
					}
				}
				return;
			case "^A":
				this.finished = true;
				return;
		}
	}

	onChar(ch) {
		this.escPending = false;

		switch (this.current_input_type) {
			case "YesNo":
				if (ch.toLowerCase() === "y" || ch.toLowerCase() === "n") {
					this.call.cmds.senddata(ch);
					this.inputbuffer += ch;
					this._evalInput();
				}
				break;

			case "YesNoQuit":
				if (ch.toLowerCase() === "q") {
					this.finished = true;
					return;
				}
				if (ch.toLowerCase() === "y" || ch.toLowerCase() === "n") {
					this.call.cmds.senddata(ch);
					this.inputbuffer += ch;
					this._evalInput();
				}
				break;

			case "Name":
				if (this.inputbuffer.length < 1) ch = ch.toUpperCase();
				if (validnamechars.test(ch)) {
					this.inputbuffer += ch;
					this.call.cmds.senddata(ch);
					this.cursor_x++;
				}
				break;

			case "Netmail":
				ch = ch.toLowerCase();
				if (validnetmailchars.test(ch)) {
					this.inputbuffer += ch;
					this.call.cmds.senddata(ch);
					this.cursor_x++;
				}
				break;

			case "RealName":
				if (this.inputbuffer.length < 1) ch = ch.toUpperCase();
				if (validrnamechars.test(ch)) {
					this.inputbuffer += ch;
					this.call.cmds.senddata(ch);
					this.cursor_x++;
				}
				break;

			case "Location":
				if (this.inputbuffer.length < 1) ch = ch.toUpperCase();
				if (validlocationchars.test(ch)) {
					this.inputbuffer += ch;
					this.call.cmds.senddata(ch);
					this.cursor_x++;
				}
				break;

			case "Username":
				if (validunamechars.test(ch)) {
					this.inputbuffer += ch;
					this.call.cmds.senddata(ch);
					this.cursor_x++;
				}
				break;

			case "Password":
				if (validpwchars.test(ch)) {
					this.inputbuffer += ch;
					this.call.cmds.senddata("*");
					this.cursor_x++;
				}
				break;

			case "Date":
				this._handleDateChar(ch);
				break;
		}
	}

	_handleDateChar(ch) {
		if (!validdatechars.test(ch)) return;
		var len = this.inputbuffer.length;

		if (len === 0) {
			if (ch !== "0" && ch < "3") {
				this.inputbuffer += ch;
				this.call.cmds.senddata(ch);
				this.cursor_x++;
			}
			return;
		}
		if (len === 1) {
			if (ch === "0" || ch === "9") {
				this.inputbuffer += ch;
				this.call.cmds.senddata(ch);
				this.cursor_x++;
			}
			return;
		}
		if (len === 2) {
			this.inputbuffer += ch;
			this.call.cmds.senddata(ch);
			this.cursor_x++;
			return;
		}
		if (len === 3) {
			this.inputbuffer += ch;
			this.call.cmds.senddata(ch);
			this.cursor_x++;
			this.inputbuffer += "/";
			this.call.cmds.senddata("/");
			this.cursor_x++;
			return;
		}
		if (len === 5) {
			if (ch === "0" || ch === "1") {
				this.inputbuffer += ch;
				this.call.cmds.senddata(ch);
				this.cursor_x++;
			}
			return;
		}
		if (len === 6) {
			if (this.inputbuffer.slice(5) === "1") {
				if (ch < "3") {
					this.inputbuffer += ch;
					this.call.cmds.senddata(ch);
					this.cursor_x++;
					this.inputbuffer += "/";
					this.call.cmds.senddata("/");
					this.cursor_x++;
				}
				return;
			}
			this.inputbuffer += ch;
			this.call.cmds.senddata(ch);
			this.inputbuffer += "/";
			this.call.cmds.senddata("/");
			this.cursor_x += 2;
			return;
		}
		if (len === 8) {
			if (ch < "4") {
				this.inputbuffer += ch;
				this.call.cmds.senddata(ch);
				this.cursor_x++;
			}
			return;
		}
		if (len === 9) {
			this.inputbuffer += ch;
			this.call.cmds.senddata(ch);
			this.cursor_x++;
			return;
		}
	}

	// --- Backspace ---
	_doBackspace() {
		if (this.inputbuffer.length > 0) {
			this.inputbuffer = this.inputbuffer.slice(0, -1);
			this.call.cmds.senddata("\b \b");
			this.cursor_x--;
		}
	}

	_doDateBackspace() {
		if (this.inputbuffer.length > 0) {
			if (this.inputbuffer.length === 5 || this.inputbuffer.length === 8) {
				this.inputbuffer = this.inputbuffer.slice(0, -1);
				this.call.cmds.senddata("\b \b");
				this.cursor_x--;
			}
			this.inputbuffer = this.inputbuffer.slice(0, -1);
			this.call.cmds.senddata("\b \b");
			this.cursor_x--;
		}
	}

	// --- Enter handling ---
	_checkEnter() {
		switch (this.current_input_type) {
			case "YesNo":
			case "YesNoQuit":
				this.call.cmds.sendbeep();
				break;
			case "Date":
				if (this.inputbuffer.length === 10) {
					this._evalInput();
				} else {
					this.call.cmds.sendbeep();
				}
				break;
			default:
				if (this.inputbuffer.length > 0) {
					this._evalInput();
				} else {
					this.call.cmds.sendbeep();
				}
				break;
		}
	}

	// --- Field navigation ---
	_nextField() {
		if (this.last_completed !== null && this.current_field <= this.last_completed) {
			this.current_field++;
			if (regstages[this.current_field] && regstages[this.current_field].field_name === "PasswordConfirm") {
				if (this.current_field <= this.last_completed) {
					this.current_field++;
				}
			}
			this.inputbuffer = "";
			this._sendPrompt();
			return;
		}
		this.call.cmds.sendbeep();
	}

	_prevField() {
		if (this.current_field > 0) {
			this.current_field--;
			if (regstages[this.current_field] && regstages[this.current_field].field_name === "PasswordConfirm") {
				this.current_field--;
			}
			this.inputbuffer = "";
			this._sendPrompt();
			return;
		}
		this.call.cmds.sendbeep();
	}

	// --- Input evaluation ---
	_evalInput() {
		this.entries++;

		switch (this.field_name) {
			case "Confirmation":
				if (this.inputbuffer.toLowerCase() === "y") {
					this.inputbuffer = "";
					this._createUser();
					return;
				}
				// Restart registration
				this.current_field = 0;
				this.inputbuffer = "";
				this.current_input_type = "";
				this.field_name = "";
				this._startRegistration();
				return;

			case "AgeVerification":
				if (this.inputbuffer.toLowerCase() === "y") {
					this._showSuccess("");
					this.inputbuffer = "";
					this.current_field++;
					this._sendPrompt();
					return;
				}
				this.inputbuffer = "";
				this._showError("You must be 13 to access this site");
				if (!this.dumb) {
					this.call.cmds.movecursor(this.errorx, this.errory + 1);
					this.call.cmds.setfgcolor(error_clr);
					this.call.cmds.senddata("Press any key to exit Registration");
					this.call.cmds.resetcolors();
				} else {
					this.call.cmds.senddata("  Press any key to exit Registration\r\n");
				}
				this.finished = true;
				return;

			case "Username":
				var username = this.inputbuffer;
				checkUsernameAvailable(this.inputbuffer)
					.then(res => {
						if (!this.active) return;
						if (res === true) {
							this._showSuccess("Username Available");
							this.username = username;
							this.inputbuffer = "";
							this.current_field++;
							this._sendPrompt();
						} else {
							this.inputbuffer = "";
							this._showError("Username in use. Try again");
							this._sendPrompt();
						}
					})
					.catch(err => {
						if (!this.active) return;
						alogger.writeAlog(5, this.loggingId + "\n  Error checking username\n" + err, "red");
						this.inputbuffer = "";
						this._showError("Error checking username. Try again");
						this._sendPrompt();
					});
				return;

			case "Password":
				if (this.inputbuffer.length > appConfig.getNumber('pwmin', 12)) {
					this._showSuccess("Password OK!");
					this.password = this.inputbuffer;
					this.inputbuffer = "";
					this.current_field++;
					this._sendPrompt();
				} else {
					this.inputbuffer = "";
					this._showError("Password too short.");
					this._sendPrompt();
				}
				return;

			case "PasswordConfirm":
				if (this.inputbuffer === this.password) {
					this._showSuccess("Password OK!");
					this.password = this.inputbuffer;
					this.inputbuffer = "";
					this.current_field++;
					this._sendPrompt();
				} else {
					this.inputbuffer = "";
					this.password = "";
					this.current_field--;
					this.last_completed = this.current_field;
					this._showError("Passwords don't match");
					this._sendPrompt();
				}
				return;

			case "Firstname":
				if (this.inputbuffer.length > 0) {
					this._showSuccess("");
					this.firstname = this.inputbuffer;
					this.inputbuffer = "";
					this.current_field++;
					this._sendPrompt();
				} else {
					this.inputbuffer = "";
					this._showError("Please try again");
					this._sendPrompt();
				}
				return;

			case "Lastname":
				if (this.inputbuffer.length > 0) {
					this._showSuccess("");
					this.lastname = this.inputbuffer;
					this.fullname = this.firstname + " " + this.lastname;
					this.inputbuffer = "";
					this.current_field++;
					this._sendPrompt();
				} else {
					this.inputbuffer = "";
					this._showError("Please try again");
					this._sendPrompt();
				}
				return;

			case "Location":
				if (this.inputbuffer.length > 0) {
					this._showSuccess("");
					this.location = this.inputbuffer;
					this.inputbuffer = "";
					this.current_field++;
					this._sendPrompt();
				} else {
					this.inputbuffer = "";
					this._showError("Please try again");
					this._sendPrompt();
				}
				return;

			case "Netmail":
				if (this.inputbuffer.length > 0) {
					var checkaddr = this.inputbuffer;
					checkRegMailAddress(checkaddr)
						.then(res => {
							if (!this.active) return;
							if (res.status) {
								this._showSuccess("");
								this.mailaddress = checkaddr;
								this.mailtype = res.mailtype;
								this.inputbuffer = "";
								this.current_field++;
								this._sendPrompt();
							} else {
								this.inputbuffer = "";
								if (res.isvalid && res.inuse) {
									this._showError("Address already in use");
								} else {
									this._showError("That does not appear to be a valid address");
								}
								this._sendPrompt();
							}
						})
						.catch(err => {
							if (!this.active) return;
							alogger.writeAlog(4, this.loggingId + "\n  Netmail check error: " + err, "red");
							this.inputbuffer = "";
							this._showError("Error validating address");
							this._sendPrompt();
						});
				}
				return;

			case "Birthdate":
				var datearr = this.inputbuffer.split("/");
				var currentyear = DateTime.now().toFormat("yyyy");
				var roughuserage = currentyear - datearr[0];

				if (roughuserage < appConfig.getNumber('minage', 13)) {
					this.inputbuffer = "";
					this._showError("That birthdate would make you too young for access.");
					this._sendPrompt();
					return;
				}
				if (roughuserage > 110) {
					this.inputbuffer = "";
					this._showError("You're over 110? Really?");
					this._sendPrompt();
					return;
				}
				if (datearr[1] > 12) {
					this.inputbuffer = "";
					this._showError("Invalid Date String");
					this._sendPrompt();
					return;
				}
				if (datearr[2] > 31) {
					this.inputbuffer = "";
					this._showError("Invalid Date String");
					this._sendPrompt();
					return;
				}

				this._showSuccess("");
				this.birth_day = datearr[2];
				this.birth_month = datearr[1];
				this.birth_year = datearr[0];
				this.birthdate = this.inputbuffer;
				this.inputbuffer = "";
				this.current_field++;
				this._sendPrompt();
				return;

			default:
				this.inputbuffer = "";
				this._showError("Something went wrong. Try again.");
				this._sendPrompt();
				return;
		}
	}

	// --- User creation ---
	_createUser() {
		alogger.writeAlog(5, this.loggingId + "\n  Attempting to create user record", "green");

		var newres = {
			username: this.username,
			firstname: this.firstname,
			lastname: this.lastname,
			fullname: this.firstname + " " + this.lastname,
			password: this.password,
			mailaddress: this.mailaddress,
			location: this.location,
			birthdate: this.birthdate,
			birth_day: this.birth_day,
			birth_month: this.birth_month,
			birth_year: this.birth_year,
		};

		createNewUser(newres)
			.then(res => {
				if (!this.active) return;
				if (res.status) {
					var logmsg = this.loggingId + "\n  New user registration complete!"
						+ "\n  Username: " + this.username
						+ "\n  DbID: " + res.resultid;
					alogger.writeAlog(5, logmsg, "greenbright", true);
					alogger.writeClog(3, logmsg, "NewUsers", "greenbright", true);
					this.validRegistration = true;
					this.dbid = res.resultid;
					this._validReg();
				} else {
					this._doRegError();
				}
			})
			.catch(err => {
				if (!this.active) return;
				alogger.writeAlog(3, this.loggingId + "\n  Error creating user\n" + err, "red");
				this._doRegError();
			});
	}

	_validReg() {
		this._clearAllTimeouts();
		this.call.cmds.senddata("\r\nRecord written to DB!\r\nTesting it can be retrieved...");
		this.call.caller_fullname = this.fullname;
		this.call.caller_username = this.username;
		this.call.caller_location = this.location;

		getUserRecord(this.username)
			.then(urecord => {
				if (!this.active) return;
				if (urecord) {
					this.call.user_record = urecord;
					this.call.cmds.senddata("\r\nUser Creation Success!\r\n  Press Enter to Continue...");
					this.finished = true;
				} else {
					this._doRegError();
				}
			})
			.catch(err => {
				if (!this.active) return;
				alogger.writeAlog(3, this.loggingId + "\n  Error retrieving new user\n" + err, "red");
				this._doRegError();
			});
	}

	_doRegError() {
		this.call.cmds.senddata("\r\nSomething went wrong saving your registration");
		this.call.cmds.senddata("\r\n Please try again later, but unfortunately we must exit now");
		this.call.cmds.senddata("\r\n  Press Enter to Hangup...");
		this.validRegistration = false;
		this.fatal_error = true;
		this.finished = true;
	}

	// --- Warning display ---
	_clearWarning() {
		if (!this.haswarning) return;
		this.haswarning = false;
		if (this.dumb) return;
		this.call.cmds.movecursor(this.warnx, this.warny);
		this.call.cmds.cleartoeol();
		// Restore cursor to input position
		this.call.cmds.setfgcolor(input_clr);
		this.call.cmds.movecursor(this.cursor_x, this.cursor_y);
	}

	onInactivityWarn() {
		if (!this.call) return;
		this.haswarning = true;
		if (!this.dumb) {
			this.call.cmds.movecursor(this.warnx, this.warny);
			this.call.cmds.cleartoeol();
			this.call.cmds.setfgcolor(warn_clr);
		}
		this.call.cmds.senddata(this.warnMsg);
	}

	onInactivityKick() {
		if (!this.call) return;
		if (!this.dumb) {
			this.call.cmds.movecursor(this.warnx, this.warny);
			this.call.cmds.setfgcolor(warn_clr);
			this.call.cmds.cleartoeol();
		}
		this.call.cmds.senddata(this.inactiveMsg);
		alogger.writeAlog(3, this.loggingId + "\n  Inactivity disconnect.", "cyan");
		this.emitter.emit("HangupSignal");
	}

	// --- Start registration flow ---
	_startRegistration() {
		alogger.writeAlog(5, this.loggingId + "\n  Starting new Registration", "greenbright", true);
		if (!this.dumb) {
			this._drawBox();
			this._drawCmds();
		}
		this._sendPrompt();
	}

	// --- Lifecycle ---
	signalReturn() {
		if (this.validRegistration) {
			this.emitter.emit("RegistrationOK");
		} else if (this.fatal_error) {
			this.emitter.emit("InvalidReg");
		} else {
			this.emitter.emit("ModuleReturn");
		}
	}

	startStage() {
		if (!this.call) return;
		try {
			this._calcMenuPos();
			this.call.cmds.drawrandomscreen("Registration");
			this._startRegistration();
			this.setInactivityTimeouts();
		} catch (err) {
			this._handleError("startStage error", err);
		}
	}
}

export { RegistrationHandler };