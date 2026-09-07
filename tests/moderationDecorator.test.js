// tests/moderationDecorator.test.js: moderation as a property of the message.
//
// The web thread view, the flat view, the lazy-load endpoints and the terminal
// reader all show messages, and each used to be handed a page-level
// canModerate flag and left to work out what it meant. That is how they drift:
// the move rule landed in the routes and the browser, the terminal never got it
// at all, and a rule tightened in one place stayed loose in the others.
//
// So the model answers once, per item, and every view reads item.moderation.
// These tests pin the answer, not any one view's rendering of it.
//
// Pure: no database. buildMoveTargets is the only piece that touches one, and
// it is exercised in messageMove.test.js.
//
// Run: npx mocha

import assert from 'assert';

var messages = null;
try {
	messages = await import('../src/models/messages.js');
} catch (_) { messages = null; }

var AREA  = { shortcode: 'GEN', name: 'General' };
var SYSOP = { username: 'sysop', permissionflags: ['Sysop'] };
var PLAIN = { username: 'joe', permissionflags: ['Trusted'] };

var LOCAL_TARGET = { shortcode: 'LOCAL', name: 'Local Chat', group_shortcode: 'G', networked: false };
var NET_TARGET   = { shortcode: 'NET', name: 'Networked Echo', group_shortcode: 'G', networked: true };
var TARGETS = [LOCAL_TARGET, NET_TARGET];

var LOCAL_MSG = { uuid: 'm-1', from_user: 'alice', source_network_id: null };
var NET_MSG   = { uuid: 'm-2', from_user: 'bob', source_network_id: 7 };

describe('messages.moderationTargetAllowed', function () {
	before(function () {
		if (!messages || typeof messages.moderationTargetAllowed !== 'function') this.skip();
	});

	it('lets locally written content go anywhere', function () {
		assert.strictEqual(messages.moderationTargetAllowed(false, true), true);
		assert.strictEqual(messages.moderationTargetAllowed(false, false), true);
	});

	it('keeps content that came off a network out of another network', function () {
		// Re-export from the new area is the point of moving. The rule is about
		// provenance: this system does not republish someone else's mail into a
		// network it did not come from.
		assert.strictEqual(messages.moderationTargetAllowed(true, true), false);
	});

	it('lets content that came off a network into a local area', function () {
		assert.strictEqual(messages.moderationTargetAllowed(true, false), true);
	});
});

