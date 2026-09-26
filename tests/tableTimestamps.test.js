// tests/tableTimestamps.test.js: one timestamp format for every table, and
// date columns that sort by date.
//
// The admin log pages printed `new Date(x).toLocaleString()`, which in Node's
// default locale is "9/22/2026, 5:57:03 PM", and DataTables sorted it as text:
// 10/1 before 9/30, 5 PM before 9 AM. Other list pages printed "September 22,
// 2026" or "Sep 22", which sort by month name. Issue #56.
//
// Now every DataTables view renders dates through the `ts` mixin, with the
// epoch as the cell's data-order. The last two tests are guards over the views
// themselves, so the next log page cannot quietly go back to the old way.
//
// Run: npx mocha --no-config --exit tests/tableTimestamps.test.js

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import pug from 'pug';
import { formatTimestamp, timestampMs } from '../src/utils/dateFormat.js';
import { format as localFormat, shortDate } from '../public/js/localTime.js';
import { formatListDate } from '../src/utils/dateFormat.js';
import { DateTime } from 'luxon';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
var VIEWS = path.join(ROOT, 'src', 'views');

describe('formatTimestamp', function () {
	var saved;
	before(function () { saved = process.env.TZ; process.env.TZ = 'America/Edmonton'; });
	after(function () { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; });

	it('zero pads and uses a 24-hour clock', function () {
		assert.strictEqual(formatTimestamp('2026-03-05T14:07:09Z'), '2026-03-05 07:07:09');
		assert.strictEqual(formatTimestamp('2026-10-01T23:59:00Z'), '2026-10-01 17:59:00');
	});

	it('gives the date alone when asked', function () {
		assert.strictEqual(formatTimestamp('2026-03-05T14:07:09Z', { dateOnly: true }), '2026-03-05');
	});

	it('sorts correctly even as text', function () {
		var values = ['2026-09-30T12:00:00Z', '2026-10-01T12:00:00Z', '2026-09-03T21:00:00Z', '2026-09-03T15:00:00Z'];
		var asText = values.map(function (v) { return formatTimestamp(v); }).sort();
		var byTime = values.slice().sort(function (a, b) { return Date.parse(a) - Date.parse(b); })
			.map(function (v) { return formatTimestamp(v); });
		assert.deepStrictEqual(asText, byTime);
	});

	it('accepts what pg hands back: a Date, a string, epoch millis', function () {
		var d = new Date('2026-03-05T14:07:09Z');
		assert.strictEqual(formatTimestamp(d), formatTimestamp(d.getTime()));
		assert.strictEqual(formatTimestamp(d), formatTimestamp('2026-03-05 14:07:09+00'));
	});

	it('is null for nothing, and timestampMs gives the instant', function () {
		assert.strictEqual(formatTimestamp(null), null);
		assert.strictEqual(formatTimestamp('not a date'), null);
		assert.strictEqual(timestampMs(null), null);
		assert.strictEqual(timestampMs('2026-03-05T14:07:09Z'), Date.parse('2026-03-05T14:07:09Z'));
	});
});

describe('localTime.format, in the browser', function () {
	var saved;
	before(function () { saved = process.env.TZ; });
	after(function () { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; });

	it('writes the same format as the server, in the viewer\'s timezone', function () {
		var ms = Date.parse('2026-03-05T14:07:09Z');
		process.env.TZ = 'America/Edmonton';
		assert.strictEqual(localFormat(ms), formatTimestamp(ms));
		process.env.TZ = 'Europe/Berlin';
		assert.strictEqual(localFormat(ms), '2026-03-05 15:07:09');
		assert.strictEqual(localFormat(ms, 'date'), '2026-03-05');
	});

	it('writes nothing for something that is not a time', function () {
		assert.strictEqual(localFormat('x'), '');
	});
});

