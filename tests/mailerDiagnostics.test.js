// tests/mailerDiagnostics.test.js: mailer session history and its presentation.
//
// The mailer knew all of this while a session ran and kept none of it. The only
// durable trace was the backoff state on peer_connections.connection_data,
// which is overwritten on every attempt, so "what happened the last five times
// we called this node" had no answer that outlived a log rotation.
//
// Two things here are worth pinning beyond the obvious:
//
// Byte totals come back from postgres as strings, because node-postgres hands
// BIGINT over as text rather than quietly losing precision above 2^53. Every
// formatter has to accept both or a real page shows "NaN" where the test fixture
// with a plain number showed a size.
//
// And a peer that has never been contacted is not a failing peer. Flagging a
// newly added node red before it has had a chance to poll is noise in exactly
// the view meant to cut through noise.
//
// Run: npx mocha

import assert from 'assert';
import { EventEmitter } from 'node:events';
import { dbAvailable } from './helpers/dbAvailable.js';

var fmt = null;
try { fmt = await import('../src/utils/mailerFormat.js'); } catch (_) { fmt = null; }

describe('mailerFormat.formatBytes', function () {
	before(function () { if (!fmt) this.skip(); });

	it('formats plain numbers', function () {
		assert.strictEqual(fmt.formatBytes(0), '0');
		assert.strictEqual(fmt.formatBytes(512), '512B');
		assert.strictEqual(fmt.formatBytes(2048), '2KB');
		assert.strictEqual(fmt.formatBytes(1024 * 1024 * 3), '3MB');
	});

	it('accepts the strings postgres actually returns for BIGINT', function () {
		// This is the whole reason the helper exists rather than an inline
		// expression in the template: a BIGINT column arrives as text, and
		// arithmetic on it silently produces NaN or string concatenation.
		assert.strictEqual(fmt.formatBytes('2048'), '2KB');
		assert.strictEqual(fmt.formatBytes('0'), '0');
		assert.strictEqual(fmt.formatBytes('96256'), '94KB');
	});

	it('keeps one decimal where it says something', function () {
		assert.strictEqual(fmt.formatBytes(1536), '1.5KB');
		assert.strictEqual(fmt.formatBytes(1024 * 150), '150KB',
			'past a hundred the decimal is noise');
	});

	it('renders nothing rather than a wrong zero for absent values', function () {
		assert.strictEqual(fmt.formatBytes(null), '-');
		assert.strictEqual(fmt.formatBytes(undefined), '-');
		assert.strictEqual(fmt.formatBytes(''), '-');
		assert.strictEqual(fmt.formatBytes('nonsense'), '-');
	});

	it('does not run off the end of the unit table', function () {
		assert.ok(/TB$/.test(fmt.formatBytes(1024 * 1024 * 1024 * 1024 * 5000)));
	});
});

describe('mailerFormat.relativeAge', function () {
	before(function () { if (!fmt) this.skip(); });

	var NOW = new Date('2026-09-07T12:00:00Z');
	function ago(ms) { return new Date(NOW.getTime() - ms); }

	it('reports recent activity as just now', function () {
		assert.strictEqual(fmt.relativeAge(ago(30 * 1000), NOW), 'just now');
	});

	it('steps through minutes, hours, days and weeks', function () {
		assert.strictEqual(fmt.relativeAge(ago(5 * 60000), NOW), '5m');
		assert.strictEqual(fmt.relativeAge(ago(3 * 3600000), NOW), '3h');
		assert.strictEqual(fmt.relativeAge(ago(3 * 86400000), NOW), '3d');
		assert.strictEqual(fmt.relativeAge(ago(21 * 86400000), NOW), '3w');
	});

	it('stays in hours up to two days, so an overnight gap stays legible', function () {
		assert.strictEqual(fmt.relativeAge(ago(30 * 3600000), NOW), '30h');
	});

	it('does not report a time in the future', function () {
		// Clock skew between this box and the database is normal, and "in 2m"
		// tells a sysop nothing useful about a session that already ended.
		assert.strictEqual(fmt.relativeAge(new Date(NOW.getTime() + 120000), NOW), 'just now');
	});

	it('returns null for no date so the caller picks its own placeholder', function () {
		assert.strictEqual(fmt.relativeAge(null, NOW), null);
		assert.strictEqual(fmt.relativeAge('nonsense', NOW), null);
	});

	it('accepts a timestamp string, which is what a row carries', function () {
		assert.strictEqual(fmt.relativeAge('2026-09-07T09:00:00Z', NOW), '3h');
	});
});

