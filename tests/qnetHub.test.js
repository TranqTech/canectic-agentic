// tests/qnetHub.test.js — QWK networking over HTTP, hub and node.
//
// Before this, a Canectic hub had no network transport at all: a node could
// only swap packets through a shared directory, and nothing ever called
// buildQwkForNode(), so the hub never produced a packet for a node over any
// transport. The hub now answers at /api/v1/qnet (src/routes/api/qnet.js) and
// the `http` QWK transport is the node side. A packet's high-water marks are
// committed only when the node acknowledges it; they used to advance when the
// packet was built, so a failed download lost every message in it.
//
// Run: npx mocha --no-config --exit tests/qnetHub.test.js

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseBasic, matchNode, looksLikeZip } from '../src/utils/qnetAuth.js';
import { HttpTransport, hubBaseUrl, makeTransport } from '../src/models/qwkTransport.js';
import { hwmFor } from '../src/models/qwkPacketBuilder.js';
import { classifyTransfer } from '../src/utils/transferFormat.js';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function basic(u, p) { return 'Basic ' + Buffer.from(u + ':' + p).toString('base64'); }

describe('hub: who a node is', function () {
	var HUB = { active: true, connection_data: { transport: 'hub', remote_qwk_id: 'UNDRMINE', password: 's3cret' } };

	it('reads HTTP Basic credentials', function () {
		assert.deepStrictEqual(parseBasic(basic('UNDRMINE', 'a:b')), { user: 'UNDRMINE', pass: 'a:b' });
		assert.strictEqual(parseBasic('Bearer x'), null);
		assert.strictEqual(parseBasic(''), null);
		assert.strictEqual(parseBasic('Basic ' + Buffer.from('nocolon').toString('base64')), null);
	});

	it('opens the hub connection for its QWK ID and password, any case of ID', function () {
		assert.strictEqual(matchNode({ user: 'undrmine', pass: 's3cret' }, [HUB]), HUB);
		assert.strictEqual(matchNode({ user: 'UNDRMINE', pass: 'wrong' }, [HUB]), null);
		assert.strictEqual(matchNode({ user: 'OTHER', pass: 's3cret' }, [HUB]), null);
	});

	it('never opens a connection with no password, one inactive, or one not on the hub transport', function () {
		var noPw = { active: true, connection_data: { transport: 'hub', remote_qwk_id: 'UNDRMINE', password: '' } };
		assert.strictEqual(matchNode({ user: 'UNDRMINE', pass: '' }, [noPw]), null, 'the QWK ID is printed in every packet');
		assert.strictEqual(matchNode({ user: 'UNDRMINE', pass: 's3cret' }, [Object.assign({}, HUB, { active: false })]), null);
		var client = { active: true, connection_data: { transport: 'ftp', remote_qwk_id: 'UNDRMINE', password: 's3cret' } };
		assert.strictEqual(matchNode({ user: 'UNDRMINE', pass: 's3cret' }, [client]), null);
	});

	it('only takes a ZIP as a packet', function () {
		assert.strictEqual(looksLikeZip(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0])), true);
		assert.strictEqual(looksLikeZip(Buffer.from('hello world')), false);
		assert.strictEqual(looksLikeZip(null), false);
	});

	it('logs a bad login in the form the shipped fail2ban filter matches', function () {
		var src = read('src/routes/api/qnet.js');
		var filter = read('examples/fail2ban/filter.d/canectic-auth.conf');
		assert.match(filter, /Failed login for/);
		// The text itself is src/utils/authFailLog.js since #83, checked
		// against this filter in tests/authFailLog.test.js.
		assert.match(src, /logAuthFail\('failed', 'QWK node ' \+ creds\.user, clientIp\(req\), 'QWK HTTP'\)/);
	});
});

