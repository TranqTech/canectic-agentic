# Canectic BBS — FTN Mailer Architecture Reference

## Overview

The FTN mailer system handles real-time node-to-node communication for exchanging mail packets, file attachments, and TIC files with remote FidoNet-compatible systems. It replaces the current directory-based file drop model with active session management — the system can both initiate outbound calls and accept inbound connections.

The mailer operates independently of the tosser. The tosser prepares `.pkt` files in an outbound directory and processes `.pkt` files from an inbound directory. The mailer's job is to move files between the local outbound/inbound directories and the remote system via a negotiated transfer protocol over a network transport.

For the shared message platform (schemas, read tracking, body_html pipeline, posting, web views), see `message_architecture.md`.
For the message networking stack (tossers, protocols, packet formats), see `NETWORKING_ARCHITECTURE.md`.
For the terminal-side BBS architecture, see `terminal_architecture.md`.
For the web application (Express, sessions, admin panel, WebSockets), see `web_architecture.md`.
For the process model, job queues, and inter-process signaling, see `PROCESS_ARCHITECTURE.md`.

---

## Design Goals

1. **Support both binkd (binkp) and FrontDoor/BinkleyTerm (EMSI/Wazoo) session handshakes** — binkp is the modern standard; EMSI support enables connectivity with legacy systems still running FrontDoor, BinkleyTerm, or T-Mail.

2. **Transport-agnostic session layer** — session handshake and file transfer logic should not care whether the underlying connection is TCP or WebSocket. This enables both traditional TCP mailer connections and browser/serverless WebSocket relays for systems behind restrictive NATs or firewalls.

3. **Leverage existing peer connection infrastructure** — outbound connection parameters (address, host, port, passwords, routing rules) and inbound authentication (session password matching by presented address) use the existing `peer_connections` table and `connection_data` JSONB. No parallel configuration system.

4. **Concurrent multi-session** — handle multiple simultaneous inbound and outbound sessions. Node-style event loop is naturally suited to this.

5. **Observable** — session activity, transfer progress, and errors should be visible via logging and (future) a real-time admin dashboard.

---

## Architecture Layers

```
┌─────────────────────────────────────────────────┐
│                  Mailer Manager                  │
│  (scheduling, outbound poll loop, session pool)  │
├─────────────────────────────────────────────────┤
│              Session Controller                  │
│  (one per active connection — state machine,     │
│   handshake orchestration, file list management) │
├──────────────────────┬──────────────────────────┤
│   Protocol Module    │    Protocol Module        │
│      (binkp)         │     (EMSI/Wazoo)          │
├──────────────────────┴──────────────────────────┤
│              Transfer Engine                      │
│  (file send/receive, CRC, resume, compression)   │
├─────────────────────────────────────────────────┤
│              Transport Layer                      │
│  (TCP client/server, WebSocket client/server)    │
└─────────────────────────────────────────────────┘
```

Each layer has a clean interface boundary. The session controller talks to a protocol module via a common protocol adapter interface. The protocol module talks to the transport via a stream-like read/write abstraction. This means adding a new protocol (e.g., Hydra) or a new transport (e.g., TLS, SSH tunnel) requires implementing only that layer's interface.

---

## Transport Layer

### Responsibilities

- Accept inbound connections (server mode)
- Initiate outbound connections (client mode)
- Provide a bidirectional byte stream with `write(buffer)`, `on('data')`, `on('close')`, `on('error')`
- Report remote address/port for logging
- Handle keepalive and connection timeout at the socket level

### Transport Interface

All transports implement:

```javascript
class BaseTransport extends EventEmitter {
    write(buffer)          // Send raw bytes
    close()                // Graceful close
    destroy()              // Immediate teardown
    get remoteAddress()    // String — remote IP or identifier
    get isConnected()      // Boolean
}

// Events: 'data', 'close', 'error', 'connect'
```

### TCP Transport (`mailer/transports/tcp.js`)

Standard TCP sockets. The server binds one port, `MAILER_BINKP_PORT` (default 24554), for both binkp and EMSI: the session tells them apart by the first byte received (see EMSI below). There is no separate EMSI listener. The client connects to `connection_data.remote_host` and `connection_data.remote_port` (what the admin peer form writes; `mailer_host`/`mailer_port` are read first when present, a fallback kept for older rows), or to the nodelist hostname when no host is configured.

Uses Node.js `net` module. Straightforward 1:1 mapping to the transport interface.

### WebSocket Transport (`mailer/transports/ws.js`)

WebSocket connections for binkp sessions. Two operating modes depending on the process model:

**Inbound — Separate mode (default):** The mailer process binds its own HTTP server on `MAILER_WS_PORT` (default 24555, 0 to disable). Only the `/ws/mailer/binkp` upgrade path is accepted; all other requests get 404. The `MailerManager` wraps accepted WebSocket connections in `WsTransport` and creates answerer sessions.

**Inbound — Embedded mode:** The gateway's `WsManager` creates a `WsPool` at `/ws/mailer/binkp` and passes it to `mailerManager.setWebSocketPool()`. The pool's `wss` `connection` event routes directly to `_onInboundWebSocket()`. No separate HTTP server needed — the gateway's shared upgrade handler routes by pathname.

**Outbound (client):** For peers configured with `mailer_transport: 'websocket'`, the transport creates a `ws` client connection to the peer's `mailer_ws_url`. The client WebSocket is wrapped in `WsTransport` with the same interface.

Binary frames — all data is transmitted as `Buffer` payloads in binary WebSocket frames, not text. The `ws` library sends `Buffer` arguments as binary frames automatically. The session layer sees the same byte stream it would over TCP.

**Flow control:** WebSocket has no kernel-level pause/resume like TCP sockets. The transport buffers incoming messages in an array while paused and replays them on resume. The pause window is only during the brief async setup in `SessionController.start()` before the protocol layer is wired.

**Integration with existing infrastructure:**
```javascript
// Embedded mode (PROCESS_MODE=embedded) — in bin/gateway.js startEmbeddedMailer():
var mailerWsPool = wsManager.createNewPool('/ws/mailer/binkp', 'Mailer Binkp Pool');
mailerManager.setWebSocketPool(mailerWsPool);

// Separate mode (PROCESS_MODE=separate) — the mailer process (bin/mailer.js)
// creates its own HTTP server on MAILER_WS_PORT with WebSocketServer({ noServer: true }).
// Only /ws/mailer/binkp upgrade path is accepted.
```

Use case: systems behind CGN/restrictive firewalls that can't accept inbound TCP, or browser-based BBS frontends that want to relay mailer traffic through a WebSocket bridge. Also useful for serverless deployments where raw TCP listeners aren't available.

### Transport Configuration (connection_data additions)

```json
{
    "address": "1:123/456",
    "session_password": "...",
    "packet_password": "...",
    "remote_host": "bbs.example.com",
    "remote_port": 24554,
    "mailer_transport": "tcp",
    "mailer_protocol": "binkp",
    "mailer_ws_url": "wss://bbs.example.com/ws/mailer/binkp"
}
```

Mailer fields (written by `peerConnections.buildConnectionData()`; additive, existing connection_data fields unchanged):

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `remote_host` | string | empty | Remote hostname/IP for outbound calls. Empty means look the address up in the nodelist |
| `remote_port` | integer | null (24554 used) | Remote port for outbound calls |
| `mailer_transport` | string | `"tcp"` | Transport type: `tcp` or `websocket` |
| `mailer_protocol` | string | `"binkp"` | Session protocol for outbound calls: `binkp` or `emsi` |
| `mailer_ws_url` | string | empty | Full WebSocket URL for WS transport |
| `force_plain_password` | boolean | false | Send plaintext M_PWD even when CRAM-MD5 is offered |

TLS (`mailer_tls` in the original plan) is not implemented; nothing reads such a key.

