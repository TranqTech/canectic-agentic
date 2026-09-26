// scheduleFormat.js -- presentation and lag arithmetic for the queue diagnostics.
//
// Split out of src/tools/schedules.js for the same reason mailerFormat.js is
// split out of the mailer views: the interesting part is the arithmetic that
// decides whether a scheduler is late or a job is stuck, and a CLI script is
// not a testable unit.
//
// Everything here is pure. Callers pass `now` so a test does not have to wait.

// A BullMQ job scheduler is not a timer. The next iteration is only created
// when a worker picks up the current delayed job, so a worker that is dead or
// wedged freezes the schedule where it stands. That makes a `next` timestamp
// in the past the single most useful signal there is: it does not mean the job
// ran late, it means nothing has collected it.
//
// Some slack is needed regardless. A busy worker can be a few seconds behind
// on a one minute schedule and that is normal operation, not a fault.
var DEFAULT_LATE_GRACE_MS = 120000;

// How long a job may sit in the active state before we call it stuck rather
// than slow. A full nodelist import or an echolist batch subscribe legitimately
// runs for minutes, so this is deliberately generous; the failure it is here to
// catch held a slot for four days.
var DEFAULT_STALL_MS = 30 * 60 * 1000;

function formatDuration(ms) {
	if (ms === null || ms === undefined || isNaN(ms)) return '-';
	var neg = ms < 0;
	var s = Math.floor(Math.abs(ms) / 1000);
	var out;
	if (s < 60) out = s + 's';
	else if (s < 3600) out = Math.floor(s / 60) + 'm ' + (s % 60) + 's';
	else if (s < 86400) out = Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
	else out = Math.floor(s / 86400) + 'd ' + Math.floor((s % 86400) / 3600) + 'h';
	return neg ? '-' + out : out;
}

// Intervals are configured in minutes everywhere in this system, so show them
// that way even though BullMQ stores milliseconds.
function formatEvery(ms) {
	if (!ms && ms !== 0) return '-';
	var m = ms / 60000;
	return (Number.isInteger(m) ? m : m.toFixed(2)) + ' min';
}

/**
 * Describe a scheduler's next run relative to now.
 *
 * Returns { text, lateMs, late }. `late` is only true once the overdue amount
 * clears the grace window, so ordinary jitter does not read as a fault.
 */
function describeNext(nextMs, now, graceMs) {
	var grace = (graceMs === undefined || graceMs === null) ? DEFAULT_LATE_GRACE_MS : graceMs;
	if (!nextMs) return { text: 'unknown', lateMs: 0, late: false };

	var delta = nextMs - now;
	if (delta >= 0) return { text: 'in ' + formatDuration(delta), lateMs: 0, late: false };

	var lateMs = -delta;
	return {
		text: formatDuration(lateMs) + ' overdue',
		lateMs: lateMs,
		late: lateMs > grace
	};
}

/**
 * Which of the given schedulers are overdue. Input is whatever
 * Queue.getJobSchedulers() returned, so entries may be missing `next`
 * entirely; those are reported as unknown rather than late, because a
 * scheduler registered a moment ago has not been assigned one yet.
 */
function lateSchedulers(schedulers, now, graceMs) {
	var out = [];
	for (var sched of (schedulers || [])) {
		if (!sched || !sched.next) continue;
		var d = describeNext(sched.next, now, graceMs);
		if (d.late) {
			out.push({ key: String(sched.key || sched.id || ''), lateMs: d.lateMs, next: sched.next });
		}
	}
	return out.sort(function (a, b) { return b.lateMs - a.lateMs; });
}

/**
 * Jobs that have been in the active state too long.
 *
 * BullMQ's own stalled-job detection does not cover this. It fires when a
 * worker stops renewing a job's lock, which happens when the process dies. A
 * process that is alive and sitting on an await that never settles keeps
 * renewing the lock forever, so BullMQ considers the job perfectly healthy
 * while the slot is gone for good. At concurrency three, three of those and
 * the queue stops moving with nothing logged.
 *
 * `jobs` are BullMQ Job objects or anything carrying processedOn/name/id.
 */
