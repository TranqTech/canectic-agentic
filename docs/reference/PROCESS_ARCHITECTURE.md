# Canectic BBS — Process Architecture & Job Queue Reference

## Overview

The system runs as three independent OS processes sharing PostgreSQL and Redis. Each process can crash and restart without affecting the others. A BullMQ job queue (backed by the existing Redis instance) handles all inter-process communication.

For the shared message platform (schemas, read tracking, body_html pipeline, posting), see `message_architecture.md`.
For the networking/tosser stack (FTN, QWK, NNTP), see `NETWORKING_ARCHITECTURE.md`.
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
│  TIC processor (future)    │       │
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

**Owns:** HTTP server, WsManager, WsPool instances, CallManager, CallPools, SocatManager, NodeManager, Express routes.

**Does not own:** Tosser logic, mailer sessions, maintenance tasks. These are no longer imported or executed in this process.

**Queue role:** Producer only (enqueues jobs when user actions or admin commands require background processing) and event subscriber (receives notifications from workers for real-time UI updates).

### Process 2 — Mailer (`bin/mailer.js`)

Manages FTN mailer sessions — both inbound (listening for connections) and outbound (poll-based and triggered). Binds its own TCP port for binkp and its own HTTP port for WebSocket mailer connections.

**Owns:** MailerManager, TCP listener, WebSocket listener (own port), session pool, transport/protocol/transfer layers.

**Does not own:** User connections, web UI, tosser processing, door games. Loads its own pgpool and Redis connection. Loads NodeManager read-only for peer connection config.

**Queue role:** Consumer of `mailer` queue (poll triggers, outbound signals). Producer of `toss` queue jobs (when inbound files arrive). Event publisher (session status, transfer progress for future admin dashboard).

### Process 3 — Worker (`bin/worker.js`)

Stateless batch processor. Runs toss cycles, maintenance tasks, and future TIC processing. Can be stopped and restarted freely — BullMQ resumes incomplete jobs with retry.

**Owns:** Tosser modules (ftnTosser, qwkTosser, nntpTosser), maintenance functions. Loads its own pgpool and Redis connection.

**Does not own:** Network listeners, user sessions, mailer sessions.

**Queue role:** Consumer of `toss` and `maintenance` queues. Producer of `mailer` queue jobs (signal outbound after FTN toss). Event publisher (import completion notifications with affected area shortcodes).

---

## Shared Resources

### What each process loads independently

| Resource | Gateway | Mailer | Worker |
|----------|---------|--------|--------|
| pgpool (own connection pool) | ✓ | ✓ | ✓ |
| Redis (own ioredis instance) | ✓ | ✓ | ✓ |
| BullMQ connection | ✓ | ✓ | ✓ |
| NodeManager (read-only config) | ✓ | ✓ | ✗ |
| dotenv / env config | ✓ | ✓ | ✓ |
| appConfig singleton (own instance) | ✓ | ✓ | ✓ |

### What is NOT shared across processes

| Resource | Lives in |
|----------|----------|
| WsManager, WsPool, CallPool | Gateway only |
| SocatManager | Gateway only |
| Express app / routes | Gateway only |
| MailerManager, sessions | Mailer only |
| Tosser modules | Worker only |

### Filesystem (shared via disk)

- `ftn/in/` — mailer writes received files, worker reads and processes them
- `ftn/out/` — worker writes outbound packets, mailer reads and sends them
- `cwd/qnet/` — worker reads/writes QWK exchange directories
- `logs/` — each process writes to its own log files (or tagged entries)

No process writes to another process's output directory. The mailer writes to inbound; the worker reads from inbound. The worker writes to outbound; the mailer reads from outbound. Filesystem is the boundary — same convention as the existing "mailer does not toss" design principle.

---

## Queue Topology

Three BullMQ queues, each with named job types. All share the same Redis instance.

### `toss` queue

| Job name | Producer | Consumer | Payload | Notes |
|----------|----------|----------|---------|-------|
| `ftn:inbound` | Mailer (after file receive), Admin (manual toss) | Worker | `{ connectionUUID?, sourceDir? }` | Process .pkt files from inbound directory |
| `ftn:outbound` | Gateway (after user post), Admin (manual toss) | Worker | `{ connectionUUID? }` | Gather and pack outbound echomail/netmail |
| `qwk:pull` | Scheduler (repeatable), Admin | Worker | `{ connectionUUID }` | Pull .qwk from remote hub |
| `qwk:push` | Scheduler (repeatable), Admin | Worker | `{ connectionUUID }` | Build and upload .rep to remote hub |
| `qwk:hub:inbound` | Gateway (node drops .rep) | Worker | `{ connectionUUID }` | Process inbound .rep from hub node |
| `nntp:pull` | Scheduler (repeatable), Admin | Worker | `{ connectionUUID }` | Pull articles from NNTP server |
| `nntp:push` | Scheduler (repeatable), Admin | Worker | `{ connectionUUID }` | Post local messages to NNTP server |
| `tic:inbound` | Mailer (after file receive), Admin, CLI | Worker | `{ connectionUUID?, sourceDir? }` | Process inbound .tic files and attached files |
| `tic:outbound` | Upload handler (networked area), tic:inbound (forwarding), Admin, CLI | Worker | `{ connectionUUID? }` | Build TIC descriptors and stage outbound files |

