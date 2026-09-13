// applyPlan.js -- exactly what landing a release on an install will do to it,
// worked out before anything is touched.
//
// This is the module that can destroy somebody's work, so it is pure and it is
// a plan rather than a loop that writes as it goes. A sysop can read it, a test
// can assert it, and a dry run is the same code path as the real one with the
// writes turned off.
//
// The rules are per category, and each one is a claim about whose file it is:
//
//   code          ours. Overwrite, and delete strays, because a file left
//                 behind in src/ is a module the new release does not know
//                 about and may still import.
//   overlay       ours to add to, theirs to extend. Overwrite what we ship and
//                 leave everything else, since public/ mixes our assets with
//                 their branding.
//   overlay-seed  theirs the moment it exists. public/css/custom.css ships once
//                 and is never written again.
//   data          theirs once touched. Take the update when the file is still
//                 byte for byte what the last release shipped, and otherwise
//                 keep theirs and say so.
//   art           theirs. Add what is new, never replace what is there.
//
// The data rule is the one the manifest exists for. update.sh compares mtimes,
// which says when a file was written and nothing about whether its contents
// differ from what shipped, so it has to stop and ask about every file. With
// the previous release's hashes we can answer it: same as shipped means nobody
// touched it.
//
// An install with no MANIFEST, which is every install predating the release
// machinery, cannot answer that question at all. It fails to CONFLICT, so the
// sysop keeps their file and is told. Guessing the other way would overwrite
// edits nobody can recover.
//
// Pure: no filesystem, no network.

import { manifestIndex } from './manifest.js';
import {
	CATEGORY_CODE, CATEGORY_OVERLAY, CATEGORY_OVERLAY_SEED, CATEGORY_DATA, CATEGORY_ART
} from './shippedTree.js';

// What will happen to one path.
var ACTION_CREATE    = 'create';     // not there, write it
var ACTION_OVERWRITE = 'overwrite';  // there, differs, ours to replace
var ACTION_UNCHANGED = 'unchanged';  // there, identical, nothing to do
var ACTION_KEEP      = 'keep';       // there, deliberately not touched
var ACTION_CONFLICT  = 'conflict';   // there, differs, and it may be theirs
var ACTION_REMOVE    = 'remove';     // here and not in the release, and ours

var ACTIONS = [
	ACTION_CREATE, ACTION_OVERWRITE, ACTION_UNCHANGED,
	ACTION_KEEP, ACTION_CONFLICT, ACTION_REMOVE
];

// Categories whose strays we delete. Everything else keeps target-only files,
// because a file we did not ship and do not ship now is the sysop's.
var REMOVABLE_CATEGORIES = [CATEGORY_CODE];

/**
 * Decide one file.
 *
 * @param {object} entry    the target manifest entry (path, sha256, category)
 * @param {object} [have]   the local file, if present (path, sha256)
 * @param {object} [shipped] what the PREVIOUS release shipped at this path
 * @returns {{action:string, reason:string}}
 */
function decideFile(entry, have, shipped) {
	var category = entry.category;

	if (!have) return { action: ACTION_CREATE, reason: 'not present' };
	if (have.sha256 === entry.sha256) return { action: ACTION_UNCHANGED, reason: 'already current' };

	if (category === CATEGORY_CODE || category === CATEGORY_OVERLAY) {
		return { action: ACTION_OVERWRITE, reason: 'shipped file, ours to replace' };
	}

	if (category === CATEGORY_OVERLAY_SEED) {
		return { action: ACTION_KEEP, reason: 'seeded once at install and never written again' };
	}

	if (category === CATEGORY_ART) {
		return { action: ACTION_KEEP, reason: 'art is never replaced, only added' };
	}

	if (category === CATEGORY_DATA) {
		if (!shipped) {
			return {
				action: ACTION_CONFLICT,
				reason: 'differs from the release, and there is no record of what the last release shipped here'
			};
		}
		if (shipped.sha256 === have.sha256) {
			return { action: ACTION_OVERWRITE, reason: 'still exactly what the last release shipped' };
		}
		return { action: ACTION_CONFLICT, reason: 'edited since the last release shipped it' };
	}

	// A category nothing knows about must not be written over. Reaching here
	// means a release added a category this code does not have a rule for, and
	// the safe reading of "I do not know what this is" is "leave it alone".
	return { action: ACTION_CONFLICT, reason: 'unknown category "' + category + '"' };
}

