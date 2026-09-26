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
});
