#!/usr/bin/env node
// mailer/tests/binkp-echo.js
//
// Standalone binkp echo responder. Accepts inbound binkp connections,
// authenticates any password, receives files to a temp directory, and
// logs all session activity. Useful for:
//
//   - Testing the mailer manager's outbound polling
//   - Verifying binkp framing over real TCP
//   - Debugging handshake issues with remote systems
//   - Checking file transfer integrity
//
// Usage:
//   node mailer/tests/binkp-echo.js [port] [address] [password]
//
// Defaults:
//   port:     24554
//   address:  1:999/999
//   password: (accept any)
//
// Files are received to ./binkp-echo-inbound/
// Press Ctrl+C to stop.

import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { TcpTransport } from '../../src/mailer/transports/tcp.js';
import { BinkpProtocol, verifyCramMD5 } from '../../src/mailer/protocols/binkp.js';
import { TransferEngine } from '../../src/mailer/transfer.js';

var PORT       = parseInt(process.argv[2]) || 24554;
var ADDRESS    = process.argv[3] || '1:999/999';
var ACCEPT_PW  = process.argv[4] || null; // null = accept any
var INBOUND    = './binkp-echo-inbound';
var TEMP       = './binkp-echo-tmp';

// Ensure directories
if (!fs.existsSync(INBOUND)) fs.mkdirSync(INBOUND, { recursive: true });
if (!fs.existsSync(TEMP))    fs.mkdirSync(TEMP, { recursive: true });

var sessionCount = 0;

function log(prefix, msg) {
	var ts = new Date().toISOString().substring(11, 19);
	console.log('\x1b[90m' + ts + '\x1b[0m ' + prefix + ' ' + msg);
}

var server = net.createServer((socket) => {
	sessionCount++;
	var sid = '#' + sessionCount;
	var remote = (socket.remoteAddress || '?') + ':' + (socket.remotePort || '?');

	log(sid, '\x1b[36mInbound connection from ' + remote + '\x1b[0m');

	var transport = TcpTransport.fromSocket(socket);
	var proto = new BinkpProtocol(transport, {
		localAddresses: [ADDRESS],
		systemName: 'binkp-echo',
		sysopName: 'Test Responder'
	});

	var transfer = new TransferEngine(proto, {
		inboundDir: INBOUND,
		tempDir: TEMP,
		sessionId: 'echo-' + sessionCount
	});

	// Log all M_NUL info
	var origNUL = proto._handleNUL.bind(proto);
	proto._handleNUL = function(data) {
		log(sid, '\x1b[90m  NUL: ' + data + '\x1b[0m');
		origNUL(data);
	};

	proto.on('passwordReceived', (info) => {
		log(sid, '  Addresses: ' + info.addresses.join(', '));
		log(sid, '  Password: ' + (info.isCramMD5 ? 'CRAM-MD5' : 'plaintext'));

		var ok = true;
		if (ACCEPT_PW) {
			if (info.isCramMD5 && info.challenge) {
				ok = verifyCramMD5(ACCEPT_PW, info.challenge, info.password);
			} else {
				ok = (info.password === ACCEPT_PW);
			}
		}

		if (ok) {
			log(sid, '\x1b[32m  Authentication OK\x1b[0m');
			proto.confirmAuth();
		} else {
			log(sid, '\x1b[31m  Authentication FAILED\x1b[0m');
			proto.sendERR('Bad password');
		}
	});

	proto.on('authenticated', () => {
		log(sid, '\x1b[32m  Session authenticated\x1b[0m');
		log(sid, '  Remote: ' + (proto._peerOptions.systemName || 'unknown') +
			' [' + proto._peerAddresses.join(', ') + ']');

		// No files to send
		proto.sendEOB();
	});

	proto.on('fileOffered', (info) => {
		log(sid, '\x1b[33m  File offered: ' + info.name + ' (' + info.size + ' bytes)\x1b[0m');
	});

	transfer.on('receiveProgress', (info) => {
		var pct = Math.floor((info.received / info.size) * 100);
		process.stdout.write('\r  ' + sid + ' Receiving ' + info.name + ': ' + pct + '%');
	});

	transfer.on('receiveComplete', (info) => {
		process.stdout.write('\r');
		log(sid, '\x1b[32m  Received: ' + info.name + ' (' + info.size + ' bytes) → ' + info.path + '\x1b[0m');
	});

	transfer.on('transferError', (info) => {
		log(sid, '\x1b[31m  Transfer error: ' + info.name + ' — ' + (info.error ? info.error.message : 'unknown') + '\x1b[0m');
	});

	proto.on('remoteEOB', () => {
		log(sid, '  Remote sent EOB');
	});

	proto.on('sessionEnd', () => {
		log(sid, '\x1b[36m  Session complete\x1b[0m');
		transfer.cleanup();
	});

	proto.on('error', (err) => {
		log(sid, '\x1b[31m  Error: ' + err.message + '\x1b[0m');
		transfer.cleanup();
	});

	transport.on('close', () => {
		log(sid, '  Connection closed');
	});

	proto.startSession('answerer');
	transport.resume(); // Socket was paused by fromSocket — resume after protocol wired
});

server.on('error', (err) => {
	if (err.code === 'EADDRINUSE') {
		console.error('\x1b[31mPort ' + PORT + ' is already in use.\x1b[0m');
		process.exit(1);
	}
	console.error('\x1b[31mServer error:\x1b[0m', err.message);
});

server.listen(PORT, () => {
	console.log('\x1b[1m\x1b[36m┌────────────────────────────────────┐\x1b[0m');
	console.log('\x1b[1m\x1b[36m│       binkp Echo Responder         │\x1b[0m');
	console.log('\x1b[1m\x1b[36m└────────────────────────────────────┘\x1b[0m');
	console.log('  Listening:  \x1b[1m0.0.0.0:' + PORT + '\x1b[0m');
	console.log('  Address:    \x1b[1m' + ADDRESS + '\x1b[0m');
	console.log('  Password:   \x1b[1m' + (ACCEPT_PW || '(accept any)') + '\x1b[0m');
	console.log('  Inbound:    \x1b[1m' + path.resolve(INBOUND) + '\x1b[0m');
	console.log('  Press Ctrl+C to stop.\n');
});

process.on('SIGINT', () => {
	console.log('\n  Shutting down...');
	server.close();
	process.exit(0);
});
