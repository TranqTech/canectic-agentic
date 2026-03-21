// messageMaint.js
// Maintenance routines for dynamically-named message and thread tables.
//
// Unlike dbmigrations.js which handles statically-named tables from
// tablenames.conf, message/thread tables are created per-area and named
// mb_{shortcode}_msgs / mb_{shortcode}_threads. This module applies the
// same template-driven add/remove column logic to all existing areas.
//
// Can be run as a standalone CLI tool or imported and called from
// dbmigrations.js as part of a full migration run.

import * as pgdb from '../middleware/db/postgres.js';
import * as tableTools from '../middleware/db/tableTools.js';
import * as alogger from '../utils/alogger.js';


const workingdir = process.cwd();

const MSG_TEMPLATE    = workingdir + '/src/templates/msgTable.conf';
const THREAD_TEMPLATE = workingdir + '/src/templates/threadTable.conf';
const MSG_REMOVED     = workingdir + '/src/templates/msgTableRemoved.conf';
const THREAD_REMOVED  = workingdir + '/src/templates/threadTableRemoved.conf';

// Fetch all area shortcodes — active and inactive. We maintain tables for
// inactive areas so that re-activating an area doesn't require a schema catch-up.
async function getAllShortcodes() {
	var rows = await pgdb.query('SELECT shortcode FROM message_areas ORDER BY shortcode ASC', []);
	return (rows || []).map(r => r.shortcode.toLowerCase().trim());
}

// Run template-driven schema maintenance across all area tables.
async function maintainAllAreaTables() {
	// Load template column definitions once — shared across all areas
	var msgCols      = await tableTools.getColumnsFromFile(MSG_TEMPLATE);
	var threadCols   = await tableTools.getColumnsFromFile(THREAD_TEMPLATE);
	var msgRemove    = await tableTools.getColumnsFromFile(MSG_REMOVED);
	var threadRemove = await tableTools.getColumnsFromFile(THREAD_REMOVED);

	if (!msgCols || msgCols.length === 0) {
		alogger.writeAlog(3, 'messageMaint: no columns found in ' + MSG_TEMPLATE, 'redbright');
		return;
	}
	if (!threadCols || threadCols.length === 0) {
		alogger.writeAlog(3, 'messageMaint: no columns found in ' + THREAD_TEMPLATE, 'redbright');
		return;
	}

	var shortcodes = await getAllShortcodes();
	if (shortcodes.length === 0) {
		alogger.writeAlog(5, 'messageMaint: no areas found, nothing to do', 'cyan');
		return;
	}

	alogger.writeAlog(5, 'messageMaint: checking ' + shortcodes.length + ' area(s)', 'cyan');

	for (var shortcode of shortcodes) {
		var shorty = shortcode.toLowerCase().trim();
		var mTable = 'mb_' + shorty + '_msgs';
		var tTable = 'mb_' + shorty + '_threads';

		await tableTools.checkOrCreateTable(mTable, msgCols,    msgRemove);
		await tableTools.checkOrCreateTable(tTable, threadCols, threadRemove);
	}

	alogger.writeAlog(5, 'messageMaint: done', 'greenbright');
}

export {
	maintainAllAreaTables
};

// Run as CLI if invoked directly
if (process.argv[1] && process.argv[1].endsWith('messageMaint.js')) {
	await maintainAllAreaTables();
	process.exit();
}

