// tests/updateRunner.test.js: the phase sequence, and the line through the
// middle of it.
//
// One implementation of the phases serves both ways of applying a release, so
// this is the only place the ordering and the failure behaviour are asserted.
//
// The rule that matters is the rollback line. Up to and including
// `dependencies` the only thing that changed is files, so putting them back is
// correct and complete. From `schema` onwards the database has moved, and old
// code over a migrated database is a worse state than the failure was. Getting
// that backwards in either direction is bad in a different way: roll back too
// late and you have a board running last week's code against this week's
// schema; too early and you leave a half-applied tree nobody undid.
//
// The commands are injected. Without a way to make npm fail on demand there is
// no way to assert any of this, and the environment is not what is under test.
//
// Builds miniature releases in a temp directory rather than using a real
// artifact: the sequence does not care how big the tree is.

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildManifest, serialiseManifest, MANIFEST_FILENAME } from '../src/release/manifest.js';
import { newRun } from '../src/release/updatePhases.js';
import * as runStore from '../src/maintenance/updateRunStore.js';
import { backupDir } from '../src/maintenance/updateLayout.js';
import { runUpdate, ROLLBACK_SAFE } from '../src/maintenance/updateRunner.js';

var roots = [];
function tmp(tag) {
	var d = fs.mkdtempSync(path.join(os.tmpdir(), 'canectic-runner-' + tag + '-'));
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

// A staged tree with a MANIFEST, as stageRelease would leave it.
function stage(files) {
	var root = write(tmp('staged'), files);
	var entries = Object.keys(files).sort().map(function (p) { return { path: p, category: 'code' }; });
	var manifest = buildManifest({ root: root, files: entries, version: '0.9.8a' });
	fs.writeFileSync(path.join(root, MANIFEST_FILENAME), serialiseManifest(manifest));
	return root;
}

// A scenario: an installation at 0.9.6a, a staged 0.9.8a, and a run ready to go.
function scenario(opts) {
	var o = opts || {};
	var target = write(tmp('install'), Object.assign({
		'package.json': JSON.stringify({ version: '0.9.6a' }),
		'src/a.js': 'OLD',
		'src/stray.js': 'doomed'
	}, o.installExtra));

	var stagedRoot = stage(Object.assign({
		'package.json': JSON.stringify({ version: '0.9.8a' }),
		'src/a.js': 'NEW',
		'src/added.js': 'fresh'
	}, o.stagedExtra));

	var runId = 'test-' + Math.random().toString(36).substring(2, 8);
	runStore.save(target, newRun({ runId: runId, from: '0.9.6a', to: '0.9.8a', target: target }));
	var instructions = {
		runId: runId, target: target, stagedRoot: stagedRoot,
		from: '0.9.6a', to: '0.9.8a', steps: o.steps || [],
		options: Object.assign({ dump: false }, o.options)
	};
	return { target: target, stagedRoot: stagedRoot, runId: runId, instructions: instructions };
}

/** A command runner that succeeds, unless the command matches `failOn`. */
function execStub(record, failOn) {
	return function (command) {
		record.push(command);
		if (failOn && failOn.test(command)) throw new Error('pretend failure: ' + command);
		return '';
	};
}

function phase(state, name) {
	return state.phases.filter(function (p) { return p.name === name; })[0];
}
function read(target, rel) {
	return fs.readFileSync(path.join(target, rel), 'utf8');
}

describe('the whole sequence', function () {

	it('runs every phase in order and finishes', async function () {
		var s = scenario({ steps: [{ id: 'thing', description: 'a thing', automatic: true, command: 'do-the-thing' }] });
		var ran = [];
		var state = await runUpdate({ instructions: s.instructions, exec: execStub(ran) });

		assert.strictEqual(state.status, 'complete', state.error || '');
		for (var name of ['preflight', 'backup', 'stop', 'files', 'dependencies', 'schema', 'steps', 'start', 'verify']) {
			assert.strictEqual(phase(state, name).status, 'done', name + ': ' + phase(state, name).detail);
		}
		// The commands, in the order they had to happen.
		assert.ok(/stop/.test(ran[0]), ran.join(' | '));
		assert.ok(ran.indexOf('npm install --omit=dev') < ran.indexOf('do-the-thing'), ran.join(' | '));
		assert.ok(/dbmigrations/.test(ran[2]), ran.join(' | '));
		assert.ok(/start/.test(ran[ran.length - 1]), ran.join(' | '));
	});

	it('lands the files', async function () {
		var s = scenario();
		await runUpdate({ instructions: s.instructions, exec: execStub([]) });
		assert.strictEqual(read(s.target, 'src/a.js'), 'NEW');
		assert.strictEqual(read(s.target, 'src/added.js'), 'fresh');
		assert.strictEqual(fs.existsSync(path.join(s.target, 'src/stray.js')), false);
	});

	it('records migrations as covered by the schema run, not as done twice', async function () {
		// One dbmigrations invocation does both. Marking migrations done would
		// imply a second thing happened.
		var s = scenario();
		var ran = [];
		var state = await runUpdate({ instructions: s.instructions, exec: execStub(ran) });
		assert.strictEqual(phase(state, 'migrations').status, 'skipped');
		assert.ok(/same dbmigrations run/.test(phase(state, 'migrations').detail));
		assert.strictEqual(ran.filter(function (c) { return /dbmigrations/.test(c); }).length, 1);
	});

	it('never invokes a bare node', async function () {
		// A BBS runs for years across OS upgrades and under nvm the PATH may
		// not hold the version it is running on.
		var s = scenario();
		var ran = [];
		await runUpdate({ instructions: s.instructions, exec: execStub(ran) });
		var migrate = ran.filter(function (c) { return /dbmigrations/.test(c); })[0];
		assert.ok(migrate.indexOf(process.execPath) === 0 || migrate.indexOf(JSON.stringify(process.execPath)) === 0,
			'should invoke this interpreter: ' + migrate);
	});
});

describe('steps', function () {

	it('runs the automatic ones and hands the rest to the sysop', async function () {
		var s = scenario({ steps: [
			{ id: 'auto', description: 'runs itself', automatic: true, command: 'run-me' },
			{ id: 'manual', description: 'needs a person', automatic: false, command: 'you-run-me', applies_when: 'sometimes' }
		] });
		var ran = [];
		var state = await runUpdate({ instructions: s.instructions, exec: execStub(ran) });

		assert.ok(ran.indexOf('run-me') !== -1);
		assert.ok(ran.indexOf('you-run-me') === -1, 'a manual step must never be run for them');
		var warning = state.warnings.filter(function (w) { return /manual/.test(w); })[0];
		assert.ok(warning, JSON.stringify(state.warnings));
		assert.ok(/you-run-me/.test(warning), 'the warning has to carry the command: ' + warning);
		assert.ok(/sometimes/.test(warning), 'and the condition: ' + warning);
	});

	it('skips the phase when a release declares none', async function () {
		var state = await runUpdate({ instructions: scenario().instructions, exec: execStub([]) });
		assert.strictEqual(phase(state, 'steps').status, 'skipped');
	});
});

describe('the database dump', function () {

	it('is taken immediately before migrating, not earlier', async function () {
		// It exists to protect the migration. Taken any earlier and it does not
		// contain the writes between the two; taken before the stop and that
		// window is as long as the dump.
		var s = scenario({ options: { dump: true } });
		var order = [];
		await runUpdate({
			instructions: s.instructions,
			exec: function (c) { order.push('exec:' + c); return ''; },
			dump: function () { order.push('dump'); return { file: '/tmp/x.dump', bytes: 1048576 }; }
		});
		var dumpAt = order.indexOf('dump');
		var migrateAt = order.findIndex(function (o) { return /dbmigrations/.test(o); });
		var filesDone = order.findIndex(function (o) { return /npm install/.test(o); });
		assert.ok(dumpAt > filesDone, 'the dump comes after the files are in place');
		assert.ok(dumpAt < migrateAt, 'and immediately before the migration');
	});

	it('says so loudly when there is no dump', async function () {
		var s = scenario({ options: { dump: false } });
		var state = await runUpdate({ instructions: s.instructions, exec: execStub([]) });
		assert.ok(state.warnings.some(function (w) { return /no database dump/.test(w); }),
			JSON.stringify(state.warnings));
	});

	it('records where the dump went, so it can be found again', async function () {
		var s = scenario({ options: { dump: true } });
		var state = await runUpdate({
			instructions: s.instructions, exec: execStub([]),
			dump: function () { return { file: '/somewhere/database.dump', bytes: 5 * 1048576 }; }
		});
		assert.ok(state.warnings.some(function (w) { return /\/somewhere\/database\.dump/.test(w); }),
			JSON.stringify(state.warnings));
	});
});

describe('the rollback line', function () {

	it('puts the files back when the failure is before the database moved', async function () {
		var s = scenario();
		var state = await runUpdate({
			instructions: s.instructions, exec: execStub([], /npm install/)
		});

		assert.strictEqual(state.status, 'failed');
		assert.strictEqual(phase(state, 'dependencies').status, 'failed');
		assert.strictEqual(read(s.target, 'src/a.js'), 'OLD', 'the overwritten file came back');
		assert.strictEqual(read(s.target, 'src/stray.js'), 'doomed', 'the removed file came back');
		assert.strictEqual(fs.existsSync(path.join(s.target, 'src/added.js')), false, 'the new file went away');
		assert.ok(state.warnings.some(function (w) { return /rolled back/.test(w); }), JSON.stringify(state.warnings));
	});

	it('leaves the files alone when the database has already been migrated', async function () {
		// Old code over a migrated database is a worse state than the failure,
		// so this stops and tells a person rather than deciding for them.
		var s = scenario({ steps: [{ id: 'boom', description: 'fails', automatic: true, command: 'explode' }] });
		var state = await runUpdate({
			instructions: s.instructions, exec: execStub([], /explode/)
		});

		assert.strictEqual(state.status, 'failed');
		assert.strictEqual(phase(state, 'steps').status, 'failed');
		assert.strictEqual(read(s.target, 'src/a.js'), 'NEW', 'the files stay applied');
		var warning = state.warnings.filter(function (w) { return /NOT rolled back/.test(w); })[0];
		assert.ok(warning, JSON.stringify(state.warnings));
		assert.ok(/backup is at/.test(warning), 'it has to say where the backup is: ' + warning);
	});

	it('names every phase on the safe side of the line', function () {
		// Written out rather than derived, because the consequence of a phase
		// drifting to the wrong side is silent and only shows up in a failure.
		assert.deepStrictEqual(ROLLBACK_SAFE, ['preflight', 'backup', 'stop', 'files', 'dependencies']);
		for (var late of ['schema', 'migrations', 'steps', 'start', 'verify']) {
			assert.ok(ROLLBACK_SAFE.indexOf(late) === -1, late + ' must not be rollback-safe');
		}
	});

	it('has nothing to roll back when it fails before writing anything', async function () {
		var s = scenario();
		var state = await runUpdate({ instructions: s.instructions, exec: execStub([], /stop/) });
		assert.strictEqual(phase(state, 'stop').status, 'failed');
		assert.strictEqual(read(s.target, 'src/a.js'), 'OLD');
		assert.ok(!state.warnings.some(function (w) { return /rolled back/.test(w); }),
			'nothing was written, so nothing should claim to have been undone');
	});
});

describe('after a failure', function () {

	it('starts the BBS again rather than leaving the board down', async function () {
		var s = scenario();
		var ran = [];
		var state = await runUpdate({ instructions: s.instructions, exec: execStub(ran, /npm install/) });
		assert.strictEqual(state.status, 'failed');
		assert.strictEqual(ran.filter(function (c) { return /start/.test(c); }).length, 1,
			'it stopped the BBS, so it has to try to start it: ' + ran.join(' | '));
		assert.ok(state.warnings.some(function (w) { return /started again/.test(w); }), JSON.stringify(state.warnings));
	});

	it('says the board is still down when it cannot start it', async function () {
		var s = scenario();
		var state = await runUpdate({ instructions: s.instructions, exec: execStub([], /npm install|start/) });
		assert.ok(state.warnings.some(function (w) { return /still stopped/.test(w); }), JSON.stringify(state.warnings));
	});

	it('does not try to start what it never stopped', async function () {
		var s = scenario({ options: { processControl: false } });
		var ran = [];
		await runUpdate({ instructions: s.instructions, exec: execStub(ran, /npm install/) });
		assert.deepStrictEqual(ran.filter(function (c) { return /pm2|start/.test(c); }), []);
	});
});

describe('opting out', function () {

	it('skips what it was told to skip, with the command to run by hand', async function () {
		var s = scenario({ options: { dependencies: false, schema: false, processControl: false } });
		var ran = [];
		var state = await runUpdate({ instructions: s.instructions, exec: execStub(ran) });

		assert.strictEqual(state.status, 'complete');
		for (var name of ['stop', 'dependencies', 'schema', 'migrations', 'start']) {
			assert.strictEqual(phase(state, name).status, 'skipped', name);
			assert.ok(phase(state, name).detail, name + ' must say why');
		}
		assert.ok(/npm install/.test(phase(state, 'dependencies').detail));
		assert.ok(/dbmigrations/.test(phase(state, 'schema').detail));
		assert.deepStrictEqual(ran, [], 'nothing should have been run at all');
		// The files still landed: skipping the environment is not skipping the update.
		assert.strictEqual(read(s.target, 'src/a.js'), 'NEW');
	});
});

describe('the backup', function () {

	it('goes under the update directory, not among the logs', async function () {
		var s = scenario();
		await runUpdate({ instructions: s.instructions, exec: execStub([]) });
		var dir = backupDir(s.target, s.runId);
		assert.ok(fs.existsSync(path.join(dir, 'src/a.js')), 'the displaced file is in the backup');
		assert.strictEqual(fs.readFileSync(path.join(dir, 'src/a.js'), 'utf8'), 'OLD');
		assert.ok(dir.indexOf('.canectic-update') !== -1, dir);
		assert.ok(dir.indexOf('logs') === -1, 'logs hold the record, not the bytes: ' + dir);
	});
});
