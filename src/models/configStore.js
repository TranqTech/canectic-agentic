/**
 * PostgreSQL CRUD for the config_settings table.
 *
 * Provides bulk load (for appConfig startup/reload), single-key get/set
 * (for admin UI), and a seed function that populates defaults on first
 * run without overwriting admin-customized values.
 *
 * After any write, publishes a CONFIG_CHANGED event so all processes
 * reload their in-memory config cache.
 */

import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';
import { createEventPublisher, EVENTS } from '../queues/events.js';

var TABLE = 'settings';
var _publisher = null;

// Lazy-create a single event publisher (reused across all writes)
function getPublisher() {
	if (!_publisher) {
		_publisher = createEventPublisher();
	}
	return _publisher;
}

function publishInvalidation(keys) {
	try {
		getPublisher().publish(EVENTS.CONFIG_CHANGED, { keys: keys || [] });
	} catch (err) {
		alogger.writeAlog(3, "[configStore] Publish error: " + err.message, "yellow");
	}
}

// ---------------------------------------------------------------------------
// Bulk reads (used by appConfig.load / reload)
// ---------------------------------------------------------------------------

/**
 * Load all config key-value pairs.  Single query, no N+1.
 * Returns: array of { key, value }
 */
async function loadAll() {
	var rows = await postgres.query(
		"SELECT key, value FROM " + TABLE + " ORDER BY key"
	);
	return rows;
}

/**
 * Load all config rows with full metadata.
 * Returns: array of full row objects
 */
async function loadAllWithMeta() {
	var rows = await postgres.query(
		"SELECT * FROM " + TABLE + " ORDER BY category, key"
	);
	return rows;
}

// ---------------------------------------------------------------------------
// Single-key operations (used by admin UI)
// ---------------------------------------------------------------------------

async function getValue(key) {
	var row = await postgres.queryOne(
		"SELECT value FROM " + TABLE + " WHERE key = $1",
		[key]
	);
	return row ? row.value : null;
}

/**
 * Upsert a single config value.  Publishes invalidation on success.
 */
async function setValue(key, value) {
	var err = await postgres.write(
		"INSERT INTO " + TABLE + " (key, value, updated_at) VALUES ($1, $2, NOW()) " +
		"ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()",
		[key, value]
	);
	if (err) return false;
	publishInvalidation([key]);
	return true;
}

/**
 * Batch upsert.  kvArray: [{ key, value }, ...]
 * Publishes a single invalidation event after all writes.
 */
async function setValues(kvArray) {
	if (!kvArray || kvArray.length === 0) return true;

	for (var kv of kvArray) {
		var err = await postgres.write(
			"INSERT INTO " + TABLE + " (key, value, updated_at) VALUES ($1, $2, NOW()) " +
			"ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()",
			[kv.key, kv.value]
		);
		if (err) {
			alogger.writeAlog(2, "[configStore] setValues error on key '" + kv.key + "': " + err.message, "redbright");
			return false;
		}
	}

	var keys = kvArray.map(function (kv) { return kv.key; });
	publishInvalidation(keys);
	return true;
}

/**
 * Delete a config key.  Publishes invalidation on success.
 */
async function deleteSetting(key) {
	var err = await postgres.write(
		"DELETE FROM " + TABLE + " WHERE key = $1",
		[key]
	);
	if (err) return false;
	publishInvalidation([key]);
	return true;
}

// ---------------------------------------------------------------------------
// Metadata queries (admin UI)
// ---------------------------------------------------------------------------

async function getByCategory(category) {
	var rows = await postgres.query(
		"SELECT * FROM " + TABLE + " WHERE category = $1 ORDER BY key",
		[category]
	);
	return rows;
}

// ---------------------------------------------------------------------------
// Seed defaults
// ---------------------------------------------------------------------------

/**
 * Insert default values for any keys that don't already exist in the DB.
 * Uses ON CONFLICT DO NOTHING so admin-customized values are preserved.
 * Called during appConfig.load() on startup.
 *
 * @param {Array} definitions — CONFIG_DEFINITIONS from configDefaults.js
 */
async function seedDefaults(definitions) {
	var inserted = 0;
	for (var def of definitions) {
		try {
			var result = await postgres.pgpool.query(
				"INSERT INTO " + TABLE + " (key, value, type, category, description, readonly) " +
				"VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (key) DO NOTHING",
				[def.key, def.defaultValue, def.type, def.category, def.description, false]
			);
			if (result.rowCount > 0) inserted++;
		} catch (_) {}
	}
	if (inserted > 0) {
		alogger.writeAlog(3, "[configStore] Seeded " + inserted + " new default config keys", "cyan");
	}
}

// ---------------------------------------------------------------------------
// Table bootstrap
// ---------------------------------------------------------------------------

/**
 * Ensure the settings table exists with the current schema.
 * Called early in appConfig.load() before any queries.
 *
 * If the old settings table exists (has 'name' column instead of 'key'),
 * drop and recreate it — the old table was unused (model was a stub).
 */
async function ensureTable() {
	// Check if old schema exists (has 'name' column but no 'key' column)
	var hasOldSchema = await postgres.queryOne(
		"SELECT EXISTS (SELECT 1 FROM information_schema.columns " +
		"WHERE table_name = 'settings' AND column_name = 'name') AS has_name"
	);
	var hasNewSchema = await postgres.queryOne(
		"SELECT EXISTS (SELECT 1 FROM information_schema.columns " +
		"WHERE table_name = 'settings' AND column_name = 'key') AS has_key"
	);

	if (hasOldSchema && hasOldSchema.has_name && (!hasNewSchema || !hasNewSchema.has_key)) {
		alogger.writeAlog(2, "[configStore] Dropping old settings table (name→key migration)", "yellow");
		await postgres.write("DROP TABLE IF EXISTS " + TABLE);
	}

	await postgres.write(
		"CREATE TABLE IF NOT EXISTS " + TABLE + " (" +
		"  id BIGSERIAL PRIMARY KEY," +
		"  key VARCHAR(255) UNIQUE NOT NULL," +
		"  value TEXT," +
		"  type VARCHAR(32) DEFAULT 'string'," +
		"  category VARCHAR(64) DEFAULT 'system'," +
		"  description TEXT," +
		"  readonly BOOLEAN DEFAULT false," +
		"  created_at TIMESTAMPTZ DEFAULT NOW()," +
		"  updated_at TIMESTAMPTZ DEFAULT NOW()" +
		")"
	);
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

function shutdown() {
	if (_publisher) {
		_publisher.shutdown();
		_publisher = null;
	}
}

/**
 * Publish a CONFIG_CHANGED event without writing anything to the DB.
 *
 * Used by the admin "Reload configuration" action so every process re-reads
 * the .env file and the settings table.  Nothing is persisted: this is a
 * pure invalidation signal.
 */
function publishReload() {
	publishInvalidation([]);
}

export {
	loadAll,
	publishReload,
	loadAllWithMeta,
	getValue,
	setValue,
	setValues,
	deleteSetting,
	getByCategory,
	seedDefaults,
	ensureTable,
	shutdown
};
