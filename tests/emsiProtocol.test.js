// tests/emsiProtocol.test.js — EMSI protocol unit tests.
//
// Tests: packet encoding/decoding, CRC validation, field escaping,
// caller/answerer handshake loopback.
//
// EVERY PROTOCOL BUILT HERE MUST BE TORN DOWN. A caller that has sent its DAT
// has a retry chain armed: ACK_TIMEOUT is 10s and MAX_RETRIES is 6, so an
// abandoned instance spends a minute retrying and then emits 'error' on an
// object nobody is listening to, which throws and takes the process with it.
//
// That is what issue #45 was. It stayed invisible because `.mocharc.yml` sets
// `exit: true`, so mocha force-exited before the timer could fire: the suite
// reported 3,831 passing over a process that was about to die.
//
// That setting is gone (#46): tests/helpers/rootHooks.js closes the database
// connections after the run and fails it, naming the timer, if anything else
// is still holding the process open, so a leak like this one now fails the
// suite on its own.
//
// The protocol itself is not at fault. `sendERR` closes the transport, and on a
// real socket that kills the caller too. These mocks are wired by overriding
// `write`, so a close on one never reaches the other and the caller retries
// into nothing. Hence `track()`.

import assert from 'assert';
import { EventEmitter } from 'node:events';
import {
	EmsiProtocol,
	encodeEmsiDat,
	parseEmsiDat,
	emsiCrc16,
	escapeField,
	unescapeField
} from '../src/mailer/protocols/emsi.js';

