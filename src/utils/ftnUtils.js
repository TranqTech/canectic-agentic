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
//   bits 15-0  (16)  shared per-day counter      [65,536/day aggregate]
//
// The **Canectic epoch** is 1980-12-08 UTC. This is deliberately before
// FidoNet (1984) so that the day field can represent any historical FTN
// message base that future import tools might need to synthesize MSGIDs
// for. The day field wraps at 2^16 days = 2160-06-07 UTC, giving 135
// years of forward runway from 2025 and ~180 years of total representable
// span. Also happens to be the project maintainer's birthday, which is
// as good a reason as any for a long-lived constant.
//
// The counter is a **shared pool** across all Canectic processes, held
// as an atomic key in Redis (`msgid:day:<days>`) with a 48-hour TTL so
// old day counters self-expire. INCR is atomic and cross-process-safe,
// so the gateway, mail, mailer, and worker all draw from the same pool
// without coordination.
//
// On process startup (cold start, after Redis flush, or fresh install),
// `initializeMsgidCounter()` scans the outbound message tables for the
// highest serial already in use for the current day bucket and seeds
// Redis from that + a safety margin. This makes the counter resilient
// to Redis state loss without risking collision against already-emitted
// messages.
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

// In-process fallback state. Used only if Redis is unreachable when
// `_nextMsgIdSerial()` is called. Normally initializeMsgidCounter()
// primes Redis at startup and all subsequent calls hit Redis directly.
var _fallbackCounters = {};  // { <days>: <counter> }

// Generate the next MSGID serial for the current day bucket.
// Uses Redis INCR on the shared key; falls back to process-local counter
// (logged as a warning) if Redis is unreachable.
async function _nextMsgIdSerial() {
	var days = _currentDayBucket();
	var key = 'msgid:day:' + days;
	var counter;

	try {
		var redis = await import('../middleware/db/redis.js');
		var client = await redis.getClient();
		counter = await client.incr(key);
		// First INCR of a new day sets the TTL so the key self-expires.
		// 48h gives slack for timezone drift and late-night sessions.
		if (counter === 1) {
			try { await client.expire(key, 172800); } catch (_) {}
		}
	} catch (err) {
		// Redis unreachable -- degrade to in-process counter and log once.
		if (!_fallbackCounters[days]) _fallbackCounters[days] = 0;
		_fallbackCounters[days]++;
		counter = _fallbackCounters[days];
		try {
			alogger.writeAlog(2,
				'[ftnUtils] MSGID Redis unreachable, using process-local ' +
				'fallback counter (day=' + days + ' counter=' + counter + '). ' +
				'Cross-process collisions possible until Redis recovers.',
				'yellowbright');
		} catch (_) {}
	}

	if (counter > 0xFFFF) {
		try {
			alogger.writeAlog(1,
				'[ftnUtils] MSGID counter wrap on day ' + days +
				' (count=' + counter + '). Duplicates possible within ' +
				'this day at downstream systems.',
				'redbright');
		} catch (_) {}
	}

	return _assembleSerial(days, counter & 0xFFFF);
}

