# Canectic BBS — BSO Scanner Design

## Overview

The BSO (Binkley-Style Outbound) scanner is a periodic directory scanner that discovers pending outbound mail in the BSO directory tree and triggers mailer sessions to deliver it. It decouples outbound mail detection from the tossers that create it — any process, tool, or external program that drops correctly-named files into the BSO directory structure will have them discovered and delivered.

Currently, the FTN tosser (`ftnTosser.js`) and TIC tosser (`ticTosser.js`) tightly couple packet creation with mailer signalling: `TossOutboundNetmail` resolves routes and enqueues `nodelist-connect` jobs inline, and `tossOutbound` in the TIC tosser enqueues `signal-outbound` jobs for CRASH connections. This works for tosser-created packets but misses files placed by external tools, door games, or manual sysop drops. The BSO scanner replaces this coupling with a universal mechanism.

For the mailer session architecture, see `MAILER_ARCHITECTURE.md`.
For the process model and job queues, see `PROCESS_ARCHITECTURE.md`.
For the FTN routing cascade, see `NETWORKING_ARCHITECTURE.md`.
For the nodelist system, see `NODELIST_DESIGN.md`.

---

## Design Principles

- **Source-agnostic.** The scanner does not care who created the files. It reads the BSO directory and acts on what it finds. This enables external FTN tools, door games that generate netmail, sysop file drops, and future subsystems to all trigger delivery without code changes.
- **Flavour-aware.** BSO filenames encode delivery urgency (Normal, Crash, Hold, etc.). The scanner respects these: Crash triggers immediate connection, Normal waits for the next poll or scan cycle, Hold is never actively delivered.
- **Idempotent.** Running the scanner multiple times with the same directory state produces the same result. It does not modify files — it only reads directory listings and triggers mailer actions.
- **Lightweight.** A directory scan is a `readdirSync` plus filename pattern matching. No database queries are needed for the core scan loop. Route resolution is only invoked for addresses that are not already in an active session.
- **Fits the three-process model.** The scanner runs inside the mailer process, which is the only process that manages sessions. No cross-process coordination needed for the scan itself. On-demand triggers arrive via the existing mailer BullMQ queue.

---

## 1. Scanner Module Design

### File: `src/mailer/bsoScanner.js`

A standalone module imported by `MailerManager`. It does not subclass anything — it exports a `BsoScanner` class that the manager instantiates, starts, and stops.

### Class shape

```
class BsoScanner {
    constructor(options)
        // options.outboundDir  — base BSO directory (default from appConfig)
        // options.defaultZone  — default zone number (default 1)
        // options.manager      — reference to MailerManager (for session checks, connection triggers)

    start()                     — begin periodic scanning
    stop()                      — stop periodic scanning, clear timer
    scanNow()                   — perform one immediate scan cycle (returns Promise)

    // Internal
    _scanAllZones()             — scan base dir + all zone-specific dirs
    _scanOneDirectory(dirPath, zone) — scan a single BSO directory
    _parseFilename(filename)    — extract address + type + flavour from a BSO filename
    _handleAddress(zone, net, node, flavour, scanResult) — decide what to do for one address
}
```

### Why a separate module (not inline in MailerManager)

`MailerManager` is already 470 lines handling TCP listening, session lifecycle, poll scheduling, and outbound mail detection. Adding a full BSO scanner with filename parsing, multi-zone directory traversal, and flavour-aware dispatch would push it well past maintainable size. A separate module keeps the manager focused on session coordination while the scanner focuses on directory analysis.

The scanner needs exactly three things from the manager:
1. `_hasSessionForAddress(addr)` — skip addresses with active sessions
2. `_connectToPeer(conn)` / `connectToNodelistAddress(data, addr)` — trigger connections
3. `isRunning()` — abort scan if mailer is shutting down

These are passed via the `options.manager` reference, avoiding circular imports.

---

### Outbound Filebox Scanning

After the normal BSO directory scan, the scanner checks per-peer outbound fileboxes. It queries all active FTN connections with `outbox_dir` set in `connection_data`, resolves each path via `resolveFileboxPath()` (supports `%X` variable substitution), and checks for files. If files are found, the connection's address is added to the address map with the connection's `status` as the flavour. This enables the same session-triggering logic to handle filebox delivery alongside normal BSO mail.

---

## 2. BSO Filename Parsing

### Filename structure

BSO filenames encode the destination net:node as 8 hex characters:

