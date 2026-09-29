// remoteDoorCatalog.js -- the doors a provider offers (#89, part 3).
//
// Each door provider can keep a catalog: the codes it offers, with when each
// was first seen, last seen and removed, like the echolist registry. The
// sysop ticks doors from it to make door entries, or adds them by code.
//
// Where a catalog comes from (settings.list_source):
//   shipped  a list distributed with Canectic, config/doorlists/<list_name>.json
//   file     the newest file in a file area whose name matches list_file (a
//            .json or .txt list, or an archive holding one), so a list can
//            arrive by file echo
//   remote   a Canectic door server's own list, over the protocol
//   none     hand entry only
// Canectic never fetches or parses anyone's web pages (decided 2026-09-29):
// a page's layout changes without notice, and what it then yields is wrong.
//
// Applying a list: new codes are added, names and categories updated, codes
// no longer listed are marked removed (never deleted) and the door entries
// for them made inactive. An automatic update (the daily check) that would
// remove more than half the active list, or that brings an empty list, is
// refused and reported instead: a truncated or wrong file must not switch
// off a provider's doors.
//
// List format, JSON:
//   { "format": "canectic-doorlist-v1", "list": "doorparty", "title": "...",
//     "updated": "YYYY-MM-DD", "doors": [{ "code", "name", "category"? }] }
// or plain text, one door per line: code, then whitespace, then the name,
// optionally a tab and a category; blank lines and # comments ignored.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import * as postgres from '../middleware/db/postgres.js';

var TABLE = 'remote_door_catalog';
var FORMAT = 'canectic-doorlist-v1';
var LIST_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'doorlists');
var MAX_REMOVED_SHARE = 0.5;
var CODE_RE = /^[A-Za-z0-9!_.=-]{1,64}$/;

function clean(v, max) { return String(v === undefined || v === null ? '' : v).replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max); }

/**
 * Parse a door list. returns { ok, list: { name, title, updated, doors }, errors }.
 * Every problem is reported; lines or entries with a bad code are skipped.
 */
