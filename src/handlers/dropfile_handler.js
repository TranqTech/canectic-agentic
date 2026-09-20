// dropfile_handler.js
// Generates BBS drop files for external door programs.
// Supported formats: door.sys, door32.sys, dorinfox.def, doorfile.sr, canectic.sys

import { EventEmitter } from "node:events";
import { DateTime } from "luxon";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

import * as alogger from "../utils/alogger.js";
import appConfig from "../config/appConfig.js";

// Config accessors — read at call time for hot-reload support
function cfgBbsName()    { return appConfig.get('bbsname', 'BBS'); }
function cfgSysopName()  { return appConfig.get('sysopname', 'Sysop'); }
function cfgSysopAlias() { return appConfig.get('sysopalias') || cfgSysopName(); }

// ============================================================================
// Safe accessors — pull from call and user_record with defaults for
// doorsession-type calls or any missing fields
// ============================================================================

function safeUser(call) {
	var ur = call.user_record || {};
	return {
		username:       ur.username       || call.caller_username || "Guest",
		fullname:       ur.fullname       || call.caller_fullname || "Guest User",
		firstname:      ur.firstname      || (ur.fullname || call.caller_fullname || "Guest").split(" ")[0],
		lastname:       ur.lastname       || (ur.fullname || call.caller_fullname || "User").split(" ").slice(1).join(" ") || "User",
		location:       ur.location       || "Unknown",
		security:       ur.security       ?? call.security ?? 10,
		usernumber:     ur.usernumber     ?? 512,
		logoncount:     ur.logoncount     ?? 0,
		birthdate:      ur.birthdate      || null,
		lastlogon:      ur.lastlogon      || null,
		defaultprotocol: ur.defaultprotocol || "Z",
		uploadcount:    ur.uploadcount    ?? 0,
		downloadcount:  ur.downloadcount  ?? 0,
		totaluploadk:   ur.totaluploadk   ?? 0,
		totaldownloadk: ur.totaldownloadk ?? 0,
		dailydownloadktotal: ur.dailydownloadktotal ?? 0,
		dailydownloadklimit: ur.dailydownloadklimit ?? 0,
		dailydownloadcount:  ur.dailydownloadcount  ?? 0,
		maxdailyfiles:       ur.maxdailyfiles       ?? 0,
		lastnewfilescan_short: ur.lastnewfilescan_short || "00/00/00",
		user_comment:   ur.user_comment   || "",
		lifetimedoortotal: ur.lifetimedoortotal ?? 0
	};
}

function safeCall(call) {
	return {
		nodenum:        call.nodenum       ?? 1,
		baudRate:       call.baudRate      ?? 115200,
		timeleft:       call.timeleft      ?? 3600,
		term_height:    call.term_height   ?? 24,
		term_width:     call.term_width    ?? 80,
		term_encoding:  call.term_encoding || "CP437",
		term_type:      call.term_type     || "ansi",
		use_rip:        call.use_rip       || false,
		connect_time:   call.connect_time  || new Date(),
		sockethandle:   call.sockethandle  ?? 0,
		caller_fullname: call.caller_fullname || "Guest User",
		caller_username: call.caller_username || "Guest"
	};
}

// ============================================================================
// Date helpers — never throw on bad data
// ============================================================================

function formatDate(value, fmt) {
	if (!value) return "00/00/00";
	try {
		var ms = (value instanceof Date) ? value.getTime() : Date.parse(value);
		if (isNaN(ms)) return "00/00/00";
		return DateTime.fromMillis(ms).toFormat(fmt);
	} catch (err) {
		return "00/00/00";
	}
}

function formatTime(value, fmt) {
	if (!value) return "00:00";
	try {
		var ms = (value instanceof Date) ? value.getTime() : Date.parse(value);
		if (isNaN(ms)) return "00:00";
		return DateTime.fromMillis(ms).toFormat(fmt);
	} catch (err) {
		return "00:00";
	}
}

function formatBirthdate(value) {
	// Accept ISO date (YYYY-MM-DD), Date objects, or MM/DD/YY strings
	if (!value) return "00/00/00";
	try {
		if (value instanceof Date) {
			return DateTime.fromJSDate(value).toFormat("MM/dd/yy");
		}
		// ISO date: YYYY-MM-DD
		if (typeof value === "string" && value.match(/^\d{4}-\d{2}-\d{2}/)) {
			return DateTime.fromISO(value).toFormat("MM/dd/yy");
		}
		// Already short format
		if (typeof value === "string" && value.match(/^\d{2}\/\d{2}\/\d{2,4}$/)) {
			return value.length > 8 ? value.slice(0, 6) + value.slice(-2) : value;
		}
		return "00/00/00";
	} catch (err) {
		return "00/00/00";
	}
}

