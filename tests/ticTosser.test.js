// tests/ticTosser.test.js — Unit tests for parseTicFile and buildTicDescriptor
// in src/middleware/tossers/ticTosser.js
//
// These are pure parsing/building functions — no DB, no filesystem.
// Run: npx mocha tests/ticTosser.test.js

import assert from 'assert';
import { parseTicFile, buildTicDescriptor } from '../src/middleware/tossers/ticTosser.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

var SAMPLE_TIC = [
	'Area TESTFILES',
	'File TESTFILE.ZIP',
	'Desc A test file for unit testing',
	'LDesc First long description line',
	'LDesc Second long description line',
	'Size 12345',
	'Date 1700000000',
	'CRC AB12CD34',
	'Origin 1:123/456',
	'From 1:123/456',
	'To 1:200/100',
	'Path 1:100/0 1699999000',
	'Path 1:123/0 1699999500',
	'Seenby 1:100/0',
	'Seenby 1:123/0',
	'Pw secretpw',
	'Magic TESTMAGIC',
	''
].join('\r\n');

// ---------------------------------------------------------------------------
// parseTicFile
// ---------------------------------------------------------------------------

describe('parseTicFile', function () {

	describe('happy path — full sample TIC', function () {
		var tic;
		before(function () {
			tic = parseTicFile(SAMPLE_TIC);
		});

		it('should parse Area field', function () {
			assert.strictEqual(tic.area, 'TESTFILES');
		});

		it('should parse File field', function () {
			assert.strictEqual(tic.file, 'TESTFILE.ZIP');
		});

		it('should parse Desc field', function () {
			assert.strictEqual(tic.desc, 'A test file for unit testing');
		});

		it('should collect multiple LDesc lines into an array', function () {
			assert.deepStrictEqual(tic.ldesc, [
				'First long description line',
				'Second long description line'
			]);
		});

		it('should parse Size as an integer', function () {
			assert.strictEqual(tic.size, 12345);
		});

		it('should parse Date as an integer', function () {
			assert.strictEqual(tic.date, 1700000000);
		});

		it('should parse CRC in uppercase', function () {
			assert.strictEqual(tic.crc, 'AB12CD34');
		});

		it('should parse Origin field', function () {
			assert.strictEqual(tic.origin, '1:123/456');
		});

		it('should parse From field', function () {
			assert.strictEqual(tic.from, '1:123/456');
		});

		it('should parse To field', function () {
			assert.strictEqual(tic.to, '1:200/100');
		});

		it('should collect multiple Path lines into an array', function () {
			assert.strictEqual(tic.path.length, 2);
			assert.ok(tic.path[0].startsWith('1:100/0'));
			assert.ok(tic.path[1].startsWith('1:123/0'));
		});

		it('should collect multiple Seenby lines into an array', function () {
			assert.deepStrictEqual(tic.seenby, ['1:100/0', '1:123/0']);
		});

		it('should parse Pw field', function () {
			assert.strictEqual(tic.pw, 'secretpw');
		});

		it('should parse Magic field', function () {
			assert.strictEqual(tic.magic, 'TESTMAGIC');
		});
	});

	describe('minimal TIC (only required fields)', function () {
		it('should parse an area and file with defaults for everything else', function () {
			var tic = parseTicFile('Area MYAREA\r\nFile MYFILE.ZIP\r\n');
			assert.strictEqual(tic.area, 'MYAREA');
			assert.strictEqual(tic.file, 'MYFILE.ZIP');
			assert.strictEqual(tic.desc, '');
			assert.deepStrictEqual(tic.ldesc, []);
			assert.deepStrictEqual(tic.path, []);
			assert.deepStrictEqual(tic.seenby, []);
			assert.strictEqual(tic.size, 0);
			assert.strictEqual(tic.crc, '');
			assert.strictEqual(tic.pw, '');
		});
	});

	describe('line ending tolerance', function () {
		it('should handle LF-only line endings', function () {
			var tic = parseTicFile('Area LFAREA\nFile LF.ZIP\n');
			assert.strictEqual(tic.area, 'LFAREA');
			assert.strictEqual(tic.file, 'LF.ZIP');
		});

		it('should handle CRLF line endings', function () {
			var tic = parseTicFile('Area CRLFAREA\r\nFile CRLF.ZIP\r\n');
			assert.strictEqual(tic.area, 'CRLFAREA');
			assert.strictEqual(tic.file, 'CRLF.ZIP');
		});

		it('should handle CR-only line endings', function () {
			var tic = parseTicFile('Area CRAREA\rFile CR.ZIP\r');
			assert.strictEqual(tic.area, 'CRAREA');
			assert.strictEqual(tic.file, 'CR.ZIP');
		});
	});

	describe('case insensitivity of keys', function () {
		it('should parse lowercase "area" key', function () {
			var tic = parseTicFile('area LOWER\nfile lower.zip\n');
			assert.strictEqual(tic.area, 'LOWER');
			assert.strictEqual(tic.file, 'lower.zip');
		});

		it('should parse mixed-case keys (real-world variation)', function () {
			var tic = parseTicFile('Area MIXED\nFile Mixed.ZIP\nCrc DEADBEEF\n');
			assert.strictEqual(tic.area, 'MIXED');
			assert.strictEqual(tic.crc, 'DEADBEEF');
		});
	});

	describe('CRC normalisation', function () {
		it('should uppercase a lowercase CRC value', function () {
			var tic = parseTicFile('Area A\nFile f.zip\nCRC abcdef00\n');
			assert.strictEqual(tic.crc, 'ABCDEF00');
		});

		it('should uppercase a mixed-case CRC value', function () {
			var tic = parseTicFile('Area A\nFile f.zip\nCRC AbCdEf12\n');
			assert.strictEqual(tic.crc, 'ABCDEF12');
		});
	});

	describe('unknown keys', function () {
		it('should silently ignore unrecognised keys', function () {
			// Should not throw, and the known fields should still parse
			var tic = parseTicFile('Area IGTEST\nFile ig.zip\nXCustomVendorTag somevalue\n');
			assert.strictEqual(tic.area, 'IGTEST');
			assert.strictEqual(tic.file, 'ig.zip');
		});
	});

	describe('empty and blank input', function () {
		it('should return default-initialised object for empty string', function () {
			var tic = parseTicFile('');
			assert.strictEqual(tic.area, '');
			assert.strictEqual(tic.file, '');
			assert.deepStrictEqual(tic.ldesc, []);
		});

		it('should return default-initialised object for whitespace-only input', function () {
			var tic = parseTicFile('   \n   \n');
			assert.strictEqual(tic.area, '');
			assert.strictEqual(tic.file, '');
		});
	});

	describe('Replaces field', function () {
		it('should parse the Replaces field', function () {
			var tic = parseTicFile('Area A\nFile new.zip\nReplaces old.zip\n');
			assert.strictEqual(tic.replaces, 'old.zip');
		});
	});
});

