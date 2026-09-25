// updateHousekeeping.js -- what an update leaves behind, and when it goes (#62).
//
// Every update wrote .canectic-update/backup/<runId>/, including a full
// database dump, and nothing ever removed one: updateLayout.js called the
// lifetime "until reclaimed" and the only way to reclaim was by hand. Staging
// was meant to be per update, but the handoff path has to keep it (the
// updater runs from it) and nothing came back for it afterwards. On the hub
// that was 933 MB of backups and 179 MB of staging after five updates.
//
// Now, once an update has COMPLETED, the backups of all but the last
// `update_backup_keep` completed runs are deleted, and every staging directory
// except the one this updater is running from. Called from the housekeeping
// block at the end of runUpdate, outside the phases, so failing here can never
// fail an update that worked; and by `update.js --prune` to reclaim by hand.
//
// A backup is the only way to undo an update's files and its database
// migration, so the rules lean towards keeping:
//
//   - the current run's backup is never deleted, whatever `keep` says;
//   - a run that did not complete (failed, still running, or no record) is
//     kept while it is NEWER than the last completed run, since that is the
//     one a sysop may be recovering from. Once a later update has completed,
//     the board has moved past it and its backup can no longer be restored
//     over what is there;
//   - 0 keeps every backup, as 0 means keep for ever for the retention settings;
//   - a directory not named like a run id is not ours and is never touched.
//
// Builtins only, like updateLayout: this runs inside the updater, which may be
// new code over old node_modules.

import * as fs from 'fs';
import * as path from 'path';
import { updateRoot, stagingRoot, dirSize } from './updateLayout.js';
import * as runStore from './updateRunStore.js';

var BACKUP = 'backup';
var RUN_ID_RE = /^\d{8}-\d{6}-[a-z0-9]+$/;

export var DEFAULT_BACKUP_KEEP = 1;

/**
 * Which backups to delete. Pure.
 *
 * @param {object} opts
 * @param {{runId: string, status: (string|null)}[]} opts.backups - every backup directory, with its run's status
 * @param {string} opts.currentRunId - the run that has just completed
 * @param {number} opts.keep - completed runs to keep backups for; 0 keeps all
 * @returns {string[]} run ids whose backups to delete, oldest first
 */
export function planBackupPrune(opts) {
	var keep = Number(opts.keep);
	if (!Number.isFinite(keep) || keep < 0) keep = DEFAULT_BACKUP_KEEP;
	if (keep === 0) return [];

	var runs = (opts.backups || [])
		.filter(function (b) { return b && RUN_ID_RE.test(b.runId); })
		.slice()
		.sort(function (a, b) { return a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0; });  // newest first

	// The current run is kept and counts towards `keep` whatever it is named;
	// it is also the newest completed run by definition.
	var current = opts.currentRunId || null;
	var newestComplete = current;
	if (!newestComplete) {
		for (var r of runs) {
			if (r.status === 'complete') { newestComplete = r.runId; break; }
		}
	}

	var keptComplete = current ? 1 : 0;
	var doomed = [];
	for (var run of runs) {
		if (run.runId === current) continue;
		if (run.status === 'complete') {
			if (keptComplete < keep) { keptComplete++; continue; }
			doomed.push(run.runId);
			continue;
		}
		// Not complete: keep while it may be what a sysop is recovering from.
		if (!newestComplete || !RUN_ID_RE.test(newestComplete) || run.runId > newestComplete) continue;
		doomed.push(run.runId);
	}
	return doomed.sort();
}

/**
 * Which staging directories to delete. Pure. Everything but the one the
 * running updater was started from.
 *
 * @param {string[]} names - entries under staging/
 * @param {string|null} inUse - the entry the running updater lives in
 */
export function planStagingPrune(names, inUse) {
	return (names || []).filter(function (n) { return n && n !== inUse; }).sort();
}

// The staging entry a staged root lives in: staging/<version>/tree -> <version>.
export function stagingEntryFor(target, stagedRoot) {
	if (!stagedRoot) return null;
	var rel = path.relative(stagingRoot(target), path.resolve(stagedRoot));
	if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
	return rel.split(path.sep)[0];
}

