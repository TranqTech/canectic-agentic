# Canectic BBS — Message Networking Architecture Reference

## Overview

Canectic BBS supports three message networking protocols: FTN (FidoNet Technology Networks), NNTP (Usenet/newsgroups), and QWK (offline packet-based networking). Each protocol has its own tosser module that handles pulling inbound messages and pushing outbound messages. The system can act as both a **client** (connecting to remote hubs) and a **hub** (accepting connections from downstream nodes).

This document covers the current architecture, key files, data flow, and integration points. It is intended both as a general reference and as a starting point for future development sessions.

For the shared message platform (schemas, read tracking, body_html pipeline, posting, web views, subscriptions), see `message_architecture.md`.
For the terminal-side UI (readers, editors, menus), see `terminal_architecture.md`.
For the web application (Express, sessions, admin panel, WebSockets), see `web_architecture.md`.
For the process model, job queues, and inter-process signaling, see `PROCESS_ARCHITECTURE.md`.

---

## Core Files

### Models (business logic)

| File | Purpose |
|------|---------|
| `ftnClasses.js` | FTN data classes. `Packet` (FTN type-2 packet envelope: source/dest addresses, password, timestamps, message array) and `Message` (single FTN message: type, area tag, addressing, kludge fields, body, origin line). Used by both the tosser and netmail modules. |
| `ftnNodelist.js` | FTN nodelist database model. `ensureTable()` creates the `ftn_nodelist` table with unique constraint on (network_id, zone, net, node, point). `importNodelist()` performs batch upsert (500/batch) with historical tracking (first_seen preserved, last_seen updated, absent nodes deactivated). Lookups: `getNode`, `getNetHost`, `getNodeHub`, `getRegionCoord`, `getZoneCoord`, `findConnectable` (IBN+hostname+not Down/Hold/Pvt), `searchNodes`, `getNodesInNet`. Historical: `getRecentlyAdded`, `getRecentlyRemoved`, `getNetworkStats`, `getNodeHistory`. Utility: `getImportInfo`, `clearNetwork`. |
| `ftnRouter.js` | FTN routing resolver. Given a destination FTN address, determines the next-hop peer connection. Cascade: direct connection match → routing rule wildcard match → nodelist direct → coordinator walk (hub → host → region → zone). Returns `routeResult` with nextHop, connection UUID, method, packet flavour, and `nodelistData` for nodelist-resolved routes. Accepts optional `networkId` parameter. |
| `ftnUtils.js` | FTN utility functions. Message-ID generation, datetime string formatting, system time parsing with timezone offset handling. |
| `areafix.js` | AreaFix automated echomail area manager. Processes netmail commands from FTN peers to subscribe/unsubscribe echomail areas. Authenticates via `areafix_password` in `connection_data`. Commands: +AREATAG, -AREATAG, %LIST, %QUERY, %AREAS, %HELP, %PAUSE, %RESUME, %RESCAN. Builds response netmail via `buildResponse()`. |
| `filefix.js` | FileFix automated TIC file area manager. Same command set and authentication as AreaFix, operates on `file_network_areas` + `file_peer_subscriptions`. Handles netmail addressed to 'filefix', 'filemgr', or 'tic'. |
| `rescan.js` | %RESCAN grammar shared by AreaFix and FileFix, plus the two executors. Only the parser is shared: the mechanisms differ (see Rescan below). |
| `ftnNetmailAdapter.js` | FTN netmail processor routing. Routes inbound netmail by `ToUser` field to AreaFix ('areafix'/'areamgr'), FileFix ('filefix'/'filemgr'/'tic'), or standard PM delivery. Queues response netmail as outbound packets. |
| `netmail.js` | FTN netmail (private point-to-point messages). Separate `netmail_in` and `netmail_out` tables. Handles inbound import with dupe checking, outbound creation with address validation, pending queue retrieval (`getPendingNetmail`), and sent marking. Bidirectional `ftnToDb`/`dbToFtn` conversion. |
| `qwkClasses.js` | Low-level QWK/REP binary packet parsing and building. Header byte layouts, body encoding (CP437/0xE3 line terminators), kludge extraction, HEADERS.DAT parsing, CONTROL.DAT parsing, REP packet assembly using system `zip`. |
| `qwkTosser.js` | _(Located in `src/middleware/tossers/`)_ QWK network tosser. Pull (inbound) and push (outbound) for client connections. Handles FTP/SFTP/directory/hub transports. Imports messages with dupe checking, threading (via `threadMessage`/`rollbackThread`/`pushImportedMsgId` from `messages.js`), HWM tracking. Builds REP packets with HEADERS.DAT for outbound client pushes. **Phase 1.5**: before downloading, checks `inDir` for an existing `.qwk` from a prior failed run — extracts and processes it instead of pulling again (prevents data loss when hubs delete after download). Post-processing cleanup removes both extracted directory and source `.qwk`. Imports `formatBodyHtml` from `terminalText.js`. |
| `qwkPacketBuilder.js` | QWK packet generation module. Builds complete `.qwk` packets (CONTROL.DAT + MESSAGES.DAT + HEADERS.DAT + NETFLAGS.DAT) for hub-mode delivery to nodes. Designed with low-level reusable functions and a high-level `buildQwkForNode()` entry point. |
| `qwkTransport.js` | Transport abstraction layer. FTP (`basic-ftp`), SFTP (`ssh2-sftp-client`), Directory (local filesystem copy), and Hub (inbound, no transport needed). Factory function `makeTransport(cd)` selects the right class. |
| `nntpTosser.js` | _(Located in `src/middleware/tossers/`)_ NNTP tosser. Pulls articles from NNTP servers, pushes local messages as NNTP posts. Uses `threadMessage`/`rollbackThread`/`pushImportedMsgId` from `messages.js` for unified thread management. Imports `formatBodyHtml` from `terminalText.js` for body_html pre-rendering. |
| `peerConnections.js` | Peer connection CRUD. Manages connection records, connection_data JSONB (transport settings, HWM, credentials), subscription management. `buildConnectionData()` handles form→JSONB for all network types. `getConnectionByUUIDWithNetwork()` joins with network metadata for tosser use. `getActiveConnectionsByNetworkType()` returns all active connections for a given protocol. |
| `peers.js` | Peer (remote system) CRUD. Parent entity above connections. Handles cascading deletion (peer → connections → subscriptions). Fields: name, sysop_name, contact, notes. |
| `peerAreaSubscriptions.js` | Manages per-area subscription state for each connection. `syncConnectionToNetwork()` bootstraps rows when connections or areas are created. `setSubscriptions()` bulk-toggles `allowed` or `enabled` flags. `allowAllNetworkAreas()` marks all active network areas as allowed for a connection (called on new connection creation). `syncNetworkAreaToConnections()` syncs a newly added area to all connections on a network with optional allow/enable. `removeSubscriptionsForNetworkArea()` cleans up subscription rows when an area is removed from a network. `resetOutboundIdx(peerConnectionUUID, areaId)` zeroes `msg_idx` for a connection (all areas or one area) so the next toss cycle rescans from the beginning — used by admin HWM reset routes, replacing the protocol-specific reset functions previously in the tossers. Lazy-imports peerConnections to avoid circular dependency. |
| `systemAddresses.js` | System address management. Each network has one or more addresses identifying the local system (FTN address, QWK-ID, NNTP host). Includes origin_line field for tear/origin on outgoing messages. |
| `userMsgPointers.js` | Message read tracking model. Two-tier pointer system: area-level scan pointers (`user_msg_pointers`) and per-thread pointers (`user_thread_pointers`). Area pointer is a floor — any message with `id <= area_pointer` is read. Thread pointers add granularity above the floor. Effective read threshold for a thread: `MAX(area_pointer, COALESCE(thread_pointer, 0))`. Provides: `advancePointer`, `advanceThreadPointer`, `markAreaRead`, `getThreadUnreadCounts` (batch), `getUnreadCount`, `hasNewMessages`, `getNewscanSummary`, `getFirstUnreadInThread`, `getFirstUnreadInArea`. Pre-populates pointers on user/area creation. Table bootstrap via `ensureConstraintsAndIndexes()` at startup. |
| `msgAreas.js` | Message area CRUD. `newArea` (creates area record, backing tables, pointer rows, network mapping, area count recalculation), `updateArea`, `removeArea` (with cascading cleanup of pointers, subscriptions, optional table deletion), `recalculateAreaCounts` (correlated UPDATE from actual data, called on every add/remove). Schema includes `thread_mode` (standard/subscribe_only/no_threads) and `post_as` (username/realname) columns. |
| `networkAreas.js` | Maps message areas to networks with areatags. For QWK networks, areatags are conference numbers (numeric strings). For FTN, areatags are echomail tag names (e.g. "DOVE-NET"). |
| `msgNetworks.js` | Network definitions (name, domain, type, config). |
| `echomail.js` | FTN echomail network import/export. Inbound: `handleInboundEchoMessage` (FTN-to-DB conversion, thread resolution, body_html pre-rendering via `formatBodyHtml` imported from `terminalText.js`, source_network_id tagging). Outbound: `getOutboundForConnection`, `dbToFtn` conversion. Thread management: `threadMessage`, `applyThreadingForArea`, `updateAreaThreads`, `updateThread`, `mergeRecentThreads`. **Shared thread helpers** for all tossers: `createThreadRow(threadtable, threadidStr, subject, systemTime, fromUser)` → `{threadId, threadidStr}`, `updateThreadStats(threadtable, threadId, systemTime, fromUser)`, `rollbackThread(threadtable, threadidStr)`. View-facing and posting methods have been migrated to `messages.js`. |
| `messages.js` | Message viewing, posting, and sanitization model. Owns all view-facing and user-posting logic. **Viewing:** `listMsgGroups`, `getAreasInGroup`, `getMessage`, `getMessageById`, `getMessageCount`, `countMessagesBefore`, `getMessages` (paginated with `afterId`/`beforeId`/`threadId` filtering), `getMessagesForThread`, `getMessagesForArea`, `getThreadsForArea`, `getRecentThreadsForArea`, `getThreadsPage` (keyset pagination), `getThreadCount`, `getThreadByUUID`, `getThreadUUIDMap` (batch lookup), `buildMessageTree`, `formatBodyHtml`, `escapeHtml`. **Posting:** `startNewThread`, `replyToThread`, `saveMessage` (dispatcher), `updateThread` (stat refresh after reply). **Security:** `sanitizeMessageFields` — strips `<script>`, `<style>`, dangerous tags, event handlers, and `javascript:` URIs from all text fields. Called at the model layer for both web posts and importable by tossers for inbound network packets. **Deletion:** `deleteMessageByUUID`. |
| `codepageConversions.js` | Shared CP437↔UTF-8 conversion utilities. Also provides `formatTextForHtml()` for lightweight space-preservation formatting of plain text with ASCII art alignment. Includes HTML entity escaping as defense-in-depth against XSS. Used by `terminalText.js` for the plain-text-with-alignment path. |
| `termMsgFormat.js` | Terminal message body formatting pipeline. CP437↔UTF-8 conversion, pipe/Ctrl-A/ANSI code conversion, semantic line classification (`classifyLine` → NORMAL/QUOTE/TEAR/TAGLINE/ORIGIN/KLUDGE), paragraph reflow (`reflowParagraphs` at 80% threshold reassembles text from wider editors), ANSI art detection (`detectAnsiArt` — checks for cursor positioning CSI sequences, not just color SGR), and ANSI-aware word wrapping (`wordWrapLineAnsi` with `measureVisualWidth`/`findStringIndexAtVisualCol`). Exports `reflowText(text, wrapWidth)` convenience function that normalizes line endings, reflows, and joins with `\r` for VirtualTerminal compatibility. Does NOT import `terminalText.js` (dependency flows one direction only). |
| `userAreaSubs.js` | User area subscription model for newscan filtering. `getSubscriptionMap(userId)` returns `Map<shortcode, boolean>` resolving: user override → area `newscan_default` → true. `getSubscription(userId, shortcode)`, `setSubscription(userId, shortcode, subscribed)`, `removeSubscription(userId, shortcode)` for individual management. Used by terminal newscan and area selector. |
| `terminalText.js` | Terminal text formatter and shared HTML body generator. `VirtualTerminal` class converts ANSI escape codes, pipe codes (`|XX`), and Synchronet Ctrl-A attribute codes to HTML with CSS classes. Supports cursor positioning, color, and a virtual terminal buffer. **`noWrap` mode**: when enabled, lines extend without column wrapping — CSS handles responsive layout. **`formatBodyHtml(displayText, forceWidth)`**: consolidated HTML formatter used by all three tossers and the maintenance regeneration tool. Pipeline: paragraph reflow (`reflowText`) → ANSI art detection (`detectAnsiArt`) → routing: art uses fixed-width VT, colored text uses noWrap VT, plain text uses `formatTextForHtml` or `<br>` replacement. Optional `forceWidth` parameter overrides noWrap to wrap at a specific column width. Imports `detectAnsiArt`/`reflowText` from `termMsgFormat.js` and `formatTextForHtml` from `codepageConversions.js`. |

