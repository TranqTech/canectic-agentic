// messageBase.js — Message base maintenance functions.
//
// Located in src/maintenance/ — callable from CLI tools, admin panels,
// or scheduled jobs. Not part of the normal request path.
//
// CLI:
//   node src/tools/maintenance.js --regen-html
//
// Or from another module:
//   import { regenerateAllBodyHtml } from '../maintenance/messageBase.js';
//   await regenerateAllBodyHtml({ areas: ['GENERAL'], dryRun: true });

import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';
import { formatBodyHtml } from '../utils/terminalText.js';

// ---------------------------------------------------------------------------
// regenerateAllBodyHtml
// ---------------------------------------------------------------------------
// Re-generates body_html for every message in every active area (or a
// specified subset). Uses the current formatBodyHtml pipeline which includes
// paragraph reflow, ANSI art detection, and noWrap for responsive layout.
//
// Options:
//   areas:     Array of shortcodes to process (default: all active areas)
//   batchSize: Number of messages to process per DB fetch (default: 100)
//   dryRun:    If true, compute new HTML but don't write it (default: false)
//   onProgress: Callback(info) called after each batch — info has
//               { area, processed, updated, skipped, total, done }
//   forceWidth: If set, passed to formatBodyHtml to force a column width
//   quiet:     If true, suppress console output (default: false)
//   signal:    AbortSignal checked between batches (#85)
//
// Returns: { totalProcessed, totalUpdated, totalUnchanged, totalSkipped,
//            totalErrors, areaResults[] }, where updated counts only rows
//            whose HTML differs (see regenerateTableBodyHtml)

async function regenerateAllBodyHtml(options) {
	var opts = options || {};
	var batchSize  = opts.batchSize  || 100;
	var dryRun     = opts.dryRun     || false;
	var forceWidth = opts.forceWidth || undefined;
	var quiet      = opts.quiet      || false;
	var onProgress = opts.onProgress || null;

	var result = {
		totalProcessed: 0,
		totalUpdated:   0,
		totalUnchanged: 0,
		totalSkipped:   0,
		totalErrors:    0,
		areaResults:    []
	};

	// Get area list
	var areas;
	if (opts.areas && opts.areas.length > 0) {
		areas = opts.areas.map(function(s) { return { shortcode: s }; });
	} else {
		areas = await postgres.query(
			"SELECT shortcode FROM message_areas WHERE active ORDER BY shortcode ASC",
			[]
		);
	}

	if (!areas || areas.length === 0) {
		if (!quiet) console.log('regenerateAllBodyHtml: no areas to process');
		return result;
	}

	if (!quiet) {
		console.log('regenerateAllBodyHtml: ' + areas.length + ' area(s) to process' +
			(dryRun ? ' [DRY RUN]' : ''));
	}

	for (var a = 0; a < areas.length; a++) {
		var shortcode = areas[a].shortcode;
		var areaResult = await regenerateAreaBodyHtml(shortcode, {
			batchSize:  batchSize,
			dryRun:     dryRun,
			forceWidth: forceWidth,
			quiet:      quiet,
			onProgress: onProgress,
			signal:     opts.signal
		});
		result.areaResults.push(areaResult);
		result.totalProcessed += areaResult.processed;
		result.totalUpdated   += areaResult.updated;
		result.totalUnchanged += areaResult.unchanged;
		result.totalSkipped   += areaResult.skipped;
		result.totalErrors    += areaResult.errors;
	}

	if (!quiet) {
		console.log('regenerateAllBodyHtml: complete — ' +
			result.totalProcessed + ' processed, ' +
			result.totalUpdated + (opts.dryRun ? ' would change, ' : ' updated, ') +
			result.totalUnchanged + ' unchanged, ' +
			result.totalSkipped + ' skipped, ' +
			result.totalErrors + ' errors');
	}

	return result;
}

// ---------------------------------------------------------------------------
// regenerateAreaBodyHtml — process a single area
// ---------------------------------------------------------------------------

