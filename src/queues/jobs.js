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
 *     When the job's data carries options (areas, width, days, dry run) the id
 *     is `optionJobId(base, data)` instead, so a request with different
 *     options queues behind the first rather than being merged into it and
 *     losing its options (#79). An identical request still merges.
 *   - One-shot jobs (e.g. manual FTN inbound with no specific connection) use
 *     a timestamp suffix to allow multiple enqueues.
 *
 * Note: BullMQ does not allow colons in custom job IDs.  We use `--` as the
 * delimiter between job name and connection UUID.
 */

import { createHash } from 'crypto';
import { tossQueue, mailerQueue, maintenanceQueue } from './queues.js';
import appConfig from '../config/appConfig.js';

/**
 * queue.add() with the dedupe the jobId convention above intends: a second
 * job with the same id is refused while the first is waiting, delayed or
 * running, and runs once the first has finished.
 *
 * Plain queue.add() refuses an id that exists in ANY state, completed and
 * failed included, and the queues keep the last 50 to 500 of those. So a
 * fixed id ran once and then every later request returned the old completed
 * job and did nothing, silently, until enough other jobs had pushed it out:
 * a second `--regen-html`, a second manual QWK pull, a second fix-msgids.
 * A finished job with the id is removed first, so the new one is added.
 */
export async function addDeduped(queue, name, data, opts) {
	var id = opts && opts.jobId;
	if (id) {
		var existing = await queue.getJob(id);
		if (existing) {
			var state = await existing.getState();
			if (state !== 'completed' && state !== 'failed') {
				// Tell the caller it was handed a job already waiting or
				// running, whose data may not be what it asked for. The CLI
				// used to announce the request as queued regardless.
				existing.merged = true;
				existing.mergedState = state;
				return existing;
			}
			try { await existing.remove(); } catch (_) {}
		}
	}
	return queue.add(name, data, opts);
}

/**
 * A jobId for a singleton job that carries options: the base alone when
 * there are none, else the base plus a short hash of the options. Equal
 * requests get equal ids whatever the key or area order; null, false and
 * empty lists count as absent, so `dryRun: false` is the same request as no
 * dryRun at all. Hashed rather than spelled out because an area list can be
 * long, and BullMQ refuses colons in ids.
 */
export function optionJobId(base, data) {
	var parts = {};
	for (var k of Object.keys(data || {}).sort()) {
		var v = data[k];
		if (v === null || v === undefined || v === false) continue;
		if (Array.isArray(v)) {
			if (v.length === 0) continue;
			v = v.map(String).sort();
		}
		parts[k] = v;
	}
	var canon = JSON.stringify(parts);
	if (canon === '{}') return base;
	return base + '--' + createHash('sha1').update(canon).digest('hex').slice(0, 12);
}

// =========================================================================
// Toss jobs
// =========================================================================

/**
 * FTN inbound toss.  Process .pkt files from inbound directory.
 * Called by: mailer (after file receive), admin (manual toss), CLI.
 */
export async function enqueueFtnInbound(opts = {}) {
	return addDeduped(tossQueue, 'ftn:inbound', {
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
	return addDeduped(tossQueue, 'ftn:outbound', { connectionUUID }, {
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
	return addDeduped(tossQueue, 'qwk:pull', { connectionUUID }, {
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
	return addDeduped(tossQueue, 'qwk:pull-all', {}, {
		jobId: `qwk-pull-all--${Date.now()}`,
	});
}

/**
 * QWK client push.  Build .rep and upload to remote hub.
 * Called by: scheduler (repeatable), admin, CLI.
 */
export async function enqueueQwkPush(connectionUUID) {
	return addDeduped(tossQueue, 'qwk:push', { connectionUUID }, {
		jobId: `qwk-push--${connectionUUID}`,
	});
}

/**
 * QWK push for ALL active connections.
 * Convenience for CLI — same rationale as enqueueQwkPullAll().
 */
export async function enqueueQwkPushAll() {
	return addDeduped(tossQueue, 'qwk:push-all', {}, {
		jobId: `qwk-push-all--${Date.now()}`,
	});
}

/**
 * QWK hub inbound.  Process .rep files dropped by a hub node.
 * Called by: gateway (node drops .rep), filesystem watcher, admin.
 */
export async function enqueueQwkHubInbound(connectionUUID) {
	return addDeduped(tossQueue, 'qwk:hub:inbound', { connectionUUID }, {
		jobId: `qwk-hub-inbound--${connectionUUID}`,
	});
}

/**
 * NNTP pull.  Connect to NNTP server, pull articles above HWM.
 * Called by: scheduler (repeatable), admin, CLI.
 */
export async function enqueueNntpPull(connectionUUID) {
	return addDeduped(tossQueue, 'nntp:pull', { connectionUUID }, {
		jobId: `nntp-pull--${connectionUUID}`,
	});
}

/**
 * NNTP pull for ALL active connections.
 * Convenience for CLI — calls pullAllNNTP() internally.
 */
export async function enqueueNntpPullAll() {
	return addDeduped(tossQueue, 'nntp:pull-all', {}, {
		jobId: `nntp-pull-all--${Date.now()}`,
	});
}

/**
 * NNTP push.  Post local messages to NNTP server.
 * Called by: scheduler (repeatable), admin, CLI.
 */
export async function enqueueNntpPush(connectionUUID) {
	return addDeduped(tossQueue, 'nntp:push', { connectionUUID }, {
		jobId: `nntp-push--${connectionUUID}`,
	});
}

/**
 * NNTP push for ALL active connections.
 * Convenience for CLI — calls pushAllNNTP() internally.
 */
export async function enqueueNntpPushAll() {
	return addDeduped(tossQueue, 'nntp:push-all', {}, {
		jobId: `nntp-push-all--${Date.now()}`,
	});
}

/**
 * TIC inbound toss.  Process .tic files from inbound directory.
 * Called by: mailer (after file receive, alongside ftn:inbound), admin, CLI.
 */
export async function enqueueTicInbound(opts = {}) {
	return addDeduped(tossQueue, 'tic:inbound', {
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
	return addDeduped(tossQueue, 'tic:outbound', {
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
	return addDeduped(tossQueue, 'email:outbound', {}, {
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
	return addDeduped(mailerQueue, 'signal-outbound', { connectionUUID }, {
		jobId: `signal-outbound--${connectionUUID}`,
	});
}

/**
 * Force a mailer poll for a specific connection (manual/admin).
 * Bypasses guards — connects even with no outbound mail.
 * Called by: admin panel, CLI.
 */
export async function enqueueMailerTriggerPoll(connectionUUID) {
	return addDeduped(mailerQueue, 'trigger-poll', { connectionUUID }, {
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
	return addDeduped(mailerQueue, 'bso-scan', {}, {
		jobId: `bso-scan--${Date.now()}`,
	});
}

/**
 * Connect to a nodelist-resolved address (no peer connection record).
 * Called by: outbound tosser when routing via nodelist.
 */
export async function enqueueMailerNodelistConnect(nodelistData, destinationAddress) {
	return addDeduped(mailerQueue, 'nodelist-connect', {
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
	return addDeduped(maintenanceQueue, 'user-maintenance', {}, {
		jobId: 'user-maintenance',
		removeOnComplete: true, removeOnFail: true,
	});
}

/**
 * File area maintenance (duplicate cleanup, missing file removal).
 * Called by: scheduler (daily), admin.
 */
export async function enqueueFileMaintenance() {
	return addDeduped(maintenanceQueue, 'file-maintenance', {}, {
		jobId: 'file-maintenance',
		removeOnComplete: true, removeOnFail: true,
	});
}

/**
 * Regenerate body_html for message area messages, as ONE JOB PER AREA.
 * No areas means every active area. Returns the jobs, in area order; a job
 * with `merged` set was already waiting or running for the same area and
 * options.
 *
 * Per area because a whole board is too big for one job: 334k messages on
 * the hub at about 60 a second is 90 minutes, past maintenance_job_timeout,
 * so it had to be run by hand as a series of --area batches (#79). Each area
 * now gets its own timeout, and an area request overlapping one already
 * queued merges for that area only.
 * Called by: admin panel, CLI.
 */
export async function enqueueRegenHtml(opts = {}) {
	var areas = opts.areas && opts.areas.length > 0 ? opts.areas : await activeAreaShortcodes();
	var queued = [];
	for (var req of regenHtmlRequests(areas, opts)) {
		queued.push(await addDeduped(maintenanceQueue, 'regen-html', req.data, {
			jobId: req.jobId,
			removeOnComplete: true, removeOnFail: true,
		}));
	}
	return queued;
}

/**
 * The per-area jobs enqueueRegenHtml adds, as { data, jobId }. Pure, and
 * split out so the split and the ids can be tested without a queue.
 * A repeated area is listed once.
 */
export function regenHtmlRequests(areas, opts = {}) {
	var seen = new Set();
	var requests = [];
	for (var area of areas || []) {
		if (seen.has(area)) continue;
		seen.add(area);
		var data = {
			areas: [area],
			batchSize: opts.batchSize || 100,
			forceWidth: opts.forceWidth || null,
		};
		requests.push({ data: data, jobId: optionJobId('regen-html', data) });
	}
	return requests;
}

// The same list regenerateAllBodyHtml walks when given no areas.
async function activeAreaShortcodes() {
	var postgres = await import('../middleware/db/postgres.js');
	var rows = await postgres.query(
		'SELECT shortcode FROM message_areas WHERE active ORDER BY shortcode ASC', []);
	return (rows || []).map(function (r) { return r.shortcode; });
}

/**
 * Regenerate body_html for PM inbox/outbox.
 * Called by: admin panel, CLI, scheduler.
 */
export async function enqueueRegenPmHtml(opts = {}) {
	var data = {
		batchSize: opts.batchSize || 100,
		forceWidth: opts.forceWidth || null,
	};
	return addDeduped(maintenanceQueue, 'regen-pm-html', data, {
		jobId: optionJobId('regen-pm-html', data),
		removeOnComplete: true, removeOnFail: true,
	});
}

/**
 * Tag soft-deleted PMs older than N days as purged. Two-stage cleanup:
 * this is the daily retention sweep that flips the purged flag, the
 * actual file unlink + row DELETE happens in pm-purged-cleanup.
 * Called by: scheduler (daily), admin, CLI.
 */
export async function enqueuePurgePmTrash(days) {
	// Days only when the caller chose them; otherwise the job reads the
	// setting when it runs (src/maintenance/retention.js).
	var data = days ? { days: days, manual: true } : {};
	return addDeduped(maintenanceQueue, 'purge-pm-trash', data, {
		jobId: optionJobId('purge-pm-trash', data),
		removeOnComplete: true, removeOnFail: true,
	});
}

/**
 * Background hard-delete of PMs tagged for cleanup. Walks pm_inbox /
 * pm_outbox where purged=true, calls pmAttachments.deleteAttachments()
 * for each, then DELETEs the rows. Designed to be cheap and re-runnable.
 *
 * Called by: scheduler (hourly), and on-demand after each user-initiated
 * trash purge (web button or IMAP EXPUNGE-from-Trash) for "feels instant"
 * disk reclaim.
 */
export async function enqueuePmPurgedCleanup() {
	return addDeduped(maintenanceQueue, 'pm-purged-cleanup', {}, {
		jobId: 'pm-purged-cleanup',
		removeOnComplete: true, removeOnFail: true,
	});
}

/**
 * Recalculate message counts for all areas.
 * Called by: admin panel.
 */
export async function enqueueRecalcAreaCounts() {
	return addDeduped(maintenanceQueue, 'recalc-area-counts', {}, {
		jobId: 'recalc-area-counts',
		removeOnComplete: true, removeOnFail: true,
	});
}

/**
 * Rebuild thread assignments for message areas.
 * Called by: admin panel, CLI.
 */
export async function enqueueRethread(opts = {}) {
	var data = {
		areas: opts.areas || null,
		dryRun: opts.dryRun || false,
	};
	// Keyed on dryRun as well as areas: a dry run queued while a real run of
	// the same areas waited used to be handed the real one, and vice versa.
	return addDeduped(maintenanceQueue, 'rethread', data, {
		jobId: optionJobId('rethread', data),
		removeOnComplete: true,
		removeOnFail: true,
	});
}

/**
 * Import a mapped set of message bases discovered by a directory scan.
 * Runs on the worker because a hub migration can be hundreds of bases and
 * would never survive an HTTP request timeout.
 * Called by: admin panel (bulk message base import).
 */
export async function enqueueBulkMsgBaseImport(opts = {}) {
	return addDeduped(maintenanceQueue, 'bulk-msgbase-import', {
		mappings: opts.mappings || [],
		seal: opts.seal !== false,
	}, {
		// One bulk import at a time. A second submission while one is running
		// would have both writing to the same areas.
		jobId: 'bulk-msgbase-import',
		removeOnComplete: true,
		removeOnFail: true,
	});
}

/**
 * Repair legacy full-string MSGIDs written by the pre-retrofit SMB importer,
 * splitting them into the msg_id / msg_orig_addr tuple the tossers use.
 * Idempotent; realistically a one-time run after upgrading.
 * Called by: maintenance CLI (--fix-msgids).
 */
export async function enqueueFixMsgIds(opts = {}) {
	var data = {
		areas: opts.areas || null,
		dryRun: opts.dryRun || false,
		batchSize: opts.batchSize || 500,
	};
	return addDeduped(maintenanceQueue, 'fix-msgids', data, {
		jobId: optionJobId('fix-msgids', data),
		removeOnComplete: true,
		removeOnFail: true,
	});
}

/**
 * Reconcile echolist/filebone local_area_id with network area mappings.
 * Called by: scheduler (daily), admin panel.
 */
export async function enqueueReconcileEcholists() {
	return addDeduped(maintenanceQueue, 'reconcile-echolists', {}, {
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
	var data = {
		batchSize: opts.batchSize || 100,
	};
	return addDeduped(maintenanceQueue, 'regen-file-desc-html', data, {
		jobId: optionJobId('regen-file-desc-html', data),
		removeOnComplete: true, removeOnFail: true,
	});
}

/**
 * Recalculate file counts and sizes for all file areas.
 * Called by: admin panel.
 */
export async function enqueueRecalcFileCounts() {
	return addDeduped(maintenanceQueue, 'recalc-file-counts', {}, {
		jobId: 'recalc-file-counts',
		removeOnComplete: true, removeOnFail: true,
	});
}

/**
 * Scan a file area directory for untracked files.
 * Called by: admin panel, CLI.
 */
export async function enqueueScanFileArea(areaShortcode) {
	return addDeduped(maintenanceQueue, 'scan-file-area', {
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
/**
 * Batch subscribe to many echolist areatags at once.
 *
 * Goes on the maintenance queue rather than running in the request because a
 * BACKBONE-sized selection is a couple of hundred areas, and each one creates
 * two backing tables plus a scan pointer per active user.
 */
/**
 * Message base retention pruning. Opt-in per area, so this is a no-op until a
 * sysop sets max_age_days or max_messages somewhere.
 */
export async function enqueueMessageMaintenance() {
	return addDeduped(maintenanceQueue, 'message-maintenance', {}, {
		jobId: 'message-maintenance',
	});
}

export async function enqueueEcholistBatchSubscribe(opts = {}) {
	return addDeduped(maintenanceQueue, 'echolist:batch-subscribe', {
		networkId: opts.networkId,
		areatags:  opts.areatags || [],
		settings:  opts.settings || {},
	}, {
		jobId: `echolist-batch--${opts.networkId || 'unknown'}--${Date.now()}`,
	});
}

/**
 * Batch subscribe to many filebone areatags at once. The filebone counterpart
 * to enqueueEcholistBatchSubscribe: cheaper per area (no backing tables) but
 * still a directory and a scan pointer per user each time.
 */
export async function enqueueFileboneBatchSubscribe(opts = {}) {
	return addDeduped(maintenanceQueue, 'filebone:batch-subscribe', {
		networkId: opts.networkId,
		areatags:  opts.areatags || [],
		settings:  opts.settings || {},
	}, {
		jobId: `filebone-batch--${opts.networkId || 'unknown'}--${Date.now()}`,
	});
}

export async function enqueueNodelistImport(opts = {}) {
	return addDeduped(maintenanceQueue, 'import-nodelist', {
		filePath:     opts.filePath,
		networkId:    opts.networkId,
		originalName: opts.originalName || null,
	}, {
		jobId: `import-nodelist--${opts.networkId || 'unknown'}--${Date.now()}`,
	});
}

export async function enqueueScanNodelists() {
	return addDeduped(maintenanceQueue, 'scan-nodelists', {}, {
		jobId: 'scan-nodelists-manual',
		removeOnComplete: true, removeOnFail: true,
	});
}

export async function enqueueScanEcholists() {
	return addDeduped(maintenanceQueue, 'scan-echolists', {}, {
		jobId: 'scan-echolists-manual',
		removeOnComplete: true, removeOnFail: true,
	});
}

export async function enqueuePurgeTossed(days) {
	var data = days ? { days: days, manual: true } : {};
	return addDeduped(maintenanceQueue, 'purge-tossed', data, {
		jobId: optionJobId('purge-tossed-manual', data),
		removeOnComplete: true, removeOnFail: true,
	});
}

export async function enqueuePurgeBadEchomail() {
	return addDeduped(maintenanceQueue, 'purge-bad-echomail', {}, {
		jobId: 'purge-bad-echomail-manual',
		removeOnComplete: true, removeOnFail: true,
	});
}