### `mailer` queue

| Job name | Producer | Consumer | Payload | Notes |
|----------|----------|----------|---------|-------|
| `signal-outbound` | Worker (after FTN outbound toss) | Mailer | `{ connectionUUID }` | Triggers immediate poll for CRASH connections (legacy, being replaced by `bso-scan`) |
| `trigger-poll` | Admin (manual) | Mailer | `{ connectionUUID }` | Force a session regardless of outbound state |
| `poll-scheduled` | Scheduler (repeatable) | Mailer | `{ connectionUUID }` | Regular poll cycle for NORMAL connections |
| `bso-scan` | Worker (after outbound toss), Admin, CLI | Mailer | `{}` | Triggers immediate BSO directory scan; discovers all pending outbound mail and resolves routes |

### `maintenance` queue

| Job name | Producer | Consumer | Payload | Notes |
|----------|----------|----------|---------|-------|
| `regen-html` | Admin, Scheduler | Worker | `{ areas?, batchSize?, forceWidth? }` | Regenerate body_html |
| `regen-pm-html` | Admin, Scheduler | Worker | `{ batchSize?, forceWidth? }` | Regenerate PM body_html |
| `purge-pm-trash` | Scheduler (repeatable) | Worker | `{ days? }` | Hard-delete old soft-deleted PMs |
| `recalc-area-counts` | Admin | Worker | `{}` | Recalculate all area message counts |
| `import-nodelist` | Admin, CLI | Worker | `{ filePath, networkId }` | Import FTN nodelist file into ftn_nodelist table |
| `scan-inbound` | Scheduler (repeatable, default 300s) | Worker | `{}` | Backstop scan of FTN inbound dir for unprocessed .pkt/.tic files |
| `scan-nodelists` | Scheduler (daily 4AM) | Worker | `{}` | Auto-import nodelists from configured file areas |
| `regen-file-desc-html` | Admin, CLI | Worker | `{ batchSize? }` | Regenerate long_desc_html for file entries |
| `recalc-file-counts` | Admin | Worker | `{}` | Recalculate file_count/total_bytes for all file areas |
| `scan-file-area` | Admin, CLI | Worker | `{ areaShortcode }` | Scan file area directory for untracked files |

### Concurrency and deduplication

- **Per-connection locking on toss jobs**: Two `qwk:pull` jobs for the same connectionUUID must not run concurrently (would double-download from the same FTP host). Use BullMQ's `jobId` set to `qwk-pull--${connectionUUID}` — duplicate job IDs are rejected while one is active. Same pattern for `nntp:pull`, `qwk:push`, `nntp:push`.
- **FTN inbound is safe to overlap**: Multiple `ftn:inbound` jobs can run if they process different files. The existing move-after-toss pattern prevents double-processing.
- **FTN outbound needs per-connection isolation**: HWM advancement must not race. Use `ftn-outbound--${connectionUUID}` as jobId.
- **Maintenance jobs are single-instance**: Use jobId deduplication. Only one `regen-html` at a time.
- **Mailer poll deduplication**: `signal-outbound--${connectionUUID}` and `poll-scheduled--${connectionUUID}` as jobIds prevent queuing multiple polls for the same peer while one is already active/waiting.

---

## Shared Queue Infrastructure

### File layout

```
src/
  queues/
    connection.js    — shared BullMQ connection factory
    queues.js        — queue definitions (toss, mailer, maintenance)
    jobs.js          — job enqueue helpers
    events.js        — cross-process event constants and pub/sub helpers
    workers/
      toss.js        — toss queue processor registrations
      mailer.js      — mailer queue processor registrations
      maintenance.js — maintenance queue processor registrations
```

### `connection.js` — BullMQ connection factory

