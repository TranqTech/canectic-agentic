# Canectic BBS — In-Process Config Singleton: Detailed Implementation Design

## Overview

This document provides a complete implementation plan for the centralized configuration management system. The design replaces scattered `process.env` reads, the nearly-dead `config/system.json`, and hardcoded defaults with a single `appConfig` module backed by three tiers: `.env` (secrets/bootstrap), PostgreSQL (admin-editable operational config), and a defaults file (fallback values).

Cross-process invalidation uses the existing Redis pub/sub event system so that config changes made via the admin UI take effect across all three processes (Gateway, Worker, Mailer) without restart.

---

## 1. Complete Audit of Current Configuration Usage

### 1.1 Every `process.env` Reference

The codebase contains ~75 `process.env` references across ~30 files. Below is the complete inventory, grouped by classification.

#### BOOTSTRAP — Must Stay in .env

These are needed before PostgreSQL is available, or contain secrets that should never be stored in a database.

| Variable | File(s) | Default | Notes |
|---|---|---|---|
| `dbuser` | `postgres.js` | `"canectic"` | DB credentials — chicken-and-egg |
| `dbhost` | `postgres.js` | `"localhost"` | |
| `dbname` | `postgres.js` | `"canectic_bbs"` | |
| `dbpass` | `postgres.js` | (none) | Secret |
| `dbport` | `postgres.js` | `5432` | |
| `redis_url` | `redis.js`, `connection.js` | `"redis://localhost:6379"` | Needed before Redis cache is available |
| `REDIS_PASSWORD` | `connection.js` | (none) | Secret |
| `REDIS_BULLMQ_DB` | `connection.js` | `2` | |
| `NODE_ENV` | `alogger.js`, `webserver.js` | `"development"` | Node.js runtime concern |
| `PROCESS_MODE` | `gateway.js` | `"separate"` | Determines process topology at startup |
| `MAILER_ENABLED` | `gateway.js`, `mailer.js`, `doorserver.js` | `"false"` | Controls whether mailer starts |
| `storeplainindev_yesimsure` | `useraccounts.js` | (none) | Dev-only debug flag, should never be in DB |
| `HOME` | `configvars.js` | OS default | System env, not app config |
| `PWD` | `doorrunner.js` | OS default | System env, not app config |

#### OPERATIONAL — Should Be Hot-Reloadable (PostgreSQL)

These are the values the admin might want to change without restarting processes.

| Variable | File(s) | Type | Default | Category |
|---|---|---|---|---|
| `boardname` | `index.js`, `admin.js`, `pm.js`, `adminLogs.js`, `systeminfo.js`, `echomail.js`, `messages.js`, `qwkPacketBuilder.js`, `qwkTosser.js`, `mailer/session.js`, `configvars.js` | string | `"Canectic BBS"` | system |
| `boardlocation` | `systeminfo.js`, `qwkPacketBuilder.js` | string | `"The Ether"` | system |
| `sysopname` | `dropfile_handler.js`, `syncnet_globals.js`, `qwkPacketBuilder.js`, `mailer/session.js` | string | `"Sysop"` | system |
| `sysopalias` | `dropfile_handler.js` | string | (sysopname) | system |
| `bbsname` | `dropfile_handler.js`, `syncnet_globals.js` | string | `"BBS"` | system |
| `system_name` | `callmanager.js`, `configvars.js` | string | `"Canectic BBS"` | system |
| `boardphone` | `qwkPacketBuilder.js` | string | `"N/A"` | system |
| `currentversion` | `echomail.js`, `messages.js` | string | `"0.1a"` | system |
| `DefaultUser` | `admin.js` | string | `"John Doe"` | system |
| `DefaultAddress` | `echomail.js`, `netmail.js` | string | `"1:1/1"` | network |
| `SYSOP_USERNAME` | `.env` only | string | — | system |
| `webport` | `gateway.js`, `doorserver.js`, `configvars.js` | number | `8080` | network |
| `sitetld` | `index.js`, `admin.js`, `users.js` | string | — | network |
| `sitedomain` | `index.js`, `admin.js` | string | — | network |
| `corsorigin` | `index.js`, `admin.js` | string | — | network |
| `faviconlink` | `index.js`, `admin.js`, `pm.js`, `adminLogs.js` | string | `"/images/favicon.ico"` | display |
| `adminsecurity` | `admin.js`, `pm.js`, `adminLogs.js` | number | `200` | security |
| `defaultsecurity` | `useraccounts.js` | number | `50` | security |
| `session_ttl` | `sessionstore.js`, `redis.js` | number | `3600` | security |
| `sessionexpire` | `sessionStore.js` | number | — | security (legacy, redundant with session_ttl) |
| `cache_ttl` | `redis.js` | number | `3600` | performance |
| `pm_trash_retention_days` | `privateMessages.js`, `jobs.js`, `schedules.js`, `maintenance.js` | number | `30` | maintenance |
| `zones_cache_ttl` | `msgZones.js` | number | `3600` | performance |
| `LOG_BUS_RETENTION_HOURS` | `alogger.js`, `adminLogs.js` | number | `8` | logging |
| `loglevel` | `alogger.js` | number | `3` | logging |
| `logtoconsole` | `alogger.js` | boolean | (falsy) | logging |
| `logeverything` | `alogger.js` | boolean | (falsy) | logging |
| `logfileindev` | `alogger.js` | boolean | (falsy) | logging |
| `defaultlogfile` | `alogger.js` | string | `"system.log"` | logging |
| `theme` | `callmanager.js` | string | `"canectic"` | display |
| `inactivityTO` | `basehandler.js` | number | `60000` | terminal |
| `warnbuff` | `basehandler.js` | number | `10000` | terminal |
| `warnmsg` | `basehandler.js` | string | `"Are you there?"` | terminal |
| `inactivemsg` | `basehandler.js` | string | `"You have been inactive too long"` | terminal |
| `inputTO` | `registrationhandler.js` | number | `20000` | terminal |
| `pwmin` | `registrationhandler.js` | number | `12` | security |
| `minage` | `registrationhandler.js` | number | `13` | security |
| `termNegotiateDelay` | `terminalnegotiator.js` | number | `500` | terminal |
| `termNegotiateMsg` | `terminalnegotiator.js` | string | `"Detecting Terminal..."` | terminal |
| `xtrnTO` | `doorrunner.js` | number | `30000` | doors |
| `doorInactivityTO` | `doorrunner.js`, `syncjsdoor_runner.js` | number | `300000` | doors |
| `syncjsdoorTO` | `syncjsdoor_runner.js` | number | `30000` | doors |
| `doorAuthTO` | `doorauthhandler.js` | number | `15000` | doors |
| `connectTO` | Old handlers only | number | `60000` | terminal (legacy) |
| `allow_netmail_relay` | `ftnNetmailAdapter.js` | boolean | `false` | network |
| `PacketPwd` | `ftnTosser.js` | string | `""` | network |
| `qwk_enabled` | `qwkUser.js`, `index.js` | boolean | `true` | qwk |
| `qwk_bbsid` | `qwkUser.js` | string | `""` | qwk |
| `qwk_max_msgs_per_area` | `qwkUser.js` | number | `500` | qwk |

