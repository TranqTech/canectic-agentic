// tests/remoteDoors.test.js -- doors on other systems (#89): door providers
// of three kinds, Remote door entries, per-caller RLogin identities, the
// RLogin client (direct and through an SSH tunnel with a recorded host key)
// and the BBSLink client with its telnet layer.

import assert from 'assert';
import net from 'net';
import ssh2 from 'ssh2';
import { dbAvailable } from './helpers/dbAvailable.js';
import { validateRemote, mayUseRemote, minSecurityFor, settingsOf, PRESETS, rloginName } from '../src/models/doorserverRemotes.js';
import { handshakeFields, openRlogin, fingerprint } from '../src/utils/rloginClient.js';
import { authHeaders, createTelnet, escapeIac, openBbslink, md5 } from '../src/utils/bbslinkClient.js';
import { remoteDoorSlug } from '../src/models/doors.js';
import { RemoteDoorRunner } from '../src/handlers/remotedoorrunner.js';

var cfg = { getNumber: function (k, d) { return k === 'verified_security' ? 60 : d; } };
var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
function until(pred, ms) {
	var end = Date.now() + (ms || 3000);
	return new Promise(function (resolve, reject) {
		(function check() {
			if (pred()) return resolve();
			if (Date.now() > end) return reject(new Error('timed out waiting'));
			setTimeout(check, 20);
		})();
	});
}

function rlForm(extra) {
	return Object.assign({ name: 'dp', kind: 'rlogin', rl_host: 'dp.example', rl_port: '513', rl_username_template: '[{tag}]{alias}', rl_tag: 'XA',
		rl_password_mode: 'per_user', rl_terminal_template: '{door}', rl_menu_terminal: 'ansi' }, extra || {});
}

// A fake RLogin door server: records the handshake, acknowledges, then echoes.
function fakeRloginServer() {
	var seen = { handshake: null, input: [] };
	var server = net.createServer(function (sock) {
		var buf = Buffer.alloc(0), shook = false;
		sock.on('data', function (d) {
			if (shook) { seen.input.push(d.toString('latin1')); return; }
			buf = Buffer.concat([buf, d]);
			var parts = buf.toString('latin1').split('\0');
			if (parts.length >= 5) {
				shook = true;
				seen.handshake = { clientUser: parts[1], serverUser: parts[2], terminal: parts[3] };
				sock.write(Buffer.concat([Buffer.from([0]), Buffer.from([0xDB, 0x20]), Buffer.from('DOOR', 'latin1')]));
			}
		});
		sock.on('error', function () {});
	});
	return { server: server, seen: seen };
}

