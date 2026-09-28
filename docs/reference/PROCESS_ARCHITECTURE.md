# Canectic BBS — Process Architecture & Job Queue Reference

## Overview

The system runs as four independent OS processes sharing PostgreSQL and Redis. Each process can crash and restart without affecting the others. A BullMQ job queue (backed by the existing Redis instance) handles all inter-process communication.

For the shared message platform (schemas, read tracking, body_html pipeline, posting), see `message_architecture.md`.
For the networking/tosser stack (FTN, QWK, NNTP), see `NETWORKING_ARCHITECTURE.md`, and `QWK_ARCHITECTURE.md` for QWK in detail.
For the FTN mailer (binkp, transports, file exchange), see `MAILER_ARCHITECTURE.md`.
For private messaging (unified PM, transport adapters), see `PM_ARCHITECTURE.md`.

---

## Process Model

```
┌────────────────────────────┐
│        Gateway             │
│   bin/gateway.js           │
│                            │
│  HTTP server (webport)     │
│  WebSocket pools           │
│  CallPools + CallManager   │
│  SocatManager (doors)      │
│  NodeManager               │
│  Express routes (web UI)   │
│                            │
│  Produces jobs ──────────────────┐
│  Subscribes to events ─────────────┐
└────────────────────────────┘  │    │
                                │    │
┌────────────────────────────┐  │    │
│        Mail                │  │    │
│   bin/mail.js              │  │    │
│                            │  │    │
│  IMAP4rev1 server          │  │    │
│  SMTP submission server    │  │    │
│                            │  │    │
│  Subscribes to events ──────────────┤
│  Publishes events ──────────────────┤
└────────────────────────────┘  │    │
                                │    │
         Redis (BullMQ)  ◄──────┤────┤
                                │    │
┌────────────────────────────┐  │    │
│        Mailer              │  │    │
│   bin/mailer.js            │  │    │
│                            │  │    │
│  TCP listener (binkp)      │  │    │
│  WS listener (mailer WS)   │  │    │
│  MailerManager             │  │    │
│  Session pool              │  │    │
│                            │  │    │
│  Consumes mailer queue ◄──────┘    │
│  Produces toss jobs ───────────────┤
│  Publishes events ─────────────────┤
└────────────────────────────┘       │
                                     │
┌────────────────────────────┐       │
│        Worker              │       │
│   bin/worker.js            │       │
│                            │       │
│  FTN tosser                │       │
│  QWK tosser                │       │
│  NNTP tosser               │       │
│  TIC processor             │       │
│  Email tosser              │       │
│  Maintenance tasks         │       │
│                            │       │
│  Consumes toss queue ◄─────────────┘
│  Consumes maintenance queue│
│  Produces mailer jobs ─────────►
│  Publishes events ─────────────►
└────────────────────────────┘
```

### Process 1 — Gateway (`bin/gateway.js`)

The critical user-facing process. Must be as stable as possible. Handles all inbound user connections (HTTP, WebSocket, terminal via socat), serves the web UI, and manages terminal call sessions.

**Owns:** HTTP server, WsManager, WsPool instances, CallManager, CallPools, SocatManager, NodeManager, Express routes, the terminal servers, the QWK hub FTP server (`src/servers/qwkFtpServer.js`, started by `startQwkFtp()` only when `qwk_ftp_enabled` is on, port `qwk_ftp_port` 8021), schedule registration (`registerSchedules()`), the worker watchdog, and its own maintenance watch.

**Does not own:** Tosser logic, mailer sessions, maintenance tasks, except in embedded mode (see below).

**Queue role:** Producer only (enqueues jobs when user actions or admin commands require background processing) and event subscriber (receives notifications from workers for real-time UI updates).

### Process 2 -- Mail (`bin/mail.js`)

IMAP4rev1 and SMTP submission servers for accessing private messages from standard mail clients. Isolated from the gateway to prevent mail client activity (long-lived IMAP IDLE connections, bulk SMTP submissions) from blocking terminal sessions or web requests.

**Owns:** IMAP server, SMTP server, own pgpool and Redis connections.

With no `mail_domain` (or every mail port 0) it **waits** rather than exiting, since an exit would be a pm2 restart loop on every board without mail. It keeps one `CONFIG_CHANGED` subscriber for its whole life and starts its servers when a reload makes mail configured (rule: `mailDisabledReason` in `src/servers/mailStartup.js`).

**Does not own:** User connections, web UI, tosser processing, mailer sessions, door games.

**Queue role:** Event subscriber only. Subscribes to `PM_DELIVERED` and `PM_READ_CHANGED` events via Redis pub/sub for IMAP IDLE push notifications. Publishes `PM_READ_CHANGED` when IMAP clients change message read state, so the gateway can update web UI unread counts.

### Process 3 -- Mailer (`bin/mailer.js`)

Manages FTN mailer sessions — both inbound (listening for connections) and outbound (poll-based and triggered). Binds its own TCP port for binkp and its own HTTP port for WebSocket mailer connections.

**Owns:** MailerManager, TCP listener, WebSocket listener (own port), session pool, transport/protocol/transfer layers.

**Does not own:** User connections, web UI, tosser processing, door games. Loads its own pgpool and Redis connection. Loads NodeManager read-only for peer connection config.

**Queue role:** Consumer of `mailer` queue (poll triggers, outbound signals). Producer of `toss` queue jobs (when inbound files arrive). Event publisher (session status, transfer progress for future admin dashboard).

### Process 4 -- Worker (`bin/worker.js`)

Stateless batch processor. Runs toss cycles, maintenance tasks, TIC processing, echolist scanning, and sysop-configured timed events. Can be stopped and restarted freely -- BullMQ resumes incomplete jobs with retry.

**Owns:** Tosser modules (ftnTosser, qwkTosser, nntpTosser, ticTosser, emailTosser), maintenance functions, the worker heartbeat (see Worker Health). Loads its own pgpool and Redis connection.

**Does not own:** Network listeners, user sessions, mailer sessions.

**Queue role:** Consumer of `toss` and `maintenance` queues. Producer of `mailer` queue jobs (signal outbound after FTN toss). Event publisher (import completion notifications with affected area shortcodes).

---

## Shared Resources

### What each process loads independently

| Resource | Gateway | Mail | Mailer | Worker |
|----------|---------|------|--------|--------|
| pgpool (own connection pool) | Yes | Yes | Yes | Yes |
| Redis (own ioredis instance) | Yes | Yes | Yes | Yes |
| BullMQ connection | Yes | No | Yes | Yes |
| NodeManager (read-only config) | Yes | No | Yes | No |
| dotenv / env config | Yes | Yes | Yes | Yes |
| appConfig singleton (own instance) | Yes | Yes | Yes | Yes |

### What is NOT shared across processes

| Resource | Lives in |
|----------|----------|
| WsManager, WsPool, CallPool | Gateway only |
| SocatManager | Gateway only |
| Express app / routes | Gateway only |
| IMAP server, SMTP server | Mail only |
| MailerManager, sessions | Mailer only |
| Tosser modules | Worker only |

### Filesystem (shared via disk)

- `ftn/in/` — mailer writes received files, worker reads and processes them
- `ftn/out/` — worker writes outbound packets, mailer reads and sends them
- `cwd/qnet/` — worker reads/writes QWK exchange directories, one per link and role: `qnet/<ID>.hub/` and `qnet/<ID>.node/` (`src/utils/qnetPaths.js`)
- `logs/` — each process writes to its own log files (or tagged entries)

No process writes to another process's output directory. The mailer writes to inbound; the worker reads from inbound. The worker writes to outbound; the mailer reads from outbound. Filesystem is the boundary — same convention as the existing "mailer does not toss" design principle.

### Timezone propagation (PM2 + alogger)

`ecosystem.config.cjs` loads `.env` at config-eval time and resolves an
IANA timezone in this precedence order:

1. `process.env.TZ` (from `.env` or the invoking shell)
2. `Intl.DateTimeFormat().resolvedOptions().timeZone` (Node reads `/etc/localtime`)
3. Unset — Node defaults to UTC

