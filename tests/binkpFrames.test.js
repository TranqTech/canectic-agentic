// tests/binkpFrames.test.js — Mocha conversion of tests/mailer/test-binkp-frames.js
//
// Tests binkp frame encoding, decoding, reassembly, and protocol events.
// No network, no database.
// Run: npx mocha tests/binkpFrames.test.js

import assert from 'assert';
import { EventEmitter } from 'node:events';
import {
	BinkpProtocol,
	verifyCramMD5,
	M_NUL, M_ADR, M_PWD, M_FILE, M_OK, M_EOB, M_GOT, M_ERR
} from '../src/mailer/protocols/binkp.js';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Mock transport
// ---------------------------------------------------------------------------

class MockTransport extends EventEmitter {
	constructor() {
		super();
		this._connected = true;
		this.written = [];
	}
	write(buffer) { this.written.push(Buffer.from(buffer)); }
	close() { this._connected = false; }
	destroy() { this._connected = false; }
	get remoteAddress() { return 'mock:0'; }
	get isConnected() { return this._connected; }
	inject(buffer) { this.emit('data', Buffer.from(buffer)); }
	getWritten() { return Buffer.concat(this.written); }
	clearWritten() { this.written = []; }
}

// ---------------------------------------------------------------------------
// Frame building helpers (same logic as the original test file)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BinkP frames — command frame encoding', function () {

	it('should produce the correct total frame length', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, {
			quiet: true, localAddresses: ['1:123/456'], sessionPassword: 'testpass'
		});
		proto._sendCmd(M_NUL, 'SYS Test BBS');
		var written = transport.getWritten();
		// Header (2) + cmd byte (1) + 12 bytes of "SYS Test BBS" = 15
		assert.strictEqual(written.length, 2 + 1 + 12);
	});

	it('should set the command flag in the 2-byte header', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, {
			quiet: true, localAddresses: ['1:123/456'], sessionPassword: 'testpass'
		});
		proto._sendCmd(M_NUL, 'SYS Test BBS');
		var written = transport.getWritten();
		assert.notStrictEqual(written.readUInt16BE(0) & 0x8000, 0);
	});

	it('should encode payload length as 13 in the header (1 cmd byte + 12 payload bytes)', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, {
			quiet: true, localAddresses: ['1:123/456'], sessionPassword: 'testpass'
		});
		proto._sendCmd(M_NUL, 'SYS Test BBS');
		var written = transport.getWritten();
		assert.strictEqual(written.readUInt16BE(0) & 0x7FFF, 13);
	});

	it('should write M_NUL as the command byte', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, {
			quiet: true, localAddresses: ['1:123/456'], sessionPassword: 'testpass'
		});
		proto._sendCmd(M_NUL, 'SYS Test BBS');
		var written = transport.getWritten();
		assert.strictEqual(written[2], M_NUL);
	});

	it('should encode the payload string correctly after the command byte', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, {
			quiet: true, localAddresses: ['1:123/456'], sessionPassword: 'testpass'
		});
		proto._sendCmd(M_NUL, 'SYS Test BBS');
		var written = transport.getWritten();
		assert.strictEqual(written.subarray(3).toString('utf8'), 'SYS Test BBS');
	});
});

describe('BinkP frames — data frame encoding', function () {

	it('should produce the correct total frame length', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, { quiet: true, localAddresses: ['1:1/1'] });
		proto._sendDataFrame(Buffer.from('Hello file data'));
		var written = transport.getWritten();
		// Header (2) + 15 bytes of data = 17
		assert.strictEqual(written.length, 2 + 15);
	});

	it('should clear the command flag (data frames have no command bit)', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, { quiet: true, localAddresses: ['1:1/1'] });
		proto._sendDataFrame(Buffer.from('Hello file data'));
		var written = transport.getWritten();
		assert.strictEqual(written.readUInt16BE(0) & 0x8000, 0);
	});

	it('should encode payload length as 15', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, { quiet: true, localAddresses: ['1:1/1'] });
		proto._sendDataFrame(Buffer.from('Hello file data'));
		var written = transport.getWritten();
		assert.strictEqual(written.readUInt16BE(0) & 0x7FFF, 15);
	});

	it('should preserve payload bytes after the 2-byte header', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, { quiet: true, localAddresses: ['1:1/1'] });
		proto._sendDataFrame(Buffer.from('Hello file data'));
		var written = transport.getWritten();
		assert.strictEqual(written.subarray(2).toString('utf8'), 'Hello file data');
	});
});

