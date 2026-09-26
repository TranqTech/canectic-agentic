// schedules.js -- inspect and repair the BullMQ job schedulers.
//
// Schedules were only ever written by registerSchedules() at gateway startup,
// so any change a sysop made through the admin UI sat in the database doing
// nothing until the next restart. A poll interval edited from 60 to 240 kept
// polling at whatever it was before, while the peer page showed 240. The admin
// routes now apply changes immediately, but a system that has been running for
// a while can still be carrying schedules that no longer match its config, and
// schedules for connections that were deleted or had polling turned off.
//
// This shows what is actually registered, compares it against what the database
// says it should be, and can fix the difference without a restart.
//
// It also answers the question the schedule listing alone could not: whether
// anything is draining the queues at all. A BullMQ scheduler is not a timer.
// The next iteration is created when a worker picks up the current delayed job,
// so a worker that is dead, or alive but wedged, freezes every schedule where
// it stands while the registered intervals still look perfect. A hub ran four
// days like that. The next-run column is what makes it visible: a `next` in the
// past does not mean the job ran late, it means nothing collected it.
//
// Usage:
//   node src/tools/schedules.js              list everything, flag mismatches
//   node src/tools/schedules.js --sync       make the schedulers match the DB
//   node src/tools/schedules.js --prune      remove orphans only
//
// --sync implies --prune. Both are safe to run on a live system: a scheduler
// upsert replaces the entry, it does not queue a job.

import * as dotenv from 'dotenv';
import { Queue } from 'bullmq';
import { createQueueConnection } from '../queues/connection.js';
import * as peerConnections from '../models/peerConnections.js';
import * as timedEvents from '../models/timedEvents.js';
import * as coordinatorSegments from '../models/coordinatorSegments.js';
import appConfig from '../config/appConfig.js';
import * as workerHealth from '../queues/workerHealth.js';
import {
	formatDuration, formatEvery, describeNext, stalledJobs, summariseCounts,
	isManagedSchedulerKey, connectionIntervalMinutes
} from '../utils/scheduleFormat.js';

dotenv.config();

var argv = process.argv.slice(2);
var DO_SYNC = argv.includes('--sync');
var DO_PRUNE = argv.includes('--prune') || DO_SYNC;

var minutes = formatEvery;

function pad(str, len) {
	var s = String(str === null || str === undefined ? '' : str);
	return s.length >= len ? s : s + ' '.repeat(len - s.length);
}

/**
 * What the database says each connection's schedule should be. Mirrors the
 * rules in registerSchedules exactly: inactive, poll-disabled and FTN HOLD
 * connections get no schedule at all.
 */
async function expectedSchedules() {
	var expected = new Map();

	for (var type of ['FTN', 'QWK', 'NNTP']) {
		var conns = await peerConnections.getActiveConnectionsByNetworkType(type);
		for (var conn of (conns || [])) {
			var cd = conn.connection_data || {};
			var label = (cd.address || conn.uuid) + ' [' + type + ']';

			if (!conn.active || !conn.poll_enabled) continue;
			if (type === 'FTN' && cd.status === 'HOLD') continue;
			if (type === 'QWK' && cd.transport === 'hub') continue;

			if (type === 'FTN') {
				expected.set('poll:' + conn.uuid, {
					queue: 'mailer', label: label,
					every: connectionIntervalMinutes('FTN', cd) * 60 * 1000
				});
			} else if (type === 'QWK') {
				var qm = connectionIntervalMinutes('QWK', cd) * 60 * 1000;
				expected.set('qwk-pull:' + conn.uuid, { queue: 'toss', label: label, every: qm });
				expected.set('qwk-push:' + conn.uuid, { queue: 'toss', label: label, every: qm });
			} else {
				var nm = connectionIntervalMinutes('NNTP', cd) * 60 * 1000;
				expected.set('nntp-pull:' + conn.uuid, { queue: 'toss', label: label, every: nm });
				expected.set('nntp-push:' + conn.uuid, { queue: 'toss', label: label, every: nm });
			}
		}
	}

	// Timed events and coordinator segments are registered by the same startup
	// pass, so they belong here too. Leaving them out did not merely under-report:
	// the orphan rule is now shared with registerSchedules, and a key it knows
	// how to write that this function does not know how to expect would be
	// reported as an orphan and removed by --prune.
	var events = await timedEvents.getActive();
	for (var evt of (events || [])) {
		expected.set('timed-event:' + evt.id, {
			queue: 'maintenance', label: (evt.name || evt.id) + ' [timed event]',
			pattern: evt.cron_pattern, syncable: false
		});
	}

	var segments = await coordinatorSegments.getAll();
	for (var seg of (segments || [])) {
		if (!seg.active || !seg.schedule || seg.schedule === 'manual') continue;
		expected.set('generate-stub:' + seg.id, {
			queue: 'maintenance', label: (seg.name || seg.id) + ' [segment]',
			pattern: seg.schedule, syncable: false
		});
	}

	return expected;
}