```
NNNNNNNN.ext
│       │
│       └── Extension determines file type + flavour
└────────── First 4 hex chars = net, last 4 hex chars = node
```

The zone comes from which directory the file is in, not the filename.

### Extension mapping

**Flow files** (contain lists of files to send):

| Extension | Flavour   | Action                          |
|-----------|-----------|---------------------------------|
| `.flo`    | Normal    | Send on next poll/scan          |
| `.clo`    | Crash     | Send immediately                |
| `.dlo`    | Direct    | Send directly (treat as Normal) |
| `.hlo`    | Hold      | Wait for inbound call           |
| `.ilo`    | Immediate | Send immediately (like Crash)   |

**Packet files** (direct .pkt data, deleted after send):

| Extension | Flavour   |
|-----------|-----------|
| `.out`    | Normal    |
| `.cut`    | Crash     |
| `.dut`    | Direct    |
| `.hut`    | Hold      |
| `.iut`    | Immediate |

**File requests**:

| Extension | Purpose                        |
|-----------|--------------------------------|
| `.req`    | Request files from remote node |

### Parsing function

```
_parseFilename(filename)
```

Returns `null` for non-BSO filenames. For valid BSO filenames, returns:

```javascript
{
    net:      number,    // parsed from first 4 hex chars
    node:     number,    // parsed from last 4 hex chars
    type:     string,    // 'flow' | 'packet' | 'request'
    flavour:  string,    // 'Normal' | 'Crash' | 'Direct' | 'Hold' | 'Immediate'
    filename: string     // original filename for logging
}
```

Validation rules:
- Filename stem must be exactly 8 hex characters (case-insensitive)
- Extension must match one of the known BSO extensions
- Parsed net and node must be valid (0-65535)
- Files not matching this pattern are silently ignored (the outbound directory may contain `.pkt` files with non-BSO names, `.tic` files, etc.)

### Zone resolution from directory

```
ftn/out/           → zone 1 (default zone, base directory)
ftn/out.002/       → zone 2 (3-digit hex zone suffix)
ftn/out.003/       → zone 3
ftn/out.00a/       → zone 10
```

The scanner derives the zone from the directory name. The base outbound directory (no suffix) maps to the default zone (configurable, default 1). Directories with a `.NNN` hex suffix map to that zone number. This matches the convention already used by `MailerManager._getOutboundDirForZone()` and `SessionController._getOutboundDirForZone()`.

---

## 3. Scan Logic and Address Resolution

### Full scan cycle (`_scanAllZones`)

```
1. Read the base outbound directory path from appConfig
2. Scan the base directory as default zone (1)
3. List sibling directories matching the pattern `<basename>.NNN`
   where NNN is a 3-digit hex number
4. Scan each zone-specific directory
5. Deduplicate results — one action per unique zone:net/node address
6. For each unique address with pending mail, call _handleAddress()
```

### Single directory scan (`_scanOneDirectory`)

```
1. If directory does not exist, return empty
2. readdirSync the directory
3. For each file, call _parseFilename()
4. Aggregate by destination address (net:node)
   — track the highest-priority flavour seen for each address
   — Crash/Immediate > Normal/Direct > Hold
5. Return a Map of { "net:node" → { net, node, flavour, fileTypes } }
```

### Flavour priority

When multiple files exist for the same address with different flavours, the highest-priority flavour wins for the connection decision:

1. **Crash / Immediate** — connect now
2. **Normal / Direct** — connect on scan
3. **Hold** — do not connect (wait for inbound)

If an address has both `.clo` (Crash) and `.flo` (Normal), the scanner treats it as Crash and triggers immediate connection. The session controller's `_buildOutboundList()` already reads all flow files regardless of flavour once connected, so all mail gets sent.

### Address handling (`_handleAddress`)

For each discovered address:

```
1. Build the FTN address string: "zone:net/node"

2. Check if the mailer already has an active session for this address
   → If yes, skip (session will pick up the files)

3. If flavour is Hold, skip (wait for inbound call)

4. Resolve route via ftnRouter.resolveRoute(address)
   → routeResult has connectionUUID (peer) or nodelistData (nodelist)

5a. If routeResult.connectionUUID exists:
    — Load the peer connection record
    — Skip if the peer is in connect backoff
    — Call manager._connectToPeer(conn)

5b. If routeResult.nodelistData exists (no peer connection):
    — Call manager.connectToNodelistAddress(nodelistData, address)

5c. If no route found:
    — Log warning: "No route for zone:net/node — mail pending but undeliverable"
    — Do not retry until next scan cycle

6. If flavour is Normal/Direct and route resolves to a peer with
   status=CRASH on the connection, escalate to immediate connection
   (the peer's connection status overrides the file flavour)
```

