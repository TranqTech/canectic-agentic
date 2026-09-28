// workerWatchdog.js -- the gateway's view of whether the worker is alive.
//
// Runs in the gateway because the gateway is the process whose death is
// obvious. A dead gateway takes the web and the terminal with it and a sysop
// hears about it within minutes; a dead or wedged worker is silent, and the
// only symptom is mail quietly not moving, which can go unnoticed for days.
//
// Three escalating responses, in order: log it, tell the sysop, restart it.
// The restart is last because it is the only one that can make things worse.
//
// Skipped entirely in embedded mode, where the queue consumers run inside this
// same process and a heartbeat would only be this process talking to itself.

import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

import * as workerHealth from './workerHealth.js';
import { tossQueue, maintenanceQueue } from './queues.js';
import { lateSchedulers } from '../utils/scheduleFormat.js';
import * as notifications from '../models/notifications.js';
import * as alogger from '../utils/alogger.js';
import appConfig from '../config/appConfig.js';

var _timer = null;

// Current incident. Reset the moment the worker reports healthy again, so a
// transient blip does not count against a later real fault.
var _tracker = { failingSince: null, attempts: 0, lastAttemptAt: null, notified: false };

// Separate throttle for the schedule-lag warning. It is a different fault with
// a different fix, and a worker restart will not touch it.
var _lagNotifiedAt = 0;

function _resetTracker() {
	_tracker = { failingSince: null, attempts: 0, lastAttemptAt: null, notified: false };
}

/**
 * Fire the configured restart command.
 *
 * Deliberately fire and forget with a hard timeout: whatever happens, the
 * watchdog must come back round on its next tick rather than block on a
 * supervisor that is itself unwell.
 */
function _runRestartCommand(command) {
	var resolved = workerHealth.resolveRestartCommand(command, process.execPath, fs.existsSync, path);
	alogger.writeAlog(1, '[Watchdog] restarting the worker: ' + resolved, 'yellowbright', true);

	exec(resolved, { timeout: 30000 }, function (err, stdout, stderr) {
		if (err) {
			alogger.writeAlog(0, '[Watchdog] restart command failed: ' + err.message, 'redbright', true);
			if (stderr) alogger.writeAlog(2, '[Watchdog] ' + String(stderr).trim(), 'red');
			return;
		}
		alogger.writeAlog(1, '[Watchdog] restart command completed', 'greenbright');
		if (stdout) alogger.writeAlog(4, '[Watchdog] ' + String(stdout).trim(), 'cyan');
	});
}

async function _notifySysop(title, body, severity) {
	try {
		await notifications.createSysop('worker_health', title, body, {
			icon: 'heart-pulse',
			severity: severity || 'danger',
			link: '/admin/logs'
		});
	} catch (err) {
		alogger.writeAlog(3, '[Watchdog] could not raise notification: ' + err.message, 'yellow');
	}
}

/**
 * Warn when a scheduler is overdue while the worker looks healthy.
 *
 * That combination means the schedules and the consumer are not looking at the
 * same place: the classic cause is REDIS_BULLMQ_DB differing between the
 * gateway that registered them and the worker that should be draining them,
 * which leaves every process reporting itself perfectly well while no repeating
 * job ever runs.
 */
async function _checkScheduleLag(now) {
	var graceMs = appConfig.getNumber('worker_schedule_lag_grace', 15) * 60 * 1000;
	if (graceMs <= 0) return;

	var late = [];
	for (var q of [tossQueue, maintenanceQueue]) {
		try {
			late = late.concat(lateSchedulers(await q.getJobSchedulers(0, 500), now, graceMs));
		} catch (_) { /* a queue we cannot read is the heartbeat check's problem */ }
	}
	if (late.length === 0) return;

	var worst = late[0];
	alogger.writeAlog(1, '[Watchdog] ' + late.length + ' schedule(s) overdue, worst is ' +
		worst.key + ' by ' + Math.round(worst.lateMs / 60000) + ' minutes', 'yellowbright', true);

	// Once a day is enough for something that needs a human to look at config.
	if (now - _lagNotifiedAt < 86400000) return;
	_lagNotifiedAt = now;
	await _notifySysop(
		'Scheduled jobs are overdue',
		late.length + ' job schedule(s) are past due, the worst by ' +
			Math.round(worst.lateMs / 60000) + ' minutes (' + worst.key + '). ' +
			'The worker is reporting healthy, so check that every process agrees on REDIS_BULLMQ_DB, ' +
			'then run: node src/tools/schedules.js',
		'warning'
	);
}