#### PATHS — Can Go Either Way

File paths are tricky: they're often tied to the machine and set at deploy time. Recommend keeping in `.env` but mirroring into appConfig as read-only for convenience.

| Variable | File(s) | Default | Category |
|---|---|---|---|
| `textdir` | `terminalcommands.js`, `configvars.js` | — | paths |
| `doordir` | `doorrunner.js`, `configvars.js` | `""` | paths |
| `dosemu_drive_c` | `configvars.js` | `"~/.dosemu/drive_c"` | paths |
| `ftninbound` | `ftnTosser.js`, `mailer/session.js`, `mailer/manager.js` | `"ftn/in"` | paths |
| `ftnoutbound` | `ftnTosser.js`, `mailer/session.js`, `mailer/manager.js` | `"ftn/out"` | paths |
| `ftntossed` | `ftnTosser.js` | `"ftn/tossed"` | paths |
| `ftnbad` | `ftnNetmailAdapter.js` | `"ftn/bad"` | paths |
| `installdir` | Old handlers only | — | paths (legacy) |

#### MAILER-SPECIFIC — Operational but Mailer-Process Only

| Variable | File(s) | Type | Default | Category |
|---|---|---|---|---|
| `MAILER_BINKP_PORT` | `mailer/manager.js` | number | `24554` | mailer |
| `MAILER_MAX_SESSIONS` | `mailer/manager.js` | number | `10` | mailer |
| `MAILER_CONNECT_TIMEOUT` | `mailer/manager.js` | number (sec) | `30` | mailer |
| `MAILER_POLL_INTERVAL` | `mailer/manager.js` | number (sec) | `900` | mailer |
| `MAILER_SESSION_TIMEOUT` | `mailer/session.js` | number (sec) | `300` | mailer |
| `MAILER_INBOUND_DIR` | `mailer/manager.js`, `mailer/session.js` | string | (ftninbound) | mailer |
| `MAILER_OUTBOUND_DIR` | `mailer/manager.js`, `mailer/session.js` | string | (ftnoutbound) | mailer |
| `MAILER_TEMP_DIR` | `mailer/manager.js`, `mailer/session.js` | string | `"ftn/tmp"` | mailer |
| `MAILER_WS_PORT` | `mailer.js` | number | `24555` | mailer |
| `WORKER_CONCURRENCY` | `worker.js` | number | `3` | worker |

### 1.2 system.json Usage

`config/system.json` is consumed **only** in `callmanager.js` method `loadConfigs()`, which reads it at startup and stores it as `this.config`. The fields used are:

```json
{
    "board_name": "Example BBS",
    "board_location": "Calgary, AB",
    "theme": "canectic",
    "pw_min": 6,
    "login_TO": 30,
    "logon_TO": 60
}
```

These overlap with `process.env.boardname`, `process.env.boardlocation`, `process.env.theme`, `process.env.pwmin`, etc. The system.json values are loaded but many are shadowed by env vars elsewhere. This is effectively dead config for most purposes. **Recommendation: absorb all system.json values into the DB tier, then deprecate the file.**

### 1.3 Theme Configuration

Theme files (`config/themes/canectic.json`) define ANSI color mappings for terminal display. These are loaded by `callmanager.js` method `loadTheme()` at startup. Themes are display-only config that applies to the terminal side. **Recommendation: keep themes as JSON files for now.** They're a separate concern from operational config (they're essentially asset files, not settings). A future theme-editor admin page could move them to the DB, but that's a different initiative.

---

## 2. Detailed Module Design

### 2.1 `src/config/appConfig.js` — The Singleton

#### Design Philosophy

The singleton is a plain JS object cache with async initialization and getter functions that return synchronous reads from the cache. This solves the core tension: Express middleware and terminal handlers need synchronous config access, but loading from PostgreSQL is inherently async.

**The key insight: load once (async), then read many times (sync).** Reload replaces the entire cache object atomically (single reference swap), so reads never see a partially-updated state.

#### Internal State

```
var _cache = {};         // The merged config object. Flat key-value.
var _loaded = false;     // Whether initial load has completed
var _loading = null;     // Promise for in-flight load (deduplication)
```

#### API Surface

```javascript
// --- Initialization (async, called once at process startup) ---

await appConfig.load()
// Performs the three-tier merge:
//   1. Read configDefaults (all defaults as a flat object)
//   2. Read all rows from config_settings table (PostgreSQL)
//   3. Read process.env for bootstrap + path variables
// Merge order: defaults < DB < .env (highest precedence)
// After merge, _cache is a plain object, _loaded = true.
// Returns: void. Throws on DB connection failure during initial load.

await appConfig.reload()
// Re-reads DB tier only (defaults and .env don't change at runtime).
// Merges fresh DB values over defaults, then overlays .env.
// Atomically swaps _cache reference. Safe during concurrent reads.
// Returns: void. On failure, keeps previous _cache (log + continue).

// --- Synchronous Getters (used everywhere after load) ---

appConfig.get(key)
// Returns the string value for key, or undefined if not found.
// Key format: flat string, e.g. 'boardname', 'adminsecurity'

appConfig.get(key, defaultValue)
// Returns value or defaultValue if key is missing.

appConfig.getNumber(key, defaultValue)
// Returns parseInt(value) || defaultValue. Handles NaN.

appConfig.getBoolean(key, defaultValue)
// Returns true for 'true', '1', 'yes' (case-insensitive).
// Returns false for 'false', '0', 'no', ''.
// Returns defaultValue for undefined/null.

appConfig.getJSON(key, defaultValue)
// JSON.parse(value), returns defaultValue on parse error or missing.
// For config values that are JSON arrays (permission flags etc.)

appConfig.getAll()
// Returns a shallow copy of the entire _cache object.
// Used by admin UI to display all config values.

appConfig.getCategory(category)
// Returns an object of key-value pairs where keys belong to the
// given category (looked up from configDefaults metadata).
// Used by admin UI to organize settings by section.

appConfig.isLoaded()
// Returns _loaded boolean. For guard checks during early startup.
```

