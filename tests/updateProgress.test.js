// tests/updateProgress.test.js: the update progress page and the updater's
// listener that serves it while the BBS is stopped.
//
// The listener takes over the gateway's web port for the stretch between the
// stop and the start, so it answers through the same reverse proxy. It shows
// a sysop the progress and everybody else the maintenance page, knowing which
// is which only from the hashes the gateway wrote when the update was started.
// The properties that fail quietly: a half-received request holding the close
// open so the updater never gets to start the BBS, a bind failure failing the
// update, and anything in a log line or error reaching the page unescaped.
//
// Run: npx mocha --no-config --exit tests/updateProgress.test.js

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import * as net from 'net';
import * as up from '../src/maintenance/updateProgress.js';
import { route, startUpdateStatusServer } from '../src/maintenance/updateStatusServer.js';
import * as sysop from '../src/maintenance/sysopSessions.js';
import { spawnAsync, runCommandAsync } from '../src/maintenance/updateCommands.js';

function runState(over) {
	return Object.assign({
		runId: 'run-1', status: 'running', from: '0.9.7a', to: '0.9.8a',
		startedAt: new Date().toISOString(), finishedAt: null, error: null, warnings: [],
		phases: [
			{ name: 'preflight', status: 'done', intended: true, detail: '12 files verified' },
			{ name: 'backup', status: 'done', intended: true },
			{ name: 'stop', status: 'done', intended: true },
			{ name: 'files', status: 'running', intended: true },
			{ name: 'env', status: 'pending', intended: false },
			{ name: 'verify', status: 'pending', intended: true }
		]
	}, over || {});
}

function get(port, p, headers, method) {
	return new Promise(function (resolve, reject) {
		var req = http.request({ host: '127.0.0.1', port: port, path: p, method: method || 'GET', headers: headers || {} }, function (res) {
			var body = '';
			res.on('data', function (d) { body += d; });
			res.on('end', function () { resolve({ status: res.statusCode, headers: res.headers, body: body }); });
		});
		req.on('error', reject);
		req.end();
	});
}