Each process creates its own ioredis connection for BullMQ. The connection config comes from the existing Redis env vars (`REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, etc.).

```javascript
import IORedis from 'ioredis';

export function createQueueConnection() {
    return new IORedis({
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: parseInt(process.env.REDIS_PORT) || 6379,
        password: process.env.REDIS_PASSWORD || undefined,
        db: parseInt(process.env.REDIS_BULLMQ_DB) || 2,
        maxRetriesPerRequest: null,  // required by BullMQ
    });
}
```

Using a separate Redis DB (`REDIS_BULLMQ_DB`, default 2) keeps job data isolated from session data and flash messages on the default DB. Same Redis instance, no extra infrastructure.

### `queues.js` — Queue definitions

Imported by any process that needs to enqueue or consume jobs.

```javascript
import { Queue } from 'bullmq';
import { createQueueConnection } from './connection.js';

const connection = createQueueConnection();

export const tossQueue = new Queue('toss', {
    connection,
    defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 500 },
    }
});

export const mailerQueue = new Queue('mailer', {
    connection,
    defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'fixed', delay: 10000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 200 },
    }
});

export const maintenanceQueue = new Queue('maintenance', {
    connection,
    defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 100 },
    }
});
```

### `jobs.js` — Enqueue helpers

Thin wrappers that enforce jobId conventions for deduplication. These are what the gateway routes, worker processors, and mailer call to produce jobs.

```javascript
import { tossQueue, mailerQueue, maintenanceQueue } from './queues.js';

// --- Toss jobs ---

export async function enqueueFtnInbound(opts = {}) {
    return tossQueue.add('ftn:inbound', {
        connectionUUID: opts.connectionUUID || null,
        sourceDir: opts.sourceDir || null,
    }, {
        jobId: opts.connectionUUID
            ? `ftn-inbound--${opts.connectionUUID}`
            : `ftn-inbound--${Date.now()}`,
    });
}

export async function enqueueFtnOutbound(connectionUUID) {
    return tossQueue.add('ftn:outbound', { connectionUUID }, {
        jobId: `ftn-outbound--${connectionUUID}`,
    });
}

export async function enqueueQwkPull(connectionUUID) {
    return tossQueue.add('qwk:pull', { connectionUUID }, {
        jobId: `qwk-pull--${connectionUUID}`,
    });
}

export async function enqueueQwkPush(connectionUUID) {
    return tossQueue.add('qwk:push', { connectionUUID }, {
        jobId: `qwk-push--${connectionUUID}`,
    });
}

export async function enqueueQwkHubInbound(connectionUUID) {
    return tossQueue.add('qwk:hub:inbound', { connectionUUID }, {
        jobId: `qwk-hub-inbound--${connectionUUID}`,
    });
}

export async function enqueueNntpPull(connectionUUID) {
    return tossQueue.add('nntp:pull', { connectionUUID }, {
        jobId: `nntp-pull--${connectionUUID}`,
    });
}

export async function enqueueNntpPush(connectionUUID) {
    return tossQueue.add('nntp:push', { connectionUUID }, {
        jobId: `nntp-push--${connectionUUID}`,
    });
}

// --- Mailer jobs ---

export async function enqueueMailerSignalOutbound(connectionUUID) {
    return mailerQueue.add('signal-outbound', { connectionUUID }, {
        jobId: `signal-outbound--${connectionUUID}`,
    });
}

export async function enqueueMailerTriggerPoll(connectionUUID) {
    return mailerQueue.add('trigger-poll', { connectionUUID }, {
        jobId: `trigger-poll--${connectionUUID}`,
    });
}

// --- Maintenance jobs ---

export async function enqueueRegenHtml(opts = {}) {
    return maintenanceQueue.add('regen-html', {
        areas: opts.areas || null,
        batchSize: opts.batchSize || 100,
        forceWidth: opts.forceWidth || null,
    }, {
        jobId: 'regen-html',
    });
}

export async function enqueueRegenPmHtml(opts = {}) {
    return maintenanceQueue.add('regen-pm-html', {
        batchSize: opts.batchSize || 100,
        forceWidth: opts.forceWidth || null,
    }, {
        jobId: 'regen-pm-html',
    });
}

export async function enqueuePurgePmTrash(days) {
    return maintenanceQueue.add('purge-pm-trash', {
        days: days || parseInt(process.env.pm_trash_retention_days) || 30,
    }, {
        jobId: 'purge-pm-trash',
    });
}
```

### `events.js` — Cross-process notifications

Lightweight pub/sub for real-time notifications that don't need job durability. Uses BullMQ's built-in event system via `QueueEvents`, or falls back to raw Redis pub/sub for simple fire-and-forget notifications.

```javascript
import IORedis from 'ioredis';
import { createQueueConnection } from './connection.js';

