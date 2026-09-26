// tests/qwkId.test.js: QWK ID rules (#67).
//
// Nothing validated a QWK ID before this: any string was a valid Remote QWK ID
// or system address, and two connections could share one. That matters more
// than it reads, because a hub builds ONE packet per node and the directory a
// link works in is named by the ID, so two connections with the same ID in
// the same role fight over both. The rules follow Synchronet, since most QWK
// peers are Synchronet boards.
//
// Fixture: a throwaway QWK network (domain zzqwkidtest) with its own peer,
// connections and address, all removed afterwards.

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dbAvailable } from './helpers/dbAvailable.js';
import {
	checkQwkId, normaliseQwkId, longIdsAllowed, remoteRole, findIdClash, auditQwkIds,
	QWK_ID_MAX, QWK_ID_LONG_MAX
} from '../src/utils/qwkId.js';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('checkQwkId', function () {
	it('upper-cases and trims', function () {
		assert.strictEqual(checkQwkId('  vert ').id, 'VERT');
		assert.strictEqual(normaliseQwkId(null), '');
	});

	it('accepts what Synchronet accepts, dashes, underscores and dots included', function () {
		for (var id of ['VERT', 'UNDRMINE', 'BBS-1', 'A_B', 'X.Y', '!HUB#']) {
			assert.deepStrictEqual(checkQwkId(id).errors, [], id);
		}
	});

	it('refuses an empty ID and every character Synchronet refuses', function () {
		assert.match(checkQwkId('').errors[0], /required/);
		for (var ch of ' \\/|<>*?+[]:=";,') {
			var id = 'A' + ch + 'B';
			assert.strictEqual(checkQwkId(id).errors.length, 1, JSON.stringify(id));
		}
	});

	it('refuses non-ASCII and control characters', function () {
		assert.strictEqual(checkQwkId('CAFÉ').errors.length, 1);
		assert.strictEqual(checkQwkId('A\tB').errors.length, 1);
	});

	it('allows 8 characters, or 32 when the network allows long IDs', function () {
		assert.strictEqual(QWK_ID_MAX, 8);
		assert.strictEqual(QWK_ID_LONG_MAX, 32);
		assert.deepStrictEqual(checkQwkId('ABCDEFGH').errors, []);
		assert.match(checkQwkId('ABCDEFGHI').errors[0], /9 characters; the limit is 8 unless the network allows/);
		assert.deepStrictEqual(checkQwkId('ABCDEFGHI', { allowLong: true }).errors, []);
		assert.deepStrictEqual(checkQwkId('A'.repeat(32), { allowLong: true }).errors, []);
		assert.match(checkQwkId('A'.repeat(33), { allowLong: true }).errors[0], /limit is 32$/);
	});

	it('warns, without refusing, about IDs netmail cannot address', function () {
		var digit = checkQwkId('2NDSITE');
		assert.deepStrictEqual(digit.errors, []);
		assert.match(digit.warnings[0], /starts with a digit/);
		assert.match(checkQwkId('X.Y').warnings[0], /contains '\.' or '@'/);
		assert.match(checkQwkId('X@Y').warnings[0], /contains '\.' or '@'/);
		assert.deepStrictEqual(checkQwkId('VERT').warnings, []);
	});
});

describe('longIdsAllowed', function () {
	it('reads the network setting, as an object or the JSON string postgres may return', function () {
		assert.strictEqual(longIdsAllowed({ config: { qwk_long_ids: true } }), true);
		assert.strictEqual(longIdsAllowed({ config: '{"qwk_long_ids":true}' }), true);
		assert.strictEqual(longIdsAllowed({ config: { qwk_long_ids: 'true' } }), false, 'only a real boolean');
		assert.strictEqual(longIdsAllowed({ config: null }), false);
		assert.strictEqual(longIdsAllowed(null), false);
	});
});

