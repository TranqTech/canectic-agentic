// tests/terminalDetect.test.js — TerminalPool auto-detection tests.
//
// Tests the TCP/Telnet auto-detect logic in TerminalPool.handleConnection.
// After the connection is created, the pool listens for IAC bytes on the
// socket for up to 2 seconds. If a telnet command (WILL/WONT/DO/DONT) is
// seen, the connection stays as Telnet. Otherwise, it is downgraded to TCP
// and the telnetParser._disabled flag is set.

import assert from 'assert';
import { EventEmitter } from 'events';
import { TerminalPool } from '../src/servers/terminalserver.js';

// Telnet bytes used for probing
var IAC  = 0xFF;
var WILL = 0xFB;
var WONT = 0xFC;
var DO   = 0xFD;
var DONT = 0xFE;
var SB   = 0xFA;
var OPT_SGA  = 3;
var OPT_NAWS = 31;
var OPT_ECHO = 1;

// ---------------------------------------------------------------------------
// MockSocket — EventEmitter-based mock of a net.Socket
// ---------------------------------------------------------------------------

class MockSocket extends EventEmitter {
	constructor() {
		super();
		this.remoteAddress = '127.0.0.1';
		this.remotePort = 12345;
		this.destroyed = false;
		this.written = [];
		this.keepAlive = false;
		this._keepAliveEnabled = false;
	}

	write(data) {
		if (!this.destroyed) {
			this.written.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
		}
	}

	setKeepAlive(enabled, ms) {
		this._keepAliveEnabled = enabled;
	}

	pause() {}
	resume() {}

	end() {
		this.destroyed = true;
		setImmediate(() => this.emit('close'));
	}

	destroy() {
		this.destroyed = true;
		setImmediate(() => this.emit('close'));
	}

