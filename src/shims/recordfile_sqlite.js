/**
 * recordfile_sqlite.js — SQLite-backed replacement for Synchronet's RecordFile
 *
 * Drop-in replacement that maintains the same API surface as the original
 * recordfile.js but stores data in a SQLite database instead of fixed-width
 * binary record files.
 *
 * Benefits over the binary format:
 *   - No fixed record sizes — fields can grow/shrink without migration
 *   - Proper transactional locking (no file-level byte range locks)
 *   - Queryable data (find players by name, etc.)
 *   - Concurrent access from multiple processes/threads via WAL mode
 *   - Easy to inspect and debug with standard SQLite tools
 *
 * Architecture:
 *   - Each RecordFile maps to a table in a shared SQLite database
 *   - The table name is derived from the filename (e.g. "player.bin" → "player")
 *   - Columns are created from the RecordDef field definitions
 *   - Record numbers map to ROWID - 1 (zero-based, matching original behavior)
 *   - Locking uses SQLite's built-in transaction isolation
 *
 * Usage (same as original):
 *   var pfile = new RecordFile('path/to/player.bin', Player_Def);
 *   var rec = pfile.get(0);        // Load record 0
 *   rec.name = "TestPlayer";
 *   rec.put();                     // Save back
 *   var newrec = pfile.new();      // Create new record
 *
 * Note: This module depends on better-sqlite3 which must be npm installed.
 *       It's designed to be loaded via the syncnet_globals require() shim.
 */

import Database from 'better-sqlite3';
import * as nodePath from 'node:path';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';


// ============================================================
//  Helpers
// ============================================================

/**
 * Derive a SQLite column type from a RecordDef field type.
 */
function fieldTypeToSQL(fieldtype) {
	if (typeof fieldtype === 'object') {
		// Nested record — store as JSON
		return 'TEXT';
	}
	switch (fieldtype) {
		case 'Float':          return 'REAL';
		case 'SignedInteger':
		case 'Integer':
		case 'SignedInteger16':
		case 'Integer16':
		case 'SignedInteger8':
		case 'Integer8':       return 'INTEGER';
		case 'Date':           return 'TEXT';
		case 'Boolean':        return 'INTEGER';  // 0/1
		default:
			// String:N, PString:N, Array:N:type
			if (fieldtype.match(/^(P)?String:[0-9]+$/)) return 'TEXT';
			if (fieldtype.match(/^Array:[0-9]+:/)) return 'TEXT'; // stored as JSON
			return 'TEXT';
	}
}

/**
 * Convert a JavaScript value to its SQLite storage form.
 */
function valueToSQL(val, fieldtype) {
	if (val === undefined || val === null) return null;
	if (typeof fieldtype === 'object') return JSON.stringify(val);
	if (fieldtype === 'Boolean') return val ? 1 : 0;
	if (typeof fieldtype === 'string' && fieldtype.match(/^Array:/)) return JSON.stringify(val);
	// Coerce booleans to numbers for numeric fields (LORD2 uses def:false for integers)
	if (typeof val === 'boolean') return val ? 1 : 0;
	// Coerce arrays to JSON (shouldn't happen here but safety net)
	if (Array.isArray(val)) return JSON.stringify(val);
	return val;
}

/**
 * Convert a SQLite value back to the expected JavaScript type.
 */
function valueFromSQL(val, fieldtype, def) {
	if (val === null || val === undefined) {
		return resolveDefault(def);
	}
	if (typeof fieldtype === 'object') {
		try { return JSON.parse(val); }
		catch (_) { return resolveDefault(def); }
	}
	if (fieldtype === 'Boolean') return val > 0;
	if (fieldtype.match(/^Array:/)) {
		try { return JSON.parse(val); }
		catch (_) { return []; }
	}
	return val;
}

/**
 * Resolve a default value from a RecordDef entry.
 * Synchronet uses eval(def.toSource()) — we just return the def directly.
 */
