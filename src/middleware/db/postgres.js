import pkg from 'pg';
const { Pool } = pkg;
import * as dotenv from 'dotenv';
import * as alogger from "../../utils/alogger.js";

dotenv.config();

const dbuser = process.env.dbuser || "canectic";
const dbhost = process.env.dbhost || "localhost";
const dbname = process.env.dbname || "canectic_bbs";
const dbpass = process.env.dbpass;
const dbport = process.env.dbport || 5432;

const pgpool = new Pool({
  user: dbuser,
  host: dbhost,
  database: dbname,
  password: dbpass,
  port: dbport,
});

// --- Table/column name validation ---
// Only names matching typical SQL identifiers are allowed
const validNameRegex = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function validateName(name, label) {
  if (!validNameRegex.test(name)) {
    throw new Error("Invalid " + label + " name: " + name);
  }
  return name;
}

// --- Core query helpers ---

// Returns rows array (empty array if no results)
async function query(text, params) {
  try {
    var { rows } = await pgpool.query(text, params);
    return rows || [];
  } catch (error) {
    alogger.writeAlog(2, "DB query error: " + error.message, "redbright");
    throw error;
  }
}

// Returns first row, or null if no results
async function queryOne(text, params) {
  var rows = await query(text, params);
  return rows[0] || null;
}

// Executes a write and returns null on success, or the error on failure
async function write(text, params) {
  try {
    await pgpool.query(text, params);
    return null;
  } catch (error) {
    alogger.writeAlog(2, "DB write error: " + error.message, "redbright");
    return error;
  }
}

// --- Parameterized object helpers ---

// INSERT an object into a table, returns { status, result, insertId, errormessages }
async function insertObject(insertObj, tablename) {
  validateName(tablename, "table");
  var retObj = {
    status: false,
    result: "",
    insertId: "",
    errormessages: []
  };

  var paramlist = Object.keys(insertObj);
  var insertvalues = [];
  var columns = [];
  var placeholders = [];
  var i = 1;

  for (var parm of paramlist) {
    validateName(parm, "column");
    columns.push(parm);
    placeholders.push("$" + i);
    insertvalues.push(insertObj[parm]);
    i++;
  }

  var inserttext = "INSERT INTO " + tablename + " (" + columns.join(", ") + ") VALUES(" + placeholders.join(", ") + ") RETURNING id";

  try {
    var rows = await query(inserttext, insertvalues);
    if (rows[0]) {
      retObj.status = true;
      retObj.result = rows[0];
      if (rows[0].id) {
        retObj.insertId = rows[0].id;
      }
    }
  } catch (error) {
    retObj.errormessages.push("Error writing to database: " + error.message);
  }

  return retObj;
}

// UPDATE by id, returns count of affected rows (0 on failure)
async function updateById(objectId, params, tablename) {
  validateName(tablename, "table");
  var paramlist = Object.keys(params);
  var updatevalues = [objectId];
  var setClauses = [];
  var i = 2;

  for (var parm of paramlist) {
    validateName(parm, "column");
    setClauses.push(parm + "=$" + i);
    updatevalues.push(params[parm]);
    i++;
  }

  var updatetext = "WITH rows AS (UPDATE " + tablename + " SET " + setClauses.join(", ") + " WHERE id=$1 RETURNING 1) SELECT count(*) FROM rows";

  try {
    var rows = await query(updatetext, updatevalues);
    if (rows[0] && rows[0].count) {
      return parseInt(rows[0].count);
    }
    return 0;
  } catch (error) {
    return 0;
  }
}

// Check if a value is unique in a table column (case-insensitive)
async function checkValueUnique(column, value, tablename) {
  validateName(tablename, "table");
  validateName(column, "column");
  var querytext = "SELECT COUNT(*) FROM " + tablename + " WHERE UPPER(" + column + ") LIKE UPPER($1)";

  try {
    var rows = await query(querytext, [value.toUpperCase()]);
    if (rows[0] && rows[0].count) {
      return parseInt(rows[0].count) === 0;
    }
    return true;
  } catch (error) {
    // On error, assume not unique to be safe
    return false;
  }
}

export {
  pgpool,
  query,
  queryOne,
  write,
  insertObject,
  updateById,
  checkValueUnique
};