### Middleware / Routes

| File | Purpose |
|------|---------|
| `tosser.js` | CLI entry point (located in `src/tools/`). Enqueues toss jobs on the BullMQ `toss` queue and waits for completion. Supports `--in`, `--out`, `--ftn`, `--nntp`, `--qwk` flags. Concurrency is managed by BullMQ jobId deduplication (replaces PID-file locking). Requires the worker process (`bin/worker.js`) or embedded mode to be running. |
| `maintenance.js` | CLI entry point (located in `src/tools/`). Enqueues maintenance jobs on the BullMQ `maintenance` queue and waits for completion. Supports `--regen-html`, `--regen-pm-html`, `--purge-pm-trash`, `--recalc-counts`. Flags: `--area SHORTCODE` (repeatable), `--dry-run`, `--width N`, `--batch N`, `--days N`. Concurrency is managed by BullMQ jobId deduplication (replaces PID-file locking). Requires the worker process (`bin/worker.js`) or embedded mode to be running. |
| `messageBase.js` | Message base maintenance functions (located in `src/maintenance/`). `regenerateAllBodyHtml(options)` iterates active areas and regenerates `body_html` from `utf8`/`body_text` using the current `formatBodyHtml` pipeline. `regenerateAreaBodyHtml(shortcode, options)` processes a single area. Uses keyset pagination (by id) for scalability. Options: `areas`, `batchSize`, `dryRun`, `forceWidth`, `onProgress` callback, `quiet`. |
| `admin.js` | Admin routes for connection management, network area CRUD, HWM resets (via `peerAreaSubscriptions.resetOutboundIdx`). Message group/area management with thread_mode and post_as selectors. `recalculateAreaCounts` enqueues via BullMQ maintenance queue. All DB access through model methods; heavy operations go through job queues. |
| `index.js` | User-facing message routes. Shared middleware injects `boardname`, `faviconlink`, `currentPath`, `DateTime`, `ismobile` into all views. Helper functions: `getCurrentUser`, `resolveUserId`, `resolvePostName`, `checkAreaReadAccess`, `checkAreaPostAccess`. Group/area/thread browsing with unread counts. Thread listing with keyset pagination. Thread reader and flat-view reader with bidirectional lazy scroll and position-aware progress bars. All area/thread routes pass `sufficientAccess` and `canPost` booleans — templates use guard chains (`!currentuser` → login, `!sufficientAccess` → unauthorized, `!msgArea` → not found) instead of separate early-return renders per condition. Message posting (`POST newthread`, `POST reply`) with `post_as` name resolution and model-layer sanitization. Mark-area-read. JSON lazy-load endpoints for both directions. Resolves `thread_mode` to render threaded or flat view. |
| `ftnTosser.js` | _(Located in `src/middleware/tossers/`)_ FTN tosser. `TossInbound()` reads type-2 FTN packets from inbound directory, parses messages via `ReadPkt`, routes echomail to `echomail.handleInboundEchoMessage()` and netmail to `netmail.newInboundNetmail()`. Unknown areatags stored in `echomail_bad` holding table via `badEchomail.storeBadMessage()` with sender lookup from `inbound_file_log`. `TossOutbound()` gathers pending echomail and netmail, routes via `ftnRouter.resolveRoute()`, builds type-2 packets with dynamically-sized buffers, writes to zone-aware BSO outbound directories with `.flo` entries, and enqueues a `bso-scan` job to trigger mailer delivery. Handles archive extraction, packet validation, and move-after-toss. |
| `badEchomail.js` | _(Located in `src/models/`)_ Bad echomail holding table and tag tracking. `storeBadMessage()` stores messages for unknown areatags (preserves both `source_address` and `destination_address` for full recovery fidelity). `recoverMessages()` rebuilds an FTN message object from stored fields -- `Source`/`Destination` address strings and Zone/Net/Node integers are restored from stored addresses via `parseFtnAddressInto()`, then passed to `handleInboundEchoMessage()` for import. `purgeOld(days)` removes expired entries. `bad_echo_tags` table tracks areatag history (first/last seen, total count, source info). Admin: `/admin/bad-echomail`. |
| `inboundFileLog.js` | _(Located in `src/models/`)_ Tracks files received via mailer sessions. `logFile()` records filename, path, size, peer info. `lookupSender(filename)` returns most recent sender for a file. Used by tosser to trace bad echomail back to the sending peer. |
| `ticTosser.js` | _(Located in `src/middleware/tossers/`)_ FTN TIC file echo processor. `tossInbound()` scans the inbound directory for `.tic` files, parses each descriptor, validates CRC-32 and TIC password, resolves file area via `fileNetworkAreas.getAreaByTag()`, dupe-checks via `fileEntries.checkDupe()`, handles `Replaces` deactivation, moves file to area directory, extracts FILE_ID.DIZ if no LDesc, inserts `file_entries` row, creates `file_distribution` rows for subscribed peers (excluding source via seenby/path), and moves `.tic` to tossed. `tossOutbound()` queries pending `file_distribution` rows, groups by connection, builds TIC descriptors with proper path/seenby propagation, stages `.tic` + attached files in zone-aware BSO outbound directory (hardlink preferred, copy fallback), creates `.flo` flow file entries for both TIC descriptor and attached file (`^` = delete after send), and enqueues a `bso-scan` job to trigger mailer delivery. Uses: `fileEntries`, `fileAreas`, `fileGroups`, `fileNetworkAreas`, `filePeerSubscriptions`, `fileDistribution`, `fileHasher`, `fileDescExtractor`. |
| `fileNetworkAreas.js` | _(Located in `src/models/`)_ Maps file areas to networks with file echo areatags. `getAreaByTag(networkId, areatag)` resolves inbound TIC area tags. `getNetworksByFileArea(areaId)` returns all network mappings for outbound TIC generation. `getMappingsForNetwork(networkId)` lists all mappings for admin UI. Analogous to `networkAreas.js` for messages. |
| `filePeerSubscriptions.js` | _(Located in `src/models/`)_ Per-connection subscription state for file areas. `getSubscribedConnections(fileAreaId)` returns peer connections with allowed+enabled for distribution row creation. `isSubscribed(peerConnectionId, fileAreaId)` checks inbound authorization. `syncConnectionToFileAreas(peerConnectionId, networkId)` bootstraps rows (same pattern as `peerAreaSubscriptions.syncConnectionToNetwork`). `setSubscriptions`, `allowAllFileAreas`, `enableAllAllowed` for admin management. |
| `fileDistribution.js` | _(Located in `src/models/`)_ Outbound file distribution tracking. One row per file per peer. `createDistributionRows(fileEntryId, peerConnectionIds, protocol)` bulk-creates pending rows (idempotent). `getAllPending()` returns pending rows grouped by connection for outbound processing. `markSent(id)`, `markFailed(id, errorMessage)`, `markSkipped(id, reason)` for status transitions. `retryFailed(peerConnectionId)` resets failed rows to pending. |

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
| `messages/areas/flat.pug` | Flat (threadless) area view. Guard chain: `!currentuser` → login, `!sufficientAccess` → unauthorized, `!msgArea` → not found. Column layout: `col-xl-6.offset-xl-3.col-lg-10.col-12` — centered on xl, wide on lg, full on mobile. Sidebar column hidden below xl (`d-none.d-xl-block`), replaced with offcanvas panel (hamburger ☰ in card header, `data-bs-backdrop='false' data-bs-scroll='true'`, Win95-style close button). Desktop nav buttons (Post, Threads, group-back) hidden below xl. Stacked message headers (from/to/subject over date, reply button right-aligned). All messages displayed chronologically with bidirectional lazy scroll. Position-aware progress bar. `data-force80` (from `msgArea.ansi_area`) and `data-can-post` on container. Post/Reply buttons, modals, quote system, and JS `buildMsgHtml` all gated behind `canPost`. Mark All Read in sidebar/offcanvas. |
| `messages/areas/thread.pug` | Thread reader. Same guard chain, column layout, offcanvas, and `canPost` gating as flat.pug. `← Threads` button hidden on mobile (available in offcanvas). Stacked message headers. Bidirectional lazy scroll starting from first unread message. Position-aware progress bar. Reply button on each message header gated behind `canPost`. Reply to Thread button in sidebar/offcanvas (targets thread root) gated behind `canPost`. Reply modal with collapsible quote panel — click a line to insert it as `"  > "` prefixed text at cursor. `data-force80` and `data-can-post` on container. |
| `partials/messages/_msgAutoSize.pug` | Auto-sizes `.messagebody` font to fit target column count. Creates hidden probe with monospace characters (`font-family:"Consolas",monospace` inline, not inherit). Reads `data-force80` from container: `ansi_area=true` → always 80 cols. Otherwise: desktop (≥992px) → 80 cols, mobile → 40 cols. Min 7px, max 32px. Uses `setProperty('font-size', px, 'important')` to override `.text-12` or other classes. Exposed as `window.fitMessageBodies` for infinite scroll. Included by both flat.pug and thread.pug. |
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