// ---------------------------------------------------------------------------
// buildTicDescriptor
// ---------------------------------------------------------------------------

describe('buildTicDescriptor', function () {

	var MINIMAL_DATA = {
		area: 'TESTAREA',
		file: 'test.zip',
		replaces: '',
		desc: '',
		ldesc: [],
		size: 0,
		date: 0,
		crc: '',
		origin: '',
		from: '',
		to: '',
		path: [],
		seenby: [],
		pw: '',
		magic: ''
	};

	describe('required fields always present', function () {
		it('should always include Area line', function () {
			var out = buildTicDescriptor(MINIMAL_DATA);
			assert.ok(out.includes('Area TESTAREA'), 'Missing Area line');
		});

		it('should always include File line', function () {
			var out = buildTicDescriptor(MINIMAL_DATA);
			assert.ok(out.includes('File test.zip'), 'Missing File line');
		});

		it('should use CRLF line endings', function () {
			var out = buildTicDescriptor(MINIMAL_DATA);
			assert.ok(out.includes('\r\n'), 'Missing CRLF endings');
		});

		it('should end with a CRLF', function () {
			var out = buildTicDescriptor(MINIMAL_DATA);
			assert.ok(out.endsWith('\r\n'), 'Missing trailing CRLF');
		});
	});

	describe('optional fields omitted when empty/falsy', function () {
		it('should omit Replaces when empty', function () {
			var out = buildTicDescriptor(MINIMAL_DATA);
			assert.ok(!out.includes('Replaces'), 'Should not include empty Replaces');
		});

		it('should omit Desc when empty', function () {
			var out = buildTicDescriptor(MINIMAL_DATA);
			assert.ok(!out.includes('\r\nDesc '), 'Should not include empty Desc');
		});

		it('should omit Size when 0', function () {
			var out = buildTicDescriptor(MINIMAL_DATA);
			assert.ok(!out.includes('Size 0'), 'Should not include zero Size');
		});

		it('should omit Date when 0', function () {
			var out = buildTicDescriptor(MINIMAL_DATA);
			assert.ok(!out.includes('Date 0'), 'Should not include zero Date');
		});

		it('should omit CRC when empty', function () {
			var out = buildTicDescriptor(MINIMAL_DATA);
			assert.ok(!out.includes('\r\nCRC '), 'Should not include empty CRC');
		});

		it('should omit From when empty', function () {
			var out = buildTicDescriptor(MINIMAL_DATA);
			assert.ok(!out.includes('From '), 'Should not include empty From');
		});

		it('should omit Pw when empty', function () {
			var out = buildTicDescriptor(MINIMAL_DATA);
			assert.ok(!out.includes('Pw '), 'Should not include empty Pw');
		});
	});

	describe('optional fields included when populated', function () {
		it('should include Desc when set', function () {
			var data = Object.assign({}, MINIMAL_DATA, { desc: 'A fine file' });
			var out = buildTicDescriptor(data);
			assert.ok(out.includes('Desc A fine file'));
		});

		it('should include Size when non-zero', function () {
			var data = Object.assign({}, MINIMAL_DATA, { size: 99999 });
			var out = buildTicDescriptor(data);
			assert.ok(out.includes('Size 99999'));
		});

		it('should include Date when non-zero', function () {
			var data = Object.assign({}, MINIMAL_DATA, { date: 1700000000 });
			var out = buildTicDescriptor(data);
			assert.ok(out.includes('Date 1700000000'));
		});

		it('should include CRC when set', function () {
			var data = Object.assign({}, MINIMAL_DATA, { crc: 'DEADBEEF' });
			var out = buildTicDescriptor(data);
			assert.ok(out.includes('CRC DEADBEEF'));
		});

		it('should include Replaces when set', function () {
			var data = Object.assign({}, MINIMAL_DATA, { replaces: 'oldfile.zip' });
			var out = buildTicDescriptor(data);
			assert.ok(out.includes('Replaces oldfile.zip'));
		});

		it('should include Pw when set', function () {
			var data = Object.assign({}, MINIMAL_DATA, { pw: 'mypassword' });
			var out = buildTicDescriptor(data);
			assert.ok(out.includes('Pw mypassword'));
		});

		it('should include Magic when set', function () {
			var data = Object.assign({}, MINIMAL_DATA, { magic: 'LATEST' });
			var out = buildTicDescriptor(data);
			assert.ok(out.includes('Magic LATEST'));
		});
	});

	describe('multi-value fields', function () {
		it('should emit one LDesc line per ldesc array entry', function () {
			var data = Object.assign({}, MINIMAL_DATA, {
				ldesc: ['Line one', 'Line two', 'Line three']
			});
			var out = buildTicDescriptor(data);
			assert.ok(out.includes('LDesc Line one'));
			assert.ok(out.includes('LDesc Line two'));
			assert.ok(out.includes('LDesc Line three'));
		});

		it('should emit one Path line per path array entry', function () {
			var data = Object.assign({}, MINIMAL_DATA, {
				path: ['1:100/0 1699999000', '1:123/0 1699999500']
			});
			var out = buildTicDescriptor(data);
			assert.ok(out.includes('Path 1:100/0 1699999000'));
			assert.ok(out.includes('Path 1:123/0 1699999500'));
		});

		it('should emit one Seenby line per seenby array entry', function () {
			var data = Object.assign({}, MINIMAL_DATA, {
				seenby: ['1:100/0', '1:123/0', '1:200/100']
			});
			var out = buildTicDescriptor(data);
			assert.ok(out.includes('Seenby 1:100/0'));
			assert.ok(out.includes('Seenby 1:123/0'));
			assert.ok(out.includes('Seenby 1:200/100'));
		});
	});
});

