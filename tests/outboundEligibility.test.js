// tests/outboundEligibility.test.js: which messages may be sent to which node.
//
// This is the decision that broke. A filter suppressed any message whose
// source_network_id matched the peer's network, which sounds like loop
// prevention and is actually a description of a hub's entire job: mail arrives
// from an uplink on network N and must go out to downlinks, which are also on
// network N. On the reporting system it suppressed 127 of 129 messages, leaving
// only locally posted mail.
//
// It went unnoticed because the decision lived inline in a function that also
// wrote packets and advanced watermarks, so there was no way to ask "would this
// be sent?" without sending it. evaluateOutbound exists to make that question
// answerable, and these tests are the point of extracting it.
//
// The headline case is "a hub forwards". The rest guard the checks that
// replaced the removed one, so tightening loop prevention cannot quietly become
// a new blocker.
//
// Pure: no database needed.
// Run: npx mocha --spec tests/outboundEligibility.test.js

import assert from 'assert';

var echomail = null;
try {
	echomail = await import('../src/models/echomail.js');
} catch (_) { echomail = null; }

// Our hub is 1:134/100. Uplink 1:134/1, downlinks 1:134/101 and 1:134/102.
var SELF = { netnode: '134/100' };
var D1   = { address: '1:134/101', net: '134', node: '101' };
var D2   = { address: '1:134/102', net: '134', node: '102' };
var OTHERNET = { address: '1:220/50', net: '220', node: '50' };

function msg(over) {
	return Object.assign({
		id: 1,
		imported: false,
		source: '1:134/1',        // arrived from the uplink
		seen_by: '134/1 100',     // uplink and us
		path: '134/1'
	}, over || {});
}

describe('echomail.evaluateOutbound', function () {
	before(function () {
		if (!echomail || typeof echomail.evaluateOutbound !== 'function') this.skip();
	});

	var evaluate;
	before(function () { evaluate = echomail.evaluateOutbound; });

	// -----------------------------------------------------------------------
	// the regression: a hub has to forward
	// -----------------------------------------------------------------------

	it('forwards uplink mail to a downlink on the same network', function () {
		var v = evaluate(msg(), D1, SELF);
		assert.strictEqual(v.tossable, true,
			'a hub must forward mail from its uplink to its downlinks; ' +
			'blocked with reason: ' + v.reason);
	});

	it('forwards the same message to every downlink not yet listed', function () {
		var m = msg();
		var v1 = evaluate(m, D1, SELF);
		assert.strictEqual(v1.tossable, true);

		// SEEN-BY now carries D1, as it would after the first send.
		var m2 = msg({ seen_by: v1.seenBy });
		var v2 = evaluate(m2, D2, SELF);
		assert.strictEqual(v2.tossable, true,
			'adding one downlink to SEEN-BY must not block the next one');
	});

	it('adds the destination to SEEN-BY so the next hop can see it', function () {
		var v = evaluate(msg(), D1, SELF);
		assert.ok(v.seenBy.includes('101'), 'SEEN-BY should gain the destination: ' + v.seenBy);
		assert.ok(v.seenBy.includes('134/1'), 'and keep what was already there');
	});

	it('forwards to a node on a different net, adding a new net group', function () {
		var v = evaluate(msg(), OTHERNET, SELF);
		assert.strictEqual(v.tossable, true);
		assert.ok(v.seenBy.includes('220/50'), 'a new net needs its own group: ' + v.seenBy);
	});

	it('does not consult source_network_id', function () {
		// The removed filter. Present on every inbound message, so honouring it
		// here would reinstate the outage.
		var v = evaluate(msg({ source_network_id: 1 }), D1, SELF);
		assert.strictEqual(v.tossable, true,
			'source_network_id must have no bearing on eligibility');
	});

	// -----------------------------------------------------------------------
	// loop prevention still has to work
	// -----------------------------------------------------------------------

	it('does not send back to the node the message came from', function () {
		var v = evaluate(msg({ source: D1.address }), D1, SELF);
		assert.strictEqual(v.tossable, false);
		assert.strictEqual(v.reason, 'received from this node');
	});

	it('does not send to a node already in SEEN-BY', function () {
		var v = evaluate(msg({ seen_by: '134/1 100 101' }), D1, SELF);
		assert.strictEqual(v.tossable, false);
		assert.strictEqual(v.reason, 'already in SEEN-BY');
	});

	it('reads compressed SEEN-BY, where bare numbers belong to the preceding net', function () {
		// "134/1 100 101 102" means 134/1, 134/100, 134/101, 134/102.
		var v = evaluate(msg({ seen_by: '134/1 100 101 102' }), D2, SELF);
		assert.strictEqual(v.tossable, false,
			'134/102 is present as a bare 102 and must still be recognised');
	});

	it('does not confuse a node number across different nets', function () {
		// 220/101 is in SEEN-BY; 134/101 is not, and must still be sent to.
		var v = evaluate(msg({ seen_by: '220/101' }), D1, SELF);
		assert.strictEqual(v.tossable, true,
			'a matching node number in a different net must not block');
	});

	it('does not send to a node already in PATH', function () {
		var v = evaluate(msg({ path: '134/1 134/101' }), D1, SELF);
		assert.strictEqual(v.tossable, false);
		assert.strictEqual(v.reason, 'already in PATH');
	});

	it('never exports imported history', function () {
		var v = evaluate(msg({ imported: true }), D1, SELF);
		assert.strictEqual(v.tossable, false);
		assert.strictEqual(v.reason, 'imported history');
	});

	it('checks imported before anything else, so a migration cannot leak', function () {
		// Even a message that would otherwise be perfectly sendable.
		var v = evaluate(msg({ imported: true, seen_by: null, path: null, source: null }), D1, SELF);
		assert.strictEqual(v.tossable, false);
		assert.strictEqual(v.reason, 'imported history');
	});

	// -----------------------------------------------------------------------
	// shapes that should not throw or over-block
	// -----------------------------------------------------------------------

	it('handles a message with no SEEN-BY by starting one', function () {
		var v = evaluate(msg({ seen_by: null }), D1, SELF);
		assert.strictEqual(v.tossable, true);
		assert.ok(v.seenBy.includes('134/100'), 'we should be in it: ' + v.seenBy);
		assert.ok(v.seenBy.includes('101'), 'and the destination: ' + v.seenBy);
	});

	it('handles a message with no PATH', function () {
		assert.strictEqual(evaluate(msg({ path: null }), D1, SELF).tossable, true);
	});

	it('handles a locally posted message with no source', function () {
		var v = evaluate(msg({ source: null, seen_by: null, path: null }), D1, SELF);
		assert.strictEqual(v.tossable, true,
			'locally posted mail with nothing stamped on it must still go out');
	});

	it('tolerates irregular whitespace in SEEN-BY', function () {
		var v = evaluate(msg({ seen_by: '  134/1   100  ' }), D1, SELF);
		assert.strictEqual(v.tossable, true);
	});

	it('tolerates irregular whitespace in PATH', function () {
		var v = evaluate(msg({ path: '  134/1   134/101  ' }), D1, SELF);
		assert.strictEqual(v.tossable, false, 'the node is present, spacing aside');
	});
});
