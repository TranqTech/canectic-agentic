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
import { createEventPublisher, createEventSubscriber, EVENTS } from "../src/queues/events.js";
import * as fileWildcards from "../src/models/fileWildcards.js";
import * as netmailRoutes from "../src/models/netmailRoutes.js";
import { Worker } from 'bullmq';
import appConfig from "../src/config/appConfig.js";
import * as workerHealth from "../src/queues/workerHealth.js";
import { initMaintenanceWatch } from "../src/maintenance/maintenanceWatch.js";
import { startClosed, attachQueueDrain, consumerUp } from "../src/maintenance/queueDrain.js";
import * as outboundSweep from "../src/maintenance/outboundSweep.js";
import * as maintenanceJobs from "../src/maintenance/maintenanceJobs.js";
import * as transferFormat from "../src/utils/transferFormat.js";
import os from 'os';

// Tosser imports — relocated to middleware/tossers/
import * as ftnTosser from "../src/middleware/tossers/ftnTosser.js";
import * as nntpTosser from "../src/middleware/tossers/nntpTosser.js";
import * as qwkTosser from "../src/middleware/tossers/qwkTosser.js";
import * as ticTosser from "../src/middleware/tossers/ticTosser.js";
import * as emailTosser from "../src/middleware/tossers/emailTosser.js";

// Shared post-toss helpers (thread finalization, area stats)
import * as messages from "../src/models/messages.js";
import * as msgAreas from "../src/models/msgAreas.js";
import * as peerConnections from "../src/models/peerConnections.js";

// Maintenance imports — the maintenance job bodies live in
// src/maintenance/maintenanceJobs.js and load what they need themselves.
import * as userMsgPointers from "../src/models/userMsgPointers.js";
import * as userAreaSubs from "../src/models/userAreaSubs.js";
import * as userFilePointers from "../src/models/userFilePointers.js";

dotenv.config();
alogger.setProcessName('worker');

const systemvermsg = systeminfo.versionMsg();
const tossConcurrency = parseInt(process.env.WORKER_CONCURRENCY) || 3;

var tossWorker;
var maintWorker;
var eventPublisher;

// ---------------------------------------------------------------------------
// Liveness bookkeeping
//
// A worker that dies is the easy case: the supervisor restarts it and the
// heartbeat key expires in the meantime. The case that cost a hub four days of
// mail was a worker that stayed up, kept its event loop turning and its job
// locks renewed, and never finished another job. BullMQ's own stalled-job
// detection cannot see that, because a job sitting on an await that never
// settles renews its lock exactly like a healthy one. So the worker has to
// keep the books itself and publish them.
// ---------------------------------------------------------------------------
const startedAt = Date.now();
var _activeJobs = new Map();      // jobKey -> ms timestamp the job went active
var _lastJobAt = null;            // when a job of any kind last finished
var _heartbeatTimer = null;
var _selfCheckFailures = 0;

function _jobKey(job) {
	return String(job && job.queueName ? job.queueName : '?') + ':' + String(job && job.id ? job.id : '?');
}

// Jobs in flight per queue, for the maintenance drain status.
function activeJobCounts() {
	var toss = 0, maint = 0;
	for (var key of _activeJobs.keys()) {
		if (key.indexOf('toss:') === 0) toss++;
		else maint++;
	}
	return { 'toss jobs': toss, 'maintenance jobs': maint };
}

function _longestActiveMs(now) {
	var longest = 0;
	for (var startedMs of _activeJobs.values()) {
		var age = now - startedMs;
		if (age > longest) longest = age;
	}
	return longest;
}

/**
 * Bookkeeping wrapper around workerHealth.withTimeout.
 *
 * The timeout itself lives in workerHealth so it can be tested; what belongs
 * here is the record of which jobs are in flight and when they started, which
 * is what the heartbeat publishes and what makes a wedged worker visible from
 * outside the process.
 */