#### Three-Tier Merge at Startup

```
Phase 1: Start with configDefaults (all known keys with default values)
Phase 2: Query config_settings table, overlay DB values onto defaults
Phase 3: Overlay .env values for bootstrap keys and any explicit overrides

Result: _cache = { ...defaults, ...dbValues, ...envOverrides }
```

**Precedence: .env wins over DB wins over defaults.** This means:
- A sysop can always override via .env if the DB has a bad value
- DB is the normal operational store for admin-editable values
- Defaults ensure every key has a sane value even on first run

#### Chicken-and-Egg: PostgreSQL Not Available at Early Startup

The DB credentials (`dbuser`, `dbhost`, `dbname`, `dbpass`, `dbport`) **must** come from `.env` because they're needed to connect to PostgreSQL in the first place. The `postgres.js` module reads them at import time (module-level `const`), which happens before `appConfig.load()` could run.

**Solution: `appConfig.load()` is called _after_ `dotenv.config()` and after the first import of `postgres.js`.** The DB connection pool is already initialized by the time `appConfig.load()` queries `config_settings`. The bootstrap variables remain read from `process.env` directly by the modules that need them (`postgres.js`, `redis.js`, `connection.js`). They are also copied into the cache for reference (admin UI can display them as read-only).

Startup order in each process:

```
1. dotenv.config()                    — populates process.env
2. import postgres.js (side effect)   — creates pgpool from process.env
3. import redis.js (side effect)      — creates redis client from process.env
4. await appConfig.load()             — queries DB, merges three tiers
5. ... rest of startup ...
```

If PostgreSQL is unreachable during `load()`, the initial load **throws** (process should not start with incomplete config). This matches the existing behavior — if the DB is down, nothing works anyway.

#### Race Conditions During Reload

Reload is triggered by a pub/sub event (another process changed config via admin UI). The risk: a read happens while the cache is being rebuilt.

**Solution: atomic reference swap.** `reload()` builds the new cache into a local variable, then assigns it to `_cache` in a single statement. JavaScript's single-threaded event loop guarantees that no read can interleave with this assignment. There is no partial state.

```javascript
async function reload() {
    try {
        var fresh = buildMergedCache(await loadFromDB());
        _cache = fresh;  // atomic swap
        alogger.writeAlog(3, "[appConfig] Reloaded from DB", "cyan");
    } catch (err) {
        // Keep old cache on failure
        alogger.writeAlog(2, "[appConfig] Reload failed, keeping previous config: " + err.message, "redbright");
    }
}
```

**Deduplication:** If multiple reload events arrive in rapid succession (e.g., admin saves multiple settings quickly), use a simple debounce. Set `_loading` to the active promise; if a reload is called while one is in-flight, return the existing promise.

#### Sync vs Async

- `load()` and `reload()` are **async** (DB reads are async)
- All getters (`get`, `getNumber`, `getBoolean`, `getJSON`, `getAll`, `getCategory`) are **synchronous** (read from in-memory cache)
- This is critical: Express middleware, Pug template rendering, and terminal handler constructors all execute synchronously and need config values inline

#### Module Export Shape

```javascript
// ES module default export (singleton pattern)
export default {
    load,
    reload,
    get,
    getNumber,
    getBoolean,
    getJSON,
    getAll,
    getCategory,
    isLoaded
};
```

Import pattern: `import appConfig from '../config/appConfig.js';`

### 2.2 `src/config/configDefaults.js` — Default Values

#### Structure

Flat key-value object with metadata. Each entry has a `key`, `defaultValue`, `type`, `category`, and `description`. The flat key matches what's stored in the DB and what `.env` uses.

