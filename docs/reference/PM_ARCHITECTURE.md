# Canectic BBS — Private Messaging Architecture Reference

## Overview

The private messaging system provides unified user-to-user messaging across multiple transports (LOCAL, FTN, QWK, EMAIL, MESHTASTIC). A single pair of tables (`pm_inbox` / `pm_outbox`) replaces the previous FTN-specific `netmail_in` / `netmail_out` tables. Transport-specific metadata lives in a JSONB `transport_data` column, keeping the schema generic while preserving full protocol fidelity.

For the shared message platform (echomail areas, read tracking, body_html pipeline), see `message_architecture.md`.
For the networking/tosser stack (FTN, QWK, NNTP), see `NETWORKING_ARCHITECTURE.md`.
For the internet email transport (outbound relay, inbound gateway), see `EMAIL_ARCHITECTURE.md`.
For the web application stack (Express, sessions, admin panel), see `web_architecture.md`.
For the process model, job queues, and inter-process signaling, see `PROCESS_ARCHITECTURE.md`.

---

## Core Files

### Models

| File | Location | Purpose |
|------|----------|---------|
| `privateMessages.js` | `src/models/` | Unified PM model. Transport access control, recipient resolution, inbox/outbox/trash CRUD, delivery pipeline, dupe checking, undeliverable queue, sysop notifications, soft delete with trash purge. On non-LOCAL `queueMessage()` and `queueOutbound()`, triggers outbound toss via BullMQ job queue (FTN → `enqueueFtnOutbound`, QWK → `enqueueQwkPushAll`, EMAIL → `enqueueEmailOutbound`). Dynamic import of queue module — gracefully skips if queue infrastructure is unavailable. |
| `pmAttachments.js` | `src/models/` | PM file attachment model. CRUD for `pm_attachments` table, disk storage management (`{pm_attachment_dir}/{YYYY-MM}/{uuid}/{filename}`), attachment linking by `message_uuid`, ownership verification for downloads. |
| `ftnNetmailAdapter.js` | `src/models/` | FTN↔PM bridge. Converts between FTN Message objects and PM objects. Handles inbound routing (local delivery, relay, automated processors). Parses file-attach flag (0x0010) on inbound netmail and links attached files. |
| `flash.js` | `src/middleware/db/` | Session-scoped flash messages via Redis. Used by PM routes for user feedback on compose/reply/delete/restore actions. Generic — usable by any route. |

### Routes

| File | Location | Purpose |
|------|----------|---------|
| `pm.js` | `src/routes/` | Express router mounted at `/pm`. Webmail UI routes, AJAX JSON endpoints, compose/reply/delete/restore actions, admin undeliverable queue. Flash message middleware. |

### Views

| File | Purpose |
|------|---------|
| `views/pm/inbox.pug` | Main webmail interface. Split-pane layout: folder sidebar, DataTables message list with search/sort, inline reader pane with reply/delete/restore. Compose modals (Local + Network). Reply modal with line-quoting system. |
| `views/pm/undeliverable.pug` | Admin undeliverable message queue with filter tabs. |
| `views/pm/undeliverable_detail.pug` | Admin review detail — deliver to user / discard / return to sender. |
| `views/partials/flash.pug` | Reusable Bootstrap alert partial for flash messages. |

### Tosser Integration

| File | Changes |
|------|---------|
| `ftnTosser.js` _(in `src/middleware/tossers/`)_ | `TossInboundFile` and `OldTossInbound` route netmail through `ftnNetmailAdapter.importFtnNetmail()` instead of `netmail.newInboundNetmail()`. `TossOutboundNetmail` uses `privateMessages.getPendingByTransport('FTN')` with per-message zone-aware source resolution via `systemAddresses.resolveSourceForDestinationZone()`. |
| `qwkTosser.js` _(in `src/middleware/tossers/`)_ | `pullFromQwkPeer` delivers conference 0 messages as PMs via `importQwkPrivateMessage()`. `pushToQwkPeer` gathers pending QWK PMs and packs them as conference 0 with private status byte (`0x2A`). |
| `qwkPacketBuilder.js` | `buildQwkForNode` gathers pending QWK PMs for conference 0 in hub-mode packets. `buildMessagesDat` passes `isPrivate` through to `buildQwkHeader`. |
| `qwkClasses.js` | `buildQwkHeader` accepts `isPrivate` parameter — sets status byte to `0x2A` (private) or `0x20` (public). `buildRepPacket` passes `isPrivate` through. |

### Maintenance

| File | Changes |
|------|---------|
| `maintenance.js` | `--purge-pm-trash` enqueues purge job on BullMQ maintenance queue. `--regen-pm-html` enqueues PM body_html regeneration job. Worker process handles execution. |
| `messageBase.js` | `regeneratePmBodyHtml()` and `regeneratePmTableBodyHtml()` regenerate `body_html` for `pm_inbox` and `pm_outbox` using the same `formatBodyHtml` pipeline as message areas. |

### Updated Models

| File | Changes |
|------|---------|
| `useraccounts.js` | Added `getUserByRealname()`, `getUsersByRealname()`, `getUsersByPermissionFlag()`. Fixed `buildSessionData()` to derive `isSysop` from `permissionflags` array. Fixed `_addFlags`/`_removeFlags` to keep `isSysop` in sync on all active sessions. |
| `systemAddresses.js` | Added `getActiveAddressByNetworkType()`, `getDefaultAddressByNetworkType()`, `resolveSourceForDestinationZone()`. |

### Terminal UI

| File | Location | Purpose |
|------|----------|---------|
| `pmReader.js` | `src/handlers/menucommands/` | Terminal mail reader. Lightbar list with inbox/sent/trash folders, message view with scrolling body viewport, reply/delete/restore/mark-all-read. Spawns `pmEditor` for compose and reply. |
| `pmEditor.js` | `src/handlers/menucommands/` | Terminal mail editor. Full-screen editor with cycleable From name (username/fullname), To field with local user resolution, Via/Addr field with transport cycling, Subject, body editor with word wrap, and quote system. Handles LOCAL and network (FTN/QWK) transports. |
| `pmCheck.js` | `src/handlers/menucommands/` | Unread mail check. Queries unread count, prompts to launch reader. Works as both a menu command (`checkEmail`) and a call flow stage (`check_email` via `SubModuleAdapter`). |
| `menuhandler.js` | `src/handlers/` | Added `email` command (launches `pmReader`) and `checkEmail` command (launches `pmCheck`). |
| `callmanager.js` | `src/servers/` | Added `check_email` to handler registry via `SubModuleAdapter`. Can be placed in any call flow (e.g. after login). |

---

## Database Schema

### pm_inbox

