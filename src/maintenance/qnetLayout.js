// src/maintenance/qnetLayout.js: move qnet/<ID>/ into qnet/<ID>.hub/ and
// qnet/<ID>.node/ (#68), run once by db/migrations/0008-qnet-role-dirs.
//
// qnet/ is sysop data: gitignored, and no release ships or touches it, so an
// upgraded board keeps the old layout until something moves it. It holds
// packets in flight (a REP not yet imported, a packet a node has not collected
// with the sidecar recording what it carries), so the move must keep every
// file; it runs with the BBS stopped, in the updater's schema phase.
//
// An ID with one role moves whole. An ID with both roles is split by what each
// file is: the node role owns the REPs a node sends (in/*.rep, and in/extracted
// when it holds a REP's <ID>.MSG), the packets we build for it (out/*.qwk and
// their .json sidecars) and the qnet.log qnet-directory.js writes; the hub role
// owns the packets a hub sends (in/*.qwk, in/bak, and in/extracted when it holds
// MESSAGES.DAT) and the REPs we build for it (out/*.rep). Anything else goes to
// the node role, since a shared-directory node is the only outsider writing
// here, and is listed in the log.
//
// Then qnet/<ID> is left as a symlink to <ID>.node whenever the ID has a node
// role, so a Synchronet node calling through qnet-directory.js with the old
// path keeps working. Only the node role is ever used from outside.
//
// Builtins only, like the rest of what the updater runs.

import fs from 'fs';
import path from 'path';

var HUB = 'hub', NODE = 'node';

/**
 * Which role a file inside a legacy qnet/<ID>/ belongs to, when the ID has
 * both. Pure. `rel` uses '/' separators; `extractedHolds` says what in/extracted
 * contains ('rep', 'qwk' or null).
 * @returns {{role: string, known: boolean}}
 */
function roleForLegacyFile(rel, extractedHolds) {
	var r = String(rel).replace(/\\/g, '/');
	var lower = r.toLowerCase();
	if (lower.indexOf('in/extracted/') === 0) {
		return { role: extractedHolds === 'qwk' ? HUB : NODE, known: extractedHolds !== null };
	}
	if (lower.indexOf('in/bak/') === 0) return { role: HUB, known: true };
	if (/^in\/[^/]+\.rep$/.test(lower) || /^in\/\.[^/]+\.rep\.part$/.test(lower)) return { role: NODE, known: true };
	if (/^in\/[^/]+\.qwk$/.test(lower)) return { role: HUB, known: true };
	if (/^out\/[^/]+\.qwk(\.json)?$/.test(lower)) return { role: NODE, known: true };
	if (/^out\/[^/]+\.rep$/.test(lower)) return { role: HUB, known: true };
	if (lower === 'qnet.log') return { role: NODE, known: true };
	return { role: NODE, known: false };
}

/** What an in/extracted directory holds: 'qwk' (MESSAGES.DAT), 'rep' (*.MSG), or null. */
function extractedKind(names) {
	var list = (names || []).map(function (n) { return String(n).toUpperCase(); });
	if (list.indexOf('MESSAGES.DAT') !== -1) return 'qwk';
	if (list.some(function (n) { return /\.MSG$/.test(n); })) return 'rep';
	return null;
}

function listFiles(dir, base) {
	var out = [];
	var entries = [];
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
	for (var e of entries) {
		var rel = base ? base + '/' + e.name : e.name;
		if (e.isDirectory()) out = out.concat(listFiles(path.join(dir, e.name), rel));
		else out.push(rel);
	}
	return out;
}

// Never overwrites and never throws: a migration that fails fails the update
// after the point where it can be rolled back, so a file that cannot move is
// left where it is and reported instead.
function moveFile(from, to) {
	try {
		if (fs.existsSync(to)) return false;
		fs.mkdirSync(path.dirname(to), { recursive: true });
		fs.renameSync(from, to);
		return true;
	} catch (_) {
		return false;
	}
}

