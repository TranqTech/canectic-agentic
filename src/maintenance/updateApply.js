// updateApply.js -- carry out an apply plan against an installation.
//
// The plan is built elsewhere and is pure; this writes it. The split matters
// because the decision about whether a file may be overwritten is the part that
// can destroy somebody's work, and it should be readable and testable without a
// filesystem. What is left here is ordering, backup and error handling.
//
// Three rules govern the writing:
//
//   Back up before touching. Every file this plan would overwrite or remove is
//   copied into the backup directory first, at its own relative path, so a
//   restore is a copy back rather than a reconstruction.
//
//   Write to a temporary name and rename into place. A rename within a
//   filesystem is atomic, so a process reading a file during an update sees the
//   old one or the new one and never a half-written one. Copying in place can
//   leave a truncated module that imports fine and behaves oddly.
//
//   Stop at the first failure. Carrying on is how a half-applied tree happens,
//   and a half-applied tree is worse than a failed update because nothing marks
//   it as broken.
//
// This does NOT stop processes, install dependencies, run migrations, or
// perform the declared upgrade steps. Those are the rest of phase 6.

import * as fs from 'fs';
import * as path from 'path';
import { hashFile } from '../release/manifest.js';
import { filesToWrite, filesToRemove, warningsFor } from '../release/applyPlan.js';
import { MANIFEST_FILENAME } from '../release/manifest.js';

/**
 * Copy one file into place, creating parent directories.
 *
 * `mode` is the manifest's '755' or '644'. Pass null to carry the source file's
 * own mode across, which is what a rollback wants: the backup already has the
 * right bits, and defaulting to 644 there would silently strip the executable
 * bit off every script it restored.
 */
function placeFile(sourceAbs, targetAbs, mode) {
	fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
	var tmp = targetAbs + '.canectic-new';
	fs.copyFileSync(sourceAbs, tmp);
	if (mode === null || mode === undefined) {
		fs.chmodSync(tmp, fs.statSync(sourceAbs).mode & 0o777);
	} else {
		fs.chmodSync(tmp, mode === '755' ? 0o755 : 0o644);
	}
	fs.renameSync(tmp, targetAbs);
}

function backUp(targetRoot, backupDir, relPath) {
	var from = path.join(targetRoot, relPath);
	if (!fs.existsSync(from)) return false;
	var to = path.join(backupDir, relPath);
	fs.mkdirSync(path.dirname(to), { recursive: true });
	fs.copyFileSync(from, to);
	return true;
}

/**
 * Remove empty directories left behind by deletions, deepest first.
 *
 * A release that drops a whole directory should not leave the shell of it in
 * src/, where the next person to look assumes it means something.
 */
function pruneEmptyDirs(root, relPaths) {
	var dirs = new Set();
	for (var p of relPaths) {
		var d = path.dirname(p);
		while (d && d !== '.' && d !== '/') { dirs.add(d); d = path.dirname(d); }
	}
	var ordered = Array.from(dirs).sort(function (a, b) { return b.length - a.length; });
	var removed = [];
	for (var rel of ordered) {
		var abs = path.join(root, rel);
		try {
			if (fs.readdirSync(abs).length === 0) { fs.rmdirSync(abs); removed.push(rel); }
		} catch (_) { /* gone, or not empty */ }
	}
	return removed;
}

/**
 * Apply a plan.
 *
 * @param {object} opts
 * @param {object} opts.plan       from buildApplyPlan
 * @param {string} opts.stagedRoot the verified release tree
 * @param {string} opts.targetRoot the installation
 * @param {string} [opts.backupDir] where displaced files go; required unless dryRun
 * @param {boolean} [opts.dryRun]  report without writing
 * @param {function} [opts.onProgress] (done, total, path)
 * @returns {{applied, written, removed, backedUp, warnings, dirsRemoved, dryRun}}
 */
