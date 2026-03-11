// qwkClasses.js
// QWK/REP packet parsing and building. Pure functions, no DB access.
//
// Standard QWK message header layout (128 bytes):
//   Offset  Len  Field
//   0       1    Status flag
//   1       7    Message number (ASCII, space-padded)
//   8       8    Date "MM-DD-YY"
//   16      5    Time "HH:MM"
//   21      25   To (space-padded)
//   46      25   From (space-padded)
//   71      25   Subject (space-padded)
//   96      12   Password (space-padded, ignored)
//   108     8    Reference message number (ASCII)
//   116     6    Number of 128-byte blocks (ASCII, includes header)
//   122     1    Active flag (0xE1 = active, 0xE0 = deleted)
//   123     2    Conference number (little-endian uint16)
//   125     2    Logical message number (not used reliably)
//   127     1    Tag line flag (not used)

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import AdmZip from 'adm-zip';
import { cp437ToUtf8, utf8ToCp437 } from '../utils/codepageConversions.js';

const QWK_RECORD_SIZE   = 128;
const QWK_HEADER_BLOCKS = 1;
const QWK_LINE_TERM     = 0xE3;   // cp437 pilcrow — QWK line terminator
const QWK_PAD_BYTE      = 0x20;   // space
const QWK_EOF_BYTE      = 0x1A;   // Ctrl-Z / EOF padding for body blocks

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

// Read an ASCII field from a buffer, trim trailing spaces and nulls.
function readField(buf, offset, length) {
	return buf.subarray(offset, offset + length)
		.toString('ascii')
		.replace(/[\x00\x1A]+$/g, '')
		.trimEnd();
}

// ---------------------------------------------------------------------------
// CONTROL.DAT parser
// ---------------------------------------------------------------------------

// CONTROL.DAT format (line-oriented):
//   Line 0: BBS name
//   Line 1: BBS city/state
//   Line 2: BBS phone number
//   Line 3: Sysop name
//   Line 4: Serial# / board ID (packet name)
//   Line 5: Date/time of packet creation
//   Line 6: Sysop name (again, or blank)
//   Lines 7+: empty or start of conference map
//   Then pairs: conference number, conference name
//   Terminated by HELLO, NEWS, GOODBYE file names (optional)
function parseControlDat(text) {
	var lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

	var result = {
		bbsName:    lines[0] || '',
		bbsCity:    lines[1] || '',
		bbsPhone:   lines[2] || '',
		bbsSysop:   lines[3] || '',
		packetName: (lines[4] || '').trim().toUpperCase(),
		conferences: []
	};

	// Conference listing starts after the header lines.
	// Some implementations put the conference count on a line, then pairs.
	// Others just list pairs until a non-numeric first element.
	// We look for lines that start with a digit as conference number,
	// followed by a name line.
	var i = 10;  // skip past header block — first 10 lines are fixed header
	// but some packets have fewer fixed lines, so find the start dynamically:
	// scan for a line that is purely a number after the initial header
	i = 7;
	while (i < lines.length) {
		var trimmed = lines[i].trim();
		// If the line is a pure integer, it could be the conference count
		// or first conference number. Peek ahead to decide.
		if (/^\d+$/.test(trimmed)) {
			// Check if the NEXT line is also a pure integer (would mean this
			// line is a conference count and the next starts the pairs)
			// Or if next line is a name (conference name for this number)
			if (i + 1 < lines.length) {
				var nextTrimmed = lines[i + 1].trim();
				if (/^\d+$/.test(nextTrimmed)) {
					// This line is probably the conference count — skip it
					i++;
					break;
				} else {
					// This line is a conference number, next is its name
					break;
				}
			}
		}
		i++;
	}

	// Now read conference number/name pairs
	while (i + 1 < lines.length) {
		var numLine  = lines[i].trim();
		var nameLine = lines[i + 1].trim();

		// Stop at special file entries (HELLO, NEWS, GOODBYE, etc.)
		// or non-numeric lines in the number position
		if (!/^\d+$/.test(numLine)) break;

		result.conferences.push({
			number: parseInt(numLine, 10),
			name:   nameLine
		});
		i += 2;
	}

	return result;
}