describe('BinkP frames — command frame parsing', function () {

	it('should dispatch an injected M_NUL frame to _handleNUL', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, { quiet: true, localAddresses: ['1:1/1'] });
		var nullHandled = false;
		var origNUL = proto._handleNUL.bind(proto);
		proto._handleNUL = function(data) { nullHandled = true; origNUL(data); };
		transport.inject(buildCmdFrame(M_NUL, 'SYS Remote BBS'));
		assert.strictEqual(nullHandled, true);
	});

	it('should parse M_NUL SYS field into _peerOptions.systemName', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, { quiet: true, localAddresses: ['1:1/1'] });
		transport.inject(buildCmdFrame(M_NUL, 'SYS Remote BBS'));
		assert.strictEqual(proto._peerOptions.systemName, 'Remote BBS');
	});

	it('should parse M_NUL OPT NR into _peerOptions.nonReliable = true', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, { quiet: true, localAddresses: ['1:1/1'] });
		transport.inject(buildCmdFrame(M_NUL, 'OPT NR MB'));
		assert.strictEqual(proto._peerOptions.nonReliable, true);
	});

	it('should parse M_NUL OPT MB into _peerOptions.multiBatch = true', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, { quiet: true, localAddresses: ['1:1/1'] });
		transport.inject(buildCmdFrame(M_NUL, 'OPT NR MB'));
		assert.strictEqual(proto._peerOptions.multiBatch, true);
	});
});

describe('BinkP frames — partial frame handling', function () {

	it('should not dispatch when only the first half of a frame is received', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, { quiet: true, localAddresses: ['1:1/1'] });
		var gotSys = false;
		var origNUL = proto._handleNUL.bind(proto);
		proto._handleNUL = function(data) { if (data.startsWith('SYS ')) gotSys = true; origNUL(data); };
		var frame = buildCmdFrame(M_NUL, 'SYS Split BBS');
		transport.inject(frame.subarray(0, 5));
		assert.strictEqual(gotSys, false);
	});

	it('should dispatch after the second chunk completes the frame', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, { quiet: true, localAddresses: ['1:1/1'] });
		var gotSys = false;
		var origNUL = proto._handleNUL.bind(proto);
		proto._handleNUL = function(data) { if (data.startsWith('SYS ')) gotSys = true; origNUL(data); };
		var frame = buildCmdFrame(M_NUL, 'SYS Split BBS');
		transport.inject(frame.subarray(0, 5));
		transport.inject(frame.subarray(5));
		assert.strictEqual(gotSys, true);
	});

	it('should have correct content after multi-chunk reassembly', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, { quiet: true, localAddresses: ['1:1/1'] });
		var origNUL = proto._handleNUL.bind(proto);
		proto._handleNUL = function(data) { origNUL(data); };
		var frame = buildCmdFrame(M_NUL, 'SYS Split BBS');
		transport.inject(frame.subarray(0, 5));
		transport.inject(frame.subarray(5));
		assert.strictEqual(proto._peerOptions.systemName, 'Split BBS');
	});
});

describe('BinkP frames — multiple frames in one chunk', function () {

	it('should parse the system name from the first frame in a combined chunk', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, { quiet: true, localAddresses: ['1:1/1'] });
		var frame1 = buildCmdFrame(M_NUL, 'SYS Multi BBS');
		var frame2 = buildCmdFrame(M_NUL, 'ZYZ Sysop Name');
		transport.inject(Buffer.concat([frame1, frame2]));
		assert.strictEqual(proto._peerOptions.systemName, 'Multi BBS');
	});

	it('should parse the sysop name from the second frame in the same combined chunk', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, { quiet: true, localAddresses: ['1:1/1'] });
		var frame1 = buildCmdFrame(M_NUL, 'SYS Multi BBS');
		var frame2 = buildCmdFrame(M_NUL, 'ZYZ Sysop Name');
		transport.inject(Buffer.concat([frame1, frame2]));
		assert.strictEqual(proto._peerOptions.sysopName, 'Sysop Name');
	});
});

