// tests/zmodemSend.test.js — ZMODEM send engine tests.
//
// Unit tests for encoding/decoding helpers, and an integration test
// using a minimal mock receiver that responds to the sender's frames.

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
	ZmodemEngine,
	encodeHexHeader,
	encodeBinHeader,
	zdleEscape,
	needsEscape,
	positionToBytes,
	bytesToPosition,
	decodeHexNibble
} from '../src/transfers/zmodem.js';
import { crc16, crc32 } from '../src/transfers/crc.js';
import {
	ZPAD, ZDLE, ZBIN, ZHEX, ZBIN32,
	ZRQINIT, ZRINIT, ZACK, ZFILE, ZRPOS, ZDATA, ZEOF, ZFIN, ZCRC,
	ZCRCG, ZCRCQ, ZCRCE, ZCRCW,
	CANFC32, CANFDX, CANOVIO,
	XON, XOFF, CAN, CR
} from '../src/transfers/constants.js';

function sleep(ms) {
	return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// =========================================================================
// Unit tests — encoding helpers
// =========================================================================

describe('ZMODEM position encoding', function() {
	it('should encode position as little-endian bytes', function() {
		var bytes = positionToBytes(0);
		assert.deepStrictEqual(bytes, [0, 0, 0, 0]);

		bytes = positionToBytes(0x12345678);
		assert.deepStrictEqual(bytes, [0x78, 0x56, 0x34, 0x12]);

		bytes = positionToBytes(1024);
		assert.deepStrictEqual(bytes, [0, 4, 0, 0]);
	});

	it('should decode position from little-endian bytes', function() {
		assert.strictEqual(bytesToPosition(0, 0, 0, 0), 0);
		assert.strictEqual(bytesToPosition(0x78, 0x56, 0x34, 0x12), 0x12345678);
		assert.strictEqual(bytesToPosition(0, 4, 0, 0), 1024);
	});

	it('should round-trip positions', function() {
		var values = [0, 1, 127, 128, 255, 256, 1024, 65535, 1000000, 0xFFFFFFFF];
		for (var v of values) {
			var b = positionToBytes(v);
			var decoded = bytesToPosition(b[0], b[1], b[2], b[3]);
			assert.strictEqual(decoded, v >>> 0, 'round-trip failed for ' + v);
		}
	});
});

describe('ZMODEM ZDLE escaping', function() {
	it('should escape ZDLE byte', function() {
		var data = Buffer.from([0x41, ZDLE, 0x42]);
		var escaped = zdleEscape(data, false);
		assert.ok(escaped.includes(ZDLE), 'should contain ZDLE');
		// ZDLE should be followed by ZDLE ^ 0x40
		var idx = escaped.indexOf(ZDLE);
		assert.strictEqual(escaped[idx + 1], ZDLE ^ 0x40);
	});

	it('should escape XON and XOFF', function() {
		var data = Buffer.from([XON, XOFF]);
		var escaped = zdleEscape(data, false);
		assert.ok(escaped.length > 2, 'escaped should be longer');
	});

	it('should not escape normal bytes', function() {
		var data = Buffer.from([0x41, 0x42, 0x43]); // ABC
		var escaped = zdleEscape(data, false);
		assert.deepStrictEqual(escaped, data);
	});

	it('should escape all control chars when escapeAll is true', function() {
		var data = Buffer.from([0x00, 0x01, 0x0D, 0x41]);
		var escaped = zdleEscape(data, true);
		// Control chars (0x00, 0x01, 0x0D) should all be escaped
		// 0x41 should not
		assert.ok(escaped.length > data.length);
	});

	it('needsEscape should identify escapable bytes', function() {
		assert.ok(needsEscape(ZDLE, false));
		assert.ok(needsEscape(XON, false));
		assert.ok(needsEscape(XOFF, false));
		assert.ok(!needsEscape(0x41, false)); // 'A'
		assert.ok(!needsEscape(0x20, false)); // space
		assert.ok(needsEscape(0x00, true));   // NUL with escapeAll
		assert.ok(!needsEscape(0x00, false)); // NUL without escapeAll
	});
});

describe('ZMODEM hex header encoding', function() {
	it('should produce valid hex header format', function() {
		var header = encodeHexHeader(ZRQINIT, 0, 0, 0, 0);
		// Should start with ZPAD ZPAD ZDLE ZHEX
		assert.strictEqual(header[0], ZPAD);
		assert.strictEqual(header[1], ZPAD);
		assert.strictEqual(header[2], ZDLE);
		assert.strictEqual(header[3], ZHEX);
		// Should end with CR LF
		assert.strictEqual(header[header.length - 2], CR);
		assert.strictEqual(header[header.length - 1], 0x0A);
	});

	it('should contain valid hex-encoded CRC', function() {
		var header = encodeHexHeader(ZRINIT, CANFDX | CANOVIO | CANFC32, 0, 0, 0);
		// Extract hex portion (after ZPAD ZPAD ZDLE ZHEX, before CR LF)
		var hexStr = header.subarray(4, header.length - 2).toString('ascii');
		assert.strictEqual(hexStr.length, 14); // 5 bytes * 2 hex chars + 2 CRC bytes * 2 hex chars

		// Decode and verify CRC
		var headerBytes = [];
		for (var i = 0; i < 5; i++) {
			headerBytes.push(parseInt(hexStr.substring(i * 2, i * 2 + 2), 16));
		}
		var rxCrc = parseInt(hexStr.substring(10, 14), 16);
		var calcCrc = crc16(Buffer.from(headerBytes));
		assert.strictEqual(rxCrc, calcCrc, 'CRC should match');
	});
});

describe('ZMODEM binary header encoding', function() {
	it('should produce valid binary header format', function() {
		var header = encodeBinHeader(ZDATA, 0, 0, 0, 0, false);
		// Should start with ZPAD ZDLE ZBIN
		assert.strictEqual(header[0], ZPAD);
		assert.strictEqual(header[1], ZDLE);
		assert.strictEqual(header[2], ZBIN);
	});
});

describe('ZMODEM hex nibble decoding', function() {
	it('should decode hex chars correctly', function() {
		assert.strictEqual(decodeHexNibble(0x30), 0);  // '0'
		assert.strictEqual(decodeHexNibble(0x39), 9);  // '9'
		assert.strictEqual(decodeHexNibble(0x61), 10); // 'a'
		assert.strictEqual(decodeHexNibble(0x66), 15); // 'f'
		assert.strictEqual(decodeHexNibble(0x41), 10); // 'A'
		assert.strictEqual(decodeHexNibble(0x46), 15); // 'F'
		assert.strictEqual(decodeHexNibble(0x47), -1); // 'G' invalid
	});
});

// =========================================================================
// Integration test — loopback with mock receiver
// =========================================================================

// Minimal ZMODEM receiver that responds to sender frames.
// Parses hex headers, sends ZRINIT, ZRPOS, and ZRINIT after ZEOF.
// Collects data subpackets to verify file content.

function createMockReceiver(adapter, targetDir) {
	var state = 'await_zrqinit';
	var receivedData = [];
	var fileName = '';
	var fileSize = 0;
	var currentOffset = 0;
	var inDataPhase = false;
	var dataBuf = Buffer.alloc(0);
	var files = [];

	function sendHexHeader(type, p0, p1, p2, p3) {
		adapter.write(encodeHexHeader(type, p0 || 0, p1 || 0, p2 || 0, p3 || 0));
	}

	function processData(buf) {
		dataBuf = Buffer.concat([dataBuf, buf]);

		// Try to parse headers and data from the buffer
		while (dataBuf.length > 0) {
			// In data phase, look for ZDLE-escaped data subpackets
			if (inDataPhase) {
				// But first check if a header appeared (sender exited data phase)
				if (hasHeaderStart(dataBuf)) {
					inDataPhase = false;
					// Fall through to header parsing below
				} else {
					var result = extractDataSubpacket(dataBuf);
					if (result === null) break; // Need more data

					receivedData.push(result.data);
					currentOffset += result.data.length;
					dataBuf = result.remaining;

					if (result.frameEnd === ZCRCE || result.frameEnd === ZCRCW) {
						inDataPhase = false;
						if (result.frameEnd === ZCRCW) {
							// Send ZACK with current position
							var ackPos = [currentOffset & 0xFF, (currentOffset >> 8) & 0xFF,
								(currentOffset >> 16) & 0xFF, (currentOffset >> 24) & 0xFF];
							sendHexHeader(ZACK, ackPos[0], ackPos[1], ackPos[2], ackPos[3]);
						}
					}
					continue;
				}
			}

			// Look for headers
			var headerResult = findAndParseHeader(dataBuf);
			if (headerResult === null) {
				// No complete header found, but might have partial — keep buffer
				break;
			}

			dataBuf = headerResult.remaining;
			handleHeader(headerResult.type, headerResult.p0, headerResult.p1, headerResult.p2, headerResult.p3, headerResult.subpacketData);
		}
	}

	function hasHeaderStart(buf) {
		for (var i = 0; i < buf.length - 1; i++) {
			if (buf[i] === ZPAD && buf[i + 1] === ZPAD) return true;
			if (buf[i] === ZPAD && buf[i + 1] === ZDLE) return true;
		}
		return false;
	}

	function findAndParseHeader(buf) {
		// Look for hex header: ZPAD ZPAD ZDLE ZHEX
		for (var i = 0; i <= buf.length - 4; i++) {
			if (buf[i] === ZPAD && buf[i + 1] === ZPAD && buf[i + 2] === ZDLE && buf[i + 3] === ZHEX) {
				if (buf.length < i + 4 + 14 + 2) return null; // Need more
				var hexStart = i + 4;
				var bytes = [];
				for (var j = 0; j < 7; j++) {
					var hi = decodeHexNibble(buf[hexStart + j * 2]);
					var lo = decodeHexNibble(buf[hexStart + j * 2 + 1]);
					if (hi < 0 || lo < 0) break;
					bytes.push((hi << 4) | lo);
				}
				if (bytes.length < 7) { continue; }

				var consumed = i + 4 + 14;
				while (consumed < buf.length && (buf[consumed] === CR || buf[consumed] === 0x0A || buf[consumed] === XON)) consumed++;

				return {
					type: bytes[0], p0: bytes[1], p1: bytes[2], p2: bytes[3], p3: bytes[4],
					remaining: buf.subarray(consumed),
					subpacketData: null
				};
			}

			// Look for binary header: ZPAD ZDLE ZBIN or ZPAD ZDLE ZBIN32
			if (buf[i] === ZPAD && i + 1 < buf.length && buf[i + 1] === ZDLE && i + 2 < buf.length && (buf[i + 2] === ZBIN || buf[i + 2] === ZBIN32)) {
				var isBin32 = buf[i + 2] === ZBIN32;
				var binCrcLen = isBin32 ? 4 : 2;
				var pos = i + 3;
				var unesc = [];
				while (unesc.length < (5 + binCrcLen) && pos < buf.length) {
					if (buf[pos] === ZDLE) {
						if (pos + 1 >= buf.length) return null;
						unesc.push(buf[pos + 1] ^ 0x40);
						pos += 2;
					} else {
						unesc.push(buf[pos]);
						pos++;
					}
				}
				if (unesc.length < (5 + binCrcLen)) return null;

				// After binary header, read data subpacket if this is ZFILE or ZDATA
				var frameType = unesc[0];
				var subData = null;
				if (frameType === ZFILE || frameType === ZDATA) {
					// Extract the following data subpacket
					var spResult = extractDataSubpacket(buf.subarray(pos));
					if (spResult === null) return null;
					subData = spResult.data;
					pos = buf.length - spResult.remaining.length;

					if (frameType === ZDATA) {
						// ZDATA means we're entering data phase for subsequent subpackets
						inDataPhase = true;
						receivedData.push(subData);
						currentOffset += subData.length;
					}
				}

				return {
					type: unesc[0], p0: unesc[1], p1: unesc[2], p2: unesc[3], p3: unesc[4],
					remaining: buf.subarray(pos),
					subpacketData: subData
				};
			}
		}
		// No header found — discard up to last few bytes that could be partial
		if (buf.length > 4) {
			return { type: -1, p0: 0, p1: 0, p2: 0, p3: 0, remaining: buf.subarray(buf.length - 4), subpacketData: null };
		}
		return null;
	}

	function extractDataSubpacket(buf) {
		// Read ZDLE-escaped data until we hit ZDLE + frame-end (ZCRCG/ZCRCQ/ZCRCE/ZCRCW)
		var data = [];
		var pos = 0;
		var frameEnd = -1;

		while (pos < buf.length) {
			if (buf[pos] === ZDLE) {
				if (pos + 1 >= buf.length) return null; // Need more
				var next = buf[pos + 1];
				if (next === ZCRCG || next === ZCRCQ || next === ZCRCE || next === ZCRCW) {
					frameEnd = next;
					pos += 2;
					// Read CRC-32 (4 bytes, ZDLE-escaped) — sender uses ZBIN32 + CRC-32
					var crcBytes = [];
					while (crcBytes.length < 4 && pos < buf.length) {
						if (buf[pos] === ZDLE) {
							if (pos + 1 >= buf.length) return null;
							crcBytes.push(buf[pos + 1] ^ 0x40);
							pos += 2;
						} else {
							crcBytes.push(buf[pos]);
							pos++;
						}
					}
					if (crcBytes.length < 4) return null;

					return {
						data: Buffer.from(data),
						frameEnd: frameEnd,
						remaining: buf.subarray(pos)
					};
				} else {
					// Escaped data byte
					data.push(next ^ 0x40);
					pos += 2;
				}
			} else {
				data.push(buf[pos]);
				pos++;
			}
		}
		return null; // Need more data
	}

	function handleHeader(type, p0, p1, p2, p3, subpacketData) {
		if (type === -1) return; // Garbage discard

		if (type === ZRQINIT && state === 'await_zrqinit') {
			state = 'send_zrinit';
			// Send ZRINIT with CRC-32 capability
			sendHexHeader(ZRINIT, 0, 0, 0, CANFDX | CANOVIO | CANFC32);
			state = 'await_zfile';
		} else if (type === ZFILE && state === 'await_zfile') {
			// Parse file metadata from subpacket data
			if (subpacketData) {
				var metaStr = subpacketData.toString('binary');
				var nullIdx = metaStr.indexOf('\0');
				if (nullIdx >= 0) {
					fileName = metaStr.substring(0, nullIdx);
					var rest = metaStr.substring(nullIdx + 1);
					var parts = rest.split(' ');
					fileSize = parseInt(parts[0]) || 0;
				}
			}
			receivedData = [];
			currentOffset = 0;
			// Send ZRPOS at offset 0 (start from beginning)
			sendHexHeader(ZRPOS, 0, 0, 0, 0);
			state = 'receiving';
		} else if (type === ZDATA && state === 'receiving') {
			// Data phase started — subpacket already extracted above
			inDataPhase = true;
		} else if (type === ZEOF) {
			inDataPhase = false;
			// Save received file
			var content = Buffer.concat(receivedData);
			var filePath = path.join(targetDir, fileName || 'unknown');
			fs.writeFileSync(filePath, content);
			files.push({ name: fileName, size: content.length, path: filePath });
			receivedData = [];
			// Send ZRINIT to request next file
			sendHexHeader(ZRINIT, 0, 0, 0, CANFDX | CANOVIO | CANFC32);
			state = 'await_zfile';
		} else if (type === ZFIN) {
			// Session done
			sendHexHeader(ZFIN, 0, 0, 0, 0);
			state = 'done';
		}
	}

	return {
		process: processData,
		getFiles: function() { return files; },
		getState: function() { return state; }
	};
}

// --- Test fixtures ---

function createTestFixture(content) {
	var tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'zmodem-test-'));
	var outDir = path.join(tmpBase, 'out');
	var inDir = path.join(tmpBase, 'in');
	fs.mkdirSync(outDir);
	fs.mkdirSync(inDir);
	if (content !== undefined) {
		var testFile = path.join(outDir, 'testfile.dat');
		if (Buffer.isBuffer(content)) {
			fs.writeFileSync(testFile, content);
		} else {
			fs.writeFileSync(testFile, content, typeof content === 'string' ? 'utf8' : undefined);
		}
		return { tmpBase, outDir, inDir, testFile };
	}
	return { tmpBase, outDir, inDir };
}

