#!/usr/bin/env node

/**
 * Canectic BBS — Tosser CLI
 *
 * Enqueues toss jobs on the BullMQ queue and waits for completion.
 * The actual tossing work is done by the worker process (bin/worker.js).
 *
 * This replaces the old direct-execution tosser.  The CLI interface is
 * identical — same flags, same output.  PID-file locking is no longer needed
 * because BullMQ's jobId deduplication prevents concurrent operations.
 *
 * Usage: node src/tools/tosser.js [--in | --out] [--ftn] [--nntp] [--qwk]
 *
 * Requires the worker process to be running (or embedded mode in the gateway).
 */

import * as dotenv from 'dotenv';
import { QueueEvents } from 'bullmq';
import { createQueueConnection } from '../queues/connection.js';
import * as jobs from '../queues/jobs.js';
import { closeQueues } from '../queues/queues.js';
import { DateTime } from "luxon";

dotenv.config();

// ---------------------------------------------------------------------------
// Argument parsing (unchanged from original)
// ---------------------------------------------------------------------------

function parseArgs() {
	var args = process.argv.slice(2);

	if (args.includes('--help') || args.includes('-h')) {
		console.log('Usage: node src/tools/tosser.js [--in | --out] [--ftn] [--nntp] [--qwk]');
		console.log('');
		console.log('Direction:');
		console.log('  --in       Inbound only');
		console.log('  --out      Outbound only');
		console.log('             (default: both)');
		console.log('');
		console.log('Network type (combinable, default: all):');
		console.log('  --ftn      FTN connections');
		console.log('  --nntp     NNTP connections');
		console.log('  --qwk      QWK connections');
		console.log('');
		console.log('Jobs are enqueued on the BullMQ toss queue.');
		console.log('The worker process (bin/worker.js) must be running.');
		process.exit(0);
	}

	var hasIn  = args.includes('--in');
	var hasOut = args.includes('--out');

	var doInbound  = hasIn  || (!hasIn && !hasOut);
	var doOutbound = hasOut || (!hasIn && !hasOut);

	var hasFtn  = args.includes('--ftn');
	var hasNntp = args.includes('--nntp');
	var hasQwk  = args.includes('--qwk');
	var anyType = hasFtn || hasNntp || hasQwk;

	var doFtn  = hasFtn  || !anyType;
	var doNntp = hasNntp || !anyType;
	var doQwk  = hasQwk  || !anyType;

	return { doInbound, doOutbound, doFtn, doNntp, doQwk };
}

// ---------------------------------------------------------------------------
// Job tracking — wait for all enqueued jobs to complete or fail
// ---------------------------------------------------------------------------

async function waitForJobs(enqueuedJobs, timeoutMs) {
	if (enqueuedJobs.length === 0) return;

	const timeout = timeoutMs || 300000;  // 5 minute default
	const connection = createQueueConnection();
	const queueEvents = new QueueEvents('toss', { connection });

	const pending = new Map();
	for (const job of enqueuedJobs) {
		if (job && job.id) {
			pending.set(job.id, job.name);
		}
	}

	if (pending.size === 0) {
		connection.disconnect();
		return;
	}

	console.log(`Waiting for ${pending.size} job(s) to complete...`);

	return new Promise((resolve) => {
		var timer = setTimeout(() => {
			console.log(`Timeout: ${pending.size} job(s) still pending after ${timeout / 1000}s`);
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
				console.log(`  ✓ ${pending.get(jobId)} completed`);
				pending.delete(jobId);
				if (pending.size === 0) {
					cleanup();
					resolve();
				}
			}
		});

		queueEvents.on('failed', ({ jobId, failedReason }) => {
			if (pending.has(jobId)) {
				console.log(`  ✗ ${pending.get(jobId)} failed: ${failedReason}`);
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

	var militime = Date.now();
	var strTime = DateTime.fromMillis(militime).toFormat('dd LLL yy  HH:mm:ss');
	console.log("\nRunning At", strTime);

	var dirLabel = (opts.doInbound && opts.doOutbound) ? 'in+out'
		: opts.doInbound ? 'inbound only'
		: 'outbound only';
	var typeLabels = [];
	if (opts.doFtn)  typeLabels.push('FTN');
	if (opts.doNntp) typeLabels.push('NNTP');
	if (opts.doQwk)  typeLabels.push('QWK');
	console.log('Tosser: ' + dirLabel + ' — types: ' + typeLabels.join(', '));
	console.log('Enqueueing jobs...');

	var enqueuedJobs = [];

	try {
		// FTN — uses the "all" functions that iterate connections internally
		if (opts.doFtn) {
			if (opts.doInbound) {
				var job = await jobs.enqueueFtnInbound();
				enqueuedJobs.push(job);
				console.log('  + ftn:inbound');
			}
			if (opts.doOutbound) {
				var job = await jobs.enqueueFtnOutbound();
				enqueuedJobs.push(job);
				console.log('  + ftn:outbound');
			}
		}

		// QWK — uses the "all" helpers for CLI compatibility
		if (opts.doQwk) {
			if (opts.doInbound) {
				var job = await jobs.enqueueQwkPullAll();
				enqueuedJobs.push(job);
				console.log('  + qwk:pull-all');
			}
			if (opts.doOutbound) {
				var job = await jobs.enqueueQwkPushAll();
				enqueuedJobs.push(job);
				console.log('  + qwk:push-all');
			}
		}

		// NNTP — uses the "all" helpers for CLI compatibility
		if (opts.doNntp) {
			if (opts.doInbound) {
				var job = await jobs.enqueueNntpPullAll();
				enqueuedJobs.push(job);
				console.log('  + nntp:pull-all');
			}
			if (opts.doOutbound) {
				var job = await jobs.enqueueNntpPushAll();
				enqueuedJobs.push(job);
				console.log('  + nntp:push-all');
			}
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
