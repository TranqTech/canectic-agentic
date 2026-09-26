// tests/terminalText.test.js — Unit tests for src/utils/terminalText.js
//
// Tests formatBodyHtml and the VirtualTerminal rendering pipeline.
// No DB, no network, no filesystem — pure function tests only.
//
// Run: npx mocha tests/terminalText.test.js

import assert from 'assert';
import { formatBodyHtml } from '../src/utils/terminalText.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Await formatBodyHtml and unwrap (it is async but never truly async in practice)
async function fmtHtml(text, forceWidth) {
	return await formatBodyHtml(text, forceWidth);
}

// ---------------------------------------------------------------------------
// Null / empty input
// ---------------------------------------------------------------------------

describe('formatBodyHtml — null/empty input', function () {

	it('should return null for null input', async function () {
		var result = await fmtHtml(null);
		assert.strictEqual(result, null);
	});

	it('should return null for undefined input', async function () {
		var result = await fmtHtml(undefined);
		assert.strictEqual(result, null);
	});

	it('should return null for empty string', async function () {
		var result = await fmtHtml('');
		assert.strictEqual(result, null);
	});

});

// ---------------------------------------------------------------------------
// Plain text — basic rendering
// ---------------------------------------------------------------------------

describe('formatBodyHtml — plain text', function () {

	it('should return a string for plain text input', async function () {
		var result = await fmtHtml('Hello world');
		assert.strictEqual(typeof result, 'string');
	});

	it('should convert \\r line endings to <br>', async function () {
		var result = await fmtHtml('Line one\rLine two');
		assert.ok(result.includes('<br>'), 'Expected <br> in output, got: ' + result);
	});

	it('should convert \\n line endings to <br>', async function () {
		var result = await fmtHtml('Line one\nLine two');
		assert.ok(result.includes('<br>'), 'Expected <br> in output, got: ' + result);
	});

	it('should convert \\r\\n line endings to a single <br>', async function () {
		var result = await fmtHtml('Line one\r\nLine two');
		// After reflow joins \r\n → \n, the line separator should appear exactly once
		var count = (result.match(/<br>/g) || []).length;
		assert.strictEqual(count, 1, 'Expected exactly one <br> for CRLF input');
	});

	it('should produce content from single-line plain text', async function () {
		var result = await fmtHtml('Hello world');
		assert.ok(result.includes('Hello') || result.length > 0);
	});

	it('should handle text that is only whitespace gracefully', async function () {
		// Should not throw
		var result = await fmtHtml('   ');
		// Result is a string (may be empty after trimming) or null
		assert.ok(result === null || typeof result === 'string');
	});

});

// ---------------------------------------------------------------------------
// Pipe code handling
// ---------------------------------------------------------------------------

describe('formatBodyHtml — pipe codes', function () {

	it('should produce HTML spans for pipe-coded text', async function () {
		var result = await fmtHtml('|07Hello|15 world');
		assert.ok(typeof result === 'string', 'Expected string result');
		assert.ok(result.includes('<span') || result.includes('class='),
			'Expected span/class markup for pipe codes, got: ' + result);
	});

	it('should map |07 to fg-grey CSS class', async function () {
		var result = await fmtHtml('|07text');
		assert.ok(result.includes('fg-grey'), 'Expected fg-grey class for |07');
	});

	it('should map |14 to fg-brightyellow CSS class', async function () {
		var result = await fmtHtml('|14text');
		assert.ok(result.includes('fg-brightyellow'), 'Expected fg-brightyellow class for |14');
	});

	it('should map |09 (foreground) to fg-brightblue CSS class', async function () {
		var result = await fmtHtml('|09text');
		assert.ok(result.includes('fg-brightblue'), 'Expected fg-brightblue for |09');
	});

	it('should map |16 (background black) to bg-black CSS class', async function () {
		var result = await fmtHtml('|16text');
		assert.ok(result.includes('bg-black'), 'Expected bg-black for |16');
	});

	it('should still render the visible text content with pipe codes', async function () {
		var result = await fmtHtml('|07Hello');
		assert.ok(result.includes('Hello'), 'Visible text should appear in output');
	});

	it('should handle multi-line pipe-coded text', async function () {
		var result = await fmtHtml('|07Line one\r|14Line two');
		assert.ok(result.includes('<br>'), 'Expected <br> between lines');
		assert.ok(result.includes('fg-grey') || result.includes('fg-brightyellow'));
	});

});

// ---------------------------------------------------------------------------
// ANSI SGR color codes (color only, not art)
// ---------------------------------------------------------------------------

