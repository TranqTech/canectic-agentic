import { DateTime } from "luxon";
import * as alogger from './alogger.js';

async function getDateTimeString(){
	var militime = await Date.now()
	var timestring = DateTime.fromMillis(militime).toFormat('dd LLL yy  HH:mm:ss')
	return timestring
}

// =========================================================================
// MSGID serial generation (FTS-0009)
//
// FTS-0009 specifies the MSGID serial as "any eight character hexadecimal
// string" -- a 32-bit value written as exactly 8 hex characters. Canectic
// lays out those 32 bits as:
//
//   bits 31-16 (16)  days since Canectic epoch   [179-year horizon]
//   bits 15-0  (16)  per-day counter             [65,536/day aggregate]
//
// The **Canectic epoch** is 1980-12-08 UTC. This is deliberately before
// FidoNet (1984) so that the day field can represent any historical FTN
// message base that import tools need to synthesize MSGIDs for. The day
// field wraps at 2^16 days = 2160-06-07 UTC, giving 135 years of forward
// runway from 2025 and ~180 years of total representable span. Also
// happens to be the project maintainer's birthday, which is as good a
// reason as any for a long-lived constant.
//
// The counter is held in the `msgid_day_watermark` Postgres table, one
// row per day-bucket that has generated messages. Every serial allocation
// is a single atomic UPSERT:
//
//   INSERT INTO msgid_day_watermark (day_bucket, max_counter, message_count)
//   VALUES ($1, 1, 1)
//   ON CONFLICT (day_bucket) DO UPDATE SET
//     max_counter   = msgid_day_watermark.max_counter + 1,
//     message_count = msgid_day_watermark.message_count + 1,
//     updated_at    = NOW()
//   RETURNING max_counter
//
// Postgres handles multi-process atomicity natively, so gateway, mail,
// mailer, and worker can all allocate concurrently without a separate
// coordination layer. No Redis dependency in this path; no TTL; no
// dual-source-of-truth. Historical imports use the exact same allocator
// with a day-bucket override (see allocateHistoricalSerial below).
//
// The serial IS NOT address-scoped. Canectic's storage splits the MSGID
// into (serial, origin_address) as separate columns at the DB level, so
// cross-network dupe detection and cross-address cross-posts can be
// reasoned about via the serial alone while the outbound kludge still
// pairs it with the correct origin address for the target network.
// =========================================================================

// Dec 8, 1980 00:00:00 UTC. Month is 0-indexed in Date.UTC so 11 = December.
var CANECTIC_EPOCH_MS = Date.UTC(1980, 11, 8);

// Milliseconds in a day, named for clarity.
var MS_PER_DAY = 86400000;

// Current day-bucket (low 16 bits of days-since-Canectic-epoch).
function _currentDayBucket() {
	var delta = Date.now() - CANECTIC_EPOCH_MS;
	if (delta < 0) delta = 0;  // clamp pre-epoch to day 0
	return Math.floor(delta / MS_PER_DAY) & 0xFFFF;
}

// Compute the Canectic-epoch day bucket for a given Date or timestamp.
// Used by import tools to synthesize MSGIDs for messages with original
// timestamps before the current run.
function dayBucketForDate(dateOrMs) {
	var ms = (dateOrMs instanceof Date) ? dateOrMs.getTime() : Number(dateOrMs);
	if (!isFinite(ms)) return 0;
	var delta = ms - CANECTIC_EPOCH_MS;
	if (delta < 0) return 0;
	return Math.floor(delta / MS_PER_DAY) & 0xFFFF;
}

// Assemble a full 32-bit msg_id serial from day and counter components.
// Returns the 8-character hex string.
function _assembleSerial(days, counter) {
	var value = (((days & 0xFFFF) << 16) | (counter & 0xFFFF)) >>> 0;
	return value.toString(16).padStart(8, '0');
}