The resolved value is spread into every app's `env` block so each child
process has the same TZ at startup. `alogger.writeAlog` and
`alogger.writeClog` both use Luxon `DateTime.now().toLocaleString()` which
honours `process.env.TZ`, so application logs render in the configured
zone regardless of OS defaults.

**Gotcha**: PM2's own `log_date_format: 'YYYY-MM-DD HH:mm:ss'` prefix on
captured stdout is stamped by the **PM2 daemon**, not by the child
process. Setting TZ in `baseEnv` fixes alogger's own timestamps but does
NOT change PM2's prefix — that inherits from whatever env the daemon was
started with. If PM2 logs show UTC after the child processes are on local
time, restart the daemon itself:

```bash
pm2 kill
TZ=America/Edmonton pm2 start ecosystem.config.cjs
```

Or set `TZ` in `/etc/environment` / shell rc before `pm2 start` so the
daemon inherits it on first launch.

---

## Queue Topology

Three BullMQ queues, each with named job types. All share the same Redis instance.

### `toss` queue

| Job name | Producer | Payload | Notes |
|----------|----------|---------|-------|
| `ftn:inbound` | Mailer (after file receive), Admin, CLI | `{ connectionUUID?, sourceDir? }` | Process .pkt files and bundles from the inbound directory |
| `ftn:outbound` | Gateway (after user post), Admin, CLI | `{ connectionUUID? }` | Gather and pack outbound echomail/netmail. `TossOutbound()` enqueues `bso-scan` itself |
| `qwk:pull` / `qwk:push` | Scheduler (per connection), Admin | `{ connectionUUID }` | Client side: fetch .qwk / send .rep |
| `qwk:pull-all` / `qwk:push-all` | Admin, CLI | `{}` | Every active QWK connection |
| `qwk:hub:inbound` | QWK hub FTP server and HTTP hub (`src/routes/api/qnet.js`) when a node uploads a REP | `{ connectionUUID }` | Imports every REP the node has left (`qwkTosser.pullHubReps`) |
| `qwk:hub-sweep` | Scheduler `qwk-hub-sweep` | `{}` | `qwkTosser.serviceHubNodes()`: build packets for, and collect REPs from, shared-directory hub nodes |
| `nntp:pull` / `nntp:push` | Scheduler (per connection), Admin | `{ connectionUUID }` | Pull articles / post local messages |
| `nntp:pull-all` / `nntp:push-all` | Admin, CLI | `{}` | Every active NNTP connection |
| `tic:inbound` | Mailer (after file receive), Admin, CLI | `{ connectionUUID?, sourceDir? }` | Process inbound .tic files and attached files |
| `tic:outbound` | tic:inbound (forwarding), upload handler (networked area), file-area rescan, Admin | `{ connectionUUID? }` | Build TIC descriptors and stage outbound files |
| `email:outbound` | PM model (`_triggerOutboundToss`), Admin | `{}` | Pending EMAIL transport PMs via the email tosser |
| `outbound-sweep` | Scheduler (`outbound_toss_interval`, default 120 min) | `{}` | All-protocol periodic outbound toss. The protocol list lives in `src/maintenance/outboundSweep.js` (`SWEEP_PROTOCOLS`) so which protocols it covers is testable. TIC was missing until 0.9.6a and file echoes were never forwarded |

All toss jobs are consumed by the worker (or the embedded toss consumer).

### `mailer` queue

| Job name | Producer | Payload | Notes |
|----------|----------|---------|-------|
| `signal-outbound` | nothing currently | `{ connectionUUID }` | Legacy; still handled, superseded by `bso-scan` |
| `trigger-poll` | Admin (manual), `src/tools/trigger-poll.js` | `{ connectionUUID }` | Force a session (`{force: true}` past backoff) |
| `poll-scheduled` | Scheduler (per FTN connection) | `{ connectionUUID }` | Regular poll with all guards |
| `bso-scan` | ftnTosser and ticTosser after writing outbound, stub distribution, Admin | `{}` | Immediate BSO directory scan (`scanOutboundNow`) |
| `nodelist-connect` | Admin manual poll of an address reached through the nodelist (no peer record) | `{ nodelistData, destinationAddress }` | `connectToNodelistAddress` |

### `maintenance` queue

One switch, `runMaintenanceJob` in `src/maintenance/maintenanceJobs.js`, shared by the worker and embedded mode; `MAINTENANCE_JOBS` is the declared list. Retention purges read their days when they run (`src/maintenance/retention.js`); `{ manual: true, days }` is only sent by a sysop's explicit run.

| Job name | Scheduled | Notes |
|----------|-----------|-------|
| `purge-pm-trash` | daily 03:00 | Tag-only sweep: `purged=true` on PMs deleted longer than `pm_trash_retention_days` (30) ago |
| `pm-purged-cleanup` | hourly :15, plus on demand after a web/IMAP purge | Hard delete of tagged PMs and their attachments (refCount-safe), drained in a loop until `pendingMore` is false |
| `purge-notifications` | daily 02:30 | `notifications_retention_days` (30) |
| `purge-tossed` | daily 02:00 | `ftn_keep_tossed_days` (7; 0 deletes at toss, 999 keeps for ever and removes the schedule) |
| `purge-bad-echomail` | daily 03:45 | `bad_echo_retention_days` (30) |
| `purge-inbound-log` | daily 03:50 | `inbound_log_retention_days` (90) |
| `purge-outbound-log` | daily 03:52 | `outbound_log_retention_days` (90) |
| `purge-mailer-sessions` | daily 03:54 | `mailer_session_retention_days` (30) |
| `purge-relay-log` | daily 03:56 | `netmail_relay_log_retention_days` (180) |
| `purge-network-transfers` | daily 03:57 | `network_transfer_retention_days` (30) |
| `purge-update-checks` | daily 03:58 | `update_check_retention_days` (90) |
| `rotate-logs` | daily 23:59 while `log_rotation_enabled` | `src/maintenance/logRotation.js` |
| `scan-nodelists` | daily 04:00 | Auto-import nodelists from configured file areas |
| `message-maintenance` | daily 04:00 | Message retention (`max_age_days`/`max_messages`, NULL by default) |
| `scan-echolists` | daily 04:15 | Scan infopack/echolist/filebone areas for updated lists |
| `reconcile-echolists` | daily 04:30 | Echolist/filebone `local_area_id` reconciliation |
| `update-check` | daily 04:40 while `update_check_enabled` | Opt-in update check (`src/maintenance/updateCheck.js`) |
| `user-maintenance` | daily 05:00 | Mailtype reconciliation, unverified user purge (`unverified_retention_days`) |
| `scan-inbound` | every `inbound_scan_interval` s (300, 0 = off) | Backstop for tossable inbound files (see Worker Health) |
| `timed-event` | cron per event (`timed-event:<id>`) | Sysop timed event (`timedEventRunner.js`) |
| `generate-stub` | cron per coordinator segment (`generate-stub:<id>`) | FTN stub generation |
| `regen-html`, `regen-pm-html`, `regen-file-desc-html` | no | Regenerate stored HTML |
| `recalc-area-counts`, `recalc-file-counts` | no | Recount areas |
| `rethread`, `fix-msgids`, `bulk-msgbase-import` | no | Message base repair and import |
| `echolist:batch-subscribe`, `filebone:batch-subscribe` | no | Batch area creation from an echolist/filebone |
| `compile-nodelist` | no | Coordinator nodelist compilation |
| `import-nodelist`, `scan-file-area`, `file-maintenance` | no | Admin/CLI on demand |

### Concurrency and deduplication

