// tests/codepageConversions.test.js — Unit tests for codepageConversions.js
//
// Tests cp437ToUtf8(), utf8ToCp437(), cp437CharFromCode(), cp437CodeFromChar(),
// canRepresentInCp437(), replaceEdgeSpaces(), replaceMultipleSpaces().
// No DB, no Redis, no filesystem.
// Run: npx mocha tests/codepageConversions.test.js

import assert from 'assert';
import {
	cp437ToUtf8,
	utf8ToCp437,
	cp437ToUtf8StringConv,
	replaceEdgeSpaces,
	formatTextForHtml,
	replaceMultipleSpaces,
} from '../src/utils/codepageConversions.js';

// Also import the non-exported helpers indirectly via their effects.
// cp437CharFromCode and cp437CodeFromChar are not exported — test via cp437ToUtf8.

// ---------------------------------------------------------------------------
// cp437ToUtf8
// ---------------------------------------------------------------------------

describe('cp437ToUtf8', function () {

	describe('byte array input', function () {
		it('should convert ASCII bytes unchanged', function () {
			var r = cp437ToUtf8([72, 101, 108, 108, 111]);
			assert.strictEqual(r, 'Hello');
		});

		it('should convert byte 128 (Ç = U+00C7)', function () {
			var r = cp437ToUtf8([128]);
			assert.strictEqual(r, '\u00C7');
		});

		it('should convert byte 186 (║ = U+2551)', function () {
			var r = cp437ToUtf8([186]);
			assert.strictEqual(r, '\u2551');
		});

		it('should convert byte 240 (≡ = U+2261)', function () {
			var r = cp437ToUtf8([240]);
			assert.strictEqual(r, '\u2261');
		});

		it('should convert byte 248 (° = U+00B0)', function () {
			var r = cp437ToUtf8([248]);
			assert.strictEqual(r, '\u00B0');
		});

		it('should convert byte 255 (non-breaking space = U+00A0)', function () {
			var r = cp437ToUtf8([255]);
			assert.strictEqual(r, '\u00A0');
		});

		it('should handle mixed ASCII and extended', function () {
			// [72, 128] = 'H' + Ç
			var r = cp437ToUtf8([72, 128]);
			assert.strictEqual(r, 'H\u00C7');
		});
	});

	describe('Uint8Array input', function () {
		it('should accept Uint8Array input', function () {
			var r = cp437ToUtf8(new Uint8Array([65, 66, 67]));
			assert.strictEqual(r, 'ABC');
		});

		it('should convert extended bytes from Uint8Array', function () {
			var r = cp437ToUtf8(new Uint8Array([128, 186]));
			assert.strictEqual(r, '\u00C7\u2551');
		});
	});

	describe('string input', function () {
		it('should accept string and use charCode interpretation', function () {
			// When passing a string, each char's charCode is used as a byte index.
			// 'A' has charCode 65, which is ASCII — should pass through unchanged.
			var r = cp437ToUtf8('Hello');
			assert.strictEqual(r, 'Hello');
		});
	});
});

// ---------------------------------------------------------------------------
// utf8ToCp437
// ---------------------------------------------------------------------------

describe('utf8ToCp437', function () {

	describe('ASCII', function () {
		it('should return same byte values for ASCII characters', function () {
			var r = utf8ToCp437('ABC');
			assert.deepStrictEqual(r, [65, 66, 67]);
		});

		it('should handle empty string', function () {
			var r = utf8ToCp437('');
			assert.deepStrictEqual(r, []);
		});
	});

	describe('Unicode → CP437 mapping', function () {
		it('should encode U+00C7 (Ç) to byte 128', function () {
			var r = utf8ToCp437('\u00C7');
			assert.strictEqual(r[0], 128);
		});

		it('should encode U+2551 (║) to byte 186', function () {
			var r = utf8ToCp437('\u2551');
			assert.strictEqual(r[0], 186);
		});

		it('should substitute ? (63) for characters not in CP437', function () {
			// Chinese character, not in CP437
			var r = utf8ToCp437('\u4E16');
			assert.strictEqual(r[0], 63);
		});
	});

	describe('returnUint8Array parameter', function () {
		it('should return regular array by default', function () {
			var r = utf8ToCp437('A');
			assert.ok(Array.isArray(r));
		});

		it('should return Uint8Array when requested', function () {
			var r = utf8ToCp437('A', true);
			assert.ok(r instanceof Uint8Array);
			assert.strictEqual(r[0], 65);
		});
	});

	describe('round-trip with cp437ToUtf8', function () {
		it('should round-trip box-drawing chars', function () {
			// Build a few CP437 box chars and round-trip them
			var cp437Bytes = [186, 201, 187, 200, 188]; // ║╔╗╚╝
			var utf8str = cp437ToUtf8(cp437Bytes);
			var backArray = utf8ToCp437(utf8str);
			assert.deepStrictEqual(backArray, cp437Bytes);
		});
	});
});

