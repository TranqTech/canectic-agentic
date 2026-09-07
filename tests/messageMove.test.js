// tests/messageMove.test.js: moving threads and messages between areas.
//
// The rule is about provenance, not re-export. Re-export is the point of
// moving: a thread that now lives in a networked area should reach that
// network. What must not happen is mail that arrived from one network being
// pushed into a different network's echo, republishing someone else's traffic
// under this system's name, which cannot be taken back once tossed.
//
//   locally written  may go anywhere, including a networked area
//   from a network   may only go to a local-only area
//
// A thread is as restricted as its most restricted message, since moving a
// mixed thread into a networked area would republish the network-origin part.
//
// The mechanics need pinning too. Ids are per area and carry high water mark
// meaning, so a moved message must take a fresh one or it lands behind every
// peer's pointer and is never exported. Thread rows live in per-area tables,
// so a moved message cannot keep its old thread_id.
//
// Needs a live database. Skips cleanly without one. ZZ-namespaced, cleaned up.
// Run: npx mocha --spec tests/messageMove.test.js

import assert from 'assert';
import { dbAvailable } from './helpers/dbAvailable.js';

var SRC = 'ZZMOVESRC';
var DST = 'ZZMOVEDST';

describe('message moving', function () {
	this.timeout(40000);

	var available = false;
	var pg = null, messages = null, msgAreas = null;

	before(async function () {
		this.timeout(30000);
		try {
			available = await dbAvailable();
			if (!available) return;
			pg       = await import('../src/middleware/db/postgres.js');
			messages = await import('../src/models/messages.js');
			msgAreas = await import('../src/models/msgAreas.js');

			var grp = await pg.queryOne('SELECT shortcode FROM message_groups LIMIT 1');
			if (!grp) { available = false; return; }

			for (var sc of [SRC, DST]) {
				await msgAreas.removeArea(sc, true).catch(function () {});
				var r = await msgAreas.newArea({
					groupshortcode: grp.shortcode, name: sc, description: 'temporary',
					shortcode: sc, readsecurity: 0, postsecurity: 0,
					createdByName: 'messageMove.test.js'
				});
				if (!r.status) { available = false; return; }
			}
		} catch (_) {
			available = false;
		}
	});

	beforeEach(function () { if (!available) this.skip(); });

	after(async function () {
		this.timeout(30000);
		if (!available) return;
		for (var sc of [SRC, DST]) {
			try {
				await pg.write('DELETE FROM user_thread_pointers WHERE area_shortcode = $1', [sc]);
				await msgAreas.removeArea(sc, true);
			} catch (_) {}
		}
	});

	// -----------------------------------------------------------------------
	// helpers
	// -----------------------------------------------------------------------

	function tbl(sc, kind) { return 'mb_' + sc.toLowerCase() + '_' + kind; }

	async function reset() {
		for (var sc of [SRC, DST]) {
			await pg.write('DELETE FROM ' + tbl(sc, 'msgs'));
			await pg.write('DELETE FROM ' + tbl(sc, 'threads'));
		}
	}

	// sourceNetworkId null means locally written, a number means off the wire.
	async function seedThread(sc, subject, messageCount, sourceNetworkId) {
		var t = await pg.insertObject({
			uuid: crypto.randomUUID(), threadid: 'T' + Math.random(), subject: subject,
			started_at: new Date(), message_count: messageCount,
			last_message: new Date(), last_message_from: 'alice'
		}, tbl(sc, 'threads'));

		var ids = [];
		for (var i = 0; i < messageCount; i++) {
			var m = await pg.insertObject({
				uuid: crypto.randomUUID(), thread_id: t.insertId, threadid: 'T',
				msg_id: 'M' + Math.random(), subject: subject,
				from_user: 'alice', to_user: 'All', body_text: 'body ' + i,
				source_network_id: Array.isArray(sourceNetworkId) ? sourceNetworkId[i] : sourceNetworkId,
				system_time: new Date(), created_at: new Date()
			}, tbl(sc, 'msgs'));
			ids.push(parseInt(m.insertId));
		}

		var threadRow = await pg.queryOne('SELECT uuid FROM ' + tbl(sc, 'threads') + ' WHERE id = $1',
			[t.insertId]);
		return { threadId: t.insertId, threadUUID: threadRow.uuid, msgIds: ids };
	}

	async function count(sc, kind) {
		var r = await pg.queryOne('SELECT COUNT(*)::int AS c FROM ' + tbl(sc, kind));
		return r ? r.c : 0;
	}

	// -----------------------------------------------------------------------
	// the rule
	// -----------------------------------------------------------------------

	describe('canMoveMessageToArea', function () {
		it('lets locally written mail go to a networked area', function () {
			var v = messages.canMoveMessageToArea({ source_network_id: null }, true);
			assert.strictEqual(v.allowed, true, 'it is ours to publish');
		});

		it('lets locally written mail go to a local area', function () {
			assert.strictEqual(messages.canMoveMessageToArea({ source_network_id: null }, false).allowed, true);
		});

		it('refuses network mail into a networked area', function () {
			var v = messages.canMoveMessageToArea({ source_network_id: 3 }, true);
			assert.strictEqual(v.allowed, false,
				'that republishes another network traffic under our name');
			assert.ok(/local area/i.test(v.reason), 'the reason should say what is allowed: ' + v.reason);
		});

		it('allows network mail into a local area', function () {
			assert.strictEqual(messages.canMoveMessageToArea({ source_network_id: 3 }, false).allowed, true,
				'pulling something into a holding area exports nowhere');
		});

		it('treats an absent source_network_id as locally written', function () {
			assert.strictEqual(messages.canMoveMessageToArea({}, true).allowed, true);
			assert.strictEqual(messages.canMoveMessageToArea({ source_network_id: undefined }, true).allowed, true);
		});
	});

	describe('threadOriginSummary', function () {
		it('reports a wholly local thread as local', async function () {
			await reset();
			var t = await seedThread(SRC, 'local', 3, null);
			var o = await messages.threadOriginSummary(t.threadUUID, SRC);
			assert.strictEqual(o.anyFromNetwork, false);
			assert.strictEqual(o.total, 3);
		});

		it('reports a thread with one network message as network origin', async function () {
			// The restrictive case: two local posts and one reply off the wire.
			await reset();
			var t = await seedThread(SRC, 'mixed', 3, [null, 4, null]);
			var o = await messages.threadOriginSummary(t.threadUUID, SRC);
			assert.strictEqual(o.anyFromNetwork, true,
				'a thread is as restricted as its most restricted message');
		});

		it('reports a missing thread rather than throwing', async function () {
			var o = await messages.threadOriginSummary('no-such-uuid', SRC);
			assert.strictEqual(o.found, false);
		});
	});

	// -----------------------------------------------------------------------
	// moving a thread
	// -----------------------------------------------------------------------

	describe('moveThreadToArea', function () {
		it('moves every message and the thread row', async function () {
			await reset();
			var t = await seedThread(SRC, 'movable', 3, null);

			var r = await messages.moveThreadToArea(t.threadUUID, SRC, DST);
			assert.strictEqual(r.status, true, (r.errormessages || []).join(', '));
			assert.strictEqual(r.moved, 3);

			assert.strictEqual(await count(SRC, 'msgs'), 0, 'source messages should be gone');
			assert.strictEqual(await count(SRC, 'threads'), 0, 'and the empty thread row with them');
			assert.strictEqual(await count(DST, 'msgs'), 3);
			assert.strictEqual(await count(DST, 'threads'), 1);
		});

		it('gives moved messages fresh ids in the destination', async function () {
			// Ids carry outbound high water mark meaning per area. Reusing one
			// would put the message behind every peer pointer and it would
			// never be exported, which is the opposite of why you moved it.
			await reset();
			// Push the destination sequence well past the source.
			var filler = await seedThread(DST, 'filler', 5, null);
			var t = await seedThread(SRC, 'movable', 2, null);
			await messages.moveThreadToArea(t.threadUUID, SRC, DST);

			var moved = await pg.query('SELECT id FROM ' + tbl(DST, 'msgs') +
				" WHERE subject = 'movable' ORDER BY id");
			assert.strictEqual(moved.length, 2,
				'nothing moved, so the id assertion below would pass vacuously');
			var maxFiller = Math.max.apply(null, filler.msgIds);
			for (var row of moved) {
				assert.ok(parseInt(row.id) > maxFiller,
					'moved message id ' + row.id + ' should sit above the destination head ' + maxFiller);
			}
		});

		it('points moved messages at the new thread row, not the old one', async function () {
			await reset();
			var t = await seedThread(SRC, 'movable', 2, null);
			await messages.moveThreadToArea(t.threadUUID, SRC, DST);

			var newThread = await pg.queryOne('SELECT id FROM ' + tbl(DST, 'threads') + ' LIMIT 1');
			var msgs = await pg.query('SELECT thread_id FROM ' + tbl(DST, 'msgs'));
			assert.strictEqual(msgs.length, 2,
				'nothing moved, so the loop below would pass vacuously');
			for (var m of msgs) {
				assert.strictEqual(parseInt(m.thread_id), parseInt(newThread.id),
					'a thread_id from the source table means nothing here');
			}
		});

		it('refuses a move to the same area', async function () {
			await reset();
			var t = await seedThread(SRC, 'same', 1, null);
			var r = await messages.moveThreadToArea(t.threadUUID, SRC, SRC);
			assert.strictEqual(r.status, false);
		});

		it('reports a missing thread rather than throwing', async function () {
			var r = await messages.moveThreadToArea('no-such-uuid', SRC, DST);
			assert.strictEqual(r.status, false);
			assert.ok((r.errormessages || []).join(' ').match(/not found/i));
		});
	});

	// -----------------------------------------------------------------------
	// moving one message
	// -----------------------------------------------------------------------

	describe('moveMessageToArea', function () {
		it('moves the message and leaves the rest of the thread behind', async function () {
			await reset();
			var t = await seedThread(SRC, 'partial', 3, null);
			var victim = await pg.queryOne('SELECT uuid FROM ' + tbl(SRC, 'msgs') +
				' WHERE id = $1', [t.msgIds[1]]);

			var r = await messages.moveMessageToArea(victim.uuid, SRC, DST);
			assert.strictEqual(r.status, true, (r.errormessages || []).join(', '));

			assert.strictEqual(await count(SRC, 'msgs'), 2, 'the other two stay put');
			assert.strictEqual(await count(DST, 'msgs'), 1);
			assert.strictEqual(await count(SRC, 'threads'), 1, 'the source thread survives');
		});

		it('recounts the source thread after taking a message out of it', async function () {
			await reset();
			var t = await seedThread(SRC, 'recount', 3, null);
			var victim = await pg.queryOne('SELECT uuid FROM ' + tbl(SRC, 'msgs') +
				' WHERE id = $1', [t.msgIds[0]]);

			await messages.moveMessageToArea(victim.uuid, SRC, DST);
			var th = await pg.queryOne('SELECT message_count FROM ' + tbl(SRC, 'threads') +
				' WHERE id = $1', [t.threadId]);
			assert.strictEqual(parseInt(th.message_count), 2,
				'a stale count leaves the thread list lying about its size');
		});

		it('removes the source thread when the last message leaves it', async function () {
			await reset();
			var t = await seedThread(SRC, 'only', 1, null);
			var victim = await pg.queryOne('SELECT uuid FROM ' + tbl(SRC, 'msgs') + ' LIMIT 1');

			await messages.moveMessageToArea(victim.uuid, SRC, DST);
			assert.strictEqual(await count(SRC, 'threads'), 0,
				'an empty thread row would show as a thread with nothing in it');
			assert.strictEqual(await count(DST, 'msgs'), 1);
		});

		it('threads the message in the destination rather than orphaning it', async function () {
			await reset();
			var t = await seedThread(SRC, 'threadme', 1, null);
			var victim = await pg.queryOne('SELECT uuid FROM ' + tbl(SRC, 'msgs') + ' LIMIT 1');

			await messages.moveMessageToArea(victim.uuid, SRC, DST);
			var moved = await pg.queryOne('SELECT thread_id FROM ' + tbl(DST, 'msgs') + ' LIMIT 1');
			assert.ok(moved.thread_id, 'every message must belong to a thread');

			var th = await pg.queryOne('SELECT id FROM ' + tbl(DST, 'threads') +
				' WHERE id = $1', [moved.thread_id]);
			assert.ok(th, 'and that thread has to actually exist in this area');
		});

		it('refuses a move to the same area', async function () {
			await reset();
			await seedThread(SRC, 'same', 1, null);
			var victim = await pg.queryOne('SELECT uuid FROM ' + tbl(SRC, 'msgs') + ' LIMIT 1');
			var r = await messages.moveMessageToArea(victim.uuid, SRC, SRC);
			assert.strictEqual(r.status, false);
		});
	});
});

