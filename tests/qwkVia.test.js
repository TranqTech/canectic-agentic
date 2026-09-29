// tests/qwkVia.test.js: QWK sender paths, passing mail on, and netmail forms (#70).
//
// Both QWK exporters skipped every message that came in on the same network,
// so a Canectic hub never passed one node's messages to its other nodes, and
// a board that was a node upstream and a hub downstream never passed its own
// nodes' mail up. FTN made the same mistake until 940b1be. We also never wrote
// @VIA, so the next system could not route replies, and mail for our own
// users that arrived in netmail form (To "NETMAIL", or user@OURID) was treated
// as mail for a user called that, and went undeliverable.
//
// Fixture for the database part: a throwaway QWK network (zzqwkviatest) with
// our address ZZHUBX, an area on conference 901, two nodes, and a throwaway
// user; all removed afterwards.

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { dbAvailable } from './helpers/dbAvailable.js';
import {
	parseViaPath, senderPath, originOf, pathContains, exportDecision, withVia,
	parseNetmailAddress, stripFirstLine
} from '../src/utils/qwkVia.js';

describe('QWK sender paths', function () {
	it('reads a path, upper case, on / or spaces', function () {
		assert.deepStrictEqual(parseViaPath('hub/a/B'), ['HUB', 'A', 'B']);
		assert.deepStrictEqual(parseViaPath('A B'), ['A', 'B']);
		assert.deepStrictEqual(parseViaPath(null), []);
	});

	it('stores the system that handed it over, then its @VIA; the writer is last', function () {
		assert.strictEqual(senderPath('hub', 'a/b'), 'HUB/A/B');
		assert.strictEqual(senderPath('HUB', null), 'HUB');
		assert.strictEqual(originOf('HUB/A/B'), 'B');
		assert.strictEqual(originOf('HUB'), 'HUB');
	});

	it('finds a system anywhere in a path, any case', function () {
		assert.strictEqual(pathContains('HUB/A/B', 'a'), true);
		assert.strictEqual(pathContains('HUB/A/B', 'C'), false);
		assert.strictEqual(pathContains('', 'A'), false);
	});
});

describe('which systems a message goes to (exportDecision)', function () {
	var NET = 7;

	it('sends local mail and mail from other networks, as before, with no @VIA', function () {
		assert.deepStrictEqual(exportDecision({ source_network_id: null }, NET, 'B'), { send: true, via: null });
		assert.deepStrictEqual(exportDecision({ source_network_id: 3, path: 'X' }, NET, 'B'), { send: true, via: null });
	});

	it('passes one node\'s mail on to another, carrying where it came from', function () {
		assert.deepStrictEqual(exportDecision({ source_network_id: NET, path: 'NODEA' }, NET, 'NODEB'),
			{ send: true, via: 'NODEA' });
		assert.deepStrictEqual(exportDecision({ source_network_id: '7', path: 'hub/a' }, NET, 'NODEB'),
			{ send: true, via: 'HUB/A' }, 'ids arrive from postgres as strings');
	});

	it('never sends it back to a system already in its path', function () {
		assert.strictEqual(exportDecision({ source_network_id: NET, path: 'NODEA' }, NET, 'nodea').send, false);
		assert.strictEqual(exportDecision({ source_network_id: NET, path: 'HUB/NODEA' }, NET, 'NODEA').send, false);
	});

	it('keeps the old rule for rows from before paths were recorded', function () {
		assert.strictEqual(exportDecision({ source_network_id: NET, path: null }, NET, 'NODEB').send, false);
	});

	it('writes @VIA first, where kludge lines go', function () {
		assert.strictEqual(withVia('Hello\r', 'HUB/A'), '@VIA: HUB/A\rHello\r');
		assert.strictEqual(withVia('Hello\r', null), 'Hello\r');
	});
});

