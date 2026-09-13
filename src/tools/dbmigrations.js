//imports
import * as dotenv from 'dotenv';
import * as pgdb from "../middleware/db/postgres.js";
import * as fs from 'fs';
import * as alogger from "../utils/alogger.js";
import { maintainAllAreaTables } from "../models/messageMaint.js";
// Aliased: this file already has a getTableColumns that reads column
// definitions out of a .conf file. The imported one reads the live table.
import { getTableColumns as getLiveTableColumns, columnNameFromDefinition } from "../middleware/db/tableTools.js";
import * as ledger from "../maintenance/migrationLedger.js";
import * as systeminfo from "../utils/systeminfo.js";

//setup
dotenv.config();
const workingdir = process.cwd();
const seedDir = workingdir + "/db/seed";
const schemaDir = workingdir + "/db/schema";
const migrationsDir = workingdir + "/db/migrations";

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

// One read of the table's columns, shared with tableTools so the static tables
// here and the per-area tables there cannot drift.
//
// This replaced a checkColumn(table, column) doing its own information_schema
// round trip per column. With roughly 127 tables in tablenames.conf, that was
// thousands of queries on every migration run to establish, almost always, that
// nothing needed doing. Returns null when the read failed, which the caller
// must treat as "do not alter this table" rather than as "no columns": the old
// per-column version returned false on error, so a database hiccup made every
// column look missing and produced an ALTER TABLE adding all of them.
async function readTableColumns(tablename) {
	try {
		return await getLiveTableColumns(tablename);
	} catch (error) {
		console.log("  Error reading columns for " + tablename + ":", error.message);
		return null;
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

	var existingCols = await readTableColumns(tablename);
	if (!existingCols) {
		summary.errors.push(tablename + ": could not read columns");
		return;
	}

	// Check columns to add
	for (var col of colarray) {
		var colName = columnNameFromDefinition(col);
		if (!colName) continue;
		if (!existingCols.has(colName.toLowerCase())) {
			console.log("    + Adding column: " + colName);
			addClauses.push("ADD COLUMN " + col);
		}
	}

	// Check columns to remove
	for (var rcol of rcolarray) {
		var rcolName = columnNameFromDefinition(rcol);
		if (!rcolName) continue;
		if (existingCols.has(rcolName.toLowerCase())) {
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

// --- Main ---

function printSummary(summary) {
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
}

// Run one migration phase and report it. Returns the phase result so the caller
// can stop the whole run on a failure.
async function runLedgerPhase(migrations, phase) {
	var version = systeminfo.softwareVersion();

	var result = await ledger.runPhase(migrations, phase, {
		version: version,
		log: function (line) { console.log(line); }
	});

	for (var r of result.results) {
		if (r.outcome === 'applied') console.log("  applied: " + r.id);
		if (r.outcome === 'skipped') console.log("  not needed: " + r.id);
	}

	if (result.failed) {
		console.log("");
		console.log("  MIGRATION FAILED: " + result.failed.id);
		console.log("  " + result.failed.error);
		console.log("");
		console.log("  Nothing after it has run. Fix the cause and run this again;");
		console.log("  migrations that already succeeded will not be repeated.");
		return result;
	}

	// Manual migrations are reported, never run. The tool that performs one
	// records it.
	for (var m of result.manual) {
		console.log("");
		console.log("  ACTION NEEDED: " + m.id);
		console.log("  " + m.description);
		console.log("");
		for (var line of String(m.instructions).split("\n")) {
			console.log("      " + line);
		}
	}

	if (result.applied === 0 && result.skipped === 0 && result.manual.length === 0) {
		console.log("  Nothing pending.");
	}

	return result;
}

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

	// Load and validate every migration before anything touches the database.
	// A typo in one of them should stop the run here, not after three others
	// have already altered things.
	var loaded = await ledger.loadMigrations(migrationsDir);
	if (loaded.errors.length > 0) {
		console.log("\n--- Migration ledger ---");
		console.log("  REFUSING TO RUN. Migrations failed validation:");
		for (var le of loaded.errors) console.log("    " + le);
		summary.errors.push("migration ledger: " + loaded.errors.length + " invalid migration(s)");
		printSummary(summary);
		process.exitCode = 1;
		return;
	}

	// Is this a database that has never held a Canectic install?
	//
	// It decides whether migrations are applied or recorded as never needed, so
	// it is checked BEFORE the table pass creates anything. Getting it wrong in
	// the "fresh" direction is the dangerous one: an existing install marked
	// preinstalled would skip every repair it actually needed, silently. So the
	// test is the presence of the users table, which every real install has had
	// since the beginning.
	var freshDatabase = !(await checkTable('users'));
	if (freshDatabase) {
		console.log("\n--- Migration ledger ---");
		console.log("  Fresh database: recording " + loaded.migrations.length +
			" migration(s) as not needed.");
	}

	// Bootstrap the ledger table before anything can need to write to it.
	//
	// It cannot wait for the general table pass below, because pre-schema
	// migrations run first and have to record themselves. The ledger is the
	// thing every other migration reports into, so it is created explicitly
	// rather than discovered in the ordinary sweep.
	await checkOrCreateTable('schema_migrations', summary);

	// Pre-schema migrations: anything that has to read data the declarative
	// pass is about to drop.
	if (!freshDatabase && loaded.migrations.length > 0) {
		console.log("\n--- Migrations (pre-schema) ---");
		var preResult = await runLedgerPhase(loaded.migrations, ledger.PHASE_PRE);
		if (preResult.stopped) {
			summary.errors.push("migration " + preResult.failed.id + " failed");
			printSummary(summary);
			process.exitCode = 1;
			return;
		}
	}

	// Check/create tables
	var tableNames = getTableNames();
	console.log("\n--- Checking tables ---");
	for (var table of tableNames) {
		console.log("\n  Processing: " + table);
		await checkOrCreateTable(table, summary);
	}

	printSummary(summary);

	// Apply template-driven schema maintenance to all dynamic message/thread tables
	console.log("\n--- Message Table Maintenance ---");
	await maintainAllAreaTables();

	// A fresh database is born current: there is no legacy data for a migration
	// to repair, so every one is recorded as never needed. This happens after
	// the table pass, because the ledger table has to exist before it can be
	// written to.
	if (freshDatabase) {
		var version = systeminfo.softwareVersion();
		var recorded = await ledger.recordFreshInstall(loaded.migrations, { version: version });
		console.log("\n--- Migration ledger ---");
		console.log("  Recorded " + recorded + " migration(s) as not needed on a fresh database.");
		return;
	}

	// Post-schema migrations: everything that needs the schema to be current.
	// This is where a one-shot data repair belongs, and where the manual ones
	// are reported.
	if (loaded.migrations.length > 0) {
		console.log("\n--- Migrations (post-schema) ---");
		var postResult = await runLedgerPhase(loaded.migrations, ledger.PHASE_POST);
		if (postResult.stopped) {
			process.exitCode = 1;
		}
	}
}

async function main() {
	await setupTables();
	process.exit();
}

main();