### areas.bbs Bulk Import

Admin tool at `/admin/import/areasbbs` for batch-creating message areas from a standard areas.bbs file (one areatag + description per line, comments with `;` or `#`).

**Flow:**
1. Upload areas.bbs, select target message group and network
2. Parser (`src/utils/areasBbsParser.js`) extracts areatag/description pairs
3. Preview table shows each areatag with status (new vs already mapped) and per-area controls:
   - **Action dropdown**: "Create New Area" or select an existing unmapped area from the group to map to this areatag
   - **Allow** checkbox (default: checked) -- allow for all network peers via `syncNetworkAreaToConnections()`
   - **Enable** checkbox (default: unchecked) -- enable for all network peers
   - Import checkbox to include/exclude individual areas
4. Execute: for each selected areatag, either creates a new area (inheriting group security/flags) with `msgAreas.newArea()` (which handles network mapping and initial subscription sync) or maps an existing area via `networkAreas.addAreaToNetwork()`. Per-area allow/enable flags are applied via `syncNetworkAreaToConnections()`.

New areas inherit: `read_security`, `post_security`, `min_age`, `max_age`, `read_perm_flags`, `read_rest_flags`, `post_perm_flags`, `post_rest_flags` from the target group. Shortcodes are derived from the areatag (uppercased, non-alphanumeric replaced with `_`).

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