describe('hub: what a packet commits', function () {
	it('is the highest message per subscription, skipped ones included', function () {
		assert.deepStrictEqual(hwmFor([
			{ pas_id: 1, msgId: 10 }, { pas_id: 1, msgId: 12, skip: true }, { pas_id: 2, msgId: 5 }
		]), { 1: 12, 2: 5 });
		assert.deepStrictEqual(hwmFor([]), {});
	});

	it('compares ids as numbers, since postgres returns them as strings', function () {
		// Found live 2026-09-25: a 10-message packet committed 9, and the next
		// packet delivered message 10 again.
		var items = [];
		for (var i = 1; i <= 10; i++) items.push({ pas_id: '15', msgId: String(i) });
		assert.deepStrictEqual(hwmFor(items), { 15: 10 });
	});

	it('commits on acknowledgement, not when the packet is built', function () {
		var src = read('src/models/qwkPacketBuilder.js');
		var build = src.slice(src.indexOf('async function buildQwkForNode'), src.indexOf('function pendingPath'));
		var tail = build.slice(build.indexOf('// Assemble packet'));
		assert.doesNotMatch(tail, /advanceHwmForItems|markSent/, 'buildQwkForNode commits after assembling');
		var commit = src.slice(src.indexOf('async function commitNodePacket'));
		assert.match(commit, /pending\.packetId !== packetId/);
		assert.match(commit, /advanceHwmForItems/);
		assert.match(commit, /markSent/);
	});

	it('is mounted, and the hub imports every waiting REP, not just the first', function () {
		assert.match(read('src/routes/api.js'), /registerQnetRoutes\(router\)/);
		for (var rel of ['bin/worker.js', 'src/queues/embedded.js']) {
			var src = read(rel);
			var job = src.slice(src.indexOf("case 'qwk:hub:inbound'"));
			assert.match(job.slice(0, 800), /pullHubReps\(/, rel);
		}
	});
});

describe('node: the http transport', function () {
	var dir;
	beforeEach(function () { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qnet-')); });
	afterEach(function () { fs.rmSync(dir, { recursive: true, force: true }); });

	// A fake fetch that answers from a table of [method path] -> response.
	function fakeFetch(routes, calls) {
		return async function (url, init) {
			var key = init.method + ' ' + new URL(url).pathname;
			calls.push({ key: key, auth: init.headers.Authorization, body: init.body });
			var r = routes[key];
			if (r instanceof Error) throw r;
			if (!r) return new Response('nope', { status: 404 });
			return typeof r === 'function' ? r() : r;
		};
	}
	var CD = { transport: 'http', host: 'hub.example', username: 'NODE', password: 'pw' };

	it('is what makeTransport gives for http', function () {
		assert.ok(makeTransport({ transport: 'http' }) instanceof HttpTransport);
		assert.strictEqual(hubBaseUrl('hub.example/'), 'https://hub.example');
		assert.strictEqual(hubBaseUrl('http://10.0.0.5:8080'), 'http://10.0.0.5:8080');
	});

	it('logs in with its QWK ID, and a refusal reads as an authentication failure', async function () {
		var calls = [];
		var t = new HttpTransport({ fetch: fakeFetch({ 'GET /api/v1/qnet/hello': new Response('{}', { status: 401 }) }, calls) });
		await assert.rejects(t.connect(CD), function (err) {
			assert.strictEqual(classifyTransfer({ status: false, stage: 'connect', errormessages: [err.message] }, 'pull'), 'auth_failed');
			return true;
		});
		assert.strictEqual(calls[0].auth, basic('NODE', 'pw'));
	});

	it('says what a network failure was, so the log can tell a timeout from a refusal', async function () {
		var refused = new TypeError('fetch failed'); refused.cause = { code: 'ECONNREFUSED' };
		var t = new HttpTransport({ fetch: fakeFetch({ 'GET /api/v1/qnet/hello': refused }, []) });
		await assert.rejects(t.connect(CD), function (err) {
			assert.match(err.message, /ECONNREFUSED/);
			assert.strictEqual(classifyTransfer({ status: false, stage: 'connect', errormessages: [err.message] }, 'pull'), 'connect_failed');
			return true;
		});
	});

	it('treats "nothing for you" as the tosser\'s nothing-waiting case', async function () {
		var t = new HttpTransport({ fetch: fakeFetch({
			'GET /api/v1/qnet/hello': new Response('{}', { status: 200 }),
			'GET /api/v1/qnet/packet': new Response(null, { status: 204 })
		}, []) });
		await t.connect(CD);
		await assert.rejects(t.downloadFile('ignored', path.join(dir, 'X.qwk')), function (err) { return err.code === 'ENOENT'; });
	});

	it('writes the packet, then acknowledges it by id', async function () {
		var calls = [];
		var t = new HttpTransport({ fetch: fakeFetch({
			'GET /api/v1/qnet/hello': new Response('{}', { status: 200 }),
			'GET /api/v1/qnet/packet': function () {
				return new Response(Buffer.from('PK\x03\x04data'), { status: 200, headers: { 'X-Qnet-Packet-Id': 'abc-123' } });
			},
			'POST /api/v1/qnet/packet/abc-123/ack': new Response('{"committed":true}', { status: 200 })
		}, calls) });
		await t.connect(CD);
		var local = path.join(dir, 'HUB.qwk');
		await t.downloadFile('ignored', local);
		assert.strictEqual(fs.readFileSync(local, 'latin1'), 'PK\x03\x04data');
		assert.deepStrictEqual(calls.map(function (c) { return c.key; }),
			['GET /api/v1/qnet/hello', 'GET /api/v1/qnet/packet', 'POST /api/v1/qnet/packet/abc-123/ack']);
	});

	it('keeps the packet when the acknowledgement fails; the hub offers it again', async function () {
		var t = new HttpTransport({ fetch: fakeFetch({
			'GET /api/v1/qnet/hello': new Response('{}', { status: 200 }),
			'GET /api/v1/qnet/packet': function () {
				return new Response(Buffer.from('PK\x03\x04'), { status: 200, headers: { 'X-Qnet-Packet-Id': 'p1' } });
			},
			'POST /api/v1/qnet/packet/p1/ack': new Response('{}', { status: 409 })
		}, []) });
		await t.connect(CD);
		await t.downloadFile('ignored', path.join(dir, 'HUB.qwk'));
		assert.ok(fs.existsSync(path.join(dir, 'HUB.qwk')));
	});

	it('uploads a REP and accepts 202', async function () {
		var calls = [];
		var t = new HttpTransport({ fetch: fakeFetch({
			'GET /api/v1/qnet/hello': new Response('{}', { status: 200 }),
			'POST /api/v1/qnet/rep': new Response('{"accepted":true}', { status: 202 })
		}, calls) });
		await t.connect(CD);
		var rep = path.join(dir, 'HUB.rep');
		fs.writeFileSync(rep, 'PK\x03\x04rep');
		await t.uploadFile(rep, 'ignored');
		assert.strictEqual(Buffer.from(calls[1].body).toString('latin1'), 'PK\x03\x04rep');
	});

	it('fails an upload the hub refuses', async function () {
		var t = new HttpTransport({ fetch: fakeFetch({
			'GET /api/v1/qnet/hello': new Response('{}', { status: 200 }),
			'POST /api/v1/qnet/rep': new Response('{"error":"too_large"}', { status: 413 })
		}, []) });
		await t.connect(CD);
		var rep = path.join(dir, 'HUB.rep');
		fs.writeFileSync(rep, 'PK\x03\x04');
		await assert.rejects(t.uploadFile(rep, 'ignored'), /HTTP 413/);
	});
});
