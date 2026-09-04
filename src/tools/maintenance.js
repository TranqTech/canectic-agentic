#!/usr/bin/env node

// maintenance.js — CLI runner for message base maintenance tasks.
// Located in src/tools/
//
// Enqueues maintenance jobs on the BullMQ `maintenance` queue and waits
// for completion.  The worker process (bin/worker.js) does the actual work.
// PID-file locking is no longer needed — BullMQ's jobId deduplication
// prevents concurrent operations.
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
//   node src/tools/maintenance.js --help                       Show usage

import * as dotenv from 'dotenv';
import { QueueEvents } from 'bullmq';
import { createQueueConnection } from '../queues/connection.js';
import * as jobs from '../queues/jobs.js';
import { closeQueues } from '../queues/queues.js';

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
		console.log('');
		console.log('Options:');
		console.log('  --area SHORTCODE   Limit regen-html, rethread or fix-msgids to specific area(s) (repeatable)');
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

	return { regenHtml, regenPmHtml, purgePmTrash, recalcCounts, rethread, fixMsgIds, areas, dryRun, width, batchSize, days };
}

// ---------------------------------------------------------------------------
// Job tracking — wait for enqueued jobs to complete or fail
// ---------------------------------------------------------------------------

async function waitForJobs(enqueuedJobs, timeoutMs) {
	if (enqueuedJobs.length === 0) return;

	var timeout = timeoutMs || 600000;  // 10 minute default (maintenance can be slow)
	var connection = createQueueConnection();
	var queueEvents = new QueueEvents('maintenance', { connection });

	var pending = new Map();
	for (var job of enqueuedJobs) {
		if (job && job.id) {
			pending.set(job.id, job.name);
		}
	}

	if (pending.size === 0) {
		connection.disconnect();
		return;
	}

	console.log('Waiting for ' + pending.size + ' job(s) to complete...');

	return new Promise((resolve) => {
		var timer = setTimeout(() => {
			console.log('Timeout: ' + pending.size + ' job(s) still pending after ' + (timeout / 1000) + 's');
			cleanup();
			resolve();
		}, timeout);

		function cleanup() {
			clearTimeout(timer);
			queueEvents.close();
			connection.disconnect();
		}

		queueEvents.on('completed', ({ jobId }) => {
			if (pending.has(jobId)) {
				console.log('  \u2713 ' + pending.get(jobId) + ' completed');
				pending.delete(jobId);
				if (pending.size === 0) {
					cleanup();
					resolve();
				}
			}
		});

		queueEvents.on('failed', ({ jobId, failedReason }) => {
			if (pending.has(jobId)) {
				console.log('  \u2717 ' + pending.get(jobId) + ' failed: ' + failedReason);
				pending.delete(jobId);
				if (pending.size === 0) {
					cleanup();
					resolve();
				}
			}
		});
	});
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	var opts = parseArgs();

	if (!opts.regenHtml && !opts.regenPmHtml && !opts.purgePmTrash && !opts.recalcCounts && !opts.rethread && !opts.fixMsgIds) {
		console.log('No task specified. Use --help for usage.');
		process.exit(1);
	}

	console.log('Enqueueing maintenance jobs...');

	var enqueuedJobs = [];

	try {
		if (opts.regenHtml) {
			var job = await jobs.enqueueRegenHtml({
				areas: opts.areas.length > 0 ? opts.areas : null,
				batchSize: opts.batchSize,
				forceWidth: opts.width || null,
			});
			enqueuedJobs.push(job);
			console.log('  + regen-html' + (opts.areas.length > 0 ? ' (areas: ' + opts.areas.join(', ') + ')' : ''));
		}

		if (opts.regenPmHtml) {
			var job = await jobs.enqueueRegenPmHtml({
				batchSize: opts.batchSize,
				forceWidth: opts.width || null,
			});
			enqueuedJobs.push(job);
			console.log('  + regen-pm-html');
		}

		if (opts.purgePmTrash) {
			var retentionDays = opts.days || parseInt(process.env.pm_trash_retention_days) || 30;
			var job = await jobs.enqueuePurgePmTrash(retentionDays);
			enqueuedJobs.push(job);
			console.log('  + purge-pm-trash (days: ' + retentionDays + ')');
		}

		if (opts.recalcCounts) {
			var job = await jobs.enqueueRecalcAreaCounts();
			enqueuedJobs.push(job);
			console.log('  + recalc-area-counts');
		}

		if (opts.rethread) {
			var job = await jobs.enqueueRethread({
				areas: opts.areas.length > 0 ? opts.areas : null,
				dryRun: opts.dryRun,
			});
			enqueuedJobs.push(job);
			console.log('  + rethread' + (opts.areas.length > 0 ? ' (areas: ' + opts.areas.join(', ') + ')' : ' (all areas)'));
		}

		if (opts.fixMsgIds) {
			var job = await jobs.enqueueFixMsgIds({
				areas: opts.areas.length > 0 ? opts.areas : null,
				dryRun: opts.dryRun,
				batchSize: opts.batchSize,
			});
			enqueuedJobs.push(job);
			console.log('  + fix-msgids' + (opts.areas.length > 0 ? ' (areas: ' + opts.areas.join(', ') + ')' : ' (all areas)') + (opts.dryRun ? ' [dry run]' : ''));
			console.log('    Progress is logged by the worker. Check: pm2 logs worker');
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
