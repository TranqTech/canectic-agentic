// tests/maintenanceWeb.test.js: the web side of maintenance mode.
//
// Anonymous visitors get the maintenance page at once. Logged-in users get a
// countdown, pushed to open pages and rendered on every page they load, then
// the maintenance page on non-admin routes once the grace runs out. Sysops
// keep the whole site. The REST API gets a JSON 503. Web users are told and
// not waited for.
//
// Run: npx mocha --no-config --exit tests/maintenanceWeb.test.js

import assert from 'assert';
import * as path from 'path';
import { fileURLToPath } from 'url';

var REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

var web = null, webDrain = null, banner = null, pug = null;
try {
	web = await import('../src/middleware/maintenanceWeb.js');
	webDrain = await import('../src/maintenance/webDrain.js');
	banner = await import('../public/js/maintenanceBanner.js');
	pug = (await import('pug')).default;
} catch (_) { /* suites skip */ }

describe('maintenance web decision', function () {
	before(function () { if (!web) this.skip(); });

	function d(over) {
		return web.decide(Object.assign({ active: true, path: '/messages', loggedIn: false,
			isSysop: false, pastDeadline: false }, over));
	}

	it('passes everything while the board is open', function () {
		assert.strictEqual(d({ active: false }), 'pass');
	});

	it('shows an anonymous visitor the maintenance page straight away', function () {
		assert.strictEqual(d({}), 'page');
		assert.strictEqual(d({ path: '/' }), 'page');
	});

	it('gives a logged-in user the countdown until the grace runs out', function () {
		assert.strictEqual(d({ loggedIn: true }), 'countdown');
	});

	it('shows a logged-in user the maintenance page once the grace has run out', function () {
		assert.strictEqual(d({ loggedIn: true, pastDeadline: true }), 'page');
	});

	it('lets a sysop use the whole site', function () {
		assert.strictEqual(d({ loggedIn: true, isSysop: true, pastDeadline: true }), 'pass');
	});

	it('keeps the admin, the log viewer, the health check and the way in open to everyone', function () {
		for (var p of ['/admin', '/admin/maintenance', '/adminlogs', '/health', '/users/login', '/users/logout']) {
			assert.strictEqual(d({ path: p, pastDeadline: true }), 'pass', p);
		}
	});

	it('does not mistake a lookalike path for the admin', function () {
		assert.strictEqual(d({ path: '/administrator' }), 'page');
		assert.strictEqual(d({ path: '/users/register' }), 'page', 'registration is not the way in');
	});

	it('answers the REST API in JSON', function () {
		assert.strictEqual(d({ path: '/api/v1/me' }), 'json');
	});

	it('recognises a sysop from a session, with flags stored either way', function () {
		assert.strictEqual(web.isSysop({ security: 255, permissionflags: ['Sysop'] }), true);
		assert.strictEqual(web.isSysop({ security: '255', permissionflags: '["Sysop"]' }), true);
		assert.strictEqual(web.isSysop({ security: 255, permissionflags: [] }), false);
		assert.strictEqual(web.isSysop({ security: 10, permissionflags: ['Sysop'] }), false);
		assert.strictEqual(web.isSysop(null), false);
	});
});

describe('maintenance web view model', function () {
	before(function () { if (!web) this.skip(); });

	it('asks crawlers to come back when the board expects to be back', function () {
		var now = Date.now();
		var vm = web.viewModel({ flag: { reason: 'x', since: new Date(now).toISOString() },
			deadline: new Date(now + 60000), expectedBack: new Date(now + 1800000) }, now);
		assert.strictEqual(vm.retryAfter, 1800);
		assert.strictEqual(vm.reason, 'x');
	});

	it('suggests ten minutes when nobody said', function () {
		var vm = web.viewModel({ flag: {}, deadline: new Date(), expectedBack: null });
		assert.strictEqual(vm.retryAfter, 600);
	});
});

