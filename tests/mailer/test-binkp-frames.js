#!/usr/bin/env node
// mailer/tests/test-binkp-frames.js
//
// Unit test for binkp frame encoding/decoding. No network, no database.
// Tests the protocol module's ability to parse frames from a byte stream,
// handle partial frames, and correctly encode outbound frames.
//
// Run: node mailer/tests/test-binkp-frames.js

import { EventEmitter } from 'node:events';
import { BinkpProtocol, verifyCramMD5, M_NUL, M_ADR, M_PWD, M_FILE, M_OK, M_EOB, M_GOT, M_ERR } from '../../src/mailer/protocols/binkp.js';

// --- Mock transport — collects written bytes and lets us inject data ---

class MockTransport extends EventEmitter {
	constructor() {
		super();
		this._connected = true;
		this.written = [];     // Array of Buffers written by the protocol
	}
	write(buffer) { this.written.push(Buffer.from(buffer)); }
	close() { this._connected = false; }
	destroy() { this._connected = false; }
	get remoteAddress() { return 'mock:0'; }
	get isConnected() { return this._connected; }

	// Inject raw bytes as if received from the network
	inject(buffer) { this.emit('data', Buffer.from(buffer)); }

	// Get all written bytes as a single buffer
	getWritten() { return Buffer.concat(this.written); }