// Split a full FTS-0009 MSGID string ("address serial") into its two
// components for the Canectic tuple storage model. The address is
// everything before the first space; the serial is everything after.
//
//   splitFullMsgid("1:134/101 abcdef01")
//     → { msg_orig_addr: "1:134/101", msg_id: "abcdef01" }
//
// Edge cases:
//   - null/empty input          → { msg_orig_addr: "", msg_id: "" }
//   - no space (just serial)    → { msg_orig_addr: "", msg_id: <input> }
//   - multiple spaces           → first token = addr, rest joined = serial
//     (defensive for malformed inbound; the address portion never has
//     spaces in valid FTN, so anything weird goes into the serial half)
function splitFullMsgid(fullMsgid) {
	if (!fullMsgid || typeof fullMsgid !== 'string') {
		return { msg_orig_addr: '', msg_id: '' };
	}
	var trimmed = fullMsgid.trim();
	if (!trimmed) return { msg_orig_addr: '', msg_id: '' };
	var spaceIdx = trimmed.indexOf(' ');
	if (spaceIdx === -1) {
		// No address prefix -- treat the whole thing as the serial.
		return { msg_orig_addr: '', msg_id: trimmed };
	}
	return {
		msg_orig_addr: trimmed.substring(0, spaceIdx),
		msg_id: trimmed.substring(spaceIdx + 1).trim()
	};
}

// Reassemble a full "address serial" MSGID string from the tuple columns.
// Used when reading from the DB tuple format and producing an output
// that expects the legacy full string format (FTN kludge lines, in-memory
// message objects, etc.).
//
//   joinMsgidTuple("1:134/101", "abcdef01")  → "1:134/101 abcdef01"
//   joinMsgidTuple("",           "abcdef01")  → "abcdef01"
//   joinMsgidTuple("1:134/101", "")          → ""
//   joinMsgidTuple(null, null)               → ""
function joinMsgidTuple(origAddr, serial) {
	if (!serial) return '';
	if (!origAddr) return serial;
	return origAddr + ' ' + serial;
}

// Parse an 8-char hex serial into {days, counter}. Returns null on
// malformed input. Used by the startup re-check and by import tools
// that need to interrogate stored serials.
function parseSerial(hexString) {
	if (!hexString || typeof hexString !== 'string') return null;
	var trimmed = hexString.trim().toLowerCase();
	if (!/^[0-9a-f]{8}$/.test(trimmed)) return null;
	var value = parseInt(trimmed, 16);
	return {
		days: (value >>> 16) & 0xFFFF,
		counter: value & 0xFFFF
	};
}

// Generate the next MSGID serial using the msgid_day_watermark table as
// the atomic counter. Single Postgres UPSERT per allocation; Postgres
// handles cross-process coordination natively.
//
// dayOverride (optional): force allocation for a specific day bucket,
// used by allocateHistoricalSerial for historical imports. Omit for
// normal live allocation on today's day.
//
// sourceTag (optional): the `source` column value when creating a new
// watermark row. Defaults to 'live'. Import tools should pass
// 'import_<label>' to distinguish imported-day watermarks from live ones.
async function _nextMsgIdSerial(dayOverride, sourceTag) {
	var days = (dayOverride !== undefined && dayOverride !== null)
		? (dayOverride & 0xFFFF)
		: _currentDayBucket();
	var source = sourceTag || 'live';

	var postgres = await import('../middleware/db/postgres.js');

	// Atomic allocation: INSERT-or-UPDATE with RETURNING gives us the
	// new max_counter value in a single roundtrip. Postgres row-level
	// locking on the conflict target guarantees no two concurrent
	// callers get the same counter value.
	var row;
	try {
		row = await postgres.queryOne(
			'INSERT INTO msgid_day_watermark (day_bucket, max_counter, message_count, source) ' +
			'VALUES ($1, 1, 1, $2) ' +
			'ON CONFLICT (day_bucket) DO UPDATE SET ' +
			'  max_counter = msgid_day_watermark.max_counter + 1, ' +
			'  message_count = msgid_day_watermark.message_count + 1, ' +
			'  updated_at = NOW() ' +
			'RETURNING max_counter',
			[days, source]
		);
	} catch (err) {
		alogger.writeAlog(1,
			'[ftnUtils] MSGID allocation failed for day ' + days + ': ' +
			err.message + '. Falling back to timestamp-only serial (may ' +
			'not be unique). Database recovery required.',
			'redbright');
		// Last-resort fallback: combine day bits with a timestamp-derived
		// sub-day fraction. This produces an 8-char serial but offers no
		// uniqueness guarantees. The sysop needs to fix the DB; this just
		// prevents outbound message composition from hard-failing.
		var msFraction = Date.now() & 0xFFFF;
		return _assembleSerial(days, msFraction);
	}

	var counter = row && row.max_counter ? row.max_counter : 1;

	if (counter > 0xFFFF) {
		alogger.writeAlog(1,
			'[ftnUtils] MSGID counter wrap on day ' + days +
			' (count=' + counter + '). Duplicates possible within ' +
			'this day at downstream systems.',
			'redbright');
	}

	return _assembleSerial(days, counter & 0xFFFF);
}

