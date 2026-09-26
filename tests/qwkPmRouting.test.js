// tests/qwkPmRouting.test.js: QWK private mail goes over its own connection,
// and a QWK hub serves nodes that use a shared directory (#65 items 3-5).
//
// Both packet builders took every pending QWK PM, so with more than one QWK
// connection whichever packed first carried all of them. And a node using
// qnet-directory.js never calls, so nothing imported the REPs it left in
// qnet/<ID>/in/ or built the packet it collects from qnet/<ID>/out/; its
// taking the packet (the sidecar left behind) is now its acknowledgement.
//
// Fixture: a throwaway ZZ peer with a directory hub connection and a client
// connection on an existing QWK network, PM rows with user_id 0 (so no bounce
// is delivered), and the qnet/ZZ* directories; all removed afterwards.

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dbAvailable } from './helpers/dbAvailable.js';
import { routeQwkPm, destinationOf } from '../src/models/qwkPmRouting.js';
import { isDirectoryHubNode } from '../src/models/peerConnections.js';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function conn(id, uuid, qwkId, extra) {
	return { id: id, uuid: uuid, active: true, connection_data: Object.assign({ remote_qwk_id: qwkId }, extra || {}) };
}

describe('routeQwkPm', function () {
	var HUB  = conn(7, 'u-hub', 'UNDRMINE', { transport: 'hub' });
	var NODE = conn(3, 'u-node', 'UNDRMINE', { transport: 'ftp' });
	var VERT = conn(5, 'u-vert', 'VERT', { transport: 'ftp' });
	var ALL = [HUB, VERT, NODE];

	it('sends to the connection whose QWK ID is the destination, any case', function () {
		assert.strictEqual(routeQwkPm({ to_address: 'vert', transport_data: {} }, ALL).uuid, 'u-vert');
		assert.strictEqual(routeQwkPm({ to_address: '', transport_data: '{"destination":"Vert"}' }, ALL).uuid, 'u-vert');
	});

	it('prefers transport_data.destination over to_address', function () {
		assert.strictEqual(destinationOf({ to_address: 'VERT', transport_data: { destination: 'undrmine' } }), 'UNDRMINE');
	});

	it('picks the oldest when two connections reach the same system, whatever order they come in', function () {
		assert.strictEqual(routeQwkPm({ to_address: 'UNDRMINE' }, ALL).uuid, 'u-node');
		assert.strictEqual(routeQwkPm({ to_address: 'UNDRMINE' }, [NODE, HUB]).uuid, 'u-node');
	});

	it('sends a reply back over the connection its original came in on', function () {
		var reply = { to_address: 'UNDRMINE', transport_data: { destination: 'UNDRMINE', peer_connection_uuid: 'u-hub' } };
		assert.strictEqual(routeQwkPm(reply, ALL).uuid, 'u-hub');
	});

	it('ignores a pin to a connection that is gone, or now names another system', function () {
		var gone = { to_address: 'VERT', transport_data: { peer_connection_uuid: 'u-deleted' } };
		assert.strictEqual(routeQwkPm(gone, ALL).uuid, 'u-vert');
		var moved = { to_address: 'VERT', transport_data: { peer_connection_uuid: 'u-hub' } };
		assert.strictEqual(routeQwkPm(moved, ALL).uuid, 'u-vert');
	});

	it('routes nowhere, with a reason, when no connection reaches the destination', function () {
		var r = routeQwkPm({ to_address: 'NOWHERE' }, ALL);
		assert.strictEqual(r.uuid, null);
		assert.match(r.reason, /NOWHERE/);
		assert.strictEqual(routeQwkPm({ to_address: '' }, ALL).uuid, null);
	});
});

describe('both QWK packet builders route PMs', function () {
	// The client REP needs a live hub to test end to end, so this pins the
	// call: going back to getPendingByTransport('QWK') is the original bug.
	for (var rel of ['src/middleware/tossers/qwkTosser.js', 'src/models/qwkPacketBuilder.js']) {
		(function (rel) {
			it(rel + ' takes its PMs from pendingQwkPmsFor', function () {
				var src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
				assert.match(src, /pendingQwkPmsFor\(peerConnectionUUID\)/);
				assert.doesNotMatch(src, /getPendingByTransport\('QWK'\)/);
			});
		})(rel);
	}
});

