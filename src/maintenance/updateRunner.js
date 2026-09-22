// updateRunner.js -- the phase sequence, in one place.
//
// Both ways of applying a release come through here: `update.js --apply` runs it
// in process, and `applyUpdate.js` runs it detached from the staged tree after a
// handoff. One implementation on purpose. Two programs that both claim to apply
// an update is precisely the shape that let setup/install.sh and
// setup/update.sh drift until one of them deleted every sysop-added asset under
// public/.
//
// The order is the design's, with two placements worth stating:
//
//   The FILE backup runs before the processes are stopped. Shipped files do not
//   change while the BBS runs, so there is no reason to pay downtime for it.
//
//   The DATABASE dump runs at the top of the schema phase, immediately before
//   migrations, which is after the stop. It exists to protect the migration, so
//   taking it any earlier would leave a window of writes it does not contain,
//   and taking it before the stop would make that window as long as the dump.
//
// Rollback has a hard line through the middle of the sequence. Up to and
// including `dependencies`, putting the files back is correct and the backup is
// enough. From `schema` onwards it is not: old code over a migrated database is
// a worse state than the failure, so the run stops, says so, and leaves the
// decision to a person.

import * as fs from 'fs';
import * as path from 'path';
// psql is spawned directly for the database size, which is one quick query
// before the stop, so blocking is harmless there. pg_dump goes through
// spawnAsync because it can take minutes while the progress page is being
// served. This import's absence was once invisible until the schema phase ran
// on a live board.
import { spawnSync } from 'child_process';

import appConfig from '../config/appConfig.js';
import { parseManifest, verifyTree, MANIFEST_FILENAME } from '../release/manifest.js';
import { buildApplyPlan, warningsFor } from '../release/applyPlan.js';
import {
	beginPhase, finishPhase, skipPhase, failPhase, completeRun, addWarning
} from '../release/updatePhases.js';
import { compareDotted } from '../release/updateVerdict.js';
import { resolveRestartCommand } from '../queues/workerHealth.js';
import * as runStore from './updateRunStore.js';
import { describeInstall } from './installTarget.js';
import { applyPlan, verifyApplied, rollback } from './updateApply.js';
import { backupDir, freeBytes } from './updateLayout.js';
import { pruneBaseCache } from './baseCache.js';
import { runCommandAsync, spawnAsync, nodeCommand, createRuntimeDirs, COMMAND_TIMEOUT_MS } from './updateCommands.js';
import * as maintFlags from './maintenanceFlag.js';
import { startUpdateStatusServer } from './updateStatusServer.js';
import { readSysopHashes, clearSysopHashes } from './sysopSessions.js';
import { forgiveNormalisedLockfile } from '../release/lockfile.js';
import { verifyTreeSignature, PUBLIC_KEY_FILENAME } from '../release/signing.js';

// Recent log lines kept for the progress page the updater serves while the BBS
// is stopped. The full log goes wherever `log` sends it.
var PROGRESS_LOG_LINES = 300;

// A failure in one of these changed nothing: no process was stopped and no
// file was written. Only then does the updater reopen the board itself. Any
// later failure leaves it closed, because a failed update is exactly when a
// person should decide whether the board is fit to open. `stop` is not in the
// list: a stop command that fails can leave the board half stopped.
var REOPEN_ON_FAILURE = ['preflight', 'backup'];

// Everything up to and including this phase can be undone by putting the files
// back. After it, a migrated database makes that the wrong thing to do.
var LAST_ROLLBACKABLE_PHASE = 'dependencies';
var ROLLBACK_SAFE = ['preflight', 'backup', 'stop', 'files', 'dependencies'];

/** The pg_dump environment, from the installation's own .env keys. */
function dumpEnv() {
	return Object.assign({}, process.env, {
		PGHOST:     process.env.dbhost || 'localhost',
		PGPORT:     String(process.env.dbport || 5432),
		PGUSER:     process.env.dbuser || 'canectic',
		PGDATABASE: process.env.dbname || 'canectic_bbs',
		PGPASSWORD: process.env.dbpass || ''
	});
}

/**
 * Take a database dump, unless asked not to.
 *
 * Custom format, compressed, because that is what pg_restore wants and a plain
 * SQL dump of a real message base is enormous. Refuses up front when the
 * filesystem has less free space than the database is likely to need, rather
 * than failing part way through and leaving a truncated file that looks like a
 * backup.
 */
