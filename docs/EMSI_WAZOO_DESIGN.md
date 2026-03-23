# EMSI/Wazoo Protocol Design for Canectic BBS Mailer

**Status**: Design complete, pending implementation
**Phase**: Mailer Phase 4 (per MAILER_ARCHITECTURE.md)

---

## Overview

This document describes the architecture for adding EMSI/Wazoo session support to the Canectic BBS FTN mailer. EMSI (Electronic Mail Standard Identification) is the session handshake protocol used by legacy FTN mailers (FrontDoor, BinkleyTerm, T-Mail, Argus, Radius). After handshake, the Wazoo batch protocol manages file exchange using ZMODEM.

The design reuses the existing `ZmodemEngine` (`src/transfers/zmodem.js`) via the same `StreamAdapter` pattern used by terminal file transfers, and emits the same events as `BinkpProtocol` so the `SessionController` can orchestrate both protocol types through a common lifecycle.

---

## Architecture

### Layer Diagram

```
                        SessionController
                       /                 \
              BinkpProtocol          EmsiProtocol
                   |                      |
            TransferEngine         WazooTransferEngine
            (binkp M_FILE/         (half-duplex ZMODEM
             M_GOT frames)          batch sessions)
                   |                      |
              [shared]              ZmodemEngine
                   |               (StreamAdapter)
                   |                      |
                   +------Transport-------+
                      (TCP or WebSocket)
```

### Key Design Principles

1. **Same event interface**: `EmsiProtocol` emits the same events as `BinkpProtocol` (`authenticated`, `passwordReceived`, `sessionEnd`, `error`) so the session controller works unchanged for the handshake phase.
2. **Separate transfer engine**: Wazoo's half-duplex ZMODEM-based transfers are fundamentally different from binkp's full-duplex interleaved framing. A separate `WazooTransferEngine` avoids complicating the well-tested binkp path.
3. **Shared cleanup**: Post-send file cleanup (flow file marking, file deletion/truncation) is extracted to a shared module used by both transfer engines.
4. **Transport adapter reuse**: The `ZmodemEngine` StreamAdapter for mailer sessions is structurally identical to the terminal adapter -- `transport.write()` replaces `call.cmds._send()`, `transport.on('data')` replaces `call.rawtarget`.

---

## 1. Protocol Auto-Detection (Inbound)

### Detection Logic

A single TCP listener handles both protocols. The first byte distinguishes them:

- **Byte >= 0x80**: binkp (binary frame header with command flag bit set)
- **Byte == 0x2A (`*`)**: EMSI (ASCII `**EMSI_INQ` or `**EMSI_REQ` sequence)
- **Timeout (5s) with no data**: default to binkp

### Implementation

Protocol detection occurs in `SessionController.start()` as a brief peek phase before protocol module creation:

```
SessionController.start():
  1. Async preamble (resolve local addresses, load peer connection)
  2. For outbound: read mailer_protocol from connection_data, skip detection
  3. For inbound: wire one-shot transport 'data' listener with 5s timeout
  4. On first data: check byte[0], create appropriate protocol module
  5. Push peeked bytes into the protocol's parser
  6. Resume transport, proceed to handshake
```

### State Machine Addition

```
IDLE -> DETECTING -> HANDSHAKE -> AUTHENTICATED -> TRANSFER -> DONE
                                                      |
                                                    ERROR
```

The `DETECTING` state is transient (one data event or timeout). Outbound sessions skip it.

### Separate EMSI Port (Optional)

`MAILER_EMSI_PORT` (default 60179, 0 to disable) can be added as a dedicated listener that forces EMSI protocol selection, skipping detection. Not needed for MVP.

---

## 2. EmsiProtocol Module

### File: `src/mailer/protocols/emsi.js`

### EMSI Packet Format

All EMSI packets are ASCII text with CRC-16/CCITT checksums (same polynomial as ZMODEM, available in `src/transfers/crc.js`):