// Record on a run that its backup is gone, so nothing later reads the run as
// one that can be rolled back. Written to the run's own file only:
// runStore.save would also overwrite latest.json with this OLD run.
function markBackupRemoved(target, runId) {
	var st = runStore.load(target, runId);
	if (!st) return;
	st.backupRemovedAt = new Date().toISOString();
	var file = runStore.statePath(target, runId);
	fs.writeFileSync(file + '.tmp', JSON.stringify(st, null, 2) + '\n');
	fs.renameSync(file + '.tmp', file);
}

function listDirs(dir) {
	try {
		return fs.readdirSync(dir, { withFileTypes: true })
			.filter(function (e) { return e.isDirectory(); })
			.map(function (e) { return e.name; });
	} catch (_) {
		return [];
	}
}

/**
 * Delete old update backups and leftover staging.
 *
 * @param {object} opts
 * @param {string} opts.target
 * @param {string|null} opts.currentRunId - the run just completed; null from the CLI
 * @param {string|null} opts.stagedRoot - the tree the running updater came from
 * @param {number} opts.keep
 * @param {boolean} [opts.dryRun]
 * @param {function} [opts.log]
 * @returns {{backups: {runId: string, bytes: number}[], staging: {name: string, bytes: number}[], freed: number, errors: string[]}}
 */
export function pruneUpdateLeftovers(opts) {
	var target = opts.target;
	var log = opts.log || function () {};
	var backupRoot = path.join(updateRoot(target), BACKUP);
	var result = { backups: [], staging: [], freed: 0, errors: [] };

	var backups = listDirs(backupRoot).map(function (runId) {
		var state = RUN_ID_RE.test(runId) ? runStore.load(target, runId) : null;
		return { runId: runId, status: state ? state.status : null };
	});
	var currentRunId = opts.currentRunId || null;
	if (!currentRunId) {
		// By hand, with no run in progress: the newest completed run counts as
		// the current one, so its backup is never the one removed.
		var done = backups.filter(function (b) { return b.status === 'complete'; }).map(function (b) { return b.runId; }).sort();
		currentRunId = done.length ? done[done.length - 1] : null;
	}
	// By hand while an update runs, the running one's staging and the backup
	// it is writing would both look like leftovers. Only a run NEWER than the
	// last completed one can really be running: an updater that died before
	// the updater guard existed (0.9.7a) left a run saying "running" for good,
	// and refusing on that would block pruning on that board for ever.
	var inProgress = backups.concat(runStore.list(target).map(function (id) {
		var st = runStore.load(target, id);
		return { runId: id, status: st ? st.status : null };
	})).some(function (b) {
		return b.status === 'running' && (!currentRunId || b.runId > currentRunId);
	});
	if (!opts.currentRunId && inProgress) {
		result.errors.push('an update is in progress; nothing removed');
		return result;
	}

	for (var runId of planBackupPrune({ backups: backups, currentRunId: currentRunId, keep: opts.keep })) {
		var dir = path.join(backupRoot, runId);
		var bytes = dirSize(dir);
		if (!opts.dryRun) {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
				markBackupRemoved(target, runId);
			} catch (err) {
				result.errors.push('backup ' + runId + ': ' + err.message);
				continue;
			}
		}
		result.backups.push({ runId: runId, bytes: bytes });
		result.freed += bytes;
		log((opts.dryRun ? 'would remove' : 'removed') + ' update backup ' + runId + ' (' + Math.round(bytes / 1048576) + ' MB)');
	}

	var inUse = stagingEntryFor(target, opts.stagedRoot);
	for (var name of planStagingPrune(listDirs(stagingRoot(target)), inUse)) {
		var sdir = path.join(stagingRoot(target), name);
		var sbytes = dirSize(sdir);
		if (!opts.dryRun) {
			try {
				fs.rmSync(sdir, { recursive: true, force: true });
			} catch (err) {
				result.errors.push('staging ' + name + ': ' + err.message);
				continue;
			}
		}
		result.staging.push({ name: name, bytes: sbytes });
		result.freed += sbytes;
		log((opts.dryRun ? 'would remove' : 'removed') + ' staged release ' + name + ' (' + Math.round(sbytes / 1048576) + ' MB)');
	}

	return result;
}