async function regenerateAreaBodyHtml(shortcode, options) {
	var tableResult = await regenerateTableBodyHtml(
		'mb_' + shortcode.toLowerCase().trim() + '_msgs', shortcode,
		Object.assign({}, options, { touchUpdatedAt: true }));
	var areaResult = Object.assign({ area: shortcode }, tableResult);
	delete areaResult.table;
	return areaResult;
}

// ---------------------------------------------------------------------------
// regenerateTableBodyHtml -- the loop both message areas and PM tables use
// ---------------------------------------------------------------------------
// Renders each row's body_text and compares the result with the stored
// body_html. Only a row whose HTML actually differs is counted as `updated`
// and, outside a dry run, written. Before #58 every row with text counted as
// updated and was rewritten, so a dry run could not say how many messages a
// regeneration would change (it reported all of them), and a real run
// rewrote and touched updated_at on rows it left identical.
//
//   updated:   HTML differs (in a dry run: would be rewritten)
//   unchanged: HTML already matches
//   skipped:   no body_text, or the formatter returned null
//   sampleIds: the first SAMPLE_IDS ids that differ, to look at before a run
//
// options.signal: an AbortSignal checked between batches, so a job that has
// run past its time limit stops at a clean point (#85). Rows written so far
// stay written, which is safe: each row is independent and a later run only
// rewrites what still differs.

var SAMPLE_IDS = 5;

async function regenerateTableBodyHtml(tableName, label, options) {
	var opts = options || {};
	var batchSize  = opts.batchSize  || 100;
	var dryRun     = opts.dryRun     || false;
	var forceWidth = opts.forceWidth || undefined;
	var quiet      = opts.quiet      || false;
	var onProgress = opts.onProgress || null;
	var signal     = opts.signal     || null;

	var result = {
		table:     tableName,
		processed: 0,
		updated:   0,
		unchanged: 0,
		skipped:   0,
		errors:    0,
		sampleIds: []
	};

	var countRow = await postgres.queryOne('SELECT COUNT(*) AS cnt FROM ' + tableName, []);
	var total = countRow ? parseInt(countRow.cnt) : 0;

	if (total === 0) {
		if (!quiet) console.log('  ' + label + ': 0 messages — skipping');
		return result;
	}

	if (!quiet) console.log('  ' + label + ': ' + total + ' message(s)');

	var update = 'UPDATE ' + tableName + ' SET body_html = $1' +
		(opts.touchUpdatedAt ? ', updated_at = NOW()' : '') + ' WHERE id = $2';

	// Batches by id to avoid OFFSET performance issues
	var lastId = 0;

	while (true) {
		if (signal) signal.throwIfAborted();

		var rows = await postgres.query(
			'SELECT id, body_text, body_html FROM ' + tableName +
			' WHERE id > $1 ORDER BY id ASC LIMIT $2',
			[lastId, batchSize]
		);

		if (!rows || rows.length === 0) break;

		for (var i = 0; i < rows.length; i++) {
			var row = rows[i];
			lastId = row.id;
			result.processed++;

			var displayText = row.body_text || '';
			if (!displayText) {
				result.skipped++;
				continue;
			}

			try {
				var newHtml = await formatBodyHtml(displayText, forceWidth);

				if (newHtml === null) {
					result.skipped++;
				} else if (newHtml === row.body_html) {
					result.unchanged++;
				} else {
					if (!dryRun) await postgres.write(update, [newHtml, row.id]);
					result.updated++;
					if (result.sampleIds.length < SAMPLE_IDS) result.sampleIds.push(row.id);
				}
			} catch (err) {
				result.errors++;
				if (!quiet) {
					console.log('    error on ' + label + ' id=' + row.id + ': ' + (err.message || err));
				}
			}
		}

		if (onProgress) {
			try {
				onProgress({
					area:      label,
					table:     tableName,
					processed: result.processed,
					updated:   result.updated,
					unchanged: result.unchanged,
					skipped:   result.skipped,
					total:     total,
					done:      result.processed >= total
				});
			} catch (_) {}
		}

		if (!quiet && result.processed % (batchSize * 5) === 0) {
			console.log('    ' + label + ': ' + result.processed + '/' + total +
				' (' + result.updated + (dryRun ? ' would change' : ' updated') + ')');
		}
	}

	if (!quiet) {
		console.log('    ' + label + ': done — ' +
			result.updated + (dryRun ? ' would change' : ' updated') + ', ' +
			result.unchanged + ' unchanged, ' +
			result.skipped + ' skipped, ' +
			result.errors + ' errors' +
			(result.sampleIds.length ? ' (e.g. ids ' + result.sampleIds.join(', ') + ')' : ''));
	}

	return result;
}