// ---------------------------------------------------------------------------
// replaceEdgeSpaces
// ---------------------------------------------------------------------------

describe('replaceEdgeSpaces', function () {

	it('should return null/undefined unchanged', function () {
		assert.strictEqual(replaceEdgeSpaces(null), null);
		assert.strictEqual(replaceEdgeSpaces(undefined), undefined);
	});

	it('should replace a single leading space with &nbsp;', function () {
		var r = replaceEdgeSpaces(' Hello');
		assert.strictEqual(r, '&nbsp;Hello');
	});

	it('should replace multiple leading spaces', function () {
		var r = replaceEdgeSpaces('   Hi');
		assert.strictEqual(r, '&nbsp;&nbsp;&nbsp;Hi');
	});

	it('should replace a single trailing space', function () {
		var r = replaceEdgeSpaces('Hello ');
		assert.strictEqual(r, 'Hello&nbsp;');
	});

	it('should replace both leading and trailing spaces', function () {
		var r = replaceEdgeSpaces('  Hi  ');
		assert.strictEqual(r, '&nbsp;&nbsp;Hi&nbsp;&nbsp;');
	});

	it('should leave interior spaces unchanged', function () {
		var r = replaceEdgeSpaces('Hello World');
		assert.strictEqual(r, 'Hello World');
	});

	it('should leave a string with no spaces unchanged', function () {
		var r = replaceEdgeSpaces('NoSpaces');
		assert.strictEqual(r, 'NoSpaces');
	});

	it('should handle a string of only spaces', function () {
		var r = replaceEdgeSpaces('   ');
		assert.ok(r.includes('&nbsp;'));
	});
});

// ---------------------------------------------------------------------------
// replaceMultipleSpaces
// ---------------------------------------------------------------------------

describe('replaceMultipleSpaces', function () {

	it('should return null/undefined unchanged', function () {
		assert.strictEqual(replaceMultipleSpaces(null), null);
		assert.strictEqual(replaceMultipleSpaces(undefined), undefined);
	});

	it('should replace two consecutive spaces with two &nbsp;', function () {
		var r = replaceMultipleSpaces('a  b');
		assert.strictEqual(r, 'a&nbsp;&nbsp;b');
	});

	it('should replace three consecutive spaces', function () {
		var r = replaceMultipleSpaces('a   b');
		assert.strictEqual(r, 'a&nbsp;&nbsp;&nbsp;b');
	});

	it('should leave single spaces unchanged', function () {
		var r = replaceMultipleSpaces('a b c');
		assert.strictEqual(r, 'a b c');
	});

	it('should leave strings with no spaces unchanged', function () {
		var r = replaceMultipleSpaces('NoSpaces');
		assert.strictEqual(r, 'NoSpaces');
	});

	it('should handle multiple runs of spaces independently', function () {
		var r = replaceMultipleSpaces('a  b   c');
		assert.strictEqual(r, 'a&nbsp;&nbsp;b&nbsp;&nbsp;&nbsp;c');
	});
});

// ---------------------------------------------------------------------------
// formatTextForHtml
// ---------------------------------------------------------------------------

describe('formatTextForHtml', function () {

	it('should return null/undefined unchanged', function () {
		assert.strictEqual(formatTextForHtml(null), null);
		assert.strictEqual(formatTextForHtml(undefined), undefined);
	});

	it('should escape HTML entities', function () {
		var r = formatTextForHtml('<script>alert("xss")</script>');
		assert.ok(!r.includes('<script>'));
		assert.ok(r.includes('&lt;script&gt;'));
		assert.ok(r.includes('&quot;'));
	});

	it('should escape ampersand', function () {
		var r = formatTextForHtml('A & B');
		assert.ok(r.includes('&amp;'));
	});

	it('should escape double quotes', function () {
		var r = formatTextForHtml('"quoted"');
		assert.ok(r.includes('&quot;'));
	});

	it('should escape single quotes', function () {
		var r = formatTextForHtml("it's");
		assert.ok(r.includes('&#39;'));
	});
});