async function takeDump(target, runId, log) {
	var dir = backupDir(target, runId);
	fs.mkdirSync(dir, { recursive: true });
	var file = path.join(dir, 'database.dump');

	var free = freeBytes(dir);
	var size = databaseSize(log);
	if (free !== null && size !== null && free < size * 1.2) {
		throw new Error('not enough free space for a database dump: ' +
			Math.round(size / 1048576) + ' MB of data and ' + Math.round(free / 1048576) +
			' MB free. Free some space, or pass --no-dump if you have a backup already.');
	}

	var env = dumpEnv();
	log('$ pg_dump -Fc -f ' + file);
	// Not spawnSync: a large board's dump takes minutes, and the progress page
	// is served from this process's event loop.
	await spawnAsync('pg_dump', ['-Fc', '--no-password', '-f', file], {
		cwd: target, env: env, timeoutMs: COMMAND_TIMEOUT_MS, log: log, label: 'pg_dump'
	});
	var bytes = fs.statSync(file).size;
	log('dump: ' + Math.round(bytes / 1048576) + ' MB at ' + file);
	return { file: file, bytes: bytes };
}

/** Roughly how big the database is, for the disk check. Null when unaskable. */
function databaseSize(log) {
	var env = dumpEnv();
	var res = spawnSync('psql', ['-tAc', 'SELECT pg_database_size(current_database())'], {
		env: env, encoding: 'utf8', timeout: 60000
	});
	if (res.status !== 0 || !res.stdout) {
		log('could not measure the database; the free space check is skipped');
		return null;
	}
	var n = parseInt(String(res.stdout).trim(), 10);
	return isNaN(n) ? null : n;
}

/**
 * Apply a release.
 *
 * @param {object} opts
 * @param {object} opts.instructions  the run file contents
 * @param {function} [opts.log]
 * @param {function} [opts.exec]      runs a shell command; the real one by default
 * @param {function} [opts.dump]      takes the database dump; the real one by default
 * @returns {object} the final run state
 *
 * `exec` and `dump` are seams, not configuration. The phases and the order they
 * fail in are the thing worth testing, and the commands are the environment:
 * without a way to make npm fail on demand there is no way to assert that a
 * failure at `dependencies` rolls the files back while one at `steps` does not,
 * and that rule is the whole reason the sequence has a middle.
 */
