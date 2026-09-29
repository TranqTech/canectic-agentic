// tests/doorclient.test.js -- the shipped door-server client (#86, phase C).
//
// bin/doorclient.js is what sysops of other BBS software run as a stdio door
// to send a caller to a Canectic door server. Its pure parts are tested
// directly; the protocol is tested end to end against a stub server built on
// the ws package, with fake stdio.

import assert from 'assert';
import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';
import { parseArgs, readDropfile, problems, takeJsonLines, run } from '../bin/doorclient.js';

describe('door-server client (#86, phase C)', function () {

	describe('options', function () {
		it('parses and reports every problem at once', function () {
			var o = parseArgs(['--server', 'wss://b/ws/doorserver', '--system', 'MY', '--secret', 's', '--user', 'bob', '--door', 'lord', '--width', '132']);
			assert.strictEqual(o.width, 132); assert.strictEqual(o.door, 'lord');
			assert.deepStrictEqual(problems(o), []);
			assert.strictEqual(problems(parseArgs(['--server', 'http://x', '--encoding', 'koi8'])).length, 5);
			assert.throws(function () { parseArgs(['--nope']); }, /unknown option/);
		});
	});

	describe('drop files', function () {
		it('reads DOOR32.SYS: handle as the name, real name, UTF-8 emulation', function () {
			var d = readDropfile('COM0\r\n0\r\n38400\r\nMystic\r\n1\r\nBob Smith\r\nBobS\r\n50\r\n60\r\n4\r\n1\r\n', '/bbs/node1/DOOR32.SYS');
			assert.deepStrictEqual(d, { name: 'BobS', real_name: 'Bob Smith', utf8: true });
		});
		it('reads DOOR.SYS: line 10 the full name, line 36 the alias', function () {
			var lines = []; for (var i = 1; i <= 52; i++) lines.push('x' + i);
			lines[9] = 'Alice Jones'; lines[35] = 'AJ';
			assert.deepStrictEqual(readDropfile(lines.join('\r\n'), 'DOOR.SYS'), { name: 'AJ', real_name: 'Alice Jones', utf8: false });
		});
	});

	describe('takeJsonLines', function () {
		it('takes JSON lines and leaves the rest, the door screen included', function () {
			var r = takeJsonLines('{"type":"hello"}\n{"type":"auth_ok","doors":[]}\n\x1b[2Jscreen');
			assert.deepStrictEqual(r.frames.map(f => f.type), ['hello', 'auth_ok']);
			assert.strictEqual(r.rest, '\x1b[2Jscreen');
		});
	});

	describe('against a stub door server', function () {
		this.timeout(10000);
		var wss, port, seen;

		beforeEach(function (done) {
			seen = { auth: null, launch: null, keys: [] };
			wss = new WebSocketServer({ port: 0, host: '127.0.0.1' }, function () { port = wss.address().port; done(); });
			wss.on('connection', function (sock) {
				sock.send(JSON.stringify({ type: 'hello', protocol: 'canectic-doorserver/1' }) + '\n');
				sock.on('message', function (data, isBinary) {
					if (isBinary || seen.launch) { seen.keys.push(Buffer.from(data).toString()); if (seen.keys.join('') === 'q') sock.close(); return; }
					var f = JSON.parse(data.toString());
					if (f.type === 'auth') {
						seen.auth = f;
						sock.send(JSON.stringify({ type: 'auth_ok', node: 3, doors: [{ slug: 'lord', name: 'LORD' }, { slug: 'bre', name: 'BRE' }] }) + '\n');
						if (f.door) { seen.launch = f.door; sock.send(JSON.stringify({ type: 'launch_ok', door: f.door }) + '\n'); sock.send(Buffer.from('\x1b[2JWELCOME')); }
					} else if (f.type === 'launch') {
						seen.launch = f.door;
						sock.send(JSON.stringify({ type: 'launch_ok', door: f.door }) + '\n');
						sock.send(Buffer.from('\x1b[2JWELCOME'));
					}
				});
			});
		});
		afterEach(function (done) { for (var c of wss.clients) c.terminate(); wss.close(function () { done(); }); });

		function fakeIo() {
			var stdin = new EventEmitter(); stdin.resume = function () {}; stdin.pause = function () {};
			var out = []; var stdout = { write: function (b) { out.push(Buffer.from(b)); } };
			var err = []; var stderr = { write: function (s) { err.push(String(s)); } };
			return { io: { stdin: stdin, stdout: stdout, stderr: stderr }, text: function () { return Buffer.concat(out).toString('latin1'); }, stdin: stdin };
		}

		it('sends the caller and terminal, launches the named door and passes keys both ways', async function () {
			var f = fakeIo();
			var done = run({ server: 'ws://127.0.0.1:' + port, system: 'MYBBS', secret: 's3cret', user: 'Bob', door: 'lord', encoding: 'utf8', width: 100, height: 30 }, f.io);
			await new Promise(r => setTimeout(r, 400));
			assert.deepStrictEqual(seen.auth.user, { name: 'Bob', real_name: 'Bob' });
			assert.deepStrictEqual(seen.auth.term, { width: 100, height: 30, encoding: 'utf8', type: 'ansi' });
			assert.strictEqual(seen.auth.secret, 's3cret');
			assert.ok(f.text().includes('WELCOME'), JSON.stringify(f.text()));
			f.stdin.emit('data', Buffer.from('q'));
			assert.strictEqual(await done, 0);
			assert.deepStrictEqual(seen.keys, ['q']);
		});

		it('lets the caller choose from the list when no door is named', async function () {
			var f = fakeIo();
			var done = run({ server: 'ws://127.0.0.1:' + port, system: 'MYBBS', secret: 's', user: 'Bob', encoding: 'cp437', width: 80, height: 25 }, f.io);
			await new Promise(r => setTimeout(r, 300));
			assert.ok(f.text().includes(' 2) BRE'), f.text());
			f.stdin.emit('data', Buffer.from('2\r'));
			await new Promise(r => setTimeout(r, 300));
			assert.strictEqual(seen.launch, 'bre');
			assert.ok(f.text().includes('WELCOME'));
			f.stdin.emit('data', Buffer.from('q'));
			await done;
		});
	});
});