/**
 * What the queues actually look like right now.
 *
 * The counts matter more than they read. Work waiting with nothing active is
 * the shape of a stopped consumer. Work waiting with every slot active and the
 * active jobs hours old is the shape of a wedged one, and that second shape is
 * invisible to the supervisor, to BullMQ's stalled-job detection, and to the
 * schedule listing on its own.
 */
async function reportQueueDepth(queues, now) {
	var stallMs = appConfig.getNumber('toss_job_timeout', 30) * 60 * 1000;
	var flagged = [];

	console.log('\n=== queue depth ===');
	console.log('  ' + pad('queue', 14) + pad('waiting', 9) + pad('active', 8) +
		pad('delayed', 9) + pad('failed', 8) + 'state');

	for (var qname of Object.keys(queues)) {
		var q = queues[qname];
		var counts, paused, active;
		try {
			counts = summariseCounts(await q.getJobCounts());
			paused = await q.isPaused();
			active = await q.getActive(0, 50);
		} catch (err) {
			console.log('  ' + pad(qname, 14) + 'unreadable: ' + err.message);
			continue;
		}

		console.log('  ' + pad(qname, 14) + pad(counts.waiting, 9) + pad(counts.active, 8) +
			pad(counts.delayed, 9) + pad(counts.failed, 8) + (paused ? 'PAUSED' : 'running'));

		if (paused) flagged.push({ kind: 'paused', queue: qname });

		// Active jobs, oldest first. Anything past the timeout is reported as
		// stuck rather than slow, because that is the failure that takes the
		// pipeline down without a single log line.
		var stuck = stalledJobs(active, now, stallMs);
		for (var job of (active || [])) {
			if (!job || !job.processedOn) continue;
			var age = now - job.processedOn;
			var isStuck = stuck.some(function (sj) { return sj.id === String(job.id); });
			console.log('      ' + pad(String(job.name || '?'), 28) + pad('id=' + job.id, 26) +
				'active ' + formatDuration(age) + (isStuck ? '   <-- STUCK' : ''));
		}
		if (stuck.length > 0) flagged.push({ kind: 'stuck', queue: qname, count: stuck.length });
	}

	return flagged;
}

/**
 * The worker's own account of itself, which is the only place a wedged but
 * living process shows up.
 */
