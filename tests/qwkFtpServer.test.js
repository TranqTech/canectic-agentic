// tests/qwkFtpServer.test.js: the QWK hub FTP server (#74).
//
// A Synchronet node calls its hub over FTP: logs in with its QWK ID, STORs
// <HUB>.rep and RETRs <HUB>.qwk at the root (exec/qnet-ftp.js, passive mode).
// Canectic had no FTP server, so such a node could not use a Canectic hub.
// Driven here with basic-ftp, the client Canectic's own tosser uses, over
// EPSV and over PASV (what qnet-ftp.js sends on IPv4).
//
// Fixture: a throwaway QWK network (zzqwkftptest), our address ZZFTPHUB, node
// ZZFTPND with password zz-secret, one private message waiting for it; all
// removed afterwards.

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Writable } from 'stream';
import { Client, enterPassiveModeIPv4 } from 'basic-ftp';
import { dbAvailable } from './helpers/dbAvailable.js';
import { parsePortRange, bareName } from '../src/servers/qwkFtpServer.js';

describe('QWK FTP helpers', function () {
	it('reads a passive port range, or none', function () {
		assert.deepStrictEqual(parsePortRange('50000-50100'), [50000, 50100]);
		assert.strictEqual(parsePortRange(''), null);
		assert.strictEqual(parsePortRange('80-90'), null, 'below 1024');
		assert.strictEqual(parsePortRange('600-500'), null);
	});

	it('takes a name with or without a leading slash', function () {
		assert.strictEqual(bareName('/HUB.qwk'), 'HUB.qwk');
		assert.strictEqual(bareName('./HUB.rep'), 'HUB.rep');
		assert.strictEqual(bareName('HUB.qwk'), 'HUB.qwk');
	});
});