describe('QWK ID uniqueness per role', function () {
	function conn(uuid, id, transport, extra) {
		return Object.assign({ uuid: uuid, id: uuid, connection_data: { remote_qwk_id: id, transport: transport } }, extra || {});
	}

	it('names the remote side\'s role: a hub-transport connection is our node, any other is our hub', function () {
		assert.strictEqual(remoteRole({ transport: 'hub' }), 'node');
		assert.strictEqual(remoteRole({ transport: 'ftp' }), 'hub');
		assert.strictEqual(remoteRole({ transport: 'http' }), 'hub');
		assert.strictEqual(remoteRole({}), 'hub');
	});

	it('finds another connection with the same ID in the same role, any case', function () {
		var existing = [conn('a', 'UNDRMINE', 'ftp')];
		assert.strictEqual(findIdClash({ uuid: 'b', id: 'undrmine', role: 'hub' }, existing).uuid, 'a');
	});

	it('lets one system be both our hub and our node', function () {
		var existing = [conn('a', 'UNDRMINE', 'ftp')];
		assert.strictEqual(findIdClash({ uuid: 'b', id: 'UNDRMINE', role: 'node' }, existing), null);
	});

	it('does not count the connection being saved against itself', function () {
		var existing = [conn('a', 'VERT', 'ftp')];
		assert.strictEqual(findIdClash({ uuid: 'a', id: 'VERT', role: 'hub' }, existing), null);
	});

	it('counts inactive connections, which still own their directory', function () {
		var existing = [conn('a', 'VERT', 'ftp', { active: false })];
		assert.ok(findIdClash({ uuid: 'b', id: 'VERT', role: 'hub' }, existing));
	});
});

describe('auditQwkIds', function () {
	var nets = new Map([['1', { name: 'DOVE-Net', config: null }], ['2', { name: 'Longnet', config: { qwk_long_ids: true } }]]);

	it('reports a duplicate in the same role, naming both', function () {
		var lines = auditQwkIds([
			{ id: 1, network_id: 1, peer_name: 'Vertrauen', connection_data: { remote_qwk_id: 'VERT', transport: 'ftp' } },
			{ id: 2, network_id: 1, peer_name: 'Impostor', connection_data: { remote_qwk_id: 'vert', transport: 'http' } }
		], [], nets);
		assert.strictEqual(lines.length, 1);
		assert.match(lines[0], /^Impostor on DOVE-Net: QWK ID VERT is also used by Vertrauen on DOVE-Net in the same role \(our hub\)/);
	});

	it('reports IDs that break the rules for their network, and our own addresses', function () {
		var lines = auditQwkIds([
			{ id: 1, network_id: 1, peer_name: 'A', connection_data: { remote_qwk_id: 'TOOLONGID', transport: 'ftp' } },
			{ id: 2, network_id: 2, peer_name: 'B', connection_data: { remote_qwk_id: 'LONGOKAYID', transport: 'ftp' } }
		], [{ address: 'BAD ID', network_id: 1 }], nets);
		assert.strictEqual(lines.length, 2, lines.join('\n'));
		assert.match(lines[0], /^A on DOVE-Net: .*9 characters/);
		assert.match(lines[1], /^Our address on DOVE-Net: .*may not contain ' '/);
	});

	it('treats the same ID in the same role on two networks as a duplicate', function () {
		// One namespace per board, as in Synchronet: the directory and the
		// packet are named by the ID alone.
		var lines = auditQwkIds([
			{ id: 1, network_id: 1, peer_name: 'A', connection_data: { remote_qwk_id: 'SAMEID', transport: 'ftp' } },
			{ id: 2, network_id: 2, peer_name: 'B', connection_data: { remote_qwk_id: 'SAMEID', transport: 'ftp' } }
		], [], nets);
		assert.strictEqual(lines.length, 1);
		assert.match(lines[0], /^B on Longnet: QWK ID SAMEID is also used by A on DOVE-Net/);
	});

	it('names a space as a space, not as a non-printable character', function () {
		assert.match(checkQwkId('A B').errors[0], /may not contain ' '$/);
	});

	it('is silent about a system that is both our hub and our node', function () {
		assert.deepStrictEqual(auditQwkIds([
			{ id: 4, network_id: 1, peer_name: 'U', connection_data: { remote_qwk_id: 'UNDRMINE', transport: 'ftp' } },
			{ id: 5, network_id: 2, peer_name: 'U', connection_data: { remote_qwk_id: 'UNDRMINE', transport: 'hub' } }
		], [], nets), []);
	});
});

