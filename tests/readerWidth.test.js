// tests/readerWidth.test.js: the web reader's 40 | 80 columns (#54), and the
// ansi_area setting that decides where an area starts (#49).
//
// On phones the reader sizes text to 40 columns so it is readable, which breaks
// 80-column art. The reader can switch the view to 80, remembered per area;
// an area marked "Mostly ANSI art" starts at 80; a message detected as art is
// always 80. ansi_area existed for six months with nothing able to set it.
//
// The width rules are pure (public/js/readerWidth.js). The settings half runs
// against the database when one is reachable, like groupPushDefaults.test.js.
//
// Run: npx mocha --no-config --exit tests/readerWidth.test.js

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
	viewCols, bodyCols, fontPx, storageKey, widestChar, PROBE_CHARS, MOBILE_BREAKPOINT, DESKTOP_COLS, MOBILE_COLS
} from '../public/js/readerWidth.js';
import { dbAvailable } from './helpers/dbAvailable.js';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
var PHONE = 400;

describe('reader width: which columns a view starts at', function () {

	it('is always 80 on desktop, whatever is remembered or set on the area', function () {
		assert.strictEqual(viewCols({ viewportWidth: MOBILE_BREAKPOINT, stored: '40', force80: false }), 80);
		assert.strictEqual(viewCols({ viewportWidth: 1920, stored: null, force80: false }), 80);
	});

	it('is 40 on a phone by default, for readable text', function () {
		assert.strictEqual(viewCols({ viewportWidth: PHONE, stored: null, force80: false }), MOBILE_COLS);
	});

	it('starts at 80 on a phone in an area marked as mostly ANSI art', function () {
		assert.strictEqual(viewCols({ viewportWidth: PHONE, stored: null, force80: true }), DESKTOP_COLS);
	});

	it('lets the reader\'s remembered choice win either way', function () {
		assert.strictEqual(viewCols({ viewportWidth: PHONE, stored: '80', force80: false }), 80);
		assert.strictEqual(viewCols({ viewportWidth: PHONE, stored: '40', force80: true }), 40);
	});

	it('ignores a remembered value it does not recognise', function () {
		assert.strictEqual(viewCols({ viewportWidth: PHONE, stored: '132', force80: false }), 40);
	});

	it('sizes a message detected as art to 80 whatever the view is set to', function () {
		assert.strictEqual(bodyCols(40, true), 80);
		assert.strictEqual(bodyCols(40, false), 40);
		assert.strictEqual(bodyCols(80, false), 80);
	});

	it('scales the font so the columns fill the width, within readable bounds', function () {
		// 8px per character at 16px: 40 columns fill 322px (2 spare) at exactly 16px.
		assert.strictEqual(fontPx(322, 8, 40), 16);
		assert.strictEqual(fontPx(322, 8, 80), 8);
		assert.strictEqual(fontPx(40, 8, 80), 7, 'never below the minimum');
		assert.strictEqual(fontPx(5000, 8, 40), 32, 'never above the maximum');
		assert.strictEqual(fontPx(0, 8, 40), null);
	});

	it('never sizes a full line wider than the space it has', function () {
		// The phone widths that matter, with character widths a real font gives.
		for (var avail = 300; avail <= 1000; avail += 7) {
			for (var cw of [8.8, 9.6, 9.62, 10, 12.04]) {
				for (var cols of [40, 80]) {
					var px = fontPx(avail, cw, cols);
					if (px === 7) continue;   // clamped at the minimum: nothing smaller to try
					assert.ok(cols * cw * px / 16 <= avail - 1,
						'overflows at ' + avail + 'px, ' + cw + ' per char, ' + cols + ' cols: ' + px + 'px');
				}
			}
		}
	});

	it('sizes by the widest glyph, so block and box characters from a fallback font still fit', function () {
		assert.ok(PROBE_CHARS.indexOf('0') !== -1 && PROBE_CHARS.indexOf('\u2588') !== -1);
		assert.strictEqual(widestChar([9.6, 11.2, 9.6]), 11.2);
		assert.strictEqual(widestChar([]), 0);
	});

	it('remembers per area, whatever case the shortcode arrives in', function () {
		assert.strictEqual(storageKey('othernets'), storageKey('OTHERNETS'));
		assert.notStrictEqual(storageKey('A'), storageKey('B'));
	});
});

