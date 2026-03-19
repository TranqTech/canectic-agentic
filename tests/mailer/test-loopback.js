#!/usr/bin/env node
// mailer/tests/test-loopback.js
//
// Loopback integration test. Wires two binkp protocol instances together
// via paired transports (write to one → data event on the other). Runs a
// full handshake and file transfer without any network or database.
//
// Tests: frame encoding/decoding, caller/answerer handshake, password
// validation, file offer/send/receive/GOT, EOB, session end.
//
// Run: node mailer/tests/test-loopback.js

import { EventEmitter } from 'node:events';
import { BinkpProtocol, verifyCramMD5 } from '../../src/mailer/protocols/binkp.js';
import { TransferEngine } from '../../src/mailer/transfer.js';
import * as fs from 'fs';
import * as path from 'path';

// --- Paired mock transports — write to A delivers to B and vice versa ---

class PairedTransport extends EventEmitter {
	constructor(name) {
		super();
		this._name = name;
		this._connected = true;
		this._peer = null;
		this._paused = false;
		this._pauseBuffer = [];
	}
	setPeer(peer) { this._peer = peer; }
	write(buffer) {
		if (this._peer && this._peer._connected) {
			// Async delivery to simulate real network
			setImmediate(() => {
				if (this._peer._paused) {
					this._peer._pauseBuffer.push(Buffer.from(buffer));
				} else {
					this._peer.emit('data', Buffer.from(buffer));
				}
			});
		}
	}
	close() {
		this._connected = false;
		setImmediate(() => this.emit('close'));
	}
	destroy() {
		this._connected = false;
		setImmediate(() => this.emit('close'));
	}
	pause() { this._paused = true; }
	resume() {
		this._paused = false;
		// Flush buffered data
		while (this._pauseBuffer.length > 0) {
			this.emit('data', this._pauseBuffer.shift());
		}
	}
	get remoteAddress() { return 'loopback:' + this._name; }
	get isConnected() { return this._connected; }
}

function createPair() {
	var a = new PairedTransport('caller');
	var b = new PairedTransport('answerer');
	a.setPeer(b);
	b.setPeer(a);
	return { caller: a, answerer: b };
}

// --- Test helpers ---

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

// -----------------------------------------------------------------------
// Test 1: Basic handshake (plaintext password)
// -----------------------------------------------------------------------

async function testBasicHandshake() {
	console.log('\n\x1b[1mTest 1: Handshake with CRAM-MD5\x1b[0m');

	var pair = createPair();
	var sessionPassword = 'testpass';

	var callerProto = new BinkpProtocol(pair.caller, {
		quiet: true,
		localAddresses: ['1:100/100'],
		sessionPassword: sessionPassword,
		systemName: 'Caller BBS'
	});

	var answererProto = new BinkpProtocol(pair.answerer, {
		quiet: true,
		localAddresses: ['1:200/200'],
		systemName: 'Answerer BBS'
	});

	var callerAuth = false;
	var answererAuth = false;
	var callerError = null;
	var answererError = null;

	callerProto.on('authenticated', () => { callerAuth = true; });
	answererProto.on('authenticated', () => { answererAuth = true; });
	callerProto.on('error', (err) => { callerError = err; });
	answererProto.on('error', (err) => { answererError = err; });

	// Answerer validates password — handle both CRAM-MD5 and plaintext
	answererProto.on('passwordReceived', (info) => {
		var ok = false;
		if (info.isCramMD5 && info.challenge) {
			ok = verifyCramMD5(sessionPassword, info.challenge, info.password);
		} else {
			ok = (info.password === sessionPassword);
		}
		if (ok) {
			answererProto.confirmAuth();
		} else {
			answererProto.sendERR('Bad password');
		}
	});

	// Start both sides
	answererProto.startSession('answerer');
	callerProto.startSession('caller');

	await sleep(200);

	assert(callerAuth, 'Caller received authenticated event');
	assert(answererAuth, 'Answerer received authenticated event');
	assert(callerError === null, 'No caller errors');
	assert(answererError === null, 'No answerer errors');
	assert(answererProto._peerAddresses[0] === '1:100/100', 'Answerer sees caller address');
	assert(callerProto._peerAddresses[0] === '1:200/200', 'Caller sees answerer address');
	assert(answererProto._peerOptions.systemName === 'Caller BBS', 'Answerer sees caller system name');
	assert(callerProto._peerOptions.systemName === 'Answerer BBS', 'Caller sees answerer system name');
}