// ---------------------------------------------------------------------------
// Round-trip: buildTicDescriptor → parseTicFile
// ---------------------------------------------------------------------------

describe('TIC round-trip (build then parse)', function () {

	var FULL_DATA = {
		area: 'ROUNDTRIP',
		file: 'round.zip',
		replaces: 'old.zip',
		desc: 'Round-trip test file',
		ldesc: ['Extended description line 1', 'Extended description line 2'],
		size: 54321,
		date: 1700000001,
		crc: 'CAFEBABE',
		origin: '1:123/456',
		from: '1:123/456',
		to: '1:200/100',
		path: ['1:100/0 1699000000', '1:123/0 1700000000'],
		seenby: ['1:100/0', '1:123/0'],
		pw: 'roundpw',
		magic: 'ROUNDMAGIC'
	};

	var tic;
	before(function () {
		var descriptor = buildTicDescriptor(FULL_DATA);
		tic = parseTicFile(descriptor);
	});

	it('area survives round-trip', function () {
		assert.strictEqual(tic.area, 'ROUNDTRIP');
	});

	it('file survives round-trip', function () {
		assert.strictEqual(tic.file, 'round.zip');
	});

	it('replaces survives round-trip', function () {
		assert.strictEqual(tic.replaces, 'old.zip');
	});

	it('desc survives round-trip', function () {
		assert.strictEqual(tic.desc, 'Round-trip test file');
	});

	it('ldesc array survives round-trip', function () {
		assert.deepStrictEqual(tic.ldesc, FULL_DATA.ldesc);
	});

	it('size survives round-trip', function () {
		assert.strictEqual(tic.size, 54321);
	});

	it('date survives round-trip', function () {
		assert.strictEqual(tic.date, 1700000001);
	});

	it('crc survives round-trip (uppercase)', function () {
		assert.strictEqual(tic.crc, 'CAFEBABE');
	});

	it('origin survives round-trip', function () {
		assert.strictEqual(tic.origin, '1:123/456');
	});

	it('from survives round-trip', function () {
		assert.strictEqual(tic.from, '1:123/456');
	});

	it('to survives round-trip', function () {
		assert.strictEqual(tic.to, '1:200/100');
	});

	it('path array survives round-trip', function () {
		assert.deepStrictEqual(tic.path, FULL_DATA.path);
	});

	it('seenby array survives round-trip', function () {
		assert.deepStrictEqual(tic.seenby, FULL_DATA.seenby);
	});

	it('pw survives round-trip', function () {
		assert.strictEqual(tic.pw, 'roundpw');
	});

	it('magic survives round-trip', function () {
		assert.strictEqual(tic.magic, 'ROUNDMAGIC');
	});
});
