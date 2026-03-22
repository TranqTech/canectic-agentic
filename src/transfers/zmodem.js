// transfers/zmodem.js — Native ZMODEM engine (send path).
//
// Pure byte-stream state machine. Works over any bidirectional channel
// via the StreamAdapter duck-type: { write(buf), onData(cb), offData() }.
//
// Implements: ZRQINIT/ZRINIT negotiation, ZFILE metadata, ZDATA streaming,
// ZDLE escaping, hex and binary headers, CRC-32 subpackets, ZRPOS error
// recovery, crash recovery (resume), ESCCTL negotiation, ZFIN shutdown.
//
// Does NOT implement: ZBIN32 headers, ZedZap (8K blocks), ZRLE compression,
// ZCOMMAND, ZCHALLENGE. These can be added later.

import { EventEmitter } from 'node:events';
import * as fs from 'fs';
import * as path from 'path';
import { crc16, crc32 } from './crc.js';
import {
	ZPAD, ZDLE, ZBIN, ZHEX,
	ZRQINIT, ZRINIT, ZSINIT, ZACK, ZFILE, ZSKIP, ZNAK, ZABORT,
	ZFIN, ZRPOS, ZDATA, ZEOF, ZFERR, ZCAN,
	ZCRCG, ZCRCQ, ZCRCE, ZCRCW,
	CANFDX, CANOVIO, CANFC32, ESCCTL, ESC8,
	XON, XOFF, CAN, CR
} from './constants.js';

// --- Constants ---

var ZDLE_XOR = 0x40;         // XOR mask for escaped bytes
var SUBPACKET_SIZE = 1024;   // Default data subpacket size
var ZRQINIT_RETRIES = 10;   // Max ZRQINIT retransmissions
var ZRQINIT_TIMEOUT = 5000; // Timeout per ZRQINIT attempt (ms)
var HEADER_TIMEOUT = 15000;  // Timeout waiting for a response header
var DATA_TIMEOUT = 30000;    // Timeout during data streaming
var ZFIN_TIMEOUT = 5000;     // Timeout for ZFIN handshake

// Hex encoding table
var HEXCHARS = '0123456789abcdef';

// Auto-start sequence: "rz\r**\x18B00000000000000\r\n\x11"
// Some receivers need this to detect ZMODEM initiation
var ZRQINIT_AUTOSTART = Buffer.from('rz\r');

// Frame type names for logging
var FRAME_NAMES = [
	'ZRQINIT', 'ZRINIT', 'ZSINIT', 'ZACK', 'ZFILE', 'ZSKIP',
	'ZNAK', 'ZABORT', 'ZFIN', 'ZRPOS', 'ZDATA', 'ZEOF',
	'ZFERR', 'ZCRC', 'ZCHALLENGE', 'ZCOMPL', 'ZCAN', 'ZFREECNT',
	'ZCOMMAND', 'ZSTDERR'
];

// --- ZDLE escape helpers ---

function needsEscape(b, escapeAll) {
	if (b === ZDLE) return true;           // Always escape ZDLE
	if (b === XON || b === XOFF) return true; // Always escape XON/XOFF
	if (b === (XON | 0x80) || b === (XOFF | 0x80)) return true;
	if (b === (ZDLE | 0x80)) return true;
	// CR after @ must be escaped (Strstripping protection)
	// We simplify by escaping all CRs when escapeAll is set
	if (escapeAll && (b & 0x60) === 0) return true; // All control chars
	return false;
}

function zdleEscape(data, escapeAll) {
	var out = [];
	for (var i = 0; i < data.length; i++) {
		var b = data[i];
		if (needsEscape(b, escapeAll)) {
			out.push(ZDLE);
			out.push(b ^ ZDLE_XOR);
		} else {
			out.push(b);
		}
	}
	return Buffer.from(out);
}

// --- Header encoding ---

