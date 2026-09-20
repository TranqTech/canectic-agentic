// tests/qwkClasses.test.js — Unit tests for src/models/qwkClasses.js
//
// Tests all exported pure functions:
//   parseControlDat, parseMessagesDAT, parseHeadersDat, applyHeadersDat,
//   buildQwkHeader, buildQwkBody
//
// No DB, no network, no filesystem.
// Run: npx mocha tests/qwkClasses.test.js

import assert from 'assert';
import { cp437ToUtf8, utf8ToCp437 } from '../src/utils/codepageConversions.js';
import {
	QWK_RECORD_SIZE,
	QWK_LINE_TERM,
	parseControlDat,
	parseMessagesDAT,
	parseHeadersDat,
	applyHeadersDat,
	buildQwkHeader,
	buildQwkBody
} from '../src/models/qwkClasses.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Build a minimal 128-byte MESSAGES.DAT buffer with one message.
// The first 128 bytes are the BBS ID header block (record 0).
// The next 128 bytes are the message header.
// body occupies blocks after the header.
function buildMsgBuffer(hdrFields, bodyText) {
	// Record 0 — packet ID
	var rec0 = Buffer.alloc(QWK_RECORD_SIZE, 0x20);
	rec0.write('TESTBBS', 0, 7, 'ascii');

	// Encode body using QWK conventions: \n → 0xE3, pad to 128-byte boundary
	var bodyRaw = (bodyText || '').replace(/\n/g, String.fromCharCode(0xE3));
	var rawBuf  = Buffer.from(bodyRaw, 'binary');
	var remainder = rawBuf.length % QWK_RECORD_SIZE;
	var padLen  = remainder === 0 ? 0 : (QWK_RECORD_SIZE - remainder);
	var bodyBuf = Buffer.alloc(rawBuf.length + padLen, 0x20);
	rawBuf.copy(bodyBuf);

	var bodyBlocks = Math.ceil(bodyBuf.length / QWK_RECORD_SIZE) || 1;
	var totalBlocks = 1 + bodyBlocks; // 1 header + body blocks

	// Message header (128 bytes)
	var hdr = Buffer.alloc(QWK_RECORD_SIZE, 0x20);

	// Status byte (offset 0)
	hdr[0] = hdrFields.status !== undefined ? hdrFields.status : 0x20;

	// MsgNumber (offsets 1-7, 7 chars)
	hdr.write(String(hdrFields.msgNumber || 1).padEnd(7, ' '), 1, 7, 'ascii');

	// Date (offsets 8-15, 8 chars) "MM-DD-YY"
	hdr.write(hdrFields.date || '03-21-25', 8, 8, 'ascii');

	// Time (offsets 16-20, 5 chars) "HH:MM"
	hdr.write(hdrFields.time || '14:30', 16, 5, 'ascii');

	// To (offsets 21-45, 25 chars)
	hdr.write((hdrFields.to || 'All').padEnd(25, ' '), 21, 25, 'ascii');

	// From (offsets 46-70, 25 chars)
	hdr.write((hdrFields.from || 'Tester').padEnd(25, ' '), 46, 25, 'ascii');

	// Subject (offsets 71-95, 25 chars)
	hdr.write((hdrFields.subject || 'Hello').padEnd(25, ' '), 71, 25, 'ascii');

	// ReplyRef (offsets 108-115, 8 chars)
	hdr.write(String(hdrFields.replyRef || 0).padEnd(8, ' '), 108, 8, 'ascii');

	// Blocks (offsets 116-121, 6 chars)
	hdr.write(String(totalBlocks).padEnd(6, ' '), 116, 6, 'ascii');

	// Active flag (offset 122)
	hdr[122] = hdrFields.activeByte !== undefined ? hdrFields.activeByte : 0xE1;

	// Conference number LE uint16 (offsets 123-124)
	hdr.writeUInt16LE(hdrFields.conferenceNum !== undefined ? hdrFields.conferenceNum : 1, 123);

	return Buffer.concat([rec0, hdr, bodyBuf]);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('QWK constants', function () {
	it('QWK_RECORD_SIZE should be 128', function () {
		assert.strictEqual(QWK_RECORD_SIZE, 128);
	});

	it('QWK_LINE_TERM should be 0xE3', function () {
		assert.strictEqual(QWK_LINE_TERM, 0xE3);
	});
});

// ---------------------------------------------------------------------------
// parseControlDat
// ---------------------------------------------------------------------------

describe('parseControlDat', function () {

	describe('basic parsing', function () {
		var SAMPLE_CONTROL = [
			'Fidonet BBS',
			'Anytown, USA',
			'555-1234',
			'Test Sysop',
			'TESTBBS',
			'03-21-2025, 14:30',
			'Test Sysop',
			'',
			'1',     // conference count
			'1',
			'General',
			'2',
			'Tech Talk',
			'HELLO',
			'NEWS',
			'GOODBYE'
		].join('\r\n');

		var result;
		before(function () {
			result = parseControlDat(SAMPLE_CONTROL);
		});

		it('should parse BBS name', function () {
			assert.strictEqual(result.bbsName, 'Fidonet BBS');
		});

		it('should parse BBS city', function () {
			assert.strictEqual(result.bbsCity, 'Anytown, USA');
		});

		it('should parse BBS phone', function () {
			assert.strictEqual(result.bbsPhone, '555-1234');
		});

		it('should parse BBS sysop', function () {
			assert.strictEqual(result.bbsSysop, 'Test Sysop');
		});

		it('should parse and uppercase the packet name', function () {
			assert.strictEqual(result.packetName, 'TESTBBS');
		});

		it('should return conferences as an array', function () {
			assert.ok(Array.isArray(result.conferences));
		});

		it('should parse at least 2 conferences', function () {
			assert.ok(result.conferences.length >= 2);
		});

		it('should parse conference numbers correctly', function () {
			var conf1 = result.conferences.find(function(c) { return c.number === 1; });
			var conf2 = result.conferences.find(function(c) { return c.number === 2; });
			assert.ok(conf1, 'Conference 1 not found');
			assert.ok(conf2, 'Conference 2 not found');
		});

		it('should parse conference names correctly', function () {
			var conf1 = result.conferences.find(function(c) { return c.number === 1; });
			var conf2 = result.conferences.find(function(c) { return c.number === 2; });
			assert.strictEqual(conf1.name, 'General');
			assert.strictEqual(conf2.name, 'Tech Talk');
		});
	});

	describe('line ending tolerance', function () {
		it('should handle LF-only line endings', function () {
			var text = 'BBS Name\nCity\nPhone\nSysop\nBBSID\n';
			var r = parseControlDat(text);
			assert.strictEqual(r.bbsName, 'BBS Name');
		});

		it('should handle CRLF line endings', function () {
			var text = 'BBS Name\r\nCity\r\nPhone\r\nSysop\r\nBBSID\r\n';
			var r = parseControlDat(text);
			assert.strictEqual(r.bbsName, 'BBS Name');
		});
	});

	describe('empty input', function () {
		it('should return empty strings for missing header fields', function () {
			var r = parseControlDat('');
			assert.strictEqual(r.bbsName, '');
			assert.strictEqual(r.packetName, '');
		});

		it('should return empty conferences array for missing conference data', function () {
			var r = parseControlDat('BBS\nCity\nPhone\nSysop\nID\n');
			assert.deepStrictEqual(r.conferences, []);
		});
	});
});

// ---------------------------------------------------------------------------
// parseMessagesDAT
// ---------------------------------------------------------------------------

describe('parseMessagesDAT', function () {

	describe('too-small buffer', function () {
		it('should return empty array for null input', function () {
			var r = parseMessagesDAT(null);
			assert.deepStrictEqual(r, []);
		});

		it('should return empty array for a buffer smaller than two records', function () {
			var r = parseMessagesDAT(Buffer.alloc(100));
			assert.deepStrictEqual(r, []);
		});

		it('should return empty array for a buffer with only one record (header)', function () {
			var r = parseMessagesDAT(Buffer.alloc(QWK_RECORD_SIZE));
			assert.deepStrictEqual(r, []);
		});
	});

	describe('single message parsing', function () {
		var msg;
		before(function () {
			var buf = buildMsgBuffer(
				{ to: 'Test User', from: 'Sender', subject: 'Test Subject',
				  date: '03-21-25', time: '14:30', conferenceNum: 5, msgNumber: 42 },
				'Hello, this is the body text.\nSecond line.\n'
			);
			var msgs = parseMessagesDAT(buf);
			msg = msgs[0];
		});

		it('should parse exactly one message', function () {
			var buf = buildMsgBuffer({ to: 'All', from: 'Me', subject: 'Hi' }, 'Body\n');
			var msgs = parseMessagesDAT(buf);
			assert.strictEqual(msgs.length, 1);
		});

		it('should parse the To field', function () {
			assert.strictEqual(msg.to, 'Test User');
		});

		it('should parse the From field', function () {
			assert.strictEqual(msg.from, 'Sender');
		});

		it('should parse the Subject field', function () {
			assert.strictEqual(msg.subject, 'Test Subject');
		});

		it('should parse the date field', function () {
			assert.strictEqual(msg.date, '03-21-25');
		});

		it('should parse the time field', function () {
			assert.strictEqual(msg.time, '14:30');
		});

		it('should parse conference number', function () {
			assert.strictEqual(msg.conferenceNum, 5);
		});

		it('should parse message number', function () {
			assert.strictEqual(msg.msgNumber, 42);
		});

		it('should mark active message as isLive = true', function () {
			assert.strictEqual(msg.isLive, true);
		});
	});

	describe('deleted message', function () {
		it('should mark a message with activeByte 0xE0 as isLive = false', function () {
			var buf = buildMsgBuffer({ activeByte: 0xE0 }, 'Deleted body\n');
			var msgs = parseMessagesDAT(buf);
			assert.strictEqual(msgs.length, 1);
			assert.strictEqual(msgs[0].isLive, false);
		});

		it('should mark a message with activeByte 0xE1 as isLive = true', function () {
			var buf = buildMsgBuffer({ activeByte: 0xE1 }, 'Live body\n');
			var msgs = parseMessagesDAT(buf);
			assert.strictEqual(msgs[0].isLive, true);
		});
	});

	describe('body line terminator handling', function () {
		it('should replace 0xE3 bytes in body with CR characters', function () {
			var buf = buildMsgBuffer({}, 'Line1\nLine2\n');
			var msgs = parseMessagesDAT(buf);
			// The buildMsgBuffer helper encodes \n as 0xE3; parseMessagesDAT decodes them to \r
			assert.ok(msgs[0].rawBody.includes('\r'), 'Expected CR in rawBody');
		});
	});

	describe('kludge line parsing', function () {
		it('should extract @MSGID kludge from body', function () {
			// Body starting with a @MSGID kludge line
			var body = '@MSGID: <abc123@1:123/456>\rHello, this is the body.\r';
			// Build a raw buffer manually with the body already having 0xE3 replaced as \r
			// Use the fact that our helper replaces \n → 0xE3 and parser replaces 0xE3 → \r
			// So we use \n in bodyText for the helper and the parser handles it
			var bodyForHelper = '@MSGID: <abc123@1:123/456>\nHello, this is the body.\n';
			var buf = buildMsgBuffer({}, bodyForHelper);
			var msgs = parseMessagesDAT(buf);
			assert.ok(msgs[0].kludges.MSGID, 'Expected MSGID kludge');
			assert.ok(msgs[0].kludges.MSGID.includes('abc123'), 'MSGID value wrong');
		});

		it('should strip kludge lines from bodyText', function () {
			var bodyForHelper = '@MSGID: <abc123@1:123/456>\nClean body text.\n';
			var buf = buildMsgBuffer({}, bodyForHelper);
			var msgs = parseMessagesDAT(buf);
			assert.ok(!msgs[0].bodyText.includes('@MSGID'), 'kludge should be stripped from bodyText');
			assert.ok(msgs[0].bodyText.includes('Clean body text'), 'bodyText should contain clean body');
		});

		it('should extract origin line from body', function () {
			var bodyForHelper = 'Hello world.\n * Origin: Test BBS (1:123/456)\n';
			var buf = buildMsgBuffer({}, bodyForHelper);
			var msgs = parseMessagesDAT(buf);
			assert.ok(msgs[0].originLine.includes('Test BBS'), 'originLine not parsed');
		});
	});

	describe('msgOffset tracking', function () {
		it('should set msgOffset to 128 for the first message (after the header block)', function () {
			var buf = buildMsgBuffer({}, 'Body text\n');
			var msgs = parseMessagesDAT(buf);
			assert.strictEqual(msgs[0].msgOffset, 128);
		});
	});
});

// ---------------------------------------------------------------------------
// parseHeadersDat
// ---------------------------------------------------------------------------

describe('parseHeadersDat', function () {

	var SAMPLE_HEADERS = [
		'[80]',
		'Utf8 = true',
		'Message-ID: <test123@bbs>',
		'Reply-ID: <parent456@bbs>',
		'Sender: Full Sender Name',
		'To: Full Recipient Name',
		'Subject: Full Subject Line That Is Longer Than 25 Characters',
		'Conference: 5',
		'X-FTN-PID: Canectic QWK Tosser',
		'WhenWritten:  20250321143000+0000  0000',
		'',
		'[100]',
		'Utf8 = false',
		'Sender: Another Sender',
		''
	].join('\n');

	describe('section parsing', function () {
		it('should parse a hex offset section header', function () {
			var r = parseHeadersDat(SAMPLE_HEADERS);
			assert.ok(r[0x80] !== undefined, 'Expected section at offset 0x80 (128)');
		});

		it('should parse multiple sections', function () {
			var r = parseHeadersDat(SAMPLE_HEADERS);
			assert.ok(r[0x80] !== undefined);
			assert.ok(r[0x100] !== undefined);
		});
	});

	describe('field parsing within sections', function () {
		var r;
		before(function () {
			r = parseHeadersDat(SAMPLE_HEADERS);
		});

		it('should parse Utf8 field with = separator', function () {
			assert.strictEqual(r[0x80]['Utf8'], 'true');
		});

		it('should parse Message-ID with : separator', function () {
			assert.strictEqual(r[0x80]['Message-ID'], '<test123@bbs>');
		});

		it('should parse Reply-ID', function () {
			assert.strictEqual(r[0x80]['Reply-ID'], '<parent456@bbs>');
		});

		it('should parse Sender', function () {
			assert.strictEqual(r[0x80]['Sender'], 'Full Sender Name');
		});

		it('should parse To', function () {
			assert.strictEqual(r[0x80]['To'], 'Full Recipient Name');
		});

		it('should parse full-length Subject', function () {
			assert.strictEqual(r[0x80]['Subject'], 'Full Subject Line That Is Longer Than 25 Characters');
		});

		it('should parse Conference', function () {
			assert.strictEqual(r[0x80]['Conference'], '5');
		});

		it('should parse WhenWritten', function () {
			assert.ok(r[0x80]['WhenWritten'].includes('20250321'));
		});

		it('should parse the second section independently', function () {
			assert.strictEqual(r[0x100]['Sender'], 'Another Sender');
			assert.strictEqual(r[0x100]['Utf8'], 'false');
		});
	});

	describe('empty and null input', function () {
		it('should return empty object for null', function () {
			var r = parseHeadersDat(null);
			assert.deepStrictEqual(r, {});
		});

		it('should return empty object for empty string', function () {
			var r = parseHeadersDat('');
			assert.deepStrictEqual(r, {});
		});
	});
});

// ---------------------------------------------------------------------------
// applyHeadersDat
// ---------------------------------------------------------------------------

describe('applyHeadersDat', function () {

	it('should overlay Sender onto msg.from', function () {
		var msgs = [{ msgOffset: 128, from: 'Short Name', to: 'All', subject: 'Hi',
			kludges: {}, conferenceNum: 1 }];
		var headers = { 128: { Sender: 'Long Full Sender Name' } };
		applyHeadersDat(msgs, headers);
		assert.strictEqual(msgs[0].from, 'Long Full Sender Name');
	});

	it('should overlay To onto msg.to', function () {
		var msgs = [{ msgOffset: 128, from: 'Me', to: 'Short', subject: 'Hi',
			kludges: {}, conferenceNum: 1 }];
		var headers = { 128: { To: 'Full Recipient With Long Name' } };
		applyHeadersDat(msgs, headers);
		assert.strictEqual(msgs[0].to, 'Full Recipient With Long Name');
	});

	it('should overlay Subject onto msg.subject', function () {
		var msgs = [{ msgOffset: 128, from: 'Me', to: 'All', subject: 'Short subj',
			kludges: {}, conferenceNum: 1 }];
		var headers = { 128: { Subject: 'This Is A Very Long Subject Line' } };
		applyHeadersDat(msgs, headers);
		assert.strictEqual(msgs[0].subject, 'This Is A Very Long Subject Line');
	});

	it('should overlay Conference number', function () {
		var msgs = [{ msgOffset: 128, from: 'Me', to: 'All', subject: 'Hi',
			kludges: {}, conferenceNum: 1 }];
		var headers = { 128: { Conference: '42' } };
		applyHeadersDat(msgs, headers);
		assert.strictEqual(msgs[0].conferenceNum, 42);
	});

	it('should inject Message-ID into kludges.MSGID', function () {
		var msgs = [{ msgOffset: 128, from: 'Me', to: 'All', subject: 'Hi',
			kludges: {}, conferenceNum: 1 }];
		var headers = { 128: { 'Message-ID': '<abc123@bbs>' } };
		applyHeadersDat(msgs, headers);
		assert.strictEqual(msgs[0].kludges.MSGID, '<abc123@bbs>');
	});

	it('should inject Reply-ID into kludges.REPLY', function () {
		var msgs = [{ msgOffset: 128, from: 'Me', to: 'All', subject: 'Hi',
			kludges: {}, conferenceNum: 1 }];
		var headers = { 128: { 'Reply-ID': '<parent@bbs>' } };
		applyHeadersDat(msgs, headers);
		assert.strictEqual(msgs[0].kludges.REPLY, '<parent@bbs>');
	});

	it('should handle Utf8 = true by copying bodyText to utf8', function () {
		var msgs = [{ msgOffset: 128, from: 'Me', to: 'All', subject: 'Hi',
			kludges: {}, conferenceNum: 1, bodyText: 'already utf8 content', utf8: null }];
		var headers = { 128: { Utf8: 'true' } };
		applyHeadersDat(msgs, headers);
		assert.strictEqual(msgs[0].utf8, 'already utf8 content');
	});

	it('should parse WhenWritten and update date/time fields', function () {
		var msgs = [{ msgOffset: 128, from: 'Me', to: 'All', subject: 'Hi',
			kludges: {}, conferenceNum: 1, date: '01-01-00', time: '00:00' }];
		var headers = { 128: { WhenWritten: '20250321143000+0000  0000' } };
		applyHeadersDat(msgs, headers);
		assert.strictEqual(msgs[0].date, '03-21-25');
		assert.strictEqual(msgs[0].time, '14:30');
	});

	it('should not modify messages with no matching header entry', function () {
		var msgs = [{ msgOffset: 128, from: 'Me', to: 'All', subject: 'Orig',
			kludges: {}, conferenceNum: 1 }];
		var headers = { 256: { Sender: 'Someone' } }; // offset 256, not 128
		applyHeadersDat(msgs, headers);
		assert.strictEqual(msgs[0].from, 'Me');
		assert.strictEqual(msgs[0].subject, 'Orig');
	});

	it('should do nothing with empty headers object', function () {
		var msgs = [{ msgOffset: 128, from: 'Me', to: 'All', subject: 'Hi',
			kludges: {}, conferenceNum: 1 }];
		applyHeadersDat(msgs, {});
		assert.strictEqual(msgs[0].from, 'Me');
	});

	it('should do nothing with null headers', function () {
		var msgs = [{ msgOffset: 128, from: 'Me', to: 'All', subject: 'Hi',
			kludges: {}, conferenceNum: 1 }];
		applyHeadersDat(msgs, null);
		assert.strictEqual(msgs[0].from, 'Me');
	});
});

// ---------------------------------------------------------------------------
// buildQwkHeader
// ---------------------------------------------------------------------------

describe('buildQwkHeader', function () {

	var BASE_MSG = {
		system_time: new Date('2025-03-21T14:30:00Z').getTime(),
		to_user: 'Target User',
		from_user: 'Sender Name',
		subject: 'Test Subject',
		reply_ref: 0
	};

	it('should return a Buffer of exactly 128 bytes', function () {
		var buf = buildQwkHeader(BASE_MSG, 5, 128, false);
		assert.strictEqual(buf.length, 128);
	});

	it('should set status byte 0x20 (space) for public message', function () {
		var buf = buildQwkHeader(BASE_MSG, 5, 128, false);
		assert.strictEqual(buf[0], 0x20);
	});

	it('should set status byte 0x2A (*) for private message', function () {
		var buf = buildQwkHeader(BASE_MSG, 5, 128, true);
		assert.strictEqual(buf[0], 0x2A);
	});

	it('should write conference number at offset 123 as LE uint16', function () {
		var buf = buildQwkHeader(BASE_MSG, 42, 128, false);
		assert.strictEqual(buf.readUInt16LE(123), 42);
	});

	it('should write active flag 0xE1 at offset 122', function () {
		var buf = buildQwkHeader(BASE_MSG, 5, 128, false);
		assert.strictEqual(buf[122], 0xE1);
	});

	it('should write byte 0x2A at offset 127', function () {
		var buf = buildQwkHeader(BASE_MSG, 5, 128, false);
		assert.strictEqual(buf[127], 0x2A);
	});

	it('should write To field at offset 21 (25 chars, space-padded)', function () {
		var buf = buildQwkHeader(BASE_MSG, 5, 128, false);
		var to = buf.subarray(21, 46).toString('ascii').trimEnd();
		assert.strictEqual(to, 'Target User');
	});

	it('should write From field at offset 46 (25 chars, space-padded)', function () {
		var buf = buildQwkHeader(BASE_MSG, 5, 128, false);
		var from = buf.subarray(46, 71).toString('ascii').trimEnd();
		assert.strictEqual(from, 'Sender Name');
	});

	it('should write Subject at offset 71 (25 chars, space-padded)', function () {
		var buf = buildQwkHeader(BASE_MSG, 5, 128, false);
		var subj = buf.subarray(71, 96).toString('ascii').trimEnd();
		assert.strictEqual(subj, 'Test Subject');
	});

	it('should truncate To to 25 chars', function () {
		var longMsg = Object.assign({}, BASE_MSG, { to_user: 'A'.repeat(40) });
		var buf = buildQwkHeader(longMsg, 1, 128, false);
		var to = buf.subarray(21, 46).toString('ascii');
		assert.strictEqual(to.length, 25);
	});

	it('should calculate correct block count in blocks field', function () {
		// 1 header block + ceil(128/128) = 1 body block = 2 total
		var buf = buildQwkHeader(BASE_MSG, 1, 128, false);
		var blocks = parseInt(buf.subarray(116, 122).toString('ascii').trim(), 10);
		assert.strictEqual(blocks, 2);
	});

	it('should round up body blocks for non-128-byte bodies', function () {
		// bodyLength = 129 → ceil(129/128) = 2 body blocks + 1 header = 3 total
		var buf = buildQwkHeader(BASE_MSG, 1, 129, false);
		var blocks = parseInt(buf.subarray(116, 122).toString('ascii').trim(), 10);
		assert.strictEqual(blocks, 3);
	});

	it('should write date in MM-DD-YY format at offset 8', function () {
		var buf = buildQwkHeader(BASE_MSG, 1, 128, false);
		var date = buf.subarray(8, 16).toString('ascii');
		assert.match(date, /^\d{2}-\d{2}-\d{2}$/);
	});

	it('should write time in HH:MM format at offset 16', function () {
		var buf = buildQwkHeader(BASE_MSG, 1, 128, false);
		var time = buf.subarray(16, 21).toString('ascii');
		assert.match(time, /^\d{2}:\d{2}$/);
	});
});

// ---------------------------------------------------------------------------
// buildQwkBody
// ---------------------------------------------------------------------------

describe('buildQwkBody', function () {

	it('should return a Buffer', function () {
		var buf = buildQwkBody('Hello');
		assert.ok(Buffer.isBuffer(buf));
	});

	it('should return length padded to a 128-byte boundary', function () {
		var buf = buildQwkBody('Hello');
		assert.strictEqual(buf.length % 128, 0);
	});

	it('should convert \\r to 0xE3 (QWK line terminator)', function () {
		var buf = buildQwkBody('Line1\rLine2');
		var found = false;
		for (var i = 0; i < buf.length; i++) {
			if (buf[i] === 0xE3) { found = true; break; }
		}
		assert.ok(found, 'Expected 0xE3 byte in output');
	});

	it('should convert \\n to 0xE3', function () {
		var buf = buildQwkBody('Line1\nLine2');
		var found = false;
		for (var i = 0; i < buf.length; i++) {
			if (buf[i] === 0xE3) { found = true; break; }
		}
		assert.ok(found, 'Expected 0xE3 byte in output from \\n conversion');
	});

	it('should convert \\r\\n to a single 0xE3 (not two)', function () {
		// \r\n → \r → 0xE3 (the \r\n is first collapsed to \r, then \r → 0xE3)
		var buf = buildQwkBody('Line1\r\nLine2');
		var e3Count = 0;
		for (var i = 0; i < buf.length; i++) {
			if (buf[i] === 0xE3) e3Count++;
		}
		assert.strictEqual(e3Count, 1);
	});

	it('should pad output to a multiple of 128 with spaces', function () {
		var buf = buildQwkBody('Short');
		assert.strictEqual(buf.length, 128);
		// Trailing bytes should be 0x20 (space)
		assert.strictEqual(buf[buf.length - 1], 0x20);
	});

	it('should produce exactly 128 bytes for text fitting in one block', function () {
		var buf = buildQwkBody('X');
		assert.strictEqual(buf.length, 128);
	});

	it('should produce exactly 256 bytes when text spans two blocks', function () {
		// Create exactly 129 bytes of content (forces a second block)
		var longText = 'A'.repeat(129);
		var buf = buildQwkBody(longText);
		assert.strictEqual(buf.length, 256);
	});

	it('should handle empty string without throwing', function () {
		var buf = buildQwkBody('');
		assert.ok(Buffer.isBuffer(buf));
		// Empty body — result may be 0 bytes or 1 padded block
		assert.strictEqual(buf.length % 128, 0);
	});

	it('should handle null/undefined without throwing', function () {
		var buf = buildQwkBody(null);
		assert.ok(Buffer.isBuffer(buf));
	});
});

// ---------------------------------------------------------------------------
// Packing a body that is not ASCII
// ---------------------------------------------------------------------------
//
// The packer used to decide how to read a stored body from which database
// column was populated: "utf8 is set, therefore body_text holds raw CP437".
// True of a message that arrived over QWK, false of one that arrived over FTN,
// where both columns hold the same Unicode text. So relaying an FTN message
// into a QWK packet ran Unicode through Buffer.from(x, 'binary'), which keeps
// the LOW BYTE of each character, and `Γöî` went out as `ô÷ε`.
//
// Since migration 0006 body_text is canonical Unicode for every source, so the
// packer converts unconditionally. These cover the path that was wrong; the
// ASCII cases above never exercised it, because ASCII survives either way.

describe('buildQwkBody with non-ASCII content', function () {

	var BLOCK = '█';      // U+2588, CP437 0xDB
	var ACCENT = 'é';     // é, CP437 0x82

	// What the packers do now: canonical text in, CP437 bytes out.
	function packAndRead(text) {
		var bytes = utf8ToCp437(text, true);
		var asChars = '';
		for (var i = 0; i < bytes.length; i++) asChars += String.fromCharCode(bytes[i]);
		var buf = buildQwkBody(asChars);
		return cp437ToUtf8(buf).replace(/\s+$/, '');   // trim the 128-byte padding
	}

	it('round-trips block art', function () {
		assert.strictEqual(packAndRead(BLOCK + BLOCK), BLOCK + BLOCK);
	});

	it('round-trips accented latin', function () {
		assert.strictEqual(packAndRead('caf' + ACCENT), 'caf' + ACCENT);
	});

	it('shows what the old path did to the same input', function () {
		// Reading canonical text as though it were raw bytes: the low byte of
		// U+2588 is 0x88, which is not a block in CP437.
		var wrong = cp437ToUtf8(Buffer.from(BLOCK + BLOCK, 'binary'));
		assert.notStrictEqual(wrong, BLOCK + BLOCK);
	});

	it('substitutes rather than corrupting when CP437 cannot hold a character', function () {
		// QWK is a CP437 format; there is nowhere for Cyrillic to go. A
		// visible '?' is the honest outcome.
		assert.strictEqual(packAndRead('При'), '???');
	});

	it('still pads to the 128-byte record boundary', function () {
		var bytes = utf8ToCp437(BLOCK, true);
		var asChars = String.fromCharCode(bytes[0]);
		assert.strictEqual(buildQwkBody(asChars).length % 128, 0);
	});
});
