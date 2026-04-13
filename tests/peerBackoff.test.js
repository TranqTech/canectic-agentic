// tests/peerBackoff.test.js -- Unit tests for peer backoff math
//
// Tests pure helpers that don't require DB access.

import assert from 'assert';
import {
	computeBackoffDelayMs,
	isInBackoff,
} from '../src/models/peerConnections.js';

describe('peerConnections.computeBackoffDelayMs', function () {

	// All tests use ±10% jitter so we assert range, not exact equals.
	function inRange(value, expected, pct) {
		var tol = expected * (pct || 0.11); // 11% to cover the 10% jitter + rounding
		return value >= expected - tol && value <= expected + tol;
	}

	it('returns one base interval for 1 failure', function () {
		var delay = computeBackoffDelayMs(1, 60, 24);
		// Expected ~60 min = 3_600_000 ms (+/- 10% jitter)
		assert.ok(inRange(delay, 60 * 60 * 1000),
			'expected ~60min, got ' + (delay / 60000) + 'min');
	});

	it('doubles at 2 failures', function () {
		var delay = computeBackoffDelayMs(2, 60, 24);
		// Expected ~120 min
		assert.ok(inRange(delay, 2 * 60 * 60 * 1000));
	});

	it('quadruples at 3 failures', function () {
		var delay = computeBackoffDelayMs(3, 60, 24);
		// Expected ~240 min
		assert.ok(inRange(delay, 4 * 60 * 60 * 1000));
	});

	it('caps at configured maximum hours', function () {
		// 10 failures with 60min base = 60 * 2^9 = 30720 min = 512 hours
		// but cap is 24 hours = 1440 min
		var delay = computeBackoffDelayMs(10, 60, 24);
		var max = 24 * 60 * 60 * 1000 * 1.11; // cap + jitter headroom
		assert.ok(delay <= max, 'delay should not exceed cap, got ' + (delay / 3600000) + ' hours');
	});

	it('respects smaller cap', function () {
		var delay = computeBackoffDelayMs(10, 60, 1); // 1-hour cap
		var max = 1 * 60 * 60 * 1000 * 1.11;
		assert.ok(delay <= max, 'delay should not exceed 1h cap');
	});

	it('scales with base interval', function () {
		var delay30 = computeBackoffDelayMs(1, 30, 24);
		var delay60 = computeBackoffDelayMs(1, 60, 24);
		// 60min base should give about twice the delay of 30min base at same failures
		// but jitter makes this stochastic, so run a few samples
		var avg30 = 0, avg60 = 0;
		for (var i = 0; i < 50; i++) {
			avg30 += computeBackoffDelayMs(1, 30, 24);
			avg60 += computeBackoffDelayMs(1, 60, 24);
		}
		avg30 /= 50; avg60 /= 50;
		assert.ok(avg60 > avg30 * 1.5 && avg60 < avg30 * 2.5,
			'60min avg should be ~2x 30min avg (got ' + avg60 / avg30 + ')');
	});

	it('handles 0 failures by treating as 1', function () {
		var delay = computeBackoffDelayMs(0, 60, 24);
		// Math.max(0, 0-1) = 0, so exp=0, minutes = base * 2^0 = base
		assert.ok(inRange(delay, 60 * 60 * 1000));
	});

	it('jitter produces varied delays', function () {
		var samples = [];
		for (var i = 0; i < 20; i++) {
			samples.push(computeBackoffDelayMs(1, 60, 24));
		}
		var min = Math.min.apply(null, samples);
		var max = Math.max.apply(null, samples);
		// Min/max should differ by at least some visible amount due to +/- 10%
		assert.ok(max > min, 'jitter should produce different values across samples');
	});
});

describe('peerConnections.isInBackoff', function () {

	it('returns false for null or missing connection_data', function () {
		assert.strictEqual(isInBackoff(null), false);
		assert.strictEqual(isInBackoff({}), false);
		assert.strictEqual(isInBackoff({ connection_data: null }), false);
	});

	it('returns false when no next_allowed_poll_at', function () {
		assert.strictEqual(isInBackoff({ connection_data: {} }), false);
	});

	it('returns false when next_allowed_poll_at is in the past', function () {
		var past = new Date(Date.now() - 60000).toISOString();
		assert.strictEqual(isInBackoff({
			connection_data: { next_allowed_poll_at: past }
		}), false);
	});

	it('returns true when next_allowed_poll_at is in the future', function () {
		var future = new Date(Date.now() + 60000).toISOString();
		assert.strictEqual(isInBackoff({
			connection_data: { next_allowed_poll_at: future }
		}), true);
	});

	it('returns false for invalid date strings', function () {
		assert.strictEqual(isInBackoff({
			connection_data: { next_allowed_poll_at: 'not a date' }
		}), false);
	});
});
