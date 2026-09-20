// tests/ticLoopGuard.test.js — what stops a file echo circulating for ever.
//
// A file that reads as new is imported AND hatched onward to every subscribed
// downlink. So in a mesh, a file that fails to be recognised does not just get
// stored twice: it goes round again, and each system that fails to recognise
// it sends it on. There are two independent brakes and they answer different
// questions.
//
//   Seenby/Path  — "has this file been through THIS system before?"
//   Dupe check   — "does this area hold this file NOW?"
//
// The second is not a substitute for the first, because retention prunes the
// table it consults. A file held, pruned, and then offered again by a peer who
// still has it reads as brand new to the dupe check and is forwarded. Only the
// Seenby stamp survives that, and it survives because it travels with the file
// rather than living here.
//
// This file covers the Seenby/Path guard, which is pure. The dupe check needs a
// database and is exercised in the tosser's own path.
//
// Run: npx mocha --no-config --no-package tests/ticLoopGuard.test.js

import assert from 'assert';
import { ticHasPassedThrough, normaliseAddress } from '../src/middleware/tossers/ticTosser.js';

function tic(seenby, path) {
	return { seenby: seenby || [], path: path || [] };
}

var OURS = ['1:123/456', '2:250/1'];

// ---------------------------------------------------------------------------
// Address normalisation
// ---------------------------------------------------------------------------

describe('TIC address normalisation', function () {

	it('lowercases', function () {
		assert.strictEqual(normaliseAddress('1:123/456@FidoNet'), '1:123/456');
	});

	it('strips a 5D domain', function () {
		// A system writes itself in with a domain on one hop and without it on
		// the next, so the raw strings do not match when it matters most.
		assert.strictEqual(normaliseAddress('1:123/456@fidonet'), '1:123/456');
	});

	it('strips a .0 point suffix', function () {
		// 1:123/456 and 1:123/456.0 are the same node.
		assert.strictEqual(normaliseAddress('1:123/456.0'), '1:123/456');
	});

	it('keeps a real point number', function () {
		assert.strictEqual(normaliseAddress('1:123/456.7'), '1:123/456.7');
	});

	it('handles surrounding whitespace and empties', function () {
		assert.strictEqual(normaliseAddress('  1:123/456  '), '1:123/456');
		assert.strictEqual(normaliseAddress(''), '');
		assert.strictEqual(normaliseAddress(null), '');
		assert.strictEqual(normaliseAddress(undefined), '');
	});
});

// ---------------------------------------------------------------------------
// The loop guard
// ---------------------------------------------------------------------------

describe('ticHasPassedThrough', function () {

	it('passes a file that has never been here', function () {
		var t = tic(['1:100/1', '1:200/2'], ['1:100/1 1700000000']);
		assert.strictEqual(ticHasPassedThrough(t, OURS), null);
	});

	it('catches our address in Seenby', function () {
		var t = tic(['1:100/1', '1:123/456']);
		assert.strictEqual(ticHasPassedThrough(t, OURS), '1:123/456');
	});

	it('catches our address in Path, ignoring the timestamp', function () {
		// Path entries are "address timestamp"; comparing the whole token
		// never matches anything.
		var t = tic([], ['1:100/1 1700000000', '1:123/456 1700000900']);
		assert.strictEqual(ticHasPassedThrough(t, OURS), '1:123/456');
	});

	it('catches any of our addresses, not just the first', function () {
		var t = tic(['2:250/1']);
		assert.strictEqual(ticHasPassedThrough(t, OURS), '2:250/1');
	});

	it('catches us when the chain wrote us with a domain', function () {
		var t = tic(['1:123/456@fidonet']);
		assert.strictEqual(ticHasPassedThrough(t, OURS), '1:123/456');
	});

	it('catches us when the chain wrote us with a .0 suffix', function () {
		var t = tic([], ['1:123/456.0 1700000000']);
		assert.strictEqual(ticHasPassedThrough(t, OURS), '1:123/456');
	});

	it('catches us when OUR address is the one carrying the domain', function () {
		// Normalisation has to apply to both sides, not just what arrived.
		var t = tic(['1:123/456']);
		assert.strictEqual(ticHasPassedThrough(t, ['1:123/456@fidonet']), '1:123/456');
	});

	it('is case insensitive', function () {
		var t = tic(['1:123/456@FIDONET']);
		assert.strictEqual(ticHasPassedThrough(t, OURS), '1:123/456');
	});

	it('does not confuse a different node on the same net', function () {
		// The cost of a false positive here is a file silently never imported.
		var t = tic(['1:123/457', '1:123/45']);
		assert.strictEqual(ticHasPassedThrough(t, OURS), null);
	});

	it('does not treat one of our points as us', function () {
		var t = tic(['1:123/456.7']);
		assert.strictEqual(ticHasPassedThrough(t, OURS), null);
	});

	it('says nothing when we have no addresses on the network', function () {
		// No addresses means no basis to claim a loop, so the file proceeds
		// and the dupe check takes it.
		assert.strictEqual(ticHasPassedThrough(tic(['1:123/456']), []), null);
		assert.strictEqual(ticHasPassedThrough(tic(['1:123/456']), null), null);
	});

	it('survives a TIC with no Seenby or Path at all', function () {
		assert.strictEqual(ticHasPassedThrough(tic([], []), OURS), null);
		assert.strictEqual(ticHasPassedThrough({}, OURS), null);
		assert.strictEqual(ticHasPassedThrough(null, OURS), null);
	});

	it('ignores blank entries rather than matching them', function () {
		var t = tic(['', '   '], ['']);
		assert.strictEqual(ticHasPassedThrough(t, OURS), null);
	});
});