// Ensure the msgid_day_watermark table is ready and, on first deployment,
// backfill it from existing outbound messages.
//
// Called once from each bin/*.js entry point after appConfig.load() and
// after Postgres is ready. Idempotent: if the table already has rows,
// returns immediately. If the table is empty but outbound tables contain
// messages, runs a one-time scan to populate historical day watermarks
// from the highest serial already used per day.
//
// The backfill only considers rows where `msg_id` is exactly 8 hex
// characters (the current post-Phase-1 format). Legacy 11+ char msg_ids
// from the pre-e8f6518 buggy scheme are ignored -- they aren't parseable
// into the Canectic day/counter layout, and historical counts on those
// days can't be reconstructed meaningfully. In practice there aren't
// many locally-generated legacy MSGIDs so this loses very little.
//
// Returns { seeded, backfilled, days_populated, total_counter } for
// diagnostics.
async function initializeMsgidCounter() {
	var postgres = await import('../middleware/db/postgres.js');

	// Ensure table exists. Normally the migration runner creates it
	// from the .conf file, but we guard here in case someone runs a
	// process without having run migrations first.
	try {
		await postgres.write(
			'CREATE TABLE IF NOT EXISTS msgid_day_watermark (' +
			'  id BIGSERIAL PRIMARY KEY, ' +
			'  day_bucket INTEGER UNIQUE NOT NULL, ' +
			'  max_counter INTEGER NOT NULL DEFAULT 0, ' +
			'  message_count INTEGER NOT NULL DEFAULT 0, ' +
			'  source VARCHAR(32) NOT NULL DEFAULT \'live\', ' +
			'  first_seen TIMESTAMPTZ DEFAULT NOW(), ' +
			'  updated_at TIMESTAMPTZ DEFAULT NOW()' +
			')'
		);
	} catch (err) {
		alogger.writeAlog(2,
			'[ftnUtils] initializeMsgidCounter: table ensure failed: ' +
			err.message + ' (may already exist)',
			'yellow');
	}

	// Short-circuit if table already has rows -- we're live, no backfill
	// needed.
	var countRow;
	try {
		countRow = await postgres.queryOne('SELECT COUNT(*) AS c FROM msgid_day_watermark');
	} catch (err) {
		alogger.writeAlog(2,
			'[ftnUtils] initializeMsgidCounter: count query failed: ' +
			err.message,
			'yellow');
		return { seeded: false, reason: 'count_failed' };
	}

	var existingCount = countRow ? parseInt(countRow.c, 10) : 0;
	if (existingCount > 0) {
		alogger.writeAlog(3,
			'[ftnUtils] msgid_day_watermark has ' + existingCount +
			' day(s) of history, no backfill needed',
			'cyan');
		return { seeded: false, reason: 'already_populated', days: existingCount };
	}

	// Table is empty. Scan outbound tables for current-format (8-char)
	// msg_ids grouped by day-prefix, inserting one row per day with the
	// highest counter found.
	var tables = ['netmail_out', 'pm_outbox'];
	try {
		var msgAreas = await import('../models/msgAreas.js');
		if (typeof msgAreas.getAllShortcodes === 'function') {
			var codes = await msgAreas.getAllShortcodes();
			for (var sc of (codes || [])) {
				tables.push('mb_' + sc.toLowerCase() + '_msgs');
			}
		}
	} catch (_) {
		// Area list not available yet -- backfill from central tables only.
	}

	// Aggregate: day_bucket -> { max_counter, message_count }
	var aggregate = {};
	var scanned = 0;
	var errors = 0;

	for (var tbl of tables) {
		try {
			// Group by high 4 hex chars (day), MAX the low 4 hex chars
			// (counter), COUNT the rows. Only current-format 8-char rows.
			var rows = await postgres.query(
				'SELECT ' +
				'  SUBSTRING(msg_id FROM 1 FOR 4) AS day_hex, ' +
				'  MAX(SUBSTRING(msg_id FROM 5 FOR 4)) AS max_counter_hex, ' +
				'  COUNT(*) AS cnt ' +
				'FROM ' + tbl + ' ' +
				'WHERE msg_id ~ \'^[0-9a-fA-F]{8}$\' ' +
				'GROUP BY SUBSTRING(msg_id FROM 1 FOR 4)'
			);
			for (var r of (rows || [])) {
				var dayBucket = parseInt(r.day_hex, 16);
				var maxc = parseInt(r.max_counter_hex, 16);
				var cnt = parseInt(r.cnt, 10);
				if (isNaN(dayBucket) || isNaN(maxc)) continue;
				if (!aggregate[dayBucket]) {
					aggregate[dayBucket] = { max_counter: 0, message_count: 0 };
				}
				if (maxc > aggregate[dayBucket].max_counter) {
					aggregate[dayBucket].max_counter = maxc;
				}
				aggregate[dayBucket].message_count += cnt;
			}
			scanned++;
		} catch (_) {
			errors++;
		}
	}

	// Insert one row per aggregated day
	var inserted = 0;
	var totalMessages = 0;
	for (var dayBucket in aggregate) {
		var agg = aggregate[dayBucket];
		try {
			await postgres.write(
				'INSERT INTO msgid_day_watermark ' +
				'  (day_bucket, max_counter, message_count, source) ' +
				'VALUES ($1, $2, $3, $4) ' +
				'ON CONFLICT (day_bucket) DO UPDATE SET ' +
				'  max_counter = GREATEST(msgid_day_watermark.max_counter, $2), ' +
				'  message_count = msgid_day_watermark.message_count + $3, ' +
				'  updated_at = NOW()',
				[parseInt(dayBucket, 10), agg.max_counter, agg.message_count, 'backfill']
			);
			inserted++;
			totalMessages += agg.message_count;
		} catch (err) {
			alogger.writeAlog(2,
				'[ftnUtils] backfill: failed to insert day ' + dayBucket +
				': ' + err.message,
				'yellow');
		}
	}

	if (inserted > 0) {
		alogger.writeAlog(2,
			'[ftnUtils] MSGID watermark backfilled from ' + scanned +
			' table(s): ' + inserted + ' day(s), ' + totalMessages +
			' total messages tracked' +
			(errors > 0 ? ' (' + errors + ' table(s) errored)' : ''),
			'greenbright');
	} else {
		alogger.writeAlog(3,
			'[ftnUtils] MSGID watermark: no current-format msg_ids found ' +
			'to backfill (fresh install or legacy-only data)',
			'cyan');
	}

	return {
		seeded: inserted > 0,
		days_populated: inserted,
		total_messages: totalMessages,
		tables_scanned: scanned,
		errors: errors
	};
}

