// msgBaseImport.js - Shared machinery for importing foreign message bases.
//
// Format-specific parsers (smbParser, jamParser) produce a common message
// shape; format-specific adapters (smbToDbObj, jamToDbObj) map one parsed
// message to a DB row. Everything between those two points is the same
// regardless of format, and lives here.
//
// See smbImport.js and jamImport.js for the per-format wrappers.

import * as postgres from '../middleware/db/postgres.js';
import * as messages from '../models/messages.js';
import * as msgAreas from '../models/msgAreas.js';
import * as networkAreas from '../models/networkAreas.js';
import * as peerAreaSubs from '../models/peerAreaSubscriptions.js';
import { formatBodyHtml } from '../utils/terminalText.js';
import * as alogger from '../utils/alogger.js';

// --- Helpers ---

// Strip null bytes (0x00) from strings. PostgreSQL rejects them in text
// columns, and message base data files use nulls as padding/terminators.
function stripNulls(str) {
	if (typeof str !== 'string') return str;
	return str.replace(/\x00/g, '');
}

// --- Resolve the target area, its backing tables, and its network ---
//
// Returns { area, shorty, msgtable, threadtable, networkId }, or null when the
// shortcode does not match a known message area. Callers resolve before
// parsing so a bad shortcode fails fast instead of after reading a whole
// message base.
//
// Imported rows are stamped `imported = true` (when sealing, which is the
// default). getOutboundForConnection skips those, which is what stops a
// migration from echoing the old system's history out to peers.
//
// networkId is bookkeeping only. It used to drive outbound suppression via
// source_network_id, but that column is stamped on ALL inbound echomail, so
// suppressing on it stopped a hub forwarding anything at all. See the note in
// echomail.js getOutboundForConnection.
//
// options.networkId forces a specific network. Otherwise the area's network
// mapping is used when there is exactly one; an area carried on several
// networks is ambiguous and is left unstamped.

async function resolveImportTarget(areaShortcode, options) {
	var opts = options || {};

	var area = await msgAreas.getAreaByShortcode(areaShortcode);
	if (!area) return null;

	var shorty = areaShortcode.toLowerCase();

	var networkId = null;
	if (opts.networkId) {
		networkId = parseInt(opts.networkId);
	} else {
		var netRows = await networkAreas.getNetworksByArea(area.id);
		if (netRows && netRows.length === 1) {
			networkId = netRows[0].network_id;
		} else if (netRows && netRows.length > 1) {
			alogger.writeAlog(3,
				'resolveImportTarget: area ' + areaShortcode + ' is carried on ' + netRows.length +
				' networks, leaving source_network_id unset. Pass options.networkId to stamp it.',
				'yellow');
		}
	}

	return {
		area:        area,
		shorty:      shorty,
		msgtable:    'mb_' + shorty + '_msgs',
		threadtable: 'mb_' + shorty + '_threads',
		networkId:   networkId,
	};
}

// --- Import an already-parsed message array into a resolved area ---
//
//   source   - any iterable of parser output objects. Pass a generator rather
//              than an array: message bases are read lazily so the whole base
//              never has to fit in memory.
//   target   - result of resolveImportTarget()
//   toDbObj  - function(parsedMessage, target) returning a DB row object
//   options  - { label, seal, expectedTotal }
//
// Returns { status, imported, duplicates, skipped, errors, total, lastId }
//
// total is the number of messages actually seen. expectedTotal is only used to
// give progress logging a denominator, since a lazy source has no length.
//
// lastId is the id of the last row inserted, which the caller can use to
// fast-forward outbound high water marks past the imported history.