See `message_architecture.md` for full schema. Key networking-relevant columns: `shortcode` (derives backing table names), `read_security`/`post_security`, `read_perm_flags`/`read_rest_flags`/`post_perm_flags`/`post_rest_flags` (JSONB access control flags), `thread_mode`, `post_as`, `newscan_default`, `ansi_area`.

### Message tables (per area)

See `message_architecture.md` for full schema. Key networking-relevant columns: `msg_id` (dupe checking), `qwk_msg_id`, `nntp_msg_id`, `source_network_id` (echo suppression), `body_text`, `utf8`, `body_html` (pre-rendered at import time via `formatBodyHtml()` — see message_architecture for pipeline details), `thread_id`, `threadid`, `reply_to`.

---

## Data Flow

### FTN (FidoNet Technology Networks)

**Inbound:**
```
Remote system sends type-2 FTN packet → inbound directory
  → TossInbound() scans inbound dir
    → file-type magic byte detection per file
    → ZIP/ARJ detected + filename matches mail bundle pattern (isMailBundleFilename)
      → extractMailBundle() via adm-zip (in-process, no shell)
      → .pkt entries written to inbound, bundle unlinked on success
    → ZIP/ARJ detected but NOT a bundle filename
      → logged as "ZIP not a mail bundle, leaving for TIC/other processors"
      → left untouched so TIC tosser / wildcard router / echolist scanner
        can handle it
    → .pkt files queued for processing
  → ReadPkt() parses packet header + messages
  → Per message: ProcessMessage() extracts kludge lines, body, origin
  → Echomail → messages.handleInboundEchoMessage(message)
    → ftnToDb() converts FTN fields to DB columns
    → formatBodyHtml() generates body_html
    → threadMessage() resolves/creates thread
    → postgres.insertObject() → mb_<shortcode>_msgs
  → Netmail → netmail.newInboundNetmail(message)
    → ftnToDb() → postgres.insertObject() → netmail_in
  → Move processed .pkt to processed directory
```

**Mail bundle filename gating** (`isMailBundleFilename()` in `ftnTosser.js`)
uses the FTS-5000 / FSC-0057 arcmail bundle convention: day-of-week
prefix (`mo`/`tu`/`we`/`th`/`fr`/`sa`/`su`) plus a single hex-like
counter character `0-9` or `a-z`. So `00010001.mo0`, `abcd1234.su9`,
`xxxxxxxx.tuz` are all recognised as bundles. Everything else with
ZIP magic bytes — TIC-attached archives, nodelist distributions,
infopacks, random downloads delivered via FREQ — is left in the
inbound directory for its rightful processor. Without this gate the
tosser used to blindly `unzip -o` every archive it found, destroying
TIC attachments before the TIC tosser could see them.

**Bundle extraction** (`extractMailBundle()` in `ftnTosser.js`) uses
`adm-zip` in-process rather than shelling out to `unzip`. Benefits:
no shell injection surface from odd filenames, deterministic
behaviour across OS installs, inspectable in unit tests, and every
entry in a legitimate bundle is extracted faithfully (no content
filtering — stray non-pkt files inside a bundle are still written
out so nothing gets silently lost).

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

**Multi-address binkp sessions:** When a remote system advertises multiple AKAs in M_ADR, a single binkp session handles outbound mail for all matched peer connections. Additional connections are grouped only if their `session_password` matches the authenticated password and is non-empty (password-filtered grouping). The session's `_buildOutboundList()` iterates all grouped connections independently. See `MAILER_ARCHITECTURE.md` for details.

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

Messages are CP437 encoded. Body text uses `\r` line endings. Kludge lines appear at the start of the body prefixed with `\x01` (SOH character).

**FTS-0004 kludge format** uses a colon-space separator for most
keywords, but a handful of legacy addressing/routing kludges
(`INTL`, `TOPT`, `FMPT`, `Via`) use a bare-space separator with no
colon per FTS-0001 / FTS-4001. `formatKludge(attribute, value)` in
`ftnTosser.js` centralises the rule so outbound packets always
match whatever convention the keyword requires:

```
\x01MSGID: 1:2/3 abcdef01      — colon-space (FTS-0004 standard)
\x01REPLY: 1:2/3 abcdef02
\x01PID: Canectic 0.9
\x01TID: Canectic Tosser 0.1
\x01TZUTC: -0600
\x01CHRS: UTF-8 4
\x01PATH: 1:134/101 1:134/100
\x01INTL 2:250/1 1:134/107     — bare space (INTL/TOPT/FMPT/Via)
\x01TOPT 5
\x01FMPT 3
\x01Via 1:2/3 @20260410.123456 Canectic
```

The space-separated keywords are tracked in a `Set` at module scope:
`SPACE_SEPARATED_KLUDGES = {INTL, TOPT, FMPT, Via, VIA}`. Adding a
new keyword to one convention or the other is a single-line change
at the top of `ftnTosser.js` and is pinned by tests in
`tests/ftnTosser.test.js`.

**MSGID serial format** (FTS-0009): the portion after the origin
address must be exactly 8 hex characters — a 32-bit value. Canectic
lays this out as:

```
bits 31-16 (16)  days since Canectic epoch    179-year horizon
bits 15-0  (16)  shared per-day counter       65,536/day aggregate
```

The **Canectic epoch** is `Date.UTC(1980, 11, 8)` — December 8, 1980
UTC. Deliberately pre-FidoNet (1984) so the day field can represent
any historical FTN message base that import tools might need to
synthesize MSGIDs for. Wraps at `2^16` days on 2160-06-07, giving
135 years of forward runway from 2025.

The counter lives in the **`msgid_day_watermark` Postgres table**, one
row per day-bucket that has generated messages:

```
id            BIGSERIAL PRIMARY KEY
day_bucket    INTEGER UNIQUE NOT NULL     -- low 16 bits of days-since-epoch
max_counter   INTEGER NOT NULL            -- highest counter used for this day
message_count INTEGER NOT NULL            -- total allocations for this day
source        VARCHAR(32) NOT NULL        -- 'live' / 'import_<label>' / 'backfill'
first_seen    TIMESTAMPTZ
updated_at    TIMESTAMPTZ
```

