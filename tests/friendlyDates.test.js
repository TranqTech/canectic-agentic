// tests/friendlyDates.test.js -- the one rule for dates people read on the
// user-facing side (#59).
//
// Server time and timezone, because a BBS runs by the system's clock:
// today "17:30", yesterday "Yesterday 17:30", 2-6 days "3 days ago", within
// six months "Sep 25", older "Dec 25, 2025". Tables that sort by date keep
// the full yyyy-MM-dd HH:mm:ss (+ts); admin pages are their own matter. User
// views used to print new Date(x).toLocale*String(), which is the server
// locale's unpadded 12-hour form and different on every page.

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { DateTime } from 'luxon';
import { formatFriendly } from '../src/utils/dateFormat.js';

var ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

describe('friendly dates (#59)', function () {

	var now = DateTime.fromISO('2026-09-29T00:10:00');
	var f = function (v, dateOnly) { return formatFriendly(v, { now: now, dateOnly: !!dateOnly }); };

	it('shows a bare time today and the time with Yesterday, by calendar day', function () {
		assert.strictEqual(f('2026-09-29T00:05:00'), '00:05');
		assert.strictEqual(f('2026-09-28T23:50:00'), 'Yesterday 23:50', 'twenty minutes ago but yesterday');
		assert.strictEqual(f('2026-09-28T08:00:00', true), 'Yesterday');
		assert.strictEqual(f('2026-09-29T00:05:00', true), 'Today');
	});

	it('counts days back through the week, without a time', function () {
		assert.strictEqual(f('2026-09-27T12:00:00'), '2 days ago');
		assert.strictEqual(f('2026-09-23T12:00:00'), '6 days ago');
		assert.strictEqual(f('2026-09-22T12:00:00'), 'Sep 22', 'a week back is a date');
	});

	it('gives month and day within six months, and the year after', function () {
		assert.strictEqual(f('2026-04-05T08:00:00'), 'Apr 5');
		assert.strictEqual(f('2025-12-25T08:00:00'), 'Dec 25, 2025');
	});

	it('keeps the day across New Year while it is recent', function () {
		var jan = DateTime.fromISO('2027-01-10T09:00:00');
		assert.strictEqual(formatFriendly('2026-12-20T09:00:00', { now: jan }), 'Dec 20');
	});

	it('mirrors the rule ahead of now', function () {
		assert.strictEqual(f('2026-09-29T17:30:00'), '17:30');
		assert.strictEqual(f('2026-09-30T09:00:00'), 'Tomorrow 09:00');
		assert.strictEqual(f('2026-10-03T09:00:00'), 'in 4 days');
	});

	it('answers null for nothing', function () {
		assert.strictEqual(formatFriendly(null), null);
		assert.strictEqual(formatFriendly('not a date'), null);
	});

	it('is what every user-facing view uses: no toLocale* date formatting left', function () {
		var files = [];
		var walk = function (dir) {
			for (var e of fs.readdirSync(dir, { withFileTypes: true })) {
				var p = path.join(dir, e.name);
				if (e.isDirectory()) { if (e.name !== 'admin') walk(p); }
				else if (/\.pug$/.test(e.name)) files.push(p);
			}
		};
		walk(path.join(ROOT, 'src/views'));
		for (var r of ['index.js', 'users.js', 'pm.js', 'files.js', 'callflow.js', 'doorserver.js']) {
			var rp = path.join(ROOT, 'src/routes', r);
			if (fs.existsSync(rp)) files.push(rp);
		}
		// Web blocks (#91) load what the call flow and landing page show
		for (var wb of fs.readdirSync(path.join(ROOT, 'src/webBlocks'))) {
			if (/\.js$/.test(wb)) files.push(path.join(ROOT, 'src/webBlocks', wb));
		}
		files.push(path.join(ROOT, 'public/js/maintenanceBanner.js'));
		var offenders = [];
		for (var file of files) {
			fs.readFileSync(file, 'utf8').split('\n').forEach(function (line, i) {
				// Dates only: number formatting (counts, totals) is fine
				if (/pre-#59 fallback/.test(line)) return;
				if (/toLocale(Date|Time)String\(/.test(line) || (/toLocaleString\(/.test(line) && /Date\(/.test(line))) {
					offenders.push(path.relative(ROOT, file) + ':' + (i + 1));
				}
			});
		}
		assert.deepStrictEqual(offenders, []);
	});
});