	// Reset written buffer
	clearWritten() { this.written = []; }
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

function buildCmdFrame(cmdId, data) {
	var payload = Buffer.from(data, 'utf8');
	var frame = Buffer.alloc(2 + 1 + payload.length);
	frame.writeUInt16BE(0x8000 | (1 + payload.length), 0);
	frame[2] = cmdId;
	payload.copy(frame, 3);
	return frame;
}

function buildDataFrame(data) {
	var payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
	var frame = Buffer.alloc(2 + payload.length);
	frame.writeUInt16BE(payload.length, 0);
	payload.copy(frame, 2);
	return frame;
}

// -----------------------------------------------------------------------
// Test 1: Command frame encoding
// -----------------------------------------------------------------------

console.log('\n\x1b[1mTest 1: Command frame encoding\x1b[0m');
{
	var transport = new MockTransport();
	var proto = new BinkpProtocol(transport, {
		localAddresses: ['1:123/456'],
		sessionPassword: 'testpass'
	});

	// Manually send a command
	proto._sendCmd(M_NUL, 'SYS Test BBS');
	var written = transport.getWritten();

	// Header: 0x8000 | (1 + 12) = 0x800D
	assert(written.length === 2 + 1 + 12, 'Frame length correct (15 bytes)');
	assert((written.readUInt16BE(0) & 0x8000) !== 0, 'Command flag set');
	assert((written.readUInt16BE(0) & 0x7FFF) === 13, 'Payload length = 13');
	assert(written[2] === M_NUL, 'Command ID = M_NUL (0)');
	assert(written.subarray(3).toString('utf8') === 'SYS Test BBS', 'Payload content correct');
}

// -----------------------------------------------------------------------
// Test 2: Data frame encoding
// -----------------------------------------------------------------------

console.log('\n\x1b[1mTest 2: Data frame encoding\x1b[0m');
{
	var transport = new MockTransport();
	var proto = new BinkpProtocol(transport, { localAddresses: ['1:1/1'] });

	var testData = Buffer.from('Hello file data');
	proto._sendDataFrame(testData);
	var written = transport.getWritten();

	assert(written.length === 2 + 15, 'Frame length correct (17 bytes)');
	assert((written.readUInt16BE(0) & 0x8000) === 0, 'Command flag clear (data frame)');
	assert((written.readUInt16BE(0) & 0x7FFF) === 15, 'Payload length = 15');
	assert(written.subarray(2).toString('utf8') === 'Hello file data', 'Payload content correct');
}

// -----------------------------------------------------------------------
// Test 3: Command frame parsing
// -----------------------------------------------------------------------

console.log('\n\x1b[1mTest 3: Command frame parsing\x1b[0m');
{
	var transport = new MockTransport();
	var proto = new BinkpProtocol(transport, { localAddresses: ['1:1/1'] });

	var receivedAddresses = null;
	proto.on('authenticated', (info) => { /* won't fire here */ });

	// Inject M_NUL
	var nullHandled = false;
	var origNUL = proto._handleNUL.bind(proto);
	proto._handleNUL = function(data) {
		nullHandled = true;
		origNUL(data);
	};

	transport.inject(buildCmdFrame(M_NUL, 'SYS Remote BBS'));
	assert(nullHandled, 'M_NUL frame parsed and dispatched');
	assert(proto._peerOptions.systemName === 'Remote BBS', 'M_NUL SYS parsed correctly');

	// Inject M_NUL OPT
	transport.inject(buildCmdFrame(M_NUL, 'OPT NR MB'));
	assert(proto._peerOptions.nonReliable === true, 'OPT NR parsed');
	assert(proto._peerOptions.multiBatch === true, 'OPT MB parsed');
}

// -----------------------------------------------------------------------
// Test 4: Partial frame handling
// -----------------------------------------------------------------------

console.log('\n\x1b[1mTest 4: Partial frame handling\x1b[0m');
{
	var transport = new MockTransport();
	var proto = new BinkpProtocol(transport, { localAddresses: ['1:1/1'] });

	var gotSys = false;
	var origNUL = proto._handleNUL.bind(proto);
	proto._handleNUL = function(data) {
		if (data.startsWith('SYS ')) gotSys = true;
		origNUL(data);
	};

	var frame = buildCmdFrame(M_NUL, 'SYS Split BBS');

	// Send first half
	transport.inject(frame.subarray(0, 5));
	assert(!gotSys, 'Partial frame — not yet dispatched');

	// Send remainder
	transport.inject(frame.subarray(5));
	assert(gotSys, 'Complete frame — dispatched after second chunk');
	assert(proto._peerOptions.systemName === 'Split BBS', 'Content correct after reassembly');
}

// -----------------------------------------------------------------------
// Test 5: Multiple frames in one chunk
// -----------------------------------------------------------------------

console.log('\n\x1b[1mTest 5: Multiple frames in one chunk\x1b[0m');
{
	var transport = new MockTransport();
	var proto = new BinkpProtocol(transport, { localAddresses: ['1:1/1'] });

	var frame1 = buildCmdFrame(M_NUL, 'SYS Multi BBS');
	var frame2 = buildCmdFrame(M_NUL, 'ZYZ Sysop Name');
	var combined = Buffer.concat([frame1, frame2]);

	transport.inject(combined);
	assert(proto._peerOptions.systemName === 'Multi BBS', 'First frame parsed');
	assert(proto._peerOptions.sysopName === 'Sysop Name', 'Second frame parsed');
}

// -----------------------------------------------------------------------
// Test 6: M_ADR parsing
// -----------------------------------------------------------------------

console.log('\n\x1b[1mTest 6: M_ADR parsing\x1b[0m');
{
	var transport = new MockTransport();
	var proto = new BinkpProtocol(transport, { localAddresses: ['1:1/1'] });
	proto._role = 'answerer'; // Don't try to send password on ADR

	transport.inject(buildCmdFrame(M_ADR, '1:123/456 2:200/100'));
	assert(proto._peerAddresses.length === 2, 'Two addresses parsed');
	assert(proto._peerAddresses[0] === '1:123/456', 'First address correct');
	assert(proto._peerAddresses[1] === '2:200/100', 'Second address correct');
}

// -----------------------------------------------------------------------
// Test 7: M_FILE parsing
// -----------------------------------------------------------------------

console.log('\n\x1b[1mTest 7: M_FILE parsing\x1b[0m');
{
	var transport = new MockTransport();
	var proto = new BinkpProtocol(transport, { localAddresses: ['1:1/1'] });

	var offeredFile = null;
	proto.on('fileOffered', (info) => { offeredFile = info; });

	transport.inject(buildCmdFrame(M_FILE, 'test.pkt 1024 1700000000 0'));
	assert(offeredFile !== null, 'fileOffered event emitted');
	assert(offeredFile.name === 'test.pkt', 'Filename correct');
	assert(offeredFile.size === 1024, 'Size correct');
	assert(offeredFile.offset === 0, 'Offset correct');
}

// -----------------------------------------------------------------------
// Test 8: Data frame → fileData + fileComplete
// -----------------------------------------------------------------------

console.log('\n\x1b[1mTest 8: File data reception\x1b[0m');
{
	var transport = new MockTransport();
	var proto = new BinkpProtocol(transport, { localAddresses: ['1:1/1'] });

	var dataChunks = [];
	var completed = null;
	proto.on('fileData', (buf) => { dataChunks.push(buf); });
	proto.on('fileComplete', (info) => { completed = info; });

	// Offer a 10-byte file
	transport.inject(buildCmdFrame(M_FILE, 'tiny.pkt 10 1700000000 0'));

	// Send 10 bytes of data
	transport.inject(buildDataFrame(Buffer.alloc(10, 0x42)));

	assert(dataChunks.length === 1, 'One data chunk received');
	assert(dataChunks[0].length === 10, 'Data chunk is 10 bytes');
	assert(completed !== null, 'fileComplete emitted');
	assert(completed.name === 'tiny.pkt', 'Completed file name correct');
	assert(completed.size === 10, 'Completed file size correct');
}

// -----------------------------------------------------------------------
// Test 9: EOB handling
// -----------------------------------------------------------------------

console.log('\n\x1b[1mTest 9: EOB handling\x1b[0m');
{
	var transport = new MockTransport();
	var proto = new BinkpProtocol(transport, { localAddresses: ['1:1/1'] });

	var remoteEOB = false;
	var sessionEnded = false;
	proto.on('remoteEOB', () => { remoteEOB = true; });
	proto.on('sessionEnd', () => { sessionEnded = true; });

	// Remote sends EOB
	transport.inject(buildCmdFrame(M_EOB, ''));
	assert(remoteEOB, 'remoteEOB event emitted');
	assert(!sessionEnded, 'Session not ended yet (we haven\'t sent EOB)');

	// We send EOB
	proto.sendEOB();
	assert(sessionEnded, 'sessionEnd emitted after both sides EOB');
	assert(proto.state === 'done', 'Protocol state is done');
}

// -----------------------------------------------------------------------
// Test 10: CRAM-MD5 verification
// -----------------------------------------------------------------------

console.log('\n\x1b[1mTest 10: CRAM-MD5 verification\x1b[0m');
{
	var password = 'secretpass';
	var challenge = 'abcdef1234567890abcdef1234567890';

	// Compute expected digest — decode hex challenge to bytes, same as binkp does
	var crypto = await import('crypto');
	var challengeBytes = Buffer.from(challenge, 'hex');
	var hmac = crypto.createHmac('md5', password);
	hmac.update(challengeBytes);
	var expectedDigest = hmac.digest('hex');

	var response = 'CRAM-MD5-' + expectedDigest;
	var wrongChallenge = '00112233445566778899aabbccddeeff';

	assert(verifyCramMD5(password, challenge, response), 'Valid CRAM-MD5 accepted');
	assert(!verifyCramMD5('wrongpass', challenge, response), 'Wrong password rejected');
	assert(!verifyCramMD5(password, wrongChallenge, response), 'Wrong challenge rejected');
	assert(!verifyCramMD5(password, challenge, 'plaintext'), 'Non-CRAM response rejected');
}

// -----------------------------------------------------------------------
// Test 11: M_ERR handling
// -----------------------------------------------------------------------

console.log('\n\x1b[1mTest 11: Error frame handling\x1b[0m');
{
	var transport = new MockTransport();
	var proto = new BinkpProtocol(transport, { localAddresses: ['1:1/1'] });

	var errorMsg = null;
	proto.on('error', (err) => { errorMsg = err.message; });

	transport.inject(buildCmdFrame(M_ERR, 'Bad password'));
	assert(errorMsg !== null, 'Error event emitted');
	assert(errorMsg.includes('Bad password'), 'Error message contains remote reason');
	assert(proto.state === 'error', 'Protocol state is error');
}

// -----------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------

console.log('\n\x1b[1m' + '─'.repeat(40) + '\x1b[0m');
console.log('\x1b[1mResults: ' + passed + ' passed, ' + failed + ' failed\x1b[0m');
if (failed > 0) {
	console.log('\x1b[31mSome tests failed!\x1b[0m\n');
	process.exit(1);
} else {
	console.log('\x1b[32mAll tests passed.\x1b[0m\n');
}
