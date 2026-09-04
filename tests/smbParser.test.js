// tests/smbParser.test.js — Unit tests for smbParser.js
//
// Builds synthetic .shd/.sdt/.sid buffers rather than shipping binary fixtures,
// so the expected byte layout is visible in the test itself. No DB, no network.
// Run: npx mocha tests/smbParser.test.js

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as url from 'url';
import {
	iterateSMB,
	parseSMB,
	previewSMB,
	parseStatusHeader,
	parseMsgHeader,
	extractMessageText,
	HFIELD,
	DFIELD,
	MSG_ATTR,
} from '../src/utils/smbParser.js';

var __dirname = path.dirname(url.fileURLToPath(import.meta.url));
var TMP_DIR = path.join(__dirname, 'tmp');

// ---------------------------------------------------------------------------
// Builders — mirror the layout smbParser.js expects
// ---------------------------------------------------------------------------

var BLOCK = 256;

// Status header occupies the first block of the .shd file.
function buildStatusHeader(opts) {
	var o = opts || {};
	var buf = Buffer.alloc(BLOCK);
	buf.write('SMB\x1A', 0, 'latin1');
	buf.writeUInt16LE(o.version !== undefined ? o.version : 0x0121, 4);
	buf.writeUInt16LE(o.length !== undefined ? o.length : BLOCK, 6);
	buf.writeUInt32LE(o.lastMsg || 0, 8);
	buf.writeUInt32LE(o.totalMsgs || 0, 12);
	buf.writeUInt32LE(o.headerOffset !== undefined ? o.headerOffset : BLOCK, 16);
	buf.writeUInt32LE(o.maxCrcs || 0, 20);
	buf.writeUInt32LE(o.maxMsgs || 0, 24);
	buf.writeUInt16LE(o.maxAge || 0, 28);
	buf.writeUInt16LE(o.attr || 0, 30);
	return buf;
}

// Message header: 70 fixed bytes, then dfield descriptors, then hfields.
// Padded out to whole 256-byte blocks so the sequential scan advances cleanly.
function buildMsgHeader(opts) {
	var o = opts || {};
	var dfields = o.dfields || [];
	var hfields = o.hfields || [];

	var varBytes = dfields.length * 10;
	for (var i = 0; i < hfields.length; i++) {
		varBytes += 4 + Buffer.byteLength(hfields[i].data, 'latin1');
	}

	var totalLen = 70 + varBytes;
	var blocks = Math.ceil(totalLen / BLOCK);
	var buf = Buffer.alloc(blocks * BLOCK);

	buf.write('SHD\x1A', 0, 'latin1');
	buf.writeUInt16LE(o.type || 0, 4);
	buf.writeUInt16LE(o.version !== undefined ? o.version : 0x0121, 6);
	buf.writeUInt16LE(o.lengthOverride !== undefined ? o.lengthOverride : totalLen, 8);
	buf.writeUInt16LE(o.attr || 0, 10);
	buf.writeUInt32LE(o.auxattr || 0, 12);
	buf.writeUInt32LE(o.netattr || 0, 16);
	buf.writeUInt32LE(o.whenWrittenTime || 0, 20);
	buf.writeUInt16LE(o.whenWrittenZone || 0, 24);
	buf.writeUInt32LE(o.whenImportedTime || 0, 26);
	buf.writeUInt16LE(o.whenImportedZone || 0, 30);
	buf.writeUInt32LE(o.number || 0, 32);
	buf.writeUInt32LE(o.threadOrig || 0, 36);
	buf.writeUInt32LE(o.threadNext || 0, 40);
	buf.writeUInt32LE(o.threadFirst || 0, 44);
	buf.writeUInt32LE(o.dataOffset || 0, 64);
	buf.writeUInt16LE(dfields.length, 68);

	var pos = 70;
	for (var d = 0; d < dfields.length; d++) {
		buf.writeUInt16LE(dfields[d].type, pos);
		buf.writeUInt32LE(dfields[d].offset, pos + 2);
		buf.writeUInt32LE(dfields[d].length, pos + 6);
		pos += 10;
	}
	for (var h = 0; h < hfields.length; h++) {
		var data = Buffer.from(hfields[h].data, 'latin1');
		buf.writeUInt16LE(hfields[h].type, pos);
		buf.writeUInt16LE(data.length, pos + 2);
		data.copy(buf, pos + 4);
		pos += 4 + data.length;
	}

	return buf;
}

// .sid index record: 20 bytes each.
function buildIndexRecord(opts) {
	var o = opts || {};
	var buf = Buffer.alloc(20);
	buf.writeUInt16LE(o.to || 0, 0);
	buf.writeUInt16LE(o.from || 0, 2);
	buf.writeUInt16LE(o.subj || 0, 4);
	buf.writeUInt16LE(o.attr || 0, 6);
	buf.writeUInt32LE(o.offset || 0, 8);
	buf.writeUInt32LE(o.number || 0, 12);
	buf.writeUInt32LE(o.time || 0, 16);
	return buf;
}

// .sdt data buffer with text placed at explicit absolute byte offsets.
function buildSdt(totalBytes, placements) {
	var buf = Buffer.alloc(totalBytes, 0);
	for (var i = 0; i < placements.length; i++) {
		Buffer.from(placements[i].text, 'latin1').copy(buf, placements[i].at);
	}
	return buf;
}

