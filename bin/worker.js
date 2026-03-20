#!/usr/bin/env node

/**
 * Canectic BBS — Worker Process
 *
 * Consumes the `toss` and `maintenance` BullMQ queues.  Handles all network
 * tossing (FTN, QWK, NNTP) and maintenance tasks (body_html regen, PM trash
 * purge, area count recalculation).
 *
 * Runs as a separate OS process from the gateway and mailer.  Can crash and
 * restart independently — BullMQ retries failed jobs automatically.
 *
 * Usage:
 *   node bin/worker.js
 *
 * Environment:
 *   redis_url          — Redis connection (default: redis://localhost:6379)
 *   REDIS_BULLMQ_DB   — Redis DB for job data (default: 2)
 *   NODE_ENV           — environment name for logging
 *   WORKER_CONCURRENCY — toss queue concurrency (default: 3)
 */

import * as dotenv from 'dotenv';
import * as alogger from "../src/utils/alogger.js";
import * as systeminfo from "../src/utils/systeminfo.js";
import { pgpool } from "../src/middleware/db/postgres.js";
import * as redis from "../src/middleware/db/redis.js";
import { createQueueConnection, getQueueConfig } from "../src/queues/connection.js";
import { closeQueues } from "../src/queues/queues.js";
import * as jobs from "../src/queues/jobs.js";
import { createEventPublisher, EVENTS } from "../src/queues/events.js";
import { Worker } from 'bullmq';

// Tosser imports — relocated to middleware/tossers/
import * as ftnTosser from "../src/middleware/tossers/ftnTosser.js";
import * as nntpTosser from "../src/middleware/tossers/nntpTosser.js";
import * as qwkTosser from "../src/middleware/tossers/qwkTosser.js";

// Shared post-toss helpers (thread finalization, area stats)
import * as echomail from "../src/models/echomail.js";
import * as msgAreas from "../src/models/msgAreas.js";
import * as peerConnections from "../src/models/peerConnections.js";

// Maintenance imports
import * as messageBase from "../src/maintenance/messageBase.js";
import * as privateMessages from "../src/models/privateMessages.js";
import * as userMsgPointers from "../src/models/userMsgPointers.js";
import * as userAreaSubs from "../src/models/userAreaSubs.js";

dotenv.config();

const systemvermsg = systeminfo.versionMsg();
const tossConcurrency = parseInt(process.env.WORKER_CONCURRENCY) || 3;

var tossWorker;
var maintWorker;
var eventPublisher;

// ---------------------------------------------------------------------------
// Safety catches
// ---------------------------------------------------------------------------

process.on('uncaughtException', (err) => {
	alogger.writeAlog(0, `[Worker] Uncaught exception: ${err.stack}`, "redbright");
});

process.on('unhandledRejection', (reason) => {
	alogger.writeAlog(0, `[Worker] Unhandled rejection: ${reason}`, "redbright");
});

