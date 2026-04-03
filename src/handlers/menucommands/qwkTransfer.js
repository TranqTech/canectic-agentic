// qwkTransfer.js -- QWK Mail Transfer
//
// Terminal menu command for downloading QWK packets and uploading REP packets.
// Uses the native ZMODEM/XMODEM transfer engines for file transfer.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BaseSubModule } from "../basesubmodule.js";
import { NativeZmodemProtocol } from "../../protocols/zmodem_native.js";
import { NativeXmodemProtocol } from "../../protocols/xmodem_native.js";
import { buildQwkForUser, importRepForUser, getQwkBbsId, cleanupQwkPacket } from "../../models/qwkUser.js";
import appConfig from "../../config/appConfig.js";
import * as alogger from "../../utils/alogger.js";

const TITLE_CLR = 14;    // bright cyan
const STATUS_CLR = 10;   // bright green
const ERROR_CLR = 12;    // bright red
const PROMPT_CLR = 11;   // bright yellow
const INFO_CLR = 7;      // white/grey

class QwkTransfer extends BaseSubModule {
	constructor(call) {
		super(call, "QwkTransfer");
		this._state = 'menu';      // menu, building, protocol, transferring, uploading, result, done
		this._useXmodem = false;
		this._qwkPath = null;
		this._transferring = false;
		this.loggingId = "QwkTransfer (Node " + call.nodenum + ")";
	}

	async run() {
		if (!this.call) { this.signalReturn(); return; }

		if (!appConfig.getBoolean('qwk_enabled', true)) {
			this._showLine("QWK transfers are disabled.", ERROR_CLR);
			this._showLine("Press any key...", PROMPT_CLR);
			this._state = 'done';
			return;
		}

		this._showMenu();
	}

	_showMenu() {
		this._state = 'menu';
		var cmds = this.call.cmds;

		if (this.dumb) {
			cmds.senddata("\r\n  QWK Mail Transfer\r\n");
			cmds.senddata("  D - Download QWK Packet\r\n");
			cmds.senddata("  U - Upload REP Packet\r\n");
			cmds.senddata("  Q - Quit\r\n\r\n");
			cmds.senddata("  Choice: ");
		} else {
			cmds.clearscreen();
			cmds.resetcolors();

			var cols = this.call.term_width || 80;
			var title = "QWK Mail Transfer";
			var titleX = Math.round(cols / 2) - Math.round(title.length / 2);

			cmds.movecursor(titleX, 2);
			cmds.senddata("\x1b[1m");
			cmds.setfgcolor(TITLE_CLR);
			cmds.senddata(title);
			cmds.resetcolors();

			cmds.movecursor(3, 4);
			cmds.setfgcolor(PROMPT_CLR);
			cmds.senddata("D");
			cmds.setfgcolor(INFO_CLR);
			cmds.senddata(" - Download QWK Packet");

			cmds.movecursor(3, 5);
			cmds.setfgcolor(PROMPT_CLR);
			cmds.senddata("U");
			cmds.setfgcolor(INFO_CLR);
			cmds.senddata(" - Upload REP Packet");

			cmds.movecursor(3, 6);
			cmds.setfgcolor(PROMPT_CLR);
			cmds.senddata("Q");
			cmds.setfgcolor(INFO_CLR);
			cmds.senddata(" - Quit");

			cmds.movecursor(3, 8);
			cmds.setfgcolor(PROMPT_CLR);
			cmds.senddata("Choice: ");
			cmds.resetcolors();
		}
	}

	_showLine(text, color) {
		var cmds = this.call.cmds;
		if (this.dumb) {
			cmds.senddata("\r\n  " + text + "\r\n");
		} else {
			if (!this._lineRow) this._lineRow = 4;
			cmds.movecursor(3, this._lineRow++);
			if (color) cmds.setfgcolor(color);
			cmds.senddata(text);
			cmds.resetcolors();
		}
	}

	_resetLines() {
		this._lineRow = 4;
	}

	// --- Download ---

