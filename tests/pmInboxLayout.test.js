// tests/pmInboxLayout.test.js — the private mail inbox on a phone.
//
// Rendered in headless Chromium at 390x844 and 360x640 (2026-09-25):
//   - opening a message put the reader header 13 elements past the right edge,
//     pushing Reply and Delete off the screen. The subject column was marked
//     `min-width-0`, a class nothing defined, so it could not shrink; and the
//     subject carries fg-cyan, whose display: inline defeats truncation.
//   - the layout was `calc(100vh - 56px)` under a navbar that is 70px on a
//     phone, so it ended 14px below the screen, more with the address bar.
// After: nothing past the edge on phone or desktop, the inbox ends 8px above
// the bottom at every size, and on a phone the reader header runs in rows
// (date and buttons, then the subject full width, then From/To).
//
// Run: npx mocha --no-config --exit tests/pmInboxLayout.test.js

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
var CSS = fs.readFileSync(path.join(ROOT, 'public/css/styles.css'), 'utf8');
var INBOX = fs.readFileSync(path.join(ROOT, 'src/views/pm/inbox.pug'), 'utf8');

describe('PM inbox layout', function () {

	it('defines min-width-0, which the views use', function () {
		assert.match(CSS, /\.min-width-0\s*\{\s*min-width:\s*0;?\s*\}/);
	});

	it('sizes the inbox to the screen, following the address bar', function () {
		assert.match(INBOX, /\.pm-outer\(data-fit-height='height'\)/);
		assert.match(INBOX, /fitHeight\.js/);
		assert.match(INBOX, /height: 100dvh/);
	});

	it('makes the reader subject a block so it can be contained and truncated', function () {
		assert.match(INBOX, /#readerSubject \{ display: block;/);
		assert.doesNotMatch(INBOX, /\.text-truncate#readerSubject/);
	});

	it('stacks the reader header in rows on a phone', function () {
		var phone = INBOX.slice(INBOX.indexOf('@media (max-width: 991.98px)'));
		assert.match(phone, /\.pm-reader-actions \{[^}]*flex-basis: 100%/);
		assert.match(phone, /\.pm-reader-who \{[^}]*flex-basis: 100%/);
		assert.match(INBOX, /\.pm-reader-actions\.flex-shrink-0/);
	});
});