Inbound messages delivered to a local user. One row per recipient per message.

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGSERIAL | Primary key |
| `uuid` | UUID | Public identifier |
| `user_id` | INTEGER | FK to users — the recipient |
| `msg_id` | TEXT | Canonical message ID (MSGID, QWK Message-ID, or generated UUID) |
| `from_user` | TEXT | Sender display name |
| `to_user` | TEXT | Recipient display name |
| `from_address` | TEXT | Sender address (FTN address, QWK-ID, username for LOCAL) |
| `to_address` | TEXT | Recipient address |
| `subject` | TEXT | |
| `body_text` | TEXT | Plain text body |
| `utf8` | TEXT | UTF-8 version of body (null if body_text is already UTF-8) |
| `body_html` | TEXT | Pre-rendered HTML for web display |
| `raw_text` | TEXT | Raw message text including kludge lines |
| `read` | BOOLEAN | DEFAULT false |
| `read_at` | TIMESTAMP | Set on first access |
| `deleted` | BOOLEAN | DEFAULT false — soft delete (move to trash, recoverable) |
| `deleted_at` | TIMESTAMP | Set on soft delete |
| `purged` | BOOLEAN | DEFAULT false — tagged for background hard delete (invisible, not recoverable) |
| `purged_at` | TIMESTAMP | Set when tagged for cleanup |
| `has_attachments` | BOOLEAN | DEFAULT false — set after `pm_attachments` rows are linked |
| `transport_type` | VARCHAR(16) | 'LOCAL', 'FTN', 'QWK', 'EMAIL', 'MESHTASTIC' |
| `transport_data` | JSONB | Transport-specific metadata (see below) |
| `system_time` | TIMESTAMP | Message creation time |
| `created_at` | TIMESTAMP | Row creation time |

### pm_outbox

Outbound messages queued for delivery or already sent. One row per sent message.

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGSERIAL | Primary key |
| `uuid` | UUID | Public identifier |
| `user_id` | INTEGER | FK to users — the sender |
| `msg_id` | TEXT | Canonical message ID |
| `from_user` | TEXT | Sender display name |
| `to_user` | TEXT | Recipient display name |
| `from_address` | TEXT | Sender address |
| `to_address` | TEXT | Recipient address |
| `subject` | TEXT | |
| `body_text` | TEXT | |
| `utf8` | TEXT | |
| `body_html` | TEXT | Pre-rendered HTML |
| `raw_text` | TEXT | |
| `queued` | BOOLEAN | DEFAULT true — waiting for tosser |
| `sent` | BOOLEAN | DEFAULT false |
| `sent_at` | TIMESTAMP | |
| `send_error` | TEXT | Last error message |
| `undeliverable` | BOOLEAN | DEFAULT false — permanently failed |
| `undeliverable_reason` | TEXT | Human-readable failure reason |
| `deleted` | BOOLEAN | DEFAULT false — soft delete (move to trash, recoverable) |
| `deleted_at` | TIMESTAMP | |
| `purged` | BOOLEAN | DEFAULT false — tagged for background hard delete |
| `purged_at` | TIMESTAMP | |
| `has_attachments` | BOOLEAN | DEFAULT false — set after `pm_attachments` rows are linked |
| `transport_type` | VARCHAR(16) | |
| `transport_data` | JSONB | |
| `system_time` | TIMESTAMP | |
| `created_at` | TIMESTAMP | |

### pm_undeliverable

Sysop review queue for messages that could not be delivered automatically.

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGSERIAL | Primary key |
| `uuid` | UUID | Public identifier |
| `from_user` | TEXT | |
| `to_user` | TEXT | |
| `from_address` | TEXT | |
| `to_address` | TEXT | |
| `subject` | TEXT | |
| `body_text` | TEXT | |
| `transport_type` | VARCHAR(16) | |
| `transport_data` | JSONB | |
| `reason` | TEXT | Why delivery failed |
| `reviewed` | BOOLEAN | DEFAULT false |
| `reviewed_at` | TIMESTAMP | |
| `reviewed_by` | INTEGER | FK to users — sysop who reviewed |
| `action_taken` | TEXT | 'delivered', 'deleted', 'returned' |
| `delivered_to` | INTEGER | FK to users — if manually delivered |
| `created_at` | TIMESTAMP | |

### pm_attachments

File attachments linked to private messages. One row per attached file.

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGSERIAL | Primary key |
| `message_uuid` | UUID | FK to pm_inbox/pm_outbox uuid |
| `filename` | TEXT | Original filename |
| `disk_path` | TEXT | Relative path under `pm_attachment_dir` |
| `size` | BIGINT | File size in bytes |
| `mime_type` | TEXT | MIME content type |
| `created_at` | TIMESTAMP | Row creation time |

Both `pm_inbox` and `pm_outbox` include a `has_attachments` boolean column (DEFAULT false) for fast filtering without joining the attachments table.

Attachment files are stored at `{pm_attachment_dir}/{YYYY-MM}/{uuid}/{filename}`, where `pm_attachment_dir` is configured via appConfig (default `data/pm_attachments`). The `YYYY-MM` prefix provides natural archiving and prevents any single directory from growing too large.

---

## transport_data JSONB Structures

### LOCAL

```json
{
  "sender_user_id": 42,
  "recipient_user_id": 17,
  "outbox_uuid": "abc-123-..."
}
```

### FTN

```json
{
  "source": "1:134/123",
  "destination": "1:134/101",
  "source_zone": 1,
  "source_net": 134,
  "source_node": 123,
  "destination_zone": 1,
  "destination_net": 134,
  "destination_node": 101,
  "datetime_string": "18 Mar 26  15:44:33",
  "msg_id": "1:134/123 69bb2045",
  "reply_to": "",
  "tz_utc": "-0600",
  "tosser_id": "Canectic Tosser v0.1",
  "origin_line": "",
  "seen_by": "",
  "path": "",
  "optional_attributes": [{ "attribute": "INTL", "value": "1:134/101 1:134/123" }]
}
```

### QWK

```json
{
  "source": "VERT",
  "peer_connection_uuid": "9f894ef9-...",
  "conference": 0,
  "msg_number": 42,
  "msg_id": "VERT:0:42",
  "reply_to": ""
}
```

---

## Transport Access Control

Access to each transport is governed by a combination of permission flags and restriction flags. Defined in `TRANSPORT_ACCESS_RULES` in `privateMessages.js`:

| Transport | Permission Required | Restriction Flag | Default |
|-----------|-------------------|-----------------|---------|
| LOCAL | (none) | "Private Messages" | Allow all users |
| FTN | "Netmail" | "Netmail" | Require permission |
| QWK | "Netmail" | "Netmail" | Require permission |
| MESHTASTIC | "Netmail" | "Netmail" | Require permission |
| EMAIL | "Email" | "Email" | Require permission |

The `Unverified` restriction flag blocks all non-LOCAL transports. Users who have not verified their email address carry this flag, preventing them from sending network messages until verification is complete. Verification removes the flag (see `mailVerification` model and the `verify_mail` call flow stage).

Rules:
- Sysop bypasses permission requirements (but not restrictions)
- Restriction flags always win — even Sysop is blocked if restricted
- `checkTransportAccess(userSession, transportType)` → `{ allowed, reason }`
- `getAllowedTransports(userSession)` → array of permitted transport type strings

