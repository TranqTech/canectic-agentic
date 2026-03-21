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

async function checkColumn(tablename, columnname) {
	var readquery = "SELECT EXISTS (SELECT FROM information_schema.columns WHERE table_schema LIKE 'public' AND table_name=$1 AND column_name=$2)";
	var rows = await postgres.query(readquery, [tablename, columnname]);
	if (rows && rows[0] && rows[0].exists) {
		return true;
	}
	return false;
}

async function checkOrCreateTable(tablename, tablecolumns, removecolumns) {
	var colarray  = tablecolumns  || [];
	var rcolarray = removecolumns || [];

	var doesexist = await checkTable(tablename);

	if (doesexist) {
		alogger.writeAlog(5, "checkOrCreateTable: table " + tablename + " exists, checking columns", "cyan");

		var addcolumns  = [];
		var dropcolumns = [];

		if (colarray.length > 0) {
			for (var col of colarray) {
				var checkcolumn = col.split(" ")[0].replace(/\s/g, '');
				if (checkcolumn) {
					var cdoesexist = await checkColumn(tablename, checkcolumn);
					if (!cdoesexist) {
						addcolumns.push("ADD COLUMN " + col);
					}
				}
			}
		}

		if (rcolarray.length > 0) {
			for (var rcol of rcolarray) {
				var rcheckcolumn = rcol.split(" ")[0].replace(/\s/g, '');
				if (rcheckcolumn) {
					var cdoesexist = await checkColumn(tablename, rcheckcolumn);
					if (cdoesexist) {
						dropcolumns.push("DROP COLUMN " + rcheckcolumn);
					}
				}
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
	} else {
		alogger.writeAlog(5, "checkOrCreateTable: creating table " + tablename, "cyan");
		var arraystring = colarray.join(", ");
		var createsql   = "CREATE TABLE " + tablename + " (" + arraystring + ")";
		await postgres.write(createsql);
	}
}

async function getColumnsFromFile(filepath) {
	var colarray = [];
	try {
		var filearray = fs.readFileSync(filepath).toString().split("\n");
		if (filearray) {
			colarray = filearray;
		}
	} catch (error) {
		alogger.writeAlog(3, "getColumnsFromFile: could not read " + filepath + ": " + error.message, "redbright");
	}
	return colarray;
}

export { checkOrCreateTable, checkTable, dropTable, getColumnsFromFile };