async function reportWorkerHealth(now) {
	console.log('\n=== worker ===');

	var hb = await workerHealth.readHeartbeat();
	var assessment = workerHealth.assessWorker(hb, now, {
		staleMs: appConfig.getNumber('worker_health_grace', 180) * 1000,
		stallMs: appConfig.getNumber('toss_job_timeout', 30) * 60 * 1000
	});

	console.log('  ' + pad('state', 24) + assessment.state.toUpperCase() + ' (' + assessment.detail + ')');
	if (hb && hb.state !== workerHealth.STATE_STOPPED) {
		console.log('  ' + pad('pid / host', 24) + (hb.pid || '?') + ' on ' + (hb.host || '?'));
		console.log('  ' + pad('uptime', 24) + (hb.startedAt ? formatDuration(now - hb.startedAt) : '-'));
		console.log('  ' + pad('last heartbeat', 24) + (hb.ts ? formatDuration(now - hb.ts) + ' ago' : '-'));
		console.log('  ' + pad('last job finished', 24) +
			(hb.lastJobAt ? formatDuration(now - hb.lastJobAt) + ' ago' : 'never since start'));
		if (hb.longestActiveMs) {
			console.log('  ' + pad('longest job in flight', 24) + formatDuration(hb.longestActiveMs));
		}
	}
	if (!hb) {
		console.log('  (a worker running a build older than the heartbeat writes nothing here,');
		console.log('   so check pm2 as well before concluding it is down)');
	}

	return assessment.alarm ? [{ kind: 'worker', detail: assessment.detail }] : [];
}

