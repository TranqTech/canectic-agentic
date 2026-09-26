// tests/areaListingLayout.test.js — the message and file area listings fit a phone.
//
// Rendered in headless Chromium at 390px (2026-09-25), /messages was 664px wide
// and /files 627px: a desktop grid keeping its side columns (a third of the
// width), the header's title, toggle, sort, search and buttons on one line,
// and five or six table columns. After: both pages exactly the screen's width
// at 390 and 360px, and desktop unchanged at 1366px.
//
// The two templates are built the same way and were fixed the same way; this
// holds them to it so one cannot drift back.
//
// Run: npx mocha --no-config --exit tests/areaListingLayout.test.js

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
var CSS = fs.readFileSync(path.join(ROOT, 'public/css/styles.css'), 'utf8');

describe('area listings on a phone', function () {
	['messages', 'files'].forEach(function (section) {
		var src = fs.readFileSync(path.join(ROOT, 'src/views/' + section + '/index.pug'), 'utf8');

		describe(section, function () {
			it('uses the full width below lg', function () {
				assert.match(src, /\.col-1\.d-none\.d-lg-block/);
				assert.match(src, /\.col-12\.col-lg-10/);
			});

			it('has a header that can wrap, and a search box without a fixed width', function () {
				assert.match(src, /\.area-list-header\./);
				assert.match(src, /\.area-tools\./);
				assert.match(src, /\.area-search\.input-group/);
				assert.doesNotMatch(src, /style='width:220px'/);
			});

			it('moves the description under the name instead of a column below md', function () {
				assert.match(src, /td\.d-none\.d-md-table-cell= area\.description/);
				assert.match(src, /\.small\.text-muted\.d-md-none= area\.description/);
			});

			it('drops the count column below sm', function () {
				assert.match(src, /td\.area-num\.text-center\.d-none\.d-sm-table-cell/);
			});
		});
	});

	it('styles.css carries the rules both templates rely on', function () {
		assert.match(CSS, /\.area-search \{\s*width: 220px;/);
		var lg = CSS.slice(CSS.indexOf('.area-list-header {'));
		assert.match(lg, /flex-wrap: wrap/);
		assert.match(CSS, /\.area-list-header \.area-tools \{\s*flex: 1 1 100%;/);
	});

	// The threads list (threaded areas): on a phone each thread is one cell with
	// the subject in full and a details line; checked with rows built by the
	// template AND by the script for threads loaded on scroll (70 of 70 at 390px).
	describe('threads list', function () {
		var src = fs.readFileSync(path.join(ROOT, 'src/views/messages/areas/view.pug'), 'utf8');
		var script = src.slice(src.indexOf('function buildRowHtml'));

		it('uses the full width below lg', function () {
			assert.match(src, /\.col-1\.d-none\.d-lg-block/);
			assert.match(src, /\.col-12\.col-lg-10/);
		});

		it('puts the details under the subject on a phone, in both copies of the row', function () {
			assert.match(src, /td\.thread-subject/);
			assert.match(src, /\.thread-meta\.small\.d-md-none/);
			assert.match(script, /class="thread-subject"/);
			assert.match(script, /class="thread-meta small d-md-none"/);
			assert.strictEqual((script.match(/d-none d-md-table-cell/g) || []).length, 4);
		});

		it('gives replies and unread a column of their own on a phone, not the details text', function () {
			assert.match(src, /td\.thread-counts\.d-md-none/);
			assert.match(script, /class="thread-counts d-md-none"/);
			var meta = script.slice(script.indexOf('thread-meta'), script.indexOf('thread-counts'));
			assert.doesNotMatch(meta, /repl(y|ies)|badge/, 'counts are back in the details line');
			// The rule may be shared with the group pages' .list-counts.
			assert.match(CSS, /\.thread-counts[^{]*\{[^}]*text-align: right/);
		});

		it('hides the header row with our own rule, not a Bootstrap class that does not exist', function () {
			assert.match(src, /thead\.thread-head/);
			assert.doesNotMatch(src, /table-header-group/);
			assert.match(CSS, /\.thread-head[^{]*\{\s*display: none;/);
		});
	});
});
