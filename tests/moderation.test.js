// tests/moderation.test.js: who may remove other people's threads and messages.
//
// canModerateArea is the Sysop flag today and deliberately its own function
// rather than an inline permissionflags check, because per-area and per-group
// moderators are wanted next. Pinning the current answer here means the day
// that lands, these tests say plainly which behaviours were meant to survive:
// Sysop keeps working everywhere, and an ordinary user still gets nothing.
//
// Whether a control appears is decided by messages.moderationFor and read off
// item.moderation. Views used to be handed a page-level canModerate flag and
// work it out themselves, which meant a rule tightened in one view stayed loose
// in the others and the terminal had no rule at all. These tests pin that the
// answer travels with the message.
//
// The view tests pin where the controls live, which was got wrong first time.
// They belong where a moderator can read what they are about to remove: on the
// thread view, both in the header for the whole thread and on each message, and
// on the flat view per message. Not on the area's thread list, where all you
// can see is a subject line and deleting is blind.
//
// They also check the controls are genuinely absent for a non-moderator rather
// than merely hidden, and that the lazily-appended messages carry them too,
// since both views render messages twice: server side and again in JS.
//
// Pure: no database.
// Run: npx mocha --spec tests/moderation.test.js

import assert from 'assert';
import fs from 'fs';

var areaAccess = null, pug = null, luxon = null, messages = null;
try {
	areaAccess = await import('../src/utils/areaAccess.js');
	pug = (await import('pug')).default;
	luxon = await import('luxon');
	messages = await import('../src/models/messages.js');
} catch (_) { /* leave null, suites skip */ }

describe('areaAccess.canModerateArea', function () {
	before(function () {
		if (!areaAccess || typeof areaAccess.canModerateArea !== 'function') this.skip();
	});

	var AREA = { shortcode: 'GEN', name: 'General' };

	it('allows a Sysop', function () {
		assert.strictEqual(areaAccess.canModerateArea({ permissionflags: ['Sysop'] }, AREA), true);
	});

	it('allows a Sysop who has other flags too', function () {
		assert.strictEqual(
			areaAccess.canModerateArea({ permissionflags: ['Trusted', 'Sysop', 'Beta'] }, AREA), true);
	});

	it('refuses an ordinary user', function () {
		assert.strictEqual(areaAccess.canModerateArea({ permissionflags: ['Trusted'] }, AREA), false);
	});

	it('refuses a user with no flags', function () {
		assert.strictEqual(areaAccess.canModerateArea({ permissionflags: [] }, AREA), false);
		assert.strictEqual(areaAccess.canModerateArea({}, AREA), false);
	});

	it('refuses an anonymous visitor without throwing', function () {
		assert.strictEqual(areaAccess.canModerateArea(null, AREA), false);
		assert.strictEqual(areaAccess.canModerateArea(undefined, AREA), false);
	});

	it('reads flags stored as a JSON string, which is how they come back from pg', function () {
		assert.strictEqual(areaAccess.canModerateArea({ permissionflags: '["Sysop"]' }, AREA), true);
		assert.strictEqual(areaAccess.canModerateArea({ permissionflags: '["Trusted"]' }, AREA), false);
	});

	it('is case sensitive, matching every other flag check', function () {
		assert.strictEqual(areaAccess.canModerateArea({ permissionflags: ['sysop'] }, AREA), false);
	});

	it('answers board-wide when no area is named', function () {
		// Callers that cannot name an area pass null. Once per-area moderators
		// exist this stays the board-wide answer rather than becoming a refusal.
		assert.strictEqual(areaAccess.canModerateArea({ permissionflags: ['Sysop'] }, null), true);
		assert.strictEqual(areaAccess.canModerateArea({ permissionflags: ['Trusted'] }, null), false);
	});
});

