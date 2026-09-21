// tests/mailerMaintenance.test.js: the binkp mailer while the board is closed.
//
// Closed means no new sessions either way. Inbound callers get M_BSY, which
// binkp mailers read as "try later"; outbound is refused at the two choke
// points every outbound route ends in; the BSO scanner leaves the outbound
// alone. What is still in flight is reported so the updater knows when the
// mailer is idle, including a connect that has not yet become a session.
//
// The manager is never started, so nothing binds a port.
//
// Run: npx mocha --no-config --exit tests/mailerMaintenance.test.js

import assert from 'assert';

var MailerManager = null, BsoScanner = null;
try {
	MailerManager = (await import('../src/mailer/manager.js')).MailerManager;
	BsoScanner = (await import('../src/mailer/bsoScanner.js')).BsoScanner;
} catch (_) { /* suites skip */ }

// A binkp command frame: 2-byte header with the top bit set, then the
// command byte, then the argument.
function decodeFrame(buf) {
	var len = buf.readUInt16BE(0) & 0x7fff;
	return { command: buf[2], text: buf.slice(3, 2 + len).toString() };
}

function fakeSocket() {
	var s = { written: [], ended: false, destroyed: false, remoteAddress: '192.0.2.1', remotePort: 5555 };
	s.write = function (b) { s.written.push(b); };
	s.end = function () { s.ended = true; };
	s.destroy = function () { s.destroyed = true; };
	return s;
}

describe('MailerManager in maintenance mode', function () {
	var manager;

	before(function () { if (!MailerManager) this.skip(); });
	beforeEach(function () {
		manager = new MailerManager({});
		manager._running = true;   // as if started, without binding anything
	});

	it('refuses an inbound TCP caller with M_BSY and a reason', function () {
		manager.setMaintenance(true);
		var sock = fakeSocket();
		manager._onInboundTcp(sock);
		assert.strictEqual(manager._sessions.length, 0, 'no session may start');
		assert.strictEqual(sock.ended, true);
		var f = decodeFrame(sock.written[0]);
		assert.strictEqual(f.command, 8, 'M_BSY, which a remote mailer treats as try later');
		assert.ok(/maintenance/i.test(f.text), f.text);
	});

	it('refuses an inbound WebSocket caller with a readable M_BSY', function () {
		manager.setMaintenance(true);
		var sent = [], closed = false;
		manager._onInboundWebSocket({ send: function (b) { sent.push(b); }, close: function () { closed = true; } },
			{ socket: { remoteAddress: '192.0.2.1' } });
		assert.strictEqual(closed, true);
		var f = decodeFrame(sent[0]);
		assert.strictEqual(f.command, 8);
		assert.ok(/maintenance/i.test(f.text), 'the frame must carry its text, got ' + JSON.stringify(f.text));
	});

	it('sends a readable M_BSY on the WebSocket path when merely busy, too', function () {
		// That copy of the frame builder never copied the message in.
		var sent = [];
		manager._sessions = new Array(1000).fill({});
		manager._onInboundWebSocket({ send: function (b) { sent.push(b); }, close: function () {} },
			{ socket: { remoteAddress: '192.0.2.1' } });
		assert.strictEqual(decodeFrame(sent[0]).text, 'System busy, try later');
	});

	it('does not dial a peer', async function () {
		manager.setMaintenance(true);
		await manager._connectToPeer({ uuid: 'zz', connection_data: {
			address: '21:1/999', remote_host: '127.0.0.1', remote_port: 1 } }, { force: true });
		assert.strictEqual(manager._dials.size, 0, 'not even a forced poll may break a drain');
	});

	it('does not dial a nodelist route', function () {
		manager.setMaintenance(true);
		manager.connectToNodelistAddress({ hostname: '127.0.0.1', binkpPort: 1 }, '21:1/999');
		assert.strictEqual(manager._dials.size, 0);
	});

	it('reports sessions and connects still in flight', function () {
		manager._sessions = [{}, {}];
		manager._dials.set(1, Date.now());
		assert.deepStrictEqual(manager.drainCounts(), { 'binkp sessions': 2, 'binkp connects': 1 });
	});

	it('forgets a connect that never reported back, so it cannot hold the drain open', function () {
		manager._dials.set(1, Date.now() - 3600000);
		assert.strictEqual(manager.drainCounts()['binkp connects'], 0);
		assert.strictEqual(manager._dials.size, 0);
	});

	it('ends running sessions when the grace runs out', function () {
		var errs = [];
		manager._sessions = [
			{ protocol: { sendERR: function (m) { errs.push(m); } } },
			{ protocol: { sendERR: function (m) { errs.push(m); } } },
			{ protocol: null }
		];
		manager.endSessionsForMaintenance();
		assert.strictEqual(errs.length, 2);
		assert.ok(/maintenance/i.test(errs[0]));
	});

	it('accepts callers again once maintenance is over', function () {
		manager.setMaintenance(true);
		manager.setMaintenance(false);
		assert.strictEqual(manager.isInMaintenance(), false);
	});
});

describe('BsoScanner in maintenance mode', function () {
	before(function () { if (!BsoScanner) this.skip(); });

	it('leaves the outbound alone while the board is closed', async function () {
		var looked = false;
		var scanner = new BsoScanner({ manager: {
			isRunning: function () { return true; },
			isInMaintenance: function () { return true; }
		} });
		scanner._resolveOutboundDir = function () { looked = true; return null; };
		await scanner._scan();
		assert.strictEqual(looked, false, 'a scan now would only queue refusals');
	});
});