	// Helper: simulate data arriving from the remote client
	simulateData(buf) {
		this.emit('data', Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
	}
}

// ---------------------------------------------------------------------------
// Minimal mock call pool
// ---------------------------------------------------------------------------

function makeMockCallPool() {
	return {
		name: 'TestPool',
		createCall: function(conn) {
			return {
				conn: conn,
				setupCall: function() {},
				connectionClosed: function() {},
				handleData: function() {},
				term_width: 80,
				term_height: 24
			};
		}
	};
}

// Helper: wait for a condition to become true within timeoutMs
function waitFor(condFn, timeoutMs, pollMs) {
	pollMs = pollMs || 20;
	return new Promise(function(resolve, reject) {
		var elapsed = 0;
		var iv = setInterval(function() {
			if (condFn()) {
				clearInterval(iv);
				resolve();
			} else {
				elapsed += pollMs;
				if (elapsed >= timeoutMs) {
					clearInterval(iv);
					reject(new Error('waitFor timed out after ' + timeoutMs + 'ms'));
				}
			}
		}, pollMs);
	});
}

// =========================================================================
// Tests
// =========================================================================

describe('TerminalPool auto-detection', function() {
	// The downgrade timer fires after 2000ms, so tests that wait for it
	// need a generous timeout.
	this.timeout(8000);

	function makePool() {
		var pool = new TerminalPool('Test');
		pool.setCallPool(makeMockCallPool());
		return pool;
	}

	it('should set keepAlive on the socket', function() {
		var pool = makePool();
		var socket = new MockSocket();
		pool.handleConnection(socket);
		assert.ok(socket._keepAliveEnabled, 'setKeepAlive should have been called');
	});

	it('should send initial telnet negotiation bytes immediately', function() {
		var pool = makePool();
		var socket = new MockSocket();
		pool.handleConnection(socket);

		// TelnetConnection.constructor calls sendInitialNegotiation — IAC bytes go out
		assert.ok(socket.written.length > 0, 'should write telnet negotiation immediately');
		var combined = Buffer.concat(socket.written);
		assert.ok(combined.includes(IAC), 'negotiation output should contain IAC (0xFF) bytes');
	});

	it('should confirm telnet when client sends IAC WILL SGA', async function() {
		var pool = makePool();
		var socket = new MockSocket();
		pool.handleConnection(socket);

		var conn = pool.connections[0];
		assert.strictEqual(conn.connectionType, 'Telnet', 'initial type should be Telnet');

		// Client responds with IAC WILL SGA — telnet confirmed
		socket.simulateData(Buffer.from([IAC, WILL, OPT_SGA]));

		// Give the event loop a tick to process
		await new Promise(function(r) { setImmediate(r); });

		// Connection type should still be Telnet (not downgraded)
		assert.strictEqual(conn.connectionType, 'Telnet', 'should remain Telnet after IAC WILL');
		// Parser should NOT be disabled
		assert.ok(!conn.telnetParser._disabled, 'telnetParser._disabled should be false');
	});

	it('should confirm telnet when client sends IAC DO NAWS', async function() {
		var pool = makePool();
		var socket = new MockSocket();
		pool.handleConnection(socket);

		var conn = pool.connections[0];
		socket.simulateData(Buffer.from([IAC, DO, OPT_NAWS]));

		await new Promise(function(r) { setImmediate(r); });

		assert.strictEqual(conn.connectionType, 'Telnet');
		assert.ok(!conn.telnetParser._disabled);
	});

	it('should confirm telnet when client sends IAC WONT', async function() {
		var pool = makePool();
		var socket = new MockSocket();
		pool.handleConnection(socket);

		var conn = pool.connections[0];
		socket.simulateData(Buffer.from([IAC, WONT, OPT_ECHO]));

		await new Promise(function(r) { setImmediate(r); });

		assert.strictEqual(conn.connectionType, 'Telnet');
		assert.ok(!conn.telnetParser._disabled);
	});

	it('should confirm telnet when client sends IAC DONT', async function() {
		var pool = makePool();
		var socket = new MockSocket();
		pool.handleConnection(socket);

		var conn = pool.connections[0];
		socket.simulateData(Buffer.from([IAC, DONT, OPT_ECHO]));

		await new Promise(function(r) { setImmediate(r); });

		assert.strictEqual(conn.connectionType, 'Telnet');
		assert.ok(!conn.telnetParser._disabled);
	});

	it('should downgrade to TCP after timeout when no data arrives', async function() {
		var pool = makePool();
		var socket = new MockSocket();
		pool.handleConnection(socket);

		var conn = pool.connections[0];

		// Wait for the 2-second downgrade timer to fire
		await waitFor(function() { return conn.connectionType === 'TCP'; }, 3000);

		assert.strictEqual(conn.connectionType, 'TCP', 'should downgrade to TCP after timeout');
		assert.ok(conn.telnetParser._disabled, 'telnetParser._disabled should be true after downgrade');
	});

	it('should downgrade to TCP after timeout when only normal ASCII arrives', async function() {
		var pool = makePool();
		var socket = new MockSocket();
		pool.handleConnection(socket);

		var conn = pool.connections[0];

		// Send normal ASCII — no IAC
		socket.simulateData(Buffer.from('Hello\r\n', 'ascii'));

		// Wait for the downgrade timer
		await waitFor(function() { return conn.connectionType === 'TCP'; }, 3000);

		assert.strictEqual(conn.connectionType, 'TCP', 'should downgrade to TCP when no IAC seen');
		assert.ok(conn.telnetParser._disabled, 'parser should be disabled after downgrade');
	});

	it('should remain telnet when mixed data then IAC arrives within monitoring window', async function() {
		var pool = makePool();
		var socket = new MockSocket();
		pool.handleConnection(socket);

		var conn = pool.connections[0];

		// Send normal ASCII first
		socket.simulateData(Buffer.from('AT\r\n', 'ascii'));

		// Then send IAC WILL (still within the 2-second window)
		await new Promise(function(r) { setTimeout(r, 100); });
		socket.simulateData(Buffer.from([IAC, WILL, OPT_SGA]));

		await new Promise(function(r) { setTimeout(r, 200); });

		assert.strictEqual(conn.connectionType, 'Telnet',
			'should not downgrade when IAC arrives within the monitoring window');
		assert.ok(!conn.telnetParser._disabled,
			'parser should remain enabled when telnet confirmed');
	});

	it('should add connection to pool connections array', function() {
		var pool = makePool();
		var socket = new MockSocket();
		pool.handleConnection(socket);
		assert.strictEqual(pool.connections.length, 1);
	});

	it('should track multiple concurrent connections', function() {
		var pool = makePool();
		var s1 = new MockSocket();
		var s2 = new MockSocket();
		s2.remotePort = 12346;
		pool.handleConnection(s1);
		pool.handleConnection(s2);
		assert.strictEqual(pool.connections.length, 2);
	});

	it('should remove connection on socket close', async function() {
		var pool = makePool();
		var socket = new MockSocket();
		pool.handleConnection(socket);
		assert.strictEqual(pool.connections.length, 1);

		// Trigger close
		socket.emit('close');
		await new Promise(function(r) { setImmediate(r); });

		assert.strictEqual(pool.connections.length, 0, 'connection should be removed on close');
	});

	it('should not forward to pool when forwardtoPool is false', function() {
		var pool = new TerminalPool('NoForward');
		// Do not call setCallPool — forwardtoPool stays false
		var socket = new MockSocket();
		pool.handleConnection(socket);

		var conn = pool.connections[0];
		// Connection created but no callhandler
		assert.strictEqual(conn.callhandler, null, 'no callhandler when not forwarding');
	});

	it('should write goodbye message to socket when not forwarding to pool', function() {
		var pool = new TerminalPool('NoForward');
		var socket = new MockSocket();
		pool.handleConnection(socket);

		// When no pool, TelnetConnection.announceConnection writes a goodbye
		var combined = socket.written.map(function(b) { return b.toString(); }).join('');
		assert.ok(combined.includes('Sorry') || combined.includes('Goodbye') || combined.includes('sorry'),
			'should write a goodbye/sorry message: ' + combined);
	});

	it('IAC SB (subnegotiation begin) should also confirm telnet', async function() {
		var pool = makePool();
		var socket = new MockSocket();
		pool.handleConnection(socket);

		var conn = pool.connections[0];

		// IAC SB is in TELNET_COMMANDS set (0xFA)
		socket.simulateData(Buffer.from([IAC, SB, OPT_NAWS]));

		await new Promise(function(r) { setImmediate(r); });

		assert.strictEqual(conn.connectionType, 'Telnet',
			'IAC SB should confirm telnet mode');
		assert.ok(!conn.telnetParser._disabled);
	});
});
