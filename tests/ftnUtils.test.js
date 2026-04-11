// tests/ftnUtils.test.js — Unit tests for src/utils/ftnUtils.js
//
// Tests genMsgId(), getMilliHex(), parseSerial(), dayBucketForDate(),
// getDateTimeString(), and getSystemTime().
//
// The MSGID generator was rewritten to use a 16-bit day field since the
// Canectic epoch (1980-12-08 UTC) combined with a 16-bit per-day counter
// backed by Redis. These tests exercise the pure logic; the Redis path
// is covered by integration tests. Without Redis available, the
// generator falls back to an in-process counter that still produces
// well-formed 8-char hex serials.
//
// Run: npx mocha tests/ftnUtils.test.js

import assert from 'assert';
import {
	getDateTimeString,
	genMsgId,
	getMilliHex,
	getSystemTime,
	parseSerial,
	dayBucketForDate,
	CANECTIC_EPOCH_MS
} from '../src/utils/ftnUtils.js';

// ---------------------------------------------------------------------------
// Canectic epoch anchor
// ---------------------------------------------------------------------------

describe('CANECTIC_EPOCH_MS', function () {

	it('should be 1980-12-08 00:00:00 UTC', function () {
		var expected = Date.UTC(1980, 11, 8);
		assert.strictEqual(CANECTIC_EPOCH_MS, expected);
	});

	it('should convert to a Date matching 1980-12-08', function () {
		var d = new Date(CANECTIC_EPOCH_MS);
		assert.strictEqual(d.getUTCFullYear(), 1980);
		assert.strictEqual(d.getUTCMonth(), 11);   // December (0-indexed)
		assert.strictEqual(d.getUTCDate(), 8);
		assert.strictEqual(d.getUTCHours(), 0);
	});
});

// ---------------------------------------------------------------------------
// dayBucketForDate
// ---------------------------------------------------------------------------

describe('dayBucketForDate', function () {

	it('returns 0 for the epoch itself', function () {
		assert.strictEqual(dayBucketForDate(new Date(CANECTIC_EPOCH_MS)), 0);
	});

	it('returns 1 for the day after the epoch', function () {
		var d = new Date(CANECTIC_EPOCH_MS + 86400000);
		assert.strictEqual(dayBucketForDate(d), 1);
	});

	it('returns 0 (clamped) for a date before the epoch', function () {
		var d = new Date(Date.UTC(1970, 0, 1));  // 1970-01-01, well before epoch
		assert.strictEqual(dayBucketForDate(d), 0);
	});

	it('accepts a numeric millisecond timestamp', function () {
		var ms = CANECTIC_EPOCH_MS + (86400000 * 365);  // one year later
		assert.strictEqual(dayBucketForDate(ms), 365);
	});

	it('represents a date in 2025 correctly', function () {
		// 2025-01-01 is 16,095 days after 1980-12-08 (44 years + 24 days)
		var d = new Date(Date.UTC(2025, 0, 1));
		var bucket = dayBucketForDate(d);
		assert.strictEqual(bucket, 16095, 'Expected day 16095 for 2025-01-01, got ' + bucket);
	});

	it('represents a date in 1985 correctly (historical import range)', function () {
		// 1985-01-01 is 1485 days after 1980-12-08
		// (4 years + 24 days, including the 1984 leap day)
		var d = new Date(Date.UTC(1985, 0, 1));
		var bucket = dayBucketForDate(d);
		assert.strictEqual(bucket, 1485);
	});

	it('wraps at 2^16 days (2160-06-07)', function () {
		// Day 65535 is the last representable day before wrap
		var ms = CANECTIC_EPOCH_MS + (65535 * 86400000);
		var bucket = dayBucketForDate(ms);
		assert.strictEqual(bucket, 65535);
		// The next day wraps back to 0 (16-bit truncation)
		var ms2 = CANECTIC_EPOCH_MS + (65536 * 86400000);
		assert.strictEqual(dayBucketForDate(ms2), 0);
	});

	it('handles invalid input by returning 0', function () {
		assert.strictEqual(dayBucketForDate(NaN), 0);
		assert.strictEqual(dayBucketForDate('not a date'), 0);
	});
});

// ---------------------------------------------------------------------------
// parseSerial
// ---------------------------------------------------------------------------

