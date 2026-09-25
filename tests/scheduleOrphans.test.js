// tests/scheduleOrphans.test.js: automatic removal of schedulers with no row
// behind them.
//
// registerSchedules skips a connection whose polling is disabled rather than
// clearing its schedule, and until recently nothing removed one when a
// connection was deleted. Either way the scheduler went on firing its job for
// ever: a poll to a peer that no longer exists, once per interval, indefinitely.
// Five were live on the development box, two of them for connections that had
// been deleted. The only way to find them was to run the diagnostic by hand and
// the only way to clear them was --prune.
//
// Registration now rebuilds the managed set from the database on every gateway
// start and removes anything in a managed family it did not just write.
//
// The dangerous half of that is the allowlist. A sweep that removed everything
// absent from the expected set would delete the daily maintenance schedules,
// which registration writes but which these tests must prove are never
// candidates. That property gets more attention here than the removal itself.
//
// Run: npx mocha

import assert from 'assert';
import { redisAvailable } from './helpers/redisAvailable.js';
import {
	MANAGED_KEY_PREFIXES, isManagedSchedulerKey, orphanSchedulerKeys
} from '../src/utils/scheduleFormat.js';

describe('managed scheduler keys', function () {

	it('recognises every family registration rebuilds from the database', function () {
		var samples = [
			'poll:abc-123',
			'qwk-pull:abc-123',
			'qwk-push:abc-123',
			'nntp-pull:abc-123',
			'nntp-push:abc-123',
			'timed-event:7',
			'generate-stub:2'
		];
		for (var key of samples) {
			assert.ok(isManagedSchedulerKey(key), key + ' should be managed');
		}
		assert.strictEqual(samples.length, MANAGED_KEY_PREFIXES.length,
			'a prefix was added without a sample here, so it is untested');
	});

	it('does not claim the fixed maintenance schedules', function () {
		// These are the ones a careless sweep would delete. Registration writes
		// them unconditionally and never records them as managed keys, so if
		// the predicate ever accepted one, the first gateway restart after that
		// change would silently switch off PM trash purging, tossed packet
		// purging, nodelist scanning and the rest, with a log line that reads
		// like tidying up.
		var fixed = [
			'purge-pm-trash-daily',
			'pm-purged-cleanup-hourly',
			'purge-notifications-daily',
			'purge-tossed-daily',
			'scan-nodelists-daily',
			'purge-bad-echomail-daily',
			'purge-inbound-log-daily',
			'purge-outbound-log-daily',
			'purge-mailer-sessions-daily',
			'purge-relay-log-daily',
			'reconcile-echolists-daily',
			'scan-echolists-daily',
			'rotate-logs-daily',
			'message-maintenance-daily',
			'user-maintenance-daily',
			'scan-inbound',
			'outbound-sweep'
		];
		for (var key of fixed) {
			assert.ok(!isManagedSchedulerKey(key), key + ' must never be prunable');
		}
	});

	it('treats a key that merely contains a prefix as unmanaged', function () {
		// startsWith, not includes. A key such as 'daily-poll:summary' is not a
		// connection schedule and matching it loosely would remove it.
		assert.ok(!isManagedSchedulerKey('daily-poll:summary'));
		assert.ok(!isManagedSchedulerKey('x-timed-event:1'));
	});

	it('handles a missing or odd key without throwing', function () {
		assert.ok(!isManagedSchedulerKey(null));
		assert.ok(!isManagedSchedulerKey(undefined));
		assert.ok(!isManagedSchedulerKey(''));
	});
});

