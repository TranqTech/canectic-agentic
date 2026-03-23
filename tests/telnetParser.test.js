// tests/telnetParser.test.js — TelnetParser unit tests.

import assert from 'assert';
import { TelnetParser } from '../src/servers/telnetserver.js';

// Telnet constants (mirrors telnetserver.js)
var IAC  = 0xFF;
var DONT = 0xFE;
var DO   = 0xFD;
var WONT = 0xFC;
var WILL = 0xFB;
var SB   = 0xFA;
var SE   = 0xF0;
var GA   = 0xF9;
var NOP  = 0xF1;

var OPT_BINARY   = 0;
var OPT_ECHO     = 1;
var OPT_SGA      = 3;
var OPT_NAWS     = 31;
var OPT_TTYPE    = 24;
var OPT_LINEMODE = 34;

function makeMockConn() {
	var written = [];
	return {
		socket: {
			destroyed: false,
			write: function(buf) { written.push(Buffer.from(buf)); }
		},
		callhandler: null,
		loggingId: 'test',
		_written: written
	};
}

// =========================================================================
// filterInbound — normal data pass-through
// =========================================================================

describe('TelnetParser filterInbound', function() {

	it('should pass through normal ASCII data unchanged', function() {
		var conn = makeMockConn();
		var p = new TelnetParser(conn);
		var input = Buffer.from('Hello, World!', 'ascii');
		var out = p.filterInbound(input);
		assert.deepStrictEqual(out, input);
	});

	it('should strip IAC WILL <option> (3-byte sequence)', function() {
		var conn = makeMockConn();
		var p = new TelnetParser(conn);
		var input = Buffer.from([0x41, IAC, WILL, OPT_NAWS, 0x42]);
		var out = p.filterInbound(input);
		// Only 'A' and 'B' should remain; IAC WILL OPT_NAWS is stripped
		assert.deepStrictEqual(out, Buffer.from([0x41, 0x42]));
	});

	it('should strip IAC WONT <option>', function() {
		var conn = makeMockConn();
		var p = new TelnetParser(conn);
		var input = Buffer.from([IAC, WONT, OPT_ECHO]);
		var out = p.filterInbound(input);
		assert.strictEqual(out.length, 0);
	});

	it('should strip IAC DO <option>', function() {
		var conn = makeMockConn();
		var p = new TelnetParser(conn);
		var input = Buffer.from([IAC, DO, OPT_SGA]);
		var out = p.filterInbound(input);
		assert.strictEqual(out.length, 0);
	});

	it('should strip IAC DONT <option>', function() {
		var conn = makeMockConn();
		var p = new TelnetParser(conn);
		var input = Buffer.from([IAC, DONT, OPT_LINEMODE]);
		var out = p.filterInbound(input);
		assert.strictEqual(out.length, 0);
	});

	it('should unescape 0xFF 0xFF to single 0xFF', function() {
		var conn = makeMockConn();
		var p = new TelnetParser(conn);
		// IAC IAC = escaped literal 0xFF
		var input = Buffer.from([0x41, IAC, IAC, 0x42]);
		var out = p.filterInbound(input);
		assert.deepStrictEqual(out, Buffer.from([0x41, 0xFF, 0x42]));
	});

	it('should strip IAC SB ... IAC SE subnegotiation', function() {
		var conn = makeMockConn();
		var p = new TelnetParser(conn);
		// NAWS subnegotiation: width=80 (0x00 0x50), height=24 (0x00 0x18)
		var input = Buffer.from([
			0x41,
			IAC, SB, OPT_NAWS, 0x00, 0x50, 0x00, 0x18, IAC, SE,
			0x42
		]);
		var out = p.filterInbound(input);
		// Only 'A' and 'B' should remain
		assert.deepStrictEqual(out, Buffer.from([0x41, 0x42]));
	});

	it('should handle IAC split across two chunks (stateful parsing)', function() {
		var conn = makeMockConn();
		var p = new TelnetParser(conn);

		// First chunk ends with IAC
		var chunk1 = Buffer.from([0x41, IAC]);
		// Second chunk starts with the command and option
		var chunk2 = Buffer.from([WILL, OPT_NAWS, 0x42]);

		var out1 = p.filterInbound(chunk1);
		var out2 = p.filterInbound(chunk2);

		// 'A' from chunk1, 'B' from chunk2, IAC WILL OPT_NAWS stripped
		assert.deepStrictEqual(out1, Buffer.from([0x41]));
		assert.deepStrictEqual(out2, Buffer.from([0x42]));
	});

	it('should handle 0xFF 0xFF split across two chunks', function() {
		var conn = makeMockConn();
		var p = new TelnetParser(conn);

		var chunk1 = Buffer.from([IAC]);
		var chunk2 = Buffer.from([IAC]);

		var out1 = p.filterInbound(chunk1);
		var out2 = p.filterInbound(chunk2);

		// First chunk: IAC alone — goes into iac state, no output yet
		assert.strictEqual(out1.length, 0);
		// Second chunk: second IAC — completes the escape, outputs 0xFF
		assert.deepStrictEqual(out2, Buffer.from([0xFF]));
	});

	it('should pass through data unchanged when _disabled flag is true', function() {
		var conn = makeMockConn();
		var p = new TelnetParser(conn);
		p._disabled = true;

		// Even IAC sequences should pass through unmodified
		var input = Buffer.from([0x41, IAC, WILL, OPT_NAWS, 0x42]);
		var out = p.filterInbound(input);
		assert.deepStrictEqual(out, input);
	});

	it('should strip IAC GA (go-ahead)', function() {
		var conn = makeMockConn();
		var p = new TelnetParser(conn);
		var input = Buffer.from([0x41, IAC, GA, 0x42]);
		var out = p.filterInbound(input);
		assert.deepStrictEqual(out, Buffer.from([0x41, 0x42]));
	});

	it('should strip IAC NOP', function() {
		var conn = makeMockConn();
		var p = new TelnetParser(conn);
		var input = Buffer.from([0x41, IAC, NOP, 0x42]);
		var out = p.filterInbound(input);
		assert.deepStrictEqual(out, Buffer.from([0x41, 0x42]));
	});

	it('should handle mixed data and IAC commands in the same buffer', function() {
		var conn = makeMockConn();
		var p = new TelnetParser(conn);
		var input = Buffer.from([
			0x48, 0x65, 0x6C, 0x6C, 0x6F,  // "Hello"
			IAC, WILL, OPT_ECHO,             // stripped
			0x20,                            // " "
			IAC, DO, OPT_SGA,               // stripped
			0x57, 0x6F, 0x72, 0x6C, 0x64   // "World"
		]);
		var out = p.filterInbound(input);
		assert.deepStrictEqual(out, Buffer.from('Hello World', 'ascii'));
	});

	it('should handle empty buffer', function() {
		var conn = makeMockConn();
		var p = new TelnetParser(conn);
		var out = p.filterInbound(Buffer.alloc(0));
		assert.strictEqual(out.length, 0);
	});

	it('should handle multiple consecutive IAC sequences', function() {
		var conn = makeMockConn();
		var p = new TelnetParser(conn);
		var input = Buffer.from([
			IAC, WILL, OPT_ECHO,
			IAC, DO, OPT_SGA,
			IAC, WONT, OPT_LINEMODE
		]);
		var out = p.filterInbound(input);
		assert.strictEqual(out.length, 0);
	});
});

