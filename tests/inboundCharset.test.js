// tests/inboundCharset.test.js -- what a received message is read as (#57).
//
// Mail arriving without a CHRS kludge was always read as CP437, so software
// that sends UTF-8 and declares nothing had every multi-byte character stored
// as mojibake: "ΓÇÖ" for U+2019, "J├╢rg" for Jörg. About 18,000 messages on
// the hub. The same held for JAM bases, which were read as CP437 whatever
// they held. Separately, the tosser read To, From and Subject with Node's
// 'ascii' decoding, which clears the high bit of every byte, so any non-ASCII
// name or subject was mangled beyond repair.
//
// The rule (charsetPolicy.inboundCharset): a declared CHRS is believed;
// otherwise a message is UTF-8 when its bytes are valid UTF-8 with a
// multi-byte character, and CP437 when they are not. Tested here through the
// real packet reader and JAM reader, since what matters is what gets stored.

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { looksLikeUtf8, inboundCharset } from '../src/utils/charsetPolicy.js';
import { declaredCharset } from '../src/utils/ftnUtils.js';
import { ReadPkt } from '../src/middleware/tossers/ftnTosser.js';
import { parseJAM, SUBFIELD } from '../src/utils/jamParser.js';
import * as cp from '../src/utils/codepageConversions.js';

