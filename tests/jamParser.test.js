// tests/jamParser.test.js — Unit tests for jamParser.js
//
// Builds synthetic .jhr/.jdt/.jdx buffers rather than shipping binary fixtures,
// so the expected byte layout is visible in the test itself. No DB, no network.
// Struct offsets follow the JAM(mbp) spec as published in JAM.H.
// Run: npx mocha tests/jamParser.test.js

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as url from 'url';
import {
	iterateJAM,
	parseJAM,
	previewJAM,
	parseHeaderInfo,
	parseMsgHeader,
	parseSubfields,
	extractMessageText,
	parseIndex,
	hasAttr,
	SUBFIELD,
	MSG_ATTR,
	HDRINFO_SIZE,
	MSGHDR_FIXED_SIZE,
} from '../src/utils/jamParser.js';

var __dirname = path.dirname(url.fileURLToPath(import.meta.url));
var TMP_DIR = path.join(__dirname, 'tmp');

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function buildHeaderInfo(opts) {
	var o = opts || {};
	var buf = Buffer.alloc(HDRINFO_SIZE);
	buf.write('JAM\x00', 0, 'latin1');
	buf.writeUInt32LE(o.dateCreated || 0, 4);
	buf.writeUInt32LE(o.modCounter || 0, 8);
	buf.writeUInt32LE(o.activeMsgs || 0, 12);
	buf.writeUInt32LE(o.passwordCRC || 0, 16);
	buf.writeUInt32LE(o.baseMsgNum || 0, 20);
	return buf;
}

function buildSubfield(loID, hiID, data) {
	var d = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
	var buf = Buffer.alloc(8 + d.length);
	buf.writeUInt16LE(loID, 0);
	buf.writeUInt16LE(hiID || 0, 2);
	buf.writeUInt32LE(d.length, 4);
	d.copy(buf, 8);
	return buf;
}

function buildMsgHeader(opts) {
	var o = opts || {};
	var parts = (o.subfields || []).map(function (s) {
		return buildSubfield(s.loID, s.hiID || 0, s.data);
	});
	var sfBuf = parts.length ? Buffer.concat(parts) : Buffer.alloc(0);
	var sfLen = o.subfieldLenOverride !== undefined ? o.subfieldLenOverride : sfBuf.length;

	var buf = Buffer.alloc(MSGHDR_FIXED_SIZE);
	buf.write('JAM\x00', 0, 'latin1');
	buf.writeUInt16LE(o.revision !== undefined ? o.revision : 1, 4);
	buf.writeUInt16LE(0, 6);
	buf.writeUInt32LE(sfLen >>> 0, 8);
	buf.writeUInt32LE(o.timesRead || 0, 12);
	buf.writeUInt32LE(o.msgIdCRC || 0, 16);
	buf.writeUInt32LE(o.replyCRC || 0, 20);
	buf.writeUInt32LE(o.replyTo || 0, 24);
	buf.writeUInt32LE(o.reply1st || 0, 28);
	buf.writeUInt32LE(o.replyNext || 0, 32);
	buf.writeUInt32LE(o.dateWritten || 0, 36);
	buf.writeUInt32LE(o.dateReceived || 0, 40);
	buf.writeUInt32LE(o.dateProcessed || 0, 44);
	buf.writeUInt32LE(o.number || 0, 48);
	buf.writeUInt32LE((o.attribute || 0) >>> 0, 52);
	buf.writeUInt32LE(o.attribute2 || 0, 56);
	buf.writeUInt32LE(o.txtOffset || 0, 60);
	buf.writeUInt32LE(o.txtLen || 0, 64);
	buf.writeUInt32LE(o.passwordCRC || 0, 68);
	buf.writeUInt32LE(o.cost || 0, 72);

	return Buffer.concat([buf, sfBuf]);
}

function buildIndexRecord(userCRC, hdrOffset) {
	var buf = Buffer.alloc(8);
	buf.writeUInt32LE(userCRC >>> 0, 0);
	buf.writeUInt32LE(hdrOffset >>> 0, 4);
	return buf;
}

function buildJdt(totalBytes, placements) {
	var buf = Buffer.alloc(totalBytes, 0);
	for (var i = 0; i < placements.length; i++) {
		var src = Buffer.isBuffer(placements[i].text)
			? placements[i].text
			: Buffer.from(placements[i].text, 'latin1');
		src.copy(buf, placements[i].at);
	}
	return buf;
}

// A complete single-message base with text at the start of the .jdt.
function buildSimpleBase(opts) {
	var o = opts || {};
	var text = o.text !== undefined ? o.text : 'Hello from a JAM base.\r--- tossed\r * Origin: Test (1:2/3)\r';

	var hdr = buildMsgHeader({
		attribute: o.attribute || MSG_ATTR.TYPEECHO,
		number: o.number !== undefined ? o.number : 1,
		dateWritten: o.dateWritten || 1700000000,
		txtOffset: 0,
		txtLen: Buffer.byteLength(text, 'latin1'),
		subfields: o.subfields || [
			{ loID: SUBFIELD.SENDERNAME, data: 'Alice' },
			{ loID: SUBFIELD.RECVRNAME, data: 'Bob' },
			{ loID: SUBFIELD.SUBJECT, data: 'Test subject' },
		],
	});

	return {
		jhr: Buffer.concat([buildHeaderInfo({ activeMsgs: 1, baseMsgNum: 1 }), hdr]),
		jdt: buildJdt(512, [{ at: 0, text: text }]),
		hdrLen: hdr.length,
		text: text,
	};
}

// ---------------------------------------------------------------------------
// Temp file helpers
// ---------------------------------------------------------------------------

var writtenFiles = [];

function ensureTmpDir() {
	if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
}

function writeTmp(name, buf) {
	ensureTmpDir();
	var p = path.join(TMP_DIR, name);
	fs.writeFileSync(p, buf);
	writtenFiles.push(p);
	return p;
}

function cleanupTmp() {
	for (var i = 0; i < writtenFiles.length; i++) {
		try { fs.unlinkSync(writtenFiles[i]); } catch (e) { /* already gone */ }
	}
	writtenFiles = [];
}