function encodeHexHeader(frameType, p0, p1, p2, p3) {
	// Format: ZPAD ZPAD ZDLE ZHEX type[2] p0[2] p1[2] p2[2] p3[2] crc[4] CR LF XON
	var headerBytes = Buffer.from([frameType, p0 || 0, p1 || 0, p2 || 0, p3 || 0]);
	var crc = crc16(headerBytes);

	var hex = '';
	for (var i = 0; i < headerBytes.length; i++) {
		hex += HEXCHARS[(headerBytes[i] >> 4) & 0xF];
		hex += HEXCHARS[headerBytes[i] & 0xF];
	}
	hex += HEXCHARS[(crc >> 12) & 0xF];
	hex += HEXCHARS[(crc >> 8) & 0xF];
	hex += HEXCHARS[(crc >> 4) & 0xF];
	hex += HEXCHARS[crc & 0xF];

	// ZPAD ZPAD ZDLE ZHEX + hex string + CR LF XON
	var frame = Buffer.alloc(4 + hex.length + 3);
	frame[0] = ZPAD;
	frame[1] = ZPAD;
	frame[2] = ZDLE;
	frame[3] = ZHEX;
	frame.write(hex, 4, 'ascii');
	var pos = 4 + hex.length;
	frame[pos++] = CR;
	frame[pos++] = 0x0A; // LF
	frame[pos++] = XON;
	return frame;
}

function encodeBinHeader(frameType, p0, p1, p2, p3, escapeAll) {
	// Format: ZPAD ZDLE ZBIN type p0 p1 p2 p3 crc16[2]
	// All bytes after ZBIN are ZDLE-escaped
	var headerBytes = Buffer.from([frameType, p0 || 0, p1 || 0, p2 || 0, p3 || 0]);
	var crc = crc16(headerBytes);
	var crcBytes = Buffer.from([(crc >> 8) & 0xFF, crc & 0xFF]);

	var payload = Buffer.concat([headerBytes, crcBytes]);
	var escaped = zdleEscape(payload, escapeAll);

	return Buffer.concat([Buffer.from([ZPAD, ZDLE, ZBIN]), escaped]);
}

function positionToBytes(pos) {
	// ZMODEM positions are little-endian 32-bit
	return [pos & 0xFF, (pos >> 8) & 0xFF, (pos >> 16) & 0xFF, (pos >> 24) & 0xFF];
}

function bytesToPosition(p0, p1, p2, p3) {
	return ((p3 << 24) | (p2 << 16) | (p1 << 8) | p0) >>> 0;
}

// --- Header/subpacket decoding ---

function decodeHexNibble(ch) {
	if (ch >= 0x30 && ch <= 0x39) return ch - 0x30;
	if (ch >= 0x61 && ch <= 0x66) return ch - 0x61 + 10;
	if (ch >= 0x41 && ch <= 0x46) return ch - 0x41 + 10;
	return -1;
}

// --- ZmodemEngine class ---

class ZmodemEngine extends EventEmitter {
	constructor(adapter, options) {
		super();
		this._adapter = adapter;
		this._opts = options || {};
		this._subpacketSize = this._opts.subpacketSize || SUBPACKET_SIZE;
		this._escapeAll = this._opts.escapeCtl || false;
		this._timeout = this._opts.timeout || HEADER_TIMEOUT;

		this._state = 'idle';
		this._timer = null;
		this._aborted = false;
		this._rxBuf = Buffer.alloc(0);  // Input accumulator

		// Receiver capabilities (from ZRINIT)
		this._rxCanFC32 = false;
		this._rxEscCtl = false;
		this._rxWindowSize = 0;

		// File send state
		this._fileQueue = [];
		this._currentFileIndex = -1;
		this._fileHandle = null;
		this._fileSize = 0;
		this._fileName = '';
		this._fileMtime = 0;
		this._fileOffset = 0;      // Current send position
		this._resolveMain = null;
		this._rejectMain = null;

		// ZRQINIT retry counter
		this._initRetries = 0;
	}

	// ======================================================================
	// PUBLIC API — SEND
	// ======================================================================

	/**
	 * Send files via ZMODEM.
	 * @param {Array} fileList — [{ path, name?, size?, mtime? }] or string[]
	 * @returns {Promise<{success: boolean, filesSent: number, error?: string}>}
	 */
	send(fileList) {
		var self = this;
		this._fileQueue = (fileList || []).map(function(item) {
			if (typeof item === 'string') {
				return { path: item };
			}
			return item;
		});

		if (this._fileQueue.length === 0) {
			return Promise.resolve({ success: false, filesSent: 0, error: 'No files to send' });
		}

		return new Promise(function(resolve, reject) {
			self._resolveMain = resolve;
			self._rejectMain = reject;
			self._currentFileIndex = -1;
			self._state = 'init';

			// Wire adapter
			self._adapter.onData(function(data) { self._onData(data); });

			// Send auto-start + ZRQINIT
			self._sendZRQINIT();
		});
	}