// ============================================================================
// Terminal emulation code for door32/doorfile.sr
// 0=Ascii, 1=Ansi, 2=Avatar, 3=RIP, 4=Max Graphics
// ============================================================================

function getEmulationCode(call) {
	if (call.use_rip) return 3;
	var enc = (call.term_encoding || "").toUpperCase();
	if (enc === "CP437" || enc === "UTF8" || enc === "UTF-8") return 1;
	var term = (call.term_type || "").toLowerCase();
	if (term === "ansi" || term === "ansi-bbs" || term === "xterm") return 1;
	return 0;
}

// ============================================================================
// ANSI graphics mode for door.sys: "GR" or "NG"
// ============================================================================

function getGraphicsMode(call) {
	var enc = (call.term_encoding || "").toUpperCase();
	if (enc === "CP437" || enc === "UTF8" || enc === "UTF-8") return "GR";
	var term = (call.term_type || "").toLowerCase();
	if (term === "ansi" || term === "ansi-bbs" || term === "xterm") return "GR";
	return "NG";
}

// ============================================================================
// DORINFO node suffix — nodes 1-9 use digit, 10 uses 0, 11-36 use A-Z
// ============================================================================

function getDorInfoNodeSuffix(nodenum) {
	if (nodenum >= 1 && nodenum <= 9) return nodenum.toString();
	if (nodenum === 10) return "0";
	if (nodenum >= 11 && nodenum <= 36) return String.fromCharCode(64 + (nodenum - 10));
	// Fallback for nodes > 36
	return nodenum.toString();
}

// ============================================================================
// Format builders — each returns an object { filename, lines[] }
// All values are coerced to strings at write time, so push raw values.
// ============================================================================

function buildDoorSys(call, rs, useRealNames) {
	var c = safeCall(call);
	var u = safeUser(call);
	var rundir = process.cwd();
	var lastcalldate = formatDate(u.lastlogon, "MM/dd/yy");
	var lastcalltime = formatTime(u.lastlogon, "HH:mm");
	var calltime     = formatTime(c.connect_time, "HH:mm");
	var birthdate    = formatBirthdate(u.birthdate);
	var secsLeft     = Math.min(c.timeleft, 32767);
	var minsLeft     = Math.min(Math.round(c.timeleft / 60), 32767);
	var displayName  = useRealNames ? u.fullname : u.username;

	var lines = [
		/* 01 */ "COM" + (rs.comport || 0) + ":",
		/* 02 */ c.baudRate,
		/* 03 */ 8,
		/* 04 */ c.nodenum,
		/* 05 */ c.baudRate,
		/* 06 */ "Y",
		/* 07 */ "Y",
		/* 08 */ "Y",
		/* 09 */ "Y",
		/* 10 */ displayName,
		/* 11 */ u.location,
		/* 12 */ "",
		/* 13 */ "",
		/* 14 */ "PASSWORD",
		/* 15 */ u.security,
		/* 16 */ u.logoncount,
		/* 17 */ lastcalldate,
		/* 18 */ secsLeft,
		/* 19 */ minsLeft,
		/* 20 */ getGraphicsMode(c),
		/* 21 */ c.term_height,
		/* 22 */ "N",
		/* 23 */ "",
		/* 24 */ "0",
		/* 25 */ "00/00/00",
		/* 26 */ u.usernumber,
		/* 27 */ u.defaultprotocol,
		/* 28 */ u.uploadcount,
		/* 29 */ u.downloadcount,
		/* 30 */ u.dailydownloadktotal,
		/* 31 */ u.dailydownloadklimit,
		/* 32 */ birthdate,
		/* 33 */ rundir + "/nodes/" + c.nodenum,
		/* 34 */ rundir + "/data",
		/* 35 */ cfgSysopAlias(),
		/* 36 */ u.username,
		/* 37 */ "00:00",
		/* 38 */ "Y",
		/* 39 */ "N",
		/* 40 */ "Y",
		/* 41 */ "15",
		/* 42 */ "0",
		/* 43 */ u.lastnewfilescan_short,
		/* 44 */ calltime,
		/* 45 */ lastcalltime,
		/* 46 */ u.maxdailyfiles,
		/* 47 */ u.dailydownloadcount,
		/* 48 */ u.totaluploadk,
		/* 49 */ u.totaldownloadk,
		/* 50 */ u.user_comment || cfgBbsName(),
		/* 51 */ u.lifetimedoortotal,
		/* 52 */ "0"
	];

	return { filename: "door.sys", lines: lines };
}