// ---------------------------------------------------------------------------
// hasAttr
// ---------------------------------------------------------------------------

describe('jamParser hasAttr', function () {

	it('should detect MSG_DELETED even though it is the sign bit', function () {
		assert.strictEqual(hasAttr(0x80000000, MSG_ATTR.DELETED), true);
	});

	it('should not report deleted for an unrelated attribute', function () {
		assert.strictEqual(hasAttr(MSG_ATTR.LOCAL, MSG_ATTR.DELETED), false);
	});

	it('should detect deleted when every bit is set', function () {
		assert.strictEqual(hasAttr(0xFFFFFFFF, MSG_ATTR.DELETED), true);
	});

	it('should return false for a zero attribute word', function () {
		assert.strictEqual(hasAttr(0, MSG_ATTR.DELETED), false);
		assert.strictEqual(hasAttr(0, MSG_ATTR.LOCAL), false);
	});

	it('should detect low-order flags', function () {
		var attr = MSG_ATTR.LOCAL | MSG_ATTR.TYPEECHO;
		assert.strictEqual(hasAttr(attr, MSG_ATTR.LOCAL), true);
		assert.strictEqual(hasAttr(attr, MSG_ATTR.TYPEECHO), true);
		assert.strictEqual(hasAttr(attr, MSG_ATTR.PRIVATE), false);
	});

	it('should detect LOCKED and NODISP', function () {
		assert.strictEqual(hasAttr(MSG_ATTR.LOCKED, MSG_ATTR.LOCKED), true);
		assert.strictEqual(hasAttr(MSG_ATTR.NODISP, MSG_ATTR.NODISP), true);
	});
});

// ---------------------------------------------------------------------------
// parseHeaderInfo
// ---------------------------------------------------------------------------

describe('parseHeaderInfo', function () {

	it('should return null for a buffer shorter than the info block', function () {
		assert.strictEqual(parseHeaderInfo(Buffer.alloc(HDRINFO_SIZE - 1)), null);
	});

	it('should return null when the JAM signature is wrong', function () {
		var buf = buildHeaderInfo({});
		buf.write('XXXX', 0, 'latin1');
		assert.strictEqual(parseHeaderInfo(buf), null);
	});

	it('should reject a signature missing its trailing null', function () {
		var buf = buildHeaderInfo({});
		buf.write('JAMX', 0, 'latin1');
		assert.strictEqual(parseHeaderInfo(buf), null);
	});

	it('should parse the fixed info fields', function () {
		var buf = buildHeaderInfo({
			dateCreated: 1600000000,
			modCounter: 12,
			activeMsgs: 345,
			passwordCRC: 0xFFFFFFFF,
			baseMsgNum: 1,
		});
		var info = parseHeaderInfo(buf);
		assert.strictEqual(info.dateCreated, 1600000000);
		assert.strictEqual(info.modCounter, 12);
		assert.strictEqual(info.activeMsgs, 345);
		assert.strictEqual(info.passwordCRC, 0xFFFFFFFF);
		assert.strictEqual(info.baseMsgNum, 1);
	});

	it('should accept an info block that is exactly 1024 bytes', function () {
		var info = parseHeaderInfo(buildHeaderInfo({ activeMsgs: 7 }));
		assert.ok(info);
		assert.strictEqual(info.activeMsgs, 7);
	});
});

// ---------------------------------------------------------------------------
// parseSubfields
// ---------------------------------------------------------------------------

describe('parseSubfields', function () {

	it('should parse a sequence of subfields', function () {
		var buf = Buffer.concat([
			buildSubfield(SUBFIELD.SENDERNAME, 0, 'Alice'),
			buildSubfield(SUBFIELD.SUBJECT, 0, 'Hello'),
		]);
		var fields = parseSubfields(buf, 0, buf.length);
		assert.strictEqual(fields.length, 2);
		assert.strictEqual(fields[0].loID, SUBFIELD.SENDERNAME);
		assert.strictEqual(fields[0].data, 'Alice');
		assert.strictEqual(fields[1].loID, SUBFIELD.SUBJECT);
		assert.strictEqual(fields[1].data, 'Hello');
	});

	it('should return an empty list for a zero-length block', function () {
		assert.deepStrictEqual(parseSubfields(Buffer.alloc(64), 0, 0), []);
	});

	it('should preserve the HiID', function () {
		var buf = buildSubfield(5, 7, 'x');
		var fields = parseSubfields(buf, 0, buf.length);
		assert.strictEqual(fields[0].hiID, 7);
	});

	it('should handle a zero-length subfield payload', function () {
		var buf = Buffer.concat([
			buildSubfield(SUBFIELD.SUBJECT, 0, ''),
			buildSubfield(SUBFIELD.SENDERNAME, 0, 'Bob'),
		]);
		var fields = parseSubfields(buf, 0, buf.length);
		assert.strictEqual(fields.length, 2);
		assert.strictEqual(fields[0].data, '');
		assert.strictEqual(fields[1].data, 'Bob');
	});

	it('should stop when a declared length runs past the block', function () {
		var good = buildSubfield(SUBFIELD.SENDERNAME, 0, 'Alice');
		var bad = Buffer.alloc(8);
		bad.writeUInt16LE(SUBFIELD.SUBJECT, 0);
		bad.writeUInt16LE(0, 2);
		bad.writeUInt32LE(9999, 4); // claims far more data than exists
		var buf = Buffer.concat([good, bad]);

		var fields = parseSubfields(buf, 0, buf.length);
		assert.strictEqual(fields.length, 1);
		assert.strictEqual(fields[0].data, 'Alice');
	});

	it('should not read past the declared block length', function () {
		var first = buildSubfield(SUBFIELD.SENDERNAME, 0, 'Alice');
		var second = buildSubfield(SUBFIELD.SUBJECT, 0, 'Not included');
		var buf = Buffer.concat([first, second]);

		// Declare only the first subfield
		var fields = parseSubfields(buf, 0, first.length);
		assert.strictEqual(fields.length, 1);
		assert.strictEqual(fields[0].data, 'Alice');
	});

	it('should clamp the block length to the buffer size', function () {
		var buf = buildSubfield(SUBFIELD.SENDERNAME, 0, 'Alice');
		var fields = parseSubfields(buf, 0, 100000);
		assert.strictEqual(fields.length, 1);
		assert.strictEqual(fields[0].data, 'Alice');
	});

	it('should parse subfields starting at a non-zero offset', function () {
		var pad = Buffer.alloc(16, 0xAA);
		var sf = buildSubfield(SUBFIELD.SUBJECT, 0, 'Offset');
		var buf = Buffer.concat([pad, sf]);
		var fields = parseSubfields(buf, 16, sf.length);
		assert.strictEqual(fields.length, 1);
		assert.strictEqual(fields[0].data, 'Offset');
	});
});

