// tests/workerHealth.test.js: noticing that the worker has stopped working.
//
// The worker owns both the toss and the maintenance queue and nothing else
// drains them, so losing it stops the whole message pipeline. Nothing said so.
// A hub went four days without tossing while pm2 reported the process online
// for the entire period: the process was alive, its event loop was turning, and
// every concurrency slot was held by a job that would never return.
//
// That is why "is the process up" is not the question these tests are about.
// BullMQ's own stalled-job detection does not cover it either, because a job
// parked on an await that never settles renews its lock exactly like a healthy
// one, so BullMQ considers it fine while the slot is gone for good.
//
// The escalation rules matter as much as the detection. A watchdog that
// restarts too eagerly is worse than the outage it chases, so the grace window,
// the cooldown and the attempt cap are all tested for the case where they must
// refuse to act.
//
// Run: npx mocha

import assert from 'assert';

var wh = null;
try { wh = await import('../src/queues/workerHealth.js'); } catch (_) { /* suites skip */ }

describe('workerHealth.assessWorker', function () {
	before(function () { if (!wh) this.skip(); });

	var NOW = 1_700_000_000_000;

	function healthy(over) {
		return wh.buildHeartbeat(Object.assign({
			pid: 4242, host: 'hub', startedAt: NOW - 3600000, ts: NOW,
			toss:  { running: true, paused: false, active: 0 },
			maint: { running: true, paused: false, active: 0 },
			lastJobAt: NOW - 5000
		}, over || {}));
	}

	it('passes a worker that is beating with both consumers up', function () {
		var a = wh.assessWorker(healthy(), NOW, {});
		assert.strictEqual(a.state, wh.STATE_OK);
		assert.strictEqual(a.alarm, false);
	});

	it('reports a missing heartbeat as an alarm', function () {
		var a = wh.assessWorker(null, NOW, {});
		assert.strictEqual(a.state, wh.STATE_MISSING);
		assert.strictEqual(a.alarm, true);
	});

	it('does not alarm on a worker that was stopped deliberately', function () {
		// A sysop running `pm2 stop worker` during maintenance must not be
		// fought by the watchdog restarting it underneath them.
		var a = wh.assessWorker(healthy({ state: wh.STATE_STOPPED }), NOW, {});
		assert.strictEqual(a.state, wh.STATE_STOPPED);
		assert.strictEqual(a.alarm, false);
	});

	it('reports a beat that has gone quiet as stale', function () {
		var a = wh.assessWorker(healthy({ ts: NOW - 600000 }), NOW, { staleMs: 180000 });
		assert.strictEqual(a.state, wh.STATE_STALE);
		assert.strictEqual(a.alarm, true);
	});

	it('accepts a beat that is merely late but inside the window', function () {
		var a = wh.assessWorker(healthy({ ts: NOW - 60000 }), NOW, { staleMs: 180000 });
		assert.strictEqual(a.state, wh.STATE_OK);
	});

	it('catches a live process whose queue consumer has closed', function () {
		// The process is beating happily. Nothing outside it can tell that the
		// BullMQ worker is no longer consuming, and it does not make the
		// process exit non-zero, so the supervisor sees nothing wrong.
		var a = wh.assessWorker(healthy({ toss: { running: false, paused: false, active: 0 } }), NOW, {});
		assert.strictEqual(a.state, wh.STATE_UNHEALTHY);
		assert.strictEqual(a.alarm, true);
		assert.ok(/toss=down/.test(a.detail));
	});

	it('catches the four day case: beating, consumers up, job stuck forever', function () {
		var a = wh.assessWorker(healthy({ longestActiveMs: 4 * 86400000 }), NOW,
			{ stallMs: 30 * 60 * 1000 });
		assert.strictEqual(a.state, wh.STATE_UNHEALTHY);
		assert.strictEqual(a.alarm, true);
		assert.ok(/active for 4d/.test(a.detail));
	});

	it('leaves a long but legitimate job alone', function () {
		// A nodelist import or an echolist batch subscribe runs for minutes.
		var a = wh.assessWorker(healthy({ longestActiveMs: 5 * 60 * 1000 }), NOW,
			{ stallMs: 30 * 60 * 1000 });
		assert.strictEqual(a.state, wh.STATE_OK);
	});
});