function cleanupFixture(fixture) {
	fs.rmSync(fixture.tmpBase, { recursive: true, force: true });
}

// =========================================================================
// Integration tests
// =========================================================================

describe('ZMODEM send loopback', function() {
	this.timeout(15000);

	it('should transfer a small text file', async function() {
		var content = 'Hello, ZMODEM world! This is a test of the native engine.\r\n';
		var fixture = createTestFixture(content);

		try {
			// Create paired adapters
			var senderAdapter = { _h: null, sent: [], write: null, onData: function(cb) { senderAdapter._h = cb; }, offData: function() { senderAdapter._h = null; } };
			var receiver = createMockReceiver({
				write: function(buf) {
					// Receiver writes go to sender's input
					setImmediate(function() {
						if (senderAdapter._h) senderAdapter._h(Buffer.from(buf));
					});
				}
			}, fixture.inDir);

			senderAdapter.write = function(buf) {
				senderAdapter.sent.push(Buffer.from(buf));
				// Sender writes go to receiver's input
				setImmediate(function() {
					receiver.process(Buffer.from(buf));
				});
			};

			var engine = new ZmodemEngine(senderAdapter, { subpacketSize: 512, timeout: 5000 });
			var result = await engine.send([fixture.testFile]);

			assert.ok(result.success, 'send should succeed: ' + (result.error || ''));
			assert.strictEqual(result.filesSent, 1);

			var files = receiver.getFiles();
			assert.strictEqual(files.length, 1, 'receiver should have 1 file');
			assert.strictEqual(files[0].name, 'testfile.dat');

			var received = fs.readFileSync(files[0].path, 'utf8');
			assert.strictEqual(received, content, 'content should match');
		} finally {
			cleanupFixture(fixture);
		}
	});

	it('should transfer a larger file spanning many subpackets', async function() {
		var content = 'X'.repeat(10000);
		var fixture = createTestFixture(content);

		try {
			var senderAdapter = { _h: null, write: null, onData: function(cb) { senderAdapter._h = cb; }, offData: function() { senderAdapter._h = null; } };
			var receiver = createMockReceiver({
				write: function(buf) {
					setImmediate(function() { if (senderAdapter._h) senderAdapter._h(Buffer.from(buf)); });
				}
			}, fixture.inDir);

			senderAdapter.write = function(buf) {
				setImmediate(function() { receiver.process(Buffer.from(buf)); });
			};

			var engine = new ZmodemEngine(senderAdapter, { subpacketSize: 1024, timeout: 5000 });
			var result = await engine.send([fixture.testFile]);

			assert.ok(result.success, 'send should succeed: ' + (result.error || ''));

			var files = receiver.getFiles();
			assert.strictEqual(files.length, 1);
			var received = fs.readFileSync(files[0].path, 'utf8');
			assert.strictEqual(received, content);
		} finally {
			cleanupFixture(fixture);
		}
	});

	it('should transfer binary data with all byte values', async function() {
		var buf = Buffer.alloc(256);
		for (var i = 0; i < 256; i++) buf[i] = i;
		var content = Buffer.concat([buf, buf]); // 512 bytes
		var fixture = createTestFixture(content);

		try {
			var senderAdapter = { _h: null, write: null, onData: function(cb) { senderAdapter._h = cb; }, offData: function() { senderAdapter._h = null; } };
			var receiver = createMockReceiver({
				write: function(buf) {
					setImmediate(function() { if (senderAdapter._h) senderAdapter._h(Buffer.from(buf)); });
				}
			}, fixture.inDir);

			senderAdapter.write = function(buf) {
				setImmediate(function() { receiver.process(Buffer.from(buf)); });
			};

			var engine = new ZmodemEngine(senderAdapter, { subpacketSize: 256, timeout: 5000 });
			var result = await engine.send([fixture.testFile]);

			assert.ok(result.success, 'binary send should succeed: ' + (result.error || ''));

			var files = receiver.getFiles();
			var received = fs.readFileSync(files[0].path);
			assert.ok(Buffer.compare(received, content) === 0, 'binary content should match');
		} finally {
			cleanupFixture(fixture);
		}
	});

	it('should transfer multiple files in one session', async function() {
		var fixture = createTestFixture();
		var file1 = path.join(fixture.outDir, 'first.txt');
		var file2 = path.join(fixture.outDir, 'second.txt');
		fs.writeFileSync(file1, 'First file content');
		fs.writeFileSync(file2, 'Second file content here');

		try {
			var senderAdapter = { _h: null, write: null, onData: function(cb) { senderAdapter._h = cb; }, offData: function() { senderAdapter._h = null; } };
			var receiver = createMockReceiver({
				write: function(buf) {
					setImmediate(function() { if (senderAdapter._h) senderAdapter._h(Buffer.from(buf)); });
				}
			}, fixture.inDir);

			senderAdapter.write = function(buf) {
				setImmediate(function() { receiver.process(Buffer.from(buf)); });
			};

			var engine = new ZmodemEngine(senderAdapter, { timeout: 5000 });
			var result = await engine.send([file1, file2]);

			assert.ok(result.success, 'multi-file send should succeed: ' + (result.error || ''));
			assert.strictEqual(result.filesSent, 2);

			var files = receiver.getFiles();
			assert.strictEqual(files.length, 2);
			assert.strictEqual(fs.readFileSync(files[0].path, 'utf8'), 'First file content');
			assert.strictEqual(fs.readFileSync(files[1].path, 'utf8'), 'Second file content here');
		} finally {
			cleanupFixture(fixture);
		}
	});

	it('should emit progress events', async function() {
		var content = 'P'.repeat(3000);
		var fixture = createTestFixture(content);
		var progressEvents = [];

		try {
			var senderAdapter = { _h: null, write: null, onData: function(cb) { senderAdapter._h = cb; }, offData: function() { senderAdapter._h = null; } };
			var receiver = createMockReceiver({
				write: function(buf) {
					setImmediate(function() { if (senderAdapter._h) senderAdapter._h(Buffer.from(buf)); });
				}
			}, fixture.inDir);

			senderAdapter.write = function(buf) {
				setImmediate(function() { receiver.process(Buffer.from(buf)); });
			};

			var engine = new ZmodemEngine(senderAdapter, { subpacketSize: 512, timeout: 5000 });
			engine.on('progress', function(p) { progressEvents.push(p); });

			var result = await engine.send([fixture.testFile]);

			assert.ok(result.success);
			assert.ok(progressEvents.length > 0, 'should have progress events');
			assert.strictEqual(progressEvents[0].file, 'testfile.dat');
			assert.ok(progressEvents[progressEvents.length - 1].bytesSent >= content.length);
		} finally {
			cleanupFixture(fixture);
		}
	});
});