Admin flags configured in `admin.js`:
- `availablePermissions`: `["Sysop", "Mod", "Adult", "Admin", "Email", "Netmail"]`
- `availableRestrictions`: `["Underage", "Banned", "Email", "Netmail", "Private Messages"]`

---

## Data Flow

### LOCAL Messages (user-to-user on same system)

```
Web compose form → POST /pm/compose/local
  → validateFromUser() — verifies sender identity isn't tampered
  → resolveRecipient() — username match → realname match → sysop alias
  → queueMessage(messageObj, userSession)
    → checkTransportAccess (if session provided)
    → sanitizeMessageFields()
    → formatBodyHtml() with simpleTextToHtml fallback
    → INSERT pm_outbox (sent=true, queued=false, sent_at=NOW)
    → deliverMessage() — dual-write to pm_inbox
      → dupe check (msg_id + transport_type + user_id + subject + body_length)
      → INSERT pm_inbox (read=false)
  → flash success message → redirect
```

### Network Messages (FTN, QWK — user compose from web or terminal)

```
Web compose form → POST /pm/compose/network   (or terminal pmEditor save)
  → queueMessage(messageObj, userSession)
    → checkTransportAccess (if session provided)
    → sanitizeMessageFields()
    → formatBodyHtml() with simpleTextToHtml fallback
    → INSERT pm_outbox (sent=false, queued=true)
    → _triggerOutboundToss(transport_type)
        FTN → enqueues ftn:outbound on toss queue
        QWK → enqueues qwk:push-all on toss queue
        EMAIL → enqueues email:outbound on toss queue
  → flash success message → redirect
```

The outbound toss trigger fires from the model layer, so both web routes and terminal `pmEditor` get immediate dispatch without duplicating logic. The trigger uses dynamic import of `jobs.js` and silently skips if queue infrastructure is unavailable.

For EMAIL-specific flow details (relay, inbound gateway, failure handling), see `EMAIL_ARCHITECTURE.md`.

### FTN Inbound

```
Remote system sends .pkt → ftnTosser.TossInboundFile()
  → ReadPkt() parses packet → message.Type === "Netmail"
  → ftnNetmailAdapter.importFtnNetmail(ftnMessage)
    → isLocalAddress() — checks systemAddresses for our FTN addresses
    → LOCAL: netmailRoutes.matchRoute() → alias / dump / ignore
    → LOCAL: isAutomatedProcessor() → areafix / filefix / ping
    → LOCAL: resolveRecipient() → deliverMessage() to pm_inbox
    → RELAY (if allow_netmail_relay=true):
        ftnVia.hasPassedThrough() → refuse loops
        ftnVia.appendVia() → stamp our hop
        ftnRouter.resolveRoute() → queueOutbound()
    → RELAY (if relay disabled): write to ftn/bad/ → notifySysops()
    → UNRESOLVABLE: insertUndeliverable() → notifySysops()
```

### FTN Outbound

```
Triggered by: scheduled toss cycle, CLI (node src/tools/tosser.js --out --ftn),
              or queueMessage() model trigger after network PM compose
  → worker picks up ftn:outbound job → TossOutboundNetmail()
  → privateMessages.getPendingByTransport('FTN')
  → ftnNetmailAdapter.privateMessageToFtn(pmRow)
    → sets Attribute = 0x0001 (Private flag)
    → generates FTN datetime string from system_time
  → per-message: systemAddresses.resolveSourceForDestinationZone(destZone)
    → zone match failure → markOutboxUndeliverable() → bounce notification
  → WritePkts() → .pkt files in outbound directory
  → markSentArray() on success
```

### QWK Inbound

```
pullFromQwkPeer() → parseMessagesDAT() → applyHeadersDat()
  → for each message:
    → conferenceNum === 0 → importQwkPrivateMessage()
      → resolveRecipient(to)
      → resolved: deliverMessage() to pm_inbox (transport_type='QWK')
      → unresolved: insertUndeliverable() + notifySysops()
    → conferenceNum > 0 → importQwkMessage() (existing echomail path)
```

### QWK Outbound (Client Mode — pushToQwkPeer)

```
pushToQwkPeer() → gather echomail work items per subscription
  → privateMessages.getPendingByTransport('QWK')
  → add PM work items as conference 0, isPrivate=true, utf8=null
  → buildRepPacket() → buildQwkHeader with status 0x2A
    → utf8ToCp437 conversion → buildQwkBody with 0xE3 line terminators
  → upload .REP → markSent() for each PM on success
```

### QWK Outbound (Hub Mode — buildQwkForNode)

```
buildQwkForNode() → gather echomail from subscriptions
  → privateMessages.getPendingByTransport('QWK')
  → add PM items as conference 0, isPrivate=true
  → conferences.unshift({ number: 0, name: 'Personal' })
  → buildMessagesDat() → buildQwkHeader with isPrivate
  → assembleQwkPacket() → .qwk file
  → markSent() for each PM
```

---

## Netmail Relay

`netmail_relay_mode`, three values:

| Mode | Behaviour |
| --- | --- |
| `nodelist` | **Default.** Relay only when both the sender and the recipient are listed in the same network's nodelist |
| `off` | Refuse all transit mail |
| `on` | Relay anything the router can find a way to, including between two networks this system carries |

### Why nodelist is the default

`on` is far more open than it reads. `ftnRouter.resolveRoute` finds a way to
anything dialable in the nodelist (step 3) and walks up to a hub, host, RC or ZC
for anything else (step 4), so `on` means transit for the whole of every network
this system carries, in any direction, **including between two of them**. A node
on one othernet could reach any node on another through this system, which is the
shape of an open relay even when every individual link is trusted.

Nodelists here are scoped per `network_id`, so requiring both ends to be listed
in the *same* one is the whole fix:

- cross-network relay is refused, because the two ends resolve to different networks
- invented addresses are refused, because they are not listed anywhere
- a zone this system holds no address in is refused, because we do not carry that network
- ordinary routed netmail is untouched, including across the zones of one network

That last point is why the rule is network-scoped rather than net-scoped. A
coordinator routes outbound mail for their nodes, or has the echo hub do it, so
anything restricted to the sysop's own net breaks immediately. FidoNet also spans
zones 1 to 6, so a zone-scoped rule would refuse normal traffic.

Points are stripped before the lookup. Points are not listed in a nodelist and
never will be, and a point's mail is its boss node's responsibility, so
`1:229/426.1` is checked as `1:229/426`.

### What it deliberately does not do

It does not verify that the sender is who the message says. FTN cannot: the
origin address is whatever the packet claims, and there is no signature to check
it against. Chasing that with per-link trust rules buys very little, since the
practical exposure is one of your own authenticated links injecting forged mail.
Real sender authentication needs a network whose nodelist can carry public keys,
which is a thing to build rather than a thing to configure.

There is also no rate limiting and no per-peer policy. Issue #41 holds the
discussion.

### Operational notes

**No nodelist for a network means no relay for that network.** Every transit
message for it is refused with "not in the nodelist". That is the right failure
direction but it is confusing if you do not expect it, so check
`/admin/nodelists` before concluding relay is broken.

