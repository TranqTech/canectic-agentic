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
import * as alogger from '../utils/alogger.js';
import { RESERVED_CONF_COUNT } from '../models/msgAreas.js';

dotenv.config();

function printHelp() {
	console.log('qwkConfRenumber — assign QWK conference numbers per the per-group block model');
	console.log('');
	console.log('Usage:');
	console.log('  node src/tools/qwkConfRenumber.js              # preserve existing starts, fill gaps');
	console.log('  node src/tools/qwkConfRenumber.js --dry-run    # preview without writing');
	console.log('  node src/tools/qwkConfRenumber.js --force      # discard existing values and rebuild');
	console.log('  node src/tools/qwkConfRenumber.js --force --dry-run');
	console.log('  node src/tools/qwkConfRenumber.js --help');
	console.log('');
	console.log('Each message group owns a contiguous block of conference numbers of size');
	console.log('qwk_group_stride (config, default 1000). Numbers 1-' + RESERVED_CONF_COUNT + ' are reserved');
	console.log('for system conferences (announcements, wall, bulletins).');
	console.log('');
	console.log('Default mode preserves any group qwk_conf_start values already set, only');
	console.log('filling in groups that are missing one, then renumbers each group\'s areas');
	console.log('to fit. Use --force to discard existing values and start fresh.');
}