const CHANNEL = 'canectic:events';

// Event types
export const EVENTS = {
    MESSAGES_IMPORTED: 'messages:imported',
    PM_DELIVERED: 'pm:delivered',
    MAILER_SESSION_START: 'mailer:session:start',
    MAILER_SESSION_END: 'mailer:session:end',
    MAILER_TRANSFER_PROGRESS: 'mailer:transfer:progress',
    TOSS_COMPLETE: 'toss:complete',
    CONFIG_CHANGED: 'config:changed',
};

export function createEventPublisher() {
    const redis = createQueueConnection();
    return {
        publish(eventType, data) {
            redis.publish(CHANNEL, JSON.stringify({ type: eventType, data, ts: Date.now() }));
        },
        shutdown() { redis.disconnect(); }
    };
}

export function createEventSubscriber(handler) {
    const redis = createQueueConnection();
    redis.subscribe(CHANNEL);
    redis.on('message', (channel, message) => {
        try {
            const event = JSON.parse(message);
            handler(event);
        } catch (err) {
            // malformed event — ignore
        }
    });
    return {
        shutdown() { redis.unsubscribe(CHANNEL); redis.disconnect(); }
    };
}
```

Usage — worker publishes after an FTN inbound toss:

```javascript
eventPublisher.publish(EVENTS.MESSAGES_IMPORTED, {
    areas: ['GENERAL', 'DOVE-CHAT'],
    messageCount: 47,
    source: 'ftn',
});
```

Gateway subscribes and pushes to connected WebSocket clients:

```javascript
const eventSub = createEventSubscriber((event) => {
    if (event.type === EVENTS.MESSAGES_IMPORTED) {
        // push unread count updates to connected web/terminal users
        // (wired to WsPool broadcast or per-user push)
    }
});
```

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
- Currently HWM advances inside `buildQwkForNode()`. Future improvement: return the HWM data without advancing, let the caller confirm delivery (node actually picked up the file), then advance. This is noted in `NETWORKING_ARCHITECTURE.md` as a future item

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

### `bin/gateway.js` — Gateway (renamed from `doorserver.js`)

Removes all tosser and maintenance imports. Removes `MailerManager` import. Adds BullMQ queue imports for producing jobs and subscribing to events.

Key changes from the current file:

```javascript
// REMOVED:
// import {MailerManager} from "../src/mailer/manager.js"
// (mailer runs in its own process now)

// ADDED:
import { tossQueue, mailerQueue, maintenanceQueue } from "../src/queues/queues.js"
import * as jobs from "../src/queues/jobs.js"
import { createEventSubscriber, EVENTS } from "../src/queues/events.js"

// ADDED — optional embedded mode:
import { startEmbeddedWorkers } from "../src/queues/embedded.js"
```

The `startMailerManager()` function is removed. In its place, if `PROCESS_MODE=embedded`, the gateway starts embedded worker and mailer processors (see Embedded Mode below).

The `process.on('SIGINT')` handler no longer calls `mailerManager.stop()`. It drains any embedded workers if in embedded mode, and closes its own BullMQ connections.

The event subscriber starts in `main()` after the web server is up, listening for `MESSAGES_IMPORTED` and `PM_DELIVERED` events to push real-time updates.

### `bin/mailer.js` — Mailer process

New entry point. Structurally similar to `gateway.js` but much simpler — no HTTP routes, no WsManager call pools, no socat.

```javascript
import * as dotenv from 'dotenv';
import * as alogger from "../src/utils/alogger.js"
import * as systeminfo from "../src/utils/systeminfo.js"
import { pgpool } from "../src/middleware/db/postgres.js"
import * as redis from "../src/middleware/db/redis.js"
import { MailerManager } from "../src/mailer/manager.js"
import { nodeManager } from "../src/managers/nodemanager.js"
import { createQueueConnection } from "../src/queues/connection.js"
import { Worker } from 'bullmq';
import * as jobs from "../src/queues/jobs.js"
import { createEventPublisher, EVENTS } from "../src/queues/events.js"

dotenv.config();

const systemvermsg = systeminfo.versionMsg();
var mailerManager;
var mailerWorker;
var eventPublisher;

process.on('uncaughtException', (err) => {
    alogger.writeAlog(0, `[Mailer] Uncaught exception: ${err.stack}`, "redbright");
});

process.on('unhandledRejection', (reason) => {
    alogger.writeAlog(0, `[Mailer] Unhandled rejection: ${reason}`, "redbright");
});

