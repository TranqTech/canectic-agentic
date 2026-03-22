// tests/xmodem.test.js — XMODEM engine unit and integration tests.
//
// Tests: block encoding, CRC validation, send/receive loopback,
// error recovery, abort handling.

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { XmodemEngine } from '../src/transfers/xmodem.js';
import { crc16 } from '../src/transfers/crc.js';
import { SOH, STX, EOT, ACK, NAK, CAN, SUB } from '../src/transfers/constants.js';

// --- Mock adapter for paired loopback ---

function createMockAdapter() {
	return {
		sent: [],
		_handler: null,
		write: function(buf) {
			this.sent.push(Buffer.from(buf));
		},
		onData: function(cb) {
			this._handler = cb;
		},
		offData: function() {
			this._handler = null;
		},
		feed: function(buf) {
			if (this._handler) this._handler(Buffer.from(buf));
		},
		getSent: function() {
			return Buffer.concat(this.sent);
		},
		clearSent: function() {
			this.sent = [];
		}
	};
}

// --- Paired adapters for loopback (write to A feeds B and vice versa) ---

function createPairedAdapters() {
	var a = createMockAdapter();
	var b = createMockAdapter();

	var origWriteA = a.write;
	var origWriteB = b.write;

	a.write = function(buf) {
		origWriteA.call(a, buf);
		setImmediate(function() { b.feed(buf); });
	};

	b.write = function(buf) {
		origWriteB.call(b, buf);
		setImmediate(function() { a.feed(buf); });
	};

	return { sender: a, receiver: b };
}

function sleep(ms) {
	return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// --- Helper: create temp dir and test file ---

function createTestFixture(content) {
	var tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'xmodem-test-'));
	var outDir = path.join(tmpBase, 'out');
	var inDir = path.join(tmpBase, 'in');
	fs.mkdirSync(outDir);
	fs.mkdirSync(inDir);

	var testFile = path.join(outDir, 'testfile.dat');
	fs.writeFileSync(testFile, content);

	return { tmpBase: tmpBase, outDir: outDir, inDir: inDir, testFile: testFile };
}

function cleanupFixture(fixture) {
	fs.rmSync(fixture.tmpBase, { recursive: true, force: true });
}

// =========================================================================
// Unit tests
// =========================================================================

describe('XMODEM constants', function() {
	it('should export correct byte values', function() {
		assert.strictEqual(SOH, 0x01);
		assert.strictEqual(STX, 0x02);
		assert.strictEqual(EOT, 0x04);
		assert.strictEqual(ACK, 0x06);
		assert.strictEqual(NAK, 0x15);
		assert.strictEqual(CAN, 0x18);
		assert.strictEqual(SUB, 0x1A);
	});
});

describe('XMODEM block format', function() {
	it('should build valid 128-byte block with correct CRC', function() {
		var adapter = createMockAdapter();
		var engine = new XmodemEngine(adapter, { blockSize: 128 });

		// Access internal _buildBlock
		var data = Buffer.alloc(128, 0x41); // 'A' repeated
		var block = engine._buildBlock(data);

		assert.strictEqual(block.length, 3 + 128 + 2, 'frame should be 133 bytes');
		assert.strictEqual(block[0], SOH, 'first byte should be SOH');
		assert.strictEqual(block[1], 1, 'block number should be 1');
		assert.strictEqual(block[2], 0xFE, 'complement should be ~1');

		// Verify CRC
		var blockData = block.subarray(3, 3 + 128);
		var expectedCrc = crc16(blockData);
		var frameCrc = (block[131] << 8) | block[132];
		assert.strictEqual(frameCrc, expectedCrc, 'CRC should match');
	});

	it('should build valid 1024-byte block with STX header', function() {
		var adapter = createMockAdapter();
		var engine = new XmodemEngine(adapter, { blockSize: 1024 });

		var data = Buffer.alloc(1024, 0x42);
		var block = engine._buildBlock(data);

		assert.strictEqual(block.length, 3 + 1024 + 2, 'frame should be 1029 bytes');
		assert.strictEqual(block[0], STX, 'first byte should be STX for 1K');
	});
});

// =========================================================================
// Integration tests — loopback
// =========================================================================

