// systeminfo.js -- the one place the running software says what it is.
//
// The version had six readers going three different ways, with three different
// fallbacks. artCodes and messages.js each went to appConfig directly rather
// than through here, defaulting to '0.0.0' and '0.1a' respectively.
// dbmigrations read package.json itself, twice. And the binkp and EMSI mailers
// carried a hardcoded PRODUCT_VERSION of '0.1', so every FTN peer this system
// has ever called was told it was running version 0.1.
//
// Everything that needs the version comes through here now.
//
// Two properties make that possible. softwareVersion() works whether or not
// appConfig has been loaded, so a CLI that never loads it still reports the real
// version rather than a placeholder; that is what let dbmigrations stop reading
// package.json for itself. And versionInfo() parses, so a caller that needs to
// compare rather than print gets a checked answer from the same source.
//
// Parsing matters more than it looks: `currentversion` is an overridable config
// key, so a sysop can set it to anything, and everything the update system does
// rests on the value being comparable.

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { DateTime } from "luxon";
import appConfig from "../config/appConfig.js";
import { parseVersion, formatVersion } from "./version.js";

const vsoftwarename = "Canectic BBS";

// Last resort, when neither the config nor package.json can say. Distinct from
// any real version on purpose: if this ever shows up somewhere, something is
// wrong rather than merely old.
const UNKNOWN_VERSION = '0.0.0';

// Read once at module load, the same way configDefaults does, resolved relative
// to this file so it does not depend on the working directory.
const _pkgVersion = (function () {
	try {
		var here = dirname(fileURLToPath(import.meta.url));
		var pkg = JSON.parse(readFileSync(join(here, '../../package.json'), 'utf8'));
		return pkg.version || null;
	} catch (_) {
		return null;
	}
}());

function softwareName() {
	return vsoftwarename;
}

/**
 * The version this install is running.
 *
 * package.json first, and that ordering is the point.
 *
 * The obvious arrangement is to ask appConfig, since `currentversion` is a
 * config key. It was written that way and it was wrong: configStore seeds
 * defaults with ON CONFLICT DO NOTHING, so the row is written once on first run
 * and never refreshed. On this development box it was seeded on 2026-03-20 when
 * package.json said 0.1a and still said 0.1a six months later, while the code
 * had moved to 0.9.5a. Everything reading the config path reported 0.1a: the
 * @VR@ art code, the terminal system info, and the @PID kludge on every FTN
 * message posted.
 *
 * A version is not a preference. Setting it does not change what is running, it
 * only makes the system misreport itself to its users and to its peers. So the
 * file that ships with the code wins, and the config value is a fallback for the
 * case where package.json cannot be read at all.
 */
function softwareVersion() {
	if (_pkgVersion) return _pkgVersion;
	return appConfig.get('currentversion', UNKNOWN_VERSION);
}

/**
 * The version parsed, for anything that compares rather than prints.
 *
 * @returns {object|null} null when the configured version is not a version at
 *                        all, which is reachable because the key is overridable.
 *                        A caller comparing versions must treat null as "cannot
 *                        tell" rather than as "old".
 */
function versionInfo() {
	return parseVersion(softwareVersion());
}

/**
 * The version in canonical form, for anything written down or sent to another
 * system, so a stray `v` prefix or a legacy spelling does not travel.
 */
function canonicalVersion() {
	return formatVersion(softwareVersion()) || softwareVersion();
}

/** "Canectic BBS v0.9.5a" */
function versionMsg() {
	return vsoftwarename + " v" + softwareVersion();
}

function getSystemInfo() {
	var boardname = appConfig.get('boardname', 'Canectic BBS');
	var boardlocation = appConfig.get('boardlocation', 'The Ether');
	var iobj = {}
	iobj.longestline = 0
	iobj.validlines = 0
	iobj.systemver = versionMsg()
	iobj.longestline = iobj.systemver.length
	iobj.boardname = boardname
	if (boardname != ""){
		iobj.validlines += 1
	}
	if (boardname.length > iobj.longestline){
		iobj.longestline = boardname.length
	}
	iobj.location = boardlocation
	if (boardlocation != ""){
		iobj.validlines += 1
	}
	if (boardlocation.length > iobj.longestline){
		iobj.longestline = boardlocation.length
	}
	// Luxon emits a narrow no-break space before AM/PM, which a CP437
	// terminal cannot render. Written as an escape rather than the literal
	// character so an editor cannot silently turn it into an ordinary space.
	iobj.connecttime = DateTime.now().toLocaleString(DateTime.DATETIME_MED).replace(/\u202f/g, ' ')
	if (iobj.connecttime.length > iobj.longestline){
		iobj.longestline = iobj.connecttime.length
	}
	if (iobj.connecttime != ""){
		iobj.validlines += 1
	}
	return iobj
}

export {
	versionMsg,
	softwareName,
	softwareVersion,
	versionInfo,
	canonicalVersion,
	getSystemInfo,
	UNKNOWN_VERSION
};
