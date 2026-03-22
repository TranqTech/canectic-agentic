#!/usr/bin/env node
// mailer/tests/test-ws-loopback.js
//
// WebSocket integration test. Starts a real WS listener, connects to it,
// runs a binkp handshake and file transfer over actual WebSocket frames.
// No database — wires protocol events manually.
//
// This validates the full stack: WS transport → binkp framing → file
// transfer, over real WebSocket I/O with binary frame handling.
//
// Run: node tests/mailer/test-ws-loopback.js

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WebSocketServer } from 'ws';
import { WsTransport } from '../../src/mailer/transports/ws.js';
import { BinkpProtocol, verifyCramMD5 } from '../../src/mailer/protocols/binkp.js';
import { TransferEngine } from '../../src/mailer/transfer.js';

var passed = 0;
var failed = 0;

function assert(condition, label) {
	if (condition) {
		passed++;
		console.log('  \x1b[32m✓\x1b[0m ' + label);
	} else {
		failed++;
		console.log('  \x1b[31m✗\x1b[0m ' + label);
	}
}

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
	console.log('\x1b[1m\x1b[36m=== binkp WebSocket Loopback Test ===\x1b[0m\n');

	var TEST_PORT = 34567 + Math.floor(Math.random() * 10000);
	var PASSWORD  = 'wstest';

	// Temp directories
	var tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'binkp-ws-'));
	var outDir  = path.join(tmpBase, 'outbound');
	var inDir   = path.join(tmpBase, 'inbound');
	var tmpDir  = path.join(tmpBase, 'tmp');
	fs.mkdirSync(outDir);
	fs.mkdirSync(inDir);
	fs.mkdirSync(tmpDir);

	// Create test file
	var testContent = 'WebSocket loopback test data - ' + Date.now() + '\r\n';
	testContent = testContent.repeat(50);
	var testFile = path.join(outDir, 'wstest.pkt');
	fs.writeFileSync(testFile, testContent);
	var testSize = fs.statSync(testFile).size;

	// Track results
	var answererReceivedFile = null;
	var callerSentFile = false;
	var sessionDone = false;
	var handshakeOK = false;

	// --- Answerer side (WS server) ---

	var httpServer = http.createServer(function(req, res) {
		res.writeHead(426);
		res.end();
	});

	var wss = new WebSocketServer({ noServer: true });

	httpServer.on('upgrade', function(request, socket, head) {
		var pathname = new URL(request.url, 'http://localhost').pathname;
		if (pathname === '/ws/mailer/binkp') {
			wss.handleUpgrade(request, socket, head, function(ws) {
				wss.emit('connection', ws, request);
			});
		} else {
			socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
			socket.destroy();
		}
	});

	wss.on('connection', function(ws, request) {
		console.log('  [server] Inbound WS connection from ' + (request.socket.remoteAddress || '?'));

		var transport = WsTransport.fromWebSocket(ws, request);
		var proto = new BinkpProtocol(transport, {
			quiet: true,
			localAddresses: ['1:200/200'],
			systemName: 'WS Answerer'
		});

		var transfer = new TransferEngine(proto, {
			inboundDir: inDir, tempDir: tmpDir, sessionId: 'ws-answerer'
		});

		transfer.on('receiveComplete', function(info) {
			answererReceivedFile = info;
			console.log('  [server] Received: ' + info.name + ' (' + info.size + ' bytes)');
		});

		proto.on('passwordReceived', function(info) {
			console.log('  [server] Password received from ' + info.addresses.join(', '));
			var ok = false;
			if (info.isCramMD5 && info.challenge) {
				ok = verifyCramMD5(PASSWORD, info.challenge, info.password);
			} else {
				ok = (info.password === PASSWORD);
			}
			if (ok) {
				proto.confirmAuth();
				handshakeOK = true;
			} else {
				proto.sendERR('Bad password');
			}
		});

		proto.on('authenticated', function() {
			console.log('  [server] Authenticated - sending EOB (no outbound files)');
			proto.sendEOB();
		});

		proto.on('error', function(err) {
			console.log('  [server] Error: ' + err.message);
		});

		proto.on('sessionEnd', function() {
			console.log('  [server] Session ended');
			transfer.cleanup();
			transport.close();
		});

		proto.startSession('answerer');
		transport.resume();
	});

	httpServer.listen(TEST_PORT, '127.0.0.1', function() {
		console.log('  [server] WS listening on port ' + TEST_PORT + ' (path: /ws/mailer/binkp)');
	});

	// Small delay to ensure server is ready
	await sleep(100);

	// --- Caller side (WS client) ---

	var wsUrl = 'ws://127.0.0.1:' + TEST_PORT + '/ws/mailer/binkp';
	console.log('  [client] Connecting to ' + wsUrl);
	var callerTransport = WsTransport.connect(wsUrl, 5000);

	callerTransport.once('connect', function() {
		console.log('  [client] Connected');

		var proto = new BinkpProtocol(callerTransport, {
			quiet: true,
			localAddresses: ['1:100/100'],
			sessionPassword: PASSWORD,
			systemName: 'WS Caller'
		});

		var transfer = new TransferEngine(proto, {
			inboundDir: inDir, tempDir: tmpDir, sessionId: 'ws-caller'
		});

		transfer.on('sendComplete', function(info) {
			callerSentFile = true;
			console.log('  [client] Sent: ' + info.name);
		});

		transfer.on('allSent', function() {
			proto.sendEOB();
		});

		proto.on('authenticated', function() {
			console.log('  [client] Authenticated - sending file');
			transfer.queueFile(testFile);
			transfer.markAllQueued();
			transfer.startSending();
		});

		proto.on('sessionEnd', function() {
			console.log('  [client] Session ended');
			sessionDone = true;
			transfer.cleanup();
			callerTransport.close();
		});

		proto.on('error', function(err) {
			console.log('  [client] Error: ' + err.message);
			callerTransport.close();
		});

		proto.startSession('caller');
	});

	callerTransport.once('error', function(err) {
		console.log('  [client] Connection error: ' + err.message);
	});

	// Wait for everything to complete
	var timeout = 5000;
	var waited = 0;
	while (!sessionDone && waited < timeout) {
		await sleep(50);
		waited += 50;
	}

	// Give a beat for file operations to flush
	await sleep(500);

	// --- Assertions ---

	console.log('\n\x1b[1mResults:\x1b[0m');

	assert(handshakeOK, 'Handshake completed successfully');
	assert(callerSentFile, 'Caller sent file');
	assert(answererReceivedFile !== null, 'Answerer received file');

	if (answererReceivedFile) {
		assert(answererReceivedFile.name === 'wstest.pkt', 'Received filename correct');
		assert(answererReceivedFile.size === testSize, 'Received size correct (' + testSize + ' bytes)');

		if (answererReceivedFile.path && fs.existsSync(answererReceivedFile.path)) {
			var received = fs.readFileSync(answererReceivedFile.path, 'utf8');
			assert(received === testContent, 'File content matches original');
		} else {
			assert(false, 'File content matches original (file not found)');
		}
	}

	assert(sessionDone, 'Session completed within timeout');

	// --- Cleanup ---

	wss.close();
	httpServer.close();
	fs.rmSync(tmpBase, { recursive: true, force: true });

	console.log('\n\x1b[1m' + '-'.repeat(40) + '\x1b[0m');
	console.log('\x1b[1mResults: ' + passed + ' passed, ' + failed + ' failed\x1b[0m');
	if (failed > 0) {
		console.log('\x1b[31mSome tests failed!\x1b[0m\n');
		process.exit(1);
	} else {
		console.log('\x1b[32mAll tests passed.\x1b[0m\n');
	}
}

main().catch(function(err) {
	console.error('\x1b[31mTest error:\x1b[0m', err);
	process.exit(1);
});
