# Canectic BBS: Logging System Reference

## Overview

The logging system provides centralized, cross-process log aggregation via Redis. Every `writeAlog()` and `writeClog()` call in any process publishes a structured entry to a Redis pub/sub channel and caches it in a per-process sorted set. This enables real-time log streaming to the admin log viewer, terminal viewers, and future monitoring tools, without changing any existing log call sites.

Console and file logging are unchanged. The Redis log bus is additive and optional: if Redis is unavailable or `initLogBus()` is never called, everything works exactly as before.

For the process model and entry points, see `PROCESS_ARCHITECTURE.md`.
For the web application and admin routes, see `web_architecture.md`.

---

## Architecture

```
  bin/gateway.js ──┐
  bin/mail.js    ──┤
  bin/worker.js  ──┤── writeAlog() / writeClog()
  bin/mailer.js  ──┘        │
                            │
                  ┌─────────┴──────────┐
                  │                    │
            Console + File       Redis Log Bus
            (existing behavior)        │
                              ┌────────┴────────┐
                              │                 │
                        alog:stream        alog:history:*
                        (pub/sub)          (sorted sets)
                              │                 │
                    ┌─────────┤                 │
                    │         │                 │
              Admin WS    Terminal          Admin API
              Bridge      Viewer            /adminlogs/history
              (/ws/admin  (logviewer.js)
               /logs)
```

Every log entry flows through two Redis paths:

**`alog:stream`** (pub/sub channel): real-time delivery to any connected subscriber. Fire-and-forget. If nobody is listening, entries are silently discarded. Used by the admin WebSocket bridge and the terminal log viewer.

**`alog:history:{process}`** (sorted sets, scored by epoch ms): per-process history cache for backfill on page load or viewer startup. Trimmed periodically to the configured retention window. Used by the admin API endpoints and the terminal viewer's `--history` flag.

---

## Entry Format

Every log entry is a JSON object:

```json
{
  "process":  "gateway",
  "level":    2,
  "message":  "HTTP running on port 8080",
  "color":    "bluebright",
  "bold":     false,
  "filename": null,
  "ts":       1711000000000,
  "seq":      42
}
```

| Field | Type | Description |
|-------|------|-------------|
| `process` | string | Source process name (`gateway`, `mail`, `worker`, `mailer`) |
| `level` | number | Log level, lower is more important: 0 = critical, 1 = startup/shutdown, 2 = operational, 3+ = debug |
| `message` | string | Raw message text (no timestamp prefix; consumers add their own) |
| `color` | string or null | Chalk color name (`redbright`, `cyan`, `yellowbright`, etc.) |
| `bold` | boolean | Bold flag |
| `filename` | string or null | Log filename the line was written to (without `.log`), null for the system log. When `writeAlog()` is given an array, the first non-null name |
| `ts` | number | Epoch milliseconds |
| `seq` | number | Per-process monotonic sequence number for ordering entries with identical timestamps |

---

## Redis Keys

| Key | Type | Description |
|-----|------|-------------|
| `alog:stream` | pub/sub channel | Real-time log entries (JSON payloads) |
| `alog:history:gateway` | sorted set | Gateway process history (score = epoch ms) |
| `alog:history:worker` | sorted set | Worker process history |
| `alog:history:mailer` | sorted set | Mailer process history |
| `alog:history:mail` | sorted set | Mail (IMAP/SMTP) process history |

All keys use the application's default Redis database (not the BullMQ database). The history sorted sets are trimmed every 15 minutes by each process, removing entries older than the retention window.

---

## Process Integration

Each entry point initializes the log bus at startup:

```javascript
import * as alogger from "../src/utils/alogger.js";

dotenv.config();
alogger.setProcessName('gateway');   // before any logging

async function main() {
    await alogger.initLogBus();      // first line of main()
    // ... rest of startup
}

// In shutdown handler:
alogger.shutdownLogBus();
```

`setProcessName()`: call immediately after `dotenv.config()`, before any log calls. Sets the `process` field on all subsequent entries.

`initLogBus()`: connects to Redis via the existing `redis.js` module (shared connection). Starts the 15-minute trim timer. If Redis is unavailable, fails silently; console and file logging continue normally.

`shutdownLogBus()`: clears the trim timer. Called in SIGINT/SIGTERM handlers before `redis.shutdown()`.

All four entry points (`bin/gateway.js`, `bin/mail.js`, `bin/worker.js`, `bin/mailer.js`) are wired. The periodic trim always covers `gateway`, `worker`, `mailer` and the calling process's own name, so the `mail` set is trimmed by the mail process itself.

---

## Terminal Log Viewer

`src/tools/logviewer.js`: a standalone Node script that subscribes to `alog:stream` and renders entries with chalk colors in the terminal. Works from any machine with Redis access.