Every serial allocation is a single atomic Postgres UPSERT:

```sql
INSERT INTO msgid_day_watermark (day_bucket, max_counter, message_count, source)
VALUES ($1, 1, 1, 'live')
ON CONFLICT (day_bucket) DO UPDATE SET
  max_counter   = msgid_day_watermark.max_counter + 1,
  message_count = msgid_day_watermark.message_count + 1,
  updated_at    = NOW()
RETURNING max_counter
```

Postgres handles cross-process atomicity natively via row-level locking
on the conflict target, so gateway, mail, mailer, and worker can all
allocate concurrently without a separate coordination layer. No Redis
dependency in this path; no TTL; no dual-source-of-truth. Historical
imports use the exact same allocator with a day-bucket override.

On process startup, `initializeMsgidCounter()` ensures the table exists
(via CREATE TABLE IF NOT EXISTS as a defensive guard) and, if the table
is empty but outbound message tables contain current-format 8-char
serials, runs a one-time backfill scan that groups messages by day
prefix and populates watermarks for every day that has history.
Legacy 11+ char serials from pre-`e8f6518` installs are ignored
during backfill because they don't follow the Canectic day/counter
layout and can't be parsed into meaningful `(day, counter)` pairs.

If the table write fails (unlikely but possible during DB recovery),
the generator falls back to a timestamp-derived sub-day serial that
has no uniqueness guarantees -- the fallback exists purely to prevent
message composition from hard-failing during a DB outage, and the
sysop is expected to fix the DB and restart.

`genMsgId()` (async, used by `netmail.js`) and `getMilliHex()`
(async, used by `messages.js`) both wrap the same
`_nextMsgIdSerial()` generator so they share the counter pool.
`parseSerial(hex)` splits an 8-char serial back into
`{days, counter}`, and `dayBucketForDate(date)` lets import tools
compute the correct day field for historical message timestamps.

For historical imports specifically:
`allocateHistoricalSerial(originalDate, sourceTag)` allocates a
new serial for a message with the given original timestamp. The
day bucket is computed from the timestamp (pre-1980 clamps to day 0)
and the counter bumps the row's existing `max_counter`. The
`source` column records which import run the watermark came from
so sysops can audit provenance. `getWatermarkForDay(dayBucket)`
returns `{max_counter, message_count, source}` for diagnostics
without allocating a new serial.

**MSGID tuple storage**: the full "address serial" MSGID string
is split into two columns at DB write time:

```
msg_id        VARCHAR(255)    the 8-char serial only
msg_orig_addr VARCHAR(64)     the origin FTN address
```

Dupe checks and reply_to lookups compare the tuple with
`UPPER(COALESCE(msg_orig_addr, '')) = UPPER($2)` so NULL and empty
string are equivalent. Splits happen in `echomail.ftnToDb`,
`netmail.ftnToDb`, `privateMessages.deliverMessage/sendLocalMessage`,
and the QWK/NNTP tossers; joins happen in `echomail.dbToFtn` and
`netmail.dbToFtn` via `ftnUtils.joinMsgidTuple()`.

The `threadid` column in the per-area thread tables stays in the
legacy "address serial" full-string format. It's treated as an
opaque key for threading lookups and rebuilt from the tuple
columns at insert time via `joinMsgidTuple()`. This avoids
schema changes to thread tables while keeping threading logic
human-readable.

`reply_to` is split the same way into `reply_to` (serial) and
`reply_orig_addr` (origin address) so parent lookups in
`threadMessage()` compare tuples. QWK/NNTP tossers populate both
columns; NNTP Message-IDs use empty `msg_orig_addr` because
RFC 5322 IDs aren't FTN MSGIDs.

**Historical imports**: when import tools synthesize MSGIDs for
messages without existing kludges (very old SMB bases, legacy
archives), they should use `dayBucketForDate(originalTimestamp)`
to place the synthetic serial at the correct chronological
position within the day field. The counter half can come from
the shared Redis counter or be pinned explicitly if the import
needs deterministic ordering. Pre-1980 messages clamp to day 0.

See `docs/reference/CTN_DESIGN.md` for forward-looking notes on a
base36 MSGID encoding that would use the same epoch and day
numbering while expanding the burst capacity and removing the
Redis hot-path dependency. Not currently implemented.

After the body: `SEEN-BY:` lines (network distribution tracking) and `\x01PATH:` lines (routing trace) — both use colon-space.

The `ftnClasses.js` `Packet` and `Message` classes model these structures. `ftnTosser.js` `ReadPkt()` handles the binary parsing.

### FTN Routing

`ftnRouter.resolveRoute(destinationAddress, networkId)` implements a cascade:

1. **Direct connection** — `connection_data.address` exactly matches the destination. Used when we have a direct link to the target system.

2. **Routing rule match** — destination matches a wildcard pattern in `connection_data.routing_rules`. Rules use `zone:net/node` format with `*` wildcards:
   - `1:*` — route all zone 1 traffic through this connection
   - `2:234/*` — route all nodes in net 234 of zone 2
   - `3:512/100` — route a specific node (explicit override)

   First match wins. Connection order from the DB is the tie-break.

3. **Nodelist direct** — Look up destination in `ftn_nodelist` table via `ftnNodelist.findConnectable()`. If found with hostname + IBN port and not Down/Hold/Pvt, returns a route with `method='nodelist_direct'` and `nodelistData` containing hostname, port, systemName, isCM.

4. **Coordinator walk** — If direct nodelist lookup fails, walk up the FTN hierarchy:
   - **Hub** — if destination has `hub_node` set, check hub via connections then nodelist
   - **Host** — net coordinator (keyword='Host'), check via connections then nodelist
   - **Region** — region coordinator, check via connections then nodelist
   - **Zone** — zone coordinator, check via connections then nodelist

   At each level, configured peer connections are checked first (for authenticated routing), then nodelist dialability. Returns `method='coordinator'` with the coordinator's address and `nodelistData`.

The optional `networkId` parameter provides explicit network context for nodelist lookups (steps 3-4). When omitted, the network is inferred from the zone of existing FTN connections.

The `routeResult` object shape:
```
{
  nextHop:        string,      // FTN address to send to
  connectionUUID: string|null, // peer_connection UUID (null for nodelist routes)
  connectionId:   number|null, // peer_connection id (null for nodelist routes)
  method:         string,      // 'direct' | 'routing_rule' | 'nodelist_direct' | 'coordinator'
  flavour:        string,      // 'Normal' | 'Crash' | 'Hold'
  ruleMatched:    string|null, // matched wildcard pattern (routing_rule only)
  nodelistData:   object|null  // { hostname, binkpPort, systemName, isCM } (nodelist routes only)
}
```

### Netmail

FTN netmail is private point-to-point messaging, separate from echomail (public messages). Stored in dedicated tables:

- `netmail_in` — inbound messages received from remote systems
- `netmail_out` — outbound messages composed locally, with `sent` flag and `sent_at` timestamp

Outbound flow: `newOutboundNetmail()` validates the destination FTN address and creates the DB record → `getPendingNetmail()` retrieves unsent messages as FTN Message objects → tosser routes each via `ftnRouter` and packs into type-2 packets → `markMessageSent()` flags delivered messages.

### Echomail

FTN echomail (public networked messages) flows through `messages.handleInboundEchoMessage()` which is shared with any import path that provides an FTN-style message object. The orchestrator delegates FTN-specific field conversion to `echomail.ftnToDb()` then runs unified threading via `messages.threadMessage()`. Key fields mapped by `ftnToDb()`:

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

