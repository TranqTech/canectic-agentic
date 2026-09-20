// tests/ftnCharset.test.js — what encoding a message is written in, and how
// it is read back.
//
// This board wrote UTF-8 bytes into every FTN packet and declared nothing.
// FTN's default is CP437, so every receiver following the convention decoded
// them through the CP437 table: U+2588 (block art) is UTF-8 E2 96 88, which
// comes back as "Γûê". A packet captured off the wire held 3256 of those
// sequences. Names, subjects and bodies were all affected; block art just
// makes it obvious, because it is entirely high bytes.
//
// Nothing errors. The packet is well formed and the message arrives. It is
// only wrong on the receiver's screen, which is why the assertions here are
// round trips rather than "did it encode".
//
// The policy is per AREA, because the encoding of an echo is a property of the
// echo rather than of any one link:
//
//   auto    CP437 when the body fits it, UTF-8 when it does not (default)
//   cp437   always CP437, accepting the loss
//   utf8    always UTF-8
//
// Whichever is chosen, the message declares it with a CHRS kludge.
//
// Run: npx mocha --no-config --no-package tests/ftnCharset.test.js

import assert from 'assert';
import * as cp from '../src/utils/codepageConversions.js';
import { charsetFromKludge, chrsValueFor, parseOptionalAttributes } from '../src/utils/ftnUtils.js';
import {
	CHARSET_MODES, normaliseCharsetMode, isCharsetMode, charsetModeLabel,
	fitsCp437, charsetForMessage
} from '../src/utils/charsetPolicy.js';

var BLOCK = '██──';      // CP437-representable art
var ACCENT = 'café naïve';         // CP437-representable letters
var CYRILLIC = 'Привет';  // not in CP437

// Encode the way the tosser now does, then decode the way a receiver does.
function roundTrip(text, mode) {
	var wire = charsetForMessage(mode, text, cp);
	var bytes = wire === 'utf8' ? Buffer.from(text, 'utf8')
	          : wire === 'latin1' ? Buffer.from(text, 'latin1')
	          : Buffer.from(cp.utf8ToCp437(text, true));

	var packet = Buffer.concat([
		Buffer.from('\x01CHRS: ' + chrsValueFor(wire) + '\r', 'latin1'),
		bytes,
	]);

	var detected = charsetFromKludge(packet);
	var decoded = detected === 'utf8' ? packet.toString('utf8')
	            : detected === 'latin1' ? packet.toString('latin1')
	            : cp.cp437ToUtf8(packet);

	return { wire: wire, declared: chrsValueFor(wire), body: decoded.split('\r').slice(1).join('\r') };
}

// ---------------------------------------------------------------------------

describe('CHRS detection on import', function () {

	it('treats an undeclared message as CP437, which is the FTN default', function () {
		// Of 113,079 messages held on this board, 163 carry a CHRS at all.
		// Absent means CP437; it does not mean unknown.
		assert.strictEqual(charsetFromKludge(Buffer.from('plain body', 'latin1')), 'cp437');
		assert.strictEqual(charsetFromKludge(Buffer.from('', 'latin1')), 'cp437');
		assert.strictEqual(charsetFromKludge(null), 'cp437');
	});

	it('reads the identifiers seen in real traffic', function () {
		// These three are the values actually present in this board's message base.
		assert.strictEqual(charsetFromKludge(Buffer.from('\x01CHRS: CP437 2', 'latin1')), 'cp437');
		assert.strictEqual(charsetFromKludge(Buffer.from('\x01CHRS: ASCII 1', 'latin1')), 'cp437');
		assert.strictEqual(charsetFromKludge(Buffer.from('\x01CHRS: UTF-8 4', 'latin1')), 'utf8');
	});

	it('accepts the kludge without a colon', function () {
		assert.strictEqual(charsetFromKludge(Buffer.from('\x01CHRS UTF-8 4', 'latin1')), 'utf8');
	});

	it('reads LATIN-1 and its aliases', function () {
		assert.strictEqual(charsetFromKludge(Buffer.from('\x01CHRS: LATIN-1 2', 'latin1')), 'latin1');
		assert.strictEqual(charsetFromKludge(Buffer.from('\x01CHRS: ISO-8859-1 2', 'latin1')), 'latin1');
	});

	it('falls back to CP437 for an identifier it does not know', function () {
		// A guess is worse than the ecosystem default.
		assert.strictEqual(charsetFromKludge(Buffer.from('\x01CHRS: KOI8-R 2', 'latin1')), 'cp437');
	});

	it('declares the level FTS-5003 specifies', function () {
		assert.strictEqual(chrsValueFor('cp437'), 'CP437 2');
		assert.strictEqual(chrsValueFor('utf8'), 'UTF-8 4');
		assert.strictEqual(chrsValueFor('latin1'), 'LATIN-1 2');
	});
});