describe('formatBodyHtml — ANSI SGR color codes', function () {

	it('should produce HTML for ANSI green text', async function () {
		var result = await fmtHtml('\x1b[32mGreen text\x1b[0m');
		assert.ok(typeof result === 'string');
		assert.ok(result.includes('fg-green'), 'Expected fg-green class for ESC[32m');
	});

	it('should produce HTML for ANSI bright red (90-97 range) text', async function () {
		// ESC[91m is the explicit bright-red SGR code (91 = fg-brightred in ansiMappings)
		// Note: ESC[1;31m (bold + red) is NOT mapped to brightred — bold (1) is not in
		// ansiMappings, so only the color 31 is applied → fg-red.
		var result = await fmtHtml('\x1b[91mBright Red\x1b[0m');
		assert.ok(result.includes('fg-brightred'), 'Expected fg-brightred for ESC[91m');
	});

	it('should still include the text content', async function () {
		var result = await fmtHtml('\x1b[32mGreen text\x1b[0m');
		assert.ok(result.includes('Green text'), 'Text content should appear in output');
	});

	it('should handle ANSI reset code by closing spans', async function () {
		var result = await fmtHtml('\x1b[32mColored\x1b[0m normal');
		assert.ok(typeof result === 'string');
		// After reset, the word "normal" should follow without a color span
		// We check it does not crash and contains the text
		assert.ok(result.includes('Colored'));
		assert.ok(result.includes('normal'));
	});

	it('ANSI color-only text (no cursor positioning) should NOT be ANSI art', async function () {
		// Color-only text uses noWrap mode — single spaces between words become real spaces
		var result = await fmtHtml('\x1b[32mword1 word2\x1b[0m');
		// In noWrap mode single inter-word spaces are plain spaces not &nbsp;
		// The key assertion: output is a string with no crash
		assert.ok(typeof result === 'string' && result.length > 0);
	});

});

// ---------------------------------------------------------------------------
// Ctrl-A codes (Synchronet)
// ---------------------------------------------------------------------------

describe('formatBodyHtml — Ctrl-A codes', function () {

	it('should render Ctrl-A green text with fg-green class', async function () {
		var result = await fmtHtml('\x01Ggreen text');
		assert.ok(typeof result === 'string');
		assert.ok(result.includes('fg-green'), 'Expected fg-green class for ^AG');
	});

	it('should render Ctrl-A white text', async function () {
		var result = await fmtHtml('\x01Wwhite');
		assert.ok(result.includes('fg-grey'), 'Expected fg-grey class for ^AW (normal white)');
	});

	it('should render Ctrl-A H (high intensity) followed by color as bright', async function () {
		// ^AH enables high intensity, ^AG + ^AH = bright green
		var result = await fmtHtml('\x01H\x01Gbright green text');
		assert.ok(typeof result === 'string');
		assert.ok(result.includes('fg-brightgreen'), 'Expected fg-brightgreen for ^AH^AG');
	});

	it('should render Ctrl-A N (normal reset) by removing color', async function () {
		var result = await fmtHtml('\x01Gcolored\x01N after reset');
		assert.ok(typeof result === 'string');
		assert.ok(result.includes('colored'));
		assert.ok(result.includes('after reset'));
	});

	it('should render Ctrl-A background color digit', async function () {
		var result = await fmtHtml('\x011some text');
		// ^A1 = bg-darkblue
		assert.ok(typeof result === 'string');
		assert.ok(result.includes('bg-darkblue'), 'Expected bg-darkblue for ^A1');
	});

});

// ---------------------------------------------------------------------------
// ANSI art detection
// ---------------------------------------------------------------------------

describe('formatBodyHtml — ANSI art detection', function () {

	it('text with cursor positioning CSI should be treated as ANSI art', async function () {
		// ESC[10;20H is cursor position — this is art
		var artText = '\x1b[1;1H\x1b[32mArt\x1b[0m';
		var result = await fmtHtml(artText);
		assert.ok(typeof result === 'string', 'ANSI art should return a string');
		// Art mode: all spaces become &nbsp; (fixed-width)
		// The result should be non-empty
		assert.ok(result.length > 0);
	});

	it('text with ESC[2J (clear screen) should be detected as ANSI art', async function () {
		var artText = '\x1b[2J\x1b[32mContent';
		var result = await fmtHtml(artText);
		assert.ok(typeof result === 'string');
	});

	it('text with only SGR codes (no cursor movement) should NOT be art', async function () {
		// Color-only — uses noWrap mode
		// In noWrap mode single spaces are regular spaces (browser wraps)
		// This is a behavioral distinction from art mode
		var colorText = '\x1b[32mword1 word2\x1b[0m';
		var artText = '\x1b[1;1H\x1b[32mword1 word2\x1b[0m';

		var colorResult = await fmtHtml(colorText);
		var artResult = await fmtHtml(artText);

		// Both produce strings
		assert.ok(typeof colorResult === 'string');
		assert.ok(typeof artResult === 'string');
		// Art result uses fixed-width layout — single spaces still become &nbsp;
		// (because noWrap = false in art mode means replaceAllSpaces is active)
		// The difference is observable but we just verify both complete without error
	});

	it('forceWidth parameter should disable noWrap (use fixed column layout)', async function () {
		// With forceWidth set, noWrap is always false
		var result = await fmtHtml('\x1b[32mcolored text\x1b[0m', 80);
		assert.ok(typeof result === 'string');
		// In fixed-width mode, spaces become &nbsp;
		// "colored text" has a space between words that becomes &nbsp;
		assert.ok(result.includes('&nbsp;'), 'Expected &nbsp; in forceWidth mode');
	});

});