	async _startDownload() {
		this._state = 'building';
		var cmds = this.call.cmds;

		if (!this.dumb) {
			cmds.clearscreen();
			cmds.resetcolors();
			cmds.movecursor(3, 2);
			cmds.setfgcolor(TITLE_CLR);
			cmds.senddata("QWK Download");
			cmds.resetcolors();
		}
		this._resetLines();
		this._showLine("Preparing QWK packet...", INFO_CLR);

		var userId = this.call.caller_user_id;
		if (!userId) {
			this._showLine("Not logged in.", ERROR_CLR);
			this._showLine("Press any key...", PROMPT_CLR);
			this._state = 'done';
			return;
		}

		var result = await buildQwkForUser(userId);

		if (!result.status) {
			this._showLine("Error: " + result.errormessages.join(', '), ERROR_CLR);
			this._showLine("Press any key...", PROMPT_CLR);
			this._state = 'done';
			return;
		}

		if (!result.qwkPath) {
			this._showLine("No new messages.", INFO_CLR);
			this._showLine("Press any key...", PROMPT_CLR);
			this._state = 'done';
			return;
		}

		this._qwkPath = result.qwkPath;
		this._showLine("Built packet: " + result.totalMessages + " message(s) across " +
			result.areaCount + " area(s)", STATUS_CLR);
		this._showLine("", INFO_CLR);

		// Ask for protocol
		this._state = 'protocol';
		this._useXmodem = false;

		if (this.dumb) {
			this.call.cmds.senddata("  Protocol: x/[Z]: ");
		} else {
			this._showLine("Protocol: [X]modem / [Z]modem (default)", PROMPT_CLR);
		}
	}

	async _sendPacket() {
		this._state = 'transferring';
		this._transferring = true;
		var protoName = this._useXmodem ? "XMODEM" : "ZMODEM";

		this._showLine("Starting " + protoName + " transfer...", STATUS_CLR);
		if (this.dumb) {
			this.call.cmds.senddata("  Your terminal should auto-detect the transfer.\r\n\r\n");
		}

		var protocol = this._useXmodem
			? new NativeXmodemProtocol(this.call)
			: new NativeZmodemProtocol(this.call);

		var result = await protocol.send([this._qwkPath]);

		this._transferring = false;

		if (result.success) {
			alogger.writeAlog(3, "QWK packet downloaded by " +
				(this.call.caller_username || "unknown"), "greenbright");
			this._showLine("Transfer complete!", STATUS_CLR);
		} else {
			alogger.writeAlog(3, "QWK download failed for " +
				(this.call.caller_username || "unknown") + ": " +
				(result.error || "unknown"), "yellow");
			this._showLine("Transfer failed: " + (result.error || "unknown"), ERROR_CLR);
		}

		// Clean up the temp packet
		cleanupQwkPacket(this._qwkPath);
		this._qwkPath = null;

		this._showLine("Press any key...", PROMPT_CLR);
		this._state = 'result';
	}

	// --- Upload ---

	async _startUpload() {
		this._state = 'protocol';
		this._uploadMode = true;
		this._useXmodem = false;

		if (!this.dumb) {
			var cmds = this.call.cmds;
			cmds.clearscreen();
			cmds.resetcolors();
			cmds.movecursor(3, 2);
			cmds.setfgcolor(TITLE_CLR);
			cmds.senddata("REP Upload");
			cmds.resetcolors();
		}
		this._resetLines();

		if (this.dumb) {
			this.call.cmds.senddata("\r\n  REP Upload\r\n");
			this.call.cmds.senddata("  Protocol: x/[Z]: ");
		} else {
			this._showLine("Protocol: [X]modem / [Z]modem (default)", PROMPT_CLR);
		}
	}

