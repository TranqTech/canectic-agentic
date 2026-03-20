/**
 * Centralized configuration singleton.
 *
 * Loads config from three tiers (highest precedence first):
 *   1. .env          — bootstrap secrets and explicit overrides
 *   2. PostgreSQL    — admin-editable operational values (config_settings table)
 *   3. Defaults      — hardcoded fallbacks from configDefaults.js
 *
 * load() and reload() are async (DB reads).  All getters are synchronous
 * (read from an in-memory plain object).  This solves the tension between
 * Express middleware needing sync access and DB reads being async.
 *
 * Cross-process invalidation:
 *   Admin saves config → configStore writes to PG → publishes CONFIG_CHANGED
 *   → each process's event subscriber calls appConfig.reload()
 *
 * Usage:
 *   import appConfig from '../config/appConfig.js';
 *   await appConfig.load();               // once at startup
 *   var name = appConfig.get('boardname');  // sync, anywhere
 */

import { CONFIG_DEFINITIONS, getDefaults } from './configDefaults.js';
import * as configStore from '../models/configStore.js';
import * as alogger from '../utils/alogger.js';

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

var _cache = {};         // The merged config — flat key→value (all strings)
var _loaded = false;     // Whether initial load has completed
var _loading = null;     // Promise for in-flight load (dedup rapid reloads)
var _sources = {};       // key → 'env' | 'db' | 'default' (for admin UI)

// Keys that exist in .env and should always take precedence over DB values.
// Built dynamically during load — any key present in process.env wins.
var _envKeys = {};

// Bootstrap keys that are ONLY read from .env (never from DB).
// These are needed before PostgreSQL is available.
var BOOTSTRAP_KEYS = new Set([
	'dbuser', 'dbhost', 'dbname', 'dbpass', 'dbport',
	'redis_url', 'REDIS_PASSWORD', 'REDIS_BULLMQ_DB',
	'NODE_ENV', 'PROCESS_MODE', 'MAILER_ENABLED',
	'storeplainindev_yesimsure', 'HOME', 'PWD',
]);

// ---------------------------------------------------------------------------
// Three-tier merge
// ---------------------------------------------------------------------------

function buildMergedCache(dbRows) {
	var defaults = getDefaults();
	var merged = {};
	var sources = {};

	// Phase 1: defaults
	for (var key in defaults) {
		merged[key] = defaults[key];
		sources[key] = 'default';
	}

	// Phase 2: DB values overlay defaults
	if (dbRows) {
		for (var row of dbRows) {
			if (row.key && row.value !== null && row.value !== undefined) {
				merged[row.key] = row.value;
				sources[row.key] = 'db';
			}
		}
	}

	// Phase 3: .env overlays everything (for keys that exist in process.env)
	// This includes bootstrap keys and any operational key the sysop sets in .env
	var envOverrides = {};
	for (var def of CONFIG_DEFINITIONS) {
		if (process.env[def.key] !== undefined && process.env[def.key] !== '') {
			merged[def.key] = process.env[def.key];
			sources[def.key] = 'env';
			envOverrides[def.key] = true;
		}
	}

	// Also pull in bootstrap keys that aren't in CONFIG_DEFINITIONS
	for (var bk of BOOTSTRAP_KEYS) {
		if (process.env[bk] !== undefined) {
			merged[bk] = process.env[bk];
			sources[bk] = 'env';
		}
	}

	_envKeys = envOverrides;
	return { merged: merged, sources: sources };
}

// ---------------------------------------------------------------------------
// Load / Reload
// ---------------------------------------------------------------------------

/**
 * Initial load — called once at process startup, after dotenv.config()
 * and after postgres.js has created the connection pool.
 *
 * Ensures the settings table exists, seeds defaults for missing keys,
 * then performs the three-tier merge.
 *
 * Throws on failure (process should not start with incomplete config).
 */
