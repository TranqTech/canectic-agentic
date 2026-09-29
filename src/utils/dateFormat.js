/**
 * Shared date formatting for list views.
 *
 * The problem this solves: a column showing "Mar 15" is unreadable on its own,
 * because an area whose last message arrived in 2021 looks exactly as fresh as
 * one from last week. On a board carrying a few hundred echoes, that is most of
 * the list lying to you.
 *
 * The fix is the one `ls -l` has used for decades: keep the day for anything
 * recent, and swap the day for the year once it is old enough that the day
 * stopped being the useful part.
 */

import { DateTime } from 'luxon';

// Six months, matching `ls -l`. The threshold has to be generous enough that a
// December message read on New Year's Day still shows its day: a plain "is it a
// previous calendar year" test would drop the day from a six week old message
// purely because the year rolled over, which is worse than the problem being
// fixed.
var DEFAULT_RECENT_MONTHS = 6;

/**
 * Format a date for a list column.
 *
 *   within the window   "Mar 15"
 *   older               "Mar 2021"
 *
 * @param {string|number|Date} value        anything Date.parse or Luxon accepts
 * @param {object}  [opts]
 * @param {number}  [opts.recentMonths]     window in months, default 6
 * @param {DateTime}[opts.now]              for testing
 * @returns {string|null} null when the value is missing or unparseable, so the
 *                        caller can render its own placeholder
 */
function formatListDate(value, opts) {
	opts = opts || {};
	var dt = toDateTime(value);
	if (!dt) return null;

	var now = opts.now || DateTime.now();
	var months = opts.recentMonths === undefined ? DEFAULT_RECENT_MONTHS : opts.recentMonths;

	// A future date keeps its day. Clock skew between systems is normal in FTN
	// and a message dated slightly ahead is not old.
	if (dt > now) return dt.toFormat('MMM dd');

	var age = now.diff(dt, 'months').months;
	return age < months ? dt.toFormat('MMM dd') : dt.toFormat('MMM yyyy');
}

/**
 * Full date for a tooltip, so the exact value is always one hover away even
 * when the column is showing the abbreviated form.
 */
function formatListDateFull(value) {
	var dt = toDateTime(value);
	return dt ? dt.toFormat('cccc d LLLL yyyy, HH:mm') : null;
}

function toDateTime(value) {
	if (value === null || value === undefined || value === '') return null;

	var dt;
	if (value instanceof Date) {
		dt = DateTime.fromJSDate(value);
	} else if (typeof value === 'number') {
		dt = DateTime.fromMillis(value);
	} else {
		var str = String(value).trim();

		// A bare "YYYY-MM-DD" is treated as UTC midnight by Date.parse, which
		// then displays as the previous day anywhere west of Greenwich. The
		// timestamptz values pg hands us carry an offset and are unaffected,
		// but the helper is shared, so read a bare date as local instead.
		var bare = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
		if (bare) {
			dt = DateTime.local(parseInt(bare[1]), parseInt(bare[2]), parseInt(bare[3]));
		} else {
			// Date.parse rather than fromISO: the column arrives as a string
			// from pg in a format Luxon's stricter parsers reject.
			var ms = Date.parse(str);
			if (isNaN(ms)) return null;
			dt = DateTime.fromMillis(ms);
		}
	}

	return dt.isValid ? dt : null;
}

/**
 * A timestamp for a table cell: "2026-09-22 17:57:03", or "2026-09-22" with
 * `dateOnly`. Zero padded and 24-hour, so it reads the same everywhere and
 * sorts correctly even as text.
 *
 * Every DataTables view renders dates through this (via the `ts` mixin in
 * views/partials/mixins/timestamp.pug). They used `toLocaleString()`, which in
 * Node's default locale is "9/22/2026, 5:57:03 PM": no padding, a 12-hour clock
 * and month first, so every date column sorted as text, with 10/1 before 9/30
 * and 5 PM before 9 AM.
 *
 * Rendered in the server's timezone. public/js/localTime.js rewrites it in the
 * viewer's own timezone in the browser, in the same format; for a sysop that is
 * almost always the same thing, and without JavaScript the server's is shown.
 *
 * @returns {string|null} null when the value is missing or unparseable
 */
function formatTimestamp(value, opts) {
	var dt = toDateTime(value);
	if (!dt) return null;
	return dt.toFormat(opts && opts.dateOnly ? 'yyyy-MM-dd' : 'yyyy-MM-dd HH:mm:ss');
}

/**
 * Epoch milliseconds for a DataTables `data-order`, so a date column sorts on
 * the instant and never on its text. Null when there is no date, which a cell
 * should render as 0 so undated rows sort together at one end.
 */
function timestampMs(value) {
	var dt = toDateTime(value);
	return dt ? dt.toMillis() : null;
}

/**
 * A date for people to read on the user-facing side (#59), in the SERVER'S
 * time and timezone: much of what happens on a BBS runs by the system's clock
 * rather than the caller's, so every caller sees the board's time. (Tables
 * that sort by date use formatTimestamp instead; admin pages are their own
 * matter.)
 *
 *   today                 "17:30"             dateOnly: "Today"
 *   yesterday             "Yesterday 17:30"   dateOnly: "Yesterday"
 *   2 to 6 days ago       "3 days ago"
 *   within 6 months       "Sep 25"
 *   older                 "Dec 25, 2025"
 *
 * Ahead of now, mirrored: today "17:30", "Tomorrow 09:00", "in 3 days", then
 * the same dates. Days are calendar days on the server's clock, not 24 hour
 * spans, so 23:50 yesterday is "Yesterday 23:50" at 00:10 today.
 *
 * @param {string|number|Date} value
 * @param {object}   [opts]
 * @param {boolean}  [opts.dateOnly]  the value is a date without a time
 * @param {DateTime} [opts.now]       for testing
 * @returns {string|null} null when missing or unparseable
 */
function formatFriendly(value, opts) {
	opts = opts || {};
	var dt = toDateTime(value);
	if (!dt) return null;
	var now = opts.now || DateTime.now();
	var days = Math.round(now.startOf('day').diff(dt.startOf('day'), 'days').days);
	var time = dt.toFormat('HH:mm');
	if (days === 0) return opts.dateOnly ? 'Today' : time;
	if (days === 1) return opts.dateOnly ? 'Yesterday' : 'Yesterday ' + time;
	if (days === -1) return opts.dateOnly ? 'Tomorrow' : 'Tomorrow ' + time;
	if (days >= 2 && days <= 6) return days + ' days ago';
	if (days <= -2 && days >= -6) return 'in ' + (-days) + ' days';
	var months = Math.abs(now.diff(dt, 'months').months);
	return months < DEFAULT_RECENT_MONTHS ? dt.toFormat('MMM d') : dt.toFormat('MMM d, yyyy');
}

export { formatListDate, formatListDateFull, formatTimestamp, timestampMs, formatFriendly, DEFAULT_RECENT_MONTHS };