// ---------------------------------------------------------------------------
// MESSAGES.DAT parser
// ---------------------------------------------------------------------------

// Parses the binary MESSAGES.DAT buffer into an array of message objects.
// The first 128-byte record in the file is the packet header (BBS ID string)
// and is skipped. Messages follow as variable-length runs of 128-byte blocks.
function parseMessagesDAT(buffer) {
	var messages = [];

	if (!buffer || buffer.length < QWK_RECORD_SIZE * 2) {
		return messages;  // need at least header record + one message
	}

	// Skip record 0 — packet header / copyright block
	var offset = QWK_RECORD_SIZE;

	while (offset + QWK_RECORD_SIZE <= buffer.length) {
		var hdr = buffer.subarray(offset, offset + QWK_RECORD_SIZE);

		var status       = String.fromCharCode(hdr[0]);
		var msgNumber    = readField(hdr, 1, 7).trim();
		var date         = readField(hdr, 8, 8);
		var time         = readField(hdr, 16, 5);
		var to           = readField(hdr, 21, 25);
		var from         = readField(hdr, 46, 25);
		var subject      = readField(hdr, 71, 25);
		var password     = readField(hdr, 96, 12);
		var replyRef     = readField(hdr, 108, 8).trim();
		var blocksStr    = readField(hdr, 116, 6).trim();
		var isLiveByte   = hdr[122];
		var conferenceNum = hdr.readUInt16LE(123);

		var blocks = parseInt(blocksStr, 10);
		if (isNaN(blocks) || blocks < 1) {
			// Corrupted record — can't determine size, skip this record
			offset += QWK_RECORD_SIZE;
			continue;
		}

		var totalBytes = blocks * QWK_RECORD_SIZE;
		if (offset + totalBytes > buffer.length) {
			// Truncated message — stop parsing
			break;
		}

		// Active check: 0xE1 and 0x20 (space, common) are live;
		// 0xE0 is deleted. Accept anything except 0xE0 as live.
		var isLive = isLiveByte !== 0xE0;

		// Body: all blocks after the header block
		var bodyBuf = buffer.subarray(
			offset + QWK_RECORD_SIZE,
			offset + totalBytes
		);

		// Decode body: cp437 byte stream, 0xE3 = line terminator
		// Convert raw bytes to a string preserving cp437 values,
		// then strip trailing EOF padding (0x1A / Ctrl-Z) and spaces
		var bodyRaw = bodyBuf.toString('binary')
			.replace(/[\x1A]+$/g, '')
			.trimEnd();

		// Replace QWK line terminators with \r (FTN convention used by the BBS)
		bodyRaw = bodyRaw.replace(/\xE3/g, '\r');

		// rawBody preserves everything (kludge lines, conference headers)
		var rawBody = bodyRaw;

		// Parse @ kludge lines from the start of the body.
		// QWK/FTN kludges: @MSGID, @REPLY, @TZUTC, @TZ, @PID, @VIA, @INTL, etc.
		// Capture them into a structured object, then strip from the clean body.
		var kludges = {};
		var bodyClean = bodyRaw;
		while (bodyClean.startsWith('@')) {
			var lineBreak = bodyClean.indexOf('\r');
			if (lineBreak === -1) {
				// Entire body is a single @ line — leave it
				break;
			}
			var kludgeLine = bodyClean.substring(0, lineBreak).trim();
			bodyClean = bodyClean.substring(lineBreak + 1);

			// Parse "@ KEY: value" or "@KEY value" forms
			var spaceIdx = kludgeLine.indexOf(' ');
			if (spaceIdx > 1) {
				var kKey = kludgeLine.substring(1, spaceIdx)
					.replace(/:$/, '').toUpperCase();
				var kVal = kludgeLine.substring(spaceIdx + 1).trim();
				if (kKey && kVal) {
					// VIA can appear multiple times — collect as array
					if (kKey === 'VIA') {
						if (!kludges.VIA) kludges.VIA = [];
						kludges.VIA.push(kVal);
					} else {
						kludges[kKey] = kVal;
					}
				}
			}
		}

		// Extract origin line from body: " * Origin: ..." at the end
		var originLine = '';
		var originMatch = bodyClean.match(/\r \* Origin: ([^\r]*)/);
		if (originMatch) {
			originLine = originMatch[1].trim();
		}

		// cp437 → UTF-8 conversion (on clean body only)
		var bodyText = bodyClean;
		var utf8     = null;
		try {
			utf8 = cp437ToUtf8(bodyClean);
		} catch (_) {
			// leave utf8 null on failure
		}

		// rawBody gets cp437 conversion too
		var rawUtf8 = null;
		try {
			rawUtf8 = cp437ToUtf8(rawBody);
		} catch (_) {}

		messages.push({
			status,
			msgNumber:     parseInt(msgNumber, 10) || 0,
			date,
			time,
			to,
			from,
			subject,
			password,
			replyRef:      parseInt(replyRef, 10) || 0,
			blocks,
			isLive,
			conferenceNum,
			kludges,
			originLine,
			rawBody,
			rawUtf8,
			bodyText,
			utf8
		});

		offset += totalBytes;
	}

	return messages;
}

