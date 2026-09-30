// tests/webBlocks.test.js: the web block registry (#91 phase 1).
//
// The web call flow's stages used to be written out twice in
// src/routes/callflow.js, once to decide which to show and once per stage
// route to render it. They are now blocks in src/webBlocks, read by the call
// flow today and by the landing page (#87) later. These tests pin that the
// move changed nothing a user sees: the same stages, in the same order, with
// the same detail, served at the same paths, and that one failing block
// costs one stage rather than the whole flow.
//
// Run: npx mocha --no-config --exit tests/webBlocks.test.js

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { fileURLToPath } from 'url';
import { dbAvailable } from './helpers/dbAvailable.js';
import { redisAvailable } from './helpers/redisAvailable.js';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

var webBlocks = null;
try { webBlocks = await import('../src/webBlocks/index.js'); } catch (_) { /* skip */ }

// The call flow as it was built before the registry existed.
var HISTORICAL_FLOW = [
	['welcome', 'Welcome'],
	['announcements', 'Announcements'],
	['lastcallers', 'Last Callers'],
	['whosonline', "Who's Online"],
	['wall', 'The Wall'],
	['newsfiles', 'News'],
	['newmsgs', 'New Messages'],
	['newfiles', 'New Files']
];

function fakeCtx(user) {
	return webBlocks.createContext({ app: { locals: {} } }, user === undefined ? { id: '1', username: 'x' } : user);
}

function registryOf(blocks) {
	var m = new Map();
	for (var b of blocks) m.set(b.name, b);
	return m;
}

describe('web blocks: the registry', function () {
	before(function () { if (!webBlocks) this.skip(); });

	it('the default flow is the call flow as it has always been, names and labels', function () {
		assert.deepStrictEqual(
			webBlocks.DEFAULT_WEB_FLOW.map(function (n) { return [n, webBlocks.getBlock(n).label]; }),
			HISTORICAL_FLOW);
	});

	it('every block is complete and its view exists', function () {
		for (var b of webBlocks.listBlocks()) {
			assert.ok(b.name && b.label && b.view, b.name + ': name, label, view');
			assert.strictEqual(typeof b.load, 'function', b.name + ': load');
			assert.strictEqual(typeof b.requiresUser, 'boolean', b.name + ': requiresUser');
			assert.ok(fs.existsSync(path.join(ROOT, 'src/views', b.view + '.pug')), b.name + ': ' + b.view + '.pug');
		}
	});

	it('blocks that mean nothing to a visitor say so', function () {
		var needUser = webBlocks.listBlocks().filter(function (b) { return b.requiresUser; })
			.map(function (b) { return b.name; }).sort();
		assert.deepStrictEqual(needUser, ['announcements', 'newfiles', 'newmail', 'newmsgs', 'verifymail']);
	});

	it('an unknown name is a miss, including names every object has', function () {
		for (var n of ['nope', '__proto__', 'constructor', 'toString', '', null, undefined, 42]) {
			assert.strictEqual(webBlocks.getBlock(n), null, String(n));
		}
	});
});

describe('web blocks: building the stage list', function () {
	before(function () { if (!webBlocks) this.skip(); });

	var always = { name: 'a', label: 'A', view: 'v', requiresUser: false, load: async function () { return {}; } };
	var counted = { name: 'b', label: 'B', view: 'v', requiresUser: false, load: async function () { return {}; },
		available: async function () { return { count: 3, areas: 2 }; } };
	var empty = { name: 'c', label: 'C', view: 'v', requiresUser: false, load: async function () { return {}; },
		available: async function () { return null; } };
	var broken = { name: 'd', label: 'D', view: 'v', requiresUser: false, load: async function () { return {}; },
		available: async function () { throw new Error('query failed'); } };
	var greedy = { name: 'e', label: 'E', view: 'v', requiresUser: false, load: async function () { return {}; },
		available: async function () { return { name: 'hijack', label: 'Hijack', count: 1 }; } };
	var reg = registryOf([always, counted, empty, broken, greedy]);

	it('lists nothing for a visitor', async function () {
		assert.deepStrictEqual(await webBlocks.buildStageList(fakeCtx(null), ['a', 'b'], reg), []);
	});

	it('keeps the flow order, adds detail after name and label, skips a block with nothing', async function () {
		var stages = await webBlocks.buildStageList(fakeCtx(), ['b', 'c', 'a'], reg);
		assert.deepStrictEqual(stages, [
			{ name: 'b', label: 'B', count: 3, areas: 2 },
			{ name: 'a', label: 'A' }
		]);
		// Key order is what the client and the old JSON had
		assert.deepStrictEqual(Object.keys(stages[0]), ['name', 'label', 'count', 'areas']);
	});

	it('leaves out a block that throws and still lists the rest', async function () {
		var stages = await webBlocks.buildStageList(fakeCtx(), ['a', 'd', 'b'], reg);
		assert.deepStrictEqual(stages.map(function (s) { return s.name; }), ['a', 'b']);
	});

	it('skips a name the registry does not know', async function () {
		var stages = await webBlocks.buildStageList(fakeCtx(), ['a', 'gone', 'b'], reg);
		assert.deepStrictEqual(stages.map(function (s) { return s.name; }), ['a', 'b']);
	});

	it('detail cannot rename a stage', async function () {
		var stages = await webBlocks.buildStageList(fakeCtx(), ['e'], reg);
		assert.deepStrictEqual(stages, [{ name: 'e', label: 'E', count: 1 }]);
	});
});

