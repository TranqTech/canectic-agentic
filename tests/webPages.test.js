// tests/webPages.test.js: sysop web pages (#91 phase 4).
//
// A page is served at /page/<slug> to exactly who it is for, can be linked
// from the navigation bar and shown as a web call flow stage, and is
// referred to by id so its address can change without breaking either. The
// link and the stage follow the page's own rules, so nobody is offered a
// page they cannot open.
//
// Run: npx mocha --no-config --exit tests/webPages.test.js

import assert from 'assert';
import path from 'path';
import express from 'express';
import { fileURLToPath } from 'url';
import { dbAvailable } from './helpers/dbAvailable.js';
import { redisAvailable } from './helpers/redisAvailable.js';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

var webPages = null, webNav = null, catalog = null, webBlocks = null;
try {
	webPages = await import('../src/models/webPages.js');
	webNav = await import('../src/models/webNav.js');
	catalog = await import('../src/webBlocks/catalog.js');
	webBlocks = await import('../src/webBlocks/index.js');
} catch (_) { /* skip */ }

var user = { id: '1', username: 'u', security: '20', permissionflags: '[]', restrictionflags: '[]' };
var sysop = { id: '2', username: 's', security: '255', permissionflags: '["Sysop"]', restrictionflags: '[]' };
function page(over) {
	return Object.assign({ id: 7, slug: 'rules', title: 'House Rules', audience: 'all', min_security: null,
		required_flags: [], prohibited_flags: [], active: true }, over);
}

describe('web pages: checking a page before it is saved', function () {
	before(function () { if (!webPages) this.skip(); });

	it('makes an address from the title when none is given', function () {
		assert.strictEqual(webPages.slugify('House Rules!'), 'house-rules');
		assert.strictEqual(webPages.slugify('  --Hi--  '), 'hi');
		assert.strictEqual(webPages.slugify('x'.repeat(80) + ' y').length, 64);
		var r = webPages.validatePage({ title: 'How to Connect', body_html: ' <p>telnet</p> ' });
		assert.deepStrictEqual(r.errors, []);
		assert.strictEqual(r.page.slug, 'how-to-connect');
		assert.strictEqual(r.page.body_html, '<p>telnet</p>');
		assert.strictEqual(r.page.active, true);
		assert.strictEqual(r.page.show_title, true);
	});

	it('refuses a missing title, a bad address, a bad audience or security', function () {
		var errs = function (f) { return webPages.validatePage(f).errors; };
		assert.match(errs({})[0], /title is required/);
		for (var bad of ['has space', '-lead', 'trail-', 'dots.no', 'x'.repeat(65)]) {
			assert.match(errs({ title: 'T', slug: bad }).join(), /lower-case letters/, bad);
		}
		assert.deepStrictEqual(errs({ title: 'T', slug: 'UPPER' }), [], 'the address is lower-cased, not refused');
		assert.match(errs({ title: 'T', audience: 'robots' })[0], /who can read/);
		assert.match(errs({ title: 'T', min_security: '300' })[0], /0 to 255/);
	});

	it('reads the form: unticked boxes, flags one or many', function () {
		var r = webPages.validatePage({ title: 'T', active: 'false', show_title: 'false', required_flags: 'Sysop', prohibited_flags: ['Banned'] });
		assert.strictEqual(r.page.active, false);
		assert.strictEqual(r.page.show_title, false);
		assert.deepStrictEqual(r.page.required_flags, ['Sysop']);
		assert.deepStrictEqual(r.page.prohibited_flags, ['Banned']);
	});

	it('who may read a page', function () {
		assert.strictEqual(webPages.pageVisibleTo(page(), null), true);
		assert.strictEqual(webPages.pageVisibleTo(page({ active: false }), sysop), false, 'a draft is for nobody');
		assert.strictEqual(webPages.pageVisibleTo(page({ audience: 'users' }), null), false);
		assert.strictEqual(webPages.pageVisibleTo(page({ audience: 'public' }), user), false);
		assert.strictEqual(webPages.pageVisibleTo(page({ min_security: 100 }), user), false);
		assert.strictEqual(webPages.pageVisibleTo(page({ required_flags: ['Sysop'] }), sysop), true);
	});
});