### Why resolve routes in the scanner (not just check peer connections)

The existing `_startPollScheduling()` in MailerManager only polls configured peer connections. But BSO files can be addressed to any FTN node — including nodes reachable only via nodelist lookup or routing rules. The scanner must use `ftnRouter.resolveRoute()` to handle all four routing cascade steps (direct peer, routing rule, nodelist direct, coordinator walk).

This is the key architectural improvement: the scanner makes the mailer aware of mail destined for nodes that have no configured peer connection.

---

## 3.5 Flow File Housekeeping

The scanner decides a node has mail from the **filename**, not the contents. That
is fine for packets, which are self-evidently mail, and wrong for flow files,
which are a list of things to send and can end up listing nothing.

A flow file with nothing left to do used to read as pending work for ever:

1. Scanner sees `00860065.flo` and records the address as having mail
2. It triggers a session
3. The session skips every line, because each is either already marked `~` or
   names a file that no longer exists
4. Nothing is sent, so nothing marks a line, so nothing deletes the flow file
5. Next scan cycle, back to 1

At the default `MAILER_BSO_SCAN_INTERVAL` of 60 seconds that is one connection a
minute, indefinitely, to a peer whose `poll_interval` might say four hours. The
poll schedule is not involved: this path calls `_connectToPeer` directly.

Two ways in:

- **Every line already `~`.** `TransferEngine._markFloLineSent` only deleted the
  flow file when a line changed during that call, so one whose last line was
  marked in an earlier session was never removed.
- **Files that vanished.** Both outbound list builders and the send loop skipped
  a missing file silently, leaving its line unmarked for ever.

`src/utils/floFile.js` owns the fix. `pruneFlowFile()` marks lines whose file has
gone and deletes the flow file once nothing actionable remains. It is called from
the scanner before counting an address, and from both outbound list builders, so
the tidy-up does not depend on any one of them running. `pendingCount()` is the
honest answer to "does this node have mail", as against "does a flow file exist".

Deletion in `_markFloLineSent` is now gated on `allSent` alone rather than on
`updated && allSent`, and `_offerNextFile` marks a line whose file disappeared
between queueing and sending.

## 4. Flavour Handling

### Flavour-to-action mapping

| Flavour   | Scanner action                | Mailer behavior                          |
|-----------|-------------------------------|------------------------------------------|
| Normal    | Trigger connection on scan    | Connect, send all files, disconnect      |
| Crash     | Trigger connection immediately| Same as Normal, but no waiting for scan  |
| Immediate | Same as Crash                 | Same as Crash                            |
| Direct    | Same as Normal                | Same as Normal (no relay routing)        |
| Hold      | Do not trigger connection     | Files sent only on inbound calls         |

### Interaction with peer connection status

Peer connections have their own `connection_data.status` field (`NORMAL`, `CRASH`, `HOLD`). The relationship between file flavour and connection status:

- **File flavour** controls whether the scanner triggers a connection for this specific batch of files.
- **Connection status** controls the general polling/signalling behavior for that peer.

The scanner uses the higher urgency of the two. If a Normal-flavoured `.flo` file targets a peer with `status=CRASH`, the scanner still triggers an immediate connection (the peer is configured for immediate delivery). Conversely, if a Crash-flavoured `.clo` file exists but the only route is through a peer with `status=HOLD`, the scanner logs a warning but does not connect (HOLD peers are passive-only).

### Hold handling detail

Hold-flavoured files (`.hlo`, `.hut`) are never actively delivered. They exist for the remote system to pick up when it calls us. The session controller's `_buildOutboundList()` already reads Hold files when building the file list during an inbound session, so no scanner action is needed.

The scanner still logs the existence of Hold-flavoured files at debug level for visibility.

---

## 5. Integration with Mailer Manager

### Instantiation

`MailerManager.start()` creates the scanner after starting the TCP listener:

```
this._bsoScanner = new BsoScanner({
    outboundDir: appConfig.get('MAILER_OUTBOUND_DIR') || appConfig.get('ftnoutbound', 'ftn/out'),
    defaultZone: appConfig.getNumber('MAILER_DEFAULT_ZONE', 1),
    manager:     this
});
this._bsoScanner.start();
```