- **Per-connection locking on toss jobs**: Two `qwk:pull` jobs for the same connectionUUID must not run concurrently (would double-download from the same FTP host). Use BullMQ's `jobId` set to `qwk-pull--${connectionUUID}` — duplicate job IDs are rejected while one is active. Same pattern for `nntp:pull`, `qwk:push`, `nntp:push`.
- **FTN inbound is safe to overlap**: Multiple `ftn:inbound` jobs can run if they process different files. The existing move-after-toss pattern prevents double-processing.
- **FTN outbound needs per-connection isolation**: HWM advancement must not race. Use `ftn-outbound--${connectionUUID}` as jobId (a timestamp suffix when no connection is named).
- **Maintenance jobs are single-instance**: Use jobId deduplication. Only one `regen-html` at a time.
- **`addDeduped` (`jobs.js`)**: every helper goes through it. A job with the same id is refused only while it is waiting, delayed or running; a completed or failed one is removed first. Plain `queue.add()` refuses an id in ANY retained state, so a fixed id ran once and later requests silently returned the old completed job.
- **Mailer jobs**: `signal-outbound--${connectionUUID}` dedupes; `trigger-poll`, `bso-scan` and `nodelist-connect` carry a timestamp so every request is queued; `poll-scheduled` jobs come from the per-connection scheduler, which holds one delayed job at a time. Duplicate sessions to one peer are prevented inside `MailerManager`, not by job ids.

---

## Shared Queue Infrastructure

### File layout

```
src/queues/
  connection.js     BullMQ connection factory; closeAllQueueConnections() for tests
  queues.js         queue definitions (toss, mailer, maintenance)
  jobs.js           enqueue helpers (addDeduped + one enqueueXxx per job)
  events.js         cross-process event constants and pub/sub helpers
  schedules.js      registerSchedules(), per-connection schedule upkeep, orphan pruning
  embedded.js       in-gateway consumers for PROCESS_MODE=embedded
  workerHealth.js   heartbeat and the pure health rules
  workerWatchdog.js gateway-side watchdog
src/maintenance/maintenanceJobs.js   the one maintenance job switch
```

### `connection.js`: BullMQ connection factory

Every BullMQ Queue and Worker gets its own ioredis connection from `createQueueConnection()`. Host, port and password are parsed from `redis_url` (default `redis://localhost:6379`, `REDIS_PASSWORD` as a fallback for the password); the database is `REDIS_BULLMQ_DB` (default 2), with `maxRetriesPerRequest: null` (required by BullMQ) and `protocol: 2` (ioredis 6 defaults to RESP3; pinned so a version bump does not change reply shapes). Every connection opened is recorded until it ends, so `closeAllQueueConnections()` can close what is left for the test root hooks.

Using a separate Redis DB keeps job data isolated from session data and flash messages on the default DB. Same Redis instance, no extra infrastructure.

### `queues.js`: Queue definitions

| Queue | attempts | backoff | removeOnComplete | removeOnFail |
|-------|----------|---------|------------------|--------------|
| `toss` | 3 | exponential, 5s | 200 | 500 |
| `mailer` | 2 | fixed, 10s | 100 | 200 |
| `maintenance` | 1 | none | 50 | 100 |

### `jobs.js`: Enqueue helpers

Thin wrappers that fix the jobId convention for each job name, all through `addDeduped` (see above). Per-connection jobs use `${name}--${connectionUUID}`; singleton maintenance jobs a fixed id; one-shot and all-connection jobs a `Date.now()` suffix. BullMQ disallows colons in custom job IDs, hence `--`. `enqueueTossCycle(opts)` fans a CLI toss request out into the per-protocol jobs.

### `events.js`: Cross-process notifications

Raw Redis pub/sub on the channel `canectic:events`, with a dedicated connection per publisher and subscriber. Payloads are `{ type, data, ts }`. Missing a notification is acceptable, so there is no durability.

| Constant | Value | Typical publisher |
|----------|-------|-------------------|
| `MESSAGES_IMPORTED` | `messages:imported` | Worker after an import |
| `PM_DELIVERED` | `pm:delivered` | PM delivery (mail process IDLE push, gateway notifications) |
| `PM_READ_CHANGED` | `pm:read:changed` | Mail process when an IMAP client changes read state |
| `FILES_IMPORTED` | `files:imported` | Worker after `tic:inbound` |
| `TOSS_COMPLETE` | `toss:complete` | Worker after an outbound toss |
| `MAILER_SESSION_START` / `_END`, `MAILER_TRANSFER_PROGRESS` | `mailer:session:start`, `mailer:session:end`, `mailer:transfer:progress` | Mailer |
| `CONFIG_CHANGED` | `config:changed` | `configStore` writes and `publishReload()`; every process reloads appConfig |
| `WILDCARDS_CHANGED` | `wildcards:changed` | Inbound wildcard edits (cache invalidation) |
| `NETMAIL_ROUTES_CHANGED` | `netmail_routes:changed` | Netmail route edits (cache invalidation) |

---

## QWK/NNTP Transport Separation and HWM Consistency

### The problem

FTN separates transport (mailer moves files) from tossing (tosser processes packets) by convention — they communicate via the filesystem. The mailer writes to `ftn/in/`, the tosser reads from it. HWM is managed entirely within the tosser. The process boundary aligns perfectly with the existing design.

QWK and NNTP are different. The current tosser modules combine transport (FTP/SFTP connect, download, upload for QWK; TCP NNTP session for NNTP) with message processing (parse, import, HWM advance) in a single function call. Separating these into different processes requires care to avoid HWM drift — advancing the pointer before confirming the import, or importing without advancing.

### Design: keep transport and toss together in the worker

Rather than splitting QWK/NNTP transport into the mailer process, both transport and toss stay in the worker. The worker handles the full cycle: connect → fetch → parse → import → advance HWM. This preserves the existing transactional semantics where HWM only advances after successful import.

The rationale: FTN's mailer is a persistent listener with long-lived sessions and concurrent bidirectional transfers — it genuinely needs its own event loop. QWK and NNTP transports are short-lived request/response operations (connect, download a file, disconnect; or connect, pull N articles, disconnect). They don't benefit from running in a dedicated process — they're just I/O operations within a batch job.

The mailer process exists for protocols that need persistent listeners and concurrent session management. QWK FTP pulls and NNTP article fetches are not that.

### HWM consistency model by protocol

**FTN echomail:**
- HWM (`msg_idx` on `peer_area_subscriptions`) advances per-area after outbound messages are packed into a `.pkt` and written to the outbound directory
- Inbound has no HWM — it processes whatever `.pkt` files exist in the inbound directory, then moves them to processed
- On retry: outbound re-packs from the same HWM (idempotent — remote deduplicates by MSGID). Inbound re-processes any unprocessed `.pkt` files
- Risk: if the worker crashes after writing the `.pkt` but before advancing HWM, the next run re-packs the same messages. The remote tosser's dupe checking handles this

**QWK client pull (inbound):**
- Worker connects via FTP/SFTP, downloads `.qwk`, extracts, imports messages, advances HWM per-conference
- Existing safety net: if the worker crashes after download but before import, the next run finds the `.qwk` already in `inDir` and processes it instead of re-downloading (the hub may have already deleted it post-download)
- HWM advances after each conference's messages are committed, not in a single batch at the end. A crash mid-import loses progress only for unprocessed conferences — already-imported conferences have their HWM advanced
- On retry: BullMQ retries the job. If `.qwk` exists locally, it's reprocessed. If not (download failed), it's re-downloaded. Dupe checking (`qwk_msg_id`) prevents double-import of messages from conferences that were partially processed

**QWK client push (outbound):**
- Worker gathers messages above HWM, builds `.rep`, uploads via FTP/SFTP, advances HWM
- Current behavior: HWM advances after upload completes
- Risk: if upload succeeds but HWM advance fails (worker crash), next run re-uploads a `.rep` containing the same messages plus any new ones. Remote hub's dupe checking handles this
- Mitigation: advance HWM immediately after `.rep` build, before upload. If upload fails, the `.rep` is re-uploaded on retry (same file, no data loss). If HWM advanced but upload never happens (worker crash), the messages are effectively "sent" without delivery — but the next push cycle picks up only new messages, and the remote hub never received the old ones. This is the same "at-most-once" trade-off that the current code already makes

**QWK hub mode (inbound):**
- No transport — `.rep` files arrive via filesystem (directory exchange with Synchronet or similar)
- Worker processes whatever `.rep` files exist, same as FTN inbound
- No HWM on the hub side — the node controls its own HWM in its local QWK processor

