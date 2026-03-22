// tests/ftnRouter.test.js — Unit tests for pure functions in src/models/ftnRouter.js
//
// Tests parseFtnAddress() and matchesRule() — both are pure, exported, and
// require no DB or network access.
// Run: npx mocha tests/ftnRouter.test.js

import assert from 'assert';
import { parseFtnAddress, matchesRule } from '../src/models/ftnRouter.js';

// ---------------------------------------------------------------------------
// parseFtnAddress
// ---------------------------------------------------------------------------

describe('parseFtnAddress', function () {

	describe('full zone:net/node format', function () {
		it('should parse a standard 3-part FTN address', function () {
			var r = parseFtnAddress('1:123/456');
			assert.strictEqual(r.zone, 1);
			assert.strictEqual(r.net, 123);
			assert.strictEqual(r.node, 456);
			assert.strictEqual(r.point, 0);
		});

		it('should parse zone 2 address', function () {
			var r = parseFtnAddress('2:200/100');
			assert.strictEqual(r.zone, 2);
			assert.strictEqual(r.net, 200);
			assert.strictEqual(r.node, 100);
		});

		it('should parse zone 3 address with large net number', function () {
			var r = parseFtnAddress('3:712/848');
			assert.strictEqual(r.zone, 3);
			assert.strictEqual(r.net, 712);
			assert.strictEqual(r.node, 848);
		});
	});

	describe('zone:net/node.point format', function () {
		it('should parse a point address with .0', function () {
			var r = parseFtnAddress('1:123/456.0');
			assert.strictEqual(r.zone, 1);
			assert.strictEqual(r.net, 123);
			assert.strictEqual(r.node, 456);
			assert.strictEqual(r.point, 0);
		});

		it('should parse a non-zero point address', function () {
			var r = parseFtnAddress('1:123/456.7');
			assert.strictEqual(r.zone, 1);
			assert.strictEqual(r.net, 123);
			assert.strictEqual(r.node, 456);
			assert.strictEqual(r.point, 7);
		});

		it('should parse a three-digit point address', function () {
			var r = parseFtnAddress('1:100/200.100');
			assert.strictEqual(r.zone, 1);
			assert.strictEqual(r.net, 100);
			assert.strictEqual(r.node, 200);
			assert.strictEqual(r.point, 100);
		});
	});

	describe('net/node format (zone implied as 1)', function () {
		it('should parse net/node with default zone 1', function () {
			var r = parseFtnAddress('123/456');
			assert.strictEqual(r.zone, 1);
			assert.strictEqual(r.net, 123);
			assert.strictEqual(r.node, 456);
		});
	});

	describe('node/zone coordinator addresses', function () {
		it('should parse zone coordinator (net/0)', function () {
			var r = parseFtnAddress('1:1/0');
			assert.strictEqual(r.zone, 1);
			assert.strictEqual(r.net, 1);
			assert.strictEqual(r.node, 0);
		});

		it('should parse region coordinator style address', function () {
			var r = parseFtnAddress('1:14/0');
			assert.strictEqual(r.zone, 1);
			assert.strictEqual(r.net, 14);
			assert.strictEqual(r.node, 0);
		});
	});

	describe('whitespace handling', function () {
		it('should trim leading and trailing whitespace', function () {
			var r = parseFtnAddress('  1:123/456  ');
			assert.strictEqual(r.zone, 1);
			assert.strictEqual(r.net, 123);
			assert.strictEqual(r.node, 456);
		});
	});

	describe('invalid input', function () {
		it('should return null for null input', function () {
			var r = parseFtnAddress(null);
			assert.strictEqual(r, null);
		});

		it('should return null for undefined input', function () {
			var r = parseFtnAddress(undefined);
			assert.strictEqual(r, null);
		});

		it('should return null for a non-string number', function () {
			var r = parseFtnAddress(12345);
			assert.strictEqual(r, null);
		});

		it('should return null for empty string', function () {
			var r = parseFtnAddress('');
			assert.strictEqual(r, null);
		});

		it('should return an object for a partial string (no colon or slash)', function () {
			// The parser does not throw on odd input — zone defaults to 1, net/node may be 0
			var r = parseFtnAddress('garbage');
			// Just verify it does not throw and returns an object or null
			assert.ok(r === null || typeof r === 'object');
		});
	});

	describe('return shape', function () {
		it('should always return an object with zone, net, node, point keys', function () {
			var r = parseFtnAddress('1:234/567');
			assert.ok(r !== null);
			assert.ok('zone' in r);
			assert.ok('net' in r);
			assert.ok('node' in r);
			assert.ok('point' in r);
		});
	});
});

