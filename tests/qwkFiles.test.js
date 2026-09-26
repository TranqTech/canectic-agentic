// tests/qwkFiles.test.js: files carried in QWK packets, both directions (#72).
//
// Synchronet carries files over QWKnet as extra members of the packet archive
// (pack_rep.cpp, pack_qwk.cpp, un_qwk.cpp, un_rep.cpp). Canectic deleted any it
// received, without a word, with the extracted directory, and never sent any.
// Now out/files/ goes with the next packet and extras received are kept.
//
// The chain is run for real: a client push over the directory transport, the
// hub importing that REP, and a hub packet whose files go only on commit.
// Fixture: a throwaway QWK network (zzqwkfiletest) with our address ZZFLOCAL,
// a client link to hub ZZFHUB and a hub link for node ZZFNODE; all removed.

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { dbAvailable } from './helpers/dbAvailable.js';
import { isStandardMember, isSafeFileName, listOutgoing, receiveExtraFiles } from '../src/models/qwkFiles.js';

function zipNames(zipPath) {
	var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zzqf-'));
	try {
		require_unzip(zipPath, dir);
		return fs.readdirSync(dir).sort();
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}
var require_unzip = null;

describe('which packet members are files', function () {
	it('treats the packet\'s own members as not files', function () {
		for (var n of ['CONTROL.DAT', 'messages.dat', 'HEADERS.DAT', 'VOTING.DAT', 'NETFLAGS.DAT', 'DOOR.ID',
			'TOREADER.EXT', 'TODOOR.EXT', 'ATTXREF.DAT', 'PERSONAL.NDX', '001.NDX', 'VERT.MSG']) {
			assert.strictEqual(isStandardMember(n), true, n);
		}
		for (var f of ['NEWFILES.DAT', 'CERTREP.DAT', 'hello.txt', 'NODELIST.Z12']) {
			assert.strictEqual(isStandardMember(f), false, f);
		}
	});

	it('only accepts plain file names', function () {
		assert.strictEqual(isSafeFileName('NODELIST.Z12'), true);
		assert.strictEqual(isSafeFileName('my-file_1.txt'), true);
		for (var bad of ['', '.hidden', '../x', 'a/b', 'a b', 'x\u0000']) assert.strictEqual(isSafeFileName(bad), false, JSON.stringify(bad));
	});
});

describe('files on the disk', function () {
	var root;
	beforeEach(function () { root = fs.mkdtempSync(path.join(os.tmpdir(), 'zzqf-root-')); });
	afterEach(function () { fs.rmSync(root, { recursive: true, force: true }); });
	var CD = { remote_qwk_id: 'PEER', transport: 'ftp' };

	it('sends what is in out/files, leaving names a packet uses itself', function () {
		var dir = path.join(root, 'qnet', 'PEER.hub', 'out', 'files');
		fs.mkdirSync(dir, { recursive: true });
		for (var n of ['GOOD.TXT', 'MESSAGES.DAT', '.partial']) fs.writeFileSync(path.join(dir, n), n);
		assert.deepStrictEqual(listOutgoing(CD, root).map(function (f) { return f.name; }), ['GOOD.TXT']);
	});

	it('keeps extras from an extracted packet in in/files, overwriting, and refuses unsafe names', async function () {
		var ex = path.join(root, 'extracted');
		fs.mkdirSync(ex);
		fs.writeFileSync(path.join(ex, 'MESSAGES.DAT'), 'm');
		fs.writeFileSync(path.join(ex, 'ZZNEW.TXT'), 'new');
		fs.writeFileSync(path.join(ex, 'bad name.txt'), 'x');
		var inFiles = path.join(root, 'qnet', 'PEER.hub', 'in', 'files');
		fs.mkdirSync(inFiles, { recursive: true });
		fs.writeFileSync(path.join(inFiles, 'ZZNEW.TXT'), 'old');
		var r = await receiveExtraFiles(ex, CD, 'PEER', root);
		assert.deepStrictEqual(r.received.map(function (x) { return x.name; }), ['ZZNEW.TXT']);
		assert.deepStrictEqual(r.refused, ['bad name.txt']);
		assert.strictEqual(fs.readFileSync(path.join(inFiles, 'ZZNEW.TXT'), 'utf8'), 'new', 'same name overwrites, as Synchronet does');
		assert.strictEqual(fs.existsSync(path.join(ex, 'MESSAGES.DAT')), true, 'packet members are not files');
	});
});

describe('files through real packets (#72)', function () {
	this.timeout(60000);

	var DOMAIN = 'zzqwkfiletest';
	var available = false;
	var pg, peers, peerConnections, msgNetworks, systemAddresses, qwkTosser, qwkPacketBuilder, qwkClasses, qwkFiles;
	var hubUuid, nodeUuid, outbox, peerId;
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
			await pg.write('DELETE FROM system_addresses WHERE network_id = $1', [n.id]);
			await pg.write('DELETE FROM message_networks WHERE id = $1', [n.id]);
		}
		await pg.write("DELETE FROM peers WHERE name = 'ZZ QWK File Test Peer'");
		await pg.write("DELETE FROM notifications WHERE type = 'qwk_file_received' AND title LIKE '%ZZ%'");
		for (var d of ['ZZFHUB.hub', 'ZZFNODE.node']) fs.rmSync(path.join(CWD, 'qnet', d), { recursive: true, force: true });
		if (outbox) fs.rmSync(outbox, { recursive: true, force: true });
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
			qwkFiles         = await import('../src/models/qwkFiles.js');
			require_unzip    = qwkClasses.unzipQwkPacket;
			await cleanup();
			outbox = fs.mkdtempSync(path.join(os.tmpdir(), 'zzqf-outbox-'));
			var n = await msgNetworks.newNetwork({ name: 'ZZ QWK File Test', domain: DOMAIN, description: 'temporary', network_type: 'QWK' });
			if (!n.status) { available = false; return; }
			await systemAddresses.newAddress({ network_id: n.insertId, address: 'ZZFLOCAL' });
			var p = await peers.newPeer({ name: 'ZZ QWK File Test Peer', sysop_name: 'ZZ Test' });
			peerId = p.insertId;
			var h = await peerConnections.newConnection({ peer_id: peerId, network_id: n.insertId, connection_type: 'QWK',
				transport: 'directory', remote_qwk_id: 'ZZFHUB', remote_outbox: outbox + '/', remote_inbox: outbox + '/' });
			var d = await peerConnections.newConnection({ peer_id: peerId, network_id: n.insertId, connection_type: 'QWK',
				transport: 'hub', remote_qwk_id: 'ZZFNODE' });
			if (!h.status || !d.status) { available = false; return; }
			hubUuid = h.insertUUID; nodeUuid = d.insertUUID;
		} catch (err) {
			available = false;
		}
	});

	beforeEach(function () { if (!available) this.skip(); });
	after(async function () { if (pg && available) { try { await cleanup(); } catch (_) {} } });

	it('a client push carries out/files to the hub, even with no messages, and clears them once delivered', async function () {
		var outFiles = path.join(CWD, 'qnet', 'ZZFHUB.hub', 'out', 'files');
		fs.mkdirSync(outFiles, { recursive: true });
		fs.writeFileSync(path.join(outFiles, 'ZZUP.TXT'), 'up we go');
		var r = await qwkTosser.pushToQwkPeer(hubUuid);
		assert.ok(r.status, (r.errormessages || []).join('; '));
		var rep = path.join(outbox, 'ZZFHUB.rep');
		assert.ok(fs.existsSync(rep), 'the REP was delivered');
		assert.ok(zipNames(rep).indexOf('ZZUP.TXT') !== -1, 'with the file in it');
		assert.deepStrictEqual(fs.readdirSync(outFiles), [], 'sent files are removed');
		assert.strictEqual(fs.existsSync(path.join(CWD, 'qnet', 'ZZFHUB.hub', 'out', 'ZZFHUB.rep.files.json')), false);
	});

	it('the hub keeps a file that arrives in a node\'s REP, and tells the sysop', async function () {
		var inDir = path.join(CWD, 'qnet', 'ZZFNODE.node', 'in');
		fs.mkdirSync(inDir, { recursive: true });
		fs.copyFileSync(path.join(outbox, 'ZZFHUB.rep'), path.join(inDir, 'ZZFLOCAL.rep'));
		var r = await qwkTosser.pullFromQwkPeer(nodeUuid);
		assert.ok(r.status, (r.errormessages || []).join('; '));
		assert.strictEqual(r.filesReceived, 1);
		assert.strictEqual(fs.readFileSync(path.join(inDir, 'files', 'ZZUP.TXT'), 'utf8'), 'up we go');
		var note = await pg.queryOne("SELECT title FROM notifications WHERE type = 'qwk_file_received' ORDER BY id DESC LIMIT 1");
		assert.strictEqual(note.title, 'Received ZZUP.TXT from ZZFNODE via QWK');
	});

	it('a hub packet carries a node\'s files, and removes them only when the node has the packet', async function () {
		var outFiles = path.join(CWD, 'qnet', 'ZZFNODE.node', 'out', 'files');
		fs.mkdirSync(outFiles, { recursive: true });
		fs.writeFileSync(path.join(outFiles, 'ZZDOWN.TXT'), 'down we go');
		var built = await qwkPacketBuilder.buildQwkForNode(nodeUuid);
		assert.ok(built.qwkPath, 'a packet with only a file is still built: ' + built.errormessages.join('; '));
		assert.ok(zipNames(built.qwkPath).indexOf('ZZDOWN.TXT') !== -1);
		assert.ok(fs.existsSync(path.join(outFiles, 'ZZDOWN.TXT')), 'still there until the node has it');
		var c = await qwkPacketBuilder.commitNodePacket(nodeUuid, built.packetId);
		assert.ok(c.committed);
		assert.strictEqual(fs.existsSync(path.join(outFiles, 'ZZDOWN.TXT')), false);
	});
});
