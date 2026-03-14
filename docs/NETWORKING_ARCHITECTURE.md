# Canectic BBS — Message Networking Architecture Reference

## Overview

Canectic BBS supports three message networking protocols: FTN (FidoNet Technology Networks), NNTP (Usenet/newsgroups), and QWK (offline packet-based networking). Each protocol has its own tosser module that handles pulling inbound messages and pushing outbound messages. The system can act as both a **client** (connecting to remote hubs) and a **hub** (accepting connections from downstream nodes).

This document covers the current architecture, key files, data flow, and integration points. It is intended both as a general reference and as a starting point for future development sessions.

---

## Core Files

### Models (business logic)

| File | Purpose |
|------|---------|
| `ftnClasses.js` | FTN data classes. `Packet` (FTN type-2 packet envelope: source/dest addresses, password, timestamps, message array) and `Message` (single FTN message: type, area tag, addressing, kludge fields, body, origin line). Used by both the tosser and netmail modules. |
| `ftnRouter.js` | FTN routing resolver. Given a destination FTN address, determines the next-hop peer connection. Cascade: direct connection match → routing rule wildcard match → (future) nodelist direct → (future) coordinator walk. Returns `routeResult` with nextHop, connection UUID, method, and packet flavour. |
| `ftnUtils.js` | FTN utility functions. Message-ID generation, datetime string formatting, system time parsing with timezone offset handling. |
| `netmail.js` | FTN netmail (private point-to-point messages). Separate `netmail_in` and `netmail_out` tables. Handles inbound import with dupe checking, outbound creation with address validation, pending queue retrieval (`getPendingNetmail`), and sent marking. Bidirectional `ftnToDb`/`dbToFtn` conversion. |
| `qwkClasses.js` | Low-level QWK/REP binary packet parsing and building. Header byte layouts, body encoding (CP437/0xE3 line terminators), kludge extraction, HEADERS.DAT parsing, CONTROL.DAT parsing, REP packet assembly using system `zip`. |
| `qwkTosser.js` | QWK network tosser. Pull (inbound) and push (outbound) for client connections. Handles FTP/SFTP/directory/hub transports. Imports messages with dupe checking, threading, HWM tracking. Builds REP packets with HEADERS.DAT for outbound client pushes. |
| `qwkPacketBuilder.js` | QWK packet generation module. Builds complete `.qwk` packets (CONTROL.DAT + MESSAGES.DAT + HEADERS.DAT + NETFLAGS.DAT) for hub-mode delivery to nodes. Designed with low-level reusable functions and a high-level `buildQwkForNode()` entry point. |
| `qwkTransport.js` | Transport abstraction layer. FTP (`basic-ftp`), SFTP (`ssh2-sftp-client`), Directory (local filesystem copy), and Hub (inbound, no transport needed). Factory function `makeTransport(cd)` selects the right class. |
| `nntpTosser.js` | NNTP tosser. Pulls articles from NNTP servers, pushes local messages as NNTP posts. |
| `peerConnections.js` | Peer connection CRUD. Manages connection records, connection_data JSONB (transport settings, HWM, credentials), subscription management. `buildConnectionData()` handles form→JSONB for all network types. `getConnectionByUUIDWithNetwork()` joins with network metadata for tosser use. `getActiveConnectionsByNetworkType()` returns all active connections for a given protocol. |
| `peers.js` | Peer (remote system) CRUD. Parent entity above connections. Handles cascading deletion (peer → connections → subscriptions). Fields: name, sysop_name, contact, notes. |
| `peerAreaSubscriptions.js` | Manages per-area subscription state for each connection. `syncConnectionToNetwork()` bootstraps rows when connections or areas are created. `setSubscriptions()` bulk-toggles `allowed` or `enabled` flags. `allowAllNetworkAreas()` marks all active network areas as allowed for a connection (called on new connection creation). `syncNetworkAreaToConnections()` syncs a newly added area to all connections on a network with optional allow/enable. `removeSubscriptionsForNetworkArea()` cleans up subscription rows when an area is removed from a network. Lazy-imports peerConnections to avoid circular dependency. |
| `systemAddresses.js` | System address management. Each network has one or more addresses identifying the local system (FTN address, QWK-ID, NNTP host). Includes origin_line field for tear/origin on outgoing messages. |
| `userMsgPointers.js` | Message read tracking model. Two-tier pointer system: area-level scan pointers (`user_msg_pointers`) and per-thread pointers (`user_thread_pointers`). Area pointer is a floor — any message with `id <= area_pointer` is read. Thread pointers add granularity above the floor. Effective read threshold for a thread: `MAX(area_pointer, COALESCE(thread_pointer, 0))`. Provides: `advancePointer`, `advanceThreadPointer`, `markAreaRead`, `getThreadUnreadCounts` (batch), `getUnreadCount`, `hasNewMessages`, `getNewscanSummary`, `getFirstUnreadInThread`, `getFirstUnreadInArea`. Pre-populates pointers on user/area creation. Table bootstrap via `ensureConstraintsAndIndexes()` at startup. |
| `msgAreas.js` | Message area CRUD. `newArea` (creates area record, backing tables, pointer rows, network mapping, area count recalculation), `updateArea`, `removeArea` (with cascading cleanup of pointers, subscriptions, optional table deletion), `recalculateAreaCounts` (correlated UPDATE from actual data, called on every add/remove). Schema includes `thread_mode` (standard/subscribe_only/no_threads) and `post_as` (username/realname) columns. |
| `networkAreas.js` | Maps message areas to networks with areatags. For QWK networks, areatags are conference numbers (numeric strings). For FTN, areatags are echomail tag names (e.g. "DOVE-NET"). |
| `msgNetworks.js` | Network definitions (name, domain, type, config). |
| `echomail.js` | FTN echomail network import/export. Inbound: `handleInboundEchoMessage` (FTN-to-DB conversion, thread resolution, body_html pre-rendering, source_network_id tagging). Outbound: `getOutboundForConnection`, `dbToFtn` conversion. Thread management: `threadMessage`, `applyThreadingForArea`, `updateAreaThreads`, `updateThread`, `mergeRecentThreads`. Has its own copy of `formatBodyHtml` for import-time pre-rendering. View-facing and posting methods have been migrated to `messages.js`. |
| `messages.js` | Message viewing, posting, and sanitization model. Owns all view-facing and user-posting logic. **Viewing:** `listMsgGroups`, `getAreasInGroup`, `getMessage`, `getMessageById`, `getMessageCount`, `countMessagesBefore`, `getMessages` (paginated with `afterId`/`beforeId`/`threadId` filtering), `getMessagesForThread`, `getMessagesForArea`, `getThreadsForArea`, `getRecentThreadsForArea`, `getThreadsPage` (keyset pagination), `getThreadCount`, `getThreadByUUID`, `getThreadUUIDMap` (batch lookup), `buildMessageTree`, `formatBodyHtml`, `escapeHtml`. **Posting:** `startNewThread`, `replyToThread`, `saveMessage` (dispatcher), `updateThread` (stat refresh after reply). **Security:** `sanitizeMessageFields` — strips `<script>`, `<style>`, dangerous tags, event handlers, and `javascript:` URIs from all text fields. Called at the model layer for both web posts and importable by tossers for inbound network packets. **Deletion:** `deleteMessageByUUID`. |
| `codepageConversions.js` | Shared CP437↔UTF-8 conversion utilities. Also provides `formatTextForHtml()` for lightweight space-preservation formatting of plain text with ASCII art alignment. Includes HTML entity escaping as defense-in-depth against XSS. Used by all three tossers. |
| `terminalText.js` | Terminal text formatter. Converts ANSI escape codes, pipe codes (`|XX`), and Synchronet Ctrl-A attribute codes to HTML with CSS classes. Called at import time by all three tossers to pre-render `body_html`. Also used as a fallback at view time for older messages. Supports cursor positioning, color, and a virtual terminal buffer. |