// -----------------------------------------------------------------------
// Test 2: CRAM-MD5 handshake
// -----------------------------------------------------------------------

async function testCramMD5Handshake() {
	console.log('\n\x1b[1mTest 2: CRAM-MD5 handshake\x1b[0m');

	var pair = createPair();
	var sessionPassword = 'cramtest';

	var callerProto = new BinkpProtocol(pair.caller, {
		quiet: true,
		localAddresses: ['1:100/100'],
		sessionPassword: sessionPassword,
		systemName: 'CRAM Caller'
	});

	var answererProto = new BinkpProtocol(pair.answerer, {
		quiet: true,
		localAddresses: ['1:200/200'],
		systemName: 'CRAM Answerer'
	});

	var callerAuth = false;
	var answererAuth = false;

	callerProto.on('authenticated', () => { callerAuth = true; });
	answererProto.on('authenticated', () => { answererAuth = true; });
	callerProto.on('error', () => {});
	answererProto.on('error', () => {});

	answererProto.on('passwordReceived', (info) => {
		var ok = false;
		if (info.isCramMD5 && info.challenge) {
			ok = verifyCramMD5(sessionPassword, info.challenge, info.password);
		}
		if (ok) {
			answererProto.confirmAuth();
		} else {
			answererProto.sendERR('CRAM-MD5 failed');
		}
	});

	// Answerer starts first (sends challenge in M_NUL OPT)
	answererProto.startSession('answerer');
	callerProto.startSession('caller');

	await sleep(200);

	assert(callerAuth, 'Caller authenticated via CRAM-MD5');
	assert(answererAuth, 'Answerer authenticated via CRAM-MD5');
}

// -----------------------------------------------------------------------
// Test 3: Bad password rejection
// -----------------------------------------------------------------------

async function testBadPassword() {
	console.log('\n\x1b[1mTest 3: Bad password rejection\x1b[0m');

	var pair = createPair();

	var callerProto = new BinkpProtocol(pair.caller, {
		quiet: true,
		localAddresses: ['1:100/100'],
		sessionPassword: 'wrongpass',
		systemName: 'Bad Caller'
	});

	var answererProto = new BinkpProtocol(pair.answerer, {
		quiet: true,
		localAddresses: ['1:200/200'],
		systemName: 'Strict Answerer'
	});

	var callerError = null;

	callerProto.on('error', (err) => { callerError = err; });
	answererProto.on('error', () => {}); // Swallow answerer-side errors

	answererProto.on('passwordReceived', (info) => {
		var ok = false;
		if (info.isCramMD5 && info.challenge) {
			ok = verifyCramMD5('correctpass', info.challenge, info.password);
		} else {
			ok = (info.password === 'correctpass');
		}
		if (ok) {
			answererProto.confirmAuth();
		} else {
			answererProto.sendERR('Authentication failed');
		}
	});

	answererProto.startSession('answerer');
	callerProto.startSession('caller');

	await sleep(200);

	assert(callerError !== null, 'Caller received error event');
	assert(callerError.message.includes('Authentication failed'), 'Error message from remote');
	assert(callerProto.state === 'error', 'Caller state is error');
}

// -----------------------------------------------------------------------
// Test 4: File transfer (caller → answerer)
// -----------------------------------------------------------------------

