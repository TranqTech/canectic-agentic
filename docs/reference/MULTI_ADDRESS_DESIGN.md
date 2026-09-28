# Multi-Address Binkp Session Design

Handling binkp sessions where the remote system advertises multiple FTN addresses that map to different local peer connections, and batching outbound for shared remotes.

**Status: implemented** (`src/mailer/session.js`, `src/mailer/manager.js`). The implementation differs from the plan below in three places: `_matchPeer()` still returns a single connection and the grouping into `this.peerConnections` happens after authentication (in `_onPasswordReceived()` when answering, `_onAuthenticated()` when calling); FREQ still uses the primary connection; and echo suppression does not use `source_network_id` (see section 5). The "Current Behaviour" list below describes the system before this work.

## Behaviour Before This Design

- Protocol layer already handles multiple addresses (M_ADR is space-separated, `peerAddresses` is an array)
- Session matches ONE peer connection via `_matchPeer()` (first match wins)
- `_buildOutboundList()` generates BSO hex from that one connection's `cd.address`
- Manager creates one session per connection UUID
- Local addresses: sends all addresses for the matched network in M_ADR

## Design

### 1. Inbound: match all peer connections

When a remote sends `M_ADR 1:123/456 21:100/100`, update `_matchPeer()` to find ALL matching peer connections, not just the first.

**Changes to `_matchPeer()`** (as built, `_matchPeer()` still returns one connection, the primary; the answerer builds `this.peerConnections` from it in `_onPasswordReceived()`):
- Return an array of matching connections instead of a single connection
- The first match becomes the "primary" (used for password validation)
- All matches stored as `this.peerConnections` (array)
- `this.peerConnection` remains as shorthand for `this.peerConnections[0]` (backward compat)

**Password validation and group filtering:**
- Password checked against the primary connection's `session_password` (unchanged)
- After primary authentication succeeds, additional connections are ONLY added if:
  a. Their `session_password` matches the authenticated password (same sysop, same credential)
  b. They have a `session_password` configured (empty password = not authorized for sessions)
- Connections with a different password are excluded from the group even if the remote claims that address
- This prevents a malicious remote from advertising an extra address in M_ADR to receive outbound mail for a connection it hasn't authenticated against
- Same filtering applies for both inbound and outbound session grouping

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

**Implementation in `_onAuthenticated()`** (as built, this runs for caller sessions; answerer sessions do the same grouping in `_onPasswordReceived()` before `confirmAuth()`):
```javascript
// After primary connection matched and password validated,
// scan for additional connections matching the remote's other addresses.
// ONLY include connections whose session_password matches the authenticated password.
var authedPassword = this.peerConnection.connection_data.session_password;

for (var addr of info.addresses) {
    if (addr matches this.peerConnection) continue;
    var additional = findConnectionByAddress(addr);
    if (!additional) continue;

    var addCd = additional.connection_data || {};
    // Security: only group if password matches and is non-empty
    if (!addCd.session_password) continue;
    if (addCd.session_password !== authedPassword) continue;

    this.peerConnections.push(additional);
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
- For outbound (caller): return addresses for all networks (allows remote to send us mail for any of our addresses)
- **Default addresses first**: each network's default address (`is_default = true`) is listed before non-default addresses. This ensures the primary identity for each network appears first in M_ADR, which is what most mailers use for display and routing decisions.
- Ordering: default addresses (sorted by network), then non-default addresses (sorted by network)

### 5. Data leakage prevention

**Echo suppression:** Not done by the session. Outbound eligibility is decided per destination when packets are written (`echomail.evaluateOutbound()`: imported history, do not send back to the source connection, SEEN-BY, PATH), and it deliberately does NOT test `source_network_id`. The session only transmits what is already in the BSO for each grouped connection. No change needed.

**HWM tracking:** `peer_area_subscriptions.msg_idx` is per `peer_connection_id`. Each connection advances its own HWM independently. `_buildOutboundList()` reads subscriptions per connection. No change needed beyond iterating connections.

**Subscription filtering:** Each connection has its own enabled/allowed subscriptions. The tosser writes packets for each connection independently based on its subscriptions. The session just transmits whatever's in the BSO. No change needed.

**FREQ:** `_processFreqRequest()` uses `this.peerConnection.id` for file entry access control. For multi-connection sessions, FREQ should use the connection matching the address the .req file was addressed to, or the primary connection. As built it uses the primary connection (`this.peerConnection`).

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
- **Password model**: one password per binkp session (validated against primary connection). Additional connections are only grouped if their password matches the authenticated password. Connections with different passwords are handled in separate sessions -- this is both a binkp protocol limitation and a deliberate security choice.