```javascript
var CONFIG_DEFINITIONS = [
    // --- System ---
    { key: 'boardname',         defaultValue: 'Canectic BBS',    type: 'string',  category: 'system',      description: 'BBS name displayed in nav, origin lines, mailer handshake' },
    { key: 'boardlocation',     defaultValue: 'The Ether',       type: 'string',  category: 'system',      description: 'BBS location for system info and QWK headers' },
    { key: 'sysopname',         defaultValue: 'Sysop',           type: 'string',  category: 'system',      description: 'Sysop real name for drop files and QWK headers' },
    { key: 'sysopalias',        defaultValue: '',                 type: 'string',  category: 'system',      description: 'Sysop alias for drop files (falls back to sysopname)' },
    { key: 'bbsname',           defaultValue: 'BBS',             type: 'string',  category: 'system',      description: 'Short BBS name for drop files and Synchronet shims' },
    { key: 'system_name',       defaultValue: 'Canectic BBS',    type: 'string',  category: 'system',      description: 'System name for login handler title' },
    { key: 'boardphone',        defaultValue: 'N/A',             type: 'string',  category: 'system',      description: 'BBS phone number for QWK control.dat' },
    { key: 'currentversion',    defaultValue: '0.1a',            type: 'string',  category: 'system',      description: 'Software version for message tearlines' },
    { key: 'DefaultUser',       defaultValue: 'John Doe',        type: 'string',  category: 'system',      description: 'Default poster name (legacy)' },
    { key: 'SYSOP_USERNAME',    defaultValue: '',                 type: 'string',  category: 'system',      description: 'Sysop username for PM system' },

    // --- Network ---
    { key: 'webport',           defaultValue: '8080',            type: 'number',  category: 'network',     description: 'HTTP server port' },
    { key: 'sitetld',           defaultValue: '',                 type: 'string',  category: 'network',     description: 'Cookie domain (e.g. example.com)' },
    { key: 'sitedomain',        defaultValue: '',                 type: 'string',  category: 'network',     description: 'Full domain for URL generation' },
    { key: 'corsorigin',        defaultValue: '',                 type: 'string',  category: 'network',     description: 'CORS allowed origin' },
    { key: 'DefaultAddress',    defaultValue: '1:1/1',           type: 'string',  category: 'network',     description: 'Default FTN address for echomail/netmail' },
    { key: 'allow_netmail_relay', defaultValue: 'false',         type: 'boolean', category: 'network',     description: 'Allow FTN netmail relay through this system' },
    { key: 'PacketPwd',         defaultValue: '',                 type: 'string',  category: 'network',     description: 'Default FTN packet password' },

    // --- Display ---
    { key: 'faviconlink',       defaultValue: '/images/favicon.ico', type: 'string', category: 'display',  description: 'Favicon path for web UI' },
    { key: 'theme',             defaultValue: 'canectic',        type: 'string',  category: 'display',     description: 'Terminal color theme name' },

    // --- Security ---
    { key: 'adminsecurity',     defaultValue: '200',             type: 'number',  category: 'security',    description: 'Minimum security level for admin access' },
    { key: 'defaultsecurity',   defaultValue: '50',              type: 'number',  category: 'security',    description: 'Security level for new user accounts' },
    { key: 'session_ttl',       defaultValue: '3600',            type: 'number',  category: 'security',    description: 'Redis session TTL in seconds' },
    { key: 'pwmin',             defaultValue: '12',              type: 'number',  category: 'security',    description: 'Minimum password length' },
    { key: 'minage',            defaultValue: '13',              type: 'number',  category: 'security',    description: 'Minimum registration age' },

    // --- Performance ---
    { key: 'cache_ttl',         defaultValue: '3600',            type: 'number',  category: 'performance', description: 'Redis cache TTL in seconds' },
    { key: 'zones_cache_ttl',   defaultValue: '3600',            type: 'number',  category: 'performance', description: 'FTN zone list cache TTL in seconds' },

    // --- Maintenance ---
    { key: 'pm_trash_retention_days', defaultValue: '30',        type: 'number',  category: 'maintenance', description: 'Days before hard-deleting trashed PMs' },

    // --- Logging ---
    { key: 'loglevel',          defaultValue: '3',               type: 'number',  category: 'logging',     description: 'Log verbosity (0=critical, 5=trace)' },
    { key: 'logtoconsole',      defaultValue: '',                type: 'boolean', category: 'logging',     description: 'Force console output in production' },
    { key: 'logeverything',     defaultValue: '',                type: 'boolean', category: 'logging',     description: 'Log all levels in development' },
    { key: 'logfileindev',      defaultValue: '',                type: 'boolean', category: 'logging',     description: 'Write log files in development mode' },
    { key: 'defaultlogfile',    defaultValue: 'system.log',      type: 'string',  category: 'logging',     description: 'Default log filename' },
    { key: 'LOG_BUS_RETENTION_HOURS', defaultValue: '8',         type: 'number',  category: 'logging',     description: 'Hours to retain log bus history in Redis' },

    // --- Terminal ---
    { key: 'inactivityTO',      defaultValue: '60000',           type: 'number',  category: 'terminal',    description: 'Terminal inactivity timeout (ms)' },
    { key: 'warnbuff',          defaultValue: '10000',           type: 'number',  category: 'terminal',    description: 'Warning buffer before timeout (ms)' },
    { key: 'warnmsg',           defaultValue: 'Are you there?',  type: 'string',  category: 'terminal',    description: 'Inactivity warning message' },
    { key: 'inactivemsg',       defaultValue: 'You have been inactive too long', type: 'string', category: 'terminal', description: 'Inactivity disconnect message' },
    { key: 'inputTO',           defaultValue: '20000',           type: 'number',  category: 'terminal',    description: 'Input field timeout (ms)' },
    { key: 'termNegotiateDelay', defaultValue: '500',            type: 'number',  category: 'terminal',    description: 'Terminal negotiation delay (ms)' },
    { key: 'termNegotiateMsg',  defaultValue: 'Detecting Terminal...\r\n', type: 'string', category: 'terminal', description: 'Terminal negotiation message' },

    // --- Doors ---
    { key: 'xtrnTO',            defaultValue: '30000',           type: 'number',  category: 'doors',       description: 'Door launch timeout (ms)' },
    { key: 'doorInactivityTO',  defaultValue: '300000',          type: 'number',  category: 'doors',       description: 'Door inactivity timeout (ms)' },
    { key: 'syncjsdoorTO',      defaultValue: '30000',           type: 'number',  category: 'doors',       description: 'SyncJS door launch timeout (ms)' },
    { key: 'doorAuthTO',        defaultValue: '15000',           type: 'number',  category: 'doors',       description: 'Door auth timeout (ms)' },

    // --- Paths ---
    { key: 'textdir',           defaultValue: '',                 type: 'string',  category: 'paths',       description: 'Text/art file directory' },
    { key: 'doordir',           defaultValue: '',                 type: 'string',  category: 'paths',       description: 'Door game base directory' },
    { key: 'dosemu_drive_c',    defaultValue: '',                 type: 'string',  category: 'paths',       description: 'DOSemu virtual drive C path' },
    { key: 'ftninbound',        defaultValue: 'ftn/in',          type: 'string',  category: 'paths',       description: 'FTN inbound packet directory' },
    { key: 'ftnoutbound',       defaultValue: 'ftn/out',         type: 'string',  category: 'paths',       description: 'FTN outbound packet directory' },
    { key: 'ftntossed',         defaultValue: 'ftn/tossed',      type: 'string',  category: 'paths',       description: 'FTN tossed (processed) packet directory' },
    { key: 'ftnbad',            defaultValue: 'ftn/bad',         type: 'string',  category: 'paths',       description: 'FTN bad packet directory' },

    // --- Mailer ---
    { key: 'MAILER_BINKP_PORT',      defaultValue: '24554',     type: 'number',  category: 'mailer',      description: 'Binkp TCP listener port' },
    { key: 'MAILER_WS_PORT',         defaultValue: '24555',     type: 'number',  category: 'mailer',      description: 'Mailer WebSocket listener port' },
    { key: 'MAILER_MAX_SESSIONS',     defaultValue: '10',       type: 'number',  category: 'mailer',      description: 'Maximum concurrent mailer sessions' },
    { key: 'MAILER_CONNECT_TIMEOUT',  defaultValue: '30',       type: 'number',  category: 'mailer',      description: 'Mailer connect timeout (seconds)' },
    { key: 'MAILER_POLL_INTERVAL',    defaultValue: '900',      type: 'number',  category: 'mailer',      description: 'Default mailer poll interval (seconds)' },
    { key: 'MAILER_SESSION_TIMEOUT',  defaultValue: '300',      type: 'number',  category: 'mailer',      description: 'Mailer session timeout (seconds)' },
    { key: 'MAILER_INBOUND_DIR',      defaultValue: '',         type: 'string',  category: 'mailer',      description: 'Mailer inbound directory (overrides ftninbound)' },
    { key: 'MAILER_OUTBOUND_DIR',     defaultValue: '',         type: 'string',  category: 'mailer',      description: 'Mailer outbound directory (overrides ftnoutbound)' },
    { key: 'MAILER_TEMP_DIR',         defaultValue: 'ftn/tmp',  type: 'string',  category: 'mailer',      description: 'Mailer temp directory' },

    // --- Worker ---
    { key: 'WORKER_CONCURRENCY',      defaultValue: '3',        type: 'number',  category: 'worker',      description: 'Toss queue concurrency' },
];
```