// =========================================================================
// escapeOutbound — static method
// =========================================================================

describe('TelnetParser escapeOutbound', function() {

	it('should pass through data with no 0xFF unchanged (fast path)', function() {
		var input = Buffer.from('Hello, World!', 'ascii');
		var out = TelnetParser.escapeOutbound(input, false);
		// Same buffer reference expected on fast path
		assert.strictEqual(out, input);
	});

	it('should double 0xFF bytes', function() {
		var input = Buffer.from([0x41, 0xFF, 0x42]);
		var out = TelnetParser.escapeOutbound(input, false);
		assert.deepStrictEqual(out, Buffer.from([0x41, 0xFF, 0xFF, 0x42]));
	});

	it('should double multiple 0xFF bytes', function() {
		var input = Buffer.from([0xFF, 0x41, 0xFF, 0x42, 0xFF]);
		var out = TelnetParser.escapeOutbound(input, false);
		assert.deepStrictEqual(out, Buffer.from([0xFF, 0xFF, 0x41, 0xFF, 0xFF, 0x42, 0xFF, 0xFF]));
	});

	it('should handle buffer that is all 0xFF', function() {
		var input = Buffer.from([0xFF, 0xFF, 0xFF]);
		var out = TelnetParser.escapeOutbound(input, false);
		assert.deepStrictEqual(out, Buffer.from([0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]));
	});

	it('should pass through unchanged when disabled is true', function() {
		var input = Buffer.from([0x41, 0xFF, 0x42]);
		var out = TelnetParser.escapeOutbound(input, true);
		// Should be exactly the same buffer, not escaped
		assert.strictEqual(out, input);
	});

	it('should handle empty buffer', function() {
		var input = Buffer.alloc(0);
		var out = TelnetParser.escapeOutbound(input, false);
		assert.strictEqual(out.length, 0);
	});

	it('should handle single non-0xFF byte', function() {
		var input = Buffer.from([0x41]);
		var out = TelnetParser.escapeOutbound(input, false);
		assert.strictEqual(out, input);
	});

	it('should handle single 0xFF byte', function() {
		var input = Buffer.from([0xFF]);
		var out = TelnetParser.escapeOutbound(input, false);
		assert.deepStrictEqual(out, Buffer.from([0xFF, 0xFF]));
	});
});

