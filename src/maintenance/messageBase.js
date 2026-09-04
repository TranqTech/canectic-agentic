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
//
// Returns: { totalProcessed, totalUpdated, totalSkipped, totalErrors, areaResults[] }

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
			onProgress: onProgress
		});
		result.areaResults.push(areaResult);
		result.totalProcessed += areaResult.processed;
		result.totalUpdated   += areaResult.updated;
		result.totalSkipped   += areaResult.skipped;
		result.totalErrors    += areaResult.errors;
	}

	if (!quiet) {
		console.log('regenerateAllBodyHtml: complete — ' +
			result.totalProcessed + ' processed, ' +
			result.totalUpdated + ' updated, ' +
			result.totalSkipped + ' unchanged, ' +
			result.totalErrors + ' errors');
	}

	return result;
}

// ---------------------------------------------------------------------------
// regenerateAreaBodyHtml — process a single area
// ---------------------------------------------------------------------------

async function regenerateAreaBodyHtml(shortcode, options) {
	var opts = options || {};
	var batchSize  = opts.batchSize  || 100;
	var dryRun     = opts.dryRun     || false;
	var forceWidth = opts.forceWidth || undefined;
	var quiet      = opts.quiet      || false;
	var onProgress = opts.onProgress || null;

	var shorty   = shortcode.toLowerCase().trim();
	var msgtable = 'mb_' + shorty + '_msgs';

	var areaResult = {
		area:      shortcode,
		processed: 0,
		updated:   0,
		skipped:   0,
		errors:    0
	};

	// Get total count for progress reporting
	var countRow = await postgres.queryOne(
		'SELECT COUNT(*) AS cnt FROM ' + msgtable,
		[]
	);
	var total = countRow ? parseInt(countRow.cnt) : 0;

	if (total === 0) {
		if (!quiet) console.log('  ' + shortcode + ': 0 messages — skipping');
		return areaResult;
	}

	if (!quiet) console.log('  ' + shortcode + ': ' + total + ' message(s)');

	// Process in batches by id to avoid OFFSET performance issues
	var lastId = 0;

	while (true) {
		var rows = await postgres.query(
			'SELECT id, body_text, utf8 FROM ' + msgtable +
			' WHERE id > $1 ORDER BY id ASC LIMIT $2',
			[lastId, batchSize]
		);

		if (!rows || rows.length === 0) break;

		for (var i = 0; i < rows.length; i++) {
			var row = rows[i];
			lastId = row.id;
			areaResult.processed++;

			var displayText = row.utf8 || row.body_text || '';
			if (!displayText) {
				areaResult.skipped++;
				continue;
			}

			try {
				var newHtml = await formatBodyHtml(displayText, forceWidth);

				if (!dryRun && newHtml !== null) {
					await postgres.write(
						'UPDATE ' + msgtable + ' SET body_html = $1, updated_at = NOW() WHERE id = $2',
						[newHtml, row.id]
					);
					areaResult.updated++;
				} else if (newHtml !== null) {
					areaResult.updated++;
				} else {
					areaResult.skipped++;
				}
			} catch (err) {
				areaResult.errors++;
				if (!quiet) {
					console.log('    error on msg id=' + row.id + ': ' + (err.message || err));
				}
			}
		}

		// Progress callback
		if (onProgress) {
			try {
				onProgress({
					area:      shortcode,
					processed: areaResult.processed,
					updated:   areaResult.updated,
					skipped:   areaResult.skipped,
					total:     total,
					done:      areaResult.processed >= total
				});
			} catch (_) {}
		}

		if (!quiet && areaResult.processed % (batchSize * 5) === 0) {
			console.log('    ' + shortcode + ': ' + areaResult.processed + '/' + total +
				' (' + areaResult.updated + ' updated)');
		}
	}

	if (!quiet) {
		console.log('    ' + shortcode + ': done — ' +
			areaResult.updated + ' updated, ' +
			areaResult.skipped + ' skipped, ' +
			areaResult.errors + ' errors');
	}

	return areaResult;
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
		result.totalSkipped   += tableResult.skipped;
		result.totalErrors    += tableResult.errors;
	}

	if (!quiet) {
		console.log('regeneratePmBodyHtml: complete — ' +
			result.totalProcessed + ' processed, ' +
			result.totalUpdated + ' updated, ' +
			result.totalSkipped + ' unchanged, ' +
			result.totalErrors + ' errors');
	}

	return result;
}

async function regeneratePmTableBodyHtml(tableName, options) {
	var opts = options || {};
	var batchSize  = opts.batchSize  || 100;
	var dryRun     = opts.dryRun     || false;
	var forceWidth = opts.forceWidth || undefined;
	var quiet      = opts.quiet      || false;
	var onProgress = opts.onProgress || null;

	var tableResult = {
		table:     tableName,
		processed: 0,
		updated:   0,
		skipped:   0,
		errors:    0
	};

	var countRow = await postgres.queryOne(
		'SELECT COUNT(*) AS cnt FROM ' + tableName,
		[]
	);
	var total = countRow ? parseInt(countRow.cnt) : 0;

	if (total === 0) {
		if (!quiet) console.log('  ' + tableName + ': 0 messages — skipping');
		return tableResult;
	}

	if (!quiet) console.log('  ' + tableName + ': ' + total + ' message(s)');

	var lastId = 0;

	while (true) {
		var rows = await postgres.query(
			'SELECT id, body_text, utf8 FROM ' + tableName +
			' WHERE id > $1 ORDER BY id ASC LIMIT $2',
			[lastId, batchSize]
		);

		if (!rows || rows.length === 0) break;

		for (var i = 0; i < rows.length; i++) {
			var row = rows[i];
			lastId = row.id;
			tableResult.processed++;

			var displayText = row.utf8 || row.body_text || '';
			if (!displayText) {
				tableResult.skipped++;
				continue;
			}

			try {
				var newHtml = await formatBodyHtml(displayText, forceWidth);

				if (!dryRun && newHtml !== null) {
					await postgres.write(
						'UPDATE ' + tableName + ' SET body_html = $1 WHERE id = $2',
						[newHtml, row.id]
					);
					tableResult.updated++;
				} else if (newHtml !== null) {
					tableResult.updated++;
				} else {
					tableResult.skipped++;
				}
			} catch (err) {
				tableResult.errors++;
				if (!quiet) {
					console.log('    error on ' + tableName + ' id=' + row.id + ': ' + (err.message || err));
				}
			}
		}

		if (onProgress) {
			try {
				onProgress({
					table:     tableName,
					processed: tableResult.processed,
					updated:   tableResult.updated,
					skipped:   tableResult.skipped,
					total:     total,
					done:      tableResult.processed >= total
				});
			} catch (_) {}
		}

		if (!quiet && tableResult.processed % (batchSize * 5) === 0) {
			console.log('    ' + tableName + ': ' + tableResult.processed + '/' + total +
				' (' + tableResult.updated + ' updated)');
		}
	}

	if (!quiet) {
		console.log('    ' + tableName + ': done — ' +
			tableResult.updated + ' updated, ' +
			tableResult.skipped + ' skipped, ' +
			tableResult.errors + ' errors');
	}

	return tableResult;
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

	return totals;
}

export {
	regenerateAllBodyHtml,
	regenerateAreaBodyHtml,
	regeneratePmBodyHtml,
	rethreadAreas,
	fixLegacyMsgIds
};