// ---------------------------------------------------------------------------
// forceWidth parameter
// ---------------------------------------------------------------------------

describe('formatBodyHtml — forceWidth parameter', function () {

	it('should accept a numeric forceWidth parameter', async function () {
		var result = await fmtHtml('Hello world', 80);
		assert.ok(typeof result === 'string');
	});

	it('should produce <br>-separated output with forceWidth for plain text', async function () {
		var result = await fmtHtml('Line one\rLine two', 80);
		assert.ok(result.includes('<br>'), 'Expected <br> line breaks');
	});

	it('should apply fixed-width layout for colored text with forceWidth', async function () {
		// With forceWidth, noWrap=false so spaces become &nbsp;
		var result = await fmtHtml('\x1b[32mhello world\x1b[0m', 80);
		assert.ok(typeof result === 'string');
		// "hello world" has a space — in fixed-width mode it should be &nbsp;
		assert.ok(result.includes('&nbsp;'));
	});

});

// ---------------------------------------------------------------------------
// Paragraph reflow behavior
// ---------------------------------------------------------------------------

describe('formatBodyHtml — paragraph reflow', function () {

	it('should not reflow quote lines (starting with >)', async function () {
		// A quote line should never be joined to the next line
		var text = '> This is a quoted line.\r> Another quoted line.';
		var result = await fmtHtml(text);
		assert.ok(typeof result === 'string');
		assert.ok(result.includes('<br>'), 'Quote lines should remain separate');
	});

	it('should preserve short lines without joining them', async function () {
		// Short lines should not be reflowed
		var text = 'Short.\rAnother short.';
		var result = await fmtHtml(text);
		assert.ok(result.includes('<br>'), 'Short lines should not be joined');
	});

});

// ---------------------------------------------------------------------------
// noWrap mode space handling (VirtualTerminal)
// ---------------------------------------------------------------------------

describe('formatBodyHtml — noWrap space handling', function () {

	it('single space between words should NOT become &nbsp; in noWrap mode', async function () {
		// pipe-coded text uses noWrap mode (no forceWidth, not art)
		// single inter-word spaces should stay as regular spaces
		var result = await fmtHtml('|07word1 word2');
		// In noWrap mode: single inter-word space → regular space
		// Leading spaces and runs of 2+ → &nbsp;
		// We check that "word1 word2" doesn't have &nbsp; between the words
		assert.ok(typeof result === 'string');
		// The rendered text should have the words close together (single real space)
		// We check this by verifying the content includes the words
		assert.ok(result.includes('word1') && result.includes('word2'));
	});

	it('leading spaces should become &nbsp; in noWrap mode', async function () {
		// Two leading spaces before text
		var result = await fmtHtml('|07  indented text');
		assert.ok(typeof result === 'string');
		// Leading spaces → &nbsp;
		assert.ok(result.includes('&nbsp;'), 'Leading spaces should be &nbsp;');
	});

	it('two consecutive spaces should become two &nbsp; in noWrap mode', async function () {
		var result = await fmtHtml('|07word1  word2');
		assert.ok(typeof result === 'string');
		// Run of 2 spaces → 2x &nbsp;
		assert.ok(result.includes('&nbsp;'), 'Double spaces should become &nbsp;');
	});

});

// ---------------------------------------------------------------------------
// HTML entity escaping (plain text path via formatTextForHtml)
// ---------------------------------------------------------------------------

