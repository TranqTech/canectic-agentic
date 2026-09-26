/**
 * Repeatable job schedule registration.
 *
 * Registers BullMQ repeatable jobs for:
 *   - Mailer poll cycles (FTN connections with NORMAL status)
 *   - QWK client pull/push cycles
 *   - NNTP pull/push cycles
 *   - Daily PM trash purge
 *
 * Called once at gateway startup.  Schedules persist in Redis — BullMQ
 * handles the timers and enqueues jobs at the specified intervals.  The
 * worker and mailer processes consume them.
 *
 * upsertJobScheduler() is idempotent: calling it with the same key replaces
 * the existing schedule.  This means restarting the gateway (or updating a
 * peer's poll interval from the admin UI) safely re-registers without
 * duplicating schedules.
 *
 * connection_data fields used:
 *   poll_interval  — minutes between mailer polls (FTN, default 60)
 *   pull_interval_minutes — minutes between toss pull/push cycles (QWK default 120, NNTP default 60);
 *                   read through scheduleFormat.connectionIntervalMinutes, never directly
 *   status         — HOLD connections are skipped for mailer polls
 *   transport      — QWK hub transport is on-demand, not scheduled
 */

import { tossQueue, mailerQueue, maintenanceQueue } from './queues.js';
import * as peerConnections from '../models/peerConnections.js';
import * as timedEvents from '../models/timedEvents.js';
import * as coordinatorSegments from '../models/coordinatorSegments.js';
import * as scheduleFormat from '../utils/scheduleFormat.js';
import * as alogger from "../utils/alogger.js";
import appConfig from '../config/appConfig.js';
import { RETENTION_JOBS, scheduleWanted } from '../maintenance/retention.js';

/**
 * Every scheduler key currently registered on a queue.
 *
 * Paged rather than fetched in one call: getJobSchedulers takes a range, and a
 * hub carrying a few hundred connections would silently lose the tail of the
 * list to a fixed bound, which on a pruning pass reads as "these are all fine"
 * rather than as a truncated answer.
 */
async function listSchedulerKeys(queue) {
	var out  = [];
	var page = 200;
	var start = 0;
	for (;;) {
		var batch = await queue.getJobSchedulers(start, start + page - 1);
		if (!batch || batch.length === 0) break;
		for (var s of batch) out.push(String(s.key || s.id));
		if (batch.length < page) break;
		start += page;
	}
	return out;
}

/**
 * Remove schedulers that registration did not just write.
 *
 * registerSchedules rebuilds the whole managed set from the database on every
 * start, so anything in a managed family that it did not write has no row
 * behind it: a deleted connection, or one whose polling was turned off, which
 * registration skips rather than clears. Those keep firing their job for ever.
 * The admin routes now maintain schedules directly, but that only covers
 * changes made through the UI from this release forward; it does nothing about
 * orphans a database already carries, or one created by a change made outside
 * the UI.
 *
 * MUST only be called with the complete expected set. Pruning against a partial
 * set deletes live schedules, which is why the only call site is at the end of
 * a registration pass that reached it without throwing.
 *
 * @param {string[]} expectedKeys - every managed key just registered
 * @param {object} [queueMap] - queues to sweep, for tests. Defaults to the three
 *                              real ones; a test passing its own queue can prove
 *                              the sweep against real BullMQ without touching a
 *                              live schedule.
 * @returns {Array<{key: string, queue: string}>} what was removed, so the
 *          caller can tell the sysop (see notifyPruned)
 */
export async function pruneOrphanSchedules(expectedKeys, queueMap) {
	var queues  = queueMap || { mailer: mailerQueue, toss: tossQueue, maintenance: maintenanceQueue };
	var removed = [];

	for (var qname of Object.keys(queues)) {
		var keys    = await listSchedulerKeys(queues[qname]);
		var orphans = scheduleFormat.orphanSchedulerKeys(keys, expectedKeys);
		for (var key of orphans) {
			try {
				await queues[qname].removeJobScheduler(key);
				removed.push({ key: key, queue: qname });
				alogger.writeAlog(3,
					`  Removed orphan schedule ${key} from ${qname}: nothing in the database asks for it`,
					"yellow");
			} catch (rmErr) {
				// Worth a line but not worth failing startup over. The job it
				// fires is at worst a no-op, and the next start tries again.
				alogger.writeAlog(3, `  Could not remove orphan schedule ${key}: ${rmErr.message}`, "yellow");
			}
		}
	}
	return removed;
}