describe('parseSerial', function () {

	it('splits a valid 8-char hex serial into days and counter', function () {
		// 0x3ede 0x0001 = day 16094, counter 1
		var r = parseSerial('3ede0001');
		assert.deepStrictEqual(r, { days: 16094, counter: 1 });
	});

	it('handles the max 32-bit value', function () {
		var r = parseSerial('ffffffff');
		assert.deepStrictEqual(r, { days: 0xFFFF, counter: 0xFFFF });
	});

	it('handles zero', function () {
		var r = parseSerial('00000000');
		assert.deepStrictEqual(r, { days: 0, counter: 0 });
	});

	it('is case-insensitive', function () {
		var lower = parseSerial('3ede0001');
		var upper = parseSerial('3EDE0001');
		assert.deepStrictEqual(lower, upper);
	});

	it('trims whitespace', function () {
		var r = parseSerial('  3ede0001  ');
		assert.deepStrictEqual(r, { days: 16094, counter: 1 });
	});

	it('returns null for malformed input', function () {
		assert.strictEqual(parseSerial(''), null);
		assert.strictEqual(parseSerial(null), null);
		assert.strictEqual(parseSerial(undefined), null);
		assert.strictEqual(parseSerial('not hex'), null);
		assert.strictEqual(parseSerial('1234567'), null);   // 7 chars
		assert.strictEqual(parseSerial('123456789'), null); // 9 chars
		assert.strictEqual(parseSerial('ghijklmn'), null);  // invalid hex
	});

	it('round-trips through a known day/counter pair', function () {
		// Construct 0x3ede0042 explicitly: day 16094, counter 0x42 = 66
		var hex = (((16094 & 0xFFFF) << 16) | 0x42).toString(16).padStart(8, '0');
		var parsed = parseSerial(hex);
		assert.strictEqual(parsed.days, 16094);
		assert.strictEqual(parsed.counter, 0x42);
	});
});

// ---------------------------------------------------------------------------
// getMilliHex / genMsgId  (async, shared generator)
//
// FTS-0009 MSGID serial: exactly 8 hex characters. Both wrappers call
// the same _nextMsgIdSerial() internal, so they share the Redis-backed
// counter (or fallback counter when Redis isn't available to tests).
// ---------------------------------------------------------------------------

describe('getMilliHex (async)', function () {

	it('should return a string', async function () {
		var r = await getMilliHex();
		assert.strictEqual(typeof r, 'string');
	});

	it('should return EXACTLY 8 characters (FTS-0009 requirement)', async function () {
		var r = await getMilliHex();
		assert.strictEqual(r.length, 8, 'Expected exactly 8 chars, got: ' + r.length + ' (' + r + ')');
	});

	it('should contain only lowercase hex digits', async function () {
		var r = await getMilliHex();
		assert.match(r, /^[0-9a-f]{8}$/);
	});

	it('should fit in a 32-bit unsigned integer', async function () {
		var r = await getMilliHex();
		var n = parseInt(r, 16);
		assert.ok(n >= 0 && n <= 0xFFFFFFFF);
	});

	it('should encode the current day in the high 16 bits', async function () {
		var r = await getMilliHex();
		var parsed = parseSerial(r);
		var expectedDay = dayBucketForDate(new Date());
		assert.strictEqual(parsed.days, expectedDay,
			'Expected day bucket ' + expectedDay + ' in serial, got ' + parsed.days);
	});

	it('should produce distinct values on successive calls', async function () {
		var seen = new Set();
		for (var i = 0; i < 50; i++) {
			seen.add(await getMilliHex());
		}
		assert.strictEqual(seen.size, 50, 'Expected 50 unique values, got: ' + seen.size);
	});
});

describe('genMsgId (async)', function () {

	it('should return EXACTLY 8 characters', async function () {
		var r = await genMsgId();
		assert.strictEqual(r.length, 8);
	});

	it('should contain only lowercase hex digits', async function () {
		var r = await genMsgId();
		assert.match(r, /^[0-9a-f]{8}$/);
	});

	it('should share the counter with getMilliHex', async function () {
		// Both APIs call the same underlying generator, so interleaved
		// calls should produce 100 distinct values across both.
		var seen = new Set();
		for (var i = 0; i < 50; i++) {
			seen.add(await genMsgId());
			seen.add(await getMilliHex());
		}
		assert.strictEqual(seen.size, 100,
			'Expected 100 unique values across both APIs, got: ' + seen.size);
	});

	// Close the Redis connection so mocha can exit cleanly. The MSGID
	// generator opens a pooled connection the first time it's called;
	// without this, mocha hangs on "leaked async resources" for several
	// seconds before timing out.
	after(async function () {
		try {
			var redis = await import('../src/middleware/db/redis.js');
			if (typeof redis.shutdown === 'function') await redis.shutdown();
		} catch (_) {}
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