async function load() {
	if (_loading) return _loading;

	_loading = (async function () {
		try {
			await configStore.ensureTable();
			await configStore.seedDefaults(CONFIG_DEFINITIONS);
			var dbRows = await configStore.loadAll();
			var result = buildMergedCache(dbRows);
			_cache = result.merged;
			_sources = result.sources;
			_loaded = true;
			alogger.writeAlog(3, "[appConfig] Loaded — " + Object.keys(_cache).length + " keys", "cyan");
		} finally {
			_loading = null;
		}
	})();

	return _loading;
}

/**
 * Reload — re-reads DB tier only (.env and defaults don't change at runtime).
 * Atomically swaps the cache reference.  On failure, keeps previous cache.
 *
 * Called by the CONFIG_CHANGED event subscriber in each process.
 */
async function reload() {
	if (_loading) return _loading;

	_loading = (async function () {
		try {
			var dbRows = await configStore.loadAll();
			var result = buildMergedCache(dbRows);
			_cache = result.merged;      // atomic swap
			_sources = result.sources;
			alogger.writeAlog(3, "[appConfig] Reloaded from DB", "cyan");
		} catch (err) {
			alogger.writeAlog(2, "[appConfig] Reload failed, keeping previous config: " + err.message, "redbright");
		} finally {
			_loading = null;
		}
	})();

	return _loading;
}

// ---------------------------------------------------------------------------
// Synchronous getters
// ---------------------------------------------------------------------------

/**
 * Get a config value as a string.
 * @param {string} key
 * @param {string} [defaultValue] — returned if key is missing or empty
 * @returns {string|undefined}
 */
function get(key, defaultValue) {
	var val = _cache[key];
	if (val !== undefined && val !== null && val !== '') return val;
	return defaultValue;
}

/**
 * Get a config value as a number.
 * @param {string} key
 * @param {number} [defaultValue] — returned if key is missing or NaN
 * @returns {number}
 */
function getNumber(key, defaultValue) {
	var val = _cache[key];
	if (val === undefined || val === null || val === '') return defaultValue;
	var num = parseInt(val, 10);
	return isNaN(num) ? defaultValue : num;
}

/**
 * Get a config value as a boolean.
 * Truthy: 'true', '1', 'yes' (case-insensitive).
 * Falsy:  'false', '0', 'no', '' (case-insensitive).
 * @param {string} key
 * @param {boolean} [defaultValue] — returned if key is missing
 * @returns {boolean}
 */
function getBoolean(key, defaultValue) {
	var val = _cache[key];
	if (val === undefined || val === null) return defaultValue;
	var lower = String(val).toLowerCase().trim();
	if (lower === 'true' || lower === '1' || lower === 'yes') return true;
	if (lower === 'false' || lower === '0' || lower === 'no' || lower === '') return false;
	return defaultValue;
}

/**
 * Get a config value parsed as JSON.
 * @param {string} key
 * @param {*} [defaultValue] — returned if key is missing or parse fails
 * @returns {*}
 */
function getJSON(key, defaultValue) {
	var val = _cache[key];
	if (val === undefined || val === null || val === '') return defaultValue;
	try {
		return JSON.parse(val);
	} catch (_) {
		return defaultValue;
	}
}

/**
 * Get a shallow copy of the entire config cache.
 */
function getAll() {
	var copy = {};
	for (var key in _cache) {
		copy[key] = _cache[key];
	}
	return copy;
}

/**
 * Get all config keys belonging to a category.
 * Returns: { key: value, ... }
 */
function getCategory(category) {
	var result = {};
	for (var def of CONFIG_DEFINITIONS) {
		if (def.category === category) {
			result[def.key] = _cache[def.key];
		}
	}
	return result;
}

/**
 * Get the source of a config value: 'env', 'db', or 'default'.
 * Used by admin UI to show where a value comes from.
 */
function getSource(key) {
	return _sources[key] || 'default';
}

/**
 * Whether the initial load has completed.
 */
function isLoaded() {
	return _loaded;
}

// ---------------------------------------------------------------------------
// Export singleton
// ---------------------------------------------------------------------------

export default {
	load,
	reload,
	get,
	getNumber,
	getBoolean,
	getJSON,
	getAll,
	getCategory,
	getSource,
	isLoaded,
};