The system also writes keys of its own into the same JSONB (backoff state, below). Saving the edit form merges over the stored row rather than replacing it (`peerConnections.mergeConnectionData()`), so those keys survive an edit.

Existing fields used by the mailer:
- `address` — remote FTN address, presented during handshake
- `session_password` — validated during session authentication
- `packet_password` — written into the 8-byte packet header password field by both packet writers. Echomail has always used it. Netmail did not until it was fixed: `WritePkts` read the global `PacketPwd` config key and nothing else, so a sysop who set a password on a link got authenticated echomail and netmail with eight zero bytes where the password belongs. It surfaced as an uplink bouncing AreaFix requests with "no password" while every other kind of traffic to the same system worked, because everything else was echomail. See the FTN packet password section in NETWORKING_ARCHITECTURE.md.
- `status` — NORMAL/CRASH/HOLD (controls polling behavior and BSO flavour for filebox files)
- `outbox_dir` — optional per-peer outbound filebox directory (see Outbound Fileboxes below)

---

## Protocol Layer

### Responsibilities

- Session handshake (authentication, capability negotiation, address presentation)
- File offer/accept/reject/skip negotiation
- Frame-level encoding/decoding on the byte stream
- Transfer state management (sending, receiving, waiting)

### Protocol Adapter Interface

There is no `BaseProtocol` class; the shared surface is by convention. Both `BinkpProtocol` and `EmsiProtocol` take `(transport, options)`, implement `startSession(role)`, `confirmAuth()`, `sendERR()`, `sendBSY()`, `remoteAddresses`, `isAuthenticated` and `state`, and emit the handshake events the session controller listens for: `authenticated`, `passwordReceived` (answerer, so the session can validate against `peer_connections`), `sessionEnd` and `error`.

File exchange differs. binkp additionally exposes `offerFile()`, `sendFileData()`, `sendEOB()`, `sendGOT()`, `sendSKIP()`, `sendGET()` and emits `fileOffered`, `fileData`, `fileComplete`, `fileReceived`, `fileRequested`, `fileSkipped`, `remoteEOB` and `batchEnd`, all consumed by `TransferEngine`. EMSI hands the transport to `WazooTransferEngine` after the handshake instead.

### binkp Protocol (`mailer/protocols/binkp.js`)

The Binary Kinkiest Protocol (binkp/1.1). Modern FTN mailer standard. Frame-based binary protocol.

**Frame format:**
```
2 bytes: header
  bit 15:    command flag (1 = command frame, 0 = data frame)
  bits 14-0: payload length (max 32767 bytes)
N bytes: payload
```

**Command frames:**

| ID | Name | Direction | Purpose |
|----|------|-----------|---------|
| 0 | M_NUL | both | Informational (software name, capabilities, OPT flags) |
| 1 | M_ADR | both | Present FTN addresses |
| 2 | M_PWD | caller→answerer | Session password |
| 3 | M_FILE | sender→receiver | File offer: `name size time offset` |
| 4 | M_OK | answerer→caller | Password accepted |
| 5 | M_EOB | both | End of batch (no more files to send) |
| 6 | M_GOT | receiver→sender | File received successfully |
| 7 | M_ERR | both | Fatal error, session terminated |
| 8 | M_BSY | answerer→caller | System busy, try later |
| 9 | M_GET | receiver→sender | Request file (with resume offset) |
| 10 | M_SKIP | receiver→sender | Skip offered file for now |

**Session flow (caller):**
```
Connect → M_NUL (capabilities) → M_ADR (our addresses)
  → receive M_NUL, M_ADR from answerer
  → M_PWD (session password)
  → receive M_OK or M_ERR
  → file exchange phase (bidirectional)
  → M_EOB when done sending
  → receive M_EOB
  → (binkp/1.1: another batch if this one carried traffic — see below)
  → disconnect
```

**Session flow (answerer):**
```
Accept connection → M_NUL (capabilities) → M_ADR (our addresses)
  → receive M_NUL, M_ADR, M_PWD from caller
  → validate password against peer_connections
  → M_OK or M_ERR
  → file exchange phase (bidirectional)
  → M_EOB when done sending
  → receive M_EOB
  → (binkp/1.1: another batch if this one carried traffic — see below)
  → disconnect
```

**OPT flags** (sent in M_NUL):
- `NR` — non-reliable mode (file CRC verification)
- `MD5` — CRAM-MD5 authentication
- `CRYPT` — link encryption
- `NDA` — no dupes (file-level dupe prevention)

#### binkp/1.1 multi-batch session termination

A binkp/1.1 session is not one exchange, it is a sequence of **batches**. Each
batch ends when both sides have sent M_EOB; the *session* ends only on a batch
that carried nothing but those two M_EOBs. A batch that moved anything is
followed by another one.

This is not optional, and getting it wrong is silent. binkd's `protocol.c`
counts every command frame in either direction as `msgs_in_batch` (data frames
don't count; the counter is zeroed at `complete_login` so handshake traffic is
excluded) and then does:

```c
if (state.remote_EOB && state.sent_fls == 0 && state.local_EOB && ...) {
  if (state.msgs_in_batch <= 2 || (state.major*100 + state.minor <= 100))
    break;                                     /* session over, logs "OK" */
  else {
    state.msgs_in_batch = 0;
    state.remote_EOB = state.local_EOB = 0;    /* both flags cleared */
    continue;                                  /* new batch, new M_EOB */
  }
}
```

If we close instead of answering that second M_EOB, binkd's post-loop check
sees `remote_EOB == 0`, logs the session **`failed`**, and calls `create_poll()`
to re-queue everything it just sent — a redelivery loop, even though every byte
arrived and tossed correctly. Empty sessions land on exactly
`msgs_in_batch == 2` and close after one exchange, which is why only sessions
containing a file ever failed. Fixed 2026-07-29.

Synchronet's BinkIt reaches the same wire behaviour from the other side: it
requires `senteob >= 2 && goteob >= 2` before it will break out cleanly, and
calls `reset_eob()` on every non-M_EOB frame received. That second rule is why
our M_EOB must stay behind any M_GOT we owe — an M_GOT arriving after our
M_EOB zeroes BinkIt's `goteob`, and its `close()` then fires
`M_ERR "Forced Shutdown"`.

Our implementation (`_checkSessionEnd` in `protocols/binkp.js`):

- `_msgsInBatch` counts command frames both ways, reset at the transfer
  transition and at each batch boundary — identical to binkd's accounting.
- On a batch boundary with `_msgsInBatch > 2`, the protocol clears both EOB
  flags, emits `batchEnd`, and sends the new batch's M_EOB itself. A batch
  boundary is only reachable with our send queue already drained, so there is
  never anything to offer in the continuation batch.
- **Version gated.** `peerMultiBatch` parses the peer's `M_NUL VER … binkp/X.Y`
  and only continues for `> 1.00`, the same test binkd applies. binkp/1.0 and
  version-less peers (InternetRex and other pre-1.1 mailers) get byte-identical
  behaviour to the single-batch flow.
- **Close tolerance.** A peer that closes after at least one completed M_EOB
  exchange with nothing pending ends the session as `complete`, not `error`.
  binkd does exactly this whenever a batch held only the two M_EOBs.
- **Idle guard.** `BATCH_IDLE_MS` (10s) ends the session as complete if a
  1.1-advertising peer opens no second batch and doesn't close either.
  `MAX_BATCHES` (8) is a runaway guard; healthy sessions use one or two.

Do not "fix" a peer reporting `failed` by tuning close timing — that was chased
for four rounds on 2026-07-29 and timing was never the variable.