process.on('SIGINT', async () => {
    alogger.writeAlog(1, "[Mailer] Shutting down", "yellowbright", true);
    if (mailerManager) mailerManager.stop();
    if (mailerWorker) await mailerWorker.close();
    if (eventPublisher) eventPublisher.shutdown();
    pgpool.end();
    redis.shutdown();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    if (mailerManager) mailerManager.stop();
    if (mailerWorker) await mailerWorker.close();
    process.exit(0);
});

async function main() {
    alogger.writeAlog(1, systemvermsg + "\n  Mailer Process Startup", "yellowbright", true);

    // Load node config (read-only)
    const nm = new nodeManager();
    nm.listUsedNodes();

    // Start event publisher
    eventPublisher = createEventPublisher();

    // Start mailer
    mailerManager = new MailerManager();
    mailerManager.eventPublisher = eventPublisher;
    mailerManager.start();

    // Consume mailer queue
    const connection = createQueueConnection();
    mailerWorker = new Worker('mailer', async (job) => {
        switch (job.name) {
            case 'signal-outbound':
                alogger.writeAlog(2, `[Mailer] Signal outbound: ${job.data.connectionUUID}`, "cyan");
                await mailerManager.signalOutbound(job.data.connectionUUID);
                break;

            case 'trigger-poll':
                alogger.writeAlog(2, `[Mailer] Trigger poll: ${job.data.connectionUUID}`, "cyan");
                await mailerManager.triggerPoll(job.data.connectionUUID);
                break;

            case 'poll-scheduled':
                await mailerManager.pollConnection(job.data.connectionUUID);
                break;

            default:
                alogger.writeAlog(3, `[Mailer] Unknown job: ${job.name}`, "yellowbright");
        }
    }, { connection, concurrency: 5 });

    // When mailer receives files, enqueue toss
    mailerManager.on('filesReceived', async (data) => {
        alogger.writeAlog(2, `[Mailer] Files received, enqueueing FTN inbound toss`, "cyan");
        await jobs.enqueueFtnInbound({ connectionUUID: data.connectionUUID });
        eventPublisher.publish(EVENTS.MAILER_SESSION_END, data);
    });

    alogger.writeAlog(1, "[Mailer] Ready — consuming mailer queue", "greenbright", true);
}

await main();
```

The `MailerManager` already owns its own TCP listener (`MAILER_BINKP_PORT`). The WebSocket listener binds to a new env var (`MAILER_WS_PORT`, e.g. 24555) using a minimal HTTP server local to this process — the same `ws` library, but not shared with the gateway's HTTP server.

### `bin/worker.js` — Worker process

New entry point. Consumes `toss` and `maintenance` queues.

```javascript
import * as dotenv from 'dotenv';
import * as alogger from "../src/utils/alogger.js"
import * as systeminfo from "../src/utils/systeminfo.js"
import { pgpool } from "../src/middleware/db/postgres.js"
import * as redis from "../src/middleware/db/redis.js"
import { createQueueConnection } from "../src/queues/connection.js"
import { Worker } from 'bullmq';
import * as jobs from "../src/queues/jobs.js"
import { createEventPublisher, EVENTS } from "../src/queues/events.js"

// Tosser imports — relocated to middleware/tossers/
import * as ftnTosser from "../src/middleware/tossers/ftnTosser.js"
import * as qwkTosser from "../src/middleware/tossers/qwkTosser.js"
import * as nntpTosser from "../src/middleware/tossers/nntpTosser.js"

// Maintenance imports
import * as messageBase from "../src/maintenance/messageBase.js"
import * as privateMessages from "../src/models/privateMessages.js"
import * as userMsgPointers from "../src/models/userMsgPointers.js"
import * as userAreaSubs from "../src/models/userAreaSubs.js"

dotenv.config();

const systemvermsg = systeminfo.versionMsg();
var tossWorker;
var maintWorker;
var eventPublisher;

process.on('uncaughtException', (err) => {
    alogger.writeAlog(0, `[Worker] Uncaught exception: ${err.stack}`, "redbright");
});

process.on('unhandledRejection', (reason) => {
    alogger.writeAlog(0, `[Worker] Unhandled rejection: ${reason}`, "redbright");
});

process.on('SIGINT', async () => {
    alogger.writeAlog(1, "[Worker] Shutting down", "yellowbright", true);
    if (tossWorker) await tossWorker.close();
    if (maintWorker) await maintWorker.close();
    if (eventPublisher) eventPublisher.shutdown();
    pgpool.end();
    redis.shutdown();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    if (tossWorker) await tossWorker.close();
    if (maintWorker) await maintWorker.close();
    process.exit(0);
});

