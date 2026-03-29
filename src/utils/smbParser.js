// smbParser.js - Synchronet Message Base (SMB) binary file parser.
//
// Parses .shd (headers) and .sdt (data/text) files to extract messages.
// Optionally uses .sid (index) for faster lookups.
//
// Reference: https://www.synchro.net/docs/smb.html

import { readFileSync, existsSync } from 'fs';

// --- Constants ---

// Magic identifiers
var SHD_MAGIC = Buffer.from([0x53, 0x4D, 0x42, 0x1A]); // "SMB\x1A"
var MSG_MAGIC = Buffer.from([0x53, 0x48, 0x44, 0x1A]); // "SHD\x1A"

// Header field types
var HFIELD = {
	SENDER:          0x00,
	SENDERNETADDR:   0x03,
	SENDERORG:       0x06,
	RECIPIENT:       0x30,
	RECIPIENTNETADDR:0x33,
	SUBJECT:         0x60,
	FIDOCTRL:        0xA0,
	FIDOAREA:        0xA1,
	FIDOSEENBY:      0xA2,
	FIDOPATH:        0xA3,
	FIDOMSGID:       0xA4,
	FIDOREPLYID:     0xA5,
	FIDOPID:         0xA6,
	FIDOFLAGS:       0xA7,
	RFC822MSGID:     0xB1,
	RFC822REPLYID:   0xB2,
};

// Data field types
var DFIELD = {
	TEXT_BODY: 0x00,
	TEXT_SOUL: 0x01,
	TEXT_TAIL: 0x02,
	TEXT_WING: 0x03,
};

// Message attribute flags
var MSG_ATTR = {
	PRIVATE:   0x0001,
	READ:      0x0002,
	PERMANENT: 0x0004,
	LOCKED:    0x0008,
	DELETE:    0x0010,
	ANONYMOUS: 0x0020,
	KILLREAD:  0x0040,
	MODERATED: 0x0080,
	VALIDATED: 0x0100,
};

// Fixed header size
var MSGHDR_FIXED_SIZE = 74;

// --- Read helpers (little-endian) ---

function readU16(buf, offset) {
	return buf.readUInt16LE(offset);
}

function readU32(buf, offset) {
	return buf.readUInt32LE(offset);
}

function readWhen(buf, offset) {
	var time = readU32(buf, offset);
	var zone = readU16(buf, offset + 4);
	return { time: time, zone: zone };
}

// --- Parse the SMB status header (first block of .shd) ---

function parseStatusHeader(shdBuf) {
	if (shdBuf.length < 32) return null;

	// Check magic
	if (!shdBuf.subarray(0, 4).equals(SHD_MAGIC)) {
		return null;
	}

	return {
		version:       readU16(shdBuf, 4),
		length:        readU16(shdBuf, 6),
		lastMsg:       readU32(shdBuf, 8),
		totalMsgs:     readU32(shdBuf, 12),
		headerOffset:  readU32(shdBuf, 16),
		maxCrcs:       readU32(shdBuf, 20),
		maxMsgs:       readU32(shdBuf, 24),
		maxAge:        readU16(shdBuf, 28),
		attr:          readU16(shdBuf, 30),
	};
}

// --- Parse a single message header ---