#### Exports

```javascript
export var CONFIG_DEFINITIONS;      // The full definitions array (for admin UI metadata)
export function getDefaults();      // Returns { key: defaultValue } flat object
export function getDefinition(key); // Returns the definition object for a key, or null
export function getCategories();    // Returns array of distinct category strings
```

#### How Defaults Relate to DB `category` Field

The `category` in `CONFIG_DEFINITIONS` maps 1:1 to the `category` column in the `config_settings` DB table. When a value is inserted into the DB (via admin UI or seed script), it gets the category from the definitions. The admin UI uses categories to group settings into tabs or accordion sections.

### 2.3 `src/models/configStore.js` — PostgreSQL CRUD

#### Table Schema: `config_settings`

The existing `settings` table schema (`db/schema/tablecolumns/settings.conf`) has `name` and `value` columns but lacks `category`, `description`, and `type`. **Recommendation: extend the schema.**

New `settings.conf`:

```
id BIGSERIAL PRIMARY KEY
key VARCHAR(255) UNIQUE NOT NULL
value TEXT
type VARCHAR(32) DEFAULT 'string'
category VARCHAR(64) DEFAULT 'system'
description TEXT
readonly BOOLEAN DEFAULT false
created_at TIMESTAMPTZ DEFAULT NOW()
updated_at TIMESTAMPTZ DEFAULT NOW()
```

Changes from existing:
- `name` renamed to `key` (clearer semantics, avoids SQL reserved word proximity)
- `value` widened from `VARCHAR(255)` to `TEXT` (JSON arrays, long paths)
- Added `type`, `category`, `description`, `readonly`
- Added `UNIQUE` constraint on `key`
- Added `updated_at` for admin audit trail

**Migration note:** The existing `settings` table appears unused (the model file `src/models/settings.js` is a single-line comment stub). The migration should `DROP TABLE IF EXISTS settings` and recreate, or `ALTER TABLE` if there's any concern about existing data. Given the stub state, a clean recreation is safe.

#### CRUD Functions

```javascript
// --- Bulk read (used by appConfig.load/reload) ---

async function loadAll()
// SELECT key, value FROM settings ORDER BY key
// Returns: array of { key, value } rows
// Single query, no N+1 problem

async function loadAllWithMeta()
// SELECT * FROM settings ORDER BY category, key
// Returns: full rows with type, category, description, readonly
// Used by admin UI

// --- Single-key operations (used by admin UI) ---

async function getValue(key)
// SELECT value FROM settings WHERE key = $1
// Returns: string value or null

async function setValue(key, value)
// UPSERT: INSERT ... ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()
// After write: publish invalidation event
// Returns: boolean success

async function setValues(kvArray)
// Batch upsert using a transaction
// kvArray: [{ key, value }, ...]
// After write: publish single invalidation event
// Returns: boolean success

async function deleteSetting(key)
// DELETE FROM settings WHERE key = $1
// After write: publish invalidation event
// Returns: boolean success

// --- Metadata operations (admin UI) ---

async function getByCategory(category)
// SELECT * FROM settings WHERE category = $1 ORDER BY key

async function seedDefaults(definitions)
// INSERT each definition where key doesn't already exist
// Preserves admin-customized values, fills in new keys on upgrade
// Called during appConfig.load() on first run or schema upgrade

// --- Invalidation trigger ---

async function publishInvalidation()
// Uses the existing events.js publisher to fire CONFIG_CHANGED event
// All processes receive this and call appConfig.reload()
```

#### How Updates Trigger Pub/Sub

`configStore.setValue()` and `configStore.setValues()` call `publishInvalidation()` after a successful write. This function uses the existing `createEventPublisher()` from `events.js` to publish a `CONFIG_CHANGED` event. All processes subscribed to the event channel receive it and call `appConfig.reload()`.

**Important:** The configStore should maintain a single cached publisher instance (created on first use) rather than creating one per write. This matches the pattern in `bin/worker.js` and `bin/mailer.js` where a single publisher is created at startup.

### 2.4 Admin UI Considerations (High-Level)

#### Route Structure

```
GET  /admin/config           — Config settings page (all categories)
POST /admin/config           — Update one or more settings
POST /admin/config/reset/:key — Reset a setting to its default value
```

Mounted as additional routes in `src/routes/admin.js` (or a new `src/routes/adminConfig.js` if the admin router is getting too large).

#### How Categories Organize the View

The admin config page uses a tabbed or accordion layout with one section per category. Categories are derived from `configDefaults.getCategories()`. Each section displays a table or form with:

- **Key** — the setting name
- **Value** — editable input (type-appropriate: text, number, checkbox for boolean)
- **Default** — shown as placeholder or reference text
- **Description** — help text from the definition
- **Source indicator** — badge showing "Default", "Database", or "Environment" to indicate where the current value comes from

#### Read-Only Display for .env Values

Bootstrap keys (DB credentials, Redis URL, NODE_ENV, PROCESS_MODE, MAILER_ENABLED) are displayed in a "Bootstrap / Environment" section with:
- Values shown but inputs disabled
- A note: "These values come from .env and cannot be changed via the admin panel"
- The `readonly` column in the DB marks these; the admin POST route rejects writes to readonly keys

