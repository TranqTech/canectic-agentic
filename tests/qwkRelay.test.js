// tests/qwkRelay.test.js: QWK netmail routes and relaying (#73).
//
// A Synchronet QWK hub passes netmail on: to its own nodes, up to its hub, and
// by routes learned from the @VIA of every message it imports (qwk.cpp
// qwk_route, update_qwkroute), bouncing what it cannot place as BADADDR.
// Canectic did none of it: netmail for anyone but our own users went
// undeliverable. Routes are kept per network and relaying stays within the
// network a message arrived on.
//
// Fixture for the database part: a throwaway QWK network (zzqwkrelaytest), our
// address ZZRLOCAL, nodes ZZRNA and ZZRNB; all removed afterwards.

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { dbAvailable } from './helpers/dbAvailable.js';
import { routesFromSenderPath, takeLeadingKludges, netmailWire } from '../src/utils/qwkVia.js';
import { routeQwkPm } from '../src/models/qwkPmRouting.js';

function conn(id, uuid, qwkId, transport, networkId, name) {
	return { id: id, uuid: uuid, network_id: networkId || 1, network_name: name || 'Net1',
		connection_data: { remote_qwk_id: qwkId, transport: transport || 'ftp' } };
}

describe('learning routes from sender paths', function () {
	it('learns the way to every system after the first, which is a direct link', function () {
		assert.deepStrictEqual(routesFromSenderPath('HUB/A/B'), [{ id: 'A', path: 'HUB/A' }, { id: 'B', path: 'HUB/A/B' }]);
		assert.deepStrictEqual(routesFromSenderPath('HUB'), []);
	});

	it('reads the @VIA that follows a NETMAIL address line', function () {
		var r = takeLeadingKludges('@VIA: A/B\r@MSGID: 1 2\rHello\r');
		assert.deepStrictEqual(r.kludges.VIA, ['A/B']);
		assert.strictEqual(r.kludges.MSGID, '1 2');
		assert.strictEqual(r.body, 'Hello\r');
		assert.strictEqual(takeLeadingKludges('Hello @VIA: x\r').body, 'Hello @VIA: x\r');
	});

	it('writes netmail the way Synchronet does', function () {
		assert.deepStrictEqual(netmailWire('Bob', '', 'Hi\r', null), { to: 'Bob', body: 'Hi\r' });
		assert.deepStrictEqual(netmailWire('Bob', 'FAR', 'Hi\r', 'A/LEAF'),
			{ to: 'NETMAIL', body: 'Bob@FAR\r@VIA: A/LEAF\rHi\r' });
	});
});

describe('routing a QWK PM (routeQwkPm)', function () {
	var HUB = conn(1, 'u-hub', 'HUB', 'ftp', 1);
	var NODE = conn(2, 'u-node', 'NODEB', 'hub', 1);
	var OTHER = conn(3, 'u-other', 'OTHERHUB', 'ftp', 2, 'Net2');
	var CONNS = [HUB, NODE, OTHER];

	it('prefers a direct link, then an explicit path, then a learned route', function () {
		var routes = [{ network_id: 1, qwk_id: 'NODEB', path: 'HUB/NODEB' }];
		assert.deepStrictEqual(routeQwkPm({ to_address: 'NODEB' }, CONNS, routes), { uuid: 'u-node', rest: '', method: 'direct', reason: null });
		assert.deepStrictEqual(routeQwkPm({ to_address: 'HUB/FAR' }, CONNS, []), { uuid: 'u-hub', rest: 'FAR', method: 'explicit', reason: null });
		var learned = routeQwkPm({ to_address: 'FAR' }, CONNS, [{ network_id: 1, qwk_id: 'FAR', path: 'HUB/MID/FAR' }]);
		assert.deepStrictEqual(learned, { uuid: 'u-hub', rest: 'MID/FAR', method: 'learned', reason: null });
	});

	it('only uses a learned route through a link on the route\'s own network', function () {
		var r = routeQwkPm({ to_address: 'FAR' }, CONNS, [{ network_id: 2, qwk_id: 'FAR', path: 'HUB/FAR' }]);
		assert.strictEqual(r.uuid, null, 'HUB is a link on network 1, not 2');
	});

	it('holds relayed or chosen mail to its network', function () {
		var routes = [{ network_id: 1, qwk_id: 'FAR', path: 'HUB/FAR' }, { network_id: 2, qwk_id: 'FAR', path: 'OTHERHUB/FAR' }];
		assert.strictEqual(routeQwkPm({ to_address: 'FAR', transport_data: { network_id: 2 } }, CONNS, routes).uuid, 'u-other');
		assert.strictEqual(routeQwkPm({ to_address: 'NODEB', transport_data: { network_id: 2 } }, CONNS, routes).uuid, null);
	});

	it('asks for a choice when a destination is known on two networks', function () {
		var routes = [{ network_id: 1, qwk_id: 'FAR', path: 'HUB/FAR' }, { network_id: 2, qwk_id: 'FAR', path: 'OTHERHUB/FAR' }];
		var r = routeQwkPm({ to_address: 'FAR' }, CONNS, routes);
		assert.strictEqual(r.uuid, null);
		assert.match(r.reason, /FAR is known on more than one network \(Net1, Net2\)/);
	});

	it('sends a reply back the way the original came', function () {
		var r = routeQwkPm({ to_address: 'LEAF', transport_data: { peer_connection_uuid: 'u-hub', route_path: 'HUB/MID/LEAF' } }, CONNS, []);
		assert.deepStrictEqual(r, { uuid: 'u-hub', rest: 'MID/LEAF', method: 'reply', reason: null });
	});
});