// Look up the current high-water counter for a given day bucket.
// Returns the max_counter or 0 if no row exists. Used by import tools
// and diagnostics. Does NOT allocate a new serial.
async function getWatermarkForDay(dayBucket) {
	var postgres = await import('../middleware/db/postgres.js');
	var row = await postgres.queryOne(
		'SELECT max_counter, message_count, source FROM msgid_day_watermark WHERE day_bucket = $1',
		[dayBucket & 0xFFFF]
	);
	if (!row) return { max_counter: 0, message_count: 0, source: null };
	return {
		max_counter: row.max_counter,
		message_count: row.message_count,
		source: row.source
	};
}

// Allocate a MSGID serial for a historical message. Takes the message's
// original Date (or millisecond timestamp) and an optional source tag
// to mark the watermark row's provenance. The day bucket is derived
// from the timestamp via dayBucketForDate, clamping pre-epoch messages
// to day 0.
//
// Returns the 8-character hex serial. Concurrent calls from multiple
// import processes are serialized by Postgres row-level locking on
// the watermark upsert.
async function allocateHistoricalSerial(originalDate, sourceTag) {
	var days = dayBucketForDate(originalDate);
	return await _nextMsgIdSerial(days, sourceTag || 'import');
}

// FTS-0009 MSGID serial: exactly 8 hex characters. Used by `netmail.js`
// when stamping outbound netmail with an @MSGID kludge.
async function genMsgId() {
	return await _nextMsgIdSerial();
}