	async _receivePacket() {
		this._state = 'uploading';
		this._transferring = true;
		var protoName = this._useXmodem ? "XMODEM" : "ZMODEM";

		// Prepare temp receive directory
		var receiveDir = path.join(os.tmpdir(), 'canectic-rep-recv-' + this.call.nodenum + '-' + Date.now());
		fs.mkdirSync(receiveDir, { recursive: true });

		this._showLine("Starting " + protoName + " receive...", STATUS_CLR);
		if (this.dumb) {
			this.call.cmds.senddata("  Send your .rep file now.\r\n\r\n");
		}

		var result;
		if (this._useXmodem) {
			var protocol = new NativeXmodemProtocol(this.call);
			var bbsId = getQwkBbsId();
			result = await protocol.receive(receiveDir, bbsId + '.rep');
		} else {
			var protocol = new NativeZmodemProtocol(this.call);
			result = await protocol.receive(receiveDir);
		}

		this._transferring = false;

		if (!result.success) {
			this._showLine("Upload failed: " + (result.error || "unknown"), ERROR_CLR);
			this._showLine("Press any key...", PROMPT_CLR);
			try { fs.rmSync(receiveDir, { recursive: true, force: true }); } catch (_) {}
			this._state = 'result';
			return;
		}

		// Find the received .rep file
		var receivedFiles = fs.readdirSync(receiveDir);
		var repFile = receivedFiles.find(function(f) {
			return f.toLowerCase().endsWith('.rep');
		});

		if (!repFile) {
			// If only one file was received, try it anyway (XMODEM doesn't preserve filenames)
			if (receivedFiles.length === 1) {
				repFile = receivedFiles[0];
			} else {
				this._showLine("No .rep file found in upload.", ERROR_CLR);
				this._showLine("Press any key...", PROMPT_CLR);
				try { fs.rmSync(receiveDir, { recursive: true, force: true }); } catch (_) {}
				this._state = 'result';
				return;
			}
		}

		var repPath = path.join(receiveDir, repFile);
		this._showLine("Processing REP packet...", INFO_CLR);

		var userId = this.call.caller_user_id;
		var importResult = await importRepForUser(userId, repPath);

		// Clean up
		try { fs.rmSync(receiveDir, { recursive: true, force: true }); } catch (_) {}

		if (importResult.totalPosted > 0) {
			this._showLine("Posted " + importResult.totalPosted + " message(s)" +
				(importResult.totalErrors > 0 ? ", " + importResult.totalErrors + " error(s)" : ""),
				STATUS_CLR);
			alogger.writeAlog(3, "REP import by " +
				(this.call.caller_username || "unknown") + ": " +
				importResult.totalPosted + " posted", "greenbright");
		} else if (importResult.totalErrors > 0) {
			this._showLine(importResult.totalErrors + " error(s)", ERROR_CLR);
			for (var d of importResult.details) {
				this._showLine("  " + d, ERROR_CLR);
			}
		} else {
			this._showLine("No messages to post.", INFO_CLR);
		}

		this._showLine("Press any key...", PROMPT_CLR);
		this._state = 'result';
	}

	// --- Input handling ---

	onKey(key) {
		if (!this.active || !this.call) return;
		if (this._transferring) return;

		if (this._state === 'done' || this._state === 'result') {
			this._uploadMode = false;
			this._showMenu();
			return;
		}

		if (this._state === 'protocol') {
			if (key === 'ESC') {
				this._uploadMode = false;
				this._showMenu();
				return;
			}
			if (key === 'Enter') {
				// Default = ZMODEM
				if (this._uploadMode) {
					this._receivePacket();
				} else {
					this._sendPacket();
				}
				return;
			}
		}

		if (this._state === 'menu') {
			if (key === 'ESC') {
				this.signalReturn();
				return;
			}
		}
	}

	onChar(ch) {
		if (!this.active || !this.call) return;
		if (this._transferring) return;

		if (this._state === 'done' || this._state === 'result') {
			this._uploadMode = false;
			this._showMenu();
			return;
		}

		var upper = ch.toUpperCase();

		if (this._state === 'menu') {
			if (upper === 'D') {
				this._startDownload();
				return;
			}
			if (upper === 'U') {
				this._startUpload();
				return;
			}
			if (upper === 'Q') {
				this.signalReturn();
				return;
			}
		}

		if (this._state === 'protocol') {
			if (upper === 'X') {
				this._useXmodem = true;
				if (this._uploadMode) {
					this._receivePacket();
				} else {
					this._sendPacket();
				}
				return;
			}
			if (upper === 'Z') {
				this._useXmodem = false;
				if (this._uploadMode) {
					this._receivePacket();
				} else {
					this._sendPacket();
				}
				return;
			}
		}
	}
}

export { QwkTransfer };
