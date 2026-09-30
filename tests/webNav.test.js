// tests/webNav.test.js: the sysop-editable web navigation bar (#91 phase 3).
//
// The left side of the user navbar was written into user-nav.pug, which an
// update overwrites. It is now rows of web_nav_items. These tests pin that
// the default bar is the old one link for link, that each link is shown to
// exactly who it should be, that an address cannot carry a script, and that
// the storage refuses what would leave the bar in a state it cannot draw.
//
// Run: npx mocha --no-config --exit tests/webNav.test.js

import assert from 'assert';
import path from 'path';
import { fileURLToPath } from 'url';
import { dbAvailable } from './helpers/dbAvailable.js';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

var webNav = null, access = null, pug = null;
try {
	webNav = await import('../src/models/webNav.js');
	access = await import('../src/utils/areaAccess.js');
	pug = (await import('pug')).default;
} catch (_) { /* skip */ }

var nextId = 100;
function item(over) {
	return Object.assign({
		id: nextId++, parent_id: null, sort_order: nextId * 10, label: 'X', icon: null,
		target_type: 'builtin', target: 'messages', new_tab: false, audience: 'all',
		min_security: null, required_flags: [], prohibited_flags: [], active: true
	}, over);
}
var allOn = function () { return true; };
var labels = function (links) { return links.map(function (l) { return l.label; }); };
var visitor = null;
var user = { security: '20', permissionflags: '[]', restrictionflags: '[]' };
var sysop = { security: '255', permissionflags: '["Sysop"]', restrictionflags: '[]' };

