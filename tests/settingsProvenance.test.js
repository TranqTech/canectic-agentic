// tests/settingsProvenance.test.js: telling a setting a sysop chose from one
// that was merely seeded.
//
// configStore seeds every default from configDefaults into the settings table on
// first run, so a row exists for every key whether or not anyone touched it.
// Two things followed from that.
//
// A config key could not be deprecated in place. allow_netmail_relay is the
// case that forced this: honouring a stored false would have pinned every
// upgrade to the old behaviour, and honouring true would have switched relay on
// for someone who had turned it off, and there was no way to tell those apart.
// (That decision is not reopened here. It was settled on separate grounds:
// relay was broken before 351114b, so there was no working configuration to
// preserve. This is for the next deprecation.)
//
// And the admin badge lied. Reporting 'db' for any row that exists meant
// essentially every key claimed to come from the database, including the ones
// still sitting at exactly what the release shipped.
//
// Run: npx mocha

import assert from 'assert';
import { dbAvailable } from './helpers/dbAvailable.js';
import { sourceForStoredValue } from '../src/config/appConfig.js';

describe('sourceForStoredValue', function () {

	it('reports the database when a sysop set it', function () {
		assert.strictEqual(sourceForStoredValue({ value: 'x', source: 'sysop' }, 'x'), 'db');
	});

	it('reports the default for a seeded row still at the shipped value', function () {
		// The case that was wrong. This row exists only because the seed put it
		// there, and nobody has touched it.
		assert.strictEqual(sourceForStoredValue({ value: 'x', source: 'default' }, 'x'), 'default');
	});

	it('reports the database for a seeded row whose default has since changed', function () {
		// A stale seeded value is still what takes effect, so calling it the
		// default would be wrong in the other direction: the sysop would be
		// told they are running the shipped value when they are not.
		assert.strictEqual(sourceForStoredValue({ value: '10', source: 'default' }, '20'), 'db');
	});

	it('compares as strings, since settings values are text', function () {
		assert.strictEqual(sourceForStoredValue({ value: '20', source: 'default' }, 20), 'default');
		assert.strictEqual(sourceForStoredValue({ value: 'true', source: 'default' }, true), 'default');
	});

	it('treats a missing row as the default', function () {
		assert.strictEqual(sourceForStoredValue(null, 'x'), 'default');
		assert.strictEqual(sourceForStoredValue(undefined, 'x'), 'default');
	});

	it('treats a row with no source recorded as seeded unless the value differs', function () {
		// Rows written before the column existed, if the backfill has not run.
		assert.strictEqual(sourceForStoredValue({ value: 'x' }, 'x'), 'default');
		assert.strictEqual(sourceForStoredValue({ value: 'y' }, 'x'), 'db');
	});
});

describe('settings provenance against a database', function () {
	this.timeout(30000);

	var available = false;
	var pg = null, configStore = null;
	var KEY = 'zz_test_provenance_key';

	before(async function () {
		this.timeout(20000);
		available = await dbAvailable();
		if (!available) return;
		pg = await import('../src/middleware/db/postgres.js');
		configStore = await import('../src/models/configStore.js');
	});

	beforeEach(async function () {
		if (!available) return this.skip();
		await pg.write('DELETE FROM settings WHERE key LIKE $1', ['zz_test_provenance%']);
	});

	after(async function () {
		if (!available || !pg) return;
		try { await pg.write('DELETE FROM settings WHERE key LIKE $1', ['zz_test_provenance%']); } catch (_) {}
		try { configStore.shutdown(); } catch (_) {}
	});

	async function sourceOf(key) {
		var row = await pg.queryOne('SELECT source FROM settings WHERE key = $1', [key]);
		return row ? row.source : null;
	}

	it('stamps a seeded key as default', async function () {
		await configStore.seedDefaults([{
			key: KEY, defaultValue: 'seeded', type: 'string',
			category: 'system', description: 'test'
		}]);
		assert.strictEqual(await sourceOf(KEY), 'default');
	});

	it('stamps a key written through setValue as sysop', async function () {
		await configStore.setValue(KEY, 'chosen');
		assert.strictEqual(await sourceOf(KEY), 'sysop');
	});

	it('promotes a seeded key to sysop when it is written', async function () {
		// The transition that matters: the row already exists, so the write is
		// an update, and the provenance has to move with it.
		await configStore.seedDefaults([{
			key: KEY, defaultValue: 'seeded', type: 'string',
			category: 'system', description: 'test'
		}]);
		assert.strictEqual(await sourceOf(KEY), 'default');

		await configStore.setValue(KEY, 'chosen');
		assert.strictEqual(await sourceOf(KEY), 'sysop');
	});

	it('does not demote a sysop key when the seed runs again', async function () {
		// Seeding happens on every startup. If it reset provenance, the answer
		// would survive exactly until the next restart.
		await configStore.setValue(KEY, 'chosen');
		await configStore.seedDefaults([{
			key: KEY, defaultValue: 'seeded', type: 'string',
			category: 'system', description: 'test'
		}]);
		assert.strictEqual(await sourceOf(KEY), 'sysop');
		var row = await pg.queryOne('SELECT value FROM settings WHERE key = $1', [KEY]);
		assert.strictEqual(row.value, 'chosen', 'the seed must not overwrite a chosen value either');
	});

	it('stamps a batch write as sysop', async function () {
		await configStore.setValues([{ key: KEY, value: 'batched' }]);
		assert.strictEqual(await sourceOf(KEY), 'sysop');
	});

	it('wasSetBySysop answers the question the table could not', async function () {
		assert.strictEqual(await configStore.wasSetBySysop(KEY), false,
			'a key with no row was never set');

		await configStore.seedDefaults([{
			key: KEY, defaultValue: 'seeded', type: 'string',
			category: 'system', description: 'test'
		}]);
		assert.strictEqual(await configStore.wasSetBySysop(KEY), false,
			'a seeded row is not a choice');

		await configStore.setValue(KEY, 'chosen');
		assert.strictEqual(await configStore.wasSetBySysop(KEY), true);
	});

	it('deleting a key removes its provenance with it', async function () {
		// Reset to default deletes the row, which is the right shape: there is
		// no stored value left to have an opinion about.
		await configStore.setValue(KEY, 'chosen');
		await configStore.deleteSetting(KEY);
		assert.strictEqual(await configStore.wasSetBySysop(KEY), false);
		assert.strictEqual(await sourceOf(KEY), null);
	});
});
