// tests/updateHandoff.test.js: handing an update over to the new release, and
// the CLI that drives it.
//
// The handoff is the piece a unit test can only half reach, so this is split:
// the safety rules are pure and asserted directly, and the rest is a real
// detached process against a real tiny installation.
//
// Two of these cover fixes that previously had no test at all, both found by
// running the tool by hand rather than by review:
//
//   The tool reported the version of the tree it was RUNNING from, not the tree
//   it was about to modify. Identical whenever --target is the current
//   directory, which is what anybody testing by hand would use.
//
//   Naming --version explicitly skipped the move rule entirely, and the one
//   time somebody names a version by hand is when they are trying to get past
//   something.

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

import {
	UPDATER_ENTRY, STAGING_DIRNAME, stagingRootFor, updaterEntry,
	isInsideReplacedTree, validateHandoff, handoffPlan, launchUpdater
} from '../src/maintenance/updateHandoff.js';
import * as runStore from '../src/maintenance/updateRunStore.js';
import { newRun, summarise } from '../src/release/updatePhases.js';
import { buildManifest, serialiseManifest, hashFile, MANIFEST_FILENAME } from '../src/release/manifest.js';
import { buildMetadata, serialiseMetadata, artifactName, metadataName } from '../src/release/metadata.js';
import { emptyIndex, addRelease, serialiseIndex, indexName } from '../src/release/releaseIndex.js';
import { appliedIds } from '../src/maintenance/migrationLedger.js';

var REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
var CLI = path.join(REPO, 'src/tools/update.js');

var roots = [];
function tmp(tag) {
	var d = fs.mkdtempSync(path.join(os.tmpdir(), 'canectic-handoff-' + tag + '-'));
	roots.push(d);
	return d;
}
function write(root, files) {
	for (var p of Object.keys(files)) {
		var abs = path.join(root, p);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, files[p]);
	}
	return root;
}

after(function () {
	for (var d of roots) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
});

// ---------------------------------------------------------------------------
// Pure safety rules
// ---------------------------------------------------------------------------

describe('isInsideReplacedTree', function () {

	it('rejects a staged tree inside a directory the update replaces', function () {
		// The updater would be deleting its own source while running it.
		assert.strictEqual(isInsideReplacedTree('/opt/c/src/staging', '/opt/c'), true);
		assert.strictEqual(isInsideReplacedTree('/opt/c/public/x', '/opt/c'), true);
		assert.strictEqual(isInsideReplacedTree('/opt/c/config/x', '/opt/c'), true);
	});

	it('accepts the dot directory inside the installation, which is the normal case', function () {
		// Staging lives inside the install on purpose: node_modules resolves by
		// walking up, and a release artifact ships none. The dot directory is
		// not a shipped category, so nothing replaces it.
		assert.strictEqual(isInsideReplacedTree('/opt/c/' + STAGING_DIRNAME + '/0.9.8a/tree', '/opt/c'), false);
	});

	it('accepts a staged tree outside the installation entirely', function () {
		assert.strictEqual(isInsideReplacedTree('/tmp/stage', '/opt/c'), false);
	});
});

describe('validateHandoff', function () {

	function stagedTreeWith(entry) {
		var d = tmp('staged');
		if (entry) write(d, { [UPDATER_ENTRY]: '// updater\n' });
		return d;
	}
	function install() {
		return write(tmp('install'), { 'package.json': '{"version":"0.9.6a"}' });
	}

	it('passes a sound handoff', function () {
		assert.deepStrictEqual(validateHandoff({ stagedRoot: stagedTreeWith(true), target: install() }), []);
	});

	it('refuses a release that ships no updater', function () {
		// A release cut before this mechanism existed. It must say so and point
		// at the alternative rather than failing obscurely on spawn.
		var problems = validateHandoff({ stagedRoot: stagedTreeWith(false), target: install() });
		assert.strictEqual(problems.length, 1);
		assert.ok(/ships no src\/tools\/applyUpdate\.js/.test(problems[0]), problems[0]);
		assert.ok(/--apply/.test(problems[0]), 'it has to say what to do instead');
	});

	it('refuses when the staged tree and the installation are the same place', function () {
		var d = install();
		write(d, { [UPDATER_ENTRY]: '// updater\n' });
		var problems = validateHandoff({ stagedRoot: d, target: d });
		assert.ok(problems.some(function (p) { return /same directory/.test(p); }), problems.join('; '));
	});

	it('refuses a staged tree inside a replaced directory', function () {
		var target = install();
		var staged = path.join(target, 'src', 'staging');
		write(target, { ['src/staging/' + UPDATER_ENTRY]: '// updater\n' });
		var problems = validateHandoff({ stagedRoot: staged, target: target });
		assert.ok(problems.some(function (p) { return /delete itself mid-run/.test(p); }), problems.join('; '));
	});

	it('refuses a target that is not an installation', function () {
		var problems = validateHandoff({ stagedRoot: stagedTreeWith(true), target: tmp('empty') });
		assert.ok(problems.some(function (p) { return /no package\.json/.test(p); }), problems.join('; '));
	});

	it('says so plainly when it was given nothing', function () {
		assert.deepStrictEqual(validateHandoff({}), ['no staged tree', 'no target installation']);
	});
});