```
**EMSI_REQ<4hex_crc>\r       Fixed 20-byte sequences
**EMSI_INQ<4hex_crc>\r
**EMSI_ACK<4hex_crc>\r
**EMSI_NAK<4hex_crc>\r

{EMSI_DAT}<4hex_len>{field1}{field2}...{fieldN}<4hex_crc>\r
```

### EMSI_DAT Fields

Brace-delimited `{value}` with backslash escaping for literal braces:

| Field | Content | Notes |
|-------|---------|-------|
| system_name | `appConfig.get('boardname')` | Display name |
| city | Location string or empty | |
| sysop | `appConfig.get('sysopname')` | |
| phone | `-Unpublished-` | Standard for IP nodes |
| baud | `300` | Required but meaningless for IP |
| flags | `XA,CM,IBN,IFC` | Capability flags |
| addresses | Space-separated FTN addresses | Same as binkp M_ADR |
| password | Session password (plaintext) | No CRAM-MD5 in EMSI |
| link_codes | `8N1` | Dummy for IP |
| compat_codes | `ZMO,ZAP` | Supported transfer protocols |

### Handshake State Machines

**Caller:**
```
INIT
  |-> send **EMSI_INQ\r
  |-> start retry timer (5s, max 6 retries)
  |
AWAIT_REQ -----(timeout)-----> retry EMSI_INQ
  |<- receive **EMSI_REQ
  |-> send EMSI_DAT (our info, addresses, password)
  |
AWAIT_ACK -----(timeout)-----> retry EMSI_DAT
  |<- receive EMSI_DAT (remote info) -- may arrive before or after ACK
  |<- receive EMSI_ACK
  |-> send EMSI_ACK
  |
AUTHENTICATED
  |-> emit 'authenticated'
```

**Answerer:**
```
INIT
  |<- receive **EMSI_INQ or **EMSI_REQ
  |-> send **EMSI_REQ\r
  |
AWAIT_DAT
  |<- receive EMSI_DAT (caller info, addresses, password)
  |-> emit 'passwordReceived' to session controller
  |
AWAIT_AUTH_DECISION
  |<- session controller calls confirmAuth()
  |-> send EMSI_DAT (our info)
  |-> send EMSI_ACK
  |
AWAIT_CALLER_ACK -----(timeout)-----> retry our EMSI_ACK
  |<- receive EMSI_ACK
  |
AUTHENTICATED
  |-> emit 'authenticated'
```

### Protocol Interface

```javascript
class EmsiProtocol extends EventEmitter {
    constructor(transport, options)

    startSession(role)          // Begin handshake as caller or answerer
    pushInitialData(buf)        // Feed peeked bytes from auto-detection

    confirmAuth()               // Answerer: password OK, proceed
    sendERR(reason)             // Graceful close (EMSI has no error frame -- disconnects)
    sendBSY(reason)             // Same as sendERR for EMSI

    get remoteAddresses()       // FTN addresses from remote EMSI_DAT
    get isAuthenticated()
    get state()

    // Events (same as BinkpProtocol):
    //   'authenticated'     { addresses, options }
    //   'passwordReceived'  { addresses, password }
    //   'wazooReady'        (handshake complete, transport available for ZMODEM)
    //   'sessionEnd'
    //   'error'             Error
}
```

### Parser Strategy

Accumulate incoming data in a buffer, scan for known ASCII sequences:

- `**EMSI_` prefix -> extract fixed-length control sequence (20 bytes)
- `{EMSI_DAT}` prefix -> read 4-hex length field, extract data, validate CRC
- Discard unrecognized data before the first recognized sequence

### MVP Scope

**Included**: EMSI_INQ, EMSI_REQ, EMSI_DAT, EMSI_ACK, CRC-16 validation, ZMO compat code, plaintext password

**Excluded**: EMSI_NAK retry (add if testing requires), EMSI_HBT heartbeat, EMSI_CLI, JANUS bidirectional, modem flags

---

## 3. Wazoo Transfer Engine

### File: `src/mailer/wazooTransfer.js`

### Wazoo Batch Sequence

After EMSI handshake, file exchange follows the half-duplex Wazoo protocol:

```
1. Answerer sends files (ZMODEM batch session)
2. Answerer signals batch end (ZMODEM ZFIN)
3. Caller sends files (ZMODEM batch session)
4. Caller signals batch end (ZMODEM ZFIN)
5. Session complete
```

The byte stream is fully owned by ZMODEM during each batch phase.

### StreamAdapter Bridge

The `ZmodemEngine` expects `{ write(buf), onData(cb), offData() }`. For mailer sessions:

```javascript
_createTransportAdapter() {
    var transport = this._transport;
    var dataHandler = null;
    return {
        write: function(buf) {
            transport.write(buf);
        },
        onData: function(cb) {
            dataHandler = cb;
            transport.on('data', dataHandler);
        },
        offData: function() {
            if (dataHandler) {
                transport.removeListener('data', dataHandler);
                dataHandler = null;
            }
        }
    };
}
```

### ZMODEM Options

```javascript
{
    subpacketSize:  1024,           // 1K for max legacy compatibility
    escapeCtl:      true,           // Legacy systems often need ESCCTL
    timeout:        30000,          // Generous timeout for slow links
    initialCrcMode: 'zbin_crc16'   // CRC-16 for broadest legacy support
}
```

### Empty Batch Handling

When a side has no files, it must still run a ZMODEM session that immediately closes. Requires adding `sendEmpty()` to `ZmodemEngine`:

```javascript
// In src/transfers/zmodem.js:
// Send ZRQINIT+ZFIN to signal "no files" in a Wazoo batch context.
sendEmpty() {
    // Wire adapter, send ZRQINIT, on ZRINIT immediately send ZFIN
    // Returns Promise<{ success: true, filesSent: 0 }>
}
```

The receiver side's `receive()` already handles immediate ZFIN correctly.

### API

```javascript
class WazooTransferEngine extends EventEmitter {
    constructor(transport, options)
    // options: { role, inboundDir, tempDir, outboundFiles[], sessionId }

    async run()    // Execute full Wazoo batch sequence (send+receive or receive+send)
    abort()        // Cancel in-progress transfer

    // Events:
    //   'sendComplete'      { name, size }
    //   'receiveComplete'   { name, size, path }
    //   'sendProgress'      { name, sent, size }
    //   'receiveProgress'   { name, received, size }
    //   'batchComplete'     { direction: 'send'|'receive' }
    //   'allComplete'       { filesSent, filesReceived }
    //   'error'             Error
}
```

---

## 4. Shared File Cleanup

### File: `src/mailer/fileCleanup.js`

Extract post-send cleanup logic from `TransferEngine` into a shared module:

```javascript
// Shared between binkp TransferEngine and WazooTransferEngine
function cleanupSentFile(item, logPrefix) { ... }
function markFloLineSent(floFile, filepath) { ... }
function deleteFile(filepath) { ... }
function truncateFile(filepath) { ... }

export { cleanupSentFile, markFloLineSent, deleteFile, truncateFile };
```

Both `TransferEngine._onFileReceived()` and `WazooTransferEngine` import these.

---

## 5. Session Controller Integration

### Modified Flow in `session.js`

```
start()
  |-> async preamble (local addresses, peer connection, password)
  |
  |-- outbound? read mailer_protocol from connection_data
  |-- inbound?  auto-detect from first bytes
  |
  |-- binkp?    _createBinkpSession() -> existing flow (unchanged)
  |-- emsi?     _createEmsiSession() -> EmsiProtocol + event wiring
  |
  v
handshake (protocol-agnostic -- same events)
  |
  v
_onAuthenticated()
  |-- binkp?    existing TransferEngine path (unchanged)
  |-- emsi?     _runWazooTransfer() -> WazooTransferEngine.run()
  |
  v
_endSession('complete')
```

### Outbound File List

For EMSI sessions, `_collectOutboundFiles()` reuses the existing BSO scanning logic but returns an array of `{ path, name, size, mtime, floFile, floPrefix, deleteAfterSend }` instead of calling `transfer.queueFile()`. The `WazooTransferEngine` maps these to `ZmodemEngine.send()` format.