// ---------------------------------------------------------------------------
// regeneratePmBodyHtml — regenerate body_html for pm_inbox and pm_outbox
// ---------------------------------------------------------------------------
// Same pipeline as message areas but operates on the two PM tables.
// Options are the same as regenerateAllBodyHtml (batchSize, dryRun, forceWidth, quiet, onProgress).

async function regeneratePmBodyHtml(options) {
	var opts = options || {};
	var quiet = opts.quiet || false;

	var result = {
		totalProcessed: 0,
		totalUpdated:   0,
		totalUnchanged: 0,
		totalSkipped:   0,
		totalErrors:    0,
		tableResults:   []
	};

	var tables = ['pm_inbox', 'pm_outbox'];

	if (!quiet) {
		console.log('regeneratePmBodyHtml: processing pm_inbox + pm_outbox' +
			(opts.dryRun ? ' [DRY RUN]' : ''));
	}

	for (var t = 0; t < tables.length; t++) {
		var tableResult = await regeneratePmTableBodyHtml(tables[t], opts);
		result.tableResults.push(tableResult);
		result.totalProcessed += tableResult.processed;
		result.totalUpdated   += tableResult.updated;
		result.totalUnchanged += tableResult.unchanged;
		result.totalSkipped   += tableResult.skipped;
		result.totalErrors    += tableResult.errors;
	}

	if (!quiet) {
		console.log('regeneratePmBodyHtml: complete — ' +
			result.totalProcessed + ' processed, ' +
			result.totalUpdated + (opts.dryRun ? ' would change, ' : ' updated, ') +
			result.totalUnchanged + ' unchanged, ' +
			result.totalSkipped + ' skipped, ' +
			result.totalErrors + ' errors');
	}

	return result;
}