**Key implementation notes:**
- binkp is natively full-duplex — both sides can send files simultaneously. The transfer engine handles interleaved send/receive.
- Data frames carry file content. Command frames carry control. They share the same stream — the command flag bit in the header distinguishes them.
- Resume support via M_GET with a byte offset.
- Passwords are plaintext in basic mode, CRAM-MD5 in MD5 mode (answerer sends a challenge in M_NUL, caller responds with a hash in M_PWD).
- Per FTS-1026, command bodies MAY be NUL-terminated. `_handleCommand()` strips trailing NULs at payload extraction so string comparisons (M_PWD, M_ADR matching) don't silently fail on an invisible byte. Observed with Argus — their M_PWD bodies end in `\0` and JS `.trim()` doesn't touch NULs, so a correct password compared unequal before the fix.
- **Force-plaintext toggle**: `connection_data.force_plain_password` (boolean) on an FTN peer connection makes the caller send plaintext M_PWD even when the answerer offered CRAM-MD5. Escape hatch for peers whose CRAM-MD5 verifier rejects valid digests or whose passwords are asymmetric. Surfaced as a checkbox in the admin peer edit form. Diagnostic level-5 log line on caller-side password send includes the challenge, password length, and computed digest so sysops can reproduce the HMAC with `openssl dgst -md5 -mac HMAC` when chasing CRAM-MD5 mismatches.

### EMSI/Wazoo Protocol (`mailer/protocols/emsi.js`)

The Electronic Mail Standard Identification protocol. Used by FrontDoor, BinkleyTerm, T-Mail, and other legacy mailers. Half-duplex session with ZMODEM file transfer (SEAlink is not implemented).

Implemented: `protocols/emsi.js` (handshake) and `mailer/wazooTransfer.js` (`WazooTransferEngine`, batch exchange over `transfers/zmodem.js`). Inbound sessions are detected by the first byte on the shared listener (`SessionController._detectProtocol()`: `*` means EMSI, a byte >= 0x80 or anything else means binkp); outbound sessions use `connection_data.mailer_protocol`. Status and gaps are tracked in `EMSI_WAZOO_DESIGN.md`.

**Handshake sequence (as built):**
```
Caller sends **EMSI_INQ (retried every 5s, up to 6 times)
  -> Answerer sends **EMSI_REQ
  -> Caller sends EMSI_DAT (system info, addresses, password)
  -> Answerer emits passwordReceived; session validates and calls confirmAuth()
  -> Answerer sends its EMSI_DAT, then EMSI_ACK
  -> Caller sends EMSI_ACK
  -> Wazoo batch exchange: answerer sends first, then caller
```

**EMSI_DAT packet fields:**
- System name, location, operator name, phone, baud, flags
- FTN addresses (AKA list)
- Password
- Link codes (capabilities)
- Compatibility codes (supported transfer protocols)

**File transfer within EMSI sessions:**
After handshake, `WazooTransferEngine` takes over the transport. Files are transferred with the standalone `transfers/zmodem.js` engine using 1K subpackets, ESCCTL and CRC-16 for legacy compatibility; a side with nothing to send runs `ZmodemEngine.sendEmpty()`. We advertise `ZMO,ZAP` in EMSI_DAT.

**Key implementation notes:**
- EMSI is ASCII-based with hex encoding and CRC16 checksums on data packets
- Half-duplex: one side sends, then the other
- The outbound list (`_buildOutboundFileList()`) covers the primary connection only, not grouped AKAs
- No post-send cleanup is done for Wazoo sessions: flow file lines are not marked `~`, and `.out` packets and filebox files are not deleted after sending (binkp does all of this in `TransferEngine`). Flow files are still pruned of vanished entries when the list is built
- Not tested against a live EMSI mailer

---

## Session Controller (`mailer/session.js`)

### Responsibilities

- Manage the lifecycle of a single mailer session (connect → handshake → transfer → disconnect)
- Match inbound connections to peer_connections records by presented FTN address
- Build the outbound file list from the outbound directory for the target address
- Coordinate file receipt (temp file → validate → move to inbound directory)
- Handle transfer errors, resume, and retry
- Report session statistics (files sent/received, bytes, duration)

### Session State Machine

```
IDLE → CONNECTING → HANDSHAKE → AUTHENTICATED → TRANSFER → DONE
                                                    ↓
                                                  ERROR
```

States:
- **IDLE** — not yet started
- **CONNECTING** — transport connection in progress (outbound only)
- **HANDSHAKE** — protocol handshake/authentication in progress
- **AUTHENTICATED** — handshake complete, password verified, peer identified
- **TRANSFER** — file exchange phase (sending and/or receiving)
- **DONE** — session completed normally
- **ERROR** — session failed (auth failure, protocol error, network error)

### Inbound Session Flow

```
Transport accepts connection
  → MailerManager creates SessionController(transport, 'answerer')
  → Protocol module starts answerer handshake
  → Remote presents addresses → lookup peer_connections by FTN address
  → Remote presents password → validate against connection_data.session_password
  → 'authenticated' event → state = AUTHENTICATED
  → Scan outbound directory for packets addressed to this peer
  → Enter TRANSFER state
  → Exchange files (send outbound, receive inbound)
  → Both sides signal EOB → state = DONE
  → Run tosser on inbound files (or flag for next toss cycle)
  → Cleanup
```

### Outbound Session Flow

```
MailerManager decides to call a peer (poll event or outbound mail waiting)
  → Load peer_connection record
  → Resolve host: connection_data.remote_host, or nodelist lookup fallback
  → Create transport (TCP or WebSocket based on connection_data)
  → Connect to host:port
  → MailerManager creates SessionController(transport, 'caller')
  → Protocol module starts caller handshake
  → Present our addresses and password
  → Receive remote addresses → validate against expected peer
  → 'authenticated' event → state = AUTHENTICATED
  → Create TransferEngine (wired BEFORE any async work to avoid M_FILE race)
  → Build outbound file list for this connection
  → Enter TRANSFER state
  → Exchange files
  → Both sides signal EOB → state = DONE
  → Run tosser on inbound files
  → Cleanup
```

### Peer Connection Matching (Inbound)

When a remote system presents FTN addresses during handshake:

1. `_matchPeer()` loads active FTN connections (`getActiveConnectionsByNetworkType('FTN')`) and compares each presented address with `connection_data.address`, normalised (domain stripped, `.0` point suffix stripped, lower case)
2. First pass requires the address AND the `@domain` to match the connection's network domain; second pass matches the address alone. The first match wins and becomes the primary connection
3. Validate `session_password` from `connection_data` against the presented password (CRAM-MD5 or plaintext)
4. No match: the session is refused (`M_ERR`). An "accept unlisted" mode remains a future idea

### Multi-Address Session Grouping

Many FTN systems operate multiple addresses (AKAs) and advertise all of them in M_ADR during the binkp handshake. A single binkp session can now handle outbound mail for all matched connections, avoiding the need for separate sessions per address.

**How it works:**

After authentication succeeds against the primary connection, the session scans for additional `peer_connections` whose `connection_data.address` matches one of the remote's other M_ADR addresses. An additional connection is only grouped into the session if:

1. Its `session_password` is non-empty (unauthenticated connections never get a free ride)
2. Its `session_password` exactly matches the password that was used to authenticate the primary connection

This password-filtered grouping is a security constraint: a malicious remote cannot claim arbitrary extra addresses in M_ADR to receive mail for connections it has not authenticated against. Only connections sharing the same session password are trusted to be operated by the same remote system.

The grouped connections are stored in `this.peerConnections[]` (an array that always contains at least the primary connection). This array is used by:

- **`_buildOutboundList()`** -- iterates all grouped connections independently, scanning BSO outbound directories for each connection's address. No cross-contamination between connections' outbound queues.
- **Manager `_hasSessionForAddress()`** -- checks all grouped connections when deduplicating, so an inbound session already handling `1:123/1` and `1:123/2` prevents a separate outbound poll to either address.

The grouping works for both roles:
- **Answerer**: grouping happens in `_onPasswordReceived()` immediately after password validation
- **Caller**: grouping happens in `_onAuthenticated()` after the remote confirms auth and presents its addresses

Single-address sessions are fully backward compatible -- `peerConnections` is an array of one.