function buildDoor32(call, rs, useRealNames) {
	var c = safeCall(call);
	var u = safeUser(call);
	var minsLeft = Math.round(c.timeleft / 60);
	var displayName = useRealNames ? u.fullname : u.username;

	var lines = [
		/* 01 */ rs.comtype ?? 2,
		/* 02 */ c.sockethandle,
		/* 03 */ c.baudRate,
		/* 04 */ cfgBbsName(),
		/* 05 */ u.usernumber,
		/* 06 */ displayName,
		/* 07 */ u.username,
		/* 08 */ u.security,
		/* 09 */ minsLeft,
		/* 10 */ getEmulationCode(c),
		/* 11 */ c.nodenum
	];

	return { filename: "door32.sys", lines: lines };
}

function buildDorInfo(call, rs, useRealNames) {
	var c = safeCall(call);
	var u = safeUser(call);
	var minsLeft = Math.round(c.timeleft / 60);
	var ansi = (getGraphicsMode(c) === "GR") ? 1 : 0;

	// DORINFO spec (RBBS v2 / QuickBBS / RemoteAccess):
	//  1: BBS name
	//  2: Sysop first name
	//  3: Sysop last name
	//  4: COM port (COM0 = local, COM1, etc.)
	//  5: Baud rate (or 0 for local)
	//  6: Networked (0 = not networked)
	//  7: User first name
	//  8: User last name
	//  9: User location
	// 10: ANSI (1 = yes, 0 = no)
	// 11: Security level
	// 12: Minutes remaining

	var sysopParts = cfgSysopName().split(" ");
	var sysopFirst = sysopParts[0] || "Sysop";
	var sysopLast  = sysopParts.slice(1).join(" ") || "";

	var comPort = "COM" + (rs.comport || 0);

	// When not using real names, put username in first name and leave last blank
	var userFirst, userLast;
	if (useRealNames) {
		userFirst = u.firstname;
		userLast = u.lastname;
	} else {
		userFirst = u.username;
		userLast = "";
	}

	var comPort = "COM" + (rs.comport || 0);

	var lines = [
		/* 01 */ cfgBbsName(),
		/* 02 */ sysopFirst,
		/* 03 */ sysopLast,
		/* 04 */ comPort,
		/* 05 */ c.baudRate,
		/* 06 */ 0,
		/* 07 */ userFirst,
		/* 08 */ userLast,
		/* 09 */ u.location,
		/* 10 */ ansi,
		/* 11 */ u.security,
		/* 12 */ minsLeft
	];

	var suffix = getDorInfoNodeSuffix(c.nodenum);
	return { filename: "dorinfo" + suffix + ".def", lines: lines };
}

function buildDoorfileSR(call, rs, useRealNames) {
	// DOORFILE.SR — Solar Realms / John Dailey Software format
	// Used by BRE, SRE, Falcon's Eye, Arcadian Legends, etc.
	// Very similar to DOOR32.SYS with slightly different field ordering.
	//
	// Line format from Synchronet source + fsxNet docs:
	//  1: User's name
	//  2: COM port (1-based, 0 for local)
	//  3: Baud rate
	//  4: BBS name
	//  5: User record number
	//  6: User's time left in minutes
	//  7: ANSI (1=yes, 0=no)
	//  8: Node number

	var c = safeCall(call);
	var u = safeUser(call);
	var minsLeft = Math.round(c.timeleft / 60);
	var ansi = (getGraphicsMode(c) === "GR") ? 1 : 0;
	var displayName = useRealNames ? u.fullname : u.username;

	var lines = [
		/* 01 */ displayName,
		/* 02 */ rs.comport || 0,
		/* 03 */ c.baudRate,
		/* 04 */ cfgBbsName(),
		/* 05 */ u.usernumber,
		/* 06 */ minsLeft,
		/* 07 */ ansi,
		/* 08 */ c.nodenum
	];

	return { filename: "doorfile.sr", lines: lines };
}

