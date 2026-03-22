// tests/termMsgFormat.test.js — Unit tests for termMsgFormat.js
//
// Tests classifyLine(), detectAnsiArt(), measureVisualWidth(), convertPipeCodes(),
// convertCtrlACodes(), convertCP437toUTF8(), convertUTF8toCP437(), reflowParagraphs().
// No DB, no Redis, no filesystem.
// Run: npx mocha tests/termMsgFormat.test.js

import assert from 'assert';
import {
	classifyLine,
	detectAnsiArt,
	convertPipeCodes,
	convertCtrlACodes,
	convertCP437toUTF8,
	convertUTF8toCP437,
	hasAnsiCodes,
	hasPipeCodes,
	hasCtrlACodes,
	hasColorCodes,
	reflowParagraphs,
	LINE_NORMAL,
	LINE_QUOTE,
	LINE_TEAR,
	LINE_TAGLINE,
	LINE_ORIGIN,
	LINE_KLUDGE,
} from '../src/utils/termMsgFormat.js';

// ---------------------------------------------------------------------------
// classifyLine
// ---------------------------------------------------------------------------

describe('classifyLine', function () {

	describe('null / empty input', function () {
		it('should return normal for null', function () {
			assert.strictEqual(classifyLine(null), LINE_NORMAL);
		});

		it('should return normal for empty string', function () {
			assert.strictEqual(classifyLine(''), LINE_NORMAL);
		});
	});

	describe('kludge lines', function () {
		it('should classify SOH-prefixed lines as kludge', function () {
			assert.strictEqual(classifyLine('\x01MSGID: 1:123/456 12345678'), LINE_KLUDGE);
		});

		it('should classify line with leading space then SOH as kludge', function () {
			// trimStart puts SOH at the front
			assert.strictEqual(classifyLine(' \x01KLUDGE'), LINE_KLUDGE);
		});
	});

	describe('origin lines', function () {
		it('should classify "* Origin:" as origin', function () {
			assert.strictEqual(classifyLine(' * Origin: My BBS (1:123/456)'), LINE_ORIGIN);
		});

		it('should classify "* Origin:" without leading space', function () {
			assert.strictEqual(classifyLine('* Origin: My BBS'), LINE_ORIGIN);
		});

		it('should be case-insensitive for origin', function () {
			assert.strictEqual(classifyLine('* origin: test'), LINE_ORIGIN);
		});
	});

	describe('tear lines', function () {
		it('should classify "---" exactly as tear', function () {
			assert.strictEqual(classifyLine('---'), LINE_TEAR);
		});

		it('should classify "--- " with trailing text as tear', function () {
			assert.strictEqual(classifyLine('--- MyBBS 3.14'), LINE_TEAR);
		});

		it('should NOT classify "----" as tear (too many dashes)', function () {
			// "----" does not match /^---\s/ and is not exactly "---"
			assert.notStrictEqual(classifyLine('----'), LINE_TEAR);
		});
	});

	describe('tagline lines', function () {
		it('should classify "--" exactly as tagline', function () {
			assert.strictEqual(classifyLine('--'), LINE_TAGLINE);
		});

		it('should classify "-- " (with trailing space) as tagline', function () {
			assert.strictEqual(classifyLine('-- '), LINE_TAGLINE);
		});

		it('should classify "===" as tagline', function () {
			assert.strictEqual(classifyLine('==='), LINE_TAGLINE);
		});

		it('should classify "====" as tagline', function () {
			assert.strictEqual(classifyLine('===='), LINE_TAGLINE);
		});

		it('should NOT classify "==" (only 2 equals) as tagline', function () {
			assert.notStrictEqual(classifyLine('=='), LINE_TAGLINE);
		});
	});

	describe('quote lines', function () {
		it('should classify "> text" as quote', function () {
			assert.strictEqual(classifyLine('> This is a quote'), LINE_QUOTE);
		});

		it('should classify ">> text" as quote', function () {
			assert.strictEqual(classifyLine('>> Nested quote'), LINE_QUOTE);
		});

		it('should classify " > text" with leading space as quote', function () {
			assert.strictEqual(classifyLine(' > Indented quote'), LINE_QUOTE);
		});

		it('should classify "XX> text" (username prefix) as quote', function () {
			assert.strictEqual(classifyLine('JD> John said this'), LINE_QUOTE);
		});

		it('should classify "Rob> text" (3-letter prefix) as quote', function () {
			assert.strictEqual(classifyLine('Rob> replied here'), LINE_QUOTE);
		});

		it('should classify "-> text" as quote', function () {
			assert.strictEqual(classifyLine('-> reply text'), LINE_QUOTE);
		});

		it('should classify "=> text" as quote', function () {
			assert.strictEqual(classifyLine('=> reply text'), LINE_QUOTE);
		});

		it('should classify "-=> text" as quote', function () {
			assert.strictEqual(classifyLine('-=> reply text'), LINE_QUOTE);
		});
	});

	describe('normal lines', function () {
		it('should classify ordinary text as normal', function () {
			assert.strictEqual(classifyLine('Hello, world!'), LINE_NORMAL);
		});

		it('should classify a line starting with a single dash as normal', function () {
			assert.strictEqual(classifyLine('- list item'), LINE_NORMAL);
		});

		it('should classify "----" of four dashes as normal', function () {
			// Not tear (not "---" or "--- text"), not tagline (not "--" pattern)
			assert.strictEqual(classifyLine('----'), LINE_NORMAL);
		});
	});
});

