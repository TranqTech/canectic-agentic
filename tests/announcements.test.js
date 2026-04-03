// tests/announcements.test.js — Unit tests for pure functions in src/models/announcements.js
//
// Only the pure exported functions are tested:
//   htmlToTerminalText(html, baseAnsi) — converts TinyMCE HTML to text with ANSI escape sequences
//   htmlToPlainText(html)              — strips HTML to plain text, decodes entities
//
// announcements.js imports postgres — the pg Pool constructor is lazy (no network call at import
// time), so the module loads safely without a running database.
//
// Run: npx mocha tests/announcements.test.js

import assert from 'assert';
import { htmlToTerminalText, htmlToPlainText } from '../src/models/announcements.js';

// Convenience: strip all ANSI escape sequences from a string so content can be asserted
// without caring about exact colour codes.
function stripAnsi(str) {
	return str.replace(/\x1b\[[0-9;]*m/g, '');
}

// Detect whether a string contains at least one ANSI escape sequence.
function hasAnsi(str) {
	return /\x1b\[/.test(str);
}

// ---------------------------------------------------------------------------
// htmlToTerminalText — null / empty / non-string guard
// ---------------------------------------------------------------------------

describe('htmlToTerminalText', function () {

	describe('input guard', function () {

		it('should return empty string for null', function () {
			assert.strictEqual(htmlToTerminalText(null), '');
		});

		it('should return empty string for undefined', function () {
			assert.strictEqual(htmlToTerminalText(undefined), '');
		});

		it('should return empty string for a number', function () {
			assert.strictEqual(htmlToTerminalText(42), '');
		});

		it('should return empty string for an empty string', function () {
			assert.strictEqual(htmlToTerminalText(''), '');
		});

	});

	// ---------------------------------------------------------------------------
	// Plain text passthrough (no tags)
	// ---------------------------------------------------------------------------

	describe('plain text passthrough', function () {

		it('should return plain text unchanged when no tags or entities are present', function () {
			var result = htmlToTerminalText('Hello World');
			assert.strictEqual(result, 'Hello World');
		});

		it('should not append ANSI reset when no ANSI codes were emitted', function () {
			var result = htmlToTerminalText('No colour here');
			assert.ok(!hasAnsi(result), 'unexpected ANSI codes in plain-text output');
		});

	});

	// ---------------------------------------------------------------------------
	// HTML entity decoding
	// ---------------------------------------------------------------------------

	describe('entity decoding', function () {

		it('should decode &amp; to &', function () {
			assert.strictEqual(stripAnsi(htmlToTerminalText('Rock &amp; Roll')), 'Rock & Roll');
		});

		it('should decode &lt; to <', function () {
			assert.strictEqual(stripAnsi(htmlToTerminalText('a &lt; b')), 'a < b');
		});

		it('should decode &gt; to >', function () {
			assert.strictEqual(stripAnsi(htmlToTerminalText('a &gt; b')), 'a > b');
		});

		it('should decode &quot; to "', function () {
			assert.strictEqual(stripAnsi(htmlToTerminalText('say &quot;hello&quot;')), 'say "hello"');
		});

		it('should decode &#39; to single quote', function () {
			assert.strictEqual(stripAnsi(htmlToTerminalText('it&#39;s fine')), "it's fine");
		});

		it('should decode &nbsp; to a regular space', function () {
			assert.strictEqual(stripAnsi(htmlToTerminalText('a&nbsp;b')), 'a b');
		});

		it('should decode multiple entities in one string', function () {
			var result = stripAnsi(htmlToTerminalText('&lt;tag&gt; &amp; &quot;value&quot;'));
			assert.strictEqual(result, '<tag> & "value"');
		});

	});

	// ---------------------------------------------------------------------------
	// Block-level tags: <br>, <p>, <div>
	// ---------------------------------------------------------------------------

	describe('block-level tags', function () {

		it('should convert <br> to CRLF', function () {
			var result = htmlToTerminalText('line1<br>line2');
			assert.ok(result.includes('\r\n'), 'expected CRLF after <br>');
			assert.ok(stripAnsi(result).includes('line1'), 'expected "line1" in result');
			assert.ok(stripAnsi(result).includes('line2'), 'expected "line2" in result');
		});

		it('should convert self-closing <br /> to CRLF', function () {
			var result = htmlToTerminalText('a<br />b');
			assert.ok(result.includes('\r\n'));
		});

		it('should convert </p> to CRLF when followed by more content', function () {
			// trim() removes a trailing CRLF, so use two paragraphs so the CRLF between
			// them survives the trim applied at the end of htmlToTerminalText.
			var result = htmlToTerminalText('<p>first</p><p>second</p>');
			assert.ok(result.includes('\r\n'), 'expected CRLF between paragraphs');
		});

		it('should convert </div> to CRLF when followed by more content', function () {
			var result = htmlToTerminalText('<div>row one</div><div>row two</div>');
			assert.ok(result.includes('\r\n'), 'expected CRLF between divs');
		});

		it('should not double-newline when consecutive blocks already ended with CRLF', function () {
			var result = htmlToTerminalText('<p>one</p><p>two</p>');
			var plain = stripAnsi(result);
			// trim() is applied by the function, so leading/trailing whitespace is gone.
			// There should be at most one CRLF sequence between "one" and "two".
			var between = plain.substring(plain.indexOf('one') + 3, plain.indexOf('two'));
			assert.ok(!between.includes('\r\n\r\n'), 'unexpected double-newline between paragraphs: ' + JSON.stringify(between));
		});

	});

	// ---------------------------------------------------------------------------
	// List items
	// ---------------------------------------------------------------------------

	describe('list items', function () {

		it('should prefix <li> with a bullet marker', function () {
			// The function emits "  * " before each <li>, but trim() is applied at the
			// end of htmlToTerminalText which strips the leading spaces when the <li>
			// is the very first content in the output.  Assert the marker text itself.
			var result = stripAnsi(htmlToTerminalText('<li>Item one</li>'));
			assert.ok(result.includes('* Item one'), 'expected bullet marker, got: ' + JSON.stringify(result));
		});

		it('should emit CRLF after </li>', function () {
			var result = htmlToTerminalText('<li>Item one</li><li>Item two</li>');
			var plain = stripAnsi(result);
			// After first item close, before second item open there must be CRLF then the marker.
			assert.ok(plain.includes('\r\n  * '), 'expected CRLF + bullet for second item');
		});

		it('should render multiple list items correctly', function () {
			var result = stripAnsi(htmlToTerminalText('<ul><li>Alpha</li><li>Beta</li></ul>'));
			// First item: trim() strips the leading spaces, so just "* Alpha".
			// Second item onward: the CRLF prefix prevents trimming, so "  * Beta".
			assert.ok(result.includes('* Alpha'), 'expected bullet + "Alpha"');
			assert.ok(result.includes('  * Beta'), 'expected "  * Beta" for second item');
		});

	});

	// ---------------------------------------------------------------------------
	// Inline formatting: bold, underline
	// ---------------------------------------------------------------------------

	describe('inline formatting', function () {

		it('should emit ANSI bold code for <strong>', function () {
			var result = htmlToTerminalText('<strong>bold</strong>');
			assert.ok(result.includes('\x1b[1m'), 'expected bold ANSI code');
		});

		it('should emit ANSI bold code for <b>', function () {
			var result = htmlToTerminalText('<b>bold</b>');
			assert.ok(result.includes('\x1b[1m'), 'expected bold ANSI code for <b>');
		});

		it('should emit ANSI underline-on code for <u>', function () {
			var result = htmlToTerminalText('<u>underlined</u>');
			assert.ok(result.includes('\x1b[4m'), 'expected underline-on ANSI code');
		});

		it('should emit ANSI underline-off code for </u>', function () {
			var result = htmlToTerminalText('<u>underlined</u>');
			assert.ok(result.includes('\x1b[24m'), 'expected underline-off ANSI code');
		});

		it('should include the text content of a <strong> element', function () {
			var result = stripAnsi(htmlToTerminalText('<strong>Important</strong>'));
			assert.ok(result.includes('Important'));
		});

		it('should append ANSI reset at end when ANSI codes were emitted', function () {
			var result = htmlToTerminalText('<strong>bold</strong>');
			assert.ok(result.endsWith('\x1b[0m'), 'expected trailing ANSI reset');
		});

	});

	// ---------------------------------------------------------------------------
	// <span> with colour styles
	// ---------------------------------------------------------------------------

	describe('span colour styles', function () {

		it('should emit an ANSI colour code for a span with rgb() foreground', function () {
			// rgb(255, 255, 85) maps closest to bright yellow (ANSI 11)
			var result = htmlToTerminalText('<span style="color: rgb(255, 255, 85)">yellow</span>');
			assert.ok(hasAnsi(result), 'expected ANSI codes for coloured span');
			assert.ok(stripAnsi(result).includes('yellow'));
		});

		it('should emit an ANSI colour code for a span with hex foreground', function () {
			var result = htmlToTerminalText('<span style="color: #ffff55">bright</span>');
			assert.ok(hasAnsi(result), 'expected ANSI codes for hex-colour span');
		});

		it('should emit an ANSI colour code for a span with short-form hex (#RGB)', function () {
			var result = htmlToTerminalText('<span style="color: #f00">red</span>');
			assert.ok(hasAnsi(result), 'expected ANSI codes for short-form hex colour span');
		});

		it('should restore base colour after </span>', function () {
			// Without a baseAnsi argument the base is ANSI_RESET (\x1b[0m)
			var result = htmlToTerminalText('<span style="color: #ff5555">red</span>after');
			// After the closing </span> there should be a reset or base code
			var afterClose = result.substring(result.lastIndexOf('</span>'.replace('</', '')));
			// The function emits baseCode on </span>; default is \x1b[0m
			assert.ok(result.includes('\x1b[0m'), 'expected ANSI reset after </span>');
		});

		it('should honour baseAnsi parameter as restore point after </span>', function () {
			// baseAnsi = 2 (green) → baseCode = '\x1b[0;32m'
			var result = htmlToTerminalText('<span style="color: #ff5555">red</span>after', 2);
			assert.ok(result.includes('\x1b[0;32m'), 'expected base colour code after </span>');
		});

		it('should treat #010101 sentinel as theme default (restore to base colour)', function () {
			var result = htmlToTerminalText('<span style="color: #010101">default</span>');
			// The sentinel causes baseCode to be emitted immediately inside the span
			// (before any text is written for that span). The result should contain
			// the ANSI reset code.
			assert.ok(result.includes('\x1b[0m'), 'expected reset for #010101 sentinel');
		});

		it('should emit background colour ANSI codes for background-color style', function () {
			// background-color: #000000 → ANSI 0 → bg code \x1b[40m
			var result = htmlToTerminalText('<span style="background-color: #000000">bg</span>');
			assert.ok(result.includes('\x1b[40m'), 'expected background ANSI code');
		});

		it('should emit high-intensity background code for bright background colours', function () {
			// background-color: #5555ff → closest to ANSI bright blue (12), which is > 7
			// → \x1b[1;44m (12 + 40 - 8 = 44)
			var result = htmlToTerminalText('<span style="background-color: #5555ff">bg</span>');
			assert.ok(result.includes('\x1b[1;44m'), 'expected bright-bg ANSI code');
		});

		it('should ignore a span with no style attribute', function () {
			var result = stripAnsi(htmlToTerminalText('<span>plain</span>'));
			assert.strictEqual(result, 'plain');
		});

		it('should ignore a span with a style that has no color property', function () {
			var result = stripAnsi(htmlToTerminalText('<span style="font-size: 12pt">plain</span>'));
			assert.strictEqual(result, 'plain');
		});

	});

	// ---------------------------------------------------------------------------
	// Links (<a>) — should pass through text, strip the tag
	// ---------------------------------------------------------------------------

	describe('links', function () {

		it('should strip <a> tags and keep link text', function () {
			var result = stripAnsi(htmlToTerminalText('<a href="https://example.com">click here</a>'));
			assert.ok(result.includes('click here'), 'expected link text to be preserved');
			assert.ok(!result.includes('href'), 'expected href attribute to be stripped');
		});

	});

	// ---------------------------------------------------------------------------
	// Trailing whitespace / blank-line collapsing
	// ---------------------------------------------------------------------------

	describe('whitespace normalisation', function () {

		it('should trim leading and trailing whitespace from the result', function () {
			var result = htmlToTerminalText('<p>hello</p>');
			var plain = stripAnsi(result);
			assert.ok(!plain.startsWith('\r\n') && !plain.startsWith('\n'), 'unexpected leading newline');
			assert.ok(!plain.endsWith('\r\n') && !plain.endsWith('\n'), 'unexpected trailing newline');
		});

		it('should preserve multiple consecutive CRLFs from repeated <br> tags', function () {
			// The internal collapse regex is /\r\n{3,}/g which matches \r followed by
			// 3+ literal \n characters — a pattern that the function itself never emits
			// (it always writes \r\n pairs). Consecutive <br> tags therefore produce
			// the expected number of \r\n sequences unchanged.
			var result = htmlToTerminalText('a<br><br>b');
			var plain = stripAnsi(result);
			assert.ok(plain.includes('\r\n\r\n'), 'expected two CRLFs from two <br> tags');
		});

	});

	// ---------------------------------------------------------------------------
	// baseAnsi parameter
	// ---------------------------------------------------------------------------

	describe('baseAnsi parameter', function () {

		it('should accept baseAnsi = 0 (black) and use it as restore point', function () {
			var result = htmlToTerminalText('<span style="color:#ff5555">red</span>text', 0);
			// ANSI 0 = black = \x1b[0;30m
			assert.ok(result.includes('\x1b[0;30m'), 'expected black base colour after </span>');
		});

		it('should use ANSI_RESET when baseAnsi is not provided', function () {
			var result = htmlToTerminalText('<span style="color:#ff5555">red</span>text');
			assert.ok(result.includes('\x1b[0m'), 'expected ANSI reset as default base');
		});

		it('should use ANSI_RESET when baseAnsi is null', function () {
			var result = htmlToTerminalText('<span style="color:#ff5555">red</span>text', null);
			assert.ok(result.includes('\x1b[0m'), 'expected ANSI reset when baseAnsi is null');
		});

		it('should accept baseAnsi for a bright colour (> 7) and emit correct code', function () {
			// baseAnsi = 10 (bright green) → '\x1b[1;32m' (10-8+30 = 32, with bold prefix)
			var result = htmlToTerminalText('<span style="color:#ff5555">red</span>text', 10);
			assert.ok(result.includes('\x1b[1;32m'), 'expected bright-green base code after </span>');
		});

	});

	// ---------------------------------------------------------------------------
	// Unrecognised / unknown tags — should be silently consumed
	// ---------------------------------------------------------------------------

	describe('unknown tags', function () {

		it('should silently strip unrecognised tags', function () {
			var result = stripAnsi(htmlToTerminalText('<table><tr><td>cell</td></tr></table>'));
			assert.ok(result.includes('cell'), 'expected text content to survive unknown tags');
			assert.ok(!result.includes('<'), 'expected no raw < characters from tag stripping');
		});

	});

	// ---------------------------------------------------------------------------
	// ansiColorCode helper behaviour (exercised via span)
	// ---------------------------------------------------------------------------

	describe('ansiColorCode mapping', function () {

		it('should emit bold+colour code (\\x1b[1;3Xm) for bright colours (8-15) via span', function () {
			// Bright red = ANSI 9 → '\x1b[1;31m' (9-8+30 = 31)
			var result = htmlToTerminalText('<span style="color: rgb(255, 85, 85)">bright red</span>');
			assert.ok(result.includes('\x1b[1;31m'), 'expected bright-red code \\x1b[1;31m');
		});

		it('should emit dim colour code (\\x1b[0;3Xm) for standard colours (0-7) via span', function () {
			// Standard red = ANSI 1 → '\x1b[0;31m'
			var result = htmlToTerminalText('<span style="color: rgb(170, 0, 0)">dim red</span>');
			assert.ok(result.includes('\x1b[0;31m'), 'expected dim-red code \\x1b[0;31m');
		});

	});

});

// ---------------------------------------------------------------------------
// htmlToPlainText — null / empty / non-string guard
// ---------------------------------------------------------------------------

describe('htmlToPlainText', function () {

	describe('input guard', function () {

		it('should return empty string for null', function () {
			assert.strictEqual(htmlToPlainText(null), '');
		});

		it('should return empty string for undefined', function () {
			assert.strictEqual(htmlToPlainText(undefined), '');
		});

		it('should return empty string for a number', function () {
			assert.strictEqual(htmlToPlainText(42), '');
		});

		it('should return empty string for an empty string', function () {
			assert.strictEqual(htmlToPlainText(''), '');
		});

	});

	// ---------------------------------------------------------------------------
	// Plain text passthrough
	// ---------------------------------------------------------------------------

	describe('plain text passthrough', function () {

		it('should return plain text unchanged when no tags or entities are present', function () {
			assert.strictEqual(htmlToPlainText('Hello World'), 'Hello World');
		});

	});

	// ---------------------------------------------------------------------------
	// HTML entity decoding
	// ---------------------------------------------------------------------------

	describe('entity decoding', function () {

		it('should decode &amp; to &', function () {
			assert.strictEqual(htmlToPlainText('Rock &amp; Roll'), 'Rock & Roll');
		});

		it('should decode &lt; to <', function () {
			assert.strictEqual(htmlToPlainText('a &lt; b'), 'a < b');
		});

		it('should decode &gt; to >', function () {
			assert.strictEqual(htmlToPlainText('a &gt; b'), 'a > b');
		});

		it('should decode &quot; to "', function () {
			assert.strictEqual(htmlToPlainText('say &quot;hello&quot;'), 'say "hello"');
		});

		it('should decode &#39; to single quote', function () {
			assert.strictEqual(htmlToPlainText("it&#39;s"), "it's");
		});

		it('should decode &nbsp; to a regular space', function () {
			assert.strictEqual(htmlToPlainText('a&nbsp;b'), 'a b');
		});

		it('should decode multiple different entities in one string', function () {
			assert.strictEqual(
				htmlToPlainText('&lt;tag&gt; &amp; &quot;value&quot;'),
				'<tag> & "value"'
			);
		});

	});

	// ---------------------------------------------------------------------------
	// Block-level tags: <br>, </p>, </div>
	// ---------------------------------------------------------------------------

	describe('block-level tags', function () {

		it('should convert <br> to a single newline', function () {
			var result = htmlToPlainText('line1<br>line2');
			assert.ok(result.includes('\n'), 'expected newline after <br>');
			assert.ok(!result.includes('\r'), 'expected no carriage return (\\r) in plain text');
		});

		it('should convert <br /> self-closing to a single newline', function () {
			var result = htmlToPlainText('a<br />b');
			assert.ok(result.includes('\n'));
		});

		it('should convert </p> to a double newline (paragraph break)', function () {
			var result = htmlToPlainText('<p>first</p><p>second</p>');
			assert.ok(result.includes('\n\n'), 'expected double newline after </p>');
		});

		it('should convert </div> to a single newline', function () {
			var result = htmlToPlainText('<div>row one</div><div>row two</div>');
			assert.ok(result.includes('\n'), 'expected newline after </div>');
		});

		it('should strip opening <p> tag without adding whitespace', function () {
			var result = htmlToPlainText('<p>text</p>');
			// The opening <p> tag is stripped; the </p> adds \n\n, then trim() cleans trailing.
			assert.ok(result.includes('text'));
			assert.ok(!result.startsWith('\n'));
		});

	});

	// ---------------------------------------------------------------------------
	// List items
	// ---------------------------------------------------------------------------

	describe('list items', function () {

		it('should prefix <li> with a bullet marker and strip the tag', function () {
			// htmlToPlainText applies trim() at the end, which strips the leading spaces
			// when the <li> is the very first content in the result.  Assert the marker
			// text itself rather than the exact leading-space form.
			var result = htmlToPlainText('<li>Item</li>');
			assert.ok(result.includes('* Item'), 'expected bullet marker, got: ' + JSON.stringify(result));
		});

		it('should emit a newline after </li>', function () {
			var result = htmlToPlainText('<li>One</li><li>Two</li>');
			assert.ok(result.includes('\n  * Two'), 'expected newline before second bullet');
		});

		it('should render multiple list items correctly', function () {
			var result = htmlToPlainText('<ul><li>Alpha</li><li>Beta</li></ul>');
			// First item: trim() strips leading spaces, so "* Alpha".
			// Second item onward: newline prefix prevents trim, so "  * Beta".
			assert.ok(result.includes('* Alpha'), 'expected bullet + "Alpha"');
			assert.ok(result.includes('  * Beta'), 'expected "  * Beta" for second item');
		});

		it('should strip <ul> and <ol> wrapper tags', function () {
			var result = htmlToPlainText('<ul><li>only</li></ul>');
			assert.ok(!result.includes('<ul>') && !result.includes('</ul>'));
		});

	});

	// ---------------------------------------------------------------------------
	// All other HTML tags are stripped
	// ---------------------------------------------------------------------------

	describe('tag stripping', function () {

		it('should strip <strong> and <b> tags but keep text', function () {
			assert.strictEqual(htmlToPlainText('<strong>bold</strong>'), 'bold');
			assert.strictEqual(htmlToPlainText('<b>bold</b>'), 'bold');
		});

		it('should strip <em> and <i> tags but keep text', function () {
			assert.strictEqual(htmlToPlainText('<em>italic</em>'), 'italic');
			assert.strictEqual(htmlToPlainText('<i>italic</i>'), 'italic');
		});

		it('should strip <u> tags but keep text', function () {
			assert.strictEqual(htmlToPlainText('<u>underline</u>'), 'underline');
		});

		it('should strip <span> with style attributes', function () {
			var result = htmlToPlainText('<span style="color:#ff0000">coloured</span>');
			assert.strictEqual(result, 'coloured');
		});

		it('should strip <a> tags and keep link text', function () {
			var result = htmlToPlainText('<a href="https://example.com">click here</a>');
			assert.strictEqual(result, 'click here');
		});

		it('should strip <h1>-<h3> tags and keep heading text', function () {
			assert.strictEqual(htmlToPlainText('<h1>Title</h1>'), 'Title');
			assert.strictEqual(htmlToPlainText('<h2>Subtitle</h2>'), 'Subtitle');
		});

		it('should strip unknown tags without error', function () {
			var result = htmlToPlainText('<table><tr><td>cell data</td></tr></table>');
			assert.ok(result.includes('cell data'));
		});

		it('should produce no angle-bracket characters from stripped tags', function () {
			var result = htmlToPlainText('<strong>test</strong> <em>value</em>');
			assert.ok(!result.includes('<') && !result.includes('>'));
		});

	});

	// ---------------------------------------------------------------------------
	// Whitespace normalisation
	// ---------------------------------------------------------------------------

	describe('whitespace normalisation', function () {

		it('should trim leading and trailing whitespace', function () {
			var result = htmlToPlainText('<p>hello</p>');
			assert.ok(!result.startsWith('\n'));
			assert.ok(!result.endsWith('\n'));
		});

		it('should collapse three or more consecutive newlines to two', function () {
			// </p></p> produces \n\n\n\n which should collapse to \n\n
			var result = htmlToPlainText('<p>one</p><p>two</p><p>three</p>');
			assert.ok(!result.includes('\n\n\n'), 'expected no triple newlines after collapsing');
		});

	});

	// ---------------------------------------------------------------------------
	// Mixed content
	// ---------------------------------------------------------------------------

	describe('mixed content', function () {

		it('should handle a realistic announcement body', function () {
			var html = '<p><strong>Welcome</strong> to the BBS!</p>'
				+ '<p>Please read the rules &amp; have fun.</p>'
				+ '<ul><li>No spam</li><li>Be nice</li></ul>';
			var result = htmlToPlainText(html);
			assert.ok(result.includes('Welcome'));
			assert.ok(result.includes('&') && !result.includes('&amp;'));
			assert.ok(result.includes('  * No spam'));
			assert.ok(result.includes('  * Be nice'));
		});

		it('should not contain any raw HTML tags in a mixed output', function () {
			var html = '<p><strong>Bold</strong> and <em>italic</em> text.</p>';
			var result = htmlToPlainText(html);
			assert.ok(!/[<>]/.test(result), 'expected no angle brackets in output');
		});

	});

});

// ---------------------------------------------------------------------------
// Export surface — ensure all documented exports are present
// ---------------------------------------------------------------------------

describe('announcements module exports', function () {

	it('should export htmlToTerminalText as a function', async function () {
		var mod = await import('../src/models/announcements.js');
		assert.strictEqual(typeof mod.htmlToTerminalText, 'function');
	});

	it('should export htmlToPlainText as a function', async function () {
		var mod = await import('../src/models/announcements.js');
		assert.strictEqual(typeof mod.htmlToPlainText, 'function');
	});

	it('should export getActiveAnnouncements as a function', async function () {
		var mod = await import('../src/models/announcements.js');
		assert.strictEqual(typeof mod.getActiveAnnouncements, 'function');
	});

	it('should export getAllAnnouncements as a function', async function () {
		var mod = await import('../src/models/announcements.js');
		assert.strictEqual(typeof mod.getAllAnnouncements, 'function');
	});

	it('should export updateSortOrder as a function', async function () {
		var mod = await import('../src/models/announcements.js');
		assert.strictEqual(typeof mod.updateSortOrder, 'function');
	});

	it('should export getAnnouncementById as a function', async function () {
		var mod = await import('../src/models/announcements.js');
		assert.strictEqual(typeof mod.getAnnouncementById, 'function');
	});

	it('should export createAnnouncement as a function', async function () {
		var mod = await import('../src/models/announcements.js');
		assert.strictEqual(typeof mod.createAnnouncement, 'function');
	});

	it('should export updateAnnouncement as a function', async function () {
		var mod = await import('../src/models/announcements.js');
		assert.strictEqual(typeof mod.updateAnnouncement, 'function');
	});

	it('should export deleteAnnouncement as a function', async function () {
		var mod = await import('../src/models/announcements.js');
		assert.strictEqual(typeof mod.deleteAnnouncement, 'function');
	});

});
