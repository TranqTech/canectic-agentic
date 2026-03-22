#!/usr/bin/env node

/**
 * Canectic BBS — Mailer Process
 *
 * Runs the FTN mailer as a standalone process.  Manages binkp sessions
 * (inbound and outbound), file transfers, and its own TCP/WS listeners.
 *
 * Consumes the `mailer` BullMQ queue for:
 *   - signal-outbound  (worker finished tossing outbound, trigger CRASH poll)
 *   - trigger-poll     (admin manual poll)
 *   - poll-scheduled   (repeatable schedule from gateway)
 *
 * Produces `toss` queue jobs when files are received from a session.
 *
 * Usage:
 *   node bin/mailer.js
 *
 * Environment:
 *   MAILER_ENABLED     — must be 'true' to start (default: false)
 *   MAILER_BINKP_PORT  — TCP listener port (default: 24554)
 *   MAILER_WS_PORT     — WebSocket listener port (default: 24555)
 *   redis_url          — Redis connection
 *   REDIS_BULLMQ_DB    — Redis DB for job data (default: 2)
 */

import * as dotenv from 'dotenv';
import * as alogger from "../src/utils/alogger.js";
import * as systeminfo from "../src/utils/systeminfo.js";
import { pgpool } from "../src/middleware/db/postgres.js";
import * as redis from "../src/middleware/db/redis.js";
import { MailerManager } from "../src/mailer/manager.js";
import { nodeManager } from "../src/managers/nodemanager.js";
import { createQueueConnection, getQueueConfig } from "../src/queues/connection.js";
import { closeQueues } from "../src/queues/queues.js";
import * as jobs from "../src/queues/jobs.js";
import { createEventPublisher, createEventSubscriber, EVENTS } from "../src/queues/events.js";
import { Worker } from 'bullmq';
import appConfig from "../src/config/appConfig.js";

dotenv.config();
alogger.setProcessName('mailer');

const systemvermsg = systeminfo.versionMsg();
var mailerManager;
var mailerWorker;
var eventPublisher;

// ---------------------------------------------------------------------------
// Safety catches
// ---------------------------------------------------------------------------

process.on('uncaughtException', (err) => {
	alogger.writeAlog(0, `[Mailer] Uncaught exception: ${err.stack}`, "redbright");
});

process.on('unhandledRejection', (reason) => {
	alogger.writeAlog(0, `[Mailer] Unhandled rejection: ${reason}`, "redbright");
});

async function shutdown() {
	alogger.writeAlog(1, "[Mailer] Shutting down", "yellowbright", true);
	if (mailerManager) mailerManager.stop();
	if (mailerWorker) await mailerWorker.close();
	await closeQueues();
	if (eventPublisher) eventPublisher.shutdown();
	alogger.shutdownLogBus();
	pgpool.end();
	redis.shutdown();
	process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main() {
	await alogger.initLogBus();
	await appConfig.load();
	alogger.writeAlog(1, systemvermsg + "\n  Mailer Process Startup", "yellowbright", true);

	// Check enable flag
	if (process.env.MAILER_ENABLED !== 'true') {
		alogger.writeAlog(1, "[Mailer] Disabled — set MAILER_ENABLED=true to enable", "yellow");
		process.exit(0);
	}

	var queueConfig = getQueueConfig();
	alogger.writeAlog(2, `[Mailer] Redis: ${queueConfig.host}:${queueConfig.port} db=${queueConfig.db}`, "cyan");

	// Load node config (read-only — for peer connection parameters)
	var nm = new nodeManager();
	nm.listUsedNodes();

	// Event publisher for notifying gateway and worker
	eventPublisher = createEventPublisher();

	// Start the mailer manager (TCP + WS listeners, session pool)
	mailerManager = new MailerManager();
	mailerManager.start();

	// Wire the mailer's file-received event to enqueue a toss job
	// MailerManager should emit 'filesReceived' when a binkp session
	// completes inbound file transfers.
	if (typeof mailerManager.on === 'function') {
		mailerManager.on('filesReceived', async (data) => {
			alogger.writeAlog(2, `[Mailer] Files received from ${data.connectionUUID || 'unknown'}, enqueueing FTN inbound + TIC toss`, "cyan");
			await jobs.enqueueFtnInbound({ connectionUUID: data.connectionUUID });
			await jobs.enqueueTicInbound({ connectionUUID: data.connectionUUID });
			eventPublisher.publish(EVENTS.MAILER_SESSION_END, {
				connectionUUID: data.connectionUUID,
				filesReceived: data.fileCount || 0,
			});
		});
	}

	// Consume the mailer queue
	var connection = createQueueConnection();
	mailerWorker = new Worker('mailer', async (job) => {
		alogger.writeAlog(2, `[Mailer] Job: ${job.name}  connection=${job.data.connectionUUID || 'n/a'}`, "cyan");

		switch (job.name) {
			case 'signal-outbound':
				// Worker finished outbound toss — signal the mailer to check
				// for new packets.  For CRASH connections this triggers
				// immediate poll; for NORMAL it's a no-op if already scheduled.
				await mailerManager.signalOutbound(job.data.connectionUUID);
				break;

			case 'trigger-poll':
				// Admin manual poll — bypasses guards, always connects
				await mailerManager.triggerPoll(job.data.connectionUUID);
				break;

			case 'poll-scheduled':
				// Repeatable schedule — normal poll with all guards
				await mailerManager.pollConnection(job.data.connectionUUID);
				break;

			case 'nodelist-connect':
				// Connect to a nodelist-resolved address (no peer record)
				mailerManager.connectToNodelistAddress(
					job.data.nodelistData,
					job.data.destinationAddress
				);
				break;

			case 'bso-scan':
				// On-demand BSO directory scan — triggered by tossers after
				// outbound packets are written
				await mailerManager.scanOutboundNow();
				break;

			default:
				alogger.writeAlog(3, `[Mailer] Unknown job: ${job.name}`, "yellowbright");
		}
	}, {
		connection,
		concurrency: 5,   // multiple polls can run concurrently
	});

	mailerWorker.on('failed', (job, err) => {
		alogger.writeAlog(2, `[Mailer] Job FAILED: ${job?.name} — ${err.message}`, "redbright");
	});

	mailerWorker.on('error', (err) => {
		alogger.writeAlog(2, `[Mailer] Worker error: ${err.message}`, "redbright");
	});

	// Config reload subscriber
	var eventSubscriber = createEventSubscriber((event) => {
		if (event.type === EVENTS.CONFIG_CHANGED) {
			alogger.writeAlog(3, "[Mailer] Config changed, reloading", "cyan");
			appConfig.reload();
		}
	});

	alogger.writeAlog(1, "[Mailer] Ready — consuming mailer queue", "greenbright", true);
}

await main();