// Convenience: a complete single-message base.
// Message text lives in block 1 of the .sdt (byte 256).
function buildSimpleBase(opts) {
	var o = opts || {};
	var body = o.body !== undefined ? o.body : 'Hello from the message base.\r\n';
	var tail = o.tail !== undefined ? o.tail : '--- tossed\r\n * Origin: Test BBS (1:2/3)\r\n';

	var hdr = buildMsgHeader({
		attr: o.attr || 0,
		number: o.number !== undefined ? o.number : 1,
		whenWrittenTime: o.whenWrittenTime || 1000000000,
		dataOffset: 1,
		dfields: [
			{ type: DFIELD.TEXT_BODY, offset: 0, length: body.length },
			{ type: DFIELD.TEXT_TAIL, offset: body.length, length: tail.length },
		],
		hfields: o.hfields || [
			{ type: HFIELD.SENDER, data: 'Alice' },
			{ type: HFIELD.RECIPIENT, data: 'Bob' },
			{ type: HFIELD.SUBJECT, data: 'Test subject' },
		],
	});

	return {
		shd: Buffer.concat([buildStatusHeader({ totalMsgs: 1, lastMsg: 1 }), hdr]),
		sdt: buildSdt(1024, [
			{ at: BLOCK, text: body },
			{ at: BLOCK + body.length, text: tail },
		]),
		body: body,
		tail: tail,
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
// parseStatusHeader
// ---------------------------------------------------------------------------

describe('parseStatusHeader', function () {

	it('should return null for a buffer shorter than 32 bytes', function () {
		assert.strictEqual(parseStatusHeader(Buffer.alloc(31)), null);
	});

	it('should return null when the SMB magic is wrong', function () {
		var buf = buildStatusHeader({});
		buf.write('XXXX', 0, 'latin1');
		assert.strictEqual(parseStatusHeader(buf), null);
	});

	it('should parse the fixed status fields', function () {
		var buf = buildStatusHeader({
			version: 0x0121,
			length: 256,
			lastMsg: 42,
			totalMsgs: 17,
			headerOffset: 512,
			maxCrcs: 1000,
			maxMsgs: 5000,
			maxAge: 30,
			attr: 0x0003,
		});
		var st = parseStatusHeader(buf);
		assert.strictEqual(st.version, 0x0121);
		assert.strictEqual(st.length, 256);
		assert.strictEqual(st.lastMsg, 42);
		assert.strictEqual(st.totalMsgs, 17);
		assert.strictEqual(st.headerOffset, 512);
		assert.strictEqual(st.maxCrcs, 1000);
		assert.strictEqual(st.maxMsgs, 5000);
		assert.strictEqual(st.maxAge, 30);
		assert.strictEqual(st.attr, 0x0003);
	});

	it('should accept a buffer that is exactly 32 bytes', function () {
		var full = buildStatusHeader({ lastMsg: 7 });
		var st = parseStatusHeader(full.subarray(0, 32));
		assert.ok(st);
		assert.strictEqual(st.lastMsg, 7);
	});
});

// ---------------------------------------------------------------------------
// parseMsgHeader
// ---------------------------------------------------------------------------

describe('parseMsgHeader', function () {

	it('should return null when the fixed header would overrun the buffer', function () {
		var buf = buildMsgHeader({});
		// Only 69 bytes available from the offset, fixed header needs 70
		assert.strictEqual(parseMsgHeader(buf.subarray(0, 69), 0), null);
	});

	it('should return null when the message magic is wrong', function () {
		var buf = buildMsgHeader({});
		buf.write('XXXX', 0, 'latin1');
		assert.strictEqual(parseMsgHeader(buf, 0), null);
	});

	it('should parse the fixed numeric fields', function () {
		var buf = buildMsgHeader({
			attr: MSG_ATTR.PRIVATE,
			number: 1234,
			dataOffset: 3,
			whenWrittenTime: 1700000000,
			whenWrittenZone: 300,
			threadOrig: 11,
			threadNext: 22,
			threadFirst: 33,
		});
		var hdr = parseMsgHeader(buf, 0);
		assert.strictEqual(hdr.attr, MSG_ATTR.PRIVATE);
		assert.strictEqual(hdr.number, 1234);
		assert.strictEqual(hdr.dataOffset, 3);
		assert.strictEqual(hdr.whenWritten.time, 1700000000);
		assert.strictEqual(hdr.whenWritten.zone, 300);
		assert.strictEqual(hdr.threadOrig, 11);
		assert.strictEqual(hdr.threadNext, 22);
		assert.strictEqual(hdr.threadFirst, 33);
	});

	it('should parse data field descriptors', function () {
		var buf = buildMsgHeader({
			dfields: [
				{ type: DFIELD.TEXT_BODY, offset: 0, length: 100 },
				{ type: DFIELD.TEXT_TAIL, offset: 100, length: 40 },
			],
		});
		var hdr = parseMsgHeader(buf, 0);
		assert.strictEqual(hdr.totalDfields, 2);
		assert.strictEqual(hdr.dfields.length, 2);
		assert.deepStrictEqual(hdr.dfields[0], { type: DFIELD.TEXT_BODY, offset: 0, length: 100 });
		assert.deepStrictEqual(hdr.dfields[1], { type: DFIELD.TEXT_TAIL, offset: 100, length: 40 });
	});

	it('should extract known header fields into named properties', function () {
		var buf = buildMsgHeader({
			hfields: [
				{ type: HFIELD.SENDER, data: 'Alice' },
				{ type: HFIELD.SENDERNETADDR, data: '1:2/3' },
				{ type: HFIELD.RECIPIENT, data: 'Bob' },
				{ type: HFIELD.RECIPIENTNETADDR, data: '1:2/4' },
				{ type: HFIELD.SUBJECT, data: 'Hello there' },
				{ type: HFIELD.FIDOMSGID, data: '1:2/3 5f2a1b3c' },
				{ type: HFIELD.FIDOREPLYID, data: '1:2/4 aabbccdd' },
				{ type: HFIELD.FIDOPID, data: 'Mystic/1.12' },
				{ type: HFIELD.FIDOAREA, data: 'TEST_ECHO' },
			],
		});
		var hdr = parseMsgHeader(buf, 0);
		assert.strictEqual(hdr.sender, 'Alice');
		assert.strictEqual(hdr.senderAddr, '1:2/3');
		assert.strictEqual(hdr.recipient, 'Bob');
		assert.strictEqual(hdr.recipientAddr, '1:2/4');
		assert.strictEqual(hdr.subject, 'Hello there');
		assert.strictEqual(hdr.msgId, '1:2/3 5f2a1b3c');
		assert.strictEqual(hdr.replyId, '1:2/4 aabbccdd');
		assert.strictEqual(hdr.fidoPid, 'Mystic/1.12');
		assert.strictEqual(hdr.fidoArea, 'TEST_ECHO');
	});

	it('should join repeated SEEN-BY fields with CRLF', function () {
		var buf = buildMsgHeader({
			hfields: [
				{ type: HFIELD.FIDOSEENBY, data: '1/2 3 4' },
				{ type: HFIELD.FIDOSEENBY, data: '5/6 7' },
			],
		});
		var hdr = parseMsgHeader(buf, 0);
		assert.strictEqual(hdr.fidoSeenBy, '1/2 3 4\r\n5/6 7');
	});

	it('should join repeated PATH fields with CRLF', function () {
		var buf = buildMsgHeader({
			hfields: [
				{ type: HFIELD.FIDOPATH, data: '1/2' },
				{ type: HFIELD.FIDOPATH, data: '3/4' },
			],
		});
		var hdr = parseMsgHeader(buf, 0);
		assert.strictEqual(hdr.fidoPath, '1/2\r\n3/4');
	});

	it('should collect FIDOCTRL fields into an array', function () {
		var buf = buildMsgHeader({
			hfields: [
				{ type: HFIELD.FIDOCTRL, data: 'TZUTC: 0000' },
				{ type: HFIELD.FIDOCTRL, data: 'CHRS: CP437 2' },
			],
		});
		var hdr = parseMsgHeader(buf, 0);
		assert.deepStrictEqual(hdr.fidoCtrl, ['TZUTC: 0000', 'CHRS: CP437 2']);
	});

	it('should strip embedded and trailing nulls from header field data', function () {
		var buf = buildMsgHeader({
			hfields: [{ type: HFIELD.SUBJECT, data: 'Sub\x00ject\x00' }],
		});
		var hdr = parseMsgHeader(buf, 0);
		assert.strictEqual(hdr.subject, 'Subject');
	});

	it('should keep every parsed field in the raw hfields list', function () {
		var buf = buildMsgHeader({
			hfields: [
				{ type: HFIELD.SENDER, data: 'Alice' },
				{ type: HFIELD.SENDERORG, data: 'Test BBS' },
			],
		});
		var hdr = parseMsgHeader(buf, 0);
		assert.strictEqual(hdr.hfields.length, 2);
		assert.strictEqual(hdr.hfields[1].type, HFIELD.SENDERORG);
		assert.strictEqual(hdr.hfields[1].data, 'Test BBS');
	});

	it('should stop reading header fields at the declared header length', function () {
		// Declare a length that covers the fixed area and the first hfield only.
		// The second hfield sits past hdrEnd and must be ignored.
		var first = 4 + 'Alice'.length;
		var buf = buildMsgHeader({
			lengthOverride: 70 + first,
			hfields: [
				{ type: HFIELD.SENDER, data: 'Alice' },
				{ type: HFIELD.SUBJECT, data: 'Should not be read' },
			],
		});
		var hdr = parseMsgHeader(buf, 0);
		assert.strictEqual(hdr.sender, 'Alice');
		assert.strictEqual(hdr.subject, '');
		assert.strictEqual(hdr.hfields.length, 1);
	});

	it('should parse a header that is not at offset zero', function () {
		var status = buildStatusHeader({});
		var hdr = buildMsgHeader({ number: 99, hfields: [{ type: HFIELD.SUBJECT, data: 'Offset test' }] });
		var combined = Buffer.concat([status, hdr]);
		var parsed = parseMsgHeader(combined, BLOCK);
		assert.strictEqual(parsed.number, 99);
		assert.strictEqual(parsed.subject, 'Offset test');
	});
});

// ---------------------------------------------------------------------------
// extractMessageText
// ---------------------------------------------------------------------------

describe('extractMessageText', function () {

	it('should extract body and tail from their data fields', function () {
		var body = 'This is the body.';
		var tail = '--- tearline';
		var sdt = buildSdt(1024, [
			{ at: BLOCK, text: body },
			{ at: BLOCK + body.length, text: tail },
		]);
		var hdr = {
			dataOffset: 1,
			dfields: [
				{ type: DFIELD.TEXT_BODY, offset: 0, length: body.length },
				{ type: DFIELD.TEXT_TAIL, offset: body.length, length: tail.length },
			],
		};
		var text = extractMessageText(sdt, hdr, BLOCK);
		assert.strictEqual(text.body, body);
		assert.strictEqual(text.tail, tail);
	});

	it('should concatenate multiple body data fields in order', function () {
		var a = 'first-';
		var b = 'second';
		var sdt = buildSdt(1024, [
			{ at: BLOCK, text: a },
			{ at: BLOCK + a.length, text: b },
		]);
		var hdr = {
			dataOffset: 1,
			dfields: [
				{ type: DFIELD.TEXT_BODY, offset: 0, length: a.length },
				{ type: DFIELD.TEXT_BODY, offset: a.length, length: b.length },
			],
		};
		var text = extractMessageText(sdt, hdr, BLOCK);
		assert.strictEqual(text.body, 'first-second');
		assert.strictEqual(text.tail, '');
	});

	it('should ignore data field types that are not body or tail', function () {
		var soul = 'soul text';
		var sdt = buildSdt(1024, [{ at: BLOCK, text: soul }]);
		var hdr = {
			dataOffset: 1,
			dfields: [{ type: DFIELD.TEXT_SOUL, offset: 0, length: soul.length }],
		};
		var text = extractMessageText(sdt, hdr, BLOCK);
		assert.strictEqual(text.body, '');
		assert.strictEqual(text.tail, '');
	});

	it('should skip a data field that runs past the end of the buffer', function () {
		var sdt = buildSdt(512, [{ at: BLOCK, text: 'short' }]);
		var hdr = {
			dataOffset: 1,
			dfields: [
				{ type: DFIELD.TEXT_BODY, offset: 0, length: 5 },
				{ type: DFIELD.TEXT_BODY, offset: 200, length: 9999 },
			],
		};
		var text = extractMessageText(sdt, hdr, BLOCK);
		assert.strictEqual(text.body, 'short');
	});

	it('should strip nulls from extracted text', function () {
		var raw = 'abc\x00def\x00\x00';
		var sdt = buildSdt(1024, [{ at: BLOCK, text: raw }]);
		var hdr = {
			dataOffset: 1,
			dfields: [{ type: DFIELD.TEXT_BODY, offset: 0, length: raw.length }],
		};
		var text = extractMessageText(sdt, hdr, BLOCK);
		assert.strictEqual(text.body, 'abcdef');
	});

	it('should treat dataOffset as a block index when it fits the buffer', function () {
		var body = 'block addressed';
		var sdt = buildSdt(2048, [{ at: 2 * BLOCK, text: body }]);
		var hdr = {
			dataOffset: 2,
			dfields: [{ type: DFIELD.TEXT_BODY, offset: 0, length: body.length }],
		};
		var text = extractMessageText(sdt, hdr, BLOCK);
		assert.strictEqual(text.body, body);
	});

	it('should fall back to a direct byte offset when the block offset overruns', function () {
		// dataOffset 10 as a block index is 2560, past the end of a 100-byte
		// buffer, so the parser falls back to byte offset 10 (smbParser.js:204).
		var body = 'byte addressed';
		var sdt = buildSdt(100, [{ at: 10, text: body }]);
		var hdr = {
			dataOffset: 10,
			dfields: [{ type: DFIELD.TEXT_BODY, offset: 0, length: body.length }],
		};
		var text = extractMessageText(sdt, hdr, BLOCK);
		assert.strictEqual(text.body, body);
	});

	it('should default to a 256-byte block when no block size is supplied', function () {
		var body = 'default block size';
		var sdt = buildSdt(1024, [{ at: BLOCK, text: body }]);
		var hdr = {
			dataOffset: 1,
			dfields: [{ type: DFIELD.TEXT_BODY, offset: 0, length: body.length }],
		};
		var text = extractMessageText(sdt, hdr, null);
		assert.strictEqual(text.body, body);
	});

	it('should return empty strings when there are no data fields', function () {
		var text = extractMessageText(buildSdt(512, []), { dataOffset: 1, dfields: [] }, BLOCK);
		assert.strictEqual(text.body, '');
		assert.strictEqual(text.tail, '');
	});
});

// ---------------------------------------------------------------------------
// parseSMB
// ---------------------------------------------------------------------------

describe('parseSMB', function () {

	afterEach(function () {
		cleanupTmp();
	});

	it('should report an error when the .shd file is missing', function () {
		var base = buildSimpleBase({});
		var sdtPath = writeTmp('missing-shd.sdt', base.sdt);
		var r = parseSMB(path.join(TMP_DIR, 'does-not-exist.shd'), sdtPath, null);
		assert.strictEqual(r.status, false);
		assert.ok(/Header file not found/.test(r.error));
	});

	it('should report an error when the .sdt file is missing', function () {
		var base = buildSimpleBase({});
		var shdPath = writeTmp('missing-sdt.shd', base.shd);
		var r = parseSMB(shdPath, path.join(TMP_DIR, 'does-not-exist.sdt'), null);
		assert.strictEqual(r.status, false);
		assert.ok(/Data file not found/.test(r.error));
	});

	it('should report an error when the status header magic is invalid', function () {
		var base = buildSimpleBase({});
		base.shd.write('NOPE', 0, 'latin1');
		var shdPath = writeTmp('badmagic.shd', base.shd);
		var sdtPath = writeTmp('badmagic.sdt', base.sdt);
		var r = parseSMB(shdPath, sdtPath, null);
		assert.strictEqual(r.status, false);
		assert.ok(/Invalid SMB header file/.test(r.error));
	});

	it('should parse a single message by sequential scan', function () {
		var base = buildSimpleBase({});
		var shdPath = writeTmp('single.shd', base.shd);
		var sdtPath = writeTmp('single.sdt', base.sdt);

		var r = parseSMB(shdPath, sdtPath, null);
		assert.strictEqual(r.status, true);
		assert.strictEqual(r.messages.length, 1);
		assert.strictEqual(r.messages[0].header.sender, 'Alice');
		assert.strictEqual(r.messages[0].header.subject, 'Test subject');
		assert.strictEqual(r.messages[0].bodyText, base.body);
		assert.strictEqual(r.messages[0].tailText, base.tail);
	});

	it('should expose the parsed status header', function () {
		var base = buildSimpleBase({});
		var shdPath = writeTmp('status.shd', base.shd);
		var sdtPath = writeTmp('status.sdt', base.sdt);

		var r = parseSMB(shdPath, sdtPath, null);
		assert.ok(r.statusHeader);
		assert.strictEqual(r.statusHeader.totalMsgs, 1);
		assert.strictEqual(r.statusHeader.lastMsg, 1);
	});

	it('should skip messages flagged deleted during a sequential scan', function () {
		var base = buildSimpleBase({ attr: MSG_ATTR.DELETE });
		var shdPath = writeTmp('deleted.shd', base.shd);
		var sdtPath = writeTmp('deleted.sdt', base.sdt);

		var r = parseSMB(shdPath, sdtPath, null);
		assert.strictEqual(r.status, true);
		assert.strictEqual(r.messages.length, 0);
	});

	it('should walk multiple messages in a sequential scan', function () {
		var bodies = ['first message', 'second message', 'third message'];
		var headers = [];
		var placements = [];
		for (var i = 0; i < bodies.length; i++) {
			headers.push(buildMsgHeader({
				number: i + 1,
				dataOffset: i + 1,
				whenWrittenTime: 1700000000 + i,
				dfields: [{ type: DFIELD.TEXT_BODY, offset: 0, length: bodies[i].length }],
				hfields: [{ type: HFIELD.SUBJECT, data: 'Subject ' + (i + 1) }],
			}));
			placements.push({ at: (i + 1) * BLOCK, text: bodies[i] });
		}

		var shd = Buffer.concat([buildStatusHeader({ totalMsgs: 3, lastMsg: 3 })].concat(headers));
		var shdPath = writeTmp('multi.shd', shd);
		var sdtPath = writeTmp('multi.sdt', buildSdt(2048, placements));

		var r = parseSMB(shdPath, sdtPath, null);
		assert.strictEqual(r.status, true);
		assert.strictEqual(r.messages.length, 3);
		assert.strictEqual(r.messages[0].header.subject, 'Subject 1');
		assert.strictEqual(r.messages[1].header.subject, 'Subject 2');
		assert.strictEqual(r.messages[2].header.subject, 'Subject 3');
		assert.strictEqual(r.messages[0].bodyText, 'first message');
		assert.strictEqual(r.messages[2].bodyText, 'third message');
	});

	it('should skip only the deleted message in a mixed sequential scan', function () {
		var keepA = buildMsgHeader({
			number: 1,
			dataOffset: 1,
			hfields: [{ type: HFIELD.SUBJECT, data: 'Keep A' }],
		});
		var drop = buildMsgHeader({
			number: 2,
			attr: MSG_ATTR.DELETE,
			dataOffset: 2,
			hfields: [{ type: HFIELD.SUBJECT, data: 'Drop' }],
		});
		var keepB = buildMsgHeader({
			number: 3,
			dataOffset: 3,
			hfields: [{ type: HFIELD.SUBJECT, data: 'Keep B' }],
		});

		var shd = Buffer.concat([buildStatusHeader({ totalMsgs: 3 }), keepA, drop, keepB]);
		var shdPath = writeTmp('mixed.shd', shd);
		var sdtPath = writeTmp('mixed.sdt', buildSdt(2048, []));

		var r = parseSMB(shdPath, sdtPath, null);
		assert.strictEqual(r.messages.length, 2);
		assert.strictEqual(r.messages[0].header.subject, 'Keep A');
		assert.strictEqual(r.messages[1].header.subject, 'Keep B');
	});

	it('should use the index file to locate message headers', function () {
		var bodies = ['indexed one', 'indexed two'];
		var headers = [
			buildMsgHeader({
				number: 1,
				dataOffset: 1,
				dfields: [{ type: DFIELD.TEXT_BODY, offset: 0, length: bodies[0].length }],
				hfields: [{ type: HFIELD.SUBJECT, data: 'Indexed 1' }],
			}),
			buildMsgHeader({
				number: 2,
				dataOffset: 2,
				dfields: [{ type: DFIELD.TEXT_BODY, offset: 0, length: bodies[1].length }],
				hfields: [{ type: HFIELD.SUBJECT, data: 'Indexed 2' }],
			}),
		];

		var shd = Buffer.concat([buildStatusHeader({ totalMsgs: 2 })].concat(headers));
		var sid = Buffer.concat([
			buildIndexRecord({ offset: BLOCK, number: 1 }),
			buildIndexRecord({ offset: BLOCK + headers[0].length, number: 2 }),
		]);

		var shdPath = writeTmp('indexed.shd', shd);
		var sdtPath = writeTmp('indexed.sdt', buildSdt(2048, [
			{ at: BLOCK, text: bodies[0] },
			{ at: 2 * BLOCK, text: bodies[1] },
		]));
		var sidPath = writeTmp('indexed.sid', sid);

		var r = parseSMB(shdPath, sdtPath, sidPath);
		assert.strictEqual(r.status, true);
		assert.strictEqual(r.messages.length, 2);
		assert.strictEqual(r.messages[0].header.subject, 'Indexed 1');
		assert.strictEqual(r.messages[1].header.subject, 'Indexed 2');
		assert.strictEqual(r.messages[1].bodyText, 'indexed two');
	});

	it('should honour index order rather than physical header order', function () {
		var headers = [
			buildMsgHeader({ number: 1, dataOffset: 1, hfields: [{ type: HFIELD.SUBJECT, data: 'Physically first' }] }),
			buildMsgHeader({ number: 2, dataOffset: 2, hfields: [{ type: HFIELD.SUBJECT, data: 'Physically second' }] }),
		];
		var shd = Buffer.concat([buildStatusHeader({ totalMsgs: 2 })].concat(headers));

		// Index lists the second header first
		var sid = Buffer.concat([
			buildIndexRecord({ offset: BLOCK + headers[0].length, number: 2 }),
			buildIndexRecord({ offset: BLOCK, number: 1 }),
		]);

		var shdPath = writeTmp('order.shd', shd);
		var sdtPath = writeTmp('order.sdt', buildSdt(2048, []));
		var sidPath = writeTmp('order.sid', sid);

		var r = parseSMB(shdPath, sdtPath, sidPath);
		assert.strictEqual(r.messages.length, 2);
		assert.strictEqual(r.messages[0].header.subject, 'Physically second');
		assert.strictEqual(r.messages[1].header.subject, 'Physically first');
	});

	it('should skip index records flagged deleted without reading the header', function () {
		var headers = [
			buildMsgHeader({ number: 1, dataOffset: 1, hfields: [{ type: HFIELD.SUBJECT, data: 'Live' }] }),
			buildMsgHeader({ number: 2, dataOffset: 2, hfields: [{ type: HFIELD.SUBJECT, data: 'Dead' }] }),
		];
		var shd = Buffer.concat([buildStatusHeader({ totalMsgs: 2 })].concat(headers));
		var sid = Buffer.concat([
			buildIndexRecord({ offset: BLOCK, number: 1 }),
			buildIndexRecord({ offset: BLOCK + headers[0].length, number: 2, attr: MSG_ATTR.DELETE }),
		]);

		var shdPath = writeTmp('idxdel.shd', shd);
		var sdtPath = writeTmp('idxdel.sdt', buildSdt(2048, []));
		var sidPath = writeTmp('idxdel.sid', sid);

		var r = parseSMB(shdPath, sdtPath, sidPath);
		assert.strictEqual(r.messages.length, 1);
		assert.strictEqual(r.messages[0].header.subject, 'Live');
	});

	it('should fall back to a sequential scan when the index file is empty', function () {
		var base = buildSimpleBase({});
		var shdPath = writeTmp('emptyidx.shd', base.shd);
		var sdtPath = writeTmp('emptyidx.sdt', base.sdt);
		var sidPath = writeTmp('emptyidx.sid', Buffer.alloc(0));

		var r = parseSMB(shdPath, sdtPath, sidPath);
		assert.strictEqual(r.status, true);
		assert.strictEqual(r.messages.length, 1);
		assert.strictEqual(r.messages[0].header.subject, 'Test subject');
	});

	it('should fall back to a sequential scan when the index path does not exist', function () {
		var base = buildSimpleBase({});
		var shdPath = writeTmp('noidx.shd', base.shd);
		var sdtPath = writeTmp('noidx.sdt', base.sdt);

		var r = parseSMB(shdPath, sdtPath, path.join(TMP_DIR, 'nope.sid'));
		assert.strictEqual(r.status, true);
		assert.strictEqual(r.messages.length, 1);
	});

	it('should return an empty message list for a base with no message headers', function () {
		var shdPath = writeTmp('empty.shd', buildStatusHeader({ totalMsgs: 0 }));
		var sdtPath = writeTmp('empty.sdt', buildSdt(256, []));

		var r = parseSMB(shdPath, sdtPath, null);
		assert.strictEqual(r.status, true);
		assert.strictEqual(r.messages.length, 0);
	});

	it('should resume scanning past a block that holds no valid header', function () {
		// A junk block between the status header and the real message forces the
		// scanner through its skip-to-next-block path (smbParser.js:304).
		var junk = Buffer.alloc(BLOCK, 0x2E);
		var hdr = buildMsgHeader({
			number: 1,
			dataOffset: 2,
			hfields: [{ type: HFIELD.SUBJECT, data: 'After junk' }],
		});
		var shd = Buffer.concat([buildStatusHeader({ totalMsgs: 1 }), junk, hdr]);

		var shdPath = writeTmp('junk.shd', shd);
		var sdtPath = writeTmp('junk.sdt', buildSdt(2048, []));

		var r = parseSMB(shdPath, sdtPath, null);
		assert.strictEqual(r.messages.length, 1);
		assert.strictEqual(r.messages[0].header.subject, 'After junk');
	});

	it('should start the sequential scan at the declared header offset', function () {
		// headerOffset 512 means the scan skips the block at 256 entirely
		var skipped = buildMsgHeader({ number: 1, hfields: [{ type: HFIELD.SUBJECT, data: 'Before offset' }] });
		var wanted = buildMsgHeader({ number: 2, hfields: [{ type: HFIELD.SUBJECT, data: 'At offset' }] });
		var shd = Buffer.concat([buildStatusHeader({ headerOffset: 512 }), skipped, wanted]);

		var shdPath = writeTmp('hdroff.shd', shd);
		var sdtPath = writeTmp('hdroff.sdt', buildSdt(1024, []));

		var r = parseSMB(shdPath, sdtPath, null);
		assert.strictEqual(r.messages.length, 1);
		assert.strictEqual(r.messages[0].header.subject, 'At offset');
	});
});

// ---------------------------------------------------------------------------
// previewSMB
// ---------------------------------------------------------------------------

describe('previewSMB', function () {

	afterEach(function () {
		cleanupTmp();
	});

	it('should propagate a parse error', function () {
		var base = buildSimpleBase({});
		var sdtPath = writeTmp('preview-err.sdt', base.sdt);
		var r = previewSMB(path.join(TMP_DIR, 'nope.shd'), sdtPath, null);
		assert.strictEqual(r.status, false);
		assert.ok(/Header file not found/.test(r.error));
	});

	it('should report the message count and first/last subjects', function () {
		var headers = [
			buildMsgHeader({ number: 1, whenWrittenTime: 1600000000, hfields: [{ type: HFIELD.SUBJECT, data: 'Oldest' }] }),
			buildMsgHeader({ number: 2, whenWrittenTime: 1650000000, hfields: [{ type: HFIELD.SUBJECT, data: 'Middle' }] }),
			buildMsgHeader({ number: 3, whenWrittenTime: 1700000000, hfields: [{ type: HFIELD.SUBJECT, data: 'Newest' }] }),
		];
		var shd = Buffer.concat([buildStatusHeader({ totalMsgs: 3 })].concat(headers));

		var shdPath = writeTmp('preview.shd', shd);
		var sdtPath = writeTmp('preview.sdt', buildSdt(2048, []));

		var r = previewSMB(shdPath, sdtPath, null);
		assert.strictEqual(r.status, true);
		assert.strictEqual(r.totalMsgs, 3);
		assert.strictEqual(r.firstSubject, 'Oldest');
		assert.strictEqual(r.lastSubject, 'Newest');
		assert.strictEqual(r.dateRange.first.getTime(), 1600000000 * 1000);
		assert.strictEqual(r.dateRange.last.getTime(), 1700000000 * 1000);
	});

	it('should return a null date range for an empty base', function () {
		var shdPath = writeTmp('preview-empty.shd', buildStatusHeader({ totalMsgs: 0 }));
		var sdtPath = writeTmp('preview-empty.sdt', buildSdt(256, []));

		var r = previewSMB(shdPath, sdtPath, null);
		assert.strictEqual(r.status, true);
		assert.strictEqual(r.totalMsgs, 0);
		assert.strictEqual(r.dateRange, null);
	});

	it('should expose the status header alongside the preview stats', function () {
		var base = buildSimpleBase({});
		var shdPath = writeTmp('preview-status.shd', base.shd);
		var sdtPath = writeTmp('preview-status.sdt', base.sdt);

		var r = previewSMB(shdPath, sdtPath, null);
		assert.ok(r.statusHeader);
		assert.strictEqual(r.statusHeader.totalMsgs, 1);
	});
});

// ---------------------------------------------------------------------------
// Known gap: text is decoded as UTF-8, not CP437
// ---------------------------------------------------------------------------

describe('smbParser CP437 handling (known gap)', function () {

	afterEach(function () {
		cleanupTmp();
	});

	// smbParser.js:167 and :214 both call toString('utf8') on bytes that are
	// CP437 in practice, so high-bit characters do not survive. This test pins
	// the current behaviour so the change is visible when the JAM work
	// introduces a latin1 read plus codepageConversions. If this test starts
	// failing because extended characters now decode correctly, update it
	// rather than reverting the parser.
	it('should currently mangle high-bit CP437 bytes in the body', function () {
		var raw = Buffer.from([0xC9, 0xCD, 0xBB]); // CP437 box drawing
		var sdt = Buffer.alloc(1024, 0);
		raw.copy(sdt, BLOCK);

		var hdr = {
			dataOffset: 1,
			dfields: [{ type: DFIELD.TEXT_BODY, offset: 0, length: raw.length }],
		};
		var text = extractMessageText(sdt, hdr, BLOCK);

		// Decoded as UTF-8 these are invalid sequences, so they become U+FFFD
		assert.notStrictEqual(text.body, '╔═╗');
		assert.ok(text.body.indexOf('�') >= 0);
	});
});

// ---------------------------------------------------------------------------
// Streaming iterator
// ---------------------------------------------------------------------------

describe('iterateSMB', function () {

	afterEach(function () {
		cleanupTmp();
	});

	function fdCount() {
		try { return fs.readdirSync('/proc/self/fd').length; } catch (e) { return -1; }
	}

	it('yields the same messages parseSMB collects', function () {
		var base = buildSimpleBase({});
		var shdPath = writeTmp('iter.shd', base.shd);
		var sdtPath = writeTmp('iter.sdt', base.sdt);

		var streamed = [];
		for (var m of iterateSMB(shdPath, sdtPath, null)) streamed.push(m);
		var collected = parseSMB(shdPath, sdtPath, null).messages;

		assert.strictEqual(streamed.length, collected.length);
		assert.strictEqual(streamed[0].bodyText, collected[0].bodyText);
		assert.strictEqual(streamed[0].tailText, collected[0].tailText);
		assert.strictEqual(streamed[0].header.subject, collected[0].header.subject);
	});

	it('matches parseSMB across a multi-message base', function () {
		var bodies = ['first message', 'second message', 'third message'];
		var headers = [];
		var placements = [];
		for (var i = 0; i < bodies.length; i++) {
			headers.push(buildMsgHeader({
				number: i + 1,
				dataOffset: i + 1,
				dfields: [{ type: DFIELD.TEXT_BODY, offset: 0, length: bodies[i].length }],
				hfields: [{ type: HFIELD.SUBJECT, data: 'Subject ' + (i + 1) }],
			}));
			placements.push({ at: (i + 1) * BLOCK, text: bodies[i] });
		}

		var shdPath = writeTmp('multi.shd', Buffer.concat([buildStatusHeader({ totalMsgs: 3 })].concat(headers)));
		var sdtPath = writeTmp('multi.sdt', buildSdt(2048, placements));

		var streamed = [];
		for (var m of iterateSMB(shdPath, sdtPath, null)) streamed.push(m);
		var collected = parseSMB(shdPath, sdtPath, null).messages;

		assert.deepStrictEqual(
			streamed.map(function (x) { return x.header.subject + ':' + x.bodyText; }),
			collected.map(function (x) { return x.header.subject + ':' + x.bodyText; })
		);
	});

	it('matches parseSMB when guided by an index file', function () {
		var base = buildSimpleBase({});
		var shdPath = writeTmp('idx.shd', base.shd);
		var sdtPath = writeTmp('idx.sdt', base.sdt);
		var sidPath = writeTmp('idx.sid', buildIndexRecord({ offset: BLOCK, number: 1 }));

		var streamed = [];
		for (var m of iterateSMB(shdPath, sdtPath, sidPath)) streamed.push(m);
		var collected = parseSMB(shdPath, sdtPath, sidPath).messages;

		assert.strictEqual(streamed.length, collected.length);
		assert.strictEqual(streamed[0].bodyText, collected[0].bodyText);
	});

	it('separates body and tail the same way as the buffered path', function () {
		var base = buildSimpleBase({});
		var shdPath = writeTmp('bt.shd', base.shd);
		var sdtPath = writeTmp('bt.sdt', base.sdt);

		var streamed = [];
		for (var m of iterateSMB(shdPath, sdtPath, null)) streamed.push(m);
		assert.strictEqual(streamed[0].bodyText, base.body);
		assert.strictEqual(streamed[0].tailText, base.tail);
	});

	it('throws rather than returning a result object on a missing header', function () {
		assert.throws(function () {
			for (var m of iterateSMB(path.join(TMP_DIR, 'nope.shd'), path.join(TMP_DIR, 'nope.sdt'), null)) { void m; }
		}, /Header file not found/);
	});

	it('closes the data file descriptor when fully consumed', function () {
		var base = buildSimpleBase({});
		var shdPath = writeTmp('fd1.shd', base.shd);
		var sdtPath = writeTmp('fd1.sdt', base.sdt);

		var before = fdCount();
		for (var i = 0; i < 25; i++) {
			for (var m of iterateSMB(shdPath, sdtPath, null)) { void m; }
		}
		assert.ok(fdCount() <= before + 2, 'descriptors leaked');
	});

	it('closes the data file descriptor when the consumer stops early', function () {
		var bodies = ['aaa', 'bbb'];
		var headers = [];
		var placements = [];
		for (var i = 0; i < bodies.length; i++) {
			headers.push(buildMsgHeader({
				number: i + 1, dataOffset: i + 1,
				dfields: [{ type: DFIELD.TEXT_BODY, offset: 0, length: 3 }],
			}));
			placements.push({ at: (i + 1) * BLOCK, text: bodies[i] });
		}
		var shdPath = writeTmp('fd2.shd', Buffer.concat([buildStatusHeader({})].concat(headers)));
		var sdtPath = writeTmp('fd2.sdt', buildSdt(1024, placements));

		var before = fdCount();
		for (var j = 0; j < 25; j++) {
			for (var m of iterateSMB(shdPath, sdtPath, null)) { void m; break; }
		}
		assert.ok(fdCount() <= before + 2, 'descriptors leaked on early break');
	});

	it('does not open the data file in headersOnly mode', function () {
		var base = buildSimpleBase({});
		var shdPath = writeTmp('ho.shd', base.shd);
		var sdtPath = writeTmp('ho.sdt', Buffer.alloc(0));

		var seen = [];
		for (var m of iterateSMB(shdPath, sdtPath, null, { headersOnly: true })) seen.push(m);
		assert.strictEqual(seen.length, 1);
		assert.strictEqual(seen[0].bodyText, '');
		assert.strictEqual(seen[0].header.subject, 'Test subject');
	});
});
