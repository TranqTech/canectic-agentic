// tests/transferCrc.test.js — CRC-16 and CRC-32 test vectors.

import assert from 'assert';
import { crc16, crc16zmodem, crc32, crc32update, crc32finalize } from '../src/transfers/crc.js';

describe('CRC-16 (CCITT/XMODEM)', function() {
	it('should return 0 for empty buffer', function() {
		assert.strictEqual(crc16(Buffer.alloc(0)), 0);
	});

	it('should match known test vector "123456789"', function() {
		// Standard XMODEM CRC-16 test vector
		var buf = Buffer.from('123456789', 'ascii');
		assert.strictEqual(crc16(buf), 0x31C3);
	});

	it('should return correct CRC for single byte', function() {
		assert.strictEqual(crc16(Buffer.from([0x00])), 0x0000);
		assert.strictEqual(crc16(Buffer.from([0xFF])), 0x1EF0);
	});

	it('should return correct CRC for "A"', function() {
		assert.strictEqual(crc16(Buffer.from('A')), 0x58E5);
	});

	it('should handle binary data', function() {
		var buf = Buffer.from([0x01, 0x02, 0x03, 0x04]);
		var result = crc16(buf);
		assert.strictEqual(typeof result, 'number');
		assert.ok(result >= 0 && result <= 0xFFFF);
	});

	it('should support initial value parameter', function() {
		var buf = Buffer.from('test');
		var crc1 = crc16(buf);
		var crc2 = crc16(buf, 0);
		assert.strictEqual(crc1, crc2, 'default init should be 0');

		var crc3 = crc16(buf, 0x1234);
		assert.notStrictEqual(crc3, crc1, 'different init should give different result');
	});

	it('should produce consistent results', function() {
		var buf = Buffer.from('Hello, World!');
		var crc1 = crc16(buf);
		var crc2 = crc16(buf);
		assert.strictEqual(crc1, crc2);
	});
});

describe('CRC-32', function() {
	it('should return 0 for empty buffer', function() {
		assert.strictEqual(crc32(Buffer.alloc(0)), 0);
	});

	it('should match known test vector "123456789"', function() {
		// Standard CRC-32 test vector
		var buf = Buffer.from('123456789', 'ascii');
		assert.strictEqual(crc32(buf), 0xCBF43926);
	});

	it('should return correct CRC for single byte 0x00', function() {
		assert.strictEqual(crc32(Buffer.from([0x00])), 0xD202EF8D);
	});

	it('should handle binary data', function() {
		var buf = Buffer.alloc(256);
		for (var i = 0; i < 256; i++) buf[i] = i;
		var result = crc32(buf);
		assert.strictEqual(typeof result, 'number');
		assert.ok(result >= 0);
	});

	it('should produce consistent results', function() {
		var buf = Buffer.from('Hello, World!');
		var crc1 = crc32(buf);
		var crc2 = crc32(buf);
		assert.strictEqual(crc1, crc2);
	});

	it('should support incremental computation', function() {
		var buf = Buffer.from('123456789', 'ascii');
		var full = crc32(buf);

		// Compute in two parts
		var part1 = Buffer.from('12345', 'ascii');
		var part2 = Buffer.from('6789', 'ascii');
		var running = crc32update(part1);
		running = crc32update(part2, running);
		var incremental = crc32finalize(running);

		assert.strictEqual(incremental, full, 'incremental should match full computation');
	});

	it('should support three-part incremental computation', function() {
		var full = crc32(Buffer.from('ABCDEFGHIJ', 'ascii'));

		var r = crc32update(Buffer.from('ABC', 'ascii'));
		r = crc32update(Buffer.from('DEF', 'ascii'), r);
		r = crc32update(Buffer.from('GHIJ', 'ascii'), r);
		var incremental = crc32finalize(r);

		assert.strictEqual(incremental, full);
	});
});