describe('the maintenance pages render', function () {
	before(function () { if (!pug) this.skip(); });

	it('renders the visitor page with a reason and a return time', function () {
		var html = pug.renderFile(path.join(REPO, 'src/views/maintenance.pug'), {
			boardName: 'Test BBS', reason: 'Rebuilding areas', expectedBack: new Date(Date.now() + 1800000).toISOString()
		});
		assert.ok(html.includes('Test BBS'));
		assert.ok(html.includes('closed for maintenance'));
		assert.ok(html.includes('Rebuilding areas'));
		assert.ok(html.includes('Expected back around'));
		assert.ok(html.includes('/css/custom.css'), 'the sysop branding must carry over');
	});

	it('renders the visitor page with nothing but a board name', function () {
		var html = pug.renderFile(path.join(REPO, 'src/views/maintenance.pug'), { boardName: 'Test BBS' });
		assert.ok(html.includes('check back'));
	});

	it('renders the admin page closed and open', function () {
		var base = { currentuser: { name: 'sysop' }, sufficientAccess: true, title: 'Maintenance Mode',
			activenav: 'maintenance', graceDefault: 300, flash: [] };
		var since = new Date().toISOString();
		var closed = pug.renderFile(path.join(REPO, 'src/views/admin/maintenance/index.pug'), Object.assign({}, base, {
			maintenance: { deadline: since },
			status: { active: true, flag: { reason: 'r', since: since, source: 'update', run_id: 'abc',
				expected_minutes: 30, grace_seconds: 60, set_by: 'x' },
				deadline: new Date(), expectedBack: new Date(),
				drain: { drained: false, reporting: 1, processes: [{ process: 'worker', state: 'draining', pendingText: '1 toss jobs' }] } }
		}));
		assert.ok(closed.includes('The board is closed'));
		assert.ok(closed.includes('set by an update'));
		assert.ok(closed.includes('1 toss jobs'));
		var open = pug.renderFile(path.join(REPO, 'src/views/admin/maintenance/index.pug'), Object.assign({}, base, {
			status: { active: false, flag: null, drain: null }
		}));
		assert.ok(open.includes('Close the board'));
	});

	it('shows the admin banner on admin pages while the board is closed', function () {
		var html = pug.renderFile(path.join(REPO, 'src/views/admin/maintenance/index.pug'), {
			currentuser: { name: 'sysop' }, sufficientAccess: true, graceDefault: 300, flash: [],
			maintenance: { deadline: new Date().toISOString(), reason: 'r' },
			status: { active: false, flag: null, drain: null }
		});
		var tag = html.substring(html.indexOf('id="maintenance-banner"') - 200, html.indexOf('id="maintenance-banner"') + 400);
		assert.ok(/data-mode="admin"/.test(tag), tag);
		assert.ok(!/ hidden/.test(tag.substring(0, tag.indexOf('>', 200))), 'the banner must be visible: ' + tag);
	});
});

describe('the maintenance middleware', function () {
	var watchMod = null, flags = null, root = null, fs = null, os = null;

	before(async function () {
		if (!web) return this.skip();
		watchMod = await import('../src/maintenance/maintenanceWatch.js');
		flags = await import('../src/maintenance/maintenanceFlag.js');
		fs = await import('fs');
		os = await import('os');
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-mweb-'));
		watchMod._resetForTests();
		watchMod.initMaintenanceWatch({ process: 'gateway', root: root, intervalMs: 1000000 });
	});
	after(function () {
		if (watchMod) watchMod._resetForTests();
		if (root) fs.rmSync(root, { recursive: true, force: true });
	});
	afterEach(function () {
		if (flags) { flags.leaveMaintenance(root); watchMod.maintenanceWatch().refreshNow(); }
	});

	function fakeRes() {
		var res = { locals: {}, headers: {}, code: null, view: null, body: null };
		res.set = function (k, v) { res.headers[k] = v; return res; };
		res.status = function (c) { res.code = c; return res; };
		res.render = function (v) { res.view = v; };
		res.json = function (b) { res.body = b; };
		return res;
	}

	async function run(reqPath) {
		var res = fakeRes(), passed = false;
		await web.maintenanceMiddleware()({ path: reqPath, cookies: {} }, res, function () { passed = true; });
		return { res: res, passed: passed };
	}

	function close(info) {
		flags.enterMaintenance(root, Object.assign({ grace_seconds: 600, reason: 'Update' }, info || {}));
		watchMod.maintenanceWatch().refreshNow();
	}

	it('does nothing while the board is open', async function () {
		var r = await run('/');
		assert.strictEqual(r.passed, true);
		assert.strictEqual(r.res.locals.maintenance, undefined);
	});

	it('sends an anonymous visitor the maintenance page as a temporary outage', async function () {
		close({ expected_minutes: 30 });
		var r = await run('/messages');
		assert.strictEqual(r.passed, false);
		assert.strictEqual(r.res.view, 'maintenance');
		assert.strictEqual(r.res.code, 503, 'what keeps the maintenance page out of search indexes');
		assert.ok(parseInt(r.res.headers['Retry-After'], 10) > 0);
	});

	it('answers the API in JSON', async function () {
		close();
		var r = await run('/api/v1/me');
		assert.strictEqual(r.res.code, 503);
		assert.strictEqual(r.res.body.error, 'maintenance');
		assert.ok(/Update/.test(r.res.body.message));
	});

	it('lets the admin through, with the state for the banner', async function () {
		close();
		var r = await run('/admin/maintenance');
		assert.strictEqual(r.passed, true);
		assert.ok(r.res.locals.maintenance && r.res.locals.maintenance.deadline);
	});
});