/**
 * Tell the sysops what an automatic prune removed, with who each schedule was
 * for and why it no longer applies.
 *
 * Removing the schedule is right when polling was turned off on purpose, so
 * the prune keeps doing it; the notification is what stops it being silent
 * when it was not on purpose. The first prune (2026-09-13) stopped DOVE-Net
 * and Usenet collection on the development board, connections made before
 * poll_enabled existed, and the only record was a level 3 log line.
 *
 * Only the startup prune calls this. The admin routes remove a schedule
 * because the sysop just switched polling off, and `schedules.js --prune` is
 * run by hand and prints what it removes. Never throws: a notification that
 * cannot be written must not fail registration.
 */
export async function notifyPruned(removed) {
	if (!removed || removed.length === 0) return false;
	try {
		var byUuid = new Map();
		var conns = await peerConnections.getAllConnectionsWithPeer();
		for (var c of (conns || [])) byUuid.set(String(c.uuid), c);

		var items = [];
		for (var r of removed) {
			var parts = scheduleFormat.schedulerKeyParts(r.key);
			var row = null;
			if (parts && parts.connection) row = byUuid.get(parts.id) || null;
			else if (parts && parts.prefix === 'timed-event:') row = await timedEvents.getById(parts.id).catch(function () { return null; });
			else if (parts && parts.prefix === 'generate-stub:') row = await coordinatorSegments.getById(parts.id).catch(function () { return null; });
			items.push({ key: r.key, queue: r.queue, row: row || null });
		}

		var note = scheduleFormat.pruneNotification(items);
		if (!note) return false;
		var notif = await import('../models/notifications.js');
		await notif.createSysop('schedule_removed', note.title, note.body, {
			severity: 'warning', icon: 'calendar-x', link: '/admin/peers'
		});
		return true;
	} catch (err) {
		alogger.writeAlog(2, `  Could not notify about removed schedules: ${err.message}`, "yellow");
		return false;
	}
}

// Register a fixed schedule when it is wanted, and REMOVE it when it is not.
// Fixed schedules are outside what pruneOrphanSchedules may touch, so a
// schedule that is merely not re-registered stays in Redis and keeps firing.
// Returns true when the schedule is registered.
async function ensureSchedule(queue, key, wanted, pattern, jobName) {
	if (wanted) {
		await queue.upsertJobScheduler(key, { pattern: pattern }, { name: jobName, data: {} });
		return true;
	}
	try {
		if (await queue.removeJobScheduler(key)) {
			alogger.writeAlog(2, '  Removed schedule ' + key + ' (switched off in settings)', 'cyan');
		}
	} catch (err) {
		alogger.writeAlog(2, '  Could not remove schedule ' + key + ': ' + err.message, 'yellow');
	}
	return false;
}

export { ensureSchedule };

