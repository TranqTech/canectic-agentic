// tests/messageText.test.js — reading a stored body whatever wrote it.
//
// body_text and utf8 have no single agreed meaning. Three importers write them
// three different ways:
//
//   FTN    body_text = Unicode text, utf8 = the same string
//   QWK    body_text = raw CP437 bytes held as latin-1 chars, utf8 = converted
//   NNTP   body_text = decoded text, utf8 = null
//
// Every exporter used to decide for itself which it was looking at, and the
// QWK packer decided wrong: "utf8 is set, therefore body_text is raw CP437" is
// true of a QWK message and false of an FTN one, so relaying an FTN message
// into a QWK packet turned `Γöî` into `ô÷ε`. Nothing threw; the packet was well
// formed and the text was rubbish.
//
// canonicalText is the single place that guess now lives, so normalising
// body_text later means changing one function rather than re-deriving three
// exporters. These tests pin what each convention means, which is exactly the
// knowledge that would otherwise be lost in that migration.
//
// Run: npx mocha --no-config --no-package tests/messageText.test.js

import assert from 'assert';
import { canonicalText, looksLikeRawBytes } from '../src/utils/messageText.js';
import { utf8ToCp437, cp437ToUtf8 } from '../src/utils/codepageConversions.js';

var BLOCK = '█';          // U+2588, CP437 0xDB
var RAW_BLOCK = 'Û';      // that byte held as a latin-1 char
var ACCENT = 'é';         // é, CP437 0x82
var RAW_ACCENT = '';     // that byte held as a latin-1 char

// The three shapes, as the importers actually store them.
var FTN  = { body_text: BLOCK + BLOCK + ACCENT, utf8: BLOCK + BLOCK + ACCENT };
var QWK  = { body_text: RAW_BLOCK + RAW_BLOCK + RAW_ACCENT, utf8: BLOCK + BLOCK + ACCENT };
var NNTP = { body_text: BLOCK + BLOCK + ACCENT, utf8: null };

describe('canonicalText', function () {

	it('reads an FTN message, where both columns hold the same text', function () {
		assert.strictEqual(canonicalText(FTN), BLOCK + BLOCK + ACCENT);
	});

	it('reads a QWK message, where body_text is raw bytes', function () {
		// The case the QWK packer got right and every other reader got wrong.
		assert.strictEqual(canonicalText(QWK), BLOCK + BLOCK + ACCENT);
	});

	it('reads an NNTP message, where utf8 is null', function () {
		assert.strictEqual(canonicalText(NNTP), BLOCK + BLOCK + ACCENT);
	});

	it('treats an empty utf8 column as absent', function () {
		assert.strictEqual(canonicalText({ body_text: 'hello', utf8: '' }), 'hello');
	});

	it('survives missing input', function () {
		assert.strictEqual(canonicalText(null), '');
		assert.strictEqual(canonicalText({}), '');
		assert.strictEqual(canonicalText({ body_text: null, utf8: null }), '');
	});

	it('is safe on a pure-ASCII QWK message, where the two readings agree', function () {
		// Converting ASCII from CP437 changes nothing, so body_text === utf8
		// and this looks like the FTN shape. Harmless: the readings are
		// identical for exactly the inputs where they cannot be told apart.
		var ascii = { body_text: 'plain text', utf8: 'plain text' };
		assert.strictEqual(canonicalText(ascii), 'plain text');
	});
});

describe('every convention survives a CP437 pack', function () {

	// What the QWK packer does: canonical text in, CP437 bytes out.
	function pack(msg) {
		return cp437ToUtf8(Buffer.from(utf8ToCp437(canonicalText(msg), true)));
	}

	it('packs an FTN message without corrupting it', function () {
		// The regression: this used to take body_text raw and write the low
		// byte of each character.
		assert.strictEqual(pack(FTN), BLOCK + BLOCK + ACCENT);
	});

	it('still packs a QWK message correctly', function () {
		// The case that already worked must keep working.
		assert.strictEqual(pack(QWK), BLOCK + BLOCK + ACCENT);
	});

	it('packs an NNTP message without corrupting it', function () {
		assert.strictEqual(pack(NNTP), BLOCK + BLOCK + ACCENT);
	});

	it('demonstrates what the old branch did to an FTN message', function () {
		// Reading body_text raw when it holds text: Buffer.from(x,'binary')
		// keeps the low byte of each codepoint. U+2588 becomes 0x88.
		var wrong = cp437ToUtf8(Buffer.from(FTN.body_text, 'binary'));
		assert.notStrictEqual(wrong, BLOCK + BLOCK + ACCENT);
	});
});

describe('looksLikeRawBytes', function () {

	it('is false for anything above U+00FF, which cannot be raw CP437', function () {
		// Raw bytes held as latin-1 chars cannot exceed U+00FF, so a character
		// above it proves the column holds text. 590 of 7,818 sampled messages
		// on a live board are in that position.
		assert.strictEqual(looksLikeRawBytes(BLOCK), false);
	});

	it('is true for bytes that could be raw', function () {
		assert.strictEqual(looksLikeRawBytes(RAW_BLOCK + RAW_ACCENT), true);
		assert.strictEqual(looksLikeRawBytes('plain ascii'), true);
	});

	it('treats empty as raw, since there is nothing to contradict it', function () {
		assert.strictEqual(looksLikeRawBytes(''), true);
		assert.strictEqual(looksLikeRawBytes(null), true);
	});
});