// =========================================================================
// ZMODEM CRC fallback chain (zbin32 → zbin_crc32 → zbin_crc16)
// =========================================================================
//
// The engine sends ZFILE with zbin32 headers first. If the receiver ignores
// it (simulating a client that doesn't understand ZBIN32), the 3-second
// zfile_timeout fires and the engine retries with zbin_crc32, then zbin_crc16.
// The mock receiver below ignores the first ZFILE (ZBIN32), then ignores
// the second (ZBIN+CRC32), then responds to the third (ZBIN+CRC16).

describe('ZMODEM CRC fallback chain', function() {
	this.timeout(20000);

	// Create a mock receiver that counts ZFILE attempts before responding.
	// skipCount: how many ZFILE headers to silently ignore before accepting.
	function createFallbackReceiver(senderAdapterRef, targetDir, skipCount) {
		var state = 'await_zrqinit';
		var zfileCount = 0;
		var receivedData = [];
		var currentOffset = 0;
		var inDataPhase = false;
		var dataBuf = Buffer.alloc(0);
		var files = [];

		function sendHexHeader(type, p0, p1, p2, p3) {
			senderAdapterRef._h && setImmediate(function() {
				senderAdapterRef._h(encodeHexHeader(type, p0 || 0, p1 || 0, p2 || 0, p3 || 0));
			});
		}

		function processData(buf) {
			dataBuf = Buffer.concat([dataBuf, buf]);

			// Scan for ZRQINIT hex header
			if (state === 'await_zrqinit') {
				// Look for ZPAD ZPAD ZDLE ZHEX with frame type ZRQINIT (0x00)
				for (var i = 0; i <= dataBuf.length - 20; i++) {
					if (dataBuf[i] === ZPAD && dataBuf[i+1] === ZPAD &&
					    dataBuf[i+2] === ZDLE && dataBuf[i+3] === ZHEX) {
						var hi = decodeHexNibble(dataBuf[i+4]);
						var lo = decodeHexNibble(dataBuf[i+5]);
						if (hi === 0 && lo === 0) { // ZRQINIT = 0
							state = 'await_zfile';
							dataBuf = dataBuf.subarray(i + 4 + 14 + 2);
							sendHexHeader(ZRINIT, 0, 0, 0, CANFDX | CANOVIO | CANFC32);
							break;
						}
					}
				}
				return;
			}

			if (state === 'await_zfile') {
				// Look for ZFILE binary header: ZPAD ZDLE ZBIN or ZPAD ZDLE ZBIN32
				for (var j = 0; j <= dataBuf.length - 3; j++) {
					if (dataBuf[j] === ZPAD && dataBuf[j+1] === ZDLE &&
					    (dataBuf[j+2] === ZBIN || dataBuf[j+2] === ZBIN32)) {
						zfileCount++;
						dataBuf = Buffer.alloc(0); // Discard
						if (zfileCount <= skipCount) {
							// Ignore — let the sender's zfile_timeout fire
							return;
						}
						// Accept — respond with ZRPOS(0)
						state = 'receiving';
						receivedData = [];
						currentOffset = 0;
						sendHexHeader(ZRPOS, 0, 0, 0, 0);
						return;
					}
				}
				return;
			}

			if (state === 'receiving') {
				// Scan for ZEOF or ZDATA in hex headers; collect any data subpacket bytes
				// Look for hex header sequence
				for (var k = 0; k <= dataBuf.length - 4; k++) {
					if (dataBuf[k] === ZPAD && dataBuf[k+1] === ZPAD &&
					    dataBuf[k+2] === ZDLE && dataBuf[k+3] === ZHEX) {
						if (dataBuf.length < k + 4 + 14 + 2) break;
						var thi = decodeHexNibble(dataBuf[k+4]);
						var tlo = decodeHexNibble(dataBuf[k+5]);
						if (thi < 0 || tlo < 0) continue;
						var frameType = (thi << 4) | tlo;
						var consumed = k + 4 + 14;
						while (consumed < dataBuf.length &&
						       (dataBuf[consumed] === CR || dataBuf[consumed] === 0x0A)) consumed++;

						if (frameType === ZEOF) {
							// Save file (empty — we just confirm the handshake works)
							files.push({ name: 'received', data: Buffer.concat(receivedData) });
							dataBuf = dataBuf.subarray(consumed);
							state = 'await_zfile';
							sendHexHeader(ZRINIT, 0, 0, 0, CANFDX | CANOVIO | CANFC32);
							return;
						} else if (frameType === ZFIN) {
							dataBuf = dataBuf.subarray(consumed);
							state = 'done';
							sendHexHeader(ZFIN, 0, 0, 0, 0);
							return;
						}
						dataBuf = dataBuf.subarray(consumed);
						return;
					}
				}
				// Consume data bytes — we don't validate them, just discard
				dataBuf = Buffer.alloc(0);
			}

			if (state === 'done') {
				dataBuf = Buffer.alloc(0);
			}
		}

		return {
			process: processData,
			getFiles: function() { return files; },
			getState: function() { return state; },
			getZfileCount: function() { return zfileCount; }
		};
	}

	it('should fall back from zbin32 to zbin_crc32 when first ZFILE is ignored', async function() {
		var content = 'Fallback test content';
		var fixture = createTestFixture(content);

		try {
			var senderAdapter = {
				_h: null,
				write: null,
				onData: function(cb) { senderAdapter._h = cb; },
				offData: function() { senderAdapter._h = null; }
			};

			// skipCount=1: ignore the first ZFILE (zbin32), accept the second
			var receiver = createFallbackReceiver(senderAdapter, fixture.inDir, 1);

			senderAdapter.write = function(buf) {
				setImmediate(function() { receiver.process(Buffer.from(buf)); });
			};

			var fallbackErrors = [];
			var engine = new ZmodemEngine(senderAdapter, {
				initialCrcMode: 'zbin32',
				timeout: 5000
			});
			engine.on('error', function(e) { fallbackErrors.push(e); });

			var result = await engine.send([fixture.testFile]);

			assert.ok(result.success, 'transfer should succeed after fallback: ' + (result.error || ''));
			// Engine should have fallen back — zbin32 changed to zbin_crc32
			assert.notStrictEqual(engine._sendCrcMode, 'zbin32',
				'_sendCrcMode should have changed from zbin32 after fallback');
			// At least one fallback error event should have fired
			assert.ok(fallbackErrors.length > 0, 'should emit at least one fallback error event');
			assert.ok(fallbackErrors[0].recoverable, 'fallback error should be recoverable');
		} finally {
			cleanupFixture(fixture);
		}
	});

	it('should fall back through both modes (zbin32 → zbin_crc32 → zbin_crc16) when first two ZFILEs are ignored', async function() {
		var content = 'Double fallback test';
		var fixture = createTestFixture(content);

		try {
			var senderAdapter = {
				_h: null,
				write: null,
				onData: function(cb) { senderAdapter._h = cb; },
				offData: function() { senderAdapter._h = null; }
			};

			// skipCount=2: ignore first two ZFILEs, accept third
			var receiver = createFallbackReceiver(senderAdapter, fixture.inDir, 2);

			senderAdapter.write = function(buf) {
				setImmediate(function() { receiver.process(Buffer.from(buf)); });
			};

			var fallbackErrors = [];
			var engine = new ZmodemEngine(senderAdapter, {
				initialCrcMode: 'zbin32',
				timeout: 5000
			});
			engine.on('error', function(e) { fallbackErrors.push(e); });

			var result = await engine.send([fixture.testFile]);

			assert.ok(result.success, 'transfer should succeed after double fallback: ' + (result.error || ''));
			assert.strictEqual(engine._sendCrcMode, 'zbin_crc16',
				'after two fallbacks, sendCrcMode should be zbin_crc16');
			assert.strictEqual(fallbackErrors.length, 2, 'should emit two fallback error events');
		} finally {
			cleanupFixture(fixture);
		}
	});

	it('should start with zbin_crc16 if initialCrcMode is set', async function() {
		var content = 'CRC16 mode test';
		var fixture = createTestFixture(content);

		try {
			var senderAdapter = {
				_h: null,
				write: null,
				onData: function(cb) { senderAdapter._h = cb; },
				offData: function() { senderAdapter._h = null; }
			};

			// No skips — receiver accepts immediately
			var receiver = createFallbackReceiver(senderAdapter, fixture.inDir, 0);

			senderAdapter.write = function(buf) {
				setImmediate(function() { receiver.process(Buffer.from(buf)); });
			};

			var engine = new ZmodemEngine(senderAdapter, {
				initialCrcMode: 'zbin_crc16',
				timeout: 5000
			});

			var result = await engine.send([fixture.testFile]);
			assert.ok(result.success, 'should succeed with zbin_crc16 initial mode: ' + (result.error || ''));
		} finally {
			cleanupFixture(fixture);
		}
	});
});