export async function registerSchedules() {
	var scheduleCount = 0;

	// Keys in the families pruneOrphanSchedules is allowed to remove. Collected
	// as they are written so the prune compares against what this pass actually
	// registered rather than against a second reading of the database, which
	// could disagree with it.
	var managedKeys = [];

	try {
		// -----------------------------------------------------------------
		// Maintenance: daily retention purges (src/maintenance/retention.js).
		// Registered with no days: the job reads the setting when it runs, so
		// a change applies that night. A purge switched off (0, or 999 for
		// tossed packets) has its schedule REMOVED: it used to be skipped
		// here and left registered, and went on purging with the old days.
		// -----------------------------------------------------------------
		for (var retName of Object.keys(RETENTION_JOBS)) {
			var ret = RETENTION_JOBS[retName];
			if (await ensureSchedule(maintenanceQueue, ret.schedule,
				scheduleWanted(retName, appConfig.getNumber.bind(appConfig)), ret.pattern, retName)) {
				scheduleCount++;
			}
		}

		// -----------------------------------------------------------------
		// Maintenance: hourly PM purged-row cleanup (the actual hard-delete
		// + attachment unlink for rows tagged via purgeMessage or the
		// retention sweep above). User-initiated trash purges also enqueue
		// this on-demand for sub-minute cleanup; the hourly schedule is
		// the safety net so nothing sits tagged forever if a worker missed
		// an on-demand enqueue.
		// -----------------------------------------------------------------
		await maintenanceQueue.upsertJobScheduler('pm-purged-cleanup-hourly', {
			pattern: '15 * * * *',   // :15 every hour (offset from other top-of-hour jobs)
		}, {
			name: 'pm-purged-cleanup',
			data: {},
		});
		scheduleCount++;

		// -----------------------------------------------------------------
		// Maintenance: daily nodelist auto-import scan
		// -----------------------------------------------------------------
		await maintenanceQueue.upsertJobScheduler('scan-nodelists-daily', {
			pattern: '0 4 * * *',   // 4:00 AM daily
		}, {
			name: 'scan-nodelists',
			data: {},
		});
		scheduleCount++;

		// -----------------------------------------------------------------
		// Maintenance: daily log rotation. 23:59 rather than midnight so the
		// archive directory, named for the day the job runs, is the day its
		// contents cover. Settings are read when it runs (maintenanceJobs.js).
		// -----------------------------------------------------------------
		if (await ensureSchedule(maintenanceQueue, 'rotate-logs-daily',
			appConfig.getBoolean('log_rotation_enabled', true), '0 59 23 * * *', 'rotate-logs')) {
			scheduleCount++;
		}

		// -----------------------------------------------------------------
		// Maintenance: daily echolist/filebone auto-scan
		// -----------------------------------------------------------------
		await maintenanceQueue.upsertJobScheduler('scan-echolists-daily', {
			pattern: '0 15 4 * * *',   // 4:15 AM daily (after nodelist scan)
		}, {
			name: 'scan-echolists',
			data: {},
		});
		scheduleCount++;

		// -----------------------------------------------------------------
		// Maintenance: daily echolist/filebone reconciliation
		// -----------------------------------------------------------------
		await maintenanceQueue.upsertJobScheduler('reconcile-echolists-daily', {
			pattern: '0 30 4 * * *',   // 4:30 AM daily (after echolist scan)
		}, {
			name: 'reconcile-echolists',
			data: {},
		});
		scheduleCount++;

		// -----------------------------------------------------------------
		// Maintenance: daily message base retention pruning
		// Only touches areas with max_age_days or max_messages set; both are
		// NULL by default, so this is a no-op until a sysop opts an area in.
		// -----------------------------------------------------------------
		await maintenanceQueue.upsertJobScheduler('message-maintenance-daily', {
			pattern: '0 4 * * *',   // 4:00 AM daily, before user maintenance
		}, {
			name: 'message-maintenance',
			data: {},
		});
		scheduleCount++;

		// -----------------------------------------------------------------
		// Maintenance: daily update check
		//
		// Only registered when the sysop turned it on. An opt-in outbound
		// request should not have a scheduler sitting there waiting for
		// somebody to notice it, and registering it disabled would mean the
		// queue diagnostics list a schedule that deliberately does nothing.
		// -----------------------------------------------------------------
		if (await ensureSchedule(maintenanceQueue, 'update-check-daily',
			appConfig.getBoolean('update_check_enabled', false), '0 40 4 * * *', 'update-check')) {
			scheduleCount++;
		}

		// -----------------------------------------------------------------
		// Maintenance: daily user record maintenance
		// -----------------------------------------------------------------
		await maintenanceQueue.upsertJobScheduler('user-maintenance-daily', {
			pattern: '0 5 * * *',   // 5:00 AM daily
		}, {
			name: 'user-maintenance',
			data: {},
		});
		scheduleCount++;

		// -----------------------------------------------------------------
		// Maintenance: periodic inbound directory scan (backstop)
		// -----------------------------------------------------------------
		var inboundInterval = appConfig.getNumber('inbound_scan_interval', 300);
		if (inboundInterval > 0) {
			await maintenanceQueue.upsertJobScheduler('scan-inbound', {
				every: inboundInterval * 1000,
			}, {
				name: 'scan-inbound',
				data: {},
			});
			scheduleCount++;
		}

		// -----------------------------------------------------------------
		// Toss: periodic outbound sweep for all protocols
		// Catches queued outbound messages that weren't tossed on-demand
		// (e.g., web posts during worker downtime, race conditions).
		// -----------------------------------------------------------------
		var outboundInterval = appConfig.getNumber('outbound_toss_interval', 120); // minutes
		if (outboundInterval > 0) {
			await tossQueue.upsertJobScheduler('outbound-sweep', {
				every: outboundInterval * 60 * 1000,
			}, {
				name: 'outbound-sweep',
				data: {},
			});
			scheduleCount++;
		}

		// -----------------------------------------------------------------
		// QWK hub: packets and REPs for nodes on a shared directory
		// -----------------------------------------------------------------
		if (await syncQwkHubSweep()) scheduleCount++;

		// -----------------------------------------------------------------
		// FTN: mailer poll schedules
		// -----------------------------------------------------------------
		var ftnConns = await peerConnections.getActiveConnectionsByNetworkType('FTN');
		if (ftnConns && ftnConns.length > 0) {
			for (var conn of ftnConns) {
				if (!conn.poll_enabled) continue;
				var cd = conn.connection_data || {};
				// Skip HOLD connections — they don't get polled
				if (cd.status === 'HOLD') continue;

				var pollMinutes = scheduleFormat.connectionIntervalMinutes('FTN', cd);
				await mailerQueue.upsertJobScheduler(
					`poll:${conn.uuid}`, {
						every: pollMinutes * 60 * 1000,
					}, {
						name: 'poll-scheduled',
						data: { connectionUUID: conn.uuid },
					}
				);
				managedKeys.push(`poll:${conn.uuid}`);
				scheduleCount++;
			}
		}

		// -----------------------------------------------------------------
		// QWK: pull/push schedules for client connections (not hub)
		// -----------------------------------------------------------------
		var qwkConns = await peerConnections.getActiveConnectionsByNetworkType('QWK');
		if (qwkConns && qwkConns.length > 0) {
			for (var conn of qwkConns) {
				if (!conn.poll_enabled) continue;
				var cd = conn.connection_data || {};
				// Hub transport is on-demand — nodes pull when they're ready
				if (cd.transport === 'hub') continue;

				var pullMinutes = scheduleFormat.connectionIntervalMinutes('QWK', cd);
				await tossQueue.upsertJobScheduler(
					`qwk-pull:${conn.uuid}`, {
						every: pullMinutes * 60 * 1000,
					}, {
						name: 'qwk:pull',
						data: { connectionUUID: conn.uuid },
					}
				);
				await tossQueue.upsertJobScheduler(
					`qwk-push:${conn.uuid}`, {
						every: pullMinutes * 60 * 1000,
					}, {
						name: 'qwk:push',
						data: { connectionUUID: conn.uuid },
					}
				);
				managedKeys.push(`qwk-pull:${conn.uuid}`, `qwk-push:${conn.uuid}`);
				scheduleCount += 2;
			}
		}

		// -----------------------------------------------------------------
		// NNTP: pull/push schedules
		// -----------------------------------------------------------------
		var nntpConns = await peerConnections.getActiveConnectionsByNetworkType('NNTP');
		if (nntpConns && nntpConns.length > 0) {
			for (var conn of nntpConns) {
				if (!conn.poll_enabled) continue;
				var cd = conn.connection_data || {};
				var pullMinutes = scheduleFormat.connectionIntervalMinutes('NNTP', cd);

				await tossQueue.upsertJobScheduler(
					`nntp-pull:${conn.uuid}`, {
						every: pullMinutes * 60 * 1000,
					}, {
						name: 'nntp:pull',
						data: { connectionUUID: conn.uuid },
					}
				);
				await tossQueue.upsertJobScheduler(
					`nntp-push:${conn.uuid}`, {
						every: pullMinutes * 60 * 1000,
					}, {
						name: 'nntp:push',
						data: { connectionUUID: conn.uuid },
					}
				);
				managedKeys.push(`nntp-pull:${conn.uuid}`, `nntp-push:${conn.uuid}`);
				scheduleCount += 2;
			}
		}

		// -----------------------------------------------------------------
		// Timed events: sysop-configured scheduled commands
		// -----------------------------------------------------------------
		var events = await timedEvents.getActive();
		if (events && events.length > 0) {
			for (var evt of events) {
				try {
					await maintenanceQueue.upsertJobScheduler(
						`timed-event:${evt.id}`, {
							pattern: evt.cron_pattern,
						}, {
							name: 'timed-event',
							data: { eventId: evt.id },
						}
					);
					managedKeys.push(`timed-event:${evt.id}`);
					scheduleCount++;
				} catch (evtErr) {
					alogger.writeAlog(3, `Failed to register timed event "${evt.name}": ${evtErr.message}`, "yellow");
				}
			}
		}

		// -----------------------------------------------------------------
		// Coordinator: scheduled stub generation/distribution
		// -----------------------------------------------------------------
		var segments = await coordinatorSegments.getAll();
		if (segments && segments.length > 0) {
			for (var seg of segments) {
				if (!seg.active || !seg.schedule || seg.schedule === 'manual') continue;
				try {
					await maintenanceQueue.upsertJobScheduler(
						`generate-stub:${seg.id}`, {
							pattern: seg.schedule,
						}, {
							name: 'generate-stub',
							data: { segmentId: seg.id },
						}
					);
					managedKeys.push(`generate-stub:${seg.id}`);
					scheduleCount++;
				} catch (segErr) {
					alogger.writeAlog(3, `Failed to register stub schedule for "${seg.name}": ${segErr.message}`, "yellow");
				}
			}
		}

		alogger.writeAlog(2, `  Registered ${scheduleCount} job schedule(s)`, "cyan");

		// Only reachable when every database read above succeeded. postgres.query
		// throws on error, so a failed read leaves through the catch below and
		// never gets here with a half-built managedKeys to prune against.
		var pruned = await pruneOrphanSchedules(managedKeys);
		if (pruned.length > 0) {
			alogger.writeAlog(2, `  Pruned ${pruned.length} orphan job schedule(s)`, "yellow");
			await notifyPruned(pruned);
		}

	} catch (err) {
		alogger.writeAlog(2, `Schedule registration error: ${err.message}`, "redbright");
	}
}