	abort() {
		if (this._aborted) return;
		this._sendHexHeader(ZABORT, 0, 0, 0, 0);
		this._sendCancel();
		this._finish(false, 'Aborted');
	}

	// ======================================================================
	// PROTOCOL — SEND FLOW
	// ======================================================================

	_sendZRQINIT() {
		this._initRetries++;
		if (this._initRetries > ZRQINIT_RETRIES) {
			this._finish(false, 'No response from receiver (ZRQINIT timeout)');
			return;
		}

		// Send "rz\r" autostart sequence before first ZRQINIT
		if (this._initRetries === 1) {
			this._adapter.write(ZRQINIT_AUTOSTART);
		}

		this._state = 'await_zrinit';
		this._sendHexHeader(ZRQINIT, 0, 0, 0, 0);
		this._startTimer(ZRQINIT_TIMEOUT, 'zrqinit_timeout');
	}

	_onZRINIT(p0, p1, p2, p3) {
		this._clearTimer();

		// Parse receiver capabilities from ZF0 (p0) and ZF1 (p1)
		this._rxCanFC32 = !!(p0 & CANFC32);
		this._rxEscCtl = !!(p0 & ESCCTL);
		this._rxWindowSize = bytesToPosition(p1, p2, p3, 0); // ZP0..ZP2 = window

		// If receiver wants escape-all, comply
		if (this._rxEscCtl) {
			this._escapeAll = true;
		}

		// If we were streaming a file, this ZRINIT confirms ZEOF — file complete
		if (this._state === 'await_zrinit_next' && this._fileHandle) {
			fs.close(this._fileHandle, function() {});
			this._fileHandle = null;
			this.emit('fileComplete', { name: this._fileName, size: this._fileSize });
		}

		// Advance to next file
		this._sendNextFile();
	}

	_sendNextFile() {
		var self = this;
		this._currentFileIndex++;

		if (this._currentFileIndex >= this._fileQueue.length) {
			// All files sent — send ZFIN
			this._state = 'await_zfin';
			this._sendHexHeader(ZFIN, 0, 0, 0, 0);
			this._startTimer(ZFIN_TIMEOUT, 'zfin_timeout');
			return;
		}

		var fileSpec = this._fileQueue[this._currentFileIndex];
		var filePath = fileSpec.path;

		fs.stat(filePath, function(err, stats) {
			if (err) {
				// Skip this file, try next
				self.emit('error', { message: 'Cannot stat: ' + filePath, recoverable: true });
				self._sendNextFile();
				return;
			}

			self._fileSize = fileSpec.size || stats.size;
			self._fileName = fileSpec.name || path.basename(filePath);
			self._fileMtime = fileSpec.mtime || Math.floor(stats.mtimeMs / 1000);
			self._fileOffset = 0;

			fs.open(filePath, 'r', function(err2, fd) {
				if (err2) {
					self.emit('error', { message: 'Cannot open: ' + filePath, recoverable: true });
					self._sendNextFile();
					return;
				}

				self._fileHandle = fd;
				self.emit('fileStart', { name: self._fileName, size: self._fileSize, mtime: self._fileMtime });

				// Send ZFILE header + file metadata subpacket
				self._sendZFILE();
			});
		});
	}

	_sendZFILE() {
		// ZFILE header with conversion = binary
		this._state = 'await_zrpos';

		// File metadata subpacket: "name\0size mtime 0 0 filesremaining bytesremaining\0"
		var remaining = this._fileQueue.length - this._currentFileIndex;
		var meta = this._fileName + '\0' +
			this._fileSize + ' ' +
			this._fileMtime.toString(8) + ' 0 0 ' +
			remaining + ' 0\0';

		// Send header + metadata as a single write to ensure they arrive together
		var header = encodeBinHeader(ZFILE, 0, 0, 0, 0, this._escapeAll);
		var subpacket = this._encodeDataSubpacket(Buffer.from(meta, 'binary'), ZCRCW);
		this._adapter.write(Buffer.concat([header, subpacket]));
		this._startTimer(this._timeout, 'zfile_timeout');
	}

	_onZRPOS(p0, p1, p2, p3) {
		this._clearTimer();
		var offset = bytesToPosition(p0, p1, p2, p3);
		this._fileOffset = offset;

		// Start streaming data from the requested offset.
		// Send ZDATA header combined with first data subpacket.
		this._state = 'streaming';
		this._zdataHeaderPending = true;
		this._streamData();
	}

