# SyncTERM Telnet + ZMODEM Reference

Analysis of SyncTERM 1.8rc2 source code for telnet IAC handling during ZMODEM transfers.

## Key Finding

SyncTERM's telnet layer **always** escapes/unescapes 0xFF (IAC) transparently around the ZMODEM engine. The ZMODEM code never sees IAC bytes — the telnet layer handles them before data reaches the protocol engine.

## Data Flow

### Upload (SyncTERM → Server)
```
ZMODEM Engine → send_byte() → transfer_buffer[]
→ conn_send() → telnet_tx_parse_cb() → st_telnet_expand()
→ [0xFF doubled to 0xFF 0xFF] → network
```

### Download (Server → SyncTERM)
```
network → conn_recv_upto() → telnet_rx_parse_cb()
→ telnet_interpret() → [0xFF 0xFF → single 0xFF]
→ recv_byte() → ZMODEM Engine
```

## IAC Escaping Details

### Outbound (st_telnet_expand)
**File**: `src/syncterm/conn_telnet.c` lines 32-84

Unconditionally doubles ALL 0xFF bytes in outgoing data. The `expand_cr` parameter only controls CR expansion, not IAC handling. BINARY mode (option 0) disables CR expansion but IAC escaping remains active.

### Inbound (telnet_interpret)
**File**: `src/syncterm/telnet_io.c` lines 155-159

When 0xFF 0xFF is received, it's converted back to a single 0xFF (escaped IAC). Single 0xFF triggers IAC command parsing.

## BINARY Mode

**File**: `src/syncterm/conn_telnet.c` lines 86-100

SyncTERM always negotiates BINARY mode at connect time:
```c
request_telnet_opt(TELNET_WILL, TELNET_BINARY_TX);
request_telnet_opt(TELNET_DO, TELNET_BINARY_TX);
```

BINARY mode only affects CR/LF conversion — IAC escaping is always active.

## ZMODEM escape_telnet_iac Flag

**File**: `src/sbbs3/zmodem.h` line 285, `src/sbbs3/zmodem.c` lines 296-300

The ZMODEM engine has an `escape_telnet_iac` flag that would ZDLE-escape 0xFF bytes at the ZMODEM level. However, SyncTERM **never sets this flag** — it defaults to FALSE. The telnet layer handles IAC escaping instead.

## Implications for Canectic BBS

1. **Telnet server must escape outbound 0xFF** — double to 0xFF 0xFF
2. **Telnet server must unescape inbound 0xFF 0xFF** — collapse to single 0xFF
3. **This is transparent to ZMODEM** — the engine sees raw bytes on both sides
4. **Connection mode must match server type**:
   - SyncTERM telnet mode → Canectic telnet port (2023)
   - SyncTERM raw mode → Canectic TCP port (2060)
   - Mismatch causes CRC errors (escaped data not unescaped or vice versa)
5. **Accept BINARY mode negotiation** — SyncTERM sends WILL/DO BINARY at connect

## Source File References

| File | Content |
|------|---------|
| `src/syncterm/conn_telnet.c` | Telnet TX escaping, BINARY mode negotiation |
| `src/syncterm/telnet_io.c` | Telnet RX parsing, IAC command handling |
| `src/sbbs3/zmodem.c` | ZMODEM protocol, escape_telnet_iac flag |
| `src/sbbs3/zmodem.h` | ZMODEM structures and constants |
| `src/sbbs3/telnet.c` | Synchronet telnet expansion (identical pattern) |
| `src/syncterm/term.c` | ZMODEM initialization (lines 2146-2289) |