describe('area charset policy', function () {

	it('offers exactly the three modes', function () {
		assert.deepStrictEqual(CHARSET_MODES.slice().sort(), ['auto', 'cp437', 'utf8']);
		for (var m of CHARSET_MODES) assert.ok(charsetModeLabel(m).length > 0, m + ' needs a label');
	});

	it('defaults to auto for anything unrecognised', function () {
		assert.strictEqual(normaliseCharsetMode('nonsense'), 'auto');
		assert.strictEqual(normaliseCharsetMode(''), 'auto');
		assert.strictEqual(normaliseCharsetMode(null), 'auto');
		// The mode names are auto/cp437/utf8. The CHRS identifier is spelled
		// UTF-8; the mode is not, and a hyphen is not silently accepted.
		assert.strictEqual(normaliseCharsetMode('utf-8'), 'auto');
	});

	it('tolerates case and surrounding space, as a form posts it', function () {
		assert.strictEqual(normaliseCharsetMode('  UTF8  '), 'utf8');
		assert.strictEqual(normaliseCharsetMode('CP437'), 'cp437');
	});

	it('distinguishes absent from invalid, so an update leaves a stored value alone', function () {
		assert.strictEqual(isCharsetMode(undefined), false);
		assert.strictEqual(isCharsetMode('nonsense'), false);
		assert.strictEqual(isCharsetMode('CP437'), true);
	});

	it('knows what CP437 can carry', function () {
		assert.strictEqual(fitsCp437(BLOCK, cp), true, 'box and block glyphs are CP437');
		assert.strictEqual(fitsCp437(ACCENT, cp), true, 'accented latin is CP437');
		assert.strictEqual(fitsCp437('plain ascii', cp), true);
		assert.strictEqual(fitsCp437(CYRILLIC, cp), false);
		assert.strictEqual(fitsCp437('', cp), true);
	});

	it('auto picks CP437 whenever the body fits it', function () {
		// The compatibility case: nearly all traffic goes out exactly as
		// classic software expects, with no reliance on a kludge.
		assert.strictEqual(charsetForMessage('auto', BLOCK, cp), 'cp437');
		assert.strictEqual(charsetForMessage('auto', ACCENT, cp), 'cp437');
	});

	it('auto reaches for UTF-8 only when CP437 would lose something', function () {
		assert.strictEqual(charsetForMessage('auto', CYRILLIC, cp), 'utf8');
	});

	it('honours a forced mode over what would fit', function () {
		assert.strictEqual(charsetForMessage('utf8', 'plain ascii', cp), 'utf8');
		assert.strictEqual(charsetForMessage('cp437', CYRILLIC, cp), 'cp437');
	});
});

describe('wire round trip', function () {

	it('carries block art intact under auto', function () {
		// The reported symptom, at its source.
		var r = roundTrip(BLOCK, 'auto');
		assert.strictEqual(r.wire, 'cp437');
		assert.strictEqual(r.declared, 'CP437 2');
		assert.strictEqual(r.body, BLOCK);
	});

	it('carries block art intact under a forced utf8 area', function () {
		var r = roundTrip(BLOCK, 'utf8');
		assert.strictEqual(r.wire, 'utf8');
		assert.strictEqual(r.body, BLOCK);
	});

	it('carries accented text intact under every mode', function () {
		for (var mode of CHARSET_MODES) {
			assert.strictEqual(roundTrip(ACCENT, mode).body, ACCENT, 'mode ' + mode);
		}
	});

	it('carries Cyrillic intact under auto and utf8', function () {
		assert.strictEqual(roundTrip(CYRILLIC, 'auto').body, CYRILLIC);
		assert.strictEqual(roundTrip(CYRILLIC, 'utf8').body, CYRILLIC);
	});

	it('loses Cyrillic under a forced cp437 area, which is the declared cost', function () {
		// Not a bug: the sysop chose maximum compatibility for this echo.
		// Asserted so the trade is visible rather than discovered.
		var r = roundTrip(CYRILLIC, 'cp437');
		assert.strictEqual(r.wire, 'cp437');
		assert.strictEqual(r.body, '??????');
	});

	it('is what undeclared UTF-8 was not', function () {
		// The old behaviour, reproduced: UTF-8 bytes read through CP437.
		var mangled = cp.cp437ToUtf8(Buffer.from(BLOCK, 'utf8'));
		assert.notStrictEqual(mangled, BLOCK);
		assert.ok(mangled.includes('Γ'), 'expected the Gamma signature, got ' + JSON.stringify(mangled));
	});
});

