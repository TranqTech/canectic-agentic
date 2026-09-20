// tests/fileDupeCheck.test.js — the dupe check is a loop brake, not tidiness.
//
// A file that reads as new is imported AND hatched onward to every subscribed
// downlink. So in a mesh, a file the dupe check misses does not merely get
// stored twice: it circulates, and every system that misses it forwards it
// again.
//
// It missed two ways, and both were verified against a live board before being
// changed:
//
//   1. Filenames were compared case-sensitively. Chains rename, truncate and
//      uppercase — the same reason ftnReleaseSource treats a filename as a
//      hint — so LORD.ZIP came back past lord.zip with an identical checksum.
//   2. An exact name match was required even when the checksum matched, so any
//      rename at all defeated it.
//
// Size is part of the content match on purpose. CRC-32 alone is too weak to
// reject a file over: across ten thousand files in one area the chance of some
// pair colliding is around one percent, and a false dupe silently refuses a
// legitimate file. Identical CRC and identical size with different content is
// not something that happens by accident.
//
// Needs a database: the comparison is SQL, so asserting it anywhere else would
// test a reimplementation. Rows are created and removed here.
//
// Run: npx mocha --no-config --no-package tests/fileDupeCheck.test.js

import assert from 'assert';
import { dbAvailable } from './helpers/dbAvailable.js';

var AREA_ID = 999901;          // no such area; nothing else writes these rows
var CRC     = 'AB12CD34';
var SIZE    = 4096;

describe('fileEntries.checkDupe', function () {
	this.timeout(30000);

	var available = false;
	var pg = null, fileEntries = null;

	before(async function () {
		available = await dbAvailable();
		if (!available) return;
		pg = await import('../src/middleware/db/postgres.js');
		fileEntries = await import('../src/models/fileEntries.js');

		await pg.write('DELETE FROM file_entries WHERE area_id = $1', [AREA_ID]);
		await pg.write(
			'INSERT INTO file_entries (uuid, area_id, filename, disk_path, file_size, ' +
			' file_hash_crc32, active, created_at) ' +
			"VALUES ('zz-dupe-test', $1, $2, $2, $3, $4, true, NOW())",
			[AREA_ID, 'lord.zip', SIZE, CRC]);
	});

	after(async function () {
		if (!pg) return;
		await pg.write('DELETE FROM file_entries WHERE area_id = $1', [AREA_ID]);
	});

	beforeEach(function () { if (!available) this.skip(); });

	it('matches the exact filename and checksum', async function () {
		assert.strictEqual(await fileEntries.checkDupe(AREA_ID, 'lord.zip', CRC, SIZE), true);
	});

	it('matches a filename a chain has uppercased', async function () {
		// The regression, measured on a live board before the fix: stored
		// "lord (jsdoor).zip", offered "LORD (JSDOOR).ZIP" with an identical
		// CRC, answer was "not a dupe" — so it re-imported and re-hatched.
		assert.strictEqual(await fileEntries.checkDupe(AREA_ID, 'LORD.ZIP', CRC, SIZE), true);
		assert.strictEqual(await fileEntries.checkDupe(AREA_ID, 'Lord.Zip', CRC, SIZE), true);
	});

	it('matches the same content under a completely different name', async function () {
		// A chain that truncates or renames must not defeat the brake.
		assert.strictEqual(await fileEntries.checkDupe(AREA_ID, 'RENAMED.ZIP', CRC, SIZE), true);
	});

	it('refuses to call it a dupe on checksum alone', async function () {
		// Without a size to corroborate it, a CRC-32 match is not enough to
		// reject a file over. Conservative: treat it as new.
		assert.strictEqual(await fileEntries.checkDupe(AREA_ID, 'RENAMED.ZIP', CRC), false);
	});

	it('treats a matching checksum with a different size as a different file', async function () {
		// That is what a CRC-32 collision looks like, and the cost of getting
		// it wrong is a legitimate file silently refused.
		assert.strictEqual(await fileEntries.checkDupe(AREA_ID, 'OTHER.ZIP', CRC, 12345), false);
	});

	it('does not match a genuinely different file', async function () {
		assert.strictEqual(await fileEntries.checkDupe(AREA_ID, 'OTHER.ZIP', 'DEADBEEF', 555), false);
	});

	it('does not match across areas', async function () {
		// Areas carry the same filenames routinely; a cross-area match would
		// refuse every file that shares a name with one elsewhere.
		assert.strictEqual(await fileEntries.checkDupe(AREA_ID + 1, 'lord.zip', CRC, SIZE), false);
	});

	it('falls back to a case-insensitive name match with no checksum', async function () {
		// Some TIC files omit the CRC. The name is all there is.
		assert.strictEqual(await fileEntries.checkDupe(AREA_ID, 'LORD.ZIP'), true);
		assert.strictEqual(await fileEntries.checkDupe(AREA_ID, 'nosuch.zip'), false);
	});

	it('still counts a deactivated entry as seen', async function () {
		// A file deactivated by a Replaces has been here. Forgetting it would
		// let the chain send it round again.
		await pg.write('UPDATE file_entries SET active = false WHERE area_id = $1', [AREA_ID]);
		try {
			assert.strictEqual(await fileEntries.checkDupe(AREA_ID, 'lord.zip', CRC, SIZE), true);
		} finally {
			await pg.write('UPDATE file_entries SET active = true WHERE area_id = $1', [AREA_ID]);
		}
	});
});
