// tests/systemStats.test.js — Unit tests for src/models/systemStats.js
//
// Tests the exported formatFileSize() pure function directly.
// getStats() is DB-dependent and is validated only for export presence.
//
// Run: npx mocha tests/systemStats.test.js

import assert from 'assert';
import { formatFileSize, getStats } from '../src/models/systemStats.js';

// ---------------------------------------------------------------------------
// Export validation
// ---------------------------------------------------------------------------

describe('systemStats exports', function () {

	it('should export formatFileSize as a function', function () {
		assert.strictEqual(typeof formatFileSize, 'function');
	});

	it('should export getStats as a function', function () {
		assert.strictEqual(typeof getStats, 'function');
	});

});

// ---------------------------------------------------------------------------
// formatFileSize
// ---------------------------------------------------------------------------

describe('formatFileSize', function () {

	describe('zero', function () {

		it('should return "0 B" for exactly 0', function () {
			assert.strictEqual(formatFileSize(0), '0 B');
		});

	});

	describe('bytes (B)', function () {

		it('should return "1 B" for 1', function () {
			assert.strictEqual(formatFileSize(1), '1 B');
		});

		it('should return "512 B" for 512', function () {
			assert.strictEqual(formatFileSize(512), '512 B');
		});

		it('should return "1023 B" for 1023 (just below 1 KB boundary)', function () {
			assert.strictEqual(formatFileSize(1023), '1023 B');
		});

		it('should not include a decimal point for values below 1 KB', function () {
			assert.ok(!formatFileSize(100).includes('.'));
		});

	});

	describe('kilobytes (KB)', function () {

		it('should return "1.0 KB" for 1024', function () {
			assert.strictEqual(formatFileSize(1024), '1.0 KB');
		});

		it('should return "1.5 KB" for 1536 (1.5 * 1024)', function () {
			assert.strictEqual(formatFileSize(1536), '1.5 KB');
		});

		it('should return "512.0 KB" for 524288 (512 * 1024)', function () {
			assert.strictEqual(formatFileSize(512 * 1024), '512.0 KB');
		});

		it('should return "1023.0 KB" for 1047552 (just below 1 MB boundary)', function () {
			assert.strictEqual(formatFileSize(1023 * 1024), '1023.0 KB');
		});

	});

	describe('megabytes (MB)', function () {

		it('should return "1.0 MB" for 1048576 (1024^2)', function () {
			assert.strictEqual(formatFileSize(1048576), '1.0 MB');
		});

		it('should return "1.5 MB" for 1572864 (1.5 * 1024^2)', function () {
			assert.strictEqual(formatFileSize(1572864), '1.5 MB');
		});

		it('should return "10.0 MB" for 10485760 (10 * 1024^2)', function () {
			assert.strictEqual(formatFileSize(10485760), '10.0 MB');
		});

	});

	describe('gigabytes (GB)', function () {

		it('should return "1.0 GB" for 1073741824 (1024^3)', function () {
			assert.strictEqual(formatFileSize(1073741824), '1.0 GB');
		});

		it('should return "2.5 GB" for 2684354560 (2.5 * 1024^3)', function () {
			assert.strictEqual(formatFileSize(2684354560), '2.5 GB');
		});

	});

	describe('terabytes (TB)', function () {

		it('should return "1.0 TB" for 1099511627776 (1024^4)', function () {
			assert.strictEqual(formatFileSize(1099511627776), '1.0 TB');
		});

		it('should return "4.0 TB" for 4398046511104 (4 * 1024^4)', function () {
			assert.strictEqual(formatFileSize(4 * Math.pow(1024, 4)), '4.0 TB');
		});

	});

	describe('output format', function () {

		it('should always have exactly one space before the unit', function () {
			var cases = [1, 1024, 1048576, 1073741824, 1099511627776];
			for (var n of cases) {
				var result = formatFileSize(n);
				assert.ok(/ [BKMGT]/.test(result), 'No space before unit in: ' + result);
			}
		});

		it('should have one decimal place for KB and above', function () {
			var cases = [1024, 1048576, 1073741824, 1099511627776];
			for (var n of cases) {
				var result = formatFileSize(n);
				assert.ok(/\.\d /.test(result), 'Expected one decimal place in: ' + result);
			}
		});

		it('should not have a decimal point for plain bytes', function () {
			var result = formatFileSize(500);
			assert.ok(!result.includes('.'), 'Unexpected decimal point in: ' + result);
		});

	});

	describe('boundary conditions', function () {

		it('should produce a KB result at exactly the 1024 boundary', function () {
			assert.ok(formatFileSize(1024).endsWith(' KB'));
		});

		it('should produce an MB result at exactly the 1024^2 boundary', function () {
			assert.ok(formatFileSize(Math.pow(1024, 2)).endsWith(' MB'));
		});

		it('should produce a GB result at exactly the 1024^3 boundary', function () {
			assert.ok(formatFileSize(Math.pow(1024, 3)).endsWith(' GB'));
		});

		it('should produce a TB result at exactly the 1024^4 boundary', function () {
			assert.ok(formatFileSize(Math.pow(1024, 4)).endsWith(' TB'));
		});

	});

	describe('edge cases specific to formatFileSize (no coercion, no negative guard)', function () {

		// formatFileSize does not parseInt its input — it works on raw numbers.
		// Unlike formatBytes in formatHelpers.test.js, it has no string coercion.
		// These tests document the actual behaviour of the implementation.

		it('should handle a large integer near the Number.MAX_SAFE_INTEGER boundary gracefully', function () {
			// Should not throw — result may be in TB range with floating-point rounding
			var result = formatFileSize(Number.MAX_SAFE_INTEGER);
			assert.strictEqual(typeof result, 'string');
			assert.ok(result.length > 0);
		});

		it('should not throw for a negative number (documents behaviour)', function () {
			// Math.log(negative) is NaN; units[NaN] is undefined.
			// The implementation does not guard negatives — we document this, not fix it.
			var threw = false;
			try {
				formatFileSize(-1);
			} catch (e) {
				threw = true;
			}
			assert.strictEqual(threw, false, 'formatFileSize should not throw for negative input');
		});

		it('returns a string for 1 byte (not a number)', function () {
			assert.strictEqual(typeof formatFileSize(1), 'string');
		});

		it('returns a string for 0', function () {
			assert.strictEqual(typeof formatFileSize(0), 'string');
		});

	});

});
