// maintenance/timedEventRunner.js — Executes a timed event command.
//
// Called by the worker process when a timed-event job fires.
// Supports NativeCommand (shell exec) and Dosemu (dosemu -dumb -E) modes.
// Applies %X variable substitution to command and working_dir.
// Captures stdout/stderr, enforces timeout, records result.

import { exec } from 'child_process';
import * as fs from 'fs';
import * as alogger from '../utils/alogger.js';
import { substitute } from '../utils/configvars.js';
import * as timedEvents from '../models/timedEvents.js';

/**
 * Run a timed event by ID.
 *
 * @param {number} eventId — timed_events.id
 * @returns {object} { success, exitCode, output, error }
 */
async function runEvent(eventId) {
	var event = await timedEvents.getById(eventId);
	if (!event) {
		alogger.writeAlog(3, '[TimedEvent] Event not found: id=' + eventId, 'redbright');
		return { success: false, error: 'Event not found' };
	}

	if (!event.active) {
		alogger.writeAlog(5, '[TimedEvent] Skipping inactive event: ' + event.name, 'yellow');
		return { success: false, error: 'Event inactive' };
	}

	// Apply %X variable substitution (system-level tokens only, no session context)
	var command    = substitute(event.command);
	var workingDir = event.working_dir ? substitute(event.working_dir) : null;
	var timeout    = (event.timeout_seconds || 300) * 1000;

	// Validate working directory
	if (workingDir && !fs.existsSync(workingDir)) {
		var errMsg = 'Working directory does not exist: ' + workingDir;
		alogger.writeAlog(3, '[TimedEvent] ' + event.name + ': ' + errMsg, 'redbright');
		await timedEvents.updateLastRun(event.id, -1, errMsg);
		return { success: false, error: errMsg };
	}

	// Build the actual command based on launch type
	var runCmd;
	switch (event.launch_type) {
		case 'Dosemu':
			runCmd = 'dosemu -dumb -E ' + command;
			break;
		case 'NativeCommand':
		default:
			runCmd = command;
			break;
	}

	alogger.writeAlog(3,
		'[TimedEvent] Running: ' + event.name + ' (' + event.launch_type + ')' +
		'\n  cmd: ' + runCmd +
		(workingDir ? '\n  cwd: ' + workingDir : ''),
		'cyan'
	);

	var startTime = Date.now();

	return new Promise(function(resolve) {
		var child = exec(runCmd, {
			shell: true,
			cwd: workingDir || undefined,
			timeout: timeout,
			maxBuffer: 1024 * 1024, // 1MB output capture
			env: { ...process.env }
		});

		var stdout = '';
		var stderr = '';

		child.stdout.on('data', function(data) {
			stdout += data;
		});

		child.stderr.on('data', function(data) {
			stderr += data;
		});

		child.on('close', async function(code) {
			var elapsed = Date.now() - startTime;
			var output = stdout;
			if (stderr) output += '\n--- stderr ---\n' + stderr;

			await timedEvents.updateLastRun(event.id, code, output);

			if (code === 0) {
				alogger.writeAlog(3,
					'[TimedEvent] ' + event.name + ': completed (exit 0, ' + elapsed + 'ms)',
					'greenbright'
				);
				resolve({ success: true, exitCode: 0, output: output });
			} else {
				alogger.writeAlog(3,
					'[TimedEvent] ' + event.name + ': exited with code ' + code + ' (' + elapsed + 'ms)',
					'yellow'
				);
				resolve({ success: false, exitCode: code, output: output });
			}
		});

		child.on('error', async function(err) {
			var errMsg = 'Exec error: ' + err.message;
			alogger.writeAlog(3, '[TimedEvent] ' + event.name + ': ' + errMsg, 'redbright');
			await timedEvents.updateLastRun(event.id, -1, errMsg);
			resolve({ success: false, error: errMsg });
		});
	});
}

export { runEvent };