describe('BinkP frames — M_ADR parsing', function () {

	it('should parse two addresses from a single M_ADR frame', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, { quiet: true, localAddresses: ['1:1/1'] });
		proto._role = 'answerer';
		transport.inject(buildCmdFrame(M_ADR, '1:123/456 2:200/100'));
		assert.strictEqual(proto._peerAddresses.length, 2);
	});

	it('should parse the first address correctly', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, { quiet: true, localAddresses: ['1:1/1'] });
		proto._role = 'answerer';
		transport.inject(buildCmdFrame(M_ADR, '1:123/456 2:200/100'));
		assert.strictEqual(proto._peerAddresses[0], '1:123/456');
	});

	it('should parse the second address correctly', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, { quiet: true, localAddresses: ['1:1/1'] });
		proto._role = 'answerer';
		transport.inject(buildCmdFrame(M_ADR, '1:123/456 2:200/100'));
		assert.strictEqual(proto._peerAddresses[1], '2:200/100');
	});
});

describe('BinkP frames — M_FILE parsing', function () {

	it('should emit a fileOffered event with the correct filename', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, { quiet: true, localAddresses: ['1:1/1'] });
		var offeredFile = null;
		proto.on('fileOffered', function(info) { offeredFile = info; });
		transport.inject(buildCmdFrame(M_FILE, 'test.pkt 1024 1700000000 0'));
		assert.ok(offeredFile !== null);
		assert.strictEqual(offeredFile.name, 'test.pkt');
	});

	it('should parse file size correctly', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, { quiet: true, localAddresses: ['1:1/1'] });
		var offeredFile = null;
		proto.on('fileOffered', function(info) { offeredFile = info; });
		transport.inject(buildCmdFrame(M_FILE, 'test.pkt 1024 1700000000 0'));
		assert.strictEqual(offeredFile.size, 1024);
	});

	it('should parse the offset field as 0', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, { quiet: true, localAddresses: ['1:1/1'] });
		var offeredFile = null;
		proto.on('fileOffered', function(info) { offeredFile = info; });
		transport.inject(buildCmdFrame(M_FILE, 'test.pkt 1024 1700000000 0'));
		assert.strictEqual(offeredFile.offset, 0);
	});
});

describe('BinkP frames — file data reception', function () {

	it('should emit a fileData event with the correct chunk length', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, { quiet: true, localAddresses: ['1:1/1'] });
		var dataChunks = [];
		proto.on('fileData', function(buf) { dataChunks.push(buf); });
		proto.on('fileComplete', function() {});
		transport.inject(buildCmdFrame(M_FILE, 'tiny.pkt 10 1700000000 0'));
		transport.inject(buildDataFrame(Buffer.alloc(10, 0x42)));
		assert.strictEqual(dataChunks.length, 1);
		assert.strictEqual(dataChunks[0].length, 10);
	});

	it('should emit fileComplete with the correct filename after all data received', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, { quiet: true, localAddresses: ['1:1/1'] });
		var completed = null;
		proto.on('fileData', function() {});
		proto.on('fileComplete', function(info) { completed = info; });
		transport.inject(buildCmdFrame(M_FILE, 'tiny.pkt 10 1700000000 0'));
		transport.inject(buildDataFrame(Buffer.alloc(10, 0x42)));
		assert.ok(completed !== null);
		assert.strictEqual(completed.name, 'tiny.pkt');
	});

	it('should emit fileComplete with the correct size', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, { quiet: true, localAddresses: ['1:1/1'] });
		var completed = null;
		proto.on('fileData', function() {});
		proto.on('fileComplete', function(info) { completed = info; });
		transport.inject(buildCmdFrame(M_FILE, 'tiny.pkt 10 1700000000 0'));
		transport.inject(buildDataFrame(Buffer.alloc(10, 0x42)));
		assert.strictEqual(completed.size, 10);
	});
});

describe('BinkP frames — EOB handling', function () {

	it('should emit a remoteEOB event when M_EOB is received', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, { quiet: true, localAddresses: ['1:1/1'] });
		var remoteEOB = false;
		proto.on('remoteEOB', function() { remoteEOB = true; });
		proto.on('sessionEnd', function() {});
		transport.inject(buildCmdFrame(M_EOB, ''));
		assert.strictEqual(remoteEOB, true);
	});

	it('should not end the session after only the remote sends EOB', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, { quiet: true, localAddresses: ['1:1/1'] });
		var sessionEnded = false;
		proto.on('remoteEOB', function() {});
		proto.on('sessionEnd', function() { sessionEnded = true; });
		transport.inject(buildCmdFrame(M_EOB, ''));
		assert.strictEqual(sessionEnded, false);
	});

	it('should emit sessionEnd after both sides have sent EOB', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, { quiet: true, localAddresses: ['1:1/1'] });
		var sessionEnded = false;
		proto.on('remoteEOB', function() {});
		proto.on('sessionEnd', function() { sessionEnded = true; });
		transport.inject(buildCmdFrame(M_EOB, ''));
		proto.sendEOB();
		assert.strictEqual(sessionEnded, true);
	});

	it('should transition protocol state to "done" after mutual EOB', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, { quiet: true, localAddresses: ['1:1/1'] });
		proto.on('remoteEOB', function() {});
		proto.on('sessionEnd', function() {});
		transport.inject(buildCmdFrame(M_EOB, ''));
		proto.sendEOB();
		assert.strictEqual(proto.state, 'done');
	});
});

