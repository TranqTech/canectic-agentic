// tests/formatHelpers.test.js — Unit tests for formatBytes
//
// formatBytes is defined in src/routes/files.js but is not exported.
// It is inlined here with a comment referencing the source location so
// that the algorithm is tested independently of the Express router.
//
// Run: npx mocha tests/formatHelpers.test.js

import assert from 'assert';

// ---------------------------------------------------------------------------
// Inlined helper — mirrors src/routes/files.js lines 140-147
// ---------------------------------------------------------------------------

function formatBytes(bytes) {
	var n = parseInt(bytes) || 0;
	if (n <= 0) return '0 B';
	var sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
	var i = Math.floor(Math.log(n) / Math.log(1024));
	if (i >= sizes.length) i = sizes.length - 1;
	return (n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + sizes[i];
}

// ---------------------------------------------------------------------------
// formatBytes
// ---------------------------------------------------------------------------

describe('formatBytes', function () {

	describe('zero and falsy inputs', function () {
		it('should return "0 B" for 0', function () {
			assert.strictEqual(formatBytes(0), '0 B');
		});

		it('should return "0 B" for null', function () {
			assert.strictEqual(formatBytes(null), '0 B');
		});

		it('should return "0 B" for undefined', function () {
			assert.strictEqual(formatBytes(undefined), '0 B');
		});

		it('should return "0 B" for a non-numeric string', function () {
			assert.strictEqual(formatBytes('string zero'), '0 B');
		});

		it('should return "0 B" for negative values', function () {
			assert.strictEqual(formatBytes(-100), '0 B');
		});

		it('should return "0 B" for empty string', function () {
			assert.strictEqual(formatBytes(''), '0 B');
		});
	});

	describe('bytes (B)', function () {
		it('should return "1 B" for 1', function () {
			assert.strictEqual(formatBytes(1), '1 B');
		});

		it('should return "512 B" for 512', function () {
			assert.strictEqual(formatBytes(512), '512 B');
		});

		it('should return "1023 B" for 1023 (just below 1 KB)', function () {
			assert.strictEqual(formatBytes(1023), '1023 B');
		});

		it('should show bytes without decimal (i === 0)', function () {
			// The format uses toFixed(0) for bytes — no decimal point
			assert.ok(!formatBytes(100).includes('.'));
		});
	});

	describe('kilobytes (KB)', function () {
		it('should return "1.0 KB" for 1024', function () {
			assert.strictEqual(formatBytes(1024), '1.0 KB');
		});

		it('should return "1.5 KB" for 1536', function () {
			assert.strictEqual(formatBytes(1536), '1.5 KB');
		});

		it('should return "512.0 KB" for 524288 (512 * 1024)', function () {
			assert.strictEqual(formatBytes(512 * 1024), '512.0 KB');
		});
	});

	describe('megabytes (MB)', function () {
		it('should return "1.0 MB" for 1048576 (1024^2)', function () {
			assert.strictEqual(formatBytes(1048576), '1.0 MB');
		});

		it('should return "10.0 MB" for 10485760', function () {
			assert.strictEqual(formatBytes(10485760), '10.0 MB');
		});

		it('should return "1.5 MB" for 1572864 (1.5 * 1024^2)', function () {
			assert.strictEqual(formatBytes(1572864), '1.5 MB');
		});
	});

	describe('gigabytes (GB)', function () {
		it('should return "1.0 GB" for 1073741824 (1024^3)', function () {
			assert.strictEqual(formatBytes(1073741824), '1.0 GB');
		});
	});

	describe('terabytes (TB)', function () {
		it('should return "1.0 TB" for 1099511627776 (1024^4)', function () {
			assert.strictEqual(formatBytes(1099511627776), '1.0 TB');
		});
	});

	describe('overflow cap at TB', function () {
		it('should cap at TB for values exceeding 1024^4', function () {
			// 1024^5 would overflow to PB, but the sizes array only goes to TB
			var result = formatBytes(Math.pow(1024, 5));
			assert.ok(result.endsWith(' TB'), 'Expected TB suffix, got: ' + result);
		});
	});

	describe('string numeric inputs', function () {
		it('should parse a numeric string correctly', function () {
			assert.strictEqual(formatBytes('1024'), '1.0 KB');
		});

		it('should parse a large numeric string', function () {
			assert.strictEqual(formatBytes('1048576'), '1.0 MB');
		});
	});

	describe('output format', function () {
		it('should always have exactly one space before the unit', function () {
			var cases = [1, 1024, 1048576, 1073741824];
			for (var n of cases) {
				var result = formatBytes(n);
				// Should be: digits (optional decimal) + ' ' + unit
				assert.ok(/ [BKMGT]/.test(result), 'No space before unit in: ' + result);
			}
		});

		it('should have one decimal place for KB and above', function () {
			var result = formatBytes(1024);
			assert.ok(/\.\d /.test(result), 'Expected one decimal place in: ' + result);
		});
	});
});

// ---------------------------------------------------------------------------
// resolveAreaPath logic (inlined — mirrors src/models/fileAreas.js lines 34-38)
// ---------------------------------------------------------------------------
// resolveAreaPath uses appConfig.get() for the default root, which requires
// an initialized config cache. We test the logic directly with a mock get().

import path from 'path';

function resolveAreaPath(group, area, mockGet) {
	// mockGet replaces appConfig.get() for testing
	var root = (group && group.base_dir) ? group.base_dir : mockGet('file_base_dir', 'files');
	var sub  = (area && area.sub_dir) ? area.sub_dir : (area ? area.shortcode.toLowerCase() : '');
	return path.join(root, sub);
}

describe('resolveAreaPath', function () {

	it('should use global file_base_dir when no group is provided', function () {
		var mockGet = function(key, def) { return key === 'file_base_dir' ? '/data/files' : def; };
		var area = { shortcode: 'GAMES', sub_dir: null };
		var result = resolveAreaPath(null, area, mockGet);
		assert.strictEqual(result, path.join('/data/files', 'games'));
	});

	it('should use group base_dir when group has one', function () {
		var mockGet = function(key, def) { return def; };
		var group = { base_dir: '/data/groupfiles' };
		var area  = { shortcode: 'UTILS', sub_dir: 'utils' };
		var result = resolveAreaPath(group, area, mockGet);
		assert.strictEqual(result, path.join('/data/groupfiles', 'utils'));
	});

	it('should fall back to lowercased shortcode when area has no sub_dir', function () {
		var mockGet = function(key, def) { return def; };
		var group = { base_dir: '/groups/main' };
		var area  = { shortcode: 'WAREZ', sub_dir: null };
		var result = resolveAreaPath(group, area, mockGet);
		assert.strictEqual(result, path.join('/groups/main', 'warez'));
	});

	it('should use area sub_dir over shortcode when both are present', function () {
		var mockGet = function(key, def) { return def; };
		var group = { base_dir: '/base' };
		var area  = { shortcode: 'TEST', sub_dir: 'mysubdir' };
		var result = resolveAreaPath(group, area, mockGet);
		assert.strictEqual(result, path.join('/base', 'mysubdir'));
	});

	it('should fall back to default "files" root when appConfig has no file_base_dir', function () {
		var mockGet = function(key, def) { return def; };
		var area = { shortcode: 'MISC', sub_dir: null };
		var result = resolveAreaPath(null, area, mockGet);
		assert.strictEqual(result, path.join('files', 'misc'));
	});

	it('should ignore group base_dir when group is null', function () {
		var mockGet = function(key, def) { return key === 'file_base_dir' ? '/root' : def; };
		var area = { shortcode: 'ART', sub_dir: 'artwork' };
		var result = resolveAreaPath(null, area, mockGet);
		assert.strictEqual(result, path.join('/root', 'artwork'));
	});

	it('should ignore group base_dir when group base_dir is null', function () {
		var mockGet = function(key, def) { return key === 'file_base_dir' ? '/root' : def; };
		var group = { base_dir: null };
		var area  = { shortcode: 'ART', sub_dir: null };
		var result = resolveAreaPath(group, area, mockGet);
		assert.strictEqual(result, path.join('/root', 'art'));
	});
});
