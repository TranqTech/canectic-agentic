// tests/tableColumns.test.js: reading a table's columns once rather than once
// per column.
//
// checkOrCreateTable asked information_schema whether each column existed, one
// round trip each. A message area has two backing tables of roughly 28 columns,
// so maintaining one area cost about 114 queries. Measured on the development
// box: 6.9 seconds for 31 areas, on every dbmigrations run and every process
// that calls it, almost always to discover there was nothing to do. Issue #43.
//
// The risk in batching it is that this path runs at startup and during
// migrations, where a wrong answer is not a slow update but a broken schema. So
// what is pinned here is equivalence, not speed: a missing column is still
// added, a removed column is still dropped, a current table is still left
// alone, and a table that does not exist is still created.
//
// The pure rules are covered without a database. The equivalence cases need one
// and skip cleanly without it.
//
// Run: npx mocha

import assert from 'assert';
import { dbAvailable } from './helpers/dbAvailable.js';
import {
	getTableColumns, columnNameFromDefinition, checkOrCreateTable, checkTable, dropTable
} from '../src/middleware/db/tableTools.js';
import { legacyColumnsNeedingWidening, LEGACY_TEXT_COLUMNS } from '../src/models/messageMaint.js';

var TABLE = 'zz_test_tablecolumns';

describe('columnNameFromDefinition', function () {

	it('takes the name off an ordinary definition', function () {
		assert.strictEqual(columnNameFromDefinition('seen_by TEXT'), 'seen_by');
		assert.strictEqual(columnNameFromDefinition('max_age_days INTEGER'), 'max_age_days');
	});

	it('keeps only the name when the definition carries a default', function () {
		assert.strictEqual(columnNameFromDefinition('imported BOOLEAN DEFAULT false'), 'imported');
		assert.strictEqual(columnNameFromDefinition('id BIGSERIAL PRIMARY KEY'), 'id');
	});

	it('handles a tab between name and type', function () {
		// The previous form split on a single literal space, so a tab returned
		// the whole line and stripping whitespace from it produced "seen_byTEXT":
		// a name that can never match an existing column and can never be added.
		// Every run would try again and fail, silently.
		assert.strictEqual(columnNameFromDefinition('seen_by\tTEXT'), 'seen_by');
	});

	it('handles leading whitespace', function () {
		// This previously produced an empty name, and an empty name was skipped
		// without comment, so the column was never added at all.
		assert.strictEqual(columnNameFromDefinition('  seen_by TEXT'), 'seen_by');
	});

	it('collapses runs of whitespace rather than returning an empty name', function () {
		assert.strictEqual(columnNameFromDefinition('seen_by    TEXT'), 'seen_by');
	});

	it('returns empty for input that names nothing', function () {
		assert.strictEqual(columnNameFromDefinition(''), '');
		assert.strictEqual(columnNameFromDefinition('   '), '');
		assert.strictEqual(columnNameFromDefinition(null), '');
		assert.strictEqual(columnNameFromDefinition(undefined), '');
	});
});

describe('legacyColumnsNeedingWidening', function () {

	function cols(entries) {
		var m = new Map();
		for (var k of Object.keys(entries)) m.set(k, { name: k, dataType: entries[k] });
		return m;
	}

	it('reports a column still stored as varchar', function () {
		var out = legacyColumnsNeedingWidening(cols({ seen_by: 'character varying', path: 'text' }));
		assert.deepStrictEqual(out, ['seen_by']);
	});

	it('reports nothing when both are already text', function () {
		// This is the overwhelmingly common case, and the reason the old
		// unconditional pair of ALTER TABLE statements was pure waste: two
		// ACCESS EXCLUSIVE locks per area per run to change nothing.
		var out = legacyColumnsNeedingWidening(cols({ seen_by: 'text', path: 'text' }));
		assert.deepStrictEqual(out, []);
	});

	it('reports nothing for a column that is absent', function () {
		// Absent means checkOrCreateTable is adding it from the template, which
		// says TEXT, so widening it afterwards would be pointless.
		assert.deepStrictEqual(legacyColumnsNeedingWidening(cols({})), []);
	});

	it('survives a missing map', function () {
		assert.deepStrictEqual(legacyColumnsNeedingWidening(null), []);
		assert.deepStrictEqual(legacyColumnsNeedingWidening(undefined), []);
	});

	it('covers every column named in the constant', function () {
		var all = {};
		for (var name of LEGACY_TEXT_COLUMNS) all[name] = 'character varying';
		assert.deepStrictEqual(legacyColumnsNeedingWidening(cols(all)), LEGACY_TEXT_COLUMNS);
	});
});