describe('handoffPlan', function () {

	it('runs the staged tree\'s updater with this process\'s own interpreter', function () {
		// Never a bare `node`. A BBS runs for years across OS upgrades, and
		// under nvm the daemon's PATH may not hold the Node the gateway is on.
		var plan = handoffPlan({ stagedRoot: '/opt/c/.canectic-update/0.9.8a/tree', target: '/opt/c', runFile: '/opt/c/logs/update/x.run.json' });
		assert.strictEqual(plan.command, process.execPath);
		assert.strictEqual(plan.args[0], '/opt/c/.canectic-update/0.9.8a/tree/' + UPDATER_ENTRY);
		assert.strictEqual(plan.detached, true);
	});

	it('passes one argument, a run file, so the contract between versions can grow', function () {
		// The old release writes it and the new one reads it. A positional
		// argument list could not be extended by either without breaking the
		// other.
		var plan = handoffPlan({ stagedRoot: '/s', target: '/t', runFile: '/t/run.json' });
		assert.deepStrictEqual(plan.args.slice(1), ['--run', '/t/run.json']);
	});

	it('runs from the installation, where .env and node_modules are', function () {
		// The code comes from staging; the working directory does not, because
		// a release artifact ships neither of those and the install root is
		// never deleted.
		assert.strictEqual(handoffPlan({ stagedRoot: '/s', target: '/t', runFile: '/r' }).cwd, '/t');
	});
});

describe('updateRunStore', function () {

	it('round trips a run state and tracks the latest', function () {
		var target = tmp('store');
		var a = newRun({ runId: 'run-a', from: '0.9.6a', to: '0.9.7a', target: target });
		var b = newRun({ runId: 'run-b', from: '0.9.7a', to: '0.9.8a', target: target });
		runStore.save(target, a);
		runStore.save(target, b);

		assert.strictEqual(runStore.load(target, 'run-a').to, '0.9.7a');
		assert.strictEqual(runStore.latest(target).runId, 'run-b');
		assert.deepStrictEqual(runStore.list(target), ['run-b', 'run-a']);
	});

	it('has no opinion about an install that has never updated', function () {
		var target = tmp('store2');
		assert.strictEqual(runStore.latest(target), null);
		assert.deepStrictEqual(runStore.list(target), []);
		assert.strictEqual(runStore.load(target, 'nope'), null);
	});

	it('does not list run files as runs', function () {
		var target = tmp('store3');
		runStore.save(target, newRun({ runId: 'run-a', target: target }));
		runStore.writeRunFile(target, 'run-a', { runId: 'run-a' });
		assert.deepStrictEqual(runStore.list(target), ['run-a']);
	});
});

// ---------------------------------------------------------------------------
// A real handoff, and the CLI
// ---------------------------------------------------------------------------