async function main() {
	var args = process.argv.slice(2);
	if (args.includes('--help') || args.includes('-h')) {
		printHelp();
		process.exit(0);
	}
	var dryRun = args.includes('--dry-run');
	var force = args.includes('--force');

	// Initialise config so we can read qwk_group_stride
	try {
		await appConfig.load();
	} catch (e) {
		console.error('Fatal: appConfig load failed: ' + (e.message || e));
		process.exit(2);
	}

	var stride = appConfig.getNumber('qwk_group_stride', 1000);
	if (stride <= 0) stride = 1000;

	console.log('qwkConfRenumber' +
		(dryRun ? ' (DRY RUN)' : '') +
		(force ? ' (FORCE)' : ''));
	console.log('---');
	console.log('Reserved conference range: 1-' + RESERVED_CONF_COUNT);
	console.log('Group stride:              ' + stride);
	console.log('');

	// Connectivity sanity check
	try {
		await pgdb.query('SELECT 1', []);
	} catch (err) {
		console.error('Fatal: database unreachable: ' + err.message);
		process.exit(2);
	}

	// Ensure schema is in place so we can run before the gateway/worker
	// has a chance to apply the .conf migration. This duplicates what
	// dbmigrations.js does for message_groups.qwk_conf_start, but is
	// safe to run repeatedly (CREATE...IF NOT EXISTS / ALTER...IF NOT
	// EXISTS). Without this step the tool would fail with "column does
	// not exist" on installs that haven't booted the gateway yet.
	try {
		await pgdb.write(
			'ALTER TABLE message_groups ADD COLUMN IF NOT EXISTS qwk_conf_start INTEGER'
		);
		await pgdb.write(
			"DO $$ BEGIN " +
			"IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'message_groups_qwk_conf_start_key') " +
			"THEN ALTER TABLE message_groups ADD CONSTRAINT message_groups_qwk_conf_start_key UNIQUE (qwk_conf_start); " +
			"END IF; END $$"
		);
	} catch (err) {
		console.error('Fatal: schema bootstrap failed: ' + err.message);
		process.exit(2);
	}

	// Load all groups in the order they should appear in QWK packets
	var groups;
	try {
		groups = await pgdb.query(
			'SELECT id, shortcode, name, sort_order, qwk_conf_start FROM message_groups ' +
			'ORDER BY sort_order ASC, id ASC',
			[]
		);
	} catch (err) {
		console.error('Fatal: failed to load message_groups: ' + err.message);
		process.exit(2);
	}
	if (!groups || groups.length === 0) {
		console.log('No message groups found. Nothing to do.');
		process.exit(0);
	}

	// Pass 1: assign group starts
	//
	// In default mode we keep any existing qwk_conf_start values and
	// just fill in groups that are missing one. The fill picks the
	// first stride-aligned slot at or above MAX(existing) + stride
	// (or the first slot above the reserved range, if there are no
	// existing values).
	//
	// In --force mode we discard everything and assign fresh starts
	// to every group, packed from the first stride boundary above
	// the reserved range.

	function firstSlot() {
		var s = stride;
		while (s <= RESERVED_CONF_COUNT) s += stride;
		return s;
	}

	var assignments = []; // [{ group, oldStart, newStart }]
	var usedStarts = new Set();

	if (force) {
		var cursor = firstSlot();
		for (var g of groups) {
			assignments.push({
				group: g,
				oldStart: g.qwk_conf_start != null ? parseInt(g.qwk_conf_start, 10) : null,
				newStart: cursor
			});
			usedStarts.add(cursor);
			cursor += stride;
		}
	} else {
		// First pass: register existing starts so we don't collide
		var maxExisting = null;
		for (var g2 of groups) {
			if (g2.qwk_conf_start != null) {
				var existing = parseInt(g2.qwk_conf_start, 10);
				usedStarts.add(existing);
				if (maxExisting === null || existing > maxExisting) maxExisting = existing;
			}
		}
		// Second pass: assign starts (preserving existing where set)
		var fillCursor = maxExisting != null ? maxExisting + stride : firstSlot();
		for (var g3 of groups) {
			if (g3.qwk_conf_start != null) {
				assignments.push({
					group: g3,
					oldStart: parseInt(g3.qwk_conf_start, 10),
					newStart: parseInt(g3.qwk_conf_start, 10)
				});
			} else {
				// Find next free fill slot
				while (usedStarts.has(fillCursor)) fillCursor += stride;
				assignments.push({
					group: g3,
					oldStart: null,
					newStart: fillCursor
				});
				usedStarts.add(fillCursor);
				fillCursor += stride;
			}
		}
	}

	// Print group plan
	console.log('Group plan:');
	for (var a of assignments) {
		var range = a.newStart + '-' + (a.newStart + stride - 1);
		var note = '';
		if (a.oldStart === null) note = ' (new)';
		else if (a.oldStart !== a.newStart) note = ' (was ' + a.oldStart + ')';
		console.log('  [group ' + a.group.shortcode + '] start=' + a.newStart + ' range=' + range + note);
	}
	console.log('');

	// Pass 2: build per-area assignments inside each group's block
	var areaAssignments = []; // [{ id, shortcode, group_id, oldNum, newNum, group }]
	var fatal = false;

	for (var ag of assignments) {
		var areas;
		try {
			areas = await pgdb.query(
				'SELECT id, shortcode, qwk_conf_number FROM message_areas ' +
				'WHERE group_id = $1 ORDER BY sort_order ASC, id ASC',
				[ag.group.id]
			);
		} catch (err) {
			console.error('Fatal: failed to load areas for group ' + ag.group.shortcode + ': ' + err.message);
			process.exit(2);
		}
		if (!areas || areas.length === 0) continue;

		if (areas.length > stride) {
			console.error('  [group ' + ag.group.shortcode + '] FULL: ' + areas.length +
				' areas exceed stride ' + stride + ' -- increase qwk_group_stride or split this group');
			fatal = true;
			continue;
		}

		// In default mode (not force), try to preserve each area's
		// existing offset within the block. If the offset is outside
		// [0, stride-1] (because of a manual override or because the
		// area predates the per-group scheme), the area is repacked
		// at the next sequential slot.
		//
		// In --force mode, every area gets a fresh sequential offset
		// from 0.
		var taken = new Set();
		var pendingSequential = [];
		var areaPlan = []; // parallel to `areas` but with offset

		for (var area of areas) {
			var oldNum = area.qwk_conf_number != null ? parseInt(area.qwk_conf_number, 10) : null;
			var entry = { area: area, offset: null, oldNum: oldNum };
			if (!force && ag.oldStart != null && oldNum != null) {
				var off = oldNum - ag.oldStart;
				if (off >= 0 && off < stride && !taken.has(off)) {
					entry.offset = off;
					taken.add(off);
				}
			}
			areaPlan.push(entry);
		}

		// Second pass over areas: anything still without an offset
		// gets the next free sequential slot
		var nextSeq = 0;
		for (var ent of areaPlan) {
			if (ent.offset === null) {
				while (taken.has(nextSeq) && nextSeq < stride) nextSeq++;
				if (nextSeq >= stride) {
					console.error('  [group ' + ag.group.shortcode + '] FULL during sequential fill');
					fatal = true;
					break;
				}
				ent.offset = nextSeq;
				taken.add(nextSeq);
				nextSeq++;
			}
		}

		for (var ent2 of areaPlan) {
			if (ent2.offset === null) continue;
			areaAssignments.push({
				id: ent2.area.id,
				shortcode: ent2.area.shortcode,
				group_id: ag.group.id,
				group_shortcode: ag.group.shortcode,
				oldNum: ent2.oldNum,
				newNum: ag.newStart + ent2.offset
			});
		}
	}

	if (fatal) {
		console.error('');
		console.error('One or more groups have more areas than the configured stride allows.');
		console.error('Increase qwk_group_stride in the admin config and re-run.');
		process.exit(1);
	}

	// Print per-area plan
	console.log('Area plan:');
	var changed = 0;
	var unchanged = 0;
	for (var aa of areaAssignments) {
		var sameStart = true; // we already accounted for old starts above
		if (aa.oldNum === aa.newNum) {
			unchanged++;
		} else {
			changed++;
			console.log('  [' + aa.group_shortcode + '/' + aa.shortcode + '] ' +
				(aa.oldNum == null ? 'NULL' : aa.oldNum) + ' -> ' + aa.newNum);
		}
	}
	if (changed === 0) {
		console.log('  (no changes -- ' + unchanged + ' area(s) already at expected values)');
	} else {
		console.log('  (' + changed + ' changing, ' + unchanged + ' unchanged)');
	}
	console.log('');

	if (dryRun) {
		console.log('DRY RUN -- no writes performed.');
		process.exit(0);
	}

	// Phase 1: park every area at -id
	console.log('Phase 1: parking areas at scratch values...');
	for (var aa1 of areaAssignments) {
		try {
			await pgdb.pgpool.query(
				'UPDATE message_areas SET qwk_conf_number = $1 WHERE id = $2',
				[-1 * parseInt(aa1.id, 10), aa1.id]
			);
		} catch (err) {
			console.error('  [FAILED scratch] ' + aa1.shortcode + ': ' + err.message);
			console.error('');
			console.error('Aborting before phase 2. The DB is in a partially-parked state.');
			console.error('Re-run the tool to retry, or restore from backup if data is critical.');
			process.exit(2);
		}
	}

	// Phase 2: write final values
	console.log('Phase 2: writing final conference numbers...');
	var failed = 0;
	for (var aa2 of areaAssignments) {
		try {
			await pgdb.pgpool.query(
				'UPDATE message_areas SET qwk_conf_number = $1 WHERE id = $2',
				[aa2.newNum, aa2.id]
			);
		} catch (err) {
			console.error('  [FAILED final] ' + aa2.shortcode + ' -> ' + aa2.newNum + ': ' + err.message);
			failed++;
		}
	}

	// Phase 3: write group qwk_conf_start values
	console.log('Phase 3: writing group qwk_conf_start values...');
	for (var ag2 of assignments) {
		try {
			await pgdb.pgpool.query(
				'UPDATE message_groups SET qwk_conf_start = $1 WHERE id = $2',
				[ag2.newStart, ag2.group.id]
			);
		} catch (err) {
			console.error('  [FAILED group] ' + ag2.group.shortcode + ' -> ' + ag2.newStart + ': ' + err.message);
			failed++;
		}
	}

	console.log('');
	console.log('---');
	if (failed > 0) {
		console.error('Renumber finished with ' + failed + ' failure(s). Inspect output above and re-run.');
		process.exit(1);
	}

	console.log('Renumber complete. ' + assignments.length + ' group(s), ' +
		areaAssignments.length + ' area(s) processed.');
	process.exit(0);
}

main().catch(function(err) {
	console.error('Fatal: ' + (err && err.message ? err.message : err));
	if (err && err.stack) console.error(err.stack);
	process.exit(2);
});
