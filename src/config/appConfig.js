/**
 * Centralized configuration singleton.
 *
 * Loads config from three tiers (highest precedence first):
 *   1. .env file     : bootstrap secrets and explicit overrides
 *   2. PostgreSQL    : admin-editable operational values (settings table)
 *   3. Defaults      : hardcoded fallbacks from configDefaults.js
 *
 * Tier 1 is read from the .env FILE, not from process.env.  A parent process
 * can hand this process a stale copy of the environment: pm2 replays the env
 * captured in dump.pm2, and dotenv.config() will not overwrite a key that is
 * already set, so process.env can silently disagree with what is on disk.
 * The file is what the sysop edited, so the file wins, and any disagreement is
 * reported rather than swallowed.  See getEnvDivergence().
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

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as dotenv from 'dotenv';

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
// Built dynamically during load.
var _envKeys = {};

// Parsed contents of the .env file: the authoritative tier-1 source.
var _envFile = {};
var _envFilePath = null;

// Keys where the .env file and this process's ambient environment disagree.
// Populated on every load/reload; surfaced in the log and the admin UI.
var _divergent = [];

// Bootstrap keys that are ONLY read from .env (never from DB).
// These are needed before PostgreSQL is available.
var BOOTSTRAP_KEYS = new Set([
	'dbuser', 'dbhost', 'dbname', 'dbpass', 'dbport',
	'redis_url', 'REDIS_PASSWORD', 'REDIS_BULLMQ_DB',
	'NODE_ENV', 'PROCESS_MODE', 'MAILER_ENABLED',
	'storeplainindev_yesimsure', 'HOME', 'PWD',
]);

// ---------------------------------------------------------------------------
// .env file
// ---------------------------------------------------------------------------

/**
 * Locate and parse the .env file.
 *
 * Resolved relative to this module first (the same trick configDefaults.js
 * uses for package.json) so it does not depend on the process working
 * directory, which pm2 and systemd both set for us.  Falls back to cwd.
 *
 * Returns a plain object; missing or unreadable file yields {}.
 */
function readEnvFile() {
	var candidates = [];
	try {
		candidates.push(join(dirname(fileURLToPath(import.meta.url)), '../../.env'));
	} catch (_) {}
	candidates.push(join(process.cwd(), '.env'));

	for (var candidate of candidates) {
		try {
			if (!existsSync(candidate)) continue;
			var parsed = dotenv.parse(readFileSync(candidate, 'utf8'));
			_envFilePath = candidate;
			return parsed || {};
		} catch (err) {
			alogger.writeAlog(2, "[appConfig] Could not read " + candidate + ": " + err.message, "redbright");
		}
	}

	_envFilePath = null;
	return {};
}

/**
 * Whether a key's value should be hidden in logs and the admin UI.
 */
function isSecretKey(key) {
	var lower = String(key).toLowerCase();
	return lower.indexOf('pass') !== -1 ||
	       lower.indexOf('secret') !== -1 ||
	       lower.indexOf('token') !== -1 ||
	       lower.indexOf('credential') !== -1;
}

/**
 * Log any disagreement between the .env file and the ambient environment.
 *
 * The common cause is pm2: `pm2 save` snapshots the environment into
 * dump.pm2 and replays it on restart, so a .env edit looks like it did
 * nothing.  Saying so explicitly is the whole point of this warning.
 */
