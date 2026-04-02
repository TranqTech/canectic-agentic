// sysInfo.js -- System information display
//
// Shows board name, sysop, location, version, and aggregate stats.
// Used as a menu command and optionally as a call flow stage.

import { BaseSubModule } from "../basesubmodule.js";
import { getStats, formatFileSize } from "../../models/systemStats.js";

const TITLE_CLR = 10;     // bright green
const LABEL_CLR = 11;     // bright yellow
const VALUE_CLR = 14;     // bright cyan
const DIVIDER_CLR = 4;    // blue

const HLINE_UTF8 = "\u2500";

class SysInfo extends BaseSubModule {
	constructor(call) {
		super(call, "SysInfo");
		this.loggingId = "SysInfo (Node " + call.nodenum + ")";
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

		var stats = await getStats();
		var cmds = this.call.cmds;
		var cols = this.call.term_width || 80;

		if (this.dumb) {
			this._showDumb(stats);
			return;
		}

		cmds.clearscreen();
		cmds.resetcolors();

		// Title
		var title = "System Information";
		var titleX = Math.round(cols / 2) - Math.round(title.length / 2);
		cmds.movecursor(titleX, 2);
		cmds.senddata("\x1b[1m");
		cmds.setfgcolor(TITLE_CLR);
		cmds.senddata(title);
		cmds.resetcolors();

		// Top divider
		this._drawHLine(3);

		// Info rows
		var labelCol = 5;
		var valueCol = 25;
		var row = 5;

		var lines = [
			["Board Name",     stats.boardName],
			["Sysop",          stats.sysopName],
			["Location",       stats.boardLocation],
			["Version",        stats.systemVersion],
			null, // spacer
			["Users",          stats.totalUsers.toLocaleString()],
			["Total Calls",    stats.totalCalls.toLocaleString()],
			["Networks",       stats.totalNetworks.toLocaleString()],
			["Message Areas",  stats.totalAreas.toLocaleString()],
			["Files",          stats.totalFiles.toLocaleString()],
			["File Storage",   formatFileSize(stats.totalFileSize)],
		];

		for (var i = 0; i < lines.length; i++) {
			if (lines[i] === null) {
				row++;
				continue;
			}
			cmds.movecursor(labelCol, row);
			cmds.setfgcolor(LABEL_CLR);
			cmds.senddata(lines[i][0]);
			cmds.movecursor(valueCol, row);
			cmds.setfgcolor(VALUE_CLR);
			cmds.senddata(lines[i][1]);
			row++;
		}

		// Bottom divider
		this._drawHLine(row + 1);

		// Prompt
		cmds.movecursor(labelCol, row + 2);
		cmds.setfgcolor(LABEL_CLR);
		cmds.senddata("Press any key to continue...");
		cmds.resetcolors();
	}

	_showDumb(stats) {
		var cmds = this.call.cmds;
		cmds.senddata("\r\n\r\n  System Information\r\n\r\n");
		cmds.senddata("  Board Name:     " + stats.boardName + "\r\n");
		cmds.senddata("  Sysop:          " + stats.sysopName + "\r\n");
		cmds.senddata("  Location:       " + stats.boardLocation + "\r\n");
		cmds.senddata("  Version:        " + stats.systemVersion + "\r\n");
		cmds.senddata("\r\n");
		cmds.senddata("  Users:          " + stats.totalUsers.toLocaleString() + "\r\n");
		cmds.senddata("  Total Calls:    " + stats.totalCalls.toLocaleString() + "\r\n");
		cmds.senddata("  Networks:       " + stats.totalNetworks.toLocaleString() + "\r\n");
		cmds.senddata("  Message Areas:  " + stats.totalAreas.toLocaleString() + "\r\n");
		cmds.senddata("  Files:          " + stats.totalFiles.toLocaleString() + "\r\n");
		cmds.senddata("  File Storage:   " + formatFileSize(stats.totalFileSize) + "\r\n");
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

export { SysInfo };