describe('netmail addresses (Synchronet qwktonetmail forms)', function () {
	it('reads To "NETMAIL" with user@address on the first line', function () {
		var n = parseNetmailAddress('NETMAIL', 'Joe Bloggs@HUB/OURID\rHi Joe\r');
		assert.strictEqual(n.user, 'Joe Bloggs');
		assert.strictEqual(n.kind, 'qwk');
		assert.deepStrictEqual(n.path, ['HUB', 'OURID']);
		assert.strictEqual(n.destination, 'OURID');
		assert.strictEqual(n.firstLineUsed, true);
		assert.strictEqual(stripFirstLine('Joe Bloggs@HUB/OURID\rHi Joe\r'), 'Hi Joe\r');
	});

	it('reads To user@address', function () {
		var n = parseNetmailAddress('sysop@ourid', 'Hi');
		assert.strictEqual(n.user, 'sysop');
		assert.strictEqual(n.destination, 'OURID');
		assert.strictEqual(n.firstLineUsed, false);
	});

	it('tells FidoNet and internet addresses from QWK ones the way Synchronet does', function () {
		assert.strictEqual(parseNetmailAddress('joe@1:2/3', '').kind, 'fido');
		assert.strictEqual(parseNetmailAddress('joe@example.com', '').kind, 'internet');
		assert.strictEqual(parseNetmailAddress('joe@host:25', '').kind, 'internet');
		assert.strictEqual(parseNetmailAddress('joe@', '').kind, 'invalid');
	});

	it('leaves plain local mail alone', function () {
		assert.strictEqual(parseNetmailAddress('Joe Bloggs', 'Hi'), null);
	});
});