async function importParsedMessages(source, target, toDbObj, options) {
	var opts  = options || {};
	var label = '[' + (opts.label || 'Import') + '] ';
	var msgs  = source || [];

	var result = {
		status: false,
		imported: 0,
		duplicates: 0,
		skipped: 0,
		errors: [],
		total: 0,
		lastId: null,
		sealed: null,
	};

	var expected = opts.expectedTotal;
	alogger.writeAlog(3, label + 'Importing' +
		(expected ? ' up to ' + expected + ' messages' : ''), 'cyan');

	// Record the area head before inserting anything. The seal uses it to tell
	// which peers were caught up at that moment, so peers that were already
	// behind keep their position rather than having a legitimate backlog
	// silently suppressed.
	var seal = opts.seal !== false;
	var headBefore = 0;
	if (seal) {
		try {
			headBefore = await peerAreaSubs.headIdForShortcode(target.shorty);
		} catch (e) {
			alogger.writeAlog(3, label + 'could not read area head, seal will cover all peers: ' + e.message, 'yellow');
			headBefore = 0;
		}
	}

	// for...of so a lazy generator is consumed one message at a time. Indexing
	// would force the whole base into memory, which is what exhausted the
	// worker heap on a hub-sized echo.
	var i = -1;
	for (var msg of msgs) {
		i++;
		result.total++;

		// Parser-supplied message number when present, otherwise the loop
		// index. Only used for error reporting, so a missing header is fine.
		var msgnum = (msg && msg.header && msg.header.number) || i;

		try {
			var dbObj = toDbObj(msg, target);

			// Mark the row as imported history. This, not source_network_id, is
			// what keeps a migration from echoing another system's back traffic
			// out to peers. It is tied to the seal option so `seal: false` still
			// means "treat this import as ordinary traffic".
			dbObj.imported = seal;

			// Dupe check
			var isUnique = await postgres.checkValueUnique('msg_id', dbObj.msg_id, target.msgtable);
			if (!isUnique) {
				result.duplicates++;
				continue;
			}

			// Generate body_html
			var displayText = dbObj.body_text || '';
			try {
				dbObj.body_html = await formatBodyHtml(displayText);
			} catch (e) {
				dbObj.body_html = null;
			}

			// Thread the message
			dbObj = await messages.threadMessage(dbObj, target.msgtable, target.threadtable, target.shorty);

			// Insert
			var dbres = await postgres.insertObject(dbObj, target.msgtable);
			if (dbres.status) {
				result.imported++;
				if (dbres.insertId) result.lastId = dbres.insertId;
			} else {
				result.errors.push('Insert failed for msg #' + msgnum + ': ' + (dbres.errormessages || []).join(', '));
				result.skipped++;
			}
		} catch (err) {
			result.errors.push('Error on msg #' + msgnum + ': ' + err.message);
			result.skipped++;
		}

		// Flush thread stats frequently so subject matching and thread linking
		// see accurate last_message timestamps during the import
		if ((i + 1) % 10 === 0) {
			var pending = messages.drainThreadUpdateArray();
			if (pending.length > 0) {
				await messages.updateThreadArray(pending);
			}
		}

		// Progress logging every 100 messages
		if ((i + 1) % 100 === 0) {
			alogger.writeAlog(4, label + 'Progress: ' + (i + 1) +
				(expected ? '/' + expected : ''), 'cyan');
		}
	}

	// Final flush of any remaining thread updates
	var updatearray = messages.drainThreadUpdateArray();
	if (updatearray.length > 0) {
		await messages.updateThreadArray(updatearray);
	}

	// Update area stats
	await msgAreas.updateAreaStats();

	// Seal the imported history so downstream peers do not receive it as new
	// traffic. Belt and braces alongside source_network_id, which suppresses
	// per message for peers on the originating network.
	if (seal && result.imported > 0) {
		try {
			var sealResult = await peerAreaSubs.advanceOutboundIdxForArea(
				target.area.id, target.shorty, headBefore
			);
			result.sealed = sealResult.updated;
			alogger.writeAlog(2, label + 'Sealed ' + sealResult.updated +
				' subscription(s) at message id ' + sealResult.head, 'cyan');
		} catch (e) {
			result.errors.push('High water mark seal failed: ' + e.message);
		}
	}

	result.status = true;
	alogger.writeAlog(2, label + 'Complete: ' + result.imported + ' imported, ' +
		result.duplicates + ' dupes, ' + result.skipped + ' skipped (of ' + result.total + ')', 'greenbright');

	return result;
}

// Uniform failure result so callers and views see the same shape on every path
function failResult(errors) {
	return {
		status: false,
		imported: 0,
		duplicates: 0,
		skipped: 0,
		errors: errors,
		total: 0,
		lastId: null,
		sealed: null,
	};
}

export { resolveImportTarget, importParsedMessages, stripNulls, failResult };
