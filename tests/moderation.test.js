// tests/moderation.test.js: who may remove other people's threads and messages.
//
// canModerateArea is the Sysop flag today and deliberately its own function
// rather than an inline permissionflags check, because per-area and per-group
// moderators are wanted next. Pinning the current answer here means the day
// that lands, these tests say plainly which behaviours were meant to survive:
// Sysop keeps working everywhere, and an ordinary user still gets nothing.
//
// The view tests guard something easy to break by accident. The thread list is
// rendered twice, once server side and once in JS for lazily-loaded rows, and a
// moderation column added to one and not the other misaligns the table after a
// load-more. It also checks the controls are genuinely absent for a
// non-moderator rather than merely hidden.
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

describe('messages/areas/view moderation controls', function () {
	before(function () { if (!pug || !luxon) this.skip(); });

	function render(canModerate) {
		var fn = pug.compileFile('src/views/messages/areas/view.pug');
		return fn({
			title: 'Area', activelink: 'messages', ismobile: false,
			DateTime: luxon.DateTime,
			currentuser: { username: 'tester' },
			sufficientAccess: true, canPost: true, canModerate: canModerate,
			msgArea: { shortcode: 'GEN', name: 'General', group_shortcode: 'G', thread_mode: 'standard' },
			threadMode: 'standard', totalThreads: 1,
			threadlist: [{
				id: 1, uuid: 'u-1', subject: 'Hello', message_count: 2,
				started_by: 'alice', last_message: '2026-07-16 10:00:00-06', last_message_from: 'bob'
			}]
		});
	}

	function tbody(html) {
		var m = html.match(/<tbody id="threadBody">[\s\S]*?<\/tbody>/);
		return m ? m[0] : '';
	}

	function countHeaderCells(html) {
		var head = html.match(/<thead[\s\S]*?<\/thead>/);
		return head ? (head[0].match(/<th[ >]/g) || []).length : 0;
	}

	it('shows a delete control to a moderator', function () {
		assert.ok(/class="[^"]*thread-delete/.test(tbody(render(true))));
	});

	it('renders no delete control at all for a non-moderator', function () {
		// Absent, not merely hidden: an ordinary user should not be able to
		// find it by reading the page.
		assert.ok(!/class="[^"]*thread-delete/.test(tbody(render(false))));
	});

	it('renders no confirm dialog for a non-moderator', function () {
		assert.ok(!/id="deleteThreadModal"/.test(render(false)));
		assert.ok(/id="deleteThreadModal"/.test(render(true)));
	});

	it('keeps header and body column counts in step', function () {
		[true, false].forEach(function (mod) {
			var html = render(mod);
			var headCells = countHeaderCells(html);
			var row = tbody(html).match(/<tr[\s\S]*?<\/tr>/);
			var bodyCells = row ? (row[0].match(/<td[ >]/g) || []).length : 0;
			assert.strictEqual(bodyCells, headCells,
				'canModerate=' + mod + ': ' + bodyCells + ' body cells against ' + headCells + ' headers');
		});
	});

	it('tells the lazy-load builder whether to emit the column', function () {
		// The thread list is rendered twice, server side and in JS for rows
		// appended by load-more. If the JS flag disagrees with the server, the
		// table misaligns as soon as more threads load.
		assert.ok(/var canModerate = true;/.test(render(true)));
		assert.ok(/var canModerate = false;/.test(render(false)));
	});

	it('warns that deleting locally does not unsend what peers already have', function () {
		var html = render(true);
		assert.ok(/peer/i.test(html),
			'a moderator should know a deletion is local and a rescan can bring it back');
	});
});
