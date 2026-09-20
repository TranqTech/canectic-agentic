// tests/outboundSweep.test.js — which protocols the periodic outbound sweep
// is responsible for, and what happens when one of them throws.
//
// The sweep is the only thing that drains some outbound queues on a board
// where nobody is posting or uploading. TIC was missing from it for its whole
// life, which is invisible in exactly the way that matters: file_distribution
// rows are created correctly on inbound, the job runs, nothing throws, nothing
// is logged, and no downlink ever receives a file. A test that only asserted
// "the sweep completes" would have passed throughout.
//
// So the assertions here are about coverage and isolation, not about the
// tossers themselves, which have their own tests.
//
// Pure: every dependency is a stub, no Redis, no PostgreSQL, no filesystem.
// Run: npx mocha --spec tests/outboundSweep.test.js

import assert from 'assert';
import { runOutboundSweep, SWEEP_PROTOCOLS } from '../src/maintenance/outboundSweep.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Records every tosser entry point the sweep touches, in order.
function makeDeps(overrides) {
	var calls = [];
	var record = function (name) {
		return async function () { calls.push(name); };
	};

	var deps = {
		calls: calls,
		ticTosser:   { tossOutbound: record('tic') },
		ftnTosser:   { TossOutbound: record('ftn') },
		emailTosser: { tossOutbound: record('email') },
		qwkTosser:   { pushToQwkPeer: async function (uuid) { calls.push('qwk:' + uuid); } },
		nntpTosser:  { pushToNntpPeer: async function (uuid) { calls.push('nntp:' + uuid); } },
		peerConnections: {
			getActiveConnectionsByNetworkType: async function (type) {
				if (type === 'QWK') {
					return [
						{ uuid: 'q1', poll_enabled: true,  connection_data: {} },
						{ uuid: 'q2', poll_enabled: false, connection_data: {} },
						{ uuid: 'q3', poll_enabled: true,  connection_data: { transport: 'hub' } },
					];
				}
				if (type === 'NNTP') {
					return [
						{ uuid: 'n1', poll_enabled: true },
						{ uuid: 'n2', poll_enabled: false },
					];
				}
				return [];
			},
		},
	};

	for (var k in (overrides || {})) deps[k] = overrides[k];
	return deps;
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

describe('outbound sweep coverage', function () {

	it('names every protocol the board can send on', function () {
		// If a protocol is added to the board and not to this list, its queue
		// only ever drains on demand, which is the bug this file exists for.
		assert.deepStrictEqual(
			SWEEP_PROTOCOLS.slice().sort(),
			['email', 'ftn', 'nntp', 'qwk', 'tic']
		);
	});

	it('tosses TIC file echoes', async function () {
		// The regression. Without tic in the sweep, file_distribution rows
		// created by an inbound TIC sit at pending until a local upload.
		var deps = makeDeps();
		var result = await runOutboundSweep(deps);

		assert.ok(deps.calls.includes('tic'),
			'sweep must call ticTosser.tossOutbound()');
		assert.ok(result.ran.includes('tic'));
	});

	it('stages TIC before FTN so the BSO scan FTN enqueues sees the files', async function () {
		// ftnTosser.TossOutbound() enqueues a BSO scan when it finishes, and
		// the scan reads the outbound directory at the time it runs. Staging
		// TIC first means file echo traffic rides that same scan out.
		var deps = makeDeps();
		await runOutboundSweep(deps);

		// Assert presence first: indexOf returns -1 for a protocol that never
		// ran, which would satisfy the ordering comparison below and let this
		// test pass on a sweep with no TIC in it at all.
		assert.ok(deps.calls.includes('tic'), 'TIC must run');
		assert.ok(deps.calls.includes('ftn'), 'FTN must run');
		assert.ok(deps.calls.indexOf('tic') < deps.calls.indexOf('ftn'),
			'TIC must be staged before FTN enqueues its BSO scan');
	});

	it('tosses FTN, email, and every eligible QWK and NNTP peer', async function () {
		var deps = makeDeps();
		var result = await runOutboundSweep(deps);

		assert.ok(deps.calls.includes('ftn'));
		assert.ok(deps.calls.includes('email'));
		assert.ok(deps.calls.includes('qwk:q1'));
		assert.ok(deps.calls.includes('nntp:n1'));
		assert.deepStrictEqual(result.errors, []);
	});

	it('skips peers that are not polled, and hub-transport QWK peers', async function () {
		// A hub-transport QWK peer is pulled from, never pushed to.
		var deps = makeDeps();
		await runOutboundSweep(deps);

		assert.ok(!deps.calls.includes('qwk:q2'), 'poll_enabled false must be skipped');
		assert.ok(!deps.calls.includes('qwk:q3'), 'hub transport must be skipped');
		assert.ok(!deps.calls.includes('nntp:n2'), 'poll_enabled false must be skipped');
	});
});

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

describe('outbound sweep isolation', function () {

	it('keeps sweeping after a protocol throws', async function () {
		// One broken protocol taking the sweep down would silently stop all
		// the others, which is the same class of failure one layer up.
		var deps = makeDeps();
		deps.ftnTosser = { TossOutbound: async function () { throw new Error('boom'); } };

		var result = await runOutboundSweep(deps);

		assert.ok(deps.calls.includes('tic'));
		assert.ok(deps.calls.includes('email'));
		assert.ok(deps.calls.includes('qwk:q1'));
		assert.deepStrictEqual(result.errors, [{ protocol: 'ftn', message: 'boom' }]);
		assert.ok(!result.ran.includes('ftn'));
	});

	it('keeps pushing the remaining peers after one peer throws', async function () {
		var deps = makeDeps();
		deps.qwkTosser = {
			pushToQwkPeer: async function (uuid) {
				deps.calls.push('qwk:' + uuid);
				if (uuid === 'q1') throw new Error('unreachable');
			},
		};
		// Add a second eligible QWK peer after the failing one.
		deps.peerConnections = {
			getActiveConnectionsByNetworkType: async function (type) {
				if (type === 'QWK') {
					return [
						{ uuid: 'q1', poll_enabled: true, connection_data: {} },
						{ uuid: 'q4', poll_enabled: true, connection_data: {} },
					];
				}
				return [];
			},
		};

		var result = await runOutboundSweep(deps);

		assert.ok(deps.calls.includes('qwk:q4'),
			'a peer that fails must not abandon the peers after it');
		// A single failing peer is not a failing protocol.
		assert.deepStrictEqual(result.errors, []);
		assert.ok(result.ran.includes('qwk'));
	});

	it('reports a failure per protocol without throwing', async function () {
		var deps = makeDeps();
		deps.ticTosser = { tossOutbound: async function () { throw new Error('no outbound dir'); } };
		deps.emailTosser = { tossOutbound: async function () { throw new Error('smtp down'); } };

		var result = await runOutboundSweep(deps);

		assert.deepStrictEqual(result.errors, [
			{ protocol: 'tic',   message: 'no outbound dir' },
			{ protocol: 'email', message: 'smtp down' },
		]);
		assert.ok(result.ran.includes('ftn'), 'unaffected protocols still run');
	});
});
