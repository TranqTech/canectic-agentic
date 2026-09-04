// tests/jamImport.test.js — Unit tests for the JAM import adapter.
//
// Covers the text splitter (including its fallback path) and jamToDbObj.
// jamToDbObj is pure, so no DB is involved. importJAM itself needs a database
// and is not covered here.
// Run: npx mocha tests/jamImport.test.js

import assert from 'assert';
import {
	jamToDbObj,
	splitJamText,
	fallbackSplit,
} from '../src/maintenance/jamImport.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// A parsed-JAM header with sensible defaults, as jamParser would produce it.
function header(overrides) {
	var base = {
		number: 1,
		dateWritten: 1700000000,
		attribute: 0,
		sender: 'Alice',
		recipient: 'Bob',
		senderAddr: '1:2/3',
		recipientAddr: '1:2/4',
		subject: 'Test subject',
		msgId: '',
		replyId: '',
		pid: '',
		seenBy: '',
		path: '',
		tzUtc: '',
		flags: '',
		kludges: [],
		subfields: [],
	};
	return Object.assign(base, overrides || {});
}

function message(hdrOverrides, bodyText) {
	return {
		header: header(hdrOverrides),
		bodyText: bodyText !== undefined ? bodyText : 'Message body.\r',
		tailText: '',
	};
}

// ---------------------------------------------------------------------------
// fallbackSplit
// ---------------------------------------------------------------------------

describe('jamImport fallbackSplit', function () {

	it('should strip kludge lines from the body', function () {
		var r = fallbackSplit('\x01MSGID: 1:2/3 abc\rReal body\r');
		assert.strictEqual(r.bodyText, 'Real body\r');
	});

	it('should extract MSGID and REPLY', function () {
		var r = fallbackSplit('\x01MSGID: 1:2/3 abc\r\x01REPLY: 1:2/4 def\rBody\r');
		assert.strictEqual(r.msgId, '1:2/3 abc');
		assert.strictEqual(r.replyId, '1:2/4 def');
	});

	it('should extract PID and TID as the tosser id', function () {
		assert.strictEqual(fallbackSplit('\x01PID: Mystic/1.12\rB\r').tosserId, 'Mystic/1.12');
		assert.strictEqual(fallbackSplit('\x01TID: hpt/1.9\rB\r').tosserId, 'hpt/1.9');
	});

	it('should extract TZUTC and PATH', function () {
		var r = fallbackSplit('\x01TZUTC: -0500\r\x01PATH: 2/3\rBody\r');
		assert.strictEqual(r.tzUtc, '-0500');
		assert.strictEqual(r.path, '2/3');
	});

	it('should pull SEEN-BY out of the body', function () {
		var r = fallbackSplit('Body\rSEEN-BY 2/3 4 5\r');
		assert.strictEqual(r.seenBy, '2/3 4 5');
		assert.strictEqual(r.bodyText.indexOf('SEEN-BY'), -1);
	});

	it('should normalise CRLF to bare CR', function () {
		var r = fallbackSplit('line one\r\nline two\r\n');
		assert.strictEqual(r.bodyText, 'line one\rline two\r');
	});

	it('should normalise lone LF to bare CR', function () {
		var r = fallbackSplit('line one\nline two\n');
		assert.strictEqual(r.bodyText, 'line one\rline two\r');
	});

	it('should strip reverse-CR 0x8D characters', function () {
		var r = fallbackSplit('soft\x8Dwrap\r');
		assert.strictEqual(r.bodyText, 'softwrap\r');
	});

	it('should handle empty input', function () {
		var r = fallbackSplit('');
		assert.strictEqual(r.bodyText, '');
		assert.strictEqual(r.msgId, '');
	});

	it('should handle null input', function () {
		assert.strictEqual(fallbackSplit(null).bodyText, '');
	});

	it('should ignore a kludge with no colon', function () {
		var r = fallbackSplit('\x01FLAGS NPD\rBody\r');
		assert.strictEqual(r.bodyText, 'Body\r');
		assert.strictEqual(r.msgId, '');
	});
});

// ---------------------------------------------------------------------------
// splitJamText
// ---------------------------------------------------------------------------

