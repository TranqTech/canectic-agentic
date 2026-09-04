// jamParser.js - JAM (Joaquim-Andrew-Mats) message base binary parser.
//
// Parses .jhr (fixed info block, then per-message headers with subfields) and
// .jdt (message text). Optionally uses .jdx (index) to locate headers.
//
// Struct layout per the JAM(mbp) specification (JAM.H):
//
//   JAMHDRINFO   1024 bytes at the start of .jhr
//     0   Signature[4]   "JAM\0"
//     4   DateCreated    u32
//     8   ModCounter     u32
//     12  ActiveMsgs     u32
//     16  PasswordCRC    u32
//     20  BaseMsgNum     u32
//     24  RSRVD[1000]
//
//   JAMHDR       76 bytes, immediately followed by SubfieldLen bytes of subfields
//     0   Signature[4]   "JAM\0"
//     4   Revision       u16
//     6   ReservedWord   u16
//     8   SubfieldLen    u32
//     12  TimesRead      u32
//     16  MsgIdCRC       u32
//     20  ReplyCRC       u32
//     24  ReplyTo        u32
//     28  Reply1st       u32
//     32  ReplyNext      u32
//     36  DateWritten    u32
//     40  DateReceived   u32
//     44  DateProcessed  u32
//     48  MsgNum         u32
//     52  Attribute      u32
//     56  Attribute2     u32
//     60  TxtOffset      u32
//     64  TxtLen         u32
//     68  PasswordCRC    u32
//     72  Cost           u32
//
//   JAMSUBFIELD  LoID u16, HiID u16, DatLen u32, then DatLen bytes
//   JAMIDXREC    8 bytes: UserCRC u32, HdrOffset u32
//
// Two differences from smbParser.js worth knowing:
//
//  1. JAM stores the whole message as one text blob in .jdt, with no
//     body/tail split. tailText is therefore always empty here, and
//     separating kludges, body and origin line is left to the import adapter.
//  2. Text and subfield data are decoded as CP437 rather than UTF-8, since
//     that is what Fido-era bases actually contain.

import { readFileSync, existsSync, openSync, readSync, closeSync, fstatSync } from 'fs';
import { cp437BufferToUtf8 } from './codepageConversions.js';

// --- Constants ---

var JAM_SIGNATURE = Buffer.from([0x4A, 0x41, 0x4D, 0x00]); // "JAM\0"

var HDRINFO_SIZE         = 1024;
var MSGHDR_FIXED_SIZE    = 76;
var IDXREC_SIZE          = 8;
var SUBFIELD_PREFIX_SIZE = 8;

// Index slots for deleted or never-used messages carry this offset
var EMPTY_OFFSET = 0xFFFFFFFF;

// Subfield identifiers (LoID)
var SUBFIELD = {
	OADDRESS:    0,
	DADDRESS:    1,
	SENDERNAME:  2,
	RECVRNAME:   3,
	MSGID:       4,
	REPLYID:     5,
	SUBJECT:     6,
	PID:         7,
	TRACE:       8,
	ENCLFILE:    9,
	ENCLFWALIAS: 10,
	ENCLFREQ:    11,
	ENCLFILEWC:  12,
	ENCLINDFILE: 13,
	EMBINDAT:    1000,
	FTSKLUDGE:   2000,
	SEENBY2D:    2001,
	PATH2D:      2002,
	FLAGS:       2003,
	TZUTCINFO:   2004,
	UNKNOWN:     0xFFFF,
};

// Message attribute bits. Note these are 32-bit and DELETED is the sign bit,
// so always test with hasAttr() rather than a bare truthiness check.
var MSG_ATTR = {
	LOCAL:       0x00000001,
	INTRANSIT:   0x00000002,
	PRIVATE:     0x00000004,
	READ:        0x00000008,
	SENT:        0x00000010,
	KILLSENT:    0x00000020,
	ARCHIVESENT: 0x00000040,
	HOLD:        0x00000080,
	CRASH:       0x00000100,
	IMMEDIATE:   0x00000200,
	DIRECT:      0x00000400,
	GATE:        0x00000800,
	FILEREQUEST: 0x00001000,
	FILEATTACH:  0x00002000,
	TRUNCFILE:   0x00004000,
	KILLFILE:    0x00008000,
	RECEIPTREQ:  0x00010000,
	CONFIRMREQ:  0x00020000,
	ORPHAN:      0x00040000,
	ENCRYPT:     0x00080000,
	COMPRESS:    0x00100000,
	ESCAPED:     0x00200000,
	FPU:         0x00400000,
	TYPELOCAL:   0x00800000,
	TYPEECHO:    0x01000000,
	TYPENET:     0x02000000,
	NODISP:      0x20000000,
	LOCKED:      0x40000000,
	DELETED:     0x80000000,
};