describe('the web countdown blast', function () {
	before(function () { if (!webDrain) this.skip(); });

	function fakeWatch(state, past) {
		var handlers = {};
		return {
			on: function (e, fn) { handlers[e] = fn; },
			current: function () { return state; },
			pastDeadline: function () { return !!past; },
			fire: function (e) { return handlers[e] && handlers[e](state.flag); }
		};
	}

	function state(graceMs) {
		return { active: true, flag: { reason: 'Update', since: new Date().toISOString() },
			deadline: new Date(Date.now() + graceMs), expectedBack: new Date(Date.now() + 3600000) };
	}

	it('pushes the countdown to every open page and notifies each user once', async function () {
		var pushed = [], notified = [];
		var presence = { broadcast: function (m) { pushed.push(m); }, connectedUserIds: function () { return [1, 2]; } };
		var notifications = { create: async function (uid, type, title, body, opts) { notified.push({ uid: uid, type: type, body: body, opts: opts }); } };
		var w = fakeWatch(state(300000));
		webDrain.attachWebDrain(w, presence, notifications);

		await w.fire('enter');
		assert.strictEqual(pushed.length, 1);
		assert.strictEqual(pushed[0].type, 'maintenance');
		assert.ok(pushed[0].deadline);
		assert.deepStrictEqual(notified.map(function (n) { return n.uid; }), [1, 2]);
		assert.strictEqual(notified[0].type, 'maintenance');
		assert.strictEqual(notified[0].opts.severity, 'warning');
		assert.ok(/in 5 minutes/.test(notified[0].body), notified[0].body);

		await w.fire('change');
		assert.strictEqual(pushed.length, 2, 'an edit updates the banner');
		assert.strictEqual(notified.length, 2, 'but does not fill everybody\'s bell again');

		await w.fire('leave');
		assert.strictEqual(pushed[2].type, 'maintenance_clear');
	});

	it('does not tell anyone the board is closing when it already has', async function () {
		// The gateway restarting during an update fires enter on a closed board.
		var notified = [];
		var presence = { broadcast: function () {}, connectedUserIds: function () { return [1]; } };
		var w = fakeWatch(state(-1000), true);
		webDrain.attachWebDrain(w, presence, { create: async function (uid) { notified.push(uid); } });
		await w.fire('enter');
		assert.strictEqual(notified.length, 0);
	});
});

describe('the countdown banner text', function () {
	before(function () { if (!banner) this.skip(); });

	it('formats the time left', function () {
		assert.strictEqual(banner.formatRemaining(305000), '5:05');
		assert.strictEqual(banner.formatRemaining(3723000), '1:02:03');
		assert.strictEqual(banner.formatRemaining(-5), '0:00');
	});

	it('counts down for a user and reassures them about what they post', function () {
		var now = Date.now();
		var t = banner.bannerText({ mode: 'countdown', deadline: new Date(now + 120000).toISOString(), reason: 'Update' }, now);
		assert.ok(/closes for maintenance in 2:00/.test(t), t);
		assert.ok(/Update/.test(t));
		assert.ok(/post before then is kept/.test(t));
	});

	it('tells a sysop the board is closed and when callers go', function () {
		var now = Date.now();
		assert.ok(/disconnected in 1:00/.test(banner.bannerText({ mode: 'admin', deadline: new Date(now + 60000).toISOString() }, now)));
		assert.ok(/being refused/.test(banner.bannerText({ mode: 'admin', deadline: new Date(now - 1).toISOString() }, now)));
	});
});
