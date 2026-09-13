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

// Columns that were VARCHAR before they were TEXT, and the tables they live on.
// Pulled out of the loop so the decision is one testable rule rather than two
// statements fired blind.
const LEGACY_TEXT_COLUMNS = ['seen_by', 'path'];

// Which of the legacy columns on this table still need widening.
//
// Pure, so the rule can be tested without a database: it takes the column map
// checkOrCreateTable already read. A column that is absent needs nothing, since
// it will have been added from the template, which says TEXT.
function legacyColumnsNeedingWidening(columns) {
	if (!columns) return [];
	return LEGACY_TEXT_COLUMNS.filter(function (name) {
		var col = columns.get(name);
		return col && col.dataType !== 'text';
	});
}

async function widenLegacyTextColumns(tablename, info) {
	var todo = legacyColumnsNeedingWidening(info ? info.columns : null);
	for (var name of todo) {
		var err = await pgdb.write('ALTER TABLE ' + tablename + ' ALTER COLUMN ' + name + ' TYPE TEXT');
		if (err) {
			// Reported rather than swallowed: the old code ignored the return
			// value entirely, and pgdb.write reports a failure that way rather
			// than throwing, so a column that could not be widened looked
			// exactly like one that did not need to be.
			alogger.writeAlog(3, 'messageMaint: could not widen ' + tablename + '.' + name +
				' to TEXT: ' + err.message, 'redbright');
		} else {
			alogger.writeAlog(5, 'messageMaint: widened ' + tablename + '.' + name + ' to TEXT', 'cyan');
		}
	}
	return todo.length;
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

	var widened = 0;

	for (var shortcode of shortcodes) {
		var shorty = shortcode.toLowerCase().trim();
		var mTable = 'mb_' + shorty + '_msgs';
		var tTable = 'mb_' + shorty + '_threads';

		var mInfo = await tableTools.checkOrCreateTable(mTable, msgCols,    msgRemove);
		await tableTools.checkOrCreateTable(tTable, threadCols, threadRemove);

		// Legacy type migration: seen_by and path were VARCHAR(255) before they
		// were TEXT, and a long SEEN-BY does not fit in 255 characters.
		//
		// This used to run unconditionally, two ALTER TABLE statements per area
		// on every pass, each taking an ACCESS EXCLUSIVE lock on a live message
		// table, overwhelmingly to change nothing: the template has said TEXT
		// for a long time, so any table created since is already correct and
		// any older one was widened by the first run that saw it.
		//
		// checkOrCreateTable hands back the columns it read, so deciding costs
		// nothing extra. Note the map describes the table before that call's
		// own ALTERs, which is right here: a seen_by it just added came from the
		// template and is already TEXT.
		widened += await widenLegacyTextColumns(mTable, mInfo);
	}

	alogger.writeAlog(5, 'messageMaint: done' +
		(widened > 0 ? ' (' + widened + ' legacy column(s) widened to TEXT)' : ''), 'greenbright');
}

export {
	maintainAllAreaTables,
	legacyColumnsNeedingWidening,
	LEGACY_TEXT_COLUMNS
};

// Run as CLI if invoked directly
if (process.argv[1] && process.argv[1].endsWith('messageMaint.js')) {
	await maintainAllAreaTables();
	process.exit();
}

