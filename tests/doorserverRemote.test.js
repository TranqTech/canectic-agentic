// tests/doorserverRemote.test.js -- this board as a client of another
// Canectic door server (#86, phase D): the protocol client, the remotes
// registry rules, and the runner that bridges a caller's session.
//
// A stub door server on the ws package plays the remote side; the runner is
// driven with a fake call object, the way CallManager uses it.

import assert from 'assert';
import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';
import { openSession, listDoors } from '../src/utils/doorserverClient.js';
import { validateRemote, parseRemoteArg } from '../src/models/doorserverRemotes.js';
import { RemoteDoorRunner } from '../src/handlers/remotedoorrunner.js';

var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

describe('remote door servers (#86, phase D)', function () {
	this.timeout(10000);

	describe('rules', function () {
		it('checks a remote and keeps the current secret when the field is blank', function () {
			var ok = validateRemote({ name: 'Hub', url: 'wss://hub.example/ws/doorserver', system_id: 'mybbs', secret: 's' }, { creating: true });
			assert.deepStrictEqual(ok.errors, []);
			assert.strictEqual(ok.values.name, 'hub'); assert.strictEqual(ok.values.system_id, 'MYBBS');
			assert.strictEqual(validateRemote({ name: 'bad name', url: 'http://x', system_id: '!', secret: '' }, { creating: true }).errors.length, 4);
			var upd = validateRemote({ url: 'wss://h/ws/doorserver', system_id: 'MYBBS', secret: '' }, {});
			assert.deepStrictEqual(upd.errors, []);
			assert.ok(!('secret' in upd.values), 'a blank secret on update must not overwrite the stored one');
		});
		it('reads a menu argument as name or name:door', function () {
			assert.deepStrictEqual(parseRemoteArg('Hub'), { name: 'hub', door: '' });
			assert.deepStrictEqual(parseRemoteArg(' hub : lord '), { name: 'hub', door: 'lord' });
		});
	});

	describe('against a stub door server', function () {
		var wss, port, seen;
		beforeEach(function (done) {
			seen = { auth: null, launch: null, keys: [] };
			wss = new WebSocketServer({ port: 0, host: '127.0.0.1' }, function () { port = wss.address().port; done(); });
			wss.on('connection', function (sock) {
				sock.send(JSON.stringify({ type: 'hello', protocol: 'canectic-doorserver/1' }) + '\n');
				sock.on('message', function (data, isBinary) {
					if (isBinary) { seen.keys.push(Buffer.from(data).toString()); if (seen.keys.join('').includes('bye')) sock.close(); return; }
					var f = JSON.parse(data.toString());
					if (f.type === 'auth') {
						seen.auth = f;
						if (f.secret !== 'good') { sock.send(JSON.stringify({ type: 'auth_fail', reason: 'Login refused' }) + '\n\r\nGoodbye!\r\n'); sock.close(); return; }
						sock.send(JSON.stringify({ type: 'auth_ok', node: 2, doors: [{ slug: 'lord', name: 'LORD' }, { slug: 'bre', name: 'BRE' }] }) + '\n');
						if (f.list) { sock.close(); return; }
						if (f.door) { seen.launch = f.door; sock.send(JSON.stringify({ type: 'launch_ok', door: f.door }) + '\n'); sock.send(Buffer.from('SCREEN')); }
					} else if (f.type === 'launch') {
						seen.launch = f.door; sock.send(JSON.stringify({ type: 'launch_ok', door: f.door }) + '\n'); sock.send(Buffer.from('SCREEN'));
					}
				});
			});
		});
		afterEach(function (done) { for (var c of wss.clients) c.terminate(); wss.close(function () { done(); }); });

		var url = function () { return 'ws://127.0.0.1:' + port; };

		it('lists doors, and reports a refusal', async function () {
			var r = await listDoors({ url: url(), systemId: 'MYBBS', secret: 'good' });
			assert.deepStrictEqual(r.doors.map(d => d.slug), ['lord', 'bre']);
			var bad = await listDoors({ url: url(), systemId: 'MYBBS', secret: 'nope' });
			assert.strictEqual(bad.ok, false); assert.strictEqual(bad.reason, 'Login refused');
		});

		it('reports an unreachable server', async function () {
			var r = await listDoors({ url: 'ws://127.0.0.1:1', systemId: 'X', secret: 'y', timeoutMs: 2000 });
			assert.strictEqual(r.ok, false);
		});

		function fakeCall() {
			var out = [];
			var call = {
				nodenum: 4, term_width: 100, term_height: 30, term_encoding: 'UTF-8',
				user_record: { username: 'Bob', fullname: 'Bob Smith' },
				rawmode: false, rawtarget: null,
				cmds: { senddata: function (b) { out.push(Buffer.from(b)); }, resetcolors: function () {} }
			};
			return { call: call, text: function () { return Buffer.concat(out).toString('latin1'); } };
		}
		var remote = function (secret) { return { uuid: 'x', name: 'stub', title: 'Stub Board', url: url(), system_id: 'MYBBS', secret: secret || 'good' }; };

		it('sends the caller through the menu into a door and back', async function () {
			var f = fakeCall();
			var runner = new RemoteDoorRunner(f.call, remote(), '');
			var returned = false; runner.emitter.on('ModuleReturn', function () { returned = true; });
			runner.startStage();
			await wait(400);
			assert.deepStrictEqual(seen.auth.user, { name: 'Bob', real_name: 'Bob Smith' });
			assert.deepStrictEqual(seen.auth.term, { width: 100, height: 30, encoding: 'utf8', type: 'ansi' });
			assert.ok(f.text().includes(' 2) BRE'), f.text());
			f.call.rawtarget(Buffer.from('2\r'));
			await wait(300);
			assert.strictEqual(seen.launch, 'bre');
			assert.ok(f.text().includes('SCREEN'));
			f.call.rawtarget(Buffer.from('bye'));
			await wait(300);
			assert.deepStrictEqual(seen.keys, ['bye']);
			assert.ok(f.text().includes('Press any key'), 'the caller is told the door ended');
			f.call.rawtarget(Buffer.from(' '));
			assert.strictEqual(returned, true);
			assert.strictEqual(f.call.rawmode, false, 'raw mode is handed back');
		});

		it('goes straight to a door named in the menu entry', async function () {
			var f = fakeCall();
			var runner = new RemoteDoorRunner(f.call, remote(), 'lord');
			runner.startStage();
			await wait(400);
			assert.strictEqual(seen.auth.door, 'lord');
			assert.ok(f.text().includes('SCREEN'));
			runner.clearHandler();
		});

		it('tells the caller when the remote refuses, and returns on a key', async function () {
			var f = fakeCall();
			var runner = new RemoteDoorRunner(f.call, remote('nope'), '');
			var returned = false; runner.emitter.on('ModuleReturn', function () { returned = true; });
			runner.startStage();
			await wait(400);
			assert.ok(f.text().includes('refused the connection: Login refused'), f.text());
			assert.ok(!f.text().includes('Goodbye'), "the remote's goodbye text is not shown");
			f.call.rawtarget(Buffer.from('x'));
			assert.strictEqual(returned, true);
		});
	});
});
