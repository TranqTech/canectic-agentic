// installer.js -- putting a release on a machine that has nothing.
//
// Install is update from nothing, which is principle 1 and is meant literally
// here. The file placement is `buildApplyPlan` against an empty installation,
// so every file comes out as `create` and the categories that protect a sysop's
// work on an update simply have nothing to protect. The progress record, the
// phase vocabulary and the backup mechanics are the update's.
//
// What genuinely differs is scaffolding: the directories no release ships, and
// a .env that does not exist yet. Those are the two phases an update skips.
//
// The environment steps stop where automating them stops being honest. The
// database and its user need `sudo -u postgres`, which fails on hosts where
// that is restricted and on managed Postgres entirely, so this runs the script
// that already handles that case properly when asked and prints the command
// when not. Everything after the credentials exist is automated.

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

import { buildApplyPlan } from '../release/applyPlan.js';
import { parseManifest, verifyTree, MANIFEST_FILENAME } from '../release/manifest.js';
import {
	beginPhase, finishPhase, skipPhase, failPhase, completeRun, addWarning
} from '../release/updatePhases.js';
import { compareDotted } from '../release/updateVerdict.js';
import * as runStore from './updateRunStore.js';
import { describeInstall, installedVersion } from './installTarget.js';
import { applyPlan } from './updateApply.js';
import { backupDir } from './updateLayout.js';
import { runCommand, nodeCommand, createRuntimeDirs } from './updateCommands.js';

var ENV_TEMPLATE = 'examples/env.example';

/**
 * Is the database this install needs actually there?
 *
 * Asked with `pg_isready`, which ships with the PostgreSQL client tools and is
 * the right question. Its ABSENCE is not a failure: a board using a managed or
 * remote database has no local client and is perfectly fine, so that reports
 * and carries on. A `pg_isready` that is present and says no is a refusal,
 * because the schema phase is going to fail and it is better to fail now.
 *
 * @returns {Array<{blocking:boolean, detail:string}>}
 */
function prerequisiteProblems(env) {
	var out = [];
	var args = ['-q'];
	if (env.dbhost) args.push('-h', env.dbhost);
	if (env.dbport) args.push('-p', String(env.dbport));

	var res = spawnSync('pg_isready', args, { timeout: 15000, encoding: 'utf8' });
	if (res.error && res.error.code === 'ENOENT') {
		out.push({ blocking: false, detail: 'pg_isready is not installed, so PostgreSQL could not be checked ' +
			'before starting. If the schema phase fails, that is why.' });
	} else if (res.error) {
		out.push({ blocking: false, detail: 'could not check PostgreSQL: ' + res.error.message });
	} else if (res.status !== 0) {
		out.push({ blocking: true, detail: 'PostgreSQL is not accepting connections' +
			(env.dbhost ? ' at ' + env.dbhost : ' on this machine') +
			'. Install and start it before installing Canectic, or the schema step will fail ' +
			'after every file has already been written. Nothing has been written yet.' });
	}
	return out;
}

/**
 * Write .env from the shipped template, filling in what we were told.
 *
 * Never overwrites. An install that found a .env is an install into a directory
 * somebody has already set up, and their credentials are worth more than our
 * template.
 *
 * @returns {{written:boolean, path:string, keys:string[]}}
 */
function writeEnv(target, values) {
	var dest = path.join(target, '.env');
	if (fs.existsSync(dest)) return { written: false, path: dest, keys: [] };

	var template = path.join(target, ENV_TEMPLATE);
	if (!fs.existsSync(template)) throw new Error('the release ships no ' + ENV_TEMPLATE + ' to write .env from');

	var lines = fs.readFileSync(template, 'utf8').split('\n');
	var given = values || {};
	var set = [];

	var out = lines.map(function (line) {
		var m = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
		if (!m) return line;
		var key = m[2];
		if (!Object.prototype.hasOwnProperty.call(given, key)) return line;
		if (given[key] === null || given[key] === undefined) return line;
		set.push(key);
		return m[1] + key + '=' + given[key];
	});

	// A key the template does not carry still has to reach the file, or asking
	// for it was pointless.
	for (var key of Object.keys(given)) {
		if (set.indexOf(key) !== -1) continue;
		if (given[key] === null || given[key] === undefined) continue;
		out.push(key + '=' + given[key]);
		set.push(key);
	}

	fs.writeFileSync(dest, out.join('\n'));
	fs.chmodSync(dest, 0o600);   // it holds the database password
	return { written: true, path: dest, keys: set };
}

/**
 * Install a staged release into a target.
 *
 * @param {object} opts
 * @param {object} opts.instructions  runId, target, stagedRoot, env, options
 * @param {function} [opts.log]
 * @param {function} [opts.exec]      seam, as in updateRunner
 * @returns {object} the final run state
 */