/**
 * Update the schedule for a single peer connection.
 *
 * Call from admin routes whenever a connection's schedule inputs change:
 * poll_interval or pull_interval_minutes, active, poll_enabled, or FTN status.
 *
 * Without this, schedules were only ever written by registerSchedules() at
 * gateway startup, so every change a sysop made through the admin UI sat in the
 * database doing nothing until the next restart. A poll interval edited from 60
 * to 240 kept polling at 60, with the settings page showing 240.
 *
 * Takes the connection row rather than loose fields so a caller cannot forget
 * one and quietly create a schedule that startup would not have created.
 *
 * @param {object} conn - peer_connections row: uuid, connection_data, active, poll_enabled
 * @param {string} networkType - 'FTN', 'QWK', or 'NNTP'
 */
export async function updateConnectionSchedule(conn, networkType) {
	if (!conn || !conn.uuid) return;

	// Before the polling checks below: a hub connection never polls, but
	// whether it collects from a shared directory decides the hub sweep.
	if (networkType === 'QWK') await syncQwkHubSweep();

	var connectionUUID = conn.uuid;
	var cd = conn.connection_data || {};

	// The same three conditions registerSchedules applies at startup. They have
	// to agree, or a connection ends up with a schedule that startup would not
	// have created and that nothing ever removes: turning polling off used to
	// leave the old scheduler running forever, because registration skips
	// disabled connections rather than clearing them.
	if (!conn.active || !conn.poll_enabled) {
		await removeConnectionSchedule(connectionUUID, networkType);
		return;
	}

	switch (networkType) {
		case 'FTN': {
			if (cd.status === 'HOLD') {
				await mailerQueue.removeJobScheduler(`poll:${connectionUUID}`);
				return;
			}
			var pollMinutes = scheduleFormat.connectionIntervalMinutes('FTN', cd);
			await mailerQueue.upsertJobScheduler(
				`poll:${connectionUUID}`, {
					every: pollMinutes * 60 * 1000,
				}, {
					name: 'poll-scheduled',
					data: { connectionUUID },
				}
			);
			break;
		}

		case 'QWK': {
			if (cd.transport === 'hub') return;
			var pullMinutes = scheduleFormat.connectionIntervalMinutes('QWK', cd);
			await tossQueue.upsertJobScheduler(
				`qwk-pull:${connectionUUID}`, {
					every: pullMinutes * 60 * 1000,
				}, {
					name: 'qwk:pull',
					data: { connectionUUID },
				}
			);
			await tossQueue.upsertJobScheduler(
				`qwk-push:${connectionUUID}`, {
					every: pullMinutes * 60 * 1000,
				}, {
					name: 'qwk:push',
					data: { connectionUUID },
				}
			);
			break;
		}

		case 'NNTP': {
			var pullMinutes = scheduleFormat.connectionIntervalMinutes('NNTP', cd);
			await tossQueue.upsertJobScheduler(
				`nntp-pull:${connectionUUID}`, {
					every: pullMinutes * 60 * 1000,
				}, {
					name: 'nntp:pull',
					data: { connectionUUID },
				}
			);
			await tossQueue.upsertJobScheduler(
				`nntp-push:${connectionUUID}`, {
					every: pullMinutes * 60 * 1000,
				}, {
					name: 'nntp:push',
					data: { connectionUUID },
				}
			);
			break;
		}
	}
}