describe('messages.moderationFor', function () {
	before(function () {
		if (!messages || typeof messages.moderationFor !== 'function') this.skip();
	});

	// -----------------------------------------------------------------------
	// who
	// -----------------------------------------------------------------------

	it('gives an ordinary user nothing', function () {
		var m = messages.moderationFor(PLAIN, AREA, LOCAL_MSG, TARGETS);
		assert.strictEqual(m.canDelete, false);
		assert.strictEqual(m.canMove, false);
		assert.deepStrictEqual(m.targets, [],
			'destinations must not leak to someone who cannot move anything');
	});

	it('gives an anonymous visitor nothing without throwing', function () {
		assert.strictEqual(messages.moderationFor(null, AREA, LOCAL_MSG, TARGETS).canDelete, false);
	});

	it('gives a moderator delete', function () {
		assert.strictEqual(messages.moderationFor(SYSOP, AREA, LOCAL_MSG, TARGETS).canDelete, true);
	});

	// -----------------------------------------------------------------------
	// what, per message
	// -----------------------------------------------------------------------

	it('offers a locally written message every destination', function () {
		var m = messages.moderationFor(SYSOP, AREA, LOCAL_MSG, TARGETS);
		assert.strictEqual(m.canMove, true);
		assert.strictEqual(m.targets.length, 2);
	});

	it('offers a networked message only the local destinations', function () {
		var m = messages.moderationFor(SYSOP, AREA, NET_MSG, TARGETS);
		assert.strictEqual(m.canMove, true);
		assert.deepStrictEqual(m.targets.map(function (t) { return t.shortcode; }), ['LOCAL'],
			'the networked destination has to be filtered out, not merely discouraged');
	});

	it('reports canMove false when nothing is left after filtering', function () {
		// A board whose every area is networked can still delete network mail,
		// but there is nowhere it may be moved to.
		var m = messages.moderationFor(SYSOP, AREA, NET_MSG, [NET_TARGET]);
		assert.strictEqual(m.canDelete, true);
		assert.strictEqual(m.canMove, false);
		assert.deepStrictEqual(m.targets, []);
	});

	it('reports canMove false when there are no destinations at all', function () {
		assert.strictEqual(messages.moderationFor(SYSOP, AREA, LOCAL_MSG, []).canMove, false);
		assert.strictEqual(messages.moderationFor(SYSOP, AREA, LOCAL_MSG, null).canMove, false);
	});

	it('reports the origin, so a view can label it without re-deriving it', function () {
		assert.strictEqual(messages.moderationFor(SYSOP, AREA, NET_MSG, TARGETS).fromNetwork, true);
		assert.strictEqual(messages.moderationFor(SYSOP, AREA, LOCAL_MSG, TARGETS).fromNetwork, false);
	});

	it('treats a missing source_network_id as locally written', function () {
		var m = messages.moderationFor(SYSOP, AREA, { uuid: 'x' }, TARGETS);
		assert.strictEqual(m.fromNetwork, false);
		assert.strictEqual(m.targets.length, 2);
	});

	// -----------------------------------------------------------------------
	// threads
	// -----------------------------------------------------------------------

	it('treats a thread with any network message as network origin', function () {
		// A thread is as restricted as its most restricted message: moving the
		// whole thing into a networked area would republish that one part.
		var m = messages.moderationFor(SYSOP, AREA,
			{ uuid: 't-1', anyFromNetwork: true }, TARGETS);
		assert.strictEqual(m.fromNetwork, true);
		assert.deepStrictEqual(m.targets.map(function (t) { return t.shortcode; }), ['LOCAL']);
	});

	it('treats a wholly local thread as local', function () {
		var m = messages.moderationFor(SYSOP, AREA,
			{ uuid: 't-1', anyFromNetwork: false }, TARGETS);
		assert.strictEqual(m.fromNetwork, false);
		assert.strictEqual(m.targets.length, 2);
	});

	it('reads anyFromNetwork ahead of source_network_id when both are present', function () {
		// A thread object carrying a stray source_network_id must not override
		// the summary that was computed across all its messages.
		var m = messages.moderationFor(SYSOP, AREA,
			{ uuid: 't-1', anyFromNetwork: false, source_network_id: 7 }, TARGETS);
		assert.strictEqual(m.fromNetwork, false);
	});
});

describe('messages.moderationForArea', function () {
	before(function () {
		if (!messages || typeof messages.moderationForArea !== 'function') this.skip();
	});

	it('reports enabled for a moderator and hands over the whole list', function () {
		var m = messages.moderationForArea(SYSOP, AREA, TARGETS);
		assert.strictEqual(m.enabled, true);
		assert.strictEqual(m.targets.length, 2,
			'the area answer is unfiltered; each item narrows it');
	});

	it('reports disabled and no destinations for an ordinary user', function () {
		var m = messages.moderationForArea(PLAIN, AREA, TARGETS);
		assert.strictEqual(m.enabled, false);
		assert.deepStrictEqual(m.targets, []);
	});

	it('survives a null user and a null target list', function () {
		assert.strictEqual(messages.moderationForArea(null, AREA, null).enabled, false);
		assert.deepStrictEqual(messages.moderationForArea(SYSOP, AREA, null).targets, []);
	});
});

