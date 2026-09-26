// src/models/qwkFiles.js: files carried in QWK packets, both directions (#72).
//
// Synchronet has carried files over QWKnet since 1993 as extra members of the
// packet archive, with no metadata: whatever sits in qnet/<id>.out/ goes into
// the next packet to that peer, and whatever arrives that is not a standard
// packet file lands in qnet/<id>.in/ with a message to the sysop (pack_rep.cpp,
// pack_qwk.cpp, un_qwk.cpp, un_rep.cpp). Its planned QWK certificate authority
// uses the same channel. Canectic deleted anything extra it received, without
// a word, and never sent any.
//
// Here: files in qnet/<ID>.<role>/out/files/ go with the next packet; files
// received go through the inbound wildcard rules (as a mailer file does),
// else to qnet/<ID>.<role>/in/files/. A file of the same name is overwritten,
// as Synchronet does. They live one level down because in/ and out/ hold the
// packets themselves, which are picked out by extension: a received FOO.REP
// sitting in a node's in/ would otherwise be imported as that node's mail.

import fs from 'fs';
import path from 'path';
import * as alogger from '../utils/alogger.js';
import * as fileWildcards from './fileWildcards.js';
import { resolveFileboxPath } from '../utils/fileboxPath.js';
import { qnetInDir, qnetOutDir } from '../utils/qnetPaths.js';

// A packet's own members (Synchronet removes these before keeping the rest).
var STANDARD_NAMES = ['CONTROL.DAT', 'MESSAGES.DAT', 'HEADERS.DAT', 'VOTING.DAT', 'NETFLAGS.DAT',
	'DOOR.ID', 'TOREADER.EXT', 'TODOOR.EXT', 'ATTXREF.DAT'];
var MAX_FILES_PER_PACKET = 1000;   // Synchronet's cap on REP extraction

function isStandardMember(name) {
	var up = String(name || '').toUpperCase();
	return STANDARD_NAMES.indexOf(up) !== -1 || /\.NDX$/.test(up) || /\.MSG$/.test(up);
}

// Letters, digits, dot, dash, underscore; not starting with a dot. Stricter
// than a filesystem needs, since the name comes from another system.
function isSafeFileName(name) {
	var n = String(name || '');
	return n.length > 0 && n.length <= 255 && /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(n);
}

function outFilesDir(connectionData, root) {
	return path.join(qnetOutDir(connectionData, root), 'files');
}

function inFilesDir(connectionData, root) {
	return path.join(qnetInDir(connectionData, root), 'files');
}

/**
 * Files waiting to go to this peer. A name that could not be sent safely (or
 * would be taken for part of the packet) is left where it is and logged.
 * @returns {{name: string, path: string}[]}
 */
function listOutgoing(connectionData, root) {
	var dir = outFilesDir(connectionData, root);
	var out = [];
	var entries = [];
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
	for (var e of entries) {
		if (!e.isFile()) continue;
		if (!isSafeFileName(e.name) || isStandardMember(e.name)) {
			alogger.writeClog(3, 'QWK files: not sending ' + path.join(dir, e.name) +
				' (its name is not a plain file name, or is one a packet uses itself)', 'tosser', 'yellow', false, false);
			continue;
		}
		out.push({ name: e.name, path: path.join(dir, e.name) });
		if (out.length >= MAX_FILES_PER_PACKET) break;
	}
	return out;
}

/** Remove files that have gone: `names` from `dir`, ignoring any already gone. */
function removeSent(dir, names) {
	for (var n of names || []) {
		if (!isSafeFileName(n)) continue;
		try { fs.unlinkSync(path.join(dir, n)); } catch (_) {}
	}
}

function moveInto(from, to) {
	try {
		fs.renameSync(from, to);
	} catch (_) {
		fs.copyFileSync(from, to);
		fs.unlinkSync(from);
	}
}

/**
 * Keep every extra member of an extracted packet: through the wildcard rules,
 * else into in/files/, overwriting a file of the same name. `label` names the
 * peer for the log and the notification.
 * @returns {Promise<{received: {name: string, dest: string}[], refused: string[]}>}
 */
async function receiveExtraFiles(extractDir, connectionData, label, root) {
	var result = { received: [], refused: [] };
	var entries = [];
	try { entries = fs.readdirSync(extractDir, { withFileTypes: true }); } catch (_) { return result; }
	var extras = entries.filter(function (e) { return e.isFile() && !isStandardMember(e.name); });

	for (var e of extras) {
		if (result.received.length >= MAX_FILES_PER_PACKET || !isSafeFileName(e.name)) {
			result.refused.push(e.name);
			alogger.writeClog(3, 'QWK files: refused ' + JSON.stringify(e.name) + ' from ' + label +
				(isSafeFileName(e.name) ? ' (more than ' + MAX_FILES_PER_PACKET + ' files in one packet)' : ' (not a plain file name)'),
				'tosser', 'yellow', false, false);
			continue;
		}
		var destDir = inFilesDir(connectionData, root);
		try {
			var rule = await fileWildcards.matchFilename(e.name);
			if (rule) {
				var target = resolveFileboxPath(rule.target_dir);
				if (target) destDir = target;
			}
		} catch (_) {}
		try {
			fs.mkdirSync(destDir, { recursive: true });
			var dest = path.join(destDir, e.name);
			moveInto(path.join(extractDir, e.name), dest);
			result.received.push({ name: e.name, dest: dest });
			alogger.writeClog(5, 'QWK files: received ' + e.name + ' from ' + label + ' -> ' + dest, 'tosser', 'greenbright', false, false);
		} catch (err) {
			result.refused.push(e.name);
			alogger.writeClog(2, 'QWK files: could not keep ' + e.name + ' from ' + label + ': ' + err.message, 'tosser', 'redbright', false, false);
		}
	}

	for (var r of result.received) {
		try {
			var notifications = await import('./notifications.js');
			await notifications.createSysop('qwk_file_received', 'Received ' + r.name + ' from ' + label + ' via QWK',
				'Saved as ' + r.dest, { severity: 'info', icon: 'file-earmark-arrow-down', link: '/admin/transfers' });
		} catch (_) {}
	}
	return result;
}

export {
	STANDARD_NAMES,
	MAX_FILES_PER_PACKET,
	isStandardMember,
	isSafeFileName,
	outFilesDir,
	inFilesDir,
	listOutgoing,
	removeSent,
	receiveExtraFiles
};