// =========================================================================
// _handleWill — dedup via acceptedOptions Set
// =========================================================================

describe('TelnetParser _handleWill deduplication', function() {

	it('should respond only once per option (no negotiation loop)', function() {
		var conn = makeMockConn();
		var p = new TelnetParser(conn);

		// Client says WILL NAWS twice
		p.filterInbound(Buffer.from([IAC, WILL, OPT_NAWS]));
		var firstCount = conn._written.length;
		assert.ok(firstCount > 0, 'should have responded to first WILL NAWS');

		p.filterInbound(Buffer.from([IAC, WILL, OPT_NAWS]));
		var secondCount = conn._written.length;
		assert.strictEqual(secondCount, firstCount, 'should not respond again to duplicate WILL');
	});

	it('should send DO NAWS in response to WILL NAWS', function() {
		var conn = makeMockConn();
		var p = new TelnetParser(conn);

		p.filterInbound(Buffer.from([IAC, WILL, OPT_NAWS]));

		var found = conn._written.some(function(buf) {
			return buf.length >= 3 && buf[0] === IAC && buf[1] === DO && buf[2] === OPT_NAWS;
		});
		assert.ok(found, 'should send IAC DO OPT_NAWS');
	});

	it('should send DONT for unknown options', function() {
		var conn = makeMockConn();
		var p = new TelnetParser(conn);

		// Option 99 is unknown
		p.filterInbound(Buffer.from([IAC, WILL, 99]));

		var found = conn._written.some(function(buf) {
			return buf.length >= 3 && buf[0] === IAC && buf[1] === DONT && buf[2] === 99;
		});
		assert.ok(found, 'should send IAC DONT for unknown option');
	});

	it('should respond once to WILL BINARY and accept', function() {
		var conn = makeMockConn();
		var p = new TelnetParser(conn);

		p.filterInbound(Buffer.from([IAC, WILL, OPT_BINARY]));
		var firstCount = conn._written.length;
		assert.ok(firstCount > 0, 'should have responded');

		p.filterInbound(Buffer.from([IAC, WILL, OPT_BINARY]));
		assert.strictEqual(conn._written.length, firstCount, 'no duplicate response');
	});
});

// =========================================================================
// NAWS subnegotiation — window size update
// =========================================================================