function stalledJobs(jobs, now, stallMs) {
	var limit = (stallMs === undefined || stallMs === null) ? DEFAULT_STALL_MS : stallMs;
	var out = [];
	for (var job of (jobs || [])) {
		if (!job || !job.processedOn) continue;
		var runningMs = now - job.processedOn;
		if (runningMs > limit) {
			out.push({
				id: String(job.id === undefined || job.id === null ? '' : job.id),
				name: job.name || '',
				runningMs: runningMs
			});
		}
	}
	return out.sort(function (a, b) { return b.runningMs - a.runningMs; });
}

/**
 * One line summary of a queue's counts, plus the flags worth acting on.
 *
 * `counts` is the object Queue.getJobCounts() returns. A queue with work
 * waiting and nothing active is the shape a stopped consumer makes; a queue
 * with work waiting and everything active is the shape a stuck one makes.
 */
function summariseCounts(counts) {
	var c = counts || {};
	var num = function (v) { return typeof v === 'number' ? v : 0; };
	return {
		waiting:   num(c.waiting) + num(c.paused),
		active:    num(c.active),
		delayed:   num(c.delayed),
		failed:    num(c.failed),
		completed: num(c.completed)
	};
}

// Scheduler keys whose existence is decided entirely by a database row, and
// which registerSchedules therefore rebuilds in full on every gateway start.
// Anything matching one of these and absent from that rebuild has no row behind
// it any more: a deleted connection, or one whose polling was turned off.
//
// This list is the whole safety argument for automatic pruning. A key outside
// it is left alone, because something other than registerSchedules owns it and
// its absence from the expected set proves nothing. Adding a prefix here is a
// statement that registerSchedules is the sole authority for that family.
var MANAGED_KEY_PREFIXES = [
	'poll:',
	'qwk-pull:',
	'qwk-push:',
	'nntp-pull:',
	'nntp-push:',
	'timed-event:',
	'generate-stub:'
];

function isManagedSchedulerKey(key) {
	var k = String(key || '');
	return MANAGED_KEY_PREFIXES.some(function (p) { return k.startsWith(p); });
}

// Which registered scheduler keys no longer have a database row behind them.
//
// Orphans are not cosmetic. registerSchedules skips a connection whose polling
// is disabled rather than clearing its schedule, and nothing removed one when a
// connection was deleted, so an orphan goes on firing its job for ever: a poll
// to a peer that is gone, or a pull for a connection the sysop turned off. The
// job then fails or silently does nothing, once per interval, indefinitely.
//
// `expected` must be the complete set the caller just registered. Handing this
// a partial set deletes live schedules, so a caller that could not finish
// building it must not call this at all rather than calling it with what it
// has. Returns keys in the order given, so a caller's log reads predictably.
function orphanSchedulerKeys(registered, expected) {
	var want = expected instanceof Set ? expected : new Set(expected || []);
	return (registered || [])
		.map(function (k) { return String(k); })
		.filter(function (k) { return isManagedSchedulerKey(k) && !want.has(k); });
}

var FAMILY_LABELS = {
	'poll:': 'FTN poll',
	'qwk-pull:': 'QWK pull',
	'qwk-push:': 'QWK push',
	'nntp-pull:': 'NNTP pull',
	'nntp-push:': 'NNTP push',
	'timed-event:': 'Timed event',
	'generate-stub:': 'Stub generation'
};

// Split a managed key into its family and the id of the row it belongs to.
function schedulerKeyParts(key) {
	var k = String(key || '');
	for (var prefix of MANAGED_KEY_PREFIXES) {
		if (k.startsWith(prefix)) {
			return { prefix: prefix, family: FAMILY_LABELS[prefix], id: k.slice(prefix.length),
				connection: /^(poll|qwk-|nntp-)/.test(prefix) };
		}
	}
	return null;
}

