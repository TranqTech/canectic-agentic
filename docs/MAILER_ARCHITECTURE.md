# Canectic BBS — FTN Mailer Architecture Reference

## Overview

The FTN mailer system handles real-time node-to-node communication for exchanging mail packets, file attachments, and TIC files with remote FidoNet-compatible systems. It replaces the current directory-based file drop model with active session management — the system can both initiate outbound calls and accept inbound connections.

The mailer operates independently of the tosser. The tosser prepares `.pkt` files in an outbound directory and processes `.pkt` files from an inbound directory. The mailer's job is to move files between the local outbound/inbound directories and the remote system via a negotiated transfer protocol over a network transport.

For the shared message platform (schemas, read tracking, body_html pipeline, posting, web views), see `message_architecture.md`.
For the message networking stack (tossers, protocols, packet formats), see `NETWORKING_ARCHITECTURE.md`.
For the terminal-side BBS architecture, see `terminal_architecture.md`.
For the web application (Express, sessions, admin panel, WebSockets), see `web_architecture.md`.

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

Standard TCP sockets. Server binds to configurable port (default 24554 for binkp, 60179 for EMSI). Client connects to `connection_data.mailer_host` and `connection_data.mailer_port` on the peer connection.

Uses Node.js `net` module. Straightforward 1:1 mapping to the transport interface.

### WebSocket Transport (`mailer/transports/websocket.js`)

Serverless WebSocket connections over the existing HTTP server. Follows the same pattern as the terminal WebSocket system (`websockets.js`):

**Inbound (server):** The mailer registers a `WsPool` on the existing `WsManager` at a dedicated path (e.g., `/ws/mailer`). The `WsManager`'s shared `httpServer.on('upgrade')` handler routes upgrade requests by pathname — terminal paths go to terminal pools, the mailer path goes to the mailer pool. No separate WebSocket server or port. The mailer pool does not forward to a `CallPool`; instead, it hands the raw WebSocket connection to the `MailerManager` which wraps it in a `WebSocketTransport` and creates an answerer session.

**Outbound (client):** For outbound calls to peers configured with `mailer_transport: 'websocket'`, the transport creates a `ws` client connection to the peer's `mailer_ws_url`. The client WebSocket is wrapped in the same `WebSocketTransport` class.

Binary frames — all data is transmitted as `Buffer` payloads in binary WebSocket frames, not text. The session layer sees the same byte stream it would over TCP.

**Integration with existing infrastructure:**
```javascript
// In doorserver.js or main startup, after startWebsockets():
var mailerWsPool = wsManager.createNewPool('/ws/mailer', 'Mailer Websocket Pool');
// mailerWsPool does NOT setCallPool() — instead:
mailerManager.setWebSocketPool(mailerWsPool);
```

The `MailerManager` listens for connections on the pool and creates answerer sessions, rather than the pool forwarding to the call manager. This keeps the mailer's session lifecycle separate from the terminal's call lifecycle while sharing the HTTP server and upgrade routing.

Use case: systems behind CGN/restrictive firewalls that can't accept inbound TCP, or browser-based BBS frontends that want to relay mailer traffic through a WebSocket bridge. Also useful for serverless deployments where raw TCP listeners aren't available.

### Transport Configuration (connection_data additions)

```json
{
    "address": "1:123/456",
    "session_password": "...",
    "packet_password": "...",
    "mailer_host": "bbs.example.com",
    "mailer_port": 24554,
    "mailer_transport": "tcp",
    "mailer_protocol": "binkp",
    "mailer_tls": false,
    "mailer_ws_url": "wss://bbs.example.com/mailer"
}
```

New fields (additive — existing connection_data fields unchanged):

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `mailer_host` | string | null | Remote hostname/IP for outbound calls |
| `mailer_port` | integer | 24554 | Remote port for outbound calls |
| `mailer_transport` | string | `"tcp"` | Transport type: `tcp` or `websocket` |
| `mailer_protocol` | string | `"binkp"` | Session protocol: `binkp` or `emsi` |
| `mailer_tls` | boolean | false | Enable TLS for TCP connections |
| `mailer_ws_url` | string | null | Full WebSocket URL for WS transport |