describe('workerHealth.shouldAttemptRestart', function () {
	before(function () { if (!wh) this.skip(); });

	var NOW = 1_700_000_000_000;
	var ALARM = { state: 'stale', alarm: true, detail: 'no beat' };
	var OPTS = { enabled: true, graceMs: 180000, cooldownMs: 300000, maxAttempts: 3 };

	it('refuses when the feature is switched off', function () {
		var d = wh.shouldAttemptRestart(ALARM, { failingSince: NOW - 999999 }, NOW,
			Object.assign({}, OPTS, { enabled: false }));
		assert.strictEqual(d.restart, false);
	});

	it('refuses while the worker is healthy', function () {
		var d = wh.shouldAttemptRestart({ alarm: false }, {}, NOW, OPTS);
		assert.strictEqual(d.restart, false);
	});

	it('refuses on the first failing check', function () {
		// A worker that is itself restarting looks briefly identical to one
		// that has died. Acting on the first tick would restart it mid-start.
		var d = wh.shouldAttemptRestart(ALARM, { failingSince: null }, NOW, OPTS);
		assert.strictEqual(d.restart, false);
		assert.ok(/grace/.test(d.reason));
	});

	it('refuses while still inside the grace window', function () {
		var d = wh.shouldAttemptRestart(ALARM, { failingSince: NOW - 60000 }, NOW, OPTS);
		assert.strictEqual(d.restart, false);
	});

	it('acts once the fault has outlived the grace window', function () {
		var d = wh.shouldAttemptRestart(ALARM, { failingSince: NOW - 240000 }, NOW, OPTS);
		assert.strictEqual(d.restart, true);
	});

	it('refuses a second attempt inside the cooldown', function () {
		var d = wh.shouldAttemptRestart(ALARM,
			{ failingSince: NOW - 600000, attempts: 1, lastAttemptAt: NOW - 60000 }, NOW, OPTS);
		assert.strictEqual(d.restart, false);
		assert.ok(/cooling down/.test(d.reason));
	});

	it('gives up rather than looping once the attempt cap is reached', function () {
		var d = wh.shouldAttemptRestart(ALARM,
			{ failingSince: NOW - 9999999, attempts: 3, lastAttemptAt: NOW - 9999999 }, NOW, OPTS);
		assert.strictEqual(d.restart, false);
		assert.ok(/gave up/.test(d.reason));
	});
});

describe('workerHealth.resolveRestartCommand', function () {
	before(function () { if (!wh) this.skip(); });

	var path = null;
	before(async function () { path = await import('path'); });

	it('resolves a bare pm2 next to the running node binary', function () {
		// Under nvm the pm2 daemon may have been started from a login shell
		// whose PATH the gateway never inherited, so a bare `pm2` can fail
		// even though pm2 is what is supervising us. pm2 installs alongside
		// the node running it, and deriving from process.execPath obeys the
		// rule against hardcoding an interpreter path.
		var out = wh.resolveRestartCommand('pm2 restart worker',
			'/home/u/.nvm/versions/node/v26.8.1/bin/node',
			function (p) { return p === '/home/u/.nvm/versions/node/v26.8.1/bin/pm2'; },
			path);
		assert.strictEqual(out, '/home/u/.nvm/versions/node/v26.8.1/bin/pm2 restart worker');
	});

	it('leaves the bare command alone when no sibling pm2 exists', function () {
		var out = wh.resolveRestartCommand('pm2 restart worker', '/usr/bin/node',
			function () { return false; }, path);
		assert.strictEqual(out, 'pm2 restart worker');
	});

	it('does not touch a command that is not pm2', function () {
		// Sysops supervising with systemd point the config elsewhere.
		var cmd = 'systemctl --user restart canectic-worker';
		assert.strictEqual(
			wh.resolveRestartCommand(cmd, '/usr/bin/node', function () { return true; }, path), cmd);
	});
});

describe('workerHealth.buildHeartbeat', function () {
	before(function () { if (!wh) this.skip(); });

	it('defaults both consumers to down rather than up', function () {
		// A default of "running" would make a half-built heartbeat read as
		// healthy, which is the one direction this must never fail in.
		var hb = wh.buildHeartbeat({});
		assert.strictEqual(hb.toss.running, false);
		assert.strictEqual(hb.maint.running, false);
	});
});

describe('workerHealth.withTimeout', function () {
	before(function () { if (!wh) this.skip(); });

	it('rejects a job that never settles, so the slot comes back', function (done) {
		// The failure this exists for: BullMQ has no per-job timeout, so an
		// await that never returns keeps its concurrency slot for ever. Three
		// of these and the toss queue stops moving with nothing logged.
		var never = function () { return new Promise(function () {}); };
		var wrapped = wh.withTimeout(never, 40, 'toss_job_timeout');

		wrapped({ id: '1' }).then(
			function () { done(new Error('a job that never settles must not resolve')); },
			function (err) {
				assert.ok(/minute limit/.test(err.message));
				assert.ok(/toss_job_timeout/.test(err.message));
				done();
			}
		);
	});

	it('lets a job that finishes in time through untouched', async function () {
		var wrapped = wh.withTimeout(async function () { return 'done'; }, 5000, 'x');
		assert.strictEqual(await wrapped({ id: '1' }), 'done');
	});

	it('passes a job failure through rather than swallowing it', async function () {
		var wrapped = wh.withTimeout(async function () { throw new Error('toss failed'); }, 5000, 'x');
		await assert.rejects(wrapped({ id: '1' }), /toss failed/);
	});

	it('disables the limit when it is set to zero', async function () {
		// A sysop who would rather have a hung job than a killed one.
		var wrapped = wh.withTimeout(async function () { return 'ok'; }, 0, 'x');
		assert.strictEqual(await wrapped({ id: '1' }), 'ok');
	});

	it('clears its timer once the job has finished', async function () {
		// A pending timer per completed job keeps the event loop alive and, on
		// a busy queue, piles up.
		var before = process._getActiveHandles ? process._getActiveHandles().length : null;
		if (before === null) this.skip();

		var wrapped = wh.withTimeout(async function () { return 1; }, 600000, 'x');
		for (var i = 0; i < 20; i++) await wrapped({ id: String(i) });

		assert.ok(process._getActiveHandles().length <= before + 2,
			'timers from finished jobs are still holding the loop open');
	});
});
