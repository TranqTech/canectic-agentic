// seedSync.js — Synchronise seed data from JSON files into database tables.
//
// Upserts records: inserts new rows, updates changed columns on existing rows.
// Match key determines how to find existing records (default: first column in JSON).
//
// Usage:
//   node src/tools/seedSync.js                          # sync all registered seeds
//   node src/tools/seedSync.js --seed nodelist-flags    # sync a specific seed
//   node src/tools/seedSync.js --dry-run                # preview without writing
//   node src/tools/seedSync.js --seed nodelist-flags --dry-run

import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import * as pgdb from '../middleware/db/postgres.js';

dotenv.config();

// ---------------------------------------------------------------------------
// Seed registry: maps seed name -> { file, table, matchKey }
//
// matchKey: column used to find existing records (must be unique in practice).
// skipColumns: columns NOT to overwrite on existing records (e.g. user edits).
// ---------------------------------------------------------------------------

var SEEDS = [
	{
		name:        'nodelist-flags',
		file:        'config/default/nodelist-flags.json',
		table:       'nodelist_flag_definitions',
		matchKey:    'code',
		skipColumns: []   // overwrite everything from seed
	},
	{
		name:        'message-template-events',
		file:        'config/default/message-template-events.json',
		table:       'message_template_events',
		matchKey:    'code',
		skipColumns: ['context_schema']  // schema column is JSONB and managed separately
	}
];

// ---------------------------------------------------------------------------
// Core sync logic
// ---------------------------------------------------------------------------

async function syncSeed(seedDef, dryRun) {
	var filePath = path.join(process.cwd(), seedDef.file);
	if (!fs.existsSync(filePath)) {
		console.log('  SKIP: file not found: ' + seedDef.file);
		return { inserted: 0, updated: 0, unchanged: 0, errors: 0 };
	}

	var records;
	try {
		records = JSON.parse(fs.readFileSync(filePath, 'utf8'));
	} catch (err) {
		console.log('  ERROR: failed to parse ' + seedDef.file + ': ' + err.message);
		return { inserted: 0, updated: 0, unchanged: 0, errors: 1 };
	}

	if (!Array.isArray(records) || records.length === 0) {
		console.log('  SKIP: no records in ' + seedDef.file);
		return { inserted: 0, updated: 0, unchanged: 0, errors: 0 };
	}

	var stats = { inserted: 0, updated: 0, unchanged: 0, errors: 0 };
	var matchKey = seedDef.matchKey;
	var skipSet = new Set(seedDef.skipColumns || []);

	for (var record of records) {
		var matchVal = record[matchKey];
		if (matchVal === undefined || matchVal === null) {
			console.log('  WARN: record missing match key "' + matchKey + '", skipping');
			stats.errors++;
			continue;
		}

		// Find existing row by match key
		var existing = await pgdb.queryOne(
			'SELECT * FROM ' + seedDef.table + ' WHERE UPPER(' + matchKey + ') = UPPER($1)',
			[String(matchVal)]
		);

		if (!existing) {
			// INSERT new record
			var insertObj = Object.assign({}, record, { created_at: new Date() });
			if (dryRun) {
				console.log('  INSERT: ' + matchKey + '=' + matchVal);
			} else {
				var res = await pgdb.insertObject(insertObj, seedDef.table);
				if (res.status) {
					console.log('  INSERT: ' + matchKey + '=' + matchVal);
				} else {
					console.log('  ERROR inserting ' + matchVal + ': ' + (res.errormessages || []).join(', '));
					stats.errors++;
					continue;
				}
			}
			stats.inserted++;
		} else {
			// Compare and UPDATE if changed
			var changes = {};
			for (var col in record) {
				if (!record.hasOwnProperty(col)) continue;
				if (col === matchKey) continue;          // don't update the match key itself
				if (skipSet.has(col)) continue;           // skip user-editable columns

				var seedVal = record[col];
				var dbVal = existing[col];

				// Normalise for comparison
				if (seedVal === undefined) seedVal = null;
				if (typeof seedVal === 'boolean' && typeof dbVal !== 'boolean') {
					dbVal = dbVal === true || dbVal === 'true';
				}
				if (typeof seedVal === 'number' && typeof dbVal === 'string') {
					dbVal = parseFloat(dbVal);
				}

				if (JSON.stringify(seedVal) !== JSON.stringify(dbVal)) {
					changes[col] = seedVal;
				}
			}

			if (Object.keys(changes).length > 0) {
				changes.updated_at = new Date();
				if (dryRun) {
					console.log('  UPDATE: ' + matchKey + '=' + matchVal + '  changed: ' + Object.keys(changes).filter(function(k) { return k !== 'updated_at'; }).join(', '));
				} else {
					var count = await pgdb.updateById(existing.id, changes, seedDef.table);
					if (count > 0) {
						console.log('  UPDATE: ' + matchKey + '=' + matchVal + '  changed: ' + Object.keys(changes).filter(function(k) { return k !== 'updated_at'; }).join(', '));
					} else {
						console.log('  ERROR updating ' + matchVal);
						stats.errors++;
						continue;
					}
				}
				stats.updated++;
			} else {
				stats.unchanged++;
			}
		}
	}

	return stats;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
	var args = process.argv.slice(2);
	var dryRun = args.includes('--dry-run');
	var seedFilter = null;
	var seedIdx = args.indexOf('--seed');
	if (seedIdx >= 0 && args[seedIdx + 1]) {
		seedFilter = args[seedIdx + 1];
	}

	var seeds = SEEDS;
	if (seedFilter) {
		seeds = SEEDS.filter(function(s) { return s.name === seedFilter; });
		if (seeds.length === 0) {
			console.log('Unknown seed: ' + seedFilter);
			console.log('Available seeds: ' + SEEDS.map(function(s) { return s.name; }).join(', '));
			process.exit(1);
		}
	}

	console.log(dryRun ? 'Seed sync (dry run)' : 'Seed sync');
	console.log('---');

	var totalInserted = 0, totalUpdated = 0, totalUnchanged = 0, totalErrors = 0;

	for (var seed of seeds) {
		console.log('\n' + seed.name + '  (' + seed.table + ' <- ' + seed.file + ')');
		var stats = await syncSeed(seed, dryRun);
		totalInserted  += stats.inserted;
		totalUpdated   += stats.updated;
		totalUnchanged += stats.unchanged;
		totalErrors    += stats.errors;
		console.log('  Result: ' + stats.inserted + ' inserted, ' + stats.updated + ' updated, ' + stats.unchanged + ' unchanged' + (stats.errors > 0 ? ', ' + stats.errors + ' error(s)' : ''));
	}

	console.log('\n---');
	console.log('Total: ' + totalInserted + ' inserted, ' + totalUpdated + ' updated, ' + totalUnchanged + ' unchanged' + (totalErrors > 0 ? ', ' + totalErrors + ' error(s)' : ''));

	process.exit(totalErrors > 0 ? 1 : 0);
}

main().catch(function(err) {
	console.error('Fatal: ' + err.message);
	process.exit(1);
});