async function regeneratePmTableBodyHtml(tableName, options) {
	return regenerateTableBodyHtml(tableName, tableName, options);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
// rethreadArea
// ---------------------------------------------------------------------------
// Rebuilds all thread assignments for a message area. Clears existing threads,
// then re-processes all messages in chronological order using the standard
// threadMessage logic. Thread stats are flushed every 10 messages.
//
// Options:
//   areas: string[] — shortcodes to rethread (null = all active areas)
//   dryRun: boolean — preview only, don't write

async function rethreadAreas(options) {
	var opts = options || {};
	var messages = await import('../models/messages.js');

	var areaRows;
	if (opts.areas && opts.areas.length > 0) {
		areaRows = [];
		for (var sc of opts.areas) {
			var row = await postgres.queryOne("SELECT shortcode FROM message_areas WHERE UPPER(shortcode) = UPPER($1)", [sc]);
			if (row) areaRows.push(row);
			else alogger.writeAlog(3, '[Rethread] Area not found: ' + sc, 'yellow');
		}
	} else {
		areaRows = await postgres.query("SELECT shortcode FROM message_areas WHERE active ORDER BY shortcode");
	}

	if (!areaRows || areaRows.length === 0) {
		alogger.writeAlog(5, '[Rethread] No areas to process', 'cyan');
		return;
	}

	alogger.writeAlog(5, '[Rethread] Processing ' + areaRows.length + ' area(s)', 'cyan');

	for (var area of areaRows) {
		// Checked between areas only (#85): an area's threads are cleared
		// before they are rebuilt, so stopping part way through one would
		// leave it with most messages in no thread at all.
		if (opts.signal) opts.signal.throwIfAborted();

		var shorty = area.shortcode.toLowerCase();
		var msgtable = 'mb_' + shorty + '_msgs';
		var threadtable = 'mb_' + shorty + '_threads';

		// Count messages
		var countRow = await postgres.queryOne("SELECT COUNT(*) AS cnt FROM " + msgtable);
		var msgCount = countRow ? parseInt(countRow.cnt) : 0;
		alogger.writeAlog(5, '[Rethread] ' + area.shortcode + ': ' + msgCount + ' messages', 'cyan');

		if (msgCount === 0) continue;
		if (opts.dryRun) {
			alogger.writeAlog(5, '[Rethread] ' + area.shortcode + ': dry run, skipping', 'cyan');
			continue;
		}

		// Clear existing threads and thread references on messages
		await postgres.write("DELETE FROM " + threadtable);
		await postgres.write("UPDATE " + msgtable + " SET thread_id = NULL, threadid = NULL");

		// Load all messages in chronological order
		var allMsgs = await postgres.query(
			"SELECT * FROM " + msgtable + " ORDER BY system_time ASC, id ASC"
		);

		var processed = 0;
		for (var msg of (allMsgs || [])) {
			// threadMessage expects these fields and modifies them
			var msgObj = {
				msg_id: msg.msg_id,
				reply_to: msg.reply_to,
				subject: msg.subject || '',
				from_user: msg.from_user || '',
				to_user: msg.to_user || '',
				system_time: msg.system_time,
				threadid: null,
				thread_id: null
			};

			msgObj = await messages.threadMessage(msgObj, msgtable, threadtable, shorty);

			// Update the message row with thread assignment
			var updateFields = {};
			if (msgObj.thread_id) updateFields.thread_id = msgObj.thread_id;
			if (msgObj.threadid) updateFields.threadid = msgObj.threadid;
			if (Object.keys(updateFields).length > 0) {
				await postgres.write(
					"UPDATE " + msgtable + " SET thread_id = $1, threadid = $2 WHERE id = $3",
					[msgObj.thread_id || null, msgObj.threadid || null, msg.id]
				);
			}

			processed++;

			// Flush thread stats periodically
			if (processed % 10 === 0) {
				var pending = messages.drainThreadUpdateArray();
				if (pending.length > 0) await messages.updateThreadArray(pending);
			}

			if (processed % 100 === 0) {
				alogger.writeAlog(5, '[Rethread] ' + area.shortcode + ': ' + processed + '/' + msgCount, 'cyan');
			}
		}

		// Final flush
		var remaining = messages.drainThreadUpdateArray();
		if (remaining.length > 0) await messages.updateThreadArray(remaining);

		// Update area stats
		try {
			var msgAreasModule = await import('../models/msgAreas.js');
			await msgAreasModule.updateStatsForArea(area.shortcode);
		} catch (e) {}

		alogger.writeAlog(5, '[Rethread] ' + area.shortcode + ': complete (' + processed + ' messages)', 'greenbright');
	}

	alogger.writeAlog(5, '[Rethread] Done', 'greenbright');
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Legacy MSGID repair
// ---------------------------------------------------------------------------
//
// The platform stores MSGID split across two columns: the serial in msg_id,
// the origin FTN address in msg_orig_addr. Older code paths wrote the whole
// "address serial" string into msg_id and left msg_orig_addr empty, which
// defeats dupe detection against the same message arriving later over FTN.
//
// This walks every table that carries a MSGID and repairs those rows using
// ftnUtils.splitFullMsgid, the same function the tossers use, so there is one
// definition of the split. Doing it in SQL with split_part would be faster but
// would diverge: split_part(msg_id, ' ', 2) silently discards everything after
// a second space, whereas splitFullMsgid splits on the first space and keeps
// the remainder.
//
// Idempotent: repaired rows no longer match the selection predicate, so
// re-running is harmless. Called by dbmigrations.js after schema maintenance,
// and available on demand as maintenance.js --fix-msgids.
//
// options: { areas: [shortcode], dryRun: bool, batchSize: int }
// Returns { tables, scanned, msgidFixed, replyFixed, collisions }

// Global tables carrying a MSGID. Per-area mb_<shortcode>_msgs tables are
// discovered at runtime and always have both columns per the template.
var MSGID_TABLES = [
	{ name: 'pm_inbox',         hasReplyTo: false },
	{ name: 'pm_outbox',        hasReplyTo: false },
	{ name: 'pm_undeliverable', hasReplyTo: false },
	{ name: 'netmail_in',       hasReplyTo: false },
	{ name: 'netmail_out',      hasReplyTo: false },
	{ name: 'echomail_bad',     hasReplyTo: true  },
];

// A legacy row is one where a serial column still holds a space-separated
// "address serial" pair and its address column was never populated.
function legacyPredicate(hasReplyTo) {
	var clauses = ["(msg_id LIKE '% %' AND COALESCE(msg_orig_addr, '') = '')"];
	if (hasReplyTo) {
		clauses.push("(reply_to LIKE '% %' AND COALESCE(reply_orig_addr, '') = '')");
	}
	return '(' + clauses.join(' OR ') + ')';
}

async function tableExists(name) {
	var row = await postgres.queryOne(
		"SELECT 1 AS ok FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1",
		[name]
	);
	return !!row;
}

async function columnExists(table, column) {
	var row = await postgres.queryOne(
		"SELECT 1 AS ok FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2",
		[table, column]
	);
	return !!row;
}

// The MSGID tuple split is a one-time repair for message bases written before
// msg_id and msg_orig_addr were separate columns. It used to run on every
// `dbmigrations.js`, which meant a full scan of every per-area message table on
// every update: the predicate is `msg_id LIKE '% %'`, which no index helps, and
// on a hub with hundreds of areas and large bases that is minutes of work to
// discover there is nothing to do.
//
// It is manual now (`maintenance.js --fix-msgids`), and this marker is how a
// system remembers it has been done, so migrations can say "you still need to
// run this" without paying for the scan to find out.
const MSGID_SPLIT_MARKER = 'msgid_tuple_split_completed_at';

// The ledger id for the same one-time step. db/migrations/0002 reports it as
// pending; this module records it when the repair is actually performed.
const MSGID_MIGRATION_ID = '0002-msgid-tuple-split';

/**
 * Has the one-time MSGID tuple split been run on this system?
 */
async function msgidSplitCompleted() {
	try {
		var row = await postgres.queryOne(
			'SELECT value FROM settings WHERE key = $1', [MSGID_SPLIT_MARKER]);
		return !!(row && row.value);
	} catch (_) {
		// settings may not exist yet on a fresh install, which is the same
		// answer as far as the caller is concerned.
		return false;
	}
}

/**
 * May this run claim the whole system is repaired?
 *
 * Only a full pass proves it. An --area run repairs what it was pointed at and
 * says nothing about the rest, and a dry run repairs nothing at all. Marking
 * either as complete would silence the migration notice on a system that is
 * still half broken, which is worse than never having had the notice.
 */
function shouldMarkComplete(options) {
	var opts = options || {};
	if (opts.dryRun) return false;
	if (opts.areas && opts.areas.length > 0) return false;
	return true;
}

/**
 * Record that it has been done. Called after a full, non-dry run, and by the
 * migration tool on a system that has no message bases to repair.
 */
async function markMsgidSplitCompleted(note) {
	var ok = true;
	try {
		await postgres.write(
			'INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW()) ' +
			'ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()',
			[MSGID_SPLIT_MARKER, note || new Date().toISOString()]
		);
	} catch (err) {
		alogger.writeAlog(3, '[FixMsgIds] could not record completion marker: ' +
			(err?.message || err), 'yellow');
		ok = false;
	}

	// Also record it in the migration ledger, which is where one-time steps are
	// tracked now. The settings marker is kept because systems that predate the
	// ledger have one and migration 0002 reads it to decide it has nothing to
	// tell them; this is the other half of that bridge, so a repair run today
	// leaves a row in the general place rather than only in the private one.
	try {
		var ledger = await import('./migrationLedger.js');
		if (!(await ledger.isSettled(MSGID_MIGRATION_ID))) {
			await ledger.recordManualCompletion(MSGID_MIGRATION_ID, {
				description: 'Split legacy "address serial" MSGIDs into the msg_id / msg_orig_addr tuple',
				note: note || 'completed via maintenance.js --fix-msgids'
			});
		}
	} catch (err) {
		alogger.writeAlog(3, '[FixMsgIds] could not record ledger entry: ' +
			(err?.message || err), 'yellow');
	}

	return ok;
}

async function fixLegacyMsgIds(options) {
	var opts      = options || {};
	var dryRun    = opts.dryRun || false;
	var batchSize = opts.batchSize || 500;
	var ftnUtils  = await import('../utils/ftnUtils.js');

	var totals = { tables: 0, scanned: 0, msgidFixed: 0, replyFixed: 0, collisions: 0 };

	// Build the work list. A specific --area limits it to those message areas
	// and skips the global tables, which are not area-scoped.
	var work = [];

	if (!opts.areas || opts.areas.length === 0) {
		for (var g of MSGID_TABLES) work.push(g);
	}

	try {
		var areaRows;
		if (opts.areas && opts.areas.length > 0) {
			areaRows = [];
			for (var sc of opts.areas) {
				var row = await postgres.queryOne(
					"SELECT shortcode FROM message_areas WHERE UPPER(shortcode) = UPPER($1)", [sc]
				);
				if (row) areaRows.push(row);
				else alogger.writeAlog(3, '[FixMsgIds] Area not found: ' + sc, 'yellow');
			}
		} else {
			areaRows = await postgres.query(
				"SELECT shortcode FROM message_areas WHERE active ORDER BY shortcode"
			);
		}
		for (var a of (areaRows || [])) {
			work.push({ name: 'mb_' + a.shortcode.toLowerCase() + '_msgs', hasReplyTo: true });
		}
	} catch (_) {
		// message_areas may not exist yet on a fresh install; globals still apply
	}

	if (work.length === 0) {
		alogger.writeAlog(5, '[FixMsgIds] Nothing to scan', 'cyan');
		return totals;
	}

	alogger.writeAlog(5, '[FixMsgIds] Scanning ' + work.length + ' table(s)' +
		(dryRun ? ' (dry run)' : ''), 'cyan');

	for (var t of work) {
		// Skip tables or columns that do not exist yet rather than erroring:
		// this runs during migration, when the schema may be part way built.
		if (!(await tableExists(t.name))) continue;
		if (!(await columnExists(t.name, 'msg_orig_addr'))) continue;

		var hasReplyTo = t.hasReplyTo &&
			(await columnExists(t.name, 'reply_to')) &&
			(await columnExists(t.name, 'reply_orig_addr'));
		var predicate = legacyPredicate(hasReplyTo);

		var countRow;
		try {
			countRow = await postgres.queryOne(
				'SELECT COUNT(*) AS cnt FROM ' + t.name + ' WHERE ' + predicate
			);
		} catch (err) {
			alogger.writeAlog(3, '[FixMsgIds] Skipping ' + t.name + ': ' + err.message, 'yellow');
			continue;
		}

		var todo = countRow ? parseInt(countRow.cnt) : 0;
		if (!todo) continue;

		totals.tables++;
		totals.scanned += todo;
		alogger.writeAlog(4, '[FixMsgIds] ' + t.name + ': ' + todo + ' legacy row(s)', 'cyan');

		if (dryRun) {
			// Splitting can expose serials that were only distinct because of
			// their address prefix. Dupe detection matches on msg_id alone, so
			// report those rather than discovering them after the fact.
			try {
				var collisionRow = await postgres.queryOne(
					"SELECT COUNT(*) AS cnt FROM (" +
					"  SELECT btrim(substring(btrim(msg_id) from position(' ' in btrim(msg_id)) + 1)) AS serial" +
					"  FROM " + t.name + " WHERE msg_id LIKE '% %'" +
					"  GROUP BY 1 HAVING COUNT(*) > 1" +
					") x"
				);
				var collisions = collisionRow ? parseInt(collisionRow.cnt) : 0;
				if (collisions > 0) {
					totals.collisions += collisions;
					alogger.writeAlog(3, '[FixMsgIds] ' + t.name + ': ' + collisions +
						' serial(s) would appear more than once after splitting', 'yellow');
				}
			} catch (_) { /* reporting only */ }
			continue;
		}

		var cols = 'id, msg_id, msg_orig_addr' +
			(hasReplyTo ? ', reply_to, reply_orig_addr' : '');

		var lastId = 0;
		for (;;) {
			// Each row is split independently, so any batch boundary is a
			// clean place to stop (#85). Throwing also skips the completion
			// marker below, which only a full pass may set.
			if (opts.signal) opts.signal.throwIfAborted();

			var rows = await postgres.query(
				'SELECT ' + cols + ' FROM ' + t.name +
				' WHERE id > $1 AND ' + predicate + ' ORDER BY id LIMIT $2',
				[lastId, batchSize]
			);
			if (!rows || rows.length === 0) break;

			for (var r of rows) {
				lastId = r.id;
				var updates = {};

				if (r.msg_id && r.msg_id.indexOf(' ') >= 0 && !r.msg_orig_addr) {
					var m = ftnUtils.splitFullMsgid(r.msg_id);
					if (m.msg_id) {
						updates.msg_id = m.msg_id;
						updates.msg_orig_addr = m.msg_orig_addr;
					}
				}

				if (hasReplyTo && r.reply_to && r.reply_to.indexOf(' ') >= 0 && !r.reply_orig_addr) {
					var p = ftnUtils.splitFullMsgid(r.reply_to);
					if (p.msg_id) {
						updates.reply_to = p.msg_id;
						updates.reply_orig_addr = p.msg_orig_addr;
					}
				}

				if (Object.keys(updates).length === 0) continue;

				var affected = await postgres.updateById(r.id, updates, t.name);
				if (affected > 0) {
					if (updates.msg_id)   totals.msgidFixed++;
					if (updates.reply_to) totals.replyFixed++;
				}
			}
		}
	}

	if (totals.scanned > 0 || dryRun) {
		alogger.writeAlog(2, '[FixMsgIds] ' + (dryRun ? 'Would repair ' : 'Repaired ') +
			totals.msgidFixed + ' MSGID and ' + totals.replyFixed + ' REPLY value(s) across ' +
			totals.tables + ' table(s)' + (dryRun ? ' (' + totals.scanned + ' rows matched)' : ''),
			'greenbright');
	}

	// Only a full pass proves the whole system is clean. An --area run repairs
	// what it was pointed at and says nothing about the rest, and a dry run
	// repairs nothing at all, so neither may claim the job is done.
	if (shouldMarkComplete(opts)) {
		totals.markedComplete = await markMsgidSplitCompleted(
			'repaired ' + totals.msgidFixed + ' msg_id and ' + totals.replyFixed +
			' reply_to value(s) on ' + new Date().toISOString());
		alogger.writeAlog(3, '[FixMsgIds] recorded as complete; migrations will stop asking', 'cyan');
	}

	return totals;
}

export {
	regenerateAllBodyHtml,
	regenerateAreaBodyHtml,
	regenerateTableBodyHtml,
	regeneratePmBodyHtml,
	rethreadAreas,
	fixLegacyMsgIds,
	msgidSplitCompleted,
	shouldMarkComplete,
	markMsgidSplitCompleted,
	MSGID_SPLIT_MARKER,
	MSGID_MIGRATION_ID
};
