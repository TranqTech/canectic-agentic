import { BaseSubModule } from "../basesubmodule.js";
import * as mailVerification from "../../models/mailVerification.js";
import appConfig from "../../config/appConfig.js";
import { detectMailType } from "../../models/useraccounts.js";

var CLR_TITLE = 14;    // bright cyan
var CLR_HOTKEY = 11;   // bright yellow
var CLR_LABEL = 7;     // grey
var CLR_PROMPT = 11;   // bright yellow
var CLR_INPUT = 14;    // bright cyan
var CLR_SUCCESS = 10;  // bright green
var CLR_ERROR = 9;     // bright red
var CLR_DIM = 8;       // dark grey
var CLR_INFO = 6;      // cyan
var CLR_WARN = 13;     // bright magenta

// States
var STATE_CHECK = 'check';
var STATE_INPUT = 'input';
var STATE_CHANGE = 'change';
var STATE_DONE = 'done';
var STATE_ALREADY = 'already';

class mailVerify extends BaseSubModule {
	constructor(call) {
		super(call, "MailVerify");

		this._userId = null;
		this._mailAddress = '';
		this._createdAt = null;
		if (call.user_record) {
			this._userId = call.user_record.id || null;
			this._mailAddress = call.user_record.mailaddress || '';
			this._createdAt = call.user_record.created_at || null;
		}

		this._state = STATE_CHECK;
		this._inputBuffer = '';
		this._hasMessage = false;

		// Layout rows
		this._titleRow = 2;
		this._warnRow = 3;
		this._addrRow = 5;
		this._optionsRow = 7;
		this._statusRow = 11;
		this._promptRow = 0;
		this._inputRow = 0;

		this.loggingId = "MailVerify (Node " + call.nodenum + ")";
	}

	// --- Geometry ---
	_calcPos() {
		this._promptRow = this.call.term_height - 2;
		this._inputRow = this._promptRow;
	}