// FTS-0009 MSGID serial: exactly 8 hex characters. Used by `messages.js`
// when stamping outbound echomail on new threads and replies.
async function getMilliHex() {
	return await _nextMsgIdSerial();
}

function getMonthNumberFromDate(monthAbbreviation) {
  // Create a Date object with a dummy day and year to parse the month
  const date = new Date(`${monthAbbreviation} 1, 2000`);
  return String(date.getMonth() + 1).padStart(2, '0');; // Add 1 because getMonth() is zero-indexed
}

/**
 * Reject a message date that cannot be true.
 *
 * A message dated years in the future is not a clock-skew problem, it is bad
 * data, and it does real damage downstream: the area's last_message pins it to
 * the top of any "recently active" ordering forever, retention never prunes it
 * because it is permanently inside any window, and the list column shows a
 * plausible-looking day.
 *
 * Seen in practice: ten messages in a COOKING base carrying 2060 dates whose
 * MSGIDs decode to 2024. They arrived that way from upstream, every one of them
 * congruent to 16 seconds mod 60, so a systematic corruption at the source
 * rather than a wrong clock. Nothing downstream of the ingest point can tell
 * the difference afterwards, so the check belongs here.
 *
 * Modest future tolerance is deliberate. Clock skew of minutes or hours between
 * systems is completely normal in FTN and a message an hour ahead is not
 * suspect. Years ahead is.
 *
 * @param {Date}   candidate    the parsed message date
 * @param {Date}   [receivedAt] fallback, defaults to now
 * @param {object} [opts]
 * @param {number} [opts.futureToleranceDays] default 2
 * @param {number} [opts.earliestYear]        default 1980, before FTN existed
 * @returns {object} { date, clamped, reason }
 */
function sanitiseMessageDate(candidate, receivedAt, opts) {
	opts = opts || {};
	var fallback = receivedAt instanceof Date && !isNaN(receivedAt.getTime())
		? receivedAt : new Date();

	if (!(candidate instanceof Date) || isNaN(candidate.getTime())) {
		return { date: fallback, clamped: true, reason: 'unparseable date' };
	}

	var toleranceDays = opts.futureToleranceDays === undefined ? 2 : opts.futureToleranceDays;
	var limit = fallback.getTime() + (toleranceDays * 86400000);
	if (candidate.getTime() > limit) {
		return {
			date: fallback,
			clamped: true,
			reason: 'dated ' + candidate.toISOString().substring(0, 10) + ', more than ' +
				toleranceDays + ' day(s) in the future'
		};
	}

	var earliestYear = opts.earliestYear === undefined ? 1980 : opts.earliestYear;
	if (candidate.getUTCFullYear() < earliestYear) {
		return {
			date: fallback,
			clamped: true,
			reason: 'dated ' + candidate.toISOString().substring(0, 10) + ', before ' + earliestYear
		};
	}

	return { date: candidate, clamped: false, reason: null };
}

