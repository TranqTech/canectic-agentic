// tests/migrationLedger.test.js: ordered, recorded, one-shot migrations.
//
// The declarative schema in db/schema converges: run it on anything and it ends
// up the right shape. That is why it cannot express an event. "Renumber every
// QWK conference once" is not a shape, and asking a converging system to perform
// an event produced four different answers in this codebase: schema sniffing in
// migrateMenuLayout, a marker row in settings for the MSGID split, nothing at
// all for qwkConfRenumber, and an unanswerable question for allow_netmail_relay.
//
// What is pinned here is the part that decides, because getting it wrong does
// not fail loudly. A migration considered twice may corrupt data it already
// repaired; one considered never leaves a system quietly broken; and a fresh
// database wrongly treated as an existing one runs repairs against a schema that
// was born correct.
//
// The rules are pure and need no database. The ledger round trip needs one and
// skips cleanly without it.
//
// Run: npx mocha

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dbAvailable } from './helpers/dbAvailable.js';
import * as ledger from '../src/maintenance/migrationLedger.js';

var here = path.dirname(fileURLToPath(import.meta.url));
var migrationsDir = path.join(here, '..', 'db', 'migrations');

function fake(id, over) {
	var parsed = ledger.parseMigrationId(id);
	return Object.assign({
		id: parsed.id, sequence: parsed.sequence, slug: parsed.slug,
		file: id + '.js', description: 'test', phase: ledger.PHASE_POST,
		automatic: true, instructions: null, isNeeded: null,
		run: async function () {}
	}, over || {});
}

describe('parseMigrationId', function () {

	it('accepts NNNN-slug', function () {
		var p = ledger.parseMigrationId('0001-menu-layout.js');
		assert.strictEqual(p.id, '0001-menu-layout');
		assert.strictEqual(p.sequence, 1);
		assert.strictEqual(p.slug, 'menu-layout');
	});

	it('works with or without the extension', function () {
		assert.strictEqual(ledger.parseMigrationId('0002-msgid-tuple-split').id, '0002-msgid-tuple-split');
	});

	it('rejects a name it cannot order', function () {
		// Ordering is the entire contract of this directory. A file that cannot
		// be ordered has to stop the run rather than land arbitrarily first or
		// last, which is why these are null rather than best-effort.
		assert.strictEqual(ledger.parseMigrationId('menu-layout.js'), null);
		assert.strictEqual(ledger.parseMigrationId('1-menu-layout.js'), null);
		assert.strictEqual(ledger.parseMigrationId('0001_menu_layout.js'), null);
		assert.strictEqual(ledger.parseMigrationId('0001-Menu-Layout.js'), null);
		assert.strictEqual(ledger.parseMigrationId(''), null);
		assert.strictEqual(ledger.parseMigrationId(null), null);
	});
});

describe('sortMigrations', function () {

	it('orders by the numeric prefix', function () {
		var out = ledger.sortMigrations([fake('0003-c'), fake('0001-a'), fake('0002-b')]);
		assert.deepStrictEqual(out.map(function (m) { return m.id; }),
			['0001-a', '0002-b', '0003-c']);
	});

	it('orders numerically rather than lexically past four digits', function () {
		// Lexicographic ordering of the id agrees while the prefixes are the
		// same width and stops agreeing at 10000. Comparing the number means
		// the day that happens is not the day migrations silently reorder.
		var a = fake('0002-b'); a.sequence = 2;
		var b = fake('0010-j'); b.sequence = 10;
		var c = fake('0001-a'); c.sequence = 10000;
		var out = ledger.sortMigrations([c, b, a]);
		assert.deepStrictEqual(out.map(function (m) { return m.sequence; }), [2, 10, 10000]);
	});

	it('does not mutate its input', function () {
		var input = [fake('0002-b'), fake('0001-a')];
		ledger.sortMigrations(input);
		assert.strictEqual(input[0].id, '0002-b');
	});
});