// --- Read helpers (little-endian) ---

function readU16(buf, offset) {
	return buf.readUInt16LE(offset);
}

function readU32(buf, offset) {
	return buf.readUInt32LE(offset);
}

// JS bitwise operands are coerced to signed 32-bit, so 0x80000000 becomes
// negative. Comparing against 0 keeps the test correct for every flag.
function hasAttr(attribute, flag) {
	return ((attribute & flag) >>> 0) !== 0;
}

// JAM bases are CP437 in practice. Decode explicitly rather than letting
// Buffer.toString('utf8') replace every high-bit byte with U+FFFD.
function decodeText(buf) {
	return cp437BufferToUtf8(buf);
}

// --- Parse the fixed info block at the start of .jhr ---

function parseHeaderInfo(jhrBuf) {
	if (jhrBuf.length < HDRINFO_SIZE) return null;
	if (!jhrBuf.subarray(0, 4).equals(JAM_SIGNATURE)) return null;

	return {
		dateCreated: readU32(jhrBuf, 4),
		modCounter:  readU32(jhrBuf, 8),
		activeMsgs:  readU32(jhrBuf, 12),
		passwordCRC: readU32(jhrBuf, 16),
		baseMsgNum:  readU32(jhrBuf, 20),
	};
}

// --- Parse the subfield block that follows a message header ---

function parseSubfields(jhrBuf, start, length) {
	var fields = [];
	var pos = start;
	var end = start + length;
	if (end > jhrBuf.length) end = jhrBuf.length;

	while (pos + SUBFIELD_PREFIX_SIZE <= end) {
		var loID   = readU16(jhrBuf, pos);
		var hiID   = readU16(jhrBuf, pos + 2);
		var datLen = readU32(jhrBuf, pos + 4);
		pos += SUBFIELD_PREFIX_SIZE;

		// A length that runs past the declared block means the subfield area
		// is truncated or corrupt; take what we have and stop.
		if (datLen > end - pos) break;

		fields.push({
			loID: loID,
			hiID: hiID,
			data: decodeText(jhrBuf.subarray(pos, pos + datLen)),
		});
		pos += datLen;
	}

	return fields;
}

// --- Parse a single message header plus its subfields ---

function parseMsgHeader(jhrBuf, offset) {
	if (offset < 0 || offset + MSGHDR_FIXED_SIZE > jhrBuf.length) return null;
	if (!jhrBuf.subarray(offset, offset + 4).equals(JAM_SIGNATURE)) return null;

	var hdr = {
		revision:      readU16(jhrBuf, offset + 4),
		reservedWord:  readU16(jhrBuf, offset + 6),
		subfieldLen:   readU32(jhrBuf, offset + 8),
		timesRead:     readU32(jhrBuf, offset + 12),
		msgIdCRC:      readU32(jhrBuf, offset + 16),
		replyCRC:      readU32(jhrBuf, offset + 20),
		replyTo:       readU32(jhrBuf, offset + 24),
		reply1st:      readU32(jhrBuf, offset + 28),
		replyNext:     readU32(jhrBuf, offset + 32),
		dateWritten:   readU32(jhrBuf, offset + 36),
		dateReceived:  readU32(jhrBuf, offset + 40),
		dateProcessed: readU32(jhrBuf, offset + 44),
		number:        readU32(jhrBuf, offset + 48),
		attribute:     readU32(jhrBuf, offset + 52),
		attribute2:    readU32(jhrBuf, offset + 56),
		txtOffset:     readU32(jhrBuf, offset + 60),
		txtLen:        readU32(jhrBuf, offset + 64),
		passwordCRC:   readU32(jhrBuf, offset + 68),
		cost:          readU32(jhrBuf, offset + 72),

		// Raw subfields, kept so callers can reach anything not extracted below
		subfields: [],

		// Extracted values, named to line up with the SMB parser's header shape
		sender:        '',
		senderAddr:    '',
		recipient:     '',
		recipientAddr: '',
		subject:       '',
		msgId:         '',
		replyId:       '',
		pid:           '',
		seenBy:        '',
		path:          '',
		tzUtc:         '',
		flags:         '',
		kludges:       [],
	};

	hdr.subfields = parseSubfields(jhrBuf, offset + MSGHDR_FIXED_SIZE, hdr.subfieldLen);

	for (var i = 0; i < hdr.subfields.length; i++) {
		var sf = hdr.subfields[i];

		// HiID is reserved and zero in every known implementation. A non-zero
		// HiID means an ID space we do not understand, so leave those in the
		// raw subfield list only.
		if (sf.hiID !== 0) continue;

		switch (sf.loID) {
			case SUBFIELD.SENDERNAME: hdr.sender        = sf.data; break;
			case SUBFIELD.RECVRNAME:  hdr.recipient     = sf.data; break;
			case SUBFIELD.OADDRESS:   hdr.senderAddr    = sf.data; break;
			case SUBFIELD.DADDRESS:   hdr.recipientAddr = sf.data; break;
			case SUBFIELD.SUBJECT:    hdr.subject       = sf.data; break;
			case SUBFIELD.MSGID:      hdr.msgId         = sf.data; break;
			case SUBFIELD.REPLYID:    hdr.replyId       = sf.data; break;
			case SUBFIELD.PID:        hdr.pid           = sf.data; break;
			case SUBFIELD.TZUTCINFO:  hdr.tzUtc         = sf.data; break;
			case SUBFIELD.FLAGS:      hdr.flags         = sf.data; break;
			case SUBFIELD.SEENBY2D:   hdr.seenBy       += (hdr.seenBy ? '\r\n' : '') + sf.data; break;
			case SUBFIELD.PATH2D:     hdr.path         += (hdr.path   ? '\r\n' : '') + sf.data; break;
			case SUBFIELD.FTSKLUDGE:  hdr.kludges.push(sf.data); break;
		}
	}

	return hdr;
}

