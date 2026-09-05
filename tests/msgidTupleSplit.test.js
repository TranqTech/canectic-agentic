// tests/msgidTupleSplit.test.js — Guards the single definition of the MSGID split.
//
// MSGID is stored as a tuple: the serial in msg_id, the origin address in
// msg_orig_addr. Two places repair legacy rows that still hold the whole
// "address serial" string in msg_id — dbmigrations.js on every run, and
// maintenance.js --fix-msgids on demand — and they used to do it by different
// means. dbmigrations used SQL split_part, which diverges from
// ftnUtils.splitFullMsgid on any MSGID containing more than one space:
// split_part(msg_id, ' ', 2) returns only the middle token and silently drops
// the rest.
//
// Both now delegate to messageBase.fixLegacyMsgIds, which uses splitFullMsgid.
// This test pins that: every repaired row must match what splitFullMsgid would
// produce, including the multi-space case that exposed the divergence.
//
// Needs a database, so it skips cleanly without one. It creates a scratch
// per-area table and a matching message_areas row, then removes both.
// Run: npx mocha tests/msgidTupleSplit.test.js

import assert from 'assert';
import { dbAvailable } from './helpers/dbAvailable.js';

var SHORT = 'zzmsgidsplit';
var TABLE = 'mb_' + SHORT + '_msgs';

var available = false;
var pg = null;
var messageBase = null;
var splitFullMsgid = null;

// Shapes that exercise the interesting paths. The two-space entry is the one
// split_part got wrong.
var CASES = [
	'1:134/101 abcdef01',        // ordinary
	'21:1/100@fsxnet 6915d1e0',  // 5D domain in the address
	'1:2/3.5 00010203',          // point address
	'1:2/3 abcd ef01',           // two spaces: everything after the first is the serial
	'  1:134/101 abcdef01  ',    // surrounding whitespace
];

describe('MSGID tuple split', function () {
	this.timeout(30000);

	before(async function () {
		try {
			pg = await import('../src/middleware/db/postgres.js');
			messageBase = await import('../src/maintenance/messageBase.js');
			var ftnUtils = await import('../src/utils/ftnUtils.js');
			splitFullMsgid = ftnUtils.splitFullMsgid;

			// Shared bounded probe; see tests/helpers/dbAvailable.js.
			available = await dbAvailable();

			if (available) {
				await pg.pgpool.query('DROP TABLE IF EXISTS ' + TABLE);
				await pg.pgpool.query(
					'CREATE TABLE ' + TABLE + ' (id BIGSERIAL PRIMARY KEY, msg_id VARCHAR(255), ' +
					'msg_orig_addr VARCHAR(64), reply_to VARCHAR(255), reply_orig_addr VARCHAR(64))'
				);
				await pg.pgpool.query('DELETE FROM message_areas WHERE shortcode = $1', [SHORT.toUpperCase()]);
				await pg.pgpool.query(
					"INSERT INTO message_areas (shortcode, name, active) VALUES ($1, 'msgid split test', true)",
					[SHORT.toUpperCase()]
				);
				// Seed msg_id and reply_to with the same values so both columns
				// are exercised by the same repair pass.
				for (var c of CASES) {
					await pg.pgpool.query(
						'INSERT INTO ' + TABLE + ' (msg_id, reply_to) VALUES ($1, $1)', [c]
					);
				}
			}
		} catch (err) {
			available = false;
		}
	});

	after(async function () {
		if (!available || !pg) return;
		try {
			await pg.pgpool.query('DROP TABLE IF EXISTS ' + TABLE);
			await pg.pgpool.query('DELETE FROM message_areas WHERE shortcode = $1', [SHORT.toUpperCase()]);
		} catch (err) { /* best effort */ }
	});

	it('repairs every legacy row to match splitFullMsgid exactly', async function () {
		if (!available) return this.skip();

		await messageBase.fixLegacyMsgIds({ areas: [SHORT] });

		var rows = await pg.query(
			'SELECT id, msg_id, msg_orig_addr, reply_to, reply_orig_addr FROM ' + TABLE + ' ORDER BY id'
		);
		assert.strictEqual(rows.length, CASES.length);

		rows.forEach(function (r, i) {
			var want = splitFullMsgid(CASES[i]);
			assert.strictEqual(r.msg_id, want.msg_id,
				'msg_id for ' + JSON.stringify(CASES[i]));
			assert.strictEqual(r.msg_orig_addr || '', want.msg_orig_addr,
				'msg_orig_addr for ' + JSON.stringify(CASES[i]));
			assert.strictEqual(r.reply_to, want.msg_id,
				'reply_to for ' + JSON.stringify(CASES[i]));
			assert.strictEqual(r.reply_orig_addr || '', want.msg_orig_addr,
				'reply_orig_addr for ' + JSON.stringify(CASES[i]));
		});
	});

	it('keeps everything after the first space, where split_part would truncate', async function () {
		if (!available) return this.skip();

		// "1:2/3 abcd ef01" must become address "1:2/3" and serial "abcd ef01".
		// SQL split_part(msg_id, ' ', 2) would have yielded just "abcd".
		var row = await pg.queryOne(
			'SELECT msg_id, msg_orig_addr FROM ' + TABLE + " WHERE msg_orig_addr = '1:2/3'"
		);
		assert.ok(row, 'expected the two-space row to be present');
		assert.strictEqual(row.msg_id, 'abcd ef01',
			'serial was truncated; this is the split_part divergence returning');
	});

	it('is idempotent, so a second pass repairs nothing', async function () {
		if (!available) return this.skip();

		var totals = await messageBase.fixLegacyMsgIds({ areas: [SHORT] });
		assert.strictEqual(totals.msgidFixed, 0);
		assert.strictEqual(totals.replyFixed, 0);
	});

	it('reports what it would do without writing, in dry-run mode', async function () {
		if (!available) return this.skip();

		// Reintroduce one legacy row and confirm dry run leaves it alone.
		await pg.pgpool.query(
			'INSERT INTO ' + TABLE + ' (msg_id, reply_to) VALUES ($1, $1)', ['9:9/9 feedface']
		);

		var totals = await messageBase.fixLegacyMsgIds({ areas: [SHORT], dryRun: true });
		assert.ok(totals.scanned > 0, 'dry run should report rows it would touch');
		assert.strictEqual(totals.msgidFixed, 0, 'dry run must not write');

		var row = await pg.queryOne(
			'SELECT msg_id FROM ' + TABLE + " WHERE msg_id LIKE '9:9/9 %'"
		);
		assert.ok(row, 'the legacy row should still be unsplit after a dry run');
	});
});