describe('isDirectoryHubNode', function () {
	it('is a hub connection with hub_directory ticked, and active', function () {
		assert.strictEqual(isDirectoryHubNode(conn(1, 'a', 'N', { transport: 'hub', hub_directory: true })), true);
		assert.strictEqual(isDirectoryHubNode(conn(1, 'a', 'N', { transport: 'hub' })), false);
		assert.strictEqual(isDirectoryHubNode(conn(1, 'a', 'N', { transport: 'directory', hub_directory: true })), false);
		assert.strictEqual(isDirectoryHubNode(Object.assign(conn(1, 'a', 'N', { transport: 'hub', hub_directory: true }), { active: false })), false);
	});
});

describe('QWK hub with a shared-directory node, and per-connection PMs', function () {
	this.timeout(60000);

	var PEER_NAME = 'ZZ QWK Routing Test Peer';
	var NODE_ID = 'ZZDIRND', UP_ID = 'ZZUPHUB';
	var available = false;
	var pg, peers, peerConnections, qwkPacketBuilder, qwkTosser, qwkPmRouting, qwkClasses;
	var peerId = null, hubUuid = null, upUuid = null, localId = null;
	var pmIds = {};
	var nodeDir = path.join(ROOT, 'qnet', NODE_ID + '.node');

	async function addPm(key, toAddress) {
		var r = await pg.insertObject({
			uuid: '00000000-0000-4000-8000-' + String(Date.now() % 1e12).padStart(12, '0').slice(0, 11) + Object.keys(pmIds).length,
			user_id: 0, from_user: 'ZZ Tester', to_user: 'Someone', to_address: toAddress,
			subject: 'zz routing ' + key, body_text: 'test', transport_type: 'QWK',
			transport_data: JSON.stringify({ destination: toAddress }), queued: true, sent: false,
			system_time: new Date()
		}, 'pm_outbox');
		var row = await pg.queryOne('SELECT id FROM pm_outbox WHERE subject = $1', ['zz routing ' + key]);
		pmIds[key] = row.id;
		return r;
	}

	async function cleanup() {
		var stale = await pg.query('SELECT id FROM peers WHERE name = $1', [PEER_NAME]);
		for (var old of stale || []) {
			var cs = await pg.query('SELECT id, uuid FROM peer_connections WHERE peer_id = $1', [old.id]);
			for (var c of cs || []) {
				await pg.write('DELETE FROM peer_area_subscriptions WHERE peer_connection_id = $1', [c.id]);
				await pg.write('DELETE FROM network_transfers WHERE connection_uuid = $1', [c.uuid]).catch(function () {});
				await pg.write('DELETE FROM peer_connections WHERE id = $1', [c.id]);
			}
			await pg.write('DELETE FROM peers WHERE id = $1', [old.id]);
		}
		await pg.write("DELETE FROM pm_outbox WHERE subject LIKE 'zz routing %' AND user_id = 0");
		for (var d of [NODE_ID, NODE_ID + '.node', UP_ID, UP_ID + '.hub']) fs.rmSync(path.join(ROOT, 'qnet', d), { recursive: true, force: true });
	}

	before(async function () {
		try {
			available = await dbAvailable();
			if (!available) return;
			pg               = await import('../src/middleware/db/postgres.js');
			peers            = await import('../src/models/peers.js');
			peerConnections  = await import('../src/models/peerConnections.js');
			qwkPacketBuilder = await import('../src/models/qwkPacketBuilder.js');
			qwkTosser        = await import('../src/middleware/tossers/qwkTosser.js');
			qwkPmRouting     = await import('../src/models/qwkPmRouting.js');
			qwkClasses       = await import('../src/models/qwkClasses.js');

			var net = await pg.queryOne(
				"SELECT n.id, sa.address FROM message_networks n JOIN system_addresses sa ON sa.network_id = n.id AND sa.is_default " +
				"WHERE n.network_type = 'QWK' AND n.active ORDER BY n.id LIMIT 1");
			if (!net) { available = false; return; }
			localId = String(net.address).trim().toUpperCase();

			await cleanup();
			var p = await peers.newPeer({ name: PEER_NAME, sysop_name: 'ZZ Test' });
			if (!p.status) { available = false; return; }
			peerId = p.insertId;
			var h = await peerConnections.newConnection({ peer_id: peerId, network_id: net.id, connection_type: 'QWK',
				transport: 'hub', remote_qwk_id: NODE_ID, hub_directory: 'true' });
			var u = await peerConnections.newConnection({ peer_id: peerId, network_id: net.id, connection_type: 'QWK',
				transport: 'ftp', host: 'hub.zz.invalid', remote_qwk_id: UP_ID });
			if (!h.status || !u.status) { available = false; return; }
			hubUuid = h.insertUUID;
			upUuid = u.insertUUID;
			// PMs only: no conference traffic from the board's real areas.
			await pg.write('UPDATE peer_area_subscriptions SET enabled = false WHERE peer_connection_id IN ($1, $2)',
				[h.insertId, u.insertId]);

			await addPm('node', NODE_ID);
			await addPm('up', UP_ID.toLowerCase());
			await addPm('lost', 'ZZNOWHERE');
		} catch (err) {
			available = false;
		}
	});

	beforeEach(function () { if (!available) this.skip(); });

	after(async function () {
		if (pg && available) { try { await cleanup(); } catch (_) {} }
	});

	it('the setting reaches connection_data', async function () {
		var c = await peerConnections.getConnectionByUUID(hubUuid);
		assert.strictEqual(c.connection_data.hub_directory, true);
		assert.strictEqual(isDirectoryHubNode(c), true);
	});

	it('each connection gets only its own PMs; one with nowhere to go is undeliverable', async function () {
		var forHub = (await qwkPmRouting.pendingQwkPmsFor(hubUuid)).map(function (r) { return r.id; });
		var forUp  = (await qwkPmRouting.pendingQwkPmsFor(upUuid)).map(function (r) { return r.id; });
		assert.deepStrictEqual(forHub, [pmIds.node]);
		assert.deepStrictEqual(forUp, [pmIds.up]);
		var lost = await pg.queryOne('SELECT undeliverable, undeliverable_reason, queued FROM pm_outbox WHERE id = $1', [pmIds.lost]);
		assert.strictEqual(lost.undeliverable, true);
		assert.strictEqual(lost.queued, false);
		assert.match(lost.undeliverable_reason, /ZZNOWHERE/);
	});

	it('builds the node its packet in out/, and commits it only once the node has taken it', async function () {
		var qwkPath = path.join(nodeDir, 'out', localId + '.qwk');
		var built = await qwkPacketBuilder.buildQwkForNode(hubUuid);
		assert.ok(built.status, built.errormessages.join('; '));
		assert.strictEqual(built.qwkPath, qwkPath);
		var sidecar = JSON.parse(fs.readFileSync(qwkPath + '.json', 'utf8'));
		assert.deepStrictEqual(sidecar.pmIds.map(String), [String(pmIds.node)]);

		var again = await qwkPacketBuilder.buildQwkForNode(hubUuid);
		assert.strictEqual(again.reused, true, 'an uncollected packet is offered again, not rebuilt');
		assert.strictEqual((await pg.queryOne('SELECT sent FROM pm_outbox WHERE id = $1', [pmIds.node])).sent, false);

		// The node collects it the way qnet-directory.js does: copy, delete.
		fs.unlinkSync(qwkPath);
		var next = await qwkPacketBuilder.buildQwkForNode(hubUuid);
		assert.ok(next.status);
		assert.strictEqual(next.qwkPath, null, 'nothing left to send');
		assert.strictEqual((await pg.queryOne('SELECT sent FROM pm_outbox WHERE id = $1', [pmIds.node])).sent, true);
		assert.strictEqual(fs.existsSync(qwkPath + '.json'), false);
	});

	it('the hub sweep imports a REP the node left in in/', async function () {
		var inDir = path.join(nodeDir, 'in');
		fs.mkdirSync(inDir, { recursive: true });
		// An empty REP, as a node with nothing to say sends: the hub's ID in
		// record 0 and no messages.
		var rep = qwkClasses.buildRepPacket([], localId, inDir, NODE_ID);
		assert.ok(fs.existsSync(rep));
		var summary = await qwkTosser.serviceHubNodes();
		assert.ok(summary.repsImported >= 1, JSON.stringify(summary));
		assert.deepStrictEqual(fs.readdirSync(inDir).filter(function (f) { return /\.rep$/i.test(f); }), []);
	});
});