Existing fields used by the mailer:
- `address` — remote FTN address, presented during handshake
- `session_password` — validated during session authentication
- `packet_password` — used for packet header password field
- `status` — NORMAL/CRASH/HOLD (controls polling behavior)

---

## Protocol Layer

### Responsibilities

- Session handshake (authentication, capability negotiation, address presentation)
- File offer/accept/reject/skip negotiation
- Frame-level encoding/decoding on the byte stream
- Transfer state management (sending, receiving, waiting)

### Protocol Adapter Interface

Both binkp and EMSI modules expose the same interface to the session controller:

```javascript
class BaseProtocol extends EventEmitter {
    constructor(transport, options)

    startSession(role)     // role = 'caller' | 'answerer'
    offerFiles(fileList)   // Present files for transfer
    acceptFile(filename)   // Confirm acceptance of offered file
    rejectFile(filename)   // Decline a file
    sendFileData(buffer)   // Push file bytes
    endSession()           // Graceful session termination

    get remoteAddresses()  // Array of FTN addresses presented by remote
    get isAuthenticated()  // Boolean — password verified
    get capabilities()     // Negotiated capabilities object
}

// Events:
//   'authenticated'  — handshake complete, password matched
//   'fileOffered'    — remote offering a file { name, size, time, offset }
//   'fileData'       — incoming file data chunk
//   'fileComplete'   — incoming file transfer finished
//   'sessionEnd'     — remote requested session end
//   'error'          — protocol error or authentication failure
```

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
  → disconnect
```

**OPT flags** (sent in M_NUL):
- `NR` — non-reliable mode (file CRC verification)
- `MB` — multi-batch (multiple EOB rounds)
- `MD5` — CRAM-MD5 authentication
- `CRYPT` — link encryption
- `NDA` — no dupes (file-level dupe prevention)

**Key implementation notes:**
- binkp is natively full-duplex — both sides can send files simultaneously. The transfer engine handles interleaved send/receive.
- Data frames carry file content. Command frames carry control. They share the same stream — the command flag bit in the header distinguishes them.
- Resume support via M_GET with a byte offset.
- Passwords are plaintext in basic mode, CRAM-MD5 in MD5 mode (answerer sends a challenge in M_NUL, caller responds with a hash in M_PWD).

### EMSI/Wazoo Protocol (`mailer/protocols/emsi.js`)

The Electronic Mail Standard Identification protocol. Used by FrontDoor, BinkleyTerm, T-Mail, and other legacy mailers. Half-duplex session with Zmodem/SEAlink file transfer.

**Handshake sequence:**
```
Caller → **EMSI_REQ (hex-encoded capability request)
  → Answerer responds with **EMSI_INQ or **EMSI_REQ
  → Caller sends EMSI_DAT (system info, capabilities, password)
  → Answerer validates, sends EMSI_DAT
  → Answerer sends EMSI_ACK
  → Caller sends EMSI_ACK
  → File exchange phase (Wazoo/ZedZap)
```

**EMSI_DAT packet fields:**
- System name, location, operator name, phone, baud, flags
- FTN addresses (AKA list)
- Password
- Link codes (capabilities)
- Compatibility codes (supported transfer protocols)

**File transfer within EMSI sessions:**
After handshake, the Wazoo protocol layer takes over. Files are transferred using Zmodem (ZedZap variant — supports large files, resume, and streaming). Uses the standalone `transfers/zmodem.js` module, piped through the transport's byte stream.

**Key implementation notes:**
- EMSI is ASCII-based with hex encoding and CRC16 checksums on data packets
- Half-duplex — one side sends, then the other, per batch
- Significantly more complex state machine than binkp due to the handshake negotiation and Wazoo session management
- Lower priority for initial implementation — binkp covers most modern systems

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
  → Create transport (TCP or WebSocket based on connection_data)
  → Connect to mailer_host:mailer_port
  → MailerManager creates SessionController(transport, 'caller')
  → Protocol module starts caller handshake
  → Present our addresses and password
  → Receive remote addresses → validate against expected peer
  → 'authenticated' event → state = AUTHENTICATED
  → Build outbound file list for this connection
  → Enter TRANSFER state
  → Exchange files
  → Both sides signal EOB → state = DONE
  → Run tosser on inbound files
  → Cleanup
```

### Peer Connection Matching (Inbound)

When a remote system presents FTN addresses during handshake:

1. For each presented address, query `peer_connections` where `connection_data->>'address'` matches and `connection_type = 'FTN'` and `active = true`
2. If multiple connections match (system presents multiple AKAs), prefer the one with the most specific routing rules
3. Validate `session_password` from `connection_data` against the presented password
4. If no match found and the system allows "unlisted" connections (future config), create a temporary session with restricted privileges

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

The tosser currently writes `.pkt` files to the base outbound directory and creates `.flo` flow file references via `UpcertMailerFile()`. Zone subdirectory support in the tosser is pending — the mailer already resolves the correct directory per zone.

---

## Mailer Manager (`mailer/manager.js`)

### Responsibilities

- Start/stop the mailer system
- Manage the TCP server listener for inbound binkp/EMSI connections
- Accept inbound WebSocket connections from a `WsPool` on the existing `WsManager` (shared HTTP server — no separate WS listener)
- Maintain a pool of active sessions
- Schedule outbound polls based on connection configuration
- Provide session status for admin/logging

### Poll Scheduling

Outbound calls are triggered by:

1. **Event-driven** — when the tosser generates new outbound packets for a connection, signal the mailer manager. If the connection's status is CRASH, attempt immediate delivery.
2. **Timed poll** — configurable per-connection poll interval (e.g., every 15 minutes). Only for connections with status NORMAL.
3. **Manual** — admin triggers an outbound call via route or CLI.
4. **HOLD** connections are never polled — they wait for the remote system to call us.

### Connection Deduplication

Before initiating an outbound call, check the active session pool. If a session to the same peer (by FTN address) already exists (inbound or outbound), skip the outbound call — the existing session will handle the file exchange.

### Server Listeners

TCP listener is owned by the MailerManager. WebSocket listener is a `WsPool` on the shared `WsManager` — the MailerManager receives connections from it but doesn't manage the HTTP server or upgrade routing.

```javascript
class MailerManager {
    constructor(options)

    start()                              // Bind TCP listener, start poll timers
    stop()                               // Graceful shutdown — finish active sessions, unbind
    setWebSocketPool(wsPool)             // Receive inbound WS connections from existing WsManager
    getActiveSessions()                  // Array of session status objects
    isRunning()                          // Boolean

    // Outbound polling
    pollConnection(connectionUUID)       // Production path — checks _running, outbound mail, then connects
    triggerPoll(connectionUUID)          // Manual path — bypasses _running and outbound mail checks, always connects
    signalOutbound(connectionUUID)       // Called by tosser — CRASH = immediate poll, NORMAL = next cycle

    // Internal
    _onInboundTcp(socket)                // Wrap in TcpTransport, create answerer session
    _onInboundWebSocket(wsConnection)    // Wrap in WebSocketTransport, create answerer session (Phase 3)
    _connectToPeer(conn)                 // Shared: resolve host/port/transport, create caller session
    _createSession(transport, role, opts) // Instantiate SessionController, wire events, add to pool
    _hasSessionForAddress(address)       // Deduplication check
    _hasOutboundMail(peerAddress)        // Scan BSO outbound for flow/packet files
    _startPollScheduling()               // Timer setup for NORMAL connections with hosts
}
```

### Configuration (environment variables)

| Variable | Default | Description |
|----------|---------|-------------|
| `MAILER_ENABLED` | `false` | Master enable/disable |
| `MAILER_BINKP_PORT` | `24554` | TCP listen port for binkp |
| `MAILER_EMSI_PORT` | `60179` | TCP listen port for EMSI (0 to disable) |
| `MAILER_WS_PATH` | `/ws/mailer` | WebSocket path registered on WsManager |
| `MAILER_INBOUND_DIR` | `ftn/in` | Inbound file directory (falls back to `ftninbound` env var) |
| `MAILER_OUTBOUND_DIR` | `ftn/out` | Outbound file directory (falls back to `ftnoutbound` env var) |
| `MAILER_TEMP_DIR` | `ftn/tmp` | Temp directory for in-progress transfers |
| `MAILER_MAX_SESSIONS` | `10` | Maximum concurrent sessions |
| `MAILER_POLL_INTERVAL` | `900` | Default poll interval in seconds |
| `MAILER_CONNECT_TIMEOUT` | `30` | Outbound connection timeout in seconds |
| `MAILER_SESSION_TIMEOUT` | `300` | Maximum session duration in seconds |

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
    constructor(session)

    sendFile(filepath)                    // Queue a file for sending
    receiveFile(name, size, time, offset) // Accept an incoming file
    cancelSend(filename)                  // Abort outbound transfer
    cancelReceive(filename)               // Abort inbound transfer

    get sendQueue()                       // Array of pending outbound files
    get activeTransfers()                 // Currently in-progress transfers

    // Events: 'sendProgress', 'receiveProgress', 'sendComplete',
    //         'receiveComplete', 'transferError'
}
```

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
SessionController builds file list → TransferEngine.sendFile() per file
  → read file, feed chunks to protocol sendFileData()
  → protocol frames and transmits
  → remote sends M_GOT → mark file as sent
  → delete or move sent file based on config
```