function warnOnDivergence() {
	if (!_divergent.length) return;

	for (var d of _divergent) {
		var shown = isSecretKey(d.key)
			? "(values hidden)"
			: 'file="' + d.file + '" running="' + d.ambient + '"';
		alogger.writeAlog(1,
			"[appConfig] " + d.key + " differs from .env: " + shown + ". " +
			(d.bootstrap
				? "Bootstrap key: the running value is kept. Restart with a clean environment to apply the file."
				: "Using the .env file value."),
			"yellowbright", true);
	}

	alogger.writeAlog(1,
		"[appConfig] " + _divergent.length + " key(s) differ between .env and this process's environment. " +
		"This usually means pm2 replayed a saved environment; clear it with " +
		"'pm2 delete all && pm2 start ecosystem.config.cjs && pm2 save'.",
		"yellowbright", true);
}

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

	// Phase 2: DB values overlay defaults (skip null, undefined, and empty strings)
	if (dbRows) {
		for (var row of dbRows) {
			if (row.key && row.value !== null && row.value !== undefined && row.value !== '') {
				merged[row.key] = row.value;
				sources[row.key] = 'db';
			}
		}
	}

	// Phase 3: .env overlays everything.
	//
	// The FILE is the source of truth, not process.env.  See the note at the
	// top of this module.  Ambient env still wins for a key that is absent
	// from the file, so one-off overrides keep working:
	//
	//   in file        -> file value wins (ambient disagreement is reported)
	//   file only      -> file value
	//   ambient only   -> ambient value
	//   neither        -> DB, then default
	var envOverrides = {};
	var divergent = [];

	for (var def of CONFIG_DEFINITIONS) {
		var fileVal    = _envFile[def.key];
		var ambientVal = process.env[def.key];
		var hasFile    = fileVal !== undefined && fileVal !== '';
		var hasAmbient = ambientVal !== undefined && ambientVal !== '';

		if (hasFile && hasAmbient && fileVal !== ambientVal) {
			divergent.push({ key: def.key, file: fileVal, ambient: ambientVal, bootstrap: false });
		}

		if (hasFile) {
			merged[def.key] = fileVal;
			sources[def.key] = 'env';
			envOverrides[def.key] = true;
		} else if (hasAmbient) {
			merged[def.key] = ambientVal;
			sources[def.key] = 'env';
			envOverrides[def.key] = true;
		}
	}

	// Bootstrap keys keep ambient precedence.  They are needed before the file
	// can be located, and setting them on the command line is a documented
	// workflow (PROCESS_MODE=embedded node bin/gateway.js).  A disagreement is
	// still recorded so a stale value is never silent.
	for (var bk of BOOTSTRAP_KEYS) {
		var bFile    = _envFile[bk];
		var bAmbient = process.env[bk];

		if (bFile !== undefined && bAmbient !== undefined && bFile !== bAmbient) {
			divergent.push({ key: bk, file: bFile, ambient: bAmbient, bootstrap: true });
		}

		if (bAmbient !== undefined) {
			merged[bk] = bAmbient;
			sources[bk] = 'env';
		} else if (bFile !== undefined) {
			merged[bk] = bFile;
			sources[bk] = 'env';
		}
	}

	_envKeys = envOverrides;
	_divergent = divergent;
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
			_envFile = readEnvFile();
			await configStore.ensureTable();
			await configStore.seedDefaults(CONFIG_DEFINITIONS);
			var dbRows = await configStore.loadAll();
			var result = buildMergedCache(dbRows);
			_cache = result.merged;
			_sources = result.sources;
			_loaded = true;
			alogger.writeAlog(3, "[appConfig] Loaded: " + Object.keys(_cache).length + " keys" +
				(_envFilePath ? " (.env: " + _envFilePath + ")" : " (no .env file found)"), "cyan");
			warnOnDivergence();
		} finally {
			_loading = null;
		}
	})();

	return _loading;
}

/**
 * Reload: re-reads the .env file and the DB tier, then rebuilds the merge.
 * Atomically swaps the cache reference.  On failure, keeps previous cache.
 *
 * Re-reading the file is what lets a sysop edit .env and apply it without
 * restarting: the admin UI's Reload button publishes CONFIG_CHANGED, and every
 * process lands here.  Keys marked `restart: true` in configDefaults.js still
 * genuinely need a restart: reloading updates the value, not the listener.
 *
 * Called by the CONFIG_CHANGED event subscriber in each process.
 */
async function reload() {
	if (_loading) return _loading;

	_loading = (async function () {
		try {
			_envFile = readEnvFile();
			var dbRows = await configStore.loadAll();
			var result = buildMergedCache(dbRows);
			_cache = result.merged;      // atomic swap
			_sources = result.sources;
			alogger.writeAlog(3, "[appConfig] Reloaded from .env + DB", "cyan");
			warnOnDivergence();
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

/**
 * Keys where the .env file disagrees with the environment this process was
 * started with.  Empty in the normal case.  Secret values are redacted.
 *
 * Returns: [{ key, file, ambient, bootstrap, secret }]
 */
function getEnvDivergence() {
	return _divergent.map(function (d) {
		var secret = isSecretKey(d.key);
		return {
			key: d.key,
			file: secret ? null : d.file,
			ambient: secret ? null : d.ambient,
			bootstrap: !!d.bootstrap,
			secret: secret
		};
	});
}

/**
 * Absolute path of the .env file that was actually read, or null if none.
 */
function getEnvFilePath() {
	return _envFilePath;
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
	getEnvDivergence,
	getEnvFilePath,
};
