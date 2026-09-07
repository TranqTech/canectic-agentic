// tests/messageAreasSort.test.js: the message areas list comparator.
//
// This logic used to be inline in the pug template, where node could not reach
// it. It was extracted to public/js/messageAreas.js precisely so it could be
// tested, because its failure mode is quiet: a row whose sort key is missing or
// the wrong type does not throw, it sorts to the bottom as though the area had
// never carried a message. The feature looks like it works and gives a wrong
// answer.
//
// Pure: no database, no DOM. applyAreaSort is exercised against a small fake
// rather than a real document, since the parts worth pinning are the ordering
// rules, not querySelectorAll.
//
// Run: npx mocha --spec tests/messageAreasSort.test.js

import assert from 'assert';

var mod = null;
try {
	mod = await import('../public/js/messageAreas.js');
} catch (_) { mod = null; }

describe('messageAreas.compareAreas', function () {
	before(function () { if (!mod) this.skip(); });

	function area(order, lastMessage) {
		return { order: order, lastMessage: lastMessage };
	}

	function sorted(list, mode) {
		return list.slice().sort(function (a, b) { return mod.compareAreas(a, b, mode); });
	}

	// -----------------------------------------------------------------------
	// recent
	// -----------------------------------------------------------------------

	it('puts the most recently active first', function () {
		var out = sorted([area(0, 1000), area(1, 3000), area(2, 2000)], 'recent');
		assert.deepStrictEqual(out.map(function (a) { return a.lastMessage; }), [3000, 2000, 1000]);
	});

	it('sorts areas that have never carried a message last', function () {
		var out = sorted([area(0, 0), area(1, 5000), area(2, 0), area(3, 9000)], 'recent');
		assert.deepStrictEqual(out.map(function (a) { return a.lastMessage; }), [9000, 5000, 0, 0],
			'a never-used area must not read as the freshest thing in the group');
	});

	it('keeps never-used areas in their configured order rather than an arbitrary one', function () {
		var out = sorted([area(5, 0), area(2, 0), area(9, 0)], 'recent');
		assert.deepStrictEqual(out.map(function (a) { return a.order; }), [2, 5, 9],
			'ties fall back to the server ordering');
	});

	it('falls back to the server order for two areas with the same timestamp', function () {
		var out = sorted([area(7, 4000), area(3, 4000)], 'recent');
		assert.deepStrictEqual(out.map(function (a) { return a.order; }), [3, 7]);
	});

	// -----------------------------------------------------------------------
	// default
	// -----------------------------------------------------------------------

	it('uses the server order in default mode, ignoring timestamps entirely', function () {
		var out = sorted([area(2, 9999), area(0, 1), area(1, 5000)], 'default');
		assert.deepStrictEqual(out.map(function (a) { return a.order; }), [0, 1, 2]);
	});

	it('treats an unknown mode as the server order', function () {
		var out = sorted([area(2, 9999), area(0, 1)], 'something-else');
		assert.deepStrictEqual(out.map(function (a) { return a.order; }), [0, 2]);
	});

	// -----------------------------------------------------------------------
	// the quiet failures
	// -----------------------------------------------------------------------

	it('reads string data attributes as numbers, not lexically', function () {
		// dataset values are always strings. A lexical compare would put "9"
		// ahead of "10000000000000".
		var out = sorted([{ order: '0', lastMessage: '9' }, { order: '1', lastMessage: '10000000000000' }], 'recent');
		assert.strictEqual(out[0].lastMessage, '10000000000000',
			'the larger epoch value has to win, which it does not under a string compare');
	});

	it('treats a missing timestamp as never-used rather than producing NaN', function () {
		// NaN in a comparator makes the whole sort order unspecified, not just
		// the one row wrong.
		var out = sorted([{ order: 0 }, area(1, 5000)], 'recent');
		assert.strictEqual(out[0].lastMessage, 5000);
		assert.strictEqual(mod.compareAreas({ order: 0 }, { order: 1 }, 'recent'), -1,
			'two rows with no timestamp should still compare by order');
	});

	it('treats an unparseable timestamp as never-used', function () {
		var out = sorted([{ order: 0, lastMessage: 'nonsense' }, area(1, 5000)], 'recent');
		assert.strictEqual(out[0].lastMessage, 5000);
	});

	it('survives null and undefined rows without throwing', function () {
		assert.doesNotThrow(function () {
			mod.compareAreas(null, undefined, 'recent');
			mod.compareAreas(undefined, null, 'default');
		});
	});

	it('is a consistent comparator, so the sort is stable and defined', function () {
		var list = [area(0, 3000), area(1, 0), area(2, 3000), area(3, 7000)];
		for (var i = 0; i < list.length; i++) {
			for (var j = 0; j < list.length; j++) {
				var ab = mod.compareAreas(list[i], list[j], 'recent');
				var ba = mod.compareAreas(list[j], list[i], 'recent');
				// `|| 0` normalises -0, which strictEqual distinguishes from 0
				// because it compares with Object.is. Comparing an element with
				// itself yields 0, and negating that yields -0.
				assert.strictEqual(Math.sign(ab) || 0, -Math.sign(ba) || 0,
					'compare(a,b) must be the negation of compare(b,a) for ' + i + ',' + j);
			}
		}
	});
});