describe('messages.attachModeration', function () {
	before(function () {
		if (!messages || typeof messages.attachModeration !== 'function') this.skip();
	});

	it('answers each message on its own terms, not the page as a whole', function () {
		var list = [Object.assign({}, LOCAL_MSG), Object.assign({}, NET_MSG)];
		messages.attachModeration(SYSOP, AREA, list, TARGETS);

		assert.strictEqual(list[0].moderation.targets.length, 2);
		assert.strictEqual(list[1].moderation.targets.length, 1,
			'two messages on the same page can have different answers, which is ' +
			'the whole reason this is not a page-level flag');
	});

	it('stamps a refusal rather than leaving the field missing', function () {
		// A view should never have to tell "not computed" apart from "no".
		var list = [Object.assign({}, LOCAL_MSG)];
		messages.attachModeration(PLAIN, AREA, list, TARGETS);
		assert.ok(list[0].moderation, 'the field has to be there either way');
		assert.strictEqual(list[0].moderation.canDelete, false);
	});

	it('handles an empty list and a null list without throwing', function () {
		assert.doesNotThrow(function () {
			messages.attachModeration(SYSOP, AREA, [], TARGETS);
			messages.attachModeration(SYSOP, AREA, null, TARGETS);
		});
	});

	it('returns the list it was given, so it can be used inline', function () {
		var list = [Object.assign({}, LOCAL_MSG)];
		assert.strictEqual(messages.attachModeration(SYSOP, AREA, list, TARGETS), list);
	});
});

describe('messages.messageForClient', function () {
	before(function () {
		if (!messages || typeof messages.messageForClient !== 'function') this.skip();
	});

	var ROW = {
		id: 12, uuid: 'm-1', msg_id: 'MSGID', from_user: 'alice', to_user: 'All',
		subject: 'Hi', system_time: '2026-07-16 10:00:00-06', body_text: 'hello',
		body_html: '<p>hello</p>', thread_id: 3, source_network_id: null
	};

	it('carries the uuid', function () {
		// The lazy-load endpoints used to build this shape by hand and left the
		// uuid out, while the row builder that consumes it was already reading
		// one. An appended message's delete control addressed nothing, and the
		// first thirty on the page worked fine, so it looked correct.
		assert.strictEqual(messages.messageForClient(ROW).uuid, 'm-1');
	});

	it('carries the moderation answer so an appended row matches a rendered one', function () {
		var row = Object.assign({}, ROW);
		messages.attachModeration(SYSOP, AREA, [row], TARGETS);
		var out = messages.messageForClient(row);
		assert.strictEqual(out.moderation.canDelete, true);
		assert.strictEqual(out.moderation.canMove, true);
		assert.strictEqual(out.moderation.fromNetwork, false);
	});

	it('sends a refusal for an undecorated row rather than undefined', function () {
		var out = messages.messageForClient(Object.assign({}, ROW));
		assert.strictEqual(out.moderation.canDelete, false);
		assert.strictEqual(out.moderation.canMove, false);
	});

	it('leaves the destination list out of the per-message payload', function () {
		var row = Object.assign({}, ROW);
		messages.attachModeration(SYSOP, AREA, [row], TARGETS);
		assert.strictEqual(messages.messageForClient(row).moderation.targets, undefined,
			'the page already has the list once; thirty copies of it is the area ' +
			'list sent thirty times');
	});

	it('takes the thread uuid from the caller, which is where it is resolved', function () {
		assert.strictEqual(messages.messageForClient(ROW, 't-9').thread_uuid, 't-9');
	});

	it('falls back to a thread uuid already on the row', function () {
		assert.strictEqual(
			messages.messageForClient(Object.assign({}, ROW, { thread_uuid: 't-2' })).thread_uuid,
			't-2');
	});

	it('never emits undefined for the fields the row builder reads', function () {
		var out = messages.messageForClient({ id: 1 });
		assert.strictEqual(out.uuid, '');
		assert.strictEqual(out.thread_uuid, '');
		assert.strictEqual(out.isAnsi, false);
		assert.ok(out.moderation);
	});
});