### Local Address Advertisement

`_getLocalAddresses()` sends ALL active FTN addresses across all configured networks in the M_ADR frame. Addresses are sorted with defaults first (`is_default = true`) so the remote sees the primary address for each network before alternates. This allows remote systems to discover all our AKAs and perform their own multi-address grouping.

### File List Management

**Outbound files** for a peer are determined by:
- `.pkt` files in the outbound directory addressed to the peer's FTN address (or routed through the peer via ftnRouter)
- File attach references from netmail (`.flo` flow files or direct file references)
- TIC file bundles pending for the peer

**Inbound files** are written to a temp directory during transfer, then moved to the inbound directory on successful completion. Partial transfers are kept for resume on the next session.

**Outbound directory structure (BSO — Binkley-Style Outbound):**

Zone 1 (default zone) uses the base outbound directory. Alternate zones use a `.NNN` hex suffix on the directory name:

```
ftn/out/                    — zone 1 (default)
  <net-hex><node-hex>.flo   — flow file (normal flavour)
  <net-hex><node-hex>.clo   — flow file (crash)
  <net-hex><node-hex>.hlo   — flow file (hold)
  <net-hex><node-hex>.out   — direct packet (normal)
  <net-hex><node-hex>.cut   — direct packet (crash)
  <net-hex><node-hex>.hut   — direct packet (hold)
ftn/out.002/                — zone 2
  <net-hex><node-hex>.flo
  ...
ftn/out.003/                — zone 3
  ...
```

Example: peer `2:200/100` → zone dir `ftn/out.002/`, filename stem `00c80064` (net 200 = 0x00c8, node 100 = 0x0064).

The FTN tosser writes packets and flow files to the zone directory for the destination (`getOutboundDirForZone()` in `ftnTosser.js`), matching the mailer's own resolution.

---

## Mailer Manager (`mailer/manager.js`)

### Responsibilities

- Start/stop the mailer system
- Manage the TCP server listener for inbound binkp/EMSI connections
- Accept inbound WebSocket connections: on its own HTTP listener (`MAILER_WS_PORT`) in separate mode, or from a `WsPool` on the gateway's `WsManager` in embedded mode
- Maintain a pool of active sessions
- Schedule outbound polls based on connection configuration
- Provide session status for admin/logging

### Poll Scheduling

Outbound calls are triggered by:

1. **BSO scanner** — periodic directory scan discovers pending outbound mail and triggers connections via `ftnRouter.resolveRoute()`. Handles both peer connections and nodelist-resolved addresses. See `BSO_SCANNER_DESIGN.md`.
2. **On-demand BSO scan** — tossers enqueue `bso-scan` jobs on the mailer queue after writing outbound packets, triggering an immediate scan cycle.
3. **Timed poll**: BullMQ repeatable `poll-scheduled` jobs, registered by the gateway (`src/queues/schedules.js`) for FTN connections with `poll_enabled`.
4. **Manual**: admin triggers an outbound call via route or CLI (`trigger-poll`, `nodelist-connect` jobs).
5. **HOLD** connections are never polled; they wait for the remote system to call us.

Mailer queue jobs are added through `jobs.addDeduped()`, so a request whose job id is already waiting or running is folded into it, while one whose earlier job has finished runs again.

Maintenance mode refuses every outbound connection at the two choke points, `_connectToPeer()` and `connectToNodelistAddress()`, even a forced poll (see `docs/sysop/MAINTENANCE.md`).

### BSO Scanner (`mailer/bsoScanner.js`)

The BSO scanner runs inside the mailer process on a configurable `setInterval` timer (default 60s). It reads the BSO outbound directory tree, parses filenames to extract destination addresses and delivery flavours, and triggers mailer connections for each address with pending non-Hold mail.

Key behaviors:
- **Flow files pruned first**: `floFile.pruneFlowFile()` marks lines naming vanished files and deletes an exhausted flow file before the address counts as having mail; otherwise a flow file with nothing left to send triggers a connection every scan. The session's outbound list builders prune too
- **Source-agnostic**: discovers files regardless of who created them (tossers, external tools, manual drops)
- **Flavour-aware**: Crash/Immediate trigger immediate connections, Normal/Direct connect on scan, Hold waits for inbound
- **Debounced**: multiple rapid `scanNow()` calls collapse into at most two scans
- **Route resolution**: uses `ftnRouter.resolveRoute()` for the full 4-step cascade (direct peer, routing rule, nodelist direct, coordinator walk)

BSO filename format: `NNNNNNNN.ext` where first 4 hex chars = net, last 4 = node, zone from directory.

### Outbound Connect Backoff

Repeated outbound connect failures to the same peer are gated by exponential backoff so a misconfigured or offline remote doesn't generate a failed poll every cycle. State lives in the peer's `connection_data` JSONB (no schema change):

- `consecutive_failures` — bumped on each TCP-level or session-level failure, reset to 0 on a successful session (reason=complete)
- `last_failure_at`, `last_failure_reason` — human-visible diagnostics
- `next_allowed_poll_at` — backoff window expiry (ISO timestamp)
- `last_success_at` — last clean session

Formula: `delay = min(poll_interval * 2^(failures - 1), cap) minutes` with ±10% jitter, cap configurable via `mailer_backoff_max_hours` (default 24h). So with a 60-minute base: fail 1 → ~1h, fail 2 → ~2h, fail 3 → ~4h, … capped at 24h.

Failure is recorded in two places:
- `MailerManager._connectToPeer()` `transport.once('error')` — pre-session failures (TCP refused, DNS, timeout)
- `MailerManager._createSession()` `session.on('sessionEnd')` — post-handshake failures (`auth failed`, `connection closed unexpectedly`, etc.). Inbound answerer sessions are excluded from this tracking since they don't affect the outbound schedule.

Success clears the counter immediately. The guard lives in `_connectToPeer()`, which every outbound path comes through, and `triggerPoll()` (admin manual) passes `{ force: true }` so a sysop can force a retry.

It used to be checked in `pollConnection()` only. The BSO scanner calls `_connectToPeer()` directly whenever there is mail waiting, so a peer that was refusing connections got retried on every scan cycle (60 seconds by default) and the configured backoff did nothing at all. Adding the check to the scanner fixed that one caller and left the same trap for the next, so it moved to the shared entry point.

**Nodelist-routed addresses** have no `peer_connections` row and therefore no `connection_data` to hold backoff state, so they had no backoff of any kind. `MailerManager` keeps an in-memory map for them (`_nodelistBackoff`, address to failures and next allowed time) with the same doubling and cap, fed by both the connect error and the session end, and cleared when a session finally completes. In memory rather than persisted: these are transient routes rather than configured links, `mailer_sessions` is the durable record, and starting clean after a restart is right for a route that may exist for one batch of mail. Admin peer detail view shows current failure count, next allowed time, last reason, and a Reset button.

Saving the connection's edit form keeps the backoff state (#66: it used to drop it, along with NNTP/QWK `high_water_marks`, because `buildConnectionData` returns only the keys a form edits). `mergeConnectionData` carries every other key through, and clears the failure count, next allowed time and reason only when the dial target changes (`address`, `remote_host`, `remote_port`, `mailer_transport`, `mailer_protocol`, `mailer_ws_url`), since those failures were against the old target. `last_success_at` and `last_failure_at` are kept either way.

Config: `mailer_backoff_enabled` (default `true`) to toggle globally, `mailer_backoff_max_hours` for the cap.

Model helpers: `peerConnections.recordConnectFailure`, `recordConnectSuccess`, `resetBackoff`, `isInBackoff`, `computeBackoffDelayMs`. JSONB writes use `jsonb_set` so concurrent updates don't clobber sysop config edits on the same row.

### Session History and Diagnostics

Backoff state above is *current* state: it is overwritten on every attempt, so it
answers "is this peer in trouble right now" and cannot answer "what happened the
last five times we called". `mailer_sessions` keeps the history.

