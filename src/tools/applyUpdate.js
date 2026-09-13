#!/usr/bin/env node
// applyUpdate.js -- the updater, as run FROM THE STAGED TREE.
//
// This file is never invoked by hand. The running Canectic stages a release,
// verifies it, and spawns THIS copy of this file out of the new tree, detached,
// then stops. Everything below therefore runs as the new version, against an
// installation that is still the old one.
//
// That is the point of the split. Applying an upgrade is version specific and
// is where the bugs are, so a release can ship a fixed updater and it takes
// effect for that upgrade rather than the one after.
//
// Its only argument is the path to a run file. The contract between the release
// that launches and the release that applies has to survive both of them
// changing, so it is a JSON document: a newer updater reading an older file
// defaults what is missing, an older updater ignores what it does not know, and
// neither is possible with a positional argument list.
//
//   node <staged>/src/tools/applyUpdate.js --run <target>/logs/update/<id>.run.json
//
// Progress goes to the state file beside it, because the process watching this
// one is being replaced and will not be there to hear an exit code.
//
// WHAT THIS DOES NOT DO YET: stop and start the BBS, install dependencies, run
// the schema and migrations, or perform the release's declared upgrade steps.
// Those phases are recorded as skipped, with the reason, so the run reads as
// incomplete-on-purpose rather than as finished.

import * as fs from 'fs';
import * as path from 'path';

import { parseManifest, verifyTree, MANIFEST_FILENAME } from '../release/manifest.js';
import { buildApplyPlan, warningsFor } from '../release/applyPlan.js';
import {
	beginPhase, finishPhase, skipPhase, failPhase, completeRun, addWarning, summarise
} from '../release/updatePhases.js';
import * as runStore from '../maintenance/updateRunStore.js';
import { describeInstall } from '../maintenance/installTarget.js';
import { applyPlan, verifyApplied } from '../maintenance/updateApply.js';

// The phases this release's updater actually performs. Everything else in the
// sequence is skipped with a reason.
var PERFORMED = ['preflight', 'backup', 'files', 'verify'];

var NOT_IMPLEMENTED = {
	stop:         'this updater does not stop the BBS; stop it yourself before updating',
	dependencies: 'run npm install --omit=dev yourself',
	schema:       'run node src/tools/dbmigrations.js yourself',
	migrations:   'run node src/tools/dbmigrations.js yourself',
	steps:        'apply the upgrade steps in the release metadata yourself',
	start:        'this updater does not start the BBS'
};

function log(msg) {
	// Goes to the log file the launcher opened, which is the only place anyone
	// can read this from once the gateway is gone.
	console.log(new Date().toISOString() + '  ' + msg);
}

function parseArgs(argv) {
	var runFile = null;
	for (var i = 0; i < argv.length; i++) {
		if (argv[i] === '--run') runFile = argv[++i];
	}
	return runFile;
}

async function main() {
	var runFile = parseArgs(process.argv.slice(2));
	if (!runFile) {
		console.error('applyUpdate.js is launched by the update handoff, not by hand. It needs --run <file>.');
		process.exit(2);
	}

	var instructions = runStore.readRunFile(runFile);
	var target = instructions.target;
	var stagedRoot = instructions.stagedRoot;
	var runId = instructions.runId;

	log('updater starting from ' + stagedRoot);
	log('target ' + target + ', ' + (instructions.from || '?') + ' -> ' + (instructions.to || '?'));

	var state = runStore.load(target, runId);
	if (!state) {
		console.error('no run state for ' + runId + '; the launcher should have written one');
		process.exit(2);
	}

	function persist(next) { state = next; runStore.save(target, state); return state; }

	for (var name of Object.keys(NOT_IMPLEMENTED)) {
		persist(skipPhase(state, name, NOT_IMPLEMENTED[name]));
	}

	try {
		// Preflight. The tree was verified in staging before the handoff, but
		// that was the old release's word for it and this is the first thing
		// the new code can check for itself. It is also cheap next to the cost
		// of finding out afterwards.
		persist(beginPhase(state, 'preflight'));
		var manifestFile = path.join(stagedRoot, MANIFEST_FILENAME);
		if (!fs.existsSync(manifestFile)) throw new Error('the staged tree has no ' + MANIFEST_FILENAME);
		var manifest = parseManifest(fs.readFileSync(manifestFile, 'utf8'));
		var staged = verifyTree(stagedRoot, manifest);
		if (!staged.ok) {
			throw new Error('the staged tree no longer matches its manifest: ' +
				staged.missing.length + ' missing, ' + staged.mismatched.length + ' altered');
		}
		if (!fs.existsSync(path.join(target, 'package.json'))) {
			throw new Error('no package.json in ' + target);
		}
		log('preflight: ' + staged.checked + ' staged files verified');
		persist(finishPhase(state, 'preflight', staged.checked + ' files verified'));

		// Plan. Not a phase of its own: it is the decision the files phase
		// carries out, and separating them would let the two disagree.
		var install = describeInstall(target);
		var plan = buildApplyPlan({
			target: manifest, local: install.local, installed: install.installed
		});
		log('plan: ' + JSON.stringify(plan.counts));
		for (var w of warningsFor(plan)) {
			log('keeping your ' + w.path + ' (' + w.reason + ')');
			persist(addWarning(state, 'kept your ' + w.path + ': ' + w.reason));
		}
		if (!install.installed) {
			persist(addWarning(state,
				'this installation had no ' + MANIFEST_FILENAME + ', so every changed data file was kept as yours'));
		}

		// Backup and files are one operation with two names: applyPlan backs
		// each file up immediately before it touches it, which is the only
		// ordering that cannot leave a file overwritten with no copy of it.
		persist(beginPhase(state, 'backup'));
		var backupDir = path.join(path.dirname(runFile), runId + '.backup');
		persist(finishPhase(state, 'backup', backupDir));

		persist(beginPhase(state, 'files'));
		var result = applyPlan({
			plan: plan, stagedRoot: stagedRoot, targetRoot: target, backupDir: backupDir,
			onProgress: function (done, total, p) {
				if (done % 100 === 0 || done === total) log('files: ' + done + '/' + total + '  ' + p);
			}
		});
		log('files: ' + result.written.length + ' written, ' + result.removed.length + ' removed');
		persist(finishPhase(state, 'files',
			result.written.length + ' written, ' + result.removed.length + ' removed, ' +
			result.backedUp.length + ' backed up'));

		persist(beginPhase(state, 'verify'));
		var check = verifyApplied({ plan: plan, targetRoot: target });
		if (!check.ok) {
			throw new Error((check.missing.length + check.mismatched.length) +
				' file(s) do not match the release after writing. The backup is at ' + backupDir);
		}
		persist(finishPhase(state, 'verify', check.missing.length === 0 ? 'all written files match the release' : ''));

		persist(completeRun(state));
		log('complete: ' + JSON.stringify(summarise(state)));
		log('still to do by hand: npm install --omit=dev, node src/tools/dbmigrations.js, ' +
			'the release upgrade steps, then start the BBS');
		process.exit(0);
	} catch (e) {
		var running = state.phases.filter(function (p) { return p.status === 'running'; });
		var where = running.length ? running[0].name : 'preflight';
		persist(failPhase(state, where, e));
		log('FAILED during ' + where + ': ' + e.message);
		process.exit(1);
	}
}

main().catch(function (e) {
	console.error('updater crashed: ' + (e && e.stack ? e.stack : e));
	process.exit(1);
});