async function _tick() {
	if (!appConfig.getBoolean('worker_health_enabled', true)) return;

	var now = Date.now();
	var hb = await workerHealth.readHeartbeat();
	var assessment = workerHealth.assessWorker(hb, now, {
		staleMs: appConfig.getNumber('worker_health_grace', 180) * 1000,
		// Each queue against its own limit plus the stop grace: using the toss
		// limit for everything called a healthy long maintenance job a wedged
		// worker, and the watchdog restarts wedged workers.
		tossStallMs:  workerHealth.stallLimitMs('toss', appConfig.getNumber.bind(appConfig)),
		maintStallMs: workerHealth.stallLimitMs('maintenance', appConfig.getNumber.bind(appConfig))
	});

	if (!assessment.alarm) {
		if (_tracker.failingSince) {
			alogger.writeAlog(1, '[Watchdog] worker is healthy again', 'greenbright', true);
			_resetTracker();
		}
		// A paused worker freezes every schedule where it stands, by design:
		// the next iteration is created when a job is picked up. Warning that
		// they are overdue would be noise for the whole maintenance window.
		if (assessment.state !== workerHealth.STATE_PAUSED) await _checkScheduleLag(now);
		return;
	}

	if (!_tracker.failingSince) {
		_tracker.failingSince = now;
		alogger.writeAlog(2, '[Watchdog] worker looks unwell: ' + assessment.detail, 'yellowbright');
	}

	var decision = workerHealth.shouldAttemptRestart(assessment, _tracker, now, {
		enabled:     appConfig.getBoolean('worker_restart_enabled', true),
		graceMs:     appConfig.getNumber('worker_health_grace', 180) * 1000,
		cooldownMs:  appConfig.getNumber('worker_restart_cooldown', 300) * 1000,
		maxAttempts: appConfig.getNumber('worker_restart_max_attempts', 3)
	});

	// Tell the sysop once per incident, whether or not we are going to act, so
	// a disabled or exhausted restart is still visible rather than silent.
	if (!_tracker.notified) {
		_tracker.notified = true;
		alogger.writeAlog(0, '[Watchdog] WORKER ' + assessment.state.toUpperCase() + ': ' + assessment.detail,
			'redbright', true);
		await _notifySysop(
			'Worker process is not processing jobs',
			assessment.detail + '. Message tossing and maintenance are stopped until this clears. ' +
				(decision.restart || appConfig.getBoolean('worker_restart_enabled', true)
					? 'An automatic restart will be attempted.'
					: 'Automatic restart is switched off, so this needs a hand.') +
				' Check with: node src/tools/schedules.js',
			'danger'
		);
	}

	if (!decision.restart) {
		alogger.writeAlog(3, '[Watchdog] not restarting: ' + decision.reason, 'yellow');
		return;
	}

	_tracker.attempts++;
	_tracker.lastAttemptAt = now;
	alogger.writeAlog(0, '[Watchdog] restart attempt ' + _tracker.attempts + ': ' + decision.reason,
		'redbright', true);
	_runRestartCommand(appConfig.get('worker_restart_command', 'pm2 restart worker'));
}

/**
 * Start the watchdog. Safe to call twice; the second call is a no-op.
 * Returns a stop function for tests and for shutdown.
 */
function startWorkerWatchdog(opts) {
	var o = opts || {};

	if (o.processMode === 'embedded') {
		alogger.writeAlog(3, '[Watchdog] embedded mode, worker health check not needed', 'cyan');
		return function () {};
	}
	if (!appConfig.getBoolean('worker_health_enabled', true)) {
		alogger.writeAlog(3, '[Watchdog] disabled by config', 'cyan');
		return function () {};
	}
	if (_timer) return stopWorkerWatchdog;

	var everyMs = appConfig.getNumber('worker_health_check_interval', 60) * 1000;
	if (everyMs < 10000) everyMs = 10000;

	_timer = setInterval(function () {
		_tick().catch(function (err) {
			alogger.writeAlog(3, '[Watchdog] check failed: ' + err.message, 'yellow');
		});
	}, everyMs);

	// Never hold the process open for a health check.
	if (_timer.unref) _timer.unref();

	alogger.writeAlog(2, '[Watchdog] worker health check every ' + Math.round(everyMs / 1000) + 's on ' + os.hostname(), 'cyan');
	return stopWorkerWatchdog;
}

function stopWorkerWatchdog() {
	if (_timer) clearInterval(_timer);
	_timer = null;
	_resetTracker();
}

export { startWorkerWatchdog, stopWorkerWatchdog };