// Mode "list" (the PM inbox's date columns): the full timestamp on a wide
// screen, the short list form on a phone, where "2026-09-25 20:37:40" took
// most of the width and left sender and subject a few characters each.
describe('localTime list mode', function () {
	var NOW = Date.parse('2026-09-25T18:00:00Z');

	it('is the full timestamp on a wide screen and the short form on a narrow one', function () {
		var ms = Date.parse('2026-09-25T02:37:40Z');
		assert.strictEqual(localFormat(ms, 'list', false), localFormat(ms));
		assert.match(localFormat(ms, 'list', true), /^[A-Z][a-z]{2} \d{2}$/);
	});

	it('agrees with formatListDate, the server\'s rule for list columns', function () {
		var saved = process.env.TZ;
		process.env.TZ = 'America/Edmonton';
		try {
			for (var iso of ['2026-09-25T02:00:00Z', '2026-04-01T12:00:00Z', '2026-03-01T12:00:00Z', '2025-09-24T12:00:00Z', '2026-10-01T12:00:00Z']) {
				var ms = Date.parse(iso);
				var server = formatListDate(ms, { now: DateTime.fromMillis(NOW) });
				assert.strictEqual(shortDate(ms, NOW), server, iso);
			}
		} finally {
			if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
		}
	});
});

describe('the ts mixin', function () {
	it('renders the server-side text inside a <time> carrying the instant', function () {
		var html = pug.render('include partials/mixins/timestamp.pug\n+ts(v)\n+ts(null)\n', {
			filename: path.join(VIEWS, 'x.pug'), basedir: VIEWS,
			v: '2026-03-05T14:07:09Z', formatTimestamp: formatTimestamp, timestampMs: timestampMs
		});
		var ms = Date.parse('2026-03-05T14:07:09Z');
		assert.ok(html.includes('data-ts="' + ms + '"'), html);
		assert.ok(html.includes('datetime="2026-03-05T14:07:09.000Z"'), html);
		assert.ok(html.includes('>' + formatTimestamp(ms) + '</time>'), html);
		assert.ok(/<span class="text-muted">-<\/span>/.test(html), 'a missing date renders a placeholder');
	});

	it('is available to every view through the admin and user layouts', function () {
		for (var l of ['admin', 'user']) {
			var src = fs.readFileSync(path.join(VIEWS, 'layouts', l + '.pug'), 'utf8');
			assert.ok(src.includes('include ../partials/mixins/timestamp.pug'), l);
			assert.ok(src.includes("script(type='module' src='/js/localTime.js')"), l);
		}
	});
});

function walk(dir) {
	var out = [];
	for (var e of fs.readdirSync(dir, { withFileTypes: true })) {
		var p = path.join(dir, e.name);
		if (e.isDirectory()) out = out.concat(walk(p));
		else if (e.name.endsWith('.pug')) out.push(p);
	}
	return out;
}

var dataTablesViews = walk(VIEWS).filter(function (f) { return fs.readFileSync(f, 'utf8').includes('DataTable('); });

describe('DataTables views', function () {

	it('were found, so the guards below are checking something', function () {
		assert.ok(dataTablesViews.length >= 15, dataTablesViews.length + ' views');
	});

	it('format no date of their own: every one goes through the ts mixin', function () {
		var bad = [];
		for (var f of dataTablesViews) {
			fs.readFileSync(f, 'utf8').split('\n').forEach(function (line, i) {
				if (/toLocaleDateString\(|toLocaleTimeString\(|new Date\([^)]*\)\.toLocaleString\(|\.toFormat\(/.test(line)) {
					bad.push(path.relative(ROOT, f) + ':' + (i + 1) + ': ' + line.trim());
				}
			});
		}
		assert.deepStrictEqual(bad, [], 'use +ts(value) and a data-order, see partials/mixins/timestamp.pug');
	});

	it('give every table cell holding a timestamp its instant as data-order', function () {
		var bad = [];
		for (var f of dataTablesViews) {
			var lines = fs.readFileSync(f, 'utf8').split('\n');
			lines.forEach(function (line, i) {
				if (!/^\s*\+ts\(/.test(line)) return;
				var indent = line.match(/^\s*/)[0].length;
				// The nearest enclosing element that is a table cell, if any.
				for (var j = i - 1; j >= 0 && j >= i - 6; j--) {
					var l = lines[j];
					var ind = l.match(/^\s*/)[0].length;
					if (!l.trim() || ind >= indent) continue;
					if (/^\s*td\b/.test(l)) {
						if (!/data-order=/.test(l)) bad.push(path.relative(ROOT, f) + ':' + (j + 1) + ': ' + l.trim());
						return;
					}
					indent = ind;
				}
			});
		}
		assert.deepStrictEqual(bad, [], 'a date cell without data-order sorts on its text');
	});
});