describe('QWK ID rules where saves happen', function () {
	this.timeout(30000);

	var DOMAIN = 'zzqwkidtest';
	var available = false;
	var pg, peers, peerConnections, msgNetworks, systemAddresses;
	var networkId = null, networkUuid = null, peerId = null;

	async function cleanup() {
		var nets = await pg.query('SELECT id FROM message_networks WHERE domain = $1', [DOMAIN]);
		for (var n of nets || []) {
			var cs = await pg.query('SELECT id, peer_id FROM peer_connections WHERE network_id = $1', [n.id]);
			for (var c of cs || []) {
				await pg.write('DELETE FROM peer_area_subscriptions WHERE peer_connection_id = $1', [c.id]);
				await pg.write('DELETE FROM peer_connections WHERE id = $1', [c.id]);
			}
			await pg.write('DELETE FROM system_addresses WHERE network_id = $1', [n.id]);
			await pg.write('DELETE FROM message_networks WHERE id = $1', [n.id]);
		}
		await pg.write("DELETE FROM peers WHERE name = 'ZZ QWK ID Test Peer'");
		await pg.write("DELETE FROM notifications WHERE type = 'qwk_id_problem' AND body LIKE '%ZZ QWK ID Test%'");
	}

	async function addConn(id, transport) {
		return peerConnections.newConnection({ peer_id: peerId, network_id: networkId, connection_type: 'QWK',
			transport: transport, host: transport === 'hub' ? '' : 'hub.zz.invalid', remote_qwk_id: id });
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
			await cleanup();
			var n = await msgNetworks.newNetwork({ name: 'ZZ QWK ID Test', domain: DOMAIN, description: 'temporary', network_type: 'QWK' });
			var p = await peers.newPeer({ name: 'ZZ QWK ID Test Peer', sysop_name: 'ZZ Test' });
			if (!n.status || !p.status) { available = false; return; }
			networkId = n.insertId; networkUuid = n.insertUUID; peerId = p.insertId;
		} catch (_) { available = false; }
	});

	beforeEach(function () { if (!available) this.skip(); });
	after(async function () { if (pg && available) { try { await cleanup(); } catch (_) {} } });

	it('refuses a second connection using a QWK ID in the same role, naming the first', async function () {
		var first = await addConn('zzhuba', 'ftp');
		assert.ok(first.status, first.errormessages.join('; '));
		var row = await peerConnections.getConnectionByUUID(first.insertUUID);
		assert.strictEqual(row.connection_data.remote_qwk_id, 'ZZHUBA', 'stored upper case');

		var second = await addConn('ZZHUBA', 'http');
		assert.strictEqual(second.status, false);
		assert.match(second.errormessages.join(' '), /already used by the connection to ZZ QWK ID Test Peer on ZZ QWK ID Test, where it is our hub/);
	});

	it('allows the same QWK ID once as our node', async function () {
		var node = await addConn('ZZHUBA', 'hub');
		assert.ok(node.status, node.errormessages.join('; '));
	});

	it('refuses an edit that would make a clash', async function () {
		var other = await addConn('ZZHUBB', 'ftp');
		assert.ok(other.status);
		var r = await peerConnections.updateConnection(other.insertUUID, { qwk_remote_qwk_id: 'ZZHUBA' });
		assert.strictEqual(r.status, false);
		assert.match(r.errormessages.join(' '), /already used/);
	});

	it('refuses a long ID until the network allows long IDs, and passes warnings back', async function () {
		var r = await addConn('ZZLONGHUBID', 'ftp');
		assert.strictEqual(r.status, false);
		assert.match(r.errormessages.join(' '), /11 characters; the limit is 8/);

		var up = await msgNetworks.updateNetwork(networkUuid, { config: { qwk_long_ids: true } });
		assert.ok(up.status, up.errormessages.join('; '));
		r = await addConn('9ZZLONGHUBID', 'ftp');
		assert.ok(r.status, r.errormessages.join('; '));
		assert.match((r.warnings || []).join(' '), /starts with a digit/);
	});

	it('will not stop allowing long IDs while one is in use', async function () {
		var r = await msgNetworks.updateNetwork(networkUuid, { config: { qwk_long_ids: false } });
		assert.strictEqual(r.status, false);
		assert.match(r.errormessages.join(' '), /9ZZLONGHUBID \(connection to ZZ QWK ID Test Peer\)/);
	});

	it('reports a duplicate that predates the rules at startup, once', async function () {
		// A board upgraded into #67 may already hold one. Written straight to
		// the table, as an older release could have.
		var src = await pg.queryOne("SELECT pc.* FROM peer_connections pc WHERE pc.network_id = $1 AND pc.connection_data->>'remote_qwk_id' = 'ZZHUBA' AND pc.connection_data->>'transport' = 'ftp'", [networkId]);
		await pg.write(
			'INSERT INTO peer_connections (uuid, peer_id, network_id, connection_type, connection_data, active, poll_enabled, created_at) ' +
			"VALUES (gen_random_uuid(), $1, $2, 'QWK', $3, true, false, NOW())",
			[peerId, networkId, JSON.stringify(Object.assign({}, src.connection_data, { transport: 'http' }))]);
		var audit = await import('../src/maintenance/qwkIdAudit.js');
		var first = await audit.auditQwkIdsAndNotify();
		assert.ok(first.problems >= 1);
		assert.strictEqual(first.notified, true);
		var row = await pg.queryOne("SELECT body FROM notifications WHERE type = 'qwk_id_problem' ORDER BY id DESC LIMIT 1");
		assert.match(row.body, /QWK ID ZZHUBA is also used by ZZ QWK ID Test Peer on ZZ QWK ID Test in the same role \(our hub\)/);
		var again = await audit.auditQwkIdsAndNotify();
		assert.strictEqual(again.notified, false, 'the same problems are not raised on every restart');
	});

	it('holds our own address on the network to the same rules', async function () {
		var bad = await systemAddresses.newAddress({ network_id: networkId, address: 'ZZ BAD' });
		assert.strictEqual(bad.status, false);
		assert.match(bad.errormessages.join(' '), /may not contain ' '/);
		var good = await systemAddresses.newAddress({ network_id: networkId, address: 'zzours' });
		assert.ok(good.status, good.errormessages.join('; '));
		var row = await pg.queryOne('SELECT address FROM system_addresses WHERE id = $1', [good.insertId]);
		assert.strictEqual(row.address, 'ZZOURS');
	});
});

describe('QWK ID refusals reach the sysop', function () {
	it('every save on the network and peer pages flashes its result', function () {
		var src = fs.readFileSync(path.join(ROOT, 'src/routes/admin.js'), 'utf8');
		for (var route of ["router.post('/network/:uuid/update'", "router.post('/network/:uuid/newaddress'",
			"router.post('/address/:uuid/update'", "router.post('/peer/:uuid/newconnection'",
			"router.post('/connection/:uuid/update'"]) {
			var start = src.indexOf(route);
			assert.ok(start !== -1, route);
			var body = src.slice(start, src.indexOf('\n});', start));
			assert.match(body, /await flashSaveResult\(req, result,/, route);
		}
		for (var view of ['admin/msgNets/view', 'admin/peers/view']) {
			var at = src.indexOf("res.render('" + view + "'");
			assert.match(src.slice(at - 80, at), /res\.locals\.flash = await flash\.get\(req\);/, view);
			assert.match(fs.readFileSync(path.join(ROOT, 'src/views/' + view + '.pug'), 'utf8'), /include \.\.\/\.\.\/partials\/flash/, view);
		}
	});
});