// =========================================================================
// ZMODEM ZCRC handler
// =========================================================================
//
// When the receiver sends a ZCRC hex header after ZFILE, the sender must
// respond with a ZCRC header whose p0-p3 bytes are the CRC-32 of the file.

describe('ZMODEM ZCRC response', function() {
	this.timeout(15000);

	it('should respond with correct CRC-32 of the file when receiver sends ZCRC', async function() {
		var content = 'CRC check content for ZCRC test';
		var fixture = createTestFixture(content);

		try {
			var senderAdapter = {
				_h: null,
				write: null,
				onData: function(cb) { senderAdapter._h = cb; },
				offData: function() { senderAdapter._h = null; }
			};

			// Track the ZCRC response the engine sends back
			var zcrcsReceived = [];

			// Custom mock receiver that:
			// 1. Responds to ZRQINIT with ZRINIT
			// 2. Responds to ZFILE with ZCRC (requesting CRC verification)
			// 3. Responds to ZCRC with ZRPOS (accepting the file)
			// 4. Responds to ZEOF with ZRINIT, then to ZFIN with ZFIN
			var state = 'await_zrqinit';
			var dataBuf = Buffer.alloc(0);
			var files = [];
			var receivedData = [];

			function sendHexHeader(type, p0, p1, p2, p3) {
				senderAdapter._h && setImmediate(function() {
					senderAdapter._h(encodeHexHeader(type, p0 || 0, p1 || 0, p2 || 0, p3 || 0));
				});
			}

			function processData(buf) {
				dataBuf = Buffer.concat([dataBuf, buf]);

				while (true) {
					// Find any hex header
					var found = false;
					for (var i = 0; i <= dataBuf.length - 20; i++) {
						if (dataBuf[i] === ZPAD && dataBuf[i+1] === ZPAD &&
						    dataBuf[i+2] === ZDLE && dataBuf[i+3] === ZHEX) {
							if (dataBuf.length < i + 4 + 14 + 2) return; // Need more

							var hexBytes = [];
							for (var j = 0; j < 7; j++) {
								var hi = decodeHexNibble(dataBuf[i + 4 + j*2]);
								var lo = decodeHexNibble(dataBuf[i + 4 + j*2 + 1]);
								if (hi < 0 || lo < 0) { found = false; break; }
								hexBytes.push((hi << 4) | lo);
							}
							if (hexBytes.length < 7) break;

							var consumed = i + 4 + 14;
							while (consumed < dataBuf.length &&
							       (dataBuf[consumed] === CR || dataBuf[consumed] === 0x0A)) consumed++;

							var frameType = hexBytes[0];
							var p0 = hexBytes[1], p1 = hexBytes[2], p2 = hexBytes[3], p3 = hexBytes[4];
							dataBuf = dataBuf.subarray(consumed);
							found = true;

							if (frameType === ZRQINIT && state === 'await_zrqinit') {
								state = 'await_zfile';
								sendHexHeader(ZRINIT, 0, 0, 0, CANFDX | CANOVIO | CANFC32);
							} else if (frameType === ZCRC) {
								// Capture the CRC-32 sent by the engine (little-endian in p0-p3)
								var crcVal = p0 | (p1 << 8) | (p2 << 16) | (p3 << 24);
								zcrcsReceived.push(crcVal >>> 0);
								// Now accept the file by sending ZRPOS(0)
								state = 'receiving';
								receivedData = [];
								sendHexHeader(ZRPOS, 0, 0, 0, 0);
							} else if (frameType === ZEOF && state === 'receiving') {
								files.push({ name: 'received' });
								state = 'await_zfile';
								sendHexHeader(ZRINIT, 0, 0, 0, CANFDX | CANOVIO | CANFC32);
							} else if (frameType === ZFIN) {
								state = 'done';
								sendHexHeader(ZFIN, 0, 0, 0, 0);
							}
							break;
						}

						// Look for binary ZFILE header and send ZCRC in response
						if (dataBuf[i] === ZPAD && i + 1 < dataBuf.length &&
						    dataBuf[i+1] === ZDLE && i + 2 < dataBuf.length &&
						    (dataBuf[i+2] === ZBIN || dataBuf[i+2] === ZBIN32)) {
							if (state === 'await_zfile') {
								dataBuf = Buffer.alloc(0); // Discard the ZFILE + subpacket
								found = true;
								// Send ZCRC — ask sender to prove the file's CRC-32
								sendHexHeader(ZCRC, 0, 0, 0, 0);
							}
							break;
						}
					}
					if (!found) break;
				}

				// In receive state, discard data subpackets
				if (state === 'receiving') {
					dataBuf = Buffer.alloc(0);
				}
			}

			senderAdapter.write = function(buf) {
				setImmediate(function() { processData(Buffer.from(buf)); });
			};

			var engine = new ZmodemEngine(senderAdapter, {
				initialCrcMode: 'zbin_crc32',
				timeout: 5000
			});

			var result = await engine.send([fixture.testFile]);

			assert.ok(result.success, 'transfer should succeed after ZCRC exchange: ' + (result.error || ''));
			assert.ok(zcrcsReceived.length > 0, 'should have received a ZCRC response from the engine');

			// Verify the CRC-32 the engine sent matches the actual file content
			var expectedCrc = crc32(Buffer.from(content, 'utf8'));
			assert.strictEqual(zcrcsReceived[0], expectedCrc,
				'ZCRC response should contain the correct CRC-32 of the file content');
		} finally {
			cleanupFixture(fixture);
		}
	});

	it('should respond to ZCRC with zero CRC when no file is open', function() {
		// Direct unit test: call _onZCRC when _fileHandle is null
		var written = [];
		var adapter = {
			_h: null,
			write: function(buf) { written.push(Buffer.from(buf)); },
			onData: function(cb) { adapter._h = cb; },
			offData: function() { adapter._h = null; }
		};

		var engine = new ZmodemEngine(adapter, {});
		// _fileHandle is null by default — simulate ZCRC with no file open
		engine._onZCRC(0, 0, 0, 0);

		// Engine should have written a hex ZCRC header with position 0
		assert.ok(written.length > 0, 'should write ZCRC response');
		var combined = Buffer.concat(written);
		// Find the hex header: ZPAD ZPAD ZDLE ZHEX
		var found = false;
		for (var i = 0; i <= combined.length - 20; i++) {
			if (combined[i] === ZPAD && combined[i+1] === ZPAD &&
			    combined[i+2] === ZDLE && combined[i+3] === ZHEX) {
				var hi = decodeHexNibble(combined[i+4]);
				var lo = decodeHexNibble(combined[i+5]);
				if (((hi << 4) | lo) === ZCRC) {
					found = true;
					// p0-p3 should all be 0 (CRC of empty/no file)
					var p0hi = decodeHexNibble(combined[i+6]);
					var p0lo = decodeHexNibble(combined[i+7]);
					var p0 = (p0hi << 4) | p0lo;
					// At minimum, assert the frame type byte is ZCRC
					assert.strictEqual((hi << 4) | lo, ZCRC);
					break;
				}
			}
		}
		assert.ok(found, 'should send a hex ZCRC header in response');
	});
});
