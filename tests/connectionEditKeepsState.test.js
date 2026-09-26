// tests/connectionEditKeepsState.test.js: saving a peer connection's edit form
// keeps the state the system writes for itself (#66).
//
// updateConnection rebuilt connection_data from buildConnectionData, which
// returns only the keys a form edits, so every save dropped NNTP/QWK
// high_water_marks (the next NNTP pull restarted each group from its first
// article) and the FTN connect backoff. Backoff is now cleared only when the
// dial target changes, since those failures were against the old target.
//
// Fixture: a throwaway ZZ peer with one NNTP and one FTN connection, removed
// afterwards.

import assert from 'assert';
import { dbAvailable } from './helpers/dbAvailable.js';
import { mergeConnectionData } from '../src/models/peerConnections.js';

var BACKOFF = {
	consecutive_failures: 3,
	last_failure_at:      '2026-09-25T10:00:00.000Z',
	last_failure_reason:  'ECONNREFUSED',
	next_allowed_poll_at: '2099-01-01T00:00:00.000Z',
	last_success_at:      '2026-09-20T10:00:00.000Z'
};

describe('peerConnections.mergeConnectionData', function () {

	it('keeps NNTP high_water_marks through an unrelated edit', function () {
		var stored = { host: 'news.example', port: 119, pull_interval_minutes: 60,
			high_water_marks: { 'comp.misc': 4512 } };
		var out = mergeConnectionData('NNTP', stored, { nntp_pull_interval_minutes: '30' });
		assert.deepStrictEqual(out.high_water_marks, { 'comp.misc': 4512 });
		assert.strictEqual(out.pull_interval_minutes, 30);
	});

	it('keeps QWK high_water_marks through an unrelated edit', function () {
		var stored = { transport: 'ftp', host: 'bbs.example', port: 21, high_water_marks: { DOVE: 77 } };
		var out = mergeConnectionData('QWK', stored, { qwk_username: 'sysop' });
		assert.deepStrictEqual(out.high_water_marks, { DOVE: 77 });
		assert.strictEqual(out.username, 'sysop');
	});

	it('keeps FTN backoff when the dial target is unchanged', function () {
		var stored = Object.assign({ address: '1:2/3', remote_host: 'a.example', poll_interval: 60 }, BACKOFF);
		var out = mergeConnectionData('FTN', stored, { ftn_areafix_password: 'x' });
		for (var k of Object.keys(BACKOFF)) assert.strictEqual(out[k], BACKOFF[k], k);
	});

	it('does not read a key an old row lacks as a changed target', function () {
		// No mailer_transport/protocol stored: the rebuild defaults them, which
		// must not count as a redial.
		var stored = Object.assign({ address: '1:2/3', remote_host: 'a.example' }, BACKOFF);
		var out = mergeConnectionData('FTN', stored, { poll_interval_minutes: '30' });
		assert.strictEqual(out.consecutive_failures, 3);
	});

	for (var change of [
		{ ftn_remote_host: 'b.example' },
		{ ftn_remote_port: '24555' },
		{ ftn_address: '1:2/4' },
		{ ftn_mailer_transport: 'ws', ftn_mailer_ws_url: 'wss://b.example/binkp' }
	]) {
		(function (form) {
			it('clears FTN backoff when ' + Object.keys(form)[0] + ' changes, keeping history', function () {
				var stored = Object.assign({ address: '1:2/3', remote_host: 'a.example', remote_port: 24554 }, BACKOFF);
				var out = mergeConnectionData('FTN', stored, form);
				assert.strictEqual(out.consecutive_failures, 0);
				assert.strictEqual(out.next_allowed_poll_at, null);
				assert.strictEqual(out.last_failure_reason, null);
				assert.strictEqual(out.last_failure_at, BACKOFF.last_failure_at);
				assert.strictEqual(out.last_success_at, BACKOFF.last_success_at);
			});
		})(change);
	}
});

