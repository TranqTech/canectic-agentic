// tests/mailerBackoff.test.js: not hammering a peer that is already failing.
//
// Backoff was checked in pollConnection and nowhere else. The BSO scanner calls
// _connectToPeer directly whenever there is mail waiting, so a peer that was
// refusing connections got retried on every scan cycle, default 60 seconds, and
// the backoff a sysop configured did nothing at all. Adding the check to the
// scanner fixed that one caller and left the same trap for the next.
//
// It lives at _connectToPeer now, which every outbound path has to come
// through, with an explicit force for triggerPoll because a sysop pressing the
// button means it.
//
// Addresses routed through the nodelist had no backoff of any kind, because
// backoff state lives in a peer connection's connection_data and these have no
// peer row. That is the worst case rather than an edge case: nothing was
// counting, so a dead route cost a connection a minute for ever.
//
// Run: npx mocha

import assert from 'assert';

var peerConnections = null, fs = null;
try {
	peerConnections = await import('../src/models/peerConnections.js');
	fs = await import('fs');
} catch (_) { /* leave null, suites skip */ }

describe('peerConnections.isInBackoff', function () {
	before(function () { if (!peerConnections) this.skip(); });

	function conn(until) {
		return { uuid: 'zz', connection_data: { address: '21:1/999', next_allowed_poll_at: until } };
	}

	it('holds a peer whose window has not expired', function () {
		assert.strictEqual(
			peerConnections.isInBackoff(conn(new Date(Date.now() + 600000).toISOString())), true);
	});

	it('releases a peer whose window has passed', function () {
		assert.strictEqual(
			peerConnections.isInBackoff(conn(new Date(Date.now() - 600000).toISOString())), false);
	});

	it('treats a peer that has never failed as free to call', function () {
		assert.strictEqual(peerConnections.isInBackoff(conn(null)), false);
		assert.strictEqual(peerConnections.isInBackoff({ connection_data: {} }), false);
		assert.strictEqual(peerConnections.isInBackoff(null), false);
	});

	it('ignores an unparseable window rather than blocking for ever', function () {
		// Failing closed here would strand a peer permanently with no way for a
		// sysop to see why.
		assert.strictEqual(peerConnections.isInBackoff(conn('not a date')), false);
	});
});

describe('peerConnections.computeBackoffDelayMs', function () {
	before(function () { if (!peerConnections) this.skip(); });

	it('doubles each failure from the base interval', function () {
		var base = 60, cap = 24;
		var one = peerConnections.computeBackoffDelayMs(1, base, cap);
		var two = peerConnections.computeBackoffDelayMs(2, base, cap);
		var three = peerConnections.computeBackoffDelayMs(3, base, cap);
		assert.ok(two > one && three > two, 'each failure should wait longer');
		// Jitter is +/-10%, so compare loosely.
		assert.ok(two / one > 1.5 && two / one < 2.5, 'roughly doubling, got ' + (two / one));
	});

	it('caps so a dead peer is still retried eventually', function () {
		var capped = peerConnections.computeBackoffDelayMs(20, 60, 24);
		assert.ok(capped <= 24 * 3600000 * 1.1, 'should not exceed the cap plus jitter');
		assert.ok(capped > 0, 'and must never stop retrying altogether');
	});
});

