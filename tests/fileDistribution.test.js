// tests/fileDistribution.test.js — who a file echo can actually be sent to.
//
// The outbound pass needs an areatag to build a TIC descriptor, and it looks
// one up by the peer's network. With no mapping it calls
// markFailed('No areatag mapping'), and a failed row is terminal: the outbound
// pass only ever reads pending rows.
//
// Nothing filtered the subscriber list against that, so a peer subscribed to
// an area that is not mapped to its network collected one dead row per file,
// for ever, with no way to see them and nothing to retry them. The subscription
// looked fine, the area looked fine, and one downlink just never got anything.
//
// partitionByAreatag is the shared answer, applied by the TIC tosser and both
// upload paths. These are the cases that decide whether it is right, and every
// one of them fails silently in production rather than throwing.
//
// Pure: no database.
// Run: npx mocha --no-config --no-package tests/fileDistribution.test.js

import assert from 'assert';
import { partitionByAreatag } from '../src/models/fileDistribution.js';

// Shaped like filePeerSubscriptions.getSubscribedConnections
function sub(id, networkId, name) {
	return {
		peer_connection_id: id,
		network_id: networkId,
		peer_name: name || ('peer' + id),
		connection_data: {},
	};
}

// Shaped like fileNetworkAreas.getNetworksByFileArea
function mapping(networkId, areatag) {
	return { network_id: networkId, areatag: areatag };
}

function names(list) {
	return list.map(function (s) { return s.peer_name; }).sort();
}

describe('fileDistribution.partitionByAreatag', function () {

	it('keeps a subscriber whose network carries the area', function () {
		var r = partitionByAreatag([sub(1, 10, 'uplink')], [mapping(10, 'CANECTIC')]);
		assert.deepStrictEqual(names(r.deliverable), ['uplink']);
		assert.deepStrictEqual(r.undeliverable, []);
	});

	it('holds back a subscriber on a network the area is not mapped to', function () {
		// The whole bug: this row would be created, fail, and stay failed.
		var r = partitionByAreatag([sub(2, 20, 'othernet')], [mapping(10, 'CANECTIC')]);
		assert.deepStrictEqual(r.deliverable, []);
		assert.deepStrictEqual(names(r.undeliverable), ['othernet']);
	});

	it('splits a mixed list rather than dropping the whole thing', function () {
		var r = partitionByAreatag(
			[sub(1, 10, 'a'), sub(2, 20, 'b'), sub(3, 10, 'c')],
			[mapping(10, 'CANECTIC')]
		);
		assert.deepStrictEqual(names(r.deliverable), ['a', 'c']);
		assert.deepStrictEqual(names(r.undeliverable), ['b']);
	});

	it('handles an area carried on several networks', function () {
		var r = partitionByAreatag(
			[sub(1, 10, 'a'), sub(2, 20, 'b'), sub(3, 30, 'c')],
			[mapping(10, 'TAG_A'), mapping(20, 'TAG_B')]
		);
		assert.deepStrictEqual(names(r.deliverable), ['a', 'b']);
		assert.deepStrictEqual(names(r.undeliverable), ['c']);
	});

	it('returns the undeliverable ones rather than discarding them', function () {
		// A subscription that cannot be honoured is exactly what the sysop
		// needs telling about. Silently dropping it would trade a permanent
		// failed row for a permanent silence, which is not an improvement.
		var r = partitionByAreatag([sub(9, 99, 'stranded')], []);
		assert.strictEqual(r.undeliverable.length, 1);
		assert.strictEqual(r.undeliverable[0].peer_connection_id, 9);
	});

	it('treats a mapping with no areatag as no mapping', function () {
		// A row can exist with a null areatag; it cannot build a descriptor.
		var r = partitionByAreatag([sub(1, 10, 'a')], [{ network_id: 10, areatag: null }]);
		assert.deepStrictEqual(r.deliverable, []);
		assert.deepStrictEqual(names(r.undeliverable), ['a']);
	});

	it('matches network ids across string and number', function () {
		// postgres returns integer columns as strings often enough that an
		// identity comparison here would quietly deliver to nobody.
		var r = partitionByAreatag([sub(1, '10', 'a')], [mapping(10, 'TAG')]);
		assert.deepStrictEqual(names(r.deliverable), ['a']);

		var r2 = partitionByAreatag([sub(1, 10, 'a')], [{ network_id: '10', areatag: 'TAG' }]);
		assert.deepStrictEqual(names(r2.deliverable), ['a']);
	});

	it('delivers to nobody when the area is mapped to no network', function () {
		var r = partitionByAreatag([sub(1, 10, 'a'), sub(2, 20, 'b')], []);
		assert.deepStrictEqual(r.deliverable, []);
		assert.strictEqual(r.undeliverable.length, 2);
	});

	it('survives empty and missing input', function () {
		assert.deepStrictEqual(partitionByAreatag([], []), { deliverable: [], undeliverable: [] });
		assert.deepStrictEqual(partitionByAreatag(null, null), { deliverable: [], undeliverable: [] });
		assert.deepStrictEqual(partitionByAreatag(undefined, undefined), { deliverable: [], undeliverable: [] });
	});

	it('skips null entries in either list', function () {
		var r = partitionByAreatag([null, sub(1, 10, 'a')], [null, mapping(10, 'TAG')]);
		assert.deepStrictEqual(names(r.deliverable), ['a']);
	});

	it('does not mutate what it was given', function () {
		var subs = [sub(1, 10, 'a'), sub(2, 20, 'b')];
		var maps = [mapping(10, 'TAG')];
		partitionByAreatag(subs, maps);
		assert.strictEqual(subs.length, 2);
		assert.strictEqual(maps.length, 1);
	});
});