describe('orphanSchedulerKeys', function () {

	it('returns managed keys that registration did not write', function () {
		var registered = ['poll:alive', 'poll:deleted', 'qwk-pull:gone'];
		var expected   = ['poll:alive'];
		assert.deepStrictEqual(
			orphanSchedulerKeys(registered, expected),
			['poll:deleted', 'qwk-pull:gone']);
	});

	it('never returns an unmanaged key, whatever the expected set says', function () {
		// The safety property. An unmanaged key is absent from the expected set
		// by definition, since registration does not record those, so this is
		// the only thing standing between the sweep and the daily jobs.
		var registered = ['purge-pm-trash-daily', 'scan-inbound', 'outbound-sweep'];
		assert.deepStrictEqual(orphanSchedulerKeys(registered, []), []);
	});

	it('accepts a Set as well as an array', function () {
		var out = orphanSchedulerKeys(['poll:a', 'poll:b'], new Set(['poll:a']));
		assert.deepStrictEqual(out, ['poll:b']);
	});

	it('reports every managed key when the expected set is empty', function () {
		// Documents the hazard rather than guarding it: the function cannot
		// tell "nothing is configured" from "the caller failed to build the
		// list", so the caller must not call it unless registration completed.
		// That is why the only call site sits after a pass that did not throw.
		var out = orphanSchedulerKeys(['poll:a', 'timed-event:1'], []);
		assert.deepStrictEqual(out, ['poll:a', 'timed-event:1']);
	});

	it('survives empty and missing input', function () {
		assert.deepStrictEqual(orphanSchedulerKeys([], ['poll:a']), []);
		assert.deepStrictEqual(orphanSchedulerKeys(null, null), []);
	});
});

describe('pruneOrphanSchedules against a real queue', function () {
	this.timeout(20000);

	var available = false;
	var queue = null, schedules = null;
	var QUEUE_NAME = 'zz_test_schedule_prune';
	var ORPHAN   = 'poll:zz-orphan-0000-0000-000000000001';
	var KEEP     = 'poll:zz-keep-0000-0000-000000000002';
	var UNMANAGED = 'zz-test-daily-sweep';

	before(async function () {
		this.timeout(15000);
		try {
			available = await redisAvailable();
			if (!available) return;
			schedules = await import('../src/queues/schedules.js');
			var bull = await import('bullmq');
			var conn = await import('../src/queues/connection.js');
			// Its own queue, so a run against a live system cannot disturb a
			// real schedule. The whole point of the function is that it deletes
			// things.
			queue = new bull.Queue(QUEUE_NAME, { connection: conn.createQueueConnection() });
		} catch (_) { available = false; }
	});

	beforeEach(async function () {
		if (!available) return this.skip();
		for (var key of [ORPHAN, KEEP, UNMANAGED]) {
			await queue.removeJobScheduler(key).catch(function () {});
		}
	});

	after(async function () {
		if (!available || !queue) return;
		for (var key of [ORPHAN, KEEP, UNMANAGED]) {
			try { await queue.removeJobScheduler(key); } catch (_) {}
		}
		try { await queue.obliterate({ force: true }); } catch (_) {}
		try { await queue.close(); } catch (_) {}
	});

	async function keys() {
		var list = await queue.getJobSchedulers(0, 500);
		return list.map(function (s) { return String(s.key || s.id); }).sort();
	}

	it('removes a managed scheduler with no row behind it and leaves the rest', async function () {
		await queue.upsertJobScheduler(ORPHAN, { every: 60000 },
			{ name: 'poll-scheduled', data: { connectionUUID: 'zz-orphan' } });
		await queue.upsertJobScheduler(KEEP, { every: 60000 },
			{ name: 'poll-scheduled', data: { connectionUUID: 'zz-keep' } });
		await queue.upsertJobScheduler(UNMANAGED, { every: 60000 },
			{ name: 'zz-test', data: {} });

		assert.deepStrictEqual(await keys(), [KEEP, ORPHAN, UNMANAGED].sort(),
			'all three should be registered before the sweep');

		var removed = await schedules.pruneOrphanSchedules([KEEP], { test: queue });

		assert.strictEqual(removed, 1, 'exactly the orphan should have gone');
		assert.deepStrictEqual(await keys(), [KEEP, UNMANAGED].sort(),
			'the expected key and the unmanaged one must both survive');
	});

	it('removes nothing when every registered key is expected', async function () {
		await queue.upsertJobScheduler(KEEP, { every: 60000 },
			{ name: 'poll-scheduled', data: { connectionUUID: 'zz-keep' } });

		var removed = await schedules.pruneOrphanSchedules([KEEP], { test: queue });

		assert.strictEqual(removed, 0);
		assert.deepStrictEqual(await keys(), [KEEP]);
	});
});