`MailerManager.stop()` calls `this._bsoScanner.stop()`.

### Methods exposed to the scanner

The scanner needs these from MailerManager (all already exist):

| Method | Purpose |
|--------|---------|
| `_hasSessionForAddress(addr)` | Skip addresses with active sessions |
| `_connectToPeer(conn)` | Initiate peer connection |
| `connectToNodelistAddress(data, addr)` | Initiate nodelist connection |
| `isRunning()` | Abort scan on shutdown |

Additionally, the scanner imports `ftnRouter.resolveRoute()` and `peerConnections.getConnectionByUUIDWithNetwork()` directly for route resolution.

### Replacing `_startPollScheduling()`

The current `_startPollScheduling()` in MailerManager sets up `setInterval` timers per peer connection. This overlaps with the BSO scanner's purpose but operates at a different level — it polls peers regardless of whether there is outbound mail (to also receive inbound mail).

**Recommendation: Keep both, but clarify roles.**

- **Poll scheduling** (existing) remains responsible for periodic receive-only polls. A poll connects to a peer to check for inbound mail even when we have nothing to send. This is needed because FTN is a "call and exchange" model — you must call to receive.
- **BSO scanner** is responsible for triggering send-driven connections. When it finds outbound mail, it triggers a connection (which will also receive any waiting inbound mail as a side effect).

The existing `_startPollScheduling()` in MailerManager is now superseded by BullMQ repeatable jobs registered in `schedules.js` (`poll-scheduled` jobs). The `_startPollScheduling()` method and its `_pollTimers` Map can be removed — they are a leftover from before the BullMQ schedule system was implemented.

---

## 6. Scheduled vs On-Demand Scanning

### Periodic scanning (timer-based inside mailer process)

The scanner runs on an internal `setInterval` timer within the mailer process. This is preferable to a BullMQ repeatable job for several reasons:

1. **Process locality.** The scanner needs direct access to MailerManager's session pool (`_hasSessionForAddress`) and connection methods (`_connectToPeer`). A BullMQ job would require serializing this state or adding Redis pub/sub indirection.

2. **Frequency.** Scans should run every 30-120 seconds (configurable). BullMQ repeatables are designed for longer intervals (minutes to hours). A 30-second repeatable creates Redis churn for minimal benefit.

3. **Simplicity.** `setInterval` + `scanNow()` is straightforward. The scanner is stateless — if the mailer process restarts, the timer restarts, and the next scan picks up whatever is in the directory.

4. **No cross-process coordination needed.** Only the mailer process needs scan results. The worker and gateway never consume scan output.

### On-demand scanning (via BullMQ mailer queue)

For faster delivery after netmail creation, the tosser can trigger an immediate scan. This uses the existing mailer queue with a new job type:

**New job type: `bso-scan`**

```javascript
// In jobs.js
export async function enqueueMailerBsoScan() {
    return mailerQueue.add('bso-scan', {}, {
        jobId: 'bso-scan--' + Date.now(),
    });
}
```

The mailer queue consumer in `bin/mailer.js` handles it:

```javascript
case 'bso-scan':
    await mailerManager.scanOutboundNow();
    break;
```

`MailerManager.scanOutboundNow()` delegates to `this._bsoScanner.scanNow()`.

### Who triggers on-demand scans

1. **FTN outbound tosser** — after `TossOutbound()` completes and packets are written to the BSO directory. Replaces the current inline `enqueueMailerNodelistConnect` / `enqueueMailerSignalOutbound` calls.

2. **TIC outbound tosser** — after `tossOutbound()` stages files. Replaces the current inline `enqueueMailerSignalOutbound` for CRASH connections.

3. **Admin panel** — "Scan Outbound" button (future admin UI enhancement).

4. **CLI tool** — `node src/tools/maintenance.js --scan-outbound` (enqueues a `bso-scan` job).

### Debouncing

Multiple rapid on-demand triggers (e.g., tosser writes 5 packets in quick succession) should not cause 5 full directory scans. The scanner maintains a simple debounce:

```javascript
scanNow() {
    if (this._scanInProgress) {
        this._rescanRequested = true;
        return this._scanPromise;
    }
    return this._executeScan();
}
```

If a scan is already in progress when `scanNow()` is called again, it sets a flag to re-scan once the current scan completes. This collapses multiple rapid triggers into at most two scans.

---

