// fileBatchCheck.js — Check for pending file batch on login
//
// Loaded in the call flow before the main menu. If the user has
// tagged files from a previous session, offers to download them
// immediately. If no batch, exits silently to continue the flow.

import { BaseSubModule } from "../basesubmodule.js";
import { NativeZmodemProtocol } from "../../protocols/zmodem_native.js";
import { NativeXmodemProtocol } from "../../protocols/xmodem_native.js";
import { getAreaByShortcode, resolveAreaPath } from "../../models/fileAreas.js";
import { getGroupByShortcode } from "../../models/fileGroups.js";
import { incrementDownloadCount } from "../../models/fileEntries.js";
import * as alogger from "../../utils/alogger.js";
import * as path from "path";

// States: check → prompt → protocol_ask → hangup_ask → downloading → result → done
class fileBatchCheck extends BaseSubModule {
	constructor(call) {
		super(call, "FileBatchCheck");
		this._state = 'check';
		this._hangupAfter = false;
		this._useXmodem = false;
		this._promptRow = 10;
	}

	async run() {
		if (!this.call) { this.signalReturn(); return; }

		// No batch → exit silently
		if (!this.call.file_batch || this.call.file_batch.length === 0) {
			this.signalReturn();
			return;
		}

		this._showPrompt();
	}

	_showPrompt() {
		var count = this.call.file_batch.length;
		this._state = 'prompt';

		if (this.dumb) {
			this.call.cmds.senddata("\r\n  You have " + count + " file(s) in your download batch from a previous session.\r\n");
			this.call.cmds.senddata("  Download now? [Y]es / [N]o / [C]lear batch: ");
		} else {
			this.call.cmds.clearscreen();
			this.call.cmds.movecursor(1, 2);
			this.call.cmds.setfgcolor(14);
			this.call.cmds.senddata("  Pending Download Batch");
			this.call.cmds.movecursor(1, 4);
			this.call.cmds.setfgcolor(7);
			this.call.cmds.senddata("  You have " + count + " file(s) tagged for download:");

			var showCount = Math.min(count, 10);
			for (var i = 0; i < showCount; i++) {
				this.call.cmds.movecursor(3, 6 + i);
				this.call.cmds.setfgcolor(15);
				this.call.cmds.senddata((i + 1) + ". " + this.call.file_batch[i].filename);
			}
			if (count > 10) {
				this.call.cmds.movecursor(3, 6 + showCount);
				this.call.cmds.setfgcolor(8);
				this.call.cmds.senddata("  ... and " + (count - 10) + " more");
			}

			this._promptRow = 7 + showCount + 1;
			this.call.cmds.movecursor(1, this._promptRow);
			this.call.cmds.setfgcolor(11);
			this.call.cmds.senddata("  [Y] Download now   [N] Skip   [C] Clear batch");
			this.call.cmds.resetcolors();
		}
	}

	_showProtocolAsk() {
		this._state = 'protocol_ask';
		if (this.dumb) {
			this.call.cmds.senddata("\r\n  Protocol: x/[Z]: ");
		} else {
			this.call.cmds.movecursor(1, this._promptRow + 2);
			this.call.cmds.setfgcolor(11);
			this.call.cmds.senddata("  Protocol: [X]modem / [Z]modem (default)");
			this.call.cmds.resetcolors();
		}
	}

	_showHangupAsk() {
		this._state = 'hangup_ask';
		if (this.dumb) {
			this.call.cmds.senddata("\r\n  Hang up after transfer? [Y/n]: ");
		} else {
			this.call.cmds.movecursor(1, this._promptRow + 4);
			this.call.cmds.setfgcolor(11);
			this.call.cmds.senddata("  Hang up after transfer? [Y/n]");
			this.call.cmds.resetcolors();
		}
	}

	onChar(ch) {
		if (!this.active || !this.call) return;
		var lower = ch.toLowerCase();

		if (this._state === 'prompt') {
			if (lower === 'y') {
				this._showProtocolAsk();
			} else if (lower === 'n') {
				this.signalReturn();
			} else if (lower === 'c') {
				this._clearBatch();
			}
			return;
		}

		if (this._state === 'protocol_ask') {
			if (lower === 'z' || ch === '\r' || ch === '\n') {
				this._useXmodem = false;
				this._showHangupAsk();
			} else if (lower === 'x') {
				this._useXmodem = true;
				this._showHangupAsk();
			}
			return;
		}

		if (this._state === 'hangup_ask') {
			if (lower === 'y' || ch === '\r' || ch === '\n') {
				this._hangupAfter = true;
				this._startDownload();
			} else if (lower === 'n') {
				this._hangupAfter = false;
				this._startDownload();
			}
			return;
		}

		if (this._state === 'result') {
			if (this._hangupAfter) {
				this.signalHangup();
			} else {
				this.signalReturn();
			}
			return;
		}

		if (this._state === 'done') {
			this.signalReturn();
			return;
		}
	}

