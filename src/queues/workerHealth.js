// workerHealth.js -- worker liveness heartbeat and the rules for acting on it.
//
// The worker owns both the toss and maintenance queues. Nothing else drains
// them, so when it stops the whole message pipeline stops with it, and until
// now nothing said so. A hub sat four days without tossing while pm2 reported
// the process online the entire time: the process was alive, its event loop was
// fine, and every job slot was occupied by work that would never finish.
//
// That is the failure this module is shaped around. "Is the process running" is
// the easy half and the supervisor already answers it. The half that was
// missing is "is the process still doing anything", which only the worker can
// answer about itself, and which has to be written somewhere the gateway can
// read.
//
// Split into a heartbeat (written by the worker, read by the gateway) and a set
// of pure decision functions, so the escalation rules can be tested without a
// Redis or a process to kill.

import * as redis from '../middleware/db/redis.js';
import * as alogger from '../utils/alogger.js';
import { formatDuration } from '../utils/scheduleFormat.js';

var HEARTBEAT_KEY = 'canectic:health:worker';

// Heartbeat states, in the order they escalate.
var STATE_OK        = 'ok';        // beating, and processing
var STATE_STOPPED   = 'stopped';   // shut down on purpose, leave it alone
var STATE_MISSING   = 'missing';   // no key at all: never started, or gone long enough to expire
var STATE_STALE     = 'stale';     // key present but the beat has stopped
var STATE_UNHEALTHY = 'unhealthy'; // beating, but a queue consumer is not running
var STATE_PAUSED    = 'paused';    // beating, consumers deliberately paused for maintenance mode

/**
 * Build the heartbeat payload. Kept separate from writing it so a test can
 * assert on the shape without a Redis.
 */
function buildHeartbeat(fields) {
	var f = fields || {};
	return {
		state:     f.state || STATE_OK,
		pid:       f.pid || 0,
		host:      f.host || '',
		startedAt: f.startedAt || 0,
		ts:        f.ts || Date.now(),
		// Per-queue consumer status. `running` false means the BullMQ worker
		// has closed or never started, which is invisible from outside the
		// process and does not stop it exiting zero.
		toss:      f.toss  || { running: false, paused: false, active: 0 },
		maint:     f.maint || { running: false, paused: false, active: 0 },
		// When this worker last finished a job of any kind. A worker that has
		// been up for days with a null here has never done anything.
		lastJobAt: f.lastJobAt === undefined ? null : f.lastJobAt,
		// Longest-running job in flight, in ms, as the worker sees it. The
		// gateway cannot work this out on its own without reading every active
		// job, and the worker already knows.
		longestActiveMs: f.longestActiveMs || 0
	};
}

/**
 * Write the heartbeat. TTL is deliberately a small multiple of the write
 * interval: if the worker dies outright the key expires and the state becomes
 * `missing` rather than an ever-older `stale`, which distinguishes "gone" from
 * "wedged" without any extra bookkeeping.
 */
async function writeHeartbeat(payload, ttlSeconds) {
	try {
		return await redis.set(HEARTBEAT_KEY, JSON.stringify(payload), ttlSeconds || 180);
	} catch (err) {
		// A heartbeat that cannot be written must never take the worker down.
		alogger.writeAlog(4, '[WorkerHealth] heartbeat write failed: ' + err.message, 'yellow');
		return false;
	}
}

async function readHeartbeat() {
	try {
		var raw = await redis.get(HEARTBEAT_KEY);
		if (!raw) return null;
		return typeof raw === 'string' ? JSON.parse(raw) : raw;
	} catch (_) {
		return null;
	}
}

/**
 * Record a deliberate shutdown, so a sysop who stops the worker on purpose is
 * not fought by the watchdog. Written with a long TTL because the whole point
 * is that it outlives the process.
 */