### Middleware / Routes

| File | Purpose |
|------|---------|
| `tosser.js` | CLI entry point. Runs toss cycles for all active network types. Supports `--in`, `--out`, `--ftn`, `--nntp`, `--qwk` flags. PID-file locking prevents concurrent runs. |
| `admin.js` | Admin routes for connection management, network area CRUD, HWM resets. Message group/area management with thread_mode and post_as selectors. `recalculateAreaCounts` route. All DB access through model methods. |
| `index.js` | User-facing message routes. Group/area/thread browsing with unread counts. Thread listing with keyset pagination. Thread reader and flat-view reader with bidirectional lazy scroll and position-aware progress bars. Message posting (`POST newthread`, `POST reply`) with `post_as` name resolution and model-layer sanitization. Mark-area-read. JSON lazy-load endpoints for both directions. Resolves `thread_mode` to render threaded or flat view. |
| `ftnTosser.js` | FTN tosser middleware. `TossInbound()` reads type-2 FTN packets from inbound directory, parses messages via `ReadPkt`, routes echomail to `echomail.handleInboundEchoMessage()` and netmail to `netmail.newInboundNetmail()`. `TossOutbound()` gathers pending echomail and netmail, routes via `ftnRouter.resolveRoute()`, builds type-2 packets, and writes to outbound. Handles archive extraction, packet validation, and move-after-toss. |

### Views

| File | Purpose |
|------|---------|
| `peers_view.pug` | Peer connections admin UI. Create/edit/remove connections. QWK-specific: transport selector (FTP/SFTP/Directory/Hub), Remote QWK ID, show/hide of client fields based on transport type, Reset Idx button. Allowed/enabled area lists are deduplicated per-connection (filtered by subscription rows) and empty groups are hidden. |
| `msgNets_view.pug` | Network admin UI. Network details, system addresses (QWK-ID + origin line for QWK networks), network areas with numeric areatag validation for QWK, peer connection overview. Add-area modal has a grouped searchable select (areas organized by message group, already-mapped areas excluded) and checkboxes for "allow all peers" (checked by default) and "enable all peers" (unchecked by default). |
| `msgGroups/index.pug` | Admin message groups listing with area counts. Manual "Recalculate Area Counts" button. New group modal. |
| `msgGroups/view.pug` | Admin group detail — area listing with area info/edit/delete modals. Thread mode selector (Standard/No Threads/Subscribe Only). Post As selector (Username/Real Name). |
| `messages/index.pug` | User-facing message group listing with aggregate unread counts per group. |
| `messages/groups/view.pug` | User-facing area listing within a group. Per-area unread counts, last post info. |
| `messages/areas/view.pug` | Threaded area view. Thread listing table with keyset-paginated lazy scroll. Unread badges per thread. New Thread modal with monospace textarea. Mark Read button. Flat View toggle (when thread_mode allows). |
| `messages/areas/flat.pug` | Flat (threadless) area view. All messages displayed chronologically with bidirectional lazy scroll. Position-aware progress bar showing viewing window within total message count. Post and Reply modals with quote system. Mark All Read in sidebar. |
| `messages/areas/thread.pug` | Thread reader. Bidirectional lazy scroll starting from first unread message. Position-aware progress bar. Reply button on each message header (per-message reply_to for FTN threading). Reply to Thread button in sidebar (targets thread root). Reply modal with collapsible quote panel — click a line to insert it as `"  > "` prefixed text at the cursor. |
| `console_parsers.js` | Client-side pipe code color parser for message bodies. Largely superseded by server-side `body_html` pre-rendering; retained as fallback for edge cases. |

### External / Synchronet Integration

| File | Purpose |
|------|---------|
| `qnet-directory.js` | Synchronet SpiderMonkey JS module for directory-based QWK exchange. Runs as a SCFG call-out command on the Synchronet side. Copies REP/QWK packets between Synchronet's data directory and the Canectic exchange directory. Logs to `<exchange-dir>/qnet.log`. |

---

## Database Schema (relevant tables)

### peers
A peer represents a remote BBS or system that we exchange messages with. A peer can have multiple connections across different networks.

- `id`, `uuid` — identifiers
- `name` — display name of the remote system
- `sysop_name` — operator name
- `contact` — contact info
- `notes` — freeform notes
- `active` — boolean

Deletion cascades: removing a peer deletes all its connections and their subscriptions.

### peer_connections
Each row represents a single connection to a peer on a specific network. A peer may have one FTN connection on FidoNet, one QWK connection to a QWK hub, etc.

- `id`, `uuid` — identifiers
- `peer_id` — FK to peers (parent)
- `network_id` — FK to message_networks
- `system_address_id` — FK to system_addresses (our identity on this network, nullable — falls back to network default)
- `connection_type` — 'FTN', 'NNTP', 'QWK', 'LOCAL'
- `connection_data` — JSONB containing transport-specific settings (see below)
- `active`

When a new connection is created, `peerAreaSubscriptions.syncConnectionToNetwork()` is called to bootstrap a subscription row for every network_area on that network, then `allowAllNetworkAreas()` marks them all as allowed. The admin can then selectively revoke areas.

### peer_area_subscriptions
Links a peer connection to message areas. One row per connection per area on the connection's network. Two independent boolean flags control message flow:

- `peer_connection_id` — FK to peer_connections
- `area_id` — FK to message_areas
- `allowed` — whether this peer is permitted to send/receive in this area (admin-controlled gate)
- `enabled` — whether message exchange is currently active for this area (can be toggled without revoking permission)
- `msg_idx` — outbound HWM (last message ID sent/processed for QWK push)

