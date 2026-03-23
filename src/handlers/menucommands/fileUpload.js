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
import { NativeZmodemProtocol } from "../../protocols/zmodem_native.js";
import { NativeXmodemProtocol } from "../../protocols/xmodem_native.js";
import appConfig from "../../config/appConfig.js";
import * as fileNetworkAreas from "../../models/fileNetworkAreas.js";
import * as filePeerSubscriptions from "../../models/filePeerSubscriptions.js";
import * as fileDistribution from "../../models/fileDistribution.js";
import * as jobs from "../../queues/jobs.js";
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
		this._waitingForProtocol = false;
		this._waitingForFilename = false;
		this._filenameBuffer = '';
		this._useXmodem = false;
		this._waitingForDesc = false;
		this._descBuffer = "";
		this._receivedFiles = [];
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
			this.call.cmds.senddata("  Protocol: x/[Z]: ");
		} else {
			this.call.cmds.clearscreen();
			this.call.cmds.movecursor(1, 1);
			this.call.cmds.setfgcolor(14);
			this.call.cmds.senddata("  Upload to: " + area.name);
			this.call.cmds.movecursor(1, 3);
			this.call.cmds.setfgcolor(11);
			this.call.cmds.senddata("  Protocol: [X]modem / [Z]modem (default)");
			this.call.cmds.resetcolors();
		}

		// Wait for protocol selection
		this._stagingDir = stagingDir;
		this._area = area;
		this._group = group;
		this._areaShortcode = areaShortcode;
		this._waitingForProtocol = true;
	}

	async _startReceive() {
		var stagingDir = this._stagingDir;
		var area = this._area;
		var group = this._group;
		var areaShortcode = this._areaShortcode;

		var protoName = this._useXmodem ? "XMODEM" : "ZMODEM";
		var promptRow = this._useXmodem ? 7 : 5;

		if (this.dumb) {
			this.call.cmds.senddata("\r\n  Starting " + protoName + " receive...\r\n\r\n");
		} else {
			this.call.cmds.movecursor(1, promptRow);
			this.call.cmds.setfgcolor(10);
			this.call.cmds.senddata("  Starting " + protoName + " receive...");
			this.call.cmds.resetcolors();
		}

		// Snapshot staging dir BEFORE transfer to only process new files after
		var existingFiles = new Set();
		try {
			var priorContents = fs.readdirSync(stagingDir);
			for (var ef of priorContents) existingFiles.add(ef);
		} catch (_) {}

		// Receive files into staging
		var result;
		if (this._useXmodem) {
			var protocol = new NativeXmodemProtocol(this.call);
			result = await protocol.receive(stagingDir, this._xmodemFilename || ('upload_' + Date.now()));
		} else {
			var protocol = new NativeZmodemProtocol(this.call);
			result = await protocol.receive(stagingDir);
		}

		if (!result.success) {
			this._showMessage("Upload failed: " + (result.error || "unknown"), true);
			this._waitingForKey = true;
			return;
		}

		// Scan staging dir for NEW files only (not pre-existing from failed transfers)
		var stagedFiles = [];
		try {
			var dirContents = fs.readdirSync(stagingDir);
			for (var fname of dirContents) {
				if (existingFiles.has(fname)) continue; // Skip pre-existing
				var fullPath = path.join(stagingDir, fname);
				var stat = fs.statSync(fullPath);
				if (stat.isFile() && stat.size > 0) {
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
		var entryIds = [];
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
					if (addResult.entryId) entryIds.push(addResult.entryId);
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

		// If area is networked, create distribution rows and enqueue TIC outbound
		if (entryIds.length > 0) {
			try {
				var networkMappings = await fileNetworkAreas.getNetworksByFileArea(area.id);
				if (networkMappings && networkMappings.length > 0) {
					var subscribedConns = await filePeerSubscriptions.getSubscribedConnections(area.id);
					if (subscribedConns && subscribedConns.length > 0) {
						var connIds = subscribedConns.map(function(c) { return c.peer_connection_id; });
						for (var eid of entryIds) {
							await fileDistribution.createDistributionRows(eid, connIds, 'tic');
						}
						await jobs.enqueueTicOutbound();
						alogger.writeAlog(3, "FileUpload: hatched " + entryIds.length + " file(s) to " + connIds.length + " peer(s)", "cyan");
					}
				}
			} catch (distErr) {
				alogger.writeAlog(3, "FileUpload: TIC distribution error: " + distErr.message, "yellow");
			}
		}

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

	_showFilenamePrompt() {
		this._waitingForFilename = true;
		this._filenameBuffer = '';
		if (this.dumb) {
			this.call.cmds.senddata("\r\n  Filename: ");
		} else {
			this.call.cmds.movecursor(1, 5);
			this.call.cmds.setfgcolor(11);
			this.call.cmds.senddata("  Filename: ");
			this.call.cmds.setfgcolor(15);
		}
	}

	onKey(key) {
		if (this._waitingForProtocol) {
			if (key === 'Enter') {
				this._useXmodem = false;
				this._waitingForProtocol = false;
				this._startReceive();
			}
			return;
		}
		if (this._waitingForFilename) {
			if (key === 'Enter') {
				var fname = this._filenameBuffer.trim();
				if (fname.length > 0) {
					this._waitingForFilename = false;
					this._xmodemFilename = fname;
					this._startReceive();
				}
			} else if (key === 'Backspace') {
				if (this._filenameBuffer.length > 0) {
					this._filenameBuffer = this._filenameBuffer.slice(0, -1);
					this.call.cmds.senddata('\b \b');
				}
			} else if (key === 'ESC') {
				this._waitingForFilename = false;
				this.signalReturn();
			}
			return;
		}
		if (this._waitingForKey) {
			this.signalReturn();
			return;
		}
	}

	onChar(ch) {
		if (this._waitingForProtocol) {
			var lower = ch.toLowerCase();
			if (lower === 'z' || ch === '\r' || ch === '\n') {
				this._useXmodem = false;
				this._waitingForProtocol = false;
				this._startReceive();
			} else if (lower === 'x') {
				this._useXmodem = true;
				this._waitingForProtocol = false;
				this._showFilenamePrompt();
			}
			return;
		}
		if (this._waitingForFilename) {
			if (ch.length === 1 && ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) < 127) {
				// Filter unsafe filename characters
				if (ch !== '/' && ch !== '\\' && ch !== '..' && ch !== ':') {
					this._filenameBuffer += ch;
					this.call.cmds.senddata(ch);
				}
			}
			return;
		}
		if (this._waitingForKey) {
			this.signalReturn();
			return;
		}
	}
}

export { fileUpload };
