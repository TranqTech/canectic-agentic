/**
 * Job enqueue helpers.
 *
 * Thin wrappers around queue.add() that enforce jobId conventions for
 * deduplication.  These are what the gateway routes, admin panel, CLI tools,
 * and other processes call to schedule work.
 *
 * jobId conventions:
 *   - Per-connection jobs use `${jobName}--${connectionUUID}` — BullMQ rejects
 *     duplicate jobIds while one is active, preventing concurrent operations
 *     against the same peer.
 *   - Singleton jobs (maintenance) use a fixed jobId — only one at a time.
 *   - One-shot jobs (e.g. manual FTN inbound with no specific connection) use
 *     a timestamp suffix to allow multiple enqueues.
 *
 * Note: BullMQ does not allow colons in custom job IDs.  We use `--` as the
 * delimiter between job name and connection UUID.
 */

import { tossQueue, mailerQueue, maintenanceQueue } from './queues.js';
import appConfig from '../config/appConfig.js';

// =========================================================================
// Toss jobs
// =========================================================================

/**
 * FTN inbound toss.  Process .pkt files from inbound directory.
 * Called by: mailer (after file receive), admin (manual toss), CLI.
 */
export async function enqueueFtnInbound(opts = {}) {
	return tossQueue.add('ftn:inbound', {
		connectionUUID: opts.connectionUUID || null,
		sourceDir: opts.sourceDir || null,
	}, {
		jobId: opts.connectionUUID
			? `ftn-inbound--${opts.connectionUUID}`
			: `ftn-inbound--${Date.now()}`,
	});
}

/**
 * FTN outbound toss.  Gather and pack outbound echomail/netmail.
 * Called by: gateway (after user post), admin, CLI, scheduler.
 */
export async function enqueueFtnOutbound(connectionUUID) {
	return tossQueue.add('ftn:outbound', { connectionUUID }, {
		jobId: connectionUUID
			? `ftn-outbound--${connectionUUID}`
			: `ftn-outbound--${Date.now()}`,
	});
}

/**
 * QWK client pull.  Connect to remote hub, download .qwk, import.
 * Called by: scheduler (repeatable), admin, CLI.
 */
export async function enqueueQwkPull(connectionUUID) {
	return tossQueue.add('qwk:pull', { connectionUUID }, {
		jobId: `qwk-pull--${connectionUUID}`,
	});
}

/**
 * QWK pull for ALL active connections.
 * Convenience for CLI — calls the existing pullAllQWK() which iterates
 * connections internally.  Scheduler and admin should prefer per-connection
 * enqueueQwkPull() for finer control.
 */
export async function enqueueQwkPullAll() {
	return tossQueue.add('qwk:pull-all', {}, {
		jobId: `qwk-pull-all--${Date.now()}`,
	});
}

/**
 * QWK client push.  Build .rep and upload to remote hub.
 * Called by: scheduler (repeatable), admin, CLI.
 */
export async function enqueueQwkPush(connectionUUID) {
	return tossQueue.add('qwk:push', { connectionUUID }, {
		jobId: `qwk-push--${connectionUUID}`,
	});
}

/**
 * QWK push for ALL active connections.
 * Convenience for CLI — same rationale as enqueueQwkPullAll().
 */
export async function enqueueQwkPushAll() {
	return tossQueue.add('qwk:push-all', {}, {
		jobId: `qwk-push-all--${Date.now()}`,
	});
}

/**
 * QWK hub inbound.  Process .rep files dropped by a hub node.
 * Called by: gateway (node drops .rep), filesystem watcher, admin.
 */
export async function enqueueQwkHubInbound(connectionUUID) {
	return tossQueue.add('qwk:hub:inbound', { connectionUUID }, {
		jobId: `qwk-hub-inbound--${connectionUUID}`,
	});
}

/**
 * NNTP pull.  Connect to NNTP server, pull articles above HWM.
 * Called by: scheduler (repeatable), admin, CLI.
 */
export async function enqueueNntpPull(connectionUUID) {
	return tossQueue.add('nntp:pull', { connectionUUID }, {
		jobId: `nntp-pull--${connectionUUID}`,
	});
}

/**
 * NNTP pull for ALL active connections.
 * Convenience for CLI — calls pullAllNNTP() internally.
 */
export async function enqueueNntpPullAll() {
	return tossQueue.add('nntp:pull-all', {}, {
		jobId: `nntp-pull-all--${Date.now()}`,
	});
}

/**
 * NNTP push.  Post local messages to NNTP server.
 * Called by: scheduler (repeatable), admin, CLI.
 */
export async function enqueueNntpPush(connectionUUID) {
	return tossQueue.add('nntp:push', { connectionUUID }, {
		jobId: `nntp-push--${connectionUUID}`,
	});
}

/**
 * NNTP push for ALL active connections.
 * Convenience for CLI — calls pushAllNNTP() internally.
 */
export async function enqueueNntpPushAll() {
	return tossQueue.add('nntp:push-all', {}, {
		jobId: `nntp-push-all--${Date.now()}`,
	});
}