// ---------------------------------------------------------------------------
// parseMsgHeader
// ---------------------------------------------------------------------------

describe('jamParser parseMsgHeader', function () {

	it('should return null when the fixed header would overrun the buffer', function () {
		var buf = buildMsgHeader({});
		assert.strictEqual(parseMsgHeader(buf.subarray(0, MSGHDR_FIXED_SIZE - 1), 0), null);
	});

	it('should return null for a negative offset', function () {
		assert.strictEqual(parseMsgHeader(buildMsgHeader({}), -4), null);
	});

	it('should return null when the message signature is wrong', function () {
		var buf = buildMsgHeader({});
		buf.write('XXXX', 0, 'latin1');
		assert.strictEqual(parseMsgHeader(buf, 0), null);
	});

	it('should parse the fixed numeric fields', function () {
		var buf = buildMsgHeader({
			revision: 1,
			timesRead: 5,
			msgIdCRC: 0x11223344,
			replyCRC: 0x55667788,
			replyTo: 3,
			reply1st: 4,
			replyNext: 5,
			dateWritten: 1700000000,
			dateReceived: 1700000100,
			dateProcessed: 1700000200,
			number: 4321,
			attribute: MSG_ATTR.TYPEECHO,
			txtOffset: 1024,
			txtLen: 256,
			cost: 0,
		});
		var hdr = parseMsgHeader(buf, 0);
		assert.strictEqual(hdr.revision, 1);
		assert.strictEqual(hdr.timesRead, 5);
		assert.strictEqual(hdr.msgIdCRC, 0x11223344);
		assert.strictEqual(hdr.replyCRC, 0x55667788);
		assert.strictEqual(hdr.replyTo, 3);
		assert.strictEqual(hdr.reply1st, 4);
		assert.strictEqual(hdr.replyNext, 5);
		assert.strictEqual(hdr.dateWritten, 1700000000);
		assert.strictEqual(hdr.dateReceived, 1700000100);
		assert.strictEqual(hdr.dateProcessed, 1700000200);
		assert.strictEqual(hdr.number, 4321);
		assert.strictEqual(hdr.attribute, MSG_ATTR.TYPEECHO);
		assert.strictEqual(hdr.txtOffset, 1024);
		assert.strictEqual(hdr.txtLen, 256);
	});

	it('should read MSG_DELETED back as an unsigned attribute word', function () {
		var buf = buildMsgHeader({ attribute: MSG_ATTR.DELETED });
		var hdr = parseMsgHeader(buf, 0);
		assert.strictEqual(hdr.attribute, 0x80000000);
		assert.strictEqual(hasAttr(hdr.attribute, MSG_ATTR.DELETED), true);
	});

	it('should extract known subfields into named properties', function () {
		var buf = buildMsgHeader({
			subfields: [
				{ loID: SUBFIELD.SENDERNAME, data: 'Alice' },
				{ loID: SUBFIELD.RECVRNAME, data: 'Bob' },
				{ loID: SUBFIELD.OADDRESS, data: '1:2/3' },
				{ loID: SUBFIELD.DADDRESS, data: '1:2/4' },
				{ loID: SUBFIELD.SUBJECT, data: 'Hello there' },
				{ loID: SUBFIELD.MSGID, data: '1:2/3 5f2a1b3c' },
				{ loID: SUBFIELD.REPLYID, data: '1:2/4 aabbccdd' },
				{ loID: SUBFIELD.PID, data: 'Mystic/1.12' },
				{ loID: SUBFIELD.TZUTCINFO, data: '-0500' },
				{ loID: SUBFIELD.FLAGS, data: 'NPD' },
			],
		});
		var hdr = parseMsgHeader(buf, 0);
		assert.strictEqual(hdr.sender, 'Alice');
		assert.strictEqual(hdr.recipient, 'Bob');
		assert.strictEqual(hdr.senderAddr, '1:2/3');
		assert.strictEqual(hdr.recipientAddr, '1:2/4');
		assert.strictEqual(hdr.subject, 'Hello there');
		assert.strictEqual(hdr.msgId, '1:2/3 5f2a1b3c');
		assert.strictEqual(hdr.replyId, '1:2/4 aabbccdd');
		assert.strictEqual(hdr.pid, 'Mystic/1.12');
		assert.strictEqual(hdr.tzUtc, '-0500');
		assert.strictEqual(hdr.flags, 'NPD');
	});

	it('should join repeated SEEN-BY subfields with CRLF', function () {
		var buf = buildMsgHeader({
			subfields: [
				{ loID: SUBFIELD.SEENBY2D, data: '1/2 3 4' },
				{ loID: SUBFIELD.SEENBY2D, data: '5/6 7' },
			],
		});
		var hdr = parseMsgHeader(buf, 0);
		assert.strictEqual(hdr.seenBy, '1/2 3 4\r\n5/6 7');
	});

	it('should join repeated PATH subfields with CRLF', function () {
		var buf = buildMsgHeader({
			subfields: [
				{ loID: SUBFIELD.PATH2D, data: '1/2' },
				{ loID: SUBFIELD.PATH2D, data: '3/4' },
			],
		});
		var hdr = parseMsgHeader(buf, 0);
		assert.strictEqual(hdr.path, '1/2\r\n3/4');
	});

	it('should collect FTS kludge subfields into an array', function () {
		var buf = buildMsgHeader({
			subfields: [
				{ loID: SUBFIELD.FTSKLUDGE, data: 'CHRS: CP437 2' },
				{ loID: SUBFIELD.FTSKLUDGE, data: 'TZUTC: 0000' },
			],
		});
		var hdr = parseMsgHeader(buf, 0);
		assert.deepStrictEqual(hdr.kludges, ['CHRS: CP437 2', 'TZUTC: 0000']);
	});

	it('should ignore subfields with a non-zero HiID but keep them raw', function () {
		var buf = buildMsgHeader({
			subfields: [
				{ loID: SUBFIELD.SUBJECT, hiID: 1, data: 'Unknown ID space' },
			],
		});
		var hdr = parseMsgHeader(buf, 0);
		assert.strictEqual(hdr.subject, '');
		assert.strictEqual(hdr.subfields.length, 1);
		assert.strictEqual(hdr.subfields[0].data, 'Unknown ID space');
	});

	it('should keep unrecognised subfields in the raw list', function () {
		var buf = buildMsgHeader({
			subfields: [
				{ loID: SUBFIELD.TRACE, data: 'trace data' },
				{ loID: SUBFIELD.ENCLFILE, data: 'FILE.ZIP' },
			],
		});
		var hdr = parseMsgHeader(buf, 0);
		assert.strictEqual(hdr.subfields.length, 2);
		assert.strictEqual(hdr.subfields[1].loID, SUBFIELD.ENCLFILE);
		assert.strictEqual(hdr.subfields[1].data, 'FILE.ZIP');
	});

	it('should decode CP437 bytes in subfield data', function () {
		var buf = buildMsgHeader({
			subfields: [
				{ loID: SUBFIELD.SENDERNAME, data: Buffer.from([0x4A, 0xFC, 0x72, 0x67, 0x65, 0x6E]) },
			],
		});
		var hdr = parseMsgHeader(buf, 0);
		// 0xFC in CP437 is n with a caron, not the Latin-1 u with diaeresis
		assert.strictEqual(hdr.sender.length, 6);
		assert.notStrictEqual(hdr.sender.charCodeAt(1), 0xFC);
	});

	it('should parse a header that is not at offset zero', function () {
		var info = buildHeaderInfo({});
		var hdr = buildMsgHeader({ number: 99, subfields: [{ loID: SUBFIELD.SUBJECT, data: 'Offset test' }] });
		var parsed = parseMsgHeader(Buffer.concat([info, hdr]), HDRINFO_SIZE);
		assert.strictEqual(parsed.number, 99);
		assert.strictEqual(parsed.subject, 'Offset test');
	});

	it('should report an empty subfield list when SubfieldLen is zero', function () {
		var hdr = parseMsgHeader(buildMsgHeader({ subfields: [] }), 0);
		assert.deepStrictEqual(hdr.subfields, []);
		assert.strictEqual(hdr.subfieldLen, 0);
		assert.strictEqual(hdr.subject, '');
	});
});