describe('getTableColumns and checkOrCreateTable against a database', function () {
	this.timeout(30000);

	var available = false;

	before(async function () {
		this.timeout(20000);
		available = await dbAvailable();
		if (!available) return;
		await dropTable(TABLE);
	});

	beforeEach(async function () {
		if (!available) return this.skip();
		await dropTable(TABLE);
	});

	after(async function () {
		if (!available) return;
		try { await dropTable(TABLE); } catch (_) {}
	});

	it('returns an empty map for a table that does not exist', async function () {
		var cols = await getTableColumns(TABLE);
		assert.ok(cols instanceof Map);
		assert.strictEqual(cols.size, 0);
	});

	it('returns every column with its type', async function () {
		await checkOrCreateTable(TABLE, ['id BIGSERIAL PRIMARY KEY', 'seen_by VARCHAR(255)', 'body TEXT'], []);

		var cols = await getTableColumns(TABLE);
		assert.deepStrictEqual(Array.from(cols.keys()).sort(), ['body', 'id', 'seen_by']);
		assert.strictEqual(cols.get('seen_by').dataType, 'character varying');
		assert.strictEqual(cols.get('seen_by').maxLength, 255);
		assert.strictEqual(cols.get('body').dataType, 'text');
	});

	it('creates a table that does not exist and says so', async function () {
		assert.strictEqual(await checkTable(TABLE), false);

		var info = await checkOrCreateTable(TABLE, ['id BIGSERIAL PRIMARY KEY', 'name TEXT'], []);

		assert.strictEqual(info.existed, false);
		assert.strictEqual(info.created, true);
		assert.strictEqual(await checkTable(TABLE), true);
	});

	it('adds a column the table is missing', async function () {
		await checkOrCreateTable(TABLE, ['id BIGSERIAL PRIMARY KEY'], []);

		var info = await checkOrCreateTable(TABLE,
			['id BIGSERIAL PRIMARY KEY', 'added_later INTEGER DEFAULT 0'], []);

		assert.strictEqual(info.existed, true);
		assert.strictEqual(info.added, 1);
		var cols = await getTableColumns(TABLE);
		assert.ok(cols.has('added_later'), 'the missing column was not added');
	});

	it('drops a column listed for removal', async function () {
		await checkOrCreateTable(TABLE, ['id BIGSERIAL PRIMARY KEY', 'obsolete TEXT'], []);

		var info = await checkOrCreateTable(TABLE, ['id BIGSERIAL PRIMARY KEY'], ['obsolete']);

		assert.strictEqual(info.dropped, 1);
		var cols = await getTableColumns(TABLE);
		assert.ok(!cols.has('obsolete'), 'the removed column is still there');
	});

	it('does nothing to a table that is already current', async function () {
		var defs = ['id BIGSERIAL PRIMARY KEY', 'name TEXT', 'count INTEGER'];
		await checkOrCreateTable(TABLE, defs, []);

		var info = await checkOrCreateTable(TABLE, defs, []);

		assert.strictEqual(info.existed, true);
		assert.strictEqual(info.added, 0);
		assert.strictEqual(info.dropped, 0);
	});

	it('does not try to re-add a column whose definition is capitalised', async function () {
		// Postgres folds an unquoted identifier, so `MixedCase TEXT` creates a
		// column named `mixedcase`. The exact-match check this replaced would
		// never find it again: every run would emit ADD COLUMN MixedCase and
		// fail, for ever, reported only as an error line nobody reads.
		await checkOrCreateTable(TABLE, ['id BIGSERIAL PRIMARY KEY', 'MixedCase TEXT'], []);

		var cols = await getTableColumns(TABLE);
		assert.ok(cols.has('mixedcase'), 'Postgres should have folded the name');

		var info = await checkOrCreateTable(TABLE, ['id BIGSERIAL PRIMARY KEY', 'MixedCase TEXT'], []);
		assert.strictEqual(info.added, 0, 'a folded column was reported as missing');
	});

	it('drops a column listed for removal under a different case', async function () {
		await checkOrCreateTable(TABLE, ['id BIGSERIAL PRIMARY KEY', 'obsolete TEXT'], []);

		var info = await checkOrCreateTable(TABLE, ['id BIGSERIAL PRIMARY KEY'], ['OBSOLETE']);

		assert.strictEqual(info.dropped, 1);
		assert.ok(!(await getTableColumns(TABLE)).has('obsolete'));
	});

	it('reports the columns as they were before its own alterations', async function () {
		// messageMaint decides whether to widen seen_by from this map, so it has
		// to describe the table on arrival. A map refreshed after the ALTERs
		// would cost the second read this change exists to remove.
		await checkOrCreateTable(TABLE, ['id BIGSERIAL PRIMARY KEY'], []);

		var info = await checkOrCreateTable(TABLE, ['id BIGSERIAL PRIMARY KEY', 'fresh TEXT'], []);

		assert.strictEqual(info.added, 1);
		assert.ok(!info.columns.has('fresh'),
			'the returned map should describe the table before this call altered it');
	});
});
