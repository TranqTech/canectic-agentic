# QWK Networking Architecture

The QWK half of Canectic's message networking in detail: identity, packet directories, what a hub passes on, character sets, files, private mail, the packet format and the builders. The overview of all three protocols (FTN, QWK, NNTP), the shared tables and the data flow is in `NETWORKING_ARCHITECTURE.md`; the sysop guide is `docs/sysop/QWK_NETWORKING.md`. Split out of NETWORKING_ARCHITECTURE.md on 2026-09-26, when that file outgrew the MCP knowledge base's 100 KB limit.

## Identity and packet directories

**QWK ID rules (#67), `src/utils/qwkId.js`:** Synchronet's `code_ok` character rule (not empty; none of `` \/|<>*?+[]:=";, `` or a space; printable ASCII), stored upper case, 8 characters unless the network's `config.qwk_long_ids` is true (then 32). A digit first, or `.`/`@`, is a warning, not a refusal (netmail cannot address it). **Unique per role:** `remoteRole(cd)` is `node` for the hub transport and `hub` for any other, and `findIdClash` refuses a second connection with the same ID in the same role, across networks and including inactive connections (one namespace per board, as in Synchronet, since the packet and the directory are named by the ID). Checked in `peerConnections.newConnection`/`updateConnection` (`checkQwkConnection`) and in `systemAddresses.newAddress`/`updateAddress` for QWK networks; `msgNetworks.updateNetwork` refuses turning `qwk_long_ids` off while `longQwkIdsOnNetwork` finds any. Results reach the sysop through `flashSaveResult` on the network and peer pages, which previously only logged a refused save. Existing violations are reported, never refused, by `src/maintenance/qwkIdAudit.js` at gateway startup: one `qwk_id_problem` notification per distinct problem list (deduped on type and body).

**Packet directories (#68), `src/utils/qnetPaths.js`:** `qnet/<ID>.hub/{in,out}` for a connection where ID is our hub, `qnet/<ID>.node/{in,out}` where ID is our node (role = the part after the LAST dot, lower case; IDs are upper case and may contain dots). `qnetDir`/`qnetInDir`/`qnetOutDir` are the only builders of these paths (a test fails on a literal `'qnet'` in the tosser, packet builder or qnet routes). Before, both roles of one system shared `qnet/<ID>/` and one `in/extracted/`, so a leftover from one role could be imported as the other's mail. Migration `0008-qnet-role-dirs` (`src/maintenance/qnetLayout.js`, builtins only, never throws, never overwrites) moves an upgraded board's directories: an ID with one role moves whole; an ID with both is split by file (`in/*.rep`, `out/*.qwk(.json)`, `qnet.log`, `in/extracted` holding a `.MSG` go to the node role; `in/*.qwk`, `in/bak`, `out/*.rep`, `in/extracted` holding `MESSAGES.DAT` to the hub role; anything else to the node role, reported); IDs with no connection are left. `qnet/<ID>` then becomes a symlink to `<ID>.node` wherever the ID has a node role, since only the node role is used from outside (qnet-directory.js), so an existing shared-directory node keeps working. The peer page shows each QWK link's packet directory.

## Hub behaviour, routing and content

**Shared-directory nodes** (`hub_directory`): the node never calls, so the fixed `qwk-hub-sweep` schedule (toss queue, job `qwk:hub-sweep`, every `qwk_hub_sweep_minutes`, registered by `syncQwkHubSweep()` only while such a node exists; re-synced whenever a QWK connection is saved or removed) runs `qwkTosser.serviceHubNodes()`: import any REP in every hub node's `in/` (HTTP nodes included, as a catch for an import that could not be queued), then `buildQwkForNode()` for each directory node. The node's acknowledgement is taking the packet: qnet-directory.js copies `out/<OUR_ID>.qwk` and deletes it, so a sidecar with no packet beside it is committed (`commitPending`) at the top of the next `buildQwkForNode()`, before anything is built. The commit is idempotent, which also covers a `commitNodePacket()` interrupted between its two deletes. A node with no enabled subscriptions still gets a packet when it has private mail waiting.

**Sender paths and passing mail on (#70), `src/utils/qwkVia.js`:** an imported QWK message's `path` holds its sender path as Synchronet stores SENDERNETADDR: the QWK ID of the connection that handed it to us, then that message's `@VIA` (`senderPath`), so `HUB/A/B` means B wrote it and the ORIGIN is the last element (`originOf`). Rows imported before #70 hold the bare `@VIA` or nothing. A message whose `@VIA` already contains our QWK ID is refused as circular (Synchronet `route_circ`). **Export (`exportDecision`)** replaced a rule that skipped every message with `source_network_id` equal to the connection's network, which meant a Canectic hub never passed one node's mail to its other nodes and a mid-tier board never passed its nodes' mail up (the FTN version of the same bug was 940b1be): local mail and mail from another network go as before; mail from this network goes to every connection whose remote ID is NOT in its path, and carries `@VIA: <path>` as the first body line (`withVia`, Synchronet QM_VIA); mail from this network with no path (pre-#70 rows) keeps the old skip. **Netmail forms (`parseNetmailAddress`)**: a conference-0 message with To `NETMAIL` and `user@address` on the first body line, or To `user@address`, is netmail (QWKnet when the address does not start with a digit and has no `.` or `:`, as in Synchronet's qwktonetmail). `importQwkPrivateMessage` delivers it locally when the path's last element is our QWK ID (dropping the address line), and otherwise records it undeliverable with the reason (not relayed until #73; FidoNet and internet addresses are not gatewayed). PMs keep `from_address` = origin and `transport_data.source_path`. The undeliverable record now stores its reason and a single-encoded transport_data (both were wrong before).

**UTF-8 on the wire (#71), `qwkClasses.js`:** a message goes as CP437 (0xE3 line separators) whenever its body, sender, recipient and subject all fit CP437 (`messageNeedsUtf8`, the FTN charset `auto` rule), and as UTF-8 with LF separators only when they do not AND the connection's `utf8` option allows it (on unless `connection_data.utf8 === false`; Synchronet honours HEADERS.DAT `Utf8 = true` on import whatever its own settings, qwktomsg.cpp:41). The builders set `item.utf8Wire` and the HEADERS.DAT writers (`buildHeadersDatText`, `buildHeadersDatEntry`) write `Utf8` from THAT, and encode each entry in its own charset as a byte string (`headersEntryBytes`, written with 'latin1'). They used to write `Utf8 = true` whenever the stored row's `utf8` column was set (most mail) over a CP437 body, and Synchronet, which splits a Utf8 message on LF only (qwktomsg.cpp:323), read those as one run-on line. Reading: `decodeQwkBody(bytes, isUtf8)` is the one body decoder; `parseMessagesDAT` keeps `bodyBytes`, and `applyHeadersDat` decodes a `Utf8 = true` message again as UTF-8 with LF lines (it used to copy the CP437 decoding) and each HEADERS.DAT value by its own entry's Utf8 line (`decodeHeaderValue`; with no Utf8 line, valid UTF-8 else CP437). Both HEADERS.DAT readers read the file as latin1 bytes. Personal packets (qwkUser) pass no option and never claim UTF-8.

**Files in packets (#72), `src/models/qwkFiles.js`:** Synchronet's QWKnet file channel: any extra member of a packet archive is a file. Sending: plain files in `qnet/<ID>.<role>/out/files/` (`listOutgoing`; names must be `[A-Za-z0-9_][A-Za-z0-9._-]*` and not a packet's own member) go into the next packet. Hub: `buildQwkForNode` zips them in (`assembleQwkPacket` `extraFiles`), lists them in the `.qwk.json` sidecar (`filesDir`, `files`), and `commitPending` removes them, so they go only once the node has the packet; a packet with only files is still built. Client: `buildRepPacket` `extraFiles`, recorded in `<rep>.files.json`, removed by `sentRepFiles` when that REP is delivered (including a later retry of the same REP); the push no longer returns early while files or a stale REP wait (a stale REP used to wait for the next new message). Receiving: after a successful import, `receiveExtraFiles` keeps every non-standard member (standard: CONTROL.DAT, MESSAGES.DAT, HEADERS.DAT, VOTING.DAT, NETFLAGS.DAT, DOOR.ID, TOREADER.EXT, TODOOR.EXT, ATTXREF.DAT, *.NDX, *.MSG), through the inbound wildcard rules (`fileWildcards.matchFilename`) else to `in/files/`, overwriting a file of the same name as Synchronet does, capped at 1000 per packet; one `qwk_file_received` sysop notification per file. They used to be deleted with `extracted/`. Plain channel only: no descriptions or areas (that would be a Canectic-only extension).

**QWK private mail routing** (`src/models/qwkPmRouting.js`): both builders (client REP and hub packet) take PMs from `pendingQwkPmsFor(connectionUUID)`, never `getPendingByTransport('QWK')`, which handed every pending PM to whichever connection packed first. `routeQwkPm` (pure): a reply pinned to `transport_data.peer_connection_uuid` (set by the web and terminal reply paths from the inbound PM) while that connection is active and still has the destination's QWK ID; else the active connection whose `remote_qwk_id` equals `transport_data.destination || to_address`, case-insensitively, preferring the one where that system is our hub when it is both our hub and our node (Synchronet's `qwk_route` checks hubs first; #69); else undeliverable via `markOutboxUndeliverable`, which bounces to the sender. Since #73 the router also takes explicit hop paths and learned routes; see "Routes and relaying".

**Routes and relaying (#73), `src/models/qwkRoutes.js`, `qwkPmRouting.js`, `qwkTosser.relayQwkNetmail`:** Synchronet's `qnet/route.dat`, kept PER NETWORK in table `qwk_routes` (`route_key` = `<network_id>:<ID>`, latest path wins, entries older than 90 days ignored by `fresh()` and deleted by the next `learn()` on that network). `learn(networkId, senderPaths)` runs after every pull with the sender path of each imported message, echomail and netmail alike (`routesFromSenderPath`: the path up to each system after the first, which is a direct link). `routeQwkPm(pm, connections, routes)` follows Synchronet's `qwk_route` order and returns `{uuid, rest, method}`: a reply back over the connection its original came in on, along `transport_data.route_path` (the original's `source_path`, set by the web and terminal reply paths); the destination as a direct connection (hub role first); an explicit `HUB/.../DEST` whose first hop is a direct connection; a learned route whose first hop is a direct connection ON THE ROUTE'S NETWORK; else a reason. `transport_data.network_id` (relayed mail, or the web send form's QWK network choice) confines it to one network; a destination learned on two networks is refused as ambiguous until one is chosen. `rest` (the hops after the next) decides the wire form (`qwkVia.netmailWire`, applied by `wireFor` in both builders): To `NETMAIL` with `user@REST` as the first body line while hops remain, To = the user on the last hop, and `@VIA: <source_path>` after it on relayed mail (Synchronet `msgtoqwk` QM_TO_QNET). On import, the `@VIA` that follows a NETMAIL address line is read (`takeLeadingKludges`; the packet parser only reads kludges at the very start). Netmail for a system beyond us goes to `relayQwkNetmail`: refused if its `@VIA` already names us (loop), if the network's `config.qwk_relay === false` (on unless set false), if there is no route, or if the only way on is back to the sender; otherwise queued in `pm_outbox` (`user_id` 0, `transport_data` `{destination, network_id, relay: true, source_path}`). Every refusal sends `BADADDR: <address>` back along the sender path (never for a message whose subject is already `BADADDR:`), and every decision is a `netmail_relay_log` row with `relay_mode` `qwk`, `next_hop`, `route_method` and `via_in`. Gateways to FidoNet or internet mail are not done.

**FTP hub server (#74), `src/servers/qwkFtpServer.js`:** started by the gateway when `qwk_ftp_port` > 0 (restart). Built on `net` (no dependency) for the command set Synchronet's `exec/load/ftp.js` and basic-ftp use: USER, PASS, QUIT, NOOP, SYST, FEAT, OPTS, HELP, TYPE/MODE/STRU/ALLO (accepted), PWD, CWD/CDUP (root only), PASV, EPSV, PORT/EPRT (back to the logged-in client's own address only, which rules out the FTP bounce attack), SIZE/MDTM (the waiting packet only), LIST/NLST, RETR, STOR, DELE (a no-op on the packet), ABOR. Login is `qnetAuth.matchNode` (active hub-transport connection with a password; a failure writes the fail2ban `[AUTHFAIL]` line, three close the session), refused with 421 while maintenance mode is on or while that node already has a session (Synchronet's wording). `RETR <OUR_ID>.qwk` runs `buildQwkForNode()` (550 "No QWK packet created (no new messages)" when nothing), streams it, and only when the data connection closes cleanly calls `commitNodePacket()` and answers 226; a broken transfer answers 426 and commits nothing, so the same packet is offered next time. `STOR <OUR_ID>.rep` (anything else 553 "Invalid path or filename.") is capped at `qnet_max_rep_bytes`, must be a ZIP, is stored under a unique name in the node's `in/` via a temp file, and queues `qwk:hub:inbound` (`opts.enqueueInbound` replaces that in tests). Transfers are recorded with transport `ftp-hub`. Passive data: `qwk_ftp_pasv_address` for NAT, `qwk_ftp_pasv_ports` range (`parsePortRange`). Plain FTP only.

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
  qwkPath: '/home/.../qnet/NODEID.node/out/OURID.qwk',  // null if nothing to send
  packetId: 'uuid',       // what the node acknowledges
  reused: false,          // true when an uncollected packet was offered again
  totalMessages: 12,      // messages included in packet
  totalSkipped: 3,        // echo-suppressed messages
  errormessages: []       // error strings if status=false
}
```

### What it does

1. Loads the peer connection and resolves the local system address (explicit on connection, or network default)
2. Resolves origin line from system address, falls back to `boardname` env var + QWK-ID
3. Commits a packet the node has already collected (a sidecar with no packet beside it), then returns any packet still waiting unchanged (`reused: true`)
4. Queries all enabled subscriptions for the connection
5. For each subscription, gathers messages above the current `msg_idx` (up to 500 per area)
6. Decides per message with `exportDecision` (#70): nothing goes to a system already in its sender path, and passed-on mail carries `@VIA`
7. Applies tear/origin: local messages get `|| Canectic ||` origin, foreign messages get their original origin restored if it was stripped
8. Builds CONTROL.DAT with BBS info and conference list
9. Builds MESSAGES.DAT with Record 0 header block
10. Builds HEADERS.DAT with full-length fields and Message-IDs
11. Builds NETFLAGS.DAT (all 0x01)
12. Zips everything into `cwd/qnet/<NODE_ID>.node/out/<OUR_ID>.qwk`
13. Commits nothing: writes the `.qwk.json` sidecar (HWMs, PM ids, files) for `commitNodePacket()`/`commitPending()` once the node has the packet. Private mail comes from `pendingQwkPmsFor`, files from `out/files/`; a packet with only PMs or only files is still built

### Committing: only on acknowledgement

`buildQwkForNode()` commits nothing. It writes the packet with a sidecar,
`<packet>.qwk.json`, holding `packetId` and what delivery commits: each
subscription's new `msg_idx` (`hwm`, from `hwmFor()`) and the `pm_outbox` ids
it carries. While that packet is on disk every call returns it again
(`reused: true`), unchanged. `commitNodePacket(uuid, packetId)` applies the
sidecar and removes both files; an id that does not match the packet waiting
commits nothing, so a stale or replayed acknowledgement cannot advance past a
packet the node has not seen. A packet with no sidecar (built by an earlier
release, which advanced on build) is removed with nothing to commit.

Before this the HWM advanced when the packet was built, so a download that
failed lost every message in it. Also fixed here: the maximum was taken by
comparing ids as STRINGS (postgres returns them that way), so a packet of
messages 1 to 10 committed 9 and message 10 went again. `hwmFor` compares
numerically and `advanceHwmForItems` uses it.

### QWK hub over HTTP

`src/routes/api/qnet.js`, mounted under `/api/v1/qnet` (so it inherits the
`/api/` CSRF exemption and the maintenance-mode JSON 503). Until it existed
a Canectic hub had no network transport, and nothing called
`buildQwkForNode()` at all, so a hub never produced a packet for a node.

- **Auth:** HTTP Basic, user = the node's QWK ID (the hub connection's
  `remote_qwk_id`, any case), password = the hub connection's `password`
  (`src/utils/qnetAuth.js`, constant-time compare). An active `hub`
  connection with an EMPTY password never matches: the QWK ID is in every
  packet. A failure logs `[AUTHFAIL] Failed login for "QWK node <ID>" from
  <ip>` to `security.log`, which the shipped fail2ban filter already matches.
- `GET /hello` -> `{hub, node, protocol: 1}`: the client's connect step.
- `GET /packet` -> the packet with `X-Qnet-Packet-Id` and `X-Qnet-Messages`,
  or 204 when there is nothing (not logged). Built in the gateway, like the
  user QWK download.
- `POST /packet/:id/ack` -> `commitNodePacket`; 409 on a mismatched id.
- `POST /rep` (octet-stream, `qnet_max_rep_bytes`, 20 MB) -> must look like
  a ZIP, stored as `<NODE>-<ms>-<rand>.rep` via a temp name so a second upload
  cannot overwrite the first, then `enqueueQwkHubInbound`; 202. The worker
  runs `pullHubReps()`, which imports every waiting REP oldest first (the
  inbound job is deduplicated while it waits, so two uploads can share one).
- Transfer log: packets served and refused uploads are recorded by the route
  with transport `http-hub` and the node's IP; the REP import records its own
  row from the worker.

The client is `HttpTransport` in `qwkTransport.js`. `downloadFile` writes the
packet (temp, fsync, rename) and then acknowledges it, the same point an FTP
hub deletes after download; the tosser imports from that local copy and
processes a leftover one before pulling again. A failed acknowledgement is
logged and the hub re-offers the same packet, which dupe checking absorbs.
Network errors carry fetch's `cause` code and 401 says "authentication
failed", so the transfer log classifies them.

Shared-directory (`qnet-directory.js`) nodes get their packets from the hub
sweep (see "Shared-directory nodes" above), and QWK private mail is routed per
connection (`qwkPmRouting.js`). Nodes that call over FTP use the FTP hub server (#74, below).

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

### buildMessagesDat(messageItems, qwkId, opts)

```javascript
var result = buildMessagesDat(items, 'MYBBS', { utf8: true });  // opts optional
// result.buffer   — Buffer, the complete MESSAGES.DAT
// result.itemOffsets — array of byte offsets for HEADERS.DAT
```

Each item in the array: `{ msg: <db row>, conferenceNum: <int> }`. The msg object needs `system_time`, `to_user`, `from_user`, `subject`, `body_text`, `reply_ref`. `opts.utf8` allows UTF-8 for messages that do not fit CP437 (#71); the builder sets `item.utf8Wire`, which `buildHeadersDatText` turns into each entry's `Utf8` line. Without it (personal packets) everything is CP437.

### buildHeadersDatText(messageItems, offsets, localQwkId)

```javascript
var text = buildHeadersDatText(items, result.itemOffsets, 'MYBBS');
```

Returns an LF-terminated BYTE string (one character per byte, each entry in its own charset); write it with `'latin1'`, as `assembleQwkPacket` does.

### assembleQwkPacket(options)

```javascript
var qwkPath = assembleQwkPacket({
  packetName: 'MYBBS',
  tmpDir: '/path/to/workdir',
  controlDat: controlText,
  messagesDat: msgBuffer,
  headersDat: headersText,     // optional
  netflagsDat: netflagsBuffer, // optional
  extraFiles: ['/path/FILE.ZIP'] // optional, #72: zipped in, never removed here
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
| `http` | Client | This board as a QWK node of a Canectic hub, over the hub's `/api/v1/qnet` (see "QWK hub over HTTP"). `host` is the hub's web address, `username` our QWK ID there, `password` the one the hub set. Remote paths are ignored. |
| `hub` | Hub | The node reaches us. Over HTTP at `/api/v1/qnet`, or through a shared directory (`qnet-directory.js`). REPs land in `cwd/qnet/<NODE_ID>.node/in/`; the node's QWK is built on request by `buildQwkForNode()`, or ahead of time by the hub sweep for a shared-directory node. |

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

### Files and control messages (#75)

Personal packets carry the new-files list (`NEWFILES.DAT`), the user's batch download queue and private mail attachments, and REP messages to `SBBS` (`FILES`, `ATTACH`, `FREQ`) change those settings or queue a file, as Synchronet's offline-reader packets do. See `QWK_USER_DESIGN.md` sections 1.6 and 2.

### Config keys

- `qwk_enabled` (boolean, default true) — enable/disable user QWK transfers
- `qwk_bbsid` (string) — QWK BBS ID for packet filenames (max 8 chars, falls back to boardname)
- `qwk_max_msgs_per_area` (number, default 500) — per-area message cap in user packets

---