function resolveDefault(def) {
	if (typeof def === 'function') return def();
	return def;
}

/**
 * Derive a table name from a file path.
 * "path/to/player.bin" → "player"
 */
function tableNameFromPath(filepath) {
	var base = nodePath.basename(filepath);
	// Remove extension
	var dot = base.lastIndexOf('.');
	if (dot > 0) base = base.substring(0, dot);
	// Sanitize for SQL
	return base.replace(/[^a-zA-Z0-9_]/g, '_');
}


// ============================================================
//  Database connection manager (singleton per directory)
// ============================================================
var _dbCache = {};
var _dbDirOverride = null;

/**
 * Set a global override for where the SQLite database file is created.
 * If set, ALL RecordFile instances will use this directory instead of
 * deriving it from the record file path.
 *
 * @param {string|null} dir — absolute path to the database directory, or null to clear
 */
function setDatabaseDir(dir) {
	_dbDirOverride = dir || null;
}

function getDatabase(filepath) {
	var dir = _dbDirOverride
		? nodePath.resolve(_dbDirOverride)
		: nodePath.dirname(nodePath.resolve(filepath));

	if (_dbCache[dir]) return _dbCache[dir];

	// Ensure directory exists
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	var dbPath = nodePath.join(dir, 'gamedata.sqlite');
	var db = new Database(dbPath);

	// Enable WAL mode for better concurrent access
	db.pragma('journal_mode = WAL');
	db.pragma('busy_timeout = 5000');

	_dbCache[dir] = db;
	return db;
}


// ============================================================
//  RecordFile
// ============================================================

class RecordFile {
	constructor(filename, definition) {
		this.filename = filename;
		this.fields = definition;
		this.tableName = tableNameFromPath(filename);
		this.RecordLength = GetRecordLength(definition);  // Compat — not used for SQLite
		this.locks = [];

		// Compat: Synchronet RecordFile exposes .file for the underlying File object.
		// LORD1 accesses .file.name and .file.close().
		// LORD2 also accesses .file.position and .file.is_open.
		var self = this;
		this.file = {
			name: filename,
			_position: 0,
			get position() { return this._position; },
			set position(v) { this._position = v; },
			get length() { return self.length * self.RecordLength; },
			get is_open() { return true; },
			close: function() { self.close(); },
			truncate: function(len) { self.truncate(len); }
		};

		// Open database
		this._db = getDatabase(filename);

		// Ensure table exists with correct schema
		this._ensureTable();

		// Prepare commonly used statements
		this._prepareStatements();

		// Auto-import: if the original binary file exists on disk, check
		// whether the SQLite table has the correct number of records.
		// Re-import if the table is empty or has fewer records than
		// the binary file (previous import may have failed or been partial).
		if (existsSync(filename)) {
			try {
				var rawSize = statSync(filename).size;
				var recordLen = getRecordLength(this.fields);
				var binaryRecordCount = recordLen > 0 ? Math.floor(rawSize / recordLen) : 0;
				if (binaryRecordCount > 0 && this.length < binaryRecordCount) {
					// Clear any partial data and reimport
					if (this.length > 0) {
						this._db.exec('DELETE FROM "' + this.tableName + '"');
					}
					var imported = this._importBinary(filename);
					if (imported > 0) {
						console.log('[RecordFile] Auto-imported ' + imported + ' records from ' + nodePath.basename(filename));
					}
				}
			} catch (err) {
				console.error('[RecordFile] Binary import failed for ' + filename + ': ' + (err.stack || err.message));
			}
		}
	}

