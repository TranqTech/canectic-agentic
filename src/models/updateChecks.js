// updateChecks.js -- the history of "is there a newer Canectic".
//
// One row per check, whether it found anything or not, because the two
// questions a sysop has are "what is available" and "is this thing even
// running". A page that shows only the last result cannot tell a check that
// found nothing from a check that never happened, and the second is the failure
// worth seeing: an opt-in daily job that silently stopped looks exactly like a
// project that stopped releasing.
//
// Errors are recorded as rows too. A month of "could not resolve the index" is
// the answer to why no update was ever offered.
//
// Diagnostic only. Nothing reads this to decide anything, and a failed insert
// is swallowed rather than failing the check, on the same principle as
// mailerSessions and netmailRelayLog: the record of the work must never be able
// to stop the work.

import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';

var SOURCE_SCHEDULE = 'schedule';   // the daily job
var SOURCE_MANUAL   = 'manual';     // a sysop pressed Check now

function trunc(v, n) {
	if (v === null || v === undefined) return null;
	var s = String(v);
	return s.length > n ? s.substring(0, n) : s;
}

/**
 * Record one check. Returns the row id, or null when the write failed.
 *
 * `result` is the whole per-channel evaluation, stored so the admin page can
 * render what was found without going back to the network. postgres.insertObject
 * reports a failed write in its return value rather than throwing, so ignoring
 * it would make a broken log silent.
 */
async function record(entry) {
	var e = entry || {};
	var best = (e.result && e.result.best) || null;
	try {
		var res = await postgres.insertObject({
			checked_at:        e.checkedAt || new Date(),
			source:            trunc(e.source || SOURCE_SCHEDULE, 16),
			channel:           trunc(e.channel, 16),
			current_version:   trunc(e.current, 64),
			verdict:           trunc(e.verdict || (best ? best.verdict : 'current'), 16),
			available_version: trunc(best ? best.available : null, 64),
			available_channel: trunc(best ? best.channel : null, 16),
			result:            e.result ? JSON.stringify(e.result) : null,
			error:             e.error || null,
			notified:          e.notified === true
		}, 'update_checks');
		if (!res || !res.status) {
			alogger.writeAlog(3, '[UpdateCheck] could not record check result', 'yellowbright');
			return null;
		}
		return res.insertId || null;
	} catch (err) {
		alogger.writeAlog(3, '[UpdateCheck] could not record check result: ' + err.message, 'yellowbright');
		return null;
	}
}

/** The most recent check, or null when none has ever run. */
async function latest() {
	try {
		var rows = await postgres.query(
			'SELECT * FROM update_checks ORDER BY checked_at DESC, id DESC LIMIT 1', []);
		return (rows && rows.length) ? rows[0] : null;
	} catch (_) {
		return null;
	}
}

/** The most recent check that actually resolved an index, error or not aside. */
async function latestSuccessful() {
	try {
		var rows = await postgres.query(
			'SELECT * FROM update_checks WHERE error IS NULL ORDER BY checked_at DESC, id DESC LIMIT 1', []);
		return (rows && rows.length) ? rows[0] : null;
	} catch (_) {
		return null;
	}
}

async function getRecent(limit) {
	try {
		return await postgres.query(
			'SELECT * FROM update_checks ORDER BY checked_at DESC, id DESC LIMIT $1',
			[limit || 50]) || [];
	} catch (_) {
		return [];
	}
}

/**
 * What the last notification actually said.
 *
 * The dedupe key is version AND verdict, so this returns both. A release that
 * was blocked and is now reachable is news even though the version has not
 * moved, and keying on version alone would swallow that.
 */
async function lastNotified() {
	try {
		var rows = await postgres.query(
			'SELECT available_version, verdict FROM update_checks ' +
			'WHERE notified = true ORDER BY checked_at DESC, id DESC LIMIT 1', []);
		if (!rows || !rows.length) return null;
		return { version: rows[0].available_version, verdict: rows[0].verdict };
	} catch (_) {
		return null;
	}
}

async function purgeOld(days) {
	if (!days || days <= 0) return 0;
	try {
		var res = await postgres.query(
			"DELETE FROM update_checks WHERE checked_at < NOW() - ($1 || ' days')::interval RETURNING id",
			[String(days)]);
		return (res || []).length;
	} catch (_) {
		return 0;
	}
}

export {
	SOURCE_SCHEDULE,
	SOURCE_MANUAL,
	record,
	latest,
	latestSuccessful,
	getRecent,
	lastNotified,
	purgeOld
};