// ---------------------------------------------------------------------------
// extractMessageText
// ---------------------------------------------------------------------------

describe('jamParser extractMessageText', function () {

	it('should extract text at the declared offset and length', function () {
		var jdt = buildJdt(512, [{ at: 100, text: 'the message body' }]);
		var text = extractMessageText(jdt, { txtOffset: 100, txtLen: 16 });
		assert.strictEqual(text, 'the message body');
	});

	it('should return an empty string when TxtLen is zero', function () {
		var jdt = buildJdt(512, [{ at: 0, text: 'ignored' }]);
		assert.strictEqual(extractMessageText(jdt, { txtOffset: 0, txtLen: 0 }), '');
	});

	it('should return an empty string when the offset is past the buffer', function () {
		var jdt = buildJdt(64, []);
		assert.strictEqual(extractMessageText(jdt, { txtOffset: 500, txtLen: 10 }), '');
	});

	it('should clamp a length that runs past the end of the buffer', function () {
		var jdt = buildJdt(20, [{ at: 10, text: 'abcdefghij' }]);
		var text = extractMessageText(jdt, { txtOffset: 10, txtLen: 9999 });
		assert.strictEqual(text, 'abcdefghij');
	});

	it('should preserve bare CR line delimiters', function () {
		var raw = 'line one\rline two\rline three';
		var jdt = buildJdt(256, [{ at: 0, text: raw }]);
		var text = extractMessageText(jdt, { txtOffset: 0, txtLen: raw.length });
		assert.strictEqual(text, raw);
		assert.strictEqual(text.split('\r').length, 3);
	});

	it('should decode CP437 box drawing characters correctly', function () {
		var raw = Buffer.from([0xC9, 0xCD, 0xBB]);
		var jdt = buildJdt(64, [{ at: 0, text: raw }]);
		var text = extractMessageText(jdt, { txtOffset: 0, txtLen: 3 });
		assert.strictEqual(text, '╔═╗');
	});

	it('should not mangle high-bit bytes the way a UTF-8 read would', function () {
		var raw = Buffer.from([0xB1, 0xB2, 0xDB]);
		var jdt = buildJdt(64, [{ at: 0, text: raw }]);
		var text = extractMessageText(jdt, { txtOffset: 0, txtLen: 3 });
		assert.strictEqual(text.indexOf('�'), -1);
		assert.strictEqual(text.length, 3);
	});
});

// ---------------------------------------------------------------------------
// parseIndex
// ---------------------------------------------------------------------------

describe('jamParser parseIndex', function () {

	it('should parse 8-byte index records', function () {
		var buf = Buffer.concat([
			buildIndexRecord(0xAABBCCDD, 1024),
			buildIndexRecord(0x11223344, 2048),
		]);
		var records = parseIndex(buf);
		assert.strictEqual(records.length, 2);
		assert.strictEqual(records[0].userCRC, 0xAABBCCDD);
		assert.strictEqual(records[0].hdrOffset, 1024);
		assert.strictEqual(records[1].hdrOffset, 2048);
	});

	it('should ignore a trailing partial record', function () {
		var buf = Buffer.concat([buildIndexRecord(1, 1024), Buffer.alloc(5)]);
		assert.strictEqual(parseIndex(buf).length, 1);
	});

	it('should return an empty list for an empty buffer', function () {
		assert.deepStrictEqual(parseIndex(Buffer.alloc(0)), []);
	});
});