async function testFileTransfer() {
	console.log('\n\x1b[1mTest 4: File transfer (caller → answerer)\x1b[0m');

	// Create temp directories
	var tmpBase    = './tmp/mailer/loopback-' + Date.now();
	var outDir     = path.join(tmpBase, 'outbound');
	var inDir      = path.join(tmpBase, 'inbound');
	var tmpDir     = path.join(tmpBase, 'tmp');
	fs.mkdirSync(outDir, { recursive: true });
	fs.mkdirSync(inDir, { recursive: true });
	fs.mkdirSync(tmpDir, { recursive: true });

	// Create a test file in outbound
	var testContent = 'This is test packet data for the binkp loopback test.\r\n'.repeat(20);
	var testFile    = path.join(outDir, 'test0001.pkt');
	fs.writeFileSync(testFile, testContent);
	var testSize = fs.statSync(testFile).size;

	var pair = createPair();
	var sessionPassword = 'filetest';

	// Caller protocol + transfer
	var callerProto = new BinkpProtocol(pair.caller, {
		quiet: true,
		localAddresses: ['1:100/100'],
		sessionPassword: sessionPassword,
		systemName: 'File Sender'
	});

	// Answerer protocol + transfer
	var answererProto = new BinkpProtocol(pair.answerer, {
		quiet: true,
		localAddresses: ['1:200/200'],
		systemName: 'File Receiver'
	});

	var callerTransfer = null;
	var answererTransfer = null;
	var callerSent = false;
	var answererReceived = null;
	var sessionComplete = false;

	callerProto.on('error', () => {});
	answererProto.on('error', () => {});

	// Wire handshake
	callerProto.on('authenticated', () => {
		callerTransfer = new TransferEngine(callerProto, {
			inboundDir: inDir, tempDir: tmpDir, sessionId: 'caller-test'
		});

		callerTransfer.on('sendComplete', () => { callerSent = true; });
		callerTransfer.on('allSent', () => { callerProto.sendEOB(); });

		// Queue the test file and start
		callerTransfer.queueFile(testFile);
		callerTransfer.markAllQueued();
		callerTransfer.startSending();
	});

	answererProto.on('authenticated', () => {
		answererTransfer = new TransferEngine(answererProto, {
			inboundDir: inDir, tempDir: tmpDir, sessionId: 'answerer-test'
		});

		answererTransfer.on('receiveComplete', (info) => { answererReceived = info; });

		// Answerer has no files to send
		answererProto.sendEOB();
	});

	answererProto.on('passwordReceived', (info) => {
		var ok = false;
		if (info.isCramMD5 && info.challenge) {
			ok = verifyCramMD5(sessionPassword, info.challenge, info.password);
		} else {
			ok = (info.password === sessionPassword);
		}
		if (ok) {
			answererProto.confirmAuth();
		} else {
			answererProto.sendERR('Bad password');
		}
	});

	callerProto.on('sessionEnd', () => { sessionComplete = true; });
	answererProto.on('sessionEnd', () => { sessionComplete = true; });

	// Start
	answererProto.startSession('answerer');
	callerProto.startSession('caller');

	// Wait for transfer to complete (async stream flush + pendingGOTs)
	await sleep(1000);

	assert(callerSent, 'Caller: sendComplete event fired');
	assert(answererReceived !== null, 'Answerer: receiveComplete event fired');
	assert(answererReceived && answererReceived.name === 'test0001.pkt', 'Received filename correct');
	assert(answererReceived && answererReceived.size === testSize, 'Received size correct (' + testSize + ' bytes)');

	// Verify file content in inbound directory
	var receivedPath = answererReceived ? answererReceived.path : null;
	if (receivedPath && fs.existsSync(receivedPath)) {
		var receivedContent = fs.readFileSync(receivedPath, 'utf8');
		assert(receivedContent === testContent, 'File content matches original');
	} else {
		assert(false, 'File content matches original (file not found at ' + receivedPath + ')');
	}

	assert(sessionComplete, 'Session ended normally');

	// Cleanup
	callerTransfer && callerTransfer.cleanup();
	answererTransfer && answererTransfer.cleanup();
	fs.rmSync(tmpBase, { recursive: true, force: true });
}

// -----------------------------------------------------------------------
// Test 5: EOB with no files
// -----------------------------------------------------------------------

async function testEmptySession() {
	console.log('\n\x1b[1mTest 5: Empty session (no files either side)\x1b[0m');

	var pair = createPair();

	var callerProto = new BinkpProtocol(pair.caller, {
		quiet: true,
		localAddresses: ['1:100/100'],
		sessionPassword: 'empty',
		systemName: 'Empty Caller'
	});

	var answererProto = new BinkpProtocol(pair.answerer, {
		quiet: true,
		localAddresses: ['1:200/200'],
		systemName: 'Empty Answerer'
	});

	var bothDone = false;

	callerProto.on('error', () => {});
	answererProto.on('error', () => {});

	answererProto.on('passwordReceived', (info) => {
		answererProto.confirmAuth();
	});

	callerProto.on('authenticated', () => {
		callerProto.sendEOB();
	});

	answererProto.on('authenticated', () => {
		answererProto.sendEOB();
	});

	callerProto.on('sessionEnd', () => { bothDone = true; });

	answererProto.startSession('answerer');
	callerProto.startSession('caller');

	await sleep(200);

	assert(bothDone, 'Session completed with no files');
	assert(callerProto.state === 'done', 'Caller state is done');
	assert(answererProto.state === 'done', 'Answerer state is done');
}

