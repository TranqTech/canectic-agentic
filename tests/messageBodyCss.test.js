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

	it('comes after every fg-* colour class that sets display', function () {
		var fg = all.filter(function (r) { return /^\.fg-[a-z]+$/.test(r.selector) && /display:/.test(r.body); });
		assert.ok(fg.length > 0, 'expected fg-* classes with display to exist');
		var lastFg = Math.max.apply(null, fg.map(function (r) { return r.at; }));
		assert.ok(body[0].at > lastFg, '.messagebody must follow the fg-* rules or they win the cascade');
	});
});