// ---------------------------------------------------------------------------
// parseJAM
// ---------------------------------------------------------------------------

describe('parseJAM', function () {

	afterEach(function () {
		cleanupTmp();
	});

	it('should report an error when the .jhr file is missing', function () {
		var base = buildSimpleBase({});
		var jdtPath = writeTmp('missing-jhr.jdt', base.jdt);
		var r = parseJAM(path.join(TMP_DIR, 'nope.jhr'), jdtPath, null);
		assert.strictEqual(r.status, false);
		assert.ok(/Header file not found/.test(r.error));
	});

	it('should report an error when the .jdt file is missing', function () {
		var base = buildSimpleBase({});
		var jhrPath = writeTmp('missing-jdt.jhr', base.jhr);
		var r = parseJAM(jhrPath, path.join(TMP_DIR, 'nope.jdt'), null);
		assert.strictEqual(r.status, false);
		assert.ok(/Text file not found/.test(r.error));
	});

	it('should report an error when the info block signature is invalid', function () {
		var base = buildSimpleBase({});
		base.jhr.write('NOPE', 0, 'latin1');
		var jhrPath = writeTmp('badsig.jhr', base.jhr);
		var jdtPath = writeTmp('badsig.jdt', base.jdt);
		var r = parseJAM(jhrPath, jdtPath, null);
		assert.strictEqual(r.status, false);
		assert.ok(/Invalid JAM header file/.test(r.error));
	});

	it('should parse a single message by sequential walk', function () {
		var base = buildSimpleBase({});
		var jhrPath = writeTmp('single.jhr', base.jhr);
		var jdtPath = writeTmp('single.jdt', base.jdt);

		var r = parseJAM(jhrPath, jdtPath, null);
		assert.strictEqual(r.status, true);
		assert.strictEqual(r.messages.length, 1);
		assert.strictEqual(r.messages[0].header.sender, 'Alice');
		assert.strictEqual(r.messages[0].header.subject, 'Test subject');
		assert.strictEqual(r.messages[0].bodyText, base.text);
	});

	it('should always leave tailText empty, matching the documented contract', function () {
		var base = buildSimpleBase({});
		var jhrPath = writeTmp('tail.jhr', base.jhr);
		var jdtPath = writeTmp('tail.jdt', base.jdt);

		var r = parseJAM(jhrPath, jdtPath, null);
		assert.strictEqual(r.messages[0].tailText, '');
	});

	it('should expose the parsed info block', function () {
		var base = buildSimpleBase({});
		var jhrPath = writeTmp('info.jhr', base.jhr);
		var jdtPath = writeTmp('info.jdt', base.jdt);

		var r = parseJAM(jhrPath, jdtPath, null);
		assert.ok(r.headerInfo);
		assert.strictEqual(r.headerInfo.activeMsgs, 1);
		assert.strictEqual(r.headerInfo.baseMsgNum, 1);
	});

	it('should skip messages flagged deleted during a sequential walk', function () {
		var base = buildSimpleBase({ attribute: MSG_ATTR.DELETED });
		var jhrPath = writeTmp('deleted.jhr', base.jhr);
		var jdtPath = writeTmp('deleted.jdt', base.jdt);

		var r = parseJAM(jhrPath, jdtPath, null);
		assert.strictEqual(r.status, true);
		assert.strictEqual(r.messages.length, 0);
	});

	it('should step correctly across headers with different subfield lengths', function () {
		var h1 = buildMsgHeader({
			number: 1, txtOffset: 0, txtLen: 5,
			subfields: [{ loID: SUBFIELD.SUBJECT, data: 'One' }],
		});
		var h2 = buildMsgHeader({
			number: 2, txtOffset: 5, txtLen: 5,
			subfields: [
				{ loID: SUBFIELD.SUBJECT, data: 'Two' },
				{ loID: SUBFIELD.SENDERNAME, data: 'A much longer sender name here' },
				{ loID: SUBFIELD.SEENBY2D, data: '1/2 3 4 5 6 7 8 9' },
			],
		});
		var h3 = buildMsgHeader({
			number: 3, txtOffset: 10, txtLen: 5,
			subfields: [{ loID: SUBFIELD.SUBJECT, data: 'Three' }],
		});

		var jhr = Buffer.concat([buildHeaderInfo({ activeMsgs: 3 }), h1, h2, h3]);
		var jhrPath = writeTmp('walk.jhr', jhr);
		var jdtPath = writeTmp('walk.jdt', buildJdt(64, [{ at: 0, text: 'aaaaabbbbbccccc' }]));

		var r = parseJAM(jhrPath, jdtPath, null);
		assert.strictEqual(r.messages.length, 3);
		assert.strictEqual(r.messages[0].header.subject, 'One');
		assert.strictEqual(r.messages[1].header.subject, 'Two');
		assert.strictEqual(r.messages[2].header.subject, 'Three');
		assert.strictEqual(r.messages[0].bodyText, 'aaaaa');
		assert.strictEqual(r.messages[1].bodyText, 'bbbbb');
		assert.strictEqual(r.messages[2].bodyText, 'ccccc');
	});

	it('should skip only the deleted message in a mixed walk', function () {
		var keepA = buildMsgHeader({ number: 1, subfields: [{ loID: SUBFIELD.SUBJECT, data: 'Keep A' }] });
		var drop = buildMsgHeader({
			number: 2, attribute: MSG_ATTR.DELETED,
			subfields: [{ loID: SUBFIELD.SUBJECT, data: 'Drop' }],
		});
		var keepB = buildMsgHeader({ number: 3, subfields: [{ loID: SUBFIELD.SUBJECT, data: 'Keep B' }] });

		var jhr = Buffer.concat([buildHeaderInfo({}), keepA, drop, keepB]);
		var jhrPath = writeTmp('mixed.jhr', jhr);
		var jdtPath = writeTmp('mixed.jdt', buildJdt(64, []));

		var r = parseJAM(jhrPath, jdtPath, null);
		assert.strictEqual(r.messages.length, 2);
		assert.strictEqual(r.messages[0].header.subject, 'Keep A');
		assert.strictEqual(r.messages[1].header.subject, 'Keep B');
	});

	it('should use the index file to locate message headers', function () {
		var h1 = buildMsgHeader({
			number: 1, txtOffset: 0, txtLen: 5,
			subfields: [{ loID: SUBFIELD.SUBJECT, data: 'Indexed 1' }],
		});
		var h2 = buildMsgHeader({
			number: 2, txtOffset: 5, txtLen: 5,
			subfields: [{ loID: SUBFIELD.SUBJECT, data: 'Indexed 2' }],
		});

		var jhr = Buffer.concat([buildHeaderInfo({ activeMsgs: 2 }), h1, h2]);
		var jdx = Buffer.concat([
			buildIndexRecord(0, HDRINFO_SIZE),
			buildIndexRecord(0, HDRINFO_SIZE + h1.length),
		]);

		var jhrPath = writeTmp('idx.jhr', jhr);
		var jdtPath = writeTmp('idx.jdt', buildJdt(64, [{ at: 0, text: 'aaaaabbbbb' }]));
		var jdxPath = writeTmp('idx.jdx', jdx);

		var r = parseJAM(jhrPath, jdtPath, jdxPath);
		assert.strictEqual(r.messages.length, 2);
		assert.strictEqual(r.messages[0].header.subject, 'Indexed 1');
		assert.strictEqual(r.messages[1].header.subject, 'Indexed 2');
		assert.strictEqual(r.messages[1].bodyText, 'bbbbb');
	});

	it('should honour index order rather than physical header order', function () {
		var h1 = buildMsgHeader({ number: 1, subfields: [{ loID: SUBFIELD.SUBJECT, data: 'Physically first' }] });
		var h2 = buildMsgHeader({ number: 2, subfields: [{ loID: SUBFIELD.SUBJECT, data: 'Physically second' }] });

		var jhr = Buffer.concat([buildHeaderInfo({}), h1, h2]);
		var jdx = Buffer.concat([
			buildIndexRecord(0, HDRINFO_SIZE + h1.length),
			buildIndexRecord(0, HDRINFO_SIZE),
		]);

		var jhrPath = writeTmp('order.jhr', jhr);
		var jdtPath = writeTmp('order.jdt', buildJdt(64, []));
		var jdxPath = writeTmp('order.jdx', jdx);

		var r = parseJAM(jhrPath, jdtPath, jdxPath);
		assert.strictEqual(r.messages.length, 2);
		assert.strictEqual(r.messages[0].header.subject, 'Physically second');
		assert.strictEqual(r.messages[1].header.subject, 'Physically first');
	});

	it('should skip index slots carrying the empty offset marker', function () {
		var h1 = buildMsgHeader({ number: 1, subfields: [{ loID: SUBFIELD.SUBJECT, data: 'Live' }] });
		var h2 = buildMsgHeader({ number: 2, subfields: [{ loID: SUBFIELD.SUBJECT, data: 'Never read' }] });

		var jhr = Buffer.concat([buildHeaderInfo({}), h1, h2]);
		var jdx = Buffer.concat([
			buildIndexRecord(0, HDRINFO_SIZE),
			buildIndexRecord(0xFFFFFFFF, 0xFFFFFFFF),
		]);

		var jhrPath = writeTmp('empty.jhr', jhr);
		var jdtPath = writeTmp('empty.jdt', buildJdt(64, []));
		var jdxPath = writeTmp('empty.jdx', jdx);

		var r = parseJAM(jhrPath, jdtPath, jdxPath);
		assert.strictEqual(r.messages.length, 1);
		assert.strictEqual(r.messages[0].header.subject, 'Live');
	});

	it('should still honour the deleted attribute on an indexed message', function () {
		var h1 = buildMsgHeader({
			number: 1, attribute: MSG_ATTR.DELETED,
			subfields: [{ loID: SUBFIELD.SUBJECT, data: 'Deleted but indexed' }],
		});

		var jhr = Buffer.concat([buildHeaderInfo({}), h1]);
		var jdx = buildIndexRecord(0, HDRINFO_SIZE);

		var jhrPath = writeTmp('idxdel.jhr', jhr);
		var jdtPath = writeTmp('idxdel.jdt', buildJdt(64, []));
		var jdxPath = writeTmp('idxdel.jdx', jdx);

		var r = parseJAM(jhrPath, jdtPath, jdxPath);
		assert.strictEqual(r.messages.length, 0);
	});

	it('should skip an index entry pointing at a bad offset', function () {
		var h1 = buildMsgHeader({ number: 1, subfields: [{ loID: SUBFIELD.SUBJECT, data: 'Good' }] });
		var jhr = Buffer.concat([buildHeaderInfo({}), h1]);
		var jdx = Buffer.concat([
			buildIndexRecord(0, HDRINFO_SIZE),
			buildIndexRecord(0, HDRINFO_SIZE + 3), // lands mid-header, no signature
		]);

		var jhrPath = writeTmp('badoff.jhr', jhr);
		var jdtPath = writeTmp('badoff.jdt', buildJdt(64, []));
		var jdxPath = writeTmp('badoff.jdx', jdx);

		var r = parseJAM(jhrPath, jdtPath, jdxPath);
		assert.strictEqual(r.messages.length, 1);
		assert.strictEqual(r.messages[0].header.subject, 'Good');
	});

	it('should fall back to a sequential walk when the index is empty', function () {
		var base = buildSimpleBase({});
		var jhrPath = writeTmp('emptyidx.jhr', base.jhr);
		var jdtPath = writeTmp('emptyidx.jdt', base.jdt);
		var jdxPath = writeTmp('emptyidx.jdx', Buffer.alloc(0));

		var r = parseJAM(jhrPath, jdtPath, jdxPath);
		assert.strictEqual(r.messages.length, 1);
		assert.strictEqual(r.messages[0].header.subject, 'Test subject');
	});

	it('should fall back to a sequential walk when the index path does not exist', function () {
		var base = buildSimpleBase({});
		var jhrPath = writeTmp('noidx.jhr', base.jhr);
		var jdtPath = writeTmp('noidx.jdt', base.jdt);

		var r = parseJAM(jhrPath, jdtPath, path.join(TMP_DIR, 'nope.jdx'));
		assert.strictEqual(r.messages.length, 1);
	});

	it('should return an empty list for a base with no message headers', function () {
		var jhrPath = writeTmp('bare.jhr', buildHeaderInfo({ activeMsgs: 0 }));
		var jdtPath = writeTmp('bare.jdt', Buffer.alloc(0));

		var r = parseJAM(jhrPath, jdtPath, null);
		assert.strictEqual(r.status, true);
		assert.strictEqual(r.messages.length, 0);
	});

	it('should resync on the next signature when a header is damaged', function () {
		// Junk between the info block and the real header forces the walk
		// through its resync path rather than abandoning the rest of the base.
		var junk = Buffer.alloc(50, 0x2E);
		var hdr = buildMsgHeader({ number: 1, subfields: [{ loID: SUBFIELD.SUBJECT, data: 'After junk' }] });
		var jhr = Buffer.concat([buildHeaderInfo({}), junk, hdr]);

		var jhrPath = writeTmp('resync.jhr', jhr);
		var jdtPath = writeTmp('resync.jdt', buildJdt(64, []));

		var r = parseJAM(jhrPath, jdtPath, null);
		assert.strictEqual(r.messages.length, 1);
		assert.strictEqual(r.messages[0].header.subject, 'After junk');
	});

	it('should recover the remaining messages after a corrupt subfield length', function () {
		// A wildly wrong SubfieldLen would desync a naive walk. The resync
		// scan should still find the message that follows.
		var broken = buildMsgHeader({
			number: 1,
			subfieldLenOverride: 3,
			subfields: [{ loID: SUBFIELD.SUBJECT, data: 'Broken' }],
		});
		var good = buildMsgHeader({ number: 2, subfields: [{ loID: SUBFIELD.SUBJECT, data: 'Recovered' }] });
		var jhr = Buffer.concat([buildHeaderInfo({}), broken, good]);

		var jhrPath = writeTmp('corrupt.jhr', jhr);
		var jdtPath = writeTmp('corrupt.jdt', buildJdt(64, []));

		var r = parseJAM(jhrPath, jdtPath, null);
		var subjects = r.messages.map(function (m) { return m.header.subject; });
		assert.ok(subjects.indexOf('Recovered') >= 0, 'expected to recover the trailing message');
	});

	it('should skip text extraction in headersOnly mode', function () {
		var base = buildSimpleBase({});
		var jhrPath = writeTmp('hdronly.jhr', base.jhr);
		var jdtPath = writeTmp('hdronly.jdt', base.jdt);

		var r = parseJAM(jhrPath, jdtPath, null, { headersOnly: true });
		assert.strictEqual(r.messages.length, 1);
		assert.strictEqual(r.messages[0].bodyText, '');
		assert.strictEqual(r.messages[0].header.subject, 'Test subject');
	});
});

