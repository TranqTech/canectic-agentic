// src/models/qwkControl.js: control messages in a user's REP (#75).
//
// An offline reader changes its QWK settings by sending a message addressed to
// "SBBS" whose subject is the command (Synchronet qwk.cpp qwkcfgline, reached
// from un_rep.cpp for a To of "SBBS"). The subject is upper-cased and padded to
// 25 characters before matching, which is why "ON " has a trailing space:
//
//   FILES ON         include the new-files list (NEWFILES.DAT)
//   FILES MM/DD/YY   include it, listing files since that date (once)
//   FILES <other>    leave it out
//   ATTACH ON        include private mail attachments
//   ATTACH <other>   leave them out
//   FREQ <filename>  add that file to the user's batch download queue, which
//                    the next packet carries
//
// Commands Synchronet has that Canectic does not act on are answered as not
// supported rather than ignored.

import * as postgres from '../middleware/db/postgres.js';
import * as userFileBatch from './userFileBatch.js';
import { canBrowseFileArea, canDownloadFileArea } from '../utils/fileAreaAccess.js';

var CONTROL_TO = 'SBBS';

function isControlMessage(msg) {
	return String((msg && msg.to) || '').trim().toUpperCase() === CONTROL_TO;
}

/**
 * Pure. @returns {{command: string, on?: boolean, since?: Date, filename?: string, raw: string}}
 */
function parseControl(subject) {
	var raw = String(subject || '');
	var str = raw.toUpperCase().padEnd(25, ' ').slice(0, Math.max(25, raw.length));
	if (str.indexOf('FILES ') === 0) {
		var d = str.slice(6).match(/^(\d{2})\/(\d{2})\/(\d{2})/);
		if (d) {
			var yy = parseInt(d[3], 10);
			var since = new Date(yy < 80 ? 2000 + yy : 1900 + yy, parseInt(d[1], 10) - 1, parseInt(d[2], 10));
			if (!isNaN(since.getTime())) return { command: 'FILES', on: true, since: since, raw: raw };
		}
		return { command: 'FILES', on: str.slice(6, 9) === 'ON ', raw: raw };
	}
	if (str.indexOf('ATTACH ') === 0) return { command: 'ATTACH', on: str.slice(7, 10) === 'ON ', raw: raw };
	if (str.indexOf('FREQ ') === 0) return { command: 'FREQ', filename: raw.slice(5).trim(), raw: raw };
	return { command: 'UNKNOWN', raw: raw };
}

/** A file this user may download, by name (any case), newest first, or null. */
async function findRequestable(user, filename) {
	var rows = (await postgres.query(
		`SELECT fe.id, fe.uuid, fe.filename, fe.file_size, fe.disk_path, fe.area_shortcode,
		        fa.read_security, fa.read_perm_flags, fa.read_rest_flags,
		        fa.browse_security, fa.browse_perm_flags, fa.browse_rest_flags, fa.active AS area_active,
		        fg.read_security AS g_read_security, fg.read_perm_flags AS g_read_perm_flags,
		        fg.read_rest_flags AS g_read_rest_flags, fg.browse_security AS g_browse_security,
		        fg.browse_perm_flags AS g_browse_perm_flags, fg.browse_rest_flags AS g_browse_rest_flags
		 FROM file_entries fe
		 JOIN file_areas fa ON fa.id = fe.area_id
		 LEFT JOIN file_groups fg ON fg.shortcode = fa.group_shortcode
		 WHERE LOWER(fe.filename) = LOWER($1) AND fe.active = true AND (fg.active IS NULL OR fg.active = true)
		 ORDER BY fe.upload_date DESC, fe.id DESC`, [filename])) || [];
	for (var r of rows) {
		if (r.area_active === false) continue;
		var group = { read_security: r.g_read_security, read_perm_flags: r.g_read_perm_flags, read_rest_flags: r.g_read_rest_flags,
			browse_security: r.g_browse_security, browse_perm_flags: r.g_browse_perm_flags, browse_rest_flags: r.g_browse_rest_flags };
		if (!canBrowseFileArea(user, r) || !canDownloadFileArea(user, r)) continue;
		if (!canBrowseFileArea(user, group) || !canDownloadFileArea(user, group)) continue;
		return r;
	}
	return null;
}

/**
 * Carry out one control message for `user`. Never throws.
 * @returns {Promise<string>} one line saying what was done, for the reply
 */
async function applyControl(user, subject) {
	var c = parseControl(subject);
	try {
		if (c.command === 'FILES') {
			// write() returns a failure rather than throwing.
			var e1 = await postgres.write('UPDATE users SET qwk_files = $1, qwk_files_since = $2 WHERE id = $3',
				[c.on, c.since || null, user.id]);
			if (e1) throw e1;
			if (c.since) return 'FILES: the new-files list is on, listing files since ' + c.since.toDateString() + ' in your next packet';
			return 'FILES: the new-files list is ' + (c.on ? 'on' : 'off');
		}
		if (c.command === 'ATTACH') {
			var e2 = await postgres.write('UPDATE users SET qwk_attach = $1 WHERE id = $2', [c.on, user.id]);
			if (e2) throw e2;
			return 'ATTACH: private mail attachments are ' + (c.on ? 'on' : 'off');
		}
		if (c.command === 'FREQ') {
			if (!c.filename) return 'FREQ: no file name given';
			var f = await findRequestable(user, c.filename);
			if (!f) return 'FREQ ' + c.filename + ': not found in any file area you can download from';
			var added = await userFileBatch.addToBatch(user.id, {
				uuid: f.uuid, id: f.id, filename: f.filename, file_size: f.file_size,
				area_shortcode: f.area_shortcode, disk_path: f.disk_path || f.filename
			});
			return 'FREQ ' + f.filename + ': ' + (added ? 'added to your download queue; it comes in your next packet'
				: 'already in your download queue');
		}
		return 'SBBS "' + c.raw.trim() + '": not a command this system supports (FILES, ATTACH and FREQ are)';
	} catch (err) {
		return 'SBBS "' + c.raw.trim() + '": could not be carried out (' + err.message + ')';
	}
}

export { CONTROL_TO, isControlMessage, parseControl, findRequestable, applyControl };