### Usage

```bash
# Watch all processes, all levels
node src/tools/logviewer.js

# Single process
node src/tools/logviewer.js --process gateway

# Multiple processes
node src/tools/logviewer.js --process worker --process mailer

# Filter by level (show level N and below; lower = more important)
node src/tools/logviewer.js --level 2

# Compact single-line format
node src/tools/logviewer.js --compact

# Load history before streaming
node src/tools/logviewer.js --history

# History with custom window (default: 1h)
node src/tools/logviewer.js --history --last 2h
node src/tools/logviewer.js --history --last 30m

# Combine options
node src/tools/logviewer.js --process gateway --level 3 --compact --history --last 1h

# Remote monitoring (point to your server's Redis)
redis_url=redis://bbs.example.com:6379 node src/tools/logviewer.js

# Disable colors (for piping to a file)
node src/tools/logviewer.js --no-color > session.log
```

### Options

| Flag | Description |
|------|-------------|
| `--process NAME` | Filter to specific process(es). Repeatable. Default: all |
| `--level N` | Show entries at level N and below. Default: all levels |
| `--history` | Load recent history from Redis sorted sets before live streaming |
| `--last DURATION` | History window. Format: `Nh`, `Nm`, `Ns`. Default: `1h` |
| `--compact` | Single-line output format (timestamp, process, level, message on one line) |
| `--no-color` | Disable chalk colors |
| `--help` | Show usage |

### Display Format

Entries are rendered with process-colored labels:

```
12:34:56 [gateway] L1  Gateway Startup
12:34:57 [worker ] L1  Worker Process Startup
12:34:58 [mailer ] L1  Mailer Process Startup
12:35:01 [gateway] L2  HTTP running on port 8080
12:35:02 [worker ] L3  Toss job: ftn:inbound  id=ftn-inbound--1711000000000
```

Process colors: gateway = blue, worker = cyan, mailer = magenta. The terminal viewer's default process list is `gateway`, `worker`, `mailer`; pass `--process mail` to see the mail process. Message colors match the original chalk color passed to `writeAlog()`/`writeClog()`.

---

## Admin Web View

### Viewer Page

**`GET /adminlogs`** renders `admin/logs/index.pug` ("System Logs", the Logs item in the admin navbar): an all-processes pane or tiled panes for gateway, mail, worker and mailer, with a level filter. It backfills from `/adminlogs/history` and then follows `/ws/adminlogs`.

### API Endpoints

Mounted at `/adminlogs` via the `adminLogs.js` router (`webserver.js`). The history endpoints require admin-level session authentication. Valid process names are `gateway`, `worker`, `mailer`, `mail`.

**`GET /adminlogs/history/:process`**: returns JSON history for a single process.

Query parameters:
| Param | Default | Description |
|-------|---------|-------------|
| `since` | `LOG_BUS_RETENTION_HOURS` ago (epoch ms, default 8h) | Return entries after this timestamp |
| `limit` | 500 (max 2000) | Maximum entries to return (the newest N, returned in chronological order) |

Response:
```json
{
  "process": "gateway",
  "since": 1711000000000,
  "count": 47,
  "entries": [ { "process": "gateway", "level": 1, ... }, ... ]
}
```

**`GET /adminlogs/history`**: returns history for all processes in one call.

Same query parameters. Response:
```json
{
  "since": 1711000000000,
  "processes": {
    "gateway": [ ... ],
    "worker": [ ... ],
    "mailer": [ ... ],
    "mail": [ ... ]
  }
}
```

### WebSocket Stream

**`/ws/adminlogs`**: real-time log stream.

Connection flow:
1. Client connects to `/ws/adminlogs`
2. Client sends `{ "type": "auth", "sessionId": "<cookie>" }` within 5 seconds
3. Server validates session against session store (same admin security check as HTTP endpoints)
4. On success: server sends `{ "type": "auth", "status": "ok" }`
5. Server streams raw JSON entry payloads as they arrive from `alog:stream`

If auth fails or times out, the connection is closed with code `4003` (insufficient permissions) or `4001` (timeout).

Filtering is done client-side: the server sends all entries and the client shows/hides based on the user's selected process tabs and log level slider. This keeps the server simple and lets filter changes feel instant.

### Gateway Wiring

Both halves are wired: `src/servers/webserver.js` mounts the router (`webserver.use('/adminlogs', adminLogRouter)`), and `bin/gateway.js` calls `registerLogWebSocket(wsManager)` after the WebSocket pools start, registering `/ws/adminlogs` on the WsManager's `pathMap`.

---

## Log Files and Rotation

