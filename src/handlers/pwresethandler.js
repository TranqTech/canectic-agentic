import { BaseHandler } from "./basehandler.js";
import * as alogger from "../utils/alogger.js";
import * as pwReset from "../models/passwordReset.js";
import appConfig from "../config/appConfig.js";

// Input validation
var validunamechars = new RegExp("[A-Za-z0-9 ]");
var validcodechars = new RegExp("[A-Za-z0-9]");

// Colors
var CLR_TITLE = 14;
var CLR_TITLE_BG = 2;
var CLR_HOTKEY = 11;
var CLR_LABEL = 7;
var CLR_PROMPT = 11;
var CLR_INPUT = 14;
var CLR_SUCCESS = 10;
var CLR_ERROR = 9;
var CLR_DIM = 8;
var CLR_INFO = 6;

// States
var STATE_USERNAME = 'username';
var STATE_MENU = 'menu';
var STATE_CODE = 'code';
var STATE_PASSWORD = 'password';
var STATE_CONFIRM = 'confirm';
var STATE_DONE = 'done';

class PwResetHandler extends BaseHandler {
	constructor(call, system_name) {
		super(call, "PwReset");
		this.system_name = system_name;
		this.dumb = (call.term_type === "Dumb");

		this._state = STATE_USERNAME;
		this.username = "";
		this.inputbuffer = "";
		this.newPassword = "";
		this.validatedUserId = null;
		this.pwmin = appConfig.getNumber('pwmin', 12);
		this._hasMessage = false;

		// Layout
		this._titleRow = 2;
		this._infoRow = 4;
		this._optionsRow = 6;
		this._statusRow = 10;
		this._promptRow = 0;

		this.loggingId = "PwReset (Node " + this.call.nodenum + ")";
	}

	// --- Geometry ---
	_calcPos() {
		if (this.dumb) return;
		this._promptRow = this.call.term_height - 2;
	}

	// --- Drawing helpers ---
	_clearMessage() {
		if (!this._hasMessage) return;
		this._hasMessage = false;
		if (this.dumb) return;
		this.call.cmds.movecursor(2, this._statusRow);
		this.call.cmds.cleartoeol();
	}

	_drawPrompt(label) {
		if (this.dumb) return;
		this.call.cmds.movecursor(2, this._promptRow);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(CLR_PROMPT);
		this.call.cmds.senddata(label);
		this.call.cmds.setfgcolor(CLR_INPUT);
	}

	_showMessage(text, color) {
		this._hasMessage = true;
		if (this.dumb) {
			this.call.cmds.senddata('\r\n' + text + '\r\n');
			return;
		}
		this.call.cmds.movecursor(2, this._statusRow);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(color);
		this.call.cmds.senddata(text);
		// Restore cursor to input position
		this.call.cmds.setfgcolor(CLR_INPUT);
		var promptLen = this._currentPromptLen();
		this.call.cmds.movecursor(2 + promptLen + this.inputbuffer.length, this._promptRow);
	}

	_currentPromptLen() {
		switch (this._state) {
			case STATE_USERNAME: return 'Username: '.length;
			case STATE_MENU: return 'Reset -> '.length;
			case STATE_CODE: return 'Enter reset code: '.length;
			case STATE_PASSWORD: return 'New password: '.length;
			case STATE_CONFIRM: return 'Confirm password: '.length;
			default: return 0;
		}
	}

	_drawTitle() {
		if (this.dumb) return;
		this.call.cmds.clearscreen();
		this.emitter.emit("DrawSysInfo");

		var titleText = ' Reset Password ';
		var titleX = Math.round(this.call.term_width / 2) - Math.round(titleText.length / 2);
		this.call.cmds.movecursor(titleX, this._titleRow);
		this.call.cmds.setbgcolor(CLR_TITLE_BG);
		this.call.cmds.setfgcolor(CLR_TITLE);
		this.call.cmds.senddata(titleText);
		this.call.cmds.resetcolors();
	}

	// --- Screens ---

	_showUsernameScreen() {
		this._state = STATE_USERNAME;
		this.inputbuffer = "";

		if (this.dumb) {
			this.call.cmds.senddata('\r\nPassword Reset\r\n');
			this.call.cmds.senddata('Enter your username to continue: ');
			return;
		}

		this._drawTitle();

		this.call.cmds.movecursor(2, this._infoRow);
		this.call.cmds.setfgcolor(CLR_INFO);
		this.call.cmds.senddata('Enter your username to request or enter');
		this.call.cmds.movecursor(2, this._infoRow + 1);
		this.call.cmds.senddata('a password reset code.');

		this._drawPrompt('Username: ');
	}