function buildCanectic(call, rs, useRealNames) {
	var c = safeCall(call);
	var u = safeUser(call);
	var displayName = useRealNames ? u.fullname : u.username;

	var lines = [
		c.nodenum,
		c.term_encoding,
		u.username,
		displayName,
		u.security,
		cfgBbsName(),
		c.term_type,
		c.timeleft
	];

	return { filename: "canectic.sys", lines: lines };
}

// ============================================================================
// Format registry — maps type string to builder function and filename
// ============================================================================

var FORMAT_BUILDERS = {
	doorsys:    buildDoorSys,
	door32:     buildDoor32,
	dorinfo:    buildDorInfo,
	doorfilesr: buildDoorfileSR,
	canectic:   buildCanectic
};

// ============================================================================
// Directory resolution — shortcodes, absolute paths, and subpaths
// ============================================================================

var SHORTCODES = {
	Node:    (nodenum) => process.cwd() + "/nodes/" + nodenum,
	DosNode: (nodenum) => process.cwd() + "/doors/Dos/nodes/" + nodenum,
	Doors:   ()        => process.cwd() + "/doors"
};

function resolveDropDir(dfdir, nodenum) {
	if (!dfdir) return null;

	// Absolute path
	if (dfdir.charAt(0) === "/") return dfdir;

	// Split on / to check for shortcode prefix
	var parts = dfdir.split("/");
	var shortcode = parts[0];

	if (SHORTCODES[shortcode]) {
		var base = SHORTCODES[shortcode](nodenum);
		if (parts.length > 1) {
			return base + "/" + parts.slice(1).join("/");
		}
		return base;
	}

	// Not a shortcode and not absolute — treat as relative to cwd
	return process.cwd() + "/" + dfdir;
}

// ============================================================================
// dropfileWriter class
// ============================================================================

class dropfileWriter {
	constructor(call, filetype, dfdir, runnersettings, useRealNames) {
		this.call = call;
		this.emitter = new EventEmitter();
		this.type = filetype || "";
		this.dfdir = dfdir || "";
		this.runnersettings = runnersettings || {};
		this.useRealNames = useRealNames || false;
		this.logId = "Dropfile (Node " + (call.nodenum || "?") + ")";
	}

	doSetup() {
		try {
			// No dropfile needed
			if (!this.type || this.type === "None" || this.type === "none") {
				this.emitter.emit("NoDropfileNeeded");
				return;
			}

			// Look up the builder
			var typeKey = this.type.toLowerCase().replace(/[^a-z0-9]/g, "");
			var builder = FORMAT_BUILDERS[typeKey];

			if (!builder) {
				alogger.writeAlog(3, this.logId + " Unknown dropfile type: " + this.type, "redbright");
				this.emitter.emit("DropfileError");
				return;
			}

			// Build the lines
			var result = builder(this.call, this.runnersettings, this.useRealNames);

			// Resolve directory
			var nodenum = this.call.nodenum || 1;
			var dir = resolveDropDir(this.dfdir, nodenum);
			if (!dir) {
				alogger.writeAlog(3, this.logId + " No drop directory specified", "redbright");
				this.emitter.emit("DropfileError");
				return;
			}

			// Write
			this._writeFile(dir, result.filename, result.lines);

		} catch (err) {
			alogger.writeAlog(3, this.logId + " Setup error: " + err.message, "redbright");
			this.emitter.emit("DropfileError");
		}
	}

	_writeFile(dir, filename, lines) {
		try {
			// Ensure directory exists (recursive handles nested paths)
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}

			var filepath = path.join(dir, filename);

			// Build content — all lines joined with CR/LF, values coerced to string
			var content = "";
			for (var i = 0; i < lines.length; i++) {
				if (i > 0) content += "\r\n";
				var val = lines[i];
				content += (val !== undefined && val !== null) ? val.toString() : "";
			}

			// Single atomic write (overwrites if exists)
			fs.writeFileSync(filepath, content, "utf8");

			alogger.writeAlog(5, this.logId + " " + filepath + " written", "yellowbright");
			this.emitter.emit("DropfileCompleted");

		} catch (err) {
			alogger.writeAlog(3, this.logId + " Write error: " + err.message, "redbright");
			this.emitter.emit("DropfileError");
		}
	}
}

export { dropfileWriter };