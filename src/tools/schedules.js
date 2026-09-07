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
import appConfig from '../config/appConfig.js';

dotenv.config();

var argv = process.argv.slice(2);
var DO_SYNC = argv.includes('--sync');
var DO_PRUNE = argv.includes('--prune') || DO_SYNC;

function minutes(ms) {
	if (!ms && ms !== 0) return '-';
	var m = ms / 60000;
	return (Number.isInteger(m) ? m : m.toFixed(2)) + ' min';
}

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
					every: (parseInt(cd.poll_interval) || 60) * 60 * 1000
				});
			} else if (type === 'QWK') {
				var qm = (parseInt(cd.pull_interval) || 120) * 60 * 1000;
				expected.set('qwk-pull:' + conn.uuid, { queue: 'toss', label: label, every: qm });
				expected.set('qwk-push:' + conn.uuid, { queue: 'toss', label: label, every: qm });
			} else {
				var nm = (parseInt(cd.pull_interval) || 60) * 60 * 1000;
				expected.set('nntp-pull:' + conn.uuid, { queue: 'toss', label: label, every: nm });
				expected.set('nntp-push:' + conn.uuid, { queue: 'toss', label: label, every: nm });
			}
		}
	}

	return expected;
}

async function main() {
	await appConfig.load();

	var queues = {
		mailer:      new Queue('mailer', { connection: createQueueConnection() }),
		toss:        new Queue('toss', { connection: createQueueConnection() }),
		maintenance: new Queue('maintenance', { connection: createQueueConnection() })
	};

	var expected = await expectedSchedules();
	var seen = new Set();
	var problems = [];

	for (var qname of Object.keys(queues)) {
		var list = await queues[qname].getJobSchedulers(0, 500);
		console.log('\n=== ' + qname + ' (' + list.length + ' scheduler' + (list.length === 1 ? '' : 's') + ') ===');
		if (list.length === 0) console.log('  (none)');

		for (var sched of list.sort(function (a, b) {
			return String(a.key || a.id).localeCompare(String(b.key || b.id));
		})) {
			var key = String(sched.key || sched.id);
			var exp = expected.get(key);
			var note = '';

			if (exp) {
				seen.add(key);
				if (exp.every !== sched.every) {
					// The failure this tool exists for: what is registered is
					// not what the sysop configured, and nothing would have
					// told them.
					note = '  <-- MISMATCH, database says ' + minutes(exp.every);
					problems.push({ kind: 'mismatch', key: key, queue: qname,
						have: sched.every, want: exp.every, label: exp.label });
				}
			} else if (/^(poll|qwk-pull|qwk-push|nntp-pull|nntp-push):/.test(key)) {
				// A connection schedule with no connection behind it, or one
				// whose polling was turned off. Nothing else ever removes these.
				note = '  <-- ORPHAN, no matching enabled connection';
				problems.push({ kind: 'orphan', key: key, queue: qname });
			}

			console.log('  ' + pad(key, 46) + pad(sched.every ? minutes(sched.every) : (sched.pattern || '-'), 14) + note);
		}
	}

	var missing = [];
	for (var [key, exp] of expected) {
		if (!seen.has(key)) missing.push(Object.assign({ kind: 'missing', key: key }, exp));
	}
	if (missing.length > 0) {
		console.log('\n=== not registered at all ===');
		for (var m of missing) {
			console.log('  ' + pad(m.key, 46) + pad(minutes(m.every), 14) + '  ' + m.label);
		}
		problems = problems.concat(missing);
	}

	console.log('');
	if (problems.length === 0) {
		console.log('Everything matches the database.');
	} else {
		console.log(problems.length + ' problem(s) found.');
		if (!DO_SYNC && !DO_PRUNE) {
			console.log('Run with --sync to make the schedulers match, or --prune to remove orphans only.');
		}
	}

	if (DO_PRUNE || DO_SYNC) {
		for (var p of problems) {
			var q = queues[p.queue] || queues.mailer;
			if (p.kind === 'orphan') {
				await q.removeJobScheduler(p.key);
				console.log('  removed orphan ' + p.key);
			} else if (DO_SYNC && (p.kind === 'mismatch' || p.kind === 'missing')) {
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