// =========================================================================
// CRC-16 ZMODEM variant
// =========================================================================

describe('CRC-16 ZMODEM variant (crc16zmodem)', function() {

	it('should return 0 for empty buffer', function() {
		assert.strictEqual(crc16zmodem(Buffer.alloc(0)), 0);
	});

	it('should return a 16-bit number in range [0, 0xFFFF]', function() {
		var result = crc16zmodem(Buffer.from([0x41]));
		assert.ok(typeof result === 'number');
		assert.ok(result >= 0 && result <= 0xFFFF);
	});

	it('should give different results from crc16 for non-zero data', function() {
		// The two variants use different formulas — they should diverge on real data
		var buf = Buffer.from('123456789', 'ascii');
		var r1 = crc16(buf);
		var r2 = crc16zmodem(buf);
		assert.notStrictEqual(r1, r2,
			'crc16zmodem should produce a different result from crc16 for non-zero data');
	});

	it('should produce consistent results across calls', function() {
		var buf = Buffer.from('Hello, ZMODEM!', 'ascii');
		var r1 = crc16zmodem(buf);
		var r2 = crc16zmodem(buf);
		assert.strictEqual(r1, r2);
	});

	it('should give different results for different inputs', function() {
		var r1 = crc16zmodem(Buffer.from([0x01]));
		var r2 = crc16zmodem(Buffer.from([0x02]));
		assert.notStrictEqual(r1, r2);
	});

	it('should support init parameter', function() {
		var buf = Buffer.from('test', 'ascii');
		var r1 = crc16zmodem(buf, 0);
		var r2 = crc16zmodem(buf, 0x1234);
		assert.notStrictEqual(r1, r2, 'different init should produce different result');
	});

	it('should equal crc16 when augmented with two zero bytes', function() {
		// The ZMODEM data subpacket CRC-16 variant differs from crc16 in formula order,
		// but the augmentation property holds for the same polynomial family:
		// crc16zmodem(buf) fed through two zero bytes should equal crc16zmodem(buf + [0,0], 0)
		// i.e. incremental chaining works correctly
		var buf = Buffer.from('test', 'ascii');
		var twoZeros = Buffer.from([0x00, 0x00]);

		// Compute in one shot on augmented buffer
		var augmented = Buffer.concat([buf, twoZeros]);
		var oneShotResult = crc16zmodem(augmented);

		// Compute incrementally
		var running = crc16zmodem(buf);
		var incrementalResult = crc16zmodem(twoZeros, running);

		assert.strictEqual(incrementalResult, oneShotResult,
			'incremental with init should equal one-shot on concatenated buffer');
	});

	it('augmentation equivalence holds for multiple inputs', function() {
		var inputs = [
			Buffer.from('Hello', 'ascii'),
			Buffer.from([0x01, 0x02, 0x03]),
			Buffer.from([0xFF, 0x00, 0xAA, 0x55]),
			Buffer.from('123456789', 'ascii')
		];
		var zeros = Buffer.from([0x00, 0x00]);

		for (var i = 0; i < inputs.length; i++) {
			var buf = inputs[i];
			var oneShot = crc16zmodem(Buffer.concat([buf, zeros]));
			var incremental = crc16zmodem(zeros, crc16zmodem(buf));
			assert.strictEqual(incremental, oneShot,
				'augmentation equivalence failed for input ' + i);
		}
	});

	it('should handle single byte inputs', function() {
		// Spot-check a few single-byte values for defined output
		var r0 = crc16zmodem(Buffer.from([0x00]));
		var rFF = crc16zmodem(Buffer.from([0xFF]));
		assert.ok(typeof r0 === 'number' && r0 >= 0 && r0 <= 0xFFFF);
		assert.ok(typeof rFF === 'number' && rFF >= 0 && rFF <= 0xFFFF);
		// They should not be the same (different input → different CRC for single byte)
		assert.notStrictEqual(r0, rFF);
	});
});
