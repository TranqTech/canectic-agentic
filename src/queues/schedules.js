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
import * as alogger from "../utils/alogger.js";
import appConfig from '../config/appConfig.js';

export async function registerSchedules() {
	var scheduleCount = 0;

	try {
		// -----------------------------------------------------------------
		// Maintenance: daily PM trash purge
		// -----------------------------------------------------------------
		await maintenanceQueue.upsertJobScheduler('purge-pm-trash-daily', {
			pattern: '0 3 * * *',   // 3:00 AM daily
		}, {
			name: 'purge-pm-trash',
			data: { days: appConfig.getNumber('pm_trash_retention_days', 30) },
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

		alogger.writeAlog(2, `  Registered ${scheduleCount} job schedule(s)`, "cyan");

	} catch (err) {
		alogger.writeAlog(2, `Schedule registration error: ${err.message}`, "redbright");
	}
}

/**
 * Update the schedule for a single peer connection.
 *
 * Call from admin routes when a connection's poll_interval or pull_interval
 * is changed, or when a connection is activated/deactivated.
 *
 * @param {string} connectionUUID
 * @param {string} networkType - 'FTN', 'QWK', or 'NNTP'
 * @param {object} connectionData - the connection_data JSONB
 * @param {boolean} active - whether the connection is active
 */
export async function updateConnectionSchedule(connectionUUID, networkType, connectionData, active) {
	var cd = connectionData || {};

	if (!active) {
		// Connection deactivated — remove its schedules
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
