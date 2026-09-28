// tests/jobDedupe.test.js — a fixed jobId blocks a second job only while the
// first is still to run.
//
// jobs.js gives per-connection and singleton jobs a fixed id so a second
// request is refused while one is active. queue.add() refuses an existing id
// in ANY state, and the queues keep their last 50 to 500 completed jobs, so
// the second request returned the old completed job and nothing ran. Found
// 2026-09-25 building the QWK hub endpoint: a node's second REP upload would
// never have been imported. Also affected: a second `--regen-html`, manual
// QWK/NNTP pulls and pushes, fix-msgids, scan-file-area and the rest.
//
// Run: npx mocha --no-config --exit tests/jobDedupe.test.js

import assert from 'assert';
import { redisAvailable } from './helpers/redisAvailable.js';

describe('addDeduped against a real queue', function () {
	this.timeout(20000);
	var available = false, queue = null, worker = null, jobs = null, ran = 0, release = null;
	var NAME = 'zz_test_job_dedupe';

	before(async function () {
		try {
			available = await redisAvailable();
			if (!available) return;
			jobs = await import('../src/queues/jobs.js');
			var bull = await import('bullmq');
			var conn = await import('../src/queues/connection.js');
			queue = new bull.Queue(NAME, { connection: conn.createQueueConnection(),
				defaultJobOptions: { removeOnComplete: { count: 200 } } });
			// Start empty: a run interrupted mid-test leaves a job stuck active
			// under a fixed id, which the next run would be handed as merged.
			await queue.obliterate({ force: true });
			worker = new bull.Worker(NAME, async function () {
				ran++;
				if (release) await release;
			}, { connection: conn.createQueueConnection() });
		} catch (_) { available = false; }
	});

	after(async function () {
		if (worker) await worker.close();
		if (queue) { try { await queue.obliterate({ force: true }); } catch (_) {} await queue.close(); }
	});

	function settle(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

	async function waitFor(pred) {
		for (var i = 0; i < 50 && !pred(); i++) await settle(100);
	}

	it('runs a second job once the first with the same id has finished', async function () {
		if (!available) return this.skip();
		ran = 0;
		await jobs.addDeduped(queue, 'x', {}, { jobId: 'fixed--one' });
		await waitFor(function () { return ran === 1; });
		await settle(200);
		await jobs.addDeduped(queue, 'x', {}, { jobId: 'fixed--one' });
		await waitFor(function () { return ran === 2; });
		assert.strictEqual(ran, 2, 'the second request did not run');
	});

	it('still refuses a duplicate while the first is running', async function () {
		if (!available) return this.skip();
		ran = 0;
		var open;
		release = new Promise(function (r) { open = r; });
		var first = await jobs.addDeduped(queue, 'x', {}, { jobId: 'fixed--two' });
		await waitFor(function () { return ran === 1; });
		var second = await jobs.addDeduped(queue, 'x', {}, { jobId: 'fixed--two' });
		assert.strictEqual(second.id, first.id);
		// ...and says so, so a caller can report it rather than announce the
		// request as queued (#79).
		assert.strictEqual(second.merged, true);
		assert.strictEqual(second.mergedState, 'active');
		assert.ok(!first.merged, 'a freshly added job is not merged');
		open(); release = null;
		await settle(500);
		assert.strictEqual(ran, 1, 'a duplicate ran alongside the first');
	});

	it('is what every enqueue helper uses', async function () {
		var fs = await import('fs');
		var src = fs.readFileSync(new URL('../src/queues/jobs.js', import.meta.url), 'utf8');
		assert.doesNotMatch(src, /\b(tossQueue|mailerQueue|maintenanceQueue)\.add\(/);
	});
});