	/**
	 * Create the table if it doesn't exist, and add any missing columns.
	 */
	_ensureTable() {
		var columns = ['_record_id INTEGER PRIMARY KEY AUTOINCREMENT'];
		for (var field of this.fields) {
			var colType = fieldTypeToSQL(field.type);
			columns.push('"' + field.prop + '" ' + colType);
		}

		this._db.exec(
			'CREATE TABLE IF NOT EXISTS "' + this.tableName + '" (' +
			columns.join(', ') + ')'
		);

		// Check for missing columns (schema migration)
		var info = this._db.pragma('table_info("' + this.tableName + '")');
		var existingCols = {};
		for (var col of info) {
			existingCols[col.name] = true;
		}

		for (var field of this.fields) {
			if (!existingCols[field.prop]) {
				var colType = fieldTypeToSQL(field.type);
				this._db.exec(
					'ALTER TABLE "' + this.tableName +
					'" ADD COLUMN "' + field.prop + '" ' + colType
				);
			}
		}
	}

	/**
	 * Pre-compile SQL statements for performance.
	 */
	_prepareStatements() {
		var cols = this.fields.map(function(f) { return '"' + f.prop + '"'; });
		var placeholders = this.fields.map(function() { return '?'; });

		this._stmtCount = this._db.prepare(
			'SELECT COUNT(*) as cnt FROM "' + this.tableName + '"'
		);

		this._stmtGet = this._db.prepare(
			'SELECT * FROM "' + this.tableName + '" ORDER BY _record_id LIMIT 1 OFFSET ?'
		);

		this._stmtInsert = this._db.prepare(
			'INSERT INTO "' + this.tableName + '" (' + cols.join(', ') + ') VALUES (' + placeholders.join(', ') + ')'
		);

		// Build UPDATE statement
		var setClauses = this.fields.map(function(f) {
			return '"' + f.prop + '" = ?';
		});
		this._stmtUpdate = this._db.prepare(
			'UPDATE "' + this.tableName + '" SET ' + setClauses.join(', ') +
			' WHERE _record_id = (SELECT _record_id FROM "' + this.tableName + '" ORDER BY _record_id LIMIT 1 OFFSET ?)'
		);

		// For getting the _record_id by record number
		this._stmtGetId = this._db.prepare(
			'SELECT _record_id FROM "' + this.tableName + '" ORDER BY _record_id LIMIT 1 OFFSET ?'
		);
	}

	/** Number of records (property) */
	get length() {
		var row = this._stmtCount.get();
		return row ? row.cnt : 0;
	}

	/**
	 * Get a record by number (0-based).
	 */
	get(num, keeplocked) {
		if (num === undefined || num < 0 || parseInt(num, 10) !== num) return null;
		num = parseInt(num, 10);
		if (num >= this.length) return null;

		var row = this._stmtGet.get(num);
		if (!row) return null;

		var rec = new RecordFileRecord(this, num);
		for (var field of this.fields) {
			rec[field.prop] = valueFromSQL(row[field.prop], field.type, field.def);
		}
		rec._dbRecordId = row._record_id;

		if (keeplocked) {
			this.lock(num);
		}

		return rec;
	}
	Get(num, keeplocked) { return this.get(num, keeplocked); }

	/**
	 * Create a new record with default values.
	 */
	new(timeout, keeplocked) {
		var rec = new RecordFileRecord(this, this.length);
		rec.reInit();

		// Insert into database
		var values = this.fields.map(function(f) {
			return valueToSQL(rec[f.prop], f.type);
		});

		var result = this._stmtInsert.run.apply(this._stmtInsert, values);
		rec._dbRecordId = result.lastInsertRowid;
		rec.Record = this.length - 1; // Adjust to new zero-based index

		if (keeplocked) {
			this.lock(rec.Record);
		}

		return rec;
	}
	New(timeout, keeplocked) { return this.new(timeout, keeplocked); }

	/**
	 * Record locking (simplified — uses in-memory tracking).
	 * Real concurrency safety comes from SQLite transactions.
	 */
	lock(rec, timeout) {
		if (rec === undefined) return false;
		if (this.locks.indexOf(rec) !== -1) return false; // Already locked by us
		this.locks.push(rec);
		return true;
	}
	Lock(rec, timeout) { return this.lock(rec, timeout); }