One row is written per attempt, in both directions, including attempts that never
opened a socket. That last part matters: the peer failing hardest is the one that
never gets far enough to have a session, and recording only completed handshakes
would leave it looking like the quietest node on the board.

Columns of note:

- `direction` -- `out` for caller sessions, `in` for answerer
- `outcome` -- `complete`, `connect_failed`, `auth_failed`, `timeout`, `busy`,
  `error`. Session end reasons are free text from several places, so
  `MailerManager._classifyOutcome()` buckets them for grouping while `reason`
  keeps the original string
- `peer_software` / `peer_system` / `peer_sysop` -- the peer's M_NUL `VER`, `SYS`
  and `ZYZ` lines, useful when a remote's behaviour turns out to be
  implementation specific
- `remote_addresses` -- every AKA the far end presented, as JSONB
- `bytes_sent` / `bytes_received` -- BIGINT, so they arrive back from postgres as
  strings. `utils/mailerFormat.js` accepts both

`peer_connection_id` is null for inbound calls from systems with no peer record
and for nodelist-resolved outbound. Those are listed separately in the admin view
rather than dropped: the first may be someone trying to link, the second is a
route taken without a configured peer.

Capture points:

- `SessionController._endSession()` -- the `sessionEnd` event carries everything
  the history row needs, gathered by `getPeerInfo()`. It has to travel with the
  event: by the time the manager handles it the transport is closing and the
  protocol handler is on its way out
- `MailerManager._recordSessionHistory()` -- writes the row
- `MailerManager._recordConnectFailure()` -- the TCP and WebSocket
  `transport.once('error')` paths in `_connectToPeer()`, for attempts that never
  became a session; `connectToNodelistAddress()` writes its own row the same way

Writes are diagnostic only. Nothing reads them to make a decision, and a failed
insert is logged and swallowed rather than taking a session down with it.

### Outbound File Log

`inbound_file_log` has always recorded what arrived. `outbound_file_log` is its
mirror, written on `M_GOT`, so a row means the peer acknowledged the file rather
than that we started pushing it.

Kept as a separate table rather than a `direction` column on the inbound one
because the FTN tosser looks packets up in that table by filename to trace who
sent them, and a widened table would have to exclude our own sends from every one
of those lookups.

Note that `SessionController.bytesSent` was declared, reported in `getStatus()`
and carried through the whole mailer while nothing ever incremented it, because
`TransferEngine`'s `sendComplete` did not say how big the file was. Every session
reported zero bytes out, which looked plausible next to a working inbound count.
Fixed by adding `size` to that payload.

### Admin Views

- `/admin/mailer` -- per-peer rollup over a selectable window (24h / 72h / 7d /
  30d) with last contact, last success, success rate and traffic each way, then a
  recent-sessions feed across all peers, then sessions with no peer record.
  Trouble sorts first. FTN connections only: a QWK or NNTP peer is tossed to
  rather than dialled, so it has no sessions and would read as permanently broken
- `/admin/peer/:uuid` -- recent sessions per connection, plus the last packet in
  and out
- `/admin/outbound-log` -- the outbound file log, mirroring `/admin/inbound-log`
- `/admin/transfers` -- the QWK and NNTP counterpart of `/admin/mailer`, reading `network_transfers` (one row per pull or push; retention `network_transfer_retention_days`, default 30). Not a mailer table; listed here because it answers the same question for peers that are not dialled

`utils/mailerFormat.js` holds the presentation logic (byte formatting, relative
ages, outcome labelling, the per-connection summary) so the two views cannot
disagree about what "ok" or "stale" means. A peer that has never been contacted is
deliberately **not** flagged: a newly added node has not failed, and painting it
red before it has had a chance to poll is noise in the view meant to cut noise.
Likewise a connection with no attempts in the window reports a null success rate
rather than 0%, since zero of zero is not a failure.

Retention: `mailer_session_retention_days` (default 30) and
`outbound_log_retention_days` (default 90), purged by daily maintenance jobs
alongside the existing inbound log purge.

### Connection Deduplication

Before initiating an outbound call, check the active session pool. If a session to the same peer (by FTN address) already exists (inbound or outbound), skip the outbound call -- the existing session will handle the file exchange. For multi-address sessions, `_hasSessionForAddress()` checks both the session's `peerAddresses` array and all `peerConnections[].connection_data.address` entries, so a session already handling multiple AKAs correctly blocks duplicate outbound polls to any of those addresses.

### Server Listeners

TCP listener is owned by the MailerManager on `MAILER_BINKP_PORT` (default 24554). WebSocket listener operates in two modes: **separate mode** — the manager creates its own HTTP server on `MAILER_WS_PORT` (default 24555) with a `WebSocketServer({ noServer: true })`; **embedded mode** — a `WsPool` on the gateway's `WsManager` at `/ws/mailer/binkp` routes connections to the manager via `setWebSocketPool()`.

```javascript
class MailerManager {
    constructor(options)

    start()                              // Bind TCP + WS listeners, start BSO scanner
    stop()                               // Graceful shutdown: finish active sessions, unbind all listeners
    setWebSocketPool(wsPool)             // Receive inbound WS connections (embedded mode)
    getActiveSessions()                  // Array of session status objects
    isRunning()                          // Boolean

    setMaintenance(active)               // Maintenance mode: refuse outbound connects
    // Outbound polling
    pollConnection(connectionUUID)       // Production path: checks _running, outbound mail, then connects
    triggerPoll(connectionUUID)          // Manual path: bypasses _running, outbound mail and backoff checks
    signalOutbound(connectionUUID)       // signal-outbound job: CRASH = immediate poll, NORMAL = next cycle
    scanOutboundNow()                    // Trigger immediate BSO scan (delegates to BsoScanner)
    connectToNodelistAddress(nodelistData, address) // Caller session with no peer record

    // Internal
    _onInboundTcp(socket)                // Wrap in TcpTransport, create answerer session
    _onInboundWebSocket(ws, request)     // Wrap in WsTransport, create answerer session
    _connectToPeer(conn, opts)           // Shared: maintenance + backoff guards, resolve host/port/transport, create caller session
    _createSession(transport, role, opts) // Instantiate SessionController, wire events, add to pool
    _hasSessionForAddress(address)       // Deduplication check
    _hasOutboundMail(peerAddress)        // Scan BSO outbound for flow/packet files
}
```

Timed polls are not scheduled by the manager; the gateway registers `poll-scheduled` BullMQ schedules and `bin/mailer.js` consumes them.

### Configuration (environment variables)

`MAILER_ENABLED`, `MAILER_BINKP_PORT` and `MAILER_WS_PORT` are read from `process.env`. The rest are read through `appConfig`, so the `.env` file (or a settings row) supplies them.

| Variable | Default | Description |
|----------|---------|-------------|
| `MAILER_ENABLED` | `false` | Master enable/disable |
| `MAILER_BINKP_PORT` | `24554` | TCP listen port for binkp |
| `MAILER_WS_PORT` | `24555` | HTTP listen port for binkp WebSocket (0 to disable; separate mode only) |
| `MAILER_INBOUND_DIR` | `ftn/in` | Inbound file directory (falls back to `ftninbound` env var) |
| `MAILER_OUTBOUND_DIR` | `ftn/out` | Outbound file directory (falls back to `ftnoutbound` env var) |
| `MAILER_TEMP_DIR` | `ftn/tmp` | Temp directory for in-progress transfers |
| `MAILER_MAX_SESSIONS` | `10` | Maximum concurrent sessions |
| `MAILER_POLL_INTERVAL` | `900` | Default poll interval in seconds |
| `MAILER_CONNECT_TIMEOUT` | `30` | Outbound connection timeout in seconds |
| `MAILER_SESSION_TIMEOUT` | `300` | Maximum session duration in seconds |
| `MAILER_BSO_SCAN_INTERVAL` | `60` | BSO outbound directory scan interval (seconds) |
| `MAILER_BSO_SCAN_ENABLED` | `true` | Enable/disable periodic BSO scanning |
| `MAILER_DEFAULT_ZONE` | `1` | Default FTN zone for the base outbound directory |

