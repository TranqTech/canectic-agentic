/**
 * BullMQ queue definitions.
 *
 * Three queues, each consumed by a specific process:
 *   toss         — worker process (FTN/QWK/NNTP tossers, future TIC)
 *   mailer       — mailer process (poll triggers, outbound signals)
 *   maintenance  — worker process (body_html regen, PM trash purge, etc.)
 *
 * Queues are safe to instantiate in any process — they only schedule jobs.
 * Workers (consumers) are registered separately in the process that handles
 * the work.
 */

import { Queue } from 'bullmq';
import { createQueueConnection } from './connection.js';

// ---------------------------------------------------------------------------
// Shared connection for queue producers (enqueue side).
// Each Worker creates its own connection — see bin/worker.js, bin/mailer.js.
// ---------------------------------------------------------------------------
const connection = createQueueConnection();

// ---------------------------------------------------------------------------
// Queue: toss
// Consumed by the worker process.  Handles all network toss operations.
// ---------------------------------------------------------------------------
export const tossQueue = new Queue('toss', {
	connection,
	defaultJobOptions: {
		attempts: 3,
		backoff: { type: 'exponential', delay: 5000 },
		removeOnComplete: { count: 200 },
		removeOnFail: { count: 500 },
	}
});

// ---------------------------------------------------------------------------
// Queue: mailer
// Consumed by the mailer process.  Handles poll triggers and outbound signals.
// ---------------------------------------------------------------------------
export const mailerQueue = new Queue('mailer', {
	connection,
	defaultJobOptions: {
		attempts: 2,
		backoff: { type: 'fixed', delay: 10000 },
		removeOnComplete: { count: 100 },
		removeOnFail: { count: 200 },
	}
});

// ---------------------------------------------------------------------------
// Queue: maintenance
// Consumed by the worker process.  Handles body_html regen, PM purge, etc.
// Maintenance jobs are typically single-attempt (failures should be reviewed,
// not blindly retried).
// ---------------------------------------------------------------------------
export const maintenanceQueue = new Queue('maintenance', {
	connection,
	defaultJobOptions: {
		attempts: 1,
		removeOnComplete: { count: 50 },
		removeOnFail: { count: 100 },
	}
});

/**
 * Graceful shutdown — close the shared producer connection.
 * Call from the process's SIGINT/SIGTERM handler.
 */
export async function closeQueues() {
	await tossQueue.close();
	await mailerQueue.close();
	await maintenanceQueue.close();
	connection.disconnect();
}