var tmp;
before(function () { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inbound-charset-')); });
after(function () { fs.rmSync(tmp, { recursive: true, force: true }); });

var cp437 = function (s) { return Buffer.from(cp.utf8ToCp437(s, true)); };
var utf8 = function (s) { return Buffer.from(s, 'utf8'); };

describe('inbound charset rule (#57)', function () {

	it('calls valid multi-byte UTF-8 UTF-8', function () {
		assert.strictEqual(looksLikeUtf8(utf8('Jörg said ’hi’')), true);
		assert.strictEqual(looksLikeUtf8(utf8('Дуже')), true);
	});

	it('does not call genuine CP437 text UTF-8', function () {
		assert.strictEqual(looksLikeUtf8(cp437('café')), false, 'a lone accented letter');
		assert.strictEqual(looksLikeUtf8(cp437('╔═══╗')), false, 'box drawing');
		assert.strictEqual(looksLikeUtf8(Buffer.from('plain ascii')), false, 'nothing to decide');
	});

	it('tests the whole message, because a fragment of art can pass on its own', function () {
		// █░ in CP437 is DB B0, which happens to be valid UTF-8 (U+06F0).
		assert.strictEqual(looksLikeUtf8(cp437('█░')), true);
		// Real art around it breaks the whole, so the message stays CP437.
		assert.strictEqual(looksLikeUtf8(cp437('█░ ╔══╗ █░')), false);
	});

	it('believes a declaration over the bytes', function () {
		assert.strictEqual(inboundCharset('cp437', utf8('Jörg')), 'cp437');
		assert.strictEqual(inboundCharset(null, utf8('Jörg')), 'utf8');
		assert.strictEqual(inboundCharset(null, cp437('café')), 'cp437');
		assert.strictEqual(declaredCharset(Buffer.from('no kludge')), null);
		assert.strictEqual(declaredCharset(Buffer.from('\x01CHRS: CP437 2\r')), 'cp437');
	});
});

// A one-message FTS-0001 packet: 58-byte header, one packed message, 0000.
function packet(msg) {
	var head = Buffer.alloc(58);
	head.writeUInt16LE(3, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(2, 20);
	head.writeUInt16LE(2, 18); head.writeUInt16LE(1, 22); head.writeUInt16LE(1, 34); head.writeUInt16LE(1, 36);
	var m = Buffer.alloc(14);
	m.writeUInt16LE(0x0002, 0);
	var date = Buffer.alloc(20); date.write('01 Jan 26  12:00:00', 'latin1');
	var z = Buffer.from([0]);
	var file = path.join(tmp, 'm' + Math.random().toString(16).slice(2) + '.pkt');
	fs.writeFileSync(file, Buffer.concat([head, m, date, msg.to, z, msg.from, z, msg.subject, z,
		Buffer.from('AREA:TEST\r', 'latin1'), msg.body, z, Buffer.from([0, 0])]));
	return ReadPkt(file).Messages[0];
}

describe('FTN packets (#57)', function () {

	it('reads undeclared UTF-8 as UTF-8, names and subject included', function () {
		var m = packet({ to: utf8('All'), from: utf8('Jörg Lorenz'), subject: utf8('Grüße'),
			body: utf8('It’s 325ºF.\r') });
		assert.strictEqual(m.Charset, 'utf8');
		assert.strictEqual(m.FromUser, 'Jörg Lorenz');
		assert.strictEqual(m.Subject, 'Grüße');
		assert.ok(m.RawText.includes('It’s 325ºF.'), JSON.stringify(m.RawText));
	});

	it('reads CP437 as CP437, and no longer strips the high bit from names', function () {
		var m = packet({ to: cp437('All'), from: cp437('Jérôme'), subject: cp437('Café'),
			body: cp437('╔══╗ café\r') });
		assert.strictEqual(m.Charset, 'cp437');
		assert.strictEqual(m.FromUser, 'Jérôme');
		assert.strictEqual(m.Subject, 'Café');
		assert.ok(m.RawText.includes('╔══╗ café'));
	});

	it('trusts a CP437 declaration even when the bytes would pass as UTF-8', function () {
		var m = packet({ to: utf8('All'), from: utf8('x'), subject: utf8('s'),
			body: Buffer.concat([Buffer.from('\x01CHRS: CP437 2\r', 'latin1'), utf8('Jörg\r')]) });
		assert.strictEqual(m.Charset, 'cp437');
		assert.ok(m.RawText.includes('J├╢rg'), 'read as CP437, as declared');
	});
});

// One-message JAM base (header info 1024 bytes, then the message header).
function jamBase(subfields, text) {
	var info = Buffer.alloc(1024); info.write('JAM\x00', 0, 'latin1'); info.writeUInt32LE(1, 12);
	var sfs = Buffer.concat(subfields.map(function (s) {
		var b = Buffer.alloc(8 + s.data.length); b.writeUInt16LE(s.loID, 0); b.writeUInt32LE(s.data.length, 4); s.data.copy(b, 8); return b;
	}));
	var h = Buffer.alloc(76); h.write('JAM\x00', 0, 'latin1'); h.writeUInt16LE(1, 4); h.writeUInt32LE(sfs.length, 8);
	h.writeUInt32LE(1, 48); h.writeUInt32LE(0x02000000, 52); h.writeUInt32LE(0, 60); h.writeUInt32LE(text.length, 64);
	var name = 'b' + Math.random().toString(16).slice(2);
	fs.writeFileSync(path.join(tmp, name + '.jhr'), Buffer.concat([info, h, sfs]));
	fs.writeFileSync(path.join(tmp, name + '.jdt'), text);
	var r = parseJAM(path.join(tmp, name + '.jhr'), path.join(tmp, name + '.jdt'), null);
	assert.ok(r.status, r.error);
	return r.messages[0];
}

describe('JAM bases (#57)', function () {

	it('reads a UTF-8 message as UTF-8, header subfields included', function () {
		var m = jamBase([{ loID: SUBFIELD.SENDERNAME, data: utf8('Jörg') }, { loID: SUBFIELD.SUBJECT, data: utf8('Дуже') }],
			utf8('It’s fine\r'));
		assert.strictEqual(m.charset, 'utf8');
		assert.strictEqual(m.header.sender, 'Jörg');
		assert.strictEqual(m.header.subject, 'Дуже');
		assert.strictEqual(m.bodyText, 'It’s fine\r');
	});

	it('still reads a CP437 base as CP437', function () {
		var m = jamBase([{ loID: SUBFIELD.SENDERNAME, data: cp437('Jérôme') }], cp437('╔═╗ café\r'));
		assert.strictEqual(m.charset, 'cp437');
		assert.strictEqual(m.header.sender, 'Jérôme');
		assert.strictEqual(m.bodyText, '╔═╗ café\r');
	});

	it('believes a CHRS kludge subfield', function () {
		var m = jamBase([{ loID: SUBFIELD.FTSKLUDGE, data: Buffer.from('CHRS: CP437 2') }, { loID: SUBFIELD.SUBJECT, data: utf8('Jörg') }],
			utf8('Jörg\r'));
		assert.strictEqual(m.charset, 'cp437');
	});
});