describe('jamImport splitJamText', function () {

	var hdr = { senderAddr: '1:2/3', recipientAddr: '1:2/4' };

	it('should split a typical Mystic message', function () {
		var raw = '\x01MSGID: 1:2/3 5f2a1b3c\r'
			+ '\x01REPLY: 1:2/4 aabbccdd\r'
			+ '\x01PID: Mystic/1.12\r'
			+ '\x01TZUTC: -0500\r'
			+ 'Hello there.\r'
			+ '--- Mystic BBS v1.12\r'
			+ ' * Origin: Test BBS (1:2/3)\r'
			+ 'SEEN-BY 2/3 4 5\r'
			+ '\x01PATH: 2/3\r';

		var r = splitJamText(raw, hdr);
		assert.strictEqual(r.degraded, false);
		assert.strictEqual(r.msgId, '1:2/3 5f2a1b3c');
		assert.strictEqual(r.replyId, '1:2/4 aabbccdd');
		assert.strictEqual(r.tosserId, 'Mystic/1.12');
		assert.strictEqual(r.tzUtc, '-0500');
		assert.strictEqual(r.seenBy, '2/3 4 5');
		assert.strictEqual(r.path, '2/3');
		assert.ok(r.bodyText.indexOf('Hello there.') >= 0);
		assert.ok(r.bodyText.indexOf('Origin:') >= 0);
	});

	it('should keep kludge lines out of the body', function () {
		var r = splitJamText('\x01MSGID: 1:2/3 abc\rVisible\r', hdr);
		assert.strictEqual(r.bodyText.indexOf('\x01'), -1);
		assert.strictEqual(r.bodyText.indexOf('MSGID'), -1);
	});

	it('should carry the header addresses through untouched', function () {
		var r = splitJamText('Body\r', hdr);
		assert.strictEqual(r.source, '1:2/3');
		assert.strictEqual(r.dest, '1:2/4');
	});

	it('should not synthesise an address when the header has none', function () {
		// processMessageText builds a default address from tosser state we do
		// not have; the placeholder keeps that path from firing.
		var r = splitJamText('Body\r', { senderAddr: '', recipientAddr: '' });
		assert.strictEqual(r.source, '');
		assert.strictEqual(r.dest, '');
	});

	it('should parse a colon-form INTL kludge without degrading', function () {
		// This form used to throw inside ftnTosser.processMessageText and
		// force the fallback. It now parses through the primary path.
		var r = splitJamText('\x01INTL: 1:2/3 4:5/6\rBody survives\r', { senderAddr: '', recipientAddr: '' });
		assert.strictEqual(r.degraded, false);
		assert.strictEqual(r.bodyText, 'Body survives\r');
		// FTS-0001 orders INTL as "<destination> <origin>"
		assert.strictEqual(r.dest, '1:2/3');
		assert.strictEqual(r.source, '4:5/6');
	});

	it('should recover other kludges alongside an INTL line', function () {
		var raw = '\x01INTL: 1:2/3 4:5/6\r\x01MSGID: 1:2/3 abc\rBody\r';
		var r = splitJamText(raw, { senderAddr: '1:2/3', recipientAddr: '1:2/4' });
		assert.strictEqual(r.degraded, false);
		assert.strictEqual(r.msgId, '1:2/3 abc');
	});

	it('should let an INTL kludge override the address passed in', function () {
		// The splitter reports what the text says. jamToDbObj is where
		// subfield precedence is applied on top.
		var raw = '\x01INTL: 1:2/3 4:5/6\rBody\r';
		var r = splitJamText(raw, { senderAddr: '9:9/9', recipientAddr: '8:8/8' });
		assert.strictEqual(r.source, '4:5/6');
		assert.strictEqual(r.dest, '1:2/3');
	});

	it('should handle an empty text blob', function () {
		var r = splitJamText('', hdr);
		assert.strictEqual(r.bodyText, '');
	});
});

// ---------------------------------------------------------------------------
// jamToDbObj
// ---------------------------------------------------------------------------

