/**
 * Embedded mode — starts BullMQ workers inside the gateway process.
 *
 * Used when PROCESS_MODE=embedded.  Dynamically imports the tosser and
 * maintenance modules so they're only loaded when embedded mode is active.
 * In separate mode, the gateway never touches these modules.
 *
 * The key property: all job scheduling still goes through jobs.js enqueue
 * helpers.  Embedded workers consume from the same BullMQ queues as their
 * standalone counterparts.  Switching between modes is purely a startup
 * config change — no business logic changes anywhere.
 */

import { Worker } from 'bullmq';
import { createQueueConnection } from './connection.js';
import * as alogger from "../utils/alogger.js";
import * as jobs from "./jobs.js";
import { createEventPublisher, EVENTS } from "./events.js";
import { runMailerJob } from "../mailer/mailerJobs.js";

/**
 * Start embedded workers for toss, maintenance, and (optionally) mailer.
 *
 * @param {object} opts
 * @param {object} opts.mailerManager - MailerManager instance (if mailer is enabled)
 * @param {boolean} opts.startPaused - the board is in maintenance mode: create the
 *   consumers without running them and pause them, so none takes a job before the
 *   maintenance watch has had its first look
 * @returns {{ shutdown: () => Promise<void> }}
 */
export async function startEmbeddedWorkers(opts = {}) {
	const workers = [];
	const eventPublisher = createEventPublisher();

	// --- Dynamically import tossers (only loaded in embedded mode) ---
	const ftnTosser = await import("../middleware/tossers/ftnTosser.js");
	const nntpTosser = await import("../middleware/tossers/nntpTosser.js");
	const qwkTosser = await import("../middleware/tossers/qwkTosser.js");
	const ticTosser = await import("../middleware/tossers/ticTosser.js");
	const emailTosser = await import("../middleware/tossers/emailTosser.js");
	const outboundSweep = await import("../maintenance/outboundSweep.js");
	const maintenanceJobs = await import("../maintenance/maintenanceJobs.js");
	const peerConnections = await import("../models/peerConnections.js");
	const messages = await import("../models/messages.js");
	const msgAreas = await import("../models/msgAreas.js");
	const transferFormat = await import("../utils/transferFormat.js");

	// Same as the standalone worker's: say what a QWK or NNTP transfer came to.
	function reportTransfer(protocol, direction, uuid, result) {
		var d = transferFormat.describeResult(protocol, direction, uuid, result);
		alogger.writeAlog(d.level, '[Embedded/Toss] ' + d.text, d.colour);
	}

	// --- Post-toss maintenance (same as standalone worker) ---
	async function postTossMaint() {
		var updatearray = messages.drainThreadUpdateArray();
		if (updatearray.length > 0) {
			await messages.updateThreadArray(updatearray);
		}

		// Post-batch orphan reconciliation
		var importedIds = messages.drainImportedMsgIds();
		if (importedIds.length > 0) {
			var byArea = {};
			for (var item of importedIds) {
				if (!byArea[item.shortcode]) byArea[item.shortcode] = [];
				byArea[item.shortcode].push(item.msgId);
			}
			for (var sc in byArea) {
				await messages.reconcileOrphans(sc, byArea[sc]);
			}
			var reconUpdates = messages.drainThreadUpdateArray();
			if (reconUpdates.length > 0) {
				await messages.updateThreadArray(reconUpdates);
			}
		}

		await msgAreas.updateAreaStats();
	}

	// --- Embedded toss worker ---
	var tossConnection = createQueueConnection();
	var consumers = [];
	var tossWorker = new Worker('toss', async (job) => {
		alogger.writeAlog(3, `[Embedded/Toss] ${job.name}`, "cyan");

		switch (job.name) {
			case 'ftn:inbound':
				await ftnTosser.TossInbound();
				await postTossMaint();
				eventPublisher.publish(EVENTS.MESSAGES_IMPORTED, { source: 'ftn', direction: 'inbound' });
				break;

			case 'ftn:outbound':
				await ftnTosser.TossOutbound();
				// TossOutbound() now enqueues bso-scan internally;
				// no additional signal needed here.
				eventPublisher.publish(EVENTS.TOSS_COMPLETE, { source: 'ftn', direction: 'outbound' });
				break;

			case 'qwk:pull': {
				var qwkPulled = null;
				if (job.data.connectionUUID) {
					qwkPulled = await qwkTosser.pullFromQwkPeer(job.data.connectionUUID);
					reportTransfer('QWK', 'pull', job.data.connectionUUID, qwkPulled);
				}
				await postTossMaint();
				if (transferFormat.importedAnything(qwkPulled)) {
					eventPublisher.publish(EVENTS.MESSAGES_IMPORTED, { source: 'qwk' });
				}
				break;
			}

			case 'qwk:push':
				if (job.data.connectionUUID) {
					var qwkPushed = await qwkTosser.pushToQwkPeer(job.data.connectionUUID);
					if (!qwkPushed.notRecorded) reportTransfer('QWK', 'push', job.data.connectionUUID, qwkPushed);
				}
				break;

			case 'qwk:pull-all':
				await qwkTosser.pullAllQWK();
				await postTossMaint();
				eventPublisher.publish(EVENTS.MESSAGES_IMPORTED, { source: 'qwk' });
				break;

			case 'qwk:push-all':
				await qwkTosser.pushAllQWK();
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

			case 'qwk:hub:inbound': {
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
					eventPublisher.publish(EVENTS.MESSAGES_IMPORTED, { source: 'qwk:hub' });
				}
				break;
			}

			case 'nntp:pull': {
				var nntpPulled = null;
				if (job.data.connectionUUID) {
					nntpPulled = await nntpTosser.pullFromPeer(job.data.connectionUUID);
					reportTransfer('NNTP', 'pull', job.data.connectionUUID, nntpPulled);
				}
				await postTossMaint();
				if (transferFormat.importedAnything(nntpPulled)) {
					eventPublisher.publish(EVENTS.MESSAGES_IMPORTED, { source: 'nntp' });
				}
				break;
			}

			case 'nntp:push':
				if (job.data.connectionUUID) {
					var nntpPushed = await nntpTosser.pushToNntpPeer(job.data.connectionUUID);
					if (!nntpPushed.notRecorded) reportTransfer('NNTP', 'push', job.data.connectionUUID, nntpPushed);
				}
				break;

			case 'nntp:pull-all':
				await nntpTosser.pullAllNNTP();
				await postTossMaint();
				eventPublisher.publish(EVENTS.MESSAGES_IMPORTED, { source: 'nntp' });
				break;

			case 'nntp:push-all':
				await nntpTosser.pushAllNNTP();
				break;

			// TIC (file echoes).  These were absent, so in embedded mode the
			// job was consumed, marked complete and silently did nothing: file
			// echoes did not work in either direction and nothing said so.
			case 'tic:inbound':
				await ticTosser.tossInbound();
				eventPublisher.publish(EVENTS.FILES_IMPORTED, { source: 'tic', direction: 'inbound' });
				break;

			case 'tic:outbound':
				await ticTosser.tossOutbound();
				eventPublisher.publish(EVENTS.TOSS_COMPLETE, { source: 'tic', direction: 'outbound' });
				break;

			case 'email:outbound':
				await emailTosser.tossOutbound();
				break;

			case 'outbound-sweep':
				await outboundSweep.runOutboundSweep({
					ticTosser, ftnTosser, qwkTosser, nntpTosser, emailTosser,
					peerConnections,
					log: function (level, message, colour) {
						alogger.writeAlog(level, message, colour);
					},
				});
				eventPublisher.publish(EVENTS.TOSS_COMPLETE, { source: 'sweep', direction: 'outbound' });
				break;

			default:
				alogger.writeAlog(3, `[Embedded/Toss] Unknown job: ${job.name}`, "yellowbright");
		}
	}, {
		connection: tossConnection,
		concurrency: 2,
		autorun: !opts.startPaused,
	});
	workers.push(tossWorker);
	consumers.push({ name: 'toss', worker: tossWorker });
	alogger.writeAlog(2, "  Embedded toss worker started", "cyan");

	// --- Embedded mailer worker (if mailer is running in-process) ---
	if (opts.mailerManager) {
		var mailerConnection = createQueueConnection();
		var mm = opts.mailerManager;
		var mailerWorker = new Worker('mailer', async (job) => {
			alogger.writeAlog(3, `[Embedded/Mailer] ${job.name}`, "cyan");
			if (!(await runMailerJob(mm, job.name, job.data))) {
				alogger.writeAlog(3, `[Embedded/Mailer] Unknown job: ${job.name}`, "yellowbright");
			}
		}, {
			connection: mailerConnection,
			concurrency: 5,
			autorun: !opts.startPaused,
		});
		workers.push(mailerWorker);
		consumers.push({ name: 'mailer', worker: mailerWorker });
		alogger.writeAlog(2, "  Embedded mailer worker started", "cyan");
	}

	// --- Embedded maintenance worker ---
	var maintConnection = createQueueConnection();
	var maintWorker = new Worker('maintenance', async (job) => {
		alogger.writeAlog(3, `[Embedded/Maint] ${job.name}`, "cyan");

		// Shared with bin/worker.js. This switch used to be a separate copy
		// and had drifted to 7 of 33 job names; the other 26 fell through to
		// default and were marked complete, so an embedded board silently
		// never purged a log, enforced retention, or ran a timed event.
		var handled = await maintenanceJobs.runMaintenanceJob(job.name, job.data, {
			logPrefix: '[Embedded/Maint]',
		});
		if (!handled) {
			alogger.writeAlog(3, `[Embedded/Maint] Unknown job: ${job.name}`, "yellowbright");
		}
	}, {
		connection: maintConnection,
		concurrency: 1,
		autorun: !opts.startPaused,
	});
	workers.push(maintWorker);
	consumers.push({ name: 'maintenance', worker: maintWorker });
	alogger.writeAlog(2, "  Embedded maintenance worker started", "cyan");

	if (opts.startPaused) {
		for (var c of consumers) await c.worker.pause();
		alogger.writeAlog(1, "  Board is in maintenance mode: embedded queues start paused", "yellowbright", true);
	}

	// --- Shutdown handle ---
	return {
		consumers: consumers,
		async shutdown() {
			await Promise.all(workers.map(w => w.close()));
			eventPublisher.shutdown();
		}
	};
}
