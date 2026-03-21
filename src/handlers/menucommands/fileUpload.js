// fileUpload.js — Terminal file upload handler
//
// Receives files via ZMODEM into a staging directory, then processes each:
// hash computation, dupe check, FILE_ID.DIZ extraction, move to area dir,
// create file_entries row, update area stats.

import { BaseSubModule } from "../basesubmodule.js";
import { getAreaByShortcode, resolveAreaPath, updateStatsForArea } from "../../models/fileAreas.js";
import { getGroupByShortcode } from "../../models/fileGroups.js";
import { addFileEntry, checkDupe } from "../../models/fileEntries.js";
import { computeHashes } from "../../utils/fileHasher.js";
import { applyDescriptions } from "../../utils/fileDescExtractor.js";
import { ZmodemReceiveProtocol } from "../../protocols/zmodem_receive.js";
import appConfig from "../../config/appConfig.js";
import * as alogger from "../../utils/alogger.js";
import * as fs from "fs";
import * as path from "path";

// --- Access control helpers ---

function parseFlags(val) {
	if (!val) return [];
	if (Array.isArray(val)) return val;
	if (typeof val === "string") {
		try { var p = JSON.parse(val); return Array.isArray(p) ? p : []; }
		catch (_) { return []; }
	}
	return [];
}

function checkUploadAccess(userRecord, area) {
	if (!userRecord || !area) return false;
	var sec = parseInt(userRecord.security) || 0;
	var postSec = parseInt(area.post_security) || 0;
	if (sec < postSec) return false;
	var requiredFlags = parseFlags(area.post_perm_flags);
	var restrictFlags = parseFlags(area.post_rest_flags);
	var userPerms = parseFlags(userRecord.permissionflags);
	var userRest = parseFlags(userRecord.restrictionflags);
	for (var rf of requiredFlags) {
		if (!userPerms.includes(rf)) return false;
	}
	for (var xf of restrictFlags) {
		if (userRest.includes(xf)) return false;
	}
	return true;
}

class fileUpload extends BaseSubModule {
	constructor(call) {
		super(call, "FileUpload");
		this._waitingForKey = false;
		this._waitingForDesc = false;
		this._descBuffer = "";
		this._receivedFiles = [];  // files received from ZMODEM
		this._currentDescIndex = 0;
	}