describe('QWK hub FTP server (#74)', function () {
	this.timeout(60000);

	var DOMAIN = 'zzqwkftptest';
	var available = false;
	var pg, peers, peerConnections, msgNetworks, systemAddresses, qwkClasses, ftpServer;
	var server, peerId, nodeUuid, pmId, queued = [];
	var tmp;

	async function cleanup() {
		var nets = await pg.query('SELECT id FROM message_networks WHERE domain = $1', [DOMAIN]);
		for (var n of nets || []) {
			var cs = await pg.query('SELECT id, uuid FROM peer_connections WHERE network_id = $1', [n.id]);
			for (var c of cs || []) {
				await pg.write('DELETE FROM peer_area_subscriptions WHERE peer_connection_id = $1', [c.id]);
				await pg.write('DELETE FROM network_transfers WHERE connection_uuid = $1', [c.uuid]).catch(function () {});
				await pg.write('DELETE FROM peer_connections WHERE id = $1', [c.id]);
			}
			await pg.write('DELETE FROM system_addresses WHERE network_id = $1', [n.id]);
			await pg.write('DELETE FROM message_networks WHERE id = $1', [n.id]);
		}
		await pg.write("DELETE FROM peers WHERE name = 'ZZ QWK FTP Test Peer'");
		await pg.write("DELETE FROM pm_outbox WHERE subject = 'zz ftp waiting'");
		fs.rmSync(path.join(process.cwd(), 'qnet', 'ZZFTPND.node'), { recursive: true, force: true });
		if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
	}

	async function client(user, pass, pasv) {
		var c = new Client(15000);
		if (pasv) c.prepareTransfer = enterPassiveModeIPv4;
		await c.access({ host: '127.0.0.1', port: server.port, user: user, password: pass, secure: false });
		return c;
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
			qwkClasses      = await import('../src/models/qwkClasses.js');
			ftpServer       = await import('../src/servers/qwkFtpServer.js');
			await cleanup();
			tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zzftp-'));
			var n = await msgNetworks.newNetwork({ name: 'ZZ QWK FTP Test', domain: DOMAIN, description: 'temporary', network_type: 'QWK' });
			if (!n.status) { available = false; return; }
			await systemAddresses.newAddress({ network_id: n.insertId, address: 'ZZFTPHUB' });
			var p = await peers.newPeer({ name: 'ZZ QWK FTP Test Peer', sysop_name: 'ZZ Test' });
			peerId = p.insertId;
			var c = await peerConnections.newConnection({ peer_id: peerId, network_id: n.insertId, connection_type: 'QWK',
				transport: 'hub', remote_qwk_id: 'ZZFTPND', password: 'zz-secret' });
			if (!c.status) { available = false; return; }
			nodeUuid = c.insertUUID;
			await pg.write('UPDATE peer_area_subscriptions SET enabled = false WHERE peer_connection_id = $1', [c.insertId]);
			var pm = await pg.queryOne(
				"INSERT INTO pm_outbox (uuid, user_id, from_user, to_user, to_address, subject, body_text, transport_type, transport_data, queued, sent, system_time) " +
				"VALUES (gen_random_uuid(), 0, 'Zed', 'Nora', 'ZZFTPND', 'zz ftp waiting', 'hello', 'QWK', '{\"destination\":\"ZZFTPND\"}', true, false, NOW()) RETURNING id");
			pmId = pm.id;
			server = await ftpServer.startQwkFtpServer({ port: 0, host: '127.0.0.1',
				enqueueInbound: async function (uuid) { queued.push(uuid); } });
		} catch (err) {
			available = false;
		}
	});

	beforeEach(function () { if (!available) this.skip(); });
	after(async function () {
		if (server) await server.close();
		if (pg && available) { try { await cleanup(); } catch (_) {} }
	});

	it('refuses a wrong password', async function () {
		await assert.rejects(client('ZZFTPND', 'wrong'), function (err) { return err.code === 530; });
	});

	it('takes the REP at the root as <HUB>.rep and queues its import', async function () {
		var rep = qwkClasses.buildRepPacket([], 'ZZFTPHUB', tmp, 'ZZFTPND');
		var c = await client('zzftpnd', 'zz-secret');
		try {
			await c.uploadFrom(rep, 'ZZFTPHUB.rep');
		} finally { c.close(); }
		var inDir = path.join(process.cwd(), 'qnet', 'ZZFTPND.node', 'in');
		assert.strictEqual(fs.readdirSync(inDir).filter(function (f) { return /^ZZFTPND-.*\.rep$/.test(f); }).length, 1);
		assert.deepStrictEqual(queued, [nodeUuid]);
	});

	it('refuses any other upload with 553, as Synchronet does', async function () {
		var rep = path.join(tmp, 'ZZFTPHUB.rep');
		if (!fs.existsSync(rep)) qwkClasses.buildRepPacket([], 'ZZFTPHUB', tmp, 'ZZFTPND');
		var c = await client('ZZFTPND', 'zz-secret');
		try {
			await assert.rejects(c.uploadFrom(rep, 'SOMETHING.rep'), function (err) { return err.code === 553; });
		} finally { c.close(); }
	});

	it('allows one session per node', async function () {
		var first = await client('ZZFTPND', 'zz-secret');
		try {
			await assert.rejects(client('ZZFTPND', 'zz-secret'), function (err) {
				return err.code === 421 && /one concurrent FTP session/.test(err.message);
			});
		} finally { first.close(); }
		await new Promise(function (r) { setTimeout(r, 200); });
	});

	it('hands over the packet over PASV, and counts it delivered only once the download completes', async function () {
		var c = await client('ZZFTPND', 'zz-secret', true);
		var chunks = [];
		try {
			await c.downloadTo(new Writable({ write: function (ch, enc, cb) { chunks.push(ch); cb(); } }), 'ZZFTPHUB.qwk');
		} finally { c.close(); }
		var buf = Buffer.concat(chunks);
		assert.strictEqual(buf.slice(0, 2).toString('latin1'), 'PK', 'a zip');
		var row = await pg.queryOne('SELECT sent FROM pm_outbox WHERE id = $1', [pmId]);
		assert.strictEqual(row.sent, true, 'the PM in it is committed after 226');
	});

	it('says there is nothing, in Synchronet\'s words, when there is nothing', async function () {
		var c = await client('ZZFTPND', 'zz-secret');
		try {
			await assert.rejects(c.downloadTo(new Writable({ write: function (ch, e, cb) { cb(); } }), '/ZZFTPHUB.qwk'),
				function (err) { return err.code === 550 && /No QWK packet created \(no new messages\)/.test(err.message); });
		} finally { c.close(); }
	});
});

describe('turning the QWK FTP hub on and off', function () {
	it('is off by default, on port 8021 when turned on', async function () {
		var defs = await import('../src/config/configDefaults.js');
		var en = defs.getDefinition('qwk_ftp_enabled'), port = defs.getDefinition('qwk_ftp_port');
		assert.ok(en && port, 'both settings are defined');
		assert.strictEqual(en.type, 'boolean');
		assert.strictEqual(en.defaultValue, 'false');
		assert.strictEqual(port.defaultValue, '8021');
		assert.strictEqual(en.restart, true);
	});

	it('the gateway starts it only when qwk_ftp_enabled is on', function () {
		var src = fs.readFileSync('bin/gateway.js', 'utf8');
		var fn = src.slice(src.indexOf('async function startQwkFtp()'));
		fn = fn.slice(0, fn.indexOf('\n}\n'));
		assert.match(fn, /if \(!appConfig\.getBoolean\('qwk_ftp_enabled', false\)\) return/);
		assert.ok(fn.indexOf("qwk_ftp_enabled") < fn.indexOf('startQwkFtpServer('), 'checked before starting');
	});
});
