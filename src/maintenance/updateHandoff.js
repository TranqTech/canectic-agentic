// updateHandoff.js -- spawn the new release's updater and get out of the way.
//
// A process cannot replace its own files while running. The gateway serves the
// admin page and the update replaces src/, which is the gateway's own code; the
// worker is no help because it is replaced too. So the running Canectic
// resolves, downloads, verifies and extracts, and then hands over.
//
// The handover is to the STAGED tree's updater, not this one's. Applying an
// upgrade is version specific and is where the bugs are, so doing it with the
// new release's code means a release can ship a fixed updater and it takes
// effect for THAT upgrade rather than the one after. This side's job is small
// and is meant to stay that way.
//
// Two things make this work and both are easy to get wrong:
//
//   DETACHMENT. The child runs in its own session, so stopping the BBS does not
//   kill it. `pm2 stop all` signals the process group, and an updater launched
//   from the gateway without detaching dies with the thing it was updating,
//   halfway through.
//
//   WHERE IT RUNS FROM. The updater must not execute from the tree it is
//   replacing. Same lesson as setup/canectic-pm2.sh needing to live outside
//   setup/, which update.sh wipes.
//
// Staging goes INSIDE the installation, under a dot directory, for a reason
// that is not obvious: node_modules resolves by walking up from the module's
// own directory, and a release artifact ships no node_modules. An updater
// staged in /tmp cannot import anything with a dependency, which includes
// alogger. Staged under the install it walks up and finds the install's.
// The dot directory is not a shipped category, so nothing scans or replaces it.

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { categoryRoots } from '../release/shippedTree.js';
import * as runStore from './updateRunStore.js';
import { makeRunId, newRun } from '../release/updatePhases.js';

// The entry point a release must ship to be handed off to. Relative to the
// staged tree root.
var UPDATER_ENTRY = 'src/tools/applyUpdate.js';

// Where staging lives inside the installation.
var STAGING_DIRNAME = '.canectic-update';

var HANDOFF_VERSION = 1;

function stagingRootFor(target) {
	return path.join(target, STAGING_DIRNAME);
}

function updaterEntry(stagedRoot) {
	return path.join(stagedRoot, UPDATER_ENTRY);
}

/**
 * Is this staged tree inside something the update is going to replace?
 *
 * Being inside the installation is fine and is the point. Being inside one of
 * the directories whose contents get overwritten and pruned is not: the updater
 * would be deleting its own source while running it.
 */
function isInsideReplacedTree(stagedRoot, target) {
	var rel = path.relative(path.resolve(target), path.resolve(stagedRoot));
	if (rel === '' || rel.startsWith('..')) return false;  // outside the install entirely
	var top = rel.split(path.sep)[0];
	return categoryRoots().indexOf(top) !== -1;
}

/**
 * Everything wrong with a proposed handoff, before anything is spawned.
 *
 * @returns {string[]} problems, empty when it is safe
 */
function validateHandoff(opts) {
	var problems = [];
	var stagedRoot = opts.stagedRoot ? path.resolve(opts.stagedRoot) : null;
	var target = opts.target ? path.resolve(opts.target) : null;

	if (!stagedRoot) problems.push('no staged tree');
	if (!target) problems.push('no target installation');
	if (!stagedRoot || !target) return problems;

	if (stagedRoot === target) {
		problems.push('the staged tree and the installation are the same directory, ' +
			'so the updater would be replacing its own source while running it');
	}
	if (isInsideReplacedTree(stagedRoot, target)) {
		problems.push('the staged tree is inside ' + path.relative(target, stagedRoot).split(path.sep)[0] +
			'/, which this update replaces, so the updater would delete itself mid-run');
	}
	if (!fs.existsSync(updaterEntry(stagedRoot))) {
		problems.push('the staged release ships no ' + UPDATER_ENTRY + ', so it cannot apply itself. ' +
			'Use src/tools/update.js --apply against it instead.');
	}
	if (!fs.existsSync(path.join(target, 'package.json'))) {
		problems.push('no package.json in ' + target + ', so there is nothing to update there');
	}

	return problems;
}

/**
 * The command that will be run, worked out without running it.
 *
 * Separated so a test, a dry run and the admin page can all see exactly what
 * would be executed. `process.execPath` rather than a bare `node`: a BBS is
 * expected to run for years across OS upgrades, the interpreter must never be
 * hardcoded, and under nvm the daemon's PATH may not contain the Node the
 * gateway is running on.
 *
 * cwd is the INSTALLATION, not the staged tree. The updater's code comes from
 * staging, but it needs the install's .env and node_modules, and the install
 * root is never deleted.
 */
function handoffPlan(opts) {
	var stagedRoot = path.resolve(opts.stagedRoot);
	var target = path.resolve(opts.target);
	return {
		command: process.execPath,
		args: [updaterEntry(stagedRoot), '--run', opts.runFile],
		cwd: target,
		entry: updaterEntry(stagedRoot),
		detached: true
	};
}

/**
 * Write the instructions, spawn the updater, and return without waiting.
 *
 * The caller is expected to stop shortly afterwards. Nothing here waits on the
 * child, and the returned handle is only enough to find it again: the state
 * file is the real channel, because the process that spawned it will not be
 * around to hear an exit code.
 *
 * @returns {{runId, pid, logFile, stateFile, runFile, plan}}
 */
function launchUpdater(opts) {
	var target = path.resolve(opts.target);
	var stagedRoot = path.resolve(opts.stagedRoot);

	var problems = validateHandoff({ stagedRoot: stagedRoot, target: target });
	if (problems.length) throw new Error('cannot hand off: ' + problems.join('; '));

	var runId = opts.runId || makeRunId();
	runStore.ensureDir(target);

	var logFile = runStore.logPath(target, runId);
	var runFile = runStore.writeRunFile(target, runId, {
		handoff_version: HANDOFF_VERSION,
		runId: runId,
		target: target,
		stagedRoot: stagedRoot,
		from: opts.from || null,
		to: opts.to || null,
		logFile: logFile,
		launchedBy: opts.launchedBy || 'unknown',
		launchedAt: new Date().toISOString(),
		options: opts.options || {}
	});

	// The run starts as soon as the file is written, not when the child gets
	// round to its first phase. A crash before the updater starts would
	// otherwise leave nothing at all to read, which reads as "nothing happened"
	// when in fact an update was attempted.
	runStore.save(target, newRun({
		runId: runId, from: opts.from, to: opts.to, target: target,
		stagedRoot: stagedRoot, logFile: logFile,
		phases: opts.phases
	}));

	var plan = handoffPlan({ stagedRoot: stagedRoot, target: target, runFile: runFile });

	var out = fs.openSync(logFile, 'a');
	var child = spawn(plan.command, plan.args, {
		cwd: plan.cwd,
		detached: true,
		stdio: ['ignore', out, out],
		env: Object.assign({}, process.env, { CANECTIC_UPDATE_RUN: runId })
	});
	child.unref();
	try { fs.closeSync(out); } catch (_) {}

	var state = runStore.load(target, runId);
	if (state) { state.pid = child.pid; runStore.save(target, state); }

	return {
		runId: runId,
		pid: child.pid,
		logFile: logFile,
		stateFile: runStore.statePath(target, runId),
		runFile: runFile,
		plan: plan
	};
}

export {
	UPDATER_ENTRY,
	STAGING_DIRNAME,
	HANDOFF_VERSION,
	stagingRootFor,
	updaterEntry,
	isInsideReplacedTree,
	validateHandoff,
	handoffPlan,
	launchUpdater
};