	_streamData() {
		var self = this;
		if (this._aborted || this._state !== 'streaming') return;

		var buf = Buffer.alloc(this._subpacketSize);
		fs.read(this._fileHandle, buf, 0, this._subpacketSize, this._fileOffset, function(err, nread) {
			if (self._aborted || self._state !== 'streaming') return;

			if (err) {
				self._sendHexHeader(ZABORT, 0, 0, 0, 0);
				self._finish(false, 'Read error: ' + err.message);
				return;
			}

			if (nread === 0) {
				// End of file — send ZEOF
				self._state = 'await_zrinit_next';
				var eofPos = positionToBytes(self._fileOffset);
				self._sendHexHeader(ZEOF, eofPos[0], eofPos[1], eofPos[2], eofPos[3]);
				self._startTimer(self._timeout, 'zeof_timeout');
				return;
			}

			var data = nread < self._subpacketSize ? buf.subarray(0, nread) : buf;
			self._fileOffset += nread;

			// Use ZCRCG (more data follows, no ack needed) for streaming
			var subpacket = self._encodeDataSubpacket(data, ZCRCG);

			// Prepend ZDATA header to first subpacket so they arrive together
			if (self._zdataHeaderPending) {
				self._zdataHeaderPending = false;
				var pos = positionToBytes(self._fileOffset - nread);
				var header = encodeBinHeader(ZDATA, pos[0], pos[1], pos[2], pos[3], self._escapeAll);
				self._adapter.write(Buffer.concat([header, subpacket]));
			} else {
				self._adapter.write(subpacket);
			}

			self.emit('progress', {
				file: self._fileName,
				bytesSent: self._fileOffset,
				totalSize: self._fileSize
			});

			// Continue streaming on next tick to avoid stack overflow
			setImmediate(function() { self._streamData(); });
		});
	}

	_onZACK(p0, p1, p2, p3) {
		// Receiver acknowledged data — used for windowed flow control
		// For now we stream without windows, so ZACK is informational
		var pos = bytesToPosition(p0, p1, p2, p3);
		this.emit('headerRx', { type: 'ZACK', position: pos });
	}

	_onZSKIP() {
		// Receiver wants to skip this file
		this._clearTimer();
		if (this._fileHandle) {
			fs.close(this._fileHandle, function() {});
			this._fileHandle = null;
		}
		this.emit('error', { message: 'Receiver skipped: ' + this._fileName, recoverable: true });
		this._sendNextFile();
	}

	_onZFIN() {
		// Receiver confirmed ZFIN — send "OO" and finish
		this._clearTimer();
		this._adapter.write(Buffer.from('OO', 'ascii'));
		this._finishSuccess();
	}

	// ======================================================================
	// FRAME ENCODING
	// ======================================================================

	_sendHexHeader(type, p0, p1, p2, p3) {
		this._adapter.write(encodeHexHeader(type, p0, p1, p2, p3));
	}

	_sendBinHeader(type, p0, p1, p2, p3) {
		this._adapter.write(encodeBinHeader(type, p0, p1, p2, p3, this._escapeAll));
	}

	_encodeDataSubpacket(data, frameEnd) {
		// CRC-32 over data + frameEnd byte
		var crcInput = Buffer.concat([data, Buffer.from([frameEnd])]);
		var crc = crc32(crcInput);

		// ZDLE-escape the data
		var escaped = zdleEscape(data, this._escapeAll);

		// Frame end: ZDLE + frameEnd
		var endMarker = Buffer.from([ZDLE, frameEnd]);

		// CRC-32 bytes (little-endian), ZDLE-escaped
		var crcBuf = Buffer.from([
			crc & 0xFF,
			(crc >> 8) & 0xFF,
			(crc >> 16) & 0xFF,
			(crc >> 24) & 0xFF
		]);
		var escapedCrc = zdleEscape(crcBuf, this._escapeAll);

		return Buffer.concat([escaped, endMarker, escapedCrc]);
	}

	_sendDataSubpacket(data, frameEnd) {
		this._adapter.write(this._encodeDataSubpacket(data, frameEnd));
	}

	_sendCancel() {
		// 8 CANs + 8 BSes
		var buf = Buffer.alloc(16);
		for (var i = 0; i < 8; i++) buf[i] = CAN;
		for (var j = 8; j < 16; j++) buf[j] = 0x08;
		this._adapter.write(buf);
	}

	// ======================================================================
	// FRAME DECODING — INPUT PROCESSING
	// ======================================================================