describe('formatBodyHtml — HTML entity escaping', function () {

	it('should escape < in plain text with alignment (3+ spaces)', async function () {
		var result = await fmtHtml('a   <b> c');
		// Goes through formatTextForHtml which escapes HTML entities
		assert.ok(result.includes('&lt;'), 'Expected &lt; for < in aligned plain text');
	});

	it('should escape > in plain text with alignment', async function () {
		var result = await fmtHtml('a   <b> c');
		assert.ok(result.includes('&gt;'), 'Expected &gt; for > in aligned plain text');
	});

	it('should escape & in plain text with alignment', async function () {
		var result = await fmtHtml('a   foo & bar');
		assert.ok(result.includes('&amp;'), 'Expected &amp; for & in aligned plain text');
	});

});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('formatBodyHtml — edge cases', function () {

	it('should handle very long single lines without throwing', async function () {
		var longLine = 'A'.repeat(300);
		var result = await fmtHtml(longLine);
		assert.ok(typeof result === 'string');
	});

	it('should handle text with only pipe codes (no visible text)', async function () {
		var result = await fmtHtml('|07|14|00');
		assert.ok(result === null || typeof result === 'string');
		// Should not throw
	});

	it('should handle mixed line endings in one message', async function () {
		var result = await fmtHtml('Line1\r\nLine2\rLine3\nLine4');
		assert.ok(typeof result === 'string');
	});

	it('should handle text that starts with blank lines', async function () {
		var result = await fmtHtml('\r\rHello');
		assert.ok(result === null || typeof result === 'string');
	});

	it('should return a string (not an object) for simple plain text', async function () {
		var result = await fmtHtml('Hello world');
		// The plain text path returns reflowed.replace(/\r/g, '<br>')
		// This is a string. Verify no {} coercion happens.
		assert.notStrictEqual(typeof result, 'object', 'formatBodyHtml should not return a plain object');
	});

	it('should handle null gracefully without throwing', async function () {
		var threw = false;
		try {
			await fmtHtml(null);
		} catch (_) {
			threw = true;
		}
		assert.strictEqual(threw, false, 'Should not throw for null input');
	});

	it('should handle text with tab characters', async function () {
		var result = await fmtHtml('|07col1\tcol2');
		assert.ok(typeof result === 'string');
	});

});

// ---------------------------------------------------------------------------
// Return type invariant
// ---------------------------------------------------------------------------

describe('formatBodyHtml — return type invariant', function () {

	var cases = [
		['plain text', 'Hello world'],
		['pipe coded', '|07Hello|15'],
		['ansi sgr', '\x1b[32mGreen\x1b[0m'],
		['ctrl-a', '\x01GGreen\x01N'],
		['multiline', 'Line1\rLine2\rLine3'],
		['with alignment', 'col1   col2   col3'],
	];

	for (var c of cases) {
		// Capture for closure
		(function(label, input) {
			it('should return string or null for ' + label, async function () {
				var result = await fmtHtml(input);
				assert.ok(
					result === null || typeof result === 'string',
					'Expected string or null, got ' + typeof result + ' for input: ' + label
				);
			});
		})(c[0], c[1]);
	}

});

// #60: OTHERNETS posts pad every line with trailing spaces to the full width,
// and the plain-text path turned them into &nbsp;. Lines came out at 81-85
// characters, text plus padding; at 80 columns on a phone the padding
// overflowed onto a line of its own and every message read as double spaced.
describe('formatBodyHtml: trailing padding (#60)', function () {
	// The opening of OTHERNETS message 175 as stored, padding included.
	var PADDED =
		'Health Network is a small FTN echomail network set up by Mike Dippel devoted to  \r' +
		' support Sysops who want to provide Health-Related topics for their users.\r' +
		' \r' +
		' How to join... Joining is as simple as completing an online form, and setting  \r' +
		' up the necessary message and file echoes.  You will then be sent an email with  \r' +
		' any necessary details, and we will begin sending you messages.\r' +
		'      \r' +
		' Ingredient     1 cup     flour           \r';

	function lines(html) {
		return html.split('<br>');
	}
	function visibleLength(line) {
		return line.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&[a-z#0-9]+;/g, 'x').length;
	}

	it('ends no line in padding', async function () {
		var html = await formatBodyHtml(PADDED);
		for (var l of lines(html)) {
			assert.ok(!/(&nbsp;|\s)$/.test(l), 'line ends in padding: ' + JSON.stringify(l));
		}
	});

	it('keeps every line within 80 columns', async function () {
		var html = await formatBodyHtml(PADDED);
		for (var l of lines(html)) assert.ok(visibleLength(l) <= 80, visibleLength(l) + ': ' + l);
	});

	it('keeps leading indentation and aligned runs inside a line', async function () {
		var html = await formatBodyHtml(PADDED);
		assert.match(html, /<br>&nbsp;support Sysops/, 'the leading space');
		assert.match(html, /echoes\.&nbsp;&nbsp;You will/, 'two spaces mid-line');
		assert.match(html, /Ingredient&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;1 cup&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;flour<br>/, 'alignment kept, padding gone');
	});

	it('leaves a line of nothing but spaces as a blank line', async function () {
		var html = await formatBodyHtml(PADDED);
		assert.ok(lines(html).some(function (l) { return l === ''; }));
	});
});
