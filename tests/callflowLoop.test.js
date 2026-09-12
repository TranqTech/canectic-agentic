// tests/callflowLoop.test.js: the web call flow forcing itself for ever.
//
// Reported as an older browser window being sent back to the call flow on
// every page, endlessly, while a newer window on the same account was fine.
//
// last_callflow_at is cached on the session so the trigger check does not hit
// the database on every request. That cache has no expiry of its own. It is
// corrected only by an explicit write, and the write that matters is the one
// the call flow makes when it completes.
//
// Completion broadcast that write to every session in the username index, and
// fell back to writing the current session only when the broadcast had updated
// nothing at all. The index is written once at login and given its own expiry,
// while the session hash is renewed on every page view, so a Remember Me
// session outlives its index entry by days. Once it has dropped out and the
// user has any newer session, the broadcast returns a non-zero count, the
// fallback is skipped, and the older window's cache is never corrected. Every
// request sees a stale timestamp, forces the call flow, and completing it
// changes nothing.
//
// Three things had to be true for it to be endless, and each is closed here:
// the index dropped the session, completion did not write the session in front
// of it, and nothing ever re-read the authoritative value from the database.
//
// Run: npx mocha

import assert from 'assert';
import { redisAvailable } from './helpers/redisAvailable.js';

var cf = null;
try { cf = await import('../src/utils/callflowTrigger.js'); } catch (_) { /* skip */ }

describe('callflowTrigger.evaluateCallflow', function () {
	before(function () { if (!cf) this.skip(); });

	var NOW = 1_700_000_000_000;
	var hoursAgo = function (h) { return String(NOW - h * 3600000); };

	it('leaves a user who went through it recently alone', function () {
		var r = cf.evaluateCallflow({ last_callflow_at: hoursAgo(1), _callflow_checked: 'true' }, NOW);
		assert.strictEqual(r.force, false);
		assert.strictEqual(r.pending, false);
	});

	it('offers it after a couple of hours', function () {
		var r = cf.evaluateCallflow({ last_callflow_at: hoursAgo(3), _callflow_checked: 'true' }, NOW);
		assert.strictEqual(r.pending, true);
		assert.strictEqual(r.force, false);
	});

	it('forces it after a day', function () {
		var r = cf.evaluateCallflow({ last_callflow_at: hoursAgo(30), _callflow_checked: 'true' }, NOW);
		assert.strictEqual(r.force, true);
	});

	it('stops forcing the moment the cached timestamp is brought up to date', function () {
		// The heart of the loop. The same session, before and after the write
		// that completion is supposed to make. If the second case still forces,
		// completing the flow cannot end it.
		var stale = { last_callflow_at: hoursAgo(30), _callflow_checked: 'true' };
		assert.strictEqual(cf.evaluateCallflow(stale, NOW).force, true);

		var fresh = { last_callflow_at: String(NOW), _callflow_checked: 'true' };
		assert.strictEqual(cf.evaluateCallflow(fresh, NOW).force, false);
	});

	it('asks for a database lookup only when nothing is cached yet', function () {
		assert.strictEqual(cf.evaluateCallflow({}, NOW).needsLookup, true);
		// Already looked up and genuinely never completed one: do not look
		// again on every request.
		assert.strictEqual(
			cf.evaluateCallflow({ last_callflow_at: '0', _callflow_checked: 'true' }, NOW).needsLookup, false);
	});

	it('forces it for a user who has never been through it', function () {
		var r = cf.evaluateCallflow({ last_callflow_at: '0', _callflow_checked: 'true' }, NOW);
		assert.strictEqual(r.force, true);
		assert.strictEqual(r.hoursSince, cf.NEVER_HOURS);
	});

	it('does not trust a cached value that is not a number', function () {
		var r = cf.evaluateCallflow({ last_callflow_at: 'banana', _callflow_checked: 'true' }, NOW);
		assert.strictEqual(r.force, true);
	});

	it('raises the prompt from the idle-resume flag whatever the clock says', function () {
		var r = cf.evaluateCallflow(
			{ last_callflow_at: hoursAgo(1), _callflow_checked: 'true', callflow_pending: 'true' }, NOW);
		assert.strictEqual(r.pending, true);
		assert.strictEqual(r.force, false);
	});
});