/**
 * TIC inbound toss.  Process .tic files from inbound directory.
 * Called by: mailer (after file receive, alongside ftn:inbound), admin, CLI.
 */
export async function enqueueTicInbound(opts = {}) {
	return tossQueue.add('tic:inbound', {
		connectionUUID: opts.connectionUUID || null,
		sourceDir: opts.sourceDir || null,
	}, {
		jobId: opts.connectionUUID
			? `tic-inbound--${opts.connectionUUID}`
			: `tic-inbound--${Date.now()}`,
	});
}

/**
 * TIC outbound toss.  Build and stage outbound .tic files.
 * Called by: upload handler (networked area), tic:inbound (forwarding), admin, CLI.
 */
export async function enqueueTicOutbound(opts = {}) {
	return tossQueue.add('tic:outbound', {
		connectionUUID: opts.connectionUUID || null,
	}, {
		jobId: opts.connectionUUID
			? `tic-outbound--${opts.connectionUUID}`
			: `tic-outbound--${Date.now()}`,
	});
}

/**
 * Email outbound toss.  Send queued internet email via SMTP relay.
 * Called by: privateMessages (after EMAIL PM queued), outbound-sweep.
 */
export async function enqueueEmailOutbound() {
	return tossQueue.add('email:outbound', {}, {
		jobId: `email-outbound--${Date.now()}`,
	});
}

/**
 * Full toss cycle.  Enqueues inbound+outbound for the specified protocols.
 * Used by the CLI tosser and admin panel "run toss" button.
 *
 * Returns an array of the enqueued job objects.
 */
export async function enqueueTossCycle(opts = {}) {
	const { doInbound, doOutbound, doFtn, doNntp, doQwk, connections } = opts;
	const jobs = [];

	if (doFtn) {
		if (doInbound) {
			jobs.push(await enqueueFtnInbound());
			jobs.push(await enqueueTicInbound());
		}
		if (doOutbound) {
			jobs.push(await enqueueFtnOutbound());
			jobs.push(await enqueueTicOutbound());
		}
	}

	if (doQwk && connections?.qwk) {
		for (const conn of connections.qwk) {
			if (doInbound) jobs.push(await enqueueQwkPull(conn.uuid));
			if (doOutbound) jobs.push(await enqueueQwkPush(conn.uuid));
		}
	}

	if (doNntp && connections?.nntp) {
		for (const conn of connections.nntp) {
			if (doInbound) jobs.push(await enqueueNntpPull(conn.uuid));
			if (doOutbound) jobs.push(await enqueueNntpPush(conn.uuid));
		}
	}

	return jobs;
}

// =========================================================================
// Mailer jobs
// =========================================================================

/**
 * Signal the mailer that outbound mail is ready for a peer.
 * For CRASH connections, triggers immediate poll.
 * Called by: worker (after FTN outbound toss).
 */
export async function enqueueMailerSignalOutbound(connectionUUID) {
	return mailerQueue.add('signal-outbound', { connectionUUID }, {
		jobId: `signal-outbound--${connectionUUID}`,
	});
}

/**
 * Force a mailer poll for a specific connection (manual/admin).
 * Bypasses guards — connects even with no outbound mail.
 * Called by: admin panel, CLI.
 */
export async function enqueueMailerTriggerPoll(connectionUUID) {
	return mailerQueue.add('trigger-poll', { connectionUUID }, {
		jobId: `trigger-poll--${connectionUUID}--${Date.now()}`,
	});
}

/**
 * Trigger an immediate BSO outbound directory scan in the mailer process.
 * Called by: worker (after outbound toss), admin, CLI.
 * Replaces per-connection signal-outbound and nodelist-connect for
 * outbound delivery triggering.
 */
export async function enqueueMailerBsoScan() {
	return mailerQueue.add('bso-scan', {}, {
		jobId: `bso-scan--${Date.now()}`,
	});
}

/**
 * Connect to a nodelist-resolved address (no peer connection record).
 * Called by: outbound tosser when routing via nodelist.
 */
export async function enqueueMailerNodelistConnect(nodelistData, destinationAddress) {
	return mailerQueue.add('nodelist-connect', {
		nodelistData: nodelistData,
		destinationAddress: destinationAddress,
	}, {
		jobId: `nodelist-connect--${destinationAddress}--${Date.now()}`,
	});
}

// =========================================================================
// Maintenance jobs
// =========================================================================

/**
 * User maintenance (mailtype reconciliation, etc.).
 * Called by: scheduler (daily), admin.
 */
export async function enqueueUserMaintenance() {
	return maintenanceQueue.add('user-maintenance', {}, {
		jobId: 'user-maintenance',
		removeOnComplete: true, removeOnFail: true,
	});
}

/**
 * File area maintenance (duplicate cleanup, missing file removal).
 * Called by: scheduler (daily), admin.
 */
export async function enqueueFileMaintenance() {
	return maintenanceQueue.add('file-maintenance', {}, {
		jobId: 'file-maintenance',
		removeOnComplete: true, removeOnFail: true,
	});
}