// ---------------------------------------------------------------------------
// previewJAM
// ---------------------------------------------------------------------------

describe('previewJAM', function () {

	afterEach(function () {
		cleanupTmp();
	});

	it('should propagate a parse error', function () {
		var base = buildSimpleBase({});
		var jdtPath = writeTmp('perr.jdt', base.jdt);
		var r = previewJAM(path.join(TMP_DIR, 'nope.jhr'), jdtPath, null);
		assert.strictEqual(r.status, false);
		assert.ok(/Header file not found/.test(r.error));
	});

	it('should report the message count and first/last subjects', function () {
		var headers = [
			buildMsgHeader({ number: 1, dateWritten: 1600000000, subfields: [{ loID: SUBFIELD.SUBJECT, data: 'Oldest' }] }),
			buildMsgHeader({ number: 2, dateWritten: 1650000000, subfields: [{ loID: SUBFIELD.SUBJECT, data: 'Middle' }] }),
			buildMsgHeader({ number: 3, dateWritten: 1700000000, subfields: [{ loID: SUBFIELD.SUBJECT, data: 'Newest' }] }),
		];
		var jhr = Buffer.concat([buildHeaderInfo({ activeMsgs: 3 })].concat(headers));

		var jhrPath = writeTmp('preview.jhr', jhr);
		var jdtPath = writeTmp('preview.jdt', buildJdt(64, []));

		var r = previewJAM(jhrPath, jdtPath, null);
		assert.strictEqual(r.status, true);
		assert.strictEqual(r.totalMsgs, 3);
		assert.strictEqual(r.firstSubject, 'Oldest');
		assert.strictEqual(r.lastSubject, 'Newest');
		assert.strictEqual(r.dateRange.first.getTime(), 1600000000 * 1000);
		assert.strictEqual(r.dateRange.last.getTime(), 1700000000 * 1000);
	});

	it('should return a null date range for an empty base', function () {
		var jhrPath = writeTmp('pempty.jhr', buildHeaderInfo({ activeMsgs: 0 }));
		var jdtPath = writeTmp('pempty.jdt', Buffer.alloc(0));

		var r = previewJAM(jhrPath, jdtPath, null);
		assert.strictEqual(r.status, true);
		assert.strictEqual(r.totalMsgs, 0);
		assert.strictEqual(r.dateRange, null);
	});

	it('should expose the info block alongside the preview stats', function () {
		var base = buildSimpleBase({});
		var jhrPath = writeTmp('pstatus.jhr', base.jhr);
		var jdtPath = writeTmp('pstatus.jdt', base.jdt);

		var r = previewJAM(jhrPath, jdtPath, null);
		assert.ok(r.headerInfo);
		assert.strictEqual(r.headerInfo.activeMsgs, 1);
	});

	it('should not need the text file contents to produce a preview', function () {
		// headersOnly means an empty .jdt is still a valid preview
		var base = buildSimpleBase({});
		var jhrPath = writeTmp('notext.jhr', base.jhr);
		var jdtPath = writeTmp('notext.jdt', Buffer.alloc(0));

		var r = previewJAM(jhrPath, jdtPath, null);
		assert.strictEqual(r.status, true);
		assert.strictEqual(r.totalMsgs, 1);
		assert.strictEqual(r.firstSubject, 'Test subject');
	});
});