async function main() {
	await appConfig.load();

	var queues = {
		mailer:      new Queue('mailer', { connection: createQueueConnection() }),
		toss:        new Queue('toss', { connection: createQueueConnection() }),
		maintenance: new Queue('maintenance', { connection: createQueueConnection() })
	};

	var now = Date.now();
	var LATE_GRACE_MS = appConfig.getNumber('worker_schedule_lag_grace', 15) * 60 * 1000 || 120000;

	var expected = await expectedSchedules();
	var seen = new Set();
	var problems = [];

	var healthFlags = await reportWorkerHealth(now);
	healthFlags = healthFlags.concat(await reportQueueDepth(queues, now));

	for (var qname of Object.keys(queues)) {
		var list = await queues[qname].getJobSchedulers(0, 500);
		console.log('\n=== ' + qname + ' (' + list.length + ' scheduler' + (list.length === 1 ? '' : 's') + ') ===');
		if (list.length === 0) console.log('  (none)');
		else console.log('  ' + pad('key', 48) + pad('interval', 14) + pad('next run', 20) + pad('runs', 7) + 'notes');

		for (var sched of list.sort(function (a, b) {
			return String(a.key || a.id).localeCompare(String(b.key || b.id));
		})) {
			var key = String(sched.key || sched.id);
			var exp = expected.get(key);
			var note = '';

			if (exp) {
				seen.add(key);
				// Interval schedules carry `every`, cron ones carry `pattern`.
				// Comparing only `every` reported every timed event as matching
				// whatever it was actually registered with, since undefined
				// equals undefined.
				var mismatched = exp.pattern !== undefined
					? exp.pattern !== sched.pattern
					: exp.every !== sched.every;
				if (mismatched) {
					// The failure this tool exists for: what is registered is
					// not what the sysop configured, and nothing would have
					// told them.
					note = '  <-- MISMATCH, database says ' +
						(exp.pattern !== undefined ? exp.pattern : minutes(exp.every));
					problems.push({ kind: 'mismatch', key: key, queue: qname,
						have: sched.every, want: exp.every, label: exp.label,
						syncable: exp.syncable !== false });
				}
			} else if (isManagedSchedulerKey(key)) {
				// A schedule with no database row behind it: a deleted
				// connection, one whose polling was turned off, or a timed
				// event or segment that is gone. The predicate is shared with
				// registerSchedules, which prunes these automatically at
				// startup, so the two cannot disagree about what is managed.
				note = '  <-- ORPHAN, nothing in the database asks for it';
				problems.push({ kind: 'orphan', key: key, queue: qname });
			}

			// A next run in the past is the headline finding, not a footnote:
			// the scheduler has not been collected, which means no worker is
			// draining this queue.
			var nextInfo = describeNext(sched.next, now, LATE_GRACE_MS);
			if (nextInfo.late) {
				note = '  <-- OVERDUE, nothing is collecting this queue' + (note ? ',' + note.replace('  <--', '') : '');
				problems.push({ kind: 'overdue', key: key, queue: qname, lateMs: nextInfo.lateMs });
			}

			console.log('  ' + pad(key, 48) +
				pad(sched.every ? minutes(sched.every) : (sched.pattern || '-'), 14) +
				pad(nextInfo.text, 20) +
				pad(sched.iterationCount === undefined ? '-' : sched.iterationCount, 7) + note);
		}
	}

	var missing = [];
	for (var [key, exp] of expected) {
		if (!seen.has(key)) missing.push(Object.assign({ kind: 'missing', key: key,
			syncable: exp.syncable !== false }, exp));
	}
	if (missing.length > 0) {
		console.log('\n=== not registered at all ===');
		for (var m of missing) {
			console.log('  ' + pad(m.key, 48) + pad(minutes(m.every), 14) + '  ' + m.label);
		}
		problems = problems.concat(missing);
	}

	console.log('');
	if (problems.length === 0 && healthFlags.length === 0) {
		console.log('Everything matches the database, and the queues are moving.');
	} else {
		if (problems.length > 0) console.log(problems.length + ' schedule problem(s) found.');
		for (var hf of healthFlags) {
			if (hf.kind === 'worker') console.log('Worker: ' + hf.detail);
			if (hf.kind === 'paused') console.log('Queue ' + hf.queue + ' is paused, so nothing in it will run.');
			if (hf.kind === 'stuck') console.log('Queue ' + hf.queue + ' has ' + hf.count +
				' job(s) stuck past the timeout. Restart the worker: pm2 restart worker');
		}
		var overdue = problems.filter(function (p) { return p.kind === 'overdue'; });
		if (overdue.length > 0) {
			console.log(overdue.length + ' schedule(s) are overdue. --sync will not help: an overdue schedule is');
			console.log('a consumer problem, not a registration one. Check the worker first.');
		}
		if (!DO_SYNC && !DO_PRUNE && problems.length > overdue.length) {
			console.log('Run with --sync to make the schedulers match, or --prune to remove orphans only.');
		}
	}

	if (DO_PRUNE || DO_SYNC) {
		for (var p of problems) {
			// Overdue is a symptom of a stopped consumer. Re-registering the
			// scheduler would look like a fix and change nothing.
			if (p.kind === 'overdue') continue;
			var q = queues[p.queue] || queues.mailer;
			if (p.kind === 'orphan') {
				await q.removeJobScheduler(p.key);
				console.log('  removed orphan ' + p.key);
			} else if (DO_SYNC && (p.kind === 'mismatch' || p.kind === 'missing')) {
				// Only the connection families. A timed event or segment
				// schedule carries a cron pattern and an entirely different
				// job payload, and the prefix-to-job-name mapping below ends
				// in a fallback, so feeding it one would register a stub
				// schedule as an NNTP push. Gateway startup rewrites those.
				if (p.syncable === false) {
					console.log('  skipped ' + p.key + ', rewritten at gateway start');
					continue;
				}
				var jobName = p.key.startsWith('poll:') ? 'poll-scheduled'
					: p.key.startsWith('qwk-pull:') ? 'qwk:pull'
					: p.key.startsWith('qwk-push:') ? 'qwk:push'
					: p.key.startsWith('nntp-pull:') ? 'nntp:pull' : 'nntp:push';
				var uuid = p.key.substring(p.key.indexOf(':') + 1);
				var target = queues[p.queue] || (jobName === 'poll-scheduled' ? queues.mailer : queues.toss);
				await target.upsertJobScheduler(p.key, { every: p.want || p.every },
					{ name: jobName, data: { connectionUUID: uuid } });
				console.log('  set ' + p.key + ' to ' + minutes(p.want || p.every));
			}
		}
	}

	for (var qn of Object.keys(queues)) await queues[qn].close();
	process.exit(0);
}

main().catch(function (err) {
	console.error('schedules: ' + (err && err.stack ? err.stack : err));
	process.exit(1);
});
