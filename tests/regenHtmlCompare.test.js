// tests/regenHtmlCompare.test.js -- regenerating body_html counts and writes
// only what actually changes (#58), and --dry-run writes nothing.
//
// Before: every row with text counted as "updated" and was rewritten, so a
// dry run reported every message (COOKING: 28500 updated of 28500) and could
// not say what a regeneration would change; and the regen-html job never
// passed dryRun on, so `--regen-html --dry-run` rewrote the whole board.
//
// Uses a throwaway area table, mb_zz58test_msgs, in the dev database. The
// regen reads area tables by name and does not consult message_areas, so no
// area row is needed. Dropped in after().

import assert from 'assert';
import { dbAvailable } from './helpers/dbAvailable.js';

var TABLE = 'mb_zz58test_msgs';
var OLD_STAMP = '2001-01-01T00:00:00Z';

describe('regen body_html compares before writing (#58)', function () {
	this.timeout(20000);
	var available = false, postgres, messageBase, maintenanceJobs, formatBodyHtml;
	var ids = {};

	before(async function () {
		available = await dbAvailable();
		if (!available) return;
		postgres = await import('../src/middleware/db/postgres.js');
		messageBase = await import('../src/maintenance/messageBase.js');
		maintenanceJobs = await import('../src/maintenance/maintenanceJobs.js');
		formatBodyHtml = (await import('../src/utils/terminalText.js')).formatBodyHtml;
	});

	beforeEach(async function () {
		if (!available) return this.skip();
		await postgres.write('DROP TABLE IF EXISTS ' + TABLE);
		await postgres.write('CREATE TABLE ' + TABLE +
			' (id SERIAL PRIMARY KEY, body_text TEXT, body_html TEXT, updated_at TIMESTAMPTZ)');
		var current = await formatBodyHtml('Already right.\r');
		async function add(key, text, html) {
			var row = await postgres.queryOne('INSERT INTO ' + TABLE +
				' (body_text, body_html, updated_at) VALUES ($1, $2, $3) RETURNING id', [text, html, OLD_STAMP]);
			ids[key] = row.id;
		}
		await add('current', 'Already right.\r', current);
		await add('stale', 'Needs a new render.\r', '<p>old render</p>');
		await add('empty', '', null);
	});

	after(async function () {
		if (available) await postgres.write('DROP TABLE IF EXISTS ' + TABLE);
	});

	async function row(key) {
		return postgres.queryOne('SELECT body_html, updated_at FROM ' + TABLE + ' WHERE id = $1', [ids[key]]);
	}

	it('counts only the row whose HTML differs, and a dry run writes nothing', async function () {
		var r = await messageBase.regenerateAreaBodyHtml('ZZ58TEST', { dryRun: true, quiet: true });
		assert.strictEqual(r.processed, 3);
		assert.strictEqual(r.updated, 1);
		assert.strictEqual(r.unchanged, 1);
		assert.strictEqual(r.skipped, 1);
		assert.deepStrictEqual(r.sampleIds, [ids.stale]);
		assert.strictEqual((await row('stale')).body_html, '<p>old render</p>');
	});

	it('rewrites the stale row and leaves the current one untouched', async function () {
		var r = await messageBase.regenerateAreaBodyHtml('ZZ58TEST', { quiet: true });
		assert.strictEqual(r.updated, 1);
		assert.notStrictEqual((await row('stale')).body_html, '<p>old render</p>');
		assert.strictEqual(new Date((await row('current')).updated_at).toISOString(),
			new Date(OLD_STAMP).toISOString(), 'an unchanged row was rewritten');

		var again = await messageBase.regenerateAreaBodyHtml('ZZ58TEST', { quiet: true });
		assert.strictEqual(again.updated, 0, 'a second run should find nothing left to change');
	});

	it('passes --dry-run through the regen-html job', async function () {
		// The job used to drop dryRun, so the CLI's dry run was a real run.
		var result = null;
		var handled = await maintenanceJobs.runMaintenanceJob('regen-html',
			{ areas: ['ZZ58TEST'], dryRun: true },
			{ onResult: function (r) { result = r; } });
		assert.strictEqual(handled, true);
		assert.strictEqual((await row('stale')).body_html, '<p>old render</p>', 'the dry run wrote');
		assert.deepStrictEqual(result, {
			dryRun: true, processed: 3, updated: 1, unchanged: 1, skipped: 1, errors: 0,
			sampleIds: [ids.stale]
		});
	});

	it('stops at a batch boundary when its job is told to stop (#85)', async function () {
		var controller = new AbortController();
		controller.abort(new Error('limit'));
		await assert.rejects(
			messageBase.regenerateAreaBodyHtml('ZZ58TEST', { quiet: true, signal: controller.signal }),
			/limit/);
		assert.strictEqual((await row('stale')).body_html, '<p>old render</p>');
	});
});
