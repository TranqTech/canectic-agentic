// tests/fitHeight.test.js — the message list fits the screen it is on.
//
// The message views stop the page scrolling and scroll a list inside it, sized
// `calc(100vh - 190px)`: 190px guessed as everything above the list. On a
// phone the list started ~237px down, so its bottom was 47px below the screen
// with nothing able to scroll to it, and 100vh on a phone ignores the address
// bar, hiding more. The last message in an area was cut off.
//
// public/js/fitHeight.js sizes [data-fit-height] to what is visible below its
// top. Rendered in headless Chromium at 390x844, 360x640 and 1366x768 the list
// now ends 9px above the screen's bottom in the flat, threads and thread views,
// and follows a resize from 844 to 760 (the address bar appearing).
//
// Run: npx mocha --no-config --exit tests/fitHeight.test.js

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fitHeight, MIN_HEIGHT } from '../public/js/fitHeight.js';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('fitHeight', function () {
	it('fills what is visible below the top, less what sits underneath', function () {
		assert.strictEqual(fitHeight(844, 237, 9), 598);
	});

	it('follows the visible height, not the screen height', function () {
		// Address bar shown: 84px less to fill.
		assert.strictEqual(fitHeight(760, 237, 9), 514);
	});

	it('never goes below a usable minimum', function () {
		assert.strictEqual(fitHeight(300, 250, 9), MIN_HEIGHT);
	});

	it('ignores a negative allowance', function () {
		assert.strictEqual(fitHeight(844, 237, -40), 607);
	});
});

describe('the message views use it', function () {
	['flat', 'thread', 'view'].forEach(function (view) {
		var src = fs.readFileSync(path.join(ROOT, 'src/views/messages/areas/' + view + '.pug'), 'utf8');
		it(view + ': the list is marked, the script is loaded, and the page follows the address bar', function () {
			assert.match(src, /data-fit-height/);
			var loads = /fitHeight\.js/.test(src) || (/_msgAutoSize/.test(src) &&
				/fitHeight\.js/.test(fs.readFileSync(path.join(ROOT, 'src/views/partials/messages/_msgAutoSize.pug'), 'utf8')));
			assert.ok(loads, view + ' does not load fitHeight.js');
			assert.match(src, /height: 100dvh/);
		});
	});
});