describe('mailerFormat.summariseConnection', function () {
	before(function () { if (!fmt) this.skip(); });

	var NOW = new Date('2026-09-07T12:00:00Z');
	function hoursAgo(h) { return new Date(NOW.getTime() - h * 3600000); }

	function summary(stats, contact) {
		return fmt.summariseConnection(stats, contact, { now: NOW });
	}

	it('reports a healthy peer', function () {
		var s = summary(
			{ attempts: 14, successes: 14, files_sent: 6, files_received: 8,
			  bytes_sent: '40960', bytes_received: '96256' },
			{ last_contact: hoursAgo(2), last_success: hoursAgo(2), last_outcome: 'complete' });
		assert.strictEqual(s.successRate, 100);
		assert.strictEqual(s.failing, false);
		assert.strictEqual(s.bytesSent, 40960, 'BIGINT strings have to be numbers by here');
	});

	it('flags a peer that has not succeeded inside the stale window', function () {
		var s = summary(
			{ attempts: 19, successes: 0 },
			{ last_contact: hoursAgo(3), last_success: hoursAgo(80), last_outcome: 'auth_failed' });
		assert.strictEqual(s.failing, true);
		assert.strictEqual(s.successRate, 0);
	});

	it('flags a peer that has been tried and has never once succeeded', function () {
		var s = summary({ attempts: 5, successes: 0 },
			{ last_contact: hoursAgo(1), last_success: null, last_outcome: 'connect_failed' });
		assert.strictEqual(s.failing, true);
		assert.strictEqual(s.lastSuccessAge, null);
	});

	it('does not flag a peer that has never been contacted at all', function () {
		// A newly added node has not failed. Painting it red before it has had
		// a chance to poll is noise in the view that exists to cut noise.
		var s = summary(null, null);
		assert.strictEqual(s.failing, false);
		assert.strictEqual(s.everContacted, false);
		assert.strictEqual(s.lastContactAge, null);
	});

	it('reports no success rate rather than zero when nothing was attempted', function () {
		// Zero of zero is not a nought per cent success rate, and showing one
		// would put a quiet peer next to a broken one.
		var s = summary({ attempts: 0, successes: 0 }, { last_contact: hoursAgo(200) });
		assert.strictEqual(s.successRate, null);
	});

	it('honours a caller-supplied stale threshold', function () {
		var stats = { attempts: 1, successes: 1 };
		var contact = { last_contact: hoursAgo(10), last_success: hoursAgo(10) };
		assert.strictEqual(fmt.summariseConnection(stats, contact, { now: NOW, staleHours: 6 }).failing, true);
		assert.strictEqual(fmt.summariseConnection(stats, contact, { now: NOW, staleHours: 48 }).failing, false);
	});

	it('reports last success from all history, not just the window', function () {
		// The window is the right frame for "how has it been going lately" and
		// the wrong one for "when did this last work", which is the question
		// that matters once something has broken.
		var s = summary({ attempts: 20, successes: 0 },
			{ last_contact: hoursAgo(1), last_success: hoursAgo(200) });
		assert.ok(s.lastSuccessAge, 'a week-old success still has to be reportable');
		assert.strictEqual(s.lastSuccessAge, '8d');
	});

	it('survives being handed nothing at all', function () {
		assert.doesNotThrow(function () { fmt.summariseConnection(null, null, null); });
	});
});