describe('relaying QWK netmail through a hub (#73)', function () {
	this.timeout(60000);

	var DOMAIN = 'zzqwkrelaytest';
	var available = false;
	var pg, peers, peerConnections, msgNetworks, systemAddresses, qwkTosser, qwkPacketBuilder, qwkClasses, qwkRoutes;
	var networkId, networkUuid, peerId, nodeA, nodeB;

	async function cleanup() {
		var nets = await pg.query('SELECT id FROM message_networks WHERE domain = $1', [DOMAIN]);
		for (var n of nets || []) {
			var cs = await pg.query('SELECT id FROM peer_connections WHERE network_id = $1', [n.id]);
			for (var c of cs || []) {
				await pg.write('DELETE FROM peer_area_subscriptions WHERE peer_connection_id = $1', [c.id]);
				await pg.write('DELETE FROM peer_connections WHERE id = $1', [c.id]);
			}
			await pg.write('DELETE FROM qwk_routes WHERE network_id = $1', [n.id]);
			await pg.write('DELETE FROM system_addresses WHERE network_id = $1', [n.id]);
			await pg.write('DELETE FROM message_networks WHERE id = $1', [n.id]);
		}
		await pg.write("DELETE FROM peers WHERE name = 'ZZ QWK Relay Test Peer'");
		await pg.write("DELETE FROM pm_outbox WHERE subject LIKE 'zz relay%' OR subject LIKE 'BADADDR: ZZ%'");
		await pg.write("DELETE FROM netmail_relay_log WHERE packet_source LIKE 'ZZRN%'");
		for (var d of ['ZZRNA.node', 'ZZRNB.node']) fs.rmSync(path.join(process.cwd(), 'qnet', d), { recursive: true, force: true });
	}

	before(async function () {
		try {
			available = await dbAvailable();
			if (!available) return;
			pg               = await import('../src/middleware/db/postgres.js');
			peers            = await import('../src/models/peers.js');
			peerConnections  = await import('../src/models/peerConnections.js');
			msgNetworks      = await import('../src/models/msgNetworks.js');
			systemAddresses  = await import('../src/models/systemAddresses.js');
			qwkTosser        = await import('../src/middleware/tossers/qwkTosser.js');
			qwkPacketBuilder = await import('../src/models/qwkPacketBuilder.js');
			qwkClasses       = await import('../src/models/qwkClasses.js');
			qwkRoutes        = await import('../src/models/qwkRoutes.js');
			await cleanup();
			var n = await msgNetworks.newNetwork({ name: 'ZZ QWK Relay Test', domain: DOMAIN, description: 'temporary', network_type: 'QWK' });
			if (!n.status) { available = false; return; }
			networkId = n.insertId; networkUuid = n.insertUUID;
			await systemAddresses.newAddress({ network_id: networkId, address: 'ZZRLOCAL' });
			var p = await peers.newPeer({ name: 'ZZ QWK Relay Test Peer', sysop_name: 'ZZ Test' });
			peerId = p.insertId;
			var a = await peerConnections.newConnection({ peer_id: peerId, network_id: networkId, connection_type: 'QWK', transport: 'hub', remote_qwk_id: 'ZZRNA' });
			var b = await peerConnections.newConnection({ peer_id: peerId, network_id: networkId, connection_type: 'QWK', transport: 'hub', remote_qwk_id: 'ZZRNB' });
			if (!a.status || !b.status) { available = false; return; }
			nodeA = a.insertUUID; nodeB = b.insertUUID;
			await pg.write('UPDATE peer_area_subscriptions SET enabled = false WHERE peer_connection_id IN ($1, $2)', [a.insertId, b.insertId]);
		} catch (err) {
			available = false;
		}
	});

	beforeEach(function () { if (!available) this.skip(); });
	after(async function () { if (pg && available) { try { await cleanup(); } catch (_) {} } });

	function fromA(to, subject, body) {
		return qwkTosser.importQwkPrivateMessage({ from: 'Alice', to: to, subject: subject, bodyText: body,
			date: '09-26-26', time: '11:00', msgNumber: Math.floor(Math.random() * 1e6), kludges: {} },
			'ZZRNA', nodeA, 'ZZRLOCAL', networkId);
	}

	function packetFor(uuid) {
		return qwkPacketBuilder.buildQwkForNode(uuid).then(function (built) {
			if (!built.qwkPath) return { built: built, msgs: [] };
			var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zzrelay-'));
			qwkClasses.unzipQwkPacket(built.qwkPath, dir);
			var file = fs.readdirSync(dir).find(function (f) { return /MESSAGES\.DAT$/i.test(f); });
			var msgs = qwkClasses.parseMessagesDAT(fs.readFileSync(path.join(dir, file)));
			fs.rmSync(dir, { recursive: true, force: true });
			return { built: built, msgs: msgs };
		});
	}

	it('relays node A\'s netmail for node B, with @VIA, and logs it', async function () {
		var r = await fromA('NETMAIL', 'zz relay direct', 'Bob@ZZRNB\r@VIA: ZZLEAFA\rHello Bob\r');
		assert.strictEqual(r.relayed, true, (r.errormessages || []).join('; '));
		var log = await pg.queryOne("SELECT decision, next_hop, route_method, via_in FROM netmail_relay_log WHERE subject = 'zz relay direct'");
		assert.deepStrictEqual([log.decision, log.next_hop, log.route_method, log.via_in], ['relayed', 'ZZRNB', 'direct', 'ZZRNA/ZZLEAFA']);

		var got = await packetFor(nodeB);
		assert.strictEqual(got.msgs.length, 1);
		assert.strictEqual(got.msgs[0].to, 'Bob', 'last hop: To is the user');
		assert.deepStrictEqual(got.msgs[0].kludges.VIA, ['ZZRNA/ZZLEAFA']);
		assert.match(got.msgs[0].bodyText, /Hello Bob/);
		await qwkPacketBuilder.commitNodePacket(nodeB, got.built.packetId);
	});

	it('relays by a learned route, addressing the hops that remain', async function () {
		await qwkRoutes.learn(networkId, ['ZZRNB/ZZFAR']);
		var r = await fromA('Carol@ZZFAR', 'zz relay learned', 'Hi Carol\r');
		assert.strictEqual(r.relayed, true, (r.errormessages || []).join('; '));
		var got = await packetFor(nodeB);
		assert.strictEqual(got.msgs[0].to, 'NETMAIL');
		assert.match(got.msgs[0].bodyText, /^Carol@ZZFAR\r@VIA: ZZRNA\r/);
		await qwkPacketBuilder.commitNodePacket(nodeB, got.built.packetId);
	});

	it('bounces what it cannot place back to the sender as BADADDR', async function () {
		var r = await fromA('Dan@ZZNOWHERE', 'zz relay nowhere', 'Hi\r');
		assert.strictEqual(r.relayed, false);
		var bounce = await pg.queryOne("SELECT to_user, to_address, body_text FROM pm_outbox WHERE subject = 'BADADDR: ZZNOWHERE'");
		assert.ok(bounce, 'a bounce is queued');
		assert.strictEqual(bounce.to_user, 'Alice');
		assert.strictEqual(bounce.to_address, 'ZZRNA');
		assert.match(bounce.body_text, /could not be delivered: There is no QWK connection or known route to ZZNOWHERE/);
		var log = await pg.queryOne("SELECT decision FROM netmail_relay_log WHERE subject = 'zz relay nowhere'");
		assert.strictEqual(log.decision, 'no_route');
	});

	it('never bounces a bounce', async function () {
		var before = await pg.queryOne("SELECT COUNT(*)::int AS n FROM pm_outbox WHERE subject LIKE 'BADADDR: ZZ%'");
		await fromA('Eve@ZZNOWHERE2', 'BADADDR: ZZSOMEWHERE', 'bounced\r');
		var after = await pg.queryOne("SELECT COUNT(*)::int AS n FROM pm_outbox WHERE subject LIKE 'BADADDR: ZZ%'");
		assert.strictEqual(after.n, before.n);
	});

	it('refuses to relay, and says so, when the network has relaying off', async function () {
		var up = await msgNetworks.updateNetwork(networkUuid, { config: { qwk_relay: false } });
		assert.ok(up.status);
		var r = await fromA('Bob@ZZRNB', 'zz relay off', 'x\r');
		assert.strictEqual(r.relayed, false);
		var log = await pg.queryOne("SELECT decision, reason FROM netmail_relay_log WHERE subject = 'zz relay off'");
		assert.strictEqual(log.decision, 'refused');
		assert.match(log.reason, /does not relay QWK netmail on ZZ QWK Relay Test/);
		await msgNetworks.updateNetwork(networkUuid, { config: { qwk_relay: true } });
	});

	it('learns routes while importing a real packet, and relays from it', async function () {
		var inDir = path.join(process.cwd(), 'qnet', 'ZZRNA.node', 'in');
		fs.mkdirSync(inDir, { recursive: true });
		qwkClasses.buildRepPacket([{ conferenceNum: 0, isPrivate: true, msg: { id: 1, from_user: 'Grace', to_user: 'Frank@ZZRNB',
			subject: 'zz relay pull', body_text: '@VIA: ZZDEEP\rFrom deep\r', system_time: new Date(), reply_ref: 0 } }],
			'ZZRLOCAL', inDir, 'ZZRNA');
		var r = await qwkTosser.pullFromQwkPeer(nodeA);
		assert.ok(r.status, (r.errormessages || []).join('; '));
		var route = await pg.queryOne("SELECT path FROM qwk_routes WHERE network_id = $1 AND qwk_id = 'ZZDEEP'", [networkId]);
		assert.ok(route, 'the route to ZZDEEP was learned from the pull');
		assert.strictEqual(route.path, 'ZZRNA/ZZDEEP');
		var queued = await pg.queryOne("SELECT transport_data FROM pm_outbox WHERE subject = 'zz relay pull'");
		assert.ok(queued, 'and the netmail was relayed');
	});

	it('learns routes from what it imports, and forgets them after 90 days', async function () {
		await qwkRoutes.learn(networkId, ['ZZRNA/ZZMID/ZZEDGE']);
		var fresh = await qwkRoutes.fresh();
		var mine = fresh.filter(function (x) { return Number(x.network_id) === Number(networkId); });
		assert.ok(mine.some(function (x) { return x.qwk_id === 'ZZEDGE' && x.path === 'ZZRNA/ZZMID/ZZEDGE'; }));
		await pg.write("UPDATE qwk_routes SET updated_at = NOW() - interval '91 days' WHERE network_id = $1 AND qwk_id = 'ZZEDGE'", [networkId]);
		fresh = await qwkRoutes.fresh();
		assert.ok(!fresh.some(function (x) { return x.qwk_id === 'ZZEDGE'; }));
	});
});
