// tests/msgidSplitMarker.test.js: the one-time MSGID split, and not re-running it.
//
// The MSGID tuple split repairs message bases written before msg_id and
// msg_orig_addr were separate columns. It used to run on every dbmigrations.js,
// which meant a full scan of every per-area message table on every update: the
// predicate is `msg_id LIKE '% %'`, which no index helps. On a hub with hundreds
// of areas that is minutes of work on every pull to discover there is nothing to
// do, and it can only ever find something once.
//
// It is manual now. The marker is how a system remembers it has been done, so
// migrations can say "you still need this" from a single lookup instead of
// paying for the scan to find out.
//
// The part worth guarding is which runs may claim completion. Marking a dry run
// or a single-area run as done would silence the notice on a system that is
// still half repaired, which is worse than never having shown it.
//
// Run: npx mocha

import assert from 'assert';
import { dbAvailable } from './helpers/dbAvailable.js';

var messageBase = null;
try { messageBase = await import('../src/maintenance/messageBase.js'); } catch (_) { messageBase = null; }

describe('messageBase.shouldMarkComplete', function () {
	before(function () {
		if (!messageBase || typeof messageBase.shouldMarkComplete !== 'function') this.skip();
	});

	it('lets a full repair claim completion', function () {
		assert.strictEqual(messageBase.shouldMarkComplete({}), true);
		assert.strictEqual(messageBase.shouldMarkComplete({ areas: [] }), true);
		assert.strictEqual(messageBase.shouldMarkComplete({ dryRun: false }), true);
		assert.strictEqual(messageBase.shouldMarkComplete(undefined), true);
	});

	it('refuses a dry run', function () {
		// It repaired nothing. Recording it as done would leave the legacy
		// rows in place with nothing left to point them out.
		assert.strictEqual(messageBase.shouldMarkComplete({ dryRun: true }), false);
	});

	it('refuses a run limited to particular areas', function () {
		// It says nothing about the areas it was not pointed at.
		assert.strictEqual(messageBase.shouldMarkComplete({ areas: ['GENERAL'] }), false);
		assert.strictEqual(messageBase.shouldMarkComplete({ areas: ['A', 'B'] }), false);
	});

	it('refuses a dry run even across all areas', function () {
		assert.strictEqual(messageBase.shouldMarkComplete({ dryRun: true, areas: [] }), false);
	});
});

describe('messageBase MSGID split marker', function () {
	this.timeout(20000);

	var available = false;
	var pg = null;
	var priorValue = null;
	var hadPrior = false;

	before(async function () {
		this.timeout(15000);
		try {
			available = await dbAvailable();
			if (!available || !messageBase) { available = false; return; }
			pg = await import('../src/middleware/db/postgres.js');

			// This runs against the real settings table, so put back whatever
			// was there. Marking a live system as repaired when it is not would
			// suppress the only notice telling its sysop to run the repair.
			var row = await pg.queryOne('SELECT value FROM settings WHERE key = $1',
				[messageBase.MSGID_SPLIT_MARKER]);
			if (row) { hadPrior = true; priorValue = row.value; }
		} catch (_) { available = false; }
	});

	beforeEach(function () { if (!available) this.skip(); });

	after(async function () {
		if (!available) return;
		try {
			if (hadPrior) {
				await pg.write('INSERT INTO settings (key, value, updated_at) VALUES ($1,$2,NOW()) ' +
					'ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()',
					[messageBase.MSGID_SPLIT_MARKER, priorValue]);
			} else {
				await pg.write('DELETE FROM settings WHERE key = $1', [messageBase.MSGID_SPLIT_MARKER]);
			}
		} catch (_) {}
	});

	it('reports not completed when the marker is absent', async function () {
		await pg.write('DELETE FROM settings WHERE key = $1', [messageBase.MSGID_SPLIT_MARKER]);
		assert.strictEqual(await messageBase.msgidSplitCompleted(), false);
	});

	it('reports completed once the marker is written', async function () {
		await pg.write('DELETE FROM settings WHERE key = $1', [messageBase.MSGID_SPLIT_MARKER]);
		assert.strictEqual(await messageBase.markMsgidSplitCompleted('zz test'), true);
		assert.strictEqual(await messageBase.msgidSplitCompleted(), true);
	});

	it('keeps the note it was given, so a sysop can see when and what', async function () {
		await messageBase.markMsgidSplitCompleted('zz repaired 5 on some date');
		var row = await pg.queryOne('SELECT value FROM settings WHERE key = $1',
			[messageBase.MSGID_SPLIT_MARKER]);
		assert.strictEqual(row.value, 'zz repaired 5 on some date');
	});

	it('is idempotent, so re-running the repair does not fail on the marker', async function () {
		await messageBase.markMsgidSplitCompleted('zz first');
		await messageBase.markMsgidSplitCompleted('zz second');
		var row = await pg.queryOne('SELECT value FROM settings WHERE key = $1',
			[messageBase.MSGID_SPLIT_MARKER]);
		assert.strictEqual(row.value, 'zz second');
	});

	it('does not treat an empty marker value as completed', async function () {
		// A blank row is not evidence the repair ran.
		await pg.write('INSERT INTO settings (key, value, updated_at) VALUES ($1,$2,NOW()) ' +
			'ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()',
			[messageBase.MSGID_SPLIT_MARKER, '']);
		assert.strictEqual(await messageBase.msgidSplitCompleted(), false);
	});

	it('uses a key that is not a configurable setting', async function () {
		// It lives in the settings table but is bookkeeping, not config, so it
		// must not turn up on /admin/config for a sysop to edit.
		var defaults = await import('../src/config/configDefaults.js');
		var defs = defaults.CONFIG_DEFINITIONS || defaults.default;
		assert.ok(!defs.some(function (d) { return d.key === messageBase.MSGID_SPLIT_MARKER; }),
			'the marker must not be a declared config key');
	});
});

describe('dbmigrations no longer runs the MSGID split', function () {
	var src = null;
	before(async function () {
		try {
			var fs = await import('fs');
			src = fs.readFileSync('src/tools/dbmigrations.js', 'utf8');
		} catch (_) { this.skip(); }
	});

	it('does not call the repair', function () {
		// The whole point: every update used to scan every message table in
		// full to establish there was nothing to do.
		assert.ok(!/fixLegacyMsgIds/.test(src),
			'migrations must not run the repair, only advertise it');
	});

	it('still tells the sysop how to run it', function () {
		assert.ok(/--fix-msgids/.test(src),
			'removing it silently would leave an unrepaired system with no way to find out');
	});

	it('checks the marker rather than scanning to decide', function () {
		assert.ok(/msgidSplitCompleted/.test(src));

		// Comments stripped: the file explains the expensive predicate in
		// prose, and matching that explanation is not the same as running it.
		var code = src.split('\n')
			.filter(function (l) { return !/^\s*(\/\/|\*|\/\*)/.test(l); })
			.join('\n');
		assert.ok(!/msg_id LIKE/.test(code), 'that predicate is the expensive scan');
	});
});
