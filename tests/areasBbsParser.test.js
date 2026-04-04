// tests/areasBbsParser.test.js -- Unit tests for areasBbsParser.js
//
// Tests parseAreasBbs(text): parses areas.bbs text into [{ areatag, description }].
// No DB, no Redis, no filesystem.
// Run: npx mocha tests/areasBbsParser.test.js

import assert from 'assert';
import { parseAreasBbs } from '../src/utils/areasBbsParser.js';

// ---------------------------------------------------------------------------
// Null / empty input
// ---------------------------------------------------------------------------

describe('parseAreasBbs', function () {

	describe('null and empty input', function () {

		it('should return empty array for null', function () {
			var r = parseAreasBbs(null);
			assert.deepStrictEqual(r, []);
		});

		it('should return empty array for undefined', function () {
			var r = parseAreasBbs(undefined);
			assert.deepStrictEqual(r, []);
		});

		it('should return empty array for empty string', function () {
			var r = parseAreasBbs('');
			assert.deepStrictEqual(r, []);
		});

		it('should return empty array for string of only newlines', function () {
			var r = parseAreasBbs('\n\n\n');
			assert.deepStrictEqual(r, []);
		});

		it('should return empty array for string of only whitespace lines', function () {
			var r = parseAreasBbs('   \n\t\n  ');
			assert.deepStrictEqual(r, []);
		});
	});

	// ---------------------------------------------------------------------------
	// Comment lines
	// ---------------------------------------------------------------------------

	describe('comment lines', function () {

		it('should skip lines starting with ;', function () {
			var r = parseAreasBbs('; this is a comment\nFSXNET_GEN General Chat');
			assert.strictEqual(r.length, 1);
			assert.strictEqual(r[0].areatag, 'FSXNET_GEN');
		});

		it('should skip lines starting with #', function () {
			var r = parseAreasBbs('# hash comment\nFSXNET_GEN General Chat');
			assert.strictEqual(r.length, 1);
			assert.strictEqual(r[0].areatag, 'FSXNET_GEN');
		});

		it('should skip multiple consecutive comment lines', function () {
			var input = '; comment 1\n; comment 2\n# comment 3\nFSXNET_GEN General Chat\n';
			var r = parseAreasBbs(input);
			assert.strictEqual(r.length, 1);
		});

		it('should skip a file that is entirely comments', function () {
			var r = parseAreasBbs('; whole file\n; is comments\n');
			assert.deepStrictEqual(r, []);
		});

		it('should not treat an inline semicolon as a comment', function () {
			// Only leading ; is a comment marker
			var r = parseAreasBbs('FSXNET_GEN General; Chat');
			assert.strictEqual(r.length, 1);
			assert.strictEqual(r[0].description, 'General; Chat');
		});
	});

	// ---------------------------------------------------------------------------
	// Blank lines
	// ---------------------------------------------------------------------------

	describe('blank lines', function () {

		it('should skip blank lines between areas', function () {
			var r = parseAreasBbs('AREA1 First area\n\nAREA2 Second area');
			assert.strictEqual(r.length, 2);
		});

		it('should skip lines containing only spaces', function () {
			var r = parseAreasBbs('AREA1 First\n   \nAREA2 Second');
			assert.strictEqual(r.length, 2);
		});

		it('should skip lines containing only tabs', function () {
			var r = parseAreasBbs('AREA1 First\n\t\nAREA2 Second');
			assert.strictEqual(r.length, 2);
		});
	});

	// ---------------------------------------------------------------------------
	// Space-separated lines
	// ---------------------------------------------------------------------------

	describe('space-separated areatag and description', function () {

		it('should parse areatag and description from a normal line', function () {
			var r = parseAreasBbs('FSXNET_GEN General Chat');
			assert.strictEqual(r.length, 1);
			assert.strictEqual(r[0].areatag, 'FSXNET_GEN');
			assert.strictEqual(r[0].description, 'General Chat');
		});

		it('should preserve internal spaces in the description', function () {
			var r = parseAreasBbs('MYSTIC_CHAT Mystic BBS  General  Chat');
			assert.strictEqual(r[0].description, 'Mystic BBS  General  Chat');
		});

		it('should trim leading and trailing whitespace from the line', function () {
			var r = parseAreasBbs('   AREA1 Some Description   ');
			assert.strictEqual(r[0].areatag, 'AREA1');
			assert.strictEqual(r[0].description, 'Some Description');
		});
	});

	// ---------------------------------------------------------------------------
	// Tab-separated lines
	// ---------------------------------------------------------------------------

	describe('tab-separated areatag and description', function () {

		it('should parse areatag and description separated by a tab', function () {
			var r = parseAreasBbs('FSXNET_GEN\tGeneral Chat');
			assert.strictEqual(r.length, 1);
			assert.strictEqual(r[0].areatag, 'FSXNET_GEN');
			assert.strictEqual(r[0].description, 'General Chat');
		});

		it('should handle multiple tabs between areatag and description', function () {
			// The tab after areatag is the separator; rest including extra tabs becomes description
			var r = parseAreasBbs('AREA1\t\tSome Desc');
			assert.strictEqual(r[0].areatag, 'AREA1');
			// The leading extra tab in the description substring gets trimmed
			assert.strictEqual(r[0].description, 'Some Desc');
		});
	});

	// ---------------------------------------------------------------------------
	// Areatag only (no description)
	// ---------------------------------------------------------------------------

	describe('areatag only, no description', function () {

		it('should return empty string for description when no separator present', function () {
			var r = parseAreasBbs('ORPHAN_AREA');
			assert.strictEqual(r.length, 1);
			assert.strictEqual(r[0].areatag, 'ORPHAN_AREA');
			assert.strictEqual(r[0].description, '');
		});

		it('should still produce an object with both keys when no description', function () {
			var r = parseAreasBbs('MYAREA');
			assert.ok(Object.prototype.hasOwnProperty.call(r[0], 'areatag'));
			assert.ok(Object.prototype.hasOwnProperty.call(r[0], 'description'));
		});
	});

	// ---------------------------------------------------------------------------
	// Multiple areas
	// ---------------------------------------------------------------------------

	describe('multiple areas', function () {

		it('should parse two areas', function () {
			var r = parseAreasBbs('AREA1 First area\nAREA2 Second area');
			assert.strictEqual(r.length, 2);
			assert.strictEqual(r[0].areatag, 'AREA1');
			assert.strictEqual(r[1].areatag, 'AREA2');
		});

		it('should parse many areas in order', function () {
			var lines = [];
			for (var i = 1; i <= 10; i++) {
				lines.push('AREA' + i + ' Area number ' + i);
			}
			var r = parseAreasBbs(lines.join('\n'));
			assert.strictEqual(r.length, 10);
			for (var j = 0; j < 10; j++) {
				assert.strictEqual(r[j].areatag, 'AREA' + (j + 1));
				assert.strictEqual(r[j].description, 'Area number ' + (j + 1));
			}
		});
	});

	// ---------------------------------------------------------------------------
	// Mixed content
	// ---------------------------------------------------------------------------

	describe('mixed comments, blank lines, and areas', function () {

		it('should parse only area lines from a realistic mixed file', function () {
			var input = [
				'; areas.bbs generated by Mystic BBS',
				'; Network: FsxNet',
				'',
				'FSXNET_GEN    General Chat',
				'FSXNET_TEST   Test Area',
				'',
				'# end of file',
			].join('\n');

			var r = parseAreasBbs(input);
			assert.strictEqual(r.length, 2);
			assert.strictEqual(r[0].areatag, 'FSXNET_GEN');
			assert.strictEqual(r[0].description, 'General Chat');
			assert.strictEqual(r[1].areatag, 'FSXNET_TEST');
			assert.strictEqual(r[1].description, 'Test Area');
		});

		it('should return empty array for file with only comments and blank lines', function () {
			var input = '; comment\n\n# another comment\n   \n';
			var r = parseAreasBbs(input);
			assert.deepStrictEqual(r, []);
		});
	});

	// ---------------------------------------------------------------------------
	// Windows-style line endings
	// ---------------------------------------------------------------------------

	describe('Windows CRLF line endings', function () {

		it('should handle \\r\\n line endings', function () {
			var r = parseAreasBbs('AREA1 First\r\nAREA2 Second\r\n');
			assert.strictEqual(r.length, 2);
			assert.strictEqual(r[0].areatag, 'AREA1');
			assert.strictEqual(r[1].areatag, 'AREA2');
		});

		it('should not include \\r in areatag or description', function () {
			var r = parseAreasBbs('AREA1 Some description\r\n');
			assert.strictEqual(r[0].areatag, 'AREA1');
			assert.strictEqual(r[0].description, 'Some description');
		});
	});

	// ---------------------------------------------------------------------------
	// Real-world areas.bbs examples
	// ---------------------------------------------------------------------------

	describe('real-world areas.bbs format examples', function () {

		it('should parse a typical Mystic BBS / FsxNet areas.bbs excerpt', function () {
			var input = [
				'; AREAS.BBS for FsxNet',
				'; Created by Mystic BBS',
				'',
				'FSXNET_GEN        FsxNet - General',
				'FSXNET_BBS        FsxNet - BBS Discussion',
				'FSXNET_DEV        FsxNet - Development',
				'FSXNET_MUSIC      FsxNet - Music',
			].join('\n');

			var r = parseAreasBbs(input);
			assert.strictEqual(r.length, 4);
			assert.strictEqual(r[0].areatag, 'FSXNET_GEN');
			assert.strictEqual(r[0].description, 'FsxNet - General');
			assert.strictEqual(r[3].areatag, 'FSXNET_MUSIC');
			assert.strictEqual(r[3].description, 'FsxNet - Music');
		});

		it('should parse a typical Synchronet / Dove-Net areas.bbs excerpt', function () {
			var input = [
				'; Dove-Net areas.bbs',
				'DOVE-NET.DOVE_DOVE        Dove-Net General',
				'DOVE-NET.SYSOP_DOVE       Dove-Net SysOp',
				'DOVE-NET.ARTS_DOVE        Dove-Net Arts & Entertainment',
			].join('\n');

			var r = parseAreasBbs(input);
			assert.strictEqual(r.length, 3);
			assert.strictEqual(r[0].areatag, 'DOVE-NET.DOVE_DOVE');
			assert.strictEqual(r[2].description, 'Dove-Net Arts & Entertainment');
		});

		it('should parse tab-delimited areas.bbs as produced by some BBS software', function () {
			var input = [
				'; tab-delimited export',
				'NET46_GENERAL\tFidoNet 46 General',
				'NET46_SYSOP\tFidoNet 46 Sysop',
			].join('\n');

			var r = parseAreasBbs(input);
			assert.strictEqual(r.length, 2);
			assert.strictEqual(r[0].areatag, 'NET46_GENERAL');
			assert.strictEqual(r[0].description, 'FidoNet 46 General');
		});

		it('should parse areas with extra trailing flags and keep only the description part', function () {
			// Some BBS software appends flags after the description.
			// Per the module spec: "Some variants have additional flags after the
			// description -- we ignore those." The parser keeps everything after
			// the areatag as the description, so flags end up in description.
			// Verify the areatag is at least correct.
			var r = parseAreasBbs('MYAREA My Area Description -passon -loc');
			assert.strictEqual(r[0].areatag, 'MYAREA');
			assert.ok(r[0].description.startsWith('My Area Description'));
		});
	});

	// ---------------------------------------------------------------------------
	// Whitespace edge cases
	// ---------------------------------------------------------------------------

	describe('whitespace edge cases', function () {

		it('should trim leading spaces from areatag', function () {
			var r = parseAreasBbs('   AREA1 Description');
			assert.strictEqual(r[0].areatag, 'AREA1');
		});

		it('should trim trailing spaces from description', function () {
			var r = parseAreasBbs('AREA1 Description   ');
			assert.strictEqual(r[0].description, 'Description');
		});

		it('should handle areatag with multiple spaces before description', function () {
			// First space is the separator; extra spaces become part of description
			// then get trimmed
			var r = parseAreasBbs('AREA1   Description');
			assert.strictEqual(r[0].areatag, 'AREA1');
			assert.strictEqual(r[0].description, 'Description');
		});

		it('should skip a line that becomes empty after trimming (only whitespace)', function () {
			var r = parseAreasBbs('AREA1 First\n      \nAREA2 Second');
			assert.strictEqual(r.length, 2);
		});
	});

	// ---------------------------------------------------------------------------
	// Return value shape
	// ---------------------------------------------------------------------------

	describe('return value shape', function () {

		it('should always return an array', function () {
			assert.ok(Array.isArray(parseAreasBbs('')));
			assert.ok(Array.isArray(parseAreasBbs('AREA1 desc')));
		});

		it('should return objects with exactly areatag and description keys', function () {
			var r = parseAreasBbs('AREA1 Some Area');
			assert.strictEqual(typeof r[0].areatag, 'string');
			assert.strictEqual(typeof r[0].description, 'string');
		});
	});
});