	_onData(data) {
		if (this._aborted) return;

		this._rxBuf = Buffer.concat([this._rxBuf, data]);
		this._processInput();
	}

	_processInput() {
		while (this._rxBuf.length > 0 && !this._aborted) {
			// Look for ZPAD (start of hex header) or ZDLE (start of binary header)
			var consumed = this._tryParseHeader();
			if (consumed === 0) break; // Need more data
			if (consumed === -1) {
				// Discard one byte and retry
				this._rxBuf = this._rxBuf.subarray(1);
				continue;
			}
			this._rxBuf = this._rxBuf.subarray(consumed);
		}
	}

	_tryParseHeader() {
		var buf = this._rxBuf;

		// Skip until we find ZPAD or ZDLE
		if (buf[0] !== ZPAD && buf[0] !== ZDLE) {
			// Check for "OO" (ZFIN response)
			if (buf[0] === 0x4F && buf.length >= 2 && buf[1] === 0x4F) {
				if (this._state === 'await_zfin') {
					this._onZFIN();
				}
				return 2;
			}
			return -1; // Discard
		}

		// Hex header: ZPAD ZPAD ZDLE ZHEX ...
		if (buf[0] === ZPAD) {
			return this._tryParseHexHeader();
		}

		// Binary header: ZPAD ZDLE ZBIN ... (buf[0] might be ZDLE from mid-stream)
		// Actually binary headers start with ZPAD ZDLE ZBIN, but we might see
		// the ZPAD already consumed. Handle both.
		if (buf[0] === ZDLE) {
			// Could be start of binary header if next byte is ZBIN
			if (buf.length < 2) return 0;
			if (buf[1] === ZBIN) {
				return this._tryParseBinHeader(0);
			}
			return -1;
		}

		return -1;
	}

	_tryParseHexHeader() {
		var buf = this._rxBuf;

		// Find ZPAD ZPAD ZDLE ZHEX
		var start = -1;
		for (var i = 0; i <= buf.length - 4; i++) {
			if (buf[i] === ZPAD && buf[i + 1] === ZPAD && buf[i + 2] === ZDLE && buf[i + 3] === ZHEX) {
				start = i;
				break;
			}
		}
		if (start === -1) return -1;

		// Need 4 (header) + 14 (hex: type[2] + p0-p3[8] + crc[4]) + CR LF = 20 bytes after start
		if (buf.length < start + 4 + 14 + 2) return 0; // Need more

		var hexStart = start + 4;
		var hexBytes = [];
		for (var j = 0; j < 7; j++) { // 5 header bytes + 2 CRC bytes = 7 bytes = 14 hex chars
			var hi = decodeHexNibble(buf[hexStart + j * 2]);
			var lo = decodeHexNibble(buf[hexStart + j * 2 + 1]);
			if (hi < 0 || lo < 0) return -1; // Bad hex
			hexBytes.push((hi << 4) | lo);
		}

		// Validate CRC-16
		var headerData = Buffer.from(hexBytes.slice(0, 5));
		var rxCrc = (hexBytes[5] << 8) | hexBytes[6];
		var calcCrc = crc16(headerData);
		if (rxCrc !== calcCrc) {
			return -1; // Bad CRC
		}

		var frameType = hexBytes[0];
		var p0 = hexBytes[1], p1 = hexBytes[2], p2 = hexBytes[3], p3 = hexBytes[4];

		// Consume up to and including CR LF (and optional XON)
		var consumed = start + 4 + 14;
		while (consumed < buf.length && (buf[consumed] === CR || buf[consumed] === 0x0A || buf[consumed] === XON)) {
			consumed++;
		}

		this._dispatchHeader(frameType, p0, p1, p2, p3);
		return consumed;
	}

