// passwordReset.js - Logged-in password change.
// User proves identity with current password, then sets a new one.
// No reset code needed since they're already authenticated.

import { BaseSubModule } from "../basesubmodule.js";
import { checkUserPass, updateUserPassword } from "../../models/useraccounts.js";
import appConfig from "../../config/appConfig.js";

var CLR_TITLE = 14;
var CLR_HOTKEY = 11;
var CLR_LABEL = 7;
var CLR_PROMPT = 11;
var CLR_INPUT = 14;
var CLR_SUCCESS = 10;
var CLR_ERROR = 9;
var CLR_DIM = 8;
var CLR_INFO = 6;

var STATE_CURRENT = 'current';
var STATE_NEW = 'new';
var STATE_CONFIRM = 'confirm';
var STATE_DONE = 'done';

class passwordReset extends BaseSubModule {
	constructor(call) {
		super(call, "PasswordChange");

		this._username = '';
		if (call.user_record) {
			this._username = call.user_record.username || '';
		}

		this._state = STATE_CURRENT;
		this._inputBuffer = '';
		this._hasMessage = false;
		this._newPassword = '';
		this._pwmin = appConfig.getNumber('pwmin', 12);

		// Layout rows
		this._titleRow = 2;
		this._infoRow = 4;
		this._statusRow = 8;
		this._promptRow = 0;
		this._inputRow = 0;

		this.loggingId = "PasswordChange (Node " + call.nodenum + ")";
	}

	_calcPos() {
		this._promptRow = this.call.term_height - 2;
		this._inputRow = this._promptRow;
	}

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
		// Restore cursor to end of current input on the prompt line
		var promptLen = this._currentLabel().length;
		var inputLen = this._inputBuffer.length;
		this.call.cmds.movecursor(2 + promptLen + inputLen, this._promptRow);
		this.call.cmds.setfgcolor(CLR_INPUT);
	}

	_currentLabel() {
		switch (this._state) {
			case STATE_CURRENT: return 'Current password: ';
			case STATE_NEW: return 'New password: ';
			case STATE_CONFIRM: return 'Confirm password: ';
			default: return '';
		}
	}

	// --- Screens ---

	_showCurrentPrompt() {
		this._state = STATE_CURRENT;
		this._inputBuffer = '';

		if (this.dumb) {
			this.call.cmds.senddata('\r\nChange Password\r\n');
			this.call.cmds.senddata('Enter your current password: ');
			return;
		}

		this.call.cmds.clearscreen();
		this.call.cmds.resetcolors();

		this.call.cmds.movecursor(2, this._titleRow);
		this.call.cmds.setfgcolor(CLR_TITLE);
		this.call.cmds.senddata('Change Password');

		this.call.cmds.movecursor(2, this._infoRow);
		this.call.cmds.setfgcolor(CLR_INFO);
		this.call.cmds.senddata('Enter your current password to continue.');

		this.call.cmds.movecursor(2, this._infoRow + 1);
		this.call.cmds.setfgcolor(CLR_DIM);
		this.call.cmds.senddata('[Esc] to cancel');

		this._drawPrompt('Current password: ');
	}

	_showNewPrompt() {
		this._state = STATE_NEW;
		this._inputBuffer = '';
		this._newPassword = '';

		if (this.dumb) {
			this.call.cmds.senddata('\r\nEnter new password (min ' + this._pwmin + ' chars): ');
			return;
		}

		this._clearMessage();
		this.call.cmds.movecursor(2, this._infoRow);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(CLR_INFO);
		this.call.cmds.senddata('Choose a new password.');
		this.call.cmds.movecursor(2, this._infoRow + 1);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(CLR_DIM);
		this.call.cmds.senddata('Minimum ' + this._pwmin + ' characters. [Esc] to cancel');
		this._drawPrompt('New password: ');
	}

	_showConfirmPrompt() {
		this._state = STATE_CONFIRM;
		this._inputBuffer = '';

		if (this.dumb) {
			this.call.cmds.senddata('\r\nConfirm new password: ');
			return;
		}

		this._clearMessage();
		this.call.cmds.movecursor(2, this._infoRow + 1);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(CLR_DIM);
		this.call.cmds.senddata('[Esc] to cancel');
		this._drawPrompt('Confirm password: ');
	}

	_showSuccess() {
		this._state = STATE_DONE;

		if (this.dumb) {
			this.call.cmds.senddata('\r\nPassword changed successfully!\r\n');
			this.call.cmds.senddata('Press any key to continue.\r\n');
			return;
		}

		this._clearMessage();
		this.call.cmds.movecursor(2, this._statusRow);
		this.call.cmds.setfgcolor(CLR_SUCCESS);
		this.call.cmds.senddata('Password changed successfully!');

		this.call.cmds.movecursor(2, this._promptRow);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(CLR_DIM);
		this.call.cmds.senddata('Press any key to continue.');
		this.call.cmds.resetcolors();
	}

	// --- Actions ---

	async _verifyCurrent() {
		var pw = this._inputBuffer;
		this._inputBuffer = '';

		if (!pw) {
			this._showCurrentPrompt();
			this._showMessage('Password cannot be empty.', CLR_ERROR);
			return;
		}

		var result = await checkUserPass(this._username, pw);
		if (result.isvalid) {
			this._showNewPrompt();
		} else {
			this._showCurrentPrompt();
			this._showMessage('Incorrect password. Try again.', CLR_ERROR);
		}
	}

	async _submitNew() {
		var pw = this._inputBuffer;
		this._inputBuffer = '';

		if (pw.length < this._pwmin) {
			this._showNewPrompt();
			this._showMessage('Password must be at least ' + this._pwmin + ' characters.', CLR_ERROR);
			return;
		}

		this._newPassword = pw;
		this._showConfirmPrompt();
	}

	async _submitConfirm() {
		var confirm = this._inputBuffer;
		this._inputBuffer = '';

		if (confirm !== this._newPassword) {
			this._newPassword = '';
			this._showNewPrompt();
			this._showMessage('Passwords do not match. Start over.', CLR_ERROR);
			return;
		}

		var success = await updateUserPassword(this._username, this._newPassword);
		if (success) {
			this._showSuccess();
		} else {
			this._showNewPrompt();
			this._showMessage('Failed to update password. Try again.', CLR_ERROR);
		}
	}

	// --- Input ---

	onKey(key) {
		if (this._state === STATE_DONE) {
			this.signalReturn();
			return;
		}

		if (this._hasMessage) {
			this._clearMessage();
		}

		if (key === 'Enter') {
			if (this._state === STATE_CURRENT) this._verifyCurrent();
			else if (this._state === STATE_NEW) this._submitNew();
			else if (this._state === STATE_CONFIRM) this._submitConfirm();
			return;
		}
		if (key === 'Backspace') {
			if (this._inputBuffer.length > 0) {
				this._inputBuffer = this._inputBuffer.slice(0, -1);
				this.call.cmds.senddata('\b \b');
			}
			return;
		}
		if (key === 'ESC') {
			this.signalReturn();
			return;
		}
	}

	onChar(ch) {
		if (this._state === STATE_DONE) {
			this.signalReturn();
			return;
		}

		if (this._hasMessage) {
			this._clearMessage();
		}

		if (ch.length === 1 && ch.charCodeAt(0) >= 32) {
			this._inputBuffer += ch;
			this.call.cmds.senddata('*');
		}
	}

	// --- Lifecycle ---
	run() {
		if (!this.call) return;
		this._calcPos();

		if (!this._username) {
			this.signalReturn();
			return;
		}

		this._showCurrentPrompt();
	}
}

export { passwordReset };