describe('pendingFor', function () {

	var all = [
		fake('0001-a', { phase: ledger.PHASE_PRE }),
		fake('0002-b'),
		fake('0003-c'),
		fake('0004-d', { phase: ledger.PHASE_PRE })
	];

	it('returns only this phase, in order', function () {
		assert.deepStrictEqual(
			ledger.pendingFor(all, [], ledger.PHASE_PRE).map(function (m) { return m.id; }),
			['0001-a', '0004-d']);
		assert.deepStrictEqual(
			ledger.pendingFor(all, [], ledger.PHASE_POST).map(function (m) { return m.id; }),
			['0002-b', '0003-c']);
	});

	it('drops anything already settled', function () {
		assert.deepStrictEqual(
			ledger.pendingFor(all, ['0002-b'], ledger.PHASE_POST).map(function (m) { return m.id; }),
			['0003-c']);
	});

	it('accepts a Set or an array of settled ids', function () {
		var out = ledger.pendingFor(all, new Set(['0003-c']), ledger.PHASE_POST);
		assert.deepStrictEqual(out.map(function (m) { return m.id; }), ['0002-b']);
	});

	it('returns nothing when everything is settled', function () {
		assert.deepStrictEqual(ledger.pendingFor(all, ['0002-b', '0003-c'], ledger.PHASE_POST), []);
	});
});

describe('validateMigration', function () {

	function mod(over) {
		return Object.assign({ description: 'does a thing', run: async function () {} }, over || {});
	}

	it('accepts a well formed automatic migration', function () {
		assert.deepStrictEqual(ledger.validateMigration(mod(), '0001-thing.js'), []);
	});

	it('accepts a manual migration with instructions and no run', function () {
		var m = { description: 'manual thing', automatic: false, instructions: 'run this' };
		assert.deepStrictEqual(ledger.validateMigration(m, '0001-thing.js'), []);
	});

	it('requires a description, since that is what a sysop reads', function () {
		var errs = ledger.validateMigration(mod({ description: undefined }), '0001-thing.js');
		assert.ok(errs.some(function (e) { return /description/.test(e); }));
	});

	it('requires run() on an automatic migration', function () {
		var errs = ledger.validateMigration({ description: 'x' }, '0001-thing.js');
		assert.ok(errs.some(function (e) { return /run\(\)/.test(e); }));
	});

	it('requires instructions on a manual one', function () {
		var errs = ledger.validateMigration({ description: 'x', automatic: false }, '0001-thing.js');
		assert.ok(errs.some(function (e) { return /instructions/.test(e); }));
	});

	it('rejects an unknown phase rather than defaulting it', function () {
		// A typo here would silently move a migration to the wrong side of the
		// schema pass, which for a pre-schema migration means the data it
		// converts has already been dropped.
		var errs = ledger.validateMigration(mod({ phase: 'before' }), '0001-thing.js');
		assert.ok(errs.some(function (e) { return /phase/.test(e); }));
	});

	it('rejects an exported id that disagrees with the filename', function () {
		var errs = ledger.validateMigration(mod({ id: '0009-other' }), '0001-thing.js');
		assert.ok(errs.some(function (e) { return /does not match its filename/.test(e); }));
	});

	it('rejects a filename it cannot order', function () {
		var errs = ledger.validateMigration(mod(), 'thing.js');
		assert.ok(errs.some(function (e) { return /NNNN-slug/.test(e); }));
	});
});

describe('normaliseMigration', function () {

	it('defaults phase to post and automatic to true', function () {
		var n = ledger.normaliseMigration({ description: 'x', run: async function () {} }, '0001-a.js');
		assert.strictEqual(n.phase, ledger.PHASE_POST);
		assert.strictEqual(n.automatic, true);
		assert.strictEqual(n.isNeeded, null);
	});

	it('treats automatic false as manual, not falsy-checked', function () {
		var n = ledger.normaliseMigration(
			{ description: 'x', automatic: false, instructions: 'y' }, '0001-a.js');
		assert.strictEqual(n.automatic, false);
	});
});

