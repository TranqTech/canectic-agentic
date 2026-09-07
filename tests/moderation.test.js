// tests/moderation.test.js: who may remove other people's threads and messages.
//
// canModerateArea is the Sysop flag today and deliberately its own function
// rather than an inline permissionflags check, because per-area and per-group
// moderators are wanted next. Pinning the current answer here means the day
// that lands, these tests say plainly which behaviours were meant to survive:
// Sysop keeps working everywhere, and an ordinary user still gets nothing.
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

var areaAccess = null, pug = null, luxon = null;
try {
	areaAccess = await import('../src/utils/areaAccess.js');
	pug = (await import('pug')).default;
	luxon = await import('luxon');
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
	before(function () { if (!pug || !luxon) this.skip(); });

	var AREA = { shortcode: 'GEN', name: 'General', group_shortcode: 'G', thread_mode: 'standard' };
	var MSG = {
		id: 1, uuid: 'm-1', from_user: 'alice', to_user: 'All', subject: 'Hi',
		system_time: '2026-07-16 10:00:00-06', body_text: 'hello', thread_uuid: 't-1'
	};

	function render(template, canModerate) {
		var extra = template === 'thread'
			? { thread: { id: 1, uuid: 't-1', subject: 'Hi', threadid: 'x' }, messages: [MSG], totalMessages: 1 }
			: { messages: [MSG], totalMessages: 1, messagesBefore: 0, hasOlder: false, hasNewer: false, firstUnreadId: 0 };

		var locals = Object.assign({
			title: 'T', activelink: 'messages', ismobile: false, DateTime: luxon.DateTime,
			currentuser: { username: 'tester' }, sufficientAccess: true,
			canPost: true, canModerate: canModerate, msgArea: AREA,
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
			canModerate: true, msgArea: AREA, threadMode: 'standard', totalThreads: 1,
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

	it('warns that deleting locally does not unsend what peers already have', function () {
		assert.ok(/peer/i.test(render('thread', true)));
	});

	it('says that deleting the first message takes the thread with it', function () {
		assert.ok(/whole thread/i.test(render('thread', true)),
			'the consequence should be on screen, not discovered afterwards');
	});
});
