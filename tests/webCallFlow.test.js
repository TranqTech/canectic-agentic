// tests/webCallFlow.test.js: the editable web call flow (#91 phase 2).
//
// The web call flow is now the kind 'web' row of call_flows, edited at
// /admin/callflows beside the terminal flows. The two kinds must never mix:
// CallManager hangs up on a stage it does not know, so a web flow reaching a
// terminal pool would disconnect every caller on it. These tests pin the
// guards (saves checked per kind, pools on terminal flows only, CallManager
// loading terminal flows only), the per-stage settings, and that the route
// follows the flow.
//
// Run: npx mocha --no-config --exit tests/webCallFlow.test.js

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { fileURLToPath } from 'url';
import { dbAvailable } from './helpers/dbAvailable.js';
import { redisAvailable } from './helpers/redisAvailable.js';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

var catalog = null, callFlows = null, webBlocks = null;
try {
	catalog = await import('../src/webBlocks/catalog.js');
	callFlows = await import('../src/models/callFlows.js');
	webBlocks = await import('../src/webBlocks/index.js');
} catch (_) { /* skip */ }

describe('web call flow: checking a web flow before it is saved', function () {
	before(function () { if (!catalog) this.skip(); });

	it('accepts the default flow as it is', function () {
		var r = catalog.normaliseWebStages(catalog.DEFAULT_WEB_FLOW.slice());
		assert.deepStrictEqual(r.errors, []);
		assert.deepStrictEqual(r.stages, catalog.DEFAULT_WEB_FLOW.map(function (n) { return { stage: n }; }));
	});

	it('refuses a terminal stage, an unknown one, and a malformed item', function () {
		var r = catalog.normaliseWebStages(['welcome', 'logon', 'nope', { arg: 'x' }]);
		assert.deepStrictEqual(r.stages, [{ stage: 'welcome' }]);
		assert.strictEqual(r.errors.length, 3);
		assert.match(r.errors[0], /Not a web stage: logon/);
	});

	it('refuses a stage twice, since its name is its address', function () {
		var r = catalog.normaliseWebStages(['wall', { stage: 'wall', options: { count: 3 } }]);
		assert.strictEqual(r.stages.length, 1);
		assert.match(r.errors[0], /The Wall is in the flow twice/);
	});

	it('refuses a list that is not a list', function () {
		assert.deepStrictEqual(catalog.normaliseWebStages('welcome').errors, ['Stages must be a list']);
	});

	it('checks each setting against its definition', function () {
		var bad = [0, 51, 5.5, 'abc', -1, null];
		for (var v of bad) {
			var r = catalog.normaliseWebStages([{ stage: 'lastcallers', options: { count: v } }]);
			assert.strictEqual(r.errors.length, 1, 'count ' + JSON.stringify(v));
			assert.match(r.errors[0], /Last Callers: How many must be a whole number from 1 to 50/);
		}
		var sel = catalog.normaliseWebStages([{ stage: 'wall', options: { show: 'sometimes' } }]);
		assert.match(sel.errors[0], /The Wall: Show is not one of the choices/);
	});

	it('takes a number from a form as a number, drops keys it does not know, stores nothing when nothing is set', function () {
		var r = catalog.normaliseWebStages([
			{ stage: 'lastcallers', options: { count: '10', colour: 'red' } },
			{ stage: 'newmsgs', options: { count: 5 } },
			{ stage: 'welcome', options: {} }
		]);
		assert.deepStrictEqual(r.errors, []);
		assert.deepStrictEqual(r.stages, [
			{ stage: 'lastcallers', options: { count: 10 } },
			{ stage: 'newmsgs' },
			{ stage: 'welcome' }
		]);
	});

	it('at run time a bad stored value costs a default, not the page', function () {
		var entry = catalog.catalogEntry('wall');
		assert.deepStrictEqual(catalog.resolveOptions(entry, { show: 'garbage', count: 999 }), { show: 'always', count: 15 });
		assert.deepStrictEqual(catalog.resolveOptions(entry, null), { show: 'always', count: 15 });
		assert.deepStrictEqual(catalog.resolveOptions(entry, { show: 'new', count: 4 }), { show: 'new', count: 4 });
		assert.deepStrictEqual(catalog.resolveOptions(catalog.catalogEntry('welcome'), { anything: 1 }), {});
	});

	it('describes only what differs from the default', function () {
		var entry = catalog.catalogEntry('lastcallers');
		assert.strictEqual(catalog.describeOptions(entry, {}), '');
		assert.strictEqual(catalog.describeOptions(entry, { count: 15 }), '');
		assert.strictEqual(catalog.describeOptions(entry, { show: 'new', count: 5 }),
			'only when someone else has called since their last visit; how many 5');
	});
});

