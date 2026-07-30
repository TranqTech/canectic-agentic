// tests/binkpMultiBatch.test.js — binkp/1.1 multi-batch session termination.
//
// A binkp/1.1 session is a sequence of batches. Each batch ends with an M_EOB
// from both sides; the session ends on a batch that carried nothing but those
// two frames. binkd's protocol.c makes this explicit:
//
//   if (state.msgs_in_batch <= 2 || (state.major*100 + state.minor <= 100))
//     break;                                  // session over, logged "OK"
//   else {
//     state.msgs_in_batch = 0;
//     state.remote_EOB = state.local_EOB = 0;
//     continue;                               // another batch, another M_EOB
//   }
//
// Closing after the first exchange on a batch that moved a file leaves binkd
// with remote_EOB == 0, so it logs the session "failed" and re-queues
// everything it just sent. These tests pin the batch accounting and the
// version gate that keeps binkp/1.0 peers on the old single-batch flow.
//
// No network, no database.
// Run: npx mocha tests/binkpMultiBatch.test.js

import assert from 'assert';
import { EventEmitter } from 'node:events';
import {
	BinkpProtocol,
	M_NUL, M_ADR, M_FILE, M_OK, M_EOB
} from '../src/mailer/protocols/binkp.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class MockTransport extends EventEmitter {
	constructor() {
		super();
		this._connected = true;
		this.written = [];
	}
	write(buffer) { this.written.push(Buffer.from(buffer)); }
	close() { this._connected = false; this.emit('close'); }
	destroy() { this.close(); }
	get remoteAddress() { return 'mock:0'; }
	get isConnected() { return this._connected; }
	inject(buffer) { this.emit('data', Buffer.from(buffer)); }
	getWritten() { return Buffer.concat(this.written); }
	clearWritten() { this.written = []; }
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

// Count command frames of a given type in a raw written-byte stream.
function countCmdFrames(buf, cmdId) {
	var offset = 0;
	var count  = 0;
	while (offset + 2 <= buf.length) {
		var header = buf.readUInt16BE(offset);
		var isCmd  = (header & 0x8000) !== 0;
		var len    = header & 0x7FFF;
		if (offset + 2 + len > buf.length) break;
		if (isCmd && len >= 1 && buf[offset + 2] === cmdId) count++;
		offset += 2 + len;
	}
	return count;
}

// Drive a caller-role protocol through the handshake into the batch phase.
// `ver` is the peer's raw M_NUL VER payload, or null to send none at all.
function makeCaller(ver) {
	var transport = new MockTransport();
	var proto = new BinkpProtocol(transport, {
		quiet: true,
		localAddresses: ['1:1/1'],
		sessionPassword: 'secret'
	});
	// Swallow events the tests don't assert on so EventEmitter doesn't throw
	// on an unhandled 'error'.
	proto.on('remoteEOB', function() {});
	proto.on('error', function() {});

	proto.startSession('caller');
	if (ver !== null) transport.inject(buildCmdFrame(M_NUL, 'VER ' + ver));
	transport.inject(buildCmdFrame(M_ADR, '2:2/2@fidonet'));
	transport.inject(buildCmdFrame(M_OK, ''));
	transport.clearWritten();
	return { transport: transport, proto: proto };
}

// A one-file inbound transfer: M_FILE, its data, then our M_GOT.
function receiveOneFile(t, name, body) {
	var buf = Buffer.from(body);
	t.transport.inject(buildCmdFrame(M_FILE, name + ' ' + buf.length + ' 1700000000 0'));
	t.transport.inject(buildDataFrame(buf));
	t.proto.sendGOT(name, buf.length, 1700000000000);
}

const V11 = 'binkd/1.1a-115/Linux binkp/1.1';
const V10 = 'SomeMailer/2.0 binkp/1.0';

// ---------------------------------------------------------------------------
// Version parsing
// ---------------------------------------------------------------------------

describe('binkp multi-batch — peer version parsing', function () {

	it('should read binkp/1.1 out of a binkd VER line', function () {
		var t = makeCaller(V11);
		assert.strictEqual(t.proto.peerBinkpVersion, '1.1');
		assert.strictEqual(t.proto.peerMultiBatch, true);
	});

	it('should read binkp/1.1 out of a BinkIt VER line', function () {
		var t = makeCaller('BinkIT/2.41,JSBinkP/4,sbbs3.20a/Linux binkp/1.1');
		assert.strictEqual(t.proto.peerMultiBatch, true);
	});

	it('should treat binkp/1.0 as single-batch', function () {
		var t = makeCaller(V10);
		assert.strictEqual(t.proto.peerBinkpVersion, '1.0');
		assert.strictEqual(t.proto.peerMultiBatch, false);
	});

	it('should default to single-batch when the peer sends no VER', function () {
		var t = makeCaller(null);
		assert.strictEqual(t.proto.peerBinkpVersion, '1.0');
		assert.strictEqual(t.proto.peerMultiBatch, false);
	});

	it('should default to single-batch on an unparsable VER', function () {
		var t = makeCaller('WeirdMailer/9 no-version-here');
		assert.strictEqual(t.proto.peerMultiBatch, false);
	});
});