// ---------------------------------------------------------------------------
// matchesRule
// ---------------------------------------------------------------------------

describe('matchesRule', function () {

	describe('exact match', function () {
		it('should match an exact zone:net/node rule', function () {
			assert.strictEqual(matchesRule('1:123/456', 1, 123, 456), true);
		});

		it('should not match when zone differs', function () {
			assert.strictEqual(matchesRule('2:123/456', 1, 123, 456), false);
		});

		it('should not match when net differs', function () {
			assert.strictEqual(matchesRule('1:999/456', 1, 123, 456), false);
		});

		it('should not match when node differs', function () {
			assert.strictEqual(matchesRule('1:123/999', 1, 123, 456), false);
		});
	});

	describe('wildcard zone', function () {
		it('should match any zone when rule uses *', function () {
			assert.strictEqual(matchesRule('*:123/456', 1, 123, 456), true);
			assert.strictEqual(matchesRule('*:123/456', 2, 123, 456), true);
			assert.strictEqual(matchesRule('*:123/456', 99, 123, 456), true);
		});

		it('should not match when net differs with wildcard zone', function () {
			assert.strictEqual(matchesRule('*:999/456', 1, 123, 456), false);
		});
	});

	describe('wildcard net', function () {
		it('should match any net in the specified zone', function () {
			assert.strictEqual(matchesRule('1:*/456', 1, 1, 456), true);
			assert.strictEqual(matchesRule('1:*/456', 1, 999, 456), true);
		});

		it('should not match wrong zone with wildcard net', function () {
			assert.strictEqual(matchesRule('2:*/456', 1, 123, 456), false);
		});
	});

	describe('wildcard node', function () {
		it('should match any node in the specified net', function () {
			assert.strictEqual(matchesRule('1:123/*', 1, 123, 1), true);
			assert.strictEqual(matchesRule('1:123/*', 1, 123, 999), true);
			assert.strictEqual(matchesRule('1:123/*', 1, 123, 0), true);
		});

		it('should not match when the net differs with wildcard node', function () {
			assert.strictEqual(matchesRule('1:999/*', 1, 123, 456), false);
		});
	});

	describe('fully wild rule', function () {
		it('should match any address with *:*/* style rule', function () {
			assert.strictEqual(matchesRule('*:*/*', 1, 123, 456), true);
			assert.strictEqual(matchesRule('*:*/*', 3, 712, 848), true);
		});
	});

	describe('zone-only wildcard (no node part)', function () {
		it('should match zone:net with implicit wildcard node', function () {
			// Rule "1:*" has no "/" — rNode defaults to "*" in the parser
			assert.strictEqual(matchesRule('1:*', 1, 123, 0), true);
			assert.strictEqual(matchesRule('1:*', 1, 999, 456), true);
		});

		it('should not match wrong zone for zone-only rule', function () {
			assert.strictEqual(matchesRule('2:*', 1, 123, 0), false);
		});
	});

	describe('malformed rules', function () {
		it('should return false for a rule with no colon', function () {
			assert.strictEqual(matchesRule('nocoion', 1, 123, 456), false);
		});

		it('should return false for an empty rule string', function () {
			assert.strictEqual(matchesRule('', 1, 123, 456), false);
		});
	});
});