describe('TelnetParser NAWS subnegotiation', function() {

	it('should parse NAWS and set term_width and term_height on callhandler', function() {
		var conn = makeMockConn();
		var handler = { term_width: 80, term_height: 24 };
		conn.callhandler = handler;
		var p = new TelnetParser(conn);

		// IAC SB NAWS width_hi width_lo height_hi height_lo IAC SE
		// width = 132 (0x00 0x84), height = 50 (0x00 0x32)
		var input = Buffer.from([
			IAC, SB, OPT_NAWS,
			0x00, 0x84, // width = 132
			0x00, 0x32, // height = 50
			IAC, SE
		]);
		p.filterInbound(input);

		assert.strictEqual(handler.term_width, 132);
		assert.strictEqual(handler.term_height, 50);
	});

	it('should parse NAWS with standard 80x24 dimensions', function() {
		var conn = makeMockConn();
		var handler = { term_width: 0, term_height: 0 };
		conn.callhandler = handler;
		var p = new TelnetParser(conn);

		var input = Buffer.from([
			IAC, SB, OPT_NAWS,
			0x00, 0x50, // width = 80
			0x00, 0x18, // height = 24
			IAC, SE
		]);
		p.filterInbound(input);

		assert.strictEqual(handler.term_width, 80);
		assert.strictEqual(handler.term_height, 24);
	});

	it('should not update callhandler when it is null', function() {
		var conn = makeMockConn();
		conn.callhandler = null;
		var p = new TelnetParser(conn);

		// Should not throw
		var input = Buffer.from([
			IAC, SB, OPT_NAWS,
			0x00, 0x50, 0x00, 0x18,
			IAC, SE
		]);
		assert.doesNotThrow(function() {
			p.filterInbound(input);
		});
	});

	it('should strip NAWS subnegotiation bytes from data output', function() {
		var conn = makeMockConn();
		conn.callhandler = { term_width: 0, term_height: 0 };
		var p = new TelnetParser(conn);

		var input = Buffer.from([
			0x41,                            // 'A'
			IAC, SB, OPT_NAWS,
			0x00, 0x50, 0x00, 0x18,
			IAC, SE,
			0x42                             // 'B'
		]);
		var out = p.filterInbound(input);
		assert.deepStrictEqual(out, Buffer.from([0x41, 0x42]));
	});

	it('should handle two consecutive NAWS subnegotiations', function() {
		var conn = makeMockConn();
		var handler = { term_width: 0, term_height: 0 };
		conn.callhandler = handler;
		var p = new TelnetParser(conn);

		// First: 80x24
		p.filterInbound(Buffer.from([
			IAC, SB, OPT_NAWS, 0x00, 0x50, 0x00, 0x18, IAC, SE
		]));
		assert.strictEqual(handler.term_width, 80);

		// Second: 132x50
		p.filterInbound(Buffer.from([
			IAC, SB, OPT_NAWS, 0x00, 0x84, 0x00, 0x32, IAC, SE
		]));
		assert.strictEqual(handler.term_width, 132);
		assert.strictEqual(handler.term_height, 50);
	});
});

// =========================================================================
// sendInitialNegotiation — verifies IAC bytes are sent on socket
// =========================================================================

describe('TelnetParser sendInitialNegotiation', function() {

	it('should write IAC sequences to the socket', function() {
		var conn = makeMockConn();
		var p = new TelnetParser(conn);
		p.sendInitialNegotiation();

		assert.ok(conn._written.length > 0, 'should write negotiation bytes');

		// All written buffers should start with IAC
		var allStartWithIAC = conn._written.every(function(buf) {
			return buf.length >= 1 && buf[0] === IAC;
		});
		assert.ok(allStartWithIAC, 'all sent commands should start with IAC (0xFF)');
	});

	it('should not write when socket is destroyed', function() {
		var conn = makeMockConn();
		conn.socket.destroyed = true;
		var p = new TelnetParser(conn);
		p.sendInitialNegotiation();
		assert.strictEqual(conn._written.length, 0, 'should not write to destroyed socket');
	});
});
