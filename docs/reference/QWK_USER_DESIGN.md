# User QWK/REP Packet Design

Personal QWK packet download and REP packet upload for individual BBS users. Separate from the network-level QWK tosser (`qwkTosser.js`) which handles peer-to-peer message exchange.

## Overview

Users can download a `.qwk` packet containing new messages from their subscribed areas (plus unread PMs), read them offline in a QWK-compatible reader (MultiMail, BluWave, etc.), compose replies, and upload a `.rep` packet to post those replies back.

Two access paths:
- **Terminal**: menu command for download (ZMODEM/XMODEM) and upload
- **Web**: HTTP endpoints for download (file response) and upload (multipart form)

## Existing Infrastructure

### Already built (reusable)

| Component | Location | Role |
|-----------|----------|------|
| `buildControlDat()` | `qwkPacketBuilder.js` | CONTROL.DAT generation |
| `buildMessagesDat()` | `qwkPacketBuilder.js` | MESSAGES.DAT buffer from message items |
| `buildHeadersDatText()` | `qwkPacketBuilder.js` | HEADERS.DAT with full-length fields |
| `assembleQwkPacket()` | `qwkPacketBuilder.js` | ZIP assembly from component files |
| `parseMessagesDAT()` | `qwkClasses.js` | Parse MESSAGES.DAT into message objects |
| `parseHeadersDat()` / `applyHeadersDat()` | `qwkClasses.js` | Parse and overlay HEADERS.DAT |
| `parseControlDat()` | `qwkClasses.js` | Parse CONTROL.DAT |
| `unzipQwkPacket()` | `qwkClasses.js` | Extract ZIP to directory |
| `buildRepPacket()` | `qwkClasses.js` | Build REP ZIP from message items |
| `userMsgPointers` | `userMsgPointers.js` | Per-user per-area scan pointers (area floor + thread pointers) |
| `userAreaSubs` | `userAreaSubs.js` | User subscription resolution (override > area default) |
| `startNewThread()` / `replyToThread()` | `messages.js` | Standard message posting path |
| `privateMessages` | `privateMessages.js` | PM inbox/outbox, delivery, unread counts |
| Access control | `index.js` | `checkAreaReadAccess()` pattern: security level + perm flags + restriction flags |

### What needs building

1. **`message_areas.qwk_conf_number`** -- new column, auto-assigned, sysop-editable
2. **`src/models/qwkUser.js`** -- user QWK packet generation and REP import logic
3. **Terminal menu command** -- `src/handlers/menucommands/qwkTransfer.js`
4. **Web routes** -- download/upload endpoints on the messages router
5. **Admin config keys** -- QWK system ID, max messages per area, etc.

## 1. QWK Packet Generation Pipeline

### Entry point: `buildQwkForUser(userId)`

Returns `{ status, qwkPath, totalMessages, areaCount, errormessages }`.

Steps:

1. **Load user record** -- need username, security level, permission/restriction flags
2. **Resolve QWK-ID** -- system's QWK-ID from config key `qwk_bbsid` (new), falling back to `boardname` truncated to 8 chars uppercase. This is the BBS identifier in CONTROL.DAT and the packet filename.
3. **Get accessible subscribed areas**:
   - Query all active message areas with their groups
   - Filter by read access: `security_level >= read_security`, has all `read_perm_flags`, has none of `read_rest_flags`
   - Filter by subscription: `userAreaSubs.getSubscribedAreas()` (user override > area `newscan_default`)
   - Each surviving area becomes a QWK conference
4. **Conference numbers**:
   - Conference 0 is always "Personal E-mail" (PMs)
   - Each message area has a `qwk_conf_number` column -- auto-assigned on area creation, sysop-editable via admin
   - The packet uses these system-wide conference numbers directly; no per-user mapping needed
   - REP import resolves conference numbers back to areas via the same column