// ---------------------------------------------------------------------------
// Streaming iterator
// ---------------------------------------------------------------------------

describe('iterateJAM', function () {

	afterEach(function () {
		cleanupTmp();
	});

	function fdCount() {
		try { return fs.readdirSync('/proc/self/fd').length; } catch (e) { return -1; }
	}

	it('yields the same messages parseJAM collects', function () {
		var base = buildSimpleBase({});
		var jhrPath = writeTmp('iter.jhr', base.jhr);
		var jdtPath = writeTmp('iter.jdt', base.jdt);

		var streamed = [];
		for (var m of iterateJAM(jhrPath, jdtPath, null)) streamed.push(m);
		var collected = parseJAM(jhrPath, jdtPath, null).messages;

		assert.strictEqual(streamed.length, collected.length);
		assert.strictEqual(streamed[0].bodyText, collected[0].bodyText);
		assert.strictEqual(streamed[0].header.subject, collected[0].header.subject);
	});

	it('matches parseJAM across a multi-message base', function () {
		var h1 = buildMsgHeader({ number: 1, txtOffset: 0, txtLen: 5, subfields: [{ loID: SUBFIELD.SUBJECT, data: 'One' }] });
		var h2 = buildMsgHeader({ number: 2, txtOffset: 5, txtLen: 5, subfields: [{ loID: SUBFIELD.SUBJECT, data: 'Two' }] });
		var h3 = buildMsgHeader({ number: 3, txtOffset: 10, txtLen: 5, subfields: [{ loID: SUBFIELD.SUBJECT, data: 'Three' }] });

		var jhrPath = writeTmp('multi.jhr', Buffer.concat([buildHeaderInfo({ activeMsgs: 3 }), h1, h2, h3]));
		var jdtPath = writeTmp('multi.jdt', buildJdt(64, [{ at: 0, text: 'aaaaabbbbbccccc' }]));

		var streamed = [];
		for (var m of iterateJAM(jhrPath, jdtPath, null)) streamed.push(m);
		var collected = parseJAM(jhrPath, jdtPath, null).messages;

		assert.deepStrictEqual(
			streamed.map(function (x) { return x.header.subject + ':' + x.bodyText; }),
			collected.map(function (x) { return x.header.subject + ':' + x.bodyText; })
		);
	});

	it('throws rather than returning a result object on a missing header', function () {
		assert.throws(function () {
			for (var m of iterateJAM(path.join(TMP_DIR, 'nope.jhr'), path.join(TMP_DIR, 'nope.jdt'), null)) { void m; }
		}, /Header file not found/);
	});

	it('closes the text file descriptor when fully consumed', function () {
		var base = buildSimpleBase({});
		var jhrPath = writeTmp('fd1.jhr', base.jhr);
		var jdtPath = writeTmp('fd1.jdt', base.jdt);

		var before = fdCount();
		for (var i = 0; i < 25; i++) {
			for (var m of iterateJAM(jhrPath, jdtPath, null)) { void m; }
		}
		var after = fdCount();
		assert.ok(after <= before + 2, 'descriptors leaked: ' + before + ' -> ' + after);
	});

	it('closes the text file descriptor when the consumer stops early', function () {
		var h1 = buildMsgHeader({ number: 1, txtOffset: 0, txtLen: 5, subfields: [{ loID: SUBFIELD.SUBJECT, data: 'One' }] });
		var h2 = buildMsgHeader({ number: 2, txtOffset: 5, txtLen: 5, subfields: [{ loID: SUBFIELD.SUBJECT, data: 'Two' }] });
		var jhrPath = writeTmp('fd2.jhr', Buffer.concat([buildHeaderInfo({ activeMsgs: 2 }), h1, h2]));
		var jdtPath = writeTmp('fd2.jdt', buildJdt(64, [{ at: 0, text: 'aaaaabbbbb' }]));

		var before = fdCount();
		for (var i = 0; i < 25; i++) {
			// break on the first message, leaving the generator suspended
			for (var m of iterateJAM(jhrPath, jdtPath, null)) { void m; break; }
		}
		var after = fdCount();
		assert.ok(after <= before + 2, 'descriptors leaked on early break: ' + before + ' -> ' + after);
	});

	it('does not open the text file in headersOnly mode', function () {
		var base = buildSimpleBase({});
		var jhrPath = writeTmp('ho.jhr', base.jhr);
		// A zero-length .jdt would break any read attempt
		var jdtPath = writeTmp('ho.jdt', Buffer.alloc(0));

		var seen = [];
		for (var m of iterateJAM(jhrPath, jdtPath, null, { headersOnly: true })) seen.push(m);
		assert.strictEqual(seen.length, 1);
		assert.strictEqual(seen[0].bodyText, '');
		assert.strictEqual(seen[0].header.subject, 'Test subject');
	});

	it('reads only the bytes each message declares', function () {
		// Two messages sharing one .jdt; each must get its own slice
		var h1 = buildMsgHeader({ number: 1, txtOffset: 0, txtLen: 5, subfields: [] });
		var h2 = buildMsgHeader({ number: 2, txtOffset: 5, txtLen: 6, subfields: [] });
		var jhrPath = writeTmp('slice.jhr', Buffer.concat([buildHeaderInfo({}), h1, h2]));
		var jdtPath = writeTmp('slice.jdt', buildJdt(32, [{ at: 0, text: 'HELLOWORLD!' }]));

		var bodies = [];
		for (var m of iterateJAM(jhrPath, jdtPath, null)) bodies.push(m.bodyText);
		assert.deepStrictEqual(bodies, ['HELLO', 'WORLD!']);
	});
});