function parseDoorList(text, filename) {
	var errors = [], doors = [], seen = new Set(), meta = {};
	var src = String(text || '').replace(/^﻿/, '');
	var add = function (code, name, category, where) {
		var c = clean(code, 64);
		if (!CODE_RE.test(c)) { errors.push(where + ': not a door code: ' + JSON.stringify(c)); return; }
		if (seen.has(c.toLowerCase())) return;
		seen.add(c.toLowerCase());
		doors.push({ code: c, name: clean(name, 128) || c, category: clean(category, 64) });
	};
	var trimmed = src.trim();
	if (trimmed.startsWith('{')) {
		var j;
		try { j = JSON.parse(trimmed); } catch (e) { return { ok: false, list: null, errors: ['not valid JSON: ' + e.message] }; }
		if (j.format !== FORMAT) errors.push('format is ' + JSON.stringify(j.format) + ', expected ' + FORMAT);
		if (!Array.isArray(j.doors)) return { ok: false, list: null, errors: errors.concat(['no doors array']) };
		j.doors.forEach(function (d, i) { add(d && d.code, d && d.name, d && d.category, 'door ' + (i + 1)); });
		meta = { name: clean(j.list, 32), title: clean(j.title, 128), updated: clean(j.updated, 32) };
	} else {
		src.split(/\r?\n|\r/).forEach(function (line, i) {
			var l = line.replace(/\s+$/, '');
			if (!l.trim() || /^\s*#/.test(l)) return;
			var m = /^\s*(\S+)\s+(.*)$/.exec(l);
			if (!m) { add(l.trim(), '', '', 'line ' + (i + 1)); return; }
			var rest = m[2].split('\t');
			add(m[1], rest[0], rest[1] || '', 'line ' + (i + 1));
		});
		meta = { name: filename ? path.basename(filename).replace(/\.[^.]*$/, '').toLowerCase() : '', title: '', updated: '' };
	}
	return { ok: doors.length > 0, list: Object.assign(meta, { doors: doors }), errors: doors.length ? errors : errors.concat(['no doors in the list']) };
}

/** The lists shipped with Canectic: [{ name, title, updated, count }]. */
function shippedLists() {
	var out = [];
	var files = [];
	try { files = fs.readdirSync(LIST_DIR).filter(function (f) { return /\.json$/i.test(f); }).sort(); } catch (_) {}
	for (var f of files) {
		var p = parseDoorList(fs.readFileSync(path.join(LIST_DIR, f), 'utf8'), f);
		if (p.ok) out.push({ name: p.list.name || f.replace(/\.json$/i, ''), title: p.list.title, updated: p.list.updated, count: p.list.doors.length });
	}
	return out;
}

function loadShippedList(name) {
	if (!/^[a-z0-9_-]{1,32}$/.test(String(name || ''))) return { ok: false, list: null, errors: ['no shipped list named ' + name] };
	var file = path.join(LIST_DIR, name + '.json');
	if (!fs.existsSync(file)) return { ok: false, list: null, errors: ['no shipped list named ' + name] };
	return parseDoorList(fs.readFileSync(file, 'utf8'), file);
}

/** A filename glob (* and ?) as a case-insensitive RegExp. */
function globToRegExp(glob) {
	var re = String(glob || '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
	return new RegExp('^' + re + '$', 'i');
}

/**
 * Pure: compare the catalog with a list.
 * rows: [{ code, name, category, active }]; doors: [{ code, name, category }]
 * returns { added, changed, removed, returning, unchanged } (arrays of codes,
 * `changed` and `added` as door objects)
 */
function diffCatalog(rows, doors) {
	var byCode = new Map();
	for (var r of rows || []) byCode.set(String(r.code).toLowerCase(), r);
	var listed = new Set();
	var out = { added: [], changed: [], removed: [], returning: [], unchanged: [] };
	for (var d of doors || []) {
		var key = d.code.toLowerCase();
		listed.add(key);
		var row = byCode.get(key);
		if (!row) { out.added.push(d); continue; }
		if (!row.active) out.returning.push(row.code);
		if ((row.name || '') !== (d.name || '') || (row.category || '') !== (d.category || '')) out.changed.push(d);
		else if (row.active) out.unchanged.push(row.code);
	}
	for (var r2 of rows || []) {
		if (r2.active && !listed.has(String(r2.code).toLowerCase())) out.removed.push(r2.code);
	}
	return out;
}

/** Pure: whether an automatic update may apply this diff. returns { ok, reason } */
function safeToApply(rows, doors, diff) {
	if (!doors || !doors.length) return { ok: false, reason: 'the list is empty' };
	var active = (rows || []).filter(function (r) { return r.active; }).length;
	if (active >= 4 && diff.removed.length > active * MAX_REMOVED_SHARE) {
		return { ok: false, reason: 'it would remove ' + diff.removed.length + ' of ' + active + ' doors, more than half, so it looks truncated or wrong' };
	}
	return { ok: true, reason: '' };
}

async function getCatalog(remoteId) {
	return (await postgres.query('SELECT * FROM ' + TABLE + ' WHERE remote_id = $1 ORDER BY active DESC, category ASC, name ASC', [remoteId])) || [];
}

/**
 * Apply a list to a provider's catalog. opts.automatic applies the safety
 * rule; opts.dryRun only reports. returns { ok, reason, diff, deactivatedDoors: [slug] }
 */
async function applyList(remote, doors, opts) {
	var o = opts || {};
	var rows = await getCatalog(remote.id);
	var diff = diffCatalog(rows, doors);
	if (o.automatic) {
		var safe = safeToApply(rows, doors, diff);
		if (!safe.ok) return { ok: false, reason: safe.reason, diff: diff, deactivatedDoors: [] };
	} else if (!doors || !doors.length) {
		return { ok: false, reason: 'the list is empty', diff: diff, deactivatedDoors: [] };
	}
	if (o.dryRun) return { ok: true, reason: '', diff: diff, deactivatedDoors: [] };

	var err;
	for (var d of diff.added) {
		err = await postgres.write('INSERT INTO ' + TABLE + ' (remote_id, code, name, category, first_seen, last_seen, active) VALUES ($1, $2, $3, $4, NOW(), NOW(), true)',
			[remote.id, d.code, d.name, d.category || null]);
		if (err) throw new Error('could not add ' + d.code + ': ' + err.message);
	}
	var listedCodes = doors.map(function (x) { return x.code.toLowerCase(); });
	var byCode = {};
	for (var x of doors) byCode[x.code.toLowerCase()] = x;
	for (var code of listedCodes) {
		var dd = byCode[code];
		err = await postgres.write('UPDATE ' + TABLE + ' SET name = $3, category = $4, last_seen = NOW(), active = true, removed_at = NULL WHERE remote_id = $1 AND lower(code) = $2',
			[remote.id, code, dd.name, dd.category || null]);
		if (err) throw new Error('could not update ' + code + ': ' + err.message);
	}
	var deactivated = [];
	if (diff.removed.length) {
		var lower = diff.removed.map(function (c) { return String(c).toLowerCase(); });
		err = await postgres.write('UPDATE ' + TABLE + ' SET active = false, removed_at = NOW() WHERE remote_id = $1 AND lower(code) = ANY($2::text[])', [remote.id, lower]);
		if (err) throw new Error('could not mark removed doors: ' + err.message);
		// A door entry for a door the provider no longer offers stops being
		// offered to callers; it is kept, so the sysop can see why.
		var hit = (await postgres.query(
			"UPDATE doors SET active = false, updated_at = NOW() WHERE launch_type = 'Remote' AND remote_provider = $1 AND lower(remote_door) = ANY($2::text[]) AND active = true RETURNING slug",
			[remote.name, lower])) || [];
		deactivated = hit.map(function (h) { return h.slug; });
	}
	return { ok: true, reason: '', diff: diff, deactivatedDoors: deactivated };
}

/** Read a list file from disk, unpacking a .zip holding a .json or .txt list. */
function readListFile(filePath) {
	var ext = path.extname(filePath).toLowerCase();
	if (ext !== '.zip') return parseDoorList(fs.readFileSync(filePath, 'utf8'), filePath);
	var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canectic-doorlist-'));
	try {
		execFileSync('unzip', ['-o', '-j', filePath, '-d', tmp], { stdio: 'pipe', timeout: 30000 });
		var inside = fs.readdirSync(tmp).filter(function (f) { return /\.(json|txt)$/i.test(f); }).sort();
		if (!inside.length) return { ok: false, list: null, errors: [path.basename(filePath) + ' holds no .json or .txt list'] };
		return parseDoorList(fs.readFileSync(path.join(tmp, inside[0]), 'utf8'), inside[0]);
	} catch (e) {
		return { ok: false, list: null, errors: ['could not unpack ' + path.basename(filePath) + ': ' + e.message] };
	} finally {
		try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
	}
}

/**
 * Load the list a provider's settings name. deps (tests): { listRemoteDoors, files }.
 * returns { ok, list, errors, from } where `from` says where it came from.
 */
async function loadListFor(remote, settings, deps) {
	var d = deps || {};
	var src = settings.list_source || 'none';
	if (src === 'shipped') {
		var s = loadShippedList(settings.list_name);
		return Object.assign(s, { from: 'the ' + (settings.list_name || '?') + ' list shipped with Canectic' + (s.list && s.list.updated ? ' (' + s.list.updated + ')' : '') });
	}
	if (src === 'remote') {
		if ((remote.kind || 'canectic') !== 'canectic') return { ok: false, list: null, errors: ['only a Canectic door server sends its own list'], from: '' };
		var lister = d.listRemoteDoors || (await import('../utils/doorserverClient.js')).listDoors;
		var r = await lister({ url: remote.url, systemId: remote.system_id, secret: remote.secret, timeoutMs: 10000 });
		if (!r.ok) return { ok: false, list: null, errors: [r.reason], from: remote.name };
		return { ok: r.doors.length > 0, list: { doors: r.doors.map(function (x) { return { code: x.slug, name: x.name, category: '' }; }) },
			errors: r.doors.length ? [] : ['it offers no doors'], from: remote.title || remote.name };
	}
	if (src === 'file') {
		var found = await (d.files || newestListFile)(settings.list_area, settings.list_file);
		if (!found.ok) return { ok: false, list: null, errors: [found.reason], from: '' };
		var p = readListFile(found.path);
		return Object.assign(p, { from: found.name + ' in file area ' + settings.list_area, fileDate: found.date });
	}
	return { ok: false, list: null, errors: ['this provider has no door list source'], from: '' };
}

/** The newest file in a file area whose name matches a glob. */
async function newestListFile(areaShortcode, glob) {
	if (!areaShortcode || !glob) return { ok: false, reason: 'set the file area and file name to check' };
	var fileAreas = await import('./fileAreas.js');
	var fileGroups = await import('./fileGroups.js');
	var fileEntries = await import('./fileEntries.js');
	var area = await fileAreas.getAreaByShortcode(areaShortcode);
	if (!area) return { ok: false, reason: 'no file area ' + areaShortcode };
	var group = area.group_shortcode ? await fileGroups.getGroupByShortcode(area.group_shortcode) : null;
	var areaPath = fileAreas.resolveAreaPath(group, area);
	var files = (await fileEntries.getEntriesForArea(area.id, { limit: 500, orderBy: 'upload_date DESC' })) || [];
	var re = globToRegExp(glob);
	var match = files.filter(function (f) { return re.test(f.filename || ''); })
		.sort(function (a, b) { return new Date(b.upload_date || b.created_at || 0) - new Date(a.upload_date || a.created_at || 0); })[0];
	if (!match) return { ok: false, reason: 'no file matching ' + glob + ' in ' + areaShortcode };
	var p = path.join(areaPath, match.disk_path || match.filename);
	if (!fs.existsSync(p)) return { ok: false, reason: match.filename + ' is listed in ' + areaShortcode + ' but is not on disk' };
	return { ok: true, path: p, name: match.filename, date: match.upload_date || match.created_at };
}

/**
 * The daily check: every active provider with list_auto on. Reports each
 * change, refusal and deactivated door to the sysops. deps (tests): { notify, remotes }.
 */
async function checkAll(deps) {
	var d = deps || {};
	var remotesModel = d.remotes || (await import('./doorserverRemotes.js'));
	var notify = d.notify || (async function (title, body) {
		var notif = await import('./notifications.js');
		await notif.createSysop('door_list', title, body, { link: '/admin/doorserver#remotes', icon: 'controller', severity: 'info' });
	});
	var results = [];
	for (var remote of (await remotesModel.getAll()) || []) {
		if (!remote.active) continue;
		var settings = remotesModel.settingsOf(remote);
		if (!settings.list_auto || (settings.list_source || 'none') === 'none') continue;
		var loaded = await loadListFor(remote, settings, d);
		var label = remote.title || remote.name;
		if (!loaded.ok) {
			results.push({ remote: remote.name, ok: false, reason: loaded.errors.join('; ') });
			await notify('Door list for ' + label + ' could not be read', loaded.errors.join('; '));
			continue;
		}
		var r = await applyList(remote, loaded.list.doors, { automatic: true });
		results.push({ remote: remote.name, ok: r.ok, reason: r.reason, diff: r.diff, deactivated: r.deactivatedDoors });
		if (!r.ok) {
			await notify('Door list for ' + label + ' was not applied', 'The list from ' + loaded.from + ' was refused: ' + r.reason + '. Check it on the provider page.');
		} else if (r.diff.added.length || r.diff.removed.length || r.diff.returning.length) {
			var parts = [];
			if (r.diff.added.length) parts.push(r.diff.added.length + ' new: ' + r.diff.added.map(function (x) { return x.name; }).slice(0, 10).join(', '));
			if (r.diff.removed.length) parts.push(r.diff.removed.length + ' no longer offered: ' + r.diff.removed.slice(0, 10).join(', '));
			if (r.diff.returning.length) parts.push(r.diff.returning.length + ' offered again: ' + r.diff.returning.slice(0, 10).join(', '));
			if (r.deactivatedDoors.length) parts.push('door entries made inactive: ' + r.deactivatedDoors.join(', '));
			await notify('Door list for ' + label + ' changed', parts.join('. ') + '.');
		}
	}
	return results;
}

export {
	FORMAT, MAX_REMOVED_SHARE, parseDoorList, shippedLists, loadShippedList, globToRegExp,
	diffCatalog, safeToApply, getCatalog, applyList, readListFile, loadListFor, newestListFile, checkAll
};