**Refusals are noisy by design.** Each one writes the raw message to `ftn/bad`
and notifies sysops, with a reason naming the rule that refused it and the
address it could not find.

**Upgrade behaviour.** `allow_netmail_relay` is deprecated and ignored, and every
install lands on `nodelist` regardless of what that key said. It cannot be
honoured: `configStore` seeds every default into the settings table, so a sysop
who deliberately set it `false` is indistinguishable from one who never touched
it. Since relay never worked correctly before this release anyway (the message
and packet headers were swapped on every transit message, below), there is no
working configuration to preserve. A system that wants full relay back sets
`netmail_relay_mode=on` deliberately.

### Two "from" addresses, not one

A netmail carries two source addresses answering different questions:

| | Says | On relay |
| --- | --- | --- |
| Message header (`msg.SourceNet` / `SourceNode`) | who wrote the message | the original author |
| Packet header (`packet.SourceNet` / `SourceNode`) | who is handing this packet over | us |

For mail we originated they are the same address, which is why getting them
backwards went unnoticed: relay is off by default and locally written mail
exercises neither path.

They *were* backwards. `TossOutboundNetmail` stamped our address over the
message header unconditionally, ignoring `transport_data.relayed`, while
`WritePkts` derived the packet header from the INTL kludge, which on transit
mail names the original endpoints. So a relayed netmail went out claiming to be
*written* by us and *sent* by the originator: wrong in both directions, with
replies going back to the wrong system.

`ftnNetmailAdapter.resolveOutboundSource(msg, srcAddr, transportData)` now
answers both questions in one place and is unit tested.
`TossOutboundNetmail` applies it and sets `msg.PacketSource`, which `WritePkts`
groups packets by. The INTL override in `WritePkts` is gone: INTL describes the
message's endpoints, never the packet's.

### Via chain

Every system that passes a netmail on appends one Via line, so the message
carries its own route:

```
Via <address> <yyyymmdd>.<hhmmss>.UTC <product> <version>
```

`src/utils/ftnVia.js` owns this: `buildViaLine`, `parseViaLine`, `viaChain`,
`hasPassedThrough`, `appendVia`. Implementations disagree about the `@` before
the timestamp, so it is accepted on read and omitted on write, and the raw line
is kept so another system's hop survives a relay verbatim rather than being
normalised.

Two things depend on the chain:

- **Loop refusal.** `relayNetmail` checks `hasPassedThrough()` against every
  active FTN address this system holds before queueing anything. Two systems
  routing to each other would otherwise pass the same message back and forth
  indefinitely. Matching is on the bare address and case insensitive, because a
  system may write itself into the chain with a domain one hop and without it
  the next, and a loop check that misses is worse than none: it reads as
  protection. A refused message reports `relayLoop` and goes to the
  undeliverable queue rather than being counted as relayed.
- **Ping replies**, below.

The inbound parser in `ftnTosser` used to keep only two tokens of each Via line,
dropping the timestamp or the software depending on whether the writer used the
optional `@`. A truncated chain still relays and still looks like a path, so
nothing complained. It now calls `ftnVia.viaValueFromKludge()` rather than
carrying its own copy: the first pass at this fix left two implementations, and
reverting the tosser's copy broke no test because the tested one was somewhere
else entirely.

## Netmail Ping

Netmail addressed to `Ping` at one of our addresses gets a `Pong` back showing
the route it took. A convention rather than a numbered standard, but Husky's
pinger, Mystic and Synchronet all answer it, so other sysops expect it to work.
Before this, a ping fell through to recipient resolution, failed, and landed in
the undeliverable queue with a sysop notification.

`src/models/netmailPing.js` is shaped like `areafix.js` and `filefix.js`
(`handleRequest` + `buildResponse`) so the Step 2 dispatch needed no special
case beyond one branch. `ping` is in `AUTOMATED_PROCESSORS`. Config:
`netmail_ping_enabled` (default true).

The reply is plain text inside 80 columns, since it is read by a person in a
terminal on the far side of whatever link they are debugging. It names the
sender, when the message was written and received, and every hop in the Via
chain with its timestamp and software. It comes *from the address the ping was
aimed at*, not our default AKA, so a node pinging one of several addresses can
tell which answered. It deliberately carries no Via lines of its own: the reply
is a new message taking its own route, and copying the request's chain would
make our own loop check refuse it.

`TRACE`, the related convention where every transit node reports back
separately, is not implemented.

## Recipient Resolution

`resolveRecipient(toUser)` cascade:

1. **Username match** — `userAccounts.getUserRecord(toUser)`. Exact username lookup (case-insensitive).
2. **Realname match** — `userAccounts.getUsersByRealname(toUser)`. If exactly one match, resolved. If multiple matches, returns `{ resolved: false, reason: 'ambiguous_match' }`.
3. **Sysop alias** — if `toUser` is "Sysop" (case-insensitive), resolves to the first user with the "Sysop" permission flag via `getUsersByPermissionFlag('Sysop')`.

Returns `{ resolved, userId, username, reason }`.

---

## Dupe Checking

`deliverMessage()` checks for duplicates before inserting into `pm_inbox` — but only when the caller supplied a `msg_id`:

```sql
SELECT id FROM pm_inbox
WHERE msg_id = $1 AND transport_type = $2 AND user_id = $3
  AND subject = $4 AND LENGTH(COALESCE(body_text, '')) = $5
```

Subject and body length are included because some FTN implementations (notably SBBSecho areafix) reuse the same MSGID across multiple distinct response messages (split replies, related responses). The five-field check prevents false dupe rejection while still catching true duplicates.

### msg_id fallback convention

`deliverMessage()` generates a UUID fallback (`uuidv4()`) for `msg_id` when the caller doesn't supply one. Callers that provide `msg_id` (FTN/QWK/NNTP/EMAIL import paths) still go through dupe checking against their supplied id; callers that don't (system notification paths like `notifySysops`, template-event delivery, bounce stubs) get a unique synthetic UUID per row, skip dupe checking (still gated by `if (messageObj.msg_id)`), and end up with a non-null `msg_id` column.

Non-null `msg_id` matters for IMAP clients that filter or hide messages lacking a meaningful `Message-ID` header (synthetic or otherwise). The fallback matches what `queueMessage()` has always done for user-to-user PMs, so every `pm_inbox` row carries a non-null `msg_id` regardless of delivery path.

---

## body_html Pipeline

Both `deliverMessage()` and `queueMessage()` generate `body_html` from the display text:

1. Try `formatBodyHtml(displayText)` — the full pipeline (paragraph reflow → ANSI art detection → VirtualTerminal or plain text conversion)
2. Validate the result is a non-empty string
3. If `formatBodyHtml` returns empty or throws → fall back to `simpleTextToHtml(displayText)` which escapes HTML entities and converts line breaks to `<br>`

View-layer fallback chain: `body_html` (unescaped) → `body_text` in a `<pre>` (auto-escaped by Pug) → "(empty message)".