#### Pattern Consistency

Follows the existing modal-driven CRUD pattern. For config, a simpler inline-edit table may be more appropriate than modals (each setting is a single row with an input field, no complex multi-field forms). A "Save Changes" button at the bottom of each category section submits all changed values in one POST.

---

## 3. Integration Points

### 3.1 Process Initialization

Each of the three processes needs the same initialization pattern. The key addition is `await appConfig.load()` early in startup, and subscribing to the `CONFIG_CHANGED` event.

#### `bin/gateway.js`

```
dotenv.config();                          // existing
alogger.setProcessName('gateway');        // existing
await appConfig.load();                   // NEW — after dotenv, before everything else
...
// In the event subscriber setup (already exists):
var eventSubscriber = createEventSubscriber((event) => {
    if (event.type === EVENTS.MESSAGES_IMPORTED) { ... }  // existing
    if (event.type === EVENTS.PM_DELIVERED) { ... }       // existing
    if (event.type === EVENTS.CONFIG_CHANGED) {           // NEW
        appConfig.reload();
    }
});
```

#### `bin/worker.js`

```
dotenv.config();                          // existing
alogger.setProcessName('worker');         // existing
await appConfig.load();                   // NEW
...
// Worker currently creates an event publisher but no subscriber.
// Add a subscriber for CONFIG_CHANGED:
var eventSubscriber = createEventSubscriber((event) => {
    if (event.type === EVENTS.CONFIG_CHANGED) {
        appConfig.reload();
    }
});
```

#### `bin/mailer.js`

Same pattern as worker — add `appConfig.load()` and a CONFIG_CHANGED subscriber.

### 3.2 Pub/Sub Event Flow

#### Changes to `src/queues/events.js`

Add one new event constant:

```javascript
export const EVENTS = {
    MESSAGES_IMPORTED: 'messages:imported',
    PM_DELIVERED: 'pm:delivered',
    TOSS_COMPLETE: 'toss:complete',
    MAILER_SESSION_START: 'mailer:session:start',
    MAILER_SESSION_END: 'mailer:session:end',
    MAILER_TRANSFER_PROGRESS: 'mailer:transfer:progress',
    CONFIG_CHANGED: 'config:changed',         // NEW
};
```

No other changes needed to `events.js`. The existing pub/sub infrastructure handles it.

#### Event Flow

```
Admin saves config in web UI
  → POST /admin/config route calls configStore.setValue(key, value)
    → configStore writes to PostgreSQL
    → configStore calls publishInvalidation()
      → publishes { type: 'config:changed', data: { keys: ['boardname'] } }
        → Gateway event subscriber receives it → appConfig.reload()
        → Worker event subscriber receives it → appConfig.reload()
        → Mailer event subscriber receives it → appConfig.reload()
```

The Gateway (which hosts the admin UI) also reloads its own config via the same pub/sub event, which means the publishing process also reloads. This is correct — the admin route handler writes to the DB, the pub/sub fires, and the gateway's own subscriber triggers a reload from DB. This ensures all processes converge on the same state.

### 3.3 Express Route Middleware Access

Currently, each router's shared middleware sets template locals from `process.env`:

```javascript
// Current pattern in index.js, admin.js, pm.js, adminLogs.js:
res.locals.boardname = process.env.boardname;
res.locals.faviconlink = process.env.faviconlink || "/images/favicon.ico";
```

**Migration target:**

```javascript
import appConfig from '../config/appConfig.js';

// In the shared middleware:
res.locals.boardname = appConfig.get('boardname');
res.locals.faviconlink = appConfig.get('faviconlink');
```

This is a drop-in replacement. The getters are synchronous, so no async changes are needed in middleware.

For module-level constants like `const adminsecurity = parseInt(process.env.adminsecurity) || 200`, the migration changes to calling the getter at point of use rather than caching at module load:

```javascript
// Before (module-level const, never updates):
const adminsecurity = parseInt(process.env.adminsecurity) || 200;

// After (read at point of use, picks up reloaded values):
// In the route handler:
var adminsecurity = appConfig.getNumber('adminsecurity', 200);
```

This is the most impactful migration pattern — moving from module-level constants to point-of-use reads. It must be done for every operational config variable to get hot-reload benefits.

### 3.4 Terminal Handler Access

Terminal handlers read config at construction time (module-level `const`) or in their constructors:

```javascript
// Current:
const defaultInactivityTO = Number(process.env.inactivityTO) || 60000;

// After:
import appConfig from '../config/appConfig.js';
// In constructor or method (not module-level):
this.inactivityTO = appConfig.getNumber('inactivityTO', 60000);
```

For handlers like `BaseHandler` that set timeouts in their constructor, the value is read once per call (per user session). This is acceptable — a config change takes effect on the next new session, not mid-session. This is actually desirable behavior for timeout values.

For `configvars.js`, the `resolve()` functions already use closures that read `process.env` at call time. Migration is straightforward:

```javascript
// Current:
resolve: () => process.env.boardname || ''

// After:
resolve: () => appConfig.get('boardname', '')
```

### 3.5 Tosser Access

Tossers read config at module level:

```javascript
// Current (ftnTosser.js):
const defaultInbound = process.env.ftninbound || "ftn/in"

// After:
import appConfig from '../config/appConfig.js';
// In function scope, not module level:
var inboundDir = appConfig.get('ftninbound', 'ftn/in');
```

Since tossers run in the Worker process, they'll pick up reloaded config on the next toss cycle. FTN path changes taking effect on the next toss rather than mid-toss is correct behavior.

---

## 4. Migration Strategy

### 4.1 Order of Operations

The migration is designed to be incremental. Each phase is independently valuable and can be shipped and tested before proceeding.

**Phase 0: Infrastructure (no consumer changes)**
1. Create `src/config/configDefaults.js` with the full definitions table
2. Create `src/models/configStore.js` with DB CRUD and invalidation
3. Create `src/config/appConfig.js` singleton with load/reload/getters
4. Extend the `settings` table schema (migration or recreate)
5. Add `CONFIG_CHANGED` to `events.js`
6. Add `appConfig.load()` and CONFIG_CHANGED subscriber to all three bin files
7. Run seed to populate `config_settings` from defaults

At this point, `appConfig` is loaded and available but nothing reads from it yet. All existing `process.env` reads continue to work.

