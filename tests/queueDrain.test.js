// tests/queueDrain.test.js: pausing BullMQ consumers when the board closes.
//
// Uses fake consumers shaped like BullMQ's Worker, including the detail that
// matters most: pause() ends the main loop, so isRunning() is false while
// paused. consumerUp() is what keeps that from reading as a dead worker.
//
// Run: npx mocha --no-config --exit tests/queueDrain.test.js

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as flags from '../src/maintenance/maintenanceFlag.js';
import { MaintenanceWatch } from '../src/maintenance/maintenanceWatch.js';
import { attachQueueDrain, consumerUp, startClosed } from '../src/maintenance/queueDrain.js';

function fakeWorker() {
	var w = {
		running: true, paused: false, pauses: 0, resumes: 0,
		isRunning: function () { return w.running; },
		isPaused: function () { return w.paused; },
		pause: async function () { w.pauses++; w.paused = true; w.running = false; },
		resume: async function () { w.resumes++; w.paused = false; w.running = true; }
	};
	return w;
}

function settle() { return new Promise(function (r) { setImmediate(r); }); }

describe('queueDrain', function () {
	var root, watch;
	beforeEach(function () {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-qdrain-'));
		watch = new MaintenanceWatch({ process: 'worker', root: root, intervalMs: 1000000 });
	});
	afterEach(function () {
		watch.stop();
		fs.rmSync(root, { recursive: true, force: true });
	});

	it('pauses every consumer when the board closes and resumes them when it opens', async function () {
		var toss = fakeWorker(), maint = fakeWorker();
		attachQueueDrain(watch, [{ name: 'toss', worker: toss }, { name: 'maintenance', worker: maint }],
			function () { return {}; });

		flags.enterMaintenance(root, { grace_seconds: 600 });
		await watch.tick();
		await settle();
		assert.strictEqual(toss.pauses, 1);
		assert.strictEqual(maint.pauses, 1);

		flags.leaveMaintenance(root);
		await watch.tick();
		await settle();
		assert.strictEqual(toss.resumes, 1);
		assert.strictEqual(maint.resumes, 1);
	});

	it('does not pause twice when the flag is edited', async function () {
		var toss = fakeWorker();
		attachQueueDrain(watch, [{ name: 'toss', worker: toss }], function () { return {}; });
		flags.enterMaintenance(root, { reason: 'a', grace_seconds: 600 });
		await watch.tick();
		flags.enterMaintenance(root, { reason: 'b', grace_seconds: 600 });
		await watch.tick();
		await settle();
		assert.strictEqual(toss.pauses, 1);
	});

	it('reports jobs in flight until they finish', async function () {
		var active = 2;
		attachQueueDrain(watch, [{ name: 'toss', worker: fakeWorker() }],
			function () { return { 'toss jobs': active }; });
		flags.enterMaintenance(root, { grace_seconds: 600 });
		await watch.tick();
		assert.strictEqual(flags.readDrainStatuses(root)[0].drained, false);
		active = 0;
		await watch.tick();
		assert.strictEqual(flags.readDrainStatuses(root)[0].drained, true);
	});

	it('counts a paused consumer as up, and a closed one as down', function () {
		var w = fakeWorker();
		assert.strictEqual(consumerUp(w), true);
		w.running = false; w.paused = true;
		assert.strictEqual(consumerUp(w), true, 'paused for maintenance is not a dead consumer');
		w.paused = false;
		assert.strictEqual(consumerUp(w), false);
		assert.strictEqual(consumerUp(null), false);
	});

	it('knows at startup whether the board is closed', function () {
		assert.strictEqual(startClosed(root), false);
		flags.enterMaintenance(root, {});
		assert.strictEqual(startClosed(root), true);
	});
});