async function shutdown() {
	alogger.writeAlog(1, "[Worker] Shutting down", "yellowbright", true);
	if (tossWorker) await tossWorker.close();
	if (maintWorker) await maintWorker.close();
	await closeQueues();
	if (eventPublisher) eventPublisher.shutdown();
	pgpool.end();
	redis.shutdown();
	process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ---------------------------------------------------------------------------
// Post-toss maintenance
// Runs after inbound toss jobs to finalize threads and update area stats.
// Same logic as postTossMaint() in the old CLI tosser.
// ---------------------------------------------------------------------------

async function postTossMaint() {
	// Drain and finalize any threads queued during import.
	// drainThreadUpdateArray() returns parsed entries and clears the queue
	// atomically — safe for long-lived processes.
	var updatearray = echomail.drainThreadUpdateArray();
	if (updatearray.length > 0) {
		alogger.writeAlog(3, `[Worker] Updating ${updatearray.length} thread(s)`, "cyan");
		await echomail.updateThreadArray(updatearray);
	}
	await msgAreas.updateAreaStats();
}

// ---------------------------------------------------------------------------
// Toss queue processor
// ---------------------------------------------------------------------------

function createTossProcessor() {
	return async function processTossJob(job) {
		var startTime = Date.now();
		alogger.writeAlog(2, `[Worker] Toss job: ${job.name}  id=${job.id}`, "cyan");

		try {
			switch (job.name) {

				// --- FTN -----------------------------------------------------------

				case 'ftn:inbound':
					await ftnTosser.TossInbound();
					await postTossMaint();
					eventPublisher.publish(EVENTS.MESSAGES_IMPORTED, {
						source: 'ftn', direction: 'inbound'
					});
					break;

				case 'ftn:outbound': {
					await ftnTosser.TossOutbound();
					// Signal mailer for any connections with CRASH status
					if (job.data.connectionUUID) {
						await jobs.enqueueMailerSignalOutbound(job.data.connectionUUID);
					}
					eventPublisher.publish(EVENTS.TOSS_COMPLETE, {
						source: 'ftn', direction: 'outbound'
					});
					break;
				}

				// --- QWK -----------------------------------------------------------

				// Per-connection pull (used by scheduler, admin)
				case 'qwk:pull':
					if (job.data.connectionUUID) {
						await qwkTosser.pullFromQwkPeer(job.data.connectionUUID);
					}
					await postTossMaint();
					eventPublisher.publish(EVENTS.MESSAGES_IMPORTED, {
						source: 'qwk', connectionUUID: job.data.connectionUUID
					});
					break;

				// Per-connection push (used by scheduler, admin)
				case 'qwk:push':
					if (job.data.connectionUUID) {
						await qwkTosser.pushToQwkPeer(job.data.connectionUUID);
					}
					eventPublisher.publish(EVENTS.TOSS_COMPLETE, {
						source: 'qwk', direction: 'outbound',
						connectionUUID: job.data.connectionUUID
					});
					break;

				// All-connections pull (used by CLI tosser for current behavior)
				case 'qwk:pull-all':
					await qwkTosser.pullAllQWK();
					await postTossMaint();
					eventPublisher.publish(EVENTS.MESSAGES_IMPORTED, { source: 'qwk' });
					break;

				// All-connections push (used by CLI tosser)
				case 'qwk:push-all':
					await qwkTosser.pushAllQWK();
					eventPublisher.publish(EVENTS.TOSS_COMPLETE, {
						source: 'qwk', direction: 'outbound'
					});
					break;

				// Hub mode inbound (node drops .rep)
				case 'qwk:hub:inbound':
					if (job.data.connectionUUID) {
						await qwkTosser.pullFromQwkPeer(job.data.connectionUUID);
					}
					await postTossMaint();
					eventPublisher.publish(EVENTS.MESSAGES_IMPORTED, {
						source: 'qwk:hub', connectionUUID: job.data.connectionUUID
					});
					break;

				// --- NNTP ----------------------------------------------------------

				// Per-connection pull
				case 'nntp:pull':
					if (job.data.connectionUUID) {
						await nntpTosser.pullFromPeer(job.data.connectionUUID);
					}
					await postTossMaint();
					eventPublisher.publish(EVENTS.MESSAGES_IMPORTED, {
						source: 'nntp', connectionUUID: job.data.connectionUUID
					});
					break;

				// Per-connection push
				case 'nntp:push':
					if (job.data.connectionUUID) {
						await nntpTosser.pushToNntpPeer(job.data.connectionUUID);
					}
					eventPublisher.publish(EVENTS.TOSS_COMPLETE, {
						source: 'nntp', direction: 'outbound',
						connectionUUID: job.data.connectionUUID
					});
					break;

				// All-connections pull (used by CLI tosser)
				case 'nntp:pull-all':
					await nntpTosser.pullAllNNTP();
					await postTossMaint();
					eventPublisher.publish(EVENTS.MESSAGES_IMPORTED, { source: 'nntp' });
					break;

				// All-connections push (used by CLI tosser)
				case 'nntp:push-all':
					await nntpTosser.pushAllNNTP();
					eventPublisher.publish(EVENTS.TOSS_COMPLETE, {
						source: 'nntp', direction: 'outbound'
					});
					break;

				default:
					alogger.writeAlog(3, `[Worker] Unknown toss job: ${job.name}`, "yellowbright");
			}
		} finally {
			var elapsed = Date.now() - startTime;
			alogger.writeAlog(3, `[Worker] Toss job ${job.name} finished in ${elapsed}ms`, "cyan");
		}
	};
}

// ---------------------------------------------------------------------------
// Maintenance queue processor
// ---------------------------------------------------------------------------

function createMaintenanceProcessor() {
	return async function processMaintenanceJob(job) {
		alogger.writeAlog(2, `[Worker] Maintenance: ${job.name}`, "cyan");

		switch (job.name) {

			case 'regen-html':
				await messageBase.regenerateAllBodyHtml({
					areas: job.data.areas,
					batchSize: job.data.batchSize,
					forceWidth: job.data.forceWidth,
				});
				break;

			case 'regen-pm-html':
				await messageBase.regeneratePmBodyHtml({
					batchSize: job.data.batchSize,
					forceWidth: job.data.forceWidth,
				});
				break;

			case 'purge-pm-trash':
				await privateMessages.purgeDeleted(job.data.days);
				break;

			case 'recalc-area-counts': {
				await msgAreas.recalculateAreaCounts();
				break;
			}

			default:
				alogger.writeAlog(3, `[Worker] Unknown maintenance job: ${job.name}`, "yellowbright");
		}
	};
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main() {
	alogger.writeAlog(1, systemvermsg + "\n  Worker Process Startup", "yellowbright", true);

	var queueConfig = getQueueConfig();
	alogger.writeAlog(2, `[Worker] Redis: ${queueConfig.host}:${queueConfig.port} db=${queueConfig.db}`, "cyan");

	// Run startup constraint checks (same as gateway prerunMaint)
	await userMsgPointers.ensureConstraintsAndIndexes();
	await userAreaSubs.ensureConstraintsAndIndexes();

	// Event publisher for notifying other processes
	eventPublisher = createEventPublisher();

	// Create workers with their own connections
	var tossConnection = createQueueConnection();
	var maintConnection = createQueueConnection();

	tossWorker = new Worker('toss', createTossProcessor(), {
		connection: tossConnection,
		concurrency: tossConcurrency,
	});

	tossWorker.on('failed', (job, err) => {
		alogger.writeAlog(2, `[Worker] Toss job FAILED: ${job?.name} — ${err.message}`, "redbright");
	});

	tossWorker.on('error', (err) => {
		alogger.writeAlog(2, `[Worker] Toss worker error: ${err.message}`, "redbright");
	});

	maintWorker = new Worker('maintenance', createMaintenanceProcessor(), {
		connection: maintConnection,
		concurrency: 1,   // maintenance jobs run one at a time
	});

	maintWorker.on('failed', (job, err) => {
		alogger.writeAlog(2, `[Worker] Maintenance FAILED: ${job?.name} — ${err.message}`, "redbright");
	});

	maintWorker.on('error', (err) => {
		alogger.writeAlog(2, `[Worker] Maintenance worker error: ${err.message}`, "redbright");
	});

	alogger.writeAlog(1, `[Worker] Ready — toss(concurrency=${tossConcurrency}) + maintenance`, "greenbright", true);
}

await main();
