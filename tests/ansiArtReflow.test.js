// tests/ansiArtReflow.test.js — art must not be reflowed into a single line.
//
// Paragraph reflow joins any consecutive normal line at or above 80% of the
// wrap width, which every 78-to-80 column art row is. Applied to art, three
// rows become one, and nothing downstream can put the breaks back: body_html
// is written once at toss time, so the damage is permanent in the database.
//
// Two defects produced that, and both are covered here.
//
//   1. formatBodyHtml reflowed FIRST and asked whether the body was art
//      afterwards, on the wreckage. Web only; processMessageBody already
//      detected on the raw text and guarded the reflow.
//   2. detectAnsiArt only recognised cursor movement, so art drawn as SGR
//      colour plus CP437 block glyphs — which contains no cursor movement at
//      all — read as ordinary coloured text. Web and terminal both.
//
// Neither throws. The page renders, the message is there, and the art is a
// smear. That is why the regressions below assert line STRUCTURE rather than
// that a call succeeded.
//
// Run: npx mocha --no-config --no-package tests/ansiArtReflow.test.js

import assert from 'assert';
import { detectAnsiArt, reflowText, artLineWidths, isLaidOut } from '../src/utils/termMsgFormat.js';
import { formatBodyHtml } from '../src/utils/terminalText.js';

var BLOCK = '█';   // CP437 0xDB
var RULE  = '─';   // CP437 0xC4

function lines(text) { return text.split(/\r\n|\r|\n/); }
function brCount(html) { return (String(html).match(/<br\s*\/?>/g) || []).length; }