---

## Outbox Undeliverable Handling

When a message cannot be delivered (destination zone not found, address unparseable, recipient resolution failure):

1. `markOutboxUndeliverable(id, reason)` — sets `undeliverable=true`, clears `queued`, stores reason
2. `notifySenderUndeliverable(outboxRow, reason)` — delivers a bounce notification to the sender's inbox as a LOCAL/SYSTEM transport message
3. For FTN: `getPendingByTransport('FTN')` excludes `undeliverable=true` and `deleted=true` rows, so the tosser stops retrying

For QWK inbound: unresolvable recipients go to `pm_undeliverable` for sysop review rather than bouncing (since the sender is on a remote system).

---

## Soft Delete, Trash, and Two-Stage Hard Delete

Messages have a three-stage lifecycle so user actions stay non-blocking even when bulk-purging hundreds of rows with attachments:

| State | Visible? | Recoverable? | Files on disk? |
|---|---|---|---|
| `deleted=false`, `purged=false` | Yes — inbox/sent listings | n/a (live) | Yes |
| `deleted=true`, `purged=false` | Yes — trash listing only | Yes (Restore button) | Yes |
| `purged=true` | No — filtered from every read path | No | Until next cleanup tick |

### Stage 1 — soft delete (move to trash)

- `deleteMessage(userId, uuid)` / `deleteSentMessage(userId, uuid)` — sets `deleted=true`, `deleted_at=NOW()`. Attachments untouched.
- `restoreMessage(userId, uuid)` / `restoreSentMessage(userId, uuid)` — clears `deleted` / `deleted_at`. Defensive `AND purged IS NOT TRUE` clause refuses to resurrect a row that's already been tagged for cleanup.
- `getTrash(userId)` — UNIONs both tables with a `source` column ('inbox'/'sent'), filtering `deleted=true AND purged IS NOT TRUE`.

### Stage 2 — purge tagging (instant, non-blocking)

- `purgeMessage(userId, uuid)` — single-row UPDATE that flips `purged=true, purged_at=NOW()` for a row that's owned by the user, in trash, and not already tagged. Returns `{ tagged, table }`. Cheap; doesn't touch disk or `pm_attachments`.