	_showMenuScreen() {
		this._state = STATE_MENU;
		this.inputbuffer = "";

		if (this.dumb) {
			this.call.cmds.senddata('\r\nPassword reset for: ' + this.username + '\r\n');
			this.call.cmds.senddata('(S) Send reset code\r\n');
			this.call.cmds.senddata('(E) Enter reset code\r\n');
			this.call.cmds.senddata('(Q) Cancel\r\n> ');
			return;
		}

		this._drawTitle();

		this.call.cmds.movecursor(2, this._infoRow);
		this.call.cmds.setfgcolor(CLR_INFO);
		this.call.cmds.senddata('Username: ');
		this.call.cmds.setfgcolor(CLR_INPUT);
		this.call.cmds.senddata(this.username);

		this.call.cmds.movecursor(2, this._optionsRow);
		this.call.cmds.setfgcolor(CLR_HOTKEY);
		this.call.cmds.senddata('S');
		this.call.cmds.setfgcolor(CLR_LABEL);
		this.call.cmds.senddata(' Send reset code');

		this.call.cmds.movecursor(2, this._optionsRow + 1);
		this.call.cmds.setfgcolor(CLR_HOTKEY);
		this.call.cmds.senddata('E');
		this.call.cmds.setfgcolor(CLR_LABEL);
		this.call.cmds.senddata(' Enter reset code');

		this.call.cmds.movecursor(2, this._optionsRow + 2);
		this.call.cmds.setfgcolor(CLR_HOTKEY);
		this.call.cmds.senddata('Q');
		this.call.cmds.setfgcolor(CLR_LABEL);
		this.call.cmds.senddata(' Cancel');

		this._drawPrompt('Reset -> ');
		this.call.cmds.resetcolors();
	}

	_showCodePrompt() {
		this._state = STATE_CODE;
		this.inputbuffer = "";

		if (this.dumb) {
			this.call.cmds.senddata('\r\nEnter your 8-character reset code (or Q to cancel): ');
			return;
		}

		this._clearMessage();
		this.call.cmds.movecursor(2, this._statusRow);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(CLR_DIM);
		this.call.cmds.senddata('[Esc] to abort');
		this._drawPrompt('Enter reset code: ');
	}

	_showPasswordPrompt() {
		this._state = STATE_PASSWORD;
		this.inputbuffer = "";
		this.newPassword = "";

		if (this.dumb) {
			this.call.cmds.senddata('\r\nEnter new password (min ' + this.pwmin + ' chars): ');
			return;
		}

		this._clearMessage();
		this.call.cmds.movecursor(2, this._statusRow);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(CLR_DIM);
		this.call.cmds.senddata('Minimum ' + this.pwmin + ' characters. [Esc] to abort');
		this._drawPrompt('New password: ');
	}

	_showConfirmPrompt() {
		this._state = STATE_CONFIRM;
		this.inputbuffer = "";

		if (this.dumb) {
			this.call.cmds.senddata('\r\nConfirm new password: ');
			return;
		}

		this._clearMessage();
		this.call.cmds.movecursor(2, this._statusRow);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(CLR_DIM);
		this.call.cmds.senddata('[Esc] to abort');
		this._drawPrompt('Confirm password: ');
	}

	_showSuccess() {
		this._state = STATE_DONE;

		if (this.dumb) {
			this.call.cmds.senddata('\r\nPassword reset successfully!\r\n');
			this.call.cmds.senddata('Press any key to return to login.\r\n');
			return;
		}

		this._clearMessage();
		this.call.cmds.movecursor(2, this._statusRow);
		this.call.cmds.setfgcolor(CLR_SUCCESS);
		this.call.cmds.senddata('Password reset successfully!');

		this.call.cmds.movecursor(2, this._promptRow);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(CLR_DIM);
		this.call.cmds.senddata('Press any key to return to login.');
		this.call.cmds.resetcolors();
	}

	// --- Actions ---

	async _doSendReset() {
		this._showMessage('Sending reset code...', CLR_DIM);
		try {
			await pwReset.requestReset(this.username);
		} catch (err) {
			alogger.writeAlog(3, this.loggingId + " reset error: " + err.message, "yellow");
		}
		this._showMenuScreen();
		this._showMessage('If an account exists, a reset code has been sent.', CLR_SUCCESS);
	}

	async _doValidateCode() {
		var code = this.inputbuffer.trim();
		this.inputbuffer = "";

		if (code.length < 8) {
			this._showCodePrompt();
			this._showMessage('Code must be 8 characters. Try again.', CLR_ERROR);
			return;
		}

		this._showMessage('Validating...', CLR_DIM);
		var result = await pwReset.validateShortCode(this.username, code);
		if (result.valid) {
			this.validatedUserId = result.userId;
			this._showPasswordPrompt();
		} else {
			this._showCodePrompt();
			this._showMessage(result.error || 'Invalid code. Try again.', CLR_ERROR);
		}
	}

