// fileAreaRelocation.js -- move file area directories when the setting that
// places them changes (#28).
//
// An area's directory is resolved at run time from three levels: the global
// file_base_dir, the group's base_dir and the area's sub_dir
// (fileAreas.resolveAreaPath). Changing any of them used to update the
// database and leave every file at the old path, so the area pointed at an
// empty directory. File entries store only a filename (disk_path) and every
// reader resolves the area path when it needs it, so moving the files is the
// whole job: nothing in the database changes.
//
// Planning is separate from moving so the admin can see what will happen
// before saving: for each area, its path before and after, how many entries
// it holds, and any name that already exists at the destination.
//
// Moving is FILE BY FILE, never a rename of the directory, and happens AFTER
// the setting is saved. So a TIC arriving mid-move lands in the new place, a
// destination that already exists is merged into rather than replaced, and a
// move across filesystems works (rename, falling back to copy then delete,
// keeping modification times). A name that exists at both ends is left where
// it is and reported, never overwritten. The old directory is removed only
// when the move leaves it empty.

import * as fs from 'fs';
import * as path from 'path';
import * as fileAreas from '../models/fileAreas.js';
import * as fileGroups from '../models/fileGroups.js';
import * as alogger from '../utils/alogger.js';

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

function listEntries(dir) {
	try { return fs.readdirSync(dir); } catch (_) { return null; }
}

