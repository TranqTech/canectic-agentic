// tests/ftnUtils.test.js — Unit tests for src/utils/ftnUtils.js
//
// Tests genMsgId(), getMilliHex(), and getSystemTime().
// getDateTimeString() uses luxon and returns the current formatted time;
// tested for format shape only.
// Run: npx mocha tests/ftnUtils.test.js

import assert from 'assert';
import {
	getDateTimeString,
	genMsgId,
	getMilliHex,
	getSystemTime
} from '../src/utils/ftnUtils.js';

// ---------------------------------------------------------------------------
// getMilliHex  (synchronous)
//
// FTS-0009 MSGID serial: exactly 8 hex characters. The previous
// implementation produced 11+ because it hex-encoded Date.now() directly;
// the tests below pin the fixed-width 8-char output so the regression
// can't come back silently.
// ---------------------------------------------------------------------------

describe('getMilliHex', function () {

	it('should return a string', function () {
		var r = getMilliHex();
		assert.strictEqual(typeof r, 'string');
	});

	it('should return EXACTLY 8 characters (FTS-0009 requirement)', function () {
		var r = getMilliHex();
		assert.strictEqual(r.length, 8, 'Expected exactly 8 chars, got: ' + r.length + ' (' + r + ')');
	});

	it('should contain only lowercase hex digits', function () {
		var r = getMilliHex();
		assert.match(r, /^[0-9a-f]{8}$/);
	});

	it('should fit in a 32-bit unsigned integer', function () {
		var r = getMilliHex();
		var n = parseInt(r, 16);
		assert.ok(n >= 0 && n <= 0xFFFFFFFF);
	});

	it('should produce distinct values on successive calls (counter guarantees uniqueness)', function () {
		// Even if two calls happen in the same millisecond, the per-process
		// counter in the low 16 bits disambiguates them.
		var seen = new Set();
		for (var i = 0; i < 100; i++) {
			seen.add(getMilliHex());
		}
		assert.strictEqual(seen.size, 100, 'Expected 100 unique values, got: ' + seen.size);
	});
});

// ---------------------------------------------------------------------------
// genMsgId  (async wrapper over the same serial generator)
// ---------------------------------------------------------------------------

describe('genMsgId', function () {

	it('should return a string', async function () {
		var r = await genMsgId();
		assert.strictEqual(typeof r, 'string');
	});

	it('should return EXACTLY 8 characters (FTS-0009 requirement)', async function () {
		var r = await genMsgId();
		assert.strictEqual(r.length, 8);
	});

	it('should contain only lowercase hex digits', async function () {
		var r = await genMsgId();
		assert.match(r, /^[0-9a-f]{8}$/);
	});

	it('should fit in a 32-bit unsigned integer', async function () {
		var r = await genMsgId();
		var n = parseInt(r, 16);
		assert.ok(n >= 0 && n <= 0xFFFFFFFF);
	});

	it('should produce the same format as getMilliHex', async function () {
		// genMsgId and getMilliHex share the underlying _nextMsgIdSerial
		// helper, so they must produce the same shape even though one is
		// async and one is sync.
		var mid = await genMsgId();
		var hex = getMilliHex();
		assert.strictEqual(mid.length, hex.length);
		assert.match(mid, /^[0-9a-f]{8}$/);
		assert.match(hex, /^[0-9a-f]{8}$/);
	});

	it('should share the counter with getMilliHex (no collisions across the two APIs)', async function () {
		var seen = new Set();
		for (var i = 0; i < 50; i++) {
			seen.add(await genMsgId());
			seen.add(getMilliHex());
		}
		assert.strictEqual(seen.size, 100, 'Expected 100 unique values across both APIs, got: ' + seen.size);
	});
});

// ---------------------------------------------------------------------------
// getDateTimeString  (async, format shape only)
// ---------------------------------------------------------------------------

