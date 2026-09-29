// charsetRepair.js -- repair text stored as mojibake: UTF-8 that was read as
// CP437 (#57).
//
// Until 751b1ea any FTN message without a CHRS kludge was read as CP437, and
// every JAM import was, so UTF-8 from software that did not declare it was
// stored as its CP437 reading: U+2019 as "ΓÇÖ", "Jörg" as "J├╢rg", Cyrillic
// and Hebrew as runs of box drawing. About 18,000 messages on the hub and the
// dev board each, back to 2019.
//
// The damage is exactly reversible: map each character back to its CP437
// byte and decode the bytes as UTF-8. The only question is WHICH text is
// damaged, and the answer is the inbound rule (charsetPolicy.looksLikeUtf8)
// applied to the WHOLE value: every character must be one CP437 can hold,
// and the resulting bytes must be valid UTF-8 with a multi-byte sequence.
// Genuine CP437 text fails as a whole (one lone accented letter or box run is
// enough), even where a fragment such as █░ would pass. Testing fragments
// instead flagged 10,619 art messages on the hub; the whole-value test, 129,
// and those sampled were real damage. A value mixing correct text with damage
// is left alone: repairing part of it would be guessing.
//
// Each changed value is saved in charset_repairs first, so revertRepairs puts
// it back exactly. A repaired body gets its body_html re-rendered.

import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';
import { cp437BufferToUtf8 } from '../utils/codepageConversions.js';
import { looksLikeUtf8 } from '../utils/charsetPolicy.js';

var FIELDS = ['body_text', 'subject', 'from_user', 'to_user'];
var SAMPLE_IDS = 5;

var toCp437 = null;
function reverseTable() {
	if (toCp437) return toCp437;
	toCp437 = new Map();
	for (var b = 128; b < 256; b++) toCp437.set(cp437BufferToUtf8(Buffer.from([b])), b);
	return toCp437;
}

/**
 * The repaired form of one stored value, or null when it is not UTF-8 read as
 * CP437 (including when it is plain ASCII, or mixes in characters CP437 has
 * no byte for).
 */
function repairText(value) {
	if (typeof value !== 'string' || !/[^\x00-\x7f]/.test(value)) return null;
	var table = reverseTable();
	var bytes = [];
	for (var ch of value) {
		var c = ch.codePointAt(0);
		if (c < 0x80) { bytes.push(c); continue; }
		var b = table.get(ch);
		if (b === undefined) return null;
		bytes.push(b);
	}
	var buf = Buffer.from(bytes);
	if (!looksLikeUtf8(buf)) return null;
	var out = buf.toString('utf8');
	return out === value ? null : out;
}

// Which tables a run may touch: per-area message tables and the two PM
// tables. The names are interpolated into SQL, so they are checked here.
function assertRepairableTable(table) {
	if (!/^mb_[a-z0-9_]+_msgs$/.test(table) && table !== 'pm_inbox' && table !== 'pm_outbox') {
		throw new Error('not a table charset repair may touch: ' + table);
	}
}

/**
 * Repair one table.
 *
 * opts: { dryRun, batchSize, signal, formatBodyHtml (for tests) }
 * returns { table, scanned, repaired, fields: {field: n}, replacementChars,
 *           sampleIds }
 *   replacementChars: repaired rows whose text still holds U+FFFD, meaning
 *   the sender had already destroyed it; decoded faithfully, still unreadable.
 */