describe('QWK hub passes mail on, and delivers netmail-form mail (#70)', function () {
	this.timeout(60000);

	var DOMAIN = 'zzqwkviatest', AREA = 'ZZVIA1', USER = 'ZZViaTestUser';
	var available = false;
	var pg, peers, peerConnections, msgNetworks, systemAddresses, msgAreas, qwkPacketBuilder, qwkTosser, qwkClasses, qnetPaths;
	var networkId, peerId, userId, nodeA, nodeB, groupShortcode;

	async function cleanup() {
		var nets = await pg.query('SELECT id FROM message_networks WHERE domain = $1', [DOMAIN]);
		for (var n of nets || []) {
			var cs = await pg.query('SELECT id FROM peer_connections WHERE network_id = $1', [n.id]);
			for (var c of cs || []) {
				await pg.write('DELETE FROM peer_area_subscriptions WHERE peer_connection_id = $1', [c.id]);
				await pg.write('DELETE FROM peer_connections WHERE id = $1', [c.id]);
			}
			await pg.write('DELETE FROM network_areas WHERE network_id = $1', [n.id]);
			await pg.write('DELETE FROM system_addresses WHERE network_id = $1', [n.id]);
			await pg.write('DELETE FROM message_networks WHERE id = $1', [n.id]);
		}
		await msgAreas.removeArea(AREA, true).catch(function () {});
		await pg.write("DELETE FROM peers WHERE name = 'ZZ QWK Via Test Peer'");
		var u = await pg.queryOne('SELECT id FROM users WHERE username = $1', [USER]);
		if (u) {
			// Each delivered PM raises a "New PM" notification referring to it
			await pg.write("DELETE FROM notifications WHERE ref IN (SELECT 'pm:' || id FROM pm_inbox WHERE user_id = $1)", [u.id]);
			await pg.write('DELETE FROM pm_inbox WHERE user_id = $1', [u.id]);
			await pg.write('DELETE FROM users WHERE id = $1', [u.id]);
		}
		await pg.write("DELETE FROM pm_undeliverable WHERE subject LIKE 'zz via %'");
		await pg.write("DELETE FROM notifications WHERE body LIKE '%zz via %'");
		// notifySysops writes a real message to every sysop's inbox.
		await pg.write("DELETE FROM notifications WHERE ref IN (SELECT 'pm:' || id FROM pm_inbox WHERE subject LIKE 'Undeliverable QWK PM from ZZ%' AND from_user = 'SYSTEM')");
		await pg.write("DELETE FROM pm_inbox WHERE subject LIKE 'Undeliverable QWK PM from ZZ%' AND from_user = 'SYSTEM'");
		await pg.write("DELETE FROM pm_outbox WHERE subject LIKE 'zz via %' OR subject LIKE 'BADADDR: ZZ%'");
		await pg.write("DELETE FROM netmail_relay_log WHERE packet_source = 'ZZNODEA'");
		for (var d of ['ZZNODEA.node', 'ZZNODEB.node']) fs.rmSync(path.join(process.cwd(), 'qnet', d), { recursive: true, force: true });
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
			msgAreas         = await import('../src/models/msgAreas.js');
			qwkPacketBuilder = await import('../src/models/qwkPacketBuilder.js');
			qwkTosser        = await import('../src/middleware/tossers/qwkTosser.js');
			qwkClasses       = await import('../src/models/qwkClasses.js');
			qnetPaths        = await import('../src/utils/qnetPaths.js');
			await cleanup();

			var grp = await pg.queryOne('SELECT shortcode FROM message_groups LIMIT 1');
			if (!grp) { available = false; return; }
			groupShortcode = grp.shortcode;
			var n = await msgNetworks.newNetwork({ name: 'ZZ QWK Via Test', domain: DOMAIN, description: 'temporary', network_type: 'QWK' });
			if (!n.status) { available = false; return; }
			networkId = n.insertId;
			await systemAddresses.newAddress({ network_id: networkId, address: 'ZZHUBX' });
			var a = await msgAreas.newArea({ groupshortcode: groupShortcode, name: 'ZZ via area', description: 'temporary',
				shortcode: AREA, readsecurity: 50, postsecurity: 60, network_id: networkId, areatag: '901',
				createdByName: 'qwkVia.test.js' });
			if (!a.status) { available = false; return; }
			var p = await peers.newPeer({ name: 'ZZ QWK Via Test Peer', sysop_name: 'ZZ Test' });
			peerId = p.insertId;
			var ca = await peerConnections.newConnection({ peer_id: peerId, network_id: networkId, connection_type: 'QWK', transport: 'hub', remote_qwk_id: 'ZZNODEA' });
			var cb = await peerConnections.newConnection({ peer_id: peerId, network_id: networkId, connection_type: 'QWK', transport: 'hub', remote_qwk_id: 'ZZNODEB' });
			if (!ca.status || !cb.status) { available = false; return; }
			nodeA = ca.insertUUID; nodeB = cb.insertUUID;
			await pg.write('UPDATE peer_area_subscriptions SET enabled = true, msg_idx = 0 WHERE peer_connection_id IN ($1, $2)', [ca.insertId, cb.insertId]);
			var u = await pg.queryOne("INSERT INTO users (uuid, username, active) VALUES (gen_random_uuid(), $1, true) RETURNING id", [USER]);
			userId = u.id;
		} catch (err) {
			available = false;
		}
	});

	beforeEach(function () { if (!available) this.skip(); });
	after(async function () { if (pg && available) { try { await cleanup(); } catch (_) {} } });

	function packetMessages(qwkPath) {
		var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zzvia-'));
		qwkClasses.unzipQwkPacket(qwkPath, dir);
		var buf = fs.readFileSync(fs.readdirSync(dir).map(function (f) { return path.join(dir, f); })
			.find(function (f) { return /MESSAGES\.DAT$/i.test(f); }));
		var msgs = qwkClasses.parseMessagesDAT(buf);
		fs.rmSync(dir, { recursive: true, force: true });
		return msgs;
	}

	it('records who handed a message over, and refuses one that has been round a loop', async function () {
		var area = { shortcode: AREA, id: 0 };
		var r = await qwkTosser.importQwkMessage({ from: 'Alice', to: 'All', subject: 'zz via hello', bodyText: 'from A\r',
			date: '09-26-26', time: '10:00', kludges: { VIA: ['ZZLEAF'] }, conferenceNum: 901 },
			area, 'zzvia:1', networkId, { remoteQwkId: 'ZZNODEA', localQwkId: 'ZZHUBX' });
		assert.ok(r.imported, r.errormessages.join('; '));
		var row = await pg.queryOne('SELECT path, source_network_id FROM mb_zzvia1_msgs WHERE qwk_msg_id = $1', ['zzvia:1']);
		assert.strictEqual(row.path, 'ZZNODEA/ZZLEAF');

		var loop = await qwkTosser.importQwkMessage({ from: 'Bob', to: 'All', subject: 'zz via loop', bodyText: 'x\r',
			date: '09-26-26', time: '10:01', kludges: { VIA: ['ZZOTHER/ZZHUBX'] }, conferenceNum: 901 },
			area, 'zzvia:2', networkId, { remoteQwkId: 'ZZNODEA', localQwkId: 'zzhubx' });
		assert.strictEqual(loop.circular, true);
		assert.strictEqual(loop.imported, false);
	});

	it('passes node A\'s message to node B with @VIA, and not back to A', async function () {
		var forB = await qwkPacketBuilder.buildQwkForNode(nodeB);
		assert.ok(forB.qwkPath, 'node B gets a packet: ' + forB.errormessages.join('; '));
		var got = packetMessages(forB.qwkPath);
		assert.strictEqual(got.length, 1);
		assert.deepStrictEqual(got[0].kludges.VIA, ['ZZNODEA/ZZLEAF']);
		assert.match(got[0].bodyText, /^from A/);

		var forA = await qwkPacketBuilder.buildQwkForNode(nodeA);
		assert.strictEqual(forA.qwkPath, null, 'nothing goes back to A');
	});

	it('delivers our user\'s mail that arrives as To NETMAIL, without the address line', async function () {
		var r = await qwkTosser.importQwkPrivateMessage({ from: 'Alice', to: 'NETMAIL', subject: 'zz via netmail',
			bodyText: USER + '@ZZNODEA/ZZHUBX\rHello there\r', date: '09-26-26', time: '10:02', msgNumber: 3,
			kludges: { VIA: ['ZZLEAF'], MSGID: 'zzvia-netmail-1' } }, 'ZZNODEA', nodeA, 'ZZHUBX');
		assert.ok(r.delivered, r.errormessages.join('; '));
		var pm = await pg.queryOne('SELECT from_address, body_text, transport_data FROM pm_inbox WHERE user_id = $1 AND subject = $2', [userId, 'zz via netmail']);
		assert.strictEqual(pm.body_text, 'Hello there\r');
		assert.strictEqual(pm.from_address, 'ZZLEAF', 'from the system that wrote it');
		var td = typeof pm.transport_data === 'string' ? JSON.parse(pm.transport_data) : pm.transport_data;
		assert.strictEqual(td.source_path, 'ZZNODEA/ZZLEAF');
	});

	it('delivers To user@OURID too', async function () {
		var r = await qwkTosser.importQwkPrivateMessage({ from: 'Alice', to: USER + '@zzhubx', subject: 'zz via at',
			bodyText: 'Hi\r', date: '09-26-26', time: '10:03', msgNumber: 4, kludges: { MSGID: 'zzvia-netmail-2' } },
			'ZZNODEA', nodeA, 'ZZHUBX');
		assert.ok(r.delivered, r.errormessages.join('; '));
	});

	it('records an undeliverable PM with its reason, and its transport data once', async function () {
		// Mail for a system beyond us is relayed or bounced since #73 (see
		// qwkRelay.test.js); a local recipient who does not exist is what
		// reaches the undeliverable record now.
		var r = await qwkTosser.importQwkPrivateMessage({ from: 'Alice', to: 'ZZNoSuchUser@ZZHUBX', subject: 'zz via transit',
			bodyText: 'Hi\r', date: '09-26-26', time: '10:04', msgNumber: 5, kludges: {} }, 'ZZNODEA', nodeA, 'ZZHUBX');
		assert.strictEqual(r.delivered, false);
		var ud = await pg.queryOne("SELECT reason, to_user, transport_data FROM pm_undeliverable WHERE subject = 'zz via transit'");
		assert.match(ud.reason, /Recipient "ZZNoSuchUser" not found \(QWK PM from ZZNODEA\)/);
		assert.strictEqual(ud.to_user, 'ZZNoSuchUser');
		var td = typeof ud.transport_data === 'string' ? JSON.parse(ud.transport_data) : ud.transport_data;
		assert.strictEqual(typeof td, 'object', 'stored once as JSON, not a JSON string of JSON');
	});
});
