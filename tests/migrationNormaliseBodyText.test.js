// tests/migrationNormaliseBodyText.test.js — migration 0006 against a real
// database.
//
// This migration rewrites message bodies. It ran here over 4,707 rows and it
// will run unattended on boards nobody here can inspect, which is exactly why
// it needs more than "it did not throw".
//
// Three properties matter, and all three are ways it could go wrong quietly:
//
//   1. It rewrites the right rows. Too few and QWK messages stay raw; too many
//      and it overwrites FTN bodies with a redundant copy for no reason.
//   2. It finds tables by discovery, not by a list. Every board carries
//      different areas, so a hardcoded list would run clean and do NOTHING on
//      another system — a success report over an untouched database.
//   3. It is idempotent. The ledger runs it once, but a ledger row can be lost
//      or a sysop can invoke it directly, and a second pass must be harmless.
//
// The fixture is a real table, created and dropped here, because the migration
// reads information_schema to decide what to work on. A mock would test a
// different function than the one that ships.
//
// Note: because the migration discovers tables, running this also runs it
// against the real message tables. That is harmless — it is idempotent and
// they are already normalised, so it rewrites nothing — but it is worth
// knowing rather than discovering. Constraining it to the fixture would mean
// mocking information_schema, which would test a different function than the
// one that ships.
//
// Run: npx mocha --no-config --no-package tests/migrationNormaliseBodyText.test.js

import assert from 'assert';
import { dbAvailable } from './helpers/dbAvailable.js';

var FIXTURE = 'zz_test_normalise_msgs';

// CP437 0xDB is the full block; held as a latin-1 char it is U+00DB.
var RAW_BLOCK = 'Û';
var BLOCK     = '█';

describe('migration 0006 normalise-body-text', function () {
	this.timeout(60000);

	var available = false;
	var pg = null, migration = null;
	var log = [];

	before(async function () {
		available = await dbAvailable();
		if (!available) return;
		pg = await import('../src/middleware/db/postgres.js');
		migration = await import('../db/migrations/0006-normalise-body-text.js');

		await pg.write('DROP TABLE IF EXISTS ' + FIXTURE);
		await pg.write(
			'CREATE TABLE ' + FIXTURE + ' (' +
			'  id SERIAL PRIMARY KEY,' +
			'  body_text TEXT,' +
			'  utf8 TEXT' +
			')');
	});

	after(async function () {
		if (!pg) return;
		await pg.write('DROP TABLE IF EXISTS ' + FIXTURE);
	});

	beforeEach(async function () {
		if (!available) this.skip();
		log = [];
		await pg.write('TRUNCATE ' + FIXTURE);
	});

	async function seed(rows) {
		for (var r of rows) {
			await pg.write('INSERT INTO ' + FIXTURE + ' (body_text, utf8) VALUES ($1, $2)',
				[r.body_text, r.utf8]);
		}
	}

	async function run() {
		return migration.run({ postgres: pg, log: function (m) { log.push(m); } });
	}

	async function bodies() {
		var rows = await pg.query('SELECT id, body_text FROM ' + FIXTURE + ' ORDER BY id');
		return rows.map(function (r) { return r.body_text; });
	}

	it('rewrites a QWK-convention row from its decoded copy', async function () {
		// body_text holds raw bytes, utf8 holds the decoded text.
		await seed([{ body_text: RAW_BLOCK + RAW_BLOCK, utf8: BLOCK + BLOCK }]);
		await run();
		assert.deepStrictEqual(await bodies(), [BLOCK + BLOCK]);
	});

	it('leaves an FTN-convention row alone', async function () {
		// Both columns already hold the same text. Rewriting is a no-op that
		// would still cost a table scan and muddy the reported count.
		await seed([{ body_text: BLOCK, utf8: BLOCK }]);
		var result = await run();
		assert.deepStrictEqual(await bodies(), [BLOCK]);
		assert.strictEqual(result.rewritten, 0);
	});

	it('leaves an NNTP-convention row alone, where utf8 is null', async function () {
		await seed([{ body_text: BLOCK, utf8: null }]);
		var result = await run();
		assert.deepStrictEqual(await bodies(), [BLOCK]);
		assert.strictEqual(result.rewritten, 0);
	});

	it('ignores an empty utf8 rather than blanking the body', async function () {
		// The dangerous shape: a naive "utf8 IS NOT NULL" would replace real
		// text with an empty string and destroy the message.
		await seed([{ body_text: 'real content', utf8: '' }]);
		await run();
		assert.deepStrictEqual(await bodies(), ['real content']);
	});

	it('fills a null body_text from utf8', async function () {
		// IS DISTINCT FROM rather than <>, which evaluates NULL and skips it.
		await seed([{ body_text: null, utf8: BLOCK }]);
		await run();
		assert.deepStrictEqual(await bodies(), [BLOCK]);
	});

	it('rewrites only the divergent rows in a mixed table', async function () {
		await seed([
			{ body_text: RAW_BLOCK, utf8: BLOCK },      // QWK   -> rewrite
			{ body_text: BLOCK, utf8: BLOCK },          // FTN   -> leave
			{ body_text: 'plain', utf8: null },         // NNTP  -> leave
			{ body_text: RAW_BLOCK + 'x', utf8: BLOCK + 'x' }, // QWK -> rewrite
		]);
		var result = await run();
		assert.strictEqual(result.rewritten, 2, 'exactly the two divergent rows');
		assert.deepStrictEqual(await bodies(), [BLOCK, BLOCK, 'plain', BLOCK + 'x']);
	});

	it('is idempotent', async function () {
		// The ledger runs it once; this is what makes that a safeguard rather
		// than the only thing preventing a second pass.
		await seed([{ body_text: RAW_BLOCK, utf8: BLOCK }]);
		await run();
		var second = await run();
		assert.strictEqual(second.rewritten, 0);
		assert.deepStrictEqual(await bodies(), [BLOCK]);
	});

	it('discovers its tables instead of using a list', async function () {
		// The property that decides whether this works on someone else's
		// board. The fixture table did not exist when the migration was
		// written, and it still has to be found.
		await seed([{ body_text: RAW_BLOCK, utf8: BLOCK }]);
		var result = await run();

		assert.ok(result.tables >= 1, 'should have discovered tables');
		assert.ok(log.some(function (line) { return line.indexOf(FIXTURE) !== -1; }),
			'the fixture table should appear in the log: ' + JSON.stringify(log));
	});

	it('reports what it did, so an unattended run is auditable', async function () {
		await seed([{ body_text: RAW_BLOCK, utf8: BLOCK }]);
		var result = await run();
		assert.strictEqual(typeof result.tables, 'number');
		assert.strictEqual(typeof result.touched, 'number');
		assert.strictEqual(typeof result.rewritten, 'number');
		assert.ok(log.length > 0, 'a silent migration cannot be audited afterwards');
	});

	it('leaves the utf8 column intact, which is what makes it reversible', async function () {
		// The rewritten rows have no other copy of the decoded text.
		await seed([{ body_text: RAW_BLOCK, utf8: BLOCK }]);
		await run();
		var rows = await pg.query('SELECT utf8 FROM ' + FIXTURE);
		assert.strictEqual(rows[0].utf8, BLOCK);
	});
});