describe('web pages: in the navigation bar', function () {
	before(function () { if (!webNav) this.skip(); });

	var link = { id: 50, parent_id: null, sort_order: 10, label: 'Rules', icon: null, target_type: 'page', target: '7',
		new_tab: false, audience: 'all', min_security: null, required_flags: [], prohibited_flags: [], active: true };
	var on = function () { return true; };

	it('links by id and draws the address from the page, so a new address follows', function () {
		var pages = new Map([[7, page({ slug: 'house-rules' })]]);
		var links = webNav.buildNav([link], { user: null, isEnabled: on, pages: pages, path: '/page/house-rules' });
		assert.deepStrictEqual(links.map(function (l) { return [l.label, l.href, l.active]; }), [['Rules', '/page/house-rules', true]]);
	});

	it('is shown only to people who can read the page, and not for a draft or a page that is gone', function () {
		var usersOnly = new Map([[7, page({ audience: 'users' })]]);
		assert.strictEqual(webNav.buildNav([link], { user: null, isEnabled: on, pages: usersOnly }).length, 0);
		assert.strictEqual(webNav.buildNav([link], { user: user, isEnabled: on, pages: usersOnly }).length, 1);
		assert.strictEqual(webNav.buildNav([link], { user: sysop, isEnabled: on, pages: new Map([[7, page({ active: false })]]) }).length, 0);
		assert.strictEqual(webNav.buildNav([link], { user: sysop, isEnabled: on, pages: new Map() }).length, 0);
		assert.strictEqual(webNav.buildNav([link], { user: sysop, isEnabled: on }).length, 0, 'no page list, no page links');
	});

	it('a link to a page must name one by id', function () {
		assert.deepStrictEqual(webNav.validateItem({ label: 'R', target_type: 'page', target: '7' }).errors, []);
		for (var bad of ['', 'rules', '0', '-1', '7a']) {
			assert.match(webNav.validateItem({ label: 'R', target_type: 'page', target: bad }).errors.join(), /Choose one of your pages/, bad);
		}
	});
});

describe('web pages: as a call flow stage', function () {
	before(function () { if (!catalog) this.skip(); });

	it('a Page stage must say which page, and may appear once per page', function () {
		var r = catalog.normaliseWebStages([{ stage: 'page' }]);
		assert.match(r.errors[0], /Page: choose which page/);
		var two = catalog.normaliseWebStages([{ stage: 'page', options: { page: '3' } }, { stage: 'page', options: { page: 4 } }]);
		assert.deepStrictEqual(two.errors, []);
		assert.deepStrictEqual(two.stages, [{ stage: 'page', options: { page: 3 } }, { stage: 'page', options: { page: 4 } }]);
		var dup = catalog.normaliseWebStages([{ stage: 'page', options: { page: 3 } }, { stage: 'page', options: { page: '3' } }]);
		assert.match(dup.errors[0], /twice with the same page/);
		assert.match(catalog.normaliseWebStages([{ stage: 'page', options: { page: 'rules' } }]).errors[0], /choose which page/);
	});

	it('its address carries its page, and its label is the page title', async function () {
		var probe = { name: 'page', label: 'Page', view: 'v', requiresUser: false, repeatable: 'page',
			load: async function () { return {}; },
			available: async function (ctx, opts) { return { label: 'Page ' + opts.page }; } };
		var reg = new Map([['page', probe]]);
		var ctx = webBlocks.createContext({ app: { locals: {} } }, user);
		var stages = await webBlocks.buildStageList(ctx, [{ stage: 'page', options: { page: 3 } }, { stage: 'page', options: { page: 9 } }], reg);
		assert.deepStrictEqual(stages, [
			{ name: 'page', label: 'Page 3', path: '/callflow/stage/page?page=3' },
			{ name: 'page', label: 'Page 9', path: '/callflow/stage/page?page=9' }
		]);
		var flow = [{ stage: 'page', options: { page: 3 } }, { stage: 'page', options: { page: 9 } }];
		assert.deepStrictEqual(webBlocks.findStage(flow, 'page', '9'), flow[1]);
		assert.strictEqual(webBlocks.findStage(flow, 'page', '5'), null);
		assert.strictEqual(webBlocks.findStage(flow, 'page', undefined), null);
	});

	it('is skipped for someone who cannot read the page', async function () {
		var block = webBlocks.getBlock('page');
		var ctxFor = function (u, map) {
			var c = webBlocks.createContext({ app: { locals: {} } }, u);
			c.once('webPages', function () { return map; });
			return c;
		};
		var map = new Map([[7, page({ audience: 'users', title: 'Members' })]]);
		assert.strictEqual(await block.available(ctxFor(null, map), { page: 7 }), null);
		assert.deepStrictEqual(await block.available(ctxFor(user, map), { page: 7 }), { label: 'Members' });
		assert.strictEqual(await block.available(ctxFor(user, map), { page: null }), null);
	});
});

