// tests/messageRetention.test.js: per-area message pruning.
//
// Retention deletes messages irreversibly, so the properties worth pinning are
// the ones whose failure is silent:
//
//   - both limits NULL means keep everything, which is what every existing
//     area relies on
//   - age is the message's own date, not when it was received
//   - retention overrides peer high water marks rather than deferring to them,
//     because a downlink that stopped polling must not pin a hub's message base
//     forever; lagging watermarks are dragged forward and the loss reported
//   - a dry run and the real run must select identically, or the preview a
//     sysop makes a decision from is a lie
//   - thread rows must stay honest, because the reader lists threads straight
//     out of the thread table and orders by last_message
//
// Needs a live database. Skips cleanly without one. Everything is created
// under a zz_ shortcode and removed afterwards.
// Run: npx mocha --spec tests/messageRetention.test.js

import assert from 'assert';
import { dbAvailable } from './helpers/dbAvailable.js';

var SHORTCODE = 'ZZRETTEST';
var MSGTABLE  = 'mb_zzrettest_msgs';
var THREADTBL = 'mb_zzrettest_threads';

describe('message retention', function () {
	this.timeout(30000);

	var available = false;
	var pg = null, msgAreas = null, messages = null;
	var areaId = null, connId = null;

	before(async function () {
		this.timeout(20000);
		try {
			available = await dbAvailable();
			if (!available) return;
			pg       = await import('../src/middleware/db/postgres.js');
			msgAreas = await import('../src/models/msgAreas.js');
			messages = await import('../src/models/messages.js');

			var grp = await pg.queryOne('SELECT shortcode FROM message_groups LIMIT 1');
			if (!grp) { available = false; return; }
			var conn = await pg.queryOne('SELECT id FROM peer_connections LIMIT 1');
			connId = conn ? conn.id : null;

			await msgAreas.removeArea(SHORTCODE, true).catch(function () {});
			var created = await msgAreas.newArea({
				groupshortcode: grp.shortcode,
				name: 'Retention test', description: 'temporary, created by messageRetention.test.js',
				shortcode: SHORTCODE, readsecurity: 50, postsecurity: 60,
				createdByName: 'messageRetention.test.js'
			});
			if (!created.status) { available = false; return; }
			areaId = (await msgAreas.getAreaByShortcode(SHORTCODE)).id;
		} catch (_) {
			available = false;
		}
	});

	beforeEach(function () { if (!available) this.skip(); });

	after(async function () {
		this.timeout(20000);
		if (!areaId || !pg) return;
		try {
			await pg.write('DELETE FROM peer_area_subscriptions WHERE area_id = $1', [areaId]);
			await pg.write('DELETE FROM user_thread_pointers WHERE area_shortcode = $1', [SHORTCODE]);
			await msgAreas.removeArea(SHORTCODE, true);
		} catch (_) {}
	});

	// -----------------------------------------------------------------------
	// helpers
	// -----------------------------------------------------------------------

	function daysAgo(n) { return new Date(Date.now() - n * 86400000); }

	// startingCount mirrors what the tossers maintain, so a test can tell the
	// difference between "the pruner recomputed this" and "the pruner left it
	// alone", which is the whole point of the bookkeeping assertions.
	async function addThread(subject, lastDaysAgo, startingCount) {
		var r = await pg.insertObject({
			uuid: crypto.randomUUID(), threadid: 'T' + Math.random(), subject: subject,
			started_at: daysAgo(lastDaysAgo),
			message_count: startingCount === undefined ? 0 : startingCount,
			last_message: daysAgo(lastDaysAgo), last_message_from: 'tester'
		}, THREADTBL);
		return parseInt(r.insertId);
	}

	// systemTime is the message's own date; createdDaysAgo is when we received
	// it. They are deliberately separable so the age-basis test means something.
	async function addMsg(threadRowId, systemDaysAgo, createdDaysAgo) {
		var r = await pg.insertObject({
			uuid: crypto.randomUUID(), thread_id: threadRowId, threadid: 'T',
			msg_id: 'M' + Math.random(), subject: 's', from_user: 'a', to_user: 'All',
			body_text: 'body',
			system_time: daysAgo(systemDaysAgo),
			created_at: daysAgo(createdDaysAgo === undefined ? systemDaysAgo : createdDaysAgo)
		}, MSGTABLE);
		return parseInt(r.insertId);
	}

	async function reset() {
		await pg.write('DELETE FROM ' + MSGTABLE);
		await pg.write('DELETE FROM ' + THREADTBL);
		await pg.write('DELETE FROM peer_area_subscriptions WHERE area_id = $1', [areaId]);
		await pg.write('DELETE FROM user_thread_pointers WHERE area_shortcode = $1', [SHORTCODE]);
		await pg.write('UPDATE message_areas SET max_age_days = NULL, max_messages = NULL WHERE id = $1', [areaId]);
	}

	async function setLimits(ageDays, maxMsgs) {
		await pg.write('UPDATE message_areas SET max_age_days = $1, max_messages = $2 WHERE id = $3',
			[ageDays, maxMsgs, areaId]);
	}

	async function count(table) {
		var r = await pg.queryOne('SELECT COUNT(*)::int AS c FROM ' + table);
		return r ? r.c : 0;
	}

	async function run(opts) {
		return await messages.enforceRetentionLimits(
			Object.assign({ shortcode: SHORTCODE }, opts || {}));
	}

	// -----------------------------------------------------------------------
	// the default
	// -----------------------------------------------------------------------

	it('prunes nothing when both limits are NULL', async function () {
		await reset();
		var t = await addThread('old', 400);
		await addMsg(t, 400); await addMsg(t, 380);

		var res = await run();
		assert.strictEqual(res.areasChecked, 0, 'an area with no limits should not even be examined');
		assert.strictEqual(await count(MSGTABLE), 2, 'nothing may be deleted without an explicit limit');
	});

	it('treats a limit of 0 as no limit rather than "keep none"', async function () {
		await reset();
		var t = await addThread('old', 400);
		await addMsg(t, 400);
		await setLimits(0, 0);

		await run();
		assert.strictEqual(await count(MSGTABLE), 1, '0 must not be read as "delete everything"');
	});

	// -----------------------------------------------------------------------
	// age basis
	// -----------------------------------------------------------------------

	it('measures age by the message date, not the date it was received', async function () {
		await reset();
		var t = await addThread('imported', 400);
		// Written 400 days ago, received today: the shape of a JAM/SMB import.
		await addMsg(t, 400, 0);
		await setLimits(90, null);

		var res = await run({ dryRun: true });
		assert.strictEqual(res.areas[0].messagesRemoved, 1,
			'a message dated 400 days ago is past a 90 day cutoff regardless of when it arrived');
	});

	it('keeps messages inside the age window', async function () {
		await reset();
		var t = await addThread('recent', 5);
		await addMsg(t, 5); await addMsg(t, 3);
		await setLimits(90, null);

		await run();
		assert.strictEqual(await count(MSGTABLE), 2);
	});

	// -----------------------------------------------------------------------
	// count limit
	// -----------------------------------------------------------------------

	it('keeps the N newest when a count limit is set', async function () {
		await reset();
		var t = await addThread('many', 10);
		var ids = [];
		for (var i = 0; i < 6; i++) ids.push(await addMsg(t, 10 - i));
		await setLimits(null, 2);

		await run();
		assert.strictEqual(await count(MSGTABLE), 2);
		var left = await pg.query('SELECT id FROM ' + MSGTABLE + ' ORDER BY id');
		assert.deepStrictEqual(left.map(function (r) { return parseInt(r.id); }), ids.slice(-2),
			'the two newest by id should survive');
	});

	// -----------------------------------------------------------------------
	// the peer floor
	// -----------------------------------------------------------------------

	it('prunes past a lagging peer rather than letting it pin the area', async function () {
		if (!connId) this.skip();
		await reset();
		var t = await addThread('old', 400);
		var ids = [];
		for (var i = 0; i < 5; i++) ids.push(await addMsg(t, 400));

		// A downlink that stopped collecting long ago. Under the old rule this
		// pinned the floor and retention did nothing at all, forever.
		var subRow = await pg.insertObject({
			peer_connection_id: connId, area_id: areaId, allowed: true, enabled: true,
			msg_idx: ids[1], created_at: new Date()
		}, 'peer_area_subscriptions');
		await setLimits(90, null);

		var res = await run();
		var a = res.areas[0];
		assert.strictEqual(a.messagesRemoved, 5, 'retention must not be blocked by a lagging peer');
		assert.strictEqual(await count(MSGTABLE), 0);

		// and the watermark is dragged forward so it no longer points into
		// deleted space
		var after = await pg.queryOne('SELECT msg_idx FROM peer_area_subscriptions WHERE id = $1',
			[subRow.insertId]);
		assert.strictEqual(parseInt(after.msg_idx), ids[4],
			'a watermark below the pruned range should be advanced to the highest pruned id');
		assert.strictEqual(a.peersAdvanced, 1);
	});

	it('reports which peers lose mail, and how much, before deleting anything', async function () {
		if (!connId) this.skip();
		await reset();
		var t = await addThread('old', 400);
		var ids = [];
		for (var i = 0; i < 5; i++) ids.push(await addMsg(t, 400));
		await pg.insertObject({
			peer_connection_id: connId, area_id: areaId, allowed: true, enabled: true,
			msg_idx: ids[1], created_at: new Date()
		}, 'peer_area_subscriptions');
		await setLimits(90, null);

		var res = await run({ dryRun: true });
		var a = res.areas[0];
		assert.strictEqual(await count(MSGTABLE), 5, 'a dry run must not delete');
		assert.strictEqual(a.peersAdvanced, 1);
		assert.strictEqual(a.peersBehind.length, 1);
		assert.strictEqual(a.peersBehind[0].messagesLost, 3,
			'the peer had 2 of 5; the 3 above its mark are what it loses');
		assert.strictEqual(a.peersBehind[0].previousIdx, ids[1]);
	});

	it('leaves watermarks alone when every peer is already past the pruned range', async function () {
		if (!connId) this.skip();
		await reset();
		var t = await addThread('old', 400);
		var ids = [];
		for (var i = 0; i < 3; i++) ids.push(await addMsg(t, 400));

		var subRow = await pg.insertObject({
			peer_connection_id: connId, area_id: areaId, allowed: true, enabled: true,
			msg_idx: ids[2], created_at: new Date()
		}, 'peer_area_subscriptions');
		await setLimits(90, null);

		var res = await run();
		assert.strictEqual(res.areas[0].peersAdvanced, 0, 'a caught-up peer needs no adjustment');
		var after = await pg.queryOne('SELECT msg_idx FROM peer_area_subscriptions WHERE id = $1',
			[subRow.insertId]);
		assert.strictEqual(parseInt(after.msg_idx), ids[2]);
	});

	// -----------------------------------------------------------------------
	// preview honesty
	// -----------------------------------------------------------------------

	it('dry run selects exactly what the real run deletes, and deletes nothing itself', async function () {
		await reset();
		var t1 = await addThread('all old', 400);
		await addMsg(t1, 400); await addMsg(t1, 390);
		var t2 = await addThread('mixed', 2);
		await addMsg(t2, 400); await addMsg(t2, 2);
		await setLimits(90, null);

		var before = await count(MSGTABLE);
		var dry = await run({ dryRun: true });
		assert.strictEqual(await count(MSGTABLE), before, 'a dry run must not delete');

		var real = await run();
		assert.strictEqual(real.areas[0].messagesRemoved, dry.areas[0].messagesRemoved);
		assert.strictEqual(real.areas[0].threadsRemoved, dry.areas[0].threadsRemoved);
	});

	// -----------------------------------------------------------------------
	// thread bookkeeping
	// -----------------------------------------------------------------------

	it('removes emptied threads, keeps partly-pruned ones, and corrects their counts', async function () {
		await reset();
		var tAllOld = await addThread('A all old', 400, 2);
		await addMsg(tAllOld, 400); await addMsg(tAllOld, 390);

		var tMixed = await addThread('B old root, fresh reply', 2, 2);
		await addMsg(tMixed, 400);   // rolls off
		await addMsg(tMixed, 2);     // survives, orphaned, which is normal in FTN

		var tFresh = await addThread('C all fresh', 3, 2);
		await addMsg(tFresh, 5); await addMsg(tFresh, 3);

		await setLimits(90, null);
		var res = await run();

		assert.strictEqual(res.areas[0].messagesRemoved, 3);
		assert.strictEqual(res.areas[0].threadsRemoved, 1, 'only the fully-old thread should go');
		assert.strictEqual(await count(THREADTBL), 2);

		var rows = await pg.query('SELECT subject, message_count FROM ' + THREADTBL + ' ORDER BY id');
		var bySubject = {};
		for (var r of rows) bySubject[r.subject] = parseInt(r.message_count);
		assert.strictEqual(bySubject['B old root, fresh reply'], 1,
			'a thread that lost messages must have message_count recomputed');
		assert.strictEqual(bySubject['C all fresh'], 2,
			'a thread the prune did not touch keeps its existing count');
	});

	it('drops read pointers belonging to threads it removed', async function () {
		await reset();
		var t = await addThread('doomed', 400);
		await addMsg(t, 400);
		await pg.insertObject({
			user_id: 1, area_shortcode: SHORTCODE, thread_id: t,
			scan_pointer: 1, last_read_at: new Date()
		}, 'user_thread_pointers');
		await setLimits(90, null);

		await run();
		var left = await pg.queryOne(
			'SELECT COUNT(*)::int AS c FROM user_thread_pointers WHERE area_shortcode = $1', [SHORTCODE]);
		assert.strictEqual(left.c, 0, 'pointers for deleted threads would otherwise accumulate forever');
	});
});