/**
 * The QWK hub sweep (qwkTosser.serviceHubNodes): registered while at least one
 * active hub connection's node collects from a shared directory and
 * `qwk_hub_sweep_minutes` is above 0, removed otherwise, so a board with no
 * such node never lists a schedule that does nothing. Called at startup and
 * whenever a QWK connection is saved or removed.
 *
 * @returns {Promise<boolean>} whether the schedule is now registered
 */
export async function syncQwkHubSweep() {
	var minutes = appConfig.getNumber('qwk_hub_sweep_minutes', 5);
	var conns = await peerConnections.getActiveConnectionsByNetworkType('QWK');
	var wanted = minutes > 0 && (conns || []).some(peerConnections.isDirectoryHubNode);
	if (wanted) {
		await tossQueue.upsertJobScheduler('qwk-hub-sweep', {
			every: minutes * 60 * 1000,
		}, {
			name: 'qwk:hub-sweep',
			data: {},
		});
	} else {
		await tossQueue.removeJobScheduler('qwk-hub-sweep');
	}
	return wanted;
}

/**
 * Remove all schedules for a connection.
 * Call when a connection is deactivated or deleted.
 */
export async function removeConnectionSchedule(connectionUUID, networkType) {
	switch (networkType) {
		case 'FTN':
			await mailerQueue.removeJobScheduler(`poll:${connectionUUID}`);
			break;
		case 'QWK':
			await tossQueue.removeJobScheduler(`qwk-pull:${connectionUUID}`);
			await tossQueue.removeJobScheduler(`qwk-push:${connectionUUID}`);
			await syncQwkHubSweep();
			break;
		case 'NNTP':
			await tossQueue.removeJobScheduler(`nntp-pull:${connectionUUID}`);
			await tossQueue.removeJobScheduler(`nntp-push:${connectionUUID}`);
			break;
	}
}