async function main() {
    alogger.writeAlog(1, systemvermsg + "\n  Worker Process Startup", "yellowbright", true);

    // Run startup maintenance (same as gateway prerunMaint)
    await userMsgPointers.ensureConstraintsAndIndexes();
    await userAreaSubs.ensureConstraintsAndIndexes();

    // Event publisher
    eventPublisher = createEventPublisher();

    const connection = createQueueConnection();

    // --- Toss queue worker ---
    tossWorker = new Worker('toss', async (job) => {
        alogger.writeAlog(2, `[Worker] Processing ${job.name}`, "cyan");

        switch (job.name) {
            // --- FTN ---
            case 'ftn:inbound':
                await ftnTosser.TossInbound();
                eventPublisher.publish(EVENTS.TOSS_COMPLETE, {
                    type: 'ftn', direction: 'inbound'
                });
                break;

            case 'ftn:outbound': {
                await ftnTosser.TossOutbound();
                // Signal mailer for CRASH connections
                const connectionUUID = job.data.connectionUUID;
                if (connectionUUID) {
                    await jobs.enqueueMailerSignalOutbound(connectionUUID);
                }
                eventPublisher.publish(EVENTS.TOSS_COMPLETE, {
                    type: 'ftn', direction: 'outbound'
                });
                break;
            }

            // --- QWK ---
            case 'qwk:pull':
                await qwkTosser.pullFromQwkPeer(job.data.connectionUUID);
                eventPublisher.publish(EVENTS.MESSAGES_IMPORTED, {
                    source: 'qwk', connectionUUID: job.data.connectionUUID
                });
                break;

            case 'qwk:push':
                await qwkTosser.pushToQwkPeer(job.data.connectionUUID);
                break;

            case 'qwk:hub:inbound':
                await qwkTosser.pullFromQwkPeer(job.data.connectionUUID);
                eventPublisher.publish(EVENTS.MESSAGES_IMPORTED, {
                    source: 'qwk:hub', connectionUUID: job.data.connectionUUID
                });
                break;

            // --- NNTP ---
            case 'nntp:pull':
                await nntpTosser.pullFromNntpPeer(job.data.connectionUUID);
                eventPublisher.publish(EVENTS.MESSAGES_IMPORTED, {
                    source: 'nntp', connectionUUID: job.data.connectionUUID
                });
                break;

            case 'nntp:push':
                await nntpTosser.pushToNntpPeer(job.data.connectionUUID);
                break;

            default:
                alogger.writeAlog(3, `[Worker] Unknown toss job: ${job.name}`, "yellowbright");
        }
    }, {
        connection,
        concurrency: 3,  // allow parallel toss of different types/connections
    });

    // --- Maintenance queue worker ---
    maintWorker = new Worker('maintenance', async (job) => {
        alogger.writeAlog(2, `[Worker] Maintenance: ${job.name}`, "cyan");

        switch (job.name) {
            case 'regen-html':
                await messageBase.regenerateAllBodyHtml({
                    areas: job.data.areas,
                    batchSize: job.data.batchSize,
                    forceWidth: job.data.forceWidth,
                });
                break;

            case 'regen-pm-html':
                await messageBase.regeneratePmBodyHtml({
                    batchSize: job.data.batchSize,
                    forceWidth: job.data.forceWidth,
                });
                break;

            case 'purge-pm-trash':
                await privateMessages.purgeDeleted(job.data.days);
                break;

            case 'recalc-area-counts':
                const msgAreas = await import("../src/models/msgAreas.js");
                await msgAreas.recalculateAreaCounts();
                break;

            default:
                alogger.writeAlog(3, `[Worker] Unknown maintenance job: ${job.name}`, "yellowbright");
        }
    }, {
        connection,
        concurrency: 1,  // maintenance is sequential
    });

    alogger.writeAlog(1, "[Worker] Ready — consuming toss + maintenance queues", "greenbright", true);
}

await main();
```

---

## Embedded Mode

For single-server deployments where running three processes is unnecessary overhead, `PROCESS_MODE=embedded` starts the mailer and worker processors inside the gateway process. This is the simple-setup path — one process, one `node bin/gateway.js`, no process manager needed.

### `src/queues/embedded.js`

```javascript
import { Worker } from 'bullmq';
import { createQueueConnection } from './connection.js';
import * as alogger from "../utils/alogger.js";

