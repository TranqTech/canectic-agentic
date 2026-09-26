// tests/networkTransfers.test.js — one row per QWK or NNTP pull or push.
//
// DOVE-Net stopped arriving on the development board on 2026-09-12 and nobody
// could say so for two weeks: the QWK and NNTP tossers kept no history, their
// detail went to tosser.log, and the worker logged "Toss job qwk:pull
// finished" and published "Messages imported" after every pull, failed or
// empty. Undermine's FTP server timing out on every pull looked the same as a
// pull with nothing waiting.
//
// network_transfers now takes a row per attempt through networkTransfers.track,
// which wraps the four tosser entry points; transferFormat decides what to call
// each one. First live row (2026-09-25): Undermine, QWK pull, `timeout` at
// `connect`, "Timeout (control socket)", 30.1s.
//
// Run: npx mocha --no-config --exit tests/networkTransfers.test.js

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
	classifyTransfer, describeResult, importedAnything, isSuccess, summariseTransfers
} from '../src/utils/transferFormat.js';
import { rowFor } from '../src/models/networkTransfers.js';
import { retentionDaysFor, RETENTION_JOBS } from '../src/maintenance/retention.js';
import { MAINTENANCE_JOBS } from '../src/maintenance/maintenanceJobs.js';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function fail(stage, msg) { return { status: false, stage: stage, errormessages: [msg] }; }

describe('classifying a transfer', function () {
	it('calls the Undermine pull what it was: a timeout reaching the server', function () {
		assert.strictEqual(classifyTransfer(fail('connect', 'Timeout (control socket)'), 'pull'), 'timeout');
	});

	it('tells the failures apart by stage and message', function () {
		assert.strictEqual(classifyTransfer(fail('config', 'No host configured for connection x'), 'pull'), 'config_error');
		assert.strictEqual(classifyTransfer(fail('connect', 'connect ECONNREFUSED 10.0.0.1:21'), 'pull'), 'connect_failed');
		assert.strictEqual(classifyTransfer(fail('download', 'getaddrinfo ENOTFOUND x'), 'pull'), 'connect_failed');
		assert.strictEqual(classifyTransfer(fail('connect', '530 Login incorrect.'), 'pull'), 'auth_failed');
		assert.strictEqual(classifyTransfer(fail('auth', 'NNTP authentication failed for news.x'), 'pull'), 'auth_failed');
		assert.strictEqual(classifyTransfer(fail('download', '426 Connection closed; transfer aborted'), 'pull'), 'transfer_failed');
		assert.strictEqual(classifyTransfer(fail('import', 'relation "mb_x_msgs" does not exist'), 'pull'), 'processing_failed');
		assert.strictEqual(classifyTransfer(fail('', 'something else'), 'pull'), 'failed');
	});

	it('counts a push with an error as failed even though it returns status true', function () {
		// Both push functions set status true after a failed upload so the
		// index can advance past what did go. Status alone would read "ok".
		var r = { status: true, stage: 'upload', totalPosted: 0, errormessages: ['Timeout (data socket)'] };
		assert.strictEqual(classifyTransfer(r, 'push'), 'timeout');
		assert.strictEqual(isSuccess(classifyTransfer(r, 'push')), false);
	});

	it('separates a success that moved nothing from one that moved mail', function () {
		var ok = { status: true, errormessages: [] };
		assert.strictEqual(classifyTransfer(Object.assign({}, ok, { totalImported: 0 }), 'pull'), 'idle');
		assert.strictEqual(classifyTransfer(Object.assign({}, ok, { totalImported: 3 }), 'pull'), 'complete');
		assert.strictEqual(classifyTransfer(Object.assign({}, ok, { totalDuplicate: 5 }), 'pull'), 'complete', 'a packet of duplicates still arrived');
		assert.strictEqual(classifyTransfer(Object.assign({}, ok, { bytes: 900 }), 'push'), 'complete', 'a held-over REP delivered');
		assert.strictEqual(classifyTransfer(Object.assign({}, ok, { totalPosted: 2 }), 'push'), 'complete');
		assert.strictEqual(classifyTransfer(Object.assign({}, ok, { totalPosted: 2, totalRejected: 1 }), 'push'), 'partial');
	});
});