## 7. Integration with Existing Outbound Flow

### Current flow (before BSO scanner)

```
User posts netmail
  → Gateway enqueues ftn:outbound job
    → Worker runs TossOutboundNetmail()
      → WritePkts() creates .pkt files + UpcertMailerFile() creates .flo entries
      → Inline: resolveRoute() for each destination
      → Inline: enqueueMailerNodelistConnect() for nodelist routes
        → Mailer connects to nodelist address

User posts echomail
  → Gateway enqueues ftn:outbound job
    → Worker runs TossOutboundEchomail()
      → WritePktsToNode() creates .pkt + UpcertMailerFile() creates .flo entries
      → (No mailer signal — relies on poll schedule)

TIC outbound
  → Worker runs tic:outbound
    → stageOneOutboundFile() places files in outDir
    → Inline: enqueueMailerSignalOutbound() for CRASH connections
```

Problems with current flow:
- Netmail tosser duplicates routing logic that the mailer should own
- Echomail tosser does not signal the mailer at all (mail waits for next poll)
- TIC tosser only signals CRASH connections
- External tools that drop files into BSO are never detected
- Nodelist routing is done in the worker process, which has no session awareness

### New flow (with BSO scanner)

```
User posts netmail
  → Gateway enqueues ftn:outbound job
    → Worker runs TossOutboundNetmail()
      → WritePkts() creates .pkt files + UpcertMailerFile() creates .flo entries
      → enqueueMailerBsoScan()   ← replaces inline routing
        → Mailer runs BSO scan
          → Discovers new .flo/.clo files
          → Resolves routes (peer or nodelist)
          → Triggers connections

User posts echomail
  → Gateway enqueues ftn:outbound job
    → Worker runs TossOutboundEchomail()
      → WritePktsToNode() creates .pkt + UpcertMailerFile() creates .flo entries
      → enqueueMailerBsoScan()   ← NEW: echomail now triggers delivery
        → Mailer runs BSO scan, triggers connections

TIC outbound
  → Worker runs tic:outbound
    → stageOneOutboundFile() places files in outDir
    → enqueueMailerBsoScan()   ← replaces per-connection signal
      → Mailer runs BSO scan, triggers connections

External tool drops .flo/.pkt into ftn/out/
  → Next periodic scan discovers the files
  → Mailer triggers connections
```

### What changes in existing code

**`ftnTosser.js` — `TossOutboundNetmail()`:**
- Remove the inline `ftnRouter.resolveRoute()` + `enqueueMailerNodelistConnect()` block (lines ~1325-1343)
- Add a single `enqueueMailerBsoScan()` call after `WritePkts()` succeeds

**`ftnTosser.js` — `TossOutbound()`:**
- Add `enqueueMailerBsoScan()` at the end, after both netmail and echomail tossing complete

**`ticTosser.js` — `tossOutbound()`:**
- Remove the per-connection `enqueueMailerSignalOutbound()` for CRASH connections (lines ~679-686)
- Add a single `enqueueMailerBsoScan()` at the end of the function

**`bin/mailer.js`:**
- Add `case 'bso-scan'` to the mailer queue worker switch

**`src/queues/jobs.js`:**
- Add `enqueueMailerBsoScan()` function

**`src/mailer/manager.js`:**
- Instantiate and manage `BsoScanner` in `start()` / `stop()`
- Add `scanOutboundNow()` public method
- Remove `_startPollScheduling()` and `_pollTimers` (superseded by BullMQ schedules + BSO scanner)

### What does NOT change

- **`UpcertMailerFile()`** in ftnTosser — still creates `.flo` entries as before
- **`WritePkts()` / `WritePktsToNode()`** — still creates `.pkt` files as before
- **`SessionController._buildOutboundList()`** — still reads BSO files during a session as before
- **`TransferEngine`** — still handles flow file prefixes (`^`, `#`) and packet deletion as before
- **`_hasOutboundMail()`** in MailerManager — still used for logging/status; could eventually delegate to the scanner's last-known state
- **Poll schedules in `schedules.js`** — still run periodic polls for receive-only connections
- **`signalOutbound()`** in MailerManager — can be deprecated once the BSO scanner is proven, but can coexist during transition

---

## 8. Config Keys