// These are dynamically imported to avoid loading tosser/mailer
// modules in the gateway when running in separate mode
export async function startEmbeddedWorkers(opts = {}) {
    const connection = createQueueConnection();
    const workers = [];

    // --- Embedded toss worker ---
    const tossHandler = await import('./workers/toss.js');
    const tossWorker = new Worker('toss', tossHandler.processor, {
        connection, concurrency: 2,
    });
    workers.push(tossWorker);
    alogger.writeAlog(2, "  Embedded toss worker started", "cyan");

    // --- Embedded mailer worker ---
    if (opts.mailerManager) {
        const mailerHandler = await import('./workers/mailer.js');
        const mailerWorker = new Worker('mailer',
            mailerHandler.createProcessor(opts.mailerManager), {
            connection, concurrency: 5,
        });
        workers.push(mailerWorker);
        alogger.writeAlog(2, "  Embedded mailer worker started", "cyan");
    }

    // --- Embedded maintenance worker ---
    const maintHandler = await import('./workers/maintenance.js');
    const maintWorker = new Worker('maintenance', maintHandler.processor, {
        connection, concurrency: 1,
    });
    workers.push(maintWorker);
    alogger.writeAlog(2, "  Embedded maintenance worker started", "cyan");

    return {
        async shutdown() {
            await Promise.all(workers.map(w => w.close()));
        }
    };
}
```

In embedded mode, `gateway.js` keeps `MailerManager` and starts it as before. The mailer's WsPool registers on the shared HTTP server at `/ws/mailer` (the existing pattern). The mailer queue worker receives a reference to the in-process `mailerManager`. The toss worker calls the tosser modules directly.

The key: **the job enqueue helpers (`jobs.js`) are used identically in both modes**. Gateway routes call `jobs.enqueueFtnOutbound()` regardless of whether the consumer is in-process or across the network. This means switching between embedded and separate mode is purely a startup configuration change — no business logic changes anywhere.

### gateway.js embedded mode startup

```javascript
async function main() {
    await prerunMaint()
    await startNodeManager()
    await startSocatManager()
    await startCallPools()
    await startWebServer()

    if (runwssrv) {
        await startWebsockets()
    }

    // Mode-dependent startup
    const processMode = process.env.PROCESS_MODE || 'separate';

    if (processMode === 'embedded') {
        // Start mailer in-process (uses shared HTTP server for WS)
        await startMailerManager()
        // Start embedded workers for toss + maintenance
        embeddedWorkers = await startEmbeddedWorkers({
            mailerManager: mailerManager,
        });
        alogger.writeAlog(1, "Running in embedded mode (all-in-one)", "yellowbright", true);
    } else {
        alogger.writeAlog(1, "Running in gateway mode (separate mailer/worker)", "yellowbright", true);
    }

    // Event subscriber (runs in both modes)
    startEventSubscriber()
}
```

---

## Scheduled / Repeatable Jobs

BullMQ repeatable jobs replace cron for recurring tasks. Registered once at startup by whichever process consumes the queue (or by a dedicated scheduler setup that runs during `gateway.js` startup in both modes).

### `src/queues/schedules.js`

```javascript
import { tossQueue, mailerQueue, maintenanceQueue } from './queues.js';
import * as peerConnections from '../models/peerConnections.js';

export async function registerSchedules() {
    // --- Maintenance ---
    await maintenanceQueue.upsertJobScheduler('purge-pm-trash-daily', {
        pattern: '0 3 * * *',  // 3:00 AM daily
    }, {
        name: 'purge-pm-trash',
        data: { days: parseInt(process.env.pm_trash_retention_days) || 30 },
    });

    // --- Toss schedules (per active connection) ---
    const ftnConns = await peerConnections.getActiveConnectionsByNetworkType('FTN');
    for (const conn of ftnConns) {
        const cd = conn.connection_data || {};
        if (cd.status !== 'HOLD') {
            // Mailer poll schedule for FTN connections
            const pollMinutes = parseInt(cd.poll_interval) || 60;
            await mailerQueue.upsertJobScheduler(
                `poll:${conn.uuid}`, {
                    every: pollMinutes * 60 * 1000,
                }, {
                    name: 'poll-scheduled',
                    data: { connectionUUID: conn.uuid },
                }
            );
        }
    }

    const qwkConns = await peerConnections.getActiveConnectionsByNetworkType('QWK');
    for (const conn of qwkConns) {
        const cd = conn.connection_data || {};
        if (cd.transport !== 'hub') {  // hub mode is on-demand, not polled
            const pullMinutes = parseInt(cd.pull_interval) || 120;
            await tossQueue.upsertJobScheduler(
                `qwk-pull:${conn.uuid}`, {
                    every: pullMinutes * 60 * 1000,
                }, {
                    name: 'qwk:pull',
                    data: { connectionUUID: conn.uuid },
                }
            );
            await tossQueue.upsertJobScheduler(
                `qwk-push:${conn.uuid}`, {
                    every: pullMinutes * 60 * 1000,
                }, {
                    name: 'qwk:push',
                    data: { connectionUUID: conn.uuid },
                }
            );
        }
    }

    const nntpConns = await peerConnections.getActiveConnectionsByNetworkType('NNTP');
    for (const conn of nntpConns) {
        const pullMinutes = parseInt((conn.connection_data || {}).pull_interval) || 60;
        await tossQueue.upsertJobScheduler(
            `nntp-pull:${conn.uuid}`, {
                every: pullMinutes * 60 * 1000,
            }, {
                name: 'nntp:pull',
                data: { connectionUUID: conn.uuid },
            }
        );
        await tossQueue.upsertJobScheduler(
            `nntp-push:${conn.uuid}`, {
                every: pullMinutes * 60 * 1000,
            }, {
                name: 'nntp:push',
                data: { connectionUUID: conn.uuid },
            }
        );
    }
}
```

Schedules are registered by the gateway on startup (`registerSchedules()` in `main()`). They persist in Redis — BullMQ handles the timer and enqueues jobs at the specified intervals. The worker or mailer process picks them up. Updating a schedule (e.g., admin changes poll interval) calls `upsertJobScheduler` again with the same key — BullMQ replaces the existing schedule.

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
17. Add `poll_interval` / `pull_interval` to `connection_data` schema
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
| `MAILER_WS_PORT` | `24555` | WebSocket listener port for mailer (separate mode) |
| `MAILER_BINKP_PORT` | `24554` | TCP listener port for binkp (unchanged, now in mailer process) |

Existing variables unchanged: `webport`, `MAILER_ENABLED`, `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `pm_trash_retention_days`.