/**
 * Regenerate body_html for message area messages.
 * Called by: admin panel, CLI, scheduler.
 */
export async function enqueueRegenHtml(opts = {}) {
	return maintenanceQueue.add('regen-html', {
		areas: opts.areas || null,
		batchSize: opts.batchSize || 100,
		forceWidth: opts.forceWidth || null,
	}, {
		jobId: 'regen-html',
		removeOnComplete: true, removeOnFail: true,
	});
}

/**
 * Regenerate body_html for PM inbox/outbox.
 * Called by: admin panel, CLI, scheduler.
 */
export async function enqueueRegenPmHtml(opts = {}) {
	return maintenanceQueue.add('regen-pm-html', {
		batchSize: opts.batchSize || 100,
		forceWidth: opts.forceWidth || null,
	}, {
		jobId: 'regen-pm-html',
		removeOnComplete: true, removeOnFail: true,
	});
}

/**
 * Hard-delete soft-deleted PMs older than N days.
 * Called by: scheduler (daily), admin, CLI.
 */
export async function enqueuePurgePmTrash(days) {
	return maintenanceQueue.add('purge-pm-trash', {
		days: days || appConfig.getNumber('pm_trash_retention_days', 30),
	}, {
		jobId: 'purge-pm-trash',
		removeOnComplete: true, removeOnFail: true,
	});
}

/**
 * Recalculate message counts for all areas.
 * Called by: admin panel.
 */
export async function enqueueRecalcAreaCounts() {
	return maintenanceQueue.add('recalc-area-counts', {}, {
		jobId: 'recalc-area-counts',
		removeOnComplete: true, removeOnFail: true,
	});
}

/**
 * Rebuild thread assignments for message areas.
 * Called by: admin panel, CLI.
 */
export async function enqueueRethread(opts = {}) {
	return maintenanceQueue.add('rethread', {
		areas: opts.areas || null,
		dryRun: opts.dryRun || false,
	}, {
		jobId: 'rethread' + (opts.areas ? '-' + opts.areas.join('-') : '-all'),
		removeOnComplete: true,
		removeOnFail: true,
	});
}

/**
 * Reconcile echolist/filebone local_area_id with network area mappings.
 * Called by: scheduler (daily), admin panel.
 */
export async function enqueueReconcileEcholists() {
	return maintenanceQueue.add('reconcile-echolists', {}, {
		jobId: 'reconcile-echolists',
		removeOnComplete: true,
		removeOnFail: true,
	});
}

/**
 * Regenerate long_desc_html for file entries.
 * Called by: admin panel, CLI.
 */
export async function enqueueRegenFileDescHtml(opts = {}) {
	return maintenanceQueue.add('regen-file-desc-html', {
		batchSize: opts.batchSize || 100,
	}, {
		jobId: 'regen-file-desc-html',
		removeOnComplete: true, removeOnFail: true,
	});
}

/**
 * Recalculate file counts and sizes for all file areas.
 * Called by: admin panel.
 */
export async function enqueueRecalcFileCounts() {
	return maintenanceQueue.add('recalc-file-counts', {}, {
		jobId: 'recalc-file-counts',
		removeOnComplete: true, removeOnFail: true,
	});
}

/**
 * Scan a file area directory for untracked files.
 * Called by: admin panel, CLI.
 */
export async function enqueueScanFileArea(areaShortcode) {
	return maintenanceQueue.add('scan-file-area', {
		areaShortcode: areaShortcode,
	}, {
		jobId: `scan-file-area--${areaShortcode}`,
		removeOnComplete: true, removeOnFail: true,
	});
}

/**
 * Import an FTN nodelist file into the database.
 * Called by: admin panel, CLI.
 */
export async function enqueueNodelistImport(opts = {}) {
	return maintenanceQueue.add('import-nodelist', {
		filePath:     opts.filePath,
		networkId:    opts.networkId,
		originalName: opts.originalName || null,
	}, {
		jobId: `import-nodelist--${opts.networkId || 'unknown'}--${Date.now()}`,
	});
}

export async function enqueueScanNodelists() {
	return maintenanceQueue.add('scan-nodelists', {}, {
		jobId: 'scan-nodelists-manual',
		removeOnComplete: true, removeOnFail: true,
	});
}

export async function enqueueScanEcholists() {
	return maintenanceQueue.add('scan-echolists', {}, {
		jobId: 'scan-echolists-manual',
		removeOnComplete: true, removeOnFail: true,
	});
}

export async function enqueuePurgeTossed(days) {
	return maintenanceQueue.add('purge-tossed', {
		days: days || appConfig.getNumber('ftn_keep_tossed_days', 7),
	}, {
		jobId: 'purge-tossed-manual',
		removeOnComplete: true, removeOnFail: true,
	});
}

export async function enqueuePurgeBadEchomail() {
	return maintenanceQueue.add('purge-bad-echomail', {}, {
		jobId: 'purge-bad-echomail-manual',
		removeOnComplete: true, removeOnFail: true,
	});
}