describe('XMODEM loopback (128-byte)', function() {
	this.timeout(15000);

	it('should transfer a small file', async function() {
		var content = 'Hello, XMODEM world! This is a test of the native XMODEM engine.\r\n';
		var fixture = createTestFixture(content);

		try {
			var pair = createPairedAdapters();

			var sendEngine = new XmodemEngine(pair.sender, { blockSize: 128, timeout: 5000 });
			var recvEngine = new XmodemEngine(pair.receiver, { blockSize: 128, timeout: 5000 });

			// Start both concurrently
			var [sendResult, recvResult] = await Promise.all([
				sendEngine.send(fixture.testFile, 'testfile.dat'),
				recvEngine.receive(fixture.inDir, 'received.dat')
			]);

			assert.ok(sendResult.success, 'send should succeed: ' + (sendResult.error || ''));
			assert.ok(recvResult.success, 'receive should succeed: ' + (recvResult.error || ''));
			assert.strictEqual(recvResult.files.length, 1);

			var receivedPath = recvResult.files[0].path;
			assert.ok(fs.existsSync(receivedPath), 'received file should exist');

			var received = fs.readFileSync(receivedPath, 'utf8');
			assert.strictEqual(received, content, 'content should match');
		} finally {
			cleanupFixture(fixture);
		}
	});

	it('should transfer a file that spans multiple blocks', async function() {
		// 500 bytes = 4 blocks of 128 (last padded with SUB)
		var content = 'X'.repeat(500);
		var fixture = createTestFixture(content);

		try {
			var pair = createPairedAdapters();

			var sendEngine = new XmodemEngine(pair.sender, { blockSize: 128, timeout: 5000 });
			var recvEngine = new XmodemEngine(pair.receiver, { blockSize: 128, timeout: 5000 });

			var [sendResult, recvResult] = await Promise.all([
				sendEngine.send(fixture.testFile),
				recvEngine.receive(fixture.inDir, 'multi.dat')
			]);

			assert.ok(sendResult.success, 'send should succeed');
			assert.ok(recvResult.success, 'receive should succeed');

			var received = fs.readFileSync(recvResult.files[0].path, 'utf8');
			assert.strictEqual(received, content);
		} finally {
			cleanupFixture(fixture);
		}
	});

	it('should handle exact block-size file (no padding needed conceptually)', async function() {
		var content = 'Z'.repeat(128);
		var fixture = createTestFixture(content);

		try {
			var pair = createPairedAdapters();

			var sendEngine = new XmodemEngine(pair.sender, { blockSize: 128, timeout: 5000 });
			var recvEngine = new XmodemEngine(pair.receiver, { blockSize: 128, timeout: 5000 });

			var [sendResult, recvResult] = await Promise.all([
				sendEngine.send(fixture.testFile),
				recvEngine.receive(fixture.inDir, 'exact.dat')
			]);

			assert.ok(sendResult.success);
			assert.ok(recvResult.success);

			var received = fs.readFileSync(recvResult.files[0].path, 'utf8');
			assert.strictEqual(received, content);
		} finally {
			cleanupFixture(fixture);
		}
	});
});

describe('XMODEM loopback (1K)', function() {
	this.timeout(15000);

	it('should transfer a file using 1024-byte blocks', async function() {
		var content = 'Y'.repeat(2500);
		var fixture = createTestFixture(content);

		try {
			var pair = createPairedAdapters();

			var sendEngine = new XmodemEngine(pair.sender, { blockSize: 1024, timeout: 5000 });
			var recvEngine = new XmodemEngine(pair.receiver, { blockSize: 1024, timeout: 5000 });

			var [sendResult, recvResult] = await Promise.all([
				sendEngine.send(fixture.testFile),
				recvEngine.receive(fixture.inDir, '1k.dat')
			]);

			assert.ok(sendResult.success, 'send should succeed: ' + (sendResult.error || ''));
			assert.ok(recvResult.success, 'receive should succeed: ' + (recvResult.error || ''));

			var received = fs.readFileSync(recvResult.files[0].path, 'utf8');
			assert.strictEqual(received, content);
		} finally {
			cleanupFixture(fixture);
		}
	});
});

