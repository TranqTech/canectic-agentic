// goodbye.js — Confirm logoff with optional batch download prompt
//
// Unlike logOff (immediate disconnect), this sub-module asks the user
// to confirm, and if they have files in their download batch, offers
// to download them before disconnecting.
//
// States: confirm → batch_ask → protocol_ask → hangup_ask → downloading → result → done

import { BaseSubModule } from "../basesubmodule.js";
import { NativeZmodemProtocol } from "../../protocols/zmodem_native.js";
import { NativeXmodemProtocol } from "../../protocols/xmodem_native.js";
import { getAreaByShortcode, resolveAreaPath } from "../../models/fileAreas.js";
import { getGroupByShortcode } from "../../models/fileGroups.js";
import { incrementDownloadCount } from "../../models/fileEntries.js";
import * as alogger from "../../utils/alogger.js";
import * as path from "path";

class goodbye extends BaseSubModule {
	constructor(call) {
		super(call, "Goodbye");
		this._state = 'confirm';
		this._useXmodem = false;
		this._promptRow = 4;
	}

	async run() {
		if (!this.call) { this.signalReturn(); return; }
		this._showConfirm();
	}

	_showConfirm() {
		this._state = 'confirm';
		var hasBatch = this.call.file_batch && this.call.file_batch.length > 0;

		if (this.dumb) {
			this.call.cmds.senddata("\r\n  Are you sure you want to log off?");
			if (hasBatch) {
				this.call.cmds.senddata("\r\n  You have " + this.call.file_batch.length + " file(s) in your download batch.");
			}
			this.call.cmds.senddata("\r\n  [Y]es / [N]o: ");
		} else {
			this.call.cmds.clearscreen();
			this.call.cmds.movecursor(1, 2);
			this.call.cmds.setfgcolor(14);
			this.call.cmds.senddata("  Log Off");

			this.call.cmds.movecursor(1, 4);
			this.call.cmds.setfgcolor(7);
			this.call.cmds.senddata("  Are you sure you want to log off?");

			if (hasBatch) {
				this.call.cmds.movecursor(1, 6);
				this.call.cmds.setfgcolor(11);
				this.call.cmds.senddata("  You have " + this.call.file_batch.length + " file(s) in your download batch.");
				this._promptRow = 8;
			} else {
				this._promptRow = 6;
			}

			this.call.cmds.movecursor(1, this._promptRow);
			this.call.cmds.setfgcolor(11);
			this.call.cmds.senddata("  [Y] Yes, log off   [N] Cancel");
			this.call.cmds.resetcolors();
		}
	}

	_showBatchAsk() {
		this._state = 'batch_ask';
		var count = this.call.file_batch.length;

		if (this.dumb) {
			this.call.cmds.senddata("\r\n\r\n  You have " + count + " file(s) tagged for download:");
			var showCount = Math.min(count, 10);
			for (var i = 0; i < showCount; i++) {
				this.call.cmds.senddata("\r\n    " + (i + 1) + ". " + this.call.file_batch[i].filename);
			}
			if (count > 10) {
				this.call.cmds.senddata("\r\n    ... and " + (count - 10) + " more");
			}
			this.call.cmds.senddata("\r\n\r\n  Download before logging off? [Y]es / [N]o / [C]lear batch: ");
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
			this.call.cmds.senddata("  [Y] Download first   [N] Log off without downloading   [C] Clear batch");
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

	onChar(ch) {
		if (!this.active || !this.call) return;
		var lower = ch.toLowerCase();

		if (this._state === 'confirm') {
			if (lower === 'y') {
				var hasBatch = this.call.file_batch && this.call.file_batch.length > 0;
				if (hasBatch) {
					this._showBatchAsk();
				} else {
					this.signalHangup();
				}
			} else if (lower === 'n') {
				this.signalReturn();
			}
			return;
		}

		if (this._state === 'batch_ask') {
			if (lower === 'y') {
				this._showProtocolAsk();
			} else if (lower === 'n') {
				this.signalHangup();
			} else if (lower === 'c') {
				this._clearBatchAndLogoff();
			}
			return;
		}

		if (this._state === 'protocol_ask') {
			if (lower === 'z' || ch === '\r' || ch === '\n') {
				this._useXmodem = false;
				this._startDownload();
			} else if (lower === 'x') {
				this._useXmodem = true;
				this._startDownload();
			}
			return;
		}

		if (this._state === 'result' || this._state === 'done') {
			this.signalHangup();
			return;
		}
	}

	onKey(key) {
		if (!this.active || !this.call) return;

		if (key === 'Enter') {
			if (this._state === 'confirm') {
				// Default: Yes, log off
				var hasBatch = this.call.file_batch && this.call.file_batch.length > 0;
				if (hasBatch) {
					this._showBatchAsk();
				} else {
					this.signalHangup();
				}
				return;
			}
			if (this._state === 'batch_ask') {
				// Default: Yes, download first
				this._showProtocolAsk();
				return;
			}
			if (this._state === 'protocol_ask') {
				// Default: ZMODEM
				this._useXmodem = false;
				this._startDownload();
				return;
			}
		}

		if (this._state === 'result' || this._state === 'done') {
			this.signalHangup();
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
			this.call.cmds.senddata("\r\n  Starting transfer (" + filePaths.length + " files)...\r\n\r\n");
		} else {
			this._showMessage("Starting transfer: " + filePaths.length + " files...");
		}

		this._state = 'downloading';

		var protocol = this._useXmodem ? new NativeXmodemProtocol(this.call) : new NativeZmodemProtocol(this.call);
		var result = await protocol.send(filePaths);

		if (result.success) {
			for (var fid of fileIds) {
				await incrementDownloadCount(fid);
			}
			await this._doClearBatch();
			alogger.writeAlog(3, "Batch download (goodbye) complete: " + filePaths.length + " files by " + (this.call.caller_username || "unknown"), "greenbright");

			if (this.dumb) {
				this.call.cmds.senddata("\r\n  Transfer complete! Disconnecting...\r\n");
			} else {
				this._showMessage("Transfer complete! Disconnecting...");
			}

			this._state = 'result';
			var self = this;
			setTimeout(function() { self.signalHangup(); }, 1500);
		} else {
			alogger.writeAlog(3, "Batch download (goodbye) failed: " + (result.error || "unknown"), "yellow");
			if (this.dumb) {
				this.call.cmds.senddata("\r\n  Transfer failed. Press any key to disconnect...\r\n");
			} else {
				this._showMessage("Transfer failed: " + (result.error || "unknown") + ". Press any key...");
			}
			this._state = 'done';
		}
	}

	async _clearBatchAndLogoff() {
		await this._doClearBatch();
		if (this.dumb) {
			this.call.cmds.senddata("\r\n  Batch cleared. Logging off...\r\n");
		}
		this.signalHangup();
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

export { goodbye };
