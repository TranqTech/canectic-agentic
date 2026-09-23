// tests/fileNewFiles.test.js — the web's new-file views.
//
// Two things are worth holding down here, and neither throws when it breaks.
//
// 1. The NEW marker is a comparison between a file id and a scan pointer, and
//    postgres hands both back as strings. Compared as strings, '9' > '37' is
//    true and '10' > '9' is false, so the markers land on the wrong rows while
//    the page renders perfectly. The template must compare them as integers.
//
// 2. The new-only listing advances the scan pointer over exactly the rows it
//    shows. If it were ordered newest-first like the main listing, a backlog
//    larger than one page would have its oldest files marked read without ever
//    being displayed — they would simply never appear again.
//
// Pure: renders the templates directly and exercises the model's SQL shape,
// no database.
// Run: npx mocha --no-config --no-package tests/fileNewFiles.test.js

import assert from 'assert';
import { DateTime } from 'luxon';
import { formatTimestamp, timestampMs } from '../src/utils/dateFormat.js';

var pug = null;
try { pug = (await import('pug')).default; } catch (_) { pug = null; }

function formatBytes(n) { return String(n) + ' B'; }

// Rows as postgres returns them: ids are strings.
function entry(id, filename) {
	return {
		id: String(id), uuid: 'uuid-' + id, filename: filename || ('FILE' + id + '.ZIP'),
		file_size: 1024, upload_date: '2026-09-18T00:00:00.000Z',
		short_desc: 'desc ' + id, download_count: 0,
	};
}

function renderArea(locals) {
	var fn = pug.compileFile('src/views/files/areas/view.pug');
	return fn(Object.assign({
		currentuser: { username: 'tester' }, sufficientAccess: true,
		canDownload: true, canUpload: false,
		fileArea: { shortcode: 'UPLOADS', name: 'Uploads', description: '' },
		fileGroup: { shortcode: 'GEN', name: 'General' },
		filelist: [], totalFiles: 0, scanPointer: 0, newCount: 0, newOnly: false,
		formatBytes: formatBytes, uploaded: null, error: null,
		// Set app-wide by webserver.js; a view rendered on its own needs them passed.
		formatTimestamp: formatTimestamp, timestampMs: timestampMs,
		DateTime: DateTime, ismobile: false, boardname: 'Test', activelink: 'files',
		currentPath: '/files/area/UPLOADS', pmUnreadCount: 0, faviconlink: '/x.ico',
	}, locals));
}

// ---------------------------------------------------------------------------
// NEW markers
// ---------------------------------------------------------------------------

describe('file area view — NEW markers', function () {
	before(function () { if (!pug) this.skip(); });

	it('marks only the files above the scan pointer', function () {
		// Pointer 36: file 37 is new, 36 and 9 are not. Compared as strings
		// this inverts, because '9' > '36'.
		var html = renderArea({
			filelist: [entry(37, 'NEWEST.ZIP'), entry(36, 'SEEN.ZIP'), entry(9, 'OLD.ZIP')],
			totalFiles: 3, scanPointer: 36, newCount: 1,
		});

		var newRows = html.match(/data-is-new="true"/g) || [];
		assert.strictEqual(newRows.length, 1, 'exactly one row should be NEW');

		// And it must be the right one.
		assert.ok(/NEWEST\.ZIP/.test(html));
		var rowFor = function (name) {
			var m = html.match(new RegExp('<tr[^>]*>(?:(?!</tr>)[\\s\\S])*?' + name + '[\\s\\S]*?</tr>'));
			return m ? m[0] : '';
		};
		assert.ok(/data-is-new="true"/.test(rowFor('NEWEST\\.ZIP')), 'file 37 must be NEW');
		assert.ok(!/data-is-new="true"/.test(rowFor('SEEN\\.ZIP')), 'file 36 must not be NEW');
		assert.ok(!/data-is-new="true"/.test(rowFor('OLD\\.ZIP')), 'file 9 must not be NEW');
	});

	it('does not mark a single-digit id as newer than a double-digit pointer', function () {
		// The string comparison in its purest form: '9' > '10'.
		var html = renderArea({
			filelist: [entry(9, 'OLD.ZIP')], totalFiles: 1, scanPointer: 10, newCount: 0,
		});
		assert.ok(!/data-is-new="true"/.test(html), 'file 9 is older than pointer 10');
	});

	it('marks a double-digit id as newer than a single-digit pointer', function () {
		var html = renderArea({
			filelist: [entry(10, 'NEW.ZIP')], totalFiles: 1, scanPointer: 9, newCount: 1,
		});
		assert.ok(/data-is-new="true"/.test(html), 'file 10 is newer than pointer 9');
	});

	it('marks everything when the pointer is zero', function () {
		var html = renderArea({
			filelist: [entry(3), entry(2), entry(1)], totalFiles: 3, scanPointer: 0, newCount: 3,
		});
		assert.strictEqual((html.match(/data-is-new="true"/g) || []).length, 3);
	});

	it('is still right when the pointer arrives as a string', function () {
		// getPointer parses to a number today, which is the only reason a
		// naive `file.id > scanPointer` works here: string-against-number
		// coerces. Hand the template a raw scan_pointer straight off a row and
		// the comparison turns lexicographic, where '9' > '37' is true. Since
		// the template cannot see which it was given, it must not depend on it.
		var html = renderArea({
			filelist: [entry(37, 'NEWEST.ZIP'), entry(9, 'OLD.ZIP')],
			totalFiles: 2, scanPointer: '36', newCount: 1,
		});
		assert.strictEqual((html.match(/data-is-new="true"/g) || []).length, 1,
			'only file 37 is above pointer 36, whatever type the pointer has');
	});
});