---

## 6. Manager-Level Changes

### MailerManager Modifications

1. **`_connectToPeer(conn)`**: Pass `mailerProtocol: cd.mailer_protocol || 'binkp'` in session options
2. **`stop()`**: `EmsiProtocol.sendERR()` is a no-op/disconnect (EMSI has no error frame)
3. **Max sessions BSY**: Sends binkp M_BSY frame regardless of protocol -- EMSI clients see binary garbage and disconnect (acceptable behavior)

### Admin UI

Remove `disabled` attribute from EMSI option in `src/views/admin/peers/view.pug`.

---

## 7. File Inventory

| File | Action | Description |
|------|--------|-------------|
| `src/mailer/protocols/emsi.js` | **New** | EMSI handshake protocol module |
| `src/mailer/wazooTransfer.js` | **New** | Wazoo batch transfer orchestrator |
| `src/mailer/fileCleanup.js` | **New** | Shared post-send cleanup utilities |
| `src/mailer/session.js` | **Modify** | Protocol detection, EMSI path, Wazoo transfer |
| `src/mailer/manager.js` | **Modify** | Pass mailer_protocol to sessions |
| `src/mailer/transfer.js` | **Modify** | Import shared cleanup from fileCleanup.js |
| `src/transfers/zmodem.js` | **Modify** | Add sendEmpty() for empty batch signaling |
| `src/views/admin/peers/view.pug` | **Modify** | Enable EMSI option in peer forms |
| `docs/MAILER_ARCHITECTURE.md` | **Modify** | Update Phase 4 status |

---

## 8. Implementation Phases

### Phase 4a: EMSI Handshake

1. Create `emsi.js` with full state machine (caller + answerer)
2. EMSI_DAT encoding/parsing with CRC-16 validation
3. Same event interface as `BinkpProtocol`
4. Unit tests: encode/decode round-trip, CRC validation, state machine with paired transports

### Phase 4b: Wazoo Transfer

1. Create `wazooTransfer.js` with transport-to-StreamAdapter bridge
2. Half-duplex batch sequence implementation
3. Add `sendEmpty()` to `ZmodemEngine`
4. Extract `fileCleanup.js` from `TransferEngine`
5. Integration tests: EMSI handshake + ZMODEM file transfer over in-memory transport

### Phase 4c: Session Integration

1. Protocol detection in `SessionController.start()`
2. Wire `_createEmsiSession()` and `_runWazooTransfer()` paths
3. Pass protocol selection through `MailerManager._connectToPeer()`
4. Enable EMSI in admin UI
5. End-to-end testing against real EMSI mailer (Argus, Radius, BinkleyTerm)

### Phase 4d: Hardening

1. EMSI_NAK retry handling
2. Per-state timeout management
3. Connection drop / partial file edge cases
4. Documentation updates

---

## 9. Risks and Trade-Offs

### EMSI specification ambiguity
FSC-0056 has known ambiguities; implementations vary. **Mitigation**: Target Argus/Radius/BinkleyTerm compatibility. Start strict, relax per real-world testing.

### ZMODEM variant differences
Legacy mailers may use non-standard ZMODEM variants. **Mitigation**: 1K subpackets + CRC-16 + ESCCTL for maximum compatibility. ZedZap (8K) addable later.

### Half-duplex ordering
Some implementations may not follow answerer-sends-first strictly. **Mitigation**: Configurable batch ordering, inter-batch delay, detailed byte-level logging at boundaries.

### Single vs. dual TCP listeners
Auto-detection adds a brief detection delay (one data event, typically < 10ms). **Assessment**: Acceptable trade-off vs. operational complexity of separate ports. Dedicated EMSI port remains available as an option.

### Separate transfer engine vs. unified
Half-duplex ZMODEM is fundamentally different from full-duplex binkp framing. **Assessment**: Separate `WazooTransferEngine` is cleaner than adding conditional logic throughout `TransferEngine`.
