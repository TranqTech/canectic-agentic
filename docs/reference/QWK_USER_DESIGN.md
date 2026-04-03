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
| `startNewThread()` / `replyToThread()` | `echomail.js` | Standard message posting path |
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

Each message area carries a `qwk_conf_number` column (INTEGER, UNIQUE, NOT NULL). This is a system-wide property of the area, not per-user.

- **Defaults to area ID**: `qwk_conf_number = id` on creation unless explicitly set. Area IDs start at 1 and grow sequentially, so they naturally avoid conference 0 (reserved for PMs) and leave plenty of room for sysops to assign custom numbers in typical network ranges (100-999, 14000+).
- **Sysop-editable**: admin area editor shows and allows changing the conference number (with uniqueness validation)
- **Stable across all users and downloads**: every user's QWK packet uses the same conference numbers, so any QWK reader's conference list is consistent
- **Independent of QWK network areatags**: network areatags (the conference numbers used for peer-to-peer QWK networking) are a property of the network mapping, not the local area. The local `qwk_conf_number` is for user-facing packets only. A sysop may choose to align them manually, but there is no automatic coupling.

This matches how traditional BBS software handles conference numbering -- Synchronet has internal codes per sub-board, Mystic has conference numbers per message base.

## 2. REP Import Pipeline

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
     d. Post via `echomail.replyToThread()` or `echomail.startNewThread()` with the user's ID, bypassing the normal web/terminal form pipeline but using the same underlying posting functions
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

### message_areas.qwk_conf_number

New column on the existing `message_areas` table:

```sql
ALTER TABLE message_areas ADD COLUMN IF NOT EXISTS qwk_conf_number INTEGER UNIQUE;
```

- **Defaults to area ID**: on area creation, `qwk_conf_number` is set to the area's `id` unless explicitly specified. Area IDs are sequential from 1, leaving plenty of room in typical conference number ranges (100-999, 14000+) for sysops to assign custom numbers matching a network hub.
- **Sysop-editable**: shown in the admin area editor with uniqueness validation
- **Backfill for existing areas**: a migration/bootstrap sets `qwk_conf_number = id` for any areas where `qwk_conf_number IS NULL`

No new tables needed. The conference mapping is a property of the area, not the user.

## 4. Config Keys

| Key | Type | Default | Category | Description |
|-----|------|---------|----------|-------------|
| `qwk_bbsid` | string | `''` | system | QWK BBS ID (max 8 chars, uppercase). Falls back to first 8 chars of `boardname`. |
| `qwk_max_msgs_per_area` | number | `500` | system | Maximum messages per area in a user QWK packet |
| `qwk_enabled` | boolean | `true` | system | Enable/disable user QWK packet download/upload |

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