5. **Gather messages per area**:
   - For each area, get `scan_pointer` from `userMsgPointers.getPointer()`
   - Query `mb_<shortcode>_msgs WHERE id > scan_pointer ORDER BY id ASC LIMIT <max_per_area>`
   - `max_per_area` from config key `qwk_max_msgs_per_area` (default 500)
   - Track the highest message ID per area for pointer advancement
6. **Gather unread PMs** (conference 0):
   - Query `pm_inbox WHERE user_id = $1 AND read = false AND deleted = false ORDER BY created_at ASC`
   - Include as conference 0 messages with `isPrivate: true`
7. **Build packet components**:
   - `buildControlDat()` with system info, username as recipient, conference list
   - `buildMessagesDat()` from gathered message items
   - `buildHeadersDatText()` for full-length metadata
   - No NETFLAGS.DAT (not a network packet)
8. **Assemble**: `assembleQwkPacket()` into temp directory
9. **Advance pointers**: For each area included, `userMsgPointers.advancePointer(userId, shortcode, highestMsgId)`
10. **Mark PMs read**: Mark included PMs as read (they've been "downloaded")

### Conference Number Assignment

Conference numbers are allocated in **per-group blocks** so areas in the same message group cluster together in QWK reader conference lists. Each `message_groups` row owns a contiguous block starting at `qwk_conf_start` of size `qwk_group_stride` (config, default 1000). Areas in the group take consecutive offsets within the block at `[qwk_conf_start, qwk_conf_start + stride - 1]`.

**Reserved range 1-100.** Conference numbers 1 through 100 are reserved for Canectic system conferences (see the "Reserved System Conferences" section below). The first message group's block starts at the first stride boundary above 100 (e.g. 1000 for stride=1000, or 200 for stride=100). `RESERVED_CONF_COUNT = 100` is a constant in `src/models/msgAreas.js` and `src/models/msgGroups.js`.

**Group-level state** (`message_groups.qwk_conf_start`):

- Auto-assigned by `msgGroups.newGroup()` to `MAX(existing) + stride` (or the first stride boundary above 100 for the first group). The admin "Add Group" modal pre-fills the field with this value so the sysop can either accept the default or pick a custom start.
- Sysop-editable on the group edit modal. Changing the value triggers `renumberGroupAreas(groupId, oldStart, newStart)` which preserves each area's existing offset within the block. The renumber is collision-checked against any area outside the group; if any new number would collide, the entire updateGroup call aborts and the start stays at its old value.
- UNIQUE-constrained at the DB level (`message_groups_qwk_conf_start_key`). Managed at startup by `msgGroups.ensureQwkConfStartConstraint`.

**Area-level state** (`message_areas.qwk_conf_number`):

- Assigned at create time by `msgAreas.newArea()` via `nextConfNumberInGroup(group)`, which finds the lowest unused offset in the group's block. If the block is full (every slot taken), creation fails with a "block full" error before any DB write -- the sysop must increase `qwk_group_stride` or move areas out of the group.
- **Move semantics**: `moveArea(shortcode, targetGroupShortcode)` reassigns the conference number from the target group's block (lowest unused offset) before doing any other writes. If the target block is full, the move aborts cleanly with the area unchanged.
- **Sysop override**: the admin area edit modal still exposes the QWK Conference # field as an escape hatch. The override is allowed to live outside the group's block as long as it doesn't collide with any other area globally. Validation rejects values ≤ 100 (reserved range) and collisions with any other area (also enforced by the DB UNIQUE constraint). Manual overrides survive group renumbers as long as they don't conflict with the new range, and survive moves only if explicitly re-set after the move.
- **Stable across all users and downloads**: every user's QWK packet uses the same conference numbers, so any QWK reader's conference list is consistent.
- **Independent of QWK network areatags**: network areatags (the conference numbers used for peer-to-peer QWK networking) are a property of the network mapping, not the local area. The local `qwk_conf_number` is for user-facing packets only. A sysop may choose to align them manually, but there is no automatic coupling.

**AJAX collision endpoints**:

- `/admin/msgAreas/check-conf-number?n=X&exclude=shortcode` -- per-area override availability
- `/admin/msgGroups/check-conf-start?n=X&exclude_group_id=Y` -- group block start availability

Both are debounced from input events on the corresponding modals so sysops get inline feedback before submitting.

**Startup invariants** (`msgAreas.ensureQwkConfNumbers` + `msgGroups.ensureQwkConfStartConstraint`):

1. Ensure the `message_areas_qwk_conf_number_key` UNIQUE constraint exists (idempotent).
2. Ensure the `message_groups_qwk_conf_start_key` UNIQUE constraint exists (idempotent).
3. Reserved-range scan: any row with `qwk_conf_number` in `[1..100]` is logged at level 1 with its shortcode, warning the sysop to renumber it. These are explicit sysop assignments (or legacy data from before the reserved-range scheme); we do not auto-move them, since silent mutation of explicit values would be worse than the warning. Resolve via `/admin/msgAreas` or by running the upgrade tool described below.

The startup functions deliberately do **no data migration**. They only enforce schema-level invariants and surface warnings.

**Upgrade tool** (`src/tools/qwkConfRenumber.js`):

A standalone Node CLI that walks groups and areas to apply the per-group block scheme. Two modes:

- **Default**: preserves any `qwk_conf_start` values already set on groups, only filling in groups that are missing one. Then walks each group's areas in `(sort_order, id)` order and assigns offsets, preserving existing in-block offsets where possible. Use this for an upgrade run where you want to keep any sysop customisations.
- **`--force`**: discards every existing `qwk_conf_start` and `qwk_conf_number`, packs groups consecutively starting from the first stride boundary above the reserved range, and assigns fresh sequential offsets to every area. Use this when conference numbers have drifted significantly or when you want to compact groups together.

```bash
node src/tools/qwkConfRenumber.js              # preserve existing, fill gaps
node src/tools/qwkConfRenumber.js --dry-run    # preview without writing
node src/tools/qwkConfRenumber.js --force      # discard and rebuild
node src/tools/qwkConfRenumber.js --force --dry-run
```

The tool ensures the schema column and UNIQUE constraint exist before reading (so it can run before the gateway/worker has booted on a fresh upgrade). It uses a two-phase write: first parking every area at its negative id (negatives can't collide with any real conference number), then writing the final values. This dodges UNIQUE-constraint violations when the new range overlaps the old range. Group `qwk_conf_start` values are written in a final pass after all areas are repositioned. If the tool fails after phase 1, the DB is in a parked state -- re-run the tool to recover.

Exit codes: 0 success, 1 stride too small for at least one group, 2 fatal (DB error or bootstrap failure).

## 1.5. Reserved System Conferences

Conference 0 is personal mail (PMs) by QWK convention. Conferences 1-100 are reserved by Canectic for system content delivered through user QWK downloads. Three slots are currently used:

| Conf | Name | Source model | Config key | REP import behaviour |
|---|---|---|---|---|
| 1 | Announce | `announcements.js` (active, in publish window) | `qwk_announcements_conf` | Rejected (read-only) |
| 2 | Wall | `wall.js` (last 100, or since last download) | `qwk_wall_conf` | First post accepted, extras rejected |
| 3 | Bulletin | `bulletins.js` (active, filtered by updated_at) | `qwk_bulletins_conf` | Rejected (read-only) |

All three keys default to the values shown above. Setting a key to `0` disables emission for that source. Sysops can renumber to different values within the reserved range (1-100) via `/admin/config`, though the defaults are the recommended assignment.

### Read tracking: `users.last_qwk_download_at`

A new column on the users table tracks the last successful QWK build for each user. System conference content is filtered against this timestamp so each download only carries new material since the previous fetch. After the packet is fully assembled and about to ship, `last_qwk_download_at` is updated to NOW().

**Known limitation**: users who download QWK to multiple devices will have each sync advance the server-side timestamp, so the second device will miss content the first device already received. This is documented in the sysop docs as a multi-device caveat. Users with this workflow need to sync their offline readers themselves.

### Emission in CONTROL.DAT

System conferences are prepended to the conference list when building CONTROL.DAT, so they appear immediately after conference 0 on mail clients that respect CONTROL.DAT emission order. Mail clients that sort numerically also show them at the top because the reserved range (1-100) is below the message-area range (101+).

### Conference content rendering

- **Announcements**: one QWK message per active announcement newer than `last_qwk_download_at`. From = author name (or `sysopname`), To = the recipient user, Subject = truncated announcement title, Body = `body_text` (already HTML-stripped by `announcements.htmlToPlainText`). Status byte `0x2A` (private unread) so mail clients surface them as personal items. Synthesised Message-ID `<announce-N@canectic.local>`.
- **Wall**: one QWK message per post, filtered by `created_at > last_qwk_download_at` (or last 100 on first download). From = poster's username, To = `"All"`, Subject = first 25 chars of the post body (preview), Body = full post (up to 160 chars). Status byte `0x20` (public). Synthesised Message-ID `<wall-N@canectic.local>`.
- **Bulletins**: one QWK message per active bulletin where `updated_at > last_qwk_download_at` (on re-download, only modified bulletins come through; on first download all active bulletins are included). From = `sysopname`, To = the recipient user, Subject = truncated bulletin title, Body = `body_text`. Status byte `0x2A`. Synthesised Message-ID `<bulletin-N@canectic.local>`.

### Wall REP import rules

Wall one-liners are the only system conference that accepts REP uploads, with several constraints enforced in `importRepWall`:

1. **`wall.canPost(user)` must pass.** Users with the `Unverified` restriction flag (or any other configured `wall_post_restricted_flags`) are rejected with `wall posting denied for this user`.
2. **First-line-only.** The REP message body is split on any newline (CR, LF, or CRLF); only the first non-empty line is taken. Users who accidentally write a multi-line wall post get the first line posted.
3. **Silent truncation.** Leading/trailing whitespace is stripped; the result is silently truncated to `wall_max_length` (default 78). No error for overlength posts.
4. **Empty rejection.** If the first line is empty after stripping, reject with `empty wall post body`.
5. **One per REP.** The first wall-targeted message in a REP is accepted (subject to 1-4 above); subsequent wall-targeted messages in the same REP are rejected with `Wall posts are limited to one per REP upload`.

### Post-import feedback PM

If any messages in a REP were rejected (for any reason — wall overflow, wall access denied, announcements/bulletins read-only, unknown conference, area access denied, etc.), `importRepForUser` composes a LOCAL system PM to the user summarising the failures and delivers it via `privateMessages.deliverMessage`. The PM lands in the user's inbox and shows up in their next QWK download, closing the feedback loop. Most mail clients don't surface per-message rejection details from the upload response JSON, so this is the only realistic feedback path for offline-only users.

### Threading caveat

Mail clients allow users to "reply" to any message they see, including announcements and bulletins. Such replies target the announcements/bulletins conference in the REP file and are rejected by our read-only policy. The user's reply shows up in their mail client's sent folder as "sent" (the client doesn't know) but never reaches Canectic's database. The rejection PM (above) tells the user their reply was dropped, but the sent-folder state in their reader is beyond our control. Worth documenting for sysops so they can pre-answer user confusion.

## 1.6. Files in the packet (#75)

Synchronet's personal packets carry files beside the messages (pack_qwk.cpp), and so do ours, through one `PacketFileSet` (`src/models/qwkPacketFiles.js`: plain names, never a packet's own member names, a number added on a collision, each file linked into the build directory under the name the user sees because `zip -j` stores the name on disk and a file area keeps a second `NAME.EXT` as `NAME_1.EXT`). A packet is made when files are all there is to send.

- **`NEWFILES.DAT`** (`src/models/qwkNewFiles.js`) when `users.qwk_files` is on (default true, as in Synchronet's `QWK_DEFAULT`): Synchronet's layout (`New files since:`, `(n) Group (n) Area` headers with a rule as long as the header, `NAME  SIZE description` lines, `N Files Listed.`), CRLF, CP437. Files uploaded after `users.qwk_files_since` (a one-off date from `FILES MM/DD/YY`, cleared by the next packet), else `last_qwk_download_at`, else the account's `created_at`, in the file areas the user can see (`fileAreaAccess.canBrowseFileArea`, area and group) and scans for new files (`userFileSubs`), as Synchronet lists every directory not excluded from new-scan. At most 2000 files.
- **The batch download queue** (`user_file_batch`, which the file pages and FREQ fill): every queued file the user may still download (`canDownloadFileArea` on area and group) that is on disk goes in under its listed name; each is counted (`incrementDownloadCount`) and removed from the queue once the packet is built. One that cannot go stays queued.
- **Private mail attachments** when `users.qwk_attach` is on (default true): each unread PM's `pm_attachments` (inbox rows) go in as files, and the PM body gains a line `[Attached, in this packet: NAME, ...]` so the reader knows to look.

Settings: `users.qwk_files`, `users.qwk_attach`, `users.qwk_files_since`; set by REP control messages (below) and on the web `/qwk` page (Packet Settings, `POST /qwk/settings`).

## 2. REP Import Pipeline

### Control messages to SBBS (#75), `src/models/qwkControl.js`

A REP message addressed to `SBBS`, in any conference, is a control message (Synchronet `qwkcfgline`, reached from un_rep.cpp). The subject is upper-cased and padded to 25 characters, as Synchronet does, so `ON ` matches with its trailing space and anything else means off: `FILES ON` / `FILES MM/DD/YY` (on, listing from that date once) / `FILES <other>`; `ATTACH ON` / `ATTACH <other>`; `FREQ <filename>`, which finds the newest active file of that name (any case) in an area the user may browse and download and adds it to their batch download queue, so it comes in the next packet. Anything else is answered as not supported. What each did is sent back as one private message, subject `QWK settings`, since an offline reader has no other way to see it.



### Entry point: `importRepForUser(userId, repFilePath)`

Returns `{ status, totalPosted, totalErrors, errormessages }`.

Steps:

1. **Extract REP**: `unzipQwkPacket(repFilePath, extractDir)`
2. **Find message file**: Look for `<BBSID>.MSG` or `MESSAGES.DAT` in extracted files
3. **Parse messages**: `parseMessagesDAT(buffer)` on the message file
4. **Parse HEADERS.DAT** if present: `parseHeadersDat()` + `applyHeadersDat()`
5. **Resolve conference numbers**: Look up `message_areas` by `qwk_conf_number` to map conference numbers back to area shortcodes
6. **Process each message**:
   - **Conference 0** (PM reply): Create outbound PM via `privateMessages.deliverMessage()` or compose new PM
   - **Conference > 0** (area post):
     a. Resolve conference number to area shortcode via `message_areas.qwk_conf_number`
     b. Verify user has write access to the area (security + permission flags + restriction flags, same pattern as read access but using `write_security`, `write_perm_flags`, `write_rest_flags`)
     c. Determine if reply or new thread:
        - If `msg.replyTo` or HEADERS.DAT `Reply-ID` is present, find parent thread
        - If subject starts with "Re:", search for matching thread by subject (same `findThreadBySubject()` pattern as the QWK tosser)
        - Otherwise, start new thread
     d. Post via `messages.replyToThread()` or `messages.startNewThread()` with the user's ID, bypassing the normal web/terminal form pipeline but using the same underlying posting functions
7. **Clean up**: Remove extracted files and temp directory

### REP Message Field Mapping

| REP field | Maps to |
|-----------|---------|
| `from` | User's display name (override with actual username for security) |
| `to` | `to_user` on the message (or PM recipient) |
| `subject` | `subject` |
| `body` | `body_text` (CP437 decoded to UTF-8) |
| `conferenceNum` | `message_areas.qwk_conf_number` lookup to area shortcode |
| `date`/`time` | `system_time` (use current server time, not client-supplied) |

Security: Always override the `from` field with the authenticated user's username. QWK readers let users set arbitrary "from" names, but the BBS must enforce identity.

## 3. Database Schema

### message_groups.qwk_conf_start

Declared in `db/schema/tablecolumns/message_groups.conf`:

```
qwk_conf_start INTEGER
```

- **Default on create**: `msgGroups.newGroup()` auto-assigns via `nextGroupConfStart()` which returns `MAX(existing) + qwk_group_stride` (or the first stride boundary above `RESERVED_CONF_COUNT` for the first group).
- **UNIQUE constraint**: `message_groups_qwk_conf_start_key` enforces uniqueness across groups so two groups can't claim the same block start. Managed at startup by `msgGroups.ensureQwkConfStartConstraint`.
- **Sysop-editable**: the admin group edit modal exposes the field. Changing it triggers `renumberGroupAreas()` which preserves area offsets within the new block, with full collision checking against areas in other groups.
- **AJAX validation**: `/admin/msgGroups/check-conf-start?n=X&exclude_group_id=Y` returns JSON `{ available, message }` for live feedback in the create/edit modals.

### message_areas.qwk_conf_number

Declared in `db/schema/tablecolumns/message_areas.conf`:

```
qwk_conf_number INTEGER
```

- **Default on create**: `newArea()` calls `nextConfNumberInGroup(group)` to find the lowest unused offset in the parent group's block. The number is set in the same INSERT, so there's no two-step write.
- **UNIQUE constraint**: `message_areas_qwk_conf_number_key` enforces global uniqueness across all areas (not just within a group). Managed at startup by `ensureQwkConfNumbers`.
- **Sysop-editable override**: the admin area edit modal exposes the field as an escape hatch. The override is allowed to live outside the group's block as long as it remains globally unique and above the reserved range.
- **Move semantics**: `moveArea()` reassigns the conference number from the target group's block before any other writes. If the block is full, the move aborts cleanly.
- **Validation**: `msgAreas.updateArea()` rejects values ≤ `RESERVED_CONF_COUNT` and collision-checks against any other area before the write.
- **Migration**: handled by `src/tools/qwkConfRenumber.js` (standalone CLI) -- see "Conference Number Assignment" in section 1 for the per-group block model details.

### users.last_qwk_download_at

New column on `users`, declared in `db/schema/tablecolumns/users.conf`:

```
last_qwk_download_at TIMESTAMPTZ
```

Advanced to NOW() at the end of each successful `buildQwkForUser()` call. Used to filter system conference content (announcements, wall, bulletins) so each download only carries new material since the previous sync.

## 4. Config Keys

| Key | Type | Default | Category | Description |
|-----|------|---------|----------|-------------|
| `qwk_enabled` | boolean | `true` | qwk | Enable/disable user QWK packet download/upload |
| `qwk_bbsid` | string | `''` | qwk | QWK BBS ID (max 8 chars, uppercase). Falls back to first 8 chars of `boardname`. |
| `qwk_max_msgs_per_area` | number | `500` | qwk | Maximum messages per area in a user QWK packet |
| `qwk_announcements_conf` | number | `1` | qwk | Conference number for system announcements. Must be in the reserved range (1-100). `0` disables emission. |
| `qwk_wall_conf` | number | `2` | qwk | Conference number for the wall. Must be in the reserved range (1-100). `0` disables emission. |
| `qwk_bulletins_conf` | number | `3` | qwk | Conference number for bulletins. Must be in the reserved range (1-100). `0` disables emission. |
| `qwk_group_stride` | number | `1000` | qwk | Conference number block size per message group. Each group is auto-assigned a `qwk_conf_start` at `MAX(existing) + stride` and its areas take consecutive offsets within `[start, start+stride-1]`. Larger stride leaves more room for future areas; smaller stride packs groups tighter. Changing this value does NOT renumber existing groups -- run `node src/tools/qwkConfRenumber.js --force` to re-pack. |

## 5. Terminal Flow

### Menu command: `qwkTransfer` (type: `QWK`)

A `BaseSubModule` in `src/handlers/menucommands/qwkTransfer.js`.

#### Download flow

1. Display status: "Preparing QWK packet..."
2. Call `buildQwkForUser(userId)` 
3. If no messages: display "No new messages" and return
4. Display summary: "Built packet: X messages across Y areas"
5. Prompt: "Download QWK packet? [Y/n]"
6. On confirm: initiate file transfer using the same native ZMODEM/XMODEM engine used by `fileBrowser.js` downloads
   - ZMODEM preferred (auto-detected from terminal negotiation)
   - XMODEM fallback
   - The packet is a single ZIP file, straightforward single-file transfer
7. After successful transfer: clean up temp files
8. On cancel or transfer failure: clean up, pointers already advanced (messages will appear as "read" -- this is standard QWK behaviour)

#### Upload flow

1. Prompt: "Upload REP packet? [Y/n]"
2. On confirm: initiate file receive (ZMODEM/XMODEM)
3. Receive file to temp directory
4. Call `importRepForUser(userId, repFilePath)`
5. Display results: "Posted X messages, Y errors"
6. Clean up temp files

#### Combined flow

The menu command presents a simple menu:
```
QWK Mail Transfer
  D - Download QWK packet
  U - Upload REP packet
  Q - Quit
```

### Integration with existing transfer system

The terminal file transfer uses the same `StreamAdapter` pattern from `src/protocols/`:
- `zmodem_native.js` / `xmodem_native.js` for the actual transfer
- The QWK packet is just a file path; the transfer engine handles it like any other file download
- Upload receive works the same way -- receive to temp path, then process

## 6. Web Routes

Added to `src/routes/index.js` (messages router) or a new `src/routes/qwk.js` router.

### GET `/qwk/download`

Requires authentication. Generates QWK packet and sends as file download.

```
Response: application/zip, Content-Disposition: attachment; filename="<BBSID>.qwk"
```

1. Check `qwk_enabled` config
2. Build packet via `buildQwkForUser(req.session.user.id)`
3. If no messages: redirect back with flash "No new messages for QWK download"
4. Stream the ZIP file as response
5. Clean up temp files after send

### POST `/qwk/upload`

Requires authentication. Accepts multipart form upload of `.rep` file.

```
Request: multipart/form-data, field "repfile"
Response: redirect with flash summary
```

1. Check `qwk_enabled` config
2. Validate uploaded file: must end in `.rep`, size limit (configurable, default 10MB)
3. Save to temp directory
4. Process via `importRepForUser(req.session.user.id, tempPath)`
5. Clean up temp file
6. Redirect with flash: "Posted X messages" or error details

### GET `/qwk` (QWK transfer page)

Simple page with:
- Download button (links to `/qwk/download`)
- Upload form (posts to `/qwk/upload`)
- Display of subscribed area count and estimated new message count
- Last download timestamp (from highest `last_read_at` on user pointers, or a dedicated field)

## 7. Model: `src/models/qwkUser.js`

Public API:

```javascript
// Generate a QWK packet for a user
// Returns { status, qwkPath, totalMessages, areaCount, conferences, errormessages }
async function buildQwkForUser(userId)

// Import a REP packet uploaded by a user
// Returns { status, totalPosted, totalErrors, details[], errormessages }
async function importRepForUser(userId, repFilePath)

// Get the resolved QWK BBS ID
function getQwkBbsId()

// Backfill qwk_conf_number for areas that don't have one yet
async function ensureConfNumbers()
```

### Internal helpers

- `getAccessibleSubscribedAreas(user)` -- areas the user can read and is subscribed to, with `qwk_conf_number`
- `gatherAreaMessages(shortcode, scanPointer, maxMsgs)` -- query messages above pointer
- `gatherUnreadPMs(userId)` -- unread PMs for conference 0
- `resolveAreaByConfNumber(confNumber)` -- look up area by `qwk_conf_number`
- `checkAreaWriteAccess(user, area)` -- verify write permission for REP posting

## 8. Access Control

QWK packets respect the same access control as web/terminal:

- **Read access** (for QWK download): `security_level >= read_security` AND has all `read_perm_flags` AND has none of `read_rest_flags`
- **Write access** (for REP posting): `security_level >= write_security` AND has all `write_perm_flags` AND has none of `write_rest_flags`
- Areas the user cannot read are excluded from the packet entirely
- Areas the user cannot write to will reject REP posts with an error logged

The access check function should be extracted from `index.js` into a shared utility or the message areas model so it can be reused by `qwkUser.js` without importing route code.

## 9. Pointer Behaviour

QWK download advances area scan pointers (`user_msg_pointers.scan_pointer`) to the highest message ID included in the packet for each area. This is the same pointer used by web and terminal newscan.

This means:
- After downloading a QWK packet, those messages no longer appear as "new" in web or terminal
- If the user reads messages on the web between QWK downloads, the web-advanced pointer is respected (QWK only gathers messages above the current pointer)
- Thread pointers are NOT advanced by QWK download (only the area floor moves) -- this matches the flat-view behaviour documented in `userMsgPointers.js`

For PMs: downloaded PMs are marked as read. This matches the "you've received them in your offline reader" semantic.

## 10. File Layout

```
src/models/qwkUser.js                         -- core logic
src/handlers/menucommands/qwkTransfer.js       -- terminal menu command
src/routes/qwk.js (or additions to index.js)   -- web routes
src/views/qwk/index.pug                        -- QWK transfer page
src/views/qwk/results.pug                      -- upload results (or use flash)
```

## 11. Implementation Order

1. **Schema**: Add `qwk_conf_number` column to `message_areas`, backfill existing areas
2. **Config keys**: Add `qwk_bbsid`, `qwk_max_msgs_per_area`, `qwk_enabled` to `configDefaults.js`
3. **Admin UI**: Show `qwk_conf_number` in message area editor (auto-assigned, editable)
4. **`qwkUser.js`**: `buildQwkForUser()` -- packet generation with pointer advancement
5. **`qwkUser.js`**: `importRepForUser()` -- REP import with posting
6. **Extract access check**: Move `checkAreaReadAccess()` pattern to shared location
7. **Web routes**: Download and upload endpoints
8. **Web view**: QWK transfer page
9. **Terminal command**: `qwkTransfer.js` with download/upload flows
10. **Area creation path**: Set `qwk_conf_number = id` on new area creation (after INSERT returns the id)
11. **CLAUDE.md update**: Document new files, column, and config keys

## Design Decisions

1. **Conference numbers are a system-wide property of the area** (`message_areas.qwk_conf_number`), not per-user. Defaults to the area's database `id`, sysop-editable. This is simpler than a per-user mapping table and matches traditional BBS behaviour. Using the area ID as default avoids any allocation logic and naturally avoids conference 0. The QWK network areatags (used for peer-to-peer networking) are a separate concept on `network_areas` and are not coupled to the local conference number.

2. **Pointer advancement happens at build time**, not after confirmed transfer. This matches traditional QWK BBS behaviour (Synchronet, Mystic, etc.) and avoids complexity around transfer failure detection. If a download fails, the user simply re-downloads -- the packet will be empty for areas where all messages were already marked read.

3. **No NETFLAGS.DAT in user packets**. NETFLAGS.DAT is a QWK networking extension that tells the receiving system which conferences to pass through to other nodes. User packets don't participate in message routing.

4. **REP posts use the standard posting path** (`startNewThread`/`replyToThread`) rather than the tosser import path. This ensures proper user attribution, access control enforcement, and body_html generation. The tosser path is for network-imported messages with foreign authorship.

5. **System time on REP messages uses server time**, not the time from the QWK reader. This prevents clock drift issues and matches what happens when users post via web or terminal.

6. **From field override**: The `from` field in REP messages is always replaced with the authenticated user's username, regardless of what the QWK reader sends. This prevents impersonation.

7. **PMs in conference 0**: Unread PMs are included in the download packet. PM replies in conference 0 of the REP are delivered as new PMs. This is standard QWK offline reader behaviour.
