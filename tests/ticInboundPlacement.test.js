// tests/ticInboundPlacement.test.js — where an inbound file echo file lands,
// and who it is forwarded to.
//
// placeInboundFile: a file that Replaces one of the same name (an infopack
// re-released under its own name, NODELIST.Z68 a year after the last) used to
// collide with the replaced file, which Replaces deactivated in the database
// but left on disk. The new one was saved as NAME_1.EXT and recorded under
// that name, the next release's Replaces could not find it, and the area
// filled with active _1, _2, _3 copies.
//
// forwardExclusions: the systems a file has been to or through were compared
// as raw strings, so a downlink written with a 5D domain or a .0 point suffix
// did not match its own connection and was sent the file again.
//
// replacesPattern: Replaces may use DOS wildcards (`Replaces NODELIST.*`), and
// only an exact name used to match, so a wildcard replaced nothing.
//
// placeInboundFile touches only a temp directory; forwardExclusions and
// replacesPattern are pure, and the wildcard patterns are also run through
// Postgres's own ILIKE when a database is available.
// Run: npx mocha --no-config --exit tests/ticInboundPlacement.test.js

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { placeInboundFile, forwardExclusions, replacesPattern } from '../src/middleware/tossers/ticTosser.js';
import { dbAvailable } from './helpers/dbAvailable.js';

describe('placeInboundFile', function () {
	var root, inDir, areaDir;

	beforeEach(function () {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-ticplace-'));
		inDir = path.join(root, 'in');
		areaDir = path.join(root, 'area');
		fs.mkdirSync(inDir);
		fs.mkdirSync(areaDir);
	});
	afterEach(function () {
		fs.rmSync(root, { recursive: true, force: true });
	});

	function receive(name, content) {
		var p = path.join(inDir, name);
		fs.writeFileSync(p, content);
		return p;
	}
	function areaFiles() {
		return fs.readdirSync(areaDir).sort();
	}

	it('files a new file under its own name', async function () {
		var placed = await placeInboundFile({ sourcePath: receive('NEW.ZIP', 'new'), areaPath: areaDir, filename: 'NEW.ZIP' });
		await placed.commit();
		assert.strictEqual(path.basename(placed.destFilePath), 'NEW.ZIP');
		assert.strictEqual(placed.renamed, false);
		assert.deepStrictEqual(areaFiles(), ['NEW.ZIP']);
	});

	it('takes the name of the same-name file it replaces, not NAME_1', async function () {
		fs.writeFileSync(path.join(areaDir, 'FSXINFO.ZIP'), 'old release');
		var placed = await placeInboundFile({
			sourcePath: receive('FSXINFO.ZIP', 'new release'),
			areaPath: areaDir, filename: 'FSXINFO.ZIP',
			replaced: [{ disk_path: 'FSXINFO.ZIP' }]
		});
		assert.strictEqual(path.basename(placed.destFilePath), 'FSXINFO.ZIP');
		assert.strictEqual(placed.renamed, false);
		await placed.commit();
		assert.deepStrictEqual(areaFiles(), ['FSXINFO.ZIP'], 'the replaced file is gone, no _1 copy');
		assert.strictEqual(fs.readFileSync(path.join(areaDir, 'FSXINFO.ZIP'), 'utf8'), 'new release');
	});

	it('removes a replaced file of a different name on commit', async function () {
		fs.writeFileSync(path.join(areaDir, 'TOOL100.ZIP'), 'v1.00');
		var placed = await placeInboundFile({
			sourcePath: receive('TOOL110.ZIP', 'v1.10'),
			areaPath: areaDir, filename: 'TOOL110.ZIP',
			replaced: [{ disk_path: 'TOOL100.ZIP' }]
		});
		await placed.commit();
		assert.deepStrictEqual(areaFiles(), ['TOOL110.ZIP']);
	});

	it('still renames when the same name exists and is NOT being replaced', async function () {
		// A different file that happens to share a name must not be overwritten.
		fs.writeFileSync(path.join(areaDir, 'README.TXT'), 'someone else');
		var placed = await placeInboundFile({ sourcePath: receive('README.TXT', 'mine'), areaPath: areaDir, filename: 'README.TXT' });
		await placed.commit();
		assert.strictEqual(placed.renamed, true);
		assert.deepStrictEqual(areaFiles(), ['README.TXT', 'README_1.TXT']);
		assert.strictEqual(fs.readFileSync(path.join(areaDir, 'README.TXT'), 'utf8'), 'someone else');
	});

	it('keeps the replaced file until commit, and restores everything on rollback', async function () {
		fs.writeFileSync(path.join(areaDir, 'NODELIST.Z68'), 'last year');
		var src = receive('NODELIST.Z68', 'this year');
		var placed = await placeInboundFile({
			sourcePath: src, areaPath: areaDir, filename: 'NODELIST.Z68',
			replaced: [{ disk_path: 'NODELIST.Z68' }]
		});
		// Before commit the old copy still exists, set aside.
		assert.strictEqual(fs.readdirSync(areaDir).length, 2);

		await placed.rollback();
		assert.deepStrictEqual(areaFiles(), ['NODELIST.Z68']);
		assert.strictEqual(fs.readFileSync(path.join(areaDir, 'NODELIST.Z68'), 'utf8'), 'last year');
		assert.strictEqual(fs.readFileSync(src, 'utf8'), 'this year', 'the received file is back where it came from');
	});

	it('ignores a replaced entry whose file is already gone', async function () {
		var placed = await placeInboundFile({
			sourcePath: receive('A.ZIP', 'a'), areaPath: areaDir, filename: 'A.ZIP',
			replaced: [{ disk_path: 'MISSING.ZIP' }, null, {}]
		});
		await placed.commit();
		assert.deepStrictEqual(areaFiles(), ['A.ZIP']);
	});
});