function removeEmptyDirs(dir) {
	var entries = [];
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
	for (var e of entries) if (e.isDirectory()) removeEmptyDirs(path.join(dir, e.name));
	try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch (_) {}
}

/**
 * The legacy directories under qnet/ and the roles their IDs have now.
 * `connections` are QWK connection rows (connection_data), inactive included.
 */
function findLegacyDirs(root, connections) {
	var qnet = path.join(root, 'qnet');
	var roles = new Map();
	for (var c of connections || []) {
		var cd = c.connection_data || {};
		var id = String(cd.remote_qwk_id || '').trim().toUpperCase();
		if (!id) continue;
		if (!roles.has(id)) roles.set(id, new Set());
		roles.get(id).add(cd.transport === 'hub' ? NODE : HUB);
	}
	var out = [];
	var entries = [];
	try { entries = fs.readdirSync(qnet, { withFileTypes: true }); } catch (_) { return out; }
	for (var e of entries) {
		if (!e.isDirectory()) continue;   // symlinks from an earlier run are not directories here
		var dot = e.name.lastIndexOf('.');
		if (dot > 0 && [HUB, NODE].indexOf(e.name.slice(dot + 1)) !== -1) continue;
		var idRoles = roles.get(e.name.toUpperCase());
		out.push({ id: e.name, roles: idRoles ? Array.from(idRoles).sort() : [] });
	}
	return out;
}

/**
 * Move every legacy qnet/<ID>/ that has a connection into the per-role layout.
 * @returns {{moved: string[], skipped: string[], unknown: string[], kept: string[]}}
 */
function migrateQnetLayout(root, connections, log) {
	var say = log || function () {};
	var qnet = path.join(root, 'qnet');
	var result = { moved: [], skipped: [], unknown: [], kept: [] };

	for (var d of findLegacyDirs(root, connections)) {
		var legacy = path.join(qnet, d.id);
		if (d.roles.length === 0) {
			result.skipped.push(d.id);
			say('  qnet/' + d.id + ': no QWK connection uses this ID, left as it is');
			continue;
		}
		var files = listFiles(legacy, '');
		var holds = extractedKind(files.filter(function (f) { return f.toLowerCase().indexOf('in/extracted/') === 0; })
			.map(function (f) { return f.split('/').pop(); }));
		for (var rel of files) {
			var role = d.roles.length === 1 ? d.roles[0] : null;
			if (!role) {
				var decided = roleForLegacyFile(rel, holds);
				role = decided.role;
				if (!decided.known) result.unknown.push(d.id + '/' + rel);
			}
			if (!moveFile(path.join(legacy, rel), path.join(qnet, d.id.toUpperCase() + '.' + role, rel))) {
				result.kept.push(d.id + '/' + rel);
			}
		}
		for (var r of d.roles) {
			for (var sub of ['in', 'out']) {
				try { fs.mkdirSync(path.join(qnet, d.id.toUpperCase() + '.' + r, sub), { recursive: true }); } catch (_) {}
			}
		}
		removeEmptyDirs(legacy);
		if (fs.existsSync(legacy)) {
			say('  qnet/' + d.id + ': could not be emptied; left beside the new directories');
		} else if (d.roles.indexOf(NODE) !== -1) {
			try { fs.symlinkSync(d.id.toUpperCase() + '.' + NODE, legacy); } catch (err) {
				say('  qnet/' + d.id + ': could not link it to the node directory (' + err.message + ')');
			}
		}
		result.moved.push(d.id);
		say('  qnet/' + d.id + ' -> ' + d.roles.map(function (r) { return d.id.toUpperCase() + '.' + r; }).join(' and ') +
			(d.roles.indexOf(NODE) !== -1 ? ' (qnet/' + d.id + ' now links to the node directory)' : ''));
	}
	for (var u of result.unknown) say('  unrecognised file, given to the node role: qnet/' + u);
	for (var k of result.kept) say('  could not move (a file of that name is already there), left in place: qnet/' + k);
	return result;
}

export { roleForLegacyFile, extractedKind, findLegacyDirs, migrateQnetLayout };