// --- Extract message text from .jdt ---

function extractMessageText(jdtBuf, msgHeader) {
	var start = msgHeader.txtOffset;
	var len   = msgHeader.txtLen;

	if (!len || start >= jdtBuf.length) return '';
	if (start + len > jdtBuf.length) len = jdtBuf.length - start;

	return decodeText(jdtBuf.subarray(start, start + len));
}

// Same, but reading from an open .jdt descriptor instead of a resident buffer.
// A hub's larger echoes have text files far too big to hold in memory
// alongside every decoded message, so the streaming path reads only the bytes
// each message actually needs.
function readMessageText(fd, fileSize, msgHeader) {
	var start = msgHeader.txtOffset;
	var len   = msgHeader.txtLen;

	if (!len || start >= fileSize) return '';
	if (start + len > fileSize) len = fileSize - start;
	if (len <= 0) return '';

	var buf = Buffer.alloc(len);
	var got = readSync(fd, buf, 0, len, start);
	if (got <= 0) return '';

	return decodeText(got === len ? buf : buf.subarray(0, got));
}

// --- Parse index file (.jdx) ---

function parseIndex(jdxBuf) {
	var records = [];
	var count = Math.floor(jdxBuf.length / IDXREC_SIZE);

	for (var i = 0; i < count; i++) {
		var off = i * IDXREC_SIZE;
		records.push({
			userCRC:   readU32(jdxBuf, off),
			hdrOffset: readU32(jdxBuf, off + 4),
		});
	}

	return records;
}

// --- Streaming parse ---
//
// iterateJAM yields one { header, bodyText, tailText } at a time and never
// holds more than a single decoded message. The .jhr stays resident because
// headers must be walked or indexed, but the .jdt is read through a file
// descriptor a message at a time: on a hub's larger echoes that file is far
// too big to hold alongside every decoded body, and doing so exhausted the
// worker's heap.
//
// tailText is always '' to match the SMB parser's contract, so both formats
// feed the same import loop.
//
// options.headersOnly skips text reads entirely, for cheap previews.
//
// Throws on a missing or invalid header file. Callers that want a result
// object instead should use parseJAM.

function* iterateJAM(jhrPath, jdtPath, jdxPath, options) {
	var opts = options || {};

	if (!existsSync(jhrPath)) throw new Error('Header file not found: ' + jhrPath);
	if (!existsSync(jdtPath)) throw new Error('Text file not found: ' + jdtPath);

	var jhrBuf = readFileSync(jhrPath);
	var info = parseHeaderInfo(jhrBuf);
	if (!info) throw new Error('Invalid JAM header file (bad signature or too small)');

	var wantText = !opts.headersOnly;
	var fd = null;
	var fileSize = 0;

	if (wantText) {
		fd = openSync(jdtPath, 'r');
		try {
			fileSize = fstatSync(fd).size;
		} catch (err) {
			closeSync(fd);
			throw err;
		}
	}

	function build(hdr) {
		return {
			header:   hdr,
			bodyText: wantText ? readMessageText(fd, fileSize, hdr) : '',
			tailText: '',
		};
	}

	try {
		// Index-guided walk when a usable .jdx is present
		var offsets = [];
		if (jdxPath && existsSync(jdxPath)) {
			var idxRecords = parseIndex(readFileSync(jdxPath));
			for (var r = 0; r < idxRecords.length; r++) {
				if (idxRecords[r].hdrOffset === EMPTY_OFFSET) continue;
				offsets.push(idxRecords[r].hdrOffset);
			}
		}

		if (offsets.length > 0) {
			for (var o = 0; o < offsets.length; o++) {
				var ihdr = parseMsgHeader(jhrBuf, offsets[o]);
				if (!ihdr) continue;
				if (hasAttr(ihdr.attribute, MSG_ATTR.DELETED)) continue;
				yield build(ihdr);
			}
		} else {
			// Sequential walk. Headers are packed contiguously with their
			// subfields, so each step is 76 + SubfieldLen. If a header fails to
			// validate the base is damaged, so resync on the next signature
			// rather than abandoning the remaining messages.
			var pos = HDRINFO_SIZE;
			while (pos + MSGHDR_FIXED_SIZE <= jhrBuf.length) {
				var hdr = parseMsgHeader(jhrBuf, pos);

				if (!hdr) {
					var next = jhrBuf.indexOf(JAM_SIGNATURE, pos + 1);
					if (next === -1) break;
					pos = next;
					continue;
				}

				if (!hasAttr(hdr.attribute, MSG_ATTR.DELETED)) {
					yield build(hdr);
				}

				pos += MSGHDR_FIXED_SIZE + hdr.subfieldLen;
			}
		}
	} finally {
		// Runs on early return from the consumer too, so an importer that
		// stops partway does not leak the descriptor.
		if (fd !== null) {
			try { closeSync(fd); } catch (_) { /* already closed */ }
		}
	}
}