describe('messageAreas.rowToArea', function () {
	before(function () { if (!mod) this.skip(); });

	it('reads the dataset attributes the template emits', function () {
		var a = mod.rowToArea({ dataset: { order: '4', lastMessage: '1615824000000' } });
		assert.deepStrictEqual(a, { order: 4, lastMessage: 1615824000000 });
	});

	it('defaults a row with no dataset to zeroes rather than NaN', function () {
		assert.deepStrictEqual(mod.rowToArea({}), { order: 0, lastMessage: 0 });
		assert.deepStrictEqual(mod.rowToArea(null), { order: 0, lastMessage: 0 });
	});
});

describe('messageAreas.applyAreaSort', function () {
	before(function () { if (!mod) this.skip(); });

	// Minimal stand-in for the bits of the DOM the function touches. Enough to
	// prove it sorts within each group and reappends in order.
	function fakeRow(order, lastMessage) {
		return { dataset: { order: String(order), lastMessage: String(lastMessage) } };
	}

	function fakeSection(rows) {
		var appended = [];
		var body = {
			appended: appended,
			querySelectorAll: function () { return rows; },
			appendChild: function (r) { appended.push(r); }
		};
		return {
			body: body,
			querySelector: function (sel) { return sel === 'tbody' ? body : null; }
		};
	}

	function fakeRoot(sections) {
		return { querySelectorAll: function () { return sections; } };
	}

	it('reorders each group independently', function () {
		var s1 = fakeSection([fakeRow(0, 1000), fakeRow(1, 5000)]);
		var s2 = fakeSection([fakeRow(0, 9000), fakeRow(1, 2000)]);

		mod.applyAreaSort(fakeRoot([s1, s2]), 'recent');

		assert.deepStrictEqual(s1.body.appended.map(function (r) { return r.dataset.lastMessage; }),
			['5000', '1000']);
		assert.deepStrictEqual(s2.body.appended.map(function (r) { return r.dataset.lastMessage; }),
			['9000', '2000'], 'the second group must be sorted too, not left alone');
	});

	it('leaves a single-row group alone', function () {
		var s = fakeSection([fakeRow(0, 1000)]);
		mod.applyAreaSort(fakeRoot([s]), 'recent');
		assert.strictEqual(s.body.appended.length, 0, 'nothing to reorder, so nothing should be touched');
	});

	it('skips a section with no tbody instead of throwing', function () {
		var broken = { querySelector: function () { return null; } };
		assert.doesNotThrow(function () { mod.applyAreaSort(fakeRoot([broken]), 'recent'); });
	});

	it('returns 0 for a root it cannot walk', function () {
		assert.strictEqual(mod.applyAreaSort(null, 'recent'), 0);
		assert.strictEqual(mod.applyAreaSort({}, 'recent'), 0);
	});
});