// ---------------------------------------------------------------------------
// Building helpers
// ---------------------------------------------------------------------------

// Pad or truncate a string to exactly `len` bytes, space-filled on the right.
function padField(str, len) {
	var s = (str || '').substring(0, len);
	while (s.length < len) s += ' ';
	return s;
}

// Pad a number to exactly `len` chars, left-aligned, space-filled on the right.
// Matches Synchronet's REP format for MsgNum, Blocks, and Reply fields.
function padNumberLeft(num, len) {
	var s = String(num);
	while (s.length < len) s += ' ';
	return s.substring(0, len);
}

// Build a 128-byte QWK message header buffer for a REP packet.
// Matches Synchronet's output format:
//   - MsgNum = conference number (left-aligned)
//   - Blocks = left-aligned
//   - Reply ref = left-aligned
//   - Byte 127 = 0x2A (*) tagline indicator
function buildQwkHeader(msg, conferenceNum, bodyLength) {
	var buf = Buffer.alloc(QWK_RECORD_SIZE, QWK_PAD_BYTE);

	// Total blocks = header (1) + ceil(bodyLength / 128)
	var bodyBlocks  = Math.ceil(bodyLength / QWK_RECORD_SIZE);
	var totalBlocks = QWK_HEADER_BLOCKS + bodyBlocks;

	// Status — space (0x20) for public message
	buf[0] = 0x20;

	// Message number (7 chars) — conference number, left-aligned
	buf.write(padNumberLeft(conferenceNum, 7), 1, 7, 'ascii');

	// Date MM-DD-YY
	var dt = msg.system_time ? new Date(msg.system_time) : new Date();
	var mm = String(dt.getMonth() + 1).padStart(2, '0');
	var dd = String(dt.getDate()).padStart(2, '0');
	var yy = String(dt.getFullYear() % 100).padStart(2, '0');
	buf.write(mm + '-' + dd + '-' + yy, 8, 8, 'ascii');

	// Time HH:MM
	var hh = String(dt.getHours()).padStart(2, '0');
	var mi = String(dt.getMinutes()).padStart(2, '0');
	buf.write(hh + ':' + mi, 16, 5, 'ascii');

	// To (25 chars)
	buf.write(padField(msg.to_user || 'All', 25), 21, 25, 'ascii');

	// From (25 chars)
	buf.write(padField(msg.from_user || 'Unknown', 25), 46, 25, 'ascii');

	// Subject (25 chars)
	buf.write(padField(msg.subject || '', 25), 71, 25, 'ascii');

	// Password (12 chars) — leave blank
	// (already space-filled)

	// Reference number (8 chars) — left-aligned
	var ref = msg.reply_ref || 0;
	buf.write(padNumberLeft(ref, 8), 108, 8, 'ascii');

	// Number of blocks (6 chars) — left-aligned
	buf.write(padNumberLeft(totalBlocks, 6), 116, 6, 'ascii');

	// Active flag
	buf[122] = 0xE1;

	// Conference number — little-endian uint16
	buf.writeUInt16LE(conferenceNum, 123);

	// Byte 127 — tagline/network flag (* = 0x2A)
	buf[127] = 0x2A;

	return buf;
}

