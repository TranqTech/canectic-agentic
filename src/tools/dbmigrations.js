//imports
import * as dotenv from 'dotenv';
import * as pgdb from "../middleware/db/postgres.js";
import * as fs from 'fs';
import * as alogger from "../utils/alogger.js";
import { maintainAllAreaTables } from "../models/messageMaint.js";

//setup
dotenv.config();
const workingdir = process.cwd();
const seedDir = workingdir + "/db/seed";
const schemaDir = workingdir + "/db/schema";

// Simple name validation for table/column names from config files
const validNameRegex = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function validateName(name, label) {
	if (!validNameRegex.test(name)) {
		throw new Error("Invalid " + label + " name in config: " + name);
	}
	return name;
}

// --- File readers ---

function getTableColumns(tablename) {
	try {
		var colfile = schemaDir + "/tablecolumns/" + tablename + ".conf";
		var colarray = fs.readFileSync(colfile).toString().split("\n").filter(line => line.trim().length > 0);
		return colarray;
	} catch (error) {
		return [];
	}
}

function getRemovedTableColumns(tablename) {
	try {
		var colfile = schemaDir + "/tablecolumns/" + tablename + "-remove.conf";
		var colarray = fs.readFileSync(colfile).toString().split("\n").filter(line => line.trim().length > 0);
		return colarray;
	} catch (error) {
		return [];
	}
}

function getTableNames() {
	var tablenamefile = schemaDir + "/tables/tablenames.conf";
	var tablenames = fs.readFileSync(tablenamefile).toString().split("\n").filter(line => line.trim().length > 0);
	return tablenames;
}

function getDropTableNames() {
	try {
		var tablenamefile = schemaDir + "/tables/droptablenames.conf";
		var tablenames = fs.readFileSync(tablenamefile).toString().split("\n").filter(line => line.trim().length > 0);
		return tablenames;
	} catch (error) {
		return [];
	}
}

// --- DB checks ---

async function checkTable(tablename) {
	var sql = "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema LIKE 'public' AND table_type LIKE 'BASE TABLE' AND table_name = $1)";
	try {
		var rows = await pgdb.query(sql, [tablename]);
		return rows[0] && rows[0].exists === true;
	} catch (error) {
		console.log("  Error checking table:", error.message);
		return false;
	}
}

async function checkColumn(tablename, columnname) {
	var sql = "SELECT EXISTS (SELECT FROM information_schema.columns WHERE table_schema LIKE 'public' AND table_name=$1 AND column_name=$2)";
	try {
		var rows = await pgdb.query(sql, [tablename, columnname]);
		return rows[0] && rows[0].exists === true;
	} catch (error) {
		console.log("  Error checking column:", error.message);
		return false;
	}
}

// --- Migration actions ---

async function createTable(tablename, colarray) {
	validateName(tablename, "table");
	var arraystring = colarray.join(", ");
	var sql = "CREATE TABLE " + tablename + " (" + arraystring + ")";
	var err = await pgdb.write(sql);
	if (err) {
		console.log("  ERROR creating table " + tablename + ":", err.message);
		return false;
	}
	return true;
}

async function alterTableAdd(tablename, addClauses) {
	validateName(tablename, "table");
	var sql = "ALTER TABLE " + tablename + " " + addClauses.join(", ");
	var err = await pgdb.write(sql);
	if (err) {
		console.log("  ERROR adding columns to " + tablename + ":", err.message);
		return false;
	}
	return true;
}

async function alterTableRemove(tablename, removeClauses) {
	validateName(tablename, "table");
	var sql = "ALTER TABLE " + tablename + " " + removeClauses.join(", ");
	var err = await pgdb.write(sql);
	if (err) {
		console.log("  ERROR removing columns from " + tablename + ":", err.message);
		return false;
	}
	return true;
}

async function dropTable(tablename) {
	validateName(tablename, "table");
	var sql = "DROP TABLE IF EXISTS " + tablename;
	var err = await pgdb.write(sql);
	if (err) {
		console.log("  ERROR dropping table " + tablename + ":", err.message);
		return false;
	}
	return true;
}

// --- Core migration logic ---