describe('web pages: against the database', function () {
	this.timeout(30000);
	var ready = false, madePages = [], madeLinks = [], originalFlow = null, webFlow = null;
	var server = null, base = null, store = null, callFlows = null;
	var SID = 'zz-webpages-0000-0000-000000000001';

	before(async function () {
		this.timeout(20000);
		if (!webPages || !(await dbAvailable())) return this.skip();
		var postgres = await import('../src/middleware/db/postgres.js');
		var t = await postgres.query("SELECT table_name FROM information_schema.tables WHERE table_name IN ('web_pages', 'web_nav_items')", []);
		if (!t || t.length < 2) return this.skip();
		callFlows = await import('../src/models/callFlows.js');
		webFlow = await callFlows.getWebFlow();
		originalFlow = webFlow ? await callFlows.getWebFlowStages() : null;

		var appConfig = (await import('../src/config/appConfig.js')).default;
		await appConfig.load();
		var { router: pagesRouter } = await import('../src/routes/pages.js');
		var { router: callflowRouter } = await import('../src/routes/callflow.js');
		var dates = await import('../src/utils/dateFormat.js');
		var app = express();
		app.set('views', path.join(ROOT, 'src/views'));
		app.set('view engine', 'pug');
		app.use(function (req, res, next) {
			req.cookies = req.headers['x-test-session'] ? { sessionid: req.headers['x-test-session'] } : {};
			res.locals.formatTimestamp = dates.formatTimestamp;
			res.locals.timestampMs = dates.timestampMs;
			res.locals.formatFriendly = dates.formatFriendly;
			next();
		});
		app.use('/page', pagesRouter);
		app.use('/callflow', callflowRouter);
		app.use(function (req, res) { res.status(404).send('not found'); });
		app.use(function (err, req, res, next) { res.status(500).send(err.stack); });
		await new Promise(function (resolve) {
			server = app.listen(0, '127.0.0.1', function () { base = 'http://127.0.0.1:' + server.address().port; resolve(); });
		});
		ready = true;
	});
	beforeEach(function () { if (!ready) this.skip(); });

	after(async function () {
		if (!ready) return;
		var postgres = await import('../src/middleware/db/postgres.js');
		if (webFlow && originalFlow) await callFlows.updateFlow(webFlow.id, { stages: originalFlow });
		for (var l of madeLinks) await postgres.write('DELETE FROM web_nav_items WHERE id = $1', [l]);
		for (var p of madePages) await postgres.write('DELETE FROM web_pages WHERE id = $1', [p]);
		webPages.invalidateCache();
		webNav.invalidateCache();
		if (store) { try { await store.sessionDestroy(SID); } catch (_) {} }
		if (server) { server.closeAllConnections(); await new Promise(function (r) { server.close(r); }); }
	});

	async function make(form) {
		var r = await webPages.createPage(form);
		if (r.status) madePages.push(r.insertId);
		return r;
	}

	it('keeps addresses unique', async function () {
		var a = await make({ title: 'zz webpages open', slug: 'zz-webpages-open', body_html: '<p>zz open body</p>' });
		assert.strictEqual(a.status, true, a.errormessages.join());
		var b = await make({ title: 'zz dup', slug: 'zz-webpages-open' });
		assert.strictEqual(b.status, false);
		assert.match(b.errormessages[0], /already uses the address/);
	});

	it('serves a page to who it is for, asks a visitor to log in for a users page, and hides a draft', async function () {
		var open = await (await fetch(base + '/page/zz-webpages-open')).text();
		assert.match(open, /zz open body/);
		var members = await make({ title: 'zz webpages members', slug: 'zz-webpages-members', audience: 'users', body_html: '<p>members only</p>' });
		assert.strictEqual(members.status, true);
		var asVisitor = await fetch(base + '/page/zz-webpages-members', { redirect: 'manual' });
		assert.strictEqual(asVisitor.status, 302);
		assert.strictEqual(asVisitor.headers.get('location'), '/users/login?redirect=%2Fpage%2Fzz-webpages-members');
		assert.doesNotMatch(await asVisitor.text(), /members only/);
		if (await redisAvailable()) {
			store = await import('../src/middleware/db/sessionstore.js');
			await store.sessionStore(SID, { id: '999999', username: 'zz-webpages', security: '10', permissionflags: '[]', restrictionflags: '[]' }, 600);
			var asUser = await fetch(base + '/page/zz-webpages-members', { headers: { 'x-test-session': SID } });
			assert.strictEqual(asUser.status, 200);
			assert.match(await asUser.text(), /members only/);
			var high = await make({ title: 'zz webpages high', slug: 'zz-webpages-high', min_security: '200', body_html: '<p>high</p>' });
			var denied = await fetch(base + '/page/zz-webpages-high', { headers: { 'x-test-session': SID } });
			assert.strictEqual(denied.status, 403);
			assert.doesNotMatch(await denied.text(), /<p>high<\/p>/);
			assert.ok(high.status);
		}
		var draft = await make({ title: 'zz webpages draft', slug: 'zz-webpages-draft', active: 'false', body_html: '<p>draft</p>' });
		assert.ok(draft.status);
		assert.strictEqual((await fetch(base + '/page/zz-webpages-draft')).status, 404);
		assert.strictEqual((await fetch(base + '/page/zz-no-such-page')).status, 404);
	});

	it('changing the address keeps the link: links refer to the page by id', async function () {
		var id = madePages[0];
		var link = await webNav.createItem({ label: 'zz-webpages-link', target_type: 'page', target: String(id), active: 'false' });
		assert.strictEqual(link.status, true, link.errormessages.join());
		madeLinks.push(link.insertId);
		var moved = await webPages.updatePage(id, { title: 'zz webpages open', slug: 'zz-webpages-moved', body_html: '<p>zz open body</p>' });
		assert.strictEqual(moved.status, true, moved.errormessages.join());
		var pages = await webPages.getPagesForRender();
		var row = await webNav.getItemById(link.insertId);
		var links = webNav.buildNav([Object.assign({}, row, { active: true })], { user: null, isEnabled: function () { return true; }, pages: pages });
		assert.strictEqual(links[0].href, '/page/zz-webpages-moved');
		var bad = await webNav.createItem({ label: 'zz', target_type: 'page', target: '999999999', active: 'false' });
		assert.match(bad.errormessages[0], /page no longer exists/);
	});

	it('a page that is used cannot be removed until it is taken out', async function () {
		var id = madePages[0];
		var r = await webPages.deletePage(id);
		assert.strictEqual(r.status, false);
		assert.match(r.errormessages[0], /the navigation link zz-webpages-link/);
		if (webFlow) {
			var saved = await callFlows.updateFlow(webFlow.id, { stages: [{ stage: 'welcome' }, { stage: 'page', options: { page: id } }] });
			assert.strictEqual(saved.status, true, (saved.errormessages || []).join());
			var r2 = await webPages.deletePage(id);
			assert.match(r2.errormessages[0], /and the web call flow/);
		}
	});

	it('the flow serves a Page stage only as placed, and refuses a page that does not exist', async function () {
		if (!webFlow) return this.skip();
		var id = madePages[0];
		var ok = await fetch(base + '/callflow/stage/page?page=' + id);
		assert.strictEqual(ok.status, 200);
		assert.match(await ok.text(), /zz open body/);
		assert.strictEqual((await fetch(base + '/callflow/stage/page?page=' + madePages[1])).status, 404, 'a page not in the flow');
		var missing = await callFlows.updateFlow(webFlow.id, { stages: [{ stage: 'page', options: { page: 999999999 } }] });
		assert.strictEqual(missing.status, false);
		assert.match(missing.errormessages[0], /there is no page 999999999/);
	});

	it('a stage for a page the visitor cannot read sends nothing of it', async function () {
		if (!webFlow) return this.skip();
		var membersId = madePages[1];
		await callFlows.updateFlow(webFlow.id, { stages: [{ stage: 'page', options: { page: membersId } }] });
		var html = await (await fetch(base + '/callflow/stage/page?page=' + membersId)).text();
		assert.doesNotMatch(html, /members only/);
		assert.match(html, /not available/);
	});
});