describe('BinkP frames — CRAM-MD5 verification', function () {

	var password = 'secretpass';
	var challenge = 'abcdef1234567890abcdef1234567890';
	var expectedResponse;

	before(function () {
		var challengeBytes = Buffer.from(challenge, 'hex');
		var hmac = crypto.createHmac('md5', password);
		hmac.update(challengeBytes);
		expectedResponse = 'CRAM-MD5-' + hmac.digest('hex');
	});

	it('should accept a valid CRAM-MD5 response', function () {
		assert.strictEqual(verifyCramMD5(password, challenge, expectedResponse), true);
	});

	it('should reject a wrong password', function () {
		assert.strictEqual(verifyCramMD5('wrongpass', challenge, expectedResponse), false);
	});

	it('should reject a wrong challenge', function () {
		var wrongChallenge = '00112233445566778899aabbccddeeff';
		assert.strictEqual(verifyCramMD5(password, wrongChallenge, expectedResponse), false);
	});

	it('should reject a non-CRAM plaintext response', function () {
		assert.strictEqual(verifyCramMD5(password, challenge, 'plaintext'), false);
	});
});

describe('BinkP frames — M_ERR handling', function () {

	it('should emit an error event when M_ERR is received', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, { quiet: true, localAddresses: ['1:1/1'] });
		var errorMsg = null;
		proto.on('error', function(err) { errorMsg = err.message; });
		transport.inject(buildCmdFrame(M_ERR, 'Bad password'));
		assert.ok(errorMsg !== null);
	});

	it('should include the remote reason in the error message', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, { quiet: true, localAddresses: ['1:1/1'] });
		var errorMsg = null;
		proto.on('error', function(err) { errorMsg = err.message; });
		transport.inject(buildCmdFrame(M_ERR, 'Bad password'));
		assert.ok(errorMsg.includes('Bad password'));
	});

	it('should transition protocol state to "error"', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, { quiet: true, localAddresses: ['1:1/1'] });
		proto.on('error', function() {});
		transport.inject(buildCmdFrame(M_ERR, 'Bad password'));
		assert.strictEqual(proto.state, 'error');
	});
});

describe('BinkP frames — NR mode (offset -1)', function () {

	it('should emit fileOffered for an NR initial offer (offset -1)', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, { quiet: true, localAddresses: ['1:1/1'] });
		var offeredFile = null;
		proto.on('fileOffered', function(info) { offeredFile = info; });
		transport.inject(buildCmdFrame(M_FILE, 'test.pkt 1024 1700000000 -1'));
		assert.ok(offeredFile !== null);
		assert.strictEqual(offeredFile.offset, -1);
	});

	it('should not emit fileOffered again when NR re-offers with offset 0', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, { quiet: true, localAddresses: ['1:1/1'] });
		proto.on('fileOffered', function() {});
		transport.inject(buildCmdFrame(M_FILE, 'test.pkt 1024 1700000000 -1'));
		var offerCount = 0;
		proto.on('fileOffered', function() { offerCount++; });
		transport.inject(buildCmdFrame(M_FILE, 'test.pkt 1024 1700000000 0'));
		assert.strictEqual(offerCount, 0);
	});

	it('should update _rxFile.offset to 0 after the NR re-offer', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, { quiet: true, localAddresses: ['1:1/1'] });
		proto.on('fileOffered', function() {});
		transport.inject(buildCmdFrame(M_FILE, 'test.pkt 1024 1700000000 -1'));
		transport.inject(buildCmdFrame(M_FILE, 'test.pkt 1024 1700000000 0'));
		assert.strictEqual(proto._rxFile.offset, 0);
	});
});