The tosser CLI enqueues jobs on the BullMQ `toss` queue. The worker process (`bin/worker.js`) or embedded mode must be running to consume them. PID-file locking is no longer used — BullMQ's jobId deduplication handles concurrency.

```bash
# Default — all directions, all types
node src/tools/tosser.js

# Inbound only
node src/tools/tosser.js --in

# Outbound only
node src/tools/tosser.js --out

# Specific network type
node src/tools/tosser.js --qwk
node src/tools/tosser.js --in --qwk

# Multiple types
node src/tools/tosser.js --in --ftn --qwk

# Help
node src/tools/tosser.js --help
```

## Maintenance CLI Usage

```bash
# Regenerate body_html for all active areas
node src/tools/maintenance.js --regen-html

# Dry run — preview without writing
node src/tools/maintenance.js --regen-html --dry-run

# Specific area(s)
node src/tools/maintenance.js --regen-html --area GENERAL --area ALTBBSADS

# Force 80-column HTML output
node src/tools/maintenance.js --regen-html --width 80

# Custom batch size (default 100)
node src/tools/maintenance.js --regen-html --batch 50

# Help
node src/tools/maintenance.js --help
```

Maintenance tasks can also be triggered via the BullMQ `maintenance` queue (from admin routes or the scheduler). PM trash purge runs automatically as a daily repeatable job. The CLI tool remains available for manual runs and cron compatibility. See `PROCESS_ARCHITECTURE.md` for queue job definitions and scheduling.

---

## Key Design Decisions

_Networking-specific decisions. For message platform decisions (read tracking, body_html pipeline, sanitization, web views, subscriptions), see `message_architecture.md`._

1. **Conference numbers as areatags**: QWK network_areas use the conference number (as a string) as the areatag. This is enforced at the admin layer with numeric validation.

2. **System `zip` over adm-zip**: Synchronet's unzipper cannot handle adm-zip's output. All outbound zip creation uses `execSync('zip -j ...')`. Inbound extraction still uses adm-zip (works fine for reading).

3. **REP packet naming**: Both .QWK and .REP filenames use the hub's QWK-ID. The internal .MSG filename also uses the hub's QWK-ID. Record 0 of the .MSG file contains the hub's QWK-ID. This matches Synchronet's convention.

4. **HEADERS.DAT**: Generated on all outbound packets (both REP and QWK). Parsed on all inbound packets when present. Provides full-length fields (subjects > 25 chars), proper Message-IDs for dupe checking, timezone info, and UTF-8 flag.

5. **On-demand QWK generation**: Hub-mode QWK packets are built when the node requests them, not during the toss cycle. This prevents stale packets accumulating in the output directory.

6. **Echo suppression**: Messages are tagged with `source_network_id` on import. On export, messages whose `source_network_id` matches the target connection's `network_id` are skipped to prevent echoing back to the originating network.

7. **System address resolution**: The tosser checks `dbconn.system_address_id` first (explicit per-connection), then falls back to `getDefaultAddress(network_id)` (network default). This provides flexibility while ensuring an identity is always available.

8. **CP437 handling**: QWK packets are CP437. Shared `codepageConversions.js` handles CP437↔UTF-8. Control characters 0x00-0x1F are preserved (for ANSI escape codes, pipe codes, etc.).

9. **body_html pre-rendering**: All tossers import `formatBodyHtml()` from `terminalText.js`. Thread helpers shared from `messages.js`. See `message_architecture.md` for the full pipeline details.

10. **Subscription auto-allow from network**: New connections auto-allow all areas currently on the network (not copied from sibling connections, which could be incomplete). New areas added to a network sync subscription rows to all existing connections, with admin checkboxes controlling allow/enable defaults. Removing an area from a network cleans up all associated subscription rows.

11. **No direct DB access from routes**: All database reads and writes go through model methods. Admin routes orchestrate by calling model functions. This keeps business logic portable and testable.

---

## User QWK Packets

Separate from the network-level QWK tosser, the user QWK system (`src/models/qwkUser.js`) generates personal `.qwk` packets for individual users and imports `.rep` reply packets. Full design in `QWK_USER_DESIGN.md`.

### How it relates to the network QWK system

- **Reuses the same low-level functions**: `buildControlDat()`, `buildMessagesDat()`, `buildHeadersDatText()`, `assembleQwkPacket()` from `qwkPacketBuilder.js` and `parseMessagesDAT()`, `parseHeadersDat()`, `applyHeadersDat()`, `unzipQwkPacket()` from `qwkClasses.js`.
- **Different conference numbering**: Network QWK uses areatags from `network_areas` as conference numbers. User QWK uses `message_areas.qwk_conf_number` — a system-wide column allocated in per-group blocks via `message_groups.qwk_conf_start` + `qwk_group_stride` (default 1000), with conference numbers 1-100 reserved for system conferences (announcements, wall, bulletins). Per-area sysop overrides are supported as an escape hatch. These are independent of network conference numbers; a sysop may choose to align them manually.
- **Different pointer system**: Network QWK tracks HWM via `peer_area_subscriptions.msg_idx`. User QWK uses the same `user_msg_pointers.scan_pointer` as web and terminal newscan.
- **Different posting path**: Network QWK imports via the tosser (`importQwkMessage()`). User REP imports via the standard posting path (`messages.startNewThread()`/`replyToThread()`), which enforces access control, user attribution, and body_html generation.
- **No NETFLAGS.DAT**: User packets don't participate in message routing.
- **Conference 0 = PMs**: Unread PMs are included in the download; conference 0 replies in REP are delivered as new PMs.

### Access paths

- **Web**: `/qwk` (transfer page), `/qwk/download` (packet download), `/qwk/upload` (REP upload)
- **Terminal**: `qwkTransfer` menu command — D/U/Q hotkey menu, ZMODEM/XMODEM protocol selection

### Config keys

- `qwk_enabled` (boolean, default true) — enable/disable user QWK transfers
- `qwk_bbsid` (string) — QWK BBS ID for packet filenames (max 8 chars, falls back to boardname)
- `qwk_max_msgs_per_area` (number, default 500) — per-area message cap in user packets

---

## AreaFix / FileFix (Automated Area Management)

AreaFix and FileFix provide automated echomail and TIC file area management via FTN netmail. Remote peers send netmail to "AreaFix" or "FileFix" (case-insensitive) with commands in the message body, and receive a response netmail with results.

### Processor Routing

Inbound netmail is routed by `ftnNetmailAdapter.js` based on the `ToUser` field:

| ToUser | Processor | Handler |
|--------|-----------|---------|
| `areafix`, `areamgr` | AreaFix | `src/models/areafix.js` |
| `filefix`, `filemgr`, `tic` | FileFix | `src/models/filefix.js` |

**Custom routes override.** Before the built-in processor check, `ftnNetmailAdapter` consults `netmailRoutes.matchRoute()` (sysop-configured rules at `/admin/netmail-routes`). A matching rule with `action=alias` rewrites `to_user` and falls through to processor dispatch (lets a sysop add their own processor aliases, e.g. `areamanager` → `areafix`). `action=dump` writes the netmail as JSON to a target directory and consumes the message. `action=ignore` drops the message silently (used for IBBS noise). Attached files are not touched by route actions -- they remain in the inbound dir for wildcards/TIC handling. See `src/models/netmailRoutes.js` and `docs/sysop/NETMAIL_ROUTES.md`.