function withJobTimeout(processor, timeoutKey, defaultMinutes) {
	var timed = null;
	var timedForMs = null;

	return async function (job) {
		var key = _jobKey(job);
		_activeJobs.set(key, Date.now());

		try {
			// Read the limit per job rather than once at startup, so a sysop
			// raising it from /admin/config takes effect without a restart.
			// The wrapper is rebuilt only when the value actually changes.
			var timeoutMs = appConfig.getNumber(timeoutKey, defaultMinutes) * 60 * 1000;
			if (timed === null || timedForMs !== timeoutMs) {
				timed = workerHealth.withTimeout(processor, timeoutMs, timeoutKey);
				timedForMs = timeoutMs;
			}
			return await timed(job);
		} finally {
			_activeJobs.delete(key);
			_lastJobAt = Date.now();
		}
	};
}

/**
 * Publish liveness, and decide whether this process is still fit to run.
 *
 * Exiting is the right answer to a consumer that has stopped: the supervisor
 * brings back a clean process, and BullMQ hands the in-flight jobs to it. The
 * failure has to persist across several beats first, because a single failed
 * Redis round trip during a network blip is not a reason to drop the process.
 */
async function _beat() {
	var now = Date.now();
	// Paused for maintenance is not down: BullMQ's pause() ends the main loop,
	// so isRunning() goes false, and counting that as a dead consumer would
	// exit the process mid-maintenance and bring it back unpaused.
	var tossUp  = consumerUp(tossWorker);
	var maintUp = consumerUp(maintWorker);

	if (tossUp && maintUp) {
		_selfCheckFailures = 0;
	} else {
		_selfCheckFailures++;
		alogger.writeAlog(1, '[Worker] queue consumer down (toss=' + (tossUp ? 'up' : 'down') +
			' maintenance=' + (maintUp ? 'up' : 'down') + '), strike ' + _selfCheckFailures,
			'redbright', true);

		var maxFailures = appConfig.getNumber('worker_selfcheck_max_failures', 3);
		if (_selfCheckFailures >= maxFailures) {
			alogger.writeAlog(0, '[Worker] consumer has not recovered after ' + _selfCheckFailures +
				' checks, exiting so the supervisor can restart a clean process', 'redbright', true);
			// Leave the heartbeat in place rather than marking a clean stop:
			// this is a fault, and the watchdog should still see it as one if
			// the supervisor does not bring us back.
			process.exit(1);
		}
	}

	await workerHealth.writeHeartbeat(workerHealth.buildHeartbeat({
		state:     workerHealth.STATE_OK,
		pid:       process.pid,
		host:      os.hostname(),
		startedAt: startedAt,
		ts:        now,
		toss:      { running: !!(tossWorker && tossWorker.isRunning()),  paused: !!(tossWorker && tossWorker.isPaused()),  active: 0 },
		maint:     { running: !!(maintWorker && maintWorker.isRunning()), paused: !!(maintWorker && maintWorker.isPaused()), active: 0 },
		lastJobAt: _lastJobAt,
		longestActiveMs: _longestActiveMs(now)
	}), appConfig.getNumber('worker_heartbeat_interval', 30) * 6);
}

function startHeartbeat() {
	if (_heartbeatTimer) return;
	var everySec = appConfig.getNumber('worker_heartbeat_interval', 30);
	if (everySec < 5) everySec = 5;

	_beat().catch(function () {});
	_heartbeatTimer = setInterval(function () {
		_beat().catch(function (err) {
			alogger.writeAlog(4, '[Worker] heartbeat failed: ' + err.message, 'yellow');
		});
	}, everySec * 1000);
	if (_heartbeatTimer.unref) _heartbeatTimer.unref();

	alogger.writeAlog(2, '[Worker] heartbeat every ' + everySec + 's', 'cyan');
}

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
	if (_heartbeatTimer) clearInterval(_heartbeatTimer);
	// Record that this was deliberate. Without it the gateway watchdog cannot
	// tell a sysop stopping the worker from the worker falling over, and would
	// spend the maintenance window restarting it underneath them.
	try { await workerHealth.markStopped(process.pid); } catch (_) {}
	if (tossWorker) await tossWorker.close();
	if (maintWorker) await maintWorker.close();
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
// Post-toss maintenance
// Runs after inbound toss jobs to finalize threads and update area stats.
// Same logic as postTossMaint() in the old CLI tosser.
// ---------------------------------------------------------------------------