async function runUpdate(opts) {
	var ins = opts.instructions;
	var target = ins.target;
	var stagedRoot = ins.stagedRoot;
	var runId = ins.runId;
	var options = ins.options || {};
	var logOut = opts.log || function () {};
	var recentLog = [];
	function log(msg) {
		recentLog.push(new Date().toISOString().substring(11, 19) + '  ' + msg);
		if (recentLog.length > PROGRESS_LOG_LINES) recentLog.shift();
		logOut(msg);
	}
	// Commands run without blocking (runCommandAsync), so the progress page
	// keeps answering through npm install and the migration. A seam returning
	// synchronously still works: every call is awaited.
	var exec = opts.exec || runCommandAsync;
	var dump = opts.dump || takeDump;
	var waitDrain = opts.waitForDrain || maintFlags.waitForDrain;
	var startStatusServer = opts.startStatusServer || startUpdateStatusServer;
	var verifySignature = opts.verifySignature || verifyTreeSignature;
	var requireSignature = opts.requireSignature !== undefined
		? !!opts.requireSignature
		: appConfig.getBoolean('update_require_signature', false);
	var statusServer = null;

	// Everything the progress page needs from config, read now: once the
	// dependencies phase starts, nothing may be loaded that was not already.
	var progressPage = {
		enabled:   appConfig.getBoolean('update_progress_page', true),
		// The gateway reads webport from the environment only (bin/gateway.js), so
		// the same order here, or a webport saved in the settings table, which
		// the gateway ignores, would send the listener to a port nobody uses.
		port:      parseInt(process.env.webport || appConfig.get('webport', 8080), 10) || 8080,
		boardName: appConfig.get('boardname', 'Canectic BBS')
	};

	var state = runStore.load(target, runId);
	if (!state) throw new Error('no run state for ' + runId);
	function persist(next) { state = next; runStore.save(target, state); return state; }

	var backup = backupDir(target, runId);
	var plan = null;
	var applied = null;
	var processesStopped = false;

	function phaseNow() {
		var running = state.phases.filter(function (p) { return p.status === 'running'; });
		return running.length ? running[0].name : null;
	}

	// ---- maintenance mode -------------------------------------------
	// Close the board for the whole run, as early as possible, so the grace
	// runs alongside the backup rather than after it. A closure the sysop set
	// before starting the update is remembered and put back afterwards: the
	// updater reopening a board somebody closed on purpose would be wrong.
	var priorClosure = maintFlags.readFlag(target);
	var closedForUpdate = false;
	try {
		maintFlags.enterMaintenance(target, {
			reason:        'Updating to ' + (ins.to || 'a new release'),
			grace_seconds: priorClosure ? priorClosure.grace_seconds : null,
			set_by:        'updater',
			source:        'update',
			run_id:        runId
		});
		closedForUpdate = true;
		log('maintenance: board closed for the update' + (priorClosure ? ' (it was already closed; that closure is restored afterwards)' : ''));
	} catch (me) {
		persist(addWarning(state, 'could not close the board for maintenance: ' + me.message +
			'. The update carries on, but callers were not warned.'));
	}

	function reopenBoard(why) {
		if (!closedForUpdate) return;
		try {
			if (priorClosure) {
				maintFlags.enterMaintenance(target, priorClosure);
				log('maintenance: ' + why + '; the closure set before the update is back in place');
			} else {
				maintFlags.leaveMaintenance(target);
				log('maintenance: ' + why + '; board reopened');
			}
		} catch (re) {
			persist(addWarning(state, 'could not reopen the board: ' + re.message +
				'. Clear it from the Maintenance page or with node src/tools/maintenanceMode.js --off'));
		}
	}

	try {
		// ---- preflight -------------------------------------------------
		persist(beginPhase(state, 'preflight'));
		var manifestFile = path.join(stagedRoot, MANIFEST_FILENAME);
		if (!fs.existsSync(manifestFile)) throw new Error('the staged tree has no ' + MANIFEST_FILENAME);
		var manifest = parseManifest(fs.readFileSync(manifestFile, 'utf8'));
		var staged = verifyTree(stagedRoot, manifest);
		if (!staged.ok) {
			throw new Error('the staged tree no longer matches its manifest: ' +
				staged.missing.length + ' missing, ' + staged.mismatched.length + ' altered');
		}
		if (!fs.existsSync(path.join(target, 'package.json'))) throw new Error('no package.json in ' + target);

		if (ins.nodeMin && compareDotted(process.versions.node, ins.nodeMin) < 0) {
			throw new Error('this release needs Node ' + ins.nodeMin + ' and this is ' + process.versions.node);
		}

		// The signature over MANIFEST, checked against the key the INSTALLED
		// board trusts (signing.js). Checked here, in the new release's own
		// updater, so it holds however the update was launched. A signature
		// that fails is refused whatever the setting: that is somebody telling
		// you something is wrong. A missing one is refused only when the sysop
		// asked for signed releases.
		var sig = verifySignature({
			treeRoot:    stagedRoot,
			keyMaterial: path.join(stagedRoot, 'setup', PUBLIC_KEY_FILENAME),
			pinFrom:     path.join(target, 'setup', PUBLIC_KEY_FILENAME)
		});
		log('preflight: signature ' + sig.state + ': ' + sig.detail);
		if (sig.state === 'bad') {
			throw new Error('the release signature does not check out: ' + sig.detail);
		}
		if (requireSignature && sig.state !== 'verified') {
			throw new Error('update_require_signature is on, and this release is ' + sig.state + ': ' + sig.detail +
				(sig.state === 'unsigned' ? '. Development builds are never signed.' : ''));
		}
		log('preflight: ' + staged.checked + ' staged files verified, Node ' + process.versions.node);
		persist(finishPhase(state, 'preflight', staged.checked + ' files verified'));

		// The plan is the decision the files phase carries out. Not a phase of
		// its own, so the two cannot disagree.
		var install = describeInstall(target);
		plan = buildApplyPlan({ target: manifest, local: install.local, installed: install.installed });
		log('plan: ' + JSON.stringify(plan.counts));
		for (var w of warningsFor(plan)) {
			log('keeping your ' + w.path + ' (' + w.reason + ')');
			persist(addWarning(state, 'kept your ' + w.path + ': ' + w.reason));
		}
		if (!install.installed) {
			persist(addWarning(state, 'this installation had no ' + MANIFEST_FILENAME +
				', so every changed data file was kept as yours'));
		}

		// ---- backup ----------------------------------------------------
		// Files only, and before the stop: shipped files do not change while
		// the BBS is running, so there is no reason to pay downtime for this.
		persist(beginPhase(state, 'backup'));
		fs.mkdirSync(backup, { recursive: true });
		persist(finishPhase(state, 'backup', backup));

		// ---- stop ------------------------------------------------------
		if (options.processControl === false || !appConfig.getBoolean('update_process_control', true)) {
			persist(skipPhase(state, 'stop', 'process control is off; stop the BBS yourself'));
		} else {
			persist(beginPhase(state, 'stop'));
			var drainNote = closedForUpdate ? await drainBeforeStop() : 'board was not closed';
			await exec(resolvedCommand('update_stop_command', 'pm2 stop all'), target, log);
			processesStopped = true;
			persist(finishPhase(state, 'stop', 'processes stopped (' + drainNote + ')'));
			await takeOverWebPort();
		}

		// ---- files -----------------------------------------------------
		persist(beginPhase(state, 'files'));
		applied = applyPlan({
			plan: plan, stagedRoot: stagedRoot, targetRoot: target, backupDir: backup,
			onProgress: function (done, total, p) {
				if (done % 100 === 0 || done === total) log('files: ' + done + '/' + total + '  ' + p);
			}
		});
		log('files: ' + applied.written.length + ' written, ' + applied.removed.length + ' removed');
		persist(finishPhase(state, 'files', applied.written.length + ' written, ' +
			applied.removed.length + ' removed, ' + applied.backedUp.length + ' backed up'));

		// ---- directories -----------------------------------------------
		// Run on updates too, not only installs. A release that starts writing
		// to a directory the previous one did not have works perfectly on a
		// fresh install and fails on every upgraded one, at the moment the
		// feature is first used rather than at update time.
		persist(beginPhase(state, 'directories'));
		var made = createRuntimeDirs(target);
		if (made.length) log('directories: created ' + made.join(', '));
		persist(finishPhase(state, 'directories', made.length
			? made.length + ' new director' + (made.length === 1 ? 'y' : 'ies')
			: 'all present'));

		persist(skipPhase(state, 'env', 'an existing installation keeps its own .env'));

		// ---- dependencies ----------------------------------------------
		if (options.dependencies === false) {
			persist(skipPhase(state, 'dependencies', 'skipped by request; run npm install --omit=dev yourself'));
		} else {
			persist(beginPhase(state, 'dependencies'));
			await exec('npm install --omit=dev', target, log);
			persist(finishPhase(state, 'dependencies', 'npm install --omit=dev'));
		}

		// ---- schema (and the dump that protects it) --------------------
		if (options.schema === false) {
			persist(skipPhase(state, 'schema', 'skipped by request; run node src/tools/dbmigrations.js yourself'));
			persist(skipPhase(state, 'migrations', 'skipped with the schema phase'));
		} else {
			persist(beginPhase(state, 'schema'));
			if (options.dump === false) {
				persist(addWarning(state, 'no database dump was taken before migrating'));
				log('no dump taken (--no-dump)');
			} else {
				var taken = await dump(target, runId, log);
				persist(addWarning(state, 'database dumped to ' + taken.file +
					' (' + Math.round(taken.bytes / 1048576) + ' MB)'));
			}
			await exec(nodeCommand('src/tools/dbmigrations.js'), target, log);
			persist(finishPhase(state, 'schema', 'declarative schema and migration ledger applied'));
			// One dbmigrations run does both. Recording migrations as skipped
			// with that reason is honest; marking it done would imply a second
			// thing happened.
			persist(skipPhase(state, 'migrations', 'applied by the same dbmigrations run as the schema phase'));
		}

		// ---- steps -----------------------------------------------------
		var steps = (ins.steps || []);
		var automatic = steps.filter(function (st) { return st.automatic === true; });
		var manual = steps.filter(function (st) { return st.automatic !== true; });
		if (!automatic.length) {
			persist(skipPhase(state, 'steps', steps.length
				? 'this release declares no automatic steps'
				: 'this release declares no steps'));
		} else {
			persist(beginPhase(state, 'steps'));
			for (var st of automatic) {
				log('step ' + st.id + ': ' + st.description);
				await exec(st.command, target, log);
			}
			persist(finishPhase(state, 'steps', automatic.length + ' automatic step(s)'));
		}
		for (var m of manual) {
			persist(addWarning(state, 'step "' + m.id + '" is yours to run: ' + m.description +
				(m.command ? '  ->  ' + m.command : '') +
				(m.applies_when ? '  (when: ' + m.applies_when + ')' : '')));
		}

		// ---- start -----------------------------------------------------
		if (options.processControl === false || !appConfig.getBoolean('update_process_control', true)) {
			persist(skipPhase(state, 'start', 'process control is off; start the BBS yourself'));
		} else {
			persist(beginPhase(state, 'start'));
			// Give the port back first, or the gateway cannot take it.
			await releaseWebPort();
			await exec(resolvedCommand('update_start_command', 'pm2 start ecosystem.config.cjs'), target, log);
			processesStopped = false;
			persist(finishPhase(state, 'start', 'processes started'));
		}

		// ---- verify ----------------------------------------------------
		persist(beginPhase(state, 'verify'));
		// npm install rewrites package-lock.json (lockfile.js); compare it by
		// what it pins rather than byte for byte, or every update fails here
		// after everything has worked.
		var lockCheck = forgiveNormalisedLockfile(verifyApplied({ plan: plan, targetRoot: target }),
			{ targetRoot: target, sourceRoot: stagedRoot });
		if (lockCheck.note) log('verify: ' + lockCheck.note);
		var check = lockCheck.result;
		if (!check.ok) {
			var bad = check.missing.concat(check.mismatched);
			throw new Error(bad.length + ' file(s) do not match the release after writing: ' +
				bad.slice(0, 5).join(', ') + (bad.length > 5 ? ' and ' + (bad.length - 5) + ' more' : ''));
		}
		persist(finishPhase(state, 'verify', 'all written files match the release'));

		// Housekeeping, outside the phases because failing it must not fail an
		// update that otherwise worked.
		try {
			var discarded = pruneBaseCache(target,
				appConfig.getNumber('update_base_cache_keep', 2),
				[ins.from, ins.to, ins.base].filter(Boolean));
			if (discarded.length) log('base cache: discarded ' + discarded.join(', '));
		} catch (e) {
			log('base cache prune failed, which changes nothing: ' + e.message);
		}

		// Last, once verify has passed: the processes came back up closed, and
		// only now is there reason to believe the board is fit to open.
		reopenBoard('update complete');
		clearSysopHashes(target);

		persist(completeRun(state));
		log('complete');
		return state;
	} catch (e) {
		var where = phaseNow() || 'preflight';
		log('FAILED during ' + where + ': ' + e.message);

		// The rollback line. Before the schema phase the files are the only
		// thing that changed, so putting them back is correct and complete.
		// After it the database has moved and old code over a migrated database
		// is a worse state than the failure.
		if (applied && ROLLBACK_SAFE.indexOf(where) !== -1) {
			try {
				var undone = rollback({ backupDir: backup, targetRoot: target, result: applied });
				log('rolled back: ' + undone.restored.length + ' restored, ' + undone.deleted.length + ' removed');
				persist(addWarning(state, 'files were rolled back to ' + (ins.from || 'the previous release')));
			} catch (re) {
				log('rollback itself failed: ' + re.message);
				persist(addWarning(state, 'ROLLBACK FAILED: ' + re.message + '. The backup is at ' + backup));
			}
		} else if (applied) {
			persist(addWarning(state, 'files were NOT rolled back: the database has already been migrated, ' +
				'and putting the old code back over it would be worse. The backup is at ' + backup));
		}

		// A board left down by a failure partway through is its own problem.
		if (processesStopped) {
			try {
				await releaseWebPort();
				await exec(resolvedCommand('update_start_command', 'pm2 start ecosystem.config.cjs'), target, log);
				persist(addWarning(state, 'the BBS was started again after the failure'));
			} catch (se) {
				persist(addWarning(state, 'the BBS is still stopped: ' + se.message));
			}
		}

		if (REOPEN_ON_FAILURE.indexOf(where) !== -1 && !processesStopped && !applied) {
			reopenBoard('the update failed before changing anything');
		} else if (closedForUpdate) {
			persist(addWarning(state, 'the board is left closed for maintenance. Reopen it from the Maintenance ' +
				'page, or with node src/tools/maintenanceMode.js --off, once you are satisfied it is fit to open'));
		}

		persist(failPhase(state, where, e));
		return state;
	} finally {
		// Whatever happened, the port is not ours to keep.
		await releaseWebPort();
	}

	/**
	 * With the BBS stopped, answer on its web port: the progress for a sysop,
	 * the maintenance page for everybody else. Never fails the update.
	 */
	async function takeOverWebPort() {
		if (!progressPage.enabled) return;
		var sysops = readSysopHashes(target, runId);
		if (!sysops.size) {
			log('progress page: no sysop sessions were recorded for this run (it was not started from the web, ' +
				'or nobody was logged in), so every visitor gets the maintenance page');
		}
		try {
			statusServer = await startStatusServer({
				port:        progressPage.port,
				root:        target,
				sysopHashes: sysops,
				getState:    function () { return state; },
				getLog:      function () { return recentLog.slice(-40); },
				info:        { boardName: progressPage.boardName, reason: 'Updating to ' + (ins.to || 'a new release') },
				log:         log
			});
		} catch (se) {
			log('progress page: ' + se.message + '; the update carries on without it');
			statusServer = null;
		}
		if (!statusServer) persist(addWarning(state, 'the progress page could not be served while the BBS was stopped'));
	}

	async function releaseWebPort() {
		if (!statusServer) return;
		var s = statusServer;
		statusServer = null;
		try {
			await s.close();
			log('progress page: port handed back');
		} catch (ce) {
			log('progress page: closing failed: ' + ce.message);
		}
	}

	/**
	 * Wait for the board to drain before stopping it: callers disconnected at
	 * the end of the grace, binkp sessions and queue jobs finished. Returns a
	 * note for the stop phase. Never throws; a drain that does not finish is a
	 * warning, and the stop ends whatever is left, which BullMQ retries.
	 */
	async function drainBeforeStop() {
		var flag = maintFlags.readFlag(target);
		var graceDefault = appConfig.getNumber('maintenance_grace_seconds', 300);
		var deadline = flag ? maintFlags.deadlineOf(flag, graceDefault).getTime() : Date.now();
		var timeoutMs = Math.max(0, deadline - Date.now()) + appConfig.getNumber('update_drain_timeout', 900) * 1000;
		log('stop: waiting for the board to drain (up to ' + Math.round(timeoutMs / 1000) + 's)');

		var lastLine = '';
		var res = await waitDrain(target, {
			timeoutMs: timeoutMs,
			onProgress: function (a) {
				var line = a.processes
					.filter(function (p) { return p.state === 'draining'; })
					.map(function (p) { return p.process + ': ' + maintFlags.describePending(p.pending); })
					.join('; ');
				if (line && line !== lastLine) log('stop: waiting on ' + line);
				lastLine = line;
			}
		});

		switch (res.verdict) {
			case 'drained':
				log('stop: drained, nothing in flight');
				return 'drained cleanly';
			case 'nobody':
				// The first update into a release with maintenance mode lands here:
				// the running processes predate it and never report.
				log('stop: no process reported a drain status; the running release predates maintenance mode, or nothing is running');
				return 'running release could not report a drain';
			case 'open':
				persist(addWarning(state, 'the board was reopened while the update was waiting to stop it; it was closed again'));
				try {
					maintFlags.enterMaintenance(target, { reason: 'Updating to ' + (ins.to || 'a new release'),
						set_by: 'updater', source: 'update', run_id: runId });
				} catch (_) {}
				return 'board was reopened during the wait';
			default: {
				var left = res.assessment ? res.assessment.processes
					.filter(function (p) { return p.state === 'draining'; })
					.map(function (p) { return p.process + ': ' + maintFlags.describePending(p.pending); }).join('; ') : '';
				persist(addWarning(state, 'stopped with work still in flight after waiting ' +
					Math.round(timeoutMs / 1000) + 's' + (left ? ' (' + left + ')' : '') +
					'; queue jobs are retried when the board starts again'));
				return 'drain timed out';
			}
		}
	}
}

/** A configured command, with a bare pm2 resolved next to the running Node. */
function resolvedCommand(key, fallback) {
	var configured = appConfig.get(key, fallback) || fallback;
	return resolveRestartCommand(configured, process.execPath, fs.existsSync, path);
}

export {
	LAST_ROLLBACKABLE_PHASE,
	ROLLBACK_SAFE,
	REOPEN_ON_FAILURE,
	dumpEnv,
	databaseSize,
	takeDump,
	resolvedCommand,
	runUpdate
};
