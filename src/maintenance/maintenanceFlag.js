// maintenanceFlag.js -- the maintenance mode flag, and the drain status each
// process reports while it is set.
//
// The flag is a FILE at the install root, not a config row. appConfig reads
// PostgreSQL, and the moments maintenance mode is most wanted are exactly the
// moments the database may be mid-migration, locked or down. A file is
// readable by the gateway, the mail and mailer processes, the worker, the
// updater and a CLI alike, with no dependency on the thing being worked on.
//
// Presence is the flag. The contents are for display and for the grace
// deadline, so a file that cannot be parsed still means "closed": a sysop who
// wrote the flag by hand, or a write torn by a crash, must not reopen the
// board.
//
// While the flag is set, each process writes what it still has in flight to
// tmp/maintenance/<process>.json on every tick. That is how the admin page,
// the CLI and the updater know when the board has actually drained, rather
// than guessing from elapsed time. A status that stops being refreshed means
// the process is not running, and a process that is not running has nothing
// in flight, so a stale status counts as drained.
//
// NODE BUILTINS ONLY. The CLI uses this when the gateway will not start and
// the updater uses it around the stop, so it cannot lean on node_modules or on
// the database. tests/installPath.test.js holds it to that.

import * as fs from 'fs';
import * as path from 'path';

var FLAG_FILE  = '.maintenance';
var STATUS_DIR = path.join('tmp', 'maintenance');

// Used only when neither the flag nor the caller supplies a grace. Matches the
// shipped default of maintenance_grace_seconds.
var DEFAULT_GRACE_SECONDS = 300;

// A status older than this is from a process that has stopped. The watcher
// writes every couple of seconds, so this is several missed ticks.
var DEFAULT_STALE_MS = 15000;

var SOURCES = ['manual', 'update'];

function flagPath(root) {
	return path.join(root, FLAG_FILE);
}

function statusDir(root) {
	return path.join(root, STATUS_DIR);
}

function toIso(value) {
	if (!value) return null;
	var d = value instanceof Date ? value : new Date(value);
	return isNaN(d.getTime()) ? null : d.toISOString();
}

function wholeOrNull(value) {
	if (value === null || value === undefined || value === '') return null;
	var n = parseInt(value, 10);
	return (isNaN(n) || n < 0) ? null : n;
}

/**
 * Coerce whatever is in the flag file into one shape. Pure.
 *
 * `raw` may be null (unparseable) and `mtime` is the file's modification time,
 * which stands in for `since` when the contents cannot say.
 */
function normaliseFlag(raw, mtime) {
	var r = (raw && typeof raw === 'object') ? raw : {};
	var since = toIso(r.since) || toIso(mtime) || new Date(0).toISOString();
	return {
		since:            since,
		reason:           (typeof r.reason === 'string' && r.reason.trim()) ? r.reason.trim() : null,
		expected_minutes: wholeOrNull(r.expected_minutes),
		grace_seconds:    wholeOrNull(r.grace_seconds),
		set_by:           (typeof r.set_by === 'string' && r.set_by.trim()) ? r.set_by.trim() : null,
		source:           SOURCES.indexOf(r.source) !== -1 ? r.source : 'manual',
		run_id:           (typeof r.run_id === 'string' && r.run_id) ? r.run_id : null,
		malformed:        !raw || typeof raw !== 'object'
	};
}