**QWK hub mode (outbound):**
- `buildQwkForNode()` is called on demand (node requests a packet), not during toss cycle
- HWM advances after packet build
- Gateway triggers this via a toss job (`qwk:hub:build`) when a node connection requests its packet
- Done (a800d87): `buildQwkForNode()` no longer advances HWMs; it records them in the packet's `.qwk.json` sidecar and `commitNodePacket()`/`commitPending()` advance them once the node has the packet (acknowledgement over HTTP, or the packet collected from `out/` by a shared-directory node). See `QWK_ARCHITECTURE.md`

**NNTP pull (inbound):**
- Worker connects to NNTP server, pulls articles above per-group HWM, imports, advances HWM
- HWM advances per-newsgroup after articles for that group are committed
- On retry: re-pulls from last committed HWM. May re-fetch articles that were pulled but not committed in the crashed run. Dupe checking (`nntp_msg_id`) prevents double-import
- NNTP servers retain articles for extended periods, so re-pulling is always safe

**NNTP push (outbound):**
- Worker connects to NNTP server, posts local messages above HWM
- HWM advances per-area after successful POST for each message
- On retry: re-posts from last committed HWM. NNTP servers reject duplicate Message-IDs, so re-posting is safe (server returns 441 or 435)

### Summary: all protocols are retry-safe

Every protocol path is designed so that BullMQ retry produces correct results:

| Protocol | Direction | Retry behavior | Dupe protection |
|----------|-----------|---------------|-----------------|
| FTN | Inbound | Re-process unprocessed .pkt files | MSGID dupe check on import |
| FTN | Outbound | Re-pack from same HWM | Remote MSGID dupe check |
| QWK client | Pull | Re-process local .qwk or re-download | qwk_msg_id dupe check |
| QWK client | Push | Re-upload .rep | Remote dupe check |
| QWK hub | Pull (.rep) | Re-process unprocessed .rep files | qwk_msg_id dupe check |
| QWK hub | Push (build) | Rebuild from same HWM | Node dupe check |
| NNTP | Pull | Re-pull from last HWM | nntp_msg_id dupe check |
| NNTP | Push | Re-post from last HWM | Server rejects duplicate Message-ID |

The existing dupe-checking infrastructure across all three tossers is what makes BullMQ retry safe without additional coordination. No distributed locks or two-phase commits needed.

---

## Entry Points

The original design sketches of these files have been replaced by this summary; read the files for detail.

### `bin/gateway.js`: Gateway (renamed from `doorserver.js`)

`main()` in order: log bus, fail fast if PostgreSQL or Redis is unreachable, `appConfig.load()`, create the maintenance watch (started last), seed default theme, nodelist flags and template events, `prerunMaint()`, MSGID counter seed, NodeManager, SocatManager, call pools, web server, QWK hub FTP server (`qwk_ftp_enabled`), WebSockets (plus the log and NodeSpy sockets), the unified terminal server and the legacy TCP/Telnet servers. In embedded mode it then starts IMAP, SMTP, the mailer (only with `MAILER_ENABLED=true`) and the embedded consumers. Then, in both modes: the event subscriber, `startMaintenanceWatch()`, `registerSchedules()`, the QWK ID audit, and `startWorkerWatchdog({ processMode })`.

### `bin/mailer.js`: Mailer process

Starts `MailerManager` (binkp TCP on `MAILER_BINKP_PORT`, WebSocket listener on `MAILER_WS_PORT`), wires its `filesReceived` event to `enqueueFtnInbound` and `enqueueTicInbound` for that connection, and consumes the `mailer` queue at concurrency 5 (`signal-outbound`, `trigger-poll`, `poll-scheduled`, `nodelist-connect`, `bso-scan`). On a closed board the consumer is created paused and the manager is put in maintenance before `start()`.

### `bin/worker.js`: Worker process

Consumes `toss` (concurrency `WORKER_CONCURRENCY`, default 3) and `maintenance` (concurrency 1), each processor wrapped in a job timeout (`toss_job_timeout`, `maintenance_job_timeout`). The toss switch publishes `MESSAGES_IMPORTED` / `FILES_IMPORTED` / `TOSS_COMPLETE` and runs post-toss thread reconciliation; the maintenance processor calls `runMaintenanceJob`. It also runs the heartbeat and the consumer self check (see Worker Health), and follows maintenance mode through `queueDrain`.

---

## Embedded Mode

For single-server deployments where running four processes is unnecessary overhead, `PROCESS_MODE=embedded` starts the mailer and worker processors inside the gateway process. This is the simple-setup path — one process, one `node bin/gateway.js`, no process manager needed.

### `src/queues/embedded.js`

`startEmbeddedWorkers({ mailerManager, startPaused })` creates, in the gateway, a toss consumer (concurrency 2, its own switch), a mailer consumer (concurrency 5, only when a `mailerManager` was passed) and a maintenance consumer (concurrency 1, `runMaintenanceJob`). With `startPaused` (a closed board) they are created with `autorun: false`. It returns `{ shutdown, consumers }`; `consumers` feeds the gateway's queue drain.

