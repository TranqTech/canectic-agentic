// tests/qwkUtf8.test.js: UTF-8 in QWK packets, both directions (#71).
//
// Both HEADERS.DAT writers said "Utf8 = true" whenever the stored message had
// its utf8 column filled, which is most mail, while the body always went out
// as CP437 with 0xE3 line separators. Synchronet, seeing Utf8 = true, splits
// lines on LF only (qwktomsg.cpp:323), so such a message reached a Synchronet
// board as one run-on line. Our reader had the mirror problem: it decoded
// every body as CP437 split on 0xE3, and "handled" Utf8 = true by copying that
// decoding, so UTF-8 mail arrived as mojibake on one line. And a message that
// did not fit CP437 lost its characters on every QWK link.
//
// Now a message goes as CP437 whenever it fits, and as UTF-8 with LF lines and
// Utf8 = true only when it does not and the connection allows it (on by
// default). The flag always describes the bytes actually written.

import assert from 'assert';
import {
	parseMessagesDAT, applyHeadersDat, parseHeadersDat, messageNeedsUtf8, encodeMessageBody,
	decodeHeaderValue, buildHeadersDatEntry, headersEntryBytes
} from '../src/models/qwkClasses.js';
import { buildMessagesDat, buildHeadersDatText } from '../src/models/qwkPacketBuilder.js';

function item(body, extra) {
	return { msg: Object.assign({ id: 1, from_user: 'Alice', to_user: 'All', subject: 'Hi', body_text: body,
		utf8: body, system_time: new Date('2026-09-26T10:00:00Z'), reply_ref: 0 }, extra || {}), conferenceNum: 5 };
}

function roundTrip(items, opts) {
	var built = buildMessagesDat(items, 'HUB', opts);
	var headersText = buildHeadersDatText(items, built.itemOffsets, 'HUB');
	var msgs = parseMessagesDAT(built.buffer);
	applyHeadersDat(msgs, parseHeadersDat(headersText));
	return { msgs: msgs, headersText: headersText, items: items };
}

describe('which messages go as UTF-8', function () {
	it('only when the connection allows it and the text does not fit CP437', function () {
		assert.strictEqual(messageNeedsUtf8({ body_text: 'plain ascii' }, true), false);
		assert.strictEqual(messageNeedsUtf8({ body_text: 'CP437 ░▒▓ fine' }, true), false);
		assert.strictEqual(messageNeedsUtf8({ body_text: 'emoji 🙂' }, true), true);
		assert.strictEqual(messageNeedsUtf8({ body_text: 'emoji 🙂' }, false), false);
		assert.strictEqual(messageNeedsUtf8({ body_text: 'x', subject: 'Ελληνικά' }, true), true, 'header fields count too');
	});

	it('writes UTF-8 with LF lines, and CP437 with 0xE3 lines', function () {
		assert.strictEqual(encodeMessageBody('a\rb', true).toString('utf8').trimEnd(), 'a\nb');
		var cp = encodeMessageBody('a\rb', false);
		assert.strictEqual(cp[1], 0xE3);
		assert.strictEqual(encodeMessageBody('x', true).length % 128, 0);
	});
});

describe('the Utf8 line describes the bytes written', function () {
	it('says false for a message that fits CP437, even with the utf8 column set', function () {
		var r = roundTrip([item('Hello\rthere\r')], { utf8: true });
		assert.match(r.headersText, /Utf8 = false/);
		assert.doesNotMatch(r.headersText, /Utf8 = true/);
	});

	it('says true for one that does not fit, and the body round-trips with its lines', function () {
		var r = roundTrip([item('Smile 🙂\rLine two ✓\r')], { utf8: true });
		assert.match(r.headersText, /Utf8 = true/);
		assert.strictEqual(r.msgs[0].bodyText, 'Smile 🙂\rLine two ✓');
		assert.strictEqual(r.msgs[0].isUtf8, true);
	});

	it('falls back to CP437 when the connection has UTF-8 off', function () {
		var r = roundTrip([item('Smile 🙂\r')], { utf8: false });
		assert.match(r.headersText, /Utf8 = false/);
		assert.notStrictEqual(r.msgs[0].bodyText, 'Smile 🙂');
	});

	it('personal packets, built without the option, never claim UTF-8', function () {
		var r = roundTrip([item('Smile 🙂\r')]);
		assert.match(r.headersText, /Utf8 = false/);
	});

	it('mixes entries: each in its own charset, names included', function () {
		var r = roundTrip([item('plain\r', { from_user: 'Zoë' }), item('🙂\r', { id: 2, from_user: 'Zoë' })], { utf8: true });
		assert.strictEqual(r.msgs[0].from, 'Zoë', 'CP437 entry');
		assert.strictEqual(r.msgs[1].from, 'Zoë', 'UTF-8 entry');
	});

	it('the client REP writer uses the same rule', function () {
		var e = buildHeadersDatEntry(128, { from_user: 'A', to_user: 'B', subject: 'S', utf8: 'set' }, 5, 'NODE', false);
		assert.match(e, /Utf8 = false/);
		assert.match(buildHeadersDatEntry(128, { from_user: 'A' }, 5, 'NODE', true), /Utf8 = true/);
	});
});

describe('reading HEADERS.DAT values', function () {
	it('decodes each by its own Utf8 line', function () {
		var utf8Bytes = Buffer.from('Zoë', 'utf8').toString('latin1');
		var cpBytes = headersEntryBytes('Zoë', false);
		assert.strictEqual(decodeHeaderValue(utf8Bytes, 'true'), 'Zoë');
		assert.strictEqual(decodeHeaderValue(cpBytes, 'false'), 'Zoë');
		assert.strictEqual(decodeHeaderValue(utf8Bytes, ''), 'Zoë', 'no Utf8 line: valid UTF-8 is read as UTF-8');
		assert.strictEqual(decodeHeaderValue(cpBytes, ''), 'Zoë', 'no Utf8 line: anything else is CP437');
	});
});

describe('HEADERS.DAT is read from disk as bytes', function () {
	it('by both readers, so each entry can be decoded by its own Utf8 line', async function () {
		var fs = await import('fs');
		for (var f of ['src/middleware/tossers/qwkTosser.js', 'src/models/qwkUser.js']) {
			var src = fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
			assert.match(src, /readFileSync\(path\.join\(extractDir, headersFile\), 'latin1'\)/, f);
		}
	});

	it('round-trips a UTF-8 entry written to and read from a real file', async function () {
		var fs = await import('fs');
		var os = await import('os');
		var path = await import('path');
		var items = [item('🙂\r', { from_user: 'Zoë' })];
		var built = buildMessagesDat(items, 'HUB', { utf8: true });
		var file = path.join(os.tmpdir(), 'zz-headers-' + process.pid + '.dat');
		fs.writeFileSync(file, buildHeadersDatText(items, built.itemOffsets, 'HUB'), 'latin1');
		var msgs = parseMessagesDAT(built.buffer);
		applyHeadersDat(msgs, parseHeadersDat(fs.readFileSync(file, 'latin1')));
		fs.unlinkSync(file);
		assert.strictEqual(msgs[0].from, 'Zoë');
		assert.strictEqual(msgs[0].bodyText, '🙂');
	});
});
