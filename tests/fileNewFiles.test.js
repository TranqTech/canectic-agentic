// tests/fileNewFiles.test.js — the web's new-file views.
//
// "New" means arrived (upload_date) since the start of the user's previous
// visit, the classic BBS newscan (src/utils/newSince.js). It used to be a
// per-area read pointer moved forward by viewing pages; nothing moves anything
// now, so a file stays marked for the whole visit.
//
// The marker compares a file's upload_date, which postgres returns as a Date
// or a string depending on the driver path, with the baseline in epoch ms.
//
// Pure: renders the templates directly, no database.
// Run: npx mocha --no-config --exit tests/fileNewFiles.test.js

import assert from 'assert';
import { DateTime } from 'luxon';
import { formatTimestamp, timestampMs } from '../src/utils/dateFormat.js';

var pug = null;
try { pug = (await import('pug')).default; } catch (_) { pug = null; }

function formatBytes(n) { return String(n) + ' B'; }

// Rows as postgres returns them: ids are strings.
function entry(id, filename, uploaded) {
	return {
		id: String(id), uuid: 'uuid-' + id, filename: filename || ('FILE' + id + '.ZIP'),
		file_size: 1024, upload_date: uploaded || '2026-09-18T00:00:00.000Z',
		short_desc: 'desc ' + id, download_count: 0,
	};
}

// The previous visit began here.
var SINCE = Date.parse('2026-09-20T12:00:00Z');

function renderArea(locals) {
	var fn = pug.compileFile('src/views/files/areas/view.pug');
	return fn(Object.assign({
		currentuser: { username: 'tester' }, sufficientAccess: true,
		canDownload: true, canUpload: false,
		fileArea: { shortcode: 'UPLOADS', name: 'Uploads', description: '' },
		fileGroup: { shortcode: 'GEN', name: 'General' },
		filelist: [], totalFiles: 0, newSinceMs: SINCE, newCount: 0, newOnly: false,
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

	function rowFor(html, name) {
		var m = html.match(new RegExp('<tr[^>]*>(?:(?!</tr>)[\\s\\S])*?' + name + '[\\s\\S]*?</tr>'));
		return m ? m[0] : '';
	}

	it('marks only the files that arrived since the previous visit', function () {
		var html = renderArea({
			filelist: [entry(37, 'NEWEST.ZIP', '2026-09-24T08:00:00Z'), entry(36, 'SEEN.ZIP', '2026-09-19T08:00:00Z'), entry(9, 'OLD.ZIP', '2025-01-01T00:00:00Z')],
			totalFiles: 3, newCount: 1,
		});
		assert.strictEqual((html.match(/data-is-new="true"/g) || []).length, 1, 'exactly one row should be NEW');
		assert.ok(/data-is-new="true"/.test(rowFor(html, 'NEWEST\\.ZIP')), 'the file from Sep 24 is NEW');
		assert.ok(!/data-is-new="true"/.test(rowFor(html, 'SEEN\\.ZIP')), 'the file from before the visit is not');
	});

	it('goes by arrival, not by id', function () {
		// A low id that arrived late (an import, a re-hatch) is still new.
		var html = renderArea({ filelist: [entry(3, 'LATE.ZIP', '2026-09-25T00:00:00Z')], totalFiles: 1, newCount: 1 });
		assert.ok(/data-is-new="true"/.test(html));
	});

	it('takes upload_date as a Date as well as a string', function () {
		var html = renderArea({ filelist: [entry(5, 'D.ZIP', new Date('2026-09-25T00:00:00Z'))], totalFiles: 1, newCount: 1 });
		assert.ok(/data-is-new="true"/.test(html));
	});

	it('marks nothing at the boundary itself', function () {
		var html = renderArea({ filelist: [entry(5, 'EDGE.ZIP', new Date(SINCE).toISOString())], totalFiles: 1, newCount: 0 });
		assert.ok(!/data-is-new="true"/.test(html));
	});
});

// ---------------------------------------------------------------------------
// The toggle
// ---------------------------------------------------------------------------

describe('file area view — new-only toggle', function () {
	before(function () { if (!pug) this.skip(); });

	it('offers a New link with the count when there are new files', function () {
		var html = renderArea({ filelist: [entry(5)], totalFiles: 1, newCount: 1 });
		assert.ok(html.includes('/files/area/UPLOADS?new=1'), 'New link must be present');
	});

	it('offers no New link when nothing is new', function () {
		var html = renderArea({ filelist: [entry(5)], totalFiles: 1, newCount: 0 });
		assert.ok(!html.includes('?new=1'), 'no New link when there is nothing new');
	});

	it('says how many of the new files a capped new-only page shows', function () {
		var html = renderArea({
			filelist: [entry(1), entry(2)], totalFiles: 90, newCount: 90, newOnly: true,
		});
		assert.ok(/Showing 2 of 90 new since your last visit, newest first/.test(html));
		assert.ok(!/reload to continue/.test(html), 'reloading no longer moves anything along');
	});

	it('offers a way back to the full listing when new-only is empty', function () {
		var html = renderArea({ filelist: [], totalFiles: 12, newCount: 0, newOnly: true });
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