Rows are pre-created by `syncConnectionToNetwork()` when a connection is established or when a new area is added to a network that already has connections. Both `allowed` and `enabled` default to `false` on row creation, but `allowAllNetworkAreas()` immediately sets `allowed = true` for new connections.

`setSubscriptions(connectionId, areaIds, field)` is the bulk toggle — sets the given field to `true` for the listed areas and `false` for all others on that connection. If a row is unexpectedly missing, it upserts with a warning log.

### Subscription lifecycle

**New connection created** → `syncConnectionToNetwork()` creates rows → `allowAllNetworkAreas()` allows all active network areas.

**New area added to network** → `syncNetworkAreaToConnections()` creates the subscription row on all active connections for that network. Optionally sets `allowed` and/or `enabled` based on admin checkboxes (allow checked by default, enable unchecked by default).

**Area removed from network** → `removeSubscriptionsForNetworkArea()` deletes all subscription rows for that area across all connections on the network. Called from both the remove-area-from-network route and the delete-entire-area route.

**Entire area deleted** → same cleanup runs per-network before the area record is removed.

### connection_data JSONB structure (FTN)

```json
{
  "address": "1:123/456",
  "status": "NORMAL",
  "session_password": "...",
  "packet_password": "...",
  "tic_password": "...",
  "areafix_password": "...",
  "routing_rules": ["1:*", "2:234/*"]
}
```

`address` is the remote system's FTN address. `status` controls packet flavour (NORMAL/CRASH/HOLD). `routing_rules` is an array of wildcard patterns for the routing cascade (see FTN Routing below). Passwords are per-connection for session, packet, TIC file, and AreaFix authentication.

### connection_data JSONB structure (QWK)

```json
{
  "transport": "ftp|sftp|directory|hub",
  "host": "dove.synchro.net",
  "port": 21,
  "username": "undredux",
  "password": "...",
  "remote_inbox": "/",
  "remote_outbox": "/",
  "remote_qwk_id": "VERT",
  "high_water_marks": {
    "2010": 1234,
    "14002": 567
  }
}
```

For hub transport, only `transport`, `remote_qwk_id`, and `high_water_marks` are used.

### connection_data JSONB structure (NNTP)

```json
{
  "host": "news.eternal-september.org",
  "port": 119,
  "use_tls": false,
  "username": "...",
  "password": "...",
  "high_water_marks": {
    "alt.bbs": 3074,
    "alt.bbs.ads": 13236
  }
}
```

### network_areas
Maps message areas to networks with an areatag.

- `network_id`, `area_id` — composite key
- `areatag` — for QWK networks this is the conference number as a string (e.g. "14002")
- `active`

### system_addresses
Our identity on each network.

- `network_id` — FK to message_networks
- `address` — the address string (FTN: "1:123/456", QWK: "UNDREDUX", NNTP: "news.example.net")
- `origin_line` — tagline/origin text for outgoing messages
- `is_default` — one default per network
- `domain` — inherited from network

### message_areas
Each row represents a message area (forum/conference) belonging to a message group.

- `id`, `uuid` — identifiers
- `name`, `description` — display info
- `shortcode` — unique internal identifier, used to derive backing table names (`mb_<shortcode>_msgs`, `mb_<shortcode>_threads`)
- `group_shortcode`, `group_id`, `group_uuid` — FK to parent group
- `read_security`, `post_security` — minimum security level to read/post
- `min_age`, `max_age` — age restrictions for participants
- `active` — boolean
- `msg_count`, `last_message`, `last_from`, `last_subject`, `last_id` — cached stats
- `thread_mode` — VARCHAR(16), DEFAULT 'standard'. Controls threading behavior:
  - `standard` — normal threaded view with thread listing
  - `no_threads` — flat message list only, no thread grouping
  - `subscribe_only` — (future) only show subscribed threads in newscan
- `post_as` — VARCHAR(16), DEFAULT 'username'. Controls how the poster's name appears:
  - `username` — posts display the user's login name
  - `realname` — posts display the user's full name (falling back to username)

### Message tables (per area)
Each message area has `mb_<shortcode>_msgs` and `mb_<shortcode>_threads` tables.

Key columns on message records:
- `msg_id` — canonical message ID (from @MSGID kludge or HEADERS.DAT Message-ID)
- `qwk_msg_id` — QWK-specific dupe ID: `{connectionUUID}:{confNum}:{msgNum}`
- `nntp_msg_id` — NNTP Message-ID (separate column, allows cross-posting)
- `source_network_id` — which network this message originated from (for echo suppression)
- `origin_line` — extracted origin/tagline (stored separately, may be stripped from body)
- `body_text` — message body (CP437 if from QWK/FTN, UTF-8 if from NNTP or local)
- `utf8` — UTF-8 version of body (null if body_text is already UTF-8)
- `body_html` — pre-rendered HTML for display, generated at import time. Three-tier detection: ANSI/pipe/Ctrl-A → `formatTerminalText()`, triple-space alignment → `formatTextForHtml()`, plain text → `\r` to `<br>`. Null for older messages (view layer falls back to on-the-fly rendering). Non-fatal: import succeeds even if HTML generation fails.
- `thread_id`, `threadid`, `reply_to` — threading

---

## Data Flow

### FTN (FidoNet Technology Networks)

**Inbound:**
```
Remote system sends type-2 FTN packet → inbound directory
  → TossInbound() reads .pkt files
  → ReadPkt() parses packet header + messages
  → Per message: ProcessMessage() extracts kludge lines, body, origin
  → Echomail → echomail.handleInboundEchoMessage(message)
    → ftnToDb() converts FTN fields to DB columns
    → formatBodyHtml() generates body_html
    → threadMessage() resolves/creates thread
    → postgres.insertObject() → mb_<shortcode>_msgs
  → Netmail → netmail.newInboundNetmail(message)
    → ftnToDb() → postgres.insertObject() → netmail_in
  → Move processed .pkt to processed directory
```

**Outbound:**
```
Echomail: DB messages pending export
  → per subscribed peer connection:
    → gather messages above HWM, skip echo suppression (source_network_id)
    → echomail.dbToFtn() converts to FTN Message objects
    → append tear/origin, seen-by, path lines
    → ftnRouter.resolveRoute(destination) determines next hop
    → build type-2 packet → write to outbound directory
    → advance msg_idx

Netmail: netmail.getPendingNetmail()
  → ftnRouter.resolveRoute(destination) per message
  → build type-2 packet per destination → outbound directory
  → netmail.markMessageSent()
```

### QWK Client Mode (we connect to a remote hub)

**Pull (inbound):**
```
Remote Hub → [FTP/SFTP download] → cwd/qnet/<HUB_ID>/in/<HUB_ID>.qwk
  → unzip → extracted/MESSAGES.DAT + HEADERS.DAT (optional)
  → parseMessagesDAT() → applyHeadersDat() (if present)
  → importQwkMessage() per message (dupe check, threading, DB insert)
  → cleanup extracted dir
```

