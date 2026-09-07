// tests/connectionSchedules.test.js: keeping poll schedules in step with config.
//
// Schedules were only ever written by registerSchedules() at gateway startup.
// updateConnectionSchedule existed, its doc comment said "call from admin routes
// when a connection's poll_interval is changed", and nothing called it. So every
// change a sysop made through the admin UI sat in the database doing nothing
// until the next gateway restart: a poll interval edited from 60 to 240 kept
// polling at whatever it had been, while the peer page showed 240.
//
// The same gap left orphans behind. Registration skips connections with polling
// disabled rather than clearing them, so turning polling off, or deleting a
// connection outright, left its scheduler running forever. Five of them were
// live on the development box when this was written.
//
// These run against a real BullMQ queue, because the thing being tested is
// whether an upsert actually changes an existing scheduler's interval. A mock
// would only prove the call was made.
//
// Run: npx mocha

import assert from 'assert';
import { redisAvailable } from './helpers/redisAvailable.js';

var schedules = null, Queue = null, createQueueConnection = null;

describe('connection poll schedules', function () {
	this.timeout(20000);

	var available = false;
	var queue = null;
	// A uuid shape no real connection will collide with.
	var UUID = 'zz-sched-test-0000-0000-000000000001';
	var KEY = 'poll:' + UUID;

	function ftnConn(over) {
		return Object.assign({
			uuid: UUID, active: true, poll_enabled: true,
			connection_data: { address: '21:1/999', poll_interval: 60, status: 'NORMAL' }
		}, over || {});
	}

	async function schedulerFor(key) {
		var list = await queue.getJobSchedulers(0, 500);
		return list.filter(function (s) { return String(s.key || s.id) === key; })[0] || null;
	}

	before(async function () {
		this.timeout(15000);
		try {
			available = await redisAvailable();
			if (!available) return;
			schedules = await import('../src/queues/schedules.js');
			var bull = await import('bullmq');
			Queue = bull.Queue;
			var conn = await import('../src/queues/connection.js');
			createQueueConnection = conn.createQueueConnection;
			queue = new Queue('mailer', { connection: createQueueConnection() });
			await queue.removeJobScheduler(KEY).catch(function () {});
		} catch (_) { available = false; }
	});

	beforeEach(function () { if (!available) this.skip(); });

	afterEach(async function () {
		if (!available) return;
		try { await queue.removeJobScheduler(KEY); } catch (_) {}
	});

	after(async function () {
		if (!available || !queue) return;
		try { await queue.removeJobScheduler(KEY); } catch (_) {}
		try { await queue.close(); } catch (_) {}
	});

	// -----------------------------------------------------------------------
	// the bug
	// -----------------------------------------------------------------------

	it('registers a schedule at the configured interval', async function () {
		await schedules.updateConnectionSchedule(ftnConn(), 'FTN');
		var s = await schedulerFor(KEY);
		assert.ok(s, 'no scheduler was created');
		assert.strictEqual(s.every, 60 * 60 * 1000);
	});

	it('changes the interval of a schedule that already exists', async function () {
		// The actual reported failure: set to 240, kept running at the old
		// interval. An upsert that does not replace `every` on an existing key
		// would leave the sysop with a setting that reads correct and does
		// nothing, which is worse than an error.
		await schedules.updateConnectionSchedule(ftnConn(), 'FTN');
		await schedules.updateConnectionSchedule(
			ftnConn({ connection_data: { address: '21:1/999', poll_interval: 240 } }), 'FTN');

		var s = await schedulerFor(KEY);
		assert.ok(s);
		assert.strictEqual(s.every, 240 * 60 * 1000,
			'expected 4 hours, got ' + (s.every / 60000) + ' minutes');
	});

	it('does not leave a second scheduler behind when the interval changes', async function () {
		await schedules.updateConnectionSchedule(ftnConn(), 'FTN');
		await schedules.updateConnectionSchedule(
			ftnConn({ connection_data: { poll_interval: 240 } }), 'FTN');

		var list = await queue.getJobSchedulers(0, 500);
		var mine = list.filter(function (s) { return String(s.key || s.id).indexOf(UUID) !== -1; });
		assert.strictEqual(mine.length, 1, 'two schedulers for one connection would double the polling');
	});

	// -----------------------------------------------------------------------
	// the orphans
	// -----------------------------------------------------------------------

	it('removes the schedule when polling is turned off', async function () {
		// registerSchedules skips poll_enabled=false rather than clearing it,
		// so without this the old scheduler runs forever and the peer keeps
		// being called after the sysop switched it off.
		await schedules.updateConnectionSchedule(ftnConn(), 'FTN');
		assert.ok(await schedulerFor(KEY), 'setup failed');

		await schedules.updateConnectionSchedule(ftnConn({ poll_enabled: false }), 'FTN');
		assert.strictEqual(await schedulerFor(KEY), null);
	});

	it('removes the schedule when the connection is deactivated', async function () {
		await schedules.updateConnectionSchedule(ftnConn(), 'FTN');
		await schedules.updateConnectionSchedule(ftnConn({ active: false }), 'FTN');
		assert.strictEqual(await schedulerFor(KEY), null);
	});

	it('removes the schedule when the peer is set to HOLD', async function () {
		// A HOLD peer is passive: it calls us. Continuing to dial it is exactly
		// what HOLD means not to do.
		await schedules.updateConnectionSchedule(ftnConn(), 'FTN');
		await schedules.updateConnectionSchedule(
			ftnConn({ connection_data: { poll_interval: 60, status: 'HOLD' } }), 'FTN');
		assert.strictEqual(await schedulerFor(KEY), null);
	});

	it('removes the schedule outright on request', async function () {
		await schedules.updateConnectionSchedule(ftnConn(), 'FTN');
		await schedules.removeConnectionSchedule(UUID, 'FTN');
		assert.strictEqual(await schedulerFor(KEY), null);
	});

	// -----------------------------------------------------------------------
	// shapes the admin routes can hand it
	// -----------------------------------------------------------------------

	it('falls back to 60 minutes when no interval is configured', async function () {
		await schedules.updateConnectionSchedule(
			ftnConn({ connection_data: { address: '21:1/999' } }), 'FTN');
		var s = await schedulerFor(KEY);
		assert.strictEqual(s.every, 60 * 60 * 1000);
	});

	it('reads an interval stored as a string, which is how forms arrive', async function () {
		await schedules.updateConnectionSchedule(
			ftnConn({ connection_data: { poll_interval: '240' } }), 'FTN');
		var s = await schedulerFor(KEY);
		assert.strictEqual(s.every, 240 * 60 * 1000);
	});

	it('ignores a nonsense interval rather than scheduling a runaway', async function () {
		// parseInt('') and parseInt('abc') are NaN, and NaN || 60 is 60. An
		// every of NaN or 0 would be a poll loop.
		await schedules.updateConnectionSchedule(
			ftnConn({ connection_data: { poll_interval: 'abc' } }), 'FTN');
		var s = await schedulerFor(KEY);
		assert.strictEqual(s.every, 60 * 60 * 1000);
		assert.ok(s.every > 0);
	});

	it('does nothing at all when handed no connection', async function () {
		await assert.doesNotReject(async function () {
			await schedules.updateConnectionSchedule(null, 'FTN');
			await schedules.updateConnectionSchedule({}, 'FTN');
		});
		assert.strictEqual(await schedulerFor(KEY), null);
	});

	it('takes the whole connection row, so a caller cannot forget a condition', function () {
		// The old signature was (uuid, networkType, connectionData, active),
		// which let a caller pass a connection with polling disabled and get a
		// schedule anyway, because active was the only flag it looked at.
		assert.strictEqual(schedules.updateConnectionSchedule.length, 2);
	});
});