function applyPlan(opts) {
	var plan = opts.plan;
	var stagedRoot = opts.stagedRoot;
	var targetRoot = opts.targetRoot;
	var dryRun = opts.dryRun === true;
	var progress = opts.onProgress || function () {};

	var writes = filesToWrite(plan);
	var removals = filesToRemove(plan);
	var total = writes.length + removals.length;

	if (!dryRun && !opts.backupDir) {
		throw new Error('refusing to apply without a backup directory');
	}
	if (!dryRun) fs.mkdirSync(opts.backupDir, { recursive: true });

	var written = [];
	var removed = [];
	var backedUp = [];
	var done = 0;

	// Writes first, removals after. A module the new release still wants must
	// be in place before anything it replaced disappears, and doing removals
	// first would widen the window in which the tree is missing files it needs.
	for (var f of writes) {
		var source = path.join(stagedRoot, f.path);
		var target = path.join(targetRoot, f.path);

		if (!dryRun) {
			if (!fs.existsSync(source)) {
				throw new Error('the staged tree is missing ' + f.path + ', which the plan wants to write. ' +
					'Nothing further has been applied.');
			}
			if (backUp(targetRoot, opts.backupDir, f.path)) backedUp.push(f.path);
			placeFile(source, target, f.mode);
		}
		written.push(f.path);
		progress(++done, total, f.path);
	}

	for (var r of removals) {
		if (!dryRun) {
			if (backUp(targetRoot, opts.backupDir, r.path)) backedUp.push(r.path);
			try { fs.unlinkSync(path.join(targetRoot, r.path)); } catch (_) { /* already gone */ }
		}
		removed.push(r.path);
		progress(++done, total, r.path);
	}

	var dirsRemoved = dryRun ? [] : pruneEmptyDirs(targetRoot, removed);

	// The installation's record of what it now is. MANIFEST describes the tree,
	// so it cannot appear in its own file list and no plan will ever write it;
	// it needs this explicit step.
	//
	// It is written LAST, and only once everything else succeeded. A MANIFEST
	// naming a release that did not fully land is worse than no MANIFEST at
	// all, because the next update would trust it: every data file the release
	// legitimately changed would read as edited by the sysop and be reported as
	// a conflict for ever after.
	var manifestWritten = false;
	var stagedManifest = path.join(stagedRoot, MANIFEST_FILENAME);
	if (!dryRun && fs.existsSync(stagedManifest)) {
		// Recorded in backedUp and written like any other file, so a rollback
		// puts the old one back. Treating it as a special case that skips the
		// bookkeeping leaves a rolled-back install claiming to be the release
		// it just backed out of, which is the one lie that would make the NEXT
		// update reason from the wrong hashes.
		if (backUp(targetRoot, opts.backupDir, MANIFEST_FILENAME)) backedUp.push(MANIFEST_FILENAME);
		placeFile(stagedManifest, path.join(targetRoot, MANIFEST_FILENAME), '644');
		written.push(MANIFEST_FILENAME);
		manifestWritten = true;
	}

	if (!dryRun && opts.onProgress) {
		// Deliberately no alogger here. This module runs on the INSTALL path,
		// which happens before npm install has ever run, so anything it imports
		// has to resolve with no node_modules at all. alogger pulls luxon,
		// chalk and dotenv. The callers do the logging.
	}

	return {
		applied: !dryRun,
		dryRun: dryRun,
		version: plan.version,
		written: written,
		removed: removed,
		backedUp: backedUp,
		dirsRemoved: dirsRemoved,
		manifestWritten: manifestWritten,
		warnings: warningsFor(plan)
	};
}

/**
 * Confirm the installation now matches the release, for the files we wrote.
 *
 * Deliberately not a whole-tree verify: a conflict was kept on purpose and a
 * data file the sysop edited is supposed to differ, so checking everything
 * would report the intended outcome as a failure.
 */
function verifyApplied(opts) {
	var mismatched = [];
	var missing = [];
	for (var f of filesToWrite(opts.plan)) {
		var abs = path.join(opts.targetRoot, f.path);
		if (!fs.existsSync(abs)) { missing.push(f.path); continue; }
		if (hashFile(abs) !== f.sha256) mismatched.push(f.path);
	}
	return { ok: missing.length === 0 && mismatched.length === 0, missing: missing, mismatched: mismatched };
}

/**
 * Put back everything a run displaced.
 *
 * Code rollback is nearly free, which is the whole reason the backup is worth
 * taking: a file removed by the plan comes back, a file overwritten comes back,
 * and a file the plan created is deleted because it was not there before.
 */
function rollback(opts) {
	var backupDir = opts.backupDir;
	var targetRoot = opts.targetRoot;
	var result = opts.result;
	var restored = [];
	var deleted = [];

	var hadBackup = new Set(result.backedUp || []);
	for (var rel of hadBackup) {
		var from = path.join(backupDir, rel);
		if (!fs.existsSync(from)) continue;
		placeFile(from, path.join(targetRoot, rel), null);
		restored.push(rel);
	}

	for (var w of (result.written || [])) {
		if (hadBackup.has(w)) continue; // it existed before and has been restored
		try { fs.unlinkSync(path.join(targetRoot, w)); deleted.push(w); } catch (_) {}
	}

	return { restored: restored, deleted: deleted };
}

export {
	placeFile,
	backUp,
	pruneEmptyDirs,
	applyPlan,
	verifyApplied,
	rollback
};
