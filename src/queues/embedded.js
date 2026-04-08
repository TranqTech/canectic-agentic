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

/**
 * Start embedded workers for toss, maintenance, and (optionally) mailer.
 *
 * @param {object} opts
 * @param {object} opts.mailerManager - MailerManager instance (if mailer is enabled)
 * @returns {{ shutdown: () => Promise<void> }}
 */
export async function startEmbeddedWorkers(opts = {}) {
	const workers = [];
	const eventPublisher = createEventPublisher();

	// --- Dynamically import tossers (only loaded in embedded mode) ---
	const ftnTosser = await import("../middleware/tossers/ftnTosser.js");
	const nntpTosser = await import("../middleware/tossers/nntpTosser.js");
	const qwkTosser = await import("../middleware/tossers/qwkTosser.js");
	const echomail = await import("../models/echomail.js");
	const msgAreas = await import("../models/msgAreas.js");
	const messageBase = await import("../maintenance/messageBase.js");
	const privateMessages = await import("../models/privateMessages.js");

	// --- Post-toss maintenance (same as standalone worker) ---
	async function postTossMaint() {
		var updatearray = echomail.drainThreadUpdateArray();
		if (updatearray.length > 0) {
			await echomail.updateThreadArray(updatearray);
		}

		// Post-batch orphan reconciliation
		var importedIds = echomail.drainImportedMsgIds();
		if (importedIds.length > 0) {
			var byArea = {};
			for (var item of importedIds) {
				if (!byArea[item.shortcode]) byArea[item.shortcode] = [];
				byArea[item.shortcode].push(item.msgId);
			}
			for (var sc in byArea) {
				await echomail.reconcileOrphans(sc, byArea[sc]);
			}
			var reconUpdates = echomail.drainThreadUpdateArray();
			if (reconUpdates.length > 0) {
				await echomail.updateThreadArray(reconUpdates);
			}
		}

		await msgAreas.updateAreaStats();
	}

	// --- Embedded toss worker ---
	var tossConnection = createQueueConnection();
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

			case 'qwk:pull':
				if (job.data.connectionUUID) await qwkTosser.pullFromQwkPeer(job.data.connectionUUID);
				await postTossMaint();
				eventPublisher.publish(EVENTS.MESSAGES_IMPORTED, { source: 'qwk' });
				break;

			case 'qwk:push':
				if (job.data.connectionUUID) await qwkTosser.pushToQwkPeer(job.data.connectionUUID);
				break;

			case 'qwk:pull-all':
				await qwkTosser.pullAllQWK();
				await postTossMaint();
				eventPublisher.publish(EVENTS.MESSAGES_IMPORTED, { source: 'qwk' });
				break;

			case 'qwk:push-all':
				await qwkTosser.pushAllQWK();
				break;

			case 'qwk:hub:inbound':
				if (job.data.connectionUUID) await qwkTosser.pullFromQwkPeer(job.data.connectionUUID);
				await postTossMaint();
				eventPublisher.publish(EVENTS.MESSAGES_IMPORTED, { source: 'qwk:hub' });
				break;

			case 'nntp:pull':
				if (job.data.connectionUUID) await nntpTosser.pullFromPeer(job.data.connectionUUID);
				await postTossMaint();
				eventPublisher.publish(EVENTS.MESSAGES_IMPORTED, { source: 'nntp' });
				break;

			case 'nntp:push':
				if (job.data.connectionUUID) await nntpTosser.pushToNntpPeer(job.data.connectionUUID);
				break;

			case 'nntp:pull-all':
				await nntpTosser.pullAllNNTP();
				await postTossMaint();
				eventPublisher.publish(EVENTS.MESSAGES_IMPORTED, { source: 'nntp' });
				break;

			case 'nntp:push-all':
				await nntpTosser.pushAllNNTP();
				break;

			default:
				alogger.writeAlog(3, `[Embedded/Toss] Unknown job: ${job.name}`, "yellowbright");
		}
	}, {
		connection: tossConnection,
		concurrency: 2,
	});
	workers.push(tossWorker);
	alogger.writeAlog(2, "  Embedded toss worker started", "cyan");

	// --- Embedded mailer worker (if mailer is running in-process) ---
	if (opts.mailerManager) {
		var mailerConnection = createQueueConnection();
		var mm = opts.mailerManager;
		var mailerWorker = new Worker('mailer', async (job) => {
			alogger.writeAlog(3, `[Embedded/Mailer] ${job.name}`, "cyan");
			switch (job.name) {
				case 'signal-outbound':
					await mm.signalOutbound(job.data.connectionUUID);
					break;
				case 'trigger-poll':
					await mm.triggerPoll(job.data.connectionUUID);
					break;
				case 'poll-scheduled':
					await mm.pollConnection(job.data.connectionUUID);
					break;
				default:
					alogger.writeAlog(3, `[Embedded/Mailer] Unknown job: ${job.name}`, "yellowbright");
			}
		}, {
			connection: mailerConnection,
			concurrency: 5,
		});
		workers.push(mailerWorker);
		alogger.writeAlog(2, "  Embedded mailer worker started", "cyan");
	}

	// --- Embedded maintenance worker ---
	var maintConnection = createQueueConnection();
	var maintWorker = new Worker('maintenance', async (job) => {
		alogger.writeAlog(3, `[Embedded/Maint] ${job.name}`, "cyan");
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
			case 'recalc-area-counts':
				await msgAreas.recalculateAreaCounts();
				break;
			default:
				alogger.writeAlog(3, `[Embedded/Maint] Unknown job: ${job.name}`, "yellowbright");
		}
	}, {
		connection: maintConnection,
		concurrency: 1,
	});
	workers.push(maintWorker);
	alogger.writeAlog(2, "  Embedded maintenance worker started", "cyan");

	// --- Shutdown handle ---
	return {
		async shutdown() {
			await Promise.all(workers.map(w => w.close()));
			eventPublisher.shutdown();
		}
	};
}
