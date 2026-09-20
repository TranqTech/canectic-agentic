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

// Maintenance imports
import * as messageBase from "../src/maintenance/messageBase.js";
import * as privateMessages from "../src/models/privateMessages.js";
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
	var tossUp  = !!(tossWorker && tossWorker.isRunning());
	var maintUp = !!(maintWorker && maintWorker.isRunning());

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
		toss:      { running: tossUp,  paused: !!(tossWorker && tossWorker.isPaused()),  active: 0 },
		maint:     { running: maintUp, paused: !!(maintWorker && maintWorker.isPaused()), active: 0 },
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

			case 'pm-purged-cleanup': {
				// Hourly + on-demand background cleanup of rows tagged
				// for hard delete by purgeMessage / purgeDeleted. Drains
				// in batches until exhausted so a backed-up queue catches
				// up in one job run rather than waiting for the next tick.
				var cleanupResult;
				do {
					cleanupResult = await privateMessages.executePurgedCleanup({
						batchSize: job.data.batchSize || 500,
					});
				} while (cleanupResult && cleanupResult.pendingMore);
				break;
			}

			case 'purge-notifications': {
				var notifMod = await import("../src/models/notifications.js");
				await notifMod.purgeOld(job.data.days);
				break;
			}

			case 'purge-tossed': {
				var tossedDir = appConfig.get('ftntossed', 'ftn/tossed');
				var keepDays = job.data.days || 7;
				try {
					var fsPurge = await import('fs');
					var pathPurge = await import('path');
					var cutoff = Date.now() - (keepDays * 86400000);
					var files = fsPurge.readdirSync(tossedDir);
					var purged = 0;
					for (var f of files) {
						var fp = pathPurge.join(tossedDir, f);
						var stat = fsPurge.statSync(fp);
						if (stat.isFile() && stat.mtimeMs < cutoff) {
							fsPurge.unlinkSync(fp);
							purged++;
						}
					}
					if (purged > 0) {
						alogger.writeAlog(2, 'Purged ' + purged + ' tossed packet(s) older than ' + keepDays + ' days', 'cyan');
					}
				} catch (tossErr) {
					alogger.writeAlog(3, 'Tossed packet purge error: ' + tossErr.message, 'yellow');
				}
				break;
			}

			case 'purge-bad-echomail': {
				var badEchomail = await import("../src/models/badEchomail.js");
				var days = job.data.days || appConfig.getNumber('bad_echo_retention_days', 30);
				if (days > 0) await badEchomail.purgeOld(days);
				break;
			}

			case 'purge-inbound-log': {
				var inboundLog = await import("../src/models/inboundFileLog.js");
				var logDays = job.data.days || appConfig.getNumber('inbound_log_retention_days', 90);
				if (logDays > 0) {
					var logPurged = await inboundLog.purgeOld(logDays);
					if (logPurged > 0) alogger.writeAlog(3, 'Purged ' + logPurged + ' inbound file log entries older than ' + logDays + ' days', 'cyan');
				}
				break;
			}

			case 'update-check': {
				var updateCheck = await import("../src/maintenance/updateCheck.js");
				var checkResult = await updateCheck.runCheck({ source: 'schedule' });
				if (checkResult && checkResult.skipped) {
					alogger.writeAlog(3, '[Worker] Update check skipped: ' + checkResult.reason, 'cyan');
				} else if (checkResult && checkResult.best) {
					alogger.writeAlog(2, '[Worker] Update check: ' + checkResult.best.verdict +
						' (' + checkResult.best.available + ' on ' + checkResult.best.channel + ')', 'cyan');
				} else {
					alogger.writeAlog(3, '[Worker] Update check: nothing newer', 'cyan');
				}
				break;
			}

			case 'purge-update-checks': {
				var updateChecksModel = await import("../src/models/updateChecks.js");
				var ucDays = job.data.days || appConfig.getNumber('update_check_retention_days', 90);
				if (ucDays > 0) {
					var ucPurged = await updateChecksModel.purgeOld(ucDays);
					if (ucPurged > 0) alogger.writeAlog(3, 'Purged ' + ucPurged + ' update check records older than ' + ucDays + ' days', 'cyan');
				}
				break;
			}

			case 'purge-relay-log': {
				var relayLog = await import("../src/models/netmailRelayLog.js");
				var relayDays = job.data.days || appConfig.getNumber('netmail_relay_log_retention_days', 180);
				if (relayDays > 0) {
					var relayPurged = await relayLog.purgeOld(relayDays);
					if (relayPurged > 0) alogger.writeAlog(3, 'Purged ' + relayPurged + ' netmail relay log entries older than ' + relayDays + ' days', 'cyan');
				}
				break;
			}

			case 'purge-outbound-log': {
				var outboundLog = await import("../src/models/outboundFileLog.js");
				var outDays = job.data.days || appConfig.getNumber('outbound_log_retention_days', 90);
				if (outDays > 0) {
					var outPurged = await outboundLog.purgeOld(outDays);
					if (outPurged > 0) alogger.writeAlog(3, 'Purged ' + outPurged + ' outbound file log entries older than ' + outDays + ' days', 'cyan');
				}
				break;
			}

			case 'purge-mailer-sessions': {
				var mailerSess = await import("../src/models/mailerSessions.js");
				var sessDays = job.data.days || appConfig.getNumber('mailer_session_retention_days', 30);
				if (sessDays > 0) {
					var sessPurged = await mailerSess.purgeOld(sessDays);
					if (sessPurged > 0) alogger.writeAlog(3, 'Purged ' + sessPurged + ' mailer session history rows older than ' + sessDays + ' days', 'cyan');
				}
				break;
			}

			case 'recalc-area-counts': {
				await msgAreas.recalculateAreaCounts();
				break;
			}

			case 'echolist:batch-subscribe': {
				var batchSub = await import("../src/maintenance/echolistBatchSubscribe.js");
				await batchSub.runBatch(job.data.networkId, job.data.areatags, job.data.settings);
				break;
			}

			case 'filebone:batch-subscribe': {
				var fbBatch = await import("../src/maintenance/fileboneBatchSubscribe.js");
				await fbBatch.runBatch(job.data.networkId, job.data.areatags, job.data.settings);
				break;
			}

			case 'scan-echolists': {
				var echolistScan = await import("../src/maintenance/echolistScan.js");
				await echolistScan.scanForUpdates();
				break;
			}

			case 'timed-event': {
				var timedEventRunner = await import("../src/maintenance/timedEventRunner.js");
				await timedEventRunner.runEvent(job.data.eventId);
				break;
			}

			case 'generate-stub': {
				var stubDist = await import("../src/maintenance/stubDistribution.js");
				await stubDist.generateAndDistribute(job.data.segmentId);
				break;
			}

			case 'compile-nodelist': {
				var compiler = await import("../src/maintenance/nodelistCompiler.js");
				await compiler.compileNodelist(job.data.networkId, job.data.options || {});
				break;
			}

			case 'reconcile-echolists': {
				var networkEcholist = await import("../src/models/networkEcholist.js");
				var fileEcholist = await import("../src/models/fileEcholist.js");
				await networkEcholist.reconcileLocalAreaIds();
				await fileEcholist.reconcileLocalAreaIds();
				break;
			}

			case 'rethread': {
				var msgBase = await import("../src/maintenance/messageBase.js");
				await msgBase.rethreadAreas({
					areas: job.data.areas || null,
					dryRun: job.data.dryRun || false,
				});
				break;
			}

			case 'fix-msgids': {
				var msgBaseFix = await import("../src/maintenance/messageBase.js");
				await msgBaseFix.fixLegacyMsgIds({
					areas: job.data.areas || null,
					dryRun: job.data.dryRun || false,
					batchSize: job.data.batchSize || 500,
				});
				break;
			}

			case 'bulk-msgbase-import': {
				var msgBaseBulk = await import("../src/maintenance/msgBaseBulk.js");
				await msgBaseBulk.importMessageBases(job.data.mappings || [], {
					seal: job.data.seal !== false,
				});
				break;
			}

			case 'regen-file-desc-html': {
				var fileEntries = await import("../src/models/fileEntries.js");
				await fileEntries.regenerateDescHtml({
					batchSize: job.data.batchSize,
				});
				break;
			}

			case 'recalc-file-counts': {
				var fileAreas = await import("../src/models/fileAreas.js");
				await fileAreas.recalculateFileCounts();
				break;
			}

			case 'scan-file-area': {
				var fileEntriesMod = await import("../src/models/fileEntries.js");
				await fileEntriesMod.scanAreaDirectory(job.data.areaShortcode);
				break;
			}

			case 'import-nodelist': {
				var nodelistImport = await import("../src/maintenance/nodelistImport.js");
				await nodelistImport.importFromFile(job.data.filePath, job.data.networkId, { originalName: job.data.originalName });
				break;
			}

			case 'scan-nodelists': {
				var nodelistScan = await import("../src/maintenance/nodelistImport.js");
				await nodelistScan.scanForNewNodelists();
				break;
			}

			case 'message-maintenance': {
				var msgMaint = await import("../src/models/messages.js");
				var retResult = await msgMaint.enforceRetentionLimits();
				if (retResult.messagesRemoved > 0 || retResult.threadsRemoved > 0) {
					alogger.writeAlog(2, '[Worker] Retention: removed ' + retResult.messagesRemoved +
						' message(s) and ' + retResult.threadsRemoved + ' empty thread(s) across ' +
						retResult.areasChecked + ' area(s)', 'cyan');
				}
				break;
			}

			case 'file-maintenance': {
				var fileMaint = await import("../src/models/fileEntries.js");
				await fileMaint.cleanDuplicates();
				await fileMaint.cleanMissingFiles();
				await fileMaint.enforceRetentionLimits();
				break;
			}

			case 'user-maintenance': {
				var userMaint = await import("../src/models/useraccounts.js");
				await userMaint.reconcileMailTypes();
				await userMaint.purgeUnverifiedUsers();
				// Fire daily template events: birthdays, anniversaries, dormant users
				try {
					await userMaint.runDailyTemplateEvents();
				} catch (e) {
					alogger.writeAlog(3, '[Worker] Daily template events failed: ' + e.message, 'yellow');
				}
				break;
			}

			case 'scan-inbound': {
				var fs = await import('fs');
				var path = await import('path');
				var inDir = appConfig.get('MAILER_INBOUND_DIR') || appConfig.get('ftninbound', 'ftn/in');
				var ticDir = appConfig.get('tic_inbound_dir') || inDir;

				try {
					var hasMail = false;
					var hasTic = false;
					var trigger = null;

					if (fs.existsSync(inDir)) {
						var files = fs.readdirSync(inDir);
						for (var f of files) {
							// Same predicate TossInbound uses, so the backstop
							// covers everything the toss would act on. Testing
							// for a literal .pkt here missed arcmail bundles
							// entirely, which is precisely the case this scan
							// exists to catch: the mailer enqueues a toss when
							// a file arrives, so a bundle only sits unclaimed
							// when that enqueue did not happen.
							if (!hasMail && ftnTosser.isTossableInboundFile(f)) {
								hasMail = true;
								trigger = f;
							}
							if (f.toLowerCase().endsWith('.tic')) hasTic = true;
							if (hasMail && hasTic) break;
						}
					}

					// Check TIC dir separately if different from inbound
					if (ticDir !== inDir && !hasTic && fs.existsSync(ticDir)) {
						var ticFiles = fs.readdirSync(ticDir);
						for (var tf of ticFiles) {
							if (tf.toLowerCase().endsWith('.tic')) { hasTic = true; break; }
						}
					}

					if (hasMail) {
						// Name the file that triggered it. When this scan fires
						// it means something got left behind, and which file it
						// was is the first thing worth knowing.
						alogger.writeAlog(3, "[Worker] Inbound scan: unclaimed mail in " + inDir +
							" (" + trigger + "), enqueueing ftn:inbound", "cyan");
						await jobs.enqueueFtnInbound();
					}
					if (hasTic) {
						alogger.writeAlog(3, "[Worker] Inbound scan: .tic files found, enqueueing tic:inbound", "cyan");
						await jobs.enqueueTicInbound();
					}
					if (!hasMail && !hasTic) {
						alogger.writeAlog(4, "[Worker] Inbound scan: no files", "cyan");
					}
				} catch (scanErr) {
					alogger.writeAlog(3, "[Worker] Inbound scan error: " + scanErr.message, "yellow");
				}
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

	tossWorker = new Worker('toss', withJobTimeout(createTossProcessor(), 'toss_job_timeout', 30), {
		connection: tossConnection,
		concurrency: tossConcurrency,
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
	});

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

	startHeartbeat();

	alogger.writeAlog(1, `[Worker] Ready — toss(concurrency=${tossConcurrency}) + maintenance`, "greenbright", true);
}

await main();