// Three rows of full-width block art, coloured with SGR only.
function blockArt(rows, width) {
	var out = [];
	for (var i = 0; i < (rows || 3); i++) {
		out.push('\x1b[3' + (i % 7) + 'm' + BLOCK.repeat(width || 78));
	}
	return out.join('\r');
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

describe('detectAnsiArt — block glyph art', function () {

	it('recognises SGR colour plus block glyphs as art', function () {
		// The regression. No cursor movement anywhere in this string.
		var art = blockArt(3, 78);
		assert.ok(!/\x1b\[\d*[ABCDHJKfsu]/.test(art), 'sample must contain no cursor movement');
		assert.strictEqual(detectAnsiArt(art), true);
	});

	it('recognises art with a drawn header and footer around plain text', function () {
		// Per-line protection is not enough for this shape: the text between
		// the rows is not glyph-dense, so it would still be joined to itself
		// and to the footer. The verdict has to be about the whole message.
		var art = [
			BLOCK.repeat(78),
			'Welcome to the board, this line is long enough to be reflowed away',
			'and this second line would be joined to it, destroying the layout',
			BLOCK.repeat(78),
		].join('\r');
		assert.strictEqual(detectAnsiArt(art), true);
	});

	it('still recognises cursor-positioned art', function () {
		assert.strictEqual(detectAnsiArt('\x1b[1;1HX'), true);
		assert.strictEqual(detectAnsiArt('\x1b[1A'), true);
		assert.strictEqual(detectAnsiArt('\x1b[2J'), true);
	});
});

describe('detectAnsiArt — what must NOT become art', function () {

	// Every false positive here costs paragraph reflow on an ordinary message,
	// which is orphan words when it is re-wrapped narrower.

	it('leaves plain prose alone', function () {
		assert.strictEqual(detectAnsiArt(
			'The quick brown fox jumps over the lazy dog and keeps going here\r' +
			'It continued for quite some distance before it stopped to rest.'), false);
	});

	it('leaves coloured prose alone', function () {
		assert.strictEqual(detectAnsiArt('\x1b[1;33mBright yellow text\x1b[0m'), false);
	});

	it('leaves prose with a single rule alone', function () {
		assert.strictEqual(detectAnsiArt(
			'Some text here that is reasonably long and will wrap around ok\r' +
			RULE.repeat(40) + '\r' +
			'More text after the rule, also fairly long indeed and wrapping.'), false);
	});

	it('leaves a narrow box signature alone', function () {
		// Two art-like lines, but narrow: this is decoration, not a drawing.
		var msg = 'Body text long enough to be joined by the reflow pass here ok\r' +
			RULE.repeat(30) + '\rSysop, 1:123/456\r' + RULE.repeat(30);
		assert.deepStrictEqual(artLineWidths(msg), [30, 30]);
		assert.strictEqual(detectAnsiArt(msg), false);
	});

	it('handles empty and missing input', function () {
		assert.strictEqual(detectAnsiArt(''), false);
		assert.strictEqual(detectAnsiArt(null), false);
		assert.strictEqual(detectAnsiArt(undefined), false);
	});
});

// ---------------------------------------------------------------------------
// The damage itself
// ---------------------------------------------------------------------------

describe('reflow and art: the caller still asks first', function () {

	it('no longer joins drawn rows on its own', function () {
		// It used to: three full-width rows collapsed to one, which is why both
		// callers run detectAnsiArt before reflowing. Reflow now also refuses
		// to join a line that is laid out (isLaidOut: gaps of spaces, or mostly
		// not letters), because ASCII art is neither cursor movement nor block
		// glyphs and detectAnsiArt cannot see it (#54).
		var art = blockArt(3, 78);
		assert.strictEqual(lines(art).length, 3);
		assert.strictEqual(lines(reflowText(art, 80)).length, 3);
	});

	it('would still join text written between drawn rows, which is why the caller check stays', function () {
		var textRow = 'A line of ordinary words that runs long enough to be a join candidate here,';
		var next = 'and the words carry on onto a second line just as prose would do in a post.';
		assert.strictEqual(lines(reflowText(textRow + '\r' + next, 80)).length, 1,
			'a text row inside art reads as prose; only detectAnsiArt on the whole message protects it');
	});

	it('still reflows ordinary prose', function () {
		// The whole point of reflow. Protecting art by weakening this would
		// trade one rendering bug for another. Lines must exceed 80% of the
		// wrap width (64 at 80) to be join candidates at all.
		var prose = 'The quick brown fox jumps over the lazy dog and keeps on going and on\r' +
			'until it reaches the far side of the field where it finally rests here.';
		assert.ok(lines(prose)[0].length >= 64, 'first line must clear the reflow threshold');
		assert.strictEqual(lines(prose).length, 2);
		assert.strictEqual(lines(reflowText(prose, 80)).length, 1, 'prose must still be joined');
	});
});

describe('formatBodyHtml preserves art line structure', function () {

	it('keeps the line breaks in block art', async function () {
		// The end-to-end regression: what lands in body_html, which is what
		// the web renders and what cannot be repaired later.
		var html = await formatBodyHtml(blockArt(3, 78));
		assert.strictEqual(brCount(html), 2, 'three rows need two breaks between them');
	});

	it('keeps the structure of a header/footer layout', async function () {
		var art = [
			BLOCK.repeat(78),
			'Welcome to the board, this line is long enough to be reflowed away',
			'and this second line would be joined to it, destroying the layout',
			BLOCK.repeat(78),
		].join('\r');
		var html = await formatBodyHtml(art);
		assert.strictEqual(brCount(html), 3, 'four rows need three breaks');
	});

	it('keeps cursor-positioned art working', async function () {
		var art = '\x1b[1;1H' + BLOCK.repeat(78) + '\x1b[2;1H' + BLOCK.repeat(78);
		var html = await formatBodyHtml(art);
		assert.ok(brCount(html) >= 1, 'cursor art must still produce line breaks');
	});

	it('returns null for empty input, as before', async function () {
		assert.strictEqual(await formatBodyHtml(''), null);
		assert.strictEqual(await formatBodyHtml(null), null);
	});
});

describe('reflow leaves laid-out lines alone (#54)', function () {

	// Rows of an ASCII drawing, as posted to ALTBBSADS (message 1557 on the dev
	// board). Every row is 64+ wide, so the old reflow joined each to the next
	// and a 72-column drawing rendered as 148-column lines that wrapped.
	var ASCII_ART = [
		'| \\ / | \\    / |         |   ||      |  |  |       |  |  |     | \\ / ||',
		'|     |   \\ /   -----    |   ||      |---- |---   ------ |     |     | ',
		'|     |    |    -----|   |   ||      |  \\  |      ------ |     |     | '
	];

	it('keeps every row of ASCII art on its own line', function () {
		assert.ok(ASCII_ART.every(function (l) { return l.length >= 64; }), 'rows clear the reflow threshold');
		assert.strictEqual(lines(reflowText(ASCII_ART.join('\r'), 80)).length, 3);
	});

	it('keeps aligned columns and field headers apart', function () {
		for (var l of [
			'Mem:             429          62         146          34         220',
			'Recipe By     : King Cotton Cafe, Morgan Keegan Tower, Memphis TN',
			'MMMMM----------------------TOFU SOUR CREAM---------------------------',
			'-------------------------------------------------------------------------'
		]) assert.strictEqual(isLaidOut(l), true, l);
	});

	it('leaves prose to reflow, including the stray extra space people type', function () {
		for (var l of [
			'JR-Comm 1.02a works really well for me.   Reminds me of the late 80s and',
			'MY APPOLOGIES EVERYONE!  I must not have been fully awake this morning, I',
			'The quick brown fox jumps over the lazy dog and keeps on going and on'
		]) assert.strictEqual(isLaidOut(l), false, l);
	});

	it('does not join prose onto a laid-out line, or a laid-out line onto prose', function () {
		var prose = 'The quick brown fox jumps over the lazy dog and keeps on going and on';
		var rule = 'MMMMM----------------------TOFU SOUR CREAM---------------------------';
		assert.strictEqual(lines(reflowText(prose + '\r' + rule, 80)).length, 2);
		assert.strictEqual(lines(reflowText(rule + '\r' + prose, 80)).length, 2);
	});
});
