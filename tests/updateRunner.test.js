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
import { runUpdate, ROLLBACK_SAFE, manualActionsFrom } from '../src/maintenance/updateRunner.js';

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

// The drain wait is injected too: the real one polls status files for up to
// twenty seconds before deciding nothing is reporting. `drain` sets the verdict.
function drainStub(verdict, record) {
	return async function (root, opts) {
		if (record) record.push({ root: root, timeoutMs: opts && opts.timeoutMs });
		return { verdict: verdict || 'drained', assessment: { processes: [], reporting: 0, drained: true } };
	};
}
// And the progress page listener: the real one would try to take the web
// port, which a dev box's gateway is sitting on.
function listenerStub(record) {
	return async function (opts) {
		if (record) record.push({ event: 'start', opts: opts });
		return { port: opts.port, close: async function () { if (record) record.push({ event: 'close' }); } };
	};
}
function run(o) {
	return runUpdate(Object.assign({ waitForDrain: drainStub('drained'), startStatusServer: listenerStub() }, o));
}

function phase(state, name) {
	return state.phases.filter(function (p) { return p.name === name; })[0];
}
function read(target, rel) {
	return fs.readFileSync(path.join(target, rel), 'utf8');
}

// Undermine, updated from 0.9.6a with no MANIFEST, was told "every changed
// data file was kept as yours" when not one had been.
describe('an installation with no MANIFEST', function () {

	it('says nothing about kept files when none were kept', async function () {
		var s = scenario();
		var state = await run({ instructions: s.instructions, exec: execStub([]) });
		assert.strictEqual(state.status, 'complete', state.error || '');
		assert.ok(!state.warnings.some(function (w) { return /had no MANIFEST/.test(w); }), state.warnings.join('\n'));
	});

	it('says how many data files it kept when some differed', async function () {
		var s = scenario({
			installExtra: { 'config/x.json': '{"mine":true}' },
			stagedExtra: { 'config/x.json': '{"shipped":true}' }
		});
		// Re-describe the staged tree with config/x.json as a data file.
		var files = ['package.json', 'src/a.js', 'src/added.js', 'config/x.json'].map(function (p) {
			return { path: p, category: p === 'config/x.json' ? 'data' : 'code' };
		});
		fs.writeFileSync(path.join(s.stagedRoot, MANIFEST_FILENAME),
			serialiseManifest(buildManifest({ root: s.stagedRoot, files: files, version: '0.9.8a' })));
		var state = await run({ instructions: s.instructions, exec: execStub([]) });
		assert.strictEqual(state.status, 'complete', state.error || '');
		assert.strictEqual(read(s.target, 'config/x.json'), '{"mine":true}', 'kept, since it may be theirs');
		var w = state.warnings.filter(function (x) { return /had no MANIFEST/.test(x); })[0];
		assert.ok(w && /1 data file\(s\)/.test(w), state.warnings.join('\n'));
		assert.ok(state.warnings.some(function (x) { return /kept your config\/x\.json/.test(x); }), 'and names it');
	});
});