---

## NPM Dependencies (new)

| Package | Purpose |
|---------|---------|
| `bullmq` | Job queue — durable jobs, repeatable schedules, retry, concurrency |
| `ioredis` | Redis client (peer dependency of BullMQ, may already be in stack via existing Redis usage) |

BullMQ uses the existing Redis instance. No new infrastructure required.

---

## Failure Scenarios

| Scenario | Impact | Recovery |
|----------|--------|----------|
| Gateway crash | Terminal users disconnect, web UI unavailable | Restart gateway. In-flight toss and mailer jobs continue unaffected. Queued jobs are durable. |
| Mailer crash | Active file transfer sessions drop. Remote peers retry on next poll. | Restart mailer. Queued `signal-outbound` and `trigger-poll` jobs process on restart. No messages lost. |
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

10. **Worker concurrency of 3 for toss, 1 for maintenance**: Toss jobs for different connections/protocols can safely run in parallel (separate HWMs, separate directories). Maintenance jobs are sequential to avoid overlapping DB-heavy operations. These values are configurable via env vars if needed.

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

A reverse proxy fronting the gateway and mailer WebSocket ports allows unified external endpoints on standard ports (443 for HTTPS/WSS) and TLS termination. The binkp TCP port is typically exposed directly (binkd peers expect raw TCP on a known port) or via a TCP-mode proxy.

Detailed proxy configuration examples for HAProxy and nginx will be documented in the deployment guide. Key considerations:

- **WebSocket upgrade handling**: Both HAProxy and nginx require explicit configuration to pass `Upgrade: websocket` headers. The gateway and mailer WS ports both need this.
- **Path-based routing**: The gateway serves both HTTP routes and WebSocket upgrades on the same port, differentiated by path (`/ws/bbs` for general terminal connections, `/ws/doorserver` for door game clients, `/` as catchall). The proxy must pass the path through unchanged.
- **Mailer WS as separate backend**: In HAProxy terms, the mailer WS port is a separate backend from the gateway. Route by SNI, path prefix, or subdomain depending on topology.
- **TCP mode for binkp**: binkp is a raw binary protocol. HAProxy's TCP mode (`mode tcp`) or nginx's `stream` block passes it through without HTTP parsing.
- **Health checks**: The gateway exposes HTTP routes that can serve as health endpoints. The mailer and worker processes can expose a minimal HTTP health route or rely on process-level checks.
- **Timeouts**: Mailer binkp sessions and file transfers can run for extended periods. Set proxy timeouts accordingly (HAProxy `timeout server`/`timeout tunnel`, nginx `proxy_read_timeout`). WebSocket connections for terminal sessions are long-lived — default proxy timeouts will kill them.

### Embedded mode

In embedded mode, only the gateway's `webport` is exposed. The mailer WS pool registers on the gateway's HTTP server at `/ws/mailer` (same upgrade handler, different path). The binkp TCP listener is still separate. Proxy configuration is simpler — one HTTP backend plus one TCP backend.

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