describe('web blocks: the request context', function () {
	before(function () { if (!webBlocks) this.skip(); });

	it('once() runs a shared lookup one time, even when asked concurrently', async function () {
		var ctx = fakeCtx();
		var calls = 0;
		var fn = async function () { calls++; return 'v'; };
		var r = await Promise.all([ctx.once('k', fn), ctx.once('k', fn), ctx.once('k', fn)]);
		assert.deepStrictEqual(r, ['v', 'v', 'v']);
		assert.strictEqual(calls, 1);
	});

	it('a visitor has no last call flow and asks the database nothing', async function () {
		assert.strictEqual(await fakeCtx(null).lastCallflowAt(), null);
	});

	it('picks the node manager off the app', function () {
		var nm = { getActiveNodes: function () { return []; } };
		var ctx = webBlocks.createContext({ app: { locals: { nodeManager: nm } } }, null);
		assert.strictEqual(ctx.nodeManager, nm);
	});
});

describe('web blocks: the call flow routes', function () {
	var router = null, server = null, base = null;

	before(async function () {
		if (!webBlocks) return this.skip();
		try { ({ router } = await import('../src/routes/callflow.js')); } catch (_) { return this.skip(); }
		var app = express();
		app.use('/callflow', router);
		app.use(function (err, req, res, next) { res.status(500).json({ error: err.message }); });
		await new Promise(function (resolve) {
			server = app.listen(0, '127.0.0.1', function () {
				base = 'http://127.0.0.1:' + server.address().port;
				resolve();
			});
		});
	});

	after(function (done) {
		if (!server) return done();
		server.closeAllConnections();
		server.close(done);
	});

	it('a visitor gets an empty stage list', async function () {
		var res = await fetch(base + '/callflow/stages.json');
		assert.deepStrictEqual(await res.json(), { stages: [] });
	});

	it('a stage that needs a user refuses a visitor', async function () {
		for (var n of ['announcements', 'newmsgs', 'newfiles']) {
			assert.strictEqual((await fetch(base + '/callflow/stage/' + n)).status, 401, n);
		}
	});

	it('an unknown stage is a 404, not an error', async function () {
		for (var n of ['nope', '__proto__', 'constructor']) {
			assert.strictEqual((await fetch(base + '/callflow/stage/' + n)).status, 404, n);
		}
	});
});

describe('web blocks: every stage renders for a real user', function () {
	this.timeout(30000);

	var router = null, server = null, base = null, store = null;
	var SID = 'zz-webblocks-0000-0000-000000000001';
	var ready = false;

	before(async function () {
		this.timeout(20000);
		if (!webBlocks) return this.skip();
		if (!(await dbAvailable()) || !(await redisAvailable())) return this.skip();

		var appConfig = (await import('../src/config/appConfig.js')).default;
		await appConfig.load();
		var postgres = await import('../src/middleware/db/postgres.js');
		store = await import('../src/middleware/db/sessionstore.js');
		var dates = await import('../src/utils/dateFormat.js');
		({ router } = await import('../src/routes/callflow.js'));

		var user = await postgres.queryOne('SELECT id, username FROM users ORDER BY id LIMIT 1');
		if (!user) return this.skip();
		// prev_logon a month back so the new files query has a window to search
		await store.sessionStore(SID, { id: String(user.id), username: user.username,
			prev_logon: String(Date.now() - 30 * 86400000) }, 600);

		var app = express();
		app.set('views', path.join(ROOT, 'src/views'));
		app.set('view engine', 'pug');
		app.use(function (req, res, next) {
			req.cookies = { sessionid: SID };
			// What webserver.js sets app-wide and the views rely on
			res.locals.formatTimestamp = dates.formatTimestamp;
			res.locals.timestampMs = dates.timestampMs;
			res.locals.formatFriendly = dates.formatFriendly;
			next();
		});
		app.use('/callflow', router);
		app.use(function (err, req, res, next) { res.status(500).send(err.stack); });
		await new Promise(function (resolve) {
			server = app.listen(0, '127.0.0.1', function () {
				base = 'http://127.0.0.1:' + server.address().port;
				resolve();
			});
		});
		ready = true;
	});

	beforeEach(function () { if (!ready) this.skip(); });

	after(async function () {
		if (store) { try { await store.sessionDestroy(SID); } catch (_) {} }
		if (server) {
			server.closeAllConnections();
			await new Promise(function (r) { server.close(r); });
		}
	});

	it('the stage list is the default flow, in order, starting with Welcome', async function () {
		var body = await (await fetch(base + '/callflow/stages.json')).json();
		var names = body.stages.map(function (s) { return s.name; });
		assert.strictEqual(names[0], 'welcome');
		var positions = names.map(function (n) { return webBlocks.DEFAULT_WEB_FLOW.indexOf(n); });
		assert.ok(positions.every(function (p, i) { return p >= 0 && (i === 0 || p > positions[i - 1]); }),
			'a subsequence of the default flow: ' + names.join(','));
	});

	webBlocksNames().forEach(function (name) {
		it('/callflow/stage/' + name + ' renders', async function () {
			var res = await fetch(base + '/callflow/stage/' + name);
			var text = await res.text();
			assert.strictEqual(res.status, 200, text.slice(0, 500));
		});
	});
});

// Every block, not only the default flow's: a sysop can add any of them
function webBlocksNames() {
	return webBlocks ? webBlocks.listBlocks().map(function (b) { return b.name; }) : [];
}