Files live in `logs/<NODE_ENV>/`. `writeAlog(level, msg, colour, bold, filename)` and `writeClog(level, msg, filename, ...)` write `system.log` when `filename` is empty and `<filename>.log` otherwise. `writeAlog` also accepts an ARRAY of names (`null` meaning the system log) and writes the one line to each, while the console and the log bus get it once.

| File | Written by |
|------|------------|
| `system.log` | everything without a filename |
| `mailer.log` | binkp mailer, BSO scanner, wazoo transfers |
| `tosser.log` | FTN tosser (packet identification, bundles) |
| `tic.log` | TIC file echo processing, inbound and outbound (`ticLog()` in `ticTosser.js`). Failures, refusals and each run's summary go to `system.log` as well (`SYSTEM_TOO`), because the 0.9.7a-0.9.10a Seenby loop bug refused every inbound file and its only trace was a routine-looking system log line; moving TIC out of the system log entirely would have left not even that |
| `security.log` | for fail2ban: honeypot logins (level 1), and `[AUTHFAIL]` lines for a login to an unknown user or with a wrong password (`useraccounts.js`), a failed QWK FTP hub login (`qwkFtpServer.js`) and a failed QNET API authentication (`routes/api/qnet.js`) |
| `NewUsers.log` | new user registrations from the terminal (`registrationhandler.js`) |
| `<process>-out.log`, `<process>-error.log` | pm2, as named in `ecosystem.config.cjs` |

### Rotation

`src/maintenance/logRotation.js`, run daily at 23:59 by the `rotate-logs` maintenance job (`rotate-logs-daily`) and by hand with `node src/tools/rotateLogs.js [--dry-run] [--days N]`, which needs no worker. Each non-empty top-level `*.log` becomes `logs/<env>/archive/YYYY-MM-DD/<name>.log.gz`, dated by the local day the rotation ran (23:59 so the day is the day the contents cover); a second rotation that day writes `<name>.2.log.gz` rather than overwriting. Archive days older than `log_retention_days` (30, 0 keeps all) are deleted; a directory under `archive/` not named like a day is never touched.

Two ways to take a file, chosen by name (`rotationMethod`):

- **rename** for alogger's files. alogger opens by path on every write, so the next line recreates the file. Atomic; nothing lost. Moved first and compressed after, so writers never wait on gzip.
- **copytruncate** for pm2's `-out.log` / `-error.log`. pm2 holds them open for the daemon's life; renamed, it would keep writing into the archive. Copied up to the size seen, then truncated; a line written between the two is lost. pm2 opens in append mode, so later writes land at offset 0 rather than leaving a sparse hole. `tests/logRotation.test.js` fails if `ecosystem.config.cjs` names a pm2 file that does not match.

The job reads `log_rotation_enabled` and `log_retention_days` when it runs, so a retention change applies that night; enabling or disabling registers or skips the schedule, so that half needs a gateway restart or `schedules.js --sync`. A board running with `NODE_ENV=development` rotates `logs/development/` only, while `ecosystem.config.cjs` points pm2 at `logs/production/`; on a production board they are the same directory. fail2ban follows `security.log` across a rename.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_BUS_RETENTION_HOURS` | `8` | Hours to retain entries in Redis history sorted sets. alogger reads it from the environment; the admin history endpoints read it via appConfig (it is also a `logging` key in `configDefaults.js`), so a value set only in the settings table changes the endpoints' default window but not the trim |
| `redis_url` | `redis://localhost:6379` | Redis connection (shared with existing app Redis) |
| `loglevel` | `3` | Console/file log level filter |
| `logtoconsole` | unset | Always log to console in production |
| `logeverything` | unset | Ignore log levels in development |
| `logfileindev` | unset | Write to log files in development |
| `defaultlogfile` | `system.log` | Default log filename |

`log_rotation_enabled` (true) and `log_retention_days` (30) are ordinary appConfig keys in the `logging` category; see Rotation above.

The log bus publishes ALL levels to Redis regardless of the `loglevel` setting. Level filtering happens at the consumer (terminal viewer `--level` flag, admin view client-side filter). This means the admin can see debug-level entries even when the console is configured for level 2.

---

## Future Development

- **Admin log viewer search**: the viewer page (see Viewer Page above) has panes and a level filter; free-text search is not built.
- **Log filename filtering**: the `filename` field enables filtering by subsystem (e.g., show only `mailer` log entries from the worker process, or only `tosser` entries). The admin view could offer a filename dropdown.
- **Custom process names**: `setProcessName()` accepts any string. If you add more worker types or tools, they get their own history sorted set and show up as a separate pane. The trim function already includes `_processName` in its sweep.
- **Log retention per process**: different retention windows per process (e.g., keep mailer logs longer for debugging session issues).
- **Alerting**: subscribe to `alog:stream` with a filter for level 0-1 entries and push notifications (email, webhook, Meshtastic) on critical events.