describe('mailerFormat outcome labelling', function () {
	before(function () { if (!fmt) this.skip(); });

	it('separates the outcomes a sysop acts on differently', function () {
		assert.strictEqual(fmt.outcomeClass('complete'), 'success');
		assert.strictEqual(fmt.outcomeClass('connect_failed'), 'danger');
		assert.strictEqual(fmt.outcomeClass('auth_failed'), 'danger');
		assert.strictEqual(fmt.outcomeClass('timeout'), 'warning');
	});

	it('labels an unknown outcome as itself rather than hiding it', function () {
		assert.strictEqual(fmt.outcomeLabel('something-new'), 'something-new');
		assert.strictEqual(fmt.outcomeLabel(null), 'unknown');
	});

	it('formats durations', function () {
		assert.strictEqual(fmt.formatDuration(4), '4s');
		assert.strictEqual(fmt.formatDuration(90), '1m 30s');
		assert.strictEqual(fmt.formatDuration(3600), '1h 0m');
		assert.strictEqual(fmt.formatDuration(null), '-');
		assert.strictEqual(fmt.formatDuration('61'), '1m 1s', 'duration may arrive as text too');
	});
});

describe('TransferEngine sendComplete', function () {
	var TransferEngine = null;
	before(async function () {
		try {
			TransferEngine = (await import('../src/mailer/transfer.js')).TransferEngine;
		} catch (_) { this.skip(); }
	});

	it('reports the size of what it sent', async function () {
		// SessionController.bytesSent was declared, reported in getStatus and
		// carried through the whole mailer while nothing ever incremented it,
		// because sendComplete did not say how big the file was. Every session
		// reported zero bytes out, which looked plausible next to a working
		// byte count inbound.
		var protocol = new EventEmitter();
		protocol.offerFile = function () {};
		protocol.sendFileData = function () {};

		var engine = new TransferEngine(protocol, {
			inboundDir: 'tmp', tempDir: 'tmp', sessionId: 'zz-test'
		});

		engine._sendActive = {
			filepath: '/nonexistent/zz.pkt', name: 'zz.pkt', size: 4096,
			mtime: 0, offset: 4096, fd: null, floFile: null, floPrefix: '', deleteAfterSend: false
		};

		var payload = await new Promise(function (resolve) {
			engine.once('sendComplete', resolve);
			engine._onFileReceived({ name: 'zz.pkt' });
		});

		assert.strictEqual(payload.size, 4096,
			'without this the session cannot total what it pushed');
		assert.strictEqual(payload.name, 'zz.pkt');
	});
});