// Why a removed schedule was no longer wanted, from the row it belonged to
// (null when the row is gone). Mirrors the rules registerSchedules applies.
function orphanReason(key, row) {
	var parts = schedulerKeyParts(key);
	if (!parts) return 'not a managed schedule';
	if (!row) return parts.connection ? 'the connection no longer exists' : 'it no longer exists';
	if (parts.connection) {
		var cd = row.connection_data || {};
		if (!row.active) return 'the connection is inactive';
		if (!row.poll_enabled) return 'polling is turned off for this connection';
		if (parts.prefix === 'poll:' && cd.status === 'HOLD') return 'the connection is on hold';
		if (parts.prefix.startsWith('qwk-') && cd.transport === 'hub') return 'it is a hub connection, which the other side polls';
		return 'nothing in the database asks for it';
	}
	if (row.active === false) return 'it is inactive';
	if (parts.prefix === 'generate-stub:' && (!row.schedule || row.schedule === 'manual')) return 'it is set to manual';
	return 'nothing in the database asks for it';
}

// Who a removed schedule was for, in words a sysop recognises.
function orphanSubject(key, row) {
	var parts = schedulerKeyParts(key);
	if (!parts) return String(key);
	if (!row) return parts.family + ' ' + parts.id;
	if (parts.connection) {
		var cd = row.connection_data || {};
		var who = row.peer_name || cd.address || cd.host || parts.id;
		var where = row.network_name ? ' on ' + row.network_name : '';
		var host = cd.host || cd.mailer_host || cd.remote_host;
		return parts.family + ' for ' + who + where + (host ? ' (' + host + ')' : '');
	}
	return parts.family + ' "' + (row.name || parts.id) + '"';
}

/**
 * The sysop notification for one automatic pruning pass, or null when nothing
 * was removed. `removed` is [{key, queue, row}], row null when it is gone.
 *
 * Removing a schedule is the correct response to polling being turned off, so
 * the prune must go on doing it. But until 2026-09 connections created before
 * poll_enabled existed ran on schedules nothing in the database asked for, and
 * the first prune stopped DOVE-Net and Usenet collection with one level 3 log
 * line each. A sysop who meant it reads this and moves on; one who did not now
 * finds out the day it happens, not two weeks later from an empty area.
 */
function pruneNotification(removed) {
	var list = (removed || []).filter(Boolean);
	if (list.length === 0) return null;
	var lines = list.map(function (r) {
		return orphanSubject(r.key, r.row) + ': removed because ' + orphanReason(r.key, r.row) + '.';
	});
	var title = list.length === 1
		? 'Schedule removed: ' + orphanSubject(list[0].key, list[0].row)
		: list.length + ' schedules removed';
	var body = lines.join('\n') + '\n\nIf this was not intended, turn polling back on for the connection (Peers). ' +
		'The schedule is registered again when you save.';
	return { title: title, body: body, lines: lines };
}

// The minutes between a connection's scheduled polls or pull/push cycles.
// The ONE reading of the setting, for startup registration, the save path,
// the diagnostic and the log line alike. They used to read it separately:
// QWK and NNTP store `pull_interval_minutes` (peerConnections
// .buildConnectionData), startup read that, but the save path and
// tools/schedules.js read `pull_interval`, which nothing writes, so saving a
// connection re-registered it at the default and the diagnostic compared
// against the default. `pull_interval` is still read as a fallback for rows
// written by hand. A value that is not a positive number falls to the
// default, since an every of NaN or 0 would be a poll loop.
var DEFAULT_INTERVAL_MINUTES = { FTN: 60, QWK: 120, NNTP: 60 };

function connectionIntervalMinutes(networkType, cd) {
	var d = cd || {};
	var raw = networkType === 'FTN' ? d.poll_interval : (d.pull_interval_minutes || d.pull_interval);
	var n = parseInt(raw);
	return n > 0 ? n : (DEFAULT_INTERVAL_MINUTES[networkType] || 60);
}

export {
	DEFAULT_LATE_GRACE_MS,
	DEFAULT_STALL_MS,
	MANAGED_KEY_PREFIXES,
	connectionIntervalMinutes,
	formatDuration,
	formatEvery,
	describeNext,
	lateSchedulers,
	stalledJobs,
	summariseCounts,
	isManagedSchedulerKey,
	orphanSchedulerKeys,
	schedulerKeyParts,
	orphanReason,
	orphanSubject,
	pruneNotification
};