describe('the whole sequence', function () {

	it('runs every phase in order and finishes', async function () {
		var s = scenario({ steps: [{ id: 'thing', description: 'a thing', automatic: true, command: 'do-the-thing' }] });
		var ran = [];
		var state = await run({ instructions: s.instructions, exec: execStub(ran) });

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
		await run({ instructions: s.instructions, exec: execStub([]) });
		assert.strictEqual(read(s.target, 'src/a.js'), 'NEW');
		assert.strictEqual(read(s.target, 'src/added.js'), 'fresh');
		assert.strictEqual(fs.existsSync(path.join(s.target, 'src/stray.js')), false);
	});

	it('records migrations as covered by the schema run, not as done twice', async function () {
		// One dbmigrations invocation does both. Marking migrations done would
		// imply a second thing happened.
		var s = scenario();
		var ran = [];
		var state = await run({ instructions: s.instructions, exec: execStub(ran) });
		assert.strictEqual(phase(state, 'migrations').status, 'skipped');
		assert.ok(/same dbmigrations run/.test(phase(state, 'migrations').detail));
		assert.strictEqual(ran.filter(function (c) { return /dbmigrations/.test(c); }).length, 1);
	});

	it('never invokes a bare node', async function () {
		// A BBS runs for years across OS upgrades and under nvm the PATH may
		// not hold the version it is running on.
		var s = scenario();
		var ran = [];
		await run({ instructions: s.instructions, exec: execStub(ran) });
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
		var state = await run({ instructions: s.instructions, exec: execStub(ran) });

		assert.ok(ran.indexOf('run-me') !== -1);
		assert.ok(ran.indexOf('you-run-me') === -1, 'a manual step must never be run for them');
		var warning = state.warnings.filter(function (w) { return /manual/.test(w); })[0];
		assert.ok(warning, JSON.stringify(state.warnings));
		assert.ok(/you-run-me/.test(warning), 'the warning has to carry the command: ' + warning);
		assert.ok(/sometimes/.test(warning), 'and the condition: ' + warning);
	});

	it('skips the phase when a release declares none', async function () {
		var state = await run({ instructions: scenario().instructions, exec: execStub([]) });
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
		await run({
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
		var state = await run({ instructions: s.instructions, exec: execStub([]) });
		assert.ok(state.warnings.some(function (w) { return /no database dump/.test(w); }),
			JSON.stringify(state.warnings));
	});

	it('records where the dump went, so it can be found again', async function () {
		var s = scenario({ options: { dump: true } });
		var state = await run({
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
		var state = await run({
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
		var state = await run({
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
		var state = await run({ instructions: s.instructions, exec: execStub([], /stop/) });
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
		var state = await run({ instructions: s.instructions, exec: execStub(ran, /npm install/) });
		assert.strictEqual(state.status, 'failed');
		assert.strictEqual(ran.filter(function (c) { return /start/.test(c); }).length, 1,
			'it stopped the BBS, so it has to try to start it: ' + ran.join(' | '));
		assert.ok(state.warnings.some(function (w) { return /started again/.test(w); }), JSON.stringify(state.warnings));
	});

	it('says the board is still down when it cannot start it', async function () {
		var s = scenario();
		var state = await run({ instructions: s.instructions, exec: execStub([], /npm install|start/) });
		assert.ok(state.warnings.some(function (w) { return /still stopped/.test(w); }), JSON.stringify(state.warnings));
	});

	it('does not try to start what it never stopped', async function () {
		var s = scenario({ options: { processControl: false } });
		var ran = [];
		await run({ instructions: s.instructions, exec: execStub(ran, /npm install/) });
		assert.deepStrictEqual(ran.filter(function (c) { return /pm2|start/.test(c); }), []);
	});
});

describe('opting out', function () {

	it('skips what it was told to skip, with the command to run by hand', async function () {
		var s = scenario({ options: { dependencies: false, schema: false, processControl: false } });
		var ran = [];
		var state = await run({ instructions: s.instructions, exec: execStub(ran) });

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
		await run({ instructions: s.instructions, exec: execStub([]) });
		var dir = backupDir(s.target, s.runId);
		assert.ok(fs.existsSync(path.join(dir, 'src/a.js')), 'the displaced file is in the backup');
		assert.strictEqual(fs.readFileSync(path.join(dir, 'src/a.js'), 'utf8'), 'OLD');
		assert.ok(dir.indexOf('.canectic-update') !== -1, dir);
		assert.ok(dir.indexOf('logs') === -1, 'logs hold the record, not the bytes: ' + dir);
	});

	it('removes older backups and leftover staging once the update completes (#62)', async function () {
		var s = scenario();
		var old = '20260920-040034-aaaa';
		fs.mkdirSync(backupDir(s.target, old), { recursive: true });
		fs.writeFileSync(path.join(backupDir(s.target, old), 'database.dump'), 'old dump');
		runStore.save(s.target, { runId: old, status: 'complete', phases: [] });
		runStore.save(s.target, JSON.parse(fs.readFileSync(runStore.statePath(s.target, s.runId), 'utf8')));
		write(s.target, { '.canectic-update/staging/0.9.7a/tree/x': 'stale' });

		var state = await run({ instructions: s.instructions, exec: execStub([]) });
		assert.strictEqual(state.status, 'complete');
		assert.ok(!fs.existsSync(backupDir(s.target, old)), 'the older backup is gone');
		assert.ok(fs.existsSync(backupDir(s.target, s.runId)), 'this run keeps its own');
		assert.ok(!fs.existsSync(path.join(s.target, '.canectic-update/staging/0.9.7a')), 'stale staging is gone');
	});

	it('keeps older backups when the update fails', async function () {
		var s = scenario();
		var old = '20260920-040034-aaaa';
		fs.mkdirSync(backupDir(s.target, old), { recursive: true });
		runStore.save(s.target, { runId: old, status: 'complete', phases: [] });
		var state = await run({ instructions: s.instructions, exec: execStub([], /npm/) });
		assert.strictEqual(state.status, 'failed');
		assert.ok(fs.existsSync(backupDir(s.target, old)), 'nothing is pruned after a failure');
	});
});

describe('maintenance mode around an update', function () {
	var flags = null;
	before(async function () { flags = await import('../src/maintenance/maintenanceFlag.js'); });

	// Records each command with whether the board was closed when it ran.
	function execWatching(target, record, failOn) {
		return function (command) {
			record.push({ command: command, closed: flags.isActive(target) });
			if (failOn && failOn.test(command)) throw new Error('pretend failure: ' + command);
			return '';
		};
	}

	it('closes the board for the run and reopens it once verify passes', async function () {
		var s = scenario();
		var ran = [];
		var state = await run({ instructions: s.instructions, exec: execWatching(s.target, ran) });
		assert.strictEqual(state.status, 'complete', JSON.stringify(state.phases));
		var stop = ran.filter(function (r) { return /stop/.test(r.command); })[0];
		var start = ran.filter(function (r) { return /start/.test(r.command); })[0];
		assert.strictEqual(stop.closed, true, 'the board must be closed before it is stopped');
		assert.strictEqual(start.closed, true, 'processes must come back up closed, and open only after verify');
		assert.strictEqual(flags.isActive(s.target), false, 'a completed update reopens the board');
	});

	it('marks the closure as the update\'s own, with the run id', async function () {
		var s = scenario();
		var seen = null;
		await run({ instructions: s.instructions, exec: function (command) {
			if (/stop/.test(command)) seen = flags.readFlag(s.target);
			return '';
		} });
		assert.strictEqual(seen.source, 'update');
		assert.strictEqual(seen.run_id, s.runId);
		assert.ok(/0\.9\.8a/.test(seen.reason), seen.reason);
	});

	it('waits for the drain before running the stop command', async function () {
		var s = scenario();
		var order = [];
		await run({
			instructions: s.instructions,
			exec: function (command) { order.push(command); return ''; },
			waitForDrain: async function (root, opts) {
				order.push('drain:' + opts.timeoutMs);
				return { verdict: 'drained', assessment: { processes: [], reporting: 2, drained: true } };
			}
		});
		var drainAt = order.findIndex(function (c) { return /^drain:/.test(c); });
		var stopAt = order.findIndex(function (c) { return /stop/.test(c); });
		assert.ok(drainAt !== -1 && drainAt < stopAt, order.join(' | '));
		assert.ok(parseInt(order[drainAt].split(':')[1], 10) >= 900000,
			'the wait covers the rest of the grace plus update_drain_timeout');
	});

	it('leaves the board closed when the update fails after the stop', async function () {
		var s = scenario();
		var state = await run({ instructions: s.instructions, exec: execStub([], /npm install/) });
		assert.strictEqual(state.status, 'failed');
		assert.strictEqual(flags.isActive(s.target), true, 'a failed update is when a person decides');
		assert.ok(state.warnings.some(function (w) { return /left closed for maintenance/.test(w); }), state.warnings.join('\n'));
	});

	it('leaves the board closed when the stop command itself fails', async function () {
		// A stop that fails can leave a half-stopped board, as one on the hub did.
		var s = scenario();
		var state = await run({ instructions: s.instructions, exec: execStub([], /stop/) });
		assert.strictEqual(state.status, 'failed');
		assert.strictEqual(flags.isActive(s.target), true);
	});

	it('reopens the board when the update fails before changing anything', async function () {
		var s = scenario();
		fs.unlinkSync(path.join(s.stagedRoot, MANIFEST_FILENAME));
		var state = await run({ instructions: s.instructions, exec: execStub([]) });
		assert.strictEqual(state.status, 'failed');
		assert.strictEqual(phase(state, 'preflight').status, 'failed');
		assert.strictEqual(flags.isActive(s.target), false, 'nothing was touched, so there is nothing to decide');
	});

	it('puts back a closure the sysop set before starting the update', async function () {
		var s = scenario();
		var before = flags.enterMaintenance(s.target, { reason: 'Rebuilding areas', expected_minutes: 90,
			grace_seconds: 0, set_by: 'sysop', source: 'manual' });
		var state = await run({ instructions: s.instructions, exec: execStub([]) });
		assert.strictEqual(state.status, 'complete');
		var after = flags.readFlag(s.target);
		assert.ok(after, 'the update must not reopen a board somebody closed on purpose');
		assert.strictEqual(after.reason, 'Rebuilding areas');
		assert.strictEqual(after.source, 'manual');
		assert.strictEqual(after.since, before.since, 'and the grace keeps its original start');
	});

	it('warns when the drain times out, and stops anyway', async function () {
		var s = scenario();
		var ran = [];
		var state = await run({ instructions: s.instructions, exec: execStub(ran), waitForDrain: async function () {
			return { verdict: 'timeout', assessment: { reporting: 1, drained: false,
				processes: [{ process: 'worker', state: 'draining', pending: { 'toss jobs': 1 } }] } };
		} });
		assert.strictEqual(state.status, 'complete');
		assert.ok(ran.some(function (c) { return /stop/.test(c); }));
		assert.ok(state.warnings.some(function (w) { return /still in flight.*worker: 1 toss jobs/.test(w); }), state.warnings.join('\n'));
	});

	it('carries on quietly when the running release cannot report a drain', async function () {
		// The first update into a release with maintenance mode.
		var s = scenario();
		var state = await run({ instructions: s.instructions, exec: execStub([]), waitForDrain: drainStub('nobody') });
		assert.strictEqual(state.status, 'complete');
		assert.ok(/could not report a drain/.test(phase(state, 'stop').note || phase(state, 'stop').detail || JSON.stringify(phase(state, 'stop'))));
	});

	it('does not wait for a drain when the sysop stops the BBS themselves', async function () {
		var s = scenario({ options: { processControl: false } });
		var waited = [];
		var state = await run({ instructions: s.instructions, exec: execStub([]), waitForDrain: drainStub('drained', waited) });
		assert.strictEqual(state.status, 'complete');
		assert.strictEqual(waited.length, 0);
		assert.strictEqual(flags.isActive(s.target), false);
	});
});

describe('the progress page while the BBS is stopped', function () {
	var sysopMod = null;
	before(async function () { sysopMod = await import('../src/maintenance/sysopSessions.js'); });

	// One ordered record of commands and listener events.
	function recorder() {
		var events = [];
		return {
			events: events,
			exec: function (failOn) {
				return function (command) {
					events.push('exec:' + (/stop/.test(command) ? 'stop' : /start/.test(command) ? 'start' : command));
					if (failOn && failOn.test(command)) throw new Error('pretend failure: ' + command);
					return '';
				};
			},
			listener: function (seen) {
				return async function (opts) {
					events.push('listen:' + opts.port);
					if (seen) seen.opts = opts;
					return { port: opts.port, close: async function () { events.push('close'); } };
				};
			}
		};
	}

	it('takes the web port only after the stop, and gives it back before the start', async function () {
		var s = scenario();
		var r = recorder();
		var state = await run({ instructions: s.instructions, exec: r.exec(), startStatusServer: r.listener() });
		assert.strictEqual(state.status, 'complete');
		var seq = r.events.filter(function (e) { return /^exec:(stop|start)$|^listen|^close$/.test(e); });
		assert.deepStrictEqual(seq.map(function (e) { return e.replace(/:\d+$/, ''); }),
			['exec:stop', 'listen', 'close', 'exec:start'],
			'the gateway cannot start on a port the updater is still holding: ' + r.events.join(' | '));
	});

	it('gives the port back before restarting the BBS after a failure', async function () {
		var s = scenario();
		var r = recorder();
		var state = await run({ instructions: s.instructions, exec: r.exec(/npm install/), startStatusServer: r.listener() });
		assert.strictEqual(state.status, 'failed');
		var closeAt = r.events.indexOf('close');
		var startAt = r.events.indexOf('exec:start');
		assert.ok(closeAt !== -1 && closeAt < startAt, r.events.join(' | '));
	});

	it('lets go of the port even when a failure leaves the BBS stopped', async function () {
		var s = scenario();
		var r = recorder();
		// Both the install and the restart fail: the BBS stays down, and the
		// port still must not be held by an updater that is about to exit.
		await run({ instructions: s.instructions, exec: r.exec(/npm install|start/), startStatusServer: r.listener() });
		assert.ok(r.events.indexOf('close') !== -1, r.events.join(' | '));
	});

	it('does not take the port when the sysop runs the BBS themselves', async function () {
		var s = scenario({ options: { processControl: false } });
		var r = recorder();
		await run({ instructions: s.instructions, exec: r.exec(), startStatusServer: r.listener() });
		assert.ok(!r.events.some(function (e) { return /^listen/.test(e); }),
			'with nobody to say when the gateway lets go, taking its port could stop it starting');
	});

	it('knows the sysops recorded for this run, and only this run', async function () {
		var s = scenario();
		sysopMod.writeSysopHashes(s.target, ['hash-a', 'hash-b'], s.runId);
		var seen = {};
		await run({ instructions: s.instructions, exec: execStub([]), startStatusServer: recorder().listener(seen) });
		assert.deepStrictEqual(Array.from(seen.opts.sysopHashes).sort(), ['hash-a', 'hash-b']);

		var s2 = scenario();
		sysopMod.writeSysopHashes(s2.target, ['hash-a'], 'some-other-run');
		var seen2 = {};
		await run({ instructions: s2.instructions, exec: execStub([]), startStatusServer: recorder().listener(seen2) });
		assert.strictEqual(seen2.opts.sysopHashes.size, 0);
	});

	it('clears the recorded sysops once the update completes', async function () {
		var s = scenario();
		sysopMod.writeSysopHashes(s.target, ['hash-a'], s.runId);
		await run({ instructions: s.instructions, exec: execStub([]) });
		assert.strictEqual(fs.existsSync(sysopMod.sessionsPath(s.target)), false);
	});

	it('serves the live run state, not a copy from the start', async function () {
		var s = scenario();
		var seen = {};
		var during = null;
		await run({
			instructions: s.instructions,
			startStatusServer: recorder().listener(seen),
			exec: function (command) {
				if (/npm install/.test(command) && seen.opts) {
					during = seen.opts.getState().phases.filter(function (p) { return p.status === 'running'; })[0].name;
				}
				return '';
			}
		});
		assert.strictEqual(during, 'dependencies', 'the page must show the phase the updater is actually in');
		assert.ok(seen.opts.getLog().some(function (l) { return /preflight: .* staged files verified/.test(l); }),
			'and its recent log: ' + seen.opts.getLog().join(' | '));
	});

	it('awaits a command that returns a promise, so the loop stays free', async function () {
		var s = scenario();
		var order = [];
		await run({ instructions: s.instructions, exec: function (command) {
			return new Promise(function (resolve) {
				setTimeout(function () { order.push(command); resolve(''); }, 5);
			});
		} });
		var npm = order.findIndex(function (c) { return /npm install/.test(c); });
		var migrate = order.findIndex(function (c) { return /dbmigrations/.test(c); });
		assert.ok(npm !== -1 && npm < migrate, 'each command finishes before the next starts: ' + order.join(' | '));
	});
});

describe('the final check and npm rewriting the lockfile', function () {
	function lockText(version, extraField) {
		var l = { name: 'canectic-bbs', version: version, lockfileVersion: 3, packages: {
			'': { name: 'canectic-bbs', version: version },
			'node_modules/bindings': { version: '1.5.0', integrity: 'sha512-BBB' }
		} };
		if (extraField) l.packages['node_modules/bindings'].hasInstallScript = true;
		return JSON.stringify(l, null, 2) + '\n';
	}

	it('completes when npm only normalises the lockfile, which is every real update', async function () {
		var s = scenario({ stagedExtra: { 'package-lock.json': lockText('0.9.8a') } });
		var state = await run({ instructions: s.instructions, exec: function (command) {
			if (/npm install/.test(command)) fs.writeFileSync(path.join(s.target, 'package-lock.json'), lockText('0.9.8a', true));
			return '';
		} });
		assert.strictEqual(state.status, 'complete', state.error || JSON.stringify(state.phases));
	});

	it('still fails, naming the file, when npm pins something different', async function () {
		var s = scenario({ stagedExtra: { 'package-lock.json': lockText('0.9.8a') } });
		var state = await run({ instructions: s.instructions, exec: function (command) {
			if (/npm install/.test(command)) {
				fs.writeFileSync(path.join(s.target, 'package-lock.json'), lockText('0.9.8a').replace('1.5.0', '9.9.9'));
			}
			return '';
		} });
		assert.strictEqual(state.status, 'failed');
		assert.strictEqual(phase(state, 'verify').status, 'failed');
		assert.ok(/package-lock\.json/.test(state.error), state.error);
	});
});

describe('the release signature', function () {
	var flags = null;
	before(async function () { flags = await import('../src/maintenance/maintenanceFlag.js'); });

	function sigAs(state, seen) {
		return function (opts) {
			if (seen) seen.opts = opts;
			return { state: state, detail: 'stubbed ' + state };
		};
	}

	it('checks the staged tree against the key the installed board trusts', async function () {
		var s = scenario();
		var seen = {};
		await run({ instructions: s.instructions, exec: execStub([]), verifySignature: sigAs('verified', seen) });
		assert.strictEqual(seen.opts.treeRoot, s.stagedRoot);
		assert.strictEqual(seen.opts.pinFrom, path.join(s.target, 'setup', 'canectic-release.asc'),
			'the pin must come from the INSTALLED board, never from the release being checked');
		assert.strictEqual(seen.opts.keyMaterial, path.join(s.stagedRoot, 'setup', 'canectic-release.asc'));
	});

	it('refuses a bad signature before touching anything, and reopens the board', async function () {
		var s = scenario();
		var ran = [];
		var state = await run({ instructions: s.instructions, exec: execStub(ran), verifySignature: sigAs('bad') });
		assert.strictEqual(state.status, 'failed');
		assert.strictEqual(phase(state, 'preflight').status, 'failed');
		assert.ok(/signature does not check out/.test(state.error), state.error);
		assert.strictEqual(ran.length, 0, 'nothing may run: ' + ran.join(' | '));
		assert.strictEqual(read(s.target, 'src/a.js'), 'OLD');
		assert.strictEqual(flags.isActive(s.target), false);
	});

	it('refuses an unsigned release when the sysop requires signatures', async function () {
		var s = scenario();
		var state = await run({ instructions: s.instructions, exec: execStub([]), verifySignature: sigAs('unsigned'),
			requireSignature: true });
		assert.strictEqual(state.status, 'failed');
		assert.strictEqual(phase(state, 'preflight').status, 'failed');
		assert.ok(/update_require_signature is on/.test(state.error), state.error);
		assert.ok(/Development builds are never signed/.test(state.error), 'it must say why a dev build fails this');
	});

	it('lets an unsigned release through when signatures are not required', async function () {
		var s = scenario();
		var state = await run({ instructions: s.instructions, exec: execStub([]), verifySignature: sigAs('unsigned') });
		assert.strictEqual(state.status, 'complete');
	});
});

// Undermine went from 0.9.6a to 0.9.9a and was told "COMPLETE", with the
// MSGID split still pending: dbmigrations said ACTION NEEDED in the log and
// nothing else did. The text below is what it printed there.
var UNDERMINE_MIGRATIONS = [
	'    --- Migrations (post-schema) ---',
	'    normalised 0 row(s) across 0 of 108 table(s)',
	'      applied: 0006-normalise-body-text',
	'  ACTION NEEDED: 0002-msgid-tuple-split',
	'  Split legacy "address serial" MSGIDs into the msg_id / msg_orig_addr tuple',
	'',
	'      node src/tools/maintenance.js --fix-msgids --dry-run   (report only)',
	'      node src/tools/maintenance.js --fix-msgids             (repair)',
	''
].join('\n');

describe('manual migrations an update does not run', function () {

	it('reads what dbmigrations reported', function () {
		var acts = manualActionsFrom(UNDERMINE_MIGRATIONS);
		assert.strictEqual(acts.length, 1);
		assert.strictEqual(acts[0].id, '0002-msgid-tuple-split');
		assert.ok(/address serial/.test(acts[0].description), acts[0].description);
		assert.deepStrictEqual(acts[0].commands, [
			'node src/tools/maintenance.js --fix-msgids --dry-run (report only)',
			'node src/tools/maintenance.js --fix-msgids (repair)'
		]);
	});

	it('finds nothing when nothing is pending', function () {
		assert.deepStrictEqual(manualActionsFrom('  Nothing pending.\n'), []);
		assert.deepStrictEqual(manualActionsFrom(''), []);
		assert.deepStrictEqual(manualActionsFrom(undefined), []);
	});

	it('reads several in a row', function () {
		var two = UNDERMINE_MIGRATIONS + '\n  ACTION NEEDED: 0009-other\n  Something else\n\n      node x.js\n';
		assert.deepStrictEqual(manualActionsFrom(two).map(function (a) { return a.id; }),
			['0002-msgid-tuple-split', '0009-other']);
	});

	it('says so in the run, where the Update page and --status show it', async function () {
		var s = scenario();
		var exec = function (command) { return /dbmigrations/.test(command) ? UNDERMINE_MIGRATIONS : ''; };
		var state = await run({ instructions: s.instructions, exec: exec });
		assert.strictEqual(state.status, 'complete', state.error || '');
		var w = state.warnings.filter(function (x) { return /action needed/.test(x); })[0];
		assert.ok(w, state.warnings.join('\n'));
		assert.ok(/0002-msgid-tuple-split/.test(w) && /--fix-msgids --dry-run/.test(w), w);
	});
});