	async _doSetPassword() {
		var pw = this.inputbuffer;
		this.inputbuffer = "";

		if (pw.length < this.pwmin) {
			this._showPasswordPrompt();
			this._showMessage('Password too short. Try again.', CLR_ERROR);
			return;
		}

		this.newPassword = pw;
		this._showConfirmPrompt();
	}

	async _doConfirmPassword() {
		var confirm = this.inputbuffer;
		this.inputbuffer = "";

		if (confirm !== this.newPassword) {
			this.newPassword = "";
			this._showPasswordPrompt();
			this._showMessage('Passwords do not match. Start over.', CLR_ERROR);
			return;
		}

		this._showMessage('Resetting password...', CLR_DIM);
		var result = await pwReset.completeReset(this.validatedUserId, this.newPassword);
		if (result.status) {
			this._showSuccess();
		} else {
			this._showPasswordPrompt();
			this._showMessage(result.error || 'Reset failed. Try again.', CLR_ERROR);
		}
	}

	// --- Input handling ---
	onKey(key) {
		if (this._state === STATE_DONE) {
			this.finished = true;
			return;
		}

		// Clear status on input for non-menu states
		if (this._hasMessage && this._state !== STATE_MENU) {
			this._clearMessage();
		}

		if (this._state === STATE_USERNAME) {
			if (key === 'Enter') {
				this.username = this.inputbuffer.trim();
				this.inputbuffer = "";
				if (this.username.length > 0) {
					this._showMenuScreen();
				}
				return;
			}
			if (key === 'Backspace') {
				if (this.inputbuffer.length > 0) {
					this.inputbuffer = this.inputbuffer.slice(0, -1);
					this.call.cmds.senddata("\b \b");
				}
				return;
			}
			if (key === 'ESC' || key === '^A') {
				this.finished = true;
				return;
			}
			return;
		}

		if (this._state === STATE_CODE || this._state === STATE_PASSWORD || this._state === STATE_CONFIRM) {
			if (key === 'Enter') {
				if (this._state === STATE_CODE) this._doValidateCode();
				else if (this._state === STATE_PASSWORD) this._doSetPassword();
				else if (this._state === STATE_CONFIRM) this._doConfirmPassword();
				return;
			}
			if (key === 'Backspace') {
				if (this.inputbuffer.length > 0) {
					this.inputbuffer = this.inputbuffer.slice(0, -1);
					this.call.cmds.senddata("\b \b");
				}
				return;
			}
			if (key === 'ESC') {
				this._showMenuScreen();
				return;
			}
			return;
		}
	}

	onChar(ch) {
		if (this._state === STATE_DONE) {
			this.finished = true;
			return;
		}

		// Clear status on input for menu state
		if (this._hasMessage && this._state === STATE_MENU) {
			this._clearMessage();
		}

		if (this._state === STATE_USERNAME) {
			if (ch.toLowerCase() === 'q' && this.inputbuffer.length === 0) {
				this.finished = true;
				return;
			}
			if (validunamechars.test(ch)) {
				this.inputbuffer += ch;
				this.call.cmds.senddata(ch);
			}
			return;
		}

		if (this._state === STATE_MENU) {
			var lower = ch.toLowerCase();
			if (lower === 's') {
				this._doSendReset();
				return;
			}
			if (lower === 'e') {
				this._showCodePrompt();
				return;
			}
			if (lower === 'q') {
				this.finished = true;
				return;
			}
			return;
		}

		if (this._state === STATE_CODE) {
			if (validcodechars.test(ch) && this.inputbuffer.length < 8) {
				this.inputbuffer += ch;
				this.call.cmds.senddata(ch.toUpperCase());
			}
			return;
		}

		if (this._state === STATE_PASSWORD || this._state === STATE_CONFIRM) {
			if (ch.length === 1 && ch.charCodeAt(0) >= 32) {
				this.inputbuffer += ch;
				this.call.cmds.senddata('*');
			}
			return;
		}
	}

	// --- Lifecycle ---
	signalReturn() {
		this.emitter.emit("ModuleReturn");
	}

	startStage() {
		if (!this.call) return;
		try {
			this._calcPos();
			this._showUsernameScreen();
			this.setInactivityTimeouts();
		} catch (err) {
			this._handleError("startStage error", err);
		}
	}
}

export { PwResetHandler };
