// tests/terminalModeration.test.js: the terminal reader gets the same answer.
//
// The moderation controls were built for the web views first, and the terminal
// reader was left without them. That is the failure this file exists to stop
// coming back: a sysop reading COOKING over telnet could see the message that
// needed removing and had no way to remove it, and worse, any rule added later
// to the browser would have gone on not applying here.
//
// The reader now reads message.moderation, filled in by messages.js, exactly as
// the pug views do. These tests pin that it reads rather than decides.
//
// The class needs a live call object to draw anything, so the behavioural tests
// here call the small pure methods through the prototype with a hand-built
// `this`. The rest is checked against the source, which is the honest way to
// pin "this file does not contain a second copy of the policy".
//
// Pure: no database, no terminal.
// Run: npx mocha

import assert from 'assert';
import fs from 'fs';

var SRC = 'src/handlers/menucommands/msgReader.js';
var src = null, reader = null, messages = null;
try {
	src = fs.readFileSync(SRC, 'utf8');
	reader = (await import('../src/handlers/menucommands/msgReader.js')).msgReader;
	messages = await import('../src/models/messages.js');
} catch (_) { /* leave null, suites skip */ }

describe('terminal reader moderation wiring', function () {
	before(function () { if (!src) this.skip(); });

	it('asks the model rather than carrying its own copy of the rules', function () {
		assert.ok(/moderationForArea/.test(src), 'the area answer comes from messages.js');
		assert.ok(/attachModeration/.test(src), 'per-message answers come from messages.js');
		assert.ok(/moderationFor\b/.test(src), 'the thread answer comes from messages.js');
	});

	it('does not work out provenance for itself', function () {
		// The move rule turns on source_network_id. If that name appears here
		// it means the terminal has its own copy, and the two will drift.
		assert.ok(!/source_network_id/.test(src),
			'provenance is decided in messages.js, not in the reader');
	});

	it('does not check the sysop flag for itself', function () {
		// canModerateArea is the seam per-area moderators plug into, and naming
		// the flag here would route around it. The reader does read
		// permissionflags, but only through its own post-access check, which is
		// a separate and much older question.
		assert.ok(!/Sysop/.test(src), 'the moderator flag must not be named here');
		assert.ok(!/canModerateArea/.test(src),
			'even the check itself is the model\'s to make, so the reader cannot ' +
			'ask it about one area and act on another');
	});

	it('offers delete and move from the message view', function () {
		assert.ok(/case "d":\s*\n\s*this\._beginDelete\(\);/.test(src));
		assert.ok(/case "m":\s*\n\s*this\._beginMove\(\);/.test(src));
	});

	it('offers them on a dumb terminal too', function () {
		// The dumb path has its own key dispatch, which is exactly the sort of
		// second door a feature gets added to the first one only.
		assert.ok(/lower === "d"[\s\S]{0,80}_beginDelete/.test(src));
		assert.ok(/lower === "m"[\s\S]{0,80}_beginMove/.test(src));
	});

	it('lets an open prompt own the keyboard on a dumb terminal', function () {
		// Without this the yes/no answer falls through to the reader's own keys
		// and the confirmation is left hanging while the screen moves on.
		assert.ok(/if \(this\._modPrompt\)/.test(src));
	});

	it('confirms before deleting either a message or a thread', function () {
		assert.ok(/_confirmDeleteMessage/.test(src));
		assert.ok(/_confirmDeleteThread/.test(src));
		assert.ok(/\(Y\/N\)/.test(src), 'the confirmation has to be explicit');
	});

	it('says the deletion is local only, as the web dialogs do', function () {
		assert.ok(/peers keep what they already have/i.test(src),
			'a moderator should not be left thinking a delete unsends anything');
	});

	it('decorates messages at one place rather than at each load site', function () {
		// There are six paths that fill this._messages. Decorating at each is
		// how the seventh one gets forgotten.
		assert.ok(/_updateMessageBounds\(\) \{\s*\n(?:[^\n]*\n){0,6}?\s*this\._decorateMessages\(\);/
			.test(src), 'the decoration belongs in the choke point every load goes through');
	});

	it('re-asks for a thread rather than borrowing the message on screen', function () {
		// A thread is as restricted as its most restricted message, so the
		// answer for the message being read is not the answer for its thread.
		assert.ok(/threadOriginSummary/.test(src));
	});
});

describe('terminal reader moderation behaviour', function () {
	before(function () { if (!reader || !messages) this.skip(); });

	// Enough of a `this` for the small pure methods. Anything that draws needs
	// a real call object and is not exercised here.
	var P = reader.prototype;

	function fake(overrides) {
		return Object.assign(Object.create(P), {
			_messages: [], _msgIdx: 0, _filteredThreads: [], _currentThreadId: null,
			_viewMode: 'threaded', _moderation: { enabled: false, targets: [] }
		}, overrides || {});
	}
	var AREA = { shortcode: 'GEN', name: 'General' };
	var SYSOP = { username: 'sysop', permissionflags: ['Sysop'] };
	var TARGETS = [
		{ shortcode: 'LOCAL', name: 'Local', group_shortcode: 'G', networked: false },
		{ shortcode: 'NET', name: 'Net', group_shortcode: 'G', networked: true }
	];

	it('offers the keys the message on screen actually allows', function () {
		var local = { uuid: 'm-1', from_user: 'a', source_network_id: null };
		var net   = { uuid: 'm-2', from_user: 'b', source_network_id: 7 };
		messages.attachModeration(SYSOP, AREA, [local, net], [TARGETS[1]]);

		assert.strictEqual(P._dumbModKeys.call(fake({ _messages: [local], _msgIdx: 0 })),
			', D=Delete, M=Move');
		assert.strictEqual(P._dumbModKeys.call(fake({ _messages: [net], _msgIdx: 0 })),
			', D=Delete',
			'a networked message with only a networked destination can be deleted ' +
			'but not moved, and the prompt should say so');
	});

	it('offers nothing to a reader who may not moderate', function () {
		var msg = { uuid: 'm-1', from_user: 'a', source_network_id: null };
		messages.attachModeration({ username: 'joe', permissionflags: [] }, AREA, [msg], TARGETS);
		assert.strictEqual(P._dumbModKeys.call(fake({ _messages: [msg] })), '');
	});

	it('offers nothing when there is no message on screen', function () {
		assert.strictEqual(P._dumbModKeys.call(fake()), '',
			'an empty area must not advertise a delete');
	});

	it('offers nothing for an undecorated message rather than throwing', function () {
		assert.strictEqual(P._dumbModKeys.call(fake({ _messages: [{ uuid: 'x' }] })), '');
	});

	it('finds the thread being read', function () {
		var t = { id: 5, uuid: 't-5', subject: 'Hi' };
		assert.strictEqual(
			P._currentThread.call(fake({ _currentThreadId: 5, _filteredThreads: [{ id: 4 }, t] })), t);
	});

	it('reports no thread in a flat view', function () {
		assert.strictEqual(P._currentThread.call(fake({ _currentThreadId: null })), null);
	});

	it('reports no thread when the list no longer holds it', function () {
		// After a move or a delete the list is reloaded, and the thread that was
		// being read may be gone.
		assert.strictEqual(
			P._currentThread.call(fake({ _currentThreadId: 9, _filteredThreads: [{ id: 4 }] })), null);
	});

	it('offers thread operations only in a threaded view with a thread in hand', function () {
		var t = { id: 5, uuid: 't-5' };
		assert.strictEqual(P._threadOpsAvailable.call(
			fake({ _viewMode: 'threaded', _currentThreadId: 5, _filteredThreads: [t] })), true);
		assert.strictEqual(P._threadOpsAvailable.call(
			fake({ _viewMode: 'flat', _currentThreadId: 5, _filteredThreads: [t] })), false,
			'the flat view has no thread on screen, so it must not offer to delete one');
		assert.strictEqual(P._threadOpsAvailable.call(
			fake({ _viewMode: 'threaded', _currentThreadId: null })), false);
	});
});
