/**
 * The maintenance queue's work, in one place.
 *
 * There are two consumers of the `maintenance` queue: the standalone worker
 * (`bin/worker.js`) and the embedded worker the gateway starts under
 * PROCESS_MODE=embedded (`src/queues/embedded.js`).  They used to be two
 * separate switch statements over the same job names, and they drifted badly:
 * the embedded one handled 7 of 33.
 *
 * That drift was invisible.  `registerSchedules()` runs in both modes, so an
 * embedded board registered every daily schedule, the jobs fired on time, and
 * BullMQ handed each one to a switch with no case for it.  The job fell to
 * `default`, logged one line at level 3 (verbose, so nothing at a normal log
 * level), and was marked COMPLETE.  Queues drained, the schedule diagnostics
 * reported every scheduler healthy, and meanwhile nothing was ever purged, no
 * retention was enforced, timed events never ran, and admin buttons reported
 * success while doing nothing.
 *
 * A test can hold two switches to the same list, and one does.  But the switch
 * only has to exist once, so it does.
 *
 * Everything is imported dynamically, which is what the bulk of these cases
 * already did.  It keeps this module cheap to import for a process that may
 * never run a maintenance job, and it means the gateway does not pull the
 * tossers into memory merely by being able to.
 */

import * as alogger from "../utils/alogger.js";
import appConfig from "../config/appConfig.js";
import { retentionDaysFor } from "./retention.js";

// Days a retention purge keeps on this run, or null to purge nothing. Read
// when the job runs, never from a schedule's data: see retention.js.
function keepDays(name, data) {
	return retentionDaysFor(name, data, appConfig.getNumber.bind(appConfig));
}

/**
 * Every job name this module handles.
 *
 * Exported so the queue's producers can be checked against it rather than
 * against a hand-maintained list that would rot the same way the switch did.
 */
export const MAINTENANCE_JOBS = [
	'regen-html',
	'regen-pm-html',
	'purge-pm-trash',
	'pm-purged-cleanup',
	'purge-notifications',
	'purge-tossed',
	'purge-bad-echomail',
	'purge-inbound-log',
	'update-check',
	'purge-update-checks',
	'purge-relay-log',
	'purge-outbound-log',
	'purge-mailer-sessions',
	'purge-network-transfers',
	'recalc-area-counts',
	'echolist:batch-subscribe',
	'filebone:batch-subscribe',
	'scan-echolists',
	'timed-event',
	'generate-stub',
	'compile-nodelist',
	'reconcile-echolists',
	'rethread',
	'fix-msgids',
	'bulk-msgbase-import',
	'regen-file-desc-html',
	'recalc-file-counts',
	'scan-file-area',
	'import-nodelist',
	'scan-nodelists',
	'message-maintenance',
	'file-maintenance',
	'user-maintenance',
	'scan-inbound',
	'rotate-logs',
];

/**
 * Run one maintenance job.
 *
 * @param {string} name    - the BullMQ job name
 * @param {object} data    - job.data (may be empty)
 * @param {object} [opts]
 * @param {string} [opts.logPrefix] - tag for log lines, e.g. '[Worker]'
 * @param {AbortSignal} [opts.signal] - aborted when the job has run past its
 *          time limit (#85). Passed to the jobs with long batch loops, which
 *          stop at the next clean point; a job that does not check it runs on.
 * @param {function} [opts.onResult] - called with a job's summary for the
 *          jobs that report one (regen-html, regen-pm-html), which the worker
 *          returns as the BullMQ job's return value so the CLI can print it.
 * @returns {Promise<boolean>} false if the name is not one we handle, so the
 *          caller can log it as unknown rather than reporting silent success.
 */