// -----------------------------------------------------------------------
// Test 6: Double EOB protection
// -----------------------------------------------------------------------

async function testDoubleEOB() {
	console.log('\n\x1b[1mTest 6: Double EOB protection\x1b[0m');

	var pair = createPair();

	var callerProto = new BinkpProtocol(pair.caller, {
		quiet: true,
		localAddresses: ['1:100/100'],
		sessionPassword: 'eob',
		systemName: 'EOB Caller'
	});

	var answererProto = new BinkpProtocol(pair.answerer, {
		quiet: true,
		localAddresses: ['1:200/200'],
		systemName: 'EOB Answerer'
	});

	callerProto.on('error', () => {});
	answererProto.on('error', () => {});

	answererProto.on('passwordReceived', (info) => {
		answererProto.confirmAuth();
	});

	var sessionEndCount = 0;

	callerProto.on('authenticated', () => {
		// Send EOB twice — should only emit one
		callerProto.sendEOB();
		callerProto.sendEOB();
	});

	answererProto.on('authenticated', () => {
		answererProto.sendEOB();
	});

	callerProto.on('sessionEnd', () => { sessionEndCount++; });

	answererProto.startSession('answerer');
	callerProto.startSession('caller');

	await sleep(200);

	assert(sessionEndCount === 1, 'sessionEnd emitted exactly once (got ' + sessionEndCount + ')');
	assert(callerProto.state === 'done', 'Caller state is done');
}

// -----------------------------------------------------------------------
// Test 7: NR mode (offset -1) handling
// -----------------------------------------------------------------------

async function testNRMode() {
	console.log('\n\x1b[1mTest 7: NR mode (offset -1) file receive\x1b[0m');

	var pair = createPair();
	var sessionPassword = 'nrtest';

	// Temp dirs
	var tmpBase = './tmp/mailer/loopback-nr-' + Date.now();
	var inDir   = path.join(tmpBase, 'inbound');
	var tmpDir  = path.join(tmpBase, 'tmp');
	fs.mkdirSync(inDir, { recursive: true });
	fs.mkdirSync(tmpDir, { recursive: true });

	var callerProto = new BinkpProtocol(pair.caller, {
		quiet: true,
		localAddresses: ['1:100/100'],
		sessionPassword: sessionPassword,
		systemName: 'NR Caller'
	});

	var answererProto = new BinkpProtocol(pair.answerer, {
		quiet: true,
		localAddresses: ['1:200/200'],
		systemName: 'NR Answerer'
	});

	callerProto.on('error', () => {});
	answererProto.on('error', () => {});

	var receivedFile = null;
	var getReceived = false;

	answererProto.on('passwordReceived', (info) => {
		var ok = false;
		if (info.isCramMD5 && info.challenge) {
			ok = verifyCramMD5(sessionPassword, info.challenge, info.password);
		} else {
			ok = (info.password === sessionPassword);
		}
		if (ok) {
			answererProto.confirmAuth();
		} else {
			answererProto.sendERR('Bad password');
		}
	});

	// Answerer receives files
	answererProto.on('authenticated', () => {
		var transfer = new TransferEngine(answererProto, {
			inboundDir: inDir, tempDir: tmpDir, sessionId: 'nr-answerer'
		});

		transfer.on('receiveComplete', (info) => {
			receivedFile = info;
		});

		// Answerer has no files to send
		answererProto.sendEOB();
	});

	// Caller will manually send a file in NR mode (offset -1)
	callerProto.on('authenticated', () => {
		// Listen for M_GET from answerer
		callerProto.on('fileRequested', (info) => {
			getReceived = true;
		});

		// Offer file with offset -1 (NR mode)
		callerProto.offerFile('nrtest.pkt', 20, Date.now(), -1);
	});

	// Listen for M_GET on the caller side — when answerer sends M_GET,
	// we send the data. We hook _handleGET.
	var origGET = callerProto._handleGET.bind(callerProto);
	callerProto._handleGET = function(data) {
		origGET(data);
		getReceived = true;
		// Now send the actual data + re-offer with real offset
		callerProto.offerFile('nrtest.pkt', 20, Date.now(), 0);
		callerProto.sendFileData(Buffer.alloc(20, 0x41));
		callerProto.sendEOB();
	};

	answererProto.startSession('answerer');
	callerProto.startSession('caller');

	await sleep(1000);

	assert(getReceived, 'Answerer sent M_GET in response to NR offer');
	assert(receivedFile !== null, 'File received by answerer');
	if (receivedFile) {
		assert(receivedFile.name === 'nrtest.pkt', 'Received filename correct');
		assert(receivedFile.size === 20, 'Received size correct');
	}

	fs.rmSync(tmpBase, { recursive: true, force: true });
}