describe('mailerSessions model', function () {
	this.timeout(20000);

	var available = false;
	var ms = null, pg = null;
	// Ids well outside anything a real install would allocate, so the cleanup
	// at the end cannot take a real row with it.
	var CONN = 99000001, CONN2 = 99000002, PEER = 99000003;

	before(async function () {
		this.timeout(15000);
		try {
			available = await dbAvailable();
			if (!available) return;
			ms = await import('../src/models/mailerSessions.js');
			pg = await import('../src/middleware/db/postgres.js');
			await ms.ensureIndexes();
			await pg.write('DELETE FROM mailer_sessions WHERE peer_connection_id IN ($1,$2) OR peer_id = $3',
				[CONN, CONN2, PEER]);
		} catch (_) { available = false; }
	});

	beforeEach(function () { if (!available) this.skip(); });

	after(async function () {
		if (!available) return;
		try {
			await pg.write('DELETE FROM mailer_sessions WHERE peer_connection_id IN ($1,$2) OR peer_id = $3',
				[CONN, CONN2, PEER]);
		} catch (_) {}
	});

	function base(over) {
		return Object.assign({
			uuid: 'zz-' + Math.random().toString(36).slice(2, 10),
			direction: 'out', peerId: PEER, peerConnectionId: CONN,
			remoteAddress: '1:229/426', remoteHost: 'ex.org:24554', protocol: 'binkp',
			outcome: 'complete', reason: 'complete',
			filesSent: 1, filesReceived: 2, bytesSent: 100, bytesReceived: 200,
			startedAt: new Date(), endedAt: new Date(), durationSeconds: 3
		}, over || {});
	}

	it('records a session and reads it back', async function () {
		var r = await ms.record(base({ peerSoftware: 'binkd/1.1a-115' }));
		assert.ok(r && r.insertId, 'the insert has to report an id');

		var rows = await ms.recentForConnection(CONN, 5);
		assert.ok(rows.length > 0);
		assert.strictEqual(rows[0].peer_software, 'binkd/1.1a-115');
	});

	it('stores the peer AKAs as a real array, not a string', async function () {
		await ms.record(base({ remoteAddresses: ['1:229/426@fidonet', '21:1/100@fsxnet'] }));
		var row = (await ms.recentForConnection(CONN, 1))[0];
		assert.ok(Array.isArray(row.remote_addresses), 'jsonb should come back parsed');
		assert.strictEqual(row.remote_addresses.length, 2);
	});

	it('records an attempt that never became a session', async function () {
		// The peer failing hardest is the one that never gets a socket open.
		// If only completed handshakes were kept it would look like the
		// quietest node on the board.
		await ms.record({
			direction: 'out', peerConnectionId: CONN2, peerId: PEER,
			remoteAddress: '2:203/0', outcome: ms.OUTCOME_CONNECT_FAILED,
			reason: 'tcp: ECONNREFUSED', startedAt: new Date(), endedAt: new Date()
		});
		var rows = await ms.recentForConnection(CONN2, 5);
		assert.strictEqual(rows.length, 1);
		assert.strictEqual(rows[0].outcome, 'connect_failed');
		assert.strictEqual(rows[0].files_sent, 0, 'counts should default rather than be null');
	});

	it('defaults a missing duration from the timestamps', async function () {
		await pg.write('DELETE FROM mailer_sessions WHERE peer_connection_id = $1', [CONN2]);
		var start = new Date(Date.now() - 7000);
		await ms.record(base({ peerConnectionId: CONN2, startedAt: start, endedAt: new Date(),
			durationSeconds: undefined }));
		var row = (await ms.recentForConnection(CONN2, 1))[0];
		assert.ok(row.duration_seconds >= 6 && row.duration_seconds <= 8,
			'got ' + row.duration_seconds + '; a row should not claim a session took no time');
	});

	it('truncates an overlong reason instead of failing the insert', async function () {
		// Reasons are free text from several places, including error messages
		// that carry a stack fragment. A diagnostics write must never be the
		// thing that breaks a session.
		var r = await ms.record(base({ reason: 'x'.repeat(2000) }));
		assert.ok(r && r.insertId, 'the row still has to be written');
	});

	it('returns newest first', async function () {
		await pg.write('DELETE FROM mailer_sessions WHERE peer_connection_id = $1', [CONN2]);
		await ms.record(base({ peerConnectionId: CONN2, uuid: 'zz-old',
			startedAt: new Date(Date.now() - 60000), endedAt: new Date(Date.now() - 59000) }));
		await ms.record(base({ peerConnectionId: CONN2, uuid: 'zz-new' }));
		var rows = await ms.recentForConnection(CONN2, 5);
		assert.strictEqual(rows[0].uuid, 'zz-new');
	});

	it('rolls up attempts and successes over a window', async function () {
		await pg.write('DELETE FROM mailer_sessions WHERE peer_connection_id = $1', [CONN2]);
		await ms.record(base({ peerConnectionId: CONN2, outcome: 'complete', bytesSent: 1000 }));
		await ms.record(base({ peerConnectionId: CONN2, outcome: 'timeout', bytesSent: 0, filesSent: 0 }));

		var stats = (await ms.statsByConnection(24))
			.filter(function (r) { return r.peer_connection_id === CONN2; })[0];
		assert.ok(stats, 'the connection should appear in the rollup');
		assert.strictEqual(stats.attempts, 2);
		assert.strictEqual(stats.successes, 1, 'only complete counts as a success');
	});

	it('leaves sessions outside the window out of the rollup', async function () {
		await pg.write('DELETE FROM mailer_sessions WHERE peer_connection_id = $1', [CONN2]);
		var old = new Date(Date.now() - (72 * 3600000));
		await ms.record(base({ peerConnectionId: CONN2, startedAt: old, endedAt: old }));

		var inWindow = (await ms.statsByConnection(24))
			.filter(function (r) { return r.peer_connection_id === CONN2; });
		assert.strictEqual(inWindow.length, 0);

		var wider = (await ms.statsByConnection(168))
			.filter(function (r) { return r.peer_connection_id === CONN2; });
		assert.strictEqual(wider.length, 1, 'a wider window should reach it');
	});

	it('reports last contact and last success separately', async function () {
		await pg.write('DELETE FROM mailer_sessions WHERE peer_connection_id = $1', [CONN2]);
		var older = new Date(Date.now() - 3600000);
		await ms.record(base({ peerConnectionId: CONN2, outcome: 'complete',
			startedAt: older, endedAt: older, peerSoftware: 'binkd/1.1a' }));
		await ms.record(base({ peerConnectionId: CONN2, outcome: 'auth_failed',
			reason: 'CRAM-MD5 auth failed', peerSoftware: null }));

		var row = (await ms.lastContactByConnection())
			.filter(function (r) { return r.peer_connection_id === CONN2; })[0];
		assert.ok(row);
		assert.strictEqual(row.last_outcome, 'auth_failed', 'last contact is the newest attempt');
		assert.ok(new Date(row.last_success) < new Date(row.last_contact),
			'last success has to be the older complete one, not the newest row');
		assert.strictEqual(row.last_reason, 'CRAM-MD5 auth failed');
		assert.strictEqual(row.peer_software, 'binkd/1.1a',
			'the most recent session that reported software should win, even if ' +
			'a later failed one reported none');
	});

	it('lists sessions with no peer record separately', async function () {
		await ms.record({
			direction: 'in', peerConnectionId: null, remoteAddress: '9:99/99',
			outcome: 'auth_failed', reason: 'unknown node',
			startedAt: new Date(), endedAt: new Date()
		});
		var rows = await ms.recentUnmatched(50);
		assert.ok(rows.some(function (r) { return r.remote_address === '9:99/99'; }));
		var matched = await ms.recentForConnection(CONN, 50);
		assert.ok(!matched.some(function (r) { return r.remote_address === '9:99/99'; }),
			'an unmatched session must not be filed under some other peer');
		await pg.write("DELETE FROM mailer_sessions WHERE remote_address = '9:99/99'");
	});

	it('keeps everything when retention is zero', async function () {
		assert.strictEqual(await ms.purgeOld(0), 0);
		assert.strictEqual(await ms.purgeOld(null), 0);
		assert.ok((await ms.recentForConnection(CONN, 5)).length > 0,
			'a zero retention setting means keep forever, not delete everything');
	});

	it('purges rows older than the retention window', async function () {
		await pg.write('DELETE FROM mailer_sessions WHERE peer_connection_id = $1', [CONN2]);
		var ancient = new Date(Date.now() - (40 * 86400000));
		await ms.record(base({ peerConnectionId: CONN2, startedAt: ancient, endedAt: ancient }));
		await ms.record(base({ peerConnectionId: CONN2 }));

		var purged = await ms.purgeOld(30);
		assert.ok(purged >= 1, 'the 40 day old row should go');
		var left = await ms.recentForConnection(CONN2, 10);
		assert.strictEqual(left.length, 1, 'and the recent one should stay');
	});

	it('never throws on a bad write, since diagnostics must not break a session', async function () {
		// A column that does not exist stands in for any write failure. The
		// mailer calls this from inside a session end handler.
		// Tagged with the test connection id so the cleanup below reaches it.
		// Without that this row has no peer, no uuid and no address, and four
		// of them accumulated in the real database on every run.
		var r = await ms.record({ direction: 'out', peerConnectionId: CONN2,
			outcome: 'x'.repeat(9000) });
		assert.ok(r === null || (r && r.insertId), 'either it wrote or it reported null');
	});
});