describe('XMODEM binary data', function() {
	this.timeout(15000);

	it('should transfer binary data with all byte values', async function() {
		var buf = Buffer.alloc(256);
		for (var i = 0; i < 256; i++) buf[i] = i;
		// Repeat to span multiple blocks
		var content = Buffer.concat([buf, buf, buf]);
		var fixture = createTestFixture(content);

		try {
			var pair = createPairedAdapters();

			var sendEngine = new XmodemEngine(pair.sender, { blockSize: 128, timeout: 5000 });
			var recvEngine = new XmodemEngine(pair.receiver, { blockSize: 128, timeout: 5000 });

			var [sendResult, recvResult] = await Promise.all([
				sendEngine.send(fixture.testFile),
				recvEngine.receive(fixture.inDir, 'binary.dat')
			]);

			assert.ok(sendResult.success);
			assert.ok(recvResult.success);

			var received = fs.readFileSync(recvResult.files[0].path);
			assert.ok(Buffer.compare(received, content) === 0, 'binary content should match exactly');
		} finally {
			cleanupFixture(fixture);
		}
	});
});

describe('XMODEM abort', function() {
	this.timeout(10000);

	it('should handle sender abort via CAN sequence', async function() {
		var adapter = createMockAdapter();
		var engine = new XmodemEngine(adapter, { blockSize: 128, timeout: 3000 });

		var recvPromise = engine.receive(os.tmpdir(), 'abort_test.dat');

		// Simulate sender sending 3x CAN
		await sleep(100);
		adapter.feed(Buffer.from([CAN, CAN, CAN]));

		var result = await recvPromise;
		assert.ok(!result.success, 'should not succeed');
		assert.ok(result.error.includes('cancelled'), 'error should mention cancel');

		// Cleanup
		try { fs.unlinkSync(path.join(os.tmpdir(), 'abort_test.dat')); } catch (_) {}
	});
});

describe('XMODEM events', function() {
	this.timeout(15000);

	it('should emit progress events during transfer', async function() {
		var content = 'P'.repeat(300);
		var fixture = createTestFixture(content);
		var progressEvents = [];

		try {
			var pair = createPairedAdapters();

			var sendEngine = new XmodemEngine(pair.sender, { blockSize: 128, timeout: 5000 });
			var recvEngine = new XmodemEngine(pair.receiver, { blockSize: 128, timeout: 5000 });

			sendEngine.on('progress', function(p) { progressEvents.push(p); });

			var [sendResult, recvResult] = await Promise.all([
				sendEngine.send(fixture.testFile),
				recvEngine.receive(fixture.inDir, 'progress.dat')
			]);

			assert.ok(sendResult.success);
			assert.ok(progressEvents.length > 0, 'should have progress events');
			assert.ok(progressEvents[0].blockNumber > 0);
			assert.ok(progressEvents[0].bytesSent > 0);
		} finally {
			cleanupFixture(fixture);
		}
	});

	it('should emit fileStart and fileComplete events', async function() {
		var content = 'E'.repeat(50);
		var fixture = createTestFixture(content);
		var events = [];

		try {
			var pair = createPairedAdapters();

			var sendEngine = new XmodemEngine(pair.sender, { blockSize: 128, timeout: 5000 });
			var recvEngine = new XmodemEngine(pair.receiver, { blockSize: 128, timeout: 5000 });

			sendEngine.on('fileStart', function(e) { events.push({ type: 'start', data: e }); });
			sendEngine.on('fileComplete', function(e) { events.push({ type: 'complete', data: e }); });

			var [sendResult] = await Promise.all([
				sendEngine.send(fixture.testFile, 'myfile.dat'),
				recvEngine.receive(fixture.inDir, 'events.dat')
			]);

			assert.ok(sendResult.success);
			var startEvt = events.find(function(e) { return e.type === 'start'; });
			var completeEvt = events.find(function(e) { return e.type === 'complete'; });
			assert.ok(startEvt, 'should have fileStart event');
			assert.strictEqual(startEvt.data.name, 'myfile.dat');
			assert.ok(completeEvt, 'should have fileComplete event');
		} finally {
			cleanupFixture(fixture);
		}
	});
});