// Build a QWK message body buffer from text.
// Converts \r line endings to 0xE3 (QWK line terminator).
// Pads final block to a 128-byte boundary with spaces (0x20).
function buildQwkBody(bodyText) {
	// Replace \r\n first to avoid double conversion, then \r → 0xE3
	var text = (bodyText || '')
		.replace(/\r\n/g, '\r')
		.replace(/\r/g, String.fromCharCode(QWK_LINE_TERM))
		.replace(/\n/g, String.fromCharCode(QWK_LINE_TERM));

	var raw = Buffer.from(text, 'binary');

	// Pad to 128-byte boundary with spaces (Synchronet convention)
	var remainder = raw.length % QWK_RECORD_SIZE;
	if (remainder === 0 && raw.length > 0) {
		return raw;
	}
	var padLen  = remainder === 0 ? 0 : QWK_RECORD_SIZE - remainder;
	var padded  = Buffer.alloc(raw.length + padLen, QWK_PAD_BYTE);
	raw.copy(padded);
	return padded;
}

// ---------------------------------------------------------------------------
// REP packet builder
// ---------------------------------------------------------------------------

// Build a .REP packet (zip archive containing PACKETNAME.MSG) from an array
// of work items. Each item must have { msg, conferenceNum } where msg is a
// DB row with at minimum: id, system_time, to_user, from_user, subject,
// body_text, utf8, reply_ref.
//
// Body encoding: QWK packets are CP437. If msg.utf8 is populated, body_text
// is already CP437 (use directly). If msg.utf8 is null, body_text is UTF-8
// and must be converted via utf8ToCp437 before packing.
//
// Returns the path to the generated .REP file.
// packetName is the hub's QWK-ID — used for filenames and Record 0.
// Synchronet checks Record 0 matches its own QWK-ID.
// localQwkId is the sender's QWK BBS ID (used in HEADERS.DAT ExportedFrom).
function buildRepPacket(workItems, packetName, tmpDir, localQwkId) {
	var msgFileName = packetName.toUpperCase() + '.MSG';
	var repFileName = packetName.toUpperCase() + '.rep';

	var chunks = [];
	var headersDatLines = [];
	var msgOffset = 0;

	// Record 0: 128-byte header block containing the hub's QWK-ID.
	var headerBlock = Buffer.alloc(QWK_RECORD_SIZE, QWK_PAD_BYTE);
	var idString = packetName.toUpperCase();
	headerBlock.write(idString, 0, Math.min(idString.length, QWK_RECORD_SIZE), 'ascii');
	chunks.push(headerBlock);
	msgOffset += QWK_RECORD_SIZE;

	for (var item of workItems) {
		// Determine the CP437 body to pack
		var bodyForPack;
		if (item.msg.utf8) {
			bodyForPack = item.msg.body_text || '';
		} else {
			var cp437Bytes = utf8ToCp437(item.msg.body_text || '');
			bodyForPack = '';
			for (var i = 0; i < cp437Bytes.length; i++) {
				bodyForPack += String.fromCharCode(cp437Bytes[i]);
			}
		}

		var bodyBuf = buildQwkBody(bodyForPack);
		var hdrBuf  = buildQwkHeader(item.msg, item.conferenceNum, bodyBuf.length);

		// Record the offset of this message header for HEADERS.DAT
		var hdrOffset = msgOffset;

		chunks.push(hdrBuf);
		chunks.push(bodyBuf);
		msgOffset += hdrBuf.length + bodyBuf.length;

		// Build HEADERS.DAT entry for this message
		headersDatLines.push(buildHeadersDatEntry(
			hdrOffset, item.msg, item.conferenceNum, localQwkId
		));
	}

	var msgData = Buffer.concat(chunks);

	// Write .MSG and HEADERS.DAT, then zip both into the .REP
	var msgPath     = path.join(tmpDir, msgFileName);
	var headersPath = path.join(tmpDir, 'HEADERS.DAT');
	var repPath     = path.join(tmpDir, repFileName);

	fs.writeFileSync(msgPath, msgData);
	fs.writeFileSync(headersPath, headersDatLines.join('\n') + '\n');

	try {
		execSync('zip -j ' + JSON.stringify(repPath) + ' ' +
			JSON.stringify(msgPath) + ' ' + JSON.stringify(headersPath));
	} catch (err) {
		throw new Error('Failed to create REP zip (is zip installed?): ' + err.message);
	}

	// Remove intermediate files
	fs.unlinkSync(msgPath);
	fs.unlinkSync(headersPath);

	return repPath;
}