// Publish a miniature release that ships a real updater entry point. The
// updater it ships is a stub: this is testing the handoff, and the applier it
// would call has its own tests.
// Whatever THIS machine's ledger says has been applied.
//
// The test releases below declare exactly that, so the migration half of the
// move rule can never be what refuses them. Without it these tests pass or fail
// depending on which migrations happen to be recorded in the developer's own
// database, which is the definition of a flaky test. Bounded, because a
// database that will not answer must not hang the suite; an empty answer is
// equally fine, since a release shipping no migrations blocks nothing.
var LOCAL_MIGRATIONS = [];
before(async function () {
	this.timeout(15000);
	var timer = null;
	var bound = new Promise(function (resolve) { timer = setTimeout(function () { resolve([]); }, 8000); });
	LOCAL_MIGRATIONS = await Promise.race([appliedIds().catch(function () { return []; }), bound]);
	if (timer) clearTimeout(timer);
});

function publishRelease(pub, version, extraFiles) {
	var staging = tmp('build');
	var treeName = 'canectic-' + version;
	var treeRoot = path.join(staging, treeName);
	var files = Object.assign({
		'package.json': JSON.stringify({ name: 'canectic-bbs', version: version }, null, 2) + '\n',
		'src/a.js': '// ' + version + '\n'
	}, extraFiles || {});
	write(treeRoot, files);

	var entries = Object.keys(files).sort().map(function (p) { return { path: p, category: 'code' }; });
	var manifest = buildManifest({ root: treeRoot, files: entries, version: version, generated: '2026-09-20T00:00:00.000Z' });
	fs.writeFileSync(path.join(treeRoot, MANIFEST_FILENAME), serialiseManifest(manifest));

	fs.mkdirSync(pub, { recursive: true });
	var artifact = path.join(pub, artifactName(version));
	execFileSync('tar', ['--sort=name', '--owner=0', '--group=0', '--numeric-owner', '-czf', artifact, '-C', staging, treeName]);

	var meta = buildMetadata({
		version: version, released: '2026-09-20', sha256: hashFile(artifact),
		migrations: LOCAL_MIGRATIONS, node_min: '22.0.0',
		min_upgrade_from: (extraFiles && extraFiles.__floor) || null
	});
	fs.writeFileSync(path.join(pub, metadataName(version)), serialiseMetadata(meta));
	return meta;
}

function publishIndex(pub, metas) {
	var idx = emptyIndex('stable');
	for (var m of metas) idx = addRelease(idx, m);
	fs.writeFileSync(path.join(pub, indexName('stable')), serialiseIndex(idx));
}

describe('launchUpdater', function () {

	it('spawns the staged tree\'s updater and leaves a readable run behind', function (done) {
		this.timeout(20000);
		var target = write(tmp('install'), { 'package.json': '{"version":"0.9.6a"}' });
		var staged = tmp('staged');
		// A stub updater that marks the run complete, which is all the handoff
		// itself is responsible for getting to.
		write(staged, {
			[UPDATER_ENTRY]: [
				"import * as fs from 'fs';",
				"var runFile = process.argv[process.argv.indexOf('--run') + 1];",
				"var ins = JSON.parse(fs.readFileSync(runFile, 'utf8'));",
				"var state = JSON.parse(fs.readFileSync(ins.target + '/logs/update/' + ins.runId + '.json', 'utf8'));",
				"state.status = 'complete';",
				"state.sawCwd = process.cwd();",
				"state.sawEnv = process.env.CANECTIC_UPDATE_RUN;",
				"fs.writeFileSync(ins.target + '/logs/update/latest.json', JSON.stringify(state));",
				"console.log('stub updater ran');"
			].join('\n')
		});

		var handle = launchUpdater({
			stagedRoot: staged, target: target, from: '0.9.6a', to: '0.9.8a',
			launchedBy: 'test', phases: ['files']
		});
		assert.ok(handle.pid > 0);

		var waited = 0;
		var poll = setInterval(function () {
			var state = runStore.latest(target);
			if (state && state.status === 'complete') {
				clearInterval(poll);
				assert.strictEqual(state.sawCwd, fs.realpathSync(target), 'the updater runs from the installation');
				assert.strictEqual(state.sawEnv, handle.runId, 'the run id reaches the child');
				assert.ok(fs.existsSync(handle.logFile), 'its output goes to a file, since nobody is watching');
				done();
			} else if ((waited += 100) > 15000) {
				clearInterval(poll);
				done(new Error('the updater never finished; log: ' +
					(fs.existsSync(handle.logFile) ? fs.readFileSync(handle.logFile, 'utf8') : 'none')));
			}
		}, 100);
	});

	it('writes the run state before spawning, so a crash still leaves a record', function () {
		var target = write(tmp('install'), { 'package.json': '{"version":"0.9.6a"}' });
		var staged = write(tmp('staged'), { [UPDATER_ENTRY]: 'process.exit(3);\n' });

		var handle = launchUpdater({ stagedRoot: staged, target: target, from: '0.9.6a', to: '0.9.8a' });
		var state = runStore.load(target, handle.runId);
		assert.ok(state, 'a run that dies instantly must still be visible');
		assert.strictEqual(state.from, '0.9.6a');
		assert.strictEqual(state.to, '0.9.8a');
		assert.strictEqual(summarise(state).status, 'running');
	});

	it('refuses rather than spawning something that cannot work', function () {
		var target = write(tmp('install'), { 'package.json': '{}' });
		assert.throws(function () {
			launchUpdater({ stagedRoot: tmp('staged'), target: target });
		}, /cannot hand off/);
	});
});

