// tests/bsoScanner.test.js — Unit tests for parseBsoFilename()
//
// Tests only the pure filename parsing function — no filesystem, no DB, no Redis.
// Run: npx mocha tests/bsoScanner.test.js

import assert from 'assert';
import { parseBsoFilename } from '../src/mailer/bsoScanner.js';

describe('parseBsoFilename', function () {

	describe('null / short input', function () {
		it('should return null for null', function () {
			assert.strictEqual(parseBsoFilename(null, 1), null);
		});

		it('should return null for empty string', function () {
			assert.strictEqual(parseBsoFilename('', 1), null);
		});

		it('should return null for filename shorter than 12 characters', function () {
			// "0086002a.lo" is 11 chars — too short (needs 12+)
			assert.strictEqual(parseBsoFilename('0086002a.lo', 1), null);
		});

		it('should return null for filename without extension', function () {
			assert.strictEqual(parseBsoFilename('00860001no', 1), null);
		});
	});

	describe('stem validation', function () {
		it('should return null for stem that is not exactly 8 hex characters', function () {
			assert.strictEqual(parseBsoFilename('0086002.clo', 1), null);   // 7 hex
			assert.strictEqual(parseBsoFilename('008600001.clo', 1), null); // 9 hex
		});

		it('should return null for non-hex stem characters', function () {
			assert.strictEqual(parseBsoFilename('zzzzzzzz.clo', 1), null);
		});
	});

	describe('flow files (.?lo)', function () {
		it('should parse a Normal flow file (.flo)', function () {
			var r = parseBsoFilename('0086002a.flo', 1);
			assert.notStrictEqual(r, null);
			assert.strictEqual(r.net, 0x0086);
			assert.strictEqual(r.node, 0x002a);
			assert.strictEqual(r.zone, 1);
			assert.strictEqual(r.type, 'flow');
			assert.strictEqual(r.flavour, 'Normal');
			assert.strictEqual(r.filename, '0086002a.flo');
		});

		it('should parse a Crash flow file (.clo)', function () {
			var r = parseBsoFilename('0086002a.clo', 1);
			assert.notStrictEqual(r, null);
			assert.strictEqual(r.type, 'flow');
			assert.strictEqual(r.flavour, 'Crash');
		});

		it('should parse a Hold flow file (.hlo)', function () {
			var r = parseBsoFilename('0086002a.hlo', 1);
			assert.notStrictEqual(r, null);
			assert.strictEqual(r.flavour, 'Hold');
		});

		it('should parse a Direct flow file (.dlo)', function () {
			var r = parseBsoFilename('0086002a.dlo', 1);
			assert.notStrictEqual(r, null);
			assert.strictEqual(r.flavour, 'Direct');
		});

		it('should parse an Immediate flow file (.ilo)', function () {
			var r = parseBsoFilename('0086002a.ilo', 1);
			assert.notStrictEqual(r, null);
			assert.strictEqual(r.flavour, 'Immediate');
		});

		it('should parse using the .olo variant as Normal', function () {
			var r = parseBsoFilename('0086002a.olo', 1);
			assert.notStrictEqual(r, null);
			assert.strictEqual(r.flavour, 'Normal');
		});
	});

	describe('packet files (.?ut)', function () {
		it('should parse a Normal packet file (.fut)', function () {
			var r = parseBsoFilename('0100001f.fut', 1);
			assert.notStrictEqual(r, null);
			assert.strictEqual(r.type, 'packet');
			assert.strictEqual(r.flavour, 'Normal');
		});

		it('should parse a Crash packet file (.cut)', function () {
			var r = parseBsoFilename('0100001f.cut', 1);
			assert.notStrictEqual(r, null);
			assert.strictEqual(r.type, 'packet');
			assert.strictEqual(r.flavour, 'Crash');
		});

		it('should parse a Hold packet file (.hut)', function () {
			var r = parseBsoFilename('0100001f.hut', 1);
			assert.notStrictEqual(r, null);
			assert.strictEqual(r.type, 'packet');
			assert.strictEqual(r.flavour, 'Hold');
		});
	});

	describe('request files (.req)', function () {
		it('should parse a .req file with Normal flavour', function () {
			var r = parseBsoFilename('0086002a.req', 1);
			assert.notStrictEqual(r, null);
			assert.strictEqual(r.type, 'request');
			assert.strictEqual(r.flavour, 'Normal');
		});
	});

	describe('unknown extension', function () {
		it('should return null for unknown 3-char extension', function () {
			assert.strictEqual(parseBsoFilename('0086002a.xyz', 1), null);
		});

		it('should return null for 2-char extension (not .req)', function () {
			assert.strictEqual(parseBsoFilename('0086002a.fl', 1), null);
		});
	});

	describe('address decoding', function () {
		it('should decode high hex values correctly', function () {
			// 0x01f4 = 500 net, 0x0002 = 2 node
			var r = parseBsoFilename('01f40002.flo', 2);
			assert.notStrictEqual(r, null);
			assert.strictEqual(r.net, 500);
			assert.strictEqual(r.node, 2);
		});

		it('should carry zone from argument', function () {
			var r = parseBsoFilename('0086002a.flo', 3);
			assert.strictEqual(r.zone, 3);
		});

		it('should decode maximum valid address components', function () {
			// ffff = 65535
			var r = parseBsoFilename('ffffffff.flo', 1);
			assert.notStrictEqual(r, null);
			assert.strictEqual(r.net, 65535);
			assert.strictEqual(r.node, 65535);
		});
	});

	describe('case insensitivity of stem/ext', function () {
		it('should parse uppercase hex stem', function () {
			var r = parseBsoFilename('0086002A.flo', 1);
			assert.notStrictEqual(r, null);
			assert.strictEqual(r.node, 0x002a);
		});

		it('should parse uppercase extension', function () {
			var r = parseBsoFilename('0086002a.FLO', 1);
			assert.notStrictEqual(r, null);
			assert.strictEqual(r.flavour, 'Normal');
		});
	});
});
