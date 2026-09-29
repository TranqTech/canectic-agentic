#!/usr/bin/env node

// maintenance.js — CLI runner for message base maintenance tasks.
// Located in src/tools/
//
// Enqueues maintenance jobs on the BullMQ `maintenance` queue and waits
// for completion.  The worker process (bin/worker.js) does the actual work.
// PID-file locking is no longer needed: a request identical to one already
// waiting or running is merged into it (and reported as such), while one with
// different options (areas, width, days, dry run) queues behind it. A regen
// of message HTML is one job per area.
//
// Requires the worker process or embedded mode to be running.
//
// Usage:
//   node src/tools/maintenance.js --regen-html                 Regenerate body_html for all areas
//   node src/tools/maintenance.js --regen-html --area GENERAL  Regenerate for a specific area
//   node src/tools/maintenance.js --regen-html --dry-run       Preview without writing
//   node src/tools/maintenance.js --regen-html --width 80      Force a specific column width
//   node src/tools/maintenance.js --regen-pm-html              Regenerate body_html for PM tables
//   node src/tools/maintenance.js --purge-pm-trash             Hard-delete expired PM trash
//   node src/tools/maintenance.js --purge-pm-trash --days 7    Override retention period
//   node src/tools/maintenance.js --recalc-counts              Recalculate message area counts
//   node src/tools/maintenance.js --fix-msgids                 Repair legacy full-string MSGIDs
//   node src/tools/maintenance.js --fix-msgids --dry-run       Report what would be repaired
//   node src/tools/maintenance.js --fix-charset --dry-run      Report text stored as mojibake (UTF-8 read as CP437)
//   node src/tools/maintenance.js --fix-charset                Repair it, keeping the old text in charset_repairs
//   node src/tools/maintenance.js --revert-charset             Put back what --fix-charset changed
//   node src/tools/maintenance.js --help                       Show usage

import * as dotenv from 'dotenv';
import { QueueEvents } from 'bullmq';
import { createQueueConnection } from '../queues/connection.js';
import * as jobs from '../queues/jobs.js';
import { closeQueues, maintenanceQueue } from '../queues/queues.js';

dotenv.config();

function parseArgs() {
	var args = process.argv.slice(2);

	if (args.includes('--help') || args.includes('-h')) {
		console.log('Usage: node src/tools/maintenance.js [task] [options]');
		console.log('');
		console.log('Tasks:');
		console.log('  --regen-html       Regenerate body_html for message area messages');
		console.log('  --regen-pm-html    Regenerate body_html for private messages (pm_inbox + pm_outbox)');
		console.log('  --purge-pm-trash   Hard-delete PM trash older than retention period');
		console.log('  --recalc-counts    Recalculate message area counts');
		console.log('  --rethread         Rebuild thread assignments for message areas');
		console.log('  --fix-msgids       Split legacy full-string MSGIDs into the msg_id/msg_orig_addr tuple');
		console.log('  --fix-charset      Repair text stored as mojibake (UTF-8 that was read as CP437); try --dry-run first');
		console.log('  --revert-charset   Put back everything --fix-charset changed (old text is kept in charset_repairs)');
		console.log('');
		console.log('Options:');
		console.log('  --area SHORTCODE   Limit regen-html, rethread, fix-msgids or fix-charset to specific area(s) (repeatable)');
		console.log('  --dry-run          Preview without writing changes');
		console.log('  --width N          Force column width for HTML generation');
		console.log('  --batch N          Batch size (default: 100)');
		console.log('  --days N           Trash retention days for purge-pm-trash (default: env pm_trash_retention_days or 30)');
		console.log('');
		console.log('Jobs are enqueued on the BullMQ maintenance queue.');
		console.log('The worker process (bin/worker.js) must be running.');
		process.exit(0);
	}

	var areas = [];
	var dryRun = args.includes('--dry-run');
	var regenHtml = args.includes('--regen-html');
	var regenPmHtml = args.includes('--regen-pm-html');
	var purgePmTrash = args.includes('--purge-pm-trash');
	var recalcCounts = args.includes('--recalc-counts');
	var rethread = args.includes('--rethread');
	var fixMsgIds = args.includes('--fix-msgids');
	var fixCharset = args.includes('--fix-charset');
	var revertCharset = args.includes('--revert-charset');
	var width = null;
	var batchSize = 100;
	var days = null;

	for (var i = 0; i < args.length; i++) {
		if (args[i] === '--area' && args[i + 1]) {
			areas.push(args[i + 1]);
			i++;
		} else if (args[i] === '--width' && args[i + 1]) {
			width = parseInt(args[i + 1], 10);
			i++;
		} else if (args[i] === '--batch' && args[i + 1]) {
			batchSize = parseInt(args[i + 1], 10);
			i++;
		} else if (args[i] === '--days' && args[i + 1]) {
			days = parseInt(args[i + 1], 10);
			i++;
		}
	}

	return { regenHtml, regenPmHtml, purgePmTrash, recalcCounts, rethread, fixMsgIds, fixCharset, revertCharset, areas, dryRun, width, batchSize, days };
}