### Resume Support

Both binkp and Zmodem support resume:
- **binkp**: Remote sends M_GET with offset. TransferEngine seeks into the file and begins sending from that offset.
- **Zmodem**: Built-in crash recovery. Receiver reports last good position, sender resumes.

Partial inbound files in the temp directory are kept between sessions. On the next session with the same peer, if the remote offers a file that matches a partial, the protocol requests resume from the existing offset.

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

The mailer does not toss — it only moves files. After a session completes:

1. **Inbound**: Files are in `MAILER_INBOUND_DIR`. Either:
   - Signal the tosser to run an inbound toss cycle
   - Set a flag file that the tosser's cron/scheduled run picks up
   - Call `TossInbound()` directly if running in the same process

2. **Outbound**: The tosser's `TossOutbound()` writes packets to `MAILER_OUTBOUND_DIR`. The mailer polls this directory (or is signaled) when building the file list for an outbound session.

### Admin Routes (future)

- `GET /admin/mailer` — mailer status, active sessions, recent session log
- `GET /admin/mailer/sessions` — list of active sessions with transfer progress
- `POST /admin/mailer/poll/:connectionId` — manually trigger outbound call
- `POST /admin/mailer/stop` / `POST /admin/mailer/start` — control mailer without restart

---

## Directory Structure

