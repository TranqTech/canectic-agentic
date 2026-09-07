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
 *   pull_interval  — minutes between toss pull/push cycles (QWK default 120, NNTP default 60)
 *   status         — HOLD connections are skipped for mailer polls
 *   transport      — QWK hub transport is on-demand, not scheduled
 */

import { tossQueue, mailerQueue, maintenanceQueue } from './queues.js';
import * as peerConnections from '../models/peerConnections.js';
import * as timedEvents from '../models/timedEvents.js';
import * as coordinatorSegments from '../models/coordinatorSegments.js';
import * as alogger from "../utils/alogger.js";
import appConfig from '../config/appConfig.js';

export async function registerSchedules() {
	var scheduleCount = 0;

	try {
		// -----------------------------------------------------------------
		// Maintenance: daily PM trash retention sweep (tag-only)
		// -----------------------------------------------------------------
		await maintenanceQueue.upsertJobScheduler('purge-pm-trash-daily', {
			pattern: '0 3 * * *',   // 3:00 AM daily
		}, {
			name: 'purge-pm-trash',
			data: { days: appConfig.getNumber('pm_trash_retention_days', 30) },
		});
		scheduleCount++;

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
		// Maintenance: daily notification purge
		// -----------------------------------------------------------------
		var notifRetention = appConfig.getNumber('notifications_retention_days', 30);
		if (notifRetention > 0) {
			await maintenanceQueue.upsertJobScheduler('purge-notifications-daily', {
				pattern: '0 30 2 * * *',   // 2:30 AM daily
			}, {
				name: 'purge-notifications',
				data: { days: notifRetention },
			});
			scheduleCount++;
		}

		// -----------------------------------------------------------------
		// Maintenance: daily tossed packet purge
		// -----------------------------------------------------------------
		var keepDays = appConfig.getNumber('ftn_keep_tossed_days', 7);
		if (keepDays > 0 && keepDays < 999) {
			await maintenanceQueue.upsertJobScheduler('purge-tossed-daily', {
				pattern: '0 2 * * *',   // 2:00 AM daily
			}, {
				name: 'purge-tossed',
				data: { days: keepDays },
			});
			scheduleCount++;
		}

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
		// Maintenance: daily bad echomail purge
		// -----------------------------------------------------------------
		var badEchoDays = appConfig.getNumber('bad_echo_retention_days', 30);
		if (badEchoDays > 0) {
			await maintenanceQueue.upsertJobScheduler('purge-bad-echomail-daily', {
				pattern: '0 45 3 * * *',   // 3:45 AM daily
			}, {
				name: 'purge-bad-echomail',
				data: { days: badEchoDays },
			});
			scheduleCount++;
		}

		// -----------------------------------------------------------------
		// Maintenance: daily inbound file log purge
		// -----------------------------------------------------------------
		var inboundLogDays = appConfig.getNumber('inbound_log_retention_days', 90);
		if (inboundLogDays > 0) {
			await maintenanceQueue.upsertJobScheduler('purge-inbound-log-daily', {
				pattern: '0 50 3 * * *',   // 3:50 AM daily
			}, {
				name: 'purge-inbound-log',
				data: { days: inboundLogDays },
			});
			scheduleCount++;
		}

		// -----------------------------------------------------------------
		// Maintenance: daily outbound file log purge
		// -----------------------------------------------------------------
		var outboundLogDays = appConfig.getNumber('outbound_log_retention_days', 90);
		if (outboundLogDays > 0) {
			await maintenanceQueue.upsertJobScheduler('purge-outbound-log-daily', {
				pattern: '0 52 3 * * *',   // 3:52 AM daily
			}, {
				name: 'purge-outbound-log',
				data: { days: outboundLogDays },
			});
			scheduleCount++;
		}

		// -----------------------------------------------------------------
		// Maintenance: daily mailer session history purge
		// -----------------------------------------------------------------
		var mailerSessionDays = appConfig.getNumber('mailer_session_retention_days', 30);
		if (mailerSessionDays > 0) {
			await maintenanceQueue.upsertJobScheduler('purge-mailer-sessions-daily', {
				pattern: '0 54 3 * * *',   // 3:54 AM daily
			}, {
				name: 'purge-mailer-sessions',
				data: { days: mailerSessionDays },
			});
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
		// FTN: mailer poll schedules
		// -----------------------------------------------------------------
		var ftnConns = await peerConnections.getActiveConnectionsByNetworkType('FTN');
		if (ftnConns && ftnConns.length > 0) {
			for (var conn of ftnConns) {
				if (!conn.poll_enabled) continue;
				var cd = conn.connection_data || {};
				// Skip HOLD connections — they don't get polled
				if (cd.status === 'HOLD') continue;

				var pollMinutes = parseInt(cd.poll_interval) || 60;
				await mailerQueue.upsertJobScheduler(
					`poll:${conn.uuid}`, {
						every: pollMinutes * 60 * 1000,
					}, {
						name: 'poll-scheduled',
						data: { connectionUUID: conn.uuid },
					}
				);
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

				var pullMinutes = parseInt(cd.pull_interval_minutes || cd.pull_interval) || 120;
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
				var pullMinutes = parseInt(cd.pull_interval_minutes || cd.pull_interval) || 60;

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
					scheduleCount++;
				} catch (segErr) {
					alogger.writeAlog(3, `Failed to register stub schedule for "${seg.name}": ${segErr.message}`, "yellow");
				}
			}
		}

		alogger.writeAlog(2, `  Registered ${scheduleCount} job schedule(s)`, "cyan");

	} catch (err) {
		alogger.writeAlog(2, `Schedule registration error: ${err.message}`, "redbright");
	}
}

/**
 * Update the schedule for a single peer connection.
 *
 * Call from admin routes whenever a connection's schedule inputs change:
 * poll_interval or pull_interval, active, poll_enabled, or FTN status.
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
			var pollMinutes = parseInt(cd.poll_interval) || 60;
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
			var pullMinutes = parseInt(cd.pull_interval) || 120;
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
			var pullMinutes = parseInt(cd.pull_interval) || 60;
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