// ---------------------------------------------------------------------------
// Empty batch — one exchange is enough
// ---------------------------------------------------------------------------

describe('binkp multi-batch — quiet batch ends the session', function () {

	it('should end the session after one exchange when the batch was empty', function () {
		var t = makeCaller(V11);
		var ended = 0;
		t.proto.on('sessionEnd', function() { ended++; });

		t.proto.sendEOB();                              // msgsInBatch = 1
		t.transport.inject(buildCmdFrame(M_EOB, ''));   // msgsInBatch = 2

		assert.strictEqual(ended, 1);
		assert.strictEqual(t.proto.state, 'done');
		assert.strictEqual(t.proto.batchNumber, 1);
	});

	it('should send exactly one M_EOB for an empty session', function () {
		var t = makeCaller(V11);
		t.proto.on('sessionEnd', function() {});

		t.proto.sendEOB();
		t.transport.inject(buildCmdFrame(M_EOB, ''));

		assert.strictEqual(countCmdFrames(t.transport.getWritten(), M_EOB), 1);
	});

	it('should not count handshake frames toward the batch', function () {
		// makeCaller already pushed M_NUL/M_ADR/M_PWD/M_OK through the wire.
		// If those counted, msgsInBatch would exceed 2 and open a second batch.
		var t = makeCaller(V11);
		var ended = 0;
		t.proto.on('sessionEnd', function() { ended++; });

		t.proto.sendEOB();
		t.transport.inject(buildCmdFrame(M_EOB, ''));

		assert.strictEqual(ended, 1);
	});
});

// ---------------------------------------------------------------------------
// Active batch — a second batch is required
// ---------------------------------------------------------------------------

describe('binkp multi-batch — active batch opens a second batch', function () {

	it('should not end the session on the first exchange after a file', function () {
		var t = makeCaller(V11);
		var ended = 0;
		t.proto.on('sessionEnd', function() { ended++; });
		t.proto.on('fileComplete', function() {});

		receiveOneFile(t, 'test.pkt', 'hello world');
		t.proto.sendEOB();
		t.transport.inject(buildCmdFrame(M_EOB, ''));

		assert.strictEqual(ended, 0, 'session must not end while a batch was active');
		assert.notStrictEqual(t.proto.state, 'done');
	});

	it('should open batch 2 and emit batchEnd', function () {
		var t = makeCaller(V11);
		var batches = [];
		t.proto.on('sessionEnd', function() {});
		t.proto.on('fileComplete', function() {});
		t.proto.on('batchEnd', function(info) { batches.push(info); });

		receiveOneFile(t, 'test.pkt', 'hello world');
		t.proto.sendEOB();
		t.transport.inject(buildCmdFrame(M_EOB, ''));

		assert.strictEqual(batches.length, 1);
		assert.strictEqual(batches[0].batch, 1);
		assert.strictEqual(batches[0].next, 2);
		assert.strictEqual(t.proto.batchNumber, 2);
	});

	it('should send a second M_EOB for the new batch without being asked', function () {
		var t = makeCaller(V11);
		t.proto.on('sessionEnd', function() {});
		t.proto.on('fileComplete', function() {});

		receiveOneFile(t, 'test.pkt', 'hello world');
		t.proto.sendEOB();
		t.transport.inject(buildCmdFrame(M_EOB, ''));

		assert.strictEqual(countCmdFrames(t.transport.getWritten(), M_EOB), 2);
	});

	it('should end the session once the second batch is quiet', function () {
		var t = makeCaller(V11);
		var ended = 0;
		t.proto.on('sessionEnd', function() { ended++; });
		t.proto.on('fileComplete', function() {});

		receiveOneFile(t, 'test.pkt', 'hello world');
		t.proto.sendEOB();
		t.transport.inject(buildCmdFrame(M_EOB, ''));   // batch 1 closes, batch 2 opens
		t.transport.inject(buildCmdFrame(M_EOB, ''));   // batch 2: our EOB + theirs = 2

		assert.strictEqual(ended, 1);
		assert.strictEqual(t.proto.state, 'done');
		assert.strictEqual(t.proto.batchNumber, 2);
	});

	it('should count a mid-batch M_NUL toward the batch, as binkd does', function () {
		var t = makeCaller(V11);
		var ended = 0;
		t.proto.on('sessionEnd', function() { ended++; });

		t.transport.inject(buildCmdFrame(M_NUL, 'SYS Something'));  // 1
		t.proto.sendEOB();                                          // 2
		t.transport.inject(buildCmdFrame(M_EOB, ''));               // 3 -> continue

		assert.strictEqual(ended, 0);
		assert.strictEqual(t.proto.batchNumber, 2);
	});

	it('should not open a second batch for a file session with a 1.0 peer', function () {
		var t = makeCaller(V10);
		var ended = 0;
		t.proto.on('sessionEnd', function() { ended++; });
		t.proto.on('fileComplete', function() {});

		receiveOneFile(t, 'test.pkt', 'hello world');
		t.proto.sendEOB();
		t.transport.inject(buildCmdFrame(M_EOB, ''));

		assert.strictEqual(ended, 1, '1.0 peers keep the single-batch flow');
		assert.strictEqual(t.proto.state, 'done');
		assert.strictEqual(countCmdFrames(t.transport.getWritten(), M_EOB), 1);
	});

	it('should not open a second batch for a versionless peer', function () {
		var t = makeCaller(null);
		var ended = 0;
		t.proto.on('sessionEnd', function() { ended++; });
		t.proto.on('fileComplete', function() {});

		receiveOneFile(t, 'test.pkt', 'hello world');
		t.proto.sendEOB();
		t.transport.inject(buildCmdFrame(M_EOB, ''));

		assert.strictEqual(ended, 1);
		assert.strictEqual(countCmdFrames(t.transport.getWritten(), M_EOB), 1);
	});

	it('should hold the session open while a GOT is still pending', function () {
		var t = makeCaller(V11);
		var ended = 0;
		t.proto.on('sessionEnd', function() { ended++; });
		t.proto.on('fileComplete', function() {});

		// File data arrives (pendingGOTs -> 1) but we haven't acked it yet.
		var body = Buffer.from('hello world');
		t.transport.inject(buildCmdFrame(M_FILE, 'test.pkt ' + body.length + ' 1700000000 0'));
		t.transport.inject(buildDataFrame(body));
		t.proto.sendEOB();
		t.transport.inject(buildCmdFrame(M_EOB, ''));

		assert.strictEqual(t.proto.pendingGOTs, 1);
		assert.strictEqual(ended, 0);
		assert.strictEqual(t.proto.batchNumber, 1, 'batch must not roll while a GOT is owed');
	});
});

