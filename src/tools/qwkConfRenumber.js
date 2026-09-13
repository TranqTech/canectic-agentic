// qwkConfRenumber.js — Migrate or rebuild QWK conference numbering.
//
// Canectic uses a per-group block model for QWK conference numbers:
//
//   * Conference 0 is E-mail (QWK convention).
//   * Conferences 1..RESERVED_CONF_COUNT (currently 100) are reserved
//     for system conferences (announcements, wall, bulletins).
//   * Each message_group owns a contiguous block starting at
//     message_groups.qwk_conf_start. The block is qwk_group_stride
//     wide (config, default 1000). Areas in the group are assigned
//     consecutive offsets within the block, sorted by sort_order then
//     id.
//
// This is the command line front end. The planning and writing live in
// src/maintenance/qwkConfRenumber.js so the migration ledger can perform the
// same work during an update: db/migrations/0003-qwk-conference-blocks.js runs
// it in default mode, which is what stopped this being an upgrade step a sysop
// had to read about and remember.
//
// This tool walks the existing groups and areas and assigns conference
// numbers to fit that model. It is the upgrade-path tool for installs
// created before this scheme existed (where qwk_conf_number was a
// flat id+100 derivation), and a recovery tool for any install where
// the conference numbering has drifted.
//
// Modes:
//
//   * Default mode preserves any group qwk_conf_start values that are
//     already set, and only fills in groups that are missing one. It
//     then renumbers each group's areas inside the existing block.
//     Use this for a normal upgrade run.
//
//   * --force discards every existing qwk_conf_start and qwk_conf_number,
//     then assigns fresh values from scratch. Group starts are placed
//     consecutively from the first stride boundary above
//     RESERVED_CONF_COUNT, in (sort_order, id) order. Use this when
//     conference numbers are completely scrambled or when you want to
//     compact groups together.
//
// Usage:
//   node src/tools/qwkConfRenumber.js                # default
//   node src/tools/qwkConfRenumber.js --dry-run      # preview only
//   node src/tools/qwkConfRenumber.js --force        # rebuild from zero
//   node src/tools/qwkConfRenumber.js --force --dry-run
//   node src/tools/qwkConfRenumber.js --help
//
// Two-phase write:
//   The tool first parks every area at -id (negatives can't collide
//   with any real conference number) and then writes final values.
//   This dodges UNIQUE-constraint violations when new and old ranges
//   overlap. The DB UNIQUE constraint allows negatives.
//
// Exit codes:
//   0  success (including no-op)
//   1  one or more groups have a full block (more areas than stride)
//   2  fatal (DB connection error, unexpected exception)

import * as dotenv from 'dotenv';
import * as pgdb from '../middleware/db/postgres.js';
import appConfig from '../config/appConfig.js';
import { RESERVED_CONF_COUNT } from '../models/msgAreas.js';
import * as renumber from '../maintenance/qwkConfRenumber.js';
import * as ledger from '../maintenance/migrationLedger.js';

dotenv.config();

// Kept in step with db/migrations/0003 so a run here settles the migration
// rather than leaving it pending.
const MIGRATION_ID = '0003-qwk-conference-blocks';

function printHelp() {
	console.log('');
	console.log('qwkConfRenumber -- assign QWK conference numbers in per-group blocks');
	console.log('');
	console.log('  node src/tools/qwkConfRenumber.js                # default: fill gaps, keep what is set');
	console.log('  node src/tools/qwkConfRenumber.js --dry-run      # preview only');
	console.log('  node src/tools/qwkConfRenumber.js --force        # discard and rebuild from zero');
	console.log('  node src/tools/qwkConfRenumber.js --force --dry-run');
	console.log('');
	console.log('Default mode is what the migration ledger runs during an update.');
	console.log('--force is not, because it renumbers areas that are already correct');
	console.log('and invalidates every conference list a reader is holding.');
	console.log('');
}

async function main() {
	var args = process.argv.slice(2);
	if (args.includes('--help') || args.includes('-h')) {
		printHelp();
		process.exit(0);
	}
	var dryRun = args.includes('--dry-run');
	var force = args.includes('--force');

	try {
		await appConfig.load();
	} catch (e) {
		console.error('Fatal: appConfig load failed: ' + (e.message || e));
		process.exit(2);
	}

	var stride = appConfig.getNumber('qwk_group_stride', 1000);
	if (stride <= 0) stride = 1000;

	console.log('qwkConfRenumber' + (dryRun ? ' (DRY RUN)' : '') + (force ? ' (FORCE)' : ''));
	console.log('---');
	console.log('Reserved conference range: 1-' + RESERVED_CONF_COUNT);
	console.log('Group stride:              ' + stride);
	console.log('');

	try {
		await pgdb.query('SELECT 1', []);
	} catch (err) {
		console.error('Fatal: database unreachable: ' + err.message);
		process.exit(2);
	}

	var result;
	try {
		result = await renumber.renumberConferences({ force: force, dryRun: dryRun, stride: stride });
	} catch (err) {
		console.error('');
		console.error(err.message || err);
		process.exit(1);
	}

	if (result.plan.groups.length === 0) {
		console.log('No message groups found. Nothing to do.');
		process.exit(0);
	}

	console.log('Group plan:');
	for (var a of result.plan.groups) {
		var range = a.newStart + '-' + (a.newStart + stride - 1);
		var note = '';
		if (a.oldStart === null) note = ' (new)';
		else if (a.oldStart !== a.newStart) note = ' (was ' + a.oldStart + ')';
		console.log('  [group ' + a.group.shortcode + '] start=' + a.newStart + ' range=' + range + note);
	}
	console.log('');

	console.log('Area plan:');
	var unchanged = result.plan.areas.length - result.changed.length;
	for (var aa of result.changed) {
		console.log('  [' + aa.group_shortcode + '/' + aa.shortcode + '] ' +
			(aa.oldNum == null ? 'NULL' : aa.oldNum) + ' -> ' + aa.newNum);
	}
	if (result.changed.length === 0) {
		console.log('  (no changes -- ' + unchanged + ' area(s) already at expected values)');
	} else {
		console.log('  (' + result.changed.length + ' changing, ' + unchanged + ' unchanged)');
	}
	console.log('');

	if (dryRun) {
		console.log('DRY RUN -- no writes performed.');
		process.exit(0);
	}

	// A completed run settles the ledger entry, so an update does not go on
	// reporting work that has been done.
	try {
		if (!(await ledger.isSettled(MIGRATION_ID))) {
			await ledger.recordManualCompletion(MIGRATION_ID, {
				description: 'Assign QWK conference numbers in per-group blocks',
				note: 'run from src/tools/qwkConfRenumber.js' + (force ? ' --force' : '')
			});
		}
	} catch (err) {
		console.log('Note: could not record this in the migration ledger: ' + (err.message || err));
	}

	console.log('---');
	console.log('Renumber complete. ' + result.plan.groups.length + ' group(s), ' +
		result.plan.areas.length + ' area(s) processed.');
	process.exit(0);
}

main().catch(function (err) {
	console.error('Fatal: ' + (err && err.message ? err.message : err));
	if (err && err.stack) console.error(err.stack);
	process.exit(2);
});