// ---------------------------------------------------------------------------
// detectAnsiArt
// ---------------------------------------------------------------------------

describe('detectAnsiArt', function () {

	it('should return false for null', function () {
		assert.strictEqual(detectAnsiArt(null), false);
	});

	it('should return false for plain text', function () {
		assert.strictEqual(detectAnsiArt('Hello world'), false);
	});

	it('should return false for SGR-only ANSI (color codes)', function () {
		assert.strictEqual(detectAnsiArt('\x1b[1;33mBright yellow\x1b[0m'), false);
	});

	it('should return true for cursor-up sequence (ESC[A)', function () {
		assert.strictEqual(detectAnsiArt('\x1b[1A'), true);
	});

	it('should return true for cursor positioning (ESC[row;colH)', function () {
		assert.strictEqual(detectAnsiArt('\x1b[5;10H'), true);
	});

	it('should return true for erase screen (ESC[2J)', function () {
		assert.strictEqual(detectAnsiArt('\x1b[2J'), true);
	});

	it('should return true for erase to end of line (ESC[K)', function () {
		assert.strictEqual(detectAnsiArt('\x1b[K'), true);
	});

	it('should return true for cursor forward (ESC[C)', function () {
		assert.strictEqual(detectAnsiArt('\x1b[5C'), true);
	});

	it('should return false for pipe codes (no ANSI)', function () {
		assert.strictEqual(detectAnsiArt('|07Hello |03world'), false);
	});
});

// ---------------------------------------------------------------------------
// convertPipeCodes
// ---------------------------------------------------------------------------

describe('convertPipeCodes', function () {

	it('should return null/undefined unchanged', function () {
		assert.strictEqual(convertPipeCodes(null), null);
		assert.strictEqual(convertPipeCodes(undefined), undefined);
	});

	it('should convert |00 (black foreground) to ANSI', function () {
		var r = convertPipeCodes('|00Text');
		assert.ok(r.includes('\x1b['));
		assert.ok(r.includes('Text'));
	});

	it('should convert |07 (white foreground)', function () {
		var r = convertPipeCodes('|07White');
		assert.ok(r.includes('\x1b[0;37m'));
	});

	it('should convert |08 (bright black = dark grey)', function () {
		var r = convertPipeCodes('|08Dark');
		assert.ok(r.includes('\x1b[1;30m'));
	});

	it('should convert |15 (bright white)', function () {
		var r = convertPipeCodes('|15Bright');
		assert.ok(r.includes('\x1b[1;37m'));
	});

	it('should convert |16 (background black)', function () {
		var r = convertPipeCodes('|16BG');
		assert.ok(r.includes('\x1b[40m'));
	});

	it('should convert |23 (background white)', function () {
		var r = convertPipeCodes('|23BG');
		assert.ok(r.includes('\x1b[47m'));
	});

	it('should leave |24 and above unchanged', function () {
		var r = convertPipeCodes('|24unchanged');
		assert.ok(r.includes('|24'));
	});

	it('should convert multiple pipe codes in one string', function () {
		var r = convertPipeCodes('|07Hello |02World');
		assert.ok(r.includes('\x1b[0;37m'));
		assert.ok(r.includes('\x1b[0;32m'));
	});

	it('should leave text without pipe codes unchanged', function () {
		var r = convertPipeCodes('Plain text');
		assert.strictEqual(r, 'Plain text');
	});
});

