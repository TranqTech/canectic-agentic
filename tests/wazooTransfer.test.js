// tests/wazooTransfer.test.js — Wazoo batch transfer engine tests.

import assert from 'assert';
import { EventEmitter } from 'node:events';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WazooTransferEngine } from '../src/mailer/wazooTransfer.js';

function sleep(ms) {
	return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// --- Paired mock transports ---

function createPairedTransports() {
	var a = new EventEmitter();
	var b = new EventEmitter();
	a._connected = true;
	b._connected = true;
	a.write = function(buf) { setImmediate(function() { b.emit('data', Buffer.from(buf)); }); };
	b.write = function(buf) { setImmediate(function() { a.emit('data', Buffer.from(buf)); }); };
	a.close = function() { a._connected = false; };
	b.close = function() { b._connected = false; };
	a.removeListener = EventEmitter.prototype.removeListener;
	b.removeListener = EventEmitter.prototype.removeListener;
	return { answerer: a, caller: b };
}

function createTestFixture(files) {
	var tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wazoo-test-'));
	var outDir = path.join(tmpBase, 'out');
	var inDirA = path.join(tmpBase, 'inA');
	var inDirB = path.join(tmpBase, 'inB');
	var tmpDir = path.join(tmpBase, 'tmp');
	fs.mkdirSync(outDir);
	fs.mkdirSync(inDirA);
	fs.mkdirSync(inDirB);
	fs.mkdirSync(tmpDir);

	var filePaths = [];
	if (files) {
		for (var i = 0; i < files.length; i++) {
			var fp = path.join(outDir, files[i].name);
			fs.writeFileSync(fp, files[i].content);
			filePaths.push({ path: fp });
		}
	}

	return { tmpBase, outDir, inDirA, inDirB, tmpDir, filePaths };
}

function cleanupFixture(fixture) {
	fs.rmSync(fixture.tmpBase, { recursive: true, force: true });
}

// =========================================================================
// Tests
// =========================================================================

describe('Wazoo batch transfer', function() {
	this.timeout(30000);

	it('should transfer a file from answerer to caller', async function() {
		var fixture = createTestFixture([
			{ name: 'test.pkt', content: 'Hello from answerer via Wazoo!' }
		]);

		try {
			var pair = createPairedTransports();

			var answerer = new WazooTransferEngine(pair.answerer, {
				role: 'answerer',
				inboundDir: fixture.inDirA,
				tempDir: fixture.tmpDir,
				outboundFiles: fixture.filePaths,
				sessionId: 'test-answerer'
			});

			var caller = new WazooTransferEngine(pair.caller, {
				role: 'caller',
				inboundDir: fixture.inDirB,
				tempDir: fixture.tmpDir,
				outboundFiles: [],
				sessionId: 'test-caller'
			});

			var [aResult, cResult] = await Promise.all([
				answerer.run(),
				caller.run()
			]);

			assert.ok(aResult.success, 'answerer should succeed: ' + (aResult.error || ''));
			assert.ok(cResult.success, 'caller should succeed: ' + (cResult.error || ''));
			assert.strictEqual(aResult.filesSent, 1);
			assert.strictEqual(cResult.filesReceived, 1);
		} finally {
			cleanupFixture(fixture);
		}
	});

	it('should transfer a file from caller to answerer', async function() {
		var fixture = createTestFixture([
			{ name: 'reply.pkt', content: 'Hello from caller via Wazoo!' }
		]);

		try {
			var pair = createPairedTransports();

			var answerer = new WazooTransferEngine(pair.answerer, {
				role: 'answerer',
				inboundDir: fixture.inDirA,
				tempDir: fixture.tmpDir,
				outboundFiles: [],
				sessionId: 'test-answerer'
			});

			var caller = new WazooTransferEngine(pair.caller, {
				role: 'caller',
				inboundDir: fixture.inDirB,
				tempDir: fixture.tmpDir,
				outboundFiles: fixture.filePaths,
				sessionId: 'test-caller'
			});

			var [aResult, cResult] = await Promise.all([
				answerer.run(),
				caller.run()
			]);

			assert.ok(aResult.success, 'answerer should succeed: ' + (aResult.error || ''));
			assert.ok(cResult.success, 'caller should succeed: ' + (cResult.error || ''));
			assert.strictEqual(cResult.filesSent, 1);
			assert.strictEqual(aResult.filesReceived, 1);
		} finally {
			cleanupFixture(fixture);
		}
	});

	it('should handle both sides sending files', async function() {
		var fixture = createTestFixture();

		var fileA = path.join(fixture.outDir, 'fromA.pkt');
		var fileB = path.join(fixture.outDir, 'fromB.pkt');
		fs.writeFileSync(fileA, 'File from answerer');
		fs.writeFileSync(fileB, 'File from caller');

		try {
			var pair = createPairedTransports();

			var answerer = new WazooTransferEngine(pair.answerer, {
				role: 'answerer',
				inboundDir: fixture.inDirA,
				tempDir: fixture.tmpDir,
				outboundFiles: [{ path: fileA }],
				sessionId: 'test-both-A'
			});

			var caller = new WazooTransferEngine(pair.caller, {
				role: 'caller',
				inboundDir: fixture.inDirB,
				tempDir: fixture.tmpDir,
				outboundFiles: [{ path: fileB }],
				sessionId: 'test-both-B'
			});

			var [aResult, cResult] = await Promise.all([
				answerer.run(),
				caller.run()
			]);

			assert.ok(aResult.success, 'answerer should succeed: ' + (aResult.error || ''));
			assert.ok(cResult.success, 'caller should succeed: ' + (cResult.error || ''));
			assert.strictEqual(aResult.filesSent, 1);
			assert.strictEqual(aResult.filesReceived, 1);
			assert.strictEqual(cResult.filesSent, 1);
			assert.strictEqual(cResult.filesReceived, 1);
		} finally {
			cleanupFixture(fixture);
		}
	});

	it('should handle empty batch (no files on either side)', async function() {
		var fixture = createTestFixture();

		try {
			var pair = createPairedTransports();

			var answerer = new WazooTransferEngine(pair.answerer, {
				role: 'answerer',
				inboundDir: fixture.inDirA,
				tempDir: fixture.tmpDir,
				outboundFiles: [],
				sessionId: 'test-empty-A'
			});

			var caller = new WazooTransferEngine(pair.caller, {
				role: 'caller',
				inboundDir: fixture.inDirB,
				tempDir: fixture.tmpDir,
				outboundFiles: [],
				sessionId: 'test-empty-B'
			});

			var [aResult, cResult] = await Promise.all([
				answerer.run(),
				caller.run()
			]);

			assert.ok(aResult.success, 'answerer should succeed: ' + (aResult.error || ''));
			assert.ok(cResult.success, 'caller should succeed: ' + (cResult.error || ''));
			assert.strictEqual(aResult.filesSent, 0);
			assert.strictEqual(cResult.filesSent, 0);
		} finally {
			cleanupFixture(fixture);
		}
	});

	it('should emit events during transfer', async function() {
		var fixture = createTestFixture([
			{ name: 'events.pkt', content: 'Event test data' }
		]);
		var events = [];

		try {
			var pair = createPairedTransports();

			var answerer = new WazooTransferEngine(pair.answerer, {
				role: 'answerer',
				inboundDir: fixture.inDirA,
				tempDir: fixture.tmpDir,
				outboundFiles: fixture.filePaths,
				sessionId: 'test-events'
			});

			answerer.on('sendComplete', function(i) { events.push('sendComplete'); });
			answerer.on('batchComplete', function(i) { events.push('batch:' + i.direction); });
			answerer.on('allComplete', function() { events.push('allComplete'); });

			var caller = new WazooTransferEngine(pair.caller, {
				role: 'caller',
				inboundDir: fixture.inDirB,
				tempDir: fixture.tmpDir,
				outboundFiles: [],
				sessionId: 'test-events-c'
			});

			await Promise.all([answerer.run(), caller.run()]);

			assert.ok(events.includes('sendComplete'), 'should have sendComplete');
			assert.ok(events.includes('batch:send'), 'should have batch:send');
			assert.ok(events.includes('batch:receive'), 'should have batch:receive');
			assert.ok(events.includes('allComplete'), 'should have allComplete');
		} finally {
			cleanupFixture(fixture);
		}
	});
});
