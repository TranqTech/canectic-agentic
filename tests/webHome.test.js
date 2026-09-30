// tests/webHome.test.js: the sysop's home page (#87, #91 phase 5).
//
// The home page is two layouts of web blocks, one for visitors and one for
// logged-in users, as tabs or stacked. Until a sysop saves one it must be
// the home page as it always was. These tests pin that default, the
// Announcements setting the home page needs, the Log In block, how a list
// of blocks is rendered (and what is left out), and saving.
//
// Run: npx mocha --no-config --exit tests/webHome.test.js

import assert from 'assert';
import path from 'path';
import express from 'express';
import { fileURLToPath } from 'url';
import { dbAvailable } from './helpers/dbAvailable.js';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

var webHome = null, webBlocks = null, catalog = null;
try {
	webHome = await import('../src/models/webHome.js');
	webBlocks = await import('../src/webBlocks/index.js');
	catalog = await import('../src/webBlocks/catalog.js');
} catch (_) { /* skip */ }

var user = { id: '1', username: 'u', security: '20', permissionflags: '[]', restrictionflags: '[]' };
function ctxFor(u, memo) {
	var ctx = webBlocks.createContext({ app: { locals: {} } }, u);
	for (var k of Object.keys(memo || {})) (function (v) { ctx.once(k, function () { return v; }); })(memo[k]);
	return ctx;
}

describe('home page: the layouts as shipped', function () {
	before(function () { if (!webHome) this.skip(); });

	it('are the home page as it always was: announcements, and the wall for users, as tabs', function () {
		assert.deepStrictEqual(JSON.parse(JSON.stringify(webHome.DEFAULT_LAYOUTS)), {
			public: { display: 'tabs', blocks: [{ stage: 'announcements', options: { show: 'all' } }] },
			users: { display: 'tabs', blocks: [{ stage: 'announcements', options: { show: 'all' } }, { stage: 'wall' }] }
		});
	});

	it('are valid layouts by the same rules a saved one is checked against', function () {
		for (var a of ['public', 'users']) {
			var r = catalog.normaliseWebStages(webHome.DEFAULT_LAYOUTS[a].blocks);
			assert.deepStrictEqual(r.errors, [], a);
			assert.deepStrictEqual(r.stages, JSON.parse(JSON.stringify(webHome.DEFAULT_LAYOUTS[a].blocks)), a);
		}
	});
});

describe('home page: blocks it needs', function () {
	before(function () { if (!webBlocks) this.skip(); });

	var anns = [
		{ id: 1, title: 'Old', pinned: false, created_at: '2026-01-01' },
		{ id: 2, title: 'Pinned', pinned: true, created_at: '2026-01-02' },
		{ id: 3, title: 'Fresh', pinned: false, created_at: '2026-09-28' }
	];

	it('Announcements: "all" shows every current one, "new" the new and pinned; new is marked only with a last visit', async function () {
		var { markAnnouncements } = await import('../src/webBlocks/announcements.js');
		var since = new Date('2026-09-01');
		var view = function (list) { return list.map(function (a) { return [a.title, a._isNew]; }); };
		assert.deepStrictEqual(view(markAnnouncements(anns, since, 'all')), [['Old', false], ['Pinned', false], ['Fresh', true]]);
		assert.deepStrictEqual(view(markAnnouncements(anns, null, 'all')), [['Old', false], ['Pinned', false], ['Fresh', false]],
			'a visitor sees them all with no New badges');
		assert.deepStrictEqual(view(markAnnouncements(anns, since, 'new')), [['Pinned', false], ['Fresh', true]], 'the call flow, as before');
		assert.deepStrictEqual(view(markAnnouncements(anns, null, 'new')), [['Old', true], ['Pinned', false], ['Fresh', true]],
			'a first call flow: everything is new, a pinned one carries one badge');
	});

	it('Announcements is for visitors too now, since the home page shows them', function () {
		assert.strictEqual(webBlocks.getBlock('announcements').requiresUser, false);
		assert.strictEqual(catalog.catalogEntry('announcements').options[0].default, 'new', 'the call flow keeps showing only new ones');
	});

	it('Log In is shown only to visitors', async function () {
		var block = webBlocks.getBlock('login');
		assert.deepStrictEqual(await block.available(ctxFor(null), {}), {});
		assert.strictEqual(await block.available(ctxFor(user), {}), null);
	});
});