	unLock(rec) {
		if (rec === undefined) return false;
		var idx = this.locks.indexOf(rec);
		if (idx === -1) return false;
		this.locks.splice(idx, 1);
		return true;
	}
	UnLock(rec) { return this.unLock(rec); }

	/**
	 * Import records from a binary file into this RecordFile's SQLite table.
	 * Used for auto-importing game data files on first run.
	 */
	_importBinary(binFilePath) {
		var rawBuffer = readFileSync(binFilePath);
		var recordLen = getRecordLength(this.fields);
		var recordCount = Math.floor(rawBuffer.length / recordLen);
		if (recordCount === 0) return 0;

		var insertTransaction = this._db.transaction(function(records) {
			for (var rec of records) {
				var newRec = this.new();
				for (var field of this.fields) {
					newRec[field.prop] = rec[field.prop];
				}
				newRec.put();
			}
		}.bind(this));

		var records = [];
		for (var r = 0; r < recordCount; r++) {
			var offset = r * recordLen;
			var rec = {};
			var pos = offset;
			for (var field of this.fields) {
				var result = readBinaryField(rawBuffer, pos, field.type);
				rec[field.prop] = result.value;
				pos = result.nextOffset;
			}
			records.push(rec);
		}

		insertTransaction(records);
		return recordCount;
	}

	/**
	 * Close the record file.
	 */
	close() {
		while (this.locks.length > 0) {
			this.unLock(this.locks[0]);
		}
		// Don't close the database here — it's shared
	}
	Close() { return this.close(); }

	/**
	 * Truncate to a maximum number of bytes (binary compat) or records.
	 * LORD2 calls pfile.truncate(pfile.RecordLength * 200) to cap at 200 records.
	 * For SQLite, we delete records beyond the limit.
	 */
	truncate(byteLen) {
		if (byteLen === undefined) return;
		var maxRecords = Math.floor(byteLen / this.RecordLength);
		if (maxRecords < this.length) {
			// Delete records beyond the limit
			this._db.prepare(
				'DELETE FROM "' + this.tableName + '" WHERE _record_id IN (' +
				'SELECT _record_id FROM "' + this.tableName + '" ORDER BY _record_id LIMIT -1 OFFSET ?' +
				')'
			).run(maxRecords);
		}
	}

	// --- Compat stubs for readField/writeField ---
	// These existed for binary I/O. With SQLite they're not needed
	// but some code might call them directly.
	readField(fieldtype) { return null; }
	ReadField(fieldtype) { return null; }
	writeField(val, fieldtype, def) {}
	WriteField(val, fieldtype, def) {}
}


// ============================================================
//  RecordFileRecord
// ============================================================

class RecordFileRecord {
	constructor(parent, num) {
		this.parent = parent;
		this.Record = num;
		this._dbRecordId = null;

		// When created without a record number (e.g. new RecordFileRecord(pfile)),
		// initialize all fields to defaults so the record is usable immediately.
		if (num === undefined || num === null) {
			this.reInit();
		}
	}

	/**
	 * Reset all fields to their default values.
	 */
	reInit() {
		for (var field of this.parent.fields) {
			this[field.prop] = resolveDefault(field.def);
		}
	}
	ReInit() { return this.reInit(); }

	/**
	 * Save this record back to the database.
	 */
	put(keeplocked) {
		if (this.Record === undefined || this.Record === null) {
			// Detached record — insert as new
			var newRec = this.parent.new();
			this.Record = newRec.Record;
			this._dbRecordId = newRec._dbRecordId;
		}

		var lock = (this.parent.locks.indexOf(this.Record) === -1);

		if (lock) {
			this.parent.lock(this.Record);
		}

		var values = [];
		for (var field of this.parent.fields) {
			values.push(valueToSQL(this[field.prop], field.type));
		}
		values.push(this.Record); // WHERE offset

		this.parent._stmtUpdate.run.apply(this.parent._stmtUpdate, values);

		if (!keeplocked && lock) {
			this.parent.unLock(this.Record);
		}
	}
	Put(keeplocked) { return this.put(keeplocked); }

