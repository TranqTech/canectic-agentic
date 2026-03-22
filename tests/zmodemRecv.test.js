// tests/zmodemRecv.test.js — ZMODEM receive engine tests.
//
// Integration tests using paired ZmodemEngine instances: one sending,
// one receiving, connected via paired adapters. This validates the
// full protocol round-trip without any external tools.

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ZmodemEngine } from '../src/transfers/zmodem.js';

function sleep(ms) {
	return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// --- Paired adapters ---

function createPairedAdapters() {
	var a = { _h: null, onData: function(cb) { a._h = cb; }, offData: function() { a._h = null; } };
	var b = { _h: null, onData: function(cb) { b._h = cb; }, offData: function() { b._h = null; } };
	a.write = function(buf) { setImmediate(function() { if (b._h) b._h(Buffer.from(buf)); }); };
	b.write = function(buf) { setImmediate(function() { if (a._h) a._h(Buffer.from(buf)); }); };
	return { sender: a, receiver: b };
}

// --- Test fixtures ---

function createTestFixture(content) {
	var tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'zmrecv-'));
	var outDir = path.join(tmpBase, 'out');
	var inDir = path.join(tmpBase, 'in');
	fs.mkdirSync(outDir);
	fs.mkdirSync(inDir);
	if (content !== undefined) {
		var testFile = path.join(outDir, 'testfile.dat');
		if (Buffer.isBuffer(content)) {
			fs.writeFileSync(testFile, content);
		} else {
			fs.writeFileSync(testFile, content);
		}
		return { tmpBase: tmpBase, outDir: outDir, inDir: inDir, testFile: testFile };
	}
	return { tmpBase: tmpBase, outDir: outDir, inDir: inDir };
}

function cleanupFixture(fixture) {
	fs.rmSync(fixture.tmpBase, { recursive: true, force: true });
}

// =========================================================================
// Integration tests — sender + receiver loopback
// =========================================================================