async function getSystemTime(dtstring, TZString){
	// FTS-0001 DateTime is "DD MMM YY  HH:MM:SS" (two spaces before time).
	// Malformed or missing dates from ancient/broken tossers must not abort
	// the whole packet — fall back to current time (long-standing FTN
	// practice) so the message imports with a slightly wrong timestamp
	// instead of poisoning the toss with an Invalid Date that Postgres
	// then rejects as "0NaN-NaN-NaN...".
	if (!dtstring || typeof dtstring !== 'string') {
		return new Date();
	}
	var dtarray = dtstring.trim().split(/\s+/);
	if (dtarray.length < 4) {
		return new Date();
	}
	var day    = dtarray[0];
	var mon    = dtarray[1];
	var yy     = dtarray[2];
	var hms    = dtarray[3];  // trim+split(/\s+/) collapses the double space
	var yyInt  = parseInt(yy, 10);
	if (!/^\d{1,2}$/.test(day) || !/^\d{1,2}:\d{2}:\d{2}$/.test(hms) || isNaN(yyInt)) {
		return new Date();
	}
	var yearstring = (yyInt > 80 ? "19" : "20") + yy.padStart(2, '0');
	var monthnum   = getMonthNumberFromDate(mon);
	if (monthnum === 'NaN') {
		return new Date();
	}
	var stString   = yearstring + "-" + monthnum + "-" + day.padStart(2, '0') + "T" + hms + ".000Z";
	var systemTime = new Date(stString);
	if (isNaN(systemTime.getTime())) {
		return new Date();
	}
	if (TZString && TZString !== "" && /^[+-]?\d{4}$/.test(TZString)) {
		//adjust systemtime for tzutc
		var direction = "Subtract";
		var hourstring, minutestring;
		if (TZString.startsWith("-")){
			direction = "Add";
			hourstring   = TZString.substring(1,3);
			minutestring = TZString.substring(3,5);
		}else{
			var offset = TZString.startsWith("+") ? TZString.substring(1) : TZString;
			hourstring   = offset.substring(0,2);
			minutestring = offset.substring(2,4);
		}
		var adjustmins = (parseInt(hourstring, 10) * 60) + parseInt(minutestring, 10);
		if (!isNaN(adjustmins)) {
			if (direction == "Add"){
				systemTime.setMinutes(systemTime.getMinutes() + adjustmins);
			}else{
				systemTime.setMinutes(systemTime.getMinutes() - adjustmins);
			}
		}
	}
	return systemTime;
}

/**
 * Normalise stored optional_attributes back into { attribute, value } objects.
 *
 * The column is text[], and each element goes in as a JSON STRING. Read back
 * it is still a string, so `attr.attribute` is undefined — and the outbound
 * tosser does exactly that, writing `\x01undefined: ` for every kludge it was
 * asked to carry. A packet captured off the wire had 772 of them across 157
 * messages, with CHRS gone entirely and REPLY surviving on 10.
 *
 * Nothing failed. The packet is well formed, the messages arrive, and the
 * receiving system simply never learns the charset or the reply linkage. That
 * is why this parses on READ rather than fixing the write alone: every row
 * already stored is in the string form, and they have to keep working.
 *
 * Accepts objects too, so a caller that already has the right shape, or a row
 * written after the write side is cleaned up, passes through untouched.
 */
