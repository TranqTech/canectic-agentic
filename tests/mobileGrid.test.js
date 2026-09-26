// tests/mobileGrid.test.js — user pages use the full width on a phone (#64).
//
// The user-facing pages were laid out as `.col-1` / `.col-10` (or `.col-2` /
// `.col-8`): side columns that Bootstrap keeps at every width, so on a phone a
// third of the screen was empty margin and tables squeezed into the rest. The
// fix everywhere is `.col-1.d-none.d-lg-block` / `.col-12.col-lg-10`.
//
// Rendered with a real phone user agent (Playwright's Pixel 7 and iPhone SE:
// the server picks some layouts from the user agent, and a desktop one had
// been masking that) every page below fits the screen, and at 1280px each is
// unchanged.
//
// This scans for the old pattern rather than listing pages, so a new page
// written the old way fails here too. Admin pages are out of scope. The login
// partial and the login-required catch page are exempt: their spacer columns
// are only in the desktop branch, and phones get a separate `ismobile` layout
// (the login form's was checked at 412px).
//
// Run: npx mocha --no-config --exit tests/mobileGrid.test.js

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
var VIEWS = path.join(ROOT, 'src/views');
// Both keep their spacer columns only inside `if !ismobile`: phones get a
// separate layout. status/loginrequired.pug is a catch page kept for future
// use even though nothing renders it today.
var EXEMPT = ['partials/users/login.pug', 'status/loginrequired.pug'];

function pugFiles(dir) {
	var out = [];
	for (var e of fs.readdirSync(dir, { withFileTypes: true })) {
		var p = path.join(dir, e.name);
		if (e.isDirectory()) { if (e.name !== 'admin') out = out.concat(pugFiles(p)); }
		else if (e.name.endsWith('.pug')) out.push(p);
	}
	return out;
}

describe('user pages on a phone', function () {
	it('have no side column that stays at every width', function () {
		var offenders = [];
		for (var f of pugFiles(VIEWS)) {
			var rel = path.relative(VIEWS, f);
			if (EXEMPT.includes(rel)) continue;
			var lines = fs.readFileSync(f, 'utf8').split('\n');
			lines.forEach(function (line, i) {
				// A bare .col-1 or .col-2 on its own line is a spacer column.
				if (/^\s*\.col-(1|2)\s*$/.test(line)) offenders.push(rel + ':' + (i + 1));
			});
		}
		assert.deepStrictEqual(offenders, [], 'use .col-1.d-none.d-lg-block and .col-12.col-lg-10');
	});

	it('put the details under the name on a phone in the file and group lists', function () {
		var checks = {
			'files/areas/view.pug': /th\.text-center\.d-none\.d-md-table-cell\(scope='col'\) Size/,
			'files/new.pug': /td\.text-center\.text-nowrap\.d-none\.d-md-table-cell/,
			'files/search.pug': /th\.d-none\.d-md-table-cell Area/,
			'messages/groups/view.pug': /td\.list-counts\.d-md-none/
		};
		for (var rel of Object.keys(checks)) {
			var src = fs.readFileSync(path.join(VIEWS, rel), 'utf8');
			assert.match(src, checks[rel], rel);
			assert.match(src, /\.small\.d-md-none/, rel + ' has no phone details line');
		}
	});

});