describe('ZMODEM receive loopback', function() {
	this.timeout(15000);

	it('should receive a small text file', async function() {
		var content = 'Hello from the ZMODEM sender! Testing native receive.\r\n';
		var fixture = createTestFixture(content);

		try {
			var pair = createPairedAdapters();

			var sender = new ZmodemEngine(pair.sender, { subpacketSize: 512, timeout: 5000 });
			var receiver = new ZmodemEngine(pair.receiver, { timeout: 5000 });

			var [sendResult, recvResult] = await Promise.all([
				sender.send([fixture.testFile]),
				receiver.receive(fixture.inDir)
			]);

			assert.ok(sendResult.success, 'send should succeed: ' + (sendResult.error || ''));
			assert.ok(recvResult.success, 'receive should succeed: ' + (recvResult.error || ''));
			assert.strictEqual(recvResult.files.length, 1);
			assert.strictEqual(recvResult.files[0].name, 'testfile.dat');

			var received = fs.readFileSync(recvResult.files[0].path, 'utf8');
			assert.strictEqual(received, content, 'file content should match');
		} finally {
			cleanupFixture(fixture);
		}
	});

	it('should receive a file spanning many subpackets', async function() {
		var content = 'Y'.repeat(8000);
		var fixture = createTestFixture(content);

		try {
			var pair = createPairedAdapters();

			var sender = new ZmodemEngine(pair.sender, { subpacketSize: 1024, timeout: 5000 });
			var receiver = new ZmodemEngine(pair.receiver, { timeout: 5000 });

			var [sendResult, recvResult] = await Promise.all([
				sender.send([fixture.testFile]),
				receiver.receive(fixture.inDir)
			]);

			assert.ok(sendResult.success, 'send should succeed: ' + (sendResult.error || ''));
			assert.ok(recvResult.success, 'receive should succeed: ' + (recvResult.error || ''));

			var received = fs.readFileSync(recvResult.files[0].path, 'utf8');
			assert.strictEqual(received, content);
		} finally {
			cleanupFixture(fixture);
		}
	});

	it('should receive binary data with all byte values', async function() {
		var buf = Buffer.alloc(256);
		for (var i = 0; i < 256; i++) buf[i] = i;
		var content = Buffer.concat([buf, buf, buf]); // 768 bytes
		var fixture = createTestFixture(content);

		try {
			var pair = createPairedAdapters();

			var sender = new ZmodemEngine(pair.sender, { subpacketSize: 256, timeout: 5000 });
			var receiver = new ZmodemEngine(pair.receiver, { timeout: 5000 });

			var [sendResult, recvResult] = await Promise.all([
				sender.send([fixture.testFile]),
				receiver.receive(fixture.inDir)
			]);

			assert.ok(sendResult.success);
			assert.ok(recvResult.success);

			var received = fs.readFileSync(recvResult.files[0].path);
			assert.ok(Buffer.compare(received, content) === 0, 'binary content should match exactly');
		} finally {
			cleanupFixture(fixture);
		}
	});

	it('should receive multiple files in one session', async function() {
		var fixture = createTestFixture();
		var file1 = path.join(fixture.outDir, 'alpha.txt');
		var file2 = path.join(fixture.outDir, 'beta.txt');
		var file3 = path.join(fixture.outDir, 'gamma.txt');
		fs.writeFileSync(file1, 'Alpha content');
		fs.writeFileSync(file2, 'Beta content here');
		fs.writeFileSync(file3, 'Gamma has even more content than the others');

		try {
			var pair = createPairedAdapters();

			var sender = new ZmodemEngine(pair.sender, { subpacketSize: 512, timeout: 5000 });
			var receiver = new ZmodemEngine(pair.receiver, { timeout: 5000 });

			var [sendResult, recvResult] = await Promise.all([
				sender.send([file1, file2, file3]),
				receiver.receive(fixture.inDir)
			]);

			assert.ok(sendResult.success, 'send should succeed: ' + (sendResult.error || ''));
			assert.strictEqual(sendResult.filesSent, 3);
			assert.ok(recvResult.success, 'receive should succeed: ' + (recvResult.error || ''));
			assert.strictEqual(recvResult.files.length, 3);

			assert.strictEqual(recvResult.files[0].name, 'alpha.txt');
			assert.strictEqual(recvResult.files[1].name, 'beta.txt');
			assert.strictEqual(recvResult.files[2].name, 'gamma.txt');

			assert.strictEqual(fs.readFileSync(recvResult.files[0].path, 'utf8'), 'Alpha content');
			assert.strictEqual(fs.readFileSync(recvResult.files[1].path, 'utf8'), 'Beta content here');
			assert.strictEqual(fs.readFileSync(recvResult.files[2].path, 'utf8'), 'Gamma has even more content than the others');
		} finally {
			cleanupFixture(fixture);
		}
	});

	it('should emit progress and fileComplete events on receiver', async function() {
		var content = 'E'.repeat(3000);
		var fixture = createTestFixture(content);
		var recvProgress = [];
		var recvFileComplete = [];

		try {
			var pair = createPairedAdapters();

			var sender = new ZmodemEngine(pair.sender, { subpacketSize: 512, timeout: 5000 });
			var receiver = new ZmodemEngine(pair.receiver, { timeout: 5000 });

			receiver.on('progress', function(p) { recvProgress.push(p); });
			receiver.on('fileComplete', function(e) { recvFileComplete.push(e); });

			var [sendResult, recvResult] = await Promise.all([
				sender.send([fixture.testFile]),
				receiver.receive(fixture.inDir)
			]);

			assert.ok(sendResult.success);
			assert.ok(recvResult.success);

			assert.ok(recvProgress.length > 0, 'should have progress events');
			assert.strictEqual(recvProgress[0].file, 'testfile.dat');
			assert.ok(recvProgress[recvProgress.length - 1].bytesReceived >= content.length);

			assert.strictEqual(recvFileComplete.length, 1);
			assert.strictEqual(recvFileComplete[0].name, 'testfile.dat');
		} finally {
			cleanupFixture(fixture);
		}
	});

	it('should handle escape-all mode', async function() {
		// Content with lots of control characters that need escaping
		var buf = Buffer.alloc(200);
		for (var i = 0; i < 200; i++) buf[i] = i % 32; // All control chars
		var fixture = createTestFixture(buf);

		try {
			var pair = createPairedAdapters();

			var sender = new ZmodemEngine(pair.sender, { subpacketSize: 128, timeout: 5000, escapeCtl: true });
			var receiver = new ZmodemEngine(pair.receiver, { timeout: 5000, escapeCtl: true });

			var [sendResult, recvResult] = await Promise.all([
				sender.send([fixture.testFile]),
				receiver.receive(fixture.inDir)
			]);

			assert.ok(sendResult.success, 'send should succeed with escapeCtl: ' + (sendResult.error || ''));
			assert.ok(recvResult.success, 'receive should succeed with escapeCtl: ' + (recvResult.error || ''));

			var received = fs.readFileSync(recvResult.files[0].path);
			assert.ok(Buffer.compare(received, buf) === 0, 'control char content should match');
		} finally {
			cleanupFixture(fixture);
		}
	});

	it('should preserve file size accurately', async function() {
		// Odd-sized file that doesn't align to subpacket boundaries
		var content = 'Z'.repeat(1337);
		var fixture = createTestFixture(content);

		try {
			var pair = createPairedAdapters();

			var sender = new ZmodemEngine(pair.sender, { subpacketSize: 512, timeout: 5000 });
			var receiver = new ZmodemEngine(pair.receiver, { timeout: 5000 });

			var [sendResult, recvResult] = await Promise.all([
				sender.send([fixture.testFile]),
				receiver.receive(fixture.inDir)
			]);

			assert.ok(recvResult.success);
			assert.strictEqual(recvResult.files[0].size, 1337);

			var received = fs.readFileSync(recvResult.files[0].path, 'utf8');
			assert.strictEqual(received.length, 1337);
			assert.strictEqual(received, content);
		} finally {
			cleanupFixture(fixture);
		}
	});
});