describe('the shipped migrations directory', function () {

	it('loads with no validation errors', async function () {
		// This is the guard that matters day to day: a migration added with a
		// bad name, a missing description or a typo'd phase should fail the
		// suite rather than the next sysop's update.
		var loaded = await ledger.loadMigrations(migrationsDir);
		assert.deepStrictEqual(loaded.errors, []);
	});

	it('has no duplicate sequence numbers', async function () {
		// Two topic branches each adding 0005 is the expected way this breaks.
		var loaded = await ledger.loadMigrations(migrationsDir);
		var seqs = loaded.migrations.map(function (m) { return m.sequence; });
		assert.deepStrictEqual(seqs, Array.from(new Set(seqs)),
			'duplicate sequence numbers in db/migrations');
	});

	it('returns empty rather than throwing for a directory that is not there', async function () {
		var loaded = await ledger.loadMigrations(path.join(here, 'no-such-dir'));
		assert.deepStrictEqual(loaded.migrations, []);
		assert.deepStrictEqual(loaded.errors, []);
	});

	it('every file on disk is a loadable migration', async function () {
		var onDisk = fs.readdirSync(migrationsDir).filter(function (f) { return f.endsWith('.js'); });
		var loaded = await ledger.loadMigrations(migrationsDir);
		assert.strictEqual(loaded.migrations.length, onDisk.length,
			'some file in db/migrations did not load as a migration');
	});

	it('the menu layout migration runs before the schema pass', async function () {
		// Not a style preference. Its second step reads entries_x_offset, which
		// the declarative pass drops. Post-schema, the data is already gone.
		var loaded = await ledger.loadMigrations(migrationsDir);
		var menu = loaded.migrations.filter(function (m) { return m.slug === 'menu-layout'; })[0];
		assert.ok(menu, 'expected a menu-layout migration');
		assert.strictEqual(menu.phase, ledger.PHASE_PRE);
	});

	it('the MSGID split is manual and carries instructions', async function () {
		// It full scans every per-area message table, so it is reported rather
		// than run. A sysop has to choose when to pay for it.
		var loaded = await ledger.loadMigrations(migrationsDir);
		var msgid = loaded.migrations.filter(function (m) { return m.slug === 'msgid-tuple-split'; })[0];
		assert.ok(msgid, 'expected an msgid-tuple-split migration');
		assert.strictEqual(msgid.automatic, false);
		assert.ok(/--fix-msgids/.test(msgid.instructions));
		assert.strictEqual(msgid.run, null);
	});
});

describe('runPhase', function () {

	it('skips a migration whose isNeeded says no, without running it', async function () {
		var ran = false;
		var m = fake('0001-a', {
			isNeeded: async function () { return false; },
			run: async function () { ran = true; }
		});
		var out = await ledger.runPhase([m], ledger.PHASE_POST, { dryRun: true });
		assert.strictEqual(ran, false);
		assert.strictEqual(out.skipped, 1);
	});

	it('reports a manual migration rather than running it', async function () {
		var m = fake('0001-a', { automatic: false, instructions: 'do the thing', run: null });
		var out = await ledger.runPhase([m], ledger.PHASE_POST, { dryRun: true });
		assert.strictEqual(out.manual.length, 1);
		assert.strictEqual(out.manual[0].id, '0001-a');
		assert.strictEqual(out.applied, 0);
	});

	it('runs nothing and writes nothing on a dry run', async function () {
		var ran = false;
		var m = fake('0001-a', { run: async function () { ran = true; } });
		var out = await ledger.runPhase([m], ledger.PHASE_POST, { dryRun: true });
		assert.strictEqual(ran, false);
		assert.strictEqual(out.applied, 1);
		assert.strictEqual(out.results[0].outcome, 'would-apply');
	});

	it('only considers migrations in the requested phase', async function () {
		var m = fake('0001-a', { phase: ledger.PHASE_PRE });
		var out = await ledger.runPhase([m], ledger.PHASE_POST, { dryRun: true });
		assert.strictEqual(out.applied, 0);
		assert.strictEqual(out.results.length, 0);
	});

	it('stops at the first failure and leaves later ones untouched', async function () {
		// A later migration may depend on an earlier one, so carrying on past a
		// failure is how a half-migrated database happens.
		var thirdRan = false;
		var migrations = [
			fake('0001-a', { isNeeded: async function () { return false; } }),
			fake('0002-b', { isNeeded: async function () { throw new Error('boom'); } }),
			fake('0003-c', { run: async function () { thirdRan = true; } })
		];
		var out = await ledger.runPhase(migrations, ledger.PHASE_POST, { dryRun: true });
		assert.ok(out.stopped);
		assert.strictEqual(out.failed.id, '0002-b');
		assert.strictEqual(thirdRan, false);
	});
});