/**
 * Update the schedule for a single timed event.
 * Call from admin routes when an event is created, updated, or toggled.
 */
export async function updateTimedEventSchedule(eventId, cronPattern, active) {
	var key = `timed-event:${eventId}`;
	if (!active || !cronPattern) {
		try { await maintenanceQueue.removeJobScheduler(key); } catch (_) {}
		return;
	}
	await maintenanceQueue.upsertJobScheduler(key, {
		pattern: cronPattern,
	}, {
		name: 'timed-event',
		data: { eventId: parseInt(eventId) },
	});
}

/**
 * Remove the schedule for a timed event.
 * Call when an event is deleted.
 */
export async function removeTimedEventSchedule(eventId) {
	try { await maintenanceQueue.removeJobScheduler(`timed-event:${eventId}`); } catch (_) {}
}

/**
 * Update the schedule for a coordinator segment.
 */
export async function updateSegmentSchedule(segmentId, cronPattern, active) {
	var key = `generate-stub:${segmentId}`;
	if (!active || !cronPattern || cronPattern === 'manual') {
		try { await maintenanceQueue.removeJobScheduler(key); } catch (_) {}
		return;
	}
	await maintenanceQueue.upsertJobScheduler(key, {
		pattern: cronPattern,
	}, {
		name: 'generate-stub',
		data: { segmentId: parseInt(segmentId) },
	});
}

export async function removeSegmentSchedule(segmentId) {
	try { await maintenanceQueue.removeJobScheduler(`generate-stub:${segmentId}`); } catch (_) {}
}
