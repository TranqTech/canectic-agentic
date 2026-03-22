// fileBatchDownload.js — Download all tagged files in call.file_batch
//
// Lightweight sub-module: shows batch contents, initiates ZMODEM transfer,
// clears batch on success, returns to menu.

import { BaseSubModule } from "../basesubmodule.js";
import { getAreaByShortcode, resolveAreaPath } from "../../models/fileAreas.js";
import { getGroupByShortcode } from "../../models/fileGroups.js";
import { incrementDownloadCount } from "../../models/fileEntries.js";
import { ZmodemProtocol } from "../../protocols/zmodem.js";
import * as alogger from "../../utils/alogger.js";
import * as fs from "fs";
import * as path from "path";

class fileBatchDownload extends BaseSubModule {
	constructor(call) {
		super(call, "FileBatchDownload");
	}

	async run() {
		if (!this.call) { this.signalReturn(); return; }

		var batch = this.call.file_batch;
		if (!batch || batch.length === 0) {
			if (this.dumb) {
				this.call.cmds.senddata("\r\n  No files tagged for download.\r\n\r\n");
			} else {
				this.call.cmds.clearscreen();
				this.call.cmds.movecursor(1, 2);
				this.call.cmds.setfgcolor(14);
				this.call.cmds.senddata("  No files tagged for download.");
				this.call.cmds.movecursor(1, 4);
				this.call.cmds.setfgcolor(7);
				this.call.cmds.senddata("  Tag files with T in the file browser, then use this command.");
				this.call.cmds.movecursor(1, 6);
				this.call.cmds.setfgcolor(8);
				this.call.cmds.senddata("  Press any key to continue...");
				this.call.cmds.resetcolors();
			}
			this._waitingForKey = true;
			return;
		}

		// Show batch summary
		if (this.dumb) {
			this.call.cmds.senddata("\r\n  Batch Download — " + batch.length + " file(s):\r\n");
			for (var i = 0; i < batch.length; i++) {
				this.call.cmds.senddata("    " + (i + 1) + ". " + batch[i].filename + "\r\n");
			}
			this.call.cmds.senddata("\r\n  Starting ZMODEM transfer...\r\n\r\n");
		} else {
			this.call.cmds.clearscreen();
			this.call.cmds.movecursor(1, 1);
			this.call.cmds.setfgcolor(14);
			this.call.cmds.senddata("  Batch Download - " + batch.length + " file(s)");
			for (var j = 0; j < Math.min(batch.length, 15); j++) {
				this.call.cmds.movecursor(3, 3 + j);
				this.call.cmds.setfgcolor(7);
				this.call.cmds.senddata((j + 1) + ". " + batch[j].filename);
			}
			if (batch.length > 15) {
				this.call.cmds.movecursor(3, 18);
				this.call.cmds.setfgcolor(8);
				this.call.cmds.senddata("  ... and " + (batch.length - 15) + " more");
			}
			this.call.cmds.movecursor(1, 20);
			this.call.cmds.setfgcolor(10);
			this.call.cmds.senddata("  Starting ZMODEM transfer...");
			this.call.cmds.resetcolors();
		}

		// Resolve file paths
		var filePaths = [];
		var fileIds = [];
		for (var item of batch) {
			var area = await getAreaByShortcode(item.area_shortcode);
			if (!area) continue;
			var group = area.group_shortcode ? await getGroupByShortcode(area.group_shortcode) : null;
			var areaPath = resolveAreaPath(group, area);
			var fullPath = path.join(areaPath, item.disk_path || item.filename);
			if (fs.existsSync(fullPath)) {
				filePaths.push(fullPath);
				fileIds.push(item.id);
			} else {
				alogger.writeAlog(3, "FileBatchDownload: file not on disk: " + item.filename, "yellow");
			}
		}

		if (filePaths.length === 0) {
			if (this.dumb) {
				this.call.cmds.senddata("\r\n  No tagged files found on disk.\r\n\r\n");
			} else {
				this.call.cmds.movecursor(1, 22);
				this.call.cmds.setfgcolor(9);
				this.call.cmds.senddata("  No tagged files found on disk. Press any key...");
				this.call.cmds.resetcolors();
			}
			this._waitingForKey = true;
			return;
		}

		// Run ZMODEM transfer
		var protocol = new ZmodemProtocol(this.call);
		var result = await protocol.send(filePaths);

		if (result.success) {
			for (var fid of fileIds) {
				await incrementDownloadCount(fid);
			}
			this.call.file_batch = [];
			// Clear persisted batch from DB
			if (this.call.user_record && this.call.user_record.id) {
				try { var bmc = await import("../../models/userFileBatch.js"); await bmc.clearBatch(this.call.user_record.id); } catch (_) {}
			}
			alogger.writeAlog(3, "Batch download complete: " + filePaths.length + " files by " + (this.call.caller_username || "unknown"), "greenbright");

			if (this.dumb) {
				this.call.cmds.senddata("\r\n  Transfer complete: " + filePaths.length + " files.\r\n\r\n");
			} else {
				this.call.cmds.movecursor(1, 22);
				this.call.cmds.setfgcolor(10);
				this.call.cmds.senddata("  Transfer complete: " + filePaths.length + " files. Press any key...");
				this.call.cmds.resetcolors();
			}
		} else {
			alogger.writeAlog(3, "Batch download failed: " + (result.error || "unknown"), "yellow");
			if (this.dumb) {
				this.call.cmds.senddata("\r\n  Transfer failed: " + (result.error || "unknown") + "\r\n\r\n");
			} else {
				this.call.cmds.movecursor(1, 22);
				this.call.cmds.setfgcolor(9);
				this.call.cmds.senddata("  Transfer failed: " + (result.error || "unknown") + " Press any key...");
				this.call.cmds.resetcolors();
			}
		}

		this._waitingForKey = true;
	}

	onKey(key) {
		if (this._waitingForKey) {
			this.signalReturn();
			return;
		}
	}

	onChar(ch) {
		if (this._waitingForKey) {
			this.signalReturn();
			return;
		}
	}
}

export { fileBatchDownload };