async function postTossMaint() {
	// Drain and finalize any threads queued during import.
	// drainThreadUpdateArray() returns parsed entries and clears the queue
	// atomically — safe for long-lived processes.
	var updatearray = messages.drainThreadUpdateArray();
	if (updatearray.length > 0) {
		alogger.writeAlog(3, `[Worker] Updating ${updatearray.length} thread(s)`, "cyan");
		await messages.updateThreadArray(updatearray);
	}

	// Post-batch orphan reconciliation: re-link replies whose parents
	// arrived in the same batch (out-of-order delivery).
	var importedIds = messages.drainImportedMsgIds();
	if (importedIds.length > 0) {
		// Group by shortcode
		var byArea = {};
		for (var item of importedIds) {
			if (!byArea[item.shortcode]) byArea[item.shortcode] = [];
			byArea[item.shortcode].push(item.msgId);
		}
		for (var sc in byArea) {
			await messages.reconcileOrphans(sc, byArea[sc]);
		}
		// Drain any thread updates queued by reconciliation
		var reconUpdates = messages.drainThreadUpdateArray();
		if (reconUpdates.length > 0) {
			await messages.updateThreadArray(reconUpdates);
		}
	}

	await msgAreas.updateAreaStats();
}

// ---------------------------------------------------------------------------
// Toss queue processor
// ---------------------------------------------------------------------------