describe('the ledger against a database', function () {
	this.timeout(30000);

	var available = false;
	var pg = null;
	var PREFIX = 'zz-test-ledger-';

	before(async function () {
		this.timeout(20000);
		available = await dbAvailable();
		if (!available) return;
		pg = await import('../src/middleware/db/postgres.js');
	});

	beforeEach(async function () {
		if (!available) return this.skip();
		await pg.write("DELETE FROM schema_migrations WHERE migration_id LIKE $1", [PREFIX + '%']);
	});

	after(async function () {
		if (!available || !pg) return;
		try { await pg.write("DELETE FROM schema_migrations WHERE migration_id LIKE $1", [PREFIX + '%']); } catch (_) {}
	});

	function testMigration(slug, over) {
		return Object.assign(fake('0001-a'), { id: PREFIX + slug }, over || {});
	}

	it('records an applied migration and does not consider it again', async function () {
		var runs = 0;
		var m = testMigration('applied', { run: async function () { runs++; } });

		await ledger.runPhase([m], ledger.PHASE_POST, {});
		assert.strictEqual(runs, 1);

		await ledger.runPhase([m], ledger.PHASE_POST, {});
		assert.strictEqual(runs, 1, 'an applied migration was run a second time');

		assert.strictEqual(await ledger.isSettled(m.id), true);
	});

	it('records a skipped migration so isNeeded is not asked twice', async function () {
		var asked = 0;
		var m = testMigration('skipped', {
			isNeeded: async function () { asked++; return false; }
		});

		await ledger.runPhase([m], ledger.PHASE_POST, {});
		await ledger.runPhase([m], ledger.PHASE_POST, {});

		assert.strictEqual(asked, 1, 'isNeeded was consulted after the answer was recorded');
		assert.strictEqual(await ledger.isSettled(m.id), true);
	});

	it('leaves a failed migration pending so a later run retries it', async function () {
		// The whole point of recording failures without settling them: fix the
		// cause, run again, and it picks up where it stopped.
		var attempts = 0;
		var m = testMigration('retry', {
			run: async function () {
				attempts++;
				if (attempts === 1) throw new Error('first attempt fails');
			}
		});

		var first = await ledger.runPhase([m], ledger.PHASE_POST, {});
		assert.ok(first.stopped);
		assert.strictEqual(await ledger.isSettled(m.id), false);

		var second = await ledger.runPhase([m], ledger.PHASE_POST, {});
		assert.strictEqual(second.applied, 1);
		assert.strictEqual(attempts, 2);
		assert.strictEqual(await ledger.isSettled(m.id), true);
	});

	it('keeps the failed attempt as history rather than overwriting it', async function () {
		// One row per attempt, no UNIQUE on migration_id, same reasoning as
		// mailer_sessions: the attempt that went wrong is the one worth reading
		// about later.
		var attempts = 0;
		var m = testMigration('history', {
			run: async function () {
				attempts++;
				if (attempts === 1) throw new Error('deliberate');
			}
		});

		await ledger.runPhase([m], ledger.PHASE_POST, {});
		await ledger.runPhase([m], ledger.PHASE_POST, {});

		var rows = await pg.query(
			'SELECT outcome FROM schema_migrations WHERE migration_id = $1 ORDER BY id', [m.id]);
		assert.deepStrictEqual(rows.map(function (r) { return r.outcome; }),
			[ledger.OUTCOME_FAILED, ledger.OUTCOME_APPLIED]);
	});

	it('records the failure reason, since that is what a sysop has to act on', async function () {
		var m = testMigration('reason', {
			run: async function () { throw new Error('something specific went wrong'); }
		});
		await ledger.runPhase([m], ledger.PHASE_POST, {});

		var row = await pg.queryOne(
			'SELECT note FROM schema_migrations WHERE migration_id = $1', [m.id]);
		assert.ok(/something specific went wrong/.test(row.note));
	});

	it('marks a fresh database as never needing any of them', async function () {
		var ran = false;
		var m = testMigration('fresh', { run: async function () { ran = true; } });

		await ledger.recordFreshInstall([m], { version: 'test' });

		assert.strictEqual(ran, false, 'a fresh install must not run migrations');
		assert.strictEqual(await ledger.isSettled(m.id), true);

		var row = await pg.queryOne(
			'SELECT outcome FROM schema_migrations WHERE migration_id = $1', [m.id]);
		assert.strictEqual(row.outcome, ledger.OUTCOME_PREINSTALLED);
	});

	it('records a manual completion from the tool that performed it', async function () {
		var id = PREFIX + 'manual';
		await ledger.recordManualCompletion(id, { note: 'done by hand' });

		assert.strictEqual(await ledger.isSettled(id), true);
		var row = await pg.queryOne(
			'SELECT outcome, note FROM schema_migrations WHERE migration_id = $1', [id]);
		assert.strictEqual(row.outcome, ledger.OUTCOME_APPLIED);
		assert.strictEqual(row.note, 'done by hand');
	});

	it('stamps the version so a ledger row says which release applied it', async function () {
		var m = testMigration('version', {});
		await ledger.runPhase([m], ledger.PHASE_POST, { version: '0.9.6a' });

		var row = await pg.queryOne(
			'SELECT canectic_version FROM schema_migrations WHERE migration_id = $1', [m.id]);
		assert.strictEqual(row.canectic_version, '0.9.6a');
	});
});