function parseMsgHeader(shdBuf, offset) {
	if (offset + MSGHDR_FIXED_SIZE > shdBuf.length) return null;

	// Check magic
	var magic = shdBuf.subarray(offset, offset + 4);
	if (!magic.equals(MSG_MAGIC)) return null;

	var hdr = {
		type:          readU16(shdBuf, offset + 4),
		version:       readU16(shdBuf, offset + 6),
		length:        readU16(shdBuf, offset + 8),
		attr:          readU16(shdBuf, offset + 10),
		auxattr:       readU32(shdBuf, offset + 12),
		netattr:       readU32(shdBuf, offset + 16),
		whenWritten:   readWhen(shdBuf, offset + 20),
		whenImported:  readWhen(shdBuf, offset + 26),
		number:        readU32(shdBuf, offset + 36),
		threadOrig:    readU32(shdBuf, offset + 40),
		threadNext:    readU32(shdBuf, offset + 44),
		threadFirst:   readU32(shdBuf, offset + 48),
		dataOffset:    readU32(shdBuf, offset + 68),
		totalDfields:  readU16(shdBuf, offset + 72),
		// Parsed fields
		hfields:       [],
		dfields:       [],
		// Extracted values
		sender:        '',
		senderAddr:    '',
		recipient:     '',
		recipientAddr: '',
		subject:       '',
		msgId:         '',
		replyId:       '',
		fidoPid:       '',
		fidoArea:      '',
		fidoSeenBy:    '',
		fidoPath:      '',
		fidoCtrl:      [],
	};

	// Parse variable header fields
	var pos = offset + MSGHDR_FIXED_SIZE;
	var hdrEnd = offset + hdr.length;

	// Header fields come first, then data fields
	// Data fields are at the end: totalDfields * 10 bytes
	var dfieldBytes = hdr.totalDfields * 10;
	var hfieldEnd = hdrEnd - dfieldBytes;

	while (pos < hfieldEnd && pos + 4 <= shdBuf.length) {
		var ftype = readU16(shdBuf, pos);
		var flen = readU16(shdBuf, pos + 2);
		pos += 4;

		if (pos + flen > shdBuf.length) break;

		var fdata = shdBuf.subarray(pos, pos + flen).toString('binary');
		// Strip null terminators
		fdata = fdata.replace(/\x00+$/, '');

		hdr.hfields.push({ type: ftype, data: fdata });

		// Extract known fields
		switch (ftype) {
			case HFIELD.SENDER:          hdr.sender = fdata; break;
			case HFIELD.SENDERNETADDR:   hdr.senderAddr = fdata; break;
			case HFIELD.RECIPIENT:       hdr.recipient = fdata; break;
			case HFIELD.RECIPIENTNETADDR:hdr.recipientAddr = fdata; break;
			case HFIELD.SUBJECT:         hdr.subject = fdata; break;
			case HFIELD.FIDOMSGID:       hdr.msgId = fdata; break;
			case HFIELD.FIDOREPLYID:     hdr.replyId = fdata; break;
			case HFIELD.FIDOPID:         hdr.fidoPid = fdata; break;
			case HFIELD.FIDOAREA:        hdr.fidoArea = fdata; break;
			case HFIELD.FIDOSEENBY:      hdr.fidoSeenBy += (hdr.fidoSeenBy ? '\r\n' : '') + fdata; break;
			case HFIELD.FIDOPATH:        hdr.fidoPath += (hdr.fidoPath ? '\r\n' : '') + fdata; break;
			case HFIELD.FIDOCTRL:        hdr.fidoCtrl.push(fdata); break;
		}

		pos += flen;
	}

	// Parse data field descriptors
	var dfieldPos = hfieldEnd;
	for (var di = 0; di < hdr.totalDfields; di++) {
		if (dfieldPos + 10 > shdBuf.length) break;
		hdr.dfields.push({
			type:   readU16(shdBuf, dfieldPos),
			offset: readU32(shdBuf, dfieldPos + 2),
			length: readU32(shdBuf, dfieldPos + 6),
		});
		dfieldPos += 10;
	}

	return hdr;
}

// --- Extract message text from .sdt ---

function extractMessageText(sdtBuf, msgHeader) {
	var bodyText = '';
	var tailText = '';

	for (var df of msgHeader.dfields) {
		var physOffset = msgHeader.dataOffset + df.offset;
		if (physOffset + df.length > sdtBuf.length) continue;

		var raw = sdtBuf.subarray(physOffset, physOffset + df.length);
		// Strip null terminators and trailing whitespace
		var text = raw.toString('binary').replace(/\x00+$/, '');

		if (df.type === DFIELD.TEXT_BODY) {
			bodyText += text;
		} else if (df.type === DFIELD.TEXT_TAIL) {
			tailText += text;
		}
	}

	return { body: bodyText, tail: tailText };
}

// --- Parse index file (.sid) ---