async function checkOrCreateTable(tablename, summary) {
	var doesExist = await checkTable(tablename);

	if (!doesExist) {
		// Create the table
		var colarray = getTableColumns(tablename);
		if (colarray.length === 0) {
			console.log("  No column definitions found for " + tablename + ", skipping creation");
			summary.errors.push(tablename + ": no column definitions");
			return;
		}
		console.log("  Creating table: " + tablename);
		var ok = await createTable(tablename, colarray);
		if (ok) {
			summary.tablesCreated.push(tablename);
		} else {
			summary.errors.push(tablename + ": creation failed");
		}
		return;
	}

	// Table exists — check for column additions/removals
	console.log("  Table exists: " + tablename + " — checking columns");
	var colarray = getTableColumns(tablename);
	var rcolarray = getRemovedTableColumns(tablename);
	var addClauses = [];
	var removeClauses = [];

	// Check columns to add
	for (var col of colarray) {
		var colName = col.split(" ")[0].replace(/\s/g, '');
		if (!colName) continue;
		var exists = await checkColumn(tablename, colName);
		if (!exists) {
			console.log("    + Adding column: " + colName);
			addClauses.push("ADD COLUMN " + col);
		}
	}

	// Check columns to remove
	for (var rcol of rcolarray) {
		var rcolName = rcol.split(" ")[0].replace(/\s/g, '');
		if (!rcolName) continue;
		var exists = await checkColumn(tablename, rcolName);
		if (exists) {
			console.log("    - Removing column: " + rcolName);
			removeClauses.push("DROP COLUMN " + rcolName);
		}
	}

	// Execute alterations
	if (addClauses.length > 0) {
		var ok = await alterTableAdd(tablename, addClauses);
		if (ok) {
			summary.columnsAdded.push(tablename + ": " + addClauses.length + " column(s)");
		} else {
			summary.errors.push(tablename + ": failed adding columns");
		}
	}

	if (removeClauses.length > 0) {
		var ok = await alterTableRemove(tablename, removeClauses);
		if (ok) {
			summary.columnsRemoved.push(tablename + ": " + removeClauses.length + " column(s)");
		} else {
			summary.errors.push(tablename + ": failed removing columns");
		}
	}

	if (addClauses.length === 0 && removeClauses.length === 0) {
		summary.tablesUnchanged.push(tablename);
	}
}

// --- Targeted migrations ---

// Split the legacy "addr serial" msg_id / reply_to string format into
// the new tuple storage (msg_id = 8-char serial, msg_orig_addr = origin
// address). This runs after the column auto-add step so the new columns
// exist, then scans each affected table and backfills the new columns
// from the old strings.
//
// Rules:
//   - If msg_id contains a space: split on first space. First token
//     is the address (goes into msg_orig_addr), second token is the
//     serial (stays in msg_id).
//   - If msg_id is already 8 hex chars with no space: assume it's
//     already in the new format, skip.
//   - If msg_id is empty or NULL: skip.
//   - Same rules for reply_to → reply_orig_addr.
//
// Idempotent: running on an already-migrated DB finds no rows with
// spaces in msg_id and does nothing.
async function migrateMsgidTupleSplit() {
	// Delegates to messageBase.fixLegacyMsgIds so there is one definition of
	// the MSGID split. Doing it here in SQL with split_part would diverge from
	// ftnUtils.splitFullMsgid, which the tossers use: split_part(msg_id,' ',2)
	// silently drops everything after a second space, whereas splitFullMsgid
	// splits on the first space and keeps the remainder.
	var messageBase = await import('../maintenance/messageBase.js');
	var totals = await messageBase.fixLegacyMsgIds();

	if (totals.msgidFixed > 0 || totals.replyFixed > 0) {
		console.log("  Split " + totals.msgidFixed + " msg_id and " +
			totals.replyFixed + " reply_to value(s) across " + totals.tables + " table(s).");
	} else {
		console.log("  No legacy MSGID strings found.");
	}
}