### Nodelist-Resolved Outbound Connections (Phase 3)

When the FTN router returns a `routeResult` with `method='nodelist_direct'` or `method='coordinator'`, the result has `connectionUUID: null` and carries `nodelistData` instead of referencing a peer_connection. The mailer needs a separate code path:

1. If `routeResult.connectionUUID` exists: use existing `_connectToPeer(conn)` path (host/port from connection_data).
2. If `routeResult.nodelistData` exists: connect to `nodelistData.hostname:nodelistData.binkpPort`. No session password (present `-` or use CRAM-MD5 with empty secret). Session runs in caller mode without a connectionUUID.

Nodelist routes are stored in `ftn_nodelist` (imported via `import-nodelist` maintenance job). The `ftnNodelist.findConnectable()` lookup filters for `is_ibn=true`, `hostname IS NOT NULL`, and `keyword NOT IN ('Down','Hold','Pvt')`.

---

## Transfer Engine (`mailer/transfer.js`)

### Responsibilities

- Manage concurrent file send and receive operations within a session
- Handle CRC verification, resume from offset, and compression
- Track transfer progress (bytes, percentage, speed)
- Write inbound files to temp directory, move to inbound on completion
- Read outbound files and feed to protocol module

### Transfer Operations

```javascript
class TransferEngine {
    constructor(protocol, options)

    queueFile(filepath, options)          // Queue a file: { floFile, floPrefix, deleteAfterSend }
    startSending()                        // Begin offering queued files
    markAllQueued()                       // No more files will be queued (allows M_EOB)
    cleanup()                             // fd/stream teardown

    get sendQueue()                       // Array of pending outbound files
    get isReceiving()
    get isSending()

    // Events: 'sendProgress', 'receiveProgress', 'sendComplete',
    //         'receiveComplete', 'allSent', 'transferError'
}
```

Receiving is driven by the protocol's `fileOffered`/`fileData`/`fileComplete` events rather than by a public method. Offered filenames are sanitised (basename only, `..` rejected).

### Inbound File Handling

```
Protocol signals file offer → TransferEngine.receiveFile()
  → create temp file in MAILER_TEMP_DIR/<session-id>/
  → write chunks as fileData events arrive
  → on fileComplete: verify size (and CRC if available)
  → move to MAILER_INBOUND_DIR
  → protocol sends M_GOT (binkp) or ACK (Zmodem)
```

### Outbound File Handling

```
SessionController builds file list -> TransferEngine.queueFile() per file
  -> read file, feed chunks to protocol sendFileData()
  -> protocol frames and transmits
  -> remote sends M_GOT -> outbound_file_log row
  -> cleanup by flow file prefix: ^ delete, # truncate, none leave;
     the flow file line is marked ~ (sent). Direct packets and
     filebox files are deleted (deleteAfterSend)
```

### Resume Support

Both binkp and Zmodem support resume:
- **binkp**: Remote sends M_GET with offset. TransferEngine seeks into the file and begins sending from that offset.
- **Zmodem**: Built-in crash recovery. Receiver reports last good position, sender resumes.

Partial inbound files in the temp directory are kept between sessions. On the next session with the same peer, if the remote offers a file that matches a partial, the protocol requests resume from the existing offset.

---

## Outbound Fileboxes

Each FTN peer connection can optionally have an `outbox_dir` configured in `connection_data`. Files placed in this directory are automatically sent to the peer and deleted after successful delivery.

### Use Case

Inter-BBS (IBBS) door games (LORD, TradeWars, etc.) drop outbound files into directories. DOS-based games have no knowledge of BSO transports or netmail file-attach. Outbound fileboxes bridge this gap -- the sysop configures the game's output directory as the peer's `outbox_dir`, and the mailer handles delivery.

### Path Resolution

The `outbox_dir` value supports `%X` variable substitution via `configvars.js` (e.g. `%M/lord/outbound/` expands the DOSemu drive_c path). After substitution:
- Absolute paths are used as-is
- Relative paths resolve under `filebox_base_dir` config (default: `ftn/filebox`)

Resolution is handled by `resolveFileboxPath()` in `src/utils/fileboxPath.js`.

### Scanner Integration

The BSO scanner (`bsoScanner.js`) checks outbox directories alongside the normal BSO hex-addressed scan. For each active FTN connection with `outbox_dir` set, if the directory exists and contains files, the connection's address is added to the scan results. The connection's `status` field determines the BSO flavour (NORMAL/CRASH/HOLD).

### Session Integration

During `_buildOutboundList()`, the session controller scans each connection's `outbox_dir` (if configured) after the normal BSO flow file and packet scan. All files found are queued with `deleteAfterSend: true`. EMSI/Wazoo sessions include the primary connection's filebox in their list too, but do not delete the files after sending (see the EMSI section).

---

## Inbound Wildcards

Sysop-configurable rules that route received files to specific directories based on filename patterns, instead of the default `ftn/in/` landing zone.

### Use Case

Same IBBS motivation as outbound fileboxes -- door games expect inbound files in specific directories. Wildcards like `LORD*.*` route game packets directly to the game's inbound directory without requiring the sysop to manually move files.

### Schema

The `file_wildcards` table stores rules with: `pattern` (glob), `target_dir` (destination), `still_toss` (boolean, default false), `sort_order`, `active`. Model: `src/models/fileWildcards.js`.

### Transfer Integration

In `TransferEngine._onFileComplete()`, after file verification, the filename is tested against cached wildcard rules (loaded once, invalidated on change). First match wins. Matched files are moved to the resolved `target_dir` instead of `ftn/in/`. The `receiveComplete` event includes `skipToss: true` for matched files (unless `still_toss` is set), and the session tracks `filesToToss` separately from `filesReceived`. The mailer manager only triggers toss jobs for files that need tossing.

### Admin UI

Managed at `/admin/wildcards` with drag-to-reorder, create/edit modals, and a filename test tool. Listed under Networking in the admin navbar.

### Design Doc

Full design details in `docs/reference/FILEBOX_WILDCARD_DESIGN.md`.

---

## Integration Points

### Existing Infrastructure Used

| Component | How the mailer uses it |
|-----------|----------------------|
| `peer_connections` | Outbound: load connection params (host, port, passwords, transport type). Inbound: match presented FTN address to find the peer, validate session password. |
| `connection_data` JSONB | New mailer-specific fields added alongside existing fields. No schema migration needed — JSONB is additive. |
| `ftnRouter` | Determine which outbound packets route through which connection. Already handles direct match, wildcard rules, and status-based flavour selection. |
| `ftnTosser` | Prepares `.pkt` files in outbound directory (existing `TossOutbound`). Processes `.pkt` files from inbound directory (existing `TossInbound`). The mailer sits between these two operations. |
| `ftnClasses` | Packet/Message classes for packet header inspection (reading dest address from outbound packets to match to connections). |
| `systemAddresses` | Our FTN addresses, presented during handshake. Origin lines for any locally-generated session messages. |
| `alogger` | Session logging via `writeClog()` with `'mailer'` filename — all mailer output goes to `logs/<env>/mailer.log`, separate from the main system log. |

### Tosser Integration

The mailer does not toss — it only moves files. Inter-process signaling uses BullMQ queues (see `PROCESS_ARCHITECTURE.md`).

1. **Inbound**: When a session finishes receiving files, the mailer emits `filesReceived` and enqueues a `ftn:inbound` job on the toss queue. The worker process picks it up and runs `TossInbound()`.