	_tryParseBinHeader(startOffset) {
		var buf = this._rxBuf;

		// Find ZPAD ZDLE ZBIN (or just ZDLE ZBIN if ZPAD was consumed)
		var headerStart;
		if (startOffset === 0 && buf[0] === ZDLE && buf[1] === ZBIN) {
			headerStart = 2;
		} else {
			// Look for ZPAD ZDLE ZBIN
			var found = -1;
			for (var i = startOffset; i <= buf.length - 3; i++) {
				if (buf[i] === ZPAD && buf[i + 1] === ZDLE && buf[i + 2] === ZBIN) {
					found = i;
					break;
				}
			}
			if (found === -1) return -1;
			headerStart = found + 3;
		}

		// Need to unescape 5 header bytes + 2 CRC bytes = 7 raw bytes
		// But escaped bytes take 2 bytes each, so we need up to 14 bytes
		var unescaped = [];
		var pos = headerStart;
		while (unescaped.length < 7 && pos < buf.length) {
			if (buf[pos] === ZDLE) {
				if (pos + 1 >= buf.length) return 0; // Need more
				unescaped.push(buf[pos + 1] ^ ZDLE_XOR);
				pos += 2;
			} else {
				unescaped.push(buf[pos]);
				pos++;
			}
		}

		if (unescaped.length < 7) return 0; // Need more

		// Validate CRC-16
		var headerData = Buffer.from(unescaped.slice(0, 5));
		var rxCrc = (unescaped[5] << 8) | unescaped[6];
		var calcCrc = crc16(headerData);
		if (rxCrc !== calcCrc) return -1;

		var frameType = unescaped[0];
		var p0 = unescaped[1], p1 = unescaped[2], p2 = unescaped[3], p3 = unescaped[4];

		this._dispatchHeader(frameType, p0, p1, p2, p3);
		return pos;
	}

	_dispatchHeader(frameType, p0, p1, p2, p3) {
		var name = FRAME_NAMES[frameType] || ('UNKNOWN_' + frameType);
		this.emit('headerRx', { type: name, position: bytesToPosition(p0, p1, p2, p3) });

		switch (frameType) {
			case ZRINIT:
				if (this._state === 'await_zrinit' || this._state === 'await_zrinit_next') {
					this._onZRINIT(p0, p1, p2, p3);
				}
				break;
			case ZRPOS:
				if (this._state === 'await_zrpos' || this._state === 'streaming') {
					this._onZRPOS(p0, p1, p2, p3);
				}
				break;
			case ZACK:
				this._onZACK(p0, p1, p2, p3);
				break;
			case ZSKIP:
				this._onZSKIP();
				break;
			case ZFIN:
				this._onZFIN();
				break;
			case ZNAK:
				// Retransmit last header — for now just log
				this.emit('error', { message: 'ZNAK received', recoverable: true });
				break;
			case ZABORT:
			case ZCAN:
				this._finish(false, 'Transfer cancelled by receiver');
				break;
			case ZFERR:
				this._finish(false, 'Receiver reported file error');
				break;
			case ZRQINIT:
				// Receiver is also trying to initiate — resend our ZRINIT
				// This shouldn't happen in send mode, ignore
				break;
		}
	}

	// ======================================================================
	// TIMER
	// ======================================================================

	_startTimer(ms, reason) {
		this._clearTimer();
		var self = this;
		this._timer = setTimeout(function() {
			self._timer = null;
			if (reason === 'zrqinit_timeout') {
				self._sendZRQINIT(); // Retry
			} else if (reason === 'zfin_timeout') {
				// ZFIN timeout — assume success (receiver may have disconnected)
				self._finishSuccess();
			} else {
				self._finish(false, 'Timeout: ' + reason);
			}
		}, ms);
	}

	_clearTimer() {
		if (this._timer) {
			clearTimeout(this._timer);
			this._timer = null;
		}
	}

	// ======================================================================
	// FINISH
	// ======================================================================

	_finishSuccess() {
		// Close current file if open
		if (this._fileHandle) {
			fs.close(this._fileHandle, function() {});
			this._fileHandle = null;
		}

		// _currentFileIndex points past the last file (incremented by _sendNextFile
		// when it found no more files). The actual count is _currentFileIndex.
		this._finish(true, null, this._currentFileIndex);
	}

	_finish(success, error, filesSent) {
		if (this._aborted) return;
		this._aborted = true;
		this._clearTimer();
		this._state = 'done';

		if (this._fileHandle) {
			fs.close(this._fileHandle, function() {});
			this._fileHandle = null;
		}

		this._adapter.offData();

		if (this._resolveMain) {
			this._resolveMain({
				success: success,
				filesSent: filesSent || 0,
				error: error || null
			});
			this._resolveMain = null;
			this._rejectMain = null;
		}
	}
}

// Export engine and encoding helpers for testing
export {
	ZmodemEngine,
	encodeHexHeader,
	encodeBinHeader,
	zdleEscape,
	needsEscape,
	positionToBytes,
	bytesToPosition,
	decodeHexNibble,
	FRAME_NAMES
};
