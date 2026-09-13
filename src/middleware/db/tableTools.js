//postgres
import * as postgres from "./postgres.js";
import * as fs from 'fs';
import * as alogger from "../../utils/alogger.js";


async function dropTable(table) {
	var dropsql = "DROP TABLE IF EXISTS " + table;
	await postgres.write(dropsql);
}

async function checkTable(tablename) {
	var readquery = "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema LIKE 'public' AND table_type LIKE 'BASE TABLE' AND table_name = $1)";
	var rows = await postgres.query(readquery, [tablename]);
	if (rows && rows[0] && rows[0].exists) {
		return true;
	}
	return false;
}

// Every column of a table, in one read.
//
// This replaces a checkColumn(table, column) that was its own
// information_schema round trip, called once per column in the template. A
// message area has two backing tables of roughly 28 columns each, so
// maintaining one area cost about 114 queries and measured at 215ms. Thirty-one
// areas took 6.9 seconds, on every dbmigrations run and every process that
// calls it, almost always to discover there was nothing to do.
//
// Keyed lowercase because Postgres folds an unquoted identifier: a definition
// line reading `AreaTag VARCHAR(255)` creates a column named `areatag`, and an
// exact-match check would never find it again, so every run would try to add it
// and fail. No definition file does that today, which is the only reason it has
// not bitten.
//
// Returns a Map of lowercase name -> { name, dataType, maxLength }. The type is
// carried because a caller migrating a legacy column type needs to know whether
// the work has already been done; see messageMaint.
async function getTableColumns(tablename) {
	var readquery = "SELECT column_name, data_type, character_maximum_length " +
		"FROM information_schema.columns " +
		"WHERE table_schema = 'public' AND table_name = $1";
	var rows = await postgres.query(readquery, [tablename]);
	var cols = new Map();
	for (var row of (rows || [])) {
		cols.set(String(row.column_name).toLowerCase(), {
			name: row.column_name,
			dataType: row.data_type,
			maxLength: row.character_maximum_length
		});
	}
	return cols;
}

// The column name out of a definition line such as "seen_by TEXT" or
// "max_age_days INTEGER DEFAULT NULL".
//
// The previous form was col.split(" ")[0].replace(/\s/g, ''), which splits on a
// single literal space. A line separated by a tab returned the whole line, and
// stripping whitespace from that produced "seen_byTEXT", a column that can
// never match and can never be added. A leading space produced an empty name,
// which was skipped silently. Both are the same failure this whole change is
// about: work repeated on every run, achieving nothing, reporting nothing.
function columnNameFromDefinition(definition) {
	if (!definition) return '';
	var trimmed = String(definition).trim();
	if (!trimmed) return '';
	return trimmed.split(/\s+/)[0];
}

async function checkOrCreateTable(tablename, tablecolumns, removecolumns) {
	var colarray  = tablecolumns  || [];
	var rcolarray = removecolumns || [];

	var doesexist = await checkTable(tablename);

	if (doesexist) {
		alogger.writeAlog(5, "checkOrCreateTable: table " + tablename + " exists, checking columns", "cyan");

		var existingcols = await getTableColumns(tablename);
		var addcolumns   = [];
		var dropcolumns  = [];

		for (var col of colarray) {
			var checkcolumn = columnNameFromDefinition(col);
			if (checkcolumn && !existingcols.has(checkcolumn.toLowerCase())) {
				addcolumns.push("ADD COLUMN " + col);
			}
		}

		for (var rcol of rcolarray) {
			var rcheckcolumn = columnNameFromDefinition(rcol);
			if (rcheckcolumn && existingcols.has(rcheckcolumn.toLowerCase())) {
				dropcolumns.push("DROP COLUMN " + rcheckcolumn);
			}
		}

		var alteraddsql    = addcolumns.length  > 0 ? "ALTER TABLE " + tablename + " " + addcolumns.join(", ")  : null;
		var alterremovesql = dropcolumns.length > 0 ? "ALTER TABLE " + tablename + " " + dropcolumns.join(", ") : null;

		if (alteraddsql) {
			alogger.writeAlog(5, "checkOrCreateTable: adding columns to " + tablename + ": " + addcolumns.join(", "), "cyan");
			try {
				await postgres.write(alteraddsql);
			} catch (error) {
				alogger.writeAlog(3, "checkOrCreateTable: error adding columns to " + tablename + ": " + error.message, "redbright");
			}
		}

		if (alterremovesql) {
			alogger.writeAlog(5, "checkOrCreateTable: dropping columns from " + tablename + ": " + dropcolumns.join(", "), "cyan");
			try {
				await postgres.write(alterremovesql);
			} catch (error) {
				alogger.writeAlog(3, "checkOrCreateTable: error dropping columns from " + tablename + ": " + error.message, "redbright");
			}
		}

		if (!alteraddsql && !alterremovesql) {
			alogger.writeAlog(5, "checkOrCreateTable: " + tablename + " schema is current, no changes needed", "cyan");
		}

		// The column map is as it was before any ALTER above. That is what a
		// caller wants: it is the only description of what the table looked
		// like on arrival, and reading it again would undo the point of reading
		// it once. Anything this call added is by definition as the definition
		// file specifies it.
		return { existed: true, columns: existingcols, added: addcolumns.length, dropped: dropcolumns.length };
	}

	alogger.writeAlog(5, "checkOrCreateTable: creating table " + tablename, "cyan");
	var arraystring = colarray.join(", ");
	var createsql   = "CREATE TABLE " + tablename + " (" + arraystring + ")";
	var createerr   = await postgres.write(createsql);
	if (createerr) {
		alogger.writeAlog(3, "checkOrCreateTable: error creating table " + tablename + ": " + createerr.message, "redbright");
	}
	return { existed: false, columns: new Map(), added: 0, dropped: 0, created: !createerr };
}

async function getColumnsFromFile(filepath) {
	var colarray = [];
	try {
		var filearray = fs.readFileSync(filepath).toString().split("\n");
		if (filearray) {
			// Drop blank lines. A raw split leaves an empty entry for a
			// trailing newline, which lands in the CREATE TABLE column list as
			// ", )" and fails with a syntax error. The templates happen to be
			// written without a trailing newline, so the whole file format was
			// one stray keystroke away from breaking area creation.
			colarray = filearray.filter(function (line) {
				return line && line.trim().length > 0;
			});
		}
	} catch (error) {
		alogger.writeAlog(3, "getColumnsFromFile: could not read " + filepath + ": " + error.message, "redbright");
	}
	return colarray;
}

export { checkOrCreateTable, checkTable, dropTable, getColumnsFromFile, getTableColumns, columnNameFromDefinition };