#!/usr/bin/env node
// mailer/tests/binkp-send.js
//
// Standalone binkp caller. Connects to a remote binkp server, authenticates,
// and sends one or more files. Useful for:
//
//   - Testing connectivity to remote binkd or binkp-echo
//   - Verifying the mailer's answerer side from the outside
//   - Sending test packets manually
//
// Usage:
//   node mailer/tests/binkp-send.js <host> <port> <address> <password> [file1] [file2] ...
//
// Example:
//   node mailer/tests/binkp-send.js localhost 24554 1:100/100 testpass ./outbound/test.pkt
//
// If no files are specified, runs a handshake-only session (useful for
// testing authentication).

import * as fs from 'fs';
import * as path from 'path';
import { TcpTransport } from '../../src/mailer/transports/tcp.js';
import { BinkpProtocol } from '../../src/mailer/protocols/binkp.js';
import { TransferEngine } from '../../src/mailer/transfer.js';

var HOST     = process.argv[2];
var PORT     = parseInt(process.argv[3]);
var ADDRESS  = process.argv[4];
var PASSWORD = process.argv[5] || '';
var FILES    = process.argv.slice(6);

if (!HOST || !PORT || !ADDRESS) {
	console.log('Usage: node binkp-send.js <host> <port> <address> <password> [file1] [file2] ...');
	console.log('');
	console.log('  host      Remote hostname or IP');
	console.log('  port      Remote port (typically 24554)');
	console.log('  address   Our FTN address (e.g. 1:100/100)');
	console.log('  password  Session password (use "" for empty)');
	console.log('  file...   Files to send (optional)');
	console.log('');
	console.log('Example:');
	console.log('  node binkp-send.js localhost 24554 1:100/100 testpass ./test.pkt');
	process.exit(1);
}

// Validate files exist
for (var f of FILES) {
	if (!fs.existsSync(f)) {
		console.error('\x1b[31mFile not found: ' + f + '\x1b[0m');
		process.exit(1);
	}
}

function log(msg) {
	var ts = new Date().toISOString().substring(11, 19);
	console.log('\x1b[90m' + ts + '\x1b[0m ' + msg);
}

// Temp dirs for receiving (in case remote sends us files)
var tmpBase = './tmp/mailer/send-' + Date.now();
var inDir   = path.join(tmpBase, 'in');
var tmpDir  = path.join(tmpBase, 'tmp');
fs.mkdirSync(inDir, { recursive: true });
fs.mkdirSync(tmpDir, { recursive: true });

log('Connecting to \x1b[1m' + HOST + ':' + PORT + '\x1b[0m');
log('Our address: \x1b[1m' + ADDRESS + '\x1b[0m');
log('Password: \x1b[1m' + (PASSWORD || '(empty)') + '\x1b[0m');
log('Files to send: \x1b[1m' + (FILES.length > 0 ? FILES.join(', ') : '(none — handshake only)') + '\x1b[0m');
console.log('');

var transport = TcpTransport.connect(HOST, PORT, 10000);

transport.once('connect', () => {
	log('\x1b[32mConnected\x1b[0m');

	var proto = new BinkpProtocol(transport, {
		localAddresses: [ADDRESS],
		sessionPassword: PASSWORD,
		systemName: 'binkp-send tool'
	});

	var transfer = new TransferEngine(proto, {
		inboundDir: inDir, tempDir: tmpDir, sessionId: 'send-tool'
	});

	// Log remote info
	var origNUL = proto._handleNUL.bind(proto);
	proto._handleNUL = function(data) {
		log('\x1b[90m  Remote NUL: ' + data + '\x1b[0m');
		origNUL(data);
	};

	proto.on('authenticated', () => {
		log('\x1b[32mAuthenticated\x1b[0m');
		log('  Remote: ' + (proto._peerOptions.systemName || 'unknown') +
			' [' + proto._peerAddresses.join(', ') + ']');

		if (FILES.length > 0) {
			for (var f of FILES) {
				transfer.queueFile(f);
				log('  Queued: ' + path.basename(f));
			}
			transfer.markAllQueued();
			transfer.startSending();
		} else {
			log('  No files to send');
			proto.sendEOB();
		}
	});

	transfer.on('sendProgress', (info) => {
		var pct = Math.floor((info.sent / info.size) * 100);
		process.stdout.write('\r  Sending ' + info.name + ': ' + pct + '% (' + info.sent + '/' + info.size + ')');
	});

	transfer.on('sendComplete', (info) => {
		process.stdout.write('\r');
		log('\x1b[32m  Sent: ' + info.name + '\x1b[0m');
	});

	transfer.on('allSent', () => {
		log('  All files sent — sending EOB');
		proto.sendEOB();
	});

	transfer.on('receiveComplete', (info) => {
		log('\x1b[33m  Received from remote: ' + info.name + ' (' + info.size + ' bytes)\x1b[0m');
	});

	proto.on('remoteEOB', () => {
		log('  Remote sent EOB');
	});

	proto.on('sessionEnd', () => {
		log('\x1b[32mSession complete\x1b[0m');
		transfer.cleanup();
		transport.close();
		cleanup();
	});

	proto.on('error', (err) => {
		log('\x1b[31mError: ' + err.message + '\x1b[0m');
		transfer.cleanup();
		transport.close();
		cleanup();
	});

	proto.startSession('caller');
});

transport.once('error', (err) => {
	log('\x1b[31mConnection failed: ' + err.message + '\x1b[0m');
	cleanup();
});

function cleanup() {
	try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch (_) {}
	setTimeout(() => process.exit(0), 200);
}

// Timeout safety
setTimeout(() => {
	log('\x1b[31mTimeout — no response within 30 seconds\x1b[0m');
	transport.destroy();
	cleanup();
}, 30000);