// True when `inner` is `outer` or somewhere below it.
function isWithin(inner, outer) {
	var rel = path.relative(outer, inner);
	return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * What moving one area's directory would do.
 *
 * status:
 *   same      the path does not change
 *   empty     nothing at the old path (missing or empty): nothing to move
 *   move      entries to move, none of them clashing
 *   conflict  some names already exist at the destination; the rest move
 */
function inspectMove(shortcode, from, to) {
	var result = { shortcode: shortcode, from: from, to: to, status: 'same', entries: 0, conflicts: [] };
	if (path.resolve(from) === path.resolve(to)) return result;

	var names = listEntries(from);
	// Never count the destination itself when it sits inside the source.
	names = (names || []).filter(function (n) { return !isWithin(path.resolve(to), path.resolve(from, n)); });
	result.entries = names.length;
	if (!names.length) { result.status = 'empty'; return result; }

	var there = new Set(listEntries(to) || []);
	result.conflicts = names.filter(function (n) { return there.has(n); });
	result.status = result.conflicts.length ? 'conflict' : 'move';
	return result;
}

function summarise(moves) {
	var needs = moves.filter(function (m) { return m.status === 'move' || m.status === 'conflict'; });
	return {
		moves: moves,
		needsMove: needs.length > 0,
		entries: needs.reduce(function (n, m) { return n + m.entries - m.conflicts.length; }, 0),
		conflicts: needs.reduce(function (n, m) { return n + m.conflicts.length; }, 0),
	};
}

function normaliseBaseDir(value) {
	var v = value === undefined || value === null ? '' : String(value).trim();
	return v || null;
}

/** A group's base_dir is about to become newBaseDir. */
async function planGroupChange(groupShortcode, newBaseDir) {
	var group = await fileGroups.getGroupByShortcode(groupShortcode);
	if (!group) return summarise([]);
	var after = Object.assign({}, group, { base_dir: normaliseBaseDir(newBaseDir) });
	var areas = await fileAreas.getAreasInGroup(groupShortcode);
	return summarise(areas.map(function (a) {
		return inspectMove(a.shortcode, fileAreas.resolveAreaPath(group, a), fileAreas.resolveAreaPath(after, a));
	}));
}

/** An area's sub_dir is about to become newSubDir (blank means its shortcode). */
async function planAreaChange(areaShortcode, newSubDir) {
	var area = await fileAreas.getAreaByShortcode(areaShortcode);
	if (!area) return summarise([]);
	var group = area.group_shortcode ? await fileGroups.getGroupByShortcode(area.group_shortcode) : null;
	var sub = (newSubDir === undefined || newSubDir === null ? '' : String(newSubDir).trim()) || area.shortcode.toLowerCase();
	var after = Object.assign({}, area, { sub_dir: sub });
	return summarise([inspectMove(area.shortcode, fileAreas.resolveAreaPath(group, area), fileAreas.resolveAreaPath(group, after))]);
}

/** The global file_base_dir is about to become newBase. */
async function planGlobalChange(newBase) {
	var groups = await fileGroups.getAllGroups();
	var byId = {};
	for (var g of groups) byId[g.id] = g;
	var areas = await fileAreas.getAllAreas();
	return summarise(areas.map(function (a) {
		var group = byId[a.group_id] || null;
		return inspectMove(a.shortcode, fileAreas.resolveAreaPath(group, a),
			fileAreas.resolveAreaPath(group, a, { globalBase: newBase }));
	}));
}

// ---------------------------------------------------------------------------
// Moving
// ---------------------------------------------------------------------------

function moveEntry(src, dest) {
	try {
		fs.renameSync(src, dest);
		return;
	} catch (err) {
		if (err.code !== 'EXDEV') throw err;
	}
	// Across filesystems: copy, keeping times, then remove the original.
	var st = fs.statSync(src);
	if (st.isDirectory()) {
		fs.cpSync(src, dest, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
		fs.rmSync(src, { recursive: true, force: true });
	} else {
		fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
		fs.utimesSync(dest, st.atime, st.mtime);
		fs.unlinkSync(src);
	}
}

/**
 * Move one area's entries from `from` into `to`.
 * returns { shortcode, from, to, moved, conflicts: [names], errors: [text], removedOld }
 */
function moveArea(shortcode, from, to) {
	var out = { shortcode: shortcode, from: from, to: to, moved: 0, conflicts: [], errors: [], removedOld: false };
	if (path.resolve(from) === path.resolve(to)) return out;
	var names = listEntries(from);
	if (!names) return out;

	try { fs.mkdirSync(to, { recursive: true }); }
	catch (err) { out.errors.push('cannot create ' + to + ': ' + err.message); return out; }

	for (var name of names) {
		var src = path.join(from, name);
		var dest = path.join(to, name);
		if (isWithin(path.resolve(to), path.resolve(src))) continue;
		if (fs.existsSync(dest)) { out.conflicts.push(name); continue; }
		try { moveEntry(src, dest); out.moved++; }
		catch (err) { out.errors.push(name + ': ' + err.message); }
	}

	try {
		if ((listEntries(from) || []).length === 0) { fs.rmdirSync(from); out.removedOld = true; }
	} catch (_) {}
	return out;
}

/**
 * Carry out moves planned before a setting was saved.
 *
 * Each move's destination is checked against where its area resolves NOW,
 * and a move whose area has since been pointed somewhere else again is
 * skipped rather than sent to a stale destination.
 *
 * moves: [{ shortcode, from, to }]
 * opts.resolveNow(shortcode) -> current path, or null for an area that is
 *   gone (injectable for tests)
 */
async function executeMoves(moves, opts) {
	var o = opts || {};
	var resolveNow = o.resolveNow || currentAreaPath;
	var results = [];
	for (var m of moves || []) {
		var now = await resolveNow(m.shortcode);
		if (!now || path.resolve(now) !== path.resolve(m.to)) {
			results.push({ shortcode: m.shortcode, from: m.from, to: m.to, moved: 0, conflicts: [], removedOld: false,
				errors: ['not moved: the area no longer resolves to ' + m.to + (now ? ' (now ' + now + ')' : ' (area gone)')] });
			continue;
		}
		var r = moveArea(m.shortcode, m.from, m.to);
		results.push(r);
		alogger.writeAlog(r.errors.length ? 2 : 3, '[Relocate] ' + m.shortcode + ': moved ' + r.moved + ' from ' + m.from + ' to ' + m.to +
			(r.conflicts.length ? ', left ' + r.conflicts.length + ' already present at the destination' : '') +
			(r.errors.length ? ', ' + r.errors.length + ' error(s): ' + r.errors.join('; ') : ''), r.errors.length ? 'redbright' : 'cyan');
	}
	return results;
}

async function currentAreaPath(shortcode) {
	var area = await fileAreas.getAreaByShortcode(shortcode);
	if (!area) return null;
	var group = area.group_shortcode ? await fileGroups.getGroupByShortcode(area.group_shortcode) : null;
	return fileAreas.resolveAreaPath(group, area);
}

/** The moves a plan asks for, as job data. */
function movesToRun(plan) {
	return (plan && plan.moves || [])
		.filter(function (m) { return m.status === 'move' || m.status === 'conflict'; })
		.map(function (m) { return { shortcode: m.shortcode, from: m.from, to: m.to }; });
}

export {
	inspectMove, planGroupChange, planAreaChange, planGlobalChange,
	moveArea, executeMoves, movesToRun, isWithin
};
