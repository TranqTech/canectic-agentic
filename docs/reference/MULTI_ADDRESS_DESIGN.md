# Multi-Address Binkp Session Design

Handling binkp sessions where the remote system advertises multiple FTN addresses that map to different local peer connections, and batching outbound for shared remotes.

## Current Behaviour

- Protocol layer already handles multiple addresses (M_ADR is space-separated, `peerAddresses` is an array)
- Session matches ONE peer connection via `_matchPeer()` (first match wins)
- `_buildOutboundList()` generates BSO hex from that one connection's `cd.address`
- Manager creates one session per connection UUID
- Local addresses: sends all addresses for the matched network in M_ADR

## Design

### 1. Inbound: match all peer connections

When a remote sends `M_ADR 1:123/456 21:100/100`, update `_matchPeer()` to find ALL matching peer connections, not just the first.

**Changes to `_matchPeer()`:**
- Return an array of matching connections instead of a single connection
- The first match becomes the "primary" (used for password validation)
- All matches stored as `this.peerConnections` (array)
- `this.peerConnection` remains as shorthand for `this.peerConnections[0]` (backward compat)

**Password validation:**
- Password checked against the primary connection's `session_password` (unchanged)
- If connections on different networks have different passwords, the primary match determines which password is expected. This is standard binkp behaviour -- one password per session.

### 2. Outbound: build file lists for all matched connections

**Changes to `_buildOutboundList()`:**
- Iterate `this.peerConnections` instead of using just `this.peerConnection`
- For each connection, parse its `cd.address`, generate BSO hex, scan for .flo/.out/.req files
- Files from all connections are queued in the same transfer engine (single session sends them all)

**Per-connection isolation:**
- Each connection's outbound is built independently from its own `cd.address` BSO hex
- Packets are addressed correctly because they were already written to the correct BSO location by the tosser
- No merging or cross-contamination -- each .out packet contains messages for a specific destination address

### 3. Outbound batching for shared remotes

When the manager detects that multiple peer connections share the same `host:port`, it could batch them into one session. However, the simpler approach:

**Post-connect discovery (recommended):**
After connecting and receiving the remote's M_ADR, check if we have additional connections matching those addresses. Add them to `this.peerConnections` dynamically.

This handles:
- Remote serves more addresses than we configured on a single connection
- Remotes that change their address list over time
- No need to group connections by host:port in advance

**Implementation in `_onAuthenticated()`:**
```javascript
// After primary connection matched, scan for additional connections
// matching the remote's other advertised addresses
for (var addr of info.addresses) {
    // Skip the primary (already matched)
    if (addr matches this.peerConnection) continue;
    var additional = findConnectionByAddress(addr);
    if (additional) this.peerConnections.push(additional);
}
```

### 4. Address advertisement (answering)

**Decision: advertise all active FTN system addresses.**

Rationale:
- Standard binkp convention (binkd, Argus, etc. all do this)
- FTN addresses are public (published in nodelists)
- Answerer sends M_ADR before the caller authenticates, so filtering by caller identity isn't possible
- The caller already knows which of our addresses they care about
- Advertising all addresses allows the caller to send outbound for any of them in one session

**Current code already does this** for network-scoped addresses (`_getLocalAddresses()` sends all addresses for the matched network). The change is to send addresses from ALL networks, not just the primary connection's network.

**Changes to `_getLocalAddresses()`:**
- For inbound (answerer): return all active FTN system addresses across all networks
- For outbound (caller): return addresses for the primary connection's network (unchanged, or expand to all)

### 5. Data leakage prevention

**Echo suppression:** Already per-connection via `source_network_id` on messages. A message from network A won't be echoed back to network A even if the session handles both networks. No change needed.

**HWM tracking:** `peer_area_subscriptions.msg_idx` is per `peer_connection_id`. Each connection advances its own HWM independently. `_buildOutboundList()` reads subscriptions per connection. No change needed beyond iterating connections.

**Subscription filtering:** Each connection has its own enabled/allowed subscriptions. The tosser writes packets for each connection independently based on its subscriptions. The session just transmits whatever's in the BSO. No change needed.

**FREQ:** `_processFreqRequest()` uses `this.peerConnection.id` for file entry access control. For multi-connection sessions, FREQ should use the connection matching the address the .req file was addressed to, or the primary connection. Minor change.

**AreaFix/FileFix:** Already route by the netmail's destination address, not the session's connection. No change needed.

## Implementation Order

1. Update `_matchPeer()` to return array, add `this.peerConnections`
2. Update `_buildOutboundList()` to iterate all matched connections
3. Update `_onAuthenticated()` to discover additional connections
4. Update `_getLocalAddresses()` to send all FTN addresses when answering
5. Update manager's `_hasSessionForAddress()` to check against all session addresses
6. Test with single-address peers (backward compat)
7. Test with multi-address peers

## Backward Compatibility

All changes are additive. Single-address sessions work identically:
- `_matchPeer()` returns an array with one element
- `this.peerConnection` still works (shorthand for `[0]`)
- `_buildOutboundList()` iterates one connection
- No schema changes needed -- existing peer_connections table is unchanged

## Not Changing

- **Peer connection schema**: one address per connection record. Multiple addresses on a remote are handled by matching multiple connection records, not by adding array fields.
- **Manager polling**: polls are per-connection, not per-remote-host. If two connections share a host, they're polled independently. The session discovery handles merging at runtime.
- **Password model**: one password per session (validated against primary connection). Different passwords per connection on the same remote are not supported -- this is a binkp protocol limitation.