```
src/mailer/
  manager.js          — MailerManager (server listeners, poll scheduling, session pool)
  session.js          — SessionController (per-session state machine, file list, peer matching)
  transfer.js         — TransferEngine (file send/receive, resume, CRC)
  transports/
    base.js           — BaseTransport (interface definition)
    tcp.js            — TCP client/server transport
    websocket.js      — WebSocket client/server transport (Phase 3)
  protocols/
    base.js           — BaseProtocol (interface definition)
    binkp.js          — binkp/1.1 protocol implementation
    emsi.js           — EMSI/Wazoo protocol implementation (Phase 4)
transfers/
  zmodem.js           — Standalone Zmodem send/receive (used by mailer EMSI + terminal file transfers)
tests/mailer/
  README.md           — Test documentation and run instructions
  test-binkp-frames.js — Unit: binkp frame encoding/decoding, CRAM-MD5 (41 assertions, no dependencies)
  test-loopback.js    — Integration: paired in-memory transports, handshake + file transfer (5 scenarios)
  test-tcp-loopback.js — Integration: real TCP sockets, full stack validation
  binkp-echo.js       — Manual: standalone binkp answerer server (accepts connections, receives files)
  binkp-send.js       — Manual: standalone binkp caller (connects, authenticates, sends files)
  trigger-poll.js     — Manual: triggers outbound poll by connection UUID or FTN address (requires DB)
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

8. **Real-world binkd testing** — test inbound and outbound sessions against a live binkd node. Fix any protocol compliance issues discovered.
9. **Outbound queue signaling** — tosser notifies mailer when new outbound mail is ready. Wire `signalOutbound()` call into `ftnTosser.TossOutbound()` completion path.
10. **Sent file cleanup** — after M_GOT, handle flow file line prefixes: `^` = delete file, `#` = truncate, no prefix = leave. Mark flow file lines as sent (`~` prefix).
11. **Session logging** — structured session log entries (connect time, peer address, peer system name, files transferred with sizes, errors, duration) written to `mailer.log` via `writeClog`.
12. **Path traversal prevention** — strip directory components from offered filenames on inbound. Reject filenames containing `..`, `/`, `\`.
13. **Admin status route** — `GET /admin/mailer` with active session display, recent session history.
14. **Startup integration** — wire `MailerManager` into `doorserver.js` startup sequence, gated by `MAILER_ENABLED` env var.

### Phase 3: WebSocket Transport

15. **WebSocket transport** — `WebSocketTransport` class wrapping `ws` connections. Inbound: register a `WsPool` at `/ws/mailer` on the existing `WsManager` (same HTTP server as terminal WebSockets). Outbound: `ws` client to remote `mailer_ws_url`. Binary frame mode.
16. **Admin UI for transport selection** — per-connection transport type in the peer connection editor
17. **Connection testing** — admin button to test connectivity to a peer

### Phase 4: EMSI/Wazoo Support

18. **EMSI handshake** — EMSI_REQ/EMSI_INQ/EMSI_DAT/EMSI_ACK negotiation
19. **Wazoo session layer** — batch file exchange orchestration
20. **Zmodem transfer module** — standalone, event-driven Zmodem implementation (`transfers/zmodem.js`) that operates on any bidirectional byte stream, not coupled to the mailer. Used by the EMSI protocol module for mailer sessions, but equally usable by terminal connection handlers for user file uploads/downloads (Zmodem over telnet/TCP/WebSocket). See Design Decision #9.
21. **Protocol auto-detection** — on inbound connections, detect whether the remote is speaking binkp or EMSI based on the first bytes received

### Phase 5: Advanced Features

22. **TLS support** — for both TCP and WebSocket transports
23. **File attach handling** — file attach netmail integration (`.flo` flow file parsing is implemented in Phase 1's session controller; this covers the netmail attach workflow)
24. **TIC file processing** — receive TIC bundles, validate CRC, store in file areas
25. **BSO zone directory support in tosser** — update `ftnTosser.js` to write packets and flow files to zone-specific outbound directories (`ftn/out.NNN/`) for alternate zones. The mailer already resolves zone directories.
26. **Nodelist integration** — dial flags, system capabilities, phone/IP lookup
27. **AreaFix/FileFix** — automated area subscription management via netmail commands
28. **Compression** — binkp CRYPT/compressed data frames (if demand exists)

---

## Key Design Decisions

1. **Transport-protocol separation**: Transports and protocols are independent modules connected by a byte-stream interface. This avoids the common mailer pitfall of coupling TCP socket handling with binkp frame parsing. Adding WebSocket support or a new protocol doesn't touch existing code.

2. **Session controller as orchestrator**: The session controller doesn't parse frames or manage sockets. It coordinates: tell the protocol to start, react to protocol events (authenticated, file offered), tell the transfer engine to send/receive, and manage the session lifecycle. This keeps each component focused and testable.

3. **Existing peer_connections as config source**: No separate mailer configuration database. All connection parameters, passwords, and routing rules come from the same `peer_connections` and `connection_data` that the tosser already uses. One place to configure a peer.

4. **Mailer does not toss**: Clear separation of concerns. The mailer moves files. The tosser processes them. They communicate via the filesystem (inbound/outbound directories). This means either can be replaced independently, and the tosser can still work in directory-drop mode without the mailer for systems that use external mailers.

5. **Event-driven, not threaded**: Node.js event loop handles concurrency naturally. Multiple sessions run cooperatively via async I/O. No thread pool, no locking, no shared-state hazards. The `MailerManager` tracks sessions in a plain array.

6. **binkp first, EMSI second**: binkp is the dominant protocol for modern FTN systems. Most active FidoNet nodes run binkd. EMSI support is for backward compatibility and can be deferred without blocking useful functionality.

7. **WebSocket as first-class transport, shared infrastructure**: Not an afterthought. The transport abstraction is designed from the start to support WebSocket alongside TCP. Inbound WebSocket connections use the existing `WsManager`/`WsPool` path-routing system (shared with the terminal server) — the mailer registers a pool at `/ws/mailer` on the same HTTP server, no separate listener. This follows the established serverless pattern: `httpServer.on('upgrade')` routes by pathname, terminal paths go to terminal pools, mailer path goes to the mailer pool. Outbound WebSocket connections use the `ws` client library directly. This enables novel topologies (relay nodes, browser bridges, serverless mailer endpoints) without protocol changes or additional ports.

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