/**
 * Everything applying `target` to this install will do.
 *
 * @param {object} opts
 * @param {object} opts.target     manifest of the release being applied
 * @param {object} opts.local      manifest-shaped scan of the install as it is
 * @param {object} [opts.installed] the install's own MANIFEST, if it has one
 * @returns {object} the plan
 */
function buildApplyPlan(opts) {
	var target = opts.target || { files: [] };
	var localIdx = manifestIndex(opts.local);
	var shippedIdx = manifestIndex(opts.installed);

	var files = [];
	for (var entry of (target.files || [])) {
		var decision = decideFile(entry, localIdx.get(entry.path), shippedIdx.get(entry.path));
		files.push({
			path: entry.path,
			category: entry.category,
			action: decision.action,
			reason: decision.reason,
			sha256: entry.sha256,
			mode: entry.mode,
			size: entry.size
		});
	}

	// Strays. Computed from the live tree rather than from the install's own
	// manifest, because most installs have no manifest and the ones that do may
	// have drifted from it. Only categories we own are eligible: removing a
	// target-only file under public/, config/ or txtfiles/ would delete the
	// sysop's own work, which is the exact bug that made install.sh dangerous.
	var targetIdx = manifestIndex(target);
	for (var [path, localEntry] of localIdx) {
		if (targetIdx.has(path)) continue;
		if (REMOVABLE_CATEGORIES.indexOf(localEntry.category) === -1) continue;
		files.push({
			path: path,
			category: localEntry.category,
			action: ACTION_REMOVE,
			reason: 'not in this release, and this directory is ours',
			sha256: localEntry.sha256,
			size: localEntry.size
		});
	}

	files.sort(function (a, b) { return a.path < b.path ? -1 : (a.path > b.path ? 1 : 0); });

	return {
		version: target.version || null,
		files: files,
		counts: countByAction(files),
		bytesWritten: files.reduce(function (sum, f) {
			return sum + ((f.action === ACTION_CREATE || f.action === ACTION_OVERWRITE) ? (f.size || 0) : 0);
		}, 0),
		hasConflicts: files.some(function (f) { return f.action === ACTION_CONFLICT; })
	};
}

function countByAction(files) {
	var counts = {};
	for (var a of ACTIONS) counts[a] = 0;
	for (var f of (files || [])) counts[f.action] = (counts[f.action] || 0) + 1;
	return counts;
}

/** The paths one action covers, in order. */
function pathsFor(plan, action) {
	return ((plan && plan.files) || [])
		.filter(function (f) { return f.action === action; })
		.map(function (f) { return f.path; });
}

/** The files that will actually be written, which is what a backup must cover. */
function filesToWrite(plan) {
	return ((plan && plan.files) || []).filter(function (f) {
		return f.action === ACTION_CREATE || f.action === ACTION_OVERWRITE;
	});
}

/** The files that will be deleted, which a backup must cover as well. */
function filesToRemove(plan) {
	return ((plan && plan.files) || []).filter(function (f) { return f.action === ACTION_REMOVE; });
}

/**
 * Everything the sysop has to be told before this is applied.
 *
 * Conflicts are the whole list today. They are not errors and do not stop an
 * update: their file is kept and the release's version is not written, which is
 * a decision the sysop may want to revisit, so it has to be visible rather than
 * logged.
 */
function warningsFor(plan) {
	var out = [];
	for (var f of ((plan && plan.files) || [])) {
		if (f.action !== ACTION_CONFLICT) continue;
		out.push({
			path: f.path,
			reason: f.reason,
			detail: 'keeping your ' + f.path + '; the version shipped in this release was not written'
		});
	}
	return out;
}

export {
	ACTION_CREATE,
	ACTION_OVERWRITE,
	ACTION_UNCHANGED,
	ACTION_KEEP,
	ACTION_CONFLICT,
	ACTION_REMOVE,
	ACTIONS,
	REMOVABLE_CATEGORIES,
	decideFile,
	buildApplyPlan,
	countByAction,
	pathsFor,
	filesToWrite,
	filesToRemove,
	warningsFor
};