2. **Outbound**: The FTN and TIC tossers, after writing packets and flow files, enqueue a `bso-scan` job on the mailer queue (`jobs.enqueueMailerBsoScan()`). The mailer runs an immediate BSO scan, which connects to every address with pending non-Hold mail. `signal-outbound` is still consumed by the mailer but nothing in the tossers enqueues it any more.

Inbound toss jobs (`ftn:inbound`, `tic:inbound`) are enqueued by `bin/mailer.js` on the manager's `filesReceived` event.

### Admin Routes

Implemented, on the Jobs & Maintenance page (`/admin/events`, Mailer tab):

- `POST /admin/events/poll` — manual poll for a single target. Body: `{ target }`, accepting
  either an FTN address (4D or 5D) or a peer connection UUID. A UUID enqueues `trigger-poll`
  for that connection directly. An address goes through `ftnRouter.resolveRoute()`, so it
  enqueues `trigger-poll` when a peer connection matches and `nodelist-connect` when the node
  is only reachable via an imported nodelist. Both job types bypass the outbound-mail and
  backoff guards, which is the point of a manual poll. Returns as soon as the job is queued;
  session results appear in the mailer log.
- `POST /admin/events/trigger` with `{ job: 'bso-scan' }` — on-demand BSO outbound scan.

Also implemented: `GET /admin/mailer` (session history rollup, see Admin Views above).

Still future:

- a live view of active sessions with transfer progress
- `POST /admin/mailer/stop` / `POST /admin/mailer/start`: control the mailer without a restart

---

## Directory Structure

```
src/mailer/
  manager.js          - MailerManager (server listeners, poll scheduling, session pool)
  session.js          - SessionController (per-session state machine, file list, peer matching)
  transfer.js         - TransferEngine (file send/receive, resume, CRC)
  wazooTransfer.js    - WazooTransferEngine (EMSI batch exchange over ZMODEM)
  bsoScanner.js       - BsoScanner (periodic BSO outbound scan)
  transports/
    base.js           - BaseTransport (interface definition)
    tcp.js            - TCP client/server transport
    ws.js             - WebSocket client/server transport
  protocols/
    binkp.js          - binkp/1.1 protocol implementation
    emsi.js           - EMSI handshake (Phase 4)
src/transfers/
  zmodem.js           - Standalone ZMODEM engine (mailer EMSI + terminal file transfers)
tests/                - mocha suite, including binkpFrames, binkpMultiBatch, emsiProtocol,
                        wazooTransfer, mailerBackoff, peerBackoff, mailerDiagnostics,
                        mailerMaintenance, floFile
tests/mailer/         - older standalone scripts, not run by npm test
  README.md           - Test documentation and run instructions
  test-binkp-frames.js - Unit: binkp frame encoding/decoding, CRAM-MD5 (41 assertions, no dependencies)
  test-loopback.js    - Integration: paired in-memory transports, handshake + file transfer (5 scenarios)
  test-tcp-loopback.js - Integration: real TCP sockets, full stack validation
  test-ws-loopback.js - Integration: WebSocket transport
  binkp-echo.js       - Manual: standalone binkp answerer server (accepts connections, receives files)
  binkp-send.js       - Manual: standalone binkp caller (connects, authenticates, sends files)
  trigger-poll.js     - Manual: triggers outbound poll by connection UUID or FTN address (requires DB)
```

---

## Implementation Plan

### Phase 1: TCP Transport + binkp Core (Implemented)

Build the minimum viable mailer that can exchange files with a remote binkd system.

1. **BaseTransport + TCP transport** — `BaseTransport` abstract class with `write`/`close`/`destroy`/`remoteAddress`/`isConnected`. `TcpTransport` with `fromSocket()` (inbound) and `connect()` (outbound) factory methods. `setNoDelay` enabled.
2. **binkp frame parser** — accumulator-based parser handles partial frames, multi-frame batches, and max-size frames. Big-endian 2-byte header with command flag (bit 15) and 15-bit payload length.
3. **binkp protocol module** — all 11 command types (M_NUL through M_SKIP). Caller and answerer handshake flows. CRAM-MD5 challenge/response authentication (answerer generates challenge in M_NUL OPT, caller responds with HMAC-MD5 in M_PWD). `confirmAuth()` for answerer-side password validation delegation to session controller. Full-duplex file send/receive negotiation.
4. **Session controller** — state machine (idle → handshake → authenticated → transfer → done/error). Inbound peer matching against `getActiveConnectionsByNetworkType('FTN')` by presented address. Password validation with CRAM-MD5 and plaintext fallback. Outbound file list building from BSO flow files (`.flo`/`.clo`/`.dlo`/`.hlo`/`.ilo`) and direct packet files (`.out`/`.cut`/`.hut`). Local address resolution via `systemAddresses`.
5. **Transfer engine** — file queue, 4KB chunk reads, `sendProgress`/`receiveProgress`/`sendComplete`/`receiveComplete`/`allSent` events. Inbound: write to temp dir, verify size on stream `finish` callback, move to inbound dir. Resume support via partial file detection and M_GET offset. `cleanup()` for fd/stream teardown.
6. **Mailer manager** — TCP listener on `MAILER_BINKP_PORT`. `pollConnection()` (production, checks `_running` + outbound mail) and `triggerPoll()` (manual, bypasses guards). Shared `_connectToPeer()`. Session pool with deduplication by FTN address. Poll scheduling for NORMAL connections. `signalOutbound()` for CRASH immediate delivery. M_BSY frame on max sessions. `pollFailed` event for test tooling.
7. **connection_data extensions** — admin peer connection UI updated with Direct/Route To selector, Mailer Host, Mailer Port fields in both new and edit connection modals. `buildConnectionData()` already handled the form fields.
8. **Logging** — all mailer modules use `writeClog` with `'mailer'` filename, writing to `logs/<env>/mailer.log`.

**Milestone reached**: Loopback tests pass (in-memory paired transports, real TCP sockets). Manual tools (`binkp-echo`, `binkp-send`, `trigger-poll`) work for end-to-end testing. CRAM-MD5 authentication, file transfer with content verification, resume support, and poll scheduling are functional.

### Phase 2: Reliability + Polish

Items 8–10 from the original plan (resume support, CRAM-MD5, poll scheduling) were implemented in Phase 1. Remaining work:

8. ~~**Real-world binkd testing**~~: **DONE.** Live sessions with binkd, BinkIt and Argus peers; the fixes that came out of it are recorded above (multi-batch termination, NUL-terminated command bodies).
9. ~~**Outbound queue signaling**~~: **DONE**, since superseded: the tossers now enqueue `bso-scan` rather than `signal-outbound` (see Tosser Integration).
10. ~~**Sent file cleanup**~~: **DONE** for binkp in `TransferEngine` (`^` delete, `#` truncate, lines marked `~`). Not done for EMSI/Wazoo.
11. ~~**Session logging**~~: **DONE**, as the `mailer_sessions` table (see Session History and Diagnostics) plus `mailer.log`.
12. ~~**Path traversal prevention**~~: **DONE** in `TransferEngine` filename sanitisation.
13. ~~**Admin status route**~~: **DONE** as `GET /admin/mailer` (history; no live active-session view).
14. ~~**Startup integration**~~ — **DONE.** In embedded mode, `bin/gateway.js` starts the mailer in-process. In separate mode, `bin/mailer.js` is the standalone entry point. Both are gated by `MAILER_ENABLED` env var. See `PROCESS_ARCHITECTURE.md`.

### Phase 3: WebSocket Transport (Implemented)

15. **WebSocket transport** — `WsTransport` class (`mailer/transports/ws.js`) wrapping `ws` connections. **Inbound (separate mode):** the mailer process binds its own HTTP listener on `MAILER_WS_PORT` (default 24555) at path `/ws/mailer/binkp`. **Inbound (embedded mode):** a `WsPool` registered on the gateway's `WsManager` at `/ws/mailer/binkp`. **Outbound:** `ws` client to remote `mailer_ws_url`. Binary frame mode. Application-level pause buffering for flow control during async session setup.
16. ~~**Admin UI for transport selection**~~: **DONE.** Transport, protocol and WebSocket URL are in the new and edit connection forms.
17. **Connection testing**: admin button to test connectivity to a peer (TODO; the manual poll on `/admin/events` is the nearest thing)