function parseIndex(sidBuf) {
	var records = [];
	var recSize = 28;
	var count = Math.floor(sidBuf.length / recSize);

	for (var i = 0; i < count; i++) {
		var off = i * recSize;
		records.push({
			to:     readU16(sidBuf, off),
			from:   readU16(sidBuf, off + 2),
			subj:   readU16(sidBuf, off + 4),
			attr:   readU16(sidBuf, off + 6),
			offset: readU32(sidBuf, off + 8),
			number: readU32(sidBuf, off + 12),
			time:   readU32(sidBuf, off + 16),
		});
	}

	return records;
}

// --- Main parse function ---
// Returns { status, messages[], error }

function parseSMB(shdPath, sdtPath, sidPath) {
	var result = { status: false, messages: [], statusHeader: null, error: null };

	if (!existsSync(shdPath)) {
		result.error = 'Header file not found: ' + shdPath;
		return result;
	}
	if (!existsSync(sdtPath)) {
		result.error = 'Data file not found: ' + sdtPath;
		return result;
	}

	var shdBuf = readFileSync(shdPath);
	var sdtBuf = readFileSync(sdtPath);

	// Parse status header
	var status = parseStatusHeader(shdBuf);
	if (!status) {
		result.error = 'Invalid SMB header file (bad magic or too small)';
		return result;
	}
	result.statusHeader = status;

	// Use index file if available for faster scanning
	var indexRecords = null;
	if (sidPath && existsSync(sidPath)) {
		var sidBuf = readFileSync(sidPath);
		indexRecords = parseIndex(sidBuf);
	}

	if (indexRecords && indexRecords.length > 0) {
		// Index-guided parse
		for (var idx of indexRecords) {
			if (idx.attr & MSG_ATTR.DELETE) continue; // Skip deleted
			var hdr = parseMsgHeader(shdBuf, idx.offset);
			if (!hdr) continue;
			if (hdr.attr & MSG_ATTR.DELETE) continue;

			var text = extractMessageText(sdtBuf, hdr);
			result.messages.push({
				header: hdr,
				bodyText: text.body,
				tailText: text.tail,
			});
		}
	} else {
		// Sequential scan from headerOffset
		var scanPos = status.headerOffset || 256;
		while (scanPos < shdBuf.length) {
			var hdr = parseMsgHeader(shdBuf, scanPos);
			if (!hdr) {
				// Skip to next 256-byte block
				scanPos = (Math.floor(scanPos / 256) + 1) * 256;
				continue;
			}

			if (!(hdr.attr & MSG_ATTR.DELETE)) {
				var text = extractMessageText(sdtBuf, hdr);
				result.messages.push({
					header: hdr,
					bodyText: text.body,
					tailText: text.tail,
				});
			}

			// Advance past this header (aligned to 256-byte blocks)
			var hdrBytes = hdr.length;
			var blocksUsed = Math.ceil(hdrBytes / 256);
			scanPos += blocksUsed * 256;
		}
	}

	result.status = true;
	return result;
}

// --- Preview (quick stats without full text extraction) ---

function previewSMB(shdPath, sdtPath, sidPath) {
	var result = { status: false, totalMsgs: 0, dateRange: null, firstSubject: '', lastSubject: '', error: null };

	var parsed = parseSMB(shdPath, sdtPath, sidPath);
	if (!parsed.status) {
		result.error = parsed.error;
		return result;
	}

	result.status = true;
	result.totalMsgs = parsed.messages.length;
	result.statusHeader = parsed.statusHeader;

	if (parsed.messages.length > 0) {
		var first = parsed.messages[0];
		var last = parsed.messages[parsed.messages.length - 1];
		result.firstSubject = first.header.subject;
		result.lastSubject = last.header.subject;

		var firstDate = new Date(first.header.whenWritten.time * 1000);
		var lastDate = new Date(last.header.whenWritten.time * 1000);
		result.dateRange = {
			first: firstDate,
			last: lastDate,
		};
	}

	return result;
}

export {
	parseSMB,
	previewSMB,
	parseStatusHeader,
	parseMsgHeader,
	extractMessageText,
	HFIELD,
	DFIELD,
	MSG_ATTR,
};
