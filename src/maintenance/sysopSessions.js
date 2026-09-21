// sysopSessions.js -- which browsers belong to a sysop, for a process that
// cannot ask Redis.
//
// While the BBS is stopped for an update, the updater answers on the web port
// itself and shows sysops the update's progress and everybody else the
// maintenance page (updateStatusServer.js). It has to tell the two apart, and
// it cannot use the session store to do it: the updater runs while its own
// dependencies are being replaced, so it imports Node builtins and nothing
// else, and even before that it is the NEW release's code running against the
// OLD release's installed packages.
//
// So the gateway, which has matching code and packages, writes down which
// sessions are sysops' once, when a sysop starts the update from the web and
// before anything else happens, and the updater reads that. A sysop who logs
// in after pressing the button is not in it, and sees the maintenance page
// like anybody else while the BBS is stopped. The file carries the run id, so
// a leftover from an earlier run is never trusted.
//
// Only a SHA-256 of each session id goes in the file: the updater compares the
// hash of the cookie a browser presents, so the file never holds anything a
// browser could present itself. Mode 600 regardless.
//
// NODE BUILTINS ONLY: read by the updater's listener. The gateway side, which
// needs the session store, is recordSysopSessions() in maintenanceWeb.js.

import * as fs from 'fs';
import * as path from 'path';
import { STATUS_DIR } from './maintenanceFlag.js';

var FILE = 'sysop-sessions.json';

function sessionsPath(root) {
	return path.join(root, STATUS_DIR, FILE);
}

/**
 * Record the hashes. Written atomically, so a reader never sees half a list.
 * @param {string} root
 * @param {Iterable<string>} hashes  hex SHA-256 of each sysop session id
 * @param {string} runId             the update run they are for
 */
function writeSysopHashes(root, hashes, runId) {
	var file = sessionsPath(root);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	var tmp = file + '.tmp-' + process.pid;
	var list = Array.from(hashes || []);
	fs.writeFileSync(tmp, JSON.stringify({ ts: new Date().toISOString(), runId: runId || null, hashes: list }) + '\n', { mode: 0o600 });
	fs.renameSync(tmp, file);
	return list.length;
}

/**
 * The recorded hashes as a Set: empty when there is no file, it is unreadable,
 * or it was written for a different run.
 */
function readSysopHashes(root, runId) {
	try {
		var rec = JSON.parse(fs.readFileSync(sessionsPath(root), 'utf8'));
		if (runId && rec.runId !== runId) return new Set();
		return new Set(Array.isArray(rec.hashes) ? rec.hashes.filter(function (h) { return typeof h === 'string'; }) : []);
	} catch (_) {
		return new Set();
	}
}

function clearSysopHashes(root) {
	try { fs.unlinkSync(sessionsPath(root)); } catch (_) {}
}

export {
	sessionsPath,
	writeSysopHashes,
	readSysopHashes,
	clearSysopHashes
};