// ---------------------------------------------------------------------------
// Job tracking — wait for enqueued jobs to complete or fail
// ---------------------------------------------------------------------------

// What a job is, for the progress lines: its name plus the area it covers.
function jobLabel(job) {
	var areas = job && job.data && job.data.areas;
	var table = job && job.data && job.data.table;
	return job.name + (areas && areas.length ? ' (' + areas.join(', ') + ')' : table ? ' (' + table + ')' : '');
}

// No overall time limit. A whole-board regen runs one area job after another
// and can take hours, which the old ten-minute cap abandoned while the worker
// carried on. Each job is still bounded by maintenance_job_timeout on the
// worker, which fails it and so ends the wait for it. A worker that is not
// running shows here as jobs that stay waiting, reported every five minutes.
var PROGRESS_EVERY_MS = 5 * 60 * 1000;
var POLL_MS = 5000;

async function waitForJobs(enqueuedJobs) {
	var pending = new Map();
	for (var job of enqueuedJobs) {
		if (job && job.id) pending.set(job.id, job);
	}
	if (pending.size === 0) return;

	var connection = createQueueConnection();
	var queueEvents = new QueueEvents('maintenance', { connection });
	var queue = maintenanceQueue;
	await queueEvents.waitUntilReady();

	var total = pending.size;
	var failed = 0;
	console.log('Waiting for ' + total + ' job(s) to complete... (Ctrl-C stops waiting; the jobs carry on)');

	return new Promise((resolve) => {
		var lastProgress = Date.now();

		function finish(jobId, line, isFailure) {
			if (!pending.has(jobId)) return;
			console.log(line);
			pending.delete(jobId);
			if (isFailure) failed++;
			if (pending.size === 0) {
				clearInterval(poll);
				queueEvents.close();
				connection.disconnect();
				if (failed) console.log(failed + ' of ' + total + ' job(s) failed.');
				resolve();
			}
		}

		queueEvents.on('completed', ({ jobId, returnvalue }) => {
			var j = pending.get(jobId);
			if (j) finish(jobId, '  \u2713 ' + jobLabel(j) + ' completed' + describeResult(returnvalue), false);
		});

		queueEvents.on('failed', ({ jobId, failedReason }) => {
			var j = pending.get(jobId);
			if (j) finish(jobId, '  \u2717 ' + jobLabel(j) + ' failed: ' + failedReason, true);
		});

		// Jobs are removed on completion, so one that finished before the
		// listener was ready is simply gone. Without this check the wait for
		// it would never end.
		var poll = setInterval(async () => {
			var counts = { waiting: 0, active: 0, other: 0 };
			for (var [jobId, j] of Array.from(pending.entries())) {
				var current = await queue.getJob(jobId);
				if (!current) {
					finish(jobId, '  ? ' + jobLabel(j) + ' finished before its result was seen (see pm2 logs worker)', false);
					continue;
				}
				var state = await current.getState();
				// Finished before the listener was ready: jobs that report a
				// result are kept for a while, so read it from the job itself.
				if (state === 'completed') {
					finish(jobId, '  \u2713 ' + jobLabel(j) + ' completed' + describeResult(current.returnvalue), false);
					continue;
				}
				if (state === 'failed') {
					finish(jobId, '  \u2717 ' + jobLabel(j) + ' failed: ' + current.failedReason, true);
					continue;
				}
				if (state === 'active') counts.active++;
				else if (state === 'waiting' || state === 'prioritized' || state === 'delayed') counts.waiting++;
				else counts.other++;
			}
			if (pending.size > 0 && Date.now() - lastProgress >= PROGRESS_EVERY_MS) {
				lastProgress = Date.now();
				console.log('  ... ' + (total - pending.size) + ' of ' + total + ' done, ' +
					counts.active + ' running, ' + counts.waiting + ' waiting' +
					(counts.active === 0 && counts.waiting > 0 ? ' (is the worker running?)' : ''));
			}
		}, POLL_MS);
	});
}

// A regen reports its counts as the job's return value; nothing else does.
// A dry run exists to answer "how many would change", so say that.
function describeResult(returnvalue) {
	var r = returnvalue;
	if (typeof r === 'string') {
		try { r = JSON.parse(r); } catch (_) { return ''; }
	}
	if (r && r.kind === 'charset') {
		if (!r.repaired) return ': ' + r.scanned + ' checked, nothing to repair';
		return ': ' + r.scanned + ' checked, ' + r.repaired + (r.dryRun ? ' would be repaired' : ' repaired') +
			' (' + Object.keys(r.fields).map(function (f) { return f + ' ' + r.fields[f]; }).join(', ') + ')' +
			(r.replacementChars ? ', ' + r.replacementChars + ' already destroyed by the sender (hold U+FFFD)' : '') +
			(r.sampleIds && r.sampleIds.length ? ' (e.g. ids ' + r.sampleIds.join(', ') + ')' : '');
	}
	if (r && r.kind === 'charset-revert') return ': ' + r.restored + ' value(s) restored';
	if (!r || typeof r !== 'object' || r.processed === undefined) return '';
	return ': ' + r.processed + ' checked, ' + r.updated + (r.dryRun ? ' would change' : ' updated') +
		', ' + r.unchanged + ' unchanged' +
		(r.skipped ? ', ' + r.skipped + ' skipped' : '') +
		(r.errors ? ', ' + r.errors + ' errors' : '') +
		(r.sampleIds && r.sampleIds.length ? ' (e.g. ids ' + r.sampleIds.join(', ') + ')' : '');
}