describe('jamToDbObj', function () {

	it('should map the basic header fields', function () {
		var row = jamToDbObj(message({}, 'Body\r'), null);
		assert.strictEqual(row.from_user, 'Alice');
		assert.strictEqual(row.to_user, 'Bob');
		assert.strictEqual(row.subject, 'Test subject');
		assert.strictEqual(row.source, '1:2/3');
		assert.strictEqual(row.destination, '1:2/4');
		assert.strictEqual(row.user_id, 0);
	});

	it('should convert DateWritten to a Date', function () {
		var row = jamToDbObj(message({ dateWritten: 1700000000 }), null);
		assert.ok(row.system_time instanceof Date);
		assert.strictEqual(row.system_time.getTime(), 1700000000 * 1000);
	});

	it('should fall back to now when DateWritten is zero', function () {
		var before = Date.now();
		var row = jamToDbObj(message({ dateWritten: 0 }), null);
		assert.ok(row.system_time.getTime() >= before);
	});

	it('should split MSGID into the tuple columns', function () {
		var row = jamToDbObj(message({ msgId: '1:2/3 5f2a1b3c' }), null);
		assert.strictEqual(row.msg_id, '5f2a1b3c');
		assert.strictEqual(row.msg_orig_addr, '1:2/3');
	});

	it('should split REPLY into the tuple columns', function () {
		var row = jamToDbObj(message({ replyId: '1:2/4 aabbccdd' }), null);
		assert.strictEqual(row.reply_to, 'aabbccdd');
		assert.strictEqual(row.reply_orig_addr, '1:2/4');
	});

	it('should treat a bare serial with no address as serial only', function () {
		var row = jamToDbObj(message({ msgId: 'deadbeef' }), null);
		assert.strictEqual(row.msg_id, 'deadbeef');
		assert.strictEqual(row.msg_orig_addr, '');
	});

	it('should synthesise a msg_id when the base carries no MSGID', function () {
		var row = jamToDbObj(message({ number: 42, msgId: '' }, 'Body\r'), null);
		assert.strictEqual(row.msg_id, 'jam-42');
		assert.strictEqual(row.msg_orig_addr, '');
	});

	it('should prefer the MSGID subfield over an inline kludge', function () {
		var msg = message({ msgId: '1:2/3 fromsubfield' }, '\x01MSGID: 9:9/9 frominline\rBody\r');
		var row = jamToDbObj(msg, null);
		assert.strictEqual(row.msg_id, 'fromsubfield');
		assert.strictEqual(row.msg_orig_addr, '1:2/3');
	});

	it('should fall back to the inline MSGID when there is no subfield', function () {
		var msg = message({ msgId: '' }, '\x01MSGID: 9:9/9 frominline\rBody\r');
		var row = jamToDbObj(msg, null);
		assert.strictEqual(row.msg_id, 'frominline');
		assert.strictEqual(row.msg_orig_addr, '9:9/9');
	});

	it('should break the sender address into zone, net and node', function () {
		var row = jamToDbObj(message({ senderAddr: '2:250/1', recipientAddr: '3:770/1' }), null);
		assert.strictEqual(row.source_zone, 2);
		assert.strictEqual(row.source_net, 250);
		assert.strictEqual(row.source_node, 1);
		assert.strictEqual(row.destination_zone, 3);
		assert.strictEqual(row.destination_net, 770);
		assert.strictEqual(row.destination_node, 1);
	});

	it('should leave address parts null when there is no address', function () {
		var row = jamToDbObj(message({ senderAddr: '', recipientAddr: '' }), null);
		assert.strictEqual(row.source_zone, null);
		assert.strictEqual(row.source_net, null);
		assert.strictEqual(row.destination_node, null);
	});

	it('should stamp source_network_id from the resolved target', function () {
		var row = jamToDbObj(message({}), { networkId: 7 });
		assert.strictEqual(row.source_network_id, 7);
	});

	it('should leave source_network_id null without a target', function () {
		assert.strictEqual(jamToDbObj(message({}), null).source_network_id, null);
	});

	it('should leave source_network_id null when the target has no network', function () {
		assert.strictEqual(jamToDbObj(message({}), { networkId: null }).source_network_id, null);
	});

	it('should extract the origin line from the body', function () {
		var msg = message({}, 'Text\r--- Mystic\r * Origin: Some BBS (1:2/3)\r');
		var row = jamToDbObj(msg, null);
		assert.strictEqual(row.origin_line, 'Some BBS (1:2/3)');
	});

	it('should leave origin_line empty when there is no origin', function () {
		assert.strictEqual(jamToDbObj(message({}, 'Just text\r'), null).origin_line, '');
	});

	it('should prefer the SEEN-BY subfield over an inline SEEN-BY', function () {
		var msg = message({ seenBy: '1/1 2' }, 'Body\rSEEN-BY 9/9 8\r');
		assert.strictEqual(jamToDbObj(msg, null).seen_by, '1/1 2');
	});

	it('should fall back to the inline SEEN-BY when no subfield is present', function () {
		var msg = message({ seenBy: '' }, 'Body\rSEEN-BY 9/9 8\r');
		assert.strictEqual(jamToDbObj(msg, null).seen_by, '9/9 8');
	});

	it('should prefer the PID subfield for tosser_id', function () {
		var msg = message({ pid: 'Mystic/1.12' }, '\x01PID: Other/1.0\rBody\r');
		assert.strictEqual(jamToDbObj(msg, null).tosser_id, 'Mystic/1.12');
	});

	it('should default tosser_id when nothing supplies one', function () {
		assert.strictEqual(jamToDbObj(message({ pid: '' }, 'Body\r'), null).tosser_id, 'JAM Import');
	});

	it('should keep kludges out of body_text but keep them in raw_text', function () {
		var msg = message({}, '\x01MSGID: 1:2/3 abc\rVisible body\r');
		var row = jamToDbObj(msg, null);
		assert.strictEqual(row.body_text.indexOf('MSGID'), -1);
		assert.ok(row.raw_text.indexOf('MSGID') >= 0);
	});

	it('should mirror body_text into the utf8 column', function () {
		var row = jamToDbObj(message({}, 'Body\r'), null);
		assert.strictEqual(row.utf8, row.body_text);
	});

	it('should strip null bytes from every text field', function () {
		var msg = message({
			sender: 'Al\x00ice',
			subject: 'Sub\x00ject',
		}, 'Bo\x00dy\r');
		var row = jamToDbObj(msg, null);
		assert.strictEqual(row.from_user, 'Alice');
		assert.strictEqual(row.subject, 'Subject');
		assert.strictEqual(row.body_text.indexOf('\x00'), -1);
		assert.strictEqual(row.raw_text.indexOf('\x00'), -1);
	});

	it('should default missing names and subject', function () {
		var row = jamToDbObj(message({ sender: '', recipient: '', subject: '' }), null);
		assert.strictEqual(row.from_user, 'Unknown');
		assert.strictEqual(row.to_user, 'All');
		assert.strictEqual(row.subject, '(no subject)');
	});

	it('should carry the TZUTC subfield through', function () {
		assert.strictEqual(jamToDbObj(message({ tzUtc: '-0500' }), null).tz_utc, '-0500');
	});

	it('should give every row a distinct uuid', function () {
		var a = jamToDbObj(message({}), null);
		var b = jamToDbObj(message({}), null);
		assert.notStrictEqual(a.uuid, b.uuid);
		assert.ok(a.uuid.length > 0);
	});

	it('should prefer the address subfields over an INTL kludge', function () {
		var msg = message({ senderAddr: '1:2/3', recipientAddr: '1:2/4' }, '\x01INTL: 9:9/9 8:8/8\rBody\r');
		var row = jamToDbObj(msg, null);
		assert.strictEqual(row.source, '1:2/3');
		assert.strictEqual(row.destination, '1:2/4');
	});

	it('should recover addresses from an INTL kludge when subfields are absent', function () {
		var msg = message({ msgId: '', senderAddr: '', recipientAddr: '' }, '\x01INTL: 1:2/3 4:5/6\rBody\r');
		var row = jamToDbObj(msg, null);
		assert.strictEqual(row.body_text, 'Body\r');
		assert.strictEqual(row.msg_id, 'jam-1');
		assert.strictEqual(row.source, '4:5/6');
		assert.strictEqual(row.destination, '1:2/3');
	});
});