	/**
	 * Reload this record from the database.
	 */
	reLoad(keeplocked) {
		var row = this.parent._stmtGet.get(this.Record);
		if (!row) return;

		for (var field of this.parent.fields) {
			this[field.prop] = valueFromSQL(row[field.prop], field.type, field.def);
		}
		this._dbRecordId = row._record_id;
	}
	ReLoad(keeplocked) { return this.reLoad(keeplocked); }

	/**
	 * Flush read cache — no-op for SQLite (no caching issues).
	 */
	flushRead(keeplocked) {
		// SQLite doesn't have the read caching problems that
		// Synchronet's binary files had. This is a no-op.
	}
	FlushRead(keeplocked) { return this.flushRead(keeplocked); }

	/**
	 * Lock this record.
	 */
	lock(timeout) {
		return this.parent.lock(this.Record, timeout);
	}
	Lock(timeout) { return this.lock(timeout); }

	/**
	 * Unlock this record.
	 */
	unLock() {
		return this.parent.unLock(this.Record);
	}
	UnLock() { return this.unLock(); }
}


// ============================================================
//  GetRecordLength — compat function (not needed for SQLite
//  but some code references it)
// ============================================================

function getRecordLength(RecordDef) {
	var len = 0;

	function getTypeLength(fieldtype) {
		if (typeof fieldtype === 'object') {
			var fl = getRecordLength(fieldtype.recordDef);
			if (fieldtype.array !== undefined) fl *= fieldtype.array;
			return fl;
		}
		switch (fieldtype) {
			case 'Float':           return 22;
			case 'SignedInteger8':
			case 'Integer8':        return 1;
			case 'SignedInteger16':
			case 'Integer16':       return 2;
			case 'SignedInteger':
			case 'Integer':         return 4;
			case 'Date':            return 8;
			case 'Boolean':         return 1;
			default:
				var m = fieldtype.match(/^String:([0-9]+)$/);
				if (m) return parseInt(m[1], 10);
				m = fieldtype.match(/^PString:([0-9]+)$/);
				if (m) return parseInt(m[1], 10) + 1;
				return 0;
		}
	}

	for (var i = 0; i < RecordDef.length; i++) {
		var m = null;
		if (typeof RecordDef[i].type === 'string') {
			m = RecordDef[i].type.match(/^Array:([0-9]+):(.*)$/);
		}
		if (m !== null) {
			len += getTypeLength(m[2]) * parseInt(m[1], 10);
		} else {
			len += getTypeLength(RecordDef[i].type);
		}
	}
	return len;
}

function GetRecordLength(RecordDef) {
	return getRecordLength(RecordDef);
}


// ============================================================
//  Binary import utility
// ============================================================

/**
 * Import an existing binary player.bin (or other record file) into SQLite.
 * Reads the binary file using the original record format and inserts
 * each record into the SQLite database.
 *
 * @param {string} binFilePath — path to the binary record file
 * @param {Array} recordDef — the field definition array
 * @param {string} sqliteDir — directory for the SQLite database
 * @returns {number} number of records imported
 */
function importBinaryRecordFile(binFilePath, recordDef, sqliteDir) {
	if (!existsSync(binFilePath)) return 0;

	var rawBuffer = readFileSync(binFilePath);
	var recordLen = getRecordLength(recordDef);
	var recordCount = Math.floor(rawBuffer.length / recordLen);

	if (recordCount === 0) return 0;

	// Create RecordFile (which creates the table)
	var rf = new RecordFile(nodePath.join(sqliteDir, nodePath.basename(binFilePath)), recordDef);

	for (var r = 0; r < recordCount; r++) {
		var offset = r * recordLen;
		var rec = {};

		// Parse each field from the binary data
		var pos = offset;
		for (var field of recordDef) {
			var result = readBinaryField(rawBuffer, pos, field.type);
			rec[field.prop] = result.value;
			pos = result.nextOffset;
		}

		// Create a new RecordFileRecord and populate it
		var newRec = rf.new();
		for (var field of recordDef) {
			newRec[field.prop] = rec[field.prop];
		}
		newRec.put();
	}

	rf.close();
	return recordCount;
}