**Phase 1: Route middleware (highest visibility, lowest risk)**
1. Migrate `res.locals.boardname`, `res.locals.faviconlink` in all four routers
2. Migrate `adminsecurity` in `admin.js`, `pm.js`, `adminLogs.js`
3. Migrate `sitetld`, `sitedomain`, `corsorigin` in route files

These are the most-duplicated values (boardname appears in 11 files). Immediate deduplication win.

**Phase 2: Models and tossers**
1. Migrate `echomail.js`, `messages.js` (boardname, DefaultAddress, currentversion)
2. Migrate `ftnTosser.js` (paths)
3. Migrate `qwkPacketBuilder.js`, `qwkTosser.js` (boardname, sysopname, etc.) — `qwkUser.js` already uses `appConfig`
4. Migrate `privateMessages.js`, `jobs.js`, `schedules.js` (pm_trash_retention_days)
5. Migrate `useraccounts.js` (defaultsecurity)

**Phase 3: Terminal handlers**
1. Migrate `basehandler.js` (timeout config)
2. Migrate `registrationhandler.js` (pwmin, minage)
3. Migrate `doorrunner.js`, `syncjsdoor_runner.js`, `doorauthhandler.js` (door timeouts)
4. Migrate `terminalnegotiator.js`
5. Migrate `callmanager.js` (theme, system_name) — also deprecate system.json load
6. Migrate `dropfile_handler.js` (bbsname, sysopname, sysopalias)
7. Migrate `configvars.js` resolve functions

**Phase 4: Infrastructure modules (careful — bootstrap dependencies)**
1. Migrate `alogger.js` (loglevel, log flags) — note: alogger is imported before appConfig.load(), so these must use a hybrid approach (initial value from .env, then pick up reloaded values via getter)
2. Migrate `mailer/manager.js`, `mailer/session.js`
3. Migrate `systeminfo.js`
4. Migrate `syncnet_globals.js`

**Phase 5: Admin UI**
1. Build the `/admin/config` route and view
2. Wire up inline editing with category tabs
3. Add read-only display for bootstrap/.env values

