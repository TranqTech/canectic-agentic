// tests/ftnSeenPath.test.js: SEEN-BY and PATH, read and written.
//
// Neither survived a pass through this system intact: the parser kept only the
// last SEEN-BY line and the colon after "SEEN-BY" as an entry, and export
// replaced the PATH with our own address. The module under test is the one
// definition of both lists that the parser, the eligibility check and the
// packet writers now share.
//
// Pure. Run: npx mocha --no-config --exit tests/ftnSeenPath.test.js

import assert from 'assert';
import {
	MAX_LINE, parseNetNodes, hasNetNode, mergeSeenBy, appendPath, normalisePath, seenByLines, pathLines
} from '../src/utils/ftnSeenPath.js';

function flat(entries) { return entries.map(function (e) { return e.net + '/' + e.node; }).join(' '); }

describe('ftnSeenPath.parseNetNodes', function () {

	it('reads the compressed form, where a bare number belongs to the net before it', function () {
		assert.strictEqual(flat(parseNetNodes('134/100 101 153/757')), '134/100 134/101 153/757');
	});

	it('skips the colon older rows stored as an entry', function () {
		assert.strictEqual(flat(parseNetNodes(': 460/1124 633/280')), '460/1124 633/280');
	});

	it('reads several wire lines run together, labels and all', function () {
		assert.strictEqual(flat(parseNetNodes('SEEN-BY: 1/110 18/200\rSEEN-BY: 134/100 153/135\r')),
			'1/110 18/200 134/100 153/135');
		assert.strictEqual(flat(parseNetNodes('\x01PATH: 18/200 229/426')), '18/200 229/426');
	});

	it('drops a zone, a point and a domain, since both lists are 2D', function () {
		assert.strictEqual(flat(parseNetNodes('1:134/100.0@fidonet 101.2')), '134/100 134/101');
	});

	it('ignores a bare number with no net before it, rather than inventing one', function () {
		assert.strictEqual(flat(parseNetNodes('101 134/100')), '134/100');
	});

	it('reads nothing from nothing', function () {
		assert.deepStrictEqual(parseNetNodes(null), []);
		assert.deepStrictEqual(parseNetNodes(''), []);
	});
});

describe('ftnSeenPath.hasNetNode', function () {
	it('finds a node written bare after its net', function () {
		assert.strictEqual(hasNetNode('134/100 101', { net: '134', node: '101' }), true);
		assert.strictEqual(hasNetNode('134/100 220/101', { net: 134, node: 101 }), false);
		assert.strictEqual(hasNetNode(null, '134/101'), false);
	});
});

describe('ftnSeenPath.mergeSeenBy', function () {

	it('adds, deduplicates and sorts by net then node', function () {
		assert.strictEqual(mergeSeenBy('153/757 134/101 100', ['134/100', { net: 134, node: 123 }]),
			'134/100 101 123 153/757');
	});

	it('sorts numerically, not as text', function () {
		assert.strictEqual(mergeSeenBy('9/9 10/1 9/10'), '9/9 10 10/1');
	});

	it('is null when there is nothing in it', function () {
		assert.strictEqual(mergeSeenBy(': ', []), null);
	});
});

describe('ftnSeenPath.appendPath', function () {

	it('adds this system at the end, keeping the order', function () {
		assert.strictEqual(appendPath('18/200 229/426 460/58 280/464 153/757', '134/100'),
			'18/200 229/426 460/58 280/464 153/757 134/100');
	});

	it('does not add this system twice when it is already the last hop', function () {
		// A message sent to two downlinks passes through the same export twice,
		// and a message posted here carries our address already.
		assert.strictEqual(appendPath('153/757 134/100', '134/100'), '153/757 134/100');
		assert.strictEqual(appendPath('134/100', '134/100'), '134/100');
	});

	it('starts a PATH that has none', function () {
		assert.strictEqual(appendPath(null, '134/100'), '134/100');
	});

	it('compresses without reordering', function () {
		assert.strictEqual(normalisePath('134/100 134/101 18/200 134/102'), '134/100 101 18/200 134/102');
	});
});

describe('ftnSeenPath wire lines', function () {

	var LONG = '1/110 18/200 103/705 105/81 106/201 124/5016 128/187 129/14 305 134/100 153/135 143 148 150 ' +
		'151 153 757 7715 154/10 30 110 203/0 218/700 221/0 6 226/30 227/114 229/110 112 114 115 200 206 ' +
		'275 300 307 317 400 426 428 470 664 700 705 240/1120 5832 250/1 263/1 266/325 512 275/1000';

	it('keeps every line under 80 characters', function () {
		for (var l of seenByLines(LONG)) assert.ok(l.length <= MAX_LINE, l.length + ': ' + l);
	});

	it('starts every line with a full net/node, so each can be read alone', function () {
		for (var l of seenByLines(LONG)) assert.ok(/^SEEN-BY: \d+\/\d+/.test(l), l);
	});

	it('loses nothing across the wrap', function () {
		var lines = seenByLines(LONG);
		assert.ok(lines.length > 1);
		assert.strictEqual(mergeSeenBy(lines.join('\r')), mergeSeenBy(LONG));
	});

	it('writes PATH as kludge lines, in order', function () {
		var lines = pathLines('18/200 229/426 153/757 134/100');
		assert.deepStrictEqual(lines, ['\x01PATH: 18/200 229/426 153/757 134/100']);
	});

	it('writes nothing for an empty list', function () {
		assert.deepStrictEqual(seenByLines(null), []);
		assert.deepStrictEqual(pathLines(''), []);
	});
});
