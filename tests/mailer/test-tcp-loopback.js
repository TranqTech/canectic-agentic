#!/usr/bin/env node
// mailer/tests/test-tcp-loopback.js
//
// TCP integration test. Starts a real TCP listener, connects to it,
// runs a binkp handshake and file transfer over actual sockets.
// No database — wires protocol events manually.
//
// This validates the full stack: TCP transport → binkp framing → file
// transfer, over real network I/O with real buffering behavior.
//
// Run: node mailer/tests/test-tcp-loopback.js

import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { TcpTransport } from '../../src/mailer/transports/tcp.js';
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
	console.log('\x1b[1m\x1b[36m=== binkp TCP Loopback Test ===\x1b[0m\n');

	var TEST_PORT = 34567 + Math.floor(Math.random() * 10000);
	var PASSWORD  = 'tcptest';

	// Temp directories
	var tmpBase = './tmp/mailer/tcp-' + Date.now();
	var outDir  = path.join(tmpBase, 'outbound');
	var inDir   = path.join(tmpBase, 'inbound');
	var tmpDir  = path.join(tmpBase, 'tmp');
	fs.mkdirSync(outDir, { recursive: true });
	fs.mkdirSync(inDir, { recursive: true });
	fs.mkdirSync(tmpDir, { recursive: true });

	// Create test file
	var testContent = 'TCP loopback test data — ' + Date.now() + '\r\n';
	testContent = testContent.repeat(50);
	var testFile = path.join(outDir, 'tcptest.pkt');
	fs.writeFileSync(testFile, testContent);
	var testSize = fs.statSync(testFile).size;

	// Track results
	var answererReceivedFile = null;
	var callerSentFile = false;
	var sessionDone = false;
	var handshakeOK = false;

	// --- Answerer side (server) ---

	var server = net.createServer((socket) => {
		console.log('  [server] Inbound connection from ' + socket.remoteAddress + ':' + socket.remotePort);

		var transport = TcpTransport.fromSocket(socket);
		var proto = new BinkpProtocol(transport, {
			localAddresses: ['1:200/200'],
			systemName: 'TCP Answerer'
		});

		var transfer = new TransferEngine(proto, {
			inboundDir: inDir, tempDir: tmpDir, sessionId: 'tcp-answerer'
		});

		transfer.on('receiveComplete', (info) => {
			answererReceivedFile = info;
			console.log('  [server] Received: ' + info.name + ' (' + info.size + ' bytes)');
		});

		proto.on('passwordReceived', (info) => {
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

		proto.on('authenticated', () => {
			console.log('  [server] Authenticated — sending EOB (no outbound files)');
			proto.sendEOB();
		});

		proto.on('error', (err) => {
			console.log('  [server] Error: ' + err.message);
		});

		proto.on('sessionEnd', () => {
			console.log('  [server] Session ended');
			transfer.cleanup();
			transport.close();
		});

		proto.startSession('answerer');
	});

	server.listen(TEST_PORT, '127.0.0.1', () => {
		console.log('  [server] Listening on port ' + TEST_PORT);
	});

	// Small delay to ensure server is ready
	await sleep(100);

	// --- Caller side (client) ---

	console.log('  [client] Connecting to 127.0.0.1:' + TEST_PORT);
	var callerTransport = TcpTransport.connect('127.0.0.1', TEST_PORT, 5000);

	callerTransport.once('connect', () => {
		console.log('  [client] Connected');

		var proto = new BinkpProtocol(callerTransport, {
			localAddresses: ['1:100/100'],
			sessionPassword: PASSWORD,
			systemName: 'TCP Caller'
		});

		var transfer = new TransferEngine(proto, {
			inboundDir: inDir, tempDir: tmpDir, sessionId: 'tcp-caller'
		});

		transfer.on('sendComplete', (info) => {
			callerSentFile = true;
			console.log('  [client] Sent: ' + info.name);
		});

		transfer.on('allSent', () => {
			proto.sendEOB();
		});

		proto.on('authenticated', () => {
			console.log('  [client] Authenticated — sending file');
			transfer.queueFile(testFile);
			transfer.markAllQueued();
			transfer.startSending();
		});

		proto.on('sessionEnd', () => {
			console.log('  [client] Session ended');
			sessionDone = true;
			transfer.cleanup();
			callerTransport.close();
		});

		proto.on('error', (err) => {
			console.log('  [client] Error: ' + err.message);
			callerTransport.close();
		});

		proto.startSession('caller');
	});

	callerTransport.once('error', (err) => {
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
	await sleep(100);

	// --- Assertions ---

	console.log('\n\x1b[1mResults:\x1b[0m');

	assert(handshakeOK, 'Handshake completed successfully');
	assert(callerSentFile, 'Caller sent file');
	assert(answererReceivedFile !== null, 'Answerer received file');

	if (answererReceivedFile) {
		assert(answererReceivedFile.name === 'tcptest.pkt', 'Received filename correct');
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

	server.close();
	fs.rmSync(tmpBase, { recursive: true, force: true });

	console.log('\n\x1b[1m' + '─'.repeat(40) + '\x1b[0m');
	console.log('\x1b[1mResults: ' + passed + ' passed, ' + failed + ' failed\x1b[0m');
	if (failed > 0) {
		console.log('\x1b[31mSome tests failed!\x1b[0m\n');
		process.exit(1);
	} else {
		console.log('\x1b[32mAll tests passed.\x1b[0m\n');
	}
}

main().catch(err => {
	console.error('\x1b[31mTest error:\x1b[0m', err);
	process.exit(1);
});