/**
 * Read a single field value from a binary buffer.
 */
function readBinaryField(buffer, offset, fieldtype) {
	var m;

	// Object types: { array: N, recordDef: [...] } — array of sub-records
	if (typeof fieldtype === 'object' && fieldtype.recordDef) {
		var count = fieldtype.array || 1;
		var arr = [];
		for (var i = 0; i < count; i++) {
			var subRec = {};
			for (var sf of fieldtype.recordDef) {
				var result = readBinaryField(buffer, offset, sf.type);
				subRec[sf.prop] = result.value;
				offset = result.nextOffset;
			}
			arr.push(subRec);
		}
		return { value: arr, nextOffset: offset };
	}

	if (typeof fieldtype === 'string') {
		m = fieldtype.match(/^Array:([0-9]+):(.*)$/);
	}
	if (m) {
		var arr = [];
		var count = parseInt(m[1], 10);
		for (var i = 0; i < count; i++) {
			var result = readBinaryField(buffer, offset, m[2]);
			arr.push(result.value);
			offset = result.nextOffset;
		}
		return { value: arr, nextOffset: offset };
	}

	switch (fieldtype) {
		case 'Float': {
			var str = buffer.subarray(offset, offset + 22).toString('binary').replace(/\x00/g, '');
			return { value: parseFloat(str) || 0, nextOffset: offset + 22 };
		}
		case 'SignedInteger': {
			var val = buffer.readUInt32LE(offset);
			if (val >= 2147483648) val -= 4294967296;
			return { value: val, nextOffset: offset + 4 };
		}
		case 'Integer': {
			return { value: buffer.readUInt32LE(offset), nextOffset: offset + 4 };
		}
		case 'SignedInteger16': {
			var val = buffer.readUInt16LE(offset);
			if (val >= 32768) val -= 65536;
			return { value: val, nextOffset: offset + 2 };
		}
		case 'Integer16': {
			return { value: buffer.readUInt16LE(offset), nextOffset: offset + 2 };
		}
		case 'SignedInteger8': {
			var val = buffer.readUInt8(offset);
			if (val >= 127) val -= 256;
			return { value: val, nextOffset: offset + 1 };
		}
		case 'Integer8': {
			return { value: buffer.readUInt8(offset), nextOffset: offset + 1 };
		}
		case 'Date': {
			var str = buffer.subarray(offset, offset + 8).toString('binary').replace(/\x00/g, '');
			return { value: str, nextOffset: offset + 8 };
		}
		case 'Boolean': {
			return { value: buffer.readUInt8(offset) > 0, nextOffset: offset + 1 };
		}
		default: {
			m = fieldtype.match(/^String:([0-9]+)$/);
			if (m) {
				var len = parseInt(m[1], 10);
				var str = buffer.subarray(offset, offset + len).toString('binary').replace(/\x00/g, '');
				return { value: str, nextOffset: offset + len };
			}
			m = fieldtype.match(/^PString:([0-9]+)$/);
			if (m) {
				var maxLen = parseInt(m[1], 10);
				var strLen = buffer.readUInt8(offset);
				var str = buffer.subarray(offset + 1, offset + 1 + maxLen).toString('binary').substring(0, strLen);
				return { value: str, nextOffset: offset + 1 + maxLen };
			}
			return { value: null, nextOffset: offset };
		}
	}
}


// ============================================================
//  Exports
// ============================================================

export {
	RecordFile,
	RecordFileRecord,
	GetRecordLength,
	getRecordLength,
	setDatabaseDir,
	importBinaryRecordFile,
};