// ---------------------------------------------------------------------------
// convertCtrlACodes
// ---------------------------------------------------------------------------

describe('convertCtrlACodes', function () {

	it('should convert Ctrl-A W to bright white ANSI', function () {
		var r = convertCtrlACodes('\x01WText');
		assert.ok(r.includes('\x1b[0;37m'));
		assert.ok(r.includes('Text'));
	});

	it('should convert Ctrl-A R to red', function () {
		var r = convertCtrlACodes('\x01RRed');
		assert.ok(r.includes('\x1b[0;31m'));
	});

	it('should convert Ctrl-A H to bold', function () {
		var r = convertCtrlACodes('\x01HBold');
		assert.ok(r.includes('\x1b[1m'));
	});

	it('should convert Ctrl-A N to reset', function () {
		var r = convertCtrlACodes('\x01NReset');
		assert.ok(r.includes('\x1b[0m'));
	});

	it('should strip unknown Ctrl-A codes silently', function () {
		var r = convertCtrlACodes('\x01ZUnknown');
		// \x01Z is not in CTRLA_MAP, so both chars are consumed/stripped
		assert.ok(!r.includes('\x01'));
		assert.ok(r.includes('Unknown'));
	});

	it('should handle string with no Ctrl-A codes unchanged', function () {
		var r = convertCtrlACodes('Normal text');
		assert.strictEqual(r, 'Normal text');
	});

	it('should return unchanged for null/undefined', function () {
		assert.strictEqual(convertCtrlACodes(null), null);
		assert.strictEqual(convertCtrlACodes(undefined), undefined);
	});
});

// ---------------------------------------------------------------------------
// convertCP437toUTF8
// ---------------------------------------------------------------------------

describe('convertCP437toUTF8', function () {

	it('should return empty string for empty/null', function () {
		assert.strictEqual(convertCP437toUTF8(''), '');
		assert.strictEqual(convertCP437toUTF8(null), '');
	});

	it('should pass through ASCII unchanged', function () {
		assert.strictEqual(convertCP437toUTF8('Hello'), 'Hello');
	});

	it('should convert CP437 byte 0x80 (Ç) to U+00C7', function () {
		var r = convertCP437toUTF8('\x80');
		assert.strictEqual(r, '\u00C7');
	});

	it('should convert CP437 byte 0xBA (box drawing ║) to U+2551', function () {
		// 0xBA = 186 → CP437_EXT[186-128] = CP437_EXT[58] = U+2551
		var r = convertCP437toUTF8('\xBA');
		assert.strictEqual(r, '\u2551');
	});

	it('should convert CP437 byte 0xF0 (≡) to U+2261', function () {
		var r = convertCP437toUTF8('\xF0');
		assert.strictEqual(r, '\u2261');
	});

	it('should convert mixed ASCII and CP437', function () {
		var r = convertCP437toUTF8('Hi\x80');
		assert.strictEqual(r, 'Hi\u00C7');
	});
});

// ---------------------------------------------------------------------------
// convertUTF8toCP437
// ---------------------------------------------------------------------------

describe('convertUTF8toCP437', function () {

	it('should return empty buffer for empty/null', function () {
		var r = convertUTF8toCP437('');
		assert.ok(Buffer.isBuffer(r));
		assert.strictEqual(r.length, 0);
		assert.deepStrictEqual(convertUTF8toCP437(null), Buffer.alloc(0));
	});

	it('should pass through ASCII as-is', function () {
		var r = convertUTF8toCP437('Hello');
		assert.deepStrictEqual(Array.from(r), [72, 101, 108, 108, 111]);
	});

	it('should convert U+00C7 (Ç) to byte 0x80', function () {
		var r = convertUTF8toCP437('\u00C7');
		assert.strictEqual(r[0], 0x80);
	});

	it('should convert U+2551 (║) to byte 0xBA', function () {
		var r = convertUTF8toCP437('\u2551');
		assert.strictEqual(r[0], 0xBA);
	});

	it('should substitute ? (0x3F) for characters not in CP437', function () {
		// Chinese character — not in CP437
		var r = convertUTF8toCP437('\u4E16');
		assert.strictEqual(r[0], 0x3F);
	});

	it('should be a partial inverse of convertCP437toUTF8 for known chars', function () {
		var original = '\xBA\xC9\xBB'; // box drawing chars
		var utf8 = convertCP437toUTF8(original);
		var back = convertUTF8toCP437(utf8);
		assert.strictEqual(back[0], 0xBA);
		assert.strictEqual(back[1], 0xC9);
		assert.strictEqual(back[2], 0xBB);
	});
});