describe('callflowTrigger.isRedirectablePath', function () {
	before(function () { if (!cf) this.skip(); });

	it('never redirects the call flow to itself', function () {
		// The immediate loop, as opposed to the slow one above.
		assert.strictEqual(cf.isRedirectablePath('/callflow', 'GET'), false);
		assert.strictEqual(cf.isRedirectablePath('/callflow/newmail', 'GET'), false);
	});

	it('leaves login and logout reachable', function () {
		// Trapping a user away from logout would make the loop unescapable.
		assert.strictEqual(cf.isRedirectablePath('/users/login', 'GET'), false);
		assert.strictEqual(cf.isRedirectablePath('/users/logout', 'GET'), false);
	});

	it('does not redirect a non-GET', function () {
		assert.strictEqual(cf.isRedirectablePath('/messages', 'POST'), false);
	});

	it('redirects an ordinary page', function () {
		assert.strictEqual(cf.isRedirectablePath('/messages', 'GET'), true);
		assert.strictEqual(cf.isRedirectablePath('/files', 'GET'), true);
	});
});

describe('sessionRenew keeps the username index alive', function () {
	this.timeout(20000);

	var store = null, redis = null, haveRedis = false;
	var USER = 'zz-callflow-loop-test';
	var SID  = 'zz-callflow-0000-0000-000000000001';

	before(async function () {
		this.timeout(15000);
		haveRedis = await redisAvailable();
		if (!haveRedis) return;
		var appConfig = (await import('../src/config/appConfig.js')).default;
		await appConfig.load();
		store = await import('../src/middleware/db/sessionstore.js');
		redis = await import('../src/middleware/db/redis.js');
	});

	beforeEach(function () { if (!haveRedis) this.skip(); });

	afterEach(async function () {
		if (!haveRedis) return;
		try {
			await store.sessionDestroy(SID);
			var rc = await redis.getClient();
			await rc.del('session_index:' + USER);
		} catch (_) {}
	});

	it('puts a session back in the index after the index has expired', async function () {
		// The root cause. The index is written at login with its own expiry and
		// never touched again, while the session hash is renewed on every page
		// view. Deleting the index key is exactly what its expiry does.
		await store.sessionStore(SID, { id: '4242', username: USER }, 3600);

		var rc = await redis.getClient();
		var inIndex = async function () {
			// node-redis returns 0/1 here rather than a boolean.
			return !!(await rc.sIsMember('session_index:' + USER, SID));
		};

		await rc.del('session_index:' + USER);
		assert.strictEqual(await inIndex(), false, 'index cleared for the test');

		await store.sessionRenew(SID);

		assert.strictEqual(await inIndex(), true,
			'a renewed session belongs in the index again');
	});

	it('so a broadcast update reaches a session that had dropped out', async function () {
		// What the index being wrong actually costs: sessionUpdateUser is how
		// completion tells every window it is done, and it can only reach
		// sessions the index knows about.
		await store.sessionStore(SID, { id: '4242', username: USER, last_callflow_at: '0' }, 3600);

		var rc = await redis.getClient();
		await rc.del('session_index:' + USER);

		assert.strictEqual(await store.sessionUpdateUser(USER, { last_callflow_at: '111' }), 0,
			'unreachable while it is out of the index');

		await store.sessionRenew(SID);
		assert.strictEqual(await store.sessionUpdateUser(USER, { last_callflow_at: '222' }), 1);

		var sess = await store.sessionGet(SID);
		assert.strictEqual(sess.last_callflow_at, '222');
	});
});