describe('doors on other systems (#89)', function () {
	this.timeout(15000);

	describe('door providers', function () {
		it('checks an RLogin provider and requires what its settings use', function () {
			var ok = validateRemote(rlForm(), { creating: true });
			assert.deepStrictEqual(ok.errors, []);
			var st = JSON.parse(ok.values.settings);
			assert.strictEqual(st.username_template, '[{tag}]{alias}');
			assert.strictEqual(ok.values.url, 'rlogin://dp.example:513');
			assert.ok(validateRemote(rlForm({ rl_tag: '' }), { creating: true }).errors.some(function (e) { return /tag/.test(e); }));
			assert.ok(validateRemote(rlForm({ rl_ssh: 'true' }), { creating: true }).errors.some(function (e) { return /SSH username/.test(e); }));
			assert.ok(validateRemote(rlForm({ rl_ssh: 'true', rl_ssh_user: 'u' }), { creating: true }).errors.some(function (e) { return /SSH password/.test(e); }));
			assert.ok(validateRemote(rlForm({ rl_terminal_template: 'x' }), { creating: true }).errors.some(function (e) { return /\{door\}/.test(e); }));
			assert.strictEqual(JSON.parse(validateRemote(rlForm({ rl_tag: '[XA]' }), { creating: true }).values.settings).tag, 'XA', 'brackets are the template\'s, not the tag\'s');
		});

		it('keeps stored secrets when a field is left blank on an update', function () {
			var current = { kind: 'rlogin', name: 'dp', secrets: { ssh_password: 'stored' } };
			var upd = validateRemote(rlForm({ rl_ssh: 'true', rl_ssh_user: 'u', rl_ssh_password: '', active: 'true' }), {}, current);
			assert.deepStrictEqual(upd.errors, []);
			assert.strictEqual(JSON.parse(upd.values.secrets).ssh_password, 'stored');
			var changed = validateRemote(rlForm({ rl_ssh: 'true', rl_ssh_user: 'u', rl_ssh_password: 'new', active: 'true' }), {}, current);
			assert.strictEqual(JSON.parse(changed.values.secrets).ssh_password, 'new');
		});

		it('checks a BBSLink provider', function () {
			var bad = validateRemote({ name: 'bl', kind: 'bbslink' }, { creating: true });
			assert.strictEqual(bad.errors.length, 3, bad.errors.join('; '));
			var ok = validateRemote({ name: 'bl', kind: 'bbslink', bl_system_code: 'SYS', bl_auth_code: 'a', bl_scheme_code: 's' }, { creating: true });
			assert.deepStrictEqual(ok.errors, []);
			assert.strictEqual(JSON.parse(ok.values.settings).host, 'games.bbslink.net');
		});

		it('has presets for DoorParty, BBSLink and Synchronet', function () {
			assert.strictEqual(PRESETS.doorparty.settings.ssh_port, 2022);
			assert.strictEqual(PRESETS.doorparty.settings.username_template, '[{tag}]{alias}');
			assert.strictEqual(PRESETS.synchronet.settings.terminal_template, 'xtrn={door}');
			assert.strictEqual(PRESETS.bbslink.kind, 'bbslink');
		});

		it('lets only a logged-in caller at the minimum security use a provider, and never a door-server session', function () {
			var remote = { name: 'dp', min_security: null };
			assert.strictEqual(minSecurityFor(remote, cfg), 60, 'blank is the verified level');
			assert.strictEqual(mayUseRemote({ user_record: { id: 1, security: 60 } }, remote, cfg).ok, true);
			assert.strictEqual(mayUseRemote({ user_record: { id: 1, security: 59 } }, remote, cfg).ok, false);
			assert.strictEqual(mayUseRemote({ user_record: null }, remote, cfg).ok, false, 'a caller who never logged in');
			assert.strictEqual(mayUseRemote({ doorsession: true, doorserver_session: true, user_record: { id: 1, security: 255 } }, remote, cfg).ok, false);
			assert.strictEqual(mayUseRemote({ doorsession: true, web_originated: true, user_record: { id: 1, security: 60 } }, remote, cfg).ok, true,
				'web Play is a door session too, and is this board\'s own caller');
			assert.strictEqual(mayUseRemote({ user_record: { id: 1, security: 10 } }, { name: 'dp', min_security: 10 }, cfg).ok, true);
		});

		it('names a remote door provider-code unless given a slug', function () {
			assert.strictEqual(remoteDoorSlug('doorparty', 'lord2'), 'doorparty-lord2');
			assert.strictEqual(remoteDoorSlug('dp', 'stackem!'), 'dp-stackem');
			assert.strictEqual(remoteDoorSlug('bl', ''), 'bl-menu');
		});
	});

	describe('RLogin', function () {
		var dp = settingsOf({ kind: 'rlogin', settings: PRESETS.doorparty.settings });
		dp.tag = 'XA';

		it('forms the DoorParty handshake: password, [TAG]alias, door code', function () {
			var f = handshakeFields(dp, { name: 'Bob', password: 'pw1' }, 'lord');
			assert.deepStrictEqual(f, { clientUser: 'pw1', serverUser: '[XA]Bob', terminal: 'lord' });
			assert.strictEqual(handshakeFields(dp, { name: 'Bob', password: 'pw1' }, '').terminal, 'ansi', 'no door: their menu');
			var sync = settingsOf({ kind: 'rlogin', settings: PRESETS.synchronet.settings });
			assert.strictEqual(handshakeFields(sync, { name: 'Bob', password: 'x' }, 'lord').terminal, 'xtrn=lord');
			assert.strictEqual(rloginName('Bo\x00b\x1b'), 'Bob');
		});

		it('speaks RLogin directly and passes the stream both ways', async function () {
			var f = fakeRloginServer();
			await new Promise(function (r) { f.server.listen(0, '127.0.0.1', r); });
			try {
				var st = Object.assign({}, dp, { ssh: false, host: '127.0.0.1', port: f.server.address().port });
				var s = await openRlogin({ uuid: 'u', name: 'dp' }, st, {}, { user: { id: 1, name: 'Bob' }, door: 'lord' },
					{ identityFor: async function () { return { name: 'Bob', password: 'pw1' }; } });
				var out = [], launched = null, closed = false;
				s.on('launch_ok', function (d) { launched = d; });
				s.on('data', function (b) { out.push(b); });
				s.on('close', function () { closed = true; });
				await until(function () { return Buffer.concat(out).toString('latin1').includes('DOOR'); });
				assert.deepStrictEqual(f.seen.handshake, { clientUser: 'pw1', serverUser: '[XA]Bob', terminal: 'lord' });
				assert.strictEqual(launched, 'lord');
				assert.strictEqual(Buffer.concat(out)[0], 0xDB, 'the \\0 acknowledgement is not passed on');
				assert.strictEqual(s.cp437, true);
				s.send(Buffer.from('hi'));
				await until(function () { return f.seen.input.join('') === 'hi'; });
				s.close();
				assert.strictEqual(closed, true);
			} finally { f.server.close(); }
		});

		it('tunnels through SSH, records the host key, and refuses a different one', async function () {
			var f = fakeRloginServer();
			await new Promise(function (r) { f.server.listen(0, '127.0.0.1', r); });
			var rlPort = f.server.address().port;
			var hostKey = ssh2.utils.generateKeyPairSync('ed25519');
			var sshSeen = { user: null, forward: null };
			var sshd = new ssh2.Server({ hostKeys: [hostKey.private] }, function (client) {
				client.on('authentication', function (ctx) {
					if (ctx.method === 'password' && ctx.username === 'bbsuser' && ctx.password === 'sshpw') { sshSeen.user = ctx.username; ctx.accept(); }
					else ctx.reject(['password']);
				});
				client.on('ready', function () {
					client.on('tcpip', function (accept, reject, info) {
						sshSeen.forward = info.destIP + ':' + info.destPort;
						var ch = accept();
						var up = net.connect(rlPort, '127.0.0.1');
						ch.pipe(up); up.pipe(ch);
						up.on('error', function () {}); ch.on('error', function () {});
					});
				});
				client.on('error', function () {});
			});
			await new Promise(function (r) { sshd.listen(0, '127.0.0.1', r); });
			try {
				var recorded = null;
				var remote = { uuid: 'u', name: 'dp', host_key: null };
				var st = Object.assign({}, dp, { ssh: true, ssh_host: '127.0.0.1', ssh_port: sshd.address().port, ssh_user: 'bbsuser', host: '127.0.0.1', port: rlPort });
				var deps = { identityFor: async function () { return { name: 'Bob', password: 'pw1' }; }, setHostKey: async function (uuid, fp) { recorded = fp; } };
				var s = await openRlogin(remote, st, { ssh_password: 'sshpw' }, { user: { id: 1, name: 'Bob' }, door: 'tw2002' }, deps);
				var out = [];
				s.on('data', function (b) { out.push(b); });
				await until(function () { return Buffer.concat(out).toString('latin1').includes('DOOR'); }, 8000);
				assert.strictEqual(sshSeen.user, 'bbsuser');
				assert.strictEqual(sshSeen.forward, '127.0.0.1:' + rlPort);
				assert.strictEqual(f.seen.handshake.terminal, 'tw2002');
				assert.ok(/^SHA256:/.test(recorded), 'the host key is recorded on first connect');
				s.close();

				// Same key: accepted. A different recorded key: refused, and said so.
				var errs = [];
				var s2 = await openRlogin({ uuid: 'u', name: 'dp', title: 'DoorParty', host_key: 'SHA256:somethingelse' }, st, { ssh_password: 'sshpw' },
					{ user: { id: 1, name: 'Bob' }, door: 'lord' }, deps);
				s2.on('error', function (e) { errs.push(e); });
				await until(function () { return errs.length; }, 8000);
				assert.match(errs[0], /different host key/);

				var badPw = [];
				var s3 = await openRlogin({ uuid: 'u', name: 'dp', host_key: recorded }, st, { ssh_password: 'wrong' }, { user: { id: 1, name: 'Bob' }, door: 'lord' }, deps);
				s3.on('error', function (e) { badPw.push(e); });
				await until(function () { return badPw.length; }, 8000);
				assert.match(badPw[0], /username or password was refused/);
			} finally { f.server.close(); sshd.close(); }
		});

		it('fingerprints a key the way OpenSSH prints it', function () {
			assert.ok(/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint(Buffer.from('key'))));
		});
	});

	describe('BBSLink', function () {
		it('signs the auth request with md5(code + token)', function () {
			var h = authHeaders({ system_code: 'SYS' }, { auth_code: 'AUTH', scheme_code: 'SCH' }, { userNumber: 42, token: '123', key: 'abcdef', door: 'LORD', rows: 25 });
			assert.strictEqual(h['X-Auth'], md5('AUTH123'));
			assert.strictEqual(h['X-Code'], md5('SCH123'));
			assert.strictEqual(h['X-User'], '42');
			assert.strictEqual(h['X-Door'], 'lord', 'door codes are sent in lower case');
			assert.strictEqual(h['X-Rows'], '25');
		});

		it('answers telnet negotiation and strips it from the output', function () {
			var replies = [];
			var t = createTelnet(function (b) { replies.push(Array.from(b)); }, { width: 100, height: 30 });
			var out = t.feed(Buffer.from([65, 255, 251, 1, 255, 253, 31, 255, 253, 24, 255, 250, 24, 1, 255, 240, 255, 253, 5, 66, 255, 255, 67]));
			assert.deepStrictEqual(Array.from(out), [65, 66, 255, 67], 'data only, with IAC IAC read as one 0xFF');
			assert.deepStrictEqual(replies[0], [255, 253, 1], 'agree to the server echoing');
			assert.deepStrictEqual(replies[1], [255, 251, 31]);
			assert.deepStrictEqual(replies[2], [255, 250, 31, 0, 100, 0, 30, 255, 240], 'window size');
			assert.deepStrictEqual(replies[3], [255, 251, 24]);
			assert.deepStrictEqual(replies[4], [255, 250, 24, 0, 65, 78, 83, 73, 255, 240], 'terminal type ANSI');
			assert.deepStrictEqual(replies[5], [255, 252, 5], 'refuse anything else');
			assert.deepStrictEqual(Array.from(escapeIac(Buffer.from([1, 255, 2]))), [1, 255, 255, 2]);
		});

		it('gets a token, authenticates, then telnets', async function () {
			var got = [];
			var telnetd = net.createServer(function (sock) {
				sock.write(Buffer.from([255, 251, 1, 0xB0, 0x41]));
				sock.on('data', function (d) { got.push(Array.from(d)); });
				sock.on('error', function () {});
			});
			await new Promise(function (r) { telnetd.listen(0, '127.0.0.1', r); });
			try {
				var calls = [];
				var fetch = async function (url, init) {
					calls.push({ url: url, headers: (init && init.headers) || null });
					return { status: 200, text: async function () { return url.includes('token.php') ? '12713799933771\n' : 'complete'; } };
				};
				var s = await openBbslink({ name: 'bl' }, { system_code: 'SYS', http_base: 'http://bbslink.test', host: '127.0.0.1', telnet_port: telnetd.address().port },
					{ auth_code: 'A', scheme_code: 'S' }, { user: { id: 7, name: 'Bob' }, door: 'lord', term: { width: 80, height: 24 } }, { fetch: fetch });
				var out = [];
				s.on('data', function (b) { out.push(b); });
				await until(function () { return Buffer.concat(out).length >= 2; });
				assert.match(calls[0].url, /^http:\/\/bbslink\.test\/token\.php\?key=[A-Za-z0-9]{6}$/);
				assert.strictEqual(calls[1].url.split('key=')[1], calls[0].url.split('key=')[1], 'the same xkey both times');
				assert.strictEqual(calls[1].headers['X-Auth'], md5('A12713799933771'));
				assert.strictEqual(calls[1].headers['X-User'], '7');
				assert.deepStrictEqual(Array.from(Buffer.concat(out)), [0xB0, 0x41]);
				await until(function () { return got.length; });
				assert.deepStrictEqual(got[0], [255, 253, 1]);
				s.close();
			} finally { telnetd.close(); }
		});

		it('shows the reason BBSLink gives for a refusal', async function () {
			var fetch = async function (url) { return { status: 500, text: async function () { return url.includes('token.php') ? '123' : 'Unauthorised (Error 7)'; } }; };
			var s = await openBbslink({ name: 'bl' }, { system_code: 'SYS', http_base: 'http://x', host: '127.0.0.1', telnet_port: 1 }, {}, { user: { id: 7 }, door: 'lord' }, { fetch: fetch });
			var errs = [];
			s.on('error', function (e) { errs.push(e); });
			await until(function () { return errs.length; });
			assert.strictEqual(errs[0], 'BBSLink refused: Unauthorised (Error 7)');
		});
	});

	describe('the runner with an RLogin or BBSLink session', function () {
		function fakeCall(encoding) {
			var out = [];
			return {
				out: out,
				call: {
					nodenum: 2, term_width: 80, term_height: 24, term_encoding: encoding,
					user_record: { id: 5, username: 'Bob', fullname: 'Bob Smith' }, rawmode: false, rawtarget: null,
					cmds: { senddata: function (b) { out.push(Buffer.isBuffer(b) ? b.toString('utf8') : String(b)); }, resetcolors: function () {} }
				}
			};
		}
		function stubSession() {
			var ev = new (require_events())();
			ev.kind = 'rlogin'; ev.cp437 = true; ev.sent = [];
			ev.send = function (b) { ev.sent.push(b.toString()); }; ev.launch = function () {}; ev.close = function () { ev.emit('close'); };
			return ev;
		}
		var EE = null;
		function require_events() { return EE; }
		before(async function () { EE = (await import('events')).EventEmitter; });

		it('converts CP437 output for a UTF-8 caller and passes keys through', async function () {
			var f = fakeCall('UTF-8');
			var sess = stubSession();
			var seenOpts = null;
			var runner = new RemoteDoorRunner(f.call, { uuid: 'x', name: 'dp', title: 'DoorParty', kind: 'rlogin' }, 'lord',
				{ open: function (remote, o) { seenOpts = o; return sess; } });
			await runner.startStage();
			sess.emit('launch_ok', 'lord');
			sess.emit('data', Buffer.from([0xDB, 0x41]));
			await wait(50);
			assert.ok(f.out.join('').includes('█A'), 'CP437 0xDB is the full block for a UTF-8 caller: ' + JSON.stringify(f.out));
			assert.strictEqual(seenOpts.door, 'lord');
			assert.strictEqual(seenOpts.user.id, 5);
			f.call.rawtarget(Buffer.from('x'));
			assert.deepStrictEqual(sess.sent, ['x']);
			runner.clearHandler();
		});

		it('passes CP437 output unchanged to a CP437 caller', async function () {
			var f = fakeCall('CP437');
			var sess = stubSession();
			var raw = [];
			f.call.cmds.senddata = function (b) { raw.push(Buffer.from(b)); };
			var runner = new RemoteDoorRunner(f.call, { uuid: 'x', name: 'dp', kind: 'rlogin' }, 'lord', { open: function () { return sess; } });
			await runner.startStage();
			sess.emit('launch_ok', 'lord');
			sess.emit('data', Buffer.from([0xDB]));
			assert.ok(raw.some(function (b) { return b.length === 1 && b[0] === 0xDB; }));
			runner.clearHandler();
		});
	});

	describe('against the database', function () {
		var available = false, pg, remotes, doors;
		before(async function () {
			available = await dbAvailable();
			if (!available) return;
			pg = await import('../src/middleware/db/postgres.js');
			remotes = await import('../src/models/doorserverRemotes.js');
			doors = await import('../src/models/doors.js');
		});
		async function cleanup() {
			await pg.write("DELETE FROM door_remote_identities WHERE remote_id IN (SELECT id FROM doorserver_remotes WHERE name LIKE 'zz89%')");
			await pg.write("DELETE FROM doors WHERE slug LIKE 'zz89%'");
			await pg.write("DELETE FROM doorserver_remotes WHERE name LIKE 'zz89%'");
		}
		beforeEach(async function () { if (!available) return this.skip(); await cleanup(); });
		after(async function () { if (available) await cleanup(); });

		it('gives each caller one password on an RLogin provider, and keeps it', async function () {
			var r = await remotes.createRemote(rlForm({ name: 'zz89dp' }));
			assert.ok(r.status, r.errors.join());
			var a = await remotes.identityFor(r.remote, { id: 987001, name: 'Bob' });
			var b = await remotes.identityFor(r.remote, { id: 987001, name: 'Robert' });
			var c = await remotes.identityFor(r.remote, { id: 987002, name: 'Carol' });
			assert.strictEqual(a.created, true);
			assert.strictEqual(b.created, false);
			assert.strictEqual(a.password, b.password, 'the same password every time');
			assert.notStrictEqual(a.password, c.password);
			assert.strictEqual(b.name, 'Robert', 'the current name by default');
			await remotes.updateRemote(r.remote.uuid, rlForm({ rl_keep_first_name: 'true', active: 'true' }));
			var kept = await remotes.identityFor(await remotes.getByUuid(r.remote.uuid), { id: 987001, name: 'Robert' });
			assert.strictEqual(kept.name, 'Bob', 'keep_first_name sends the first name used');
		});

		it('sends the sysop\'s password when every caller shares one', async function () {
			var r = await remotes.createRemote(rlForm({ name: 'zz89fx', rl_password_mode: 'fixed', rl_password: 'shared' }));
			assert.ok(r.status, r.errors.join());
			assert.strictEqual((await remotes.identityFor(r.remote, { id: 987001, name: 'Bob' })).password, 'shared');
		});

		it('runs a Remote door entry through CallManager.launchDoor, and refuses a caller below the minimum', async function () {
			var f = fakeRloginServer();
			await new Promise(function (r) { f.server.listen(0, '127.0.0.1', r); });
			try {
				var { IncomingCall } = await import('../src/managers/callmanager.js');
				var r = await remotes.createRemote(rlForm({ name: 'zz89live', rl_host: '127.0.0.1', rl_port: String(f.server.address().port), min_security: '50' }));
				assert.ok(r.status, r.errors.join());
				var d = await doors.createRemoteDoor({ provider: 'zz89live', code: 'lord', name: 'LORD there' });
				assert.ok(d.status, (d.errormessages || []).join());
				var fake = function (security) {
					var out = [], returned = 0;
					var self = {
						loggingId: 'test', nodenum: 3, term_width: 80, term_height: 24, term_encoding: 'CP437',
						user_record: { id: 987003, username: 'Dora', fullname: 'Dora D', security: security },
						rawmode: false, rawtarget: null, currentHandler: null,
						cmds: { senddata: function (b) { out.push(Buffer.from(b).toString('latin1')); }, resetcolors: function () {} },
						updateNodeStatus: function () {}, hangUpCall: function () {},
						_doorReturn: function () { returned++; },
						_waitForKeyThen: function (cb) { self.waited = cb; }
					};
					Object.setPrototypeOf(self, IncomingCall.prototype);
					return { self: self, text: function () { return out.join(''); }, returned: function () { return returned; } };
				};
				var ok = fake(60);
				await ok.self.launchDoor('zz89live-lord', true);
				await until(function () { return f.seen.handshake && ok.text().includes('DOOR'); });
				assert.deepStrictEqual(f.seen.handshake.serverUser, '[XA]Dora');
				assert.strictEqual(f.seen.handshake.terminal, 'lord');
				assert.ok(ok.self.currentHandler, 'the remote door runner is the call\'s handler');
				ok.self.currentHandler.clearHandler();

				var low = fake(10);
				await low.self.launchDoor('zz89live-lord', true);
				assert.match(low.text(), /need security 50/);
				low.self.waited();
				assert.strictEqual(low.returned(), 1, 'back to the menu on a key');
			} finally { f.server.close(); }
		});

		it('adds door entries for a provider', async function () {
			var r = await remotes.createRemote(rlForm({ name: 'zz89dq' }));
			var d1 = await doors.createRemoteDoor({ provider: 'zz89dq', code: 'lord', name: 'LORD' });
			var d2 = await doors.createRemoteDoor({ provider: 'zz89dq', code: '', name: '' });
			assert.ok(d1.status && d2.status, (d1.errormessages || []).concat(d2.errormessages || []).join());
			var list = await doors.getRemoteDoors('zz89dq');
			assert.deepStrictEqual(list.map(function (d) { return d.slug; }).sort(), ['zz89dq-lord', 'zz89dq-menu']);
			var cfgd = await doors.getDoorConfig('zz89dq-lord');
			assert.strictEqual(cfgd.launchType, 'Remote');
			assert.strictEqual(cfgd.remoteProvider, 'zz89dq');
			assert.strictEqual(cfgd.remoteDoor, 'lord');
			assert.strictEqual(cfgd.doorserverAvailable, false);
			var noProvider = await doors.createDoor({ slug: 'zz89-bad', name: 'x', launch_type: 'Remote' });
			assert.strictEqual(noProvider.status, false);
			assert.ok(r.status);
		});
	});
});