describe('peerConnections.updateConnection keeps runtime state (#66)', function () {
	this.timeout(30000);

	var PEER_NAME = 'ZZ Connection Edit Test Peer';
	var available = false;
	var pg = null, peers = null, peerConnections = null;
	var peerId = null, nntpUuid = null, ftnUuid = null;

	async function setData(uuid, data) {
		await pg.write('UPDATE peer_connections SET connection_data = connection_data || $1::jsonb WHERE uuid = $2',
			[JSON.stringify(data), uuid]);
	}

	before(async function () {
		try {
			available = await dbAvailable();
			if (!available) return;
			pg              = await import('../src/middleware/db/postgres.js');
			peers           = await import('../src/models/peers.js');
			peerConnections = await import('../src/models/peerConnections.js');

			var nntpNet = await pg.queryOne("SELECT id FROM message_networks WHERE network_type = 'NNTP' AND active LIMIT 1");
			var ftnNet  = await pg.queryOne("SELECT id FROM message_networks WHERE network_type = 'FTN' AND active LIMIT 1");
			if (!nntpNet || !ftnNet) { available = false; return; }

			var stale = await pg.query('SELECT id FROM peers WHERE name = $1', [PEER_NAME]);
			for (var old of stale || []) {
				await pg.write('DELETE FROM peer_area_subscriptions WHERE peer_connection_id IN (SELECT id FROM peer_connections WHERE peer_id = $1)', [old.id]);
				await pg.write('DELETE FROM peer_connections WHERE peer_id = $1', [old.id]);
				await pg.write('DELETE FROM peers WHERE id = $1', [old.id]);
			}

			var p = await peers.newPeer({ name: PEER_NAME, sysop_name: 'ZZ Test' });
			if (!p.status) { available = false; return; }
			peerId = p.insertId;

			var n = await peerConnections.newConnection({ peer_id: peerId, network_id: nntpNet.id,
				connection_type: 'NNTP', host: 'news.zz.invalid' });
			var f = await peerConnections.newConnection({ peer_id: peerId, network_id: ftnNet.id,
				connection_type: 'FTN', address: '1:999/9998', remote_host: 'a.zz.invalid' });
			if (!n.status || !f.status) { available = false; return; }
			nntpUuid = n.insertUUID;
			ftnUuid  = f.insertUUID;
		} catch (_) {
			available = false;
		}
	});

	beforeEach(function () { if (!available) this.skip(); });

	after(async function () {
		if (!pg || !peerId) return;
		try {
			await pg.write('DELETE FROM peer_area_subscriptions WHERE peer_connection_id IN (SELECT id FROM peer_connections WHERE peer_id = $1)', [peerId]);
			await pg.write('DELETE FROM peer_connections WHERE peer_id = $1', [peerId]);
			await pg.write('DELETE FROM peers WHERE id = $1', [peerId]);
		} catch (_) {}
	});

	it('an NNTP save keeps high_water_marks', async function () {
		await setData(nntpUuid, { high_water_marks: { 'zz.test': 4512 } });
		var r = await peerConnections.updateConnection(nntpUuid, { nntp_pull_interval_minutes: '30' });
		assert.ok(r.status, r.errormessages.join('; '));
		var conn = await peerConnections.getConnectionByUUID(nntpUuid);
		assert.deepStrictEqual(conn.connection_data.high_water_marks, { 'zz.test': 4512 });
		assert.strictEqual(conn.connection_data.pull_interval_minutes, 30);
	});

	it('an FTN save keeps backoff, and a new host clears it', async function () {
		await setData(ftnUuid, BACKOFF);
		var r = await peerConnections.updateConnection(ftnUuid, { ftn_areafix_password: 'zz' });
		assert.ok(r.status, r.errormessages.join('; '));
		var cd = (await peerConnections.getConnectionByUUID(ftnUuid)).connection_data;
		assert.strictEqual(cd.consecutive_failures, 3);
		assert.strictEqual(cd.next_allowed_poll_at, BACKOFF.next_allowed_poll_at);

		r = await peerConnections.updateConnection(ftnUuid, { ftn_remote_host: 'b.zz.invalid' });
		assert.ok(r.status, r.errormessages.join('; '));
		cd = (await peerConnections.getConnectionByUUID(ftnUuid)).connection_data;
		assert.strictEqual(cd.consecutive_failures, 0);
		assert.strictEqual(cd.next_allowed_poll_at, null);
		assert.strictEqual(cd.last_success_at, BACKOFF.last_success_at);
	});
});