// Report what enqueueing did. A merged job was already waiting or running
// with the same options, so this request adds nothing and the wait is on
// that job; saying "+ queued" for it is what #79 was about.
function reportQueued(queued) {
	var fresh = queued.filter(function (j) { return j && !j.merged; });
	var merged = queued.filter(function (j) { return j && j.merged; });
	if (queued.length <= 10) {
		for (var j of fresh) console.log('  + ' + jobLabel(j));
		for (var m of merged) console.log('  = ' + jobLabel(m) + ': already ' + m.mergedState + ' with the same options, waiting on that one');
	} else {
		console.log('  + ' + fresh.length + ' ' + (queued[0].name) + ' job(s) queued');
		if (merged.length) {
			console.log('  = ' + merged.length + ' already waiting or running with the same options: ' + merged.map(jobLabel).join('; '));
		}
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	var opts = parseArgs();

	if (!opts.regenHtml && !opts.regenPmHtml && !opts.purgePmTrash && !opts.recalcCounts && !opts.rethread && !opts.fixMsgIds && !opts.fixCharset && !opts.revertCharset) {
		console.log('No task specified. Use --help for usage.');
		process.exit(1);
	}

	console.log('Enqueueing maintenance jobs...');

	var enqueuedJobs = [];

	try {
		if (opts.regenHtml) {
			// One job per area; no --area means every active area.
			var regenJobs = await jobs.enqueueRegenHtml({
				areas: opts.areas.length > 0 ? opts.areas : null,
				batchSize: opts.batchSize,
				forceWidth: opts.width || null,
				dryRun: opts.dryRun,
			});
			if (opts.dryRun) console.log('  [dry run] nothing will be written; each area reports how many messages would change');
			if (regenJobs.length === 0) console.log('  regen-html: no active message areas');
			reportQueued(regenJobs);
			enqueuedJobs.push(...regenJobs);
		}

		if (opts.regenPmHtml) {
			var job = await jobs.enqueueRegenPmHtml({
				batchSize: opts.batchSize,
				forceWidth: opts.width || null,
				dryRun: opts.dryRun,
			});
			reportQueued([job]);
			enqueuedJobs.push(job);
		}

		if (opts.purgePmTrash) {
			var retentionDays = opts.days || parseInt(process.env.pm_trash_retention_days) || 30;
			var job = await jobs.enqueuePurgePmTrash(retentionDays);
			reportQueued([job]);
			console.log('    (days: ' + retentionDays + ')');
			enqueuedJobs.push(job);
		}

		if (opts.recalcCounts) {
			var job = await jobs.enqueueRecalcAreaCounts();
			reportQueued([job]);
			enqueuedJobs.push(job);
		}

		if (opts.rethread) {
			var job = await jobs.enqueueRethread({
				areas: opts.areas.length > 0 ? opts.areas : null,
				dryRun: opts.dryRun,
			});
			reportQueued([job]);
			if (opts.areas.length === 0) console.log('    (all areas)');
			enqueuedJobs.push(job);
		}

		if (opts.fixMsgIds) {
			var job = await jobs.enqueueFixMsgIds({
				areas: opts.areas.length > 0 ? opts.areas : null,
				dryRun: opts.dryRun,
				batchSize: opts.batchSize,
			});
			reportQueued([job]);
			console.log('    ' + (opts.areas.length > 0 ? '' : '(all areas) ') + (opts.dryRun ? '[dry run] ' : '') +
				'Progress is logged by the worker. Check: pm2 logs worker');
			enqueuedJobs.push(job);
		}

		if (opts.fixCharset || opts.revertCharset) {
			if (opts.fixCharset && opts.revertCharset) throw new Error('--fix-charset and --revert-charset cannot be combined');
			var charsetJobs = await jobs.enqueueFixCharset({
				areas: opts.areas.length > 0 ? opts.areas : null,
				dryRun: opts.dryRun,
				batchSize: opts.batchSize,
				revert: opts.revertCharset,
			});
			if (opts.fixCharset && opts.dryRun) console.log('  [dry run] nothing will be written; each table reports what would be repaired');
			reportQueued(charsetJobs);
			enqueuedJobs.push(...charsetJobs);
		}

		if (enqueuedJobs.length === 0) {
			console.log('No jobs to enqueue.');
		} else {
			await waitForJobs(enqueuedJobs);
			console.log('Done.');
		}

	} catch (err) {
		console.error('Error enqueueing jobs:', err.message);
		console.error('Is the worker process running?  (node bin/worker.js)');
	}

	await closeQueues();
}

await main();
process.exit();