// Build a single HEADERS.DAT entry for one message.
// Format matches Synchronet's output: [hex_offset], key: value pairs, LF endings.
function buildHeadersDatEntry(offset, msg, conferenceNum, localQwkId) {
	var lines = [];

	// Section header — hex offset of message header in .MSG file
	lines.push('[' + offset.toString(16).toUpperCase() + ']');

	// UTF-8 flag
	lines.push('Utf8 = ' + (msg.utf8 ? 'true' : 'false'));

	// Message-ID
	if (msg.msg_id) {
		lines.push('Message-ID: ' + msg.msg_id);
	}

	// Reply-ID (In-Reply-To equivalent)
	if (msg.reply_to) {
		lines.push('Reply-ID: ' + msg.reply_to);
	}

	// Timestamps — format: YYYYMMDDHHMMss-TZOFFSET  tzhex
	var dt = msg.system_time ? new Date(msg.system_time) : new Date();
	var now = new Date();
	var whenStr = formatQwkTimestamp(dt);
	var exportStr = formatQwkTimestamp(now);

	lines.push('WhenWritten:  ' + whenStr);
	lines.push('WhenExported: ' + exportStr);

	// ExportedFrom — QWKID internal_code msg_number
	if (localQwkId) {
		var destStr = msg.destination || String(conferenceNum);
		lines.push('ExportedFrom: ' + localQwkId.toUpperCase() +
			' ' + destStr + ' ' + (msg.id || 0));
	}

	// Sender / recipient
	lines.push('Sender: ' + (msg.from_user || 'Unknown'));
	lines.push('To: ' + (msg.to_user || 'All'));
	lines.push('Subject: ' + (msg.subject || ''));

	// Conference number
	lines.push('Conference: ' + conferenceNum);

	// Product ID
	lines.push('X-FTN-PID: Canectic QWK Tosser');

	// Blank line to terminate entry
	lines.push('');

	return lines.join('\n');
}

// Format a Date as Synchronet HEADERS.DAT timestamp: YYYYMMDDHHMMSS+0000  0000
function formatQwkTimestamp(dt) {
	var yyyy = String(dt.getUTCFullYear());
	var mm   = String(dt.getUTCMonth() + 1).padStart(2, '0');
	var dd   = String(dt.getUTCDate()).padStart(2, '0');
	var hh   = String(dt.getUTCHours()).padStart(2, '0');
	var mi   = String(dt.getUTCMinutes()).padStart(2, '0');
	var ss   = String(dt.getUTCSeconds()).padStart(2, '0');
	// Use UTC (+0000) and timezone code 0000 (UTC)
	return yyyy + mm + dd + hh + mi + ss + '+0000  0000';
}

// ---------------------------------------------------------------------------
// QWK packet extraction
// ---------------------------------------------------------------------------

// Extracts a .QWK zip archive to a target directory.
// Returns the path to the extraction directory.
function unzipQwkPacket(zipPath, extractDir) {
	if (!fs.existsSync(extractDir)) {
		fs.mkdirSync(extractDir, { recursive: true });
	}
	var zip = new AdmZip(zipPath);
	zip.extractAllTo(extractDir, true);
	return extractDir;
}

export {
	QWK_RECORD_SIZE,
	QWK_HEADER_BLOCKS,
	QWK_LINE_TERM,
	parseControlDat,
	parseMessagesDAT,
	buildQwkHeader,
	buildQwkBody,
	buildRepPacket,
	unzipQwkPacket
};