All configurable via `appConfig` (DB-backed with .env override):

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `MAILER_BSO_SCAN_INTERVAL` | number | 60 | Seconds between periodic BSO scans |
| `MAILER_BSO_SCAN_ENABLED` | boolean | true | Enable/disable the periodic scanner |
| `MAILER_DEFAULT_ZONE` | number | 1 | Default zone for the base outbound directory |
| `MAILER_OUTBOUND_DIR` | string | `ftn/out` | Base BSO outbound directory (existing key) |

The scan interval should be independent of the poll interval (`MAILER_POLL_INTERVAL`). Polling is about receiving mail on a schedule; scanning is about discovering locally-staged outbound mail. A system with frequent local posts might want a 30-second scan interval but a 15-minute poll interval.

`MAILER_BSO_SCAN_ENABLED` allows disabling the scanner without disabling the mailer. Useful during maintenance or when running an external mailer alongside Canectic.

---

## 9. Logging

All scanner logging uses `alogger.writeClog()` with the `'mailer'` channel.

| Level | What |
|-------|------|
| 1 | Scanner start/stop |
| 2 | Scan cycle summary: "BSO scan: 3 addresses with pending mail, 2 connections triggered" |
| 3 | Per-address actions: "Triggering connection to 1:134/42 (Crash) via peer conn abc-123" |
| 3 | Routing failures: "No route for 2:234/1 — mail pending but undeliverable" |
| 4 | Hold-flavoured files noted: "Hold mail for 1:134/99 — waiting for inbound call" |
| 5 | Directory scan details: "Scanning ftn/out/ (zone 1): 12 BSO files found" |
| 5 | Skipped addresses: "1:134/42 — session already active, skipping" |

---

## 10. Error Handling

- **Directory does not exist:** Silently skip (outbound dir may not exist until first toss). Log at level 5.
- **Permission errors on readdir:** Log at level 2, skip that directory, continue scanning others.
- **Route resolution failure:** Log at level 3, skip that address, continue with others. Will be retried on next scan cycle.
- **Connection failure:** Handled by MailerManager's existing connection error handling (the scanner does not track connection outcomes).
- **Malformed filenames:** Silently skip. Non-BSO files in the outbound directory are expected (.tic files, temp files, etc.).
- **Scanner exception:** Catch at the top level of `_executeScan()`, log at level 2, ensure the periodic timer continues running.

---

## 11. Implementation Phases

### Phase 1: Core Scanner Module

1. Create `src/mailer/bsoScanner.js` with `BsoScanner` class
2. Implement `_parseFilename()` with full extension mapping
3. Implement `_scanOneDirectory()` and `_scanAllZones()`
4. Implement `_handleAddress()` with `ftnRouter.resolveRoute()` integration
5. Implement periodic timer (`start()` / `stop()`) and debounced `scanNow()`
6. Wire into `MailerManager.start()` / `stop()`
7. Add `scanOutboundNow()` to MailerManager

### Phase 2: Queue Integration

1. Add `enqueueMailerBsoScan()` to `src/queues/jobs.js`
2. Add `case 'bso-scan'` to `bin/mailer.js` queue consumer
3. Add `MAILER_BSO_SCAN_INTERVAL` and `MAILER_BSO_SCAN_ENABLED` to config defaults

### Phase 3: Tosser Migration

1. Replace inline routing in `ftnTosser.TossOutboundNetmail()` with `enqueueMailerBsoScan()`
2. Add `enqueueMailerBsoScan()` to `ftnTosser.TossOutbound()` (covers echomail)
3. Replace per-connection signalling in `ticTosser.tossOutbound()` with `enqueueMailerBsoScan()`
4. Remove `_startPollScheduling()` and `_pollTimers` from MailerManager (verify BullMQ schedules cover polling)

### Phase 4: Cleanup

1. Deprecate `enqueueMailerSignalOutbound()` (keep for backward compat, add deprecation log)
2. Deprecate `enqueueMailerNodelistConnect()` (scanner handles this now)
3. Update `MAILER_ARCHITECTURE.md` and `PROCESS_ARCHITECTURE.md`

---

## Documentation Updates Required

When implementation begins:

- **`MAILER_ARCHITECTURE.md`** — Add BSO Scanner section covering periodic scanning, on-demand triggers, and flavour handling. Update the outbound mail flow diagram.
- **`PROCESS_ARCHITECTURE.md`** — Add `bso-scan` to the mailer queue job list. Note the scanner as an internal mailer component.
- **`NETWORKING_ARCHITECTURE.md`** — Update the FTN outbound toss flow to show the scanner as the delivery trigger instead of inline routing.