// Initialize the MSGID counter for today's day bucket on process startup.
//
// Called once from each bin/*.js entry point after appConfig.load() and
// after the postgres + redis pools are ready. Idempotent across processes
// racing each other: whichever INCR-check lands first wins, the others
// see the existing key and return without scanning.
//
// If Redis has no state for today, scans outbound message tables for the
// highest serial already used in today's day bucket and seeds Redis from
// (max_found + safety_margin). This protects against Redis flush and
// fresh-install scenarios where a naive start-from-zero would collide
// with already-emitted messages.
//
// Safe to call multiple times. Logs a summary line.
async function initializeMsgidCounter() {
	var days = _currentDayBucket();
	var key = 'msgid:day:' + days;

	var client;
	try {
		var redis = await import('../middleware/db/redis.js');
		client = await redis.getClient();
	} catch (err) {
		alogger.writeAlog(2,
			'[ftnUtils] initializeMsgidCounter: Redis unavailable, ' +
			'cannot seed. Will use process-local fallback until Redis ' +
			'recovers. Error: ' + err.message,
			'yellow');
		return { seeded: false, reason: 'redis_unavailable' };
	}

	var existing = await client.get(key);
	if (existing !== null) {
		alogger.writeAlog(3,
			'[ftnUtils] MSGID counter already present for day ' + days +
			' (value=' + existing + '), no seeding needed',
			'cyan');
		return { seeded: false, reason: 'already_present', value: parseInt(existing, 10) };
	}

	// Redis has no state for today. Scan outbound tables to find the
	// highest serial already used. We only care about the low 16 bits
	// (counter half) of serials whose high 16 bits match today's day.
	var postgres = await import('../middleware/db/postgres.js');
	var prefixHex = ((days & 0xFFFF)).toString(16).padStart(4, '0');

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
		// msgAreas not available yet -- skip per-area tables, still
		// scan the central outbound tables.
	}

	var maxCounter = 0;
	var scanned = 0;
	var errors = 0;

	for (var tbl of tables) {
		try {
			// Query the max low-16-bits (counter portion) for rows where
			// the high 16 bits match today's day prefix. The msg_id column
			// is stored as an 8-char hex string; we filter with LIKE and
			// extract the low 4 hex chars as the counter.
			var row = await postgres.queryOne(
				'SELECT MAX(SUBSTRING(msg_id FROM 5 FOR 4)) AS maxc ' +
				'FROM ' + tbl + ' WHERE msg_id LIKE $1',
				[prefixHex + '%']
			);
			if (row && row.maxc) {
				var candidate = parseInt(row.maxc, 16);
				if (!isNaN(candidate) && candidate > maxCounter) {
					maxCounter = candidate;
				}
			}
			scanned++;
		} catch (_) {
			// Table may not exist yet on fresh install, or may have a
			// non-string msg_id column. Skip and count.
			errors++;
		}
	}

	var seed = maxCounter + 100;  // safety margin
	try {
		await client.set(key, seed.toString(), 'EX', 172800);
	} catch (err) {
		alogger.writeAlog(2,
			'[ftnUtils] initializeMsgidCounter: failed to seed Redis ' +
			'(day=' + days + '): ' + err.message,
			'redbright');
		return { seeded: false, reason: 'redis_write_failed' };
	}

	alogger.writeAlog(2,
		'[ftnUtils] MSGID counter seeded from DB scan: day=' + days +
		' max_found=' + maxCounter + ' seed=' + seed +
		' tables_scanned=' + scanned +
		(errors > 0 ? ' tables_errored=' + errors : ''),
		'greenbright');

	return { seeded: true, days: days, maxFound: maxCounter, seed: seed, scanned: scanned };
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

async function getSystemTime(dtstring, TZString){
	var stString = ""
	var dtarray = dtstring.split(" ")
	var yearstring = "20"
	if (parseInt(dtarray[2]) > 80){
		yearstring = "19"
	}
	yearstring += dtarray[2]
	var monthnum = getMonthNumberFromDate(dtarray[1])
	stString += yearstring + "-" + monthnum + "-" + dtarray[0] + "T" + dtarray[4] + ".000Z"
	var systemTime = new Date(stString)
	//console.log("Converting", systemTime, "With Offset", TZString)
	if ((TZString)&&(TZString != "")){
		//adjust systemtime for tzutc
		var adjustmins = 0
		var direction = "Subtract"
		var hourstring = ""
		var minutestring = ""
		if (TZString.startsWith("-")){
			direction = "Add"
			hourstring = TZString.substring(1,3)
			minutestring = TZString.substring(3,5)
		}else{
			hourstring = TZString.substring(0,2)
			minutestring = TZString.substring(2,4)
		}
		adjustmins += (parseInt(hourstring)*60)
		adjustmins += (parseInt(minutestring))
		if (direction == "Add"){
			systemTime.setMinutes(systemTime.getMinutes() + adjustmins);
		}else if (direction == "Subtract"){
			systemTime.setMinutes(systemTime.getMinutes() - adjustmins);
		}		
	}
	console.log(systemTime)
	return systemTime
}

export{
	getDateTimeString,
	genMsgId,
	getMilliHex,
	getSystemTime,
	initializeMsgidCounter,
	parseSerial,
	dayBucketForDate,
	CANECTIC_EPOCH_MS
}