async function repairTable(table, opts) {
	assertRepairableTable(table);
	var o = opts || {};
	var batchSize = o.batchSize || 500;
	var format = o.formatBodyHtml || (await import('../utils/terminalText.js')).formatBodyHtml;
	var result = { table: table, scanned: 0, repaired: 0, fields: {}, replacementChars: 0, sampleIds: [] };

	var cols = (await postgres.query(
		"SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1", [table]) || [])
		.map(function (r) { return r.column_name; });
	var fields = FIELDS.filter(function (f) { return cols.indexOf(f) !== -1; });
	var hasHtml = cols.indexOf('body_html') !== -1;
	if (!fields.length) return result;

	var lastId = 0;
	for (;;) {
		// Rows are independent, so any batch boundary is a clean stop (#85).
		if (o.signal) o.signal.throwIfAborted();
		var rows = await postgres.query(
			'SELECT id, ' + fields.join(', ') + ' FROM ' + table +
			' WHERE id > $1 ORDER BY id LIMIT $2', [lastId, batchSize]);
		if (!rows || rows.length === 0) break;

		for (var row of rows) {
			lastId = row.id;
			result.scanned++;
			var changes = {};
			for (var f of fields) {
				var fixed = repairText(row[f]);
				if (fixed !== null) changes[f] = fixed;
			}
			var names = Object.keys(changes);
			if (!names.length) continue;

			result.repaired++;
			for (var n of names) result.fields[n] = (result.fields[n] || 0) + 1;
			if (names.some(function (k) { return changes[k].indexOf('�') !== -1; })) result.replacementChars++;
			if (result.sampleIds.length < SAMPLE_IDS) result.sampleIds.push(row.id);
			if (o.dryRun) continue;

			// Old values first: if the update then fails, the record of what
			// was there is still right, and a revert restores it unchanged.
			for (var name of names) {
				var err = await postgres.write(
					'INSERT INTO charset_repairs (table_name, row_id, field, old_value, repaired_at) VALUES ($1, $2, $3, $4, NOW())',
					[table, row.id, name, row[name]]);
				if (err) throw new Error('could not record the old ' + name + ' of ' + table + ' #' + row.id + ': ' + err.message);
			}
			var sets = [], params = [];
			for (var k of names) { params.push(changes[k]); sets.push(k + ' = $' + params.length); }
			if (changes.body_text !== undefined && hasHtml) {
				var html = null;
				try { html = await format(changes.body_text); } catch (_) { html = null; }
				if (html !== null) { params.push(html); sets.push('body_html = $' + params.length); }
			}
			params.push(row.id);
			var uerr = await postgres.write('UPDATE ' + table + ' SET ' + sets.join(', ') + ' WHERE id = $' + params.length, params);
			if (uerr) throw new Error('could not repair ' + table + ' #' + row.id + ': ' + uerr.message);
		}
	}

	if (result.repaired) {
		alogger.writeAlog(3, '[CharsetRepair] ' + table + ': ' + (o.dryRun ? 'would repair ' : 'repaired ') +
			result.repaired + ' of ' + result.scanned + ' message(s)', 'cyan');
	}
	return result;
}

/**
 * Put back what repairTable changed in one table, newest repair first, and
 * re-render body_html where a body is restored. Returns the number of values
 * restored.
 */
async function revertTable(table, opts) {
	assertRepairableTable(table);
	var o = opts || {};
	var format = o.formatBodyHtml || (await import('../utils/terminalText.js')).formatBodyHtml;
	var rows = await postgres.query(
		'SELECT id, row_id, field, old_value FROM charset_repairs WHERE table_name = $1 AND reverted_at IS NULL ORDER BY id DESC',
		[table]) || [];
	var hasHtml = !!(await postgres.queryOne(
		"SELECT 1 AS x FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'body_html'", [table]));
	var restored = 0;
	for (var r of rows) {
		if (FIELDS.indexOf(r.field) === -1) continue;
		var sets = r.field + ' = $1', params = [r.old_value];
		if (r.field === 'body_text' && hasHtml) {
			var html = null;
			try { html = await format(r.old_value); } catch (_) { html = null; }
			if (html !== null) { params.push(html); sets += ', body_html = $2'; }
		}
		params.push(r.row_id);
		var err = await postgres.write('UPDATE ' + table + ' SET ' + sets + ' WHERE id = $' + params.length, params);
		if (err) throw new Error('could not revert ' + table + ' #' + r.row_id + ': ' + err.message);
		await postgres.write('UPDATE charset_repairs SET reverted_at = NOW() WHERE id = $1', [r.id]);
		restored++;
	}
	return restored;
}

export { repairText, repairTable, revertTable, assertRepairableTable, FIELDS };
