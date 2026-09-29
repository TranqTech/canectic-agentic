// adminDashboardCards.test.js: every page in the admin navbar has a card on
// the admin dashboard, which is where a sysop looks for what the board can do.
// The Door Server page (#86) shipped in 0.9.13a in the Doors menu only, and
// its absence from the dashboard read as there being no UI for it at all.

import assert from 'assert';
import fs from 'fs';

// Navbar pages deliberately without a card. Add one here only on purpose.
var NO_CARD = [
	'/admin'                   // the dashboard itself
];

describe('admin dashboard cards', function () {
	it('has a card for every admin navbar page', function () {
		var nav = fs.readFileSync('src/views/includes/admin-nav.pug', 'utf8');
		var dash = fs.readFileSync('src/views/admin/dashboard.pug', 'utf8');
		var links = new Set(Array.from(nav.matchAll(/href=['"](\/admin[^'"?#]*)/g), function (m) { return m[1]; }));
		var cards = new Set(Array.from(dash.matchAll(/\+card\(['"](\/[^'"]*)/g), function (m) { return m[1]; }));
		assert.ok(links.size > 20, 'navbar links found');
		var missing = Array.from(links).filter(function (h) { return !cards.has(h) && NO_CARD.indexOf(h) === -1; });
		assert.deepStrictEqual(missing, [], 'navbar pages with no dashboard card');
	});
});