### Phase 4: EMSI/Wazoo Support (Largely implemented)

Items 18 to 21 are built; post-send cleanup for Wazoo and a live test are outstanding. See `EMSI_WAZOO_DESIGN.md`.

18. **EMSI handshake** — EMSI_REQ/EMSI_INQ/EMSI_DAT/EMSI_ACK negotiation
19. **Wazoo session layer** — batch file exchange orchestration
20. **Zmodem transfer module** — standalone, event-driven Zmodem implementation (`transfers/zmodem.js`) that operates on any bidirectional byte stream, not coupled to the mailer. Used by the EMSI protocol module for mailer sessions, but equally usable by terminal connection handlers for user file uploads/downloads (Zmodem over telnet/TCP/WebSocket). See Design Decision #9.
21. **Protocol auto-detection** — on inbound connections, detect whether the remote is speaking binkp or EMSI based on the first bytes received

### Phase 5: Advanced Features

22. **TLS support** — for both TCP and WebSocket transports
23. ~~**File attach handling**~~ — **DONE.** Inbound: FTN tosser parses the file-attach flag (attribute word bit 0x0010) from type-2 packet netmail and links received files from `ftn/in` to the PM via `pm_attachments`. Outbound: tosser sets the file-attach flag on the attribute word and writes attachment paths as `.flo` flow file entries for binkp delivery. See `PM_ARCHITECTURE.md` Attachments section.
24. ~~**TIC file processing**~~: **DONE** (`ticTosser.js`, see `FILES_ARCHITECTURE.md`).
25. ~~**BSO zone directory support in tosser**~~: **DONE** (`getOutboundDirForZone()` in `ftnTosser.js`).
26. ~~**Nodelist integration**~~: **DONE** for IP lookup and routing (`ftnNodelist.js`, `connectToNodelistAddress()`, see `NODELIST_DESIGN.md`).
27. ~~**AreaFix/FileFix**~~: **DONE** (`areafix.js`, `filefix.js`).
28. **Compression** — binkp CRYPT/compressed data frames (if demand exists)

---

## Key Design Decisions

1. **Transport-protocol separation**: Transports and protocols are independent modules connected by a byte-stream interface. This avoids the common mailer pitfall of coupling TCP socket handling with binkp frame parsing. Adding WebSocket support or a new protocol doesn't touch existing code.

2. **Session controller as orchestrator**: The session controller doesn't parse frames or manage sockets. It coordinates: tell the protocol to start, react to protocol events (authenticated, file offered), tell the transfer engine to send/receive, and manage the session lifecycle. This keeps each component focused and testable.

3. **Existing peer_connections as config source**: No separate mailer configuration database. All connection parameters, passwords, and routing rules come from the same `peer_connections` and `connection_data` that the tosser already uses. One place to configure a peer.

4. **Mailer does not toss**: Clear separation of concerns. The mailer moves files. The tosser processes them. They communicate via the filesystem (inbound/outbound directories). This means either can be replaced independently, and the tosser can still work in directory-drop mode without the mailer for systems that use external mailers.

5. **Event-driven, not threaded**: Node.js event loop handles concurrency naturally. Multiple sessions run cooperatively via async I/O. No thread pool, no locking, no shared-state hazards. The `MailerManager` tracks sessions in a plain array.

6. **binkp first, EMSI second**: binkp is the dominant protocol for modern FTN systems. Most active FidoNet nodes run binkd. EMSI support is for backward compatibility and can be deferred without blocking useful functionality.

7. **WebSocket as first-class transport, shared infrastructure**: Not an afterthought. The transport abstraction is designed from the start to support WebSocket alongside TCP. In embedded mode, inbound WebSocket connections use the existing `WsManager`/`WsPool` path-routing system (shared with the terminal server): the mailer registers a pool at `/ws/mailer/binkp` on the gateway's HTTP server, and `httpServer.on('upgrade')` routes by pathname. In separate mode (the default) the mailer process runs its own HTTP listener on `MAILER_WS_PORT` for the same path. Outbound WebSocket connections use the `ws` client library directly. This enables novel topologies (relay nodes, browser bridges, serverless mailer endpoints) without protocol changes or additional ports.

8. **BSO outbound with zone directories**: The outbound uses Binkley-Style Outbound conventions. Zone 1 (default) is the base outbound directory (`ftn/out/`). Alternate zones get a `.NNN` hex suffix (`ftn/out.002/` for zone 2). Filenames are `<net-hex><node-hex>` with extensions indicating flavour (`.flo`/`.clo`/`.hlo` for flow files, `.out`/`.cut`/`.hut` for direct packets). This is the standard BSO layout understood by binkd and other FTN mailers.

9. **Zmodem as a standalone reusable module**: The Zmodem implementation should be a general-purpose event-driven module (`transfers/zmodem.js`) that operates on any bidirectional byte stream — not wired to the mailer's transport layer specifically. The module takes a stream-like object with `write(buffer)` and `on('data')`, and exposes `send(filepath)` / `receive(directory)` with progress events. This means the same Zmodem code is used by the EMSI mailer protocol for FTN sessions **and** by terminal connection handlers for user file uploads and downloads over telnet, TCP, or WebSocket. The terminal side would switch the `IncomingCall` to raw mode (bypassing the ANSI input parser) and pipe socket data directly through the Zmodem module — the same pattern used for door I/O. This avoids maintaining two Zmodem implementations or shelling out to external `sz`/`rz` binaries.

10. **Separate poll and trigger paths**: `pollConnection()` is the production path — checks `_running`, verifies outbound mail exists, respects HOLD status, and silently skips when there's nothing to do. `triggerPoll()` is the manual/admin path — bypasses all guards and always initiates a connection, even with no outbound mail (useful for testing auth, receiving inbound files, or forcing a session). Both share `_connectToPeer()` for the actual transport setup. This avoids admin and test tools needing to mock outbound state or set `_running = true`.

---

## Security Considerations

- **Session passwords** are stored in `connection_data` JSONB. For CRAM-MD5, the password must be stored in a form that allows computing the HMAC (plaintext or a reversible format — not a one-way hash).
- **Inbound connections from unknown addresses** should be rejected by default. A future "accept unlisted" mode could allow connections with restricted capabilities (no file send, receive only).
- **Transfer validation**: Verify file sizes match the offered size. Verify CRC when the protocol supports it (binkp NR mode). Never execute received files — they go to the inbound directory for the tosser to process.
- **Path traversal prevention**: Strip directory components from offered filenames. Write only to the designated temp/inbound directories.
- **Rate limiting**: Maximum concurrent sessions per remote address. Connection attempt throttling for failed authentications.
- **Sanitize session data**: Apply `sanitizeMessageFields()` (see `message_architecture.md`) if any session-negotiated strings (system name, operator name) are stored or displayed. EMSI_DAT contains user-controlled strings.

---

## NPM Dependencies (anticipated)

| Package | Purpose |
|---------|---------|
| `net` (built-in) | TCP server/client |
| `ws` (already in stack) | WebSocket — already used by `websockets.js` for terminal connections. Mailer reuses the same `WsManager` infrastructure for inbound and `ws` client for outbound. |
| `tls` (built-in) | TLS wrapping for TCP (Phase 5) |
| `crypto` (built-in) | CRAM-MD5 for binkp authentication |
| `crc-32` or similar | CRC32 for file verification |

Zmodem for EMSI sessions and terminal file transfers is implemented as a standalone module (`transfers/zmodem.js`) rather than shelling out to `sz`/`rz`. This keeps the implementation event-driven, cross-platform, and usable from both the mailer and terminal connection handlers without process management overhead.