describe('getDateTimeString', function () {

	it('should return a string', async function () {
		var r = await getDateTimeString();
		assert.strictEqual(typeof r, 'string');
	});

	it('should match FTN datetime format: DD Mon YY  HH:MM:SS', async function () {
		// e.g. "21 Mar 25  14:30:00"
		var r = await getDateTimeString();
		// Pattern: two digits, space, three-letter month, space, two digits, two spaces, HH:MM:SS
		assert.match(r, /^\d{2} [A-Z][a-z]{2} \d{2}  \d{2}:\d{2}:\d{2}$/);
	});

	it('should contain the current year (2-digit)', async function () {
		var r = await getDateTimeString();
		var yy = String(new Date().getFullYear() % 100).padStart(2, '0');
		assert.ok(r.includes(yy), 'Expected year ' + yy + ' in: ' + r);
	});
});

// ---------------------------------------------------------------------------
// getSystemTime  (async, timezone handling)
// ---------------------------------------------------------------------------

describe('getSystemTime', function () {

	describe('UTC input (no TZ adjustment)', function () {
		it('should parse a valid FTN datetime string to a Date object', async function () {
			// FTN format: "DD Mon YY  HH:MM:SS" — as produced by getDateTimeString
			var r = await getSystemTime('21 Mar 25  14:30:00', '');
			assert.ok(r instanceof Date);
			assert.ok(!isNaN(r.getTime()));
		});

		it('should correctly set year, month, day for a 2000s date', async function () {
			var r = await getSystemTime('15 Jan 24  09:00:00', '');
			// year 2024 — getSystemTime prepends "20" for years <= 80
			assert.strictEqual(r.getUTCFullYear(), 2024);
		});

		it('should correctly set year for a pre-2000 date (>80 threshold)', async function () {
			var r = await getSystemTime('01 Jun 95  12:00:00', '');
			// 95 > 80 so prepend "19"
			assert.strictEqual(r.getUTCFullYear(), 1995);
		});

		it('should parse December correctly', async function () {
			var r = await getSystemTime('25 Dec 24  00:00:00', '');
			assert.strictEqual(r.getUTCMonth(), 11); // December = 11 (zero-indexed)
		});

		it('should parse June correctly', async function () {
			var r = await getSystemTime('01 Jun 24  00:00:00', '');
			assert.strictEqual(r.getUTCMonth(), 5); // June = 5 (zero-indexed)
		});
	});

	describe('timezone offset adjustment', function () {
		it('should subtract positive TZUTC offset to get UTC', async function () {
			// '+0500' means the local time is UTC+5, so we subtract 300 min to get UTC
			var base    = await getSystemTime('01 Jan 24  10:00:00', '');
			var shifted = await getSystemTime('01 Jan 24  10:00:00', '0500');
			// shifted should be 5 hours earlier (300 minutes subtracted)
			var diffMin = (base.getTime() - shifted.getTime()) / 60000;
			assert.strictEqual(diffMin, 300);
		});

		it('should add minutes for negative TZUTC offset', async function () {
			// '-0500' means the local time is UTC-5, so we add 300 min to get UTC
			var base    = await getSystemTime('01 Jan 24  10:00:00', '');
			var shifted = await getSystemTime('01 Jan 24  10:00:00', '-0500');
			var diffMin = (shifted.getTime() - base.getTime()) / 60000;
			assert.strictEqual(diffMin, 300);
		});

		it('should handle a 30-minute offset (e.g. India +0530)', async function () {
			var base    = await getSystemTime('15 Mar 25  12:00:00', '');
			var shifted = await getSystemTime('15 Mar 25  12:00:00', '0530');
			var diffMin = (base.getTime() - shifted.getTime()) / 60000;
			assert.strictEqual(diffMin, 330); // 5h 30m = 330 min
		});

		it('should treat empty string TZ as no offset', async function () {
			var r1 = await getSystemTime('01 Feb 25  06:00:00', '');
			var r2 = await getSystemTime('01 Feb 25  06:00:00', '0000');
			// Both should produce the same result (0000 = UTC+0 = no adjustment)
			assert.strictEqual(r1.getTime(), r2.getTime());
		});
	});
});