// ---------------------------------------------------------------------------
// The way back from a failed transfer
// ---------------------------------------------------------------------------
//
// A file_distribution row that reaches 'failed' is terminal: the outbound pass
// reads pending rows only. Until the peer page grew a Retry button there was
// no way back from one and no way to see one either, so the sole symptom of a
// failure here was a file that every downlink received except one.
//
// retryFailed returns a COUNT rather than a boolean on purpose: the caller has
// to tell "nothing was wrong" from "the reset did not happen", and those are
// indistinguishable from a boolean.
//
// Needs a database; the queries are the behaviour.

describe('fileDistribution failure recovery', function () {
	this.timeout(30000);

	var available = false;
	var pg = null, fd = null;
	var CONN = 999902;          // no such connection; nothing else writes these
	var ENTRY = 999903;

	before(async function () {
		var mod = await import('./helpers/dbAvailable.js');
		available = await mod.dbAvailable();
		if (!available) return;
		pg = await import('../src/middleware/db/postgres.js');
		fd = await import('../src/models/fileDistribution.js');
	});

	after(async function () {
		if (!pg) return;
		await pg.write('DELETE FROM file_distribution WHERE peer_connection_id = $1', [CONN]);
	});

	beforeEach(async function () {
		if (!available) this.skip();
		await pg.write('DELETE FROM file_distribution WHERE peer_connection_id = $1', [CONN]);
	});

	async function seed(status, n) {
		for (var i = 0; i < n; i++) {
			await pg.write(
				'INSERT INTO file_distribution (file_entry_id, peer_connection_id, protocol, status, attempts, created_at) ' +
				"VALUES ($1, $2, 'tic', $3, 1, NOW())",
				[ENTRY + i, CONN, status]);
		}
	}

	it('reports zero when there is nothing to retry, rather than claiming success', async function () {
		await seed('sent', 2);
		assert.strictEqual(await fd.retryFailed(CONN), 0);
	});

	it('resets failed rows and says how many', async function () {
		await seed('failed', 3);
		assert.strictEqual(await fd.retryFailed(CONN), 3);
	});

	it('leaves sent and pending rows alone', async function () {
		await seed('failed', 1);
		await seed('sent', 1);
		await fd.retryFailed(CONN);
		var counts = await pg.query(
			'SELECT status, COUNT(*) n FROM file_distribution WHERE peer_connection_id = $1 GROUP BY status',
			[CONN]);
		var byStatus = {};
		for (var r of counts) byStatus[r.status] = parseInt(r.n, 10);
		assert.strictEqual(byStatus.sent, 1, 'a sent file must not be sent again');
		assert.strictEqual(byStatus.pending, 1);
	});

	it('clears the error message and attempt count on the rows it resets', async function () {
		// Otherwise the peer page still shows the old reason against a row
		// that is queued again.
		await seed('failed', 1);
		await pg.write("UPDATE file_distribution SET error_message = 'old reason' WHERE peer_connection_id = $1", [CONN]);
		await fd.retryFailed(CONN);
		var row = await pg.queryOne('SELECT error_message, attempts FROM file_distribution WHERE peer_connection_id = $1', [CONN]);
		assert.strictEqual(row.error_message, null);
		assert.strictEqual(parseInt(row.attempts, 10), 0);
	});

	it('summarises the statuses for the peer page', async function () {
		await seed('failed', 2);
		await seed('sent', 1);
		var s = await fd.summaryForConnection(CONN);
		assert.strictEqual(s.failed, 2);
		assert.strictEqual(s.sent, 1);
		assert.strictEqual(s.total, 3);
	});

	it('reports zero counts for a connection with no rows at all', async function () {
		var s = await fd.summaryForConnection(CONN);
		assert.deepStrictEqual(
			{ pending: s.pending, sent: s.sent, failed: s.failed, total: s.total },
			{ pending: 0, sent: 0, failed: 0, total: 0 });
		assert.deepStrictEqual(s.failures, []);
	});
});
