// fileNewscan.js -- New file scan across subscribed file areas
//
// Scans all subscribed file areas for files added since the user's last
// scan pointer. Displays a summary and optionally marks areas as read.

import { BaseSubModule } from "../basesubmodule.js";
import { getActiveGroups } from "../../models/fileGroups.js";
import { getAreasInGroup } from "../../models/fileAreas.js";
import * as newFilesBaseline from "../../models/newFilesBaseline.js";
import { countNewSince } from "../../models/fileEntries.js";
import * as userFileSubs from "../../models/userFileSubs.js";
import * as postgres from "../../middleware/db/postgres.js";

const TITLE_CLR = 10;
const LABEL_CLR = 11;
const AREA_CLR = 14;
const COUNT_CLR = 10;
const NONE_CLR = 7;
const PROMPT_CLR = 11;
const DIVIDER_CLR = 4;

const HLINE_UTF8 = "\u2500";

// Parse JSONB flags
function parseFlags(val) {
	if (!val) return [];
	if (Array.isArray(val)) return val;
	if (typeof val === "string") {
		try { var p = JSON.parse(val); return Array.isArray(p) ? p : []; }
		catch (_) { return []; }
	}
	return [];
}

function checkAccess(userRecord, item) {
	var userSecurity = parseInt(userRecord.security) || 0;
	var browseSec = item.browse_security !== null && item.browse_security !== undefined
		? parseInt(item.browse_security)
		: (item.read_security ? parseInt(item.read_security) : 0);
	if (userSecurity < browseSec) return false;

	var reqFlags = parseFlags(item.read_required_flags || item.required_flags);
	var userPerms = parseFlags(userRecord.permissionflags);
	for (var i = 0; i < reqFlags.length; i++) {
		if (!userPerms.includes(reqFlags[i])) return false;
	}

	var restFlags = parseFlags(item.read_restriction_flags || item.restriction_flags);
	var userRestr = parseFlags(userRecord.restrictionflags);
	for (var j = 0; j < restFlags.length; j++) {
		if (userRestr.includes(restFlags[j])) return false;
	}
	return true;
}

class FileNewscan extends BaseSubModule {
	constructor(call) {
		super(call, "FileNewscan");
		this._results = [];
		this._totalNew = 0;
		this.loggingId = "FileNewscan (Node " + call.nodenum + ")";
	}

	_isUTF8() {
		var enc = this.call?.term_encoding || 'CP437';
		return (enc === 'UTF8' || enc === 'utf-8' || enc === 'utf8');
	}

	_drawHLine(row) {
		var cmds = this.call.cmds;
		var cols = this.call.term_width || 80;
		cmds.movecursor(1, row);
		cmds.setfgcolor(DIVIDER_CLR);
		if (this._isUTF8()) {
			cmds.senddata(HLINE_UTF8.repeat(cols));
		} else {
			cmds.senddata(Buffer.alloc(cols, 0xC4));
		}
		cmds.resetcolors();
	}

	async run() {
		if (!this.call) { this.signalReturn(); return; }

		var userId = this.call.user_record?.id || this.call.user_record?.user_id;
		if (!userId) { this.signalReturn(); return; }

		// Scan all accessible subscribed areas
		var groups = await getActiveGroups();
		var userRec = this.call.user_record || {};
		// New since the start of the caller's previous visit (newSince.js).
		var newSince = newFilesBaseline.forCall(this.call);
		this._results = [];
		this._totalNew = 0;

		for (var g = 0; g < groups.length; g++) {
			if (!checkAccess(userRec, groups[g])) continue;
			var areas = await getAreasInGroup(groups[g].shortcode);
			if (!areas) continue;

			for (var a = 0; a < areas.length; a++) {
				var area = areas[a];
				if (!area.active || !checkAccess(userRec, area)) continue;

				var subscribed = await userFileSubs.isSubscribed(userId, area.shortcode);
				if (!subscribed) continue;

				var newCount = await countNewSince(area.id, newSince);
				if (newCount > 0) {
					this._results.push({
						groupName: groups[g].name,
						areaName: area.name,
						shortcode: area.shortcode,
						newCount: newCount
					});
					this._totalNew += newCount;
				}
			}
		}

		this._display();
	}

	_display() {
		var cmds = this.call.cmds;
		var cols = this.call.term_width || 80;

		if (this.dumb) {
			this._displayDumb();
			return;
		}

		cmds.clearscreen();
		cmds.resetcolors();

		var title = "New File Scan";
		var titleX = Math.round(cols / 2) - Math.round(title.length / 2);
		cmds.movecursor(titleX, 2);
		cmds.senddata("\x1b[1m");
		cmds.setfgcolor(TITLE_CLR);
		cmds.senddata(title);
		cmds.resetcolors();

		this._drawHLine(3);

		if (this._results.length === 0) {
			cmds.movecursor(5, 5);
			cmds.setfgcolor(NONE_CLR);
			cmds.senddata("No new files found.");
			cmds.movecursor(5, 7);
			cmds.setfgcolor(PROMPT_CLR);
			cmds.senddata("Press any key to continue...");
			cmds.resetcolors();
			return;
		}

		var row = 5;
		var lastGroup = '';
		for (var i = 0; i < this._results.length; i++) {
			var r = this._results[i];
			if (r.groupName !== lastGroup) {
				cmds.movecursor(3, row);
				cmds.setfgcolor(LABEL_CLR);
				cmds.senddata(r.groupName);
				row++;
				lastGroup = r.groupName;
			}
			cmds.movecursor(5, row);
			cmds.setfgcolor(AREA_CLR);
			cmds.senddata(r.areaName);
			cmds.setfgcolor(COUNT_CLR);
			cmds.senddata(" (" + r.newCount + " new)");
			row++;
		}

		row++;
		this._drawHLine(row);
		row++;

		cmds.movecursor(5, row);
		cmds.setfgcolor(LABEL_CLR);
		cmds.senddata("Total: ");
		cmds.setfgcolor(COUNT_CLR);
		cmds.senddata(this._totalNew + " new file" + (this._totalNew !== 1 ? "s" : "") + " in " +
			this._results.length + " area" + (this._results.length !== 1 ? "s" : ""));
		row += 2;

		cmds.movecursor(5, row);
		cmds.setfgcolor(PROMPT_CLR);
		cmds.senddata("Press any key to continue...");
		cmds.resetcolors();
	}

	_displayDumb() {
		var cmds = this.call.cmds;
		cmds.senddata("\r\n\r\n  New File Scan\r\n\r\n");

		if (this._results.length === 0) {
			cmds.senddata("  No new files found.\r\n\r\n");
			cmds.senddata("  Press any key to continue...");
			return;
		}

		var lastGroup = '';
		for (var i = 0; i < this._results.length; i++) {
			var r = this._results[i];
			if (r.groupName !== lastGroup) {
				cmds.senddata("\r\n  " + r.groupName + "\r\n");
				lastGroup = r.groupName;
			}
			cmds.senddata("    " + r.areaName + " (" + r.newCount + " new)\r\n");
		}

		cmds.senddata("\r\n  Total: " + this._totalNew + " new files in " + this._results.length + " areas\r\n");
		cmds.senddata("\r\n  Press any key to continue...");
	}

	onKey(key) {
		if (!this.active || !this.call) return;
		this.signalReturn();
	}

	onChar(ch) {
		if (!this.active || !this.call) return;
		this.signalReturn();
	}
}

export { FileNewscan };