async function markStopped(pid) {
	return await writeHeartbeat(buildHeartbeat({ state: STATE_STOPPED, pid: pid, ts: Date.now() }), 86400);
}

/**
 * Judge a heartbeat.
 *
 * opts.staleMs  how old a beat may be before the worker counts as stale
 * opts.stallMs  how long a job may be active before the worker counts as stuck
 *
 * Returns { state, ageMs, detail, alarm }. `alarm` is the single boolean the
 * caller acts on; `detail` is what gets logged and shown to the sysop.
 */
function assessWorker(hb, now, opts) {
	var o = opts || {};
	var staleMs = o.staleMs || 180000;
	var stallMs = o.stallMs || (30 * 60 * 1000);

	if (!hb) {
		return { state: STATE_MISSING, ageMs: null, alarm: true,
			detail: 'no heartbeat in Redis: the worker is not running, or has never run since this feature was deployed' };
	}

	if (hb.state === STATE_STOPPED) {
		return { state: STATE_STOPPED, ageMs: null, alarm: false,
			detail: 'worker was shut down cleanly' };
	}

	var ageMs = now - (hb.ts || 0);
	if (ageMs > staleMs) {
		return { state: STATE_STALE, ageMs: ageMs, alarm: true,
			detail: 'last heartbeat ' + Math.round(ageMs / 1000) + 's ago (pid ' + hb.pid + ')' };
	}

	var toss = hb.toss || {};
	var maint = hb.maint || {};
	// A consumer paused for maintenance mode has stopped on purpose. BullMQ
	// reports it as not running, so without this every closure of the board
	// would read as a dead worker and the watchdog would restart it.
	var tossUp  = !!(toss.running || toss.paused);
	var maintUp = !!(maint.running || maint.paused);
	if (!tossUp || !maintUp) {
		return { state: STATE_UNHEALTHY, ageMs: ageMs, alarm: true,
			detail: 'queue consumer not running (toss=' + (tossUp ? 'up' : 'down') +
				' maintenance=' + (maintUp ? 'up' : 'down') + ')' };
	}

	// The four day case. The process beats, both consumers are up, and every
	// slot is held by a job that will never return.
	if (hb.longestActiveMs && hb.longestActiveMs > stallMs) {
		return { state: STATE_UNHEALTHY, ageMs: ageMs, alarm: true,
			detail: 'a job has been active for ' + formatDuration(hb.longestActiveMs) };
	}

	// After the stall check on purpose: a wedged job is exactly what stops a
	// maintenance drain from ever finishing, so it must stay visible.
	if (toss.paused || maint.paused) {
		return { state: STATE_PAUSED, ageMs: ageMs, alarm: false,
			detail: 'queues paused for maintenance mode' };
	}

	return { state: STATE_OK, ageMs: ageMs, alarm: false, detail: 'healthy' };
}

/**
 * Whether to fire the restart command now.
 *
 * `tracker` is the caller's mutable record of the current incident:
 *   { failingSince, attempts, lastAttemptAt }
 *
 * The rules exist to make this safe to leave switched on. A restart is not
 * attempted until the fault has persisted past the grace window, because a
 * worker that is merely restarting looks briefly identical to one that has
 * died. Attempts are capped, because a worker that cannot stay up will not be
 * fixed by restarting it a hundred times, and a restart loop is worse than the
 * outage it is chasing: past the cap the watchdog goes quiet and leaves it to
 * the sysop.
 */
