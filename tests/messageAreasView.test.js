// tests/messageAreasView.test.js: the data the message areas list hands its
// client-side sort and filter.
//
// The sort itself is inline script in the template, which is this codebase's
// convention (public/js is vendor apart from one file), so it is not
// importable. What IS testable, and what would silently break, is the contract
// between the server and that script: every row has to carry the fields the
// sort reads, in the units it expects.
//
// A missing or mistyped data-last-message does not throw. It sorts the row to
// the bottom as if the area had never carried a message, which looks like a
// working feature giving a wrong answer. That is the failure worth guarding.
//
// Pure: renders the template directly, no database.
// Run: npx mocha --spec tests/messageAreasView.test.js

import assert from 'assert';

var pug = null, dateFormat = null;
try {
	pug = (await import('pug')).default;
	dateFormat = await import('../src/utils/dateFormat.js');
} catch (_) { pug = null; }

var TEMPLATE = 'src/views/messages/index.pug';

describe('messages/index view', function () {
	before(function () { if (!pug || !dateFormat) this.skip(); });

	var html = null;

	before(function () {
		var fn = pug.compileFile(TEMPLATE);
		html = fn({
			currentuser: { username: 'tester' },
			title: 'Messages', activelink: 'messages', ismobile: false,
			formatListDate: dateFormat.formatListDate,
			formatListDateFull: dateFormat.formatListDateFull,
			groupedAreas: [{
				group: { shortcode: 'G1', name: 'Group One', description: '' },
				areas: [
					{ shortcode: 'OLD',   name: 'Old area',   description: 'd', msg_count: 5,
					  subscribed: true,  last_message: '2021-03-15 10:00:00-06' },
					{ shortcode: 'FRESH', name: 'Fresh area', description: 'd', msg_count: 9,
					  subscribed: true,  last_message: '2026-07-16 10:00:00-06' },
					{ shortcode: 'NEVER', name: 'Never used', description: 'd', msg_count: 0,
					  subscribed: false, last_message: null }
				]
			}]
		});
	});

	function rows() {
		// order and last-message are emitted adjacently by the template.
		return Array.from(html.matchAll(/data-order="(\d+)" data-last-message="(\d+)"/g))
			.map(function (m) { return { order: parseInt(m[1]), last: parseInt(m[2]) }; });
	}

	// -----------------------------------------------------------------------
	// the sort contract
	// -----------------------------------------------------------------------

	it('renders the sort control', function () {
		assert.ok(html.includes('id="areaSort"'), 'the button the sort hangs off');
		assert.ok(html.includes('areaSortLabel'), 'and its label, which shows the current mode');
	});

	it('gives every row a server ordering to fall back to', function () {
		var r = rows();
		assert.strictEqual(r.length, 3);
		assert.deepStrictEqual(r.map(function (x) { return x.order; }), [0, 1, 2],
			'data-order preserves the order the server sent, so Default is restorable without a reload');
	});

	it('gives every row its last message as epoch milliseconds', function () {
		var r = rows();
		// The sort does a numeric compare. A formatted date string here would
		// compare lexically and quietly produce a wrong order.
		assert.ok(r[0].last > 1000000000000, 'expected epoch ms, got ' + r[0].last);
		assert.ok(r[1].last > r[0].last, 'the 2026 area must sort after the 2021 one numerically');
	});

	it('marks an area that has never carried a message as 0 so it sorts last', function () {
		var r = rows();
		assert.strictEqual(r[2].last, 0,
			'a null last_message has to become 0, not NaN or an empty string');
	});

	it('keeps the fields the search and view toggle read', function () {
		// Sorting reorders the same rows the filter walks, so breaking these
		// would break search rather than sort, in a way the sort work could
		// plausibly have caused.
		assert.ok(html.includes('data-subscribed='), 'view toggle');
		assert.ok(html.includes('data-name='), 'search by name');
		assert.ok(html.includes('data-desc='), 'search by description');
		assert.ok(html.includes('data-shortcode='), 'search by shortcode');
	});

	it('remembers the choice under a namespaced key', function () {
		assert.ok(html.includes('canectic.messageAreas.sort'),
			'an unnamespaced localStorage key would collide with other pages on this origin');
	});

	it('guards localStorage access, which throws in some browser configurations', function () {
		var idx = html.indexOf('canectic.messageAreas.sort');
		var around = html.slice(Math.max(0, idx - 400), idx + 400);
		assert.ok(around.includes('try'),
			'reading or writing localStorage throws outright in a private window or with site data blocked');
	});

	// -----------------------------------------------------------------------
	// the date column this sits next to
	// -----------------------------------------------------------------------

	it('shows the year for an old area and the day for a recent one', function () {
		assert.ok(html.includes('Mar 2021'), 'a 2021 area must not read as fresh');
		assert.ok(/Jul \d{2}/.test(html), 'a recent area keeps its day');
	});

	it('carries the exact date in a tooltip', function () {
		assert.ok(html.includes('March 2021'),
			'the abbreviated form should never be the only thing available');
	});
});