// Log what a QWK or NNTP pull or push came to. Every one used to end with the
// same "finished" line, so a pull that timed out read like one that worked;
// the row in network_transfers is the durable record, this is the log line.
function reportTransfer(protocol, direction, uuid, result) {
	var d = transferFormat.describeResult(protocol, direction, uuid, result);
	alogger.writeAlog(d.level, '[Worker] ' + d.text, d.colour);
}

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
					// TossOutbound() now enqueues bso-scan internally;
					// no additional signal needed here.
					eventPublisher.publish(EVENTS.TOSS_COMPLETE, {
						source: 'ftn', direction: 'outbound'
					});
					break;
				}

				// --- QWK -----------------------------------------------------------

				// Per-connection pull (used by scheduler, admin)
				case 'qwk:pull': {
					var qwkPulled = null;
					if (job.data.connectionUUID) {
						qwkPulled = await qwkTosser.pullFromQwkPeer(job.data.connectionUUID);
						reportTransfer('QWK', 'pull', job.data.connectionUUID, qwkPulled);
					}
					await postTossMaint();
					if (transferFormat.importedAnything(qwkPulled)) {
						eventPublisher.publish(EVENTS.MESSAGES_IMPORTED, {
							source: 'qwk', connectionUUID: job.data.connectionUUID
						});
					}
					break;
				}

				// Per-connection push (used by scheduler, admin)
				case 'qwk:push':
					if (job.data.connectionUUID) {
						var qwkPushed = await qwkTosser.pushToQwkPeer(job.data.connectionUUID);
						if (!qwkPushed.notRecorded) reportTransfer('QWK', 'push', job.data.connectionUUID, qwkPushed);
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

				// Hub side of shared-directory nodes (schedule qwk-hub-sweep)
				case 'qwk:hub-sweep': {
					var hubSwept = await qwkTosser.serviceHubNodes();
					if (hubSwept.repsImported > 0) await postTossMaint();
					if (transferFormat.importedAnything(hubSwept)) {
						eventPublisher.publish(EVENTS.MESSAGES_IMPORTED, { source: 'qwk:hub' });
					}
					break;
				}

				// Hub mode inbound (node drops .rep)
				case 'qwk:hub:inbound': {
					// Every REP the node has left, not just the first.
					var hubPulled = null;
					if (job.data.connectionUUID) {
						var hubResults = await qwkTosser.pullHubReps(job.data.connectionUUID);
						for (var hr of hubResults) {
							if (!hr.notRecorded) reportTransfer('QWK', 'pull', job.data.connectionUUID, hr);
						}
						hubPulled = { totalImported: hubResults.reduce(function (n, hr) { return n + (hr.totalImported || 0); }, 0) };
					}
					await postTossMaint();
					if (transferFormat.importedAnything(hubPulled)) {
						eventPublisher.publish(EVENTS.MESSAGES_IMPORTED, {
							source: 'qwk:hub', connectionUUID: job.data.connectionUUID
						});
					}
					break;
				}

				// --- TIC (file echoes) ---------------------------------------------

				case 'tic:inbound':
					await ticTosser.tossInbound();
					eventPublisher.publish(EVENTS.FILES_IMPORTED, {
						source: 'tic', direction: 'inbound'
					});
					break;

				case 'tic:outbound':
					await ticTosser.tossOutbound();
					eventPublisher.publish(EVENTS.TOSS_COMPLETE, {
						source: 'tic', direction: 'outbound'
					});
					break;

				// --- NNTP ----------------------------------------------------------

				// Per-connection pull
				case 'nntp:pull': {
					var nntpPulled = null;
					if (job.data.connectionUUID) {
						nntpPulled = await nntpTosser.pullFromPeer(job.data.connectionUUID);
						reportTransfer('NNTP', 'pull', job.data.connectionUUID, nntpPulled);
					}
					await postTossMaint();
					if (transferFormat.importedAnything(nntpPulled)) {
						eventPublisher.publish(EVENTS.MESSAGES_IMPORTED, {
							source: 'nntp', connectionUUID: job.data.connectionUUID
						});
					}
					break;
				}

				// Per-connection push
				case 'nntp:push':
					if (job.data.connectionUUID) {
						var nntpPushed = await nntpTosser.pushToNntpPeer(job.data.connectionUUID);
						if (!nntpPushed.notRecorded) reportTransfer('NNTP', 'push', job.data.connectionUUID, nntpPushed);
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

				// --- EMAIL ---------------------------------------------------------

				case 'email:outbound':
					await emailTosser.tossOutbound();
					break;

				// --- Outbound sweep (all protocols) ----------------------------

				case 'outbound-sweep': {
					alogger.writeAlog(3, "[Worker] Outbound sweep: tossing all protocols", "cyan");
					await outboundSweep.runOutboundSweep({
						ticTosser, ftnTosser, qwkTosser, nntpTosser, emailTosser,
						peerConnections,
						log: function (level, message, colour) {
							alogger.writeAlog(level, message, colour);
						},
					});
					eventPublisher.publish(EVENTS.TOSS_COMPLETE, {
						source: 'sweep', direction: 'outbound'
					});
					break;
				}

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

		// The switch lives in src/maintenance/maintenanceJobs.js because the
		// embedded worker consumes this same queue and used to carry its own
		// copy, which had drifted to 7 of 33 job names. An unhandled name is
		// marked complete, so the drift was silent.
		var handled = await maintenanceJobs.runMaintenanceJob(job.name, job.data, {
			logPrefix: '[Worker]',
		});
		if (!handled) {
			alogger.writeAlog(3, `[Worker] Unknown maintenance job: ${job.name}`, "yellowbright");
		}
	};
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main() {
	await alogger.initLogBus();

	// Startup validation: fail fast if DB or Redis is unreachable
	try {
		await pgpool.query('SELECT 1');
	} catch (err) {
		alogger.writeAlog(0, "PostgreSQL is not reachable: " + err.message, "redbright", true);
		process.exit(1);
	}
	try {
		var rc = await redis.getClient();
		await rc.ping();
	} catch (err) {
		alogger.writeAlog(0, "Redis is not reachable: " + err.message, "redbright", true);
		process.exit(1);
	}

	await appConfig.load();
	alogger.writeAlog(1, systemvermsg + "\n  Worker Process Startup", "yellowbright", true);

	var queueConfig = getQueueConfig();
	alogger.writeAlog(2, `[Worker] Redis: ${queueConfig.host}:${queueConfig.port} db=${queueConfig.db}`, "cyan");

	// Run startup constraint checks (same as gateway prerunMaint)
	await userMsgPointers.ensureConstraintsAndIndexes();
	await userAreaSubs.ensureConstraintsAndIndexes();
	await userFilePointers.ensureConstraintsAndIndexes();

	// Ensure QWK conference numbers are populated on message areas
	var msgAreasInit = await import("../src/models/msgAreas.js");
	await msgAreasInit.ensureQwkConfNumbers();

	// Ensure UNIQUE constraint on message_groups.qwk_conf_start
	var msgGroupsInit = await import("../src/models/msgGroups.js");
	await msgGroupsInit.ensureQwkConfStartConstraint();

	// Ensure FTN nodelist table exists for import jobs and router lookups
	var ftnNodelist = await import("../src/models/ftnNodelist.js");
	await ftnNodelist.ensureTable();

	// Seed the MSGID counter in Redis from DB state for today's day bucket.
	// Idempotent across processes; first one wins, others see the key and
	// return. Must run after appConfig.load() and after Postgres+Redis are
	// ready so the DB scan for max existing serial can complete.
	try {
		var ftnUtils = await import("../src/utils/ftnUtils.js");
		await ftnUtils.initializeMsgidCounter();
	} catch (e) {
		alogger.writeAlog(2, '[Worker] MSGID counter init failed: ' + e.message, 'yellow');
	}

	// Event publisher for notifying other processes
	eventPublisher = createEventPublisher();

	// Create workers with their own connections
	var tossConnection = createQueueConnection();
	var maintConnection = createQueueConnection();

	// On a closed board (the updater restarts us with the flag still set) the
	// consumers must not take a job before the maintenance watch has had its
	// first look, so they are created without running and paused.
	var closedAtStart = startClosed();

	tossWorker = new Worker('toss', withJobTimeout(createTossProcessor(), 'toss_job_timeout', 30), {
		connection: tossConnection,
		concurrency: tossConcurrency,
		autorun: !closedAtStart,
	});

	tossWorker.on('failed', (job, err) => {
		alogger.writeAlog(2, `[Worker] Toss job FAILED: ${job?.name} — ${err.message}`, "redbright");
	});

	tossWorker.on('error', (err) => {
		alogger.writeAlog(2, `[Worker] Toss worker error: ${err.message}`, "redbright");
	});

	maintWorker = new Worker('maintenance', withJobTimeout(createMaintenanceProcessor(), 'maintenance_job_timeout', 60), {
		connection: maintConnection,
		concurrency: 1,   // maintenance jobs run one at a time
		autorun: !closedAtStart,
	});

	if (closedAtStart) {
		await tossWorker.pause();
		await maintWorker.pause();
		alogger.writeAlog(1, '[Worker] Board is in maintenance mode: queues start paused', 'yellowbright', true);
	}

	maintWorker.on('failed', (job, err) => {
		alogger.writeAlog(2, `[Worker] Maintenance FAILED: ${job?.name} — ${err.message}`, "redbright");
	});

	maintWorker.on('error', (err) => {
		alogger.writeAlog(2, `[Worker] Maintenance worker error: ${err.message}`, "redbright");
	});

	// Cross-process invalidation subscriber
	var eventSubscriber = createEventSubscriber((event) => {
		if (event.type === EVENTS.CONFIG_CHANGED) {
			alogger.writeAlog(3, "[Worker] Config changed, reloading", "cyan");
			appConfig.reload();
			emailTosser.resetTransporter();
		} else if (event.type === EVENTS.WILDCARDS_CHANGED) {
			alogger.writeAlog(4, "[Worker] Wildcard rules changed, invalidating cache", "cyan");
			fileWildcards.invalidateCache();
		} else if (event.type === EVENTS.NETMAIL_ROUTES_CHANGED) {
			alogger.writeAlog(4, "[Worker] Netmail routes changed, invalidating cache", "cyan");
			netmailRoutes.invalidateCache();
		}
	});

	// Maintenance mode: pause both queues while the board is closed, and
	// report jobs still in flight so the updater knows when the worker is idle.
	var watch = initMaintenanceWatch({
		process: 'worker',
		graceDefault: function () { return appConfig.getNumber('maintenance_grace_seconds', 300); },
		log: function (level, message) { alogger.writeAlog(level, '[Worker] ' + message, 'yellowbright'); }
	});
	attachQueueDrain(watch,
		[{ name: 'toss', worker: tossWorker }, { name: 'maintenance', worker: maintWorker }],
		function () { return activeJobCounts(); },
		function (level, message) { alogger.writeAlog(level, '[Worker] ' + message, 'yellowbright'); });
	watch.start();

	startHeartbeat();

	alogger.writeAlog(1, `[Worker] Ready — toss(concurrency=${tossConcurrency}) + maintenance`, "greenbright", true);
}

await main();