### Authentication

The password is sent in the **Subject line** of the netmail. The handler looks up the source FTN address in `peer_connections`, then compares the Subject against the `areafix_password` field in `connection_data`. Both AreaFix and FileFix share the same password.

### Commands

Both handlers support the same command set (case-insensitive, one per line in the message body):

| Command | Action |
|---------|--------|
| `+AREATAG` | Subscribe to area (sets both `allowed` and `enabled`) |
| `-AREATAG` | Unsubscribe from area (clears `enabled`) |
| `%LIST` | List all available areas on the network |
| `%QUERY` | List currently subscribed areas |
| `%AREAS` | List areas in areas.bbs/files.bbs format |
| `%HELP` | Show command reference |
| `%PAUSE` | Disable all subscriptions (preserves config) |
| `%RESUME` | Re-enable all previously allowed subscriptions |

### Response Generation

Both handlers call `buildResponse(ftnMessage, responseLines, senderName)` to construct a response netmail (FTN `Message` object) addressed back to the requesting system. The response is returned to `ftnNetmailAdapter.js` which queues it as an outbound netmail packet.

### AreaFix (`src/models/areafix.js`)

Operates on `network_areas` + `peer_area_subscriptions` (echomail areas). `%AREAS` returns an areas.bbs-format listing generated by `generateAreasBbs()` from `areasBbsParser.js`. Generates an `areafix_request` sysop notification when a request is processed.

### FileFix (`src/models/filefix.js`)

Operates on `file_network_areas` + `file_peer_subscriptions` (TIC file areas). `%AREAS` returns a files.bbs-format listing of file echo areatags and descriptions. Generates a `filefix_request` sysop notification when a request is processed.

### Sysop Notifications

AreaFix, FileFix, and the TIC tosser generate sysop notifications (via `src/models/notifications.js`) for events that require operator attention:

| Producer | Type | Trigger |
|----------|------|---------|
| TIC tosser | `tic_error` | Bad TIC file (CRC mismatch, unknown area, password failure) |
| AreaFix | `areafix_request` | Peer subscribes/unsubscribes echomail areas |
| FileFix | `filefix_request` | Peer subscribes/unsubscribes TIC file areas |

Notifications are pushed in real-time via PresenceSocket and appear in the sysop's notification bell. See `web_architecture.md` for the notification UI.

---

## areas.bbs / files.bbs Export

`generateAreasBbs()` in `src/utils/areasBbsParser.js` generates standard areas.bbs text from an array of `{ areatag, description }` pairs with an optional header comment.

### Admin Download Routes

| Route | Purpose |
|-------|---------|
| `GET /admin/export/areasbbs/:networkId` | Download areas.bbs for a message network |
| `GET /admin/export/filesbbs/:networkId` | Download files.bbs for a file network |

Download buttons appear on the network detail pages in the admin panel. The same format is returned by the `%AREAS` command in AreaFix and FileFix.

---

## Tossed Packet Retention

The FTN tosser moves processed `.pkt` files to a tossed directory after import. Retention is controlled by the `ftn_keep_tossed_days` config key:

- **Default**: 7 days
- **0**: Delete immediately after tossing (no retention)
- **999**: Keep forever

A daily maintenance job (`purge-tossed`) runs at 2 AM to remove packets older than the configured retention period. The tosser reads this config value at runtime rather than using hardcoded constants.

---

## Echolist and Filebone Registries

Per-network registries of available areas, imported from standard area list files (BACKBONE.NA, FILEBONE.NA, etc.).

### Schema

- `network_echolists` -- echolist definitions. Multiple per network, `is_default` flag identifies the primary list.
- `network_echolist_areas` -- area entries. `areatag`, `description`, `tags` (JSONB), historical tracking (`first_seen`, `last_seen`, `removed_at`, `active`), `local_area_id` (nullable FK to `message_areas`).
- `file_echolists` / `file_echolist_areas` -- identical structure for file echo areas, `local_area_id` links to `file_areas`.

### Import Workflow

1. Upload area list file (same format as areas.bbs, parsed by `parseAreasBbs()`)
2. Diff engine compares incoming entries against existing: categorises as new, removed, changed (description), unchanged
3. Preview shows counts and flags locally-carried areas that disappeared
4. Execute: inserts new, updates changed descriptions, soft-deletes removed (preserves history), touches `last_seen` on unchanged
5. Sysop notification fired if locally-carried areas disappeared (`echolist_removal` / `filebone_removal` type)

### local_area_id Sync

- `networkAreas.addAreaToNetwork()` -- sets `local_area_id` on matching echolist entries
- `networkAreas.removeAreaFromNetwork()` -- clears `local_area_id`
- `fileNetworkAreas.addMapping()` / `removeMapping()` -- same for filebone entries
- Hooks use dynamic import to avoid circular dependencies; wrapped in try/catch (non-critical)

### Batch Subscribe

Subscribing to a large echolist one area at a time is impractical: a BACKBONE-sized
list runs to a couple of hundred uncarried areatags. The batch page creates a local
message area for many areatags in one pass.

- Page: `GET /admin/echolist/:networkId/batch`, optional `?echolistId=N` to scope to
  a single echolist rather than every list on the network. Reachable from the
  combined view and from an individual echolist page.
- Enqueue: `POST /admin/echolist/:networkId/batch/subscribe`
- Job: `echolist:batch-subscribe` on the **maintenance** queue
- Worker module: `src/maintenance/echolistBatchSubscribe.js`

**Why it is a job and not a request.** Each area costs a shortcode uniqueness
check, a QWK conference allocation, an INSERT, two backing tables
(`mb_<shortcode>_msgs` and `_threads`), a scan pointer row per active user, the
network mapping, and a peer subscription sync. Two hundred areas is several
hundred CREATE TABLEs, well past a request timeout. The sysop gets a
`echolist_batch_subscribe` notification when the run finishes.

**Create-only.** Mapping an existing local area onto an areatag is a per-area
pairing decision and does not generalise, so the batch page only creates.

**Settings are shared.** One target message group, one read/post security pair,
one `post_as`, one newscan default, one set of flags, and the allow/enable peer
toggles apply to the whole batch. One group per batch also keeps QWK conference
numbering in a single block. Run the page again with a different filter to split
areas across groups.

**Shortcodes.** Derived exactly as the single-area flow does
(`areatag.toUpperCase()`, non-alphanumerics to `_`, truncated to 64). That is
lossy, so `FSX.GEN` and `FSX-GEN` both yield `FSX_GEN`. `planBatch()` resolves
collisions against both the database and shortcodes already claimed earlier in
the same run, suffixing `_2`, `_3` and so on, and reports which areas were
renamed. Duplicate areatags in one submission are deduplicated, since an areatag
is unique per network and a repeat means a doubled checkbox, not a second area.

**Failure isolation.** Areas are processed one at a time; a failure is recorded
against that areatag and the run continues. The notification summarises created,
failed, skipped, and renamed counts.

`planBatch(networkId, areatags)` is the read-only pre-flight and is exported
separately, so a dry run never disagrees with what the job will do.

**Filebones have the same feature**, at `/admin/filebone/:networkId/batch`, job
`filebone:batch-subscribe`, module `src/maintenance/fileboneBatchSubscribe.js`.
Kept as a parallel module rather than a shared abstraction, matching the
convention that `fileEcholist.js` mirrors `networkEcholist.js`. The file side
differs in five ways:

