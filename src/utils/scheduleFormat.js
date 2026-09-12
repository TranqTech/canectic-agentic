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

export {
	DEFAULT_LATE_GRACE_MS,
	DEFAULT_STALL_MS,
	MANAGED_KEY_PREFIXES,
	formatDuration,
	formatEvery,
	describeNext,
	lateSchedulers,
	stalledJobs,
	summariseCounts,
	isManagedSchedulerKey,
	orphanSchedulerKeys
};