describe('home page: rendering a list of blocks', function () {
	before(function () { if (!webBlocks) this.skip(); });

	function fake(name, over) {
		return Object.assign({ name: name, label: name.toUpperCase(), icon: 'x', view: 'v/' + name, requiresUser: false,
			load: async function () { return { who: name }; } }, over);
	}
	var render = async function (view, locals) { return '<' + view + ':' + locals.who + ':' + locals.layout + '>'; };

	it('renders each block in order with its label and icon, leaving out what this visitor does not get', async function () {
		var reg = new Map([
			['a', fake('a')],
			['b', fake('b', { requiresUser: true })],
			['c', fake('c', { available: async function () { return null; } })],
			['d', fake('d', { available: async function () { throw new Error('boom'); } })],
			['e', fake('e', { available: async function () { return { label: 'Relabelled' }; } })]
		]);
		var visitor = await webBlocks.renderBlocks(ctxFor(null), ['a', 'b', 'c', 'd', 'e', 'nope'], render, reg);
		assert.deepStrictEqual(visitor, [
			{ name: 'a', label: 'A', icon: 'x', html: '<v/a:a:false>' },
			{ name: 'e', label: 'Relabelled', icon: 'x', html: '<v/e:e:false>' }
		]);
		var member = await webBlocks.renderBlocks(ctxFor(user), ['b', 'a'], render, reg);
		assert.deepStrictEqual(member.map(function (b) { return b.name; }), ['b', 'a']);
	});

	it('a block whose view fails to render costs its own space, not the page', async function () {
		var reg = new Map([['a', fake('a')], ['b', fake('b')]]);
		var flaky = async function (view, locals) { if (locals.who === 'a') throw new Error('bad view'); return 'ok'; };
		var out = await webBlocks.renderBlocks(ctxFor(null), ['a', 'b'], flaky, reg);
		assert.deepStrictEqual(out.map(function (b) { return b.name; }), ['b']);
	});
});

describe('home page: against the database', function () {
	this.timeout(30000);
	var ready = false, saved = {}, server = null, base = null;

	before(async function () {
		this.timeout(20000);
		if (!webHome || !(await dbAvailable())) return this.skip();
		var postgres = await import('../src/middleware/db/postgres.js');
		var t = await postgres.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'web_home_layouts'", []);
		if (!t || t.length === 0) return this.skip();
		// Keep whatever the dev board has, to put back afterwards
		var rows = await postgres.query('SELECT * FROM web_home_layouts', []) || [];
		for (var r of rows) saved[r.audience] = r;
		ready = true;
	});
	beforeEach(function () { if (!ready) this.skip(); });

	after(async function () {
		if (!ready) return;
		var postgres = await import('../src/middleware/db/postgres.js');
		await postgres.write('DELETE FROM web_home_layouts', []);
		for (var a of Object.keys(saved)) {
			await postgres.write('INSERT INTO web_home_layouts (audience, display, blocks, updated_at) VALUES ($1, $2, $3, $4)',
				[a, saved[a].display, JSON.stringify(saved[a].blocks), saved[a].updated_at]);
		}
		if (server) { server.closeAllConnections(); await new Promise(function (r) { server.close(r); }); }
	});

	it('draws the shipped layout until one is saved, and again after a reset', async function () {
		await webHome.resetLayout('public');
		var l = await webHome.getLayout('public');
		assert.strictEqual(l.isDefault, true);
		assert.deepStrictEqual(l.blocks, [{ stage: 'announcements', options: { show: 'all' } }]);
	});

	it('saves blocks and display, checked as a web flow is, and refuses what it cannot draw', async function () {
		var ok = await webHome.saveLayout('public', { blocks: [{ stage: 'login' }, { stage: 'announcements', options: { show: 'all' } }] });
		assert.strictEqual(ok.status, true, ok.errormessages.join());
		var d = await webHome.saveLayout('public', { display: 'stacked' });
		assert.strictEqual(d.status, true);
		var l = await webHome.getLayout('public');
		assert.deepStrictEqual(l, { display: 'stacked', blocks: [{ stage: 'login' }, { stage: 'announcements', options: { show: 'all' } }], isDefault: false });

		assert.match((await webHome.saveLayout('public', { blocks: [{ stage: 'logon' }] })).errormessages[0], /Not a web stage: logon/);
		assert.match((await webHome.saveLayout('public', { display: 'carousel' })).errormessages[0], /tabs or one above the other/);
		assert.match((await webHome.saveLayout('public', { blocks: [{ stage: 'page', options: { page: 999999999 } }] })).errormessages[0], /there is no page/);
		assert.match((await webHome.saveLayout('robots', { display: 'tabs' })).errormessages[0], /No such home page/);
		assert.deepStrictEqual((await webHome.getLayout('public')).blocks, l.blocks, 'refused saves changed nothing');
	});

	it('the home route draws the visitor layout: stacked, the login form, no tabs', async function () {
		var appConfig = (await import('../src/config/appConfig.js')).default;
		await appConfig.load();
		var dates = await import('../src/utils/dateFormat.js');
		var webNav = await import('../src/models/webNav.js');
		var { router } = await import('../src/routes/index.js');
		var app = express();
		app.set('views', path.join(ROOT, 'src/views'));
		app.set('view engine', 'pug');
		app.use(function (req, res, next) {
			req.cookies = {};
			res.locals.formatTimestamp = dates.formatTimestamp;
			res.locals.timestampMs = dates.timestampMs;
			res.locals.formatFriendly = dates.formatFriendly;
			res.locals.webNavItems = webNav.DEFAULT_ITEMS;
			res.locals.buildWebNav = webNav.buildNav;
			res.locals.webNavPages = new Map();
			res.locals.navPath = req.path;
			next();
		});
		app.use('/', router);
		await new Promise(function (resolve) {
			server = app.listen(0, '127.0.0.1', function () { base = 'http://127.0.0.1:' + server.address().port; resolve(); });
		});
		var res = await fetch(base + '/');
		var html = await res.text();
		assert.strictEqual(res.status, 200, html.slice(0, 400));
		assert.match(html, /<div class="home-block mb-3" data-block="login">/);
		assert.match(html, /action="\/users\/login"/);
		assert.doesNotMatch(html, /nav-tabs/);
	});
});