**Push (outbound):**
```
DB messages (above HWM) → workItems with echo suppression + tear/origin
  → buildRepPacket() → MESSAGES.DAT + HEADERS.DAT → system zip → <HUB_ID>.rep
  → [FTP/SFTP upload] → remote hub processes REP
  → advance msg_idx per subscription
```

### Hub Mode (remote nodes connect to us)

**Pull (inbound — node's REP arrives):**
```
Node drops .rep in cwd/qnet/<NODE_ID>/in/ (via qnet-directory.js or directory transport)
  → pullFromQwkPeer() detects .rep in in/ dir
  → unzip → extracted/<NODE_ID>.MSG + HEADERS.DAT
  → parseMessagesDAT() → applyHeadersDat()
  → importQwkMessage() per message
  → cleanup
```

**Push (outbound — node requests QWK):**
```
Connection handler calls buildQwkForNode(connectionUUID)
  → gathers messages from subscribed areas above HWM
  → applies echo suppression + tear/origin
  → buildControlDat() + buildMessagesDat() + buildHeadersDatText()
  → assembleQwkPacket() → cwd/qnet/<NODE_ID>/out/<OUR_ID>.qwk
  → advances HWM
  → node picks up via qnet-directory.js or directory transport
```

---

## QWK Packet Format Reference

### .QWK packet (hub → node)
Zip archive containing:
- `CONTROL.DAT` — BBS info, conference list (CRLF line endings)
- `MESSAGES.DAT` — Record 0 (128-byte ID block with hub's QWK-ID) + message records
- `HEADERS.DAT` — Extended headers keyed by byte offset (LF line endings)
- `NETFLAGS.DAT` — One byte per conference (0x01 = networked)

### .REP packet (node → hub)
Zip archive containing:
- `<HUB_ID>.MSG` — Record 0 (128-byte ID block with hub's QWK-ID) + message records
- `HEADERS.DAT` — Same format as in .QWK packets

### Message header (128 bytes)

| Offset | Length | Field | Notes |
|--------|--------|-------|-------|
| 0 | 1 | Status | 0x20 = public |
| 1 | 7 | MsgNumber | Conference number, left-aligned (REP) |
| 8 | 8 | Date | MM-DD-YY |
| 16 | 5 | Time | HH:MM |
| 21 | 25 | To | Space-padded |
| 46 | 25 | From | Space-padded |
| 71 | 25 | Subject | Space-padded |
| 96 | 12 | Password | Blank |
| 108 | 8 | Reply ref | Left-aligned |
| 116 | 6 | Blocks | Total blocks (hdr+body), left-aligned |
| 122 | 1 | Active | 0xE1 = active, 0xE0 = deleted |
| 123 | 2 | Conference | Little-endian uint16 |
| 125 | 2 | (unused) | Space |
| 127 | 1 | Tagline flag | 0x2A (*) |

### Body encoding
- Line terminator: 0xE3 (CP437 pilcrow)
- Padding: 0x20 (space) to 128-byte boundary
- Character set: CP437
- Kludge lines start with `@` at beginning of body

### HEADERS.DAT format
```
[hex_offset_of_message_header]
Utf8 = false
Message-ID: <unique-id@domain>
Reply-ID: <parent-id@domain>
WhenWritten:  YYYYMMDDHHMMSS+ZZZZ  tzhex
WhenExported: YYYYMMDDHHMMSS+ZZZZ  tzhex
ExportedFrom: QWKID internal_code msg_number
Sender: Full Name
To: All
Subject: Full subject line (not truncated)
Conference: 14002
X-FTN-PID: Canectic QWK Tosser

```

Sections separated by blank lines. LF line endings. Hex offset matches the byte position of the corresponding message header in MESSAGES.DAT/.MSG.

---

## FTN Reference

### Addressing

FTN addresses follow the format `zone:net/node.point` (point is optional, defaults to 0). Examples: `1:123/456`, `2:234/100.1`. The address hierarchy is:

- **Zone** — top-level region (zone 1 = North America, zone 2 = Europe, etc.)
- **Net** — local network within a zone
- **Node** — individual system within a net
- **Point** — sub-address under a node (for point systems)

System addresses for FTN networks store the full address string (e.g. "1:123/456") and also parse out `address_zone`, `address_net`, `address_node`, `address_point` into separate columns for routing queries.

### FTN Packet Structure (Type-2)

Type-2 FTN packets (`.pkt` files) contain a binary header followed by one or more packed messages:

- **Packet header** — source/dest addresses, timestamps, password, product code
- **Messages** — each has a binary header (type, source/dest node/net, attribute, cost, datetime) followed by null-terminated strings (to, from, subject, body text)
- **Packet terminator** — two null bytes

Messages are CP437 encoded. Body text uses `\r` line endings. Kludge lines appear at the start of the body prefixed with `\x01` (SOH character):
- `\x01MSGID:` — unique message identifier
- `\x01REPLY:` — parent message ID for threading
- `\x01TZUTC:` — timezone offset
- `\x01PID:` — product/tosser identifier
- `\x01VIA:` — routing path trace

After the body: `SEEN-BY:` lines (network distribution tracking) and `\x01PATH:` lines (routing trace).

The `ftnClasses.js` `Packet` and `Message` classes model these structures. `ftnTosser.js` `ReadPkt()` handles the binary parsing.

### FTN Routing

`ftnRouter.resolveRoute(destinationAddress)` implements a cascade:

1. **Direct connection** — `connection_data.address` exactly matches the destination. Used when we have a direct link to the target system.

2. **Routing rule match** — destination matches a wildcard pattern in `connection_data.routing_rules`. Rules use `zone:net/node` format with `*` wildcards:
   - `1:*` — route all zone 1 traffic through this connection
   - `2:234/*` — route all nodes in net 234 of zone 2
   - `3:512/100` — route a specific node (explicit override)
   
   First match wins. Connection order from the DB is the tie-break.

3. **Nodelist direct** — (future) look up destination in `ftn_nodelist` table, check for dialable/CM flag.

4. **Coordinator walk** — (future) strip address to hub → region coord → zone coord, checking connections and nodelist at each level.

The `routeResult` object includes the next-hop address, connection UUID, routing method, packet flavour (Normal/Crash/Hold from connection status), and the matched rule pattern.

### Netmail

FTN netmail is private point-to-point messaging, separate from echomail (public messages). Stored in dedicated tables:

- `netmail_in` — inbound messages received from remote systems
- `netmail_out` — outbound messages composed locally, with `sent` flag and `sent_at` timestamp

Outbound flow: `newOutboundNetmail()` validates the destination FTN address and creates the DB record → `getPendingNetmail()` retrieves unsent messages as FTN Message objects → tosser routes each via `ftnRouter` and packs into type-2 packets → `markMessageSent()` flags delivered messages.

### Echomail

FTN echomail (public networked messages) flows through `echomail.handleInboundEchoMessage()` which is shared with any import path that provides an FTN-style message object. Key fields mapped by `ftnToDb()`:

| FTN Field | DB Column | Notes |
|-----------|-----------|-------|
| `MsgId` | `msg_id` | `@MSGID` kludge — used for dupe checking |
| `ReplyTo` | `reply_to` | `@REPLY` kludge — parent message for threading |
| `AreaTag` | (used for routing) | Maps to network_areas.areatag to find the message area |
| `Source` | `source` | Full FTN address of originating system |
| `FromUser` | `from_user` | Sender display name |
| `ToUser` | `to_user` | Recipient (often "All" for public posts) |
| `BodyText` | `body_text` | Message body (CP437, `\r\n` line endings) |
| `OriginLine` | `origin_line` | Extracted `* Origin:` line |
| `SeenBy` | `seen_by` | SEEN-BY distribution tracking |
| `Path` | `path` | PATH routing trace |
| `TZUTC` | `tz_utc` | Timezone offset from `@TZUTC` kludge |
| `TosserId` | `tosser_id` | `@PID` kludge — producing software |

---

## Using buildQwkForNode()

`buildQwkForNode(peerConnectionUUID)` generates a complete `.qwk` packet for a hub-mode node connection. It is **not** called by the tosser — it is designed to be called on-demand by whatever connection handler serves the node.

### Import

```javascript
import { buildQwkForNode } from './models/qwkPacketBuilder.js';
```

### Call

```javascript
var result = await buildQwkForNode('9f894ef9-5333-42c2-826b-caaf84cb457e');
```

### Return value

```javascript
{
  status: true,           // false if error
  qwkPath: '/home/.../qwk/NODEID/out/OURID.qwk',  // path to generated packet, null if no messages
  totalMessages: 12,      // messages included in packet
  totalSkipped: 3,        // echo-suppressed messages
  errormessages: []       // error strings if status=false
}
```

### What it does

1. Loads the peer connection and resolves the local system address (explicit on connection, or network default)
2. Resolves origin line from system address, falls back to `boardname` env var + QWK-ID
3. Deletes any stale `.qwk` in the output directory
4. Queries all enabled subscriptions for the connection
5. For each subscription, gathers messages above the current `msg_idx` (up to 500 per area)
6. Applies echo suppression (skips messages with `source_network_id` matching the connection's network)
7. Applies tear/origin: local messages get `|| Canectic ||` origin, foreign messages get their original origin restored if it was stripped
8. Builds CONTROL.DAT with BBS info and conference list
9. Builds MESSAGES.DAT with Record 0 header block
10. Builds HEADERS.DAT with full-length fields and Message-IDs
11. Builds NETFLAGS.DAT (all 0x01)
12. Zips everything into `cwd/qnet/<NODE_ID>/out/<OUR_ID>.qwk`
13. Advances `msg_idx` for all subscriptions

### Where to call it

Call `buildQwkForNode()` from any connection handler that serves a node requesting its packet:

- **qnet-directory.js integration**: Before the Synchronet call-out runs, have the tosser or a pre-hook call `buildQwkForNode()`. The generated `.qwk` will be in `out/` for `qnet-directory.js` to pick up.
- **FTP server**: When a QWK-restricted user logs in and requests their packet, call `buildQwkForNode()` with the connection UUID matched to that user.
- **HTTP/API endpoint**: Expose a route that triggers packet generation and returns the file.
- **Telnet/terminal QWK menu**: When a user selects "Download QWK packet", call the low-level functions directly with user-specific conference lists.

### HWM timing note

Currently, `buildQwkForNode()` advances the HWM immediately after building the packet. This means if the packet is built but never delivered (crash, network failure), those messages will not be included in the next build. For critical deployments, consider splitting: have `buildQwkForNode()` return the HWM data without advancing, and let the caller advance after confirmed delivery.

---

## Low-Level Packet Building Functions

These are exported from `qwkPacketBuilder.js` for use in contexts beyond node connections (e.g., user QWK downloads, API endpoints).

### buildControlDat(options)

```javascript
var text = buildControlDat({
  bbsName: 'My BBS',
  bbsLocation: 'Calgary, AB',
  bbsPhone: 'N/A',
  sysopName: 'Sysop',
  qwkId: 'MYBBS',
  recipientName: 'NODEID',
  conferences: [
    { number: 14002, name: '5150' },
    { number: 2010, name: 'DoveSysops' }
  ],
  totalMessages: 42
});
```

Returns a CRLF-terminated string ready to write as CONTROL.DAT.

### buildMessagesDat(messageItems, qwkId)

```javascript
var result = buildMessagesDat(items, 'MYBBS');
// result.buffer   — Buffer, the complete MESSAGES.DAT
// result.itemOffsets — array of byte offsets for HEADERS.DAT
```

Each item in the array: `{ msg: <db row>, conferenceNum: <int> }`. The msg object needs `system_time`, `to_user`, `from_user`, `subject`, `body_text`, `utf8`, `reply_ref`.

### buildHeadersDatText(messageItems, offsets, localQwkId)

```javascript
var text = buildHeadersDatText(items, result.itemOffsets, 'MYBBS');
```

Returns LF-terminated string ready to write as HEADERS.DAT.

### assembleQwkPacket(options)

```javascript
var qwkPath = assembleQwkPacket({
  packetName: 'MYBBS',
  tmpDir: '/path/to/workdir',
  controlDat: controlText,
  messagesDat: msgBuffer,
  headersDat: headersText,     // optional
  netflagsDat: netflagsBuffer  // optional
});
```

Writes component files, zips them with system `zip -j`, cleans up intermediates. Returns path to the `.qwk` file. Requires `zip` to be installed on the system.

---

## Transport Types

| Transport | Direction | How it works |
|-----------|-----------|-------------|
| `ftp` | Client | Connects to remote FTP server. Downloads .qwk, uploads .rep. CDs into target directory before upload (Synchronet compatibility). |
| `sftp` | Client | Same as FTP but over SSH. Uses `ssh2-sftp-client`. Supports password and private key auth. |
| `directory` | Client | Copies files to/from local filesystem paths. No network connection. For same-machine setups or shared mounts. |
| `hub` | Hub | No outbound transport. Scans `cwd/qnet/<NODE_ID>/in/` for .rep files on pull. QWK generation is on-demand via `buildQwkForNode()`. |

---

## Tear Line / Origin Handling

### Outbound messages (push/QWK generation)

Three cases handled in both `pushToQwkPeer()` and `buildQwkForNode()`:

1. **Local message** (no `source_network_id`): Strip any existing tear/origin, append `--- \r || Canectic || <origin text>\r`. Origin text comes from system address `origin_line` field, falling back to `<boardname> - <QWK-ID>`.

2. **Foreign message, origin stripped** (`source_network_id` set, `origin_line` in DB, no tear in body): Re-append `--- \r * Origin: <original origin>\r`.

3. **Foreign message, origin intact** (tear line already in body): Leave untouched.

### Inbound messages (import)

The parser extracts `* Origin:` lines from the body and stores them in the `origin_line` column. The clean body (with origin stripped) goes into `body_text`. The raw body (with kludges and origin) goes into `raw_text`.

---

## Environment Variables

| Variable | Default | Used by |
|----------|---------|---------|
| `boardname` | `'Canectic BBS'` | Tear/origin line, CONTROL.DAT BBS name |
| `boardlocation` | `''` | CONTROL.DAT location field |
| `boardphone` | `'N/A'` | CONTROL.DAT phone field |
| `sysopname` | `'Sysop'` | CONTROL.DAT sysop field |

---

## NPM Dependencies

| Package | Used by | Purpose |
|---------|---------|---------|
| `basic-ftp` | qwkTransport.js | FTP client |
| `ssh2-sftp-client` | qwkTransport.js | SFTP client (lazy loaded) |
| `adm-zip` | qwkClasses.js | Unzipping inbound QWK/REP packets only |
| `uuid` | qwkTosser.js, echomail.js, netmail.js | UUIDv4 generation for message records |
| `file-type` | ftnTosser.js | Archive type detection for inbound FTN bundles |
| `luxon` | tosser.js, alogger.js | Date/time formatting |
| `chalk` | alogger.js | Coloured console output |

System dependency: `zip` command (Info-ZIP) for creating outbound packets. `adm-zip` produces zip variants that Synchronet cannot extract, so system `zip` is used for all outbound packet creation.

---

## Tosser CLI Usage

```bash
# Default — all directions, all types
node tosser.js

# Inbound only
node tosser.js --in

# Outbound only
node tosser.js --out

# Specific network type
node tosser.js --qwk
node tosser.js --in --qwk

# Multiple types
node tosser.js --in --ftn --qwk

# Help
node tosser.js --help
```

---

## Key Design Decisions

1. **Conference numbers as areatags**: QWK network_areas use the conference number (as a string) as the areatag. This is enforced at the admin layer with numeric validation.

2. **System `zip` over adm-zip**: Synchronet's unzipper cannot handle adm-zip's output. All outbound zip creation uses `execSync('zip -j ...')`. Inbound extraction still uses adm-zip (works fine for reading).

3. **REP packet naming**: Both .QWK and .REP filenames use the hub's QWK-ID. The internal .MSG filename also uses the hub's QWK-ID. Record 0 of the .MSG file contains the hub's QWK-ID. This matches Synchronet's convention.

4. **HEADERS.DAT**: Generated on all outbound packets (both REP and QWK). Parsed on all inbound packets when present. Provides full-length fields (subjects > 25 chars), proper Message-IDs for dupe checking, timezone info, and UTF-8 flag.

5. **On-demand QWK generation**: Hub-mode QWK packets are built when the node requests them, not during the toss cycle. This prevents stale packets accumulating in the output directory.

6. **Echo suppression**: Messages are tagged with `source_network_id` on import. On export, messages whose `source_network_id` matches the target connection's `network_id` are skipped to prevent echoing back to the originating network.

7. **System address resolution**: The tosser checks `dbconn.system_address_id` first (explicit per-connection), then falls back to `getDefaultAddress(network_id)` (network default). This provides flexibility while ensuring an identity is always available.

8. **CP437 handling**: QWK packets are CP437. Shared `codepageConversions.js` handles CP437↔UTF-8. Control characters 0x00-0x1F are preserved (for ANSI escape codes, pipe codes, etc.).

9. **body_html pre-rendering**: All three tossers generate `body_html` at import time using a shared `formatBodyHtml()` pattern. Detection is three-tier: ANSI/pipe/Ctrl-A codes → `terminalText.formatTerminalText()` (full terminal emulation), triple-space alignment → `codepageConversions.formatTextForHtml()` (space preservation with HTML escaping), plain text → `escapeHtml()` then newline → `<br>`. Generation is non-fatal (try/catch returns null). The view layer uses pre-rendered HTML when available, falls back to on-the-fly rendering for older messages. The `isAnsi` flag is set on retrieval for view-layer styling decisions (monospace, dark background).

10. **Subscription auto-allow from network**: New connections auto-allow all areas currently on the network (not copied from sibling connections, which could be incomplete). This ensures the allowed set is always the full network regardless of what other peers have configured. New areas added to a network sync subscription rows to all existing connections, with admin checkboxes controlling whether they're auto-allowed (default yes) and/or auto-enabled (default no). Removing an area from a network cleans up all associated subscription rows.

11. **No direct DB access from routes**: All database reads and writes go through model methods. Admin routes orchestrate by calling model functions on `peerConnections`, `peerAreaSubscriptions`, `networkAreas`, etc. This keeps business logic portable and testable.

12. **Two-tier read tracking pointers over per-message tracking**: Area pointer is the floor, thread pointers add granularity. Normal reading generates at most 2 DB operations per page view (one upsert, one update) instead of N writes for N messages. The `user_msg_reads` exception table exists for future mark-unread but stays empty during normal usage.

13. **Bidirectional scroll from first unread**: Thread reader and flat view load starting from the first unread message going forward, not from the newest going backward. Users scroll up for older (already-read) content and down for newer. This ensures the first unread is always in the DOM for scroll positioning.

14. **Keyset pagination for thread listings**: `getThreadsPage()` uses `(last_message DESC, id DESC)` cursor instead of OFFSET to avoid skipping/duplicating threads when new messages arrive between pages.

15. **Model-layer input sanitization**: `sanitizeMessageFields()` strips dangerous HTML constructs (script, iframe, event handlers, javascript: URIs) while preserving safe markup and ANSI sequences. Called in the model so it covers web posts, and importable by network tossers. Route-level `sanitize-html` is not used — the model handles it.

16. **Area counts by recalculation**: `recalculateAreaCounts()` runs a correlated UPDATE from actual `message_areas` data on every area add/remove. No increment/decrement drift. Cheap operation for an infrequent action.

17. **resolveUserId for session compatibility**: Redis stores all session values as strings. `resolveUserId(sessionUser)` handles string→number conversion with fallback DB lookup for sessions created before the `id` field was added. All routes use this instead of `currentuser.id` directly.

---

## Future Development Areas

- **User QWK downloads**: Use low-level `buildControlDat()`, `buildMessagesDat()`, `buildHeadersDatText()`, and `assembleQwkPacket()` with user-specific conference lists and scan pointers from `userMsgPointers`.
- **HTTP QWK endpoint**: REST API for packet download/upload (similar to Synchronet's `qwk.ssjs`).
- **HEADERS.DAT on inbound FTN**: The parser infrastructure exists — could be extended to generate HEADERS.DAT-equivalent metadata from FTN kludge lines.
- **HWM split for hub mode**: Return HWM data from `buildQwkForNode()` without advancing, let the caller confirm delivery before advancing.
- **Voting/polls**: VOTING.DAT support in QWK packets (Synchronet generates empty VOTING.DAT).
- **Thread preferences**: Subscribe/ignore per-thread (schema designed, see below). `thread_mode` column implemented; `user_thread_prefs` table and model pending.
- **Newscan route/view**: `GET /messages/newscan` using `getNewscanSummary()`, jump-to-unread shortcuts, mark-area-read shortcuts.
- **Rich text editor**: TinyMCE or similar for HTML message composition. Separate route/handling with whitelist-based sanitization (`sanitize-html` with allowed formatting tags). HTML stored directly in `body_html`; plain `body_text` generated by stripping tags for network compatibility. ANSI conversion on outbound FTN/QWK path would map formatting tags to pipe/ANSI codes.
- **ANSI art paste support**: Users paste raw ANSI into the textarea. Escape sequences (`\x1b[...`) stored in `body_text` and detected by `formatBodyHtml`'s ANSI branch. No special handling needed — already works with current architecture.
- **Tosser sanitization integration**: Wire `sanitizeMessageFields()` calls into echomail.js, nntpTosser.js, and qwkTosser.js inbound paths (see Input Sanitization section).
- **Message body word-wrapping on post**: Ensure user-composed text respects 80 columns before saving to DB (important for FTN/QWK tossing to remote systems).

---

## Message Read Tracking (Implemented)

### Overview

Two-tier pointer system using area-level and thread-level scan pointers. The area pointer acts as a floor: any message with `id <= area_pointer` is considered read regardless of thread pointers. Thread pointers add per-thread granularity above the floor.

This design avoids per-message tracking rows (which would create massive tables) while correctly handling the interleaved nature of threaded messages (where thread A might have messages 10, 15, 22 and thread B has 12, 18, 55 — reading thread A shouldn't mark thread B's messages as read).

### Schema

#### user_msg_pointers

One row per user per area. Pre-populated when areas are created (all users get a row with pointer=0) and when users are created (new user gets rows for all areas with pointer set to current max message ID so history doesn't appear as "new").

```sql
CREATE TABLE user_msg_pointers (
    id SERIAL PRIMARY KEY,
    user_id INTEGER,
    area_shortcode VARCHAR(64),
    scan_pointer INTEGER DEFAULT 0,
    last_read_at TIMESTAMP,
    UNIQUE(user_id, area_shortcode)
);
CREATE INDEX idx_ump_user ON user_msg_pointers(user_id);
CREATE INDEX idx_ump_area ON user_msg_pointers(area_shortcode);
```

#### user_thread_pointers

One row per user per thread visited. Only created when a user actually views a thread. Stores the highest message ID seen within that specific thread.

```sql
CREATE TABLE user_thread_pointers (
    id SERIAL PRIMARY KEY,
    user_id INTEGER,
    area_shortcode VARCHAR(64),
    thread_id INTEGER,
    scan_pointer INTEGER DEFAULT 0,
    last_read_at TIMESTAMP,
    UNIQUE(user_id, area_shortcode, thread_id)
);
CREATE INDEX idx_utp_user ON user_thread_pointers(user_id);
CREATE INDEX idx_utp_user_area ON user_thread_pointers(user_id, area_shortcode);
CREATE INDEX idx_utp_user_area_thread ON user_thread_pointers(user_id, area_shortcode, thread_id);
```

#### user_msg_reads

Retained for future mark-unread functionality. Not used in normal read tracking. Currently empty.

```sql
CREATE TABLE user_msg_reads (
    id SERIAL PRIMARY KEY,
    user_id INTEGER,
    area_shortcode VARCHAR(64),
    msg_id INTEGER,
    is_read BOOLEAN,
    read_at TIMESTAMP,
    UNIQUE(user_id, area_shortcode, msg_id)
);
```

### Read-State Resolution

Effective read threshold for a thread = `MAX(area_pointer, COALESCE(thread_pointer, 0))`.

A message is **unread** if `msg.id > effective_threshold` for its thread.

| Scenario | Result |
|---|---|
| `msg.id <= area_pointer` | READ (area pointer is the floor) |
| `msg.id > area_pointer`, `msg.id <= thread_pointer` | READ (thread pointer covers it) |
| `msg.id > area_pointer`, no thread pointer row exists | UNREAD |
| `msg.id > area_pointer`, `msg.id > thread_pointer` | UNREAD |

### Pointer Advancement

**Viewing a thread**: `advanceThreadPointer(userId, area, threadId, maxMsgId)` — one UPSERT for the thread pointer + one UPDATE for the area pointer, both with `GREATEST()` so they only move forward. Two DB operations total.

**Viewing flat mode**: `advancePointer(userId, area, maxMsgId)` — one UPDATE with `GREATEST()`. One DB operation.

**Mark area as read**: `markAreaRead(userId, area)` — jumps area pointer to `MAX(id)` in the area's message table. Thread pointers don't need updating because the area pointer is the floor.

**Scrolling down for newer messages (lazy-load)**: Advances the appropriate pointer (thread or area) to the highest ID in the new batch.

**Scrolling up for older messages (lazy-load)**: No pointer update — older messages are below the watermark.

### Unread Queries

**Per-thread unread count** (`getThreadUnreadCount`): Single query comparing `msg.id > GREATEST(area_pointer, thread_pointer)` within the thread.

**Batch thread unread counts** (`getThreadUnreadCounts`): Single query with `LEFT JOIN user_thread_pointers` and `GROUP BY thread_id`. Used for thread listings — one query instead of N.

**Area total unread** (`getUnreadCount`): Same LEFT JOIN pattern, area-wide.

**Quick check** (`hasNewMessages`): Fast path checks `MAX(id) > area_pointer`, slower path checks against per-thread pointers only if needed.

**First unread in thread/area** (`getFirstUnreadInThread`, `getFirstUnreadInArea`): Returns the lowest message ID above the effective threshold. Used to position the initial view.

### View Loading Strategy

Both thread reader and flat view find the first unread message first, then load a batch of 30 messages starting from that point going forward. If nothing is unread, they load the newest 30. The first unread message is always in the DOM so scroll-to-unread is a simple querySelector.

Bidirectional lazy scroll: scrolling up loads older messages (prepended), scrolling down loads newer messages (appended). Both views track `oldestId`, `newestId`, `hasOlder`, `hasNewer`.

### Position-Aware Progress Bar

The progress bar shows a positioned window within the total message count. Server passes `messagesBefore` (from `countMessagesBefore()`) along with `hasOlder`/`hasNewer` flags. Client tracks `msgBefore` and `loaded`, renders the bar with `margin-left` (position) and `width` (window size) as percentages. Loading older decreases `msgBefore` (bar grows left), loading newer increases `loaded` (bar grows right).

### QWK Packet Integration

User QWK downloads use the area scan pointer as the starting point for message gathering — same role as `msg_idx` on `peer_area_subscriptions` for node connections. After a successful QWK download:
- Advance the area scan pointer to the highest message ID included in the packet
- Thread pointers not needed (bulk download is sequential)

REP upload (user replies) uses the standard `replyToThread`/`startNewThread` posting path.

---

## Input Sanitization (Implemented)

### Overview

Targeted sanitization at the model layer, covering both web posts and network packet imports. Designed to prevent XSS without stripping legitimate content that may be needed for future rich editing or ANSI art.

### sanitizeMessageFields (messages.js)

Called at the top of `startNewThread()` and `replyToThread()`. Exported for use by tossers on inbound packets.

**What gets stripped:**
- `<script>...</script>` and `<style>...</style>` (tags and content)
- Dangerous void/self-closing tags: `<iframe>`, `<object>`, `<embed>`, `<link>`, `<meta>`, `<base>`, `<form>`, `<input>`, `<button>`, `<select>`, `<textarea>`
- Event handler attributes (`onclick`, `onerror`, `onload`, etc.) on any surviving tags
- `javascript:`, `vbscript:`, `data:` URI schemes in `href`/`src`/`action` attributes

**What is preserved:**
- Plain text including literal `<` and `>` characters
- Safe HTML tags (`<b>`, `<i>`, `<u>`, `<br>`, `<p>`, `<div>`, `<span>`, `<font>`, `<table>`, etc.)
- ANSI escape sequences, pipe codes, Ctrl-A codes (byte sequences, not HTML)
- HTML entities (handled at render time)

### Defense-in-Depth Layers

| Layer | What | Covers |
|---|---|---|
| Model (`messages.js`) | `sanitizeMessageFields` strips dangerous constructs | All sources (web + FTN/NNTP/QWK) |
| Render (`formatBodyHtml`) | `escapeHtml()` on plain text path | Prevents XSS at display time |
| Render (`formatTextForHtml`) | HTML entity escaping before space formatting | Defense-in-depth for codepage path |
| View (`.pug`) | `= msg.body_text` (Pug auto-escape) for `body_text` fallback | Last resort if `body_html` is null |

### SQL Injection

Not a concern — all three tossers and both save functions use parameterized queries via `postgres.insertObject()`. Table names derive from admin-controlled shortcodes (not user input).

### Tosser Integration (Pending)

Add `sanitizeMessageFields(dbObj)` call in each tosser after constructing the DB object but before `postgres.insertObject()`:

- **echomail.js** — after `var dbObj = await ftnToDb(message);` (line ~195)
- **nntpTosser.js** — after the `dbObj = { ... };` block (line ~541)
- **qwkTosser.js** — after the `dbObj = { ... };` block (line ~285)

---

## Message Posting (Implemented)

### Routes

- `POST /messages/area/:shortcode/newthread` — creates thread and first message. Redirects to thread (threaded view) or back to flat view.
- `POST /messages/area/:shortcode/thread/:uuid/reply` — posts reply to existing thread. Sets `reply_to` to the specific message being replied to (from the reply button's `data-bs-msgid`), falling back to the thread root (`dbthread.threadid`). This is critical for FTN `@REPLY` kludge generation during outbound tossing.

Both routes resolve `from_user` via `resolvePostName(sessionUser, msgArea)` which checks the area's `post_as` setting (username or realname). Input is sanitized at the model layer.

### Quote System

The reply modal includes a collapsible quote panel. When replying to a specific message:
1. The original message's plain text is extracted from the DOM (`getPlainText()` clones the element, converts `<br>`/block elements to `\n`, reads `textContent`)
2. Text is word-wrapped at 80 columns (with smart truncation for lines only a few chars over)
3. Lines are displayed with numbered rows in a scrollable panel
4. Clicking a line immediately inserts `"  > {line text}"` at the cursor position in the textarea (truncated to 80 chars after prefix)
5. Inserted lines dim to 40% opacity as visual feedback
6. Users can interleave quotes with their own text by positioning the cursor between inserts

### Flat View Reply Routing

In flat view, messages span multiple threads. Each message carries `thread_uuid` (resolved via `getThreadUUIDMap()` batch lookup). The reply modal's form action is set dynamically per-click to target the correct thread.

---

## Thread Preferences (Design — Not Yet Implemented)

### Overview

Separate from area newscan subscriptions. Allows users to subscribe to or ignore individual threads, independent of whether they're subscribed to the area's newscan. Some areas may also be flagged to function in "subscribe-to-threads" mode rather than "read everything" mode.

The `thread_mode` column on `message_areas` is implemented (standard/subscribe_only/no_threads). The `user_thread_prefs` table and model logic are pending.

### Schema

#### user_thread_prefs

Only non-default rows need to exist. If no row exists for a user+thread, the thread follows the area's default behavior.

```sql
CREATE TABLE user_thread_prefs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    area_shortcode VARCHAR(64) NOT NULL,
    thread_id INTEGER NOT NULL,
    pref VARCHAR(16) NOT NULL DEFAULT 'normal',
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    UNIQUE(user_id, area_shortcode, thread_id)
);
CREATE INDEX idx_utp_user ON user_thread_prefs(user_id);
CREATE INDEX idx_utp_user_area ON user_thread_prefs(user_id, area_shortcode);
CREATE INDEX idx_utp_subscribed ON user_thread_prefs(user_id) WHERE pref = 'subscribe';
```

#### pref values

| Value | Meaning |
|---|---|
| `normal` | Follow area default. If user has area in newscan, thread is included. If not, thread is excluded. (Row can be deleted — absence = normal.) |
| `subscribe` | Always show new messages in this thread, even if the area is not in the user's newscan. |
| `ignore` | Never show new messages in this thread, even if the area is in the user's newscan. |
| `mute` | Like ignore but also suppress notifications (future). |

### Auto-subscribe Triggers (Future)

Threads could be auto-subscribed when:
- User posts a new message (starts a thread)
- User replies to a thread
- User is mentioned/tagged in a thread (requires mention system)
- User receives a private reply in a thread

### Integration with QWK Packets

For user QWK downloads in `subscribe_only` areas:
- Only include messages from subscribed threads
- The conference is still listed in CONTROL.DAT (user can post new threads)
- Thread prefs determine which messages go into the packet

For node QWK packets (`buildQwkForNode`):
- Thread prefs don't apply — nodes get all messages in subscribed conferences
- Thread filtering is a user-level concern, not a network-level one

