// tests/importSeal.test.js: the outbound high water mark seal used by SMB and
// JAM imports.
//
// This file exists because of a silent mail-loss bug on a live hub. The seal
// advanced msg_idx to headIdForShortcode(), which is MAX(id) *as of the seal*,
// not the last row the import wrote. Inbound tossing runs on the toss worker
// while a bulk import runs on the maintenance worker, so ordinary mail lands
// interleaved with imported rows. Sealing to MAX(id) moved msg_idx past that
// mail and it was never sent downstream, with no error anywhere.
//
// The guard is that the seal must never cross a row with imported = false.
// That is what the interleaved fixture below asserts.
//
// Needs a live database. Skips cleanly without one. Everything is created
// under a zz_ shortcode and removed afterwards, so a run against a working
// system cannot disturb it.
// Run: npx mocha --spec tests/importSeal.test.js

import assert from 'assert';
import { dbAvailable } from './helpers/dbAvailable.js';

var SHORTCODE = 'ZZSEALTEST';
var MSGTABLE  = 'mb_zzsealtest_msgs';

describe('import seal (advanceOutboundIdxForArea)', function () {
	this.timeout(30000);

	var available = false;
	var pg = null, msgAreas = null, pas = null;
	var areaId = null, connId = null;

	before(async function () {
		this.timeout(20000);
		try {
			available = await dbAvailable();
			if (!available) return;
			pg       = await import('../src/middleware/db/postgres.js');
			msgAreas = await import('../src/models/msgAreas.js');
			pas      = await import('../src/models/peerAreaSubscriptions.js');

			// A group to hang the area off. Any active one will do.
			var grp = await pg.queryOne('SELECT shortcode FROM message_groups LIMIT 1');
			if (!grp) { available = false; return; }

			// A peer connection to own the subscription. Without one there is
			// nothing for the seal to advance and the suite has no subject.
			var conn = await pg.queryOne('SELECT id FROM peer_connections LIMIT 1');
			if (!conn) { available = false; return; }
			connId = conn.id;

			await msgAreas.removeArea(SHORTCODE, true).catch(function () {});
			var created = await msgAreas.newArea({
				groupshortcode: grp.shortcode,
				name: 'Seal test', description: 'temporary, created by importSeal.test.js',
				shortcode: SHORTCODE, readsecurity: 50, postsecurity: 60,
				createdByName: 'importSeal.test.js'
			});
			if (!created.status) { available = false; return; }
			var area = await msgAreas.getAreaByShortcode(SHORTCODE);
			areaId = area.id;
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
			await msgAreas.removeArea(SHORTCODE, true);
		} catch (_) {}
	});

	// -----------------------------------------------------------------------
	// helpers
	// -----------------------------------------------------------------------

	async function addMsg(imported) {
		var r = await pg.insertObject({
			uuid: crypto.randomUUID(),
			subject: 'seal test', from_user: 'tester', to_user: 'All',
			body_text: 'x', imported: imported,
			system_time: new Date(), created_at: new Date()
		}, MSGTABLE);
		return parseInt(r.insertId);
	}

	async function resetArea() {
		await pg.write('DELETE FROM ' + MSGTABLE);
		await pg.write('DELETE FROM peer_area_subscriptions WHERE area_id = $1', [areaId]);
	}

	async function makeSub(msgIdx) {
		var r = await pg.insertObject({
			peer_connection_id: connId, area_id: areaId,
			allowed: true, enabled: true, msg_idx: msgIdx, created_at: new Date()
		}, 'peer_area_subscriptions');
		return parseInt(r.insertId);
	}

	async function msgIdxOf(subId) {
		var row = await pg.queryOne('SELECT msg_idx FROM peer_area_subscriptions WHERE id = $1', [subId]);
		return row ? parseInt(row.msg_idx) : null;
	}

	// -----------------------------------------------------------------------
	// the regression
	// -----------------------------------------------------------------------

	it('does not seal across mail that arrived while the import was running', async function () {
		await resetArea();

		// three pre-existing rows: the head the import starts from
		var pre = [];
		for (var i = 0; i < 3; i++) pre.push(await addMsg(false));
		var headBefore = pre[pre.length - 1];
		var sub = await makeSub(headBefore);   // peer caught up at import start

		// the import writes rows, real mail lands mid-way, more rows follow
		for (var a = 0; a < 4; a++) await addMsg(true);
		var newMail = await addMsg(false);
		for (var b = 0; b < 4; b++) await addMsg(true);

		var res = await pas.advanceOutboundIdxForArea(areaId, SHORTCODE, headBefore);
		var after = await msgIdxOf(sub);

		assert.ok(after < newMail,
			'seal advanced msg_idx to ' + after + ', crossing mail at id ' + newMail +
			' which would never be sent downstream');
		assert.strictEqual(after, newMail - 1,
			'seal should stop exactly one short of the first non-imported row');
		assert.strictEqual(res.status, true);
	});

	it('seals all the way to the head when everything above the floor is imported', async function () {
		await resetArea();

		var pre = [];
		for (var i = 0; i < 2; i++) pre.push(await addMsg(false));
		var headBefore = pre[pre.length - 1];
		var sub = await makeSub(headBefore);

		var last = 0;
		for (var a = 0; a < 5; a++) last = await addMsg(true);

		await pas.advanceOutboundIdxForArea(areaId, SHORTCODE, headBefore);
		assert.strictEqual(await msgIdxOf(sub), last,
			'with no new mail the seal should reach the area head');
	});

	it('leaves a peer that was already behind at its own position', async function () {
		await resetArea();

		var ids = [];
		for (var i = 0; i < 4; i++) ids.push(await addMsg(false));
		var headBefore = ids[ids.length - 1];

		// this peer is behind: it has only had the first message
		var behind = await makeSub(ids[0]);
		for (var a = 0; a < 3; a++) await addMsg(true);

		await pas.advanceOutboundIdxForArea(areaId, SHORTCODE, headBefore);
		assert.strictEqual(await msgIdxOf(behind), ids[0],
			'a peer below the floor keeps its backlog and must not be sealed forward');
	});

	it('is a no-op on an empty area', async function () {
		await resetArea();
		var sub = await makeSub(0);
		var res = await pas.advanceOutboundIdxForArea(areaId, SHORTCODE, 0);
		assert.strictEqual(res.updated, 0);
		assert.strictEqual(await msgIdxOf(sub), 0);
	});

	it('never moves msg_idx backwards', async function () {
		await resetArea();

		var ids = [];
		for (var i = 0; i < 5; i++) ids.push(await addMsg(true));

		// a peer that is somehow ahead of where the seal would land
		var ahead = await makeSub(ids[4]);
		await pas.advanceOutboundIdxForArea(areaId, SHORTCODE, 0);
		assert.ok(await msgIdxOf(ahead) >= ids[4],
			'seal must not rewind a subscription that is already at or past the head');
	});
});