function sleep(ms) {
	return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// --- Mock transport ---

class MockTransport extends EventEmitter {
	constructor() {
		super();
		this._connected = true;
		this.written = [];
	}
	write(buffer) { this.written.push(Buffer.from(buffer)); }
	close() { this._connected = false; }
	get isConnected() { return this._connected; }
	getWrittenString() { return Buffer.concat(this.written).toString('binary'); }
	clearWritten() { this.written = []; }
	inject(data) {
		this.emit('data', Buffer.isBuffer(data) ? data : Buffer.from(data, 'binary'));
	}
}

// Every protocol an individual test creates, cleaned up after it whatever the
// test did or how it ended.
var live = [];
function track(proto) {
	live.push(proto);
	return proto;
}
afterEach(function () {
	for (var proto of live) {
		try { proto._cleanup(); } catch (_) { /* already gone */ }
	}
	live = [];
});

// =========================================================================
// Encoding / decoding
// =========================================================================

describe('EMSI field escaping', function() {
	it('should escape braces and backslashes', function() {
		assert.strictEqual(escapeField('hello'), 'hello');
		assert.strictEqual(escapeField('{test}'), '\\{test\\}');
		assert.strictEqual(escapeField('back\\slash'), 'back\\\\slash');
	});

	it('should unescape braces and backslashes', function() {
		assert.strictEqual(unescapeField('hello'), 'hello');
		assert.strictEqual(unescapeField('\\{test\\}'), '{test}');
		assert.strictEqual(unescapeField('back\\\\slash'), 'back\\slash');
	});

	it('should round-trip field values', function() {
		var values = ['simple', '{braces}', 'back\\slash', '{a\\b}', ''];
		for (var v of values) {
			assert.strictEqual(unescapeField(escapeField(v)), v, 'round-trip failed for: ' + v);
		}
	});
});

describe('EMSI CRC-16', function() {
	it('should compute CRC for EMSI_INQ (without ** prefix)', function() {
		// EMSI fixed packet CRCs are computed over body WITHOUT the ** prefix
		var crc = emsiCrc16('EMSI_INQ');
		assert.strictEqual(crc, 0xC816, 'EMSI_INQ CRC should be C816');
	});

	it('should compute CRC for EMSI_REQ', function() {
		var crc = emsiCrc16('EMSI_REQ');
		assert.strictEqual(crc, 0xA77E, 'EMSI_REQ CRC should be A77E');
	});

	it('should compute CRC for EMSI_ACK', function() {
		var crc = emsiCrc16('EMSI_ACK');
		assert.strictEqual(crc, 0xA490, 'EMSI_ACK CRC should be A490');
	});

	it('should compute CRC for EMSI_NAK', function() {
		var crc = emsiCrc16('EMSI_NAK');
		assert.strictEqual(crc, 0xEEC3, 'EMSI_NAK CRC should be EEC3');
	});
});

describe('EMSI_DAT encoding', function() {
	it('should produce a valid packet with CRC', function() {
		var packet = encodeEmsiDat(['TestBBS', 'City', 'Sysop']);
		assert.ok(packet.startsWith('{EMSI_DAT}'), 'should start with {EMSI_DAT}');
		assert.ok(packet.endsWith('\r'), 'should end with CR');
	});

	it('should encode field values in braces', function() {
		var packet = encodeEmsiDat(['Alpha', 'Beta']);
		assert.ok(packet.includes('{Alpha}'), 'should contain {Alpha}');
		assert.ok(packet.includes('{Beta}'), 'should contain {Beta}');
	});

	it('should escape braces in field values', function() {
		var packet = encodeEmsiDat(['{test}']);
		assert.ok(packet.includes('\\{test\\}'), 'should contain escaped braces');
	});

	it('should include valid hex length', function() {
		var packet = encodeEmsiDat(['A', 'B']);
		var after = packet.substring('{EMSI_DAT}'.length);
		var lenHex = after.substring(0, 4);
		var len = parseInt(lenHex, 16);
		assert.ok(!isNaN(len) && len > 0, 'length should be valid hex');
	});
});

describe('EMSI_DAT parsing', function() {
	it('should round-trip encode/parse', function() {
		var original = ['TestBBS', 'Internet', 'Sysop', '-Unpublished-', '300'];
		var packet = encodeEmsiDat(original);
		var parsed = parseEmsiDat(packet.replace(/\r$/, ''));
		assert.ok(parsed, 'should parse successfully');
		assert.deepStrictEqual(parsed, original);
	});

	it('should handle empty fields', function() {
		var original = ['', 'value', ''];
		var packet = encodeEmsiDat(original);
		var parsed = parseEmsiDat(packet.replace(/\r$/, ''));
		assert.deepStrictEqual(parsed, original);
	});

	it('should handle escaped braces in fields', function() {
		var original = ['{test}', 'normal'];
		var packet = encodeEmsiDat(original);
		var parsed = parseEmsiDat(packet.replace(/\r$/, ''));
		assert.deepStrictEqual(parsed, original);
	});

	it('should reject packet with bad CRC', function() {
		var packet = encodeEmsiDat(['Test']);
		// Corrupt the CRC
		var corrupted = packet.substring(0, packet.length - 5) + 'FFFF\r';
		var parsed = parseEmsiDat(corrupted.replace(/\r$/, ''));
		assert.strictEqual(parsed, null, 'should reject bad CRC');
	});

	it('should reject truncated packet', function() {
		var parsed = parseEmsiDat('{EMSI_DAT}00');
		assert.strictEqual(parsed, null);
	});

	it('should handle many fields', function() {
		var fields = [];
		for (var i = 0; i < 11; i++) fields.push('field' + i);
		var packet = encodeEmsiDat(fields);
		var parsed = parseEmsiDat(packet.replace(/\r$/, ''));
		assert.deepStrictEqual(parsed, fields);
	});
});

// =========================================================================
// Handshake loopback
// =========================================================================

describe('EMSI handshake loopback', function() {
	this.timeout(15000);

	it('should complete caller/answerer handshake', async function() {
		var callerTransport = new MockTransport();
		var answererTransport = new MockTransport();

		var callerProto = track(new EmsiProtocol(callerTransport, {
			quiet: true,
			localAddresses: ['1:100/100@fidonet'],
			sessionPassword: 'testpw',
			systemName: 'CallerBBS'
		}));

		var answererProto = track(new EmsiProtocol(answererTransport, {
			quiet: true,
			localAddresses: ['1:200/200@fidonet'],
			sessionPassword: 'testpw',
			systemName: 'AnswererBBS'
		}));

		// Wire transports together
		callerTransport.on('data', function() {}); // Already wired in constructor
		answererTransport.on('data', function() {});

		// Forward writes from caller → answerer and vice versa
		var origCallerWrite = callerTransport.write.bind(callerTransport);
		var origAnswererWrite = answererTransport.write.bind(answererTransport);

		callerTransport.write = function(buf) {
			origCallerWrite(buf);
			setImmediate(function() { answererTransport.inject(buf); });
		};
		answererTransport.write = function(buf) {
			origAnswererWrite(buf);
			setImmediate(function() { callerTransport.inject(buf); });
		};

		// Track events
		var callerAuth = null;
		var answererAuth = null;
		var answererPwReceived = null;

		callerProto.on('authenticated', function(info) { callerAuth = info; });
		answererProto.on('authenticated', function(info) { answererAuth = info; });
		answererProto.on('passwordReceived', function(info) {
			answererPwReceived = info;
			// Validate password and confirm
			if (info.password === 'testpw') {
				answererProto.confirmAuth();
			}
		});

		// Start handshake
		answererProto.startSession('answerer');
		callerProto.startSession('caller');

		// Wait for completion
		var waited = 0;
		while ((!callerAuth || !answererAuth) && waited < 10000) {
			await sleep(50);
			waited += 50;
		}

		assert.ok(callerAuth, 'caller should be authenticated');
		assert.ok(answererAuth, 'answerer should be authenticated');
		assert.ok(answererPwReceived, 'answerer should have received password');
		assert.strictEqual(answererPwReceived.password, 'testpw');
		assert.ok(callerAuth.addresses.includes('1:200/200@fidonet'), 'caller should see answerer address');
		assert.ok(answererAuth.addresses.includes('1:100/100@fidonet'), 'answerer should see caller address');
		assert.strictEqual(callerAuth.options.systemName, 'AnswererBBS');
		assert.strictEqual(answererAuth.options.systemName, 'CallerBBS');
	});

	it('should handle password mismatch', async function() {
		var callerTransport = new MockTransport();
		var answererTransport = new MockTransport();

		var callerProto = track(new EmsiProtocol(callerTransport, {
			quiet: true,
			localAddresses: ['1:100/100'],
			sessionPassword: 'wrongpw',
			systemName: 'CallerBBS'
		}));

		var answererProto = track(new EmsiProtocol(answererTransport, {
			quiet: true,
			localAddresses: ['1:200/200'],
			sessionPassword: 'correctpw',
			systemName: 'AnswererBBS'
		}));

		callerTransport.write = function(buf) {
			setImmediate(function() { answererTransport.inject(buf); });
		};
		answererTransport.write = function(buf) {
			setImmediate(function() { callerTransport.inject(buf); });
		};

		var answererPwReceived = null;
		answererProto.on('passwordReceived', function(info) {
			answererPwReceived = info;
			// Password doesn't match — don't call confirmAuth, send error
			answererProto.sendERR('Bad password');
		});

		answererProto.startSession('answerer');
		callerProto.startSession('caller');

		await sleep(500);

		assert.ok(answererPwReceived, 'answerer should have received password');
		assert.strictEqual(answererPwReceived.password, 'wrongpw');
		assert.ok(!answererProto.isAuthenticated, 'answerer should not be authenticated');
	});
});

describe('EMSI pushInitialData', function() {
	it('should process peeked bytes from auto-detection', function(done) {
		var transport = new MockTransport();
		var proto = track(new EmsiProtocol(transport, {
			quiet: true,
			localAddresses: ['1:200/200'],
			systemName: 'TestBBS'
		}));

		proto.startSession('answerer');

		// Simulate auto-detection: push the EMSI_INQ bytes that were peeked
		proto.on('error', function() {}); // Prevent unhandled
		proto.pushInitialData(Buffer.from('**EMSI_INQC816\r', 'binary'));

		// The answerer should have sent EMSI_REQ in response
		var written = transport.getWrittenString();
		assert.ok(written.includes('**EMSI_REQ'), 'should have sent EMSI_REQ in response to pushed INQ');
		done();
	});
});

describe('EMSI detachTransport', function() {
	it('should remove data listener from transport', function() {
		var transport = new MockTransport();
		var proto = track(new EmsiProtocol(transport, { quiet: true, localAddresses: ['1:1/1'] }));

		var listenersBefore = transport.listenerCount('data');
		proto.detachTransport();
		var listenersAfter = transport.listenerCount('data');

		assert.ok(listenersAfter < listenersBefore, 'should have fewer data listeners after detach');
	});
});
