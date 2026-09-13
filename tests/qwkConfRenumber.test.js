// tests/qwkConfRenumber.test.js: QWK conference block assignment.
//
// The planning lived inside a 404 line CLI that planned, printed and wrote in
// one pass and called process.exit at every turn. Nothing could call it, so the
// upgrade step it performs was prose in the changelog: "run this once, before
// restarting". It had no tests at all.
//
// It is now src/maintenance/qwkConfRenumber.js, and planRenumber is pure, which
// is what makes the rules testable against a fixture instead of a live message
// base. Those rules matter because every one of them, got wrong, renumbers an
// area that was already correct, and every renumber invalidates a conference
// list somebody is holding in a mail reader.
//
// Run: npx mocha

import assert from 'assert';
import { planRenumber, changedAreas, firstSlot } from '../src/maintenance/qwkConfRenumber.js';

var STRIDE = 1000;

function group(id, shortcode, start) {
	return { id: id, shortcode: shortcode, name: shortcode, sort_order: id, qwk_conf_start: start };
}

function area(id, shortcode, num) {
	return { id: id, shortcode: shortcode, qwk_conf_number: num };
}

function byGroup(pairs) {
	var m = new Map();
	for (var p of pairs) m.set(p[0], p[1]);
	return m;
}

describe('firstSlot', function () {

	it('lands on the first stride boundary above the reserved range', function () {
		// 1..100 are reserved for system conferences, so a group block may not
		// start inside them.
		assert.strictEqual(firstSlot(1000), 1000);
	});

	it('steps past the reserved range when the stride is small', function () {
		// A stride of 50 would put the first two blocks at 50 and 100, both
		// inside the reserved range.
		assert.ok(firstSlot(50) > 100);
		assert.strictEqual(firstSlot(50) % 50, 0);
	});
});

describe('planRenumber, default mode', function () {

	it('gives a group with no block the first slot', function () {
		var plan = planRenumber(
			[group(1, 'GEN', null)],
			byGroup([[1, [area(10, 'A1', null), area(11, 'A2', null)]]]),
			STRIDE, {});

		assert.strictEqual(plan.groups[0].newStart, 1000);
		assert.deepStrictEqual(plan.areas.map(function (a) { return a.newNum; }), [1000, 1001]);
	});

	it('keeps a block that is already assigned', function () {
		// The property that makes default mode safe to run unattended: a group
		// that has been numbered keeps its numbers, so a reader holding its
		// conference list stays correct.
		var plan = planRenumber(
			[group(1, 'GEN', 5000)],
			byGroup([[1, [area(10, 'A1', 5000), area(11, 'A2', 5001)]]]),
			STRIDE, {});

		assert.strictEqual(plan.groups[0].newStart, 5000);
		assert.deepStrictEqual(changedAreas(plan), [], 'nothing should move');
	});

	it('fills only the gaps, leaving assigned groups alone', function () {
		var plan = planRenumber(
			[group(1, 'ONE', 1000), group(2, 'TWO', null), group(3, 'THREE', 3000)],
			byGroup([[1, []], [2, []], [3, []]]),
			STRIDE, {});

		var starts = {};
		for (var g of plan.groups) starts[g.group.shortcode] = g.newStart;
		assert.strictEqual(starts.ONE, 1000);
		assert.strictEqual(starts.THREE, 3000);
		assert.strictEqual(starts.TWO, 4000, 'a filled gap goes above the highest existing block');
	});

	it('never assigns a start already in use', function () {
		var plan = planRenumber(
			[group(1, 'A', 2000), group(2, 'B', null), group(3, 'C', null)],
			byGroup([[1, []], [2, []], [3, []]]),
			STRIDE, {});

		var starts = plan.groups.map(function (g) { return g.newStart; });
		assert.deepStrictEqual(starts, Array.from(new Set(starts)), 'duplicate block start');
	});

	it('keeps an area at its existing offset inside the block', function () {
		// Not just tidiness. Repacking an area that is already correct changes
		// its conference number for nothing.
		var plan = planRenumber(
			[group(1, 'GEN', 1000)],
			byGroup([[1, [area(10, 'A1', 1005), area(11, 'A2', 1002)]]]),
			STRIDE, {});

		var byCode = {};
		for (var a of plan.areas) byCode[a.shortcode] = a.newNum;
		assert.strictEqual(byCode.A1, 1005);
		assert.strictEqual(byCode.A2, 1002);
		assert.deepStrictEqual(changedAreas(plan), []);
	});

	it('repacks an area whose number falls outside its block', function () {
		// The flat id+100 scheme this replaces put numbers anywhere.
		var plan = planRenumber(
			[group(1, 'GEN', 1000)],
			byGroup([[1, [area(10, 'A1', 105), area(11, 'A2', 1003)]]]),
			STRIDE, {});

		var byCode = {};
		for (var a of plan.areas) byCode[a.shortcode] = a.newNum;
		assert.strictEqual(byCode.A2, 1003, 'the in-block area keeps its offset');
		assert.strictEqual(byCode.A1, 1000, 'the out-of-block area takes the first free slot');
	});

	it('does not put two areas on the same number when offsets collide', function () {
		// Two areas both claiming offset 5 is reachable through a manual
		// override. A collision would violate the unique constraint at write
		// time, after the base is already parked.
		var plan = planRenumber(
			[group(1, 'GEN', 1000)],
			byGroup([[1, [area(10, 'A1', 1005), area(11, 'A2', 1005)]]]),
			STRIDE, {});

		var nums = plan.areas.map(function (a) { return a.newNum; });
		assert.deepStrictEqual(nums, Array.from(new Set(nums)), 'two areas share a conference number');
	});

	it('gives a numberless area the next free slot rather than zero', function () {
		var plan = planRenumber(
			[group(1, 'GEN', 1000)],
			byGroup([[1, [area(10, 'A1', 1000), area(11, 'A2', null)]]]),
			STRIDE, {});

		var byCode = {};
		for (var a of plan.areas) byCode[a.shortcode] = a.newNum;
		assert.strictEqual(byCode.A2, 1001);
	});

	it('skips a group with no areas without consuming its block', function () {
		var plan = planRenumber(
			[group(1, 'EMPTY', null), group(2, 'FULL', null)],
			byGroup([[1, []], [2, [area(10, 'A1', null)]]]),
			STRIDE, {});

		assert.strictEqual(plan.areas.length, 1);
		assert.strictEqual(plan.groups.length, 2, 'an empty group still gets a block');
	});
});