describe('update progress page', function () {

	it('parses cookies the way a browser sends them', function () {
		assert.deepStrictEqual(up.parseCookies('a=1; sessionid=abc%20def; b=2'), { a: '1', sessionid: 'abc def', b: '2' });
		assert.deepStrictEqual(up.parseCookies(''), {});
		assert.deepStrictEqual(up.parseCookies(undefined), {});
	});

	it('hashes a session id without keeping it', function () {
		var h = up.hashSessionId('secret-session');
		assert.strictEqual(h.length, 64);
		assert.ok(!h.includes('secret'));
		assert.strictEqual(h, up.hashSessionId('secret-session'));
	});

	it('shows the phases the run intends, and which one is running', function () {
		var s = up.progressSnapshot(runState(), { servedBy: 'updater' });
		assert.deepStrictEqual(s.phases.map(function (p) { return p.name; }), ['preflight', 'backup', 'stop', 'files', 'verify'],
			'a phase this run never intended is not shown as pending');
		assert.strictEqual(s.current, 'files');
		assert.strictEqual(s.phases[3].label, 'Writing the new files');
	});

	it('says so when no update has run', function () {
		var s = up.progressSnapshot(null, {});
		assert.strictEqual(s.status, 'none');
		assert.ok(/No update has run/.test(up.renderProgressBody(s)));
	});

	it('escapes whatever a log line or an error says', function () {
		var s = up.progressSnapshot(runState({ status: 'failed', error: '<img src=x onerror=alert(1)>' }),
			{ log: ['npm WARN <script>bad()</script>'] });
		var html = up.renderProgressPage(s);
		assert.ok(!/<img src=x/.test(html), 'an error string must not become markup');
		assert.ok(!/<script>bad/.test(html), 'a log line must not become markup');
		assert.ok(html.includes('&lt;script&gt;bad()'));
	});

	it('tells the sysop the board is left closed when the update failed', function () {
		var html = up.renderProgressBody(up.progressSnapshot(runState({ status: 'failed', error: 'npm install exited 1' })));
		assert.ok(/The update failed: npm install exited 1/.test(html));
		assert.ok(/left closed for maintenance/.test(html));
		assert.ok(html.includes('/admin/maintenance'));
	});

	it('says who is serving the page, so a sysop knows the BBS is stopped', function () {
		assert.ok(/served by the updater/.test(up.renderProgressBody(up.progressSnapshot(runState(), { servedBy: 'updater' }))));
		assert.ok(/served by the BBS/.test(up.renderProgressBody(up.progressSnapshot(runState(), { servedBy: 'gateway' }))));
	});

	it('marks the page so its own polling knows when to stop', function () {
		var html = up.renderProgressPage(up.progressSnapshot(runState({ status: 'complete' }), { servedBy: 'gateway' }));
		assert.ok(/id="update-progress" data-status="complete" data-served="gateway"/.test(html), html.substring(0, 300));
		assert.ok(html.includes('fetch("/admin/update/progress"'), 'it polls the page that both servers answer');
	});

	it('gives visitors the maintenance page, refreshing itself', function () {
		var html = up.renderMaintenancePage({ boardName: 'Test BBS', reason: 'Updating to 0.9.8a' });
		assert.ok(html.includes('Test BBS'));
		assert.ok(html.includes('closed for maintenance'));
		assert.ok(html.includes('Updating to 0.9.8a'));
		assert.ok(/http-equiv="refresh" content="60"/.test(html));
		assert.ok(html.includes('/css/custom.css'), 'the sysop branding carries over');
	});

	it('reads the tail of a log file, and nothing when there is none', function () {
		var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-uprog-'));
		try {
			var f = path.join(dir, 'x.log');
			fs.writeFileSync(f, Array.from({ length: 100 }, function (_, i) { return 'line ' + i; }).join('\n') + '\n');
			var t = up.tailFile(f, 5);
			assert.deepStrictEqual(t, ['line 95', 'line 96', 'line 97', 'line 98', 'line 99']);
			assert.deepStrictEqual(up.tailFile(path.join(dir, 'missing.log'), 5), []);
			assert.deepStrictEqual(up.tailFile(null, 5), []);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('the recorded sysop sessions', function () {
	var root;
	beforeEach(function () { root = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-sysop-')); });
	afterEach(function () { fs.rmSync(root, { recursive: true, force: true }); });

	it('round-trips for the run they were written for', function () {
		sysop.writeSysopHashes(root, ['a', 'b'], 'run-1');
		assert.deepStrictEqual(Array.from(sysop.readSysopHashes(root, 'run-1')).sort(), ['a', 'b']);
	});

	it('is never trusted for a different run', function () {
		sysop.writeSysopHashes(root, ['a'], 'run-1');
		assert.strictEqual(sysop.readSysopHashes(root, 'run-2').size, 0, 'a leftover must not let an old browser in');
	});

	it('is readable only by the owner', function () {
		sysop.writeSysopHashes(root, ['a'], 'run-1');
		var mode = fs.statSync(sysop.sessionsPath(root)).mode & 0o777;
		assert.strictEqual(mode, 0o600, mode.toString(8));
	});

	it('reads as empty when absent or cleared', function () {
		assert.strictEqual(sysop.readSysopHashes(root, 'run-1').size, 0);
		sysop.writeSysopHashes(root, ['a'], 'run-1');
		sysop.clearSysopHashes(root);
		assert.strictEqual(sysop.readSysopHashes(root, 'run-1').size, 0);
	});
});

describe('the updater listener', function () {
	var root, handle, state;
	var SYSOP_ID = 'sysop-session-id';

	function start(over) {
		return startUpdateStatusServer(Object.assign({
			port: 0, host: '127.0.0.1', root: root,
			sysopHashes: new Set([up.hashSessionId(SYSOP_ID)]),
			getState: function () { return state; },
			getLog: function () { return ['$ npm install --omit=dev', '  added 3 packages']; },
			info: { boardName: 'Test BBS', reason: 'Updating to 0.9.8a' }
		}, over || {}));
	}

	beforeEach(async function () {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-ulisten-'));
		fs.mkdirSync(path.join(root, 'public', 'css'), { recursive: true });
		fs.writeFileSync(path.join(root, 'public', 'css', 'custom.css'), 'body { --brand: teal; }');
		state = runState();
		handle = await start();
	});
	afterEach(async function () {
		if (handle) await handle.close();
		fs.rmSync(root, { recursive: true, force: true });
	});

	it('routes by who is asking', function () {
		assert.strictEqual(route({ path: '/', isSysop: true }), 'progress');
		assert.strictEqual(route({ path: '/messages', isSysop: false }), 'maintenance');
		assert.strictEqual(route({ path: '/admin/update/progress.json', isSysop: false }), 'forbidden');
		assert.strictEqual(route({ path: '/css/custom.css', isSysop: false }), 'css');
	});

	it('shows a sysop the progress, on any path', async function () {
		for (var p of ['/admin/update/progress', '/admin/update', '/messages']) {
			var r = await get(handle.port, p, { Cookie: 'sessionid=' + SYSOP_ID });
			assert.strictEqual(r.status, 200, p);
			assert.ok(r.body.includes('Updating to 0.9.8a'), p);
			assert.ok(r.body.includes('data-served="updater"'), p);
			assert.ok(r.body.includes('Writing the new files'), p);
			assert.ok(r.body.includes('added 3 packages'), 'the log tail is on the page');
		}
	});

	it('follows the run as it moves on', async function () {
		state = runState({ phases: runState().phases.map(function (p) {
			return Object.assign({}, p, { status: p.name === 'verify' ? 'running' : (p.intended ? 'done' : 'pending') });
		}) });
		var r = await get(handle.port, '/admin/update/progress.json', { Cookie: 'sessionid=' + SYSOP_ID });
		assert.strictEqual(JSON.parse(r.body).current, 'verify');
	});

	it('shows everybody else the maintenance page as a temporary outage', async function () {
		var r = await get(handle.port, '/');
		assert.strictEqual(r.status, 503);
		assert.strictEqual(r.headers['retry-after'], '300');
		assert.ok(r.body.includes('closed for maintenance'));
		assert.ok(!r.body.includes('Writing the new files'), 'a visitor learns nothing about the update');
	});

	it('does not accept a cookie that is not a recorded sysop session', async function () {
		var r = await get(handle.port, '/', { Cookie: 'sessionid=someone-else' });
		assert.strictEqual(r.status, 503);
		var j = await get(handle.port, '/admin/update/progress.json', { Cookie: 'sessionid=someone-else' });
		assert.strictEqual(j.status, 403);
	});

	it('serves the sysop\'s own stylesheet to both pages', async function () {
		var r = await get(handle.port, '/css/custom.css');
		assert.strictEqual(r.status, 200);
		assert.ok(r.body.includes('--brand: teal'));
	});

	it('answers HEAD without a body', async function () {
		var r = await get(handle.port, '/', {}, 'HEAD');
		assert.strictEqual(r.status, 503);
		assert.strictEqual(r.body, '');
	});

	it('refuses a WebSocket upgrade', async function () {
		var reply = await new Promise(function (resolve) {
			var s = net.connect(handle.port, '127.0.0.1', function () {
				s.write('GET /ws/presence HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
					'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
			});
			var got = '';
			s.on('data', function (d) { got += d; });
			s.on('close', function () { resolve(got); });
		});
		assert.ok(/^HTTP\/1\.1 503/.test(reply), reply);
	});

	it('gives the port back promptly even with a request only half received', async function () {
		// A slow client, or a proxy that has sent part of a request. Node's
		// server.close() drops idle connections by itself, but it waits for one
		// that is mid-request, up to the header timeout (a minute by default).
		// The updater awaits the close before starting the BBS, so without
		// tearing these down it would sit there with the board down.
		var idle = net.connect(handle.port, '127.0.0.1');
		await new Promise(function (resolve) { idle.on('connect', resolve); });
		idle.write('GET /admin/update/progress HTTP/1.1\r\nHost: x\r\n');
		await new Promise(function (resolve) { setTimeout(resolve, 50); });
		var port = handle.port;
		var closed = handle.close();
		handle = null;
		var winner = await Promise.race([
			closed.then(function () { return 'closed'; }),
			new Promise(function (resolve) { setTimeout(function () { resolve('hung'); }, 1500); })
		]);
		idle.destroy();
		assert.strictEqual(winner, 'closed', 'close() must not wait on a connection that will never finish');
		// And the gateway can take the port straight back.
		var s = http.createServer();
		await new Promise(function (resolve, reject) { s.once('error', reject); s.listen(port, '127.0.0.1', resolve); });
		await new Promise(function (resolve) { s.close(resolve); });
	});

	it('waits for the port if the gateway has not quite let go', async function () {
		await handle.close();
		var blocker = http.createServer();
		await new Promise(function (resolve) { blocker.listen(0, '127.0.0.1', resolve); });
		var port = blocker.address().port;
		setTimeout(function () { blocker.close(); }, 150);
		handle = await start({ port: port, attempts: 20, retryMs: 50 });
		assert.ok(handle, 'it should have bound once the port was free');
		assert.strictEqual(handle.port, port);
	});

	it('gives up without failing when the port stays taken', async function () {
		await handle.close();
		var blocker = http.createServer();
		await new Promise(function (resolve) { blocker.listen(0, '127.0.0.1', resolve); });
		var said = [];
		handle = await start({ port: blocker.address().port, attempts: 2, retryMs: 20,
			log: function (m) { said.push(m); } });
		await new Promise(function (resolve) { blocker.close(resolve); });
		assert.strictEqual(handle, null);
		assert.ok(said.some(function (m) { return /carries on without it/.test(m); }), said.join('\n'));
	});
});

describe('spawnAsync', function () {

	it('streams output lines to the log and resolves with it', async function () {
		var lines = [];
		var out = await spawnAsync(process.execPath, ['-e', 'console.log("one"); console.error("two")'],
			{ log: function (l) { lines.push(l); } });
		assert.ok(out.includes('one') && out.includes('two'));
		assert.deepStrictEqual(lines.map(function (l) { return l.trim(); }).sort(), ['one', 'two']);
	});

	it('rejects on a non-zero exit', async function () {
		await assert.rejects(spawnAsync(process.execPath, ['-e', 'process.exit(3)'], { label: 'thing' }), /thing exited 3/);
	});

	it('rejects and kills the child on the timeout', async function () {
		await assert.rejects(spawnAsync(process.execPath, ['-e', 'setTimeout(function(){}, 60000)'],
			{ timeoutMs: 200, label: 'slow' }), /slow timed out/);
	});

	it('does not block the event loop while the child runs', async function () {
		// The whole reason it exists: the progress page is served from this loop.
		var ticks = 0;
		var t = setInterval(function () { ticks++; }, 20);
		await spawnAsync(process.execPath, ['-e', 'setTimeout(function(){}, 300)']);
		clearInterval(t);
		assert.ok(ticks >= 5, 'the loop should have kept turning, got ' + ticks + ' ticks');
	});

	it('runs a shell command line for runCommandAsync', async function () {
		var said = [];
		var out = await runCommandAsync('echo hello && echo there', os.tmpdir(), function (l) { said.push(l); });
		assert.ok(/hello[\s\S]*there/.test(out));
		assert.strictEqual(said[0], '$ echo hello && echo there');
	});
});

describe('recording sysop sessions from the gateway', function () {
	// Needs Redis: this is the gateway side, which reads real sessions. The
	// updater side only ever reads the file this writes.
	var store = null, web = null, redisAvailable = null, have = false, root = null;
	var SYSOP_SID = 'zz-maint-sysop-' + process.pid;
	var USER_SID = 'zz-maint-user-' + process.pid;

	before(async function () {
		this.timeout(12000);
		try {
			redisAvailable = (await import('./helpers/redisAvailable.js')).redisAvailable;
			have = await redisAvailable();
			if (!have) return;
			store = await import('../src/middleware/db/sessionstore.js');
			web = await import('../src/middleware/maintenanceWeb.js');
			root = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-recsys-'));
			await store.sessionStore(SYSOP_SID, { id: '1', username: 'zzsysop', security: '255',
				permissionflags: JSON.stringify(['Sysop']) }, 600);
			await store.sessionStore(USER_SID, { id: '2', username: 'zzuser', security: '50',
				permissionflags: JSON.stringify([]) }, 600);
		} catch (_) { have = false; }
	});
	beforeEach(function () { if (!have) this.skip(); });
	after(async function () {
		if (store) {
			await store.sessionDestroy(SYSOP_SID).catch(function () {});
			await store.sessionDestroy(USER_SID).catch(function () {});
		}
		if (root) fs.rmSync(root, { recursive: true, force: true });
	});

	it('writes the hash of every sysop session and no other', async function () {
		await web.recordSysopSessions(root, 'run-x');
		var hashes = sysop.readSysopHashes(root, 'run-x');
		assert.ok(hashes.has(up.hashSessionId(SYSOP_SID)), 'the sysop session must be recognised');
		assert.ok(!hashes.has(up.hashSessionId(USER_SID)), 'an ordinary user must not be');
		var raw = fs.readFileSync(sysop.sessionsPath(root), 'utf8');
		assert.ok(!raw.includes(SYSOP_SID), 'the file holds hashes, never a session id');
	});
});
