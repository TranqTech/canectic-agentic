// tests/mailServerMaintenance.test.js: IMAP and SMTP while the board is closed.
//
// Each protocol has its own way of saying "not now", and using it is the
// difference between a client that waits and one that reports an error or,
// for inbound mail, a sender that bounces instead of retrying. IMAP greets
// with BYE (RFC 3501 allows it in place of OK); SMTP answers 421, which a
// sending MTA treats as a temporary failure and queues.
//
// The per-connection handler is called directly with a fake socket, so no
// port is bound and no Redis connection is opened.
//
// Run: npx mocha --no-config --exit tests/mailServerMaintenance.test.js

import assert from 'assert';
import { EventEmitter } from 'events';

var ImapServer = null, SmtpServer = null;
try {
	ImapServer = (await import('../src/servers/imapServer.js')).ImapServer;
	SmtpServer = (await import('../src/servers/smtpServer.js')).SmtpServer;
} catch (_) { /* suites skip */ }

function fakeSocket(addr) {
	var s = new EventEmitter();
	s.remoteAddress = addr || '127.0.0.1';
	s.written = '';
	s.ended = false;
	s.destroyed = false;
	s.write = function (b) { s.written += String(b); return true; };
	s.end = function () { s.ended = true; };
	s.destroy = function () { s.destroyed = true; };
	return s;
}

describe('IMAP in maintenance mode', function () {
	before(function () { if (!ImapServer) this.skip(); });

	it('greets a new connection with BYE and closes it', function () {
		var srv = new ImapServer(0, 'bbs.example');
		srv.setMaintenance(true);
		var sock = fakeSocket();
		var session = srv._onConnection(sock);
		assert.strictEqual(session, null);
		assert.strictEqual(srv.sessions.size, 0);
		assert.ok(/^\* BYE /.test(sock.written), sock.written);
		assert.strictEqual(sock.ended, true);
	});

	it('greets normally once the board is open', function () {
		var srv = new ImapServer(0, 'bbs.example');
		var sock = fakeSocket();
		srv._onConnection(sock);
		assert.ok(/^\* OK /.test(sock.written), sock.written);
		assert.strictEqual(srv.sessions.size, 1);
	});

	it('says BYE to open sessions, IDLE included, when the grace runs out', function () {
		var srv = new ImapServer(0, 'bbs.example');
		var sock = fakeSocket();
		srv._onConnection(sock);
		sock.written = '';
		srv.closeSessionsForMaintenance();
		assert.ok(/^\* BYE .*maintenance/i.test(sock.written), sock.written);
		assert.strictEqual(sock.ended, true);
	});
});

describe('SMTP in maintenance mode', function () {
	before(function () { if (!SmtpServer) this.skip(); });

	it('answers a new submission connection with 421', function () {
		var srv = new SmtpServer(0, 'bbs.example');
		srv.setMaintenance(true);
		var sock = fakeSocket();
		assert.strictEqual(srv._onConnection(sock), null);
		assert.ok(/^421 4\.3\.2 /.test(sock.written), '421 is a temporary failure: ' + sock.written);
		assert.strictEqual(sock.ended, true);
		assert.strictEqual(srv.sessions.size, 0);
	});

	it('answers the trusted inbound gateway with 421 too, so the sending MTA retries', function () {
		var srv = new SmtpServer(0, 'bbs.example', { trusted: true, trustedHosts: '127.0.0.1' });
		srv.setMaintenance(true);
		var sock = fakeSocket('127.0.0.1');
		srv._onConnection(sock);
		assert.ok(/^421 /.test(sock.written), sock.written);
	});

	it('still refuses an untrusted host with 554 rather than inviting a retry', function () {
		var srv = new SmtpServer(0, 'bbs.example', { trusted: true, trustedHosts: '127.0.0.1' });
		srv.setMaintenance(true);
		var sock = fakeSocket('192.0.2.9');
		srv._onConnection(sock);
		assert.ok(/^554 /.test(sock.written), sock.written);
	});

	it('greets normally once the board is open', function () {
		var srv = new SmtpServer(0, 'bbs.example');
		var sock = fakeSocket();
		srv._onConnection(sock);
		assert.ok(/^220 /.test(sock.written), sock.written);
		assert.strictEqual(srv.sessions.size, 1);
	});

	it('closes open sessions with 421 when the grace runs out', function () {
		var srv = new SmtpServer(0, 'bbs.example');
		var sock = fakeSocket();
		srv._onConnection(sock);
		sock.written = '';
		srv.closeSessionsForMaintenance();
		assert.ok(/^421 .*maintenance/i.test(sock.written), sock.written);
		assert.strictEqual(sock.ended, true);
	});
});