async function runInstall(opts) {
	var ins = opts.instructions;
	var target = ins.target;
	var stagedRoot = ins.stagedRoot;
	var runId = ins.runId;
	var options = ins.options || {};
	var log = opts.log || function () {};
	var exec = opts.exec || runCommand;

	var state = runStore.load(target, runId);
	if (!state) throw new Error('no run state for ' + runId);
	function persist(next) { state = next; runStore.save(target, state); return state; }

	function phaseNow() {
		var running = state.phases.filter(function (p) { return p.status === 'running'; });
		return running.length ? running[0].name : null;
	}

	try {
		persist(beginPhase(state, 'preflight'));
		var manifestFile = path.join(stagedRoot, MANIFEST_FILENAME);
		if (!fs.existsSync(manifestFile)) throw new Error('the staged tree has no ' + MANIFEST_FILENAME);
		var manifest = parseManifest(fs.readFileSync(manifestFile, 'utf8'));
		var staged = verifyTree(stagedRoot, manifest);
		if (!staged.ok) throw new Error('the staged tree does not match its manifest');
		if (ins.nodeMin && compareDotted(process.versions.node, ins.nodeMin) < 0) {
			throw new Error('this release needs Node ' + ins.nodeMin + ' and this is ' + process.versions.node);
		}

		// Installing over something is not installing. An existing install has
		// a sysop's data in it and the right tool for it is the updater, which
		// knows which of their files to leave alone.
		var existing = installedVersion(target);
		if (existing && !options.force) {
			throw new Error(target + ' already holds Canectic ' + existing +
				'. Use the updater rather than the installer, which would treat every file as new.');
		}
		// Prerequisites, BEFORE a single file is written. Without this the
		// install lays down the whole tree, writes .env, runs npm install and
		// then fails at the schema phase on a box with no PostgreSQL, which is
		// the worst place to stop: everything is on disk and nothing works.
		if (options.database !== false) {
			var missing = prerequisiteProblems(ins.env || {});
			for (var problem of missing) {
				if (problem.blocking) throw new Error(problem.detail);
				log('preflight: ' + problem.detail);
				persist(addWarning(state, problem.detail));
			}
		}

		log('preflight: ' + staged.checked + ' staged files verified, Node ' + process.versions.node);
		persist(finishPhase(state, 'preflight', staged.checked + ' files verified'));

		persist(skipPhase(state, 'backup', 'a fresh install has nothing to preserve'));
		persist(skipPhase(state, 'stop', 'nothing is running yet'));

		// ---- files: the update's own planner, against nothing -----------
		persist(beginPhase(state, 'files'));
		var install = describeInstall(target);
		var plan = buildApplyPlan({ target: manifest, local: install.local, installed: null });
		var result = applyPlan({
			plan: plan, stagedRoot: stagedRoot, targetRoot: target,
			backupDir: backupDir(target, runId),
			onProgress: function (done, total, p) {
				if (done % 200 === 0 || done === total) log('files: ' + done + '/' + total + '  ' + p);
			}
		});
		log('files: ' + result.written.length + ' written');
		persist(finishPhase(state, 'files', result.written.length + ' written'));

		// ---- directories ------------------------------------------------
		persist(beginPhase(state, 'directories'));
		var made = createRuntimeDirs(target);
		log('directories: ' + made.length + ' created');
		persist(finishPhase(state, 'directories', made.length + ' created'));

		// ---- env ---------------------------------------------------------
		persist(beginPhase(state, 'env'));
		var env = writeEnv(target, ins.env || {});
		if (env.written) {
			log('env: wrote .env with ' + env.keys.length + ' value(s) filled in');
			persist(finishPhase(state, 'env', 'wrote .env (' + env.keys.join(', ') + ')'));
		} else {
			persist(addWarning(state, 'a .env was already here and was left alone'));
			persist(finishPhase(state, 'env', 'kept the .env that was already here'));
		}

		// ---- dependencies -------------------------------------------------
		if (options.dependencies === false) {
			persist(skipPhase(state, 'dependencies', 'run npm install yourself'));
		} else {
			persist(beginPhase(state, 'dependencies'));
			exec('npm install --omit=dev', target, log);
			persist(finishPhase(state, 'dependencies', 'npm install --omit=dev'));
		}

		// ---- database ------------------------------------------------------
		// Creating the role and the database needs `sudo -u postgres`, which is
		// restricted on plenty of hosts and absent on managed Postgres. The
		// script that already handles that properly is run when asked for; when
		// not, the command is printed rather than half attempted.
		if (options.database === false) {
			persist(skipPhase(state, 'schema', 'the database was not created; run setup/create_pg_db_user.sh ' +
				'then node src/tools/dbmigrations.js'));
			persist(skipPhase(state, 'migrations', 'skipped with the schema phase'));
		} else {
			persist(beginPhase(state, 'schema'));
			if (options.createDatabase) {
				exec('bash setup/create_pg_db_user.sh', target, log);
			}
			exec(nodeCommand('src/tools/dbmigrations.js'), target, log);
			persist(finishPhase(state, 'schema', 'schema created and defaults seeded'));
			persist(skipPhase(state, 'migrations', 'a fresh database is born current'));
		}

		persist(skipPhase(state, 'steps', 'a fresh install has nothing to upgrade from'));

		// ---- start -----------------------------------------------------------
		if (options.start === false) {
			persist(skipPhase(state, 'start', 'start it yourself with pm2 start ecosystem.config.cjs'));
		} else {
			persist(beginPhase(state, 'start'));
			exec('pm2 start ecosystem.config.cjs', target, log);
			persist(finishPhase(state, 'start', 'processes started'));
		}

		persist(beginPhase(state, 'verify'));
		var check = verifyTree(target, manifest);
		if (!check.ok) {
			throw new Error(check.missing.length + ' file(s) did not land and ' +
				check.mismatched.length + ' do not match the release');
		}
		persist(finishPhase(state, 'verify', check.checked + ' files match the release'));

		persist(completeRun(state));
		log('complete');
		return state;
	} catch (e) {
		var where = phaseNow() || 'preflight';
		log('FAILED during ' + where + ': ' + e.message);
		// No rollback. A failed install leaves a partial directory the sysop can
		// delete outright, which is both simpler and safer than unpicking it:
		// there is nothing underneath that was worth keeping.
		persist(addWarning(state, 'the installation is incomplete. Nothing was here before, ' +
			'so removing ' + target + ' and starting again is safe.'));
		persist(failPhase(state, where, e));
		return state;
	}
}

export {
	ENV_TEMPLATE,
	prerequisiteProblems,
	writeEnv,
	runInstall
};
