// timedEvents.js — Sysop-configurable timed event CRUD and scheduling.
//
// Timed events run external commands on a cron schedule via the worker
// process. Similar to door configs but without terminal/dropfile components.
// Launch types: NativeCommand (shell exec), Dosemu (dosemu -dumb -E).

import { v4 as uuidv4 } from 'uuid';
import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';

// Valid launch types for timed events
var VALID_LAUNCH_TYPES = ['NativeCommand', 'Dosemu', 'FireEvent'];

var LAUNCH_TYPE_LABELS = {
	'NativeCommand': 'Native Command (shell)',
	'Dosemu':        'Dosemu (DOS, headless)',
	'FireEvent':     'Fire Template Event'
};

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

async function getAll() {
	return await postgres.query(
		'SELECT * FROM timed_events ORDER BY sort_order ASC, name ASC'
	) || [];
}

async function getActive() {
	return await postgres.query(
		'SELECT * FROM timed_events WHERE active = true ORDER BY sort_order ASC, name ASC'
	) || [];
}

async function getById(id) {
	return await postgres.queryOne(
		'SELECT * FROM timed_events WHERE id = $1',
		[parseInt(id)]
	);
}

async function getByUUID(uuid) {
	return await postgres.queryOne(
		'SELECT * FROM timed_events WHERE uuid = $1',
		[uuid]
	);
}

async function create(formObj) {
	var returnObj = { status: false, errormessages: [], insertId: 0 };

	if (!formObj.name || !formObj.name.trim()) {
		returnObj.errormessages.push('Name is required');
	}
	if (!formObj.cron_pattern || !formObj.cron_pattern.trim()) {
		returnObj.errormessages.push('Cron pattern is required');
	}
	var launchType = (formObj.launch_type || 'NativeCommand').trim();
	if (!VALID_LAUNCH_TYPES.includes(launchType)) {
		returnObj.errormessages.push('Invalid launch type: ' + launchType);
	}
	// Command/fire_event validation depends on launch type
	if (launchType === 'FireEvent') {
		if (!formObj.fire_event_code || !formObj.fire_event_code.trim()) {
			returnObj.errormessages.push('Event code is required for FireEvent type');
		}
	} else {
		if (!formObj.command || !formObj.command.trim()) {
			returnObj.errormessages.push('Command is required');
		}
	}
	if (returnObj.errormessages.length > 0) return returnObj;

	var maxSort = await postgres.queryOne('SELECT COALESCE(MAX(sort_order), 0) AS max_sort FROM timed_events');
	var nextSort = (maxSort ? maxSort.max_sort : 0) + 1;

	var dbObj = {
		uuid:            uuidv4(),
		name:            formObj.name.trim(),
		description:     formObj.description ? formObj.description.trim() : null,
		launch_type:     launchType,
		command:         formObj.command ? formObj.command.trim() : null,
		working_dir:     formObj.working_dir ? formObj.working_dir.trim() : null,
		cron_pattern:    formObj.cron_pattern.trim(),
		timeout_seconds: formObj.timeout_seconds ? parseInt(formObj.timeout_seconds) : 300,
		active:          formObj.active !== 'false' && formObj.active !== false,
		sort_order:      formObj.sort_order !== undefined ? parseInt(formObj.sort_order) : nextSort,
		fire_event_code: formObj.fire_event_code ? formObj.fire_event_code.trim() : null,
		fire_event_query: formObj.fire_event_query ? formObj.fire_event_query.trim() : null,
		created_at:      new Date()
	};

	var dbres = await postgres.insertObject(dbObj, 'timed_events');
	if (!dbres.status || !dbres.insertId) {
		returnObj.errormessages = returnObj.errormessages.concat(dbres.errormessages);
		return returnObj;
	}

	returnObj.status = true;
	returnObj.insertId = dbres.insertId;
	returnObj.uuid = dbObj.uuid;
	alogger.writeAlog(5, 'Timed event created: ' + dbObj.name + ' (' + dbObj.cron_pattern + ')', 'greenbright');
	return returnObj;
}

async function update(id, formObj) {
	var returnObj = { status: false, errormessages: [] };

	var existing = await getById(id);
	if (!existing) {
		returnObj.errormessages.push('Timed event not found');
		return returnObj;
	}

	var updateObj = { updated_at: new Date() };
	if (formObj.name !== undefined) updateObj.name = formObj.name.trim();
	if (formObj.description !== undefined) updateObj.description = formObj.description ? formObj.description.trim() : null;
	if (formObj.launch_type !== undefined) {
		var lt = formObj.launch_type.trim();
		if (VALID_LAUNCH_TYPES.includes(lt)) updateObj.launch_type = lt;
	}
	if (formObj.command !== undefined) updateObj.command = formObj.command ? formObj.command.trim() : null;
	if (formObj.working_dir !== undefined) updateObj.working_dir = formObj.working_dir ? formObj.working_dir.trim() : null;
	if (formObj.cron_pattern !== undefined) updateObj.cron_pattern = formObj.cron_pattern.trim();
	if (formObj.timeout_seconds !== undefined) updateObj.timeout_seconds = formObj.timeout_seconds ? parseInt(formObj.timeout_seconds) : 300;
	if (formObj.active !== undefined) updateObj.active = formObj.active !== 'false' && formObj.active !== false;
	if (formObj.fire_event_code !== undefined) updateObj.fire_event_code = formObj.fire_event_code ? formObj.fire_event_code.trim() : null;
	if (formObj.fire_event_query !== undefined) updateObj.fire_event_query = formObj.fire_event_query ? formObj.fire_event_query.trim() : null;

	var count = await postgres.updateById(parseInt(id), updateObj, 'timed_events');
	if (count === 0) {
		returnObj.errormessages.push('No rows updated');
		return returnObj;
	}

	returnObj.status = true;
	alogger.writeAlog(5, 'Timed event updated: id=' + id, 'greenbright');
	return returnObj;
}

async function remove(id) {
	var returnObj = { status: false, errormessages: [] };
	var err = await postgres.write('DELETE FROM timed_events WHERE id = $1', [parseInt(id)]);
	if (err) {
		returnObj.errormessages.push('Delete failed: ' + err.message);
		return returnObj;
	}
	returnObj.status = true;
	alogger.writeAlog(5, 'Timed event removed: id=' + id, 'greenbright');
	return returnObj;
}

async function updateLastRun(id, exitCode, resultText) {
	await postgres.write(
		'UPDATE timed_events SET last_run_at = $1, last_exit_code = $2, last_result = $3 WHERE id = $4',
		[new Date(), exitCode, (resultText || '').substring(0, 4000), parseInt(id)]
	);
}

export {
	VALID_LAUNCH_TYPES,
	LAUNCH_TYPE_LABELS,
	getAll,
	getActive,
	getById,
	getByUUID,
	create,
	update,
	remove,
	updateLastRun
};