function shouldAttemptRestart(assessment, tracker, now, opts) {
	var o = opts || {};
	if (!o.enabled) return { restart: false, reason: 'automatic restart disabled' };
	if (!assessment || !assessment.alarm) return { restart: false, reason: 'worker healthy' };

	var t = tracker || {};
	var graceMs    = o.graceMs === undefined ? 180000 : o.graceMs;
	var cooldownMs = o.cooldownMs === undefined ? 300000 : o.cooldownMs;
	var maxAttempts = o.maxAttempts === undefined ? 3 : o.maxAttempts;

	if (!t.failingSince) return { restart: false, reason: 'first failing check, starting grace window' };
	if (now - t.failingSince < graceMs) {
		return { restart: false, reason: 'within grace window' };
	}
	if ((t.attempts || 0) >= maxAttempts) {
		return { restart: false, reason: 'gave up after ' + maxAttempts + ' restart attempts' };
	}
	if (t.lastAttemptAt && (now - t.lastAttemptAt) < cooldownMs) {
		return { restart: false, reason: 'cooling down since last restart' };
	}

	return { restart: true, reason: 'worker ' + assessment.state + ': ' + assessment.detail };
}

/**
 * Resolve the restart command against the running interpreter.
 *
 * The configured default is a bare `pm2 restart worker`, which depends on pm2
 * being on the PATH the gateway inherited. Under nvm that is not a safe
 * assumption: the pm2 daemon may have been started from a login shell whose
 * PATH the service manager never saw. pm2 installs alongside the node binary
 * running it, so deriving the path from process.execPath finds it whether or
 * not the PATH is right, and derives rather than hardcodes, which is the rule
 * for anything on this system's boot path.
 *
 * Anything that is not a bare pm2 invocation is returned untouched, so a sysop
 * running under systemd can point the config at systemctl instead.
 */
function resolveRestartCommand(command, execPath, existsSync, pathModule) {
	var cmd = String(command || '').trim();
	if (!cmd || !/^pm2(\s|$)/.test(cmd)) return cmd;
	if (!execPath || !existsSync || !pathModule) return cmd;

	try {
		var candidate = pathModule.join(pathModule.dirname(execPath), 'pm2');
		if (existsSync(candidate)) {
			return candidate + cmd.substring(3);
		}
	} catch (_) {}

	return cmd;
}

/**
 * Wrap a queue processor so one job cannot own a concurrency slot for ever.
 *
 * BullMQ dropped per-job timeouts and nothing else here imposed one, so any
 * await that never settles (a Postgres row lock, an exhausted connection pool,
 * a socket with no timeout of its own) took a slot out of circulation
 * permanently. At the default toss concurrency of three, three of those and the
 * pipeline is stopped, with the process still reporting healthy and not one log
 * line to say so.
 *
 * The timeout rejects, it does not cancel: the underlying work cannot be
 * cancelled and the orphaned promise runs on. That is the right trade anyway.
 * Freeing the slot lets BullMQ retry the job, and a worker that keeps
 * accumulating orphans will trip the self check and be restarted, which is a
 * far better outcome than a queue that silently stops.
 *
 * timeoutMs of 0 or less disables the wrapper, for a sysop who would rather
 * have a hung job than a killed one.
 */
function withTimeout(processor, timeoutMs, label) {
	return function (job) {
		if (!timeoutMs || timeoutMs <= 0) return Promise.resolve(processor(job));

		var timer = null;
		var timeout = new Promise(function (_resolve, reject) {
			timer = setTimeout(function () {
				reject(new Error('job exceeded the ' + Math.round(timeoutMs / 60000) +
					' minute limit' + (label ? ' (' + label + ')' : '')));
			}, timeoutMs);
		});

		return Promise.race([Promise.resolve(processor(job)), timeout]).finally(function () {
			// Always clear it. A pending timer on a job that finished normally
			// would keep the event loop alive and, on a busy queue, pile up.
			if (timer) clearTimeout(timer);
		});
	};
}

export {
	HEARTBEAT_KEY,
	STATE_OK,
	STATE_STOPPED,
	STATE_MISSING,
	STATE_STALE,
	STATE_UNHEALTHY,
	STATE_PAUSED,
	buildHeartbeat,
	writeHeartbeat,
	readHeartbeat,
	markStopped,
	assessWorker,
	shouldAttemptRestart,
	resolveRestartCommand,
	withTimeout
};