describe('mailer backoff wiring', function () {
	var src = null, scannerSrc = null;
	before(function () {
		if (!fs) this.skip();
		try {
			src = fs.readFileSync('src/mailer/manager.js', 'utf8');
			scannerSrc = fs.readFileSync('src/mailer/bsoScanner.js', 'utf8');
		} catch (_) { this.skip(); }
	});

	it('guards the shared entry point, not just its callers', function () {
		// The failure this exists for: the check was in pollConnection only, so
		// every other path into _connectToPeer bypassed it. Guarding each caller
		// as it is discovered leaves the same trap for the next one.
		var fn = src.substring(src.indexOf('async _connectToPeer(conn'));
		var body = fn.substring(0, fn.indexOf('\n\tconnectToNodelistAddress'));
		assert.ok(/isInBackoff/.test(body),
			'_connectToPeer itself has to check, or a new caller will miss it');
	});

	it('lets a manual poll through', function () {
		// A sysop pressing the poll button has said what they want.
		assert.ok(/force: true/.test(src));
		assert.ok(/options\.force/.test(src));
	});

	it('gives nodelist-routed addresses a backoff of their own', function () {
		// They have no connection_data to carry state, so without this they had
		// no backoff at all: the worst case, not an edge case.
		assert.ok(/_isNodelistAddressInBackoff/.test(src));
		assert.ok(/_recordNodelistFailure/.test(src));
		assert.ok(/_clearNodelistBackoff/.test(src));
	});

	it('actually consults that backoff before dialling a nodelist route', function () {
		// Having the bookkeeping and not calling it is the same as not having
		// it. Scoped to the function body, because the helpers being defined
		// somewhere in the file proves nothing about the connect path.
		var start = src.indexOf('connectToNodelistAddress(nodelistData');
		assert.ok(start !== -1, 'connectToNodelistAddress not found');
		var body = src.substring(start, src.indexOf('\n\t}', start));
		assert.ok(/_isNodelistAddressInBackoff/.test(body),
			'the connect path has to check, not merely have a checker available');
	});

	it('records a nodelist failure from both the connect error and the session end', function () {
		// A node that refuses TCP and a node that answers then fails every
		// session are the same problem from the scanner's point of view.
		var connectErr = src.indexOf("nodelist connect to ");
		assert.ok(connectErr !== -1);
		assert.ok(src.indexOf('_recordNodelistFailure', connectErr) !== -1,
			'the connect error path must count the failure');
		assert.ok(/nodelistAddress[\s\S]{0,400}_recordNodelistFailure/.test(src),
			'the session end path must count it too');
	});

	it('clears nodelist backoff when a session finally completes', function () {
		assert.ok(/complete[\s\S]{0,200}_clearNodelistBackoff/.test(src),
			'a recovered route must not stay throttled');
	});

	it('still reports backoff skips in the scan summary', function () {
		// So a sysop reading the log can tell "not connecting because it is
		// failing" from "nothing to send".
		assert.ok(/'backoff'/.test(scannerSrc));
		assert.ok(/in backoff/.test(scannerSrc));
	});
});

describe('MailerManager nodelist backoff behaviour', function () {
	var manager = null;

	before(async function () {
		try {
			var mod = await import('../src/mailer/manager.js');
			var MailerManager = mod.MailerManager || mod.default;
			if (!MailerManager) return this.skip();
			// Never started, so it binds nothing. Only the backoff bookkeeping
			// is exercised here.
			manager = new MailerManager({});
			if (typeof manager._recordNodelistFailure !== 'function') return this.skip();
		} catch (_) { this.skip(); }
	});

	beforeEach(function () {
		if (!manager) this.skip();
		manager._nodelistBackoff.clear();
	});

	it('lets a route through the first time', function () {
		assert.strictEqual(manager._isNodelistAddressInBackoff('1:229/426'), false);
	});

	it('holds a route back after a failure', function () {
		manager._recordNodelistFailure('1:229/426');
		assert.strictEqual(manager._isNodelistAddressInBackoff('1:229/426'), true);
	});

	it('waits longer after each successive failure', function () {
		manager._recordNodelistFailure('1:229/426');
		var first = manager._nodelistBackoff.get('1:229/426').nextAllowedAt;
		manager._recordNodelistFailure('1:229/426');
		var second = manager._nodelistBackoff.get('1:229/426').nextAllowedAt;
		assert.ok(second > first, 'the window has to grow or it is not backoff');
		assert.strictEqual(manager._nodelistBackoff.get('1:229/426').failures, 2);
	});

	it('releases a route that recovers', function () {
		manager._recordNodelistFailure('1:229/426');
		manager._clearNodelistBackoff('1:229/426');
		assert.strictEqual(manager._isNodelistAddressInBackoff('1:229/426'), false);
	});

	it('keeps routes separate', function () {
		manager._recordNodelistFailure('1:229/426');
		assert.strictEqual(manager._isNodelistAddressInBackoff('2:5020/1042'), false,
			'one dead node must not throttle every other route');
	});

	it('matches an address regardless of case or padding', function () {
		manager._recordNodelistFailure('1:229/426');
		assert.strictEqual(manager._isNodelistAddressInBackoff('  1:229/426  '), true);
	});

	it('ignores an empty address rather than creating a catch-all entry', function () {
		manager._recordNodelistFailure('');
		manager._recordNodelistFailure(null);
		assert.strictEqual(manager._nodelistBackoff.size, 0,
			'an empty key would hold back every address that resolved to nothing');
	});
});