describe('forwardExclusions', function () {

	it('covers Seenby, Path and From', function () {
		var ex = forwardExclusions({ seenby: ['1:1/1'], path: ['1:2/2 1700000000'], from: '1:3/3' });
		assert.deepStrictEqual([...ex].sort(), ['1:1/1', '1:2/2', '1:3/3']);
	});

	it('matches a Path entry written with a domain and a BBBS-style stamp', function () {
		// From the TIC 1:153/757 sent the hub on 2026-09-25.
		var ex = forwardExclusions({
			seenby: [],
			path: ['1:229/426@fidonet 1790308981 FRI SEP 25 00:03:01 2026 UTC-0400  53C1F788',
				'1:153/757.0 @260924211200 PDT+7'],
			from: ''
		});
		assert.ok(ex.has('1:229/426'), 'domain stripped');
		assert.ok(ex.has('1:153/757'), '.0 stripped');
	});

	it('keeps a real point distinct from its boss', function () {
		var ex = forwardExclusions({ seenby: ['1:153/757.3'], path: [], from: '' });
		assert.ok(ex.has('1:153/757.3'));
		assert.ok(!ex.has('1:153/757'));
	});

	it('survives a TIC with nothing in it', function () {
		assert.strictEqual(forwardExclusions({}).size, 0);
		assert.strictEqual(forwardExclusions(null).size, 0);
	});
});

describe('replacesPattern', function () {

	it('matches a plain name exactly', function () {
		assert.deepStrictEqual(replacesPattern('NODELIST.Z68'), { kind: 'exact', name: 'NODELIST.Z68' });
	});

	it('turns DOS wildcards into an ILIKE pattern', function () {
		assert.deepStrictEqual(replacesPattern('NODELIST.*'), { kind: 'wildcard', like: 'NODELIST.%' });
		assert.deepStrictEqual(replacesPattern('Z1DAILY.Z??'), { kind: 'wildcard', like: 'Z1DAILY.Z__' });
	});

	it('escapes the characters ILIKE would treat as wildcards', function () {
		// FSX_INFO.* must not match FSXAINFO.ZIP through an unescaped _.
		assert.deepStrictEqual(replacesPattern('FSX_INF%.*'), { kind: 'wildcard', like: 'FSX\\_INF\\%.%' });
	});

	it('refuses a wildcard that could match a whole area', function () {
		// Replaces deletes what it matches.
		for (var p of ['*', '*.*', '*.ZIP', '?ODELIST.*', '.*']) {
			assert.strictEqual(replacesPattern(p).kind, 'refused', p);
		}
	});

	it('refuses a path', function () {
		assert.strictEqual(replacesPattern('../etc/passwd').kind, 'refused');
		assert.strictEqual(replacesPattern('DIR\\FILE.ZIP').kind, 'refused');
	});

	it('refuses an empty Replaces', function () {
		assert.strictEqual(replacesPattern('   ').kind, 'refused');
	});

	describe('against Postgres ILIKE', function () {
		var pg = null;
		before(async function () {
			if (!(await dbAvailable())) return this.skip();
			pg = await import('../src/middleware/db/postgres.js');
		});

		async function matches(name, pattern) {
			var row = await pg.queryOne("SELECT $1::text ILIKE $2 ESCAPE '\\' AS m", [name, replacesPattern(pattern).like]);
			return row.m;
		}

		it('matches what the wildcard names and nothing else', async function () {
			assert.strictEqual(await matches('NODELIST.Z61', 'NODELIST.*'), true);
			assert.strictEqual(await matches('nodelist.z61', 'NODELIST.*'), true, 'case insensitive');
			assert.strictEqual(await matches('NODEDIFF.A61', 'NODELIST.*'), false);
			assert.strictEqual(await matches('Z1DAILY.Z68', 'Z1DAILY.Z??'), true);
			assert.strictEqual(await matches('Z1DAILY.Z6', 'Z1DAILY.Z??'), false, '? is exactly one character');
		});

		it('treats _ and % in the name literally', async function () {
			assert.strictEqual(await matches('FSX_INFO.ZIP', 'FSX_INFO.*'), true);
			assert.strictEqual(await matches('FSXAINFO.ZIP', 'FSX_INFO.*'), false);
		});
	});
});