// Read just the fixed info block, without walking any messages.
function readHeaderInfo(jhrPath) {
	if (!existsSync(jhrPath)) return null;
	var buf = readFileSync(jhrPath);
	return parseHeaderInfo(buf);
}

// --- Collecting parse ---
// Returns { status, messages[], headerInfo, error }
//
// Materialises every message, so it is only appropriate for small bases and
// tests. Importers should use iterateJAM.

function parseJAM(jhrPath, jdtPath, jdxPath, options) {
	var result = { status: false, messages: [], headerInfo: null, error: null };

	try {
		result.headerInfo = readHeaderInfo(jhrPath);
		for (var msg of iterateJAM(jhrPath, jdtPath, jdxPath, options)) {
			result.messages.push(msg);
		}
	} catch (err) {
		result.error = err.message;
		return result;
	}

	result.status = true;
	return result;
}

// --- Preview (message count and date range, no text extraction) ---

function previewJAM(jhrPath, jdtPath, jdxPath) {
	var result = {
		status: false,
		totalMsgs: 0,
		dateRange: null,
		firstSubject: '',
		lastSubject: '',
		headerInfo: null,
		error: null,
	};

	// Stream and keep only the first and last headers. Collecting every
	// message just to read both ends would defeat the point on a large base.
	var first = null;
	var last  = null;
	var count = 0;

	try {
		result.headerInfo = readHeaderInfo(jhrPath);
		for (var msg of iterateJAM(jhrPath, jdtPath, jdxPath, { headersOnly: true })) {
			if (!first) first = msg.header;
			last = msg.header;
			count++;
		}
	} catch (err) {
		result.error = err.message;
		return result;
	}

	result.status    = true;
	result.totalMsgs = count;

	if (first) {
		result.firstSubject = first.subject;
		result.lastSubject  = last.subject;
		result.dateRange = {
			first: new Date(first.dateWritten * 1000),
			last:  new Date(last.dateWritten * 1000),
		};
	}

	return result;
}

// --- Cheap stat: read only the fixed info block ---
//
// The info block carries ActiveMsgs, so listing a whole directory of message
// bases does not need a full parse of each one.

function statJAM(jhrPath) {
	var result = { status: false, totalMsgs: 0, baseMsgNum: 0, error: null };

	if (!existsSync(jhrPath)) {
		result.error = 'Header file not found: ' + jhrPath;
		return result;
	}

	var buf = Buffer.alloc(HDRINFO_SIZE);
	var bytesRead = 0;
	var fd;
	try {
		fd = openSync(jhrPath, 'r');
		bytesRead = readSync(fd, buf, 0, HDRINFO_SIZE, 0);
	} catch (err) {
		result.error = 'Could not read header: ' + err.message;
		return result;
	} finally {
		if (fd !== undefined) {
			try { closeSync(fd); } catch (_) { /* already closed */ }
		}
	}

	// Only hand over the bytes actually read. The buffer is pre-zeroed, so
	// passing the whole allocation would make a truncated file look like a
	// valid info block with a matching signature and zero counts.
	var info = parseHeaderInfo(buf.subarray(0, bytesRead));
	if (!info) {
		result.error = 'Invalid JAM header file (bad signature or too small)';
		return result;
	}

	result.status     = true;
	result.totalMsgs  = info.activeMsgs;
	result.baseMsgNum = info.baseMsgNum;
	return result;
}

export {
	iterateJAM,
	parseJAM,
	readHeaderInfo,
	previewJAM,
	statJAM,
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
	IDXREC_SIZE,
};
