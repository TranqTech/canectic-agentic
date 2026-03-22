// tests/transferCrc.test.js — CRC-16 and CRC-32 test vectors.

import assert from 'assert';
import { crc16, crc32, crc32update, crc32finalize } from '../src/transfers/crc.js';

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