Trigger sites:
- Web: `POST /pm/trash/:uuid/delete` (the Delete button shown in trash mode in `/pm/inbox`)
- IMAP: `_markDeleted` in the trash branch (covers STORE `\Deleted` + EXPUNGE, CLOSE, MOVE-out of Trash, UID EXPUNGE, and Thunderbird's "Empty Trash" which fires store-on-all-then-expunge)
- Daily retention sweep: `purgeDeleted(retentionDays)` (rebadged) tags rows whose `deleted_at < NOW() - pm_trash_retention_days`. No longer touches disk or DELETEs rows itself — purely a tagger now.

After tagging, the trigger site optionally enqueues a `pm-purged-cleanup` BullMQ job for sub-minute reclaim. The IMAP server coalesces multiple tags from a single command into one enqueue via `_purgedDuringSession` + `_fireOnDemandPurgeCleanup()`.

### Stage 3 — background cleanup

- `executePurgedCleanup({ batchSize: 500 })` — BullMQ worker entrypoint. SELECTs tagged rows from both tables, dynamic-imports `pmAttachments.js` (with a level-1 log on import failure rather than the silent catch the old `purgeDeleted` had), calls `pmAttachments.deleteAttachments(uuid)` per row, then DELETEs only the rows whose attachment cleanup succeeded. Per-row failures retry next cycle instead of becoming permanent orphans. Returns `{ inboxDeleted, outboxDeleted, pendingMore }` so the worker can drain the queue in a `do { ... } while (pendingMore)` loop.
- `pmAttachments.deleteAttachments(uuid)` is refCount-safe: a LOCAL message creates `pm_attachments` rows for both sender (outbox) and recipient (inbox) pointing at the same `storage_path`. The cleanup function only unlinks the disk file when no other row still references it, so the file stays alive until both ends are tagged.

Job wiring:

| Job name | Trigger | Cadence | Purpose |
|---|---|---|---|
| `purge-pm-trash` | Scheduler `purge-pm-trash-daily` | Daily 03:00 | Tag-only retention sweep — flips `purged=true` on rows older than `pm_trash_retention_days` |
| `pm-purged-cleanup` | Scheduler `pm-purged-cleanup-hourly` + on-demand from web/IMAP purge actions | Hourly :15 + on-demand | The actual disk unlink + row DELETE work for tagged rows |

Default retention: `pm_trash_retention_days` config (30 days). CLI: `node src/tools/maintenance.js --purge-pm-trash [--days N]` (the CLI still enqueues the daily sweep which now does tag-only work).

### Read-path filters

Every query that returns user-visible PMs filters `purged IS NOT TRUE`. Sites covered:

- `privateMessages.js`: `getInbox`, `getTrash` (both UNION halves), `getSentMessages`, `getMessage`, `getSentMessage`, `getUnreadCount`
- `imapAdapter.js`: `getMailboxMessages` (INBOX/Sent/Trash branches), `getFullMessage`, `getMailboxStatus` (5 COUNT queries)
- `qwkUser.js`: unread-PMs SELECT for QWK packet generation
- `routes/pm.js`: `/pm/attachment/:id` ownership check (refuses to serve attachment files for purged messages)

Two sites are intentionally not filtered:

- `deliverMessage` dupe-check — a message that comes back after being purged should be re-delivered fresh
- `getPendingByTransport` (tosser) — already gated by `deleted=false`, which excludes purge-tagged rows by design (purge only happens on already-deleted rows)

---

## Sysop Notifications

`notifySysops(subject, bodyText)` delivers a LOCAL/SYSTEM message to ALL users with the "Sysop" permission flag (co-sysop support). Uses `userAccounts.getUsersByPermissionFlag('Sysop')`. Called for:

- Undeliverable inbound FTN netmail
- Undeliverable inbound QWK PMs
- Relay denials (when `allow_netmail_relay=false`)

---

## Web UI Architecture

### Layout

Webmail-style split-pane layout filling `calc(100vh - 56px)`:

```
┌──────────┬──────────────────────────────────────────┐
│ Inbox  4 │ [DataTables search box]                   │
│ Sent     │ ● John Smith    Re: Config    Mar 18 15:30│
│ Trash    │   Bob Jones     Hello there   Mar 17 09:00│  ← 40%, scrolls
│──────────│─────────────────────────────────────────── │
│ ✉ Local  │ Re: Network Config           [Reply] [Del]│
│ 🌐Network│ From: John Smith  To: Underminer          │
│──────────│ Date: Mar 18, 2026 15:30      QWK         │  ← 60%, scrolls
│ ☑ Mark   │                                           │
│   All    │ Message body here...                      │
│   Read   │                                           │
└──────────┴──────────────────────────────────────────┘
```

- **Sidebar** (180px fixed): folder buttons (Inbox/Sent/Trash), compose buttons, mark all read. Collapses to horizontal strip on mobile.
- **Message list** (40%): DataTables with `paging: false`, `scrollY`, search box, column sorting. Three tables (inbox/sent/trash) toggled by folder buttons.
- **Reader pane** (60%): inline message display with header (subject, from, to, date, transport badge) and action buttons (Reply, Delete, or Restore for trash). Empty state overlay when no message selected.

### AJAX Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/pm/inbox/:uuid/json` | Load inbox message as JSON, marks read |
| GET | `/pm/sent/:uuid/json` | Load sent message as JSON |

Both return `{ uuid, from_user, to_user, from_address, to_address, subject, body_html, body_text, transport_type, system_time, canReply }`.

### Compose Modals

Both modals include a "From" select box with the user's username (default) and real name as options. Server-side `validateFromUser(sessionUser, submittedName)` checks the submitted value matches either field — tampered values are rejected with a flash error.

### Reply Modal with Quote System

Same line-quoting mechanism as the message area views:
1. `getPlainText(el)` extracts text from the reader body HTML
2. `wrapTextLines(text, 80)` word-wraps at 80 columns
3. `populateQuotePanel()` renders numbered clickable lines
4. Clicking a line inserts `"  > {text}"` at the cursor position in the textarea
5. Toggle button flips between "Quote Original" and "Finished Quoting"

### Flash Messages

`flash.js` stores messages in Redis under `flash:{sessionId}` with 30-second TTL. One-shot — cleared after first read. PM router middleware loads them into `res.locals.flash` on every request. The `flash.pug` partial renders Bootstrap dismissible alerts with type-specific icons (danger/warning/success/info).

---

## Navigation

### User Nav (`user-nav.pug`)

Mail link on the right side: envelope icon + "Mail" text + unread badge. Links to `/pm/inbox`. Admin Dashboard link (gear icon) shown only when `currentuser.isSysop` is true.

### Admin Nav (`admin-nav.pug`)

Same Mail link with unread badge on the right side. Brand links to `/`. Dashboard is a top-level nav item.

`pmUnreadCount` is fetched via `privateMessages.getUnreadCount(userId)` in the shared middleware of `pm.js`, `index.js`, and `admin.js` routes.

---

## Terminal UI Architecture

Three `BaseSubModule` modules provide full terminal-side PM access: a reader, an editor, and a mail-check prompt. All follow the same patterns as the echomail `msgReader`/`msgEditor`: state machine, viewport geometry, CP437/UTF-8 glyph helpers, dumb terminal fallback, and sub-module spawning via `emitter.on("ModuleReturn")`.

### PM Reader (`pmReader.js`)

#### State Machine

```
LOADING → MESSAGE_LIST ↔ MESSAGE_VIEW
```

#### Message List

- **Three folders**: Inbox (I), Sent (S), Trash (T) — switchable via hotkeys without reload
- **Chronological order**: Messages sorted oldest-first (model returns DESC, reversed on load)
- **Cursor positioning**: On load, lightbar starts at first unread message; if all read, starts at last (newest) message
- **Lightbar columns**: Adapt per folder:
  - Inbox: `[unread] From | Subject | Date | Type`
  - Sent: `[unread] To | Subject | Date | Status` (Sent/Queue/Draft)
  - Trash: `Type(In/Sent) | From/To | Subject | Deleted`
- **Date column** (9 chars): Today → `15:45    ` (24h time), Yesterday → `Yesterday`, Older → `Mar 18'25`
- **Unread indicators**: Bullet glyph (`•`/CP437 `0xF9`) + bright green color, unread count in title bar
- **Actions**: Enter (read), C (compose), D (delete), U (restore, trash), M (mark all read, inbox), Q (quit)

#### Message View

- **4-row header**: From, To, Subject, Via on left; Date, Time, Folder, Msg# on right
- **Network addresses**: From/To fields append `" @ address"` for non-LOCAL messages (e.g. `"John Smith @ 1:134/101"`)
- **From/To highlight**: Username match → bright yellow, others → bright green
- **Body viewport**: Rows 6 to H-2, centered/capped at 100 cols. Uses `termMsgFormat.processMessageBody` when available, with fallback word-wrap
- **Scroll indicators**: Separator lines on rows 5 and H-1 with down-arrow glyph when more content exists
- **Navigation**: ↑↓ scroll, ←→ prev/next message, Space (page down then advance), L (jump to last), R (reply, inbox), D (delete), U (restore, trash), Q (back to list)
- **Read state sync**: Opening a message marks it read in the DB (`getMessage` auto-marks); the read flag is synced back to the in-memory list entry so returning to the list shows the updated state

#### Compose/Reply

- Compose (C): Spawns `pmEditor` with `mode: "new"` and `allowedTransports` from `getAllowedTransports()`
- Reply (R): Spawns `pmEditor` with `mode: "reply"`, original message passed as `replyToMsg`, transport locked to original's `transport_type`. Checks `checkTransportAccess()` before launch.

### PM Editor (`pmEditor.js`)

#### State Machine

```
FIELD_FROM → FIELD_TO → FIELD_ADDRESS → FIELD_SUBJECT → BODY → CONFIRM_SAVE
                                                          ↓         ↑
                                                       QUOTING   (Y → _doSave)
                                                                 (else → BODY)
```

#### Screen Layout (5-row header)

```
Row 1:  From : Underminer          ←→ change
Row 2:    To : [editable]
Row 3:   Via : LOCAL                ←→ change    (or)  Addr : [editable]       (FTN)
Row 4: Subject : [editable]
Row 5: ─────────────────────── separator ───────────────────────
Row 6+: body editing viewport (max 79 cols, auto-wrap)
Row H-1: status bar (line/col/mode or error message)
Row H:  nav bar (Ctrl-S Send  Ctrl-A Abort  Ctrl-Q Quote  Ctrl-Z Save+Send)
```

#### From Name Cycling

Left/right arrows on the From field cycle between username and fullname (if different). No text editing — cycle only. Chosen name is used as `from_user` in the message.

#### Transport Cycling (Compose Mode)

On the Via/Addr row, left/right arrows cycle through the user's allowed transports (passed as `allowedTransports` from the reader). Switching to LOCAL clears the address field. Switching to a network transport enables the address field for editing. Transport is locked for replies.

#### To Name Normalization

On save, the To field value is title-cased: first letter of each word uppercased, rest lowercased. `"JOHN SMITH"` → `"John Smith"`. The original typed text is preserved as `to_user` for display; `to_address` gets the resolved username for routing.

#### Save Flow — LOCAL vs Network

- **LOCAL**: `resolveRecipient()` matches by username, realname, or sysop alias. Sets `transport_data.recipient_user_id` for delivery. If resolution fails, shows error on status bar and repositions cursor to the To field.
- **Network (FTN/QWK)**: Skips `resolveRecipient`. Uses To field as recipient name, Addr field as destination address. For FTN, parses address into zone:net/node components. Validates FTN address format.
- **Error visibility**: `_showError()` writes to the status bar and is NOT followed by `_drawStatusBar()`, so the error message persists until the next keypress triggers a natural redraw.
- **Async save guard**: `_saving` flag blocks all input while `resolveRecipient` and `queueMessage` are awaiting, preventing keystroke interference.

#### Quote System (Reply Mode)

Matches `msgEditor` pattern:
- `Ctrl+Q` enters quote mode — quote lines from original message displayed in the body viewport
- Lightbar navigation with `*` marker for selected lines
- Enter toggles selection + auto-advances, A selects all, N clears all
- `Ctrl+Q` or ESC inserts all selected lines (prefixed with `"> "`) at cursor position and returns to body editing
- Blank line appended after quote block

#### Ctrl Key Handling

Ctrl combos arrive as both `"^Z"`/`"^A"` tokens via `onKey()` and raw bytes (`\x1a`/`\x01`/`\x11`) via `onChar()`. Both paths are handled. Works in all field states and body state.

#### Dumb Terminal Fallback

Sequential prompts: From (shown), To (editable), Subject (editable), body lines. `/s` to send, `/a` to abort.

### PM Check (`pmCheck.js`)

Simple unread-mail prompt, usable as both a menu command and a call flow stage:

- Queries `getUnreadCount()` for the logged-in user
- **No unread**: `"No new private messages. [Press any key]"` → any key → `signalReturn()`
- **Has unread**: `"You have N new private message(s). Read now? (Y/N)"` → Y spawns `pmReader`, else → `signalReturn()`
- Works through `SubModuleAdapter` in callmanager as stage `"check_email"`, or via menu command `"checkEmail"`

### MenuHandler Integration

| Command | Action |
|---------|--------|
| `email` | `_runSubModule(new pmReader(this.call))` |
| `checkEmail` | `_runSubModule(new pmCheck(this.call))` |

### CallManager Integration

```javascript
// Handler registry
"check_email": (call) => new SubModuleAdapter(call, pmCheck, "PmCheck"),

// Example call flow
"Standard": ["negotiate", "logon", "last_callers", "check_email", "menu", "goodbye"]
```

---

## FTN-Specific Details

### Zone-Aware Source Resolution

FTN outbound uses `systemAddresses.resolveSourceForDestinationZone(destinationZone)` per-message:

1. Gets all FTN networks via `msgNetworks.getNetworksByType('FTN')`
2. For each network, checks zone list via `msgZones.getCachedZonesByNetwork()` (Redis-cached)
3. Returns `{ address, networkId }` on match or `{ address: null, reason }` on failure

Failure reasons become bounce messages to the sender.

### FTN Message Conversion

`privateMessageToFtn(pmRow)`:
- Sets `msg.Attribute = 0x0001` (Private flag — required for FTN netmail)
- Generates FTN datetime string (`"DD Mon YY  HH:MM:SS"`) from `system_time` or falls back to `transport_data.datetime_string` for relayed messages
- Restores all FTN kludge fields from `transport_data` JSONB

`ftnToPrivateMessage(ftnMessage)`:
- Packs all FTN metadata (zones, nets, nodes, kludges, seen-by, path, origin) into `transport_data` JSONB
- Sets `transport_type = 'FTN'`

### Packet Filename Generation

`generatePktFilename(outDir)`: 8-character hex filename (8.3 safe for legacy mailers):
- 4 hex chars from lower 16 bits of epoch seconds (time-ordered, ~18hr cycle)
- 4 hex chars from monotonic counter (65,536 per cycle before wrap)
- Filesystem collision check with random jitter fallback (up to 16 attempts)

---

## QWK-Specific Details

### Conference 0

QWK uses conference 0 for personal/private messages. The status byte in the QWK message header distinguishes:
- `0x20` (space) — public message
- `0x2A` (`*`) — private/personal message

### Inbound

`importQwkPrivateMessage(qwkMsg, remoteQwkId, peerConnectionUUID)`:
- Resolves `to` field against local users
- Delivers to `pm_inbox` with `transport_type: 'QWK'`
- MSGID from kludges or generated as `{remoteQwkId}:0:{msgNumber}`
- Unresolvable recipients go to `pm_undeliverable` with sysop notification

### Outbound

PM work items set `utf8: null` so that `buildRepPacket` / `buildMessagesDat` run `utf8ToCp437()` conversion on the body text. The `body_text` field receives the UTF-8 content (`pm.utf8 || pm.body_text`). This ensures proper CP437 encoding with `0xE3` line terminators.

---

## Maintenance

### Trash Purge (retention sweep)

```bash
# Default retention (env pm_trash_retention_days or 30 days)
node src/tools/maintenance.js --purge-pm-trash

# Override retention period
node src/tools/maintenance.js --purge-pm-trash --days 7
```

Tags rows in both `pm_inbox` and `pm_outbox` where `deleted = true AND deleted_at < NOW() - N days` for background hard delete (sets `purged=true, purged_at=NOW()`). The actual disk + DB cleanup is done by the separate `pm-purged-cleanup` job — the retention sweep itself is now tag-only and cheap.

Forcing cleanup immediately is rarely useful (the hourly schedule and on-demand enqueues from web/IMAP purges keep things current), but the cleanup job can be triggered from the admin Events page if needed.

### body_html Regeneration

```bash
# Regenerate for both PM tables
node src/tools/maintenance.js --regen-pm-html

# Dry run
node src/tools/maintenance.js --regen-pm-html --dry-run

# Force column width
node src/tools/maintenance.js --regen-pm-html --width 80
```

Uses keyset pagination (batch by `id > lastId`). Same `formatBodyHtml` pipeline as message area regeneration. PM tables don't have `updated_at` so only `body_html` is touched.

### Combined Tasks

All maintenance tasks can be combined in a single run:

```bash
node src/tools/maintenance.js --regen-html --regen-pm-html --purge-pm-trash
```

Enqueues each task as a separate job on the BullMQ maintenance queue. The worker processes them sequentially (maintenance queue concurrency is 1).

### Queue-Based Scheduling

PM trash purge runs automatically via a BullMQ repeatable job (daily at 3:00 AM). body_html regeneration and trash purge can also be triggered from the admin panel via the `maintenance` queue. The CLI tools remain available for manual runs and cron compatibility. See `PROCESS_ARCHITECTURE.md` for queue job definitions and scheduling.

---

## Attachments

Private messages support file attachments across all transport types. Attachments are stored on disk and tracked in the `pm_attachments` table, linked to messages by `message_uuid`. The `has_attachments` boolean on `pm_inbox`/`pm_outbox` enables fast filtering without joining.

### Configuration

| Key | Default | Category | Description |
|-----|---------|----------|-------------|
| `pm_attachment_dir` | `data/pm_attachments` | pm | Base directory for attachment storage |
| `pm_max_attachment_size` | `10485760` (10MB) | pm | Maximum size per attachment in bytes |
| `pm_max_attachments` | `5` | pm | Maximum attachments per message |

### Storage Layout

```
{pm_attachment_dir}/
  2026-04/
    {message-uuid}/
      document.pdf
      image.jpg
  2026-03/
    {message-uuid}/
      report.txt
```

The `YYYY-MM` prefix provides natural archiving and prevents any single directory from growing too large.

### Transport Coverage

**LOCAL**: Attachment files are stored once on disk. Both the inbox and outbox rows reference the same files via `message_uuid`, so LOCAL messages share a single copy.

**EMAIL inbound**: The SMTP inbound handler (`smtpServer.js`) extracts MIME attachments from multipart messages. Recursive nested multipart structures are traversed. Base64 and quoted-printable content-transfer-encodings are decoded. Extracted files are saved to disk and linked to the delivered PM.

**EMAIL outbound**: Attachments are passed through to nodemailer as attachment objects in `emailTosser.js`. The relay handles MIME encoding for delivery.

**FTN inbound**: The FTN tosser parses the file-attach flag (attribute word bit 0x0010) from type-2 packet netmail headers. When set, files delivered during the binkp session are linked to the netmail PM from the `ftn/in` directory.

**FTN outbound**: When a PM with attachments is tossed outbound, the file-attach flag (0x0010) is set on the FTN message attribute word. Attachment file paths are written as entries in the BSO `.flo` flow file for binkp delivery alongside the `.pkt`.

**Web**: The compose and reply forms use multer for multipart file upload. Uploaded files are validated against `pm_max_attachment_size` and `pm_max_attachments` limits. The download route (`GET /pm/attachment/:id`) verifies ownership (sender or recipient) before serving the file.

**IMAP**: The IMAP adapter renders messages with attachments as `multipart/mixed` in the BODYSTRUCTURE response. Full RFC 2822 message rendering includes base64-encoded attachment MIME parts, so mail clients can download attachments natively.

**Terminal**: The PM reader displays an indicator line when a message has attachments: `"[Attachments available -- use web or IMAP to download]"`. Terminal users cannot download attachments directly due to the interactive transfer protocol constraints.

---

## Key Design Decisions

1. **Unified schema over per-transport tables**: `pm_inbox` / `pm_outbox` handle all transports. Protocol-specific data lives in `transport_data` JSONB. Adding a new transport requires no schema changes — just a new adapter and transport_data structure.

2. **Dual-write for LOCAL**: `queueMessage` with `transport_type='LOCAL'` inserts into both `pm_outbox` (marked sent immediately) and `pm_inbox` (via `deliverMessage`). This gives the sender a sent copy and the recipient an inbox copy in a single operation.

3. **Restriction flags always win**: Even Sysop is blocked by restriction flags. This ensures administrative restrictions (e.g., "Banned" user can't send mail) are absolute. Sysop only bypasses permission requirements (e.g., doesn't need "Netmail" flag to send FTN).

4. **Content-aware dupe checking**: msg_id + transport_type + user_id + subject + body_text length. Handles FTN implementations that reuse MSGIDs across split replies (SBBSecho areafix).

5. **`simpleTextToHtml` fallback**: If `formatBodyHtml` returns empty or throws, a simple HTML-escape + line-break conversion ensures `body_html` is always populated for web-composed messages. The view layer has its own fallback chain as defense-in-depth.

6. **QWK `utf8: null` convention**: PM work items set `utf8: null` to trigger CP437 conversion in the packet builders. The echomail convention (`utf8` truthy = `body_text` is already CP437) doesn't apply to web-composed PMs which are always UTF-8.

7. **Flash messages via Redis**: Avoids adding session middleware dependencies. Short TTL (30 seconds) means abandoned flashes auto-expire. Append-on-set supports multiple redirects stacking messages.

8. **Webmail split-pane over modal reader**: Messages are read inline without page navigation or modal overlays. DataTables provides search/sort without server round-trips. Reply is the only modal (needs the full compose form with quote system).

9. **From select with server validation**: Users can choose between username and real name as sender identity. `validateFromUser` on the server prevents form tampering — rejects values that don't match either field.

10. **Co-sysop notification**: `notifySysops()` queries `getUsersByPermissionFlag('Sysop')` and delivers to ALL matching users, not just the first. All sysops see undeliverable messages and system alerts.

11. **Terminal editor branches LOCAL vs network at save time**: Rather than separate compose flows, a single editor handles all transports. For LOCAL, `resolveRecipient` validates the user exists before queuing. For network transports, resolution is skipped entirely — the name and address are taken as-is, since the recipient may not be a local user.

12. **Title-case normalization on To field**: The recipient name is title-cased at save time to produce consistent display regardless of how the user typed it. The original typed value is preserved as `to_user` (display) while `to_address` holds the resolved username (routing), so `"john smith"` displays as `"John Smith"` but routes correctly to the `jsmith` account.

13. **Shared module for call flow and menu**: `pmCheck` is a `BaseSubModule` that works both as a menu command (via `_runSubModule`) and as a call flow stage (via `SubModuleAdapter`). Same code path, no duplication.

14. **Model-layer outbound toss trigger**: `queueMessage()` and `queueOutbound()` enqueue the appropriate outbound toss job (FTN -> `enqueueFtnOutbound`, QWK -> `enqueueQwkPushAll`, EMAIL -> `enqueueEmailOutbound`) after a successful outbox insert for non-LOCAL transports. This ensures both web routes and terminal `pmEditor` trigger delivery without duplicating logic in each caller. Uses dynamic `await import('../queues/jobs.js')` with try/catch so the model remains testable without Redis -- the trigger silently skips if queue infrastructure is unavailable.

---

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `pm_trash_retention_days` | 30 | Days to keep soft-deleted messages before hard purge |
| `netmail_relay_mode` | nodelist | FTN netmail relay: `nodelist`, `off`, or `on` |
| `allow_netmail_relay` | false | Deprecated and ignored, replaced by `netmail_relay_mode` |
| `netmail_ping_enabled` | true | Answer netmail addressed to "Ping" with a Pong showing the route taken |
| `boardname` | 'Canectic BBS' | Used in bounce notifications and FTN origin lines |

---

## Future Development

- **Conversation grouping**: `transport_data` preserves `msg_id` / `reply_to` for future `conversation_id` threading
- **Meshtastic transport adapter**: LoRa mesh radio message delivery
- **`netmail.js` retirement**: Old FTN-specific module can be dropped once all paths confirmed working through the unified PM system
- **Old `netmail_in` / `netmail_out` tables**: Can be dropped or renamed to `_legacy` after migration verified
- **Areafix/filefix routing**: Stub in `importFtnNetmail` -- conference 0 messages addressed to automated processors (areafix, filefix) should be routed to handler modules instead of user inboxes
- **Terminal reader pagination**: Currently loads a single batch of 50 messages per folder. Lazy-loading of older/newer batches (like `msgReader`) for mailboxes exceeding the batch size
- **Terminal address book**: Quick-select from recent recipients or known network addresses rather than typing addresses manually

### Completed

- **EMAIL transport adapter**: Internet email delivery via SMTP relay. Outbound triggered by `email:outbound` toss job, inbound via SMTP gateway. See `EMAIL_ARCHITECTURE.md` for full details.