**Phase 6: Cleanup**
1. Remove `config/system.json` (after callmanager migration)
2. Remove `src/models/settings.js` stub
3. Remove redundant `dotenv.config()` calls from models/handlers (they can stay, they're harmless, but tidying is nice)
4. Update `.env.example` to only contain bootstrap variables
5. Archive this design doc into the main architecture docs

### 4.2 Coexistence During Migration

**Yes, old `process.env` reads and new `appConfig.get()` can coexist safely.** During the migration:

- `appConfig.load()` copies .env values into the cache
- Unmigrated code continues reading `process.env` directly (unchanged behavior)
- Migrated code reads `appConfig.get()` (which returns the same value, from the same .env source, until DB values are populated)
- Once the admin UI is built and values are stored in the DB, the DB values start taking precedence for migrated code
- Unmigrated code still reads .env (unchanged, but now potentially out of sync with DB — this is acceptable during migration because the DB values will match .env initially)

This means the migration can proceed file-by-file with no "big bang" cutover.

### 4.3 Minimal Viable First Step

The smallest useful increment is Phase 0 + migrating `boardname` in all route files. This proves the entire pipeline (DB storage, pub/sub invalidation, singleton reload) with the single most-duplicated config value. An admin can change the BBS name from the web UI and see it update across all processes without restart.

---

## 5. Edge Cases and Failure Modes

### 5.1 PostgreSQL Unreachable During Reload

`appConfig.reload()` catches the error, logs it, and keeps the previous `_cache` intact. The system continues operating with stale config. The next reload attempt (triggered by another config change, or a periodic refresh if one is added) will succeed when the DB comes back.

This is the correct behavior: config is cached in-memory and only refreshed on change. A temporary DB outage doesn't affect running operations.

### 5.2 Key Exists in Both .env and DB — Precedence

**.env always wins.** The merge order is: defaults < DB < .env. This means:

- If a sysop sets `boardname=TestBBS` in `.env` AND sets boardname to "Production BBS" in the admin UI, the value will be "TestBBS"
- The admin UI should indicate when a value is being overridden by .env (show the .env value and a note like "Overridden by environment variable")
- This is a safety feature: if the admin puts a bad value in the DB, the sysop can always fix it via .env

**Detection:** `appConfig.getSource(key)` could return `'env'`, `'db'`, or `'default'` to indicate where the active value came from. Useful for admin UI display.

### 5.3 Config Values That Are JSON Arrays

Example: permission flags stored as `["Sysop", "Mod"]`. The `value` column in `config_settings` is `TEXT`, so it stores the JSON string. `appConfig.getJSON(key, defaultValue)` parses it.

However, the current codebase does not store permission flags as config values — they're per-area/per-user/per-group settings stored in their respective tables. If a future need arises for JSON config values (e.g., a list of blocked email domains for registration), the `getJSON()` method handles it. The `type` field in the DB can be set to `'json'` for these, and the admin UI can provide a textarea rather than a single-line input.

### 5.4 system.json — Absorption or Coexistence

**Absorption.** The values in `system.json` should be seeded into `config_settings` during Phase 0, then the file deprecated.

Mapping:
| system.json key | config_settings key |
|---|---|
| `board_name` | `boardname` |
| `board_location` | `boardlocation` |
| `theme` | `theme` |
| `pw_min` | `pwmin` |
| `login_TO` | (maps to `inactivityTO` or new key) |
| `logon_TO` | (maps to `connectTO` or new key) |

The `callmanager.js` `loadConfigs()` method should be migrated to read from `appConfig` instead. The `loadTheme()` method continues reading JSON theme files (themes are asset files, not config — see Section 1.3).

Once all system.json consumers are migrated, the file can be removed and `config/` simplified.

### 5.5 CLI Tools (`src/tools/tosser.js`, `src/tools/maintenance.js`)

CLI tools are short-lived processes that enqueue jobs and exit. They need config for:
- Redis connection parameters (to create BullMQ queues) — from `.env`
- Possibly `pm_trash_retention_days` for the maintenance CLI — from `.env` currently

**Recommendation: CLI tools do NOT need appConfig.** They don't serve requests, don't need hot-reload, and exit quickly. They should continue reading `.env` directly for the few values they need. The actual work happens in the Worker process (which does have appConfig loaded).

The one exception is if a CLI tool needs a config value that only exists in the DB (not in .env). In that case, the tool can call `appConfig.load()` at startup, read the value, and exit. But given the current CLI tools just enqueue jobs and pass config via job payloads, this is unlikely to be needed.

### 5.6 Embedded Mode

In embedded mode, the gateway runs tossers and mailer in-process. Since there's only one process, the CONFIG_CHANGED pub/sub event is still published and received (Redis pub/sub works within a single process subscribing to its own messages). `appConfig` is a singleton within the process, so one `reload()` call updates everything. No special handling needed.

### 5.7 Hot-Reload Limitations

Some values cannot truly hot-reload because they're consumed once at startup and cached in objects/closures:

- **HTTP server port** (`webport`) — changing this requires a server restart
- **Mailer ports** (`MAILER_BINKP_PORT`, `MAILER_WS_PORT`) — same, bound at startup
- **Worker concurrency** (`WORKER_CONCURRENCY`) — BullMQ worker is created with a fixed concurrency
- **BaseHandler timeout values** — read in constructor, apply per-session. New sessions get new values; existing sessions keep old ones. This is acceptable.

The admin UI should mark these values with a "Requires restart" indicator.

### 5.8 First-Run / Empty Database

When `config_settings` is empty (fresh install), `appConfig.load()` calls `configStore.seedDefaults()` which inserts all keys from `configDefaults` with their default values. This means:

- First run: all defaults are populated in the DB
- Admin can immediately edit values in the web UI
- `.env` overrides still apply on top

On upgrade (new version adds new config keys), `seedDefaults()` uses `INSERT ... ON CONFLICT (key) DO NOTHING`, so existing admin-customized values are preserved while new keys are added with defaults.

---

## 6. Documentation Plan

### 6.1 Architecture Doc

Create or update `docs/CONFIG_ARCHITECTURE.md` covering:

- **Overview** — Three-tier config model (env/DB/defaults), singleton pattern, pub/sub invalidation
- **Module layout** — appConfig.js, configDefaults.js, configStore.js, their relationships
- **Merge precedence** — .env > DB > defaults, with rationale
- **Initialization sequence** — Where `appConfig.load()` fits in each process startup
- **Event flow** — CONFIG_CHANGED event lifecycle
- **Consumer migration pattern** — How to convert a `process.env.X` read to `appConfig.get('X')`
- **Bootstrap boundary** — Which variables must stay in .env and why
- **Admin UI** — Route structure, category organization, read-only indicators
- **Limitations** — Values that require restart, alogger hybrid approach

### 6.2 CLAUDE.md Updates

Add to the "Architecture" section:

```
### Configuration System

Config is managed by `src/config/appConfig.js`, a singleton loaded at process
startup. Three tiers in merge order: configDefaults < PostgreSQL `config_settings`
table < `.env`. Getters are synchronous (in-memory cache); `load()`/`reload()` are
async. Cross-process invalidation via `CONFIG_CHANGED` Redis pub/sub event.

- `src/config/appConfig.js` — Singleton: `get(key)`, `getNumber()`, `getBoolean()`, `getJSON()`, `load()`, `reload()`
- `src/config/configDefaults.js` — Default values, types, categories, descriptions
- `src/models/configStore.js` — PostgreSQL CRUD for `config_settings` table
- Admin UI at `/admin/config` — category-organized inline editing

Bootstrap variables (DB credentials, Redis URL, NODE_ENV, PROCESS_MODE, MAILER_ENABLED)
must remain in `.env`. All other config should use `appConfig.get()` rather than
`process.env`.
```

Add to "Key Directories":

```
- `src/config/` — Configuration system: `appConfig.js` (singleton), `configDefaults.js` (default values)
```

Add to "Environment Variables" section: a note that most env vars are now managed through appConfig and the admin UI, with `.env` as the override/bootstrap layer.

### 6.3 Update `PROCESS_ARCHITECTURE.md`

In the "Shared Resources" section, add appConfig to the table:

```
| appConfig singleton (own instance) | yes | yes | yes |
```

Add a subsection documenting the CONFIG_CHANGED event in the event flow.

### 6.4 Update `web_architecture.md`

Add the `/admin/config` routes to the admin route table. Document the config admin UI pattern (inline editing vs modal CRUD).

---

## 7. Summary of New/Modified Files

| File | Action | Purpose |
|---|---|---|
| `src/config/appConfig.js` | **NEW** | Config singleton |
| `src/config/configDefaults.js` | **NEW** | Default values and metadata |
| `src/models/configStore.js` | **NEW** (replaces `settings.js` stub) | PostgreSQL CRUD for config_settings |
| `db/schema/tablecolumns/settings.conf` | **MODIFY** | Extended schema |
| `src/queues/events.js` | **MODIFY** | Add CONFIG_CHANGED event constant |
| `bin/gateway.js` | **MODIFY** | Add appConfig.load(), CONFIG_CHANGED handler |
| `bin/worker.js` | **MODIFY** | Add appConfig.load(), event subscriber + CONFIG_CHANGED |
| `bin/mailer.js` | **MODIFY** | Add appConfig.load(), event subscriber + CONFIG_CHANGED |
| `src/routes/admin.js` | **MODIFY** | Add /admin/config routes, migrate process.env reads |
| `src/routes/index.js` | **MODIFY** | Migrate process.env reads to appConfig |
| `src/routes/pm.js` | **MODIFY** | Migrate process.env reads to appConfig |
| `src/routes/adminLogs.js` | **MODIFY** | Migrate process.env reads to appConfig |
| `src/routes/users.js` | **MODIFY** | Migrate process.env reads to appConfig |
| `src/views/admin/config/` | **NEW** | Admin config UI templates |
| `src/models/settings.js` | **DELETE** | Replaced by configStore.js |
| `config/system.json` | **DELETE** (Phase 6) | Absorbed into config_settings |
| ~30 other files | **MODIFY** (Phases 1-4) | Migrate process.env reads |
| `docs/CONFIG_ARCHITECTURE.md` | **NEW** | Architecture documentation |
| `CLAUDE.md` | **MODIFY** | Add config system to architecture section |
| `docs/PROCESS_ARCHITECTURE.md` | **MODIFY** | Add appConfig to shared resources |
| `docs/web_architecture.md` | **MODIFY** | Add /admin/config routes |