describe('threadMessage guarantee', function () {
	this.timeout(30000);

	var available = false;
	var pg = null, messages = null, msgAreas = null;
	var SC = 'ZZTHREADGUARD';

	before(async function () {
		this.timeout(20000);
		try {
			available = await dbAvailable();
			if (!available) return;
			pg       = await import('../src/middleware/db/postgres.js');
			messages = await import('../src/models/messages.js');
			msgAreas = await import('../src/models/msgAreas.js');
			var grp = await pg.queryOne('SELECT shortcode FROM message_groups LIMIT 1');
			if (!grp) { available = false; return; }
			await msgAreas.removeArea(SC, true).catch(function () {});
			var r = await msgAreas.newArea({
				groupshortcode: grp.shortcode, name: SC, description: 'temporary',
				shortcode: SC, readsecurity: 0, postsecurity: 0, createdByName: 'messageMove.test.js'
			});
			if (!r.status) available = false;
		} catch (_) { available = false; }
	});

	beforeEach(function () { if (!available) this.skip(); });

	after(async function () {
		this.timeout(20000);
		if (!available) return;
		try { await msgAreas.removeArea(SC, true); } catch (_) {}
	});

	// The documented contract is that every message gets a thread, never NULL.
	// Step A used to return early whether or not the pre-assigned threadid
	// matched anything here, so content arriving from elsewhere came back
	// orphaned and never appeared in the thread list, which lists threads and
	// then looks up their messages. Moves always hit this; rethreadAreas can.
	it('creates a thread when a pre-assigned threadid is not present in this area', async function () {
		var msgs = 'mb_' + SC.toLowerCase() + '_msgs';
		var threads = 'mb_' + SC.toLowerCase() + '_threads';
		await pg.write('DELETE FROM ' + msgs);
		await pg.write('DELETE FROM ' + threads);

		var placed = await messages.threadMessage({
			uuid: crypto.randomUUID(), threadid: 'no-such-thread-here',
			subject: 'orphan risk', from_user: 'alice', to_user: 'All',
			body_text: 'x', system_time: new Date(), created_at: new Date()
		}, msgs, threads, SC.toLowerCase());

		assert.ok(placed.thread_id, 'threadMessage must never hand back a message with no thread');

		var row = await pg.queryOne('SELECT id, threadid FROM ' + threads + ' WHERE id = $1',
			[placed.thread_id]);
		assert.ok(row, 'and the thread it named has to exist');
		assert.strictEqual(row.threadid, 'no-such-thread-here',
			'the identity the caller assigned should survive rather than being regenerated');
	});

	it('still reuses an existing thread with that threadid', async function () {
		var msgs = 'mb_' + SC.toLowerCase() + '_msgs';
		var threads = 'mb_' + SC.toLowerCase() + '_threads';
		await pg.write('DELETE FROM ' + msgs);
		await pg.write('DELETE FROM ' + threads);

		var existing = await pg.insertObject({
			uuid: crypto.randomUUID(), threadid: 'shared-id', subject: 'existing',
			started_at: new Date(), message_count: 1,
			last_message: new Date(), last_message_from: 'bob'
		}, threads);

		var placed = await messages.threadMessage({
			uuid: crypto.randomUUID(), threadid: 'shared-id', subject: 'reply',
			from_user: 'alice', to_user: 'All', body_text: 'x',
			system_time: new Date(), created_at: new Date()
		}, msgs, threads, SC.toLowerCase());

		assert.strictEqual(parseInt(placed.thread_id), parseInt(existing.insertId),
			'a matching threadid should still join the existing thread, not make a second one');
	});
});