describe('reader width: the pages', function () {
	var read = function (f) { return fs.readFileSync(path.join(ROOT, f), 'utf8'); };

	it('both reading views offer the switch and mark art bodies, server-side and when lazy-loaded', function () {
		for (var v of ['src/views/messages/areas/thread.pug', 'src/views/messages/areas/flat.pug']) {
			var s = read(v);
			assert.ok(s.includes('include ../../partials/messages/_readerWidth'), v + ': switch');
			assert.ok(s.includes(".messagebody.monospace.fg-brightgrey(data-art=message.isArt ? 'true' : undefined)"), v + ': server');
			assert.ok(s.includes("(msg.isArt ? ' data-art=\"true\"' : '')"), v + ': lazy-loaded');
			assert.ok(s.includes("data-force80=msgArea.ansi_area ? 'true' : 'false'"), v + ': area default');
			assert.ok(s.includes('include ../../partials/messages/_msgAutoSize'), v + ': sizing');
		}
	});

	it('hides the switch at the same breakpoint the sizing uses', function () {
		assert.strictEqual(MOBILE_BREAKPOINT, 992, 'Bootstrap lg');
		assert.ok(/\.d-lg-none/.test(read('src/views/partials/messages/_readerWidth.pug')));
	});

	it('messages carry isArt to the lazy loader', async function () {
		var messages = await import('../src/models/messages.js');
		assert.strictEqual(messages.messageForClient({ isArt: true }).isArt, true);
		assert.strictEqual(messages.messageForClient({}).isArt, false);
	});

	it('the area form and the group pages can set it', function () {
		assert.ok(read('src/views/admin/msgAreas/_areaFormFields.pug').includes("name='ansi_area'"));
		var gv = read('src/views/admin/msgGroups/view.pug');
		assert.ok(gv.includes("select#edit_ansi_area.form-select(name='ansi_area')"));
		assert.ok(gv.includes("input.form-check-input#push_ansi_area(type='checkbox' name='fields' value='ansi_area')"),
			'Push Group Defaults, unticked');
		assert.ok(read('src/views/admin/msgGroups/index.pug').includes("select#ng_ansi_area.form-select(name='ansi_area')"));
	});
});

describe('ansi_area: setting it, and the group default', function () {
	this.timeout(40000);
	var GROUP = 'ZZANSIGRP', A = 'ZZANSIA', B = 'ZZANSIB';
	var available = false, pg, msgGroups, msgAreas;

	before(async function () {
		this.timeout(30000);
		try {
			available = await dbAvailable();
			if (!available) return;
			pg = await import('../src/middleware/db/postgres.js');
			msgGroups = await import('../src/models/msgGroups.js');
			msgAreas = await import('../src/models/msgAreas.js');
			for (var sc of [A, B]) await msgAreas.removeArea(sc, true).catch(function () {});
			await msgGroups.removeGroup(GROUP, true).catch(function () {});
			var g = await msgGroups.newGroup({ name: 'ZZ ANSI', description: 'temporary, readerWidth.test.js',
				shortcode: GROUP, read_security: 10, post_security: 20, ansi_area: 'true', createdByName: 'readerWidth.test.js' });
			if (!g || g.status !== true) available = false;
		} catch (_) { available = false; }
	});
	beforeEach(function () { if (!available) this.skip(); });
	after(async function () {
		this.timeout(30000);
		if (!msgAreas) return;
		for (var sc of [A, B]) await msgAreas.removeArea(sc, true).catch(function () {});
		await msgGroups.removeGroup(GROUP, true).catch(function () {});
	});

	async function area(sc) {
		var rows = await pg.query('SELECT ansi_area FROM message_areas WHERE shortcode = $1', [sc]);
		return rows[0].ansi_area;
	}

	it('a new area inherits the group\'s default when the form does not say', async function () {
		var r = await msgAreas.newArea({ groupshortcode: GROUP, name: A, description: A, shortcode: A,
			readsecurity: 50, postsecurity: 60, createdByName: 'readerWidth.test.js' });
		assert.strictEqual(r.status, true, JSON.stringify(r));
		assert.strictEqual(await area(A), true);
	});

	it('an explicit choice on the form wins over the group', async function () {
		var r = await msgAreas.newArea({ groupshortcode: GROUP, name: B, description: B, shortcode: B,
			readsecurity: 50, postsecurity: 60, ansi_area: 'false', createdByName: 'readerWidth.test.js' });
		assert.strictEqual(r.status, true, JSON.stringify(r));
		assert.strictEqual(await area(B), false);
	});

	it('an area can be changed, and an update that does not mention it leaves it alone', async function () {
		await msgAreas.updateArea(B, { ansi_area: 'true' });
		assert.strictEqual(await area(B), true);
		await msgAreas.updateArea(B, { name: B });
		assert.strictEqual(await area(B), true);
		await msgAreas.updateArea(B, { ansi_area: 'false' });
		assert.strictEqual(await area(B), false);
	});

	it('Push Group Defaults changes it only when ticked', async function () {
		await msgGroups.pushDefaultsToAreas(GROUP, ['newscan_default']);
		assert.strictEqual(await area(B), false, 'not ticked, not pushed');
		await msgGroups.pushDefaultsToAreas(GROUP, ['ansi_area']);
		assert.strictEqual(await area(B), true);
	});

	it('the group default can be changed', async function () {
		await msgGroups.updateGroup(GROUP, { ansi_area: 'false' });
		var rows = await pg.query('SELECT ansi_area FROM message_groups WHERE shortcode = $1', [GROUP]);
		assert.strictEqual(rows[0].ansi_area, false);
	});
});