function parseOptionalAttributes(stored) {
	var out = [];

	// A kludge literally named "undefined" with no value is not a kludge, it
	// is the scar this bug leaves: an earlier hop read the strings as objects,
	// got undefined for both halves, and wrote `\x01undefined: ` into the
	// packet. Carrying those forward would spread damage we can no longer
	// undo, so they are dropped rather than relayed.
	var damaged = function (name, value) {
		return String(name).toLowerCase() === 'undefined' && String(value == null ? '' : value).trim() === '';
	};

	for (var entry of (stored || [])) {
		if (!entry) continue;

		if (typeof entry === 'object') {
			if (entry.attribute && !damaged(entry.attribute, entry.value)) {
				out.push({ attribute: entry.attribute, value: entry.value == null ? '' : entry.value });
			}
			continue;
		}

		if (typeof entry !== 'string') continue;

		var text = entry.trim();
		if (text.startsWith('{')) {
			try {
				var parsed = JSON.parse(text);
				if (parsed && parsed.attribute) {
					if (!damaged(parsed.attribute, parsed.value)) {
						out.push({ attribute: parsed.attribute, value: parsed.value == null ? '' : parsed.value });
					}
					continue;
				}
			} catch (_) { /* fall through to the kludge-text reading below */ }
		}

		// A bare kludge line, with or without the leading SOH. Tolerated so a
		// hand-written row or another writer's format is not silently dropped.
		var line = text.replace(/^\x01/, '');
		var colon = line.indexOf(':');
		if (colon > 0) {
			var name = line.substring(0, colon).trim();
			var val  = line.substring(colon + 1).trim();
			if (!damaged(name, val)) out.push({ attribute: name, value: val });
		}
	}
	return out;
}

/**
 * Which character set a message body declares, per FTS-5003.
 *
 * The CHRS kludge lives inside the message text as a control line, so this
 * takes the raw bytes and reads it out before anything decides how to decode
 * them. Identifiers are ASCII, so a latin1 scan is safe whatever the body is.
 *
 * FTN's default is CP437 when nothing is declared, and that default is what
 * the ecosystem actually runs on: of 113,079 messages held here, 163 carry a
 * CHRS at all. So "absent" means CP437, not "unknown".
 *
 * Returns one of 'utf8', 'latin1', 'cp437'.
 */
function charsetFromKludge(bytes) {
	if (!bytes || !bytes.length) return 'cp437';

	var text = Buffer.isBuffer(bytes) ? bytes.toString('latin1') : String(bytes);
	var m = /\x01CHRS:?\s*([A-Za-z0-9-]+)/i.exec(text);
	if (!m) return 'cp437';

	var id = m[1].toUpperCase();
	if (id === 'UTF-8' || id === 'UTF8') return 'utf8';
	if (id === 'LATIN-1' || id === 'LATIN1' || id === 'ISO-8859-1') return 'latin1';
	// CP437, IBMPC, ASCII and anything unrecognised all decode through the
	// CP437 table. ASCII is a strict subset of it, so that is lossless, and an
	// unknown identifier is better served by the ecosystem default than by a
	// guess.
	return 'cp437';
}

/**
 * The CHRS value to declare for a charset we are about to write.
 * Levels are from FTS-5003: 2 for an 8-bit single-byte set, 4 for UTF-8.
 */
function chrsValueFor(charset) {
	if (charset === 'utf8') return 'UTF-8 4';
	if (charset === 'latin1') return 'LATIN-1 2';
	return 'CP437 2';
}

export{
	parseOptionalAttributes,
	charsetFromKludge,
	chrsValueFor,
	sanitiseMessageDate,
	getDateTimeString,
	genMsgId,
	getMilliHex,
	getSystemTime,
	initializeMsgidCounter,
	getWatermarkForDay,
	allocateHistoricalSerial,
	parseSerial,
	dayBucketForDate,
	splitFullMsgid,
	joinMsgidTuple,
	CANECTIC_EPOCH_MS
}