// -----------------------------------------------------------------------
// Test 8: Path traversal rejection
// -----------------------------------------------------------------------

async function testPathTraversal() {
	console.log('\n\x1b[1mTest 8: Path traversal filename sanitization\x1b[0m');

	var tmpBase = './tmp/mailer/loopback-traversal-' + Date.now();
	var inDir   = path.join(tmpBase, 'inbound');
	var tmpDir  = path.join(tmpBase, 'tmp');
	fs.mkdirSync(inDir, { recursive: true });
	fs.mkdirSync(tmpDir, { recursive: true });

	var pair = createPair();
	var sessionPassword = 'traverse';

	var callerProto = new BinkpProtocol(pair.caller, {
		quiet: true,
		localAddresses: ['1:100/100'],
		sessionPassword: sessionPassword,
		systemName: 'Traversal Caller'
	});

	var answererProto = new BinkpProtocol(pair.answerer, {
		quiet: true,
		localAddresses: ['1:200/200'],
		systemName: 'Traversal Answerer'
	});

	callerProto.on('error', () => {});
	answererProto.on('error', () => {});

	var skippedFiles = [];
	var offeredFiles = [];

	answererProto.on('passwordReceived', (info) => {
		var ok = false;
		if (info.isCramMD5 && info.challenge) {
			ok = verifyCramMD5(sessionPassword, info.challenge, info.password);
		} else {
			ok = (info.password === sessionPassword);
		}
		if (ok) answererProto.confirmAuth();
	});

	answererProto.on('authenticated', () => {
		var transfer = new TransferEngine(answererProto, {
			inboundDir: inDir, tempDir: tmpDir, sessionId: 'trav-test'
		});

		// Track which filenames the transfer engine actually sees
		answererProto.on('fileOffered', (info) => {
			offeredFiles.push(info.name);
		});

		answererProto.sendEOB();
	});

	// Track M_SKIP responses from answerer
	callerProto.on('fileSkipped', (info) => {
		skippedFiles.push(info.name);
	});

	callerProto.on('authenticated', () => {
		// Offer files with dangerous names:
		// ../../../etc/passwd → basename strips to "passwd" (safe, accepted)
		// /tmp/evil.sh        → basename strips to "evil.sh" (safe, accepted)
		// ..                  → rejected (bare ".." is dangerous)
		// \x00\x01\x02        → rejected (empty after control char strip)
		callerProto.offerFile('../../../etc/passwd', 10, Date.now(), 0);
		callerProto.offerFile('/tmp/evil.sh', 10, Date.now(), 0);
		callerProto.offerFile('..', 10, Date.now(), 0);
		callerProto.offerFile('\x00\x01\x02', 10, Date.now(), 0);
		callerProto.sendEOB();
	});

	answererProto.startSession('answerer');
	callerProto.startSession('caller');

	await sleep(500);

	// Path components stripped — "passwd" and "evil.sh" are safe bare names
	assert(offeredFiles.includes('passwd'), 'Directory-stripped "passwd" accepted');
	assert(offeredFiles.includes('evil.sh'), 'Directory-stripped "evil.sh" accepted');

	// Bare ".." and control-only names rejected
	assert(skippedFiles.length === 2, 'Two dangerous filenames were skipped (got ' + skippedFiles.length + ')');

	fs.rmSync(tmpBase, { recursive: true, force: true });
}

// -----------------------------------------------------------------------
// Run all tests
// -----------------------------------------------------------------------

async function main() {
	console.log('\x1b[1m\x1b[36m=== binkp Loopback Test Suite ===\x1b[0m');

	await testBasicHandshake();
	await testCramMD5Handshake();
	await testBadPassword();
	await testFileTransfer();
	await testEmptySession();
	await testDoubleEOB();
	await testNRMode();
	await testPathTraversal();

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
	console.error('\x1b[31mTest suite error:\x1b[0m', err);
	process.exit(1);
});