	async run() {
		if (!this.call) { this.signalReturn(); return; }

		var areaShortcode = this.call.file_area;
		if (!areaShortcode) {
			this._showMessage("No file area selected. Use the file area selector first.", true);
			this._waitingForKey = true;
			return;
		}

		var area = await getAreaByShortcode(areaShortcode);
		if (!area) {
			this._showMessage("File area not found: " + areaShortcode, true);
			this._waitingForKey = true;
			return;
		}

		if (!checkUploadAccess(this.call.user_record, area)) {
			this._showMessage("You do not have upload access to this area.", true);
			this._waitingForKey = true;
			return;
		}

		var group = area.group_shortcode ? await getGroupByShortcode(area.group_shortcode) : null;

		// Prepare staging directory
		var stagingDir = appConfig.get('file_upload_staging_dir', 'files/staging');
		if (!fs.existsSync(stagingDir)) {
			fs.mkdirSync(stagingDir, { recursive: true });
		}

		if (this.dumb) {
			this.call.cmds.senddata("\r\n  Upload to: " + area.name + "\r\n");
			this.call.cmds.senddata("  Your terminal will prompt you to select files.\r\n\r\n");
		} else {
			this.call.cmds.clearscreen();
			this.call.cmds.movecursor(1, 1);
			this.call.cmds.setfgcolor(14);
			this.call.cmds.senddata("  Upload to: " + area.name);
			this.call.cmds.movecursor(1, 3);
			this.call.cmds.setfgcolor(7);
			this.call.cmds.senddata("  Your terminal will prompt you to select files.");
			this.call.cmds.movecursor(1, 5);
			this.call.cmds.setfgcolor(10);
			this.call.cmds.senddata("  Starting ZMODEM receive...");
			this.call.cmds.resetcolors();
		}

		// Receive files via ZMODEM into staging
		var protocol = new ZmodemReceiveProtocol(this.call);
		var result = await protocol.receive(stagingDir);

		if (!result.success) {
			this._showMessage("Upload failed: " + (result.error || "unknown"), true);
			this._waitingForKey = true;
			return;
		}

		// Scan staging dir for new files (compare before/after)
		var stagedFiles = [];
		try {
			var dirContents = fs.readdirSync(stagingDir);
			for (var fname of dirContents) {
				var fullPath = path.join(stagingDir, fname);
				var stat = fs.statSync(fullPath);
				if (stat.isFile()) {
					stagedFiles.push({ filename: fname, fullPath: fullPath, size: stat.size, mtime: stat.mtime });
				}
			}
		} catch (err) {
			alogger.writeAlog(3, "FileUpload: error scanning staging dir: " + err.message, "redbright");
		}

		if (stagedFiles.length === 0) {
			this._showMessage("No files received.", true);
			this._waitingForKey = true;
			return;
		}

		// Process each received file
		var areaPath = resolveAreaPath(group, area);
		if (!fs.existsSync(areaPath)) {
			fs.mkdirSync(areaPath, { recursive: true });
		}

		var processed = 0;
		var dupes = 0;
		var errors = 0;

		for (var sf of stagedFiles) {
			try {
				// Compute hashes
				var hashes = computeHashes(sf.fullPath);

				// Dupe check
				var isDupe = await checkDupe(area.id, sf.filename, hashes.crc32);
				if (isDupe) {
					dupes++;
					fs.unlinkSync(sf.fullPath);
					continue;
				}

				// Move to area directory
				var destPath = path.join(areaPath, sf.filename);
				fs.renameSync(sf.fullPath, destPath);

				// Build entry
				var entryObj = {
					area_id: area.id,
					area_shortcode: areaShortcode,
					filename: sf.filename,
					disk_path: sf.filename,
					file_size: sf.size,
					file_date: sf.mtime,
					file_hash_crc32: hashes.crc32,
					file_hash_sha256: hashes.sha256,
					upload_date: new Date(),
					uploader_uuid: this.call.user_record ? this.call.user_record.uuid : null,
					uploader_name: this.call.caller_username || null,
					source_type: 'local',
					source_data: { upload_method: 'terminal', upload_ip: this.call.remoteAddress || '' }
				};

				// Extract FILE_ID.DIZ
				applyDescriptions(entryObj, destPath);

				var addResult = await addFileEntry(entryObj);
				if (addResult.status) {
					processed++;
				} else {
					errors++;
					alogger.writeAlog(3, "FileUpload: failed to add " + sf.filename + ": " + addResult.errormessages.join(", "), "yellow");
				}
			} catch (err) {
				errors++;
				alogger.writeAlog(3, "FileUpload: error processing " + sf.filename + ": " + err.message, "redbright");
				// Clean up staging file
				try { if (fs.existsSync(sf.fullPath)) fs.unlinkSync(sf.fullPath); } catch (_) {}
			}
		}

		// Update area stats
		await updateStatsForArea(areaShortcode);

		// Show results
		var msg = "Upload complete: " + processed + " file(s) added";
		if (dupes > 0) msg += ", " + dupes + " duplicate(s) skipped";
		if (errors > 0) msg += ", " + errors + " error(s)";

		alogger.writeAlog(3, "FileUpload: " + msg + " to " + areaShortcode + " by " + (this.call.caller_username || "unknown"), "greenbright");

		this._showMessage(msg, errors > 0);
		this._waitingForKey = true;
	}

	_showMessage(msg, isError) {
		if (this.dumb) {
			this.call.cmds.senddata("\r\n  " + msg + "\r\n");
			this.call.cmds.senddata("  Press any key to continue...\r\n\r\n");
			return;
		}

		this.call.cmds.clearscreen();
		this.call.cmds.movecursor(3, 3);
		this.call.cmds.setfgcolor(isError ? 9 : 10);
		this.call.cmds.senddata(msg);
		this.call.cmds.movecursor(3, 5);
		this.call.cmds.setfgcolor(8);
		this.call.cmds.senddata("Press any key to continue...");
		this.call.cmds.resetcolors();
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

export { fileUpload };