**Gap:** the embedded mailer consumer handles only `signal-outbound`, `trigger-poll` and `poll-scheduled`. `bso-scan` and `nodelist-connect` fall to its `default` and are logged as unknown, so on an embedded board the on-demand BSO scan after a toss and the admin nodelist connect do nothing (the mailer's own periodic BSO scan still runs).

In embedded mode the mailer's WebSocket transport is a pool on the gateway's server at `/ws/mailer/binkp`.

The key: **the job enqueue helpers (`jobs.js`) are used identically in both modes**. Gateway routes call `jobs.enqueueFtnOutbound()` regardless of whether the consumer is in-process or across the network, so switching modes is a startup configuration change only.

### Embedded mode must handle every job name the standalone worker does

This is the invariant embedded mode kept breaking. `registerSchedules()` runs in **both** modes (`bin/gateway.js`, outside the `processMode` branch), so an embedded board registers the full set of schedulers and they fire on time. If the embedded consumer has no `case` for a name, BullMQ hands the job over, the switch falls to `default`, one line is logged at level 3 — verbose, so nothing at a normal log level — and the job is marked **complete**. The queue drains, `schedules.js` reports every scheduler healthy, and the work never happened.

It went wrong twice. The TIC jobs were absent, so file echoes did not work in either direction. The maintenance switch handled 7 of 33 names, so an embedded board never purged a log, never enforced message or file retention, never ran a timed event or an update check, and reported success on admin buttons that did nothing.

Two structural answers, one per queue:

- **Maintenance** has exactly one switch, in `src/maintenance/maintenanceJobs.js`. Both consumers call `runMaintenanceJob(name, data, { logPrefix })`, which returns `false` for a name it does not handle so the caller can log it as unknown rather than report silent success. `MAINTENANCE_JOBS` is the declared list. Each case loads its own dependencies dynamically, which is what most already did and what keeps this module cheap for a process that may never run one.
- **Toss** still has a switch per consumer, because each publishes different events around the work. `src/maintenance/outboundSweep.js` holds the one piece that was genuinely shared.

`tests/queueJobCoverage.test.js` derives the producible names from the enqueue sites and holds both consumers to them, checks that `MAINTENANCE_JOBS` matches the cases actually implemented, and asserts neither consumer has grown a private maintenance switch again. `tests/entryPointBindings.test.js` covers the other half of the same blind spot: nothing imports `bin/*.js`, so a missing import there is invisible until the process runs.

### gateway.js embedded mode startup

See `bin/gateway.js` under Entry Points: embedded mode adds `startImapServer()`, `startSmtpServer()`, `startEmbeddedMailer()` and `startEmbeddedWorkers()` after the terminal servers, and wires mailer, mail servers and the embedded consumers into the gateway's maintenance watch. The worker watchdog is skipped.

---

## Scheduled / Repeatable Jobs

BullMQ repeatable jobs replace cron for recurring tasks. Registered once at startup by whichever process consumes the queue (or by a dedicated scheduler setup that runs during `gateway.js` startup in both modes).

### `src/queues/schedules.js`

`registerSchedules()` runs in the gateway at startup in both modes. Fixed schedules (maintenance queue unless noted):

| Scheduler key | Job | When |
|---------------|-----|------|
| `<job>-daily` for each `RETENTION_JOBS` entry | the purge jobs | see the maintenance table; via `ensureSchedule`, which REMOVES the schedule when the purge is switched off |
| `pm-purged-cleanup-hourly` | `pm-purged-cleanup` | `15 * * * *` |
| `scan-nodelists-daily` | `scan-nodelists` | 04:00 |
| `rotate-logs-daily` | `rotate-logs` | 23:59, `ensureSchedule` on `log_rotation_enabled` |
| `scan-echolists-daily` | `scan-echolists` | 04:15 |
| `reconcile-echolists-daily` | `reconcile-echolists` | 04:30 |
| `message-maintenance-daily` | `message-maintenance` | 04:00 |
| `update-check-daily` | `update-check` | 04:40, `ensureSchedule` on `update_check_enabled` (default off) |
| `user-maintenance-daily` | `user-maintenance` | 05:00 |
| `scan-inbound` | `scan-inbound` | every `inbound_scan_interval` s, not registered at 0 |
| `outbound-sweep` (toss) | `outbound-sweep` | every `outbound_toss_interval` min, not registered at 0 |
| `qwk-hub-sweep` (toss) | `qwk:hub-sweep` | every `qwk_hub_sweep_minutes` (5) while an active QWK hub connection has a shared-directory node (`syncQwkHubSweep`, also re-run when a QWK connection is saved or removed); removed otherwise |

Managed (per row) schedules:

| Key | Queue / job | Source |
|-----|-------------|--------|
| `poll:<uuid>` | mailer / `poll-scheduled` | active FTN connections with `poll_enabled`, not `HOLD` |
| `qwk-pull:<uuid>`, `qwk-push:<uuid>` | toss / `qwk:pull`, `qwk:push` | active QWK connections with `poll_enabled`, except `transport: 'hub'` |
| `nntp-pull:<uuid>`, `nntp-push:<uuid>` | toss / `nntp:pull`, `nntp:push` | active NNTP connections with `poll_enabled` |
| `timed-event:<id>` | maintenance / `timed-event` | active timed events with a cron pattern |
| `generate-stub:<id>` | maintenance / `generate-stub` | active coordinator segments with a schedule other than `manual` |

Intervals are read only through `scheduleFormat.connectionIntervalMinutes`: FTN stores `poll_interval`, QWK/NNTP `pull_interval_minutes`. An older sketch read `pull_interval`, which nothing writes, and saving a QWK or NNTP connection re-registered it at the default.

Schedules persist in Redis. Admin saves call the per-connection helpers in `schedules.js` directly, and `upsertJobScheduler` with the same key replaces the existing schedule. Fixed schedules are only re-applied at gateway start: `node src/tools/schedules.js --sync` covers the managed families above, not these.

### Orphan pruning

Registration is a full rebuild of the managed set, not an additive pass, and it
prunes on the way out.

The reason it has to is that registration *skips* rather than clears. A
connection whose polling is disabled is passed over, and until recently nothing
removed a schedule when a connection was deleted, so either way the scheduler
stayed in Redis firing its job for ever: a poll to a peer that no longer exists,
once per interval, with no row anywhere asking for it. Five were live on the
development box when this was written, two of them for connections that had been
deleted outright. The admin routes now maintain schedules directly, but that
only covers changes made through the UI; it does nothing about orphans a
database already carries, or a change made outside the UI.

After registering, `registerSchedules` enumerates every scheduler on the three
queues and removes the ones it did not just write. Two constraints make that
safe rather than reckless:

**The allowlist.** Only keys in a family registration owns are candidates:
`poll:`, `qwk-pull:`, `qwk-push:`, `nntp-pull:`, `nntp-push:`, `timed-event:`,
`generate-stub:`. The list lives in `scheduleFormat.MANAGED_KEY_PREFIXES` and is
shared with `src/tools/schedules.js`, so the diagnostic and the automatic sweep
cannot disagree about what is managed. Everything else is left alone, including
the fixed daily maintenance schedules, which registration writes unconditionally
and never records as managed keys. Without the allowlist, the first restart
after any bug in the expected set would silently switch off PM trash purging,
tossed packet purging and nodelist scanning, with a log line that reads like
tidying up.

**The completeness requirement.** Pruning against a partial expected set deletes
live schedules. `registerSchedules` collects managed keys as it writes them, and
the prune call sits at the end of the `try` block, so it is only reachable when
every database read succeeded. `postgres.query` throws on error rather than
returning an empty array, which is what makes that guarantee real: a failed read
leaves through the catch and the prune never runs at all.

`src/tools/schedules.js --prune` does the same thing without a restart.

### A scheduler is not a timer

It is tempting to say BullMQ "handles the timer", and that is the wrong mental model. A job scheduler creates one delayed job at a time. The next iteration is only created when a worker picks the current one up. Nothing in Redis counts down on its own.

The consequence is the important part. A worker that is stopped, or alive but no longer processing, freezes every schedule it consumes at the point it stopped. The registered intervals still read as correct, `getJobSchedulers` still returns every entry, and the admin UI still shows the configured values. The only visible difference is that `next` stops moving. A hub ran four days in exactly that state with its tosser silent and pm2 reporting the process online throughout.

So `next` in the past is not "the job ran late". It means nothing collected it, and the question is what happened to the consumer.

---

## Worker Health

The worker owns both the `toss` and `maintenance` queues, and nothing else drains them. Losing it stops all message tossing, all TIC processing, and every maintenance sweep, while every user-facing part of the system carries on normally. That combination is why it can go unnoticed for days.

Three separate failures have to be covered, and only the first is the one people think of.

| Failure | What the supervisor sees | What catches it |
|---------|--------------------------|-----------------|
| Process exits | Non-zero exit, restart | pm2, plus `exp_backoff_restart_delay` so a dependency that is slow to start does not burn the restart budget |
| Process alive, consumer closed | Online, healthy | Worker self check, exits so the supervisor restarts a clean process |
| Process alive, job never returns | Online, healthy | Job timeout, plus the heartbeat's longest-active-job figure |

The third is the one BullMQ cannot help with. Its stalled-job detection fires when a worker stops renewing a job's lock, which happens when the process dies. A job parked on an await that never settles keeps renewing its lock exactly like a healthy one, so BullMQ considers it fine while the concurrency slot is gone for good. At the default toss concurrency of three, three of those and the queue is stopped.

### Job timeouts

`bin/worker.js` wraps both queue processors in `workerHealth.withTimeout`. A job that exceeds its limit rejects, BullMQ fails and retries it, and the slot returns to circulation. The timeout rejects rather than cancels, because the underlying work cannot be cancelled; the orphaned promise is accepted as the lesser cost.

- `toss_job_timeout` (30 minutes)
- `maintenance_job_timeout` (60 minutes, higher because imports and batch subscribes legitimately run long)

Either set to 0 disables the limit for that queue.

### Heartbeat

The worker writes `canectic:health:worker` to Redis every `worker_heartbeat_interval` seconds, carrying its pid, host, uptime, per-queue consumer status, when it last finished a job, and the age of the longest job in flight. The TTL is a small multiple of the interval, so a worker that dies outright lets the key expire and reads as `missing` rather than an ever-older `stale`.

A clean shutdown writes a `stopped` marker instead. Without it the watchdog cannot tell a sysop running `pm2 stop worker` from a worker falling over, and would spend the maintenance window restarting it underneath them.

### Watchdog

`src/queues/workerWatchdog.js` runs in the gateway, because a dead gateway is obvious within minutes and a dead worker is silent. It is skipped in embedded mode, where the consumers run in the gateway's own process.

Each tick reads the heartbeat and escalates: log it, notify the sysop once per incident, then restart. The restart is last because it is the only step that can make things worse, and it is gated three ways. Nothing happens until the fault outlives `worker_health_grace`, because a worker that is itself restarting looks briefly identical to one that has died. Attempts are spaced by `worker_restart_cooldown`. After `worker_restart_max_attempts` the watchdog stops trying and leaves it to the sysop, because a worker that cannot stay up will not be fixed by restarting it a hundred times.

`worker_restart_command` defaults to `pm2 restart worker`. A bare `pm2` is resolved next to the running Node binary before falling back to PATH: under nvm the pm2 daemon may have been started from a login shell whose PATH the gateway never inherited. Sysops supervising with something else point the key at their own command, for example `systemctl --user restart canectic-worker`.

The watchdog also warns when a schedule is overdue while the worker reports healthy. That combination usually means the processes disagree about `REDIS_BULLMQ_DB`, so the gateway is registering schedules into one database while the worker consumes another, and every process reports itself perfectly well.

### The inbound backstop

`scan-inbound` runs every `inbound_scan_interval` seconds and enqueues a toss when the inbound directory holds work. In normal operation it never fires, because the mailer enqueues a toss itself the moment a binkp session receives files. It only matters when that enqueue did not happen: the worker was down, the process restarted between receipt and enqueue, or a bundle was placed by hand or recovered from a filebox.

The predicate has to match what `TossInbound` actually processes, or the backstop does not back anything up. It tested for a literal `.pkt` and nothing else, so an arcmail bundle (`.mo0`, `.tu5`, `.su9`) sat in the inbound indefinitely. Both now call `ftnTosser.isTossableInboundFile`, which covers packets and bundles by the FTS-5000 filename pattern, whatever the archive format, and leaves TIC attachments, nodelist archives and infopacks to their own processors.

### Diagnosing

```bash
node src/tools/schedules.js
```

Reports, in order: the worker's own account of itself, per-queue depth with the age of every active job, and every scheduler with its interval, next run and iteration count. The arithmetic behind it (is this scheduler late, is this job stuck) lives in `src/utils/scheduleFormat.js` so it can be tested; a CLI script cannot be. Overdue schedules, paused queues and stuck jobs are called out by name. `--sync` and `--prune` repair registration drift only; they deliberately skip overdue entries, because an overdue schedule is a consumer problem and re-registering it would look like a fix and change nothing.

### `connection_data` additions

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `poll_interval` | integer (minutes) | 60 | Mailer poll interval for FTN connections |
| `pull_interval_minutes` | integer (minutes) | 120 (QWK) / 60 (NNTP) | Toss pull/push interval |

### `peer_connections` schema additions

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `poll_enabled` | boolean | false | Whether this connection should be periodically polled. Defaults to true for non-hub QWK and NNTP on creation. Only connections with `poll_enabled = true` get BullMQ scheduled poll jobs. |

The mailer's internal `_startPollScheduling()` timer has been removed. Polling is now entirely driven by BullMQ scheduled jobs (registered in `schedules.js`) and the BSO outbound scanner (`bsoScanner.js`). The BSO scanner handles send-driven connections; scheduled polls handle receive-only polling.

---

## Migration Path

All four phases are complete; kept as history of how the split was made.

### Phase 1: Queue infrastructure + Worker process + Rename

1. Rename `bin/doorserver.js` → `bin/gateway.js`. Update any process managers, systemd units, and documentation that reference the old name.
2. Install BullMQ: `npm install bullmq`
3. Create `src/queues/` directory with `connection.js`, `queues.js`, `jobs.js`, `events.js`
4. Create `bin/worker.js` entry point
5. Refactor `src/tools/tosser.js` CLI: instead of calling tosser functions directly, it enqueues jobs via `jobs.js` and exits. The worker process does the actual work. This preserves the CLI for manual toss commands while routing through the queue.
6. Wire admin toss routes to use `jobs.js` enqueue helpers
7. Test: run `bin/gateway.js` + `bin/worker.js` side by side. Toss cycles go through the queue.

### Phase 2: Mailer process separation

8. Create `bin/mailer.js` entry point
9. Add `MAILER_WS_PORT` env var and standalone WS listener to `MailerManager`
10. Remove `MailerManager` import from `gateway.js` (non-embedded mode)
11. Replace `mailerManager.signalOutbound()` direct calls with `jobs.enqueueMailerSignalOutbound()`
12. Move mailer poll scheduling from internal timer to BullMQ repeatable jobs
13. Test: run all three processes. Mailer crash doesn't affect terminal users.

### Phase 3: Embedded mode + Schedules

14. Create `src/queues/embedded.js` with `startEmbeddedWorkers()`
15. Add `PROCESS_MODE` env var support to `gateway.js`
16. Create `src/queues/schedules.js` with `registerSchedules()`
17. Add `poll_interval` (FTN) / `pull_interval_minutes` (QWK, NNTP) to `connection_data` schema
18. Wire admin peer connection UI to update schedules on save
19. Remove cron dependency documentation, update deployment guide

### Phase 4: Real-time events

19. Wire `MESSAGES_IMPORTED` events to gateway WebSocket push (unread count badges)
20. Wire `PM_DELIVERED` events to notification push
21. Wire `MAILER_SESSION_*` events to admin dashboard (future)

---

## Environment Variables (new)

| Variable | Default | Description |
|----------|---------|-------------|
| `PROCESS_MODE` | `separate` | `separate` = gateway only; `embedded` = all-in-one |
| `REDIS_BULLMQ_DB` | `2` | Redis database number for BullMQ job data |
| `WORKER_CONCURRENCY` | `3` | Toss queue concurrency in `bin/worker.js` |
| `MAILER_WS_PORT` | `24555` | WebSocket listener port for mailer (separate mode) |
| `MAILER_BINKP_PORT` | `24554` | TCP listener port for binkp (now in mailer process) |

Existing variables unchanged: `webport`, `MAILER_ENABLED`, `redis_url`, `REDIS_PASSWORD` (fallback only). Retention days such as `pm_trash_retention_days` are appConfig keys, not environment variables.

---

## NPM Dependencies (new)

| Package | Purpose |
|---------|---------|
| `bullmq` | Job queue — durable jobs, repeatable schedules, retry, concurrency |
| `ioredis` | Redis client (peer dependency of BullMQ, may already be in stack via existing Redis usage) |

BullMQ uses the existing Redis instance. No new infrastructure required.

---

## Maintenance Mode

Closes the board to everyone but the sysop and drains it: new work refused in
every process, in-flight work finished or ended at the grace deadline, and each
process reporting what it still holds so the admin page, the CLI and the
updater can tell when it is quiet. Sysop guide: `docs/sysop/MAINTENANCE.md`.

### The flag is a file

`.maintenance` at the install root (JSON: `since`, `reason`, `expected_minutes`,
`grace_seconds`, `set_by`, `source` manual/update, `run_id`). Not a config row,
because the database may be what is being worked on. Presence is the flag: an
unreadable or empty file still closes the board. Re-entering keeps `since`, so
editing the reason does not restart anybody's countdown. Written atomically
(temp name + rename).

`src/maintenance/maintenanceFlag.js` owns the file, the drain status files and
the pure rules (`deadlineOf`, `assessDrain`, `drainVerdict`, `waitForDrain`).
It, `maintenanceWatch.js` and the CLI `src/tools/maintenanceMode.js` are held to
Node builtins by `tests/installPath.test.js`: the CLI is for when the gateway
will not start.

### How a process follows it

`MaintenanceWatch` (one per process, `initMaintenanceWatch`) stats the flag
every 2s and emits `enter`, `change`, `leave` and `deadline` (once per closure,
when `since + grace` passes). Subsystems register **drain sources**, functions
returning `{label: count}`; while the flag is set the watcher sums them into
`tmp/maintenance/<process>.json` each tick. A source that throws counts as not
drained. Polling rather than `fs.watch` or Redis pub/sub: nothing else watches
files, and the flag must work with Redis or PostgreSQL down.

Two ordering rules, both learned the hard way in design:

- **A process starting on a closed board must not take work before the first
  tick.** Queue consumers are created with `autorun: false` and paused
  (`queueDrain.startClosed()`), the mailer and mail servers get
  `setMaintenance(true)` before `start()`.
- **The gateway creates its watcher early and starts it last.** Until the first
  tick, `current()` reads the file directly without firing events, so a request
  during startup is answered correctly and no late subscriber misses `enter`.

`assessDrain` counts only statuses written for the current `since` (a leftover
from an earlier closure says nothing about now) and treats a status older than
15s as a stopped process, which has nothing in flight. `drainVerdict` refuses to
believe "drained" until 6s after the flag appeared, so every process has ticked.

### Per process

| Process | New work | In flight | Drain source |
|---|---|---|---|
| gateway (terminal) | refused in each connection class's `announceConnection`, before `createCall` allocates a node (`terminalDrain.refuseNewCaller`) | bottom-line countdown with CSI s/u, reminders at 60s and 15s, `hangUpCall()` at the deadline | connected calls |
| gateway (web) | `maintenanceWeb.js` middleware after static and CSRF, before activity tracking: anonymous gets the 503 maintenance page, `/api` a JSON 503, non-sysop login refused | logged-in users get a presence `maintenance` push plus a notification (`webDrain.js`), a server-rendered banner on page loads during the grace, then the page | none: web users are told, not waited for |
| mail | IMAP greets `* BYE`, SMTP answers `421 4.3.2` (untrusted hosts still get 554) | `closeSessionsForMaintenance()` at the deadline | IMAP + SMTP sessions |
| mailer | inbound `M_BSY`; `_connectToPeer` and `connectToNodelistAddress` refuse (even forced); BSO scanner skips; mailer queue paused | sessions finish; `endSessionsForMaintenance()` at the deadline | sessions + dials not yet sessions (expire after the connect timeout) |
| worker | toss and maintenance consumers `pause()`d, new jobs wait in Redis | active jobs finish | `_activeJobs` per queue |

Embedded mode wires the same pieces inside the gateway (`startMaintenanceWatch`
in `bin/gateway.js`), with queue active counts from `Queue.getActiveCount()`.

**BullMQ `pause()` ends the main loop, so `isRunning()` is false while paused.**
Three things read that as a dead consumer and had to learn otherwise: the
worker self-check (`queueDrain.consumerUp`), `assessWorker` (new `STATE_PAUSED`,
after the stall check so a wedged job stays visible), and the watchdog's
schedule-lag warning (skipped while paused, since a paused worker freezes
schedules by design).

### The updater

`runUpdate` enters maintenance (`source: update`, `run_id`) before `preflight`,
so the grace overlaps the backup. Inside `stop`, before the stop command, it
waits via `waitForDrain` (an injectable seam) for at most the rest of the grace
plus `update_drain_timeout`; a timeout is a warning, not a failure. It reopens
the board only after `verify`. A failure in `preflight`/`backup`
(`REOPEN_ON_FAILURE`) changed nothing and reopens; anything later, including a
failed stop command, leaves the board closed with a warning. A closure the sysop
set before the run is restored rather than cleared. The drain lives inside the
existing `stop` phase rather than a new phase because the run file is created by
the OLD release's phase list.

Processes that predate maintenance mode never report, so the first update into
it gets `nobody` after the 20s no-report window and proceeds.

### The progress page while the BBS is stopped (#53)

Between the stop and the start, `runUpdate` serves the board's web port itself
(`updateStatusServer.js`): the SAME port as the gateway (`webport`, resolved
before the dependencies phase), so it works behind a reverse proxy unchanged.
Sysops get the progress page, everybody else the gateway's maintenance page as a
503, WebSocket upgrades a 503. The page is rendered by `updateProgress.js`,
which the gateway also serves at `/admin/update/progress`, and polls that path
and swaps its content in, so it carries on whichever server answers.

- **Who is a sysop** comes from `tmp/maintenance/sysop-sessions.json`, written
  ONCE by the gateway in `POST /admin/update/apply` before it stages anything
  (`maintenanceWeb.recordSysopSessions`), holding SHA-256s of sysop session ids
  and the run id. The updater cannot use the session store: it is the new
  release's code on the old release's packages, and the packages are replaced
  mid-run. A file for another run is ignored. CLI-launched updates record none.
- **Builtins only**: the listener, the renderer and the session file module run
  while node_modules is replaced; enforced by `installPath.test.js`.
- **Non-blocking commands**: the updater now runs commands through
  `runCommandAsync` / `spawnAsync` (updateCommands.js) and the dump through
  `spawnAsync`, because `spawnSync` would freeze the listener for all of npm
  install, the dump and the migration. `runCommand` stays for the installer.
- **Lifecycle**: bound after the stop command (retrying `EADDRINUSE` for a few
  seconds), closed before the start command and before the restart after a
  failure, and in a `finally`. Closing tears down open connections, because
  `server.close()` waits for a half-received request up to the header timeout
  and the start is awaited behind it. A bind failure never fails the update.
  Not started when process control is off, since nobody would say when the
  gateway lets go. `update_progress_page` turns it off.

## Failure Scenarios

| Scenario | Impact | Recovery |
|----------|--------|----------|
| Gateway crash | Terminal users disconnect, web UI unavailable | Restart gateway. In-flight toss and mailer jobs continue unaffected. Queued jobs are durable. |
| Mailer crash | Active file transfer sessions drop. Remote peers retry on next poll. | Restart mailer. Queued mailer jobs process on restart. No messages lost. |
| Worker crash | In-progress toss job fails | BullMQ retries with exponential backoff. HWM-based tossers resume from last committed position. No messages lost or duplicated. |
| Redis crash | All queue processing stops. No new jobs enqueued. | Gateway continues serving existing connections (HTTP/WS still work). Mailer continues active sessions but can't accept new signals. On Redis recovery, all processes reconnect automatically (ioredis reconnect). Repeatable schedules resume. |
| PostgreSQL crash | All processes affected (can't read/write data) | All processes reconnect via pgpool retry. No structural damage — jobs retry after DB recovery. |

---

## Key Design Decisions

1. **Three processes, not two**: Separating the mailer from the worker (rather than combining them) means a tosser bug processing a malformed QWK packet can't disrupt active binkp sessions in progress. Each has distinct resource profiles — the mailer is I/O-bound with concurrent streams; the worker is CPU-bound with batch processing.

2. **BullMQ over raw Redis pub/sub for jobs**: Jobs need durability (survive process restarts), retry with backoff, concurrency control, and deduplication. Raw pub/sub loses messages when the subscriber is down. BullMQ provides all of this on top of the existing Redis instance with no additional infrastructure.

3. **Raw Redis pub/sub for events**: Notifications (unread counts, session status) are fire-and-forget. Missing one is fine — the UI refreshes on next interaction. Using BullMQ jobs for ephemeral notifications would waste Redis memory on job records that have no retry value.

4. **Separate Redis DB for BullMQ**: Keeps job keys isolated from session data and flash messages. Allows independent `FLUSHDB` of job data during development without losing user sessions.

5. **jobId-based deduplication over custom locking**: BullMQ rejects duplicate jobIds while one is active. This is simpler and more reliable than maintaining lock keys in Redis manually. The convention of `${jobName}--${connectionUUID}` as jobId naturally prevents concurrent toss operations against the same peer. Note: BullMQ disallows colons in custom job IDs, so `--` is used as the delimiter.

6. **Gateway as schedule registrar**: Schedules are registered by the gateway at startup because the gateway always runs and has access to the admin UI for schedule updates. The worker and mailer are pure consumers — they don't need to know about schedules, just process jobs when they arrive.

7. **Embedded mode shares the same enqueue path**: Business logic always calls `jobs.enqueueXxx()`. Whether the consumer is in-process or separate is invisible to the caller. This means embedded mode is not a separate code path — it's the same queue with co-located consumers.

8. **Mailer owns its own WebSocket port in separate mode**: Rather than proxying through the gateway (added complexity, shared failure domain), the mailer binds its own HTTP listener for WebSocket transport. This is consistent with the transport-agnostic design — adding a listener is just another transport binding. A reverse proxy (HAProxy, nginx) can unify external endpoints if needed — see Reverse Proxy Configuration below.

9. **CLI tools become queue producers**: `src/tools/tosser.js` and `src/tools/maintenance.js` shift from doing work directly to enqueuing jobs and optionally waiting for completion. This eliminates the PID-file locking mechanism — BullMQ's jobId deduplication handles concurrency. The CLI tools become thin wrappers that create a job, wait for the `completed` event, and report the result.

10. **Worker concurrency of 3 for toss, 1 for maintenance**: Toss jobs for different connections/protocols can safely run in parallel (separate HWMs, separate directories). Maintenance jobs are sequential to avoid overlapping DB-heavy operations. The toss value is `WORKER_CONCURRENCY`; embedded mode uses 2.

11. **`connection_data` absorbs schedule config**: Poll and pull intervals live alongside existing per-connection settings rather than in a separate scheduling table. This keeps the one-place-to-configure-a-peer principle from the mailer architecture.

12. **QWK/NNTP transport stays in the worker, not the mailer**: QWK FTP/SFTP transfers and NNTP article pulls are short-lived request/response operations, not persistent listening sessions. They don't benefit from the mailer's concurrent session management. Keeping transport and toss together in the worker preserves atomic HWM semantics — the pointer advances only after a successful import, with no coordination needed between processes. See "QWK/NNTP Transport Separation and HWM Consistency" for the full analysis.

---

## Reverse Proxy Configuration

In separate mode, three services expose network ports:

| Service | Port | Protocol | Purpose |
|---------|------|----------|---------|
| Gateway | `webport` (default 8080) | HTTP + WebSocket upgrade | Web UI, terminal WebSocket pools |
| Mailer | `MAILER_BINKP_PORT` (default 24554) | Raw TCP | binkp FTN sessions |
| Mailer | `MAILER_WS_PORT` (default 24555) | HTTP + WebSocket upgrade | WebSocket mailer transport |
| Gateway | `qwk_ftp_port` (default 8021, only with `qwk_ftp_enabled`) | FTP | QWK hub FTP server, plus passive ports (`qwk_ftp_pasv_ports`) |

A reverse proxy fronting the gateway and mailer WebSocket ports allows unified external endpoints on standard ports (443 for HTTPS/WSS) and TLS termination. The binkp TCP port is typically exposed directly (binkd peers expect raw TCP on a known port) or via a TCP-mode proxy.

Detailed proxy configuration examples for HAProxy and nginx will be documented in the deployment guide. Key considerations:

- **WebSocket upgrade handling**: Both HAProxy and nginx require explicit configuration to pass `Upgrade: websocket` headers. The gateway and mailer WS ports both need this.
- **Path-based routing**: The gateway serves both HTTP routes and WebSocket upgrades on the same port, differentiated by path (`/ws/bbs` for general terminal connections, `/ws/doorserver` for door game clients, `/` as catchall). The proxy must pass the path through unchanged.
- **Mailer WS as separate backend**: In HAProxy terms, the mailer WS port is a separate backend from the gateway. Route by SNI, path prefix, or subdomain depending on topology.
- **TCP mode for binkp**: binkp is a raw binary protocol. HAProxy's TCP mode (`mode tcp`) or nginx's `stream` block passes it through without HTTP parsing.
- **Health checks**: The gateway exposes HTTP routes that can serve as health endpoints. The mailer and worker processes can expose a minimal HTTP health route or rely on process-level checks.
- **Timeouts**: Mailer binkp sessions and file transfers can run for extended periods. Set proxy timeouts accordingly (HAProxy `timeout server`/`timeout tunnel`, nginx `proxy_read_timeout`). WebSocket connections for terminal sessions are long-lived — default proxy timeouts will kill them.

### Embedded mode

In embedded mode, only the gateway's `webport` is exposed. The mailer WS pool registers on the gateway's HTTP server at `/ws/mailer/binkp` (same upgrade handler, different path). The binkp TCP listener is still separate. Proxy configuration is simpler: one HTTP backend plus one TCP backend.

---

## Rename: `doorserver.js` → `gateway.js`

The original `bin/doorserver.js` is renamed to `bin/gateway.js` to reflect its role as the user-facing gateway process. All three entry points follow a consistent naming convention:

| File | Process | Role |
|------|---------|------|
| `bin/gateway.js` | Gateway | User connections, web UI, job producer |
| `bin/mailer.js` | Mailer | FTN mailer sessions, file transfer |
| `bin/worker.js` | Worker | Tossers, maintenance, batch processing |

Items to update when renaming:

- Process manager configuration (pm2 ecosystem file, systemd unit, etc.)
- Any shell scripts or cron entries that reference `doorserver.js`
- The `wspaths` array inside the file — the `/ws/doorserver` path is unchanged; it's a functional endpoint for doorserver (door game) clients, not named after the entry point file. `/ws/bbs` is the general-purpose gateway WebSocket path.
- Documentation references in other architecture docs (now updated — `MAILER_ARCHITECTURE.md` references use `bin/gateway.js` and `bin/mailer.js`)
- The `systemstartupmsg` / `systemshutdownmsg` strings if they reference the old name

---

## Future: Web/Terminal Process Separation

The current gateway process handles both HTTP web routes and WebSocket terminal sessions on a single Node.js event loop. This means web traffic (page renders, API calls, crawler load) competes for CPU time with terminal sessions (door I/O, ANSI rendering).

### The problem

A web crawler hitting every page triggers Express route handlers, Pug template compilation, and database queries -- all on the same event loop that services terminal WebSocket frames. Under heavy web load, terminal sessions could experience increased latency or dropped frames.

### Why it's hard to split

Terminal WebSocket connections use HTTP upgrade on the same Express server that handles web routes. The `WsManager` dispatches upgrades by path (`/ws/bbs`, `/ws/doorserver`, `/ws/legacy`, `/ws/presence`, `/ws/nodespy`) from a single `httpServer.on('upgrade')` handler. Splitting requires one of:

1. **Separate ports**: Terminal WebSocket on port A, web HTTP on port B. Simple but exposes two ports and breaks the single-URL model. Users and reverse proxies need to know about both.

2. **Reverse proxy path routing**: nginx/HAProxy routes `/ws/*` to a terminal process and everything else to a web process. Both processes need shared state (nodeManager, presence, chat) via Redis. The in-memory sharing that makes NodeSpy, sysop chat, and who's online seamless would need to be replaced with Redis-backed equivalents.

3. **Worker threads**: The web server runs in a worker thread while the main thread handles WebSocket I/O. Threads can't share sockets directly, so WebSocket handling stays on the main thread. Template rendering and route handling move to the worker. Communication via `MessageChannel`. This preserves the single-port model but adds complexity.

### Recommended approach (when needed)

Option 2 (reverse proxy routing) with Redis shared state is the most production-ready path. It extends the existing four-process model to five:

- **Web process**: Express routes, template rendering, static files
- **Terminal process**: WebSocket pools, CallManager, NodeManager, SocatManager
- **Worker, Mailer, Mail**: unchanged

The terminal process would own all WebSocket endpoints and the in-memory state (node registry, ring buffers, chat). The web process would read state from Redis (presence, online users) and enqueue actions via BullMQ. This is essentially the same separation the mail process already demonstrates.

The trigger for building this would be observable event loop latency on the gateway under web load -- measurable via `process.hrtime()` or the `perf_hooks` module. Until then, the single gateway is simpler and sufficient.

### Design guideline: split-friendly by default

New features that share state between web views and terminal sessions should use Redis rather than in-memory data structures. This avoids deepening the in-memory coupling that makes the split harder.

**Already split-friendly (Redis-backed):**
- Web presence and activity tracking (`webActivity.js`)
- Chat sessions and message history (`presenceSocket.js`)
- Session management (`sessionstore.js`)
- Configuration (`appConfig.js` via PostgreSQL + Redis pub/sub invalidation)
- Job queues and schedules (BullMQ/Redis)

**Would need migration for split:**
- `NodeManager` node registry (in-memory Map)
- `OutputRingBuffer` per call (in-memory, used by NodeSpy snoop)
- `CallManager`/`CallPool` (in-memory session tracking)

The node registry and call tracking are tightly coupled to real-time terminal I/O and benefit from in-memory speed. Moving them to Redis would add latency to every terminal frame. The likely approach is that the terminal process keeps these in-memory and exposes a lightweight API (Redis pub/sub or HTTP) for the web process to query. The web process doesn't need frame-level access -- it just needs presence info and node status, which can be published at lower frequency.
