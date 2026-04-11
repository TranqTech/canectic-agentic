// qwkConfRenumber.js — One-shot tool to renumber message_areas.qwk_conf_number.
//
// Sets every message area's qwk_conf_number to (id + RESERVED_CONF_COUNT),
// which is the default assignment scheme that reserves conference numbers
// 1..RESERVED_CONF_COUNT for Canectic system conferences (announcements,
// wall, bulletins, and future additions).
//
// This is the upgrade-path tool for installs created before the reserved
// range was introduced. It must be run once after pulling a release that
// adopts the reserved-range scheme, before normal operation. Any existing
// rows whose qwk_conf_number equals the area id (the pre-reserved-range
// default) will be shifted; any rows at other values will ALSO be shifted
// -- the tool's semantic is "set every area to its id + 100", not "shift
// rows that look legacy". Run only at upgrade time, before making any
// sysop customisations to qwk_conf_number.
//
// Usage:
//   node src/tools/qwkConfRenumber.js
//   node src/tools/qwkConfRenumber.js --dry-run
//   node src/tools/qwkConfRenumber.js --help
//
// Safety:
//   - Processes rows in DESCENDING id order so intermediate states don't
//     trip the UNIQUE constraint. When we get to row N, any row with a
//     larger id has already moved to its own target slot, so N+100 is
//     guaranteed free.
//   - All addition is done in SQL (UPDATE SET qwk_conf_number = id + $1)
//     rather than JavaScript. The pg driver returns BIGSERIAL as strings,
//     so computing the target in JS would produce string concatenation
//     ('1' + 100 = '1100') instead of integer addition (1 + 100 = 101).
//   - --dry-run logs each intended move without writing to the DB.
//   - Idempotent on already-correct rows: UPDATE SET qwk_conf_number = id
//     + 100 on a row that's already at id + 100 is a no-op.
//
// Exit codes:
//   0  success (including zero rows processed)
//   1  one or more rows failed to update
//   2  fatal (DB connection error, unexpected exception)

import * as dotenv from 'dotenv';
import * as pgdb from '../middleware/db/postgres.js';
import { RESERVED_CONF_COUNT } from '../models/msgAreas.js';

dotenv.config();

function printHelp() {
	console.log('qwkConfRenumber — set every message area qwk_conf_number to id + ' + RESERVED_CONF_COUNT);
	console.log('');
	console.log('Usage:');
	console.log('  node src/tools/qwkConfRenumber.js             # renumber in place');
	console.log('  node src/tools/qwkConfRenumber.js --dry-run   # preview without writing');
	console.log('  node src/tools/qwkConfRenumber.js --help');
	console.log('');
	console.log('Run this once when upgrading an install to the release that adopted');
	console.log('the reserved conference number range. Numbers 1..' + RESERVED_CONF_COUNT + ' are reserved for');
	console.log('Canectic system conferences (announcements, wall, bulletins). Message');
	console.log('areas default to (id + ' + RESERVED_CONF_COUNT + ') for the qwk_conf_number column.');
}

async function main() {
	var args = process.argv.slice(2);
	if (args.includes('--help') || args.includes('-h')) {
		printHelp();
		process.exit(0);
	}
	var dryRun = args.includes('--dry-run');

	console.log('qwkConfRenumber' + (dryRun ? ' (DRY RUN -- no writes)' : ''));
	console.log('---');

	// Connectivity sanity check before we do anything else
	try {
		await pgdb.query('SELECT 1', []);
	} catch (err) {
		console.error('Fatal: database unreachable: ' + err.message);
		process.exit(2);
	}

	// Load all rows in descending id order. The descending order is what
	// guarantees collision-safety: by the time we process row N, every
	// row with id > N has already moved to its own target and vacated
	// any slot it was holding.
	var rows;
	try {
		rows = await pgdb.query(
			'SELECT id, shortcode, qwk_conf_number FROM message_areas ORDER BY id DESC',
			[]
		);
	} catch (err) {
		console.error('Fatal: failed to load message_areas: ' + err.message);
		process.exit(2);
	}

	if (!rows || rows.length === 0) {
		console.log('No message areas found. Nothing to do.');
		process.exit(0);
	}

	console.log('Loaded ' + rows.length + ' message area(s)');
	console.log('');

	var updated = 0;
	var unchanged = 0;
	var failed = 0;

	for (var row of rows) {
		// Compute the target for display purposes only -- the actual
		// UPDATE does the arithmetic in SQL. The parseInt here is safe
		// because we're just using the number for logging; the DB write
		// never sees this JS value.
		var target = parseInt(row.id, 10) + RESERVED_CONF_COUNT;
		var current = row.qwk_conf_number;
		var label = 'id=' + row.id + ' shortcode="' + row.shortcode + '"';

		if (current === target) {
			console.log('  [unchanged] ' + label + ' already at ' + target);
			unchanged++;
			continue;
		}

		if (dryRun) {
			console.log('  [would set] ' + label + ' qwk_conf_number ' +
				(current === null || current === undefined ? 'NULL' : current) +
				' -> ' + target);
			updated++;
			continue;
		}

		try {
			await pgdb.pgpool.query(
				'UPDATE message_areas SET qwk_conf_number = id + $1 WHERE id = $2',
				[RESERVED_CONF_COUNT, row.id]
			);
			console.log('  [set] ' + label + ' qwk_conf_number ' +
				(current === null || current === undefined ? 'NULL' : current) +
				' -> ' + target);
			updated++;
		} catch (err) {
			console.error('  [FAILED] ' + label + ' ' +
				(current === null || current === undefined ? 'NULL' : current) +
				' -> ' + target + ': ' + err.message);
			failed++;
		}
	}

	console.log('');
	console.log('---');
	console.log('Summary: ' + updated + (dryRun ? ' would update' : ' updated') +
		', ' + unchanged + ' unchanged' +
		(failed > 0 ? ', ' + failed + ' failed' : ''));

	if (failed > 0) {
		console.error('');
		console.error('One or more rows failed to update. Check the log output above');
		console.error('for per-row errors. A common cause is a pre-existing sysop');
		console.error('customisation that collides with a shift target. Resolve via');
		console.error('/admin/msgAreas and re-run.');
		process.exit(1);
	}

	if (!dryRun && updated > 0) {
		console.log('');
		console.log('Renumber complete. You can now start the gateway/worker processes');
		console.log('normally. Run with --dry-run on subsequent releases to verify the');
		console.log('DB state matches expectations.');
	}

	process.exit(0);
}

main().catch(function(err) {
	console.error('Fatal: ' + (err && err.message ? err.message : err));
	if (err && err.stack) console.error(err.stack);
	process.exit(2);
});