// ---------------------------------------------------------------------------
// hasAnsiCodes / hasPipeCodes / hasCtrlACodes / hasColorCodes
// ---------------------------------------------------------------------------

describe('color code detection helpers', function () {

	it('hasAnsiCodes should return true for ESC[ sequences', function () {
		assert.strictEqual(hasAnsiCodes('\x1b[0;37mText'), true);
	});

	it('hasAnsiCodes should return false for plain text', function () {
		assert.strictEqual(hasAnsiCodes('Plain text'), false);
	});

	it('hasPipeCodes should return true for |07 style codes', function () {
		assert.strictEqual(hasPipeCodes('|07Text'), true);
	});

	it('hasPipeCodes should return false for plain text', function () {
		assert.strictEqual(hasPipeCodes('no pipes here'), false);
	});

	it('hasCtrlACodes should return true for 0x01 byte', function () {
		assert.strictEqual(hasCtrlACodes('\x01WText'), true);
	});

	it('hasCtrlACodes should return false for plain text', function () {
		assert.strictEqual(hasCtrlACodes('plain'), false);
	});

	it('hasColorCodes should return true if any code present', function () {
		assert.strictEqual(hasColorCodes('|07pipe'), true);
		assert.strictEqual(hasColorCodes('\x1b[0mansi'), true);
		assert.strictEqual(hasColorCodes('\x01Wctrla'), true);
	});

	it('hasColorCodes should return false for plain text', function () {
		assert.strictEqual(hasColorCodes('plain text'), false);
	});

	it('hasAnsiCodes / hasPipeCodes / hasCtrlACodes return false for null/empty', function () {
		assert.strictEqual(hasAnsiCodes(null), false);
		assert.strictEqual(hasPipeCodes(null), false);
		assert.strictEqual(hasCtrlACodes(null), false);
	});
});

// ---------------------------------------------------------------------------
// reflowParagraphs
// ---------------------------------------------------------------------------

describe('reflowParagraphs', function () {

	it('should return empty array for empty input', function () {
		assert.deepStrictEqual(reflowParagraphs([], 80), []);
	});

	it('should pass through short lines unchanged', function () {
		var lines = ['Short line', 'Another short one'];
		var r = reflowParagraphs(lines, 80);
		assert.deepStrictEqual(r, lines);
	});

	it('should join long consecutive normal lines', function () {
		// Build a line that is 80% of wrapWidth = 80 → threshold 64
		// So threshold = floor(80*0.80) = 64. Line must be >= 64 chars.
		var longLine = 'A'.repeat(65);
		var continuation = 'B'.repeat(10);
		var lines = [longLine, continuation];
		var r = reflowParagraphs(lines, 80);
		// Should be joined into one paragraph
		assert.strictEqual(r.length, 1);
		assert.ok(r[0].includes(longLine));
		assert.ok(r[0].includes(continuation));
	});

	it('should NOT join across blank lines', function () {
		var longLine = 'A'.repeat(70);
		var lines = [longLine, '', 'Next paragraph'];
		var r = reflowParagraphs(lines, 80);
		// Blank line preserved as separator
		assert.strictEqual(r.length, 3);
	});

	it('should NOT join quote lines into normal paragraphs', function () {
		var longLine = 'A'.repeat(70);
		var quoteLine = '> This is a quote';
		var lines = [longLine, quoteLine];
		var r = reflowParagraphs(lines, 80);
		// Quote line cannot be joined, so at least 2 elements
		assert.strictEqual(r.length, 2);
	});

	it('should NOT join lines starting with whitespace (preformatted)', function () {
		var longLine = 'A'.repeat(70);
		var indented = '   indented line';
		var lines = [longLine, indented];
		var r = reflowParagraphs(lines, 80);
		assert.strictEqual(r.length, 2);
	});

	it('should pass through structural lines (tear, origin) unchanged', function () {
		var lines = ['---', ' * Origin: My BBS (1:123/456)'];
		var r = reflowParagraphs(lines, 80);
		assert.deepStrictEqual(r, lines);
	});
});