describe('web call flow: the terminal side is kept apart', function () {
	before(function () { if (!callFlows) this.skip(); });

	it('a terminal flow refuses a web stage by name, saying so', function () {
		var r = callFlows.normaliseTerminalStages([{ stage: 'logon' }, { stage: 'newmsgs' }]);
		assert.deepStrictEqual(r.stages, [{ stage: 'logon' }]);
		assert.deepStrictEqual(r.errors, ['newmsgs is a web stage; a terminal flow cannot use it']);
	});

	it('a terminal flow refuses a stage CallManager would hang up on', function () {
		var r = callFlows.normaliseTerminalStages(['negotiate', 'logn', { stage: 'menu' }]);
		assert.deepStrictEqual(r.stages, ['negotiate', { stage: 'menu' }], 'shapes kept as given');
		assert.deepStrictEqual(r.errors, ['Not a terminal stage: logn']);
	});

	it('the terminal stages accepted are exactly what CallManager can run', function () {
		// handlerRegistry is not exported, so read its keys from the source.
		// "goodbye" is reserved by CallManager and never in the registry.
		var src = fs.readFileSync(path.join(ROOT, 'src/managers/callmanager.js'), 'utf8');
		var block = src.slice(src.indexOf('const handlerRegistry = {'), src.indexOf('};', src.indexOf('const handlerRegistry = {')));
		var keys = [];
		for (var line of block.split('\n')) {
			if (/^\s*\/\//.test(line)) continue;
			var m = line.match(/^\s*"([a-zA-Z_]+)":/);
			if (m) keys.push(m[1]);
		}
		keys.push('goodbye');
		var accepted = callFlows.getAvailableStages().map(function (s) { return s.name; }).concat(callFlows.TERMINAL_EXTRA_STAGES);
		assert.deepStrictEqual(Array.from(new Set(accepted)).sort(), keys.sort());
	});

	it('names both kinds use are only the ones that mean the same thing in each', function () {
		// The guard is the flow's kind, not the stage name, so a shared name is
		// safe; but it should be a decision, so a new one fails here first.
		var terminal = new Set(callFlows.getAvailableStages().map(function (s) { return s.name; }).concat(callFlows.TERMINAL_EXTRA_STAGES));
		var shared = catalog.CATALOG.map(function (e) { return e.name; }).filter(function (n) { return terminal.has(n); });
		assert.deepStrictEqual(shared.sort(), ['announcements', 'wall']);
		// ...and each kind still refuses the other's stages
		assert.deepStrictEqual(catalog.normaliseWebStages(['check_email']).errors, ['Not a web stage: check_email']);
		assert.deepStrictEqual(callFlows.normaliseTerminalStages(['welcome']).errors, ['welcome is a web stage; a terminal flow cannot use it']);
	});

	it('the shipped flows each pass their own kind, and there is one web flow holding the default', function () {
		var flows = callFlows.getDefaultFlows();
		var web = flows.filter(function (f) { return f.kind === 'web'; });
		assert.strictEqual(web.length, 1);
		assert.deepStrictEqual(web[0].stages.map(function (s) { return s.stage; }), catalog.DEFAULT_WEB_FLOW.slice());
		for (var f of flows) {
			assert.ok(callFlows.FLOW_KINDS.includes(f.kind), f.name + ' has a kind');
			assert.deepStrictEqual(callFlows.normaliseStagesFor(f.kind, f.stages).errors, [], f.name);
		}
	});

	it('CallManager loads terminal flows only', function () {
		var src = fs.readFileSync(path.join(ROOT, 'src/managers/callmanager.js'), 'utf8');
		var fn = src.slice(src.indexOf('async function loadFlowsFromDB'), src.indexOf('function getCallFlow'));
		assert.match(fn, /if \(row\.kind && row\.kind !== 'terminal'\) continue;/);
	});

	it('the web flow is seeded under the first free name, since a board may already have a "Web"', function () {
		assert.strictEqual(callFlows.firstFreeFlowName('Web', ['Standard', 'Doorserver']), 'Web');
		assert.strictEqual(callFlows.firstFreeFlowName('Web', ['Standard', 'web']), 'WebLogin');
		assert.strictEqual(callFlows.firstFreeFlowName('Web', ['WEB', 'weblogin', 'WebLogin2']), 'WebLogin3');
	});
});

describe('web call flow: settings change what a block shows', function () {
	before(function () { if (!webBlocks) this.skip(); });

	function ctxWithOnline(username, online) {
		var ctx = webBlocks.createContext({ app: { locals: {} } }, { id: '1', username: username });
		// Seed the memo so the block reads this list, not Redis
		ctx.once('onlineUsers', function () { return online; });
		return ctx;
	}

	it("Who's Online on 'others' is skipped when only this user is on", async function () {
		var block = webBlocks.getBlock('whosonline');
		var only = [{ username: 'Me' }];
		var both = [{ username: 'Me' }, { username: 'someone' }];
		assert.strictEqual(await block.available(ctxWithOnline('me', only), { show: 'others' }), null);
		assert.deepStrictEqual(await block.available(ctxWithOnline('me', both), { show: 'others' }), {});
		assert.deepStrictEqual(await block.available(ctxWithOnline('me', only), { show: 'always' }), {});
	});

	it("Last Callers and the Wall on 'new' show everything to someone who has never been through the flow", async function () {
		for (var name of ['lastcallers', 'wall']) {
			var ctx = webBlocks.createContext({ app: { locals: {} } }, { id: '1', username: 'x' });
			ctx.once('lastCallflowAt', function () { return null; });
			assert.deepStrictEqual(await webBlocks.getBlock(name).available(ctx, { show: 'new', count: 15 }), {}, name);
		}
	});

	it('the stage list passes each stage its settings', async function () {
		var seen = null;
		var probe = { name: 'lastcallers', label: 'Last Callers', view: 'v', requiresUser: false,
			load: async function () { return {}; },
			available: async function (ctx, opts) { seen = opts; return {}; } };
		var reg = new Map([['lastcallers', probe]]);
		var ctx = webBlocks.createContext({ app: { locals: {} } }, { id: '1', username: 'x' });
		await webBlocks.buildStageList(ctx, [{ stage: 'lastcallers', options: { count: 7 } }], reg);
		assert.deepStrictEqual(seen, { show: 'always', count: 7 });
	});
});

describe('web call flow: against the database', function () {
	this.timeout(30000);

	var ready = false, original = null, webFlow = null;
	var server = null, base = null, store = null;
	var SID = 'zz-webcallflow-0000-0000-000000000001';

	before(async function () {
		this.timeout(20000);
		if (!callFlows || !(await dbAvailable())) return this.skip();
		var postgres = await import('../src/middleware/db/postgres.js');
		var cols = await postgres.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'call_flows' AND column_name = 'kind'", []);
		if (!cols || cols.length === 0) return this.skip();
		await callFlows.seedDefaults();
		callFlows.invalidateCache();
		webFlow = await callFlows.getWebFlow();
		if (!webFlow) return this.skip();
		original = await callFlows.getWebFlowStages();
		ready = true;
	});

	beforeEach(function () { if (!ready) this.skip(); });

	after(async function () {
		// Put the dev board's web flow back as it was
		if (webFlow && original) await callFlows.updateFlow(webFlow.id, { stages: original });
		if (store) { try { await store.sessionDestroy(SID); } catch (_) {} }
		if (server) {
			server.closeAllConnections();
			await new Promise(function (r) { server.close(r); });
		}
	});

	it('there is exactly one web flow, it is a system flow, and it is not a terminal runtime flow', async function () {
		var rows = (await callFlows.getAllFlows()).filter(function (r) { return r.kind === 'web'; });
		assert.strictEqual(rows.length, 1);
		assert.strictEqual(rows[0].is_system, true);
		assert.strictEqual(await callFlows.getFlowStages(webFlow.name), null);
	});

	it('refuses a terminal stage in the web flow and changes nothing', async function () {
		var r = await callFlows.updateFlow(webFlow.id, { stages: [{ stage: 'welcome' }, { stage: 'logon' }] });
		assert.strictEqual(r.status, false);
		assert.match(r.errormessages.join(' '), /Not a web stage: logon/);
		assert.deepStrictEqual(await callFlows.getWebFlowStages(), original);
	});

	it('refuses a pool on the web flow, and on a flow that does not exist', async function () {
		var r = await callFlows.createPool({ name: 'zz-webcallflow-pool', flow_name: webFlow.name, ws_paths: '/ws/zz' });
		assert.strictEqual(r.status, false);
		assert.match(r.errormessages[0], /is the web call flow; a pool needs a terminal flow/);
		var r2 = await callFlows.createPool({ name: 'zz-webcallflow-pool', flow_name: 'zz-no-such-flow' });
		assert.match(r2.errormessages[0], /No call flow is called zz-no-such-flow/);
		assert.strictEqual(await callFlows.getPoolByName('zz-webcallflow-pool'), null);
	});

	it('refuses to switch an existing pool onto the web flow', async function () {
		var pool = (await callFlows.getAllPools())[0];
		if (!pool) return this.skip();
		var r = await callFlows.updatePool(pool.id, { flow_name: webFlow.name });
		assert.strictEqual(r.status, false);
		assert.strictEqual((await callFlows.getPoolById(pool.id)).flow_name, pool.flow_name);
	});

	it('the web flow cannot be switched off; callflow_enabled does that', async function () {
		var r = await callFlows.updateFlow(webFlow.id, { active: 'false' });
		assert.strictEqual(r.status, true);
		assert.strictEqual((await callFlows.getFlowById(webFlow.id)).active, true);
	});

	it('the route follows the saved flow and its settings', async function () {
		if (!(await redisAvailable())) return this.skip();
		var saved = await callFlows.updateFlow(webFlow.id, { stages: [
			{ stage: 'welcome' }, { stage: 'wall', options: { count: 2 } }
		] });
		assert.strictEqual(saved.status, true, (saved.errormessages || []).join());

		var appConfig = (await import('../src/config/appConfig.js')).default;
		await appConfig.load();
		var postgres = await import('../src/middleware/db/postgres.js');
		store = await import('../src/middleware/db/sessionstore.js');
		var dates = await import('../src/utils/dateFormat.js');
		var { router } = await import('../src/routes/callflow.js');
		var user = await postgres.queryOne('SELECT id, username FROM users ORDER BY id LIMIT 1');
		if (!user) return this.skip();
		await store.sessionStore(SID, { id: String(user.id), username: user.username }, 600);

		var app = express();
		app.set('views', path.join(ROOT, 'src/views'));
		app.set('view engine', 'pug');
		app.use(function (req, res, next) {
			req.cookies = { sessionid: SID };
			res.locals.formatTimestamp = dates.formatTimestamp;
			res.locals.timestampMs = dates.timestampMs;
			res.locals.formatFriendly = dates.formatFriendly;
			next();
		});
		app.use('/callflow', router);
		await new Promise(function (resolve) {
			server = app.listen(0, '127.0.0.1', function () {
				base = 'http://127.0.0.1:' + server.address().port;
				resolve();
			});
		});

		var body = await (await fetch(base + '/callflow/stages.json')).json();
		assert.deepStrictEqual(body.stages.map(function (s) { return s.name; }), ['welcome', 'wall']);

		var wallCount = await postgres.queryOne('SELECT COUNT(*)::int AS n FROM wall_messages', []);
		var html = await (await fetch(base + '/callflow/stage/wall')).text();
		var shown = (html.match(/<span class="text-muted">: <\/span>/g) || []).length;
		assert.strictEqual(shown, Math.min(2, wallCount.n), 'the Wall shows the configured count');
	});
});
