// updateLayout.js -- where the updater keeps its things, and for how long.
//
// One definition, because the last time this codebase had a directory layout
// written down in two places the two drifted and an update deleted every
// sysop-added asset under public/.
//
// Everything lives under one dot directory in the installation, with three
// deliberately different lifetimes inside it:
//
//   staging/<version>/   PER UPDATE. Built, verified, applied, deleted.
//   base/                SURVIVES UPDATES. Cached stable artifacts that
//                        development deltas are reconstructed against. This is
//                        the whole reason the dot directory is not simply
//                        deleted when an update finishes.
//   backup/<runId>/      UNTIL RECLAIMED. What an update displaced, kept so a
//                        rollback is a copy back rather than a reconstruction.
//
// The split from logs/update/ is on purpose. logs/update/ holds the RECORD of
// what happened: small, readable, worth keeping for ever. This directory holds
// BYTES: large, and reclaimable by deleting it, at the cost of the base cache
// and the ability to roll back. Nothing else is lost, and the run state records
// whether its backup is still there so nothing offers a rollback that cannot
// happen.
//
// Why inside the installation at all, rather than /tmp or a cache directory in
// the sysop's home: node_modules resolves by walking up from a module's own
// directory, and a release artifact ships none. An updater staged outside the
// install cannot import anything with a dependency, alogger included. Under the
// install it walks up and finds the install's.
//
// A dot directory is not a shipped category, so scanInstalledFiles never walks
// it, the apply plan never removes it, and setup/update.sh, which only touches
// directories it names, leaves it alone.

import * as fs from 'fs';
import * as path from 'path';

var UPDATE_DIRNAME = '.canectic-update';

var STAGING = 'staging';
var BASE    = 'base';
var BACKUP  = 'backup';

function updateRoot(target) {
	return path.join(target, UPDATE_DIRNAME);
}

/** Per update. Safe to delete the moment an update finishes. */
function stagingDir(target, version) {
	return path.join(updateRoot(target), STAGING, version);
}

function stagingRoot(target) {
	return path.join(updateRoot(target), STAGING);
}

/** Survives updates. Holds stable artifacts deltas are rebuilt against. */
function baseCacheDir(target) {
	return path.join(updateRoot(target), BASE);
}

/** Until reclaimed. What one run displaced. */
function backupDir(target, runId) {
	return path.join(updateRoot(target), BACKUP, runId);
}

function ensure(dir) {
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function dirSize(dir) {
	var total = 0;
	var entries;
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return 0; }
	for (var e of entries) {
		var p = path.join(dir, e.name);
		if (e.isDirectory()) total += dirSize(p);
		else if (e.isFile()) { try { total += fs.statSync(p).size; } catch (_) {} }
	}
	return total;
}

/**
 * What can be deleted here and what it costs, so "I need that disk back" has an
 * answer that is not guesswork.
 */
function reclaimable(target) {
	return {
		root: updateRoot(target),
		staging: { path: stagingRoot(target), bytes: dirSize(stagingRoot(target)),
			cost: 'nothing, once an update has finished' },
		base: { path: baseCacheDir(target), bytes: dirSize(baseCacheDir(target)),
			cost: 'a development update re-downloads its base stable' },
		backup: { path: path.join(updateRoot(target), BACKUP), bytes: dirSize(path.join(updateRoot(target), BACKUP)),
			cost: 'past updates can no longer be rolled back' },
		total: dirSize(updateRoot(target))
	};
}

/**
 * Free bytes on the filesystem holding a path, or null when it cannot be read.
 *
 * Null is not zero. A preflight that treated an unreadable figure as no free
 * space would refuse every update on any system whose filesystem statfs is not
 * supported, which is the wrong direction to fail for a check that is advisory.
 */
function freeBytes(forPath) {
	try {
		var st = fs.statfsSync(forPath);
		return st.bavail * st.bsize;
	} catch (_) {
		return null;
	}
}

export {
	UPDATE_DIRNAME,
	updateRoot,
	stagingDir,
	stagingRoot,
	baseCacheDir,
	backupDir,
	ensure,
	dirSize,
	reclaimable,
	freeBytes
};