describe('planRenumber, force mode', function () {

	it('discards existing blocks and packs from the first slot', function () {
		var plan = planRenumber(
			[group(1, 'A', 7000), group(2, 'B', 9000)],
			byGroup([[1, []], [2, []]]),
			STRIDE, { force: true });

		assert.deepStrictEqual(plan.groups.map(function (g) { return g.newStart; }), [1000, 2000]);
	});

	it('renumbers every area sequentially, ignoring what it had', function () {
		var plan = planRenumber(
			[group(1, 'GEN', 5000)],
			byGroup([[1, [area(10, 'A1', 5009), area(11, 'A2', 5003)]]]),
			STRIDE, { force: true });

		assert.deepStrictEqual(plan.areas.map(function (a) { return a.newNum; }), [1000, 1001]);
	});

	it('reports the old number so a caller can say what changed', function () {
		var plan = planRenumber(
			[group(1, 'GEN', 5000)],
			byGroup([[1, [area(10, 'A1', 5009)]]]),
			STRIDE, { force: true });

		assert.strictEqual(plan.areas[0].oldNum, 5009);
		assert.strictEqual(changedAreas(plan).length, 1);
	});
});

describe('planRenumber, a group that cannot fit', function () {

	it('reports the group rather than truncating it', function () {
		// The failure the migration has to stop on. Numbering some of a group's
		// areas and silently dropping the rest is worse than refusing.
		var areas = [];
		for (var i = 0; i < 6; i++) areas.push(area(i + 10, 'A' + i, null));

		var plan = planRenumber([group(1, 'BIG', null)], byGroup([[1, areas]]), 5, {});

		assert.strictEqual(plan.full.length, 1);
		assert.strictEqual(plan.full[0].shortcode, 'BIG');
		assert.strictEqual(plan.full[0].areas, 6);
		assert.strictEqual(plan.full[0].stride, 5);
	});

	it('plans nothing for the group that does not fit', function () {
		var areas = [];
		for (var i = 0; i < 6; i++) areas.push(area(i + 10, 'A' + i, null));

		var plan = planRenumber([group(1, 'BIG', null)], byGroup([[1, areas]]), 5, {});
		assert.deepStrictEqual(plan.areas, []);
	});

	it('still plans the groups that do fit', function () {
		var big = [];
		for (var i = 0; i < 6; i++) big.push(area(i + 10, 'B' + i, null));

		var plan = planRenumber(
			[group(1, 'BIG', null), group(2, 'OK', null)],
			byGroup([[1, big], [2, [area(99, 'OK1', null)]]]),
			5, {});

		assert.strictEqual(plan.full.length, 1);
		assert.strictEqual(plan.areas.length, 1);
		assert.strictEqual(plan.areas[0].shortcode, 'OK1');
	});

	it('fills a group that is exactly at capacity', function () {
		// Written first as "catches an overflow during the sequential fill",
		// which failed, correctly: that branch cannot be reached.
		//
		// The count check above guarantees areas <= stride. Preserved offsets
		// are distinct and are only kept when they fall inside [0, stride-1],
		// so free slots always outnumber the areas still needing one. The
		// overflow guard in the fill is defensive, not live, and a test claiming
		// to exercise it would be asserting something untrue about the code.
		//
		// What is worth pinning is the case that looks like it should overflow:
		// a full group where one area already holds the last offset.
		var plan = planRenumber(
			[group(1, 'EDGE', 1000)],
			byGroup([[1, [area(10, 'A1', 1002), area(11, 'A2', null), area(12, 'A3', null)]]]),
			3, {});

		assert.deepStrictEqual(plan.full, [], 'a group at exactly capacity fits');
		var nums = plan.areas.map(function (a) { return a.newNum; }).sort();
		assert.deepStrictEqual(nums, [1000, 1001, 1002]);
	});
});

describe('changedAreas', function () {

	it('reports only the areas whose number moves', function () {
		var plan = planRenumber(
			[group(1, 'GEN', 1000)],
			byGroup([[1, [area(10, 'A1', 1000), area(11, 'A2', null)]]]),
			STRIDE, {});

		var changed = changedAreas(plan);
		assert.strictEqual(changed.length, 1);
		assert.strictEqual(changed[0].shortcode, 'A2');
	});

	it('treats a null old number as a change', function () {
		var plan = planRenumber(
			[group(1, 'GEN', 1000)],
			byGroup([[1, [area(10, 'A1', null)]]]),
			STRIDE, {});
		assert.strictEqual(changedAreas(plan).length, 1);
	});
});
