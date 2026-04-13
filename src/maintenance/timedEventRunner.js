// maintenance/timedEventRunner.js — Executes a timed event command.
//
// Called by the worker process when a timed-event job fires.
// Supports:
//   NativeCommand -- shell exec with stdout/stderr capture
//   Dosemu        -- dosemu -dumb -E wrapper
//   FireEvent     -- fire a template event for users matching an SQL filter
//
// Applies %X variable substitution to command and working_dir.

import { exec } from 'child_process';
import * as fs from 'fs';
import * as postgres from '../middleware/db/postgres.js';
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

	// FireEvent launch type: fire a template event for users matching a query
	if (event.launch_type === 'FireEvent') {
		return await _runFireEvent(event);
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
			// DOS paths use backslashes (e.g. c:\bat\battlnet.bat). Because
			// we launch via exec() with shell:true (bash -c), an unquoted
			// argument has its backslashes stripped as escape sequences --
			// c:\bat\battlnet.bat becomes c:batbattlnet.bat, DOSemu can't
			// find the batch, and the event silently exits 0 in a fraction
			// of a second. Double-quote the arg to preserve backslashes.
			// Escape any embedded double-quotes as well for safety.
			runCmd = 'dosemu -dumb -E "' + command.replace(/"/g, '\\"') + '"';
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

// ---------------------------------------------------------------------------
// FireEvent launch type: fires a template event for users matching a query
// ---------------------------------------------------------------------------
//
// fire_event_code: the template event code (e.g. "custom_xmas_2026")
// fire_event_query: optional raw WHERE clause (restricted to safe columns)
//
// For safety, the query is parsed lightly: we reject anything containing
// semicolons, comment markers (--), or the words DELETE/DROP/UPDATE/INSERT/
// TRUNCATE/ALTER. If no query is provided, fires for all active users.

var UNSAFE_QUERY_PATTERN = /(;|--|\/\*|\bDELETE\b|\bDROP\b|\bUPDATE\b|\bINSERT\b|\bTRUNCATE\b|\bALTER\b|\bCREATE\b)/i;

async function _runFireEvent(event) {
	var startTime = Date.now();
	var code = (event.fire_event_code || '').trim();
	if (!code) {
		var errMsg = 'FireEvent: no fire_event_code configured';
		alogger.writeAlog(3, '[TimedEvent] ' + event.name + ': ' + errMsg, 'redbright');
		await timedEvents.updateLastRun(event.id, -1, errMsg);
		return { success: false, error: errMsg };
	}

	// Build SQL
	var sql = 'SELECT id FROM users WHERE active = true';
	var rawQuery = (event.fire_event_query || '').trim();
	if (rawQuery) {
		if (UNSAFE_QUERY_PATTERN.test(rawQuery)) {
			var errMsg2 = 'FireEvent: query contains unsafe keywords, refusing to execute';
			alogger.writeAlog(3, '[TimedEvent] ' + event.name + ': ' + errMsg2, 'redbright');
			await timedEvents.updateLastRun(event.id, -1, errMsg2);
			return { success: false, error: errMsg2 };
		}
		sql += ' AND (' + rawQuery + ')';
	}

	// Select users
	var rows;
	try {
		rows = await postgres.query(sql);
	} catch (e) {
		var errMsg3 = 'FireEvent: query failed: ' + e.message;
		alogger.writeAlog(3, '[TimedEvent] ' + event.name + ': ' + errMsg3, 'redbright');
		await timedEvents.updateLastRun(event.id, -1, errMsg3);
		return { success: false, error: errMsg3 };
	}

	var userIds = (rows || []).map(function(r) { return r.id; });
	if (userIds.length === 0) {
		var noneMsg = 'No users matched query. Nothing to fire.';
		alogger.writeAlog(4, '[TimedEvent] ' + event.name + ': ' + noneMsg, 'cyan');
		await timedEvents.updateLastRun(event.id, 0, noneMsg);
		return { success: true, exitCode: 0, output: noneMsg };
	}

	// Fire event
	var messageTemplates;
	try {
		messageTemplates = await import('../models/messageTemplates.js');
	} catch (e) {
		var errMsg4 = 'FireEvent: could not load messageTemplates: ' + e.message;
		alogger.writeAlog(3, '[TimedEvent] ' + event.name + ': ' + errMsg4, 'redbright');
		await timedEvents.updateLastRun(event.id, -1, errMsg4);
		return { success: false, error: errMsg4 };
	}

	var result = await messageTemplates.fireEventForMany(code, userIds, {});
	var elapsed = Date.now() - startTime;
	var summary = 'Event "' + code + '" fired to ' + userIds.length + ' user(s): ' +
		result.fired + ' delivered, ' + result.skipped + ' skipped' +
		(result.errors.length ? ', ' + result.errors.length + ' errors' : '') +
		' (' + elapsed + 'ms)';

	alogger.writeAlog(3, '[TimedEvent] ' + event.name + ': ' + summary,
		result.errors.length > 0 ? 'yellow' : 'greenbright');

	var exitCode = result.errors.length > 0 ? 1 : 0;
	await timedEvents.updateLastRun(event.id, exitCode, summary);
	return {
		success: exitCode === 0,
		exitCode: exitCode,
		output: summary
	};
}

export { runEvent };