export async function runMaintenanceJob(name, data, opts) {
	data = data || {};
	var tag = (opts && opts.logPrefix) || '[Maint]';
	var signal = (opts && opts.signal) || null;
	var onResult = (opts && opts.onResult) || function () {};

	switch (name) {

		case 'regen-html': {
			var messageBase = await import("./messageBase.js");
			var regen = await messageBase.regenerateAllBodyHtml({
				areas: data.areas,
				batchSize: data.batchSize,
				forceWidth: data.forceWidth,
				// Never passed before #58, so --regen-html --dry-run rewrote
				// every message it was meant only to count.
				dryRun: data.dryRun || false,
				signal: signal,
			});
			onResult(regenSummary(regen, data.dryRun));
			return true;
		}

		case 'regen-pm-html': {
			var pmHtmlBase = await import("./messageBase.js");
			var pmRegen = await pmHtmlBase.regeneratePmBodyHtml({
				batchSize: data.batchSize,
				forceWidth: data.forceWidth,
				dryRun: data.dryRun || false,
				signal: signal,
			});
			onResult(regenSummary(pmRegen, data.dryRun));
			return true;
		}

		case 'purge-pm-trash': {
			var pmTrash = await import("../models/privateMessages.js");
			await pmTrash.purgeDeleted(keepDays(name, data));
			return true;
		}

		case 'pm-purged-cleanup': {
			// Hourly + on-demand background cleanup of rows tagged for hard
			// delete by purgeMessage / purgeDeleted. Drains in batches until
			// exhausted so a backed-up queue catches up in one job run rather
			// than waiting for the next tick.
			var pmCleanup = await import("../models/privateMessages.js");
			var cleanupResult;
			do {
				cleanupResult = await pmCleanup.executePurgedCleanup({
					batchSize: data.batchSize || 500,
				});
			} while (cleanupResult && cleanupResult.pendingMore);
			return true;
		}

		case 'purge-notifications': {
			var notifDays = keepDays(name, data);
			if (notifDays === null) return true;
			var notifMod = await import("../models/notifications.js");
			await notifMod.purgeOld(notifDays);
			return true;
		}

		case 'purge-tossed': {
			var tossedKeep = keepDays(name, data);
			if (tossedKeep === null) return true;
			var tossedDir = appConfig.get('ftntossed', 'ftn/tossed');
			try {
				var fsPurge = await import('fs');
				var pathPurge = await import('path');
				var cutoff = Date.now() - (tossedKeep * 86400000);
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
					alogger.writeAlog(2, 'Purged ' + purged + ' tossed packet(s) older than ' + tossedKeep + ' days', 'cyan');
				}
			} catch (tossErr) {
				alogger.writeAlog(3, 'Tossed packet purge error: ' + tossErr.message, 'yellow');
			}
			return true;
		}

		case 'rotate-logs': {
			// Settings are read when the job runs, not when it was scheduled,
			// so a retention change applies tonight without a restart, and a
			// schedule left behind after rotation was turned off does nothing.
			if (!data.force && !appConfig.getBoolean('log_rotation_enabled', true)) return true;
			var logRotation = await import('./logRotation.js');
			var rot = await logRotation.rotateLogs({
				logDir: alogger.logDirectory(),
				retentionDays: data.days !== undefined ? data.days : appConfig.getNumber('log_retention_days', 30),
			});
			// Written after the rotation, so it opens the new system log.
			alogger.writeAlog(2, 'Log rotation: ' + rot.rotated.length + ' file(s) archived to ' + rot.archiveDir +
				(rot.removed.length ? ', ' + rot.removed.length + ' expired day(s) removed' : '') +
				(rot.errors.length ? ', ' + rot.errors.length + ' error(s): ' +
					rot.errors.map(function (e) { return e.file + ': ' + e.error; }).join('; ') : ''),
				rot.errors.length ? 'yellowbright' : 'cyan');
			return true;
		}

		case 'purge-bad-echomail': {
			var badEchomail = await import("../models/badEchomail.js");
			var days = keepDays(name, data);
			if (days !== null) await badEchomail.purgeOld(days);
			return true;
		}

		case 'purge-inbound-log': {
			var inboundLog = await import("../models/inboundFileLog.js");
			var logDays = keepDays(name, data);
			if (logDays !== null) {
				var logPurged = await inboundLog.purgeOld(logDays);
				if (logPurged > 0) alogger.writeAlog(3, 'Purged ' + logPurged + ' inbound file log entries older than ' + logDays + ' days', 'cyan');
			}
			return true;
		}

		case 'update-check': {
			var updateCheck = await import("./updateCheck.js");
			var checkResult = await updateCheck.runCheck({ source: 'schedule' });
			if (checkResult && checkResult.skipped) {
				alogger.writeAlog(3, tag + ' Update check skipped: ' + checkResult.reason, 'cyan');
			} else if (checkResult && checkResult.best) {
				alogger.writeAlog(2, tag + ' Update check: ' + checkResult.best.verdict +
					' (' + checkResult.best.available + ' on ' + checkResult.best.channel + ')', 'cyan');
			} else {
				alogger.writeAlog(3, tag + ' Update check: nothing newer', 'cyan');
			}
			return true;
		}

		case 'purge-update-checks': {
			var updateChecksModel = await import("../models/updateChecks.js");
			var ucDays = keepDays(name, data);
			if (ucDays !== null) {
				var ucPurged = await updateChecksModel.purgeOld(ucDays);
				if (ucPurged > 0) alogger.writeAlog(3, 'Purged ' + ucPurged + ' update check records older than ' + ucDays + ' days', 'cyan');
			}
			return true;
		}

		case 'purge-relay-log': {
			var relayLog = await import("../models/netmailRelayLog.js");
			var relayDays = keepDays(name, data);
			if (relayDays !== null) {
				var relayPurged = await relayLog.purgeOld(relayDays);
				if (relayPurged > 0) alogger.writeAlog(3, 'Purged ' + relayPurged + ' netmail relay log entries older than ' + relayDays + ' days', 'cyan');
			}
			return true;
		}

		case 'purge-outbound-log': {
			var outboundLog = await import("../models/outboundFileLog.js");
			var outDays = keepDays(name, data);
			if (outDays !== null) {
				var outPurged = await outboundLog.purgeOld(outDays);
				if (outPurged > 0) alogger.writeAlog(3, 'Purged ' + outPurged + ' outbound file log entries older than ' + outDays + ' days', 'cyan');
			}
			return true;
		}

		case 'purge-mailer-sessions': {
			var mailerSess = await import("../models/mailerSessions.js");
			var sessDays = keepDays(name, data);
			if (sessDays !== null) {
				var sessPurged = await mailerSess.purgeOld(sessDays);
				if (sessPurged > 0) alogger.writeAlog(3, 'Purged ' + sessPurged + ' mailer session history rows older than ' + sessDays + ' days', 'cyan');
			}
			return true;
		}

		case 'purge-network-transfers': {
			var netTransfers = await import("../models/networkTransfers.js");
			var xferDays = keepDays(name, data);
			if (xferDays !== null) {
				var xferPurged = await netTransfers.purgeOld(xferDays);
				if (xferPurged > 0) alogger.writeAlog(3, 'Purged ' + xferPurged + ' QWK/NNTP transfer history rows older than ' + xferDays + ' days', 'cyan');
			}
			return true;
		}

		case 'recalc-area-counts': {
			var msgAreasRecalc = await import("../models/msgAreas.js");
			await msgAreasRecalc.recalculateAreaCounts();
			return true;
		}

		case 'echolist:batch-subscribe': {
			var batchSub = await import("./echolistBatchSubscribe.js");
			await batchSub.runBatch(data.networkId, data.areatags, data.settings);
			return true;
		}

		case 'filebone:batch-subscribe': {
			var fbBatch = await import("./fileboneBatchSubscribe.js");
			await fbBatch.runBatch(data.networkId, data.areatags, data.settings);
			return true;
		}

		case 'scan-echolists': {
			var echolistScan = await import("./echolistScan.js");
			await echolistScan.scanForUpdates();
			return true;
		}

		case 'timed-event': {
			var timedEventRunner = await import("./timedEventRunner.js");
			await timedEventRunner.runEvent(data.eventId);
			return true;
		}

		case 'generate-stub': {
			var stubDist = await import("./stubDistribution.js");
			await stubDist.generateAndDistribute(data.segmentId);
			return true;
		}

		case 'compile-nodelist': {
			var compiler = await import("./nodelistCompiler.js");
			await compiler.compileNodelist(data.networkId, data.options || {});
			return true;
		}

		case 'reconcile-echolists': {
			var networkEcholist = await import("../models/networkEcholist.js");
			var fileEcholist = await import("../models/fileEcholist.js");
			await networkEcholist.reconcileLocalAreaIds();
			await fileEcholist.reconcileLocalAreaIds();
			return true;
		}

		case 'rethread': {
			var msgBase = await import("./messageBase.js");
			await msgBase.rethreadAreas({
				areas: data.areas || null,
				dryRun: data.dryRun || false,
				signal: signal,
			});
			return true;
		}

		case 'fix-msgids': {
			var msgBaseFix = await import("./messageBase.js");
			await msgBaseFix.fixLegacyMsgIds({
				areas: data.areas || null,
				dryRun: data.dryRun || false,
				batchSize: data.batchSize || 500,
				signal: signal,
			});
			return true;
		}

		case 'bulk-msgbase-import': {
			var msgBaseBulk = await import("./msgBaseBulk.js");
			await msgBaseBulk.importMessageBases(data.mappings || [], {
				seal: data.seal !== false,
			});
			return true;
		}

		case 'regen-file-desc-html': {
			var fileEntries = await import("../models/fileEntries.js");
			await fileEntries.regenerateDescHtml({
				batchSize: data.batchSize,
			});
			return true;
		}

		case 'recalc-file-counts': {
			var fileAreas = await import("../models/fileAreas.js");
			await fileAreas.recalculateFileCounts();
			return true;
		}

		case 'scan-file-area': {
			var fileEntriesMod = await import("../models/fileEntries.js");
			await fileEntriesMod.scanAreaDirectory(data.areaShortcode);
			return true;
		}

		case 'import-nodelist': {
			var nodelistImport = await import("./nodelistImport.js");
			await nodelistImport.importFromFile(data.filePath, data.networkId, { originalName: data.originalName });
			return true;
		}

		case 'scan-nodelists': {
			var nodelistScan = await import("./nodelistImport.js");
			await nodelistScan.scanForNewNodelists();
			return true;
		}

		case 'message-maintenance': {
			var msgMaint = await import("../models/messages.js");
			var retResult = await msgMaint.enforceRetentionLimits();
			if (retResult.messagesRemoved > 0 || retResult.threadsRemoved > 0) {
				alogger.writeAlog(2, tag + ' Retention: removed ' + retResult.messagesRemoved +
					' message(s) and ' + retResult.threadsRemoved + ' empty thread(s) across ' +
					retResult.areasChecked + ' area(s)', 'cyan');
			}
			return true;
		}

		case 'file-maintenance': {
			var fileMaint = await import("../models/fileEntries.js");
			await fileMaint.cleanDuplicates();
			await fileMaint.cleanMissingFiles();
			await fileMaint.enforceRetentionLimits();
			return true;
		}

		case 'user-maintenance': {
			var userMaint = await import("../models/useraccounts.js");
			await userMaint.reconcileMailTypes();
			await userMaint.purgeUnverifiedUsers();
			// Fire daily template events: birthdays, anniversaries, dormant users
			try {
				await userMaint.runDailyTemplateEvents();
			} catch (e) {
				alogger.writeAlog(3, tag + ' Daily template events failed: ' + e.message, 'yellow');
			}
			return true;
		}

		case 'scan-inbound': {
			var fs = await import('fs');
			var path = await import('path');
			var jobs = await import("../queues/jobs.js");
			var ftnTosser = await import("../middleware/tossers/ftnTosser.js");

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
					alogger.writeAlog(3, tag + " Inbound scan: unclaimed mail in " + inDir +
						" (" + trigger + "), enqueueing ftn:inbound", "cyan");
					await jobs.enqueueFtnInbound();
				}
				if (hasTic) {
					alogger.writeAlog(3, tag + " Inbound scan: .tic files found, enqueueing tic:inbound", "cyan");
					await jobs.enqueueTicInbound();
				}
				if (!hasMail && !hasTic) {
					alogger.writeAlog(4, tag + " Inbound scan: no files", "cyan");
				}
			} catch (scanErr) {
				alogger.writeAlog(3, tag + " Inbound scan error: " + scanErr.message, "yellow");
			}
			return true;
		}

		default:
			return false;
	}
}

// The part of a regen result worth sending back to whoever queued it: counts
// and a few ids that differ, small enough for a BullMQ return value.
export function regenSummary(result, dryRun) {
	var parts = result.areaResults || result.tableResults || [];
	var sampleIds = [];
	for (var p of parts) {
		for (var id of (p.sampleIds || [])) {
			if (sampleIds.length < 5) sampleIds.push(id);
		}
	}
	return {
		dryRun: !!dryRun,
		processed: result.totalProcessed || 0,
		updated: result.totalUpdated || 0,
		unchanged: result.totalUnchanged || 0,
		skipped: result.totalSkipped || 0,
		errors: result.totalErrors || 0,
		sampleIds: sampleIds,
	};
}