async function migrateMenuLayout() {
	try {
		// Step 1: Migrate display_entries from BOOLEAN to VARCHAR(8)
		var typeRows = await pgdb.query(
			"SELECT data_type FROM information_schema.columns WHERE table_name = 'menus' AND column_name = 'display_entries'",
			[]
		);
		if (typeRows.length > 0 && typeRows[0].data_type === 'boolean') {
			console.log("  Migrating menus.display_entries from BOOLEAN to VARCHAR(8)...");
			var err = await pgdb.write(
				"ALTER TABLE menus ALTER COLUMN display_entries TYPE VARCHAR(8) USING CASE WHEN display_entries THEN 'auto' ELSE 'off' END"
			);
			if (err) {
				console.log("  ERROR migrating display_entries type:", err.message);
				return;
			}
			var err2 = await pgdb.write(
				"ALTER TABLE menus ALTER COLUMN display_entries SET DEFAULT 'auto'"
			);
			if (err2) {
				console.log("  ERROR setting display_entries default:", err2.message);
				return;
			}
			console.log("  display_entries migrated to VARCHAR(8) (true->auto, false->off)");
		}

		// Step 2: Migrate offset values to margin values before columns are dropped
		var offsetRows = await pgdb.query(
			"SELECT data_type FROM information_schema.columns WHERE table_name = 'menus' AND column_name = 'entries_x_offset'",
			[]
		);
		if (offsetRows.length > 0) {
			var marginRows = await pgdb.query(
				"SELECT data_type FROM information_schema.columns WHERE table_name = 'menus' AND column_name = 'margin_left'",
				[]
			);
			if (marginRows.length > 0) {
				console.log("  Migrating entries_x_offset/entries_y_offset to margin_left/margin_top...");
				var err3 = await pgdb.write(
					"UPDATE menus SET margin_left = COALESCE(entries_x_offset, 0) + 2, margin_top = COALESCE(entries_y_offset, 0) + 3 WHERE entries_x_offset IS NOT NULL AND entries_x_offset != 0 OR entries_y_offset IS NOT NULL AND entries_y_offset != 0"
				);
				if (err3) {
					console.log("  ERROR migrating offset values:", err3.message);
				} else {
					console.log("  Offset values migrated to margins");
				}
			}
		}
	} catch (error) {
		console.log("  ERROR in migrateMenuLayout:", error.message);
	}
}

// --- Main ---

async function setupTables() {
	var summary = {
		tablesDropped: [],
		tablesCreated: [],
		tablesUnchanged: [],
		columnsAdded: [],
		columnsRemoved: [],
		errors: []
	};

	// Drop tables
	var dropTableNames = getDropTableNames();
	if (dropTableNames.length > 0) {
		console.log("\n--- Dropping tables ---");
		for (var dtable of dropTableNames) {
			console.log("  Dropping: " + dtable);
			var ok = await dropTable(dtable);
			if (ok) summary.tablesDropped.push(dtable);
		}
	}

	// Targeted migrations (must run before column add/remove)
	console.log("\n--- Targeted migrations ---");
	await migrateMenuLayout();

	// Check/create tables
	var tableNames = getTableNames();
	console.log("\n--- Checking tables ---");
	for (var table of tableNames) {
		console.log("\n  Processing: " + table);
		await checkOrCreateTable(table, summary);
	}

	// Print summary
	console.log("\n========================================");
	console.log("  Migration Summary");
	console.log("========================================");
	if (summary.tablesDropped.length > 0) {
		console.log("  Dropped:    " + summary.tablesDropped.join(", "));
	}
	if (summary.tablesCreated.length > 0) {
		console.log("  Created:    " + summary.tablesCreated.join(", "));
	}
	if (summary.columnsAdded.length > 0) {
		console.log("  Added:      " + summary.columnsAdded.join("; "));
	}
	if (summary.columnsRemoved.length > 0) {
		console.log("  Removed:    " + summary.columnsRemoved.join("; "));
	}
	if (summary.tablesUnchanged.length > 0) {
		console.log("  Unchanged:  " + summary.tablesUnchanged.join(", "));
	}
	if (summary.errors.length > 0) {
		console.log("  ERRORS:     " + summary.errors.join("; "));
	}
	if (summary.errors.length === 0 && summary.tablesCreated.length === 0 && summary.columnsAdded.length === 0 && summary.columnsRemoved.length === 0 && summary.tablesDropped.length === 0) {
		console.log("  No changes needed.");
	}
	console.log("========================================\n");

	// Apply template-driven schema maintenance to all dynamic message/thread tables
	console.log("\n--- Message Table Maintenance ---");
	await maintainAllAreaTables();

	// After both global tables and per-area tables are up to date, backfill
	// the msg_orig_addr / reply_orig_addr tuple columns from any legacy
	// "addr serial" msg_id strings still in the DB. Idempotent.
	console.log("\n--- MSGID tuple split ---");
	await migrateMsgidTupleSplit();
}

async function main() {
	await setupTables();
	process.exit();
}

main();