// ---------------------------------------------------------------------------
// The kludge round trip that has to work for any of the above to survive relay
// ---------------------------------------------------------------------------

describe('optional attribute round trip', function () {

	it('parses the JSON strings the column actually stores', function () {
		// optional_attributes is text[], and each element goes in as a JSON
		// string. Read back without parsing, attr.attribute is undefined and
		// the tosser writes "\x01undefined: " for every kludge it carries.
		var stored = [
			'{"attribute":"MSGID","value":"1:18/200@fidonet 669675a3"}',
			'{"attribute":"CHRS","value":"UTF-8 4"}',
		];
		assert.deepStrictEqual(parseOptionalAttributes(stored), [
			{ attribute: 'MSGID', value: '1:18/200@fidonet 669675a3' },
			{ attribute: 'CHRS', value: 'UTF-8 4' },
		]);
	});

	it('passes objects through untouched', function () {
		assert.deepStrictEqual(
			parseOptionalAttributes([{ attribute: 'TID', value: 'x' }]),
			[{ attribute: 'TID', value: 'x' }]);
	});

	it('drops the undefined kludges this bug leaves behind', function () {
		// A real packet carried 772 of these across 157 messages. Relaying
		// them onward spreads damage that can no longer be undone.
		var stored = [
			'{"attribute":"undefined","value":""}',
			'{"attribute":"MSGID","value":"keep me"}',
			'{"attribute":"undefined","value":""}',
		];
		assert.deepStrictEqual(parseOptionalAttributes(stored),
			[{ attribute: 'MSGID', value: 'keep me' }]);
	});

	it('keeps a real kludge that merely has an empty value', function () {
		assert.deepStrictEqual(parseOptionalAttributes(['{"attribute":"FLAGS","value":""}']),
			[{ attribute: 'FLAGS', value: '' }]);
	});

	it('reads a bare kludge line, with or without the SOH', function () {
		assert.deepStrictEqual(parseOptionalAttributes(['\x01CHRS: UTF-8 4']),
			[{ attribute: 'CHRS', value: 'UTF-8 4' }]);
		assert.deepStrictEqual(parseOptionalAttributes(['CHRS: UTF-8 4']),
			[{ attribute: 'CHRS', value: 'UTF-8 4' }]);
	});

	it('survives empty, null and malformed input', function () {
		assert.deepStrictEqual(parseOptionalAttributes([]), []);
		assert.deepStrictEqual(parseOptionalAttributes(null), []);
		assert.deepStrictEqual(parseOptionalAttributes(['{bad json']), []);
		assert.deepStrictEqual(parseOptionalAttributes([null, undefined, 42]), []);
	});
});

// ---------------------------------------------------------------------------
// Group default
// ---------------------------------------------------------------------------

describe('charset inheritance from the group', function () {

	// A network that has agreed on UTF-8 should be settable once on the group
	// rather than on every area by hand, and again on every area added later.
	// msgAreas.newArea falls back to the group's value, which is what makes
	// the group setting worth having: a default new areas ignored would be
	// worse than not offering one.

	it('an area with no explicit choice takes the group default', function () {
		assert.strictEqual(normaliseCharsetMode('', normaliseCharsetMode('utf8')), 'utf8');
		assert.strictEqual(normaliseCharsetMode(undefined, normaliseCharsetMode('cp437')), 'cp437');
	});

	it('an explicit choice on the area beats the group', function () {
		assert.strictEqual(normaliseCharsetMode('cp437', normaliseCharsetMode('utf8')), 'cp437');
	});

	it('a group with nothing set leaves areas on auto', function () {
		assert.strictEqual(normaliseCharsetMode('', normaliseCharsetMode(null)), 'auto');
	});

	it('a nonsense group value cannot smuggle an invalid mode into an area', function () {
		assert.strictEqual(normaliseCharsetMode('', normaliseCharsetMode('klingon')), 'auto');
	});
});
