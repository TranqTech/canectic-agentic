// tests/messageBodyCss.test.js — a message body is a block (#60).
//
// Message bodies carry a colour class (fg-brightgrey), and the fg-* classes
// set display: inline so they can colour spans inside a message. Applied to
// the body div it made the whole body inline, so its lines sat in the parent's
// line boxes: 28.8px apart whatever size the body was set to. At 80 columns on
// a phone (7px text) every line was followed by what looked like an empty one;
// measured in headless Chromium at 390px wide, the spacing went from 28.8px to
// the intended 7.7px once the body was a block.
//
// The fix is a .messagebody rule with display: block that comes AFTER the fg-*
// rules. Same specificity, so order decides it: moving it above them brings
// the bug back without anything else changing.
//
// Run: npx mocha --no-config --exit tests/messageBodyCss.test.js

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
var CSS = fs.readFileSync(path.join(ROOT, 'public/css/styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// Every plain `.selector { ... }` rule, in source order.
function rules(css) {
	var out = [];
	var re = /([^{}]+)\{([^}]*)\}/g, m;
	while ((m = re.exec(css)) !== null) out.push({ selector: m[1].trim(), body: m[2], at: m.index });
	return out;
}

describe('the message body CSS', function () {
	var all = rules(CSS);
	var body = all.filter(function (r) { return r.selector === '.messagebody'; });

	it('makes .messagebody a block', function () {
		assert.strictEqual(body.length, 1, 'one .messagebody rule');
		assert.match(body[0].body, /display:\s*block/);
	});

	it('lets the message header shrink, and gives the subject its own row on phones', function () {
		var head = all.filter(function (r) { return r.selector === '.msg-head'; })[0];
		var row = all.filter(function (r) { return r.selector === '.msg-subject-row'; })[0];
		assert.ok(head && /min-width:\s*0/.test(head.body), '.msg-head needs min-width: 0 or text-truncate never truncates');
		assert.ok(row && /display:\s*block/.test(row.body));
		var lastFg = Math.max.apply(null, all.filter(function (r) { return /^\.fg-[a-z]+$/.test(r.selector) && /display:/.test(r.body); }).map(function (r) { return r.at; }));
		assert.ok(row.at > lastFg, '.msg-subject-row must follow the fg-* rules');
	});

	it('comes after every fg-* colour class that sets display', function () {
		var fg = all.filter(function (r) { return /^\.fg-[a-z]+$/.test(r.selector) && /display:/.test(r.body); });
		assert.ok(fg.length > 0, 'expected fg-* classes with display to exist');
		var lastFg = Math.max.apply(null, fg.map(function (r) { return r.at; }));
		assert.ok(body[0].at > lastFg, '.messagebody must follow the fg-* rules or they win the cascade');
	});
});

// The reader builds each header twice: in Pug for the first page, and in the
// view's own JavaScript for messages loaded as you scroll. Both must use the
// same layout, or half the headers still overflow (found rendering the page:
// the old Pug was still being served while the check looked only for new
// classes, and reported nothing wrong).
describe('message header markup', function () {
	['flat', 'thread'].forEach(function (view) {
		var src = fs.readFileSync(path.join(ROOT, 'src/views/messages/areas/' + view + '.pug'), 'utf8');
		var script = src.slice(src.indexOf('script'));
		var pugPart = src.slice(0, src.indexOf('script'));

		it(view + ': server and script headers both use .msg-head / .msg-who', function () {
			assert.match(pugPart, /\.msg-head\b/);
			assert.match(pugPart, /\.msg-who\b/);
			assert.match(script, /class="msg-head"/);
			assert.match(script, /class="msg-who"/);
			assert.doesNotMatch(src, /text-truncate/, 'the old truncate wrapper could not shrink');
		});
	});

	it('flat: the subject has a phone row in both copies', function () {
		var src = fs.readFileSync(path.join(ROOT, 'src/views/messages/areas/flat.pug'), 'utf8');
		var script = src.slice(src.indexOf('script'));
		assert.match(src.slice(0, src.indexOf('script')), /\.msg-subject-row\.[^\n]*\.d-lg-none/);
		assert.match(script, /class="msg-subject-row [^"]*d-lg-none"/);
	});
});
