// tests/nntpEncoding.test.js — what NNTP articles say about their encoding.
//
// NNTP was wrong in both directions and neither failure was visible from the
// protocol's point of view: articles posted and were accepted, articles
// arrived and were stored. Only the text was wrong.
//
//   Outbound  no Content-Type at all, so the article defaulted to US-ASCII per
//             RFC 5536, and the socket wrote it with latin-1 encoding, which
//             takes the LOW BYTE of each character. U+2588 left as 0x88.
//             Headers carrying non-ASCII went out raw rather than as RFC 2047
//             encoded words.
//
//   Inbound   a UTF-8 article was stored mangled. The transfer-encoding decode
//             maps each BYTE to the codepoint of the same value, which is
//             right for latin-1 and wrong for UTF-8, so a multi-byte sequence
//             became one character per byte. The comment sitting in that
//             function asserted the opposite, which is how it survived.
//
// Run: npx mocha --no-config --no-package tests/nntpEncoding.test.js

import assert from 'assert';
import { normaliseBodyText, formatNntpArticle } from '../src/middleware/tossers/nntpTosser.js';

var BLOCK = '█';
var ACCENT = 'é';

// What the transfer-encoding step hands normaliseBodyText: each byte mapped to
// the codepoint of the same value.
function asBytesString(text, encoding) {
	return Buffer.from(text, encoding || 'utf8').toString('latin1');
}

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

describe('NNTP inbound charset handling', function () {

	it('decodes a UTF-8 article rather than storing it byte-per-character', function () {
		// The regression. Without the decode, U+2588 arrives as three
		// characters and the message is permanently mojibake.
		var wire = asBytesString(BLOCK + BLOCK);
		var out = normaliseBodyText(wire, 'utf-8');
		assert.strictEqual(out.bodyText, BLOCK + BLOCK);
	});

	it('accepts the charset spelled with or without the hyphen', function () {
		var wire = asBytesString(ACCENT);
		assert.strictEqual(normaliseBodyText(wire, 'utf-8').bodyText, ACCENT);
		assert.strictEqual(normaliseBodyText(wire, 'UTF8').bodyText, ACCENT);
	});

	it('defaults to UTF-8 when the article declares nothing', function () {
		// Usenet's practical default, unlike FTN where it is CP437.
		var wire = asBytesString(ACCENT);
		assert.strictEqual(normaliseBodyText(wire, null).bodyText, ACCENT);
	});

	it('leaves latin-1 alone, where a byte value IS the codepoint', function () {
		// The case the old comment was right about, and which must not regress.
		assert.strictEqual(normaliseBodyText(ACCENT, 'iso-8859-1').bodyText, ACCENT);
		assert.strictEqual(normaliseBodyText(ACCENT, 'windows-1252').bodyText, ACCENT);
	});

	it('converts a CP437 crosspost and keeps both forms', function () {
		// CP437 0xDB is the full block.
		var out = normaliseBodyText('Û', 'cp437');
		assert.strictEqual(out.utf8, BLOCK);
		assert.strictEqual(out.bodyText, 'Û', 'raw form kept for the utf8 column contract');
	});

	it('survives an empty body', function () {
		assert.strictEqual(normaliseBodyText('', 'utf-8').bodyText, '');
	});

	it('does not throw on bytes that are not valid UTF-8', function () {
		// A mislabelled article must not take the toss down. Buffer decoding
		// substitutes replacement characters rather than failing.
		var out = normaliseBodyText('ÿþ', 'utf-8');
		assert.strictEqual(typeof out.bodyText, 'string');
	});
});

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

describe('NNTP outbound article', function () {

	function article(overrides) {
		return formatNntpArticle(Object.assign({
			uuid: 'abc-123',
			from_user: 'Test User',
			subject: 'A subject',
			body_text: 'Hello',
			system_time: new Date('2026-09-20T00:00:00Z'),
			reply_to: null,
		}, overrides), 'test.group', 'example.org');
	}

	it('declares the body encoding instead of leaving it to the default', function () {
		// Without this the article is US-ASCII per RFC 5536 and every
		// non-ASCII character is undefined behaviour at the far end.
		var a = article();
		assert.ok(/^MIME-Version: 1\.0$/m.test(a), 'needs MIME-Version');
		assert.ok(/^Content-Type: text\/plain; charset=utf-8$/m.test(a), 'needs a charset');
		assert.ok(/^Content-Transfer-Encoding: 8bit$/m.test(a));
	});

	it('carries a non-ASCII body through intact', function () {
		var a = article({ body_text: BLOCK + BLOCK });
		assert.ok(a.includes(BLOCK + BLOCK),
			'the body must survive into the article text');
	});

	it('RFC 2047 encodes a subject with non-ASCII', function () {
		// A raw 8-bit header is not legal and is mangled or rejected.
		var a = article({ subject: 'caf' + ACCENT });
		assert.ok(/^Subject: =\?UTF-8\?B\?/m.test(a), 'subject should be an encoded word: ' + a.split('\r\n')[2]);
		assert.ok(!a.includes('Subject: caf' + ACCENT), 'raw 8-bit subject must not be emitted');
	});

	it('leaves a plain ASCII subject readable', function () {
		// Encoding everything would be legal and unreadable in a raw article.
		var a = article({ subject: 'Plain subject' });
		assert.ok(/^Subject: Plain subject$/m.test(a));
	});

	it('RFC 2047 encodes the From display name when it needs it', function () {
		var a = article({ from_user: 'Jos' + ACCENT });
		assert.ok(/^From: =\?UTF-8\?B\?/m.test(a));
	});

	it('separates headers from body with a blank line', function () {
		var a = article();
		assert.ok(a.includes('\r\n\r\n'), 'an article without the separator is malformed');
	});

	it('dot-stuffs a line that begins with a period', function () {
		// Otherwise the line terminates the article early.
		var a = article({ body_text: '.hidden' });
		assert.ok(a.includes('..hidden'));
	});

	it('reads the body from body_text, which is canonical for every source', function () {
		// After migration 0006 there is one column to read. Reading utf8 here
		// would return null for an NNTP-sourced message and post an empty one.
		var a = article({ body_text: 'from body_text', utf8: null });
		assert.ok(a.includes('from body_text'));
	});
});