- no per-area backing tables (one shared `file_entries`), so an area is much
  cheaper than on the message side
- creating and mapping are two calls: `fileAreas.newArea()` takes no network, so
  `fileNetworkAreas.addMapping()` follows it. A mapping failure is reported
  distinctly, since the area exists but is not on the network
- peer sync takes `allowAll` and `enableAll` in one `syncFileAreaToConnections()`
  pass, rather than allow-inside-create plus a second enable pass
- no QWK conference number to allocate
- extra settings: browse security, browse flags, and the `max_age_days` /
  `max_files` retention limits

`sub_dir` is deliberately not a batch setting. `fileAreas.newArea()` defaults it
to the lowercased shortcode, giving every area its own directory under the
group's `base_dir`; a single shared value would put every area in one directory.

### Models

- `src/models/networkEcholist.js` -- echolist CRUD, import diff/execute, query helpers, sync
- `src/models/fileEcholist.js` -- filebone CRUD (identical API, different tables)
- `src/maintenance/echolistBatchSubscribe.js` -- batch subscribe planning and execution

## Rescan

`%RESCAN` lets a downlink ask for content it already missed. Grammar, identical
on both fixers:

```
%RESCAN                     every subscribed area, default window
%RESCAN ALL                 same; `*` also accepted
%RESCAN AREATAG             one area, default window
%RESCAN AREATAG 30          one area, last 30 days
%RESCAN ALL /FULL           everything still held
%RESCAN AREATAG -FULL       same, dash form accepted
```

Bare `%RESCAN` meaning "all" is the form SBBSecho, Mystic and Squish implement,
so it has to work. `/FULL` is the documented flag: a leading dash already means
unsubscribe in the AreaFix grammar, so `-FULL` is only unambiguous on the same
line as `%RESCAN`.

Config: `areafix_rescan_default_days` (60), `areafix_rescan_max_days` (0, no
ceiling; does not restrict `/FULL`), `areafix_rescan_enabled` (true).

Defaulting to a window rather than everything is deliberate. A full rescan of a
busy area pushes thousands of messages down a link, which is antisocial on a
shared network.

### The two sides do not share a mechanism

Only the parser is shared. `src/models/rescan.js` carries both executors
because the underlying models differ:

| | mechanism |
|---|---|
| message areas | `peer_area_subscriptions.msg_idx` is a high water mark, so a rescan **rewinds a pointer** |
| file areas | `file_peer_subscriptions` has no pointer. Distribution is per file per peer in `file_distribution`, so a rescan **re-queues rows to `pending`** and creates them where a file was never queued for that peer |

### Computing the pointer

`msg_idx` is a message **id**; the window is a **date**; the two do not move
together. An imported message can carry a high id and a very old date, so
anchoring on "the newest thing older than the cutoff" can land above messages
inside the window and silently skip exactly the mail that was asked for. This is
the same trap as the import seal race.

`pointerForWindow()` anchors on the low end instead: the oldest id inside the
window, minus one. The whole window replays, possibly with a few older messages
alongside. For a rescan, over-sending is the right direction to err. When
nothing falls inside the window it returns the current head, making the rescan a
no-op rather than an accidental full replay.

A rescan only ever moves a pointer backwards, so asking for 60 days while
already further behind than that does not skip mail.

### From the admin panel

`POST /admin/connection/:uuid/rescan`, driven by a **Rescan** button on every
connection row of the peer page. It goes through the same model functions as the
netmail path, so the two cannot drift.

The modal takes an areatag (blank or `ALL` for everything), a window in days
(blank uses `areafix_rescan_default_days`) and a Full checkbox, mirroring the
netmail grammar. On an FTN connection it rescans message areas **and** file
areas; QWK and NNTP have message areas only.

Note the existing type-specific **Reset Idx** buttons are unchanged. Those are a
one-click "full, all areas" for NNTP and QWK, which is a rescan with `/FULL`.
FTN previously had no reset button at all, so the Rescan button is the first
way to do this for an FTN link from the UI.

The executors return `{ lines, ... counts }`. `lines` is the netmail response
body; the counts exist because flash messages render as plain text on one line,
so the admin path summarises rather than pasting a 200-area body in. The
per-area detail goes to the log at level 4.

### What a rescan cannot do

Both are stated in the response text rather than left to surprise the downlink:

- **Retention caps it.** Only content still held is replayed, so an area with
  `max_age_days` set holds less than a wider window would ask for.
- **Imported history stays out.** The `imported` flag keeps an SMB/JAM migration
  from being replayed.

## sbbsecho.ini Import

Migration tool for importing linked FTN node configuration from Synchronet BBS.

- Parser: `src/utils/sbbsechoParser.js` -- parses `[node:*]` sections (peer connections) and `[domain:*]` sections (networks). Filters wildcard routing entries (`ALL`). Auto-groups nodes by BinkpHost then Name.
- Two-step admin flow: Step 1 resolves networks (create/map/skip) and local addresses (create/keep/skip, with zone creation for new networks). Step 2 groups connections into peers with drag-and-drop, per-connection network and local address dropdowns.
- Routes: `/admin/import/sbbsecho` (upload), `/admin/import/sbbsecho/preview` (parse), `/admin/import/sbbsecho/networks` (process networks, show peer grouping), `/admin/import/sbbsecho/run` (create peers + connections)

## Future Development Areas

_Networking-specific items. For message platform items (web newscan, rich editor, thread preferences, etc.), see `message_architecture.md`._

- **HEADERS.DAT on inbound FTN**: The parser infrastructure exists — could be extended to generate HEADERS.DAT-equivalent metadata from FTN kludge lines.
- **HWM split for hub mode**: Return HWM data from `buildQwkForNode()` without advancing, let the caller confirm delivery before advancing.
- **Voting/polls**: VOTING.DAT support in QWK packets (Synchronet generates empty VOTING.DAT).
- **Tosser sanitization integration**: Wire `sanitizeMessageFields()` calls into the `handleInboundEchoMessage` orchestrator in messages.js, plus nntpTosser.js and qwkTosser.js inbound paths (see `message_architecture.md` Input Sanitization section).

---

## Message Read Tracking

See `message_architecture.md` for the full two-tier pointer system, schemas, read-state resolution, pointer advancement, unread queries, view loading strategy, and progress bar implementation.

**QWK Packet Integration**: User QWK downloads use the area scan pointer as the starting point for message gathering — same role as `msg_idx` on `peer_area_subscriptions` for node connections. After a successful QWK download, `buildQwkForUser()` advances the area scan pointer to the highest message ID included in the packet. REP upload uses the standard `replyToThread`/`startNewThread` posting path via `importRepForUser()`. See the "User QWK Packets" section above and `QWK_USER_DESIGN.md`.

---

## Input Sanitization, Message Posting, Web Views, Subscriptions

See `message_architecture.md` for:
- Input sanitization (`sanitizeMessageFields`, defense-in-depth layers, tosser integration points)
- Message posting (routes, `post_as` resolution, quote system, flat view reply routing)
- Web view architecture (responsive layout, offcanvas sidebar, auto-sizing, access control, message headers)
- User area subscriptions (schema, resolution order, usage)

---

## Thread Preferences (Design — Not Yet Implemented)

See `message_architecture.md` for the full design: `user_thread_prefs` schema, pref values (normal/subscribe/ignore/mute), auto-subscribe triggers, QWK packet integration.