describe('the update CLI', function () {

	function runCli(args) {
		return spawnSync(process.execPath, [CLI].concat(args), {
			cwd: REPO, encoding: 'utf8', timeout: 60000
		});
	}

	it('reports the version of the target, not of the tree it is running from', function () {
		// The bug this covers: identical whenever --target is the current
		// directory, which is what anybody testing by hand would use.
		this.timeout(60000);
		var pub = tmp('pub');
		publishIndex(pub, [publishRelease(pub, '0.9.8a')]);
		var target = write(tmp('install'), {
			'package.json': JSON.stringify({ version: '0.4.2a' }),
			'src/a.js': '// old\n'
		});

		var out = runCli(['--from-dir', pub, '--target', target, '--version', '0.9.8a']);
		var text = out.stdout + out.stderr;
		assert.ok(/installed version 0\.4\.2a/.test(text), text);
		var repoVersion = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
		assert.ok(!new RegExp('installed version ' + repoVersion.replace('.', '\\.')).test(text),
			'it must not report this repository\'s version: ' + text);
	});

	it('applies the move rule even when a version is named by hand', function () {
		// Naming a version was a way to skip the rule, and the one time
		// somebody does that is when they are trying to get past something.
		// The upgrade floor is used here rather than a migration, because it
		// needs no database to evaluate.
		this.timeout(60000);
		var pub = tmp('pub');
		var meta = publishRelease(pub, '0.9.8a');
		meta.min_upgrade_from = '9.9.9a';
		fs.writeFileSync(path.join(pub, metadataName('0.9.8a')), serialiseMetadata(meta));
		publishIndex(pub, [meta]);

		var target = write(tmp('install'), {
			'package.json': JSON.stringify({ version: '0.9.6a' }),
			'src/a.js': '// old\n'
		});

		var out = runCli(['--from-dir', pub, '--target', target, '--version', '0.9.8a']);
		var text = out.stdout + out.stderr;
		assert.notStrictEqual(out.status, 0, 'it should have refused: ' + text);
		assert.ok(/cannot move to 0\.9\.8a/.test(text), text);
		assert.ok(/9\.9\.9a or later/.test(text), 'it has to say why: ' + text);
		assert.ok(/Nothing was downloaded/.test(text), text);
	});

	it('writes nothing to the target without --apply', function () {
		this.timeout(60000);
		var pub = tmp('pub');
		publishIndex(pub, [publishRelease(pub, '0.9.8a')]);
		var target = write(tmp('install'), {
			'package.json': JSON.stringify({ version: '0.9.6a' }),
			'src/a.js': '// old\n'
		});

		var out = runCli(['--from-dir', pub, '--target', target]);
		assert.strictEqual(out.status, 0, out.stdout + out.stderr);
		assert.strictEqual(fs.readFileSync(path.join(target, 'src/a.js'), 'utf8'), '// old\n');
		assert.strictEqual(JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).version, '0.9.6a');
	});

	it('reports no run for an install that has never updated', function () {
		this.timeout(60000);
		var target = write(tmp('install'), { 'package.json': '{"version":"0.9.6a"}' });
		var out = runCli(['--status', '--target', target]);
		assert.ok(/no update has ever run/.test(out.stdout + out.stderr), out.stdout + out.stderr);
	});
});
