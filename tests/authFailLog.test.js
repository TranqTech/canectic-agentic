// tests/authFailLog.test.js -- failed logins reach security.log in a form the
// shipped fail2ban filter can act on (#83).
//
// A failed IMAP or SMTP login was written "from unknown" (neither passed the
// client address), and a rejected API token was not written at all. Lines
// are captured through setAuthFailSink rather than written to the board's
// real security.log, and checked against the regex in
// examples/fail2ban/filter.d, so a change to either side that stops fail2ban
// matching fails here.

import assert from 'assert';
import { EventEmitter } from 'node:events';
import * as fs from 'fs';
import { dbAvailable } from './helpers/dbAvailable.js';
import { authFailMessage, normaliseIp, setAuthFailSink } from '../src/utils/authFailLog.js';

// fail2ban's <HOST> as a capture group; the rest of the filter verbatim.
function filterRegex() {
	var conf = fs.readFileSync(new URL('../examples/fail2ban/filter.d/canectic-auth.conf', import.meta.url), 'utf8');
	var line = conf.split('\n').find(function (l) { return /^failregex\s*=/.test(l); });
	var re = line.replace(/^failregex\s*=\s*/, '').trim().replace('<HOST>', '(\\S+)');
	return new RegExp(re);
}

function hostFrom(line) {
	var m = filterRegex().exec(line);
	return m ? m[1] : null;
}

function fakeSocket(addr) {
	var s = new EventEmitter();
	s.remoteAddress = addr;
	s.destroyed = false;
	s.written = [];
	s.write = function (x) { s.written.push(String(x)); return true; };
	s.end = function () {};
	s.destroy = function () { s.destroyed = true; };
	return s;
}

describe('[AUTHFAIL] lines for fail2ban (#83)', function () {

	describe('format', function () {
		it('is matched by the shipped filter, host and all, with a service suffix', function () {
			assert.strictEqual(hostFrom(authFailMessage('failed', 'bob', '203.0.113.7', 'IMAP')), '203.0.113.7');
			assert.strictEqual(hostFrom(authFailMessage('unknown', 'nobody', '203.0.113.8')), '203.0.113.8');
			assert.strictEqual(hostFrom(authFailMessage('failed', 'API token', '2001:db8::5', 'API')), '2001:db8::5');
		});

		it('reports an IPv4 client on a dual-stack socket as IPv4', function () {
			assert.strictEqual(normaliseIp('::ffff:203.0.113.9'), '203.0.113.9');
			assert.strictEqual(hostFrom(authFailMessage('failed', 'bob', '::ffff:203.0.113.9')), '203.0.113.9');
		});

		it('keeps a quote in the name from breaking the line', function () {
			assert.strictEqual(hostFrom(authFailMessage('failed', 'bo"b', '203.0.113.7')), '203.0.113.7');
		});
	});

	describe('from each service', function () {
		this.timeout(15000);
		var available = false, lines = [];

		before(async function () { available = await dbAvailable(); });
		beforeEach(function () {
			if (!available) return this.skip();
			lines = [];
			setAuthFailSink(function (l) { lines.push(l); });
		});
		afterEach(function () { setAuthFailSink(null); });

		var NOBODY = 'zz_no_such_user_83';

		it('IMAP LOGIN', async function () {
			var { ImapSession } = await import('../src/servers/imapServer.js');
			var session = new ImapSession(fakeSocket('::ffff:203.0.113.21'), 'example.invalid');
			await session._cmdLogin('a1', NOBODY + ' wrongpass');
			assert.strictEqual(lines.length, 1, JSON.stringify(lines));
			assert.strictEqual(hostFrom(lines[0]), '203.0.113.21');
			assert.ok(/via IMAP$/.test(lines[0]), lines[0]);
			session.close();
		});

		it('SMTP AUTH PLAIN and AUTH LOGIN', async function () {
			var { SmtpSession } = await import('../src/servers/smtpServer.js');
			var session = new SmtpSession(fakeSocket('203.0.113.22'), 'example.invalid');
			await session._authPlain(Buffer.from('\0' + NOBODY + '\0wrongpass').toString('base64'));
			session._authLoginUsername = NOBODY;
			await session._authLoginPass(Buffer.from('wrongpass').toString('base64'));
			assert.strictEqual(lines.length, 2, JSON.stringify(lines));
			for (var l of lines) {
				assert.strictEqual(hostFrom(l), '203.0.113.22');
				assert.ok(/via SMTP$/.test(l), l);
			}
			if (session.close) session.close();
		});

		it('a rejected API token, without writing the token', async function () {
			var { apiAuth } = await import('../src/middleware/apiAuth.js');
			var status = null;
			var res = { status: function (s) { status = s; return this; }, json: function () { return this; } };
			var secret = 'canectic_notarealtoken0000000000';
			await apiAuth({ headers: { authorization: 'Bearer ' + secret }, ip: '203.0.113.23', socket: {} }, res, function () {});
			assert.strictEqual(status, 401);
			assert.strictEqual(lines.length, 1, JSON.stringify(lines));
			assert.strictEqual(hostFrom(lines[0]), '203.0.113.23');
			assert.ok(lines[0].indexOf(secret) === -1, 'the token was written to the log');
		});
	});
});