	// --- Days remaining until account deletion ---
	_getDaysRemaining() {
		var retentionDays = appConfig.getNumber('unverified_retention_days', 14);
		if (retentionDays <= 0 || !this._createdAt) return null;
		var created = new Date(this._createdAt);
		var expires = new Date(created.getTime() + retentionDays * 24 * 60 * 60 * 1000);
		var remaining = Math.ceil((expires.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
		return Math.max(0, remaining);
	}

	// --- Clear status/error messages ---
	_clearMessage() {
		if (!this._hasMessage) return;
		this._hasMessage = false;
		if (this.dumb) return;
		this.call.cmds.movecursor(2, this._statusRow);
		this.call.cmds.cleartoeol();
	}

	// --- Display ---

	_drawPrompt(label) {
		if (this.dumb) return;
		this.call.cmds.movecursor(2, this._promptRow);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(CLR_PROMPT);
		this.call.cmds.senddata(label);
		this.call.cmds.setfgcolor(CLR_INPUT);
	}

	_showCheck() {
		this._state = STATE_CHECK;
		this._inputBuffer = '';

		if (this.dumb) {
			this.call.cmds.senddata('\r\n');
			this.call.cmds.senddata('Email/Netmail Verification\r\n');
			var daysLeft = this._getDaysRemaining();
			if (daysLeft !== null) {
				this.call.cmds.senddata('Days remaining to validate: ' + daysLeft + '\r\n');
			}
			this.call.cmds.senddata('Address: ' + this._mailAddress + '\r\n\r\n');
			this.call.cmds.senddata('(S) Re-send verification code\r\n');
			this.call.cmds.senddata('(E) Enter verification code\r\n');
			this.call.cmds.senddata('(C) Change address\r\n');
			this.call.cmds.senddata('(Q) Quit\r\n> ');
			return;
		}

		this.call.cmds.clearscreen();
		this.call.cmds.resetcolors();

		// Title
		this.call.cmds.movecursor(2, this._titleRow);
		this.call.cmds.setfgcolor(CLR_TITLE);
		this.call.cmds.senddata('Email/Netmail Verification');

		// Days remaining warning
		var daysLeft = this._getDaysRemaining();
		if (daysLeft !== null) {
			this.call.cmds.movecursor(2, this._warnRow);
			this.call.cmds.setfgcolor(daysLeft <= 3 ? CLR_ERROR : CLR_WARN);
			this.call.cmds.senddata('Days remaining to validate: ' + daysLeft);
		}

		// Address
		this.call.cmds.movecursor(2, this._addrRow);
		this.call.cmds.setfgcolor(CLR_INFO);
		this.call.cmds.senddata('Address: ');
		this.call.cmds.setfgcolor(CLR_INPUT);
		this.call.cmds.senddata(this._mailAddress);

		// Options
		this.call.cmds.movecursor(2, this._optionsRow);
		this.call.cmds.setfgcolor(CLR_HOTKEY);
		this.call.cmds.senddata('S');
		this.call.cmds.setfgcolor(CLR_LABEL);
		this.call.cmds.senddata(' Re-send verification code');

		this.call.cmds.movecursor(2, this._optionsRow + 1);
		this.call.cmds.setfgcolor(CLR_HOTKEY);
		this.call.cmds.senddata('E');
		this.call.cmds.setfgcolor(CLR_LABEL);
		this.call.cmds.senddata(' Enter verification code');

		this.call.cmds.movecursor(2, this._optionsRow + 2);
		this.call.cmds.setfgcolor(CLR_HOTKEY);
		this.call.cmds.senddata('C');
		this.call.cmds.setfgcolor(CLR_LABEL);
		this.call.cmds.senddata(' Change address');

		this.call.cmds.movecursor(2, this._optionsRow + 3);
		this.call.cmds.setfgcolor(CLR_HOTKEY);
		this.call.cmds.senddata('Q');
		this.call.cmds.setfgcolor(CLR_LABEL);
		this.call.cmds.senddata(' Quit');

		// Prompt
		this._drawPrompt('Verify -> ');
		this.call.cmds.resetcolors();
	}

	_showInputPrompt() {
		this._state = STATE_INPUT;
		this._inputBuffer = '';

		if (this.dumb) {
			this.call.cmds.senddata('\r\nEnter your 6-digit verification code (or Q to cancel): ');
			return;
		}

		this._clearMessage();
		// Show ESC hint on the status row
		this.call.cmds.movecursor(2, this._statusRow);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(CLR_DIM);
		this.call.cmds.senddata('[Esc] to abort');
		this._drawPrompt('Enter 6-digit code: ');
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
		// Return cursor to input position
		this.call.cmds.setfgcolor(CLR_INPUT);
		this.call.cmds.movecursor(2 + this._promptLabel().length + this._inputBuffer.length, this._inputRow);
	}

	_promptLabel() {
		if (this._state === STATE_INPUT) return 'Enter 6-digit code: ';
		if (this._state === STATE_CHANGE) return 'New address: ';
		return 'Verify -> ';
	}

	_showAlreadyVerified() {
		this._state = STATE_ALREADY;

		if (this.dumb) {
			this.call.cmds.senddata('\r\nYour address is already verified!\r\n');
			this.call.cmds.senddata('Press any key to continue.\r\n');
			return;
		}

		this.call.cmds.clearscreen();
		this.call.cmds.resetcolors();
		this.call.cmds.movecursor(2, this._titleRow);
		this.call.cmds.setfgcolor(CLR_TITLE);
		this.call.cmds.senddata('Email/Netmail Verification');

		this.call.cmds.movecursor(2, this._addrRow);
		this.call.cmds.setfgcolor(CLR_SUCCESS);
		this.call.cmds.senddata('Your address is already verified!');

		this.call.cmds.movecursor(2, this._addrRow + 2);
		this.call.cmds.setfgcolor(CLR_DIM);
		this.call.cmds.senddata('Press any key to continue.');
		this.call.cmds.resetcolors();
	}

	_showSuccess() {
		this._state = STATE_DONE;

		if (this.dumb) {
			this.call.cmds.senddata('\r\nAddress verified successfully!\r\n');
			this.call.cmds.senddata('Press any key to continue.\r\n');
			return;
		}

		this._clearMessage();
		this.call.cmds.movecursor(2, this._statusRow);
		this.call.cmds.setfgcolor(CLR_SUCCESS);
		this.call.cmds.senddata('Address verified successfully!');

		this.call.cmds.movecursor(2, this._promptRow);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(CLR_DIM);
		this.call.cmds.senddata('Press any key to continue.');
		this.call.cmds.resetcolors();
	}

	_showChangePrompt() {
		this._state = STATE_CHANGE;
		this._inputBuffer = '';

		if (this.dumb) {
			this.call.cmds.senddata('\r\nEnter new email or netmail address (or Q to cancel): ');
			return;
		}

		this._clearMessage();
		this.call.cmds.movecursor(2, this._statusRow);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(CLR_DIM);
		this.call.cmds.senddata('[Esc] to abort');
		this._drawPrompt('New address: ');
	}

	async _saveNewAddress() {
		var newAddr = this._inputBuffer.trim();
		if (!newAddr) {
			this._showChangePrompt();
			this._showMessage('Address cannot be empty. Try again.', CLR_ERROR);
			return;
		}

		try {
			var postgres = await import('../../middleware/db/postgres.js');
			var userMod = await import('../../models/useraccounts.js');

			// Detect mail type from new address
			var detectResult = detectMailType(newAddr);

			// Check uniqueness
			var isUnique = await userMod.checkMailUnique(newAddr);
			if (!isUnique) {
				this._showChangePrompt();
				this._showMessage('That address is already in use. Try again.', CLR_ERROR);
				return;
			}

			// Update user record
			await postgres.write(
				'UPDATE users SET mailaddress = $1, mailtype = $2, mailverified = false, mailverified_at = NULL, mailtoken = NULL, mailtoken_created = NULL, updated_at = NOW() WHERE id = $3',
				[newAddr.toLowerCase(), detectResult, this._userId]
			);

			this._mailAddress = newAddr.toLowerCase();
			if (this.call.user_record) {
				this.call.user_record.mailaddress = this._mailAddress;
				this.call.user_record.mailtype = detectResult;
				this.call.user_record.mailverified = false;
			}

			// Send verification code to the new address
			var sendResult = await mailVerification.sendVerificationCode(this._userId);

			// Redraw the check screen with new address, then show persistent feedback
			this._showCheck();
			if (sendResult.status) {
				this._showMessage('Address updated. Verification code sent.', CLR_SUCCESS);
			} else {
				this._showMessage('Address updated. Code send failed: ' + (sendResult.error || ''), CLR_WARN);
			}
		} catch (err) {
			this._showChangePrompt();
			this._showMessage('Failed to update address. Try again.', CLR_ERROR);
		}
	}

	// --- Actions ---

	async _sendCode() {
		this._showMessage('Sending verification code...', CLR_DIM);
		var result = await mailVerification.sendVerificationCode(this._userId);
		if (result.status) {
			this._showMessage('Verification code sent to ' + this._mailAddress, CLR_SUCCESS);
		} else {
			this._showMessage(result.error || 'Failed to send code', CLR_ERROR);
		}
	}

	async _submitCode() {
		var code = this._inputBuffer.trim();
		if (code.length !== 6) {
			this._showInputPrompt();
			this._showMessage('Code must be 6 digits. Try again.', CLR_ERROR);
			return;
		}

		this._showMessage('Verifying...', CLR_DIM);
		var result = await mailVerification.verifyCode(this._userId, code);
		if (result.status) {
			if (this.call.user_record) {
				this.call.user_record.mailverified = true;
			}
			this._showSuccess();
		} else {
			this._showInputPrompt();
			this._showMessage(result.error || 'Verification failed. Try again.', CLR_ERROR);
		}
	}

	// --- Input ---

	onKey(key) {
		if (this._state === STATE_DONE || this._state === STATE_ALREADY) {
			this.signalReturn();
			return;
		}

		// Clear status on any input (except when showing ESC hint during input/change)
		if (this._hasMessage && this._state !== STATE_DONE) {
			this._clearMessage();
		}

		if (this._state === STATE_INPUT) {
			if (key === 'Enter') {
				this._submitCode();
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
				this._showCheck();
				return;
			}
			return;
		}

		if (this._state === STATE_CHANGE) {
			if (key === 'Enter') {
				this._saveNewAddress();
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
				this._showCheck();
				return;
			}
			return;
		}
	}

	onChar(ch) {
		if (this._state === STATE_DONE || this._state === STATE_ALREADY) {
			this.signalReturn();
			return;
		}

		// Clear status on any input
		if (this._hasMessage && this._state !== STATE_DONE) {
			this._clearMessage();
		}

		if (this._state === STATE_INPUT) {
			if (/[0-9]/.test(ch) && this._inputBuffer.length < 6) {
				this._inputBuffer += ch;
				this.call.cmds.senddata(ch);
			}
			return;
		}

		if (this._state === STATE_CHANGE) {
			// Accept printable characters for address input
			if (ch.length === 1 && ch.charCodeAt(0) >= 32 && this._inputBuffer.length < 80) {
				this._inputBuffer += ch;
				this.call.cmds.senddata(ch);
			}
			return;
		}

		if (this._state === STATE_CHECK) {
			var lower = ch.toLowerCase();
			if (lower === 's') {
				this._sendCode();
				return;
			}
			if (lower === 'e') {
				this._showInputPrompt();
				return;
			}
			if (lower === 'c') {
				this._showChangePrompt();
				return;
			}
			if (lower === 'q') {
				this.signalReturn();
				return;
			}
		}
	}

	// --- Lifecycle ---

	run() {
		if (!this.call) return;
		this._calcPos();

		if (!this._userId || !this._mailAddress) {
			this.signalReturn();
			return;
		}

		mailVerification.isVerified(this._userId)
			.then(verified => {
				if (!this.active) return;
				if (verified) {
					this._showAlreadyVerified();
				} else {
					this._showCheck();
				}
			})
			.catch(err => {
				if (!this.active) return;
				this.signalReturn();
			});
	}
}

export { mailVerify };