describe('web nav: the default bar', function () {
	before(function () { if (!webNav) this.skip(); });

	it('is the bar the template used to hard-code, link for link', function () {
		var links = webNav.buildNav(webNav.DEFAULT_ITEMS, { user: visitor, isEnabled: allOn });
		assert.deepStrictEqual(links.map(function (l) { return [l.label, l.href]; }), [
			['Messages', '/messages'], ['Files', '/files'], ['Doors', '/doors'],
			['Chat', '/whosonline'], ['Wall', '/wall']
		]);
	});

	it('draws the same markup the template drew: one plain link per item, the current one marked', function () {
		var html = pug.renderFile(path.join(ROOT, 'src/views/includes/user-nav.pug'), {
			webNavItems: webNav.DEFAULT_ITEMS, buildWebNav: webNav.buildNav, navPath: '/files/area/X',
			activelink: 'files', currentuser: null, boardname: 'B'
		});
		var left = html.slice(html.indexOf('navbar-nav me-auto'), html.indexOf('navbar-nav ms-auto'));
		assert.strictEqual((left.match(/<a class="nav-link/g) || []).length, 5);
		assert.match(left, /<a class="nav-link active" href="\/files">Files<span class="visually-hidden"> \(current\)<\/span><\/a>/);
		assert.match(left, /<a class="nav-link" href="\/messages">Messages<\/a>/);
		assert.doesNotMatch(left, /target=|rel=/, 'no new-tab attributes on board links');
	});
});

describe('web nav: checking a link before it is saved', function () {
	before(function () { if (!webNav) this.skip(); });

	it('accepts a page on this board and fills in the defaults', function () {
		var r = webNav.validateItem({ label: ' Bulletins ', target_type: 'builtin', target: 'bulletins' });
		assert.deepStrictEqual(r.errors, []);
		assert.deepStrictEqual(r.item, {
			parent_id: null, label: 'Bulletins', icon: null, target_type: 'builtin', target: 'bulletins',
			new_tab: false, audience: 'all', min_security: null, required_flags: [], prohibited_flags: [], active: true
		});
	});

	it('refuses an address that is not http(s) or a path on this board', function () {
		var bad = ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,x', '//evil.example', '/\\evil.example',
			'ftp://x', 'http://', 'https:///x', '/has space', 'mailto:a@b', ''];
		for (var u of bad) {
			assert.ok(webNav.validateItem({ label: 'L', target_type: 'url', target: u }).errors.length > 0, JSON.stringify(u));
		}
		for (var ok of ['https://example.org', 'http://example.org/x?y=1', '/doors/play/lord', '/']) {
			assert.deepStrictEqual(webNav.validateItem({ label: 'L', target_type: 'url', target: ok }).errors, [], ok);
		}
	});

	it('refuses a missing label, a bad icon, an unknown page, a menu inside a menu, a bad audience or security', function () {
		var errs = function (f) { return webNav.validateItem(f).errors; };
		assert.match(errs({ target: 'files' })[0], /label is required/);
		assert.match(errs({ label: 'x'.repeat(65), target: 'files' })[0], /at most 64/);
		assert.match(errs({ label: 'L', target: 'files', icon: 'bad icon!' })[0], /Bootstrap icon/);
		assert.match(errs({ label: 'L', target: 'admin' })[0], /page on this board/);
		assert.match(errs({ label: 'L', target_type: 'dropdown', parent_id: '3' })[0], /cannot go inside another menu/);
		assert.match(errs({ label: 'L', target: 'files', audience: 'robots' })[0], /who sees/);
		for (var s of ['256', '-1', '5x', '1.5']) {
			assert.match(errs({ label: 'L', target: 'files', min_security: s })[0], /0 to 255/, s);
		}
		assert.match(errs({ label: 'L', target_type: 'popup' })[0], /points at/);
	});

	it('reads a form as a form: icon without bi-, blank security, flags one or many, unticked boxes', function () {
		var r = webNav.validateItem({ label: 'L', target: 'files', icon: 'bi-chat-dots', min_security: '',
			required_flags: 'Sysop', prohibited_flags: ['Banned', 'Underage'], active: 'false', new_tab: 'true' });
		assert.deepStrictEqual(r.errors, []);
		assert.strictEqual(r.item.icon, 'chat-dots');
		assert.strictEqual(r.item.min_security, null);
		assert.deepStrictEqual(r.item.required_flags, ['Sysop']);
		assert.deepStrictEqual(r.item.prohibited_flags, ['Banned', 'Underage']);
		assert.strictEqual(r.item.active, false);
		assert.strictEqual(r.item.new_tab, true);
		var menu = webNav.validateItem({ label: 'More', target_type: 'dropdown', target: 'files', new_tab: 'true' });
		assert.strictEqual(menu.item.target, null, 'a menu points at nothing');
		assert.strictEqual(menu.item.new_tab, false);
	});
});

describe('web nav: who sees each link', function () {
	before(function () { if (!webNav) this.skip(); });

	it('audience: visitors only, logged-in only, everyone', function () {
		var items = [item({ label: 'All' }), item({ label: 'Visitors', audience: 'public' }), item({ label: 'Users', audience: 'users' })];
		assert.deepStrictEqual(labels(webNav.buildNav(items, { user: visitor, isEnabled: allOn })), ['All', 'Visitors']);
		assert.deepStrictEqual(labels(webNav.buildNav(items, { user: user, isEnabled: allOn })), ['All', 'Users']);
	});

	it('security and flags, the rule menu entries use', function () {
		var items = [
			item({ label: 'Sec50', min_security: 50 }),
			item({ label: 'SysopOnly', required_flags: ['Sysop'] }),
			item({ label: 'NotBanned', prohibited_flags: ['Banned'] })
		];
		assert.deepStrictEqual(labels(webNav.buildNav(items, { user: user, isEnabled: allOn })), ['NotBanned']);
		assert.deepStrictEqual(labels(webNav.buildNav(items, { user: sysop, isEnabled: allOn })), ['Sec50', 'SysopOnly', 'NotBanned']);
		var banned = { security: '255', permissionflags: '["Sysop"]', restrictionflags: '["Banned"]' };
		assert.deepStrictEqual(labels(webNav.buildNav(items, { user: banned, isEnabled: allOn })), ['Sec50', 'SysopOnly']);
		assert.deepStrictEqual(labels(webNav.buildNav(items, { user: visitor, isEnabled: allOn })), ['NotBanned'], 'a visitor is security 0 with no flags');
	});

	it('hidden links, unknown pages, and pages whose feature is switched off are not shown', function () {
		var items = [item({ label: 'Off', active: false }), item({ label: 'Gone', target: 'nosuchpage' }),
			item({ label: 'QWK', target: 'qwk' }), item({ label: 'DS', target: 'doorserver' })];
		var onlyQwk = function (k) { return k === 'qwk_enabled'; };
		assert.deepStrictEqual(labels(webNav.buildNav(items, { user: user, isEnabled: onlyQwk })), ['QWK']);
	});

	it('the current page is marked by the route, or by its path when the route names none', function () {
		var items = [item({ label: 'Msgs', target: 'messages' }), item({ label: 'Bul', target: 'bulletins' }),
			item({ label: 'Home', target_type: 'url', target: '/' }), item({ label: 'Lord', target_type: 'url', target: '/doors/play/lord' })];
		var active = function (ctx) {
			return webNav.buildNav(items, Object.assign({ user: user, isEnabled: allOn }, ctx))
				.filter(function (l) { return l.active; }).map(function (l) { return l.label; });
		};
		assert.deepStrictEqual(active({ activelink: 'messages', path: '/messages/area/X' }), ['Msgs']);
		assert.deepStrictEqual(active({ activelink: '', path: '/bulletins/1234' }), ['Bul']);
		assert.deepStrictEqual(active({ activelink: '', path: '/doors/play/lord' }), ['Lord']);
		assert.deepStrictEqual(active({ activelink: '', path: '/bulletinsx' }), [], 'a prefix of the name is not the page');
		assert.deepStrictEqual(active({ activelink: '', path: '/anything' }), [], '"/" does not claim every page');
	});

	it('a menu shows its visible links, disappears when it has none, and is current when one of them is', function () {
		var menu = item({ label: 'More', target_type: 'dropdown', target: null });
		var items = [menu,
			item({ label: 'Bul', target: 'bulletins', parent_id: menu.id }),
			item({ label: 'SysopTools', target: 'stats', parent_id: menu.id, required_flags: ['Sysop'] })];
		var forUser = webNav.buildNav(items, { user: user, isEnabled: allOn, path: '/bulletins' });
		assert.deepStrictEqual(forUser.map(function (l) { return [l.label, labels(l.children), l.active]; }), [['More', ['Bul'], true]]);
		assert.strictEqual(forUser[0].href, null);
		var noKids = [menu, item({ label: 'SysopTools', target: 'stats', parent_id: menu.id, required_flags: ['Sysop'] })];
		assert.deepStrictEqual(webNav.buildNav(noKids, { user: user, isEnabled: allOn }), [], 'an empty menu is not drawn');
	});

	it('a link whose menu is gone is shown at the top rather than lost; a menu inside a menu is not drawn', function () {
		var items = [item({ label: 'Orphan', parent_id: 99999 }),
			item({ label: 'Nested', target_type: 'dropdown', target: null, parent_id: 5 })];
		assert.deepStrictEqual(labels(webNav.buildNav(items, { user: user, isEnabled: allOn })), ['Orphan']);
	});

	it('an address gets a new tab and noopener when asked, and external addresses are marked', function () {
		var items = [item({ label: 'Out', target_type: 'url', target: 'https://example.org', new_tab: true })];
		var html = pug.renderFile(path.join(ROOT, 'src/views/includes/user-nav.pug'), {
			webNavItems: items, buildWebNav: webNav.buildNav, navPath: '/', activelink: '', currentuser: null
		});
		assert.match(html, /<a class="nav-link" href="https:\/\/example.org" target="_blank" rel="noopener">Out<\/a>/);
	});
});

describe('web nav: the shared access rule', function () {
	before(function () { if (!access) this.skip(); });

	it('treats a prohibited flag held as a permission or a restriction alike, as menu entries do', function () {
		var rule = { prohibited_flags: ['Adult'] };
		assert.strictEqual(access.checkEntryAccess({ permissionflags: ['Adult'] }, rule), false);
		assert.strictEqual(access.checkEntryAccess({ restrictionflags: ['Adult'] }, rule), false);
		assert.strictEqual(access.checkEntryAccess({ permissionflags: [] }, rule), true);
		assert.strictEqual(access.checkEntryAccess(null, { min_security: 0 }), true);
		assert.strictEqual(access.checkEntryAccess(null, { min_security: 1 }), false);
		assert.strictEqual(access.checkEntryAccess(null, null), false);
	});
});

describe('web nav: storage', function () {
	this.timeout(20000);
	var ready = false;
	var made = [];

	before(async function () {
		if (!webNav || !(await dbAvailable())) return this.skip();
		var postgres = await import('../src/middleware/db/postgres.js');
		var t = await postgres.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'web_nav_items'", []);
		if (!t || t.length === 0) return this.skip();
		ready = true;
	});
	beforeEach(function () { if (!ready) this.skip(); });

	after(async function () {
		if (!ready) return;
		var postgres = await import('../src/middleware/db/postgres.js');
		// Children first, then menus
		for (var id of made.slice().reverse()) await postgres.write('DELETE FROM web_nav_items WHERE id = $1', [id]);
		webNav.invalidateCache();
	});

	// Hidden, so a test link never shows on the dev board's live bar
	async function add(form) {
		var r = await webNav.createItem(Object.assign({ active: 'false' }, form));
		if (r.status) made.push(r.insertId);
		return r;
	}

	it('puts a link in a menu, and refuses a parent that is not a menu', async function () {
		var menu = await add({ label: 'zz-webnav-menu', target_type: 'dropdown' });
		assert.strictEqual(menu.status, true, menu.errormessages.join());
		var link = await add({ label: 'zz-webnav-link', target: 'bulletins', parent_id: String(menu.insertId) });
		assert.strictEqual(link.status, true, link.errormessages.join());
		var bad = await add({ label: 'zz-webnav-bad', target: 'files', parent_id: String(link.insertId) });
		assert.strictEqual(bad.status, false);
		assert.match(bad.errormessages[0], /is not a menu/);
		var gone = await add({ label: 'zz-webnav-bad', target: 'files', parent_id: '99999999' });
		assert.match(gone.errormessages[0], /no longer exists/);
	});

	it('will not remove a menu that holds links, or turn it into a link', async function () {
		var menuId = made[0];
		var del = await webNav.deleteItem(menuId);
		assert.strictEqual(del.status, false);
		assert.match(del.errormessages[0], /holds links/);
		var change = await webNav.updateItem(menuId, { label: 'zz-webnav-menu', target_type: 'builtin', target: 'files', active: 'false' });
		assert.strictEqual(change.status, false);
		assert.match(change.errormessages[0], /holds links/);
		assert.strictEqual((await webNav.getItemById(menuId)).target_type, 'dropdown');
	});

	it('reorders among neighbours only', async function () {
		var a = await add({ label: 'zz-webnav-a', target: 'files' });
		var b = await add({ label: 'zz-webnav-b', target: 'doors' });
		var ok = await webNav.reorderItems([b.insertId, a.insertId]);
		assert.strictEqual(ok.status, true);
		var ra = await webNav.getItemById(a.insertId), rb = await webNav.getItemById(b.insertId);
		assert.ok(rb.sort_order < ra.sort_order);
		var mixed = await webNav.reorderItems([a.insertId, made[1]]);
		assert.strictEqual(mixed.status, false);
		assert.match(mixed.errormessages[0], /among their neighbours/);
	});

	it('a save that is refused changes nothing', async function () {
		var id = made[made.length - 1];
		var before = await webNav.getItemById(id);
		var r = await webNav.updateItem(id, { label: 'zz', target_type: 'url', target: 'javascript:alert(1)' });
		assert.strictEqual(r.status, false);
		assert.deepStrictEqual(await webNav.getItemById(id), before);
	});
});