describe('what the worker says about a job', function () {
	it('says a failure failed, where, and why, at level 2', function () {
		var d = describeResult('QWK', 'pull', 'eddbb313', fail('connect', 'Timeout (control socket)'));
		assert.strictEqual(d.ok, false);
		assert.strictEqual(d.level, 2);
		assert.strictEqual(d.text, 'QWK pull eddbb313 FAILED (timeout at connect): Timeout (control socket)');
	});

	it('gives the counts on success, and keeps an empty pull quiet', function () {
		var d = describeResult('NNTP', 'pull', 'u', { status: true, totalImported: 4, totalDuplicate: 1, errormessages: [] });
		assert.strictEqual(d.text, 'NNTP pull u: imported 4, duplicates 1');
		var idle = describeResult('QWK', 'push', 'u', { status: true, totalPosted: 0, errormessages: [] });
		assert.strictEqual(idle.level, 3);
		assert.match(idle.text, /nothing to transfer/);
	});

	it('announces imported messages only when there were some', function () {
		assert.strictEqual(importedAnything(null), false);
		assert.strictEqual(importedAnything(fail('connect', 'x')), false);
		assert.strictEqual(importedAnything({ status: true, totalImported: 0 }), false);
		// A pull that failed part way through import did bring some in.
		assert.strictEqual(importedAnything({ status: false, totalImported: 2, errormessages: ['x'] }), true);
	});

	['bin/worker.js', 'src/queues/embedded.js'].forEach(function (rel) {
		it(rel + ' no longer publishes MESSAGES_IMPORTED after every pull', function () {
			var src = read(rel);
			for (var job of ["'qwk:pull'", "'qwk:hub:inbound'", "'nntp:pull'"]) {
				var start = src.indexOf('case ' + job);
				var body = src.slice(start, src.indexOf('break;', start));
				assert.match(body, /reportTransfer\(/, job + ' does not report its result');
				assert.match(body, /if \(transferFormat\.importedAnything\(/, job + ' publishes unconditionally');
			}
		});
	});
});

describe('the row', function () {
	var conn = { id: 4, peer_id: 1, network_id: 7, connection_data: { host: 'bbs.undermine.lan', port: 21 } };
	var t0 = new Date('2026-09-25T22:29:00Z'), t1 = new Date('2026-09-25T22:29:30.101Z');

	it('carries the connection, the host and the timing', function () {
		var row = rowFor('QWK', 'pull', 'eddbb313', conn, fail('connect', 'Timeout (control socket)'), t0, t1);
		assert.strictEqual(row.peer_connection_id, 4);
		assert.strictEqual(row.peer_id, 1);
		assert.strictEqual(row.network_id, 7);
		assert.strictEqual(row.remote_host, 'bbs.undermine.lan:21');
		assert.strictEqual(row.transport, 'ftp');
		assert.strictEqual(row.outcome, 'timeout');
		assert.strictEqual(row.stage, 'connect');
		assert.strictEqual(row.reason, 'Timeout (control socket)');
		assert.strictEqual(row.duration_ms, 30101);
	});

	it('is still a row when the connection is gone', function () {
		var row = rowFor('NNTP', 'push', 'gone', null, fail('config', 'Connection not found or inactive: gone'), t0, t1);
		assert.strictEqual(row.peer_connection_id, null);
		assert.strictEqual(row.connection_uuid, 'gone');
		assert.strictEqual(row.transport, 'nntp');
		assert.strictEqual(row.outcome, 'config_error');
	});
});

describe('the page summary', function () {
	var now = new Date('2026-09-25T12:00:00Z');
	it('shows when mail last arrived, apart from when a pull last worked', function () {
		var s = summariseTransfers(
			{ attempts: 12, successes: 12, messages_in: 0, duplicates: 0, messages_out: 0, bytes: '0' },
			{ last_contact: '2026-09-25T11:00:00Z', last_success: '2026-09-25T11:00:00Z',
				last_mail: '2026-09-12T08:00:00Z', last_outcome: 'idle' },
			{ now: now });
		assert.strictEqual(s.failing, false);
		assert.strictEqual(s.successRate, 100);
		assert.strictEqual(s.lastMailAge, '13d');
	});

	it('flags a connection whose pulls keep failing', function () {
		var s = summariseTransfers({ attempts: 10, successes: 0 },
			{ last_contact: '2026-09-25T11:00:00Z', last_success: null, last_outcome: 'timeout' }, { now: now });
		assert.strictEqual(s.failing, true);
		assert.strictEqual(s.successRate, 0);
	});
});

describe('every entry point records', function () {
	it('the tosser functions callers use are the recorded wrappers', function () {
		var qwk = read('src/middleware/tossers/qwkTosser.js');
		assert.match(qwk, /async function pullFromQwkPeer\(peerConnectionUUID\) \{\s*return await networkTransfers\.track\('QWK', 'pull'/);
		assert.match(qwk, /async function pushToQwkPeer\(peerConnectionUUID\) \{\s*return await networkTransfers\.track\('QWK', 'push'/);
		var nntp = read('src/middleware/tossers/nntpTosser.js');
		assert.match(nntp, /async function pullFromPeer\(peerConnectionUUID\) \{\s*return await networkTransfers\.track\('NNTP', 'pull'/);
		assert.match(nntp, /async function pushToNntpPeer\(peerConnectionUUID\) \{\s*return await networkTransfers\.track\('NNTP', 'push'/);
	});

	it('does not record a success that never contacted the server', function () {
		// Undermine's pulls all timed out, and the page still said "last
		// success: just now" because its push had nothing to send and returned
		// success without connecting. Every such short cut is marked.
		var qwk = read('src/middleware/tossers/qwkTosser.js');
		var nothing = qwk.slice(qwk.indexOf("'pushToQwkPeer: nothing to post for '"));
		assert.match(nothing.slice(0, 600), /returnObj\.notRecorded = true/);
		var nntp = read('src/middleware/tossers/nntpTosser.js');
		for (var marker of ["'pushToNntpPeer: nothing to post for '", "'pushToNntpPeer: no enabled subscriptions for '", "'pullFromPeer: no mapped areas for network '"]) {
			var at = nntp.indexOf(marker);
			assert.ok(at > 0, marker);
			assert.match(nntp.slice(at, at + 400), /returnObj\.notRecorded = true/, marker);
		}
	});

	it('is purged daily, keeping 30 days unless set otherwise', function () {
		assert.ok(RETENTION_JOBS['purge-network-transfers']);
		assert.ok(MAINTENANCE_JOBS.includes('purge-network-transfers'));
		var get = function (k, d) { return k === 'network_transfer_retention_days' ? 30 : d; };
		assert.strictEqual(retentionDaysFor('purge-network-transfers', {}, get), 30);
		assert.strictEqual(retentionDaysFor('purge-network-transfers', {}, function () { return 0; }), null);
	});
});

describe('track against the database', function () {
	this.timeout(15000);
	var nt = null, pg = null, available = false;
	var UUID = 'zz-test-transfer-0000-000000000001';

	before(async function () {
		try {
			pg = await import('../src/middleware/db/postgres.js');
			nt = await import('../src/models/networkTransfers.js');
			await pg.query('SELECT 1 FROM network_transfers LIMIT 1', []);
			available = true;
		} catch (_) { available = false; }
	});

	afterEach(async function () {
		if (available) await pg.write('DELETE FROM network_transfers WHERE connection_uuid = $1', [UUID]);
	});

	async function rows() {
		return await pg.query('SELECT * FROM network_transfers WHERE connection_uuid = $1 ORDER BY id', [UUID]) || [];
	}

	it('records a result and hands it back with its outcome', async function () {
		if (!available) return this.skip();
		var r = await nt.track('QWK', 'pull', UUID, async function () { return fail('connect', 'Timeout (control socket)'); });
		assert.strictEqual(r.outcome, 'timeout');
		var got = await rows();
		assert.strictEqual(got.length, 1);
		assert.strictEqual(got[0].outcome, 'timeout');
		assert.strictEqual(got[0].stage, 'connect');
	});

	it('records an exception, then rethrows it', async function () {
		if (!available) return this.skip();
		await assert.rejects(nt.track('NNTP', 'push', UUID, async function () { throw new Error('boom'); }), /boom/);
		var got = await rows();
		assert.strictEqual(got.length, 1);
		assert.strictEqual(got[0].reason, 'boom');
	});

	it('writes nothing for a result marked notRecorded (a push to a hub connection)', async function () {
		if (!available) return this.skip();
		await nt.track('QWK', 'push', UUID, async function () { return { status: true, notRecorded: true, errormessages: [] }; });
		assert.strictEqual((await rows()).length, 0);
	});
});
