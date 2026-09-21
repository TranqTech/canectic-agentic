// tests/maintenanceWatch.test.js: how a running process follows the flag.
//
// The watcher is what every process relies on to notice the board closing, so
// the properties worth pinning are the ones that fail quietly: an event fired
// twice or not at all, a subscriber that throws and silences the rest, a drain
// source that cannot answer being read as drained, and a timer that keeps the
// process alive after everything else has shut down.
//
// Run: npx mocha --no-config --exit tests/maintenanceWatch.test.js

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as flags from '../src/maintenance/maintenanceFlag.js';
import { MaintenanceWatch } from '../src/maintenance/maintenanceWatch.js';

function tempRoot() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'zz-maintw-'));
}

describe('MaintenanceWatch', function () {
	var root, watch, events;

	beforeEach(function () {
		root = tempRoot();
		events = [];
		watch = new MaintenanceWatch({ process: 'gateway', root: root, intervalMs: 1000000 });
		for (var e of ['enter', 'change', 'leave', 'deadline']) {
			(function (name) { watch.on(name, function () { events.push(name); }); })(e);
		}
	});
	afterEach(function () {
		watch.stop();
		fs.rmSync(root, { recursive: true, force: true });
	});

	it('fires enter once, change on an edit, and leave when cleared', async function () {
		await watch.tick();
		assert.deepStrictEqual(events, []);

		flags.enterMaintenance(root, { reason: 'one', grace_seconds: 600 });
		await watch.tick();
		await watch.tick();
		assert.deepStrictEqual(events, ['enter']);

		flags.enterMaintenance(root, { reason: 'two', grace_seconds: 600 });
		await watch.tick();
		assert.deepStrictEqual(events, ['enter', 'change']);

		flags.leaveMaintenance(root);
		await watch.tick();
		assert.deepStrictEqual(events, ['enter', 'change', 'leave']);
		assert.strictEqual(watch.current().active, false);
	});

	it('fires deadline once when the grace runs out', async function () {
		flags.enterMaintenance(root, { grace_seconds: 0 });
		await watch.tick();
		await watch.tick();
		assert.deepStrictEqual(events, ['enter', 'deadline']);
	});

	it('enters straight away when the process starts on a closed board', async function () {
		// The updater restarts the processes with the flag still set.
		flags.enterMaintenance(root, { grace_seconds: 600 });
		await watch.tick();
		assert.deepStrictEqual(events, ['enter']);
		assert.strictEqual(watch.current().active, true);
	});

	it('keeps notifying the other subscribers when one throws', async function () {
		var reached = false;
		var logged = [];
		var w = new MaintenanceWatch({ process: 'x', root: root, intervalMs: 1000000,
			log: function (lvl, msg) { logged.push(msg); } });
		w.on('enter', function () { throw new Error('broken subsystem'); });
		w.on('enter', function () { reached = true; });
		flags.enterMaintenance(root, { grace_seconds: 600 });
		await w.tick();
		w.stop();
		assert.ok(reached, 'one broken subsystem must not leave the rest of the process open');
		assert.ok(logged.some(function (m) { return m.includes('broken subsystem'); }));
	});

	it('writes a drain status adding up every source', async function () {
		watch.registerDrainSource('terminal', function () { return { 'terminal calls': 2 }; });
		watch.registerDrainSource('toss', async function () { return { 'toss jobs': 1 }; });
		flags.enterMaintenance(root, { grace_seconds: 600 });
		await watch.tick();

		var s = flags.readDrainStatuses(root);
		assert.strictEqual(s.length, 1);
		assert.strictEqual(s[0].process, 'gateway');
		assert.strictEqual(s[0].drained, false);
		assert.deepStrictEqual(s[0].pending, { 'terminal calls': 2, 'toss jobs': 1 });
		assert.strictEqual(s[0].since, flags.readFlag(root).since);
	});

	it('reports drained when every source is at zero', async function () {
		watch.registerDrainSource('terminal', function () { return { 'terminal calls': 0 }; });
		flags.enterMaintenance(root, { grace_seconds: 600 });
		await watch.tick();
		assert.strictEqual(flags.readDrainStatuses(root)[0].drained, true);
	});

	it('does not read a failing source as drained', async function () {
		watch.registerDrainSource('worker', function () { throw new Error('redis down'); });
		flags.enterMaintenance(root, { grace_seconds: 600 });
		await watch.tick();
		var s = flags.readDrainStatuses(root)[0];
		assert.strictEqual(s.drained, false, 'a source that cannot answer might be mid-job');
		assert.ok(Object.keys(s.pending).some(function (k) { return k.includes('unknown'); }));
	});

	it('removes its status file when the board opens', async function () {
		flags.enterMaintenance(root, { grace_seconds: 600 });
		await watch.tick();
		assert.strictEqual(flags.readDrainStatuses(root).length, 1);
		flags.leaveMaintenance(root);
		await watch.tick();
		assert.strictEqual(flags.readDrainStatuses(root).length, 0);
	});

	it('uses the process default grace when the flag has none', async function () {
		var w = new MaintenanceWatch({ process: 'x', root: root, intervalMs: 1000000,
			graceDefault: function () { return 60; } });
		flags.enterMaintenance(root, {});
		w.refreshNow();
		var c = w.current();
		w.stop();
		assert.strictEqual(c.deadline.getTime() - new Date(c.flag.since).getTime(), 60000);
	});

	it('does not keep the process alive', function () {
		var w = new MaintenanceWatch({ process: 'x', root: root, intervalMs: 50 });
		w.start();
		var timer = w._timer;
		w.stop();
		assert.strictEqual(typeof timer.hasRef === 'function' ? timer.hasRef() : false, false,
			'the interval must be unref()d or a process that has shut down everything else hangs');
	});
});