/** The flag, or null when the board is open. Never throws. */
function readFlag(root) {
	var file = flagPath(root);
	var stat;
	try {
		stat = fs.statSync(file);
	} catch (_) {
		return null;
	}
	var raw = null;
	try {
		raw = JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (_) {
		raw = null;
	}
	return normaliseFlag(raw, stat.mtime);
}

function isActive(root) {
	try {
		fs.statSync(flagPath(root));
		return true;
	} catch (_) {
		return false;
	}
}

// Write to a temporary name and rename into place, so a reader never sees a
// half-written file. rename() within one directory is atomic on POSIX.
function writeAtomic(file, text) {
	var tmp = file + '.tmp-' + process.pid;
	fs.writeFileSync(tmp, text);
	fs.renameSync(tmp, file);
}

/**
 * Close the board. Overwrites an existing flag, so re-entering with a new
 * reason or duration restarts nothing but the text; `since` is kept when the
 * board is already closed, because the grace deadline hangs off it and a
 * sysop editing the reason must not hand every caller a fresh countdown.
 *
 * @param {string} root
 * @param {object} info  reason, expected_minutes, grace_seconds, set_by, source, run_id
 * @returns {object} the flag as written
 */
function enterMaintenance(root, info) {
	var i = info || {};
	var existing = readFlag(root);
	var flag = {
		since:            existing ? existing.since : new Date().toISOString(),
		reason:           i.reason || null,
		expected_minutes: wholeOrNull(i.expected_minutes),
		grace_seconds:    wholeOrNull(i.grace_seconds),
		set_by:           i.set_by || null,
		source:           SOURCES.indexOf(i.source) !== -1 ? i.source : 'manual',
		run_id:           i.run_id || null
	};
	writeAtomic(flagPath(root), JSON.stringify(flag, null, 2) + '\n');
	return normaliseFlag(flag, null);
}

/** Open the board. Returns whether a flag was removed. */
function leaveMaintenance(root) {
	try {
		fs.unlinkSync(flagPath(root));
		return true;
	} catch (err) {
		if (err && err.code === 'ENOENT') return false;
		throw err;
	}
}

/**
 * When the grace ends. Pure. A flag with no grace of its own takes the
 * caller's default, which is maintenance_grace_seconds for a process that has
 * config and DEFAULT_GRACE_SECONDS for one that does not.
 */
function deadlineOf(flag, defaultGraceSeconds) {
	if (!flag) return null;
	var grace = flag.grace_seconds !== null && flag.grace_seconds !== undefined
		? flag.grace_seconds
		: (wholeOrNull(defaultGraceSeconds) !== null ? wholeOrNull(defaultGraceSeconds) : DEFAULT_GRACE_SECONDS);
	return new Date(new Date(flag.since).getTime() + grace * 1000);
}

/** When the board expects to be back, or null if nobody said. Pure. */
function expectedBackOf(flag) {
	if (!flag || flag.expected_minutes === null || flag.expected_minutes === undefined) return null;
	return new Date(new Date(flag.since).getTime() + flag.expected_minutes * 60000);
}

// ---------------------------------------------------------------------------
// drain status
// ---------------------------------------------------------------------------

function safeName(name) {
	return String(name || 'process').replace(/[^a-z0-9_-]/gi, '_');
}

/**
 * Record what one process still has in flight.
 *
 * @param {string} root
 * @param {string} name     gateway, mail, mailer, worker
 * @param {object} status   { since, drained, pending: {label: count}, deadline }
 */
function writeDrainStatus(root, name, status) {
	var dir = statusDir(root);
	fs.mkdirSync(dir, { recursive: true });
	var s = status || {};
	var record = {
		process:  name,
		pid:      process.pid,
		ts:       new Date().toISOString(),
		since:    s.since || null,
		drained:  !!s.drained,
		pending:  s.pending || {},
		deadline: toIso(s.deadline)
	};
	writeAtomic(path.join(dir, safeName(name) + '.json'), JSON.stringify(record) + '\n');
	return record;
}

function clearDrainStatus(root, name) {
	try {
		fs.unlinkSync(path.join(statusDir(root), safeName(name) + '.json'));
	} catch (_) {}
}

/** Every status file present, parsed. Unreadable files are skipped. */
function readDrainStatuses(root) {
	var dir = statusDir(root);
	var names;
	try {
		names = fs.readdirSync(dir);
	} catch (_) {
		return [];
	}
	var out = [];
	for (var n of names) {
		if (!/\.json$/.test(n)) continue;
		try {
			var rec = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
			if (rec && rec.process) out.push(rec);
		} catch (_) {}
	}
	return out;
}

/**
 * Has the board drained? Pure.
 *
 * Only statuses written for THIS closure count: a file left over from an
 * earlier one says nothing about now, and reading it as drained would let the
 * updater stop the board before the running processes had even noticed the
 * flag. A status that has not been refreshed within staleMs belongs to a
 * process that is not running, and counts as drained.
 *
 * `reporting` is how many processes are live and answering. Zero means either
 * nothing is running or what is running predates maintenance mode, which is
 * the case on the first update into a release that has it. The caller decides
 * what to do about that; this only reports it.
 *
 * @param {Array} statuses  from readDrainStatuses
 * @param {object} opts     { since, now, staleMs }
 * @returns {{drained:boolean, reporting:number, processes:Array}}
 */
function assessDrain(statuses, opts) {
	var o = opts || {};
	var now = o.now ? new Date(o.now).getTime() : Date.now();
	var staleMs = o.staleMs || DEFAULT_STALE_MS;
	var since = toIso(o.since);

	var processes = [];
	var reporting = 0;
	var allDrained = true;

	for (var s of statuses || []) {
		var age = now - new Date(s.ts).getTime();
		var state;
		if (since && toIso(s.since) !== since) {
			state = 'previous';
		} else if (isNaN(age) || age > staleMs) {
			state = 'stopped';
		} else if (s.drained) {
			state = 'drained';
			reporting++;
		} else {
			state = 'draining';
			reporting++;
			allDrained = false;
		}
		processes.push({
			process:  s.process,
			state:    state,
			pending:  state === 'draining' ? (s.pending || {}) : {},
			ts:       s.ts,
			deadline: s.deadline || null
		});
	}

	processes.sort(function (a, b) { return String(a.process).localeCompare(String(b.process)); });
	return { drained: allDrained, reporting: reporting, processes: processes };
}

// How long after the flag appears before a "drained" answer is believed. The
// first process to tick may report drained before the others have ticked at
// all; this is a few watcher intervals, so every live process has written.
var DEFAULT_SETTLE_MS = 6000;

// How long to wait for any process to report before concluding nothing will.
var DEFAULT_NO_REPORT_MS = 20000;

/**
 * What a drain wait should do next. Pure.
 *
 *   drained  every live process reports nothing in flight
 *   nobody   nothing has reported: nothing is running, or what is running
 *            predates maintenance mode and will never report
 *   timeout  still draining after timeoutMs
 *   waiting  keep going
 *
 * @param {object} assessment  from assessDrain
 * @param {object} t           { sinceFlagMs, waitedMs }
 * @param {object} [opts]      { settleMs, noReportMs, timeoutMs }
 */
function drainVerdict(assessment, t, opts) {
	var o = opts || {};
	var settleMs   = o.settleMs   !== undefined ? o.settleMs   : DEFAULT_SETTLE_MS;
	var noReportMs = o.noReportMs !== undefined ? o.noReportMs : DEFAULT_NO_REPORT_MS;

	var timedOut = !!o.timeoutMs && t.waitedMs >= o.timeoutMs;

	if (assessment.reporting > 0 && assessment.drained && t.sinceFlagMs >= settleMs) return 'drained';
	// A timeout with nobody reporting is still "nobody": calling it work in
	// flight would claim knowledge nothing has given us.
	if (assessment.reporting === 0 && (t.waitedMs >= noReportMs || timedOut)) return 'nobody';
	if (timedOut) return 'timeout';
	return 'waiting';
}

function sleep(ms) {
	return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/**
 * Wait until the board has drained, nothing is reporting, or the timeout.
 *
 * Returns { verdict, assessment } where verdict is one of drainVerdict's, or
 * 'open' if somebody cleared the flag while we waited.
 *
 * @param {string} root
 * @param {object} [opts]  settleMs, noReportMs, timeoutMs, intervalMs, onProgress(assessment, waitedMs)
 */
async function waitForDrain(root, opts) {
	var o = opts || {};
	var intervalMs = o.intervalMs || 2000;
	var started = Date.now();
	for (;;) {
		var flag = readFlag(root);
		if (!flag) return { verdict: 'open', assessment: null };

		var now = Date.now();
		var assessment = assessDrain(readDrainStatuses(root), { since: flag.since, now: now, staleMs: o.staleMs });
		var verdict = drainVerdict(assessment, {
			sinceFlagMs: now - new Date(flag.since).getTime(),
			waitedMs:    now - started
		}, o);
		if (typeof o.onProgress === 'function') o.onProgress(assessment, now - started);
		if (verdict !== 'waiting') return { verdict: verdict, assessment: assessment };
		await sleep(intervalMs);
	}
}

/** "2 terminal calls, 1 binkp session". Pure. */
function describePending(pending) {
	var parts = [];
	for (var label in pending || {}) {
		if (!Object.prototype.hasOwnProperty.call(pending, label)) continue;
		var n = pending[label];
		if (n) parts.push(n + ' ' + label);
	}
	return parts.join(', ');
}

export {
	FLAG_FILE,
	STATUS_DIR,
	DEFAULT_GRACE_SECONDS,
	DEFAULT_STALE_MS,
	flagPath,
	statusDir,
	normaliseFlag,
	readFlag,
	isActive,
	enterMaintenance,
	leaveMaintenance,
	deadlineOf,
	expectedBackOf,
	writeDrainStatus,
	clearDrainStatus,
	readDrainStatuses,
	assessDrain,
	drainVerdict,
	waitForDrain,
	describePending,
	DEFAULT_SETTLE_MS,
	DEFAULT_NO_REPORT_MS
};
