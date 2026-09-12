// tests/scheduleFormat.test.js: reading a frozen schedule for what it is.
//
// A BullMQ job scheduler looks like a timer and is not one. The next iteration
// is created when a worker picks up the current delayed job, so a worker that
// is dead, or alive but wedged, freezes every schedule at the point it stopped
// while the registered intervals still read as perfectly correct.
//
// The diagnostics tool printed only those intervals, so a hub whose tosser had
// not run in four days produced output indistinguishable from a healthy one.
// The arithmetic that separates the two lives here.
//
// Run: npx mocha

import assert from 'assert';

var sf = null;
try { sf = await import('../src/utils/scheduleFormat.js'); } catch (_) { /* suites skip */ }

describe('scheduleFormat.describeNext', function () {
	before(function () { if (!sf) this.skip(); });

	var NOW = 1_700_000_000_000;

	it('reads a future run as time remaining', function () {
		var d = sf.describeNext(NOW + 300000, NOW, 120000);
		assert.strictEqual(d.late, false);
		assert.ok(/^in /.test(d.text));
	});

	it('does not call ordinary jitter late', function () {
		// A busy worker running a few seconds behind a one minute schedule is
		// normal operation. Flagging that would make the flag worthless.
		var d = sf.describeNext(NOW - 5000, NOW, 120000);
		assert.strictEqual(d.late, false);
		assert.strictEqual(d.lateMs, 5000);
	});

	it('flags a run that is overdue past the grace window', function () {
		var d = sf.describeNext(NOW - 4 * 86400000, NOW, 120000);
		assert.strictEqual(d.late, true);
		assert.ok(/overdue/.test(d.text));
	});

	it('treats a scheduler with no next run as unknown rather than late', function () {
		// One registered a moment ago has not been assigned one yet.
		var d = sf.describeNext(undefined, NOW, 120000);
		assert.strictEqual(d.late, false);
		assert.strictEqual(d.text, 'unknown');
	});
});

describe('scheduleFormat.lateSchedulers', function () {
	before(function () { if (!sf) this.skip(); });

	var NOW = 1_700_000_000_000;

	it('returns the worst offender first', function () {
		var late = sf.lateSchedulers([
			{ key: 'a', next: NOW - 600000 },
			{ key: 'b', next: NOW - 4 * 86400000 },
			{ key: 'c', next: NOW + 60000 }
		], NOW, 120000);

		assert.strictEqual(late.length, 2);
		assert.strictEqual(late[0].key, 'b');
	});

	it('ignores entries with no next run', function () {
		assert.strictEqual(sf.lateSchedulers([{ key: 'a' }, {}, null], NOW, 120000).length, 0);
	});
});

describe('scheduleFormat.stalledJobs', function () {
	before(function () { if (!sf) this.skip(); });

	var NOW = 1_700_000_000_000;

	it('finds a job that has held its slot far past the timeout', function () {
		// This is the shape that took the pipeline down: the job is active, its
		// lock is being renewed, and BullMQ's stalled detection is satisfied
		// because the process holding it is alive.
		var stuck = sf.stalledJobs([
			{ id: '1', name: 'ftn:inbound', processedOn: NOW - 4 * 86400000 },
			{ id: '2', name: 'ftn:outbound', processedOn: NOW - 1000 }
		], NOW, 30 * 60 * 1000);

		assert.strictEqual(stuck.length, 1);
		assert.strictEqual(stuck[0].id, '1');
	});

	it('leaves a legitimately long job alone', function () {
		var stuck = sf.stalledJobs(
			[{ id: '1', name: 'nodelist-import', processedOn: NOW - 5 * 60 * 1000 }],
			NOW, 30 * 60 * 1000);
		assert.strictEqual(stuck.length, 0);
	});

	it('ignores a job that has not started', function () {
		assert.strictEqual(sf.stalledJobs([{ id: '1', name: 'x' }], NOW, 1000).length, 0);
	});
});

describe('scheduleFormat.summariseCounts', function () {
	before(function () { if (!sf) this.skip(); });

	it('folds paused jobs into the waiting count', function () {
		// Jobs in a paused queue are waiting from the sysop's point of view;
		// reporting zero waiting on a paused queue reads as "nothing to do".
		var c = sf.summariseCounts({ waiting: 2, paused: 5, active: 1, delayed: 3, failed: 0 });
		assert.strictEqual(c.waiting, 7);
	});

	it('survives a counts object with fields missing', function () {
		var c = sf.summariseCounts({});
		assert.strictEqual(c.waiting, 0);
		assert.strictEqual(c.active, 0);
	});
});

describe('scheduleFormat.formatDuration', function () {
	before(function () { if (!sf) this.skip(); });

	it('scales from seconds to days', function () {
		assert.strictEqual(sf.formatDuration(45000), '45s');
		assert.strictEqual(sf.formatDuration(90000), '1m 30s');
		assert.strictEqual(sf.formatDuration(3 * 3600000), '3h 0m');
		assert.strictEqual(sf.formatDuration(4 * 86400000), '4d 0h');
	});
});
