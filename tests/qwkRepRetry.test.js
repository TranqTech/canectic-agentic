// tests/qwkRepRetry.test.js: a REP retried after a failed upload is committed
// when it is delivered, and not sent again (#77).
//
// pushToQwkPeer left a REP on disk when its upload failed and uploaded it at
// the next push, but committed nothing when it did: the subscription pointer
// stayed put and the private mail stayed pending, so the push after that built
// the same messages into a new REP and the hub got them twice.
//
// Run for real over the directory transport. Fixture: a throwaway QWK network
// (zzqwkreptest), our address ZZRRLOCAL, a client link to hub ZZRRHUB with an
// area on conference 902 holding one local message, and one pending PM; all
// removed afterwards.

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { dbAvailable } from './helpers/dbAvailable.js';

describe('a REP retried after a failed upload (#77)', function () {
	this.timeout(60000);

	var DOMAIN = 'zzqwkreptest', AREA = 'ZZREPA';
	var available = false;
	var pg, peers, peerConnections, msgNetworks, systemAddresses, msgAreas, qwkTosser;
	var hubUuid, hubConnId, networkId, outbox, msgId, pmId;
	var CWD = process.cwd();

	async function cleanup() {
		var nets = await pg.query('SELECT id FROM message_networks WHERE domain = $1', [DOMAIN]);
		for (var n of nets || []) {
			var cs = await pg.query('SELECT id, uuid FROM peer_connections WHERE network_id = $1', [n.id]);
			for (var c of cs || []) {
				await pg.write('DELETE FROM peer_area_subscriptions WHERE peer_connection_id = $1', [c.id]);
				await pg.write('DELETE FROM network_transfers WHERE connection_uuid = $1', [c.uuid]).catch(function () {});
				await pg.write('DELETE FROM peer_connections WHERE id = $1', [c.id]);
			}
			await pg.write('DELETE FROM network_areas WHERE network_id = $1', [n.id]);
			await pg.write('DELETE FROM system_addresses WHERE network_id = $1', [n.id]);
			await pg.write('DELETE FROM message_networks WHERE id = $1', [n.id]);
		}
		await msgAreas.removeArea(AREA, true).catch(function () {});
		await pg.write("DELETE FROM peers WHERE name = 'ZZ QWK REP Test Peer'");
		await pg.write("DELETE FROM pm_outbox WHERE subject = 'zz rep retry pm'");
		fs.rmSync(path.join(CWD, 'qnet', 'ZZRRHUB.hub'), { recursive: true, force: true });
		if (outbox) fs.rmSync(outbox, { recursive: true, force: true });
	}

	before(async function () {
		try {
			available = await dbAvailable();
			if (!available) return;
			pg              = await import('../src/middleware/db/postgres.js');
			peers           = await import('../src/models/peers.js');
			peerConnections = await import('../src/models/peerConnections.js');
			msgNetworks     = await import('../src/models/msgNetworks.js');
			systemAddresses = await import('../src/models/systemAddresses.js');
			msgAreas        = await import('../src/models/msgAreas.js');
			qwkTosser       = await import('../src/middleware/tossers/qwkTosser.js');
			await cleanup();
			outbox = fs.mkdtempSync(path.join(os.tmpdir(), 'zzrep-'));
			var grp = await pg.queryOne('SELECT shortcode FROM message_groups LIMIT 1');
			var n = await msgNetworks.newNetwork({ name: 'ZZ QWK REP Test', domain: DOMAIN, description: 'temporary', network_type: 'QWK' });
			if (!grp || !n.status) { available = false; return; }
			networkId = n.insertId;
			await systemAddresses.newAddress({ network_id: networkId, address: 'ZZRRLOCAL' });
			var a = await msgAreas.newArea({ groupshortcode: grp.shortcode, name: 'ZZ rep area', description: 'temporary',
				shortcode: AREA, readsecurity: 50, postsecurity: 60, network_id: networkId, areatag: '902', createdByName: 'qwkRepRetry.test.js' });
			if (!a.status) { available = false; return; }
			var p = await peers.newPeer({ name: 'ZZ QWK REP Test Peer', sysop_name: 'ZZ Test' });
			// The first upload fails: its outbox is under a regular file, so the
			// directory transport cannot create it.
			fs.writeFileSync(path.join(outbox, 'blocker'), 'x');
			var c = await peerConnections.newConnection({ peer_id: p.insertId, network_id: networkId, connection_type: 'QWK',
				transport: 'directory', remote_qwk_id: 'ZZRRHUB', remote_outbox: path.join(outbox, 'blocker', 'no') + '/',
				remote_inbox: outbox + '/' });
			if (!c.status) { available = false; return; }
			hubUuid = c.insertUUID; hubConnId = c.insertId;
			await pg.write('UPDATE peer_area_subscriptions SET enabled = true, msg_idx = 0 WHERE peer_connection_id = $1', [hubConnId]);
			var m = await pg.queryOne("INSERT INTO mb_zzrepa_msgs (uuid, from_user, to_user, subject, body_text, system_time, created_at) " +
				"VALUES (gen_random_uuid(), 'Local', 'All', 'zz rep retry', 'hello hub', NOW(), NOW()) RETURNING id");
			msgId = Number(m.id);
			var pm = await pg.queryOne("INSERT INTO pm_outbox (uuid, user_id, from_user, to_user, to_address, subject, body_text, transport_type, transport_data, queued, sent, system_time) " +
				"VALUES (gen_random_uuid(), 0, 'Zed', 'Nora', 'ZZRRHUB', 'zz rep retry pm', 'hi', 'QWK', '{\"destination\":\"ZZRRHUB\"}', true, false, NOW()) RETURNING id");
			pmId = pm.id;
		} catch (err) {
			available = false;
		}
	});

	beforeEach(function () { if (!available) this.skip(); });
	after(async function () { if (pg && available) { try { await cleanup(); } catch (_) {} } });

	function pas() { return pg.queryOne('SELECT msg_idx FROM peer_area_subscriptions WHERE peer_connection_id = $1 AND area_id = (SELECT id FROM message_areas WHERE shortcode = $2)', [hubConnId, AREA]); }
	function pmSent() { return pg.queryOne('SELECT sent FROM pm_outbox WHERE id = $1', [pmId]).then(function (r) { return r.sent; }); }
	var rep = function () { return path.join(CWD, 'qnet', 'ZZRRHUB.hub', 'out', 'ZZRRHUB.rep'); };

	it('keeps the REP, with what it commits, when the upload fails; commits nothing', async function () {
		await qwkTosser.pushToQwkPeer(hubUuid);
		assert.ok(fs.existsSync(rep()), 'the REP waits for a retry');
		var record = JSON.parse(fs.readFileSync(rep() + '.json', 'utf8'));
		assert.deepStrictEqual(Object.values(record.idx), [msgId]);
		assert.deepStrictEqual(record.pmIds.map(String), [String(pmId)]);
		assert.strictEqual(Number((await pas()).msg_idx), 0);
		assert.strictEqual(await pmSent(), false);
	});

	it('commits it when a later push delivers it', async function () {
		await pg.write('UPDATE peer_connections SET connection_data = connection_data || $1::jsonb WHERE id = $2',
			[JSON.stringify({ remote_outbox: outbox + '/' }), hubConnId]);
		await qwkTosser.pushToQwkPeer(hubUuid);
		assert.ok(fs.existsSync(path.join(outbox, 'ZZRRHUB.rep')), 'delivered');
		assert.strictEqual(fs.existsSync(rep()), false);
		assert.strictEqual(fs.existsSync(rep() + '.json'), false);
		assert.strictEqual(Number((await pas()).msg_idx), msgId);
		assert.strictEqual(await pmSent(), true);
	});

	it('and the next push does not send the same messages again', async function () {
		fs.unlinkSync(path.join(outbox, 'ZZRRHUB.rep'));
		var r = await qwkTosser.pushToQwkPeer(hubUuid);
		assert.ok(r.status);
		assert.strictEqual(fs.existsSync(path.join(outbox, 'ZZRRHUB.rep')), false, 'no second REP with the same messages');
	});
});
