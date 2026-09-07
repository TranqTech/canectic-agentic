// tests/dateFormat.test.js: list-column date formatting.
//
// The message areas list showed "Mar 15" with no year, so an echo whose last
// message arrived in 2021 read as freshly as one from last week. On a board
// carrying a few hundred areas that makes most of the column misleading.
//
// The rule is the one `ls -l` uses: keep the day while it is the useful part,
// swap it for the year once it is not. The boundary matters more than it looks.
// A plain "is this a previous calendar year" test would drop the day from a six
// week old December message as soon as the year rolled over, which is worse
// than the problem being fixed, so the tests below pin the New Year case
// specifically.
//
// Pure: no database needed. `now` is injected so the assertions do not rot.
// Run: npx mocha --spec tests/dateFormat.test.js

import assert from 'assert';
import { DateTime } from 'luxon';

var mod = null;
try {
	mod = await import('../src/utils/dateFormat.js');
} catch (_) { mod = null; }

describe('dateFormat.formatListDate', function () {
	before(function () { if (!mod) this.skip(); });

	// New Year's Day, the case that motivates the threshold.
	var NEWYEAR = DateTime.fromISO('2026-01-01T12:00:00');

	function fmt(value, now, months) {
		var opts = { now: now || NEWYEAR };
		if (months !== undefined) opts.recentMonths = months;
		return mod.formatListDate(value, opts);
	}

	// -----------------------------------------------------------------------
	// the point of the change
	// -----------------------------------------------------------------------

	it('shows the year for a message from years ago', function () {
		assert.strictEqual(fmt('2021-03-15 22:10:00-06'), 'Mar 2021');
	});

	it('does not let an old message masquerade as recent', function () {
		// The bug: both of these used to render "Mar 15".
		var old    = fmt('2021-03-15 22:10:00-06');
		var recent = fmt('2025-12-15 22:10:00-06');
		assert.notStrictEqual(old, recent,
			'a 2021 message and a three week old one must not render identically');
	});

	// -----------------------------------------------------------------------
	// the New Year boundary
	// -----------------------------------------------------------------------

	it('keeps the day for a December message read on New Years Day', function () {
		assert.strictEqual(fmt('2025-12-20 14:30:00-07'), 'Dec 20',
			'six weeks old is not old enough to lose the day just because the year rolled');
	});

	it('keeps the day for a November message read on New Years Day', function () {
		assert.strictEqual(fmt('2025-11-05 09:00:00-07'), 'Nov 05');
	});

	it('keeps the day right up to the window edge', function () {
		// ~4.5 months before the reference date.
		assert.strictEqual(fmt('2025-08-15 09:00:00-06'), 'Aug 15');
	});

	it('switches to the year once past the window', function () {
		// ~6.4 months before the reference date.
		assert.strictEqual(fmt('2025-06-20 09:00:00-06'), 'Jun 2025');
	});

	it('honours a caller-supplied window', function () {
		var d = '2025-10-01 09:00:00-06';   // 3 months before the reference
		assert.strictEqual(fmt(d, NEWYEAR, 6), 'Oct 01', 'inside a 6 month window');
		assert.strictEqual(fmt(d, NEWYEAR, 1), 'Oct 2025', 'outside a 1 month window');
	});

	it('defaults to a six month window', function () {
		assert.strictEqual(mod.DEFAULT_RECENT_MONTHS, 6);
	});

	// -----------------------------------------------------------------------
	// parsing
	// -----------------------------------------------------------------------

	it('reads the timestamptz shape postgres returns', function () {
		assert.strictEqual(fmt('2026-07-16 14:57:42-06', DateTime.fromISO('2026-08-01T12:00:00')), 'Jul 16');
	});

	it('reads a bare date as local rather than shifting it a day back', function () {
		// Date.parse treats "2025-12-20" as UTC midnight, which displays as the
		// 19th anywhere west of Greenwich.
		assert.strictEqual(fmt('2025-12-20'), 'Dec 20');
	});

	it('accepts a Date object', function () {
		var d = new Date(2025, 11, 20, 14, 30);
		assert.strictEqual(fmt(d), 'Dec 20');
	});

	it('accepts epoch milliseconds', function () {
		var ms = DateTime.fromISO('2025-12-20T14:30:00').toMillis();
		assert.strictEqual(fmt(ms), 'Dec 20');
	});

	// -----------------------------------------------------------------------
	// shapes the column has to survive
	// -----------------------------------------------------------------------

	it('returns null for missing values so the caller can render a placeholder', function () {
		assert.strictEqual(fmt(null), null);
		assert.strictEqual(fmt(undefined), null);
		assert.strictEqual(fmt(''), null);
	});

	it('returns null for something unparseable rather than throwing', function () {
		assert.strictEqual(fmt('not a date'), null);
		assert.strictEqual(fmt('0000-00-00'), null);
	});

	it('keeps the day for a future date, since clock skew is normal in FTN', function () {
		assert.strictEqual(fmt('2026-02-01 09:00:00-07'), 'Feb 01',
			'a message dated slightly ahead is not old');
	});
});

describe('dateFormat.formatListDateFull', function () {
	before(function () { if (!mod) this.skip(); });

	it('gives the exact value for a tooltip', function () {
		var text = mod.formatListDateFull('2021-03-15 22:10:00-06');
		assert.ok(text.includes('2021'), 'the year has to be there: ' + text);
		assert.ok(text.includes('March'), 'and the month spelled out: ' + text);
		assert.ok(/\d{2}:\d{2}/.test(text), 'and a time: ' + text);
	});

	it('returns null for missing or unparseable values', function () {
		assert.strictEqual(mod.formatListDateFull(null), null);
		assert.strictEqual(mod.formatListDateFull('nonsense'), null);
	});
});
