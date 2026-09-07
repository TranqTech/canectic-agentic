// tests/messageDateSanity.test.js: rejecting message dates that cannot be true.
//
// From a real case. Ten messages in a COOKING base carried dates in October
// 2060 while their MSGIDs decoded to July 2024 and their neighbours in the same
// base were dated August 2024. Every one of the ten was congruent to 16 seconds
// mod 60, odds of roughly 1 in 1.7e14 by chance, so a systematic corruption
// upstream rather than a wrong clock. SMB stores when_written as a raw u32 and
// the importer copied it verbatim, so it came straight through.
//
// The damage is downstream and quiet. The area's last_message pinned COOKING to
// the top of any "recently active" ordering permanently, retention would never
// prune those messages because a 2060 date is inside every window, and the list
// column showed a plausible "Oct 14". Once stored, nothing can tell the
// difference, so the check has to happen at ingest.
//
// Pure: no database.
// Run: npx mocha --spec tests/messageDateSanity.test.js

import assert from 'assert';

var ftnUtils = null;
try {
	ftnUtils = await import('../src/utils/ftnUtils.js');
} catch (_) { ftnUtils = null; }

describe('ftnUtils.sanitiseMessageDate', function () {
	before(function () {
		if (!ftnUtils || typeof ftnUtils.sanitiseMessageDate !== 'function') this.skip();
	});

	var RECEIVED = new Date('2024-08-20T12:00:00Z');

	function check(date, opts) {
		return ftnUtils.sanitiseMessageDate(date, RECEIVED, opts);
	}

	// -----------------------------------------------------------------------
	// the case that prompted it
	// -----------------------------------------------------------------------

	it('rejects the 2060 date that got through', function () {
		var r = check(new Date('2060-10-14T13:42:16Z'));
		assert.strictEqual(r.clamped, true);
		assert.strictEqual(r.date.getTime(), RECEIVED.getTime(),
			'a message dated 36 years out should fall back to when we received it');
		assert.ok(r.reason.includes('2060-10-14'), 'the reason should name the offending date');
	});

	it('reports why, so a sysop can see it happened rather than guessing', function () {
		var r = check(new Date('2060-10-14T13:42:16Z'));
		assert.ok(r.reason.includes('future'), 'got: ' + r.reason);
	});

	// -----------------------------------------------------------------------
	// clock skew is normal and must not be touched
	// -----------------------------------------------------------------------

	it('leaves a message an hour ahead alone', function () {
		var d = new Date(RECEIVED.getTime() + 3600000);
		var r = check(d);
		assert.strictEqual(r.clamped, false, 'an hour of skew between FTN systems is routine');
		assert.strictEqual(r.date.getTime(), d.getTime());
	});

	it('leaves a message a day ahead alone', function () {
		var d = new Date(RECEIVED.getTime() + 86400000);
		assert.strictEqual(check(d).clamped, false,
			'a timezone or DST mistake upstream is not corruption');
	});

	it('rejects a message a week ahead', function () {
		var d = new Date(RECEIVED.getTime() + (7 * 86400000));
		assert.strictEqual(check(d).clamped, true);
	});

	it('honours a caller-supplied tolerance', function () {
		var d = new Date(RECEIVED.getTime() + (5 * 86400000));
		assert.strictEqual(check(d, { futureToleranceDays: 10 }).clamped, false);
		assert.strictEqual(check(d, { futureToleranceDays: 1 }).clamped, true);
	});

	// -----------------------------------------------------------------------
	// ordinary dates
	// -----------------------------------------------------------------------

	it('leaves a normal past date alone', function () {
		var d = new Date('2024-08-19T09:15:00Z');
		var r = check(d);
		assert.strictEqual(r.clamped, false);
		assert.strictEqual(r.date.getTime(), d.getTime());
	});

	it('leaves genuinely old FTN mail alone', function () {
		// Imported history is routinely decades old and must survive intact,
		// which is the whole reason this is a sanity check and not a window.
		var d = new Date('1994-03-02T10:00:00Z');
		assert.strictEqual(check(d).clamped, false);
	});

	// -----------------------------------------------------------------------
	// the other end
	// -----------------------------------------------------------------------

	it('rejects a date from before FTN existed', function () {
		// epoch 0, the usual shape of "no date was recorded"
		var r = check(new Date(0));
		assert.strictEqual(r.clamped, true);
		assert.ok(r.reason.includes('1980'), 'got: ' + r.reason);
	});

	it('honours a caller-supplied floor', function () {
		var d = new Date('1975-01-01T00:00:00Z');
		assert.strictEqual(check(d, { earliestYear: 1970 }).clamped, false);
		assert.strictEqual(check(d, { earliestYear: 1990 }).clamped, true);
	});

	// -----------------------------------------------------------------------
	// shapes the ingest path can actually hand it
	// -----------------------------------------------------------------------

	it('rejects an invalid Date rather than storing NaN', function () {
		var r = check(new Date('nonsense'));
		assert.strictEqual(r.clamped, true);
		assert.strictEqual(r.date.getTime(), RECEIVED.getTime());
		assert.ok(r.reason.includes('unparseable'));
	});

	it('rejects a non-Date', function () {
		assert.strictEqual(check(null).clamped, true);
		assert.strictEqual(check(undefined).clamped, true);
		assert.strictEqual(check('2024-08-19').clamped, true,
			'a string is not a Date; the caller should have parsed it already');
	});

	it('falls back to now when the receive time is itself unusable', function () {
		var r = ftnUtils.sanitiseMessageDate(new Date('2060-01-01T00:00:00Z'), new Date('nope'));
		assert.strictEqual(r.clamped, true);
		assert.ok(!isNaN(r.date.getTime()), 'the fallback must always be a usable date');
	});

	it('never returns an invalid date, whatever it is given', function () {
		var inputs = [null, undefined, 'x', new Date('bad'), new Date(0),
		              new Date('2060-01-01'), new Date('2024-08-19')];
		for (var i = 0; i < inputs.length; i++) {
			var r = ftnUtils.sanitiseMessageDate(inputs[i], RECEIVED);
			assert.ok(r.date instanceof Date && !isNaN(r.date.getTime()),
				'input ' + i + ' produced an unusable date');
		}
	});
});