describe('moderation controls placement', function () {
	before(function () { if (!pug || !luxon || !messages) this.skip(); });

	var AREA = { shortcode: 'GEN', name: 'General', group_shortcode: 'G', thread_mode: 'standard' };
	var SYSOP = { username: 'sysop', permissionflags: ['Sysop'] };
	var PLAIN = { username: 'joe', permissionflags: [] };
	var MSG = {
		id: 1, uuid: 'm-1', from_user: 'alice', to_user: 'All', subject: 'Hi',
		system_time: '2026-07-16 10:00:00-06', body_text: 'hello', thread_uuid: 't-1'
	};

	var TARGETS = [
		{ shortcode: 'LOCAL', name: 'Local Chat', group_shortcode: 'G', networked: false },
		{ shortcode: 'NET', name: 'Networked Echo', group_shortcode: 'G', networked: true }
	];

	// The route decorates before rendering, so the tests do too: nothing is
	// passed that the real render sites do not pass.
	function decorate(canModerate, opts) {
		opts = opts || {};
		var targets = canModerate ? TARGETS : [];
		var area = Object.assign({}, AREA, {
			moderation: messages.moderationForArea(
				canModerate ? SYSOP : PLAIN, AREA, targets)
		});
		var msg = Object.assign({}, MSG, { source_network_id: opts.fromNetwork ? 7 : null });
		messages.attachModeration(canModerate ? SYSOP : PLAIN, AREA, [msg], targets);
		var thread = { id: 1, uuid: 't-1', subject: 'Hi', threadid: 'x',
		               anyFromNetwork: !!opts.fromNetwork };
		thread.moderation = messages.moderationFor(
			canModerate ? SYSOP : PLAIN, AREA, thread, targets);
		return { area: area, msg: msg, thread: thread };
	}

	function render(template, canModerate, opts) {
		var d = decorate(canModerate, opts);
		var extra = template === 'thread'
			? { thread: d.thread, messages: [d.msg], totalMessages: 1 }
			: { messages: [d.msg], totalMessages: 1, messagesBefore: 0, hasOlder: false,
			    hasNewer: false, firstUnreadId: 0 };

		var locals = Object.assign({
			title: 'T', activelink: 'messages', ismobile: false, DateTime: luxon.DateTime,
			currentuser: { username: 'tester' }, sufficientAccess: true,
			canPost: true, msgArea: d.area,
			threadMode: 'standard', postFromName: 'tester'
		}, extra);

		return pug.compileFile('src/views/messages/areas/' + template + '.pug')(locals);
	}

	// Script blocks mention the control class names in their row-builder
	// strings whatever the flag says, so assertions have to look at markup.
	function markup(html) {
		return html.replace(/<script[\s\S]*?<\/script>/g, '');
	}

	// -----------------------------------------------------------------------
	// where they belong
	// -----------------------------------------------------------------------

	it('offers a thread delete in the thread view header', function () {
		assert.ok(/class="[^"]*thread-delete/.test(markup(render('thread', true))),
			'the thread header is where the subject and its messages are on screen');
	});

	it('offers a per-message delete in the thread view', function () {
		assert.ok(/class="[^"]*message-delete/.test(markup(render('thread', true))));
	});

	it('offers a per-message delete in the flat view', function () {
		assert.ok(/class="[^"]*message-delete/.test(markup(render('flat', true))));
	});

	it('has no thread delete in the flat view, which has no thread header', function () {
		assert.ok(!/class="[^"]*thread-delete/.test(markup(render('flat', true))));
	});

	it('keeps them off the area thread list, where deleting would be blind', function () {
		// That list shows subjects only. A delete there removes content the
		// moderator has not read, which is what this placement exists to avoid.
		var fn = pug.compileFile('src/views/messages/areas/view.pug');
		var html = fn({
			title: 'Area', activelink: 'messages', ismobile: false, DateTime: luxon.DateTime,
			currentuser: { username: 'tester' }, sufficientAccess: true, canPost: true,
			msgArea: Object.assign({}, AREA, {
				moderation: messages.moderationForArea(SYSOP, AREA, TARGETS)
			}), threadMode: 'standard', totalThreads: 1,
			threadlist: [{ id: 1, uuid: 't-1', subject: 'Hi', message_count: 2, started_by: 'a',
			               last_message: '2026-07-16 10:00:00-06', last_message_from: 'b' }]
		});
		assert.ok(!/class="[^"]*thread-delete/.test(markup(html)));
		assert.ok(!/class="[^"]*message-delete/.test(markup(html)));
	});

	// -----------------------------------------------------------------------
	// absent, not hidden
	// -----------------------------------------------------------------------

	['thread', 'flat'].forEach(function (tpl) {
		it('renders nothing for a non-moderator in the ' + tpl + ' view', function () {
			var dom = markup(render(tpl, false));
			assert.ok(!/class="[^"]*message-delete/.test(dom), 'message control');
			assert.ok(!/class="[^"]*thread-delete/.test(dom), 'thread control');
			assert.ok(!/id="deleteMessageModal"/.test(dom), 'confirm dialog');
		});

		it('renders the confirm dialogs for a moderator in the ' + tpl + ' view', function () {
			var dom = markup(render(tpl, true));
			assert.ok(/id="deleteMessageModal"/.test(dom));
		});

		it('tells the lazy-load builder in the ' + tpl + ' view whether to emit controls', function () {
			// Both views render messages twice. If the JS flag disagrees with
			// the server, appended messages get controls the page should not
			// show, or lose ones it should.
			assert.ok(/data-can-moderate="true"/.test(render(tpl, true)));
			assert.ok(/data-can-moderate="false"/.test(render(tpl, false)));
		});
	});

	// -----------------------------------------------------------------------
	// move
	// -----------------------------------------------------------------------

	it('offers a thread move in the thread view header', function () {
		assert.ok(/class="[^"]*thread-move/.test(markup(render('thread', true))));
	});

	['thread', 'flat'].forEach(function (tpl) {
		it('offers a per-message move in the ' + tpl + ' view', function () {
			assert.ok(/class="[^"]*message-move/.test(markup(render(tpl, true))));
		});

		it('renders no move control for a non-moderator in the ' + tpl + ' view', function () {
			assert.ok(!/class="[^"]*message-move/.test(markup(render(tpl, false))));
			assert.ok(!/id="moveContentModal"/.test(markup(render(tpl, false))));
		});

		it('renders the destination list once per page in the ' + tpl + ' view', function () {
			var dom = markup(render(tpl, true));
			assert.strictEqual((dom.match(/id="moveDestination"/g) || []).length, 1,
				'one shared dialog, not one per message');
			assert.ok(/value="LOCAL"/.test(dom) && /value="NET"/.test(dom));
		});

		it('marks which destinations are networked in the ' + tpl + ' view', function () {
			// The dialog hides the ones a networked message may not go to, and
			// needs to know which those are without asking the server again.
			var dom = markup(render(tpl, true));
			assert.ok(/value="NET"[^>]*data-networked="true"/.test(dom) ||
			          /data-networked="true"[^>]*value="NET"/.test(dom), dom.match(/<option[^>]*>/g));
		});

		it('tells the ' + tpl + ' move control where the message came from', function () {
			assert.ok(/class="[^"]*message-move[^"]*"[\s\S]{0,300}?data-from-network="true"/
				.test(markup(render(tpl, true, { fromNetwork: true }))),
				'a networked message must say so, or the dialog cannot filter');
			assert.ok(/class="[^"]*message-move[^"]*"[\s\S]{0,300}?data-from-network="false"/
				.test(markup(render(tpl, true, { fromNetwork: false }))));
		});
	});

	// -----------------------------------------------------------------------
	// the answer travels with the message
	// -----------------------------------------------------------------------

	['thread', 'flat'].forEach(function (tpl) {
		it('has the ' + tpl + ' lazy-load builder read each message\'s own answer', function () {
			// Both views render messages twice, server side and again in JS. The
			// JS half used to key off a single page flag, so every appended
			// message got the same controls regardless of where it came from,
			// and a networked one offered a move the route would refuse.
			var script = render(tpl, true);
			assert.ok(/msg\.moderation/.test(script),
				'the row builder has to read the per-message answer, not a page flag');
			assert.ok(/m\.canMove/.test(script) && /m\.canDelete/.test(script));
		});

		it('does not decide moderation itself in the ' + tpl + ' view', function () {
			// Nothing in a template should be reading permission flags or
			// working out provenance. If it is, the terminal and the browser
			// will disagree the next time one of them is changed.
			var src = fs.readFileSync('src/views/messages/areas/' + tpl + '.pug', 'utf8');
			assert.ok(!/permissionflags/.test(src), 'a view must not read flags');
			assert.ok(!/source_network_id/.test(src), 'a view must not derive provenance');
		});
	});

	it('warns that deleting locally does not unsend what peers already have', function () {
		assert.ok(/peer/i.test(render('thread', true)));
	});

	it('says that deleting the first message takes the thread with it', function () {
		assert.ok(/whole thread/i.test(render('thread', true)),
			'the consequence should be on screen, not discovered afterwards');
	});
});