	onKey(key) {
		if (!this.active || !this.call) return;

		if (this._state === 'protocol_ask' && key === 'Enter') {
			this._useXmodem = false;
			this._showHangupAsk();
			return;
		}

		if (this._state === 'hangup_ask' && key === 'Enter') {
			this._hangupAfter = true;
			this._startDownload();
			return;
		}

		if (this._state === 'result') {
			if (this._hangupAfter) {
				this.signalHangup();
			} else {
				this.signalReturn();
			}
			return;
		}

		if (this._state === 'done') {
			this.signalReturn();
			return;
		}
	}

	async _startDownload() {
		var batch = this.call.file_batch;
		var filePaths = [];
		var fileIds = [];
		var fs = await import("fs");

		for (var item of batch) {
			var area = await getAreaByShortcode(item.area_shortcode);
			if (!area) continue;
			var group = area.group_shortcode ? await getGroupByShortcode(area.group_shortcode) : null;
			var areaPath = resolveAreaPath(group, area);
			var fullPath = path.join(areaPath, item.disk_path || item.filename);
			if (fs.existsSync(fullPath)) {
				filePaths.push(fullPath);
				fileIds.push(item.id);
			}
		}

		if (filePaths.length === 0) {
			this._showMessage("No files found on disk. Clearing batch.");
			await this._doClearBatch();
			this._state = 'done';
			return;
		}

		if (this.dumb) {
			this.call.cmds.senddata("\r\n  Starting ZMODEM batch download (" + filePaths.length + " files)...\r\n\r\n");
		} else {
			this._showMessage("Starting ZMODEM transfer: " + filePaths.length + " files...");
		}

		this._state = 'downloading';

		var protocol = this._useXmodem ? new NativeXmodemProtocol(this.call) : new NativeZmodemProtocol(this.call);
		var result = await protocol.send(filePaths);

		if (result.success) {
			for (var fid of fileIds) {
				await incrementDownloadCount(fid);
			}
			await this._doClearBatch();
			alogger.writeAlog(3, "Batch download (login) complete: " + filePaths.length + " files by " + (this.call.caller_username || "unknown"), "greenbright");

			this._state = 'result';
			if (this._hangupAfter) {
				// Auto-hangup after brief message
				if (this.dumb) {
					this.call.cmds.senddata("\r\n  Transfer complete! Disconnecting...\r\n");
				} else {
					this._showMessage("Transfer complete! Disconnecting...");
				}
				// Small delay so the message is visible before hangup
				var self = this;
				setTimeout(function() { self.signalHangup(); }, 1500);
			} else {
				if (this.dumb) {
					this.call.cmds.senddata("\r\n  Transfer complete! Press any key to continue...\r\n");
				} else {
					this._showMessage("Transfer complete! Press any key to continue...");
				}
			}
		} else {
			alogger.writeAlog(3, "Batch download (login) failed: " + (result.error || "unknown"), "yellow");
			if (this.dumb) {
				this.call.cmds.senddata("\r\n  Transfer failed. Press any key to continue...\r\n");
			} else {
				this._showMessage("Transfer failed: " + (result.error || "unknown") + ". Press any key...");
			}
			this._state = 'done';
		}
	}

	async _clearBatch() {
		await this._doClearBatch();
		if (this.dumb) {
			this.call.cmds.senddata("\r\n  Batch cleared.\r\n\r\n");
		} else {
			this._showMessage("Batch cleared. Press any key...");
		}
		this._state = 'done';
	}

	async _doClearBatch() {
		this.call.file_batch = [];
		if (this.call.user_record && this.call.user_record.id) {
			try {
				var bm = await import("../../models/userFileBatch.js");
				await bm.clearBatch(this.call.user_record.id);
			} catch (_) {}
		}
	}

	_showMessage(msg) {
		if (this.dumb) {
			this.call.cmds.senddata("\r\n  " + msg + "\r\n");
			return;
		}
		this.call.cmds.clearscreen();
		this.call.cmds.movecursor(1, 3);
		this.call.cmds.setfgcolor(10);
		this.call.cmds.senddata("  " + msg);
		this.call.cmds.resetcolors();
	}
}

export { fileBatchCheck };