// ---------------------------------------------------------------------------
// Peer-close tolerance
// ---------------------------------------------------------------------------

describe('binkp multi-batch — peer close tolerance', function () {

	it('should treat a close after a completed exchange as a clean end', function () {
		var t = makeCaller(V11);
		var ended = 0;
		var errored = 0;
		t.proto.removeAllListeners('error');
		t.proto.on('error', function() { errored++; });
		t.proto.on('sessionEnd', function() { ended++; });
		t.proto.on('fileComplete', function() {});

		receiveOneFile(t, 'test.pkt', 'hello world');
		t.proto.sendEOB();
		t.transport.inject(buildCmdFrame(M_EOB, ''));   // batch 2 opens
		t.transport.close();                            // peer never opens batch 2

		assert.strictEqual(errored, 0, 'a finished peer closing is not an error');
		assert.strictEqual(ended, 1);
		assert.strictEqual(t.proto.state, 'done');
	});

	it('should still error when the peer closes before any EOB exchange', function () {
		var t = makeCaller(V11);
		var ended = 0;
		var errored = 0;
		t.proto.removeAllListeners('error');
		t.proto.on('error', function() { errored++; });
		t.proto.on('sessionEnd', function() { ended++; });

		t.transport.close();

		assert.strictEqual(errored, 1);
		assert.strictEqual(ended, 0);
	});

	it('should still error when the peer closes mid-file', function () {
		var t = makeCaller(V11);
		var errored = 0;
		t.proto.removeAllListeners('error');
		t.proto.on('error', function() { errored++; });
		t.proto.on('sessionEnd', function() {});

		t.proto.on('fileComplete', function() {});

		// Batch 1 carries a file, so batch 2 opens. The peer then starts a
		// second file in batch 2 and the link drops part-way through it.
		receiveOneFile(t, 'test.pkt', 'hello world');
		t.proto.sendEOB();
		t.transport.inject(buildCmdFrame(M_EOB, ''));
		assert.strictEqual(t.proto.batchNumber, 2, 'precondition: batch 2 open');

		t.transport.inject(buildCmdFrame(M_FILE, 'half.pkt 100 1700000000 0'));
		t.transport.inject(buildDataFrame(Buffer.alloc(10)));
		t.transport.close();

		assert.strictEqual(errored, 1, 'a truncated receive is still a failure');
	});
});