// ---------------------------------------------------------------------------
// The toggle
// ---------------------------------------------------------------------------

describe('file area view — new-only toggle', function () {
	before(function () { if (!pug) this.skip(); });

	it('offers a New link with the count when there are new files', function () {
		var html = renderArea({ filelist: [entry(5)], totalFiles: 1, scanPointer: 0, newCount: 1 });
		assert.ok(html.includes('/files/area/UPLOADS?new=1'), 'New link must be present');
	});

	it('offers no New link when nothing is new', function () {
		var html = renderArea({ filelist: [entry(5)], totalFiles: 1, scanPointer: 5, newCount: 0 });
		assert.ok(!html.includes('?new=1'), 'no New link when there is nothing new');
	});

	it('says how far through the backlog a capped new-only page is', function () {
		// The user has to know that reloading shows more, or a backlog bigger
		// than a page looks like the whole of it.
		var html = renderArea({
			filelist: [entry(1), entry(2)], totalFiles: 90, scanPointer: 0,
			newCount: 90, newOnly: true,
		});
		assert.ok(/Showing 2 of 90 new files/.test(html));
		assert.ok(/reload to continue/.test(html), 'must say the listing continues');
	});

	it('offers a way back to the full listing when new-only is empty', function () {
		var html = renderArea({ filelist: [], totalFiles: 12, scanPointer: 99, newCount: 0, newOnly: true });
		assert.ok(/No new files in this area/.test(html));
		assert.ok(/Show all files/.test(html));
	});
});

// ---------------------------------------------------------------------------
// New files landing page
// ---------------------------------------------------------------------------

describe('new files page', function () {
	before(function () { if (!pug) this.skip(); });

	function renderNew(locals) {
		var fn = pug.compileFile('src/views/files/new.pug');
		return fn(Object.assign({
			currentuser: { username: 'tester' }, groupedAreas: [], totalNew: 0, showAll: false,
			formatBytes: formatBytes, DateTime: DateTime, ismobile: false,
			boardname: 'Test', activelink: 'files', currentPath: '/files/new',
			pmUnreadCount: 0, faviconlink: '/x.ico',
		}, locals));
	}

	it('links each area to its new-only listing', function () {
		var html = renderNew({
			totalNew: 3,
			groupedAreas: [{
				group: { shortcode: 'GEN', name: 'General' },
				areas: [{
					shortcode: 'UPLOADS', name: 'Uploads', subscribed: true,
					new_count: 3, preview: [entry(7), entry(8)],
				}],
			}],
		});

		assert.ok(html.includes('/files/area/UPLOADS?new=1'),
			'each area must link to its own new-only listing');
		assert.ok(/and 1 more/.test(html), 'must say the preview is partial');
	});

	it('says so plainly when there is nothing new', function () {
		var html = renderNew({});
		assert.ok(/No new files/.test(html));
		assert.ok(html.includes('/files/new?all=1'), 'must offer to widen the search');
	});
});

// ---------------------------------------------------------------------------
// The model query
// ---------------------------------------------------------------------------

describe('fileEntries.newEntriesOrderBy', function () {
	var newEntriesOrderBy = null;

	before(async function () {
		// The model imports postgres at module level, but pg.Pool construction
		// is lazy, so importing it opens no socket.
		try {
			newEntriesOrderBy = (await import('../src/models/fileEntries.js')).newEntriesOrderBy;
		} catch (_) { this.skip(); }
	});

	it('orders newest first by default, matching the full area listing', function () {
		assert.strictEqual(newEntriesOrderBy(), 'upload_date DESC, id DESC');
		assert.strictEqual(newEntriesOrderBy({}), 'upload_date DESC, id DESC');
		assert.strictEqual(newEntriesOrderBy({ oldestFirst: false }), 'upload_date DESC, id DESC');
	});

	it('orders oldest first for the catch-up listing', function () {
		// Load-bearing, and silent when wrong. The new-only page advances the
		// scan pointer to the highest id it displays. Ordered newest first, a
		// backlog larger than one page would have everything below the page
		// marked read without ever being shown.
		assert.strictEqual(newEntriesOrderBy({ oldestFirst: true }), 'upload_date ASC, id ASC');
	});

	it('breaks ties on id, so the pointer can always move', function () {
		// Files tossed in one batch share an upload_date to the second. With
		// no tiebreak the order within a batch is undefined, and a catch-up
		// page could show the same rows twice or skip some.
		assert.ok(/id (ASC|DESC)/.test(newEntriesOrderBy({ oldestFirst: true })));
		assert.ok(/id (ASC|DESC)/.test(newEntriesOrderBy()));
	});
});