describe('BinkP frames — implicit file completion on new M_FILE', function () {

	it('should have emitted fileOffered for the first file', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, { quiet: true, localAddresses: ['1:1/1'] });
		var offeredFiles = [];
		proto.on('fileComplete', function() {});
		proto.on('fileOffered', function(info) { offeredFiles.push(info.name); });
		transport.inject(buildCmdFrame(M_FILE, 'first.pkt 100 1700000000 0'));
		assert.strictEqual(offeredFiles.length, 1);
	});

	it('should have emitted fileOffered for both files after second M_FILE', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, { quiet: true, localAddresses: ['1:1/1'] });
		var offeredFiles = [];
		proto.on('fileComplete', function() {});
		proto.on('fileOffered', function(info) { offeredFiles.push(info.name); });
		transport.inject(buildCmdFrame(M_FILE, 'first.pkt 100 1700000000 0'));
		transport.inject(buildCmdFrame(M_FILE, 'second.pkt 200 1700000000 0'));
		assert.strictEqual(offeredFiles.length, 2);
	});

	it('should implicitly complete the first file when the second M_FILE arrives', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, { quiet: true, localAddresses: ['1:1/1'] });
		var completedFiles = [];
		proto.on('fileComplete', function(info) { completedFiles.push(info.name); });
		proto.on('fileOffered', function() {});
		transport.inject(buildCmdFrame(M_FILE, 'first.pkt 100 1700000000 0'));
		transport.inject(buildCmdFrame(M_FILE, 'second.pkt 200 1700000000 0'));
		assert.strictEqual(completedFiles.length, 1);
		assert.strictEqual(completedFiles[0], 'first.pkt');
	});
});

describe('BinkP frames — double EOB protection', function () {

	it('should produce bytes on the first sendEOB call', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, { quiet: true, localAddresses: ['1:1/1'] });
		proto.on('error', function() {});
		proto.sendEOB();
		assert.ok(transport.getWritten().length > 0);
	});

	it('should not produce additional bytes on a second sendEOB call', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, { quiet: true, localAddresses: ['1:1/1'] });
		proto.on('error', function() {});
		proto.sendEOB();
		var bytesAfterFirst = transport.getWritten().length;
		proto.sendEOB();
		assert.strictEqual(transport.getWritten().length, bytesAfterFirst);
	});

	it('should set _localEOB flag after sendEOB', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, { quiet: true, localAddresses: ['1:1/1'] });
		proto.on('error', function() {});
		proto.sendEOB();
		assert.strictEqual(proto._localEOB, true);
	});
});

describe('BinkP frames — sendSKIP clears receive state', function () {

	it('should set _rxFile after receiving M_FILE', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, { quiet: true, localAddresses: ['1:1/1'] });
		transport.inject(buildCmdFrame(M_FILE, 'bad.pkt 100 1700000000 0'));
		assert.ok(proto._rxFile !== null);
		assert.strictEqual(proto._rxFile.name, 'bad.pkt');
	});

	it('should clear _rxFile after sendSKIP', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, { quiet: true, localAddresses: ['1:1/1'] });
		transport.inject(buildCmdFrame(M_FILE, 'bad.pkt 100 1700000000 0'));
		proto.sendSKIP('bad.pkt', 100, 1700000000000);
		assert.strictEqual(proto._rxFile, null);
	});

	it('should not trigger implicit fileComplete for the skipped file', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, { quiet: true, localAddresses: ['1:1/1'] });
		var completed = [];
		proto.on('fileComplete', function(info) { completed.push(info.name); });
		transport.inject(buildCmdFrame(M_FILE, 'bad.pkt 100 1700000000 0'));
		proto.sendSKIP('bad.pkt', 100, 1700000000000);
		transport.inject(buildCmdFrame(M_FILE, 'good.pkt 50 1700000000 0'));
		assert.strictEqual(completed.length, 0);
	});

	it('should leave _pendingGOTs at 0 after skipping a file', function () {
		var transport = new MockTransport();
		var proto = new BinkpProtocol(transport, { quiet: true, localAddresses: ['1:1/1'] });
		proto.on('fileComplete', function() {});
		transport.inject(buildCmdFrame(M_FILE, 'bad.pkt 100 1700000000 0'));
		proto.sendSKIP('bad.pkt', 100, 1700000000000);
		transport.inject(buildCmdFrame(M_FILE, 'good.pkt 50 1700000000 0'));
		assert.strictEqual(proto._pendingGOTs, 0);
	});
});
