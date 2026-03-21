# Canectic BBS — File Area System Architecture Reference

## Overview

The file area system provides hierarchical file storage and distribution across both terminal (ANSI/CP437/UTF-8) and web interfaces. Files are organized into groups and areas, stored on disk with metadata in PostgreSQL, and distributed to FTN peers via TIC file echo processing.

Unlike the message system's per-area backing tables, the file system uses a **single `file_entries` table** with an `area_id` foreign key. This simplifies queries and avoids the schema-per-area complexity, since file areas do not need the threading or per-area column customization that message areas require.

The file system integrates with the three-process model:

- **Gateway** — serves web file routes (`/files/*`), admin CRUD routes (`/admin/fileGroup/*`, `/admin/fileArea/*`, `/admin/fileEntry/*`), and runs terminal file handlers (area selector, file browser, batch download, upload)
- **Worker** — consumes `tic:inbound` and `tic:outbound` jobs on the `toss` BullMQ queue, runs the TIC tosser
- **Mailer** — picks up staged outbound files (TIC + attachments) from the outbound directory

Cross-references:
- For the process model, job queues, and inter-process signaling, see `PROCESS_ARCHITECTURE.md`
- For the FTN networking layer (binkp, packet formats), see `NETWORKING_ARCHITECTURE.md` and `MAILER_ARCHITECTURE.md`
- For the terminal handler hierarchy and input pipeline, see `terminal_architecture.md`
- For the web application (Express, sessions, admin panel), see `web_architecture.md`
- For the message system (which this mirrors structurally), see `message_architecture.md`

---

## Core Files

### Models (shared business logic)

| File | Purpose |
|------|---------|
| `fileGroups.js` | File group CRUD. `newGroup` (creates record + base directory), `updateGroup`, `removeGroup` (cascading area removal, optional disk cleanup), `getGroupByShortcode`, `getAllGroups`, `getActiveGroups`, `getAllGroupsWithAreas` (joins areas + network mappings), `recalculateAreaCounts`. `normalizeFlags(input)` coerces form input to JSONB array. |
| `fileAreas.js` | File area CRUD. `newArea` (creates record, area directory, pointer rows, group count recalc), `updateArea`, `removeArea` (cascading cleanup of entries, network areas, peer subscriptions, pointers, user subscriptions, optional disk deletion), `getAreaByShortcode`, `getAreasInGroup`, `getAllAreas`, `getActiveAreas`. `resolveAreaPath(group, area)` — three-level directory resolution. `updateStatsForArea(shortcode)` — refreshes `file_count`, `total_bytes`, `last_upload`, `last_filename`, `last_uploader` from live data. `recalculateFileCounts()` — batch recalc across all active areas. |
| `fileEntries.js` | File entry CRUD, search, dupe checking. `addFileEntry`, `getEntryByUUID`, `getEntryById`, `getEntriesForArea` (paginated with configurable sort), `getEntryCount`, `searchEntries` (ILIKE across filename, short_desc, long_desc, full_text), `checkDupe` (by area + filename + optional CRC-32), `updateEntry`, `incrementDownloadCount`, `deactivateEntry`, `flagEntry`, `deleteEntry` (cascading distribution row cleanup), `getNewFileCount` (entries above scan pointer), `getMaxIdForArea`. |
| `fileDistribution.js` | Outbound file distribution tracking. Each row = one file to one peer. `createDistributionRows` (bulk, idempotent via existence check), `getPendingForConnection` (joined with file_entries), `getAllPending` (joined with file_entries + peer_connections), `getDistributionForEntry`, `markSent`, `markFailed`, `markSkipped`, `retryFailed`. Status lifecycle: `pending` -> `sent` / `failed` / `skipped`. |
| `fileNetworkAreas.js` | Maps file areas to FTN networks with areatags. `getAreaByTag(networkId, areatag)` — resolves inbound TIC area tags. `getNetworksByFileArea`, `getMappingsForNetwork`, `getMapping`, `getMappingById`, `addMapping` (dupe checks on both network+area and network+areatag), `removeMapping`, `updateMapping`. |
| `filePeerSubscriptions.js` | Per-connection subscription state for file areas. Two-flag model: `allowed` (sysop permits) + `enabled` (sysop activates). `getSubscriptionsByConnection`, `getSubscribedConnections` (requires both allowed AND enabled AND connection active), `isSubscribed`, `setSubscriptions` (bulk toggle by field), `syncConnectionToFileAreas` (bootstrap missing rows), `allowAllFileAreas`, `enableAllAllowed`, `syncFileAreaToConnections` (propagate new area to all connections on a network), `removeSubscriptionsForFileArea`. |
| `userFilePointers.js` | Per-user per-area scan pointers (mirrors `userMsgPointers.js`). Floor-based: any file with `id <= scan_pointer` is considered "seen". `ensureConstraintsAndIndexes` (table bootstrap), `advancePointer` (GREATEST — only moves forward), `markAreaRead` (jump to current max), `getPointer`, `getNewCount`, `initPointersForArea` (pre-populate all users when area created, pointer=0), `initPointersForUser` (pre-populate all areas when user created, pointer=max to hide history). |

### Utilities

| File | Purpose |
|------|---------|
| `fileHasher.js` | `computeCRC32` (via `zlib.crc32`, uppercase hex, zero-padded to 8), `computeSHA256`, `computeHashes` (both in one read). Used by TIC tosser, web upload, terminal upload. |
| `fileDescExtractor.js` | `extractDescription(filePath)` — extracts FILE_ID.DIZ from ZIP archives (via `adm-zip`), returns `{ long_desc, long_desc_html, short_desc }`. `long_desc_html` generated via `formatBodyHtml()` (shared with message system). `applyDescriptions(entryObj, filePath)` — mutates entry object in place, only filling empty fields. |

### Transfer Protocols

| File | Purpose |
|------|---------|
| `protocols/base.js` | `BaseProtocol` — EventEmitter-based file transfer executor. Raw mode management (saves/restores `call.rawmode` and `call.rawtarget`). `send(filePaths)` — spawns child process with raw stdio pipes, wires client<->child data flow. `receiveInto(targetDir, cmdInfo)` — spawns via node-pty (rz requires tty). `receiveIntoRaw(targetDir, cmdInfo)` — raw pipe fallback. Safety timeout (5 min/file for send, 5 min for receive). |
| `protocols/zmodem.js` | `ZmodemProtocol` extends `BaseProtocol`. Builds `sz` command: `-b` (binary), `-e` (escape control chars), `-B 4096` (buffer). Supports batch — multiple file paths in one `sz` invocation. |
| `protocols/zmodem_receive.js` | `ZmodemReceiveProtocol` extends `BaseProtocol`. `receive(targetDir)` calls `receiveIntoRaw` with `rz -b -e`. |

### Terminal Handlers

| File | Purpose |
|------|---------|
| `menucommands/fileAreaSelector.js` | Lightbar area selector. Flattened group/area list, cursor navigation, incremental search, new file counts per area. Persists selection to `call.file_group`/`call.file_area` and user record. Dumb terminal fallback with numbered list. |
| `menucommands/fileBrowser.js` | Two-state file browser (FILE_LIST / FILE_DETAIL). Lightbar file list with columns (filename, desc, size, date), file detail view with scrollable long description. ZMODEM download (single and batch), batch tagging (T key, max 50 files stored on `call.file_batch`), search (DB-backed via ILIKE when >= 2 chars), mark area read. Lazy pagination (loads 50 at a time, load-ahead on scroll). Dumb terminal fallback with 20-line paging. |
| `menucommands/fileBatchDownload.js` | Standalone batch download module. Shows batch summary, resolves disk paths, runs `ZmodemProtocol.send()` with all paths, increments download counts, clears batch on success. |
| `menucommands/fileUpload.js` | Terminal upload handler. Checks upload access, receives files via `ZmodemReceiveProtocol` into staging dir, then for each file: hash, dupe check, move to area dir, extract FILE_ID.DIZ, create entry, update stats. |

### Tosser

| File | Purpose |
|------|---------|
| `middleware/tossers/ticTosser.js` | FTN TIC file echo processor. **Inbound** (`tossInbound`): scan inbound dir for `.tic` files, parse TIC format, resolve source connection, validate password, resolve areatag via `file_network_areas`, verify CRC-32, dupe check, handle Replaces, move file to area dir, create entry, extract FILE_ID.DIZ if no LDesc, create distribution rows (excluding source + seenby), update area stats. **Outbound** (`tossOutbound`): get all pending distributions, group by connection, for each: resolve areatag, build TIC descriptor (append path/seenby), stage TIC + file in outbound dir (hardlink preferred, copy fallback), mark sent, signal mailer for CRASH connections. |

### Routes

| File | Purpose |
|------|---------|
| `routes/files.js` | User-facing file routes. Group listing (`/files`), area listing (`/files/group/:shortcode`), file listing (`/files/area/:shortcode`), file detail (`/files/view/:uuid`), download (`/files/download/:uuid`), JSON pagination (`/files/area/:shortcode/files.json`), upload form + POST (`/files/area/:shortcode/upload`). Access checks on all routes. |
| `routes/admin.js` | Admin file CRUD. Groups: list, create, update, delete, recalculate counts. Areas: list, view (with file entries + network mappings), create, update, delete. Entries: update, delete (optional disk removal), move between areas. Network area mappings: add, update, remove (with peer subscription sync). Peer file subscriptions: set allowed, set enabled. |

### Views

| File | Purpose |
|------|---------|
| `files/index.pug` | User file group listing. Groups filtered by read access, shows new counts and total file counts per group. |
| `files/groups/view.pug` | Area listing within a group. Areas filtered by read access, per-area new counts, upload indicators. |
| `files/areas/view.pug` | File listing in an area. Tabular display, sort controls, upload button (gated by upload access). |
| `files/view.pug` | Single file detail. Filename, size, date, uploader, download count, descriptions, download link. |
| `files/upload.pug` | Upload form. File input, description field, max size/allowed extensions display. |
| `admin/fileGroups/index.pug` | Admin file group management. DataTables listing with create/edit modals. |
| `admin/fileGroups/view.pug` | Admin file group detail. Group settings + areas within group, area create modal. |
| `admin/fileAreas/index.pug` | Admin file area listing across all groups. |
| `admin/fileAreas/view.pug` | Admin file area detail. Area settings, file entry table, network mappings. |

---

## Database Schema

### file_groups

Each row represents a file group containing one or more file areas. Groups provide default security settings and an optional base directory override.

- `id` (BIGSERIAL), `uuid` — identifiers
- `name`, `description` — display info
- `shortcode` — unique internal identifier (uppercased)
- `base_dir` — optional filesystem override (defaults to global `file_base_dir`)
- `read_security`, `post_security` — security levels for read/upload access
- `read_perm_flags`, `read_rest_flags` — JSONB arrays for read permission/restriction flags
- `post_perm_flags`, `post_rest_flags` — JSONB arrays for upload permission/restriction flags
- `area_count` — cached count of active child areas
- `active` — boolean
- `created_at`, `updated_at`, `created_by_uuid`, `created_by_name`

### file_areas

Each row represents a file area belonging to a group. Files live in the single `file_entries` table with `area_id` FK — no per-area backing tables.

- `id` (BIGSERIAL), `uuid` — identifiers
- `group_shortcode`, `group_uuid`, `group_id` — parent group references
- `name`, `description` — display info
- `shortcode` — unique internal identifier (uppercased)
- `sub_dir` — subdirectory within group's base_dir (defaults to lowercase shortcode)
- `read_security`, `post_security` — security levels
- `read_perm_flags`, `read_rest_flags`, `post_perm_flags`, `post_rest_flags` — JSONB flag arrays
- `file_count`, `total_bytes` — cached stats (refreshed by `updateStatsForArea`)
- `last_upload`, `last_filename`, `last_uploader` — cached last-upload info
- `newscan_default` — boolean, default true (controls user subscription default)
- `active` — boolean
- `created_at`, `updated_at`, `created_by_uuid`, `created_by_name`

### file_entries

Single table for all file records across all areas. Core design decision: one table with `area_id` FK instead of per-area tables.

- `id` (BIGSERIAL), `uuid` — identifiers
- `area_id`, `area_shortcode` — parent area (dual reference for convenience)
- `filename` — original filename (NOT NULL)
- `disk_path` — filename on disk (may differ from `filename` after collision handling)
- `file_size` (BIGINT) — bytes
- `file_date` — original file date
- `file_hash_crc32` — uppercase hex, 8 chars (e.g. `"1A2B3C4D"`)
- `file_hash_sha256` — lowercase hex, 64 chars
- `short_desc` — one-line description (max 255 chars)
- `long_desc` — multi-line description (from FILE_ID.DIZ or TIC LDesc)
- `long_desc_html` — pre-rendered HTML via `formatBodyHtml()` (same pipeline as messages)
- `full_text` — searchable text blob (reserved for future full-text search)
- `upload_date`, `uploader_uuid`, `uploader_name` — upload metadata
- `download_count` — integer, incremented on each download
- `source_type` — `'local'` (user upload) or `'ftn'` (TIC import)
- `source_network_id`, `source_peer_id` — network origin (NULL for local uploads)
- `source_data` (JSONB) — origin details. For TIC: `tic_origin`, `tic_from`, `tic_area`, `tic_replaces`, `tic_magic`, `tic_path`, `tic_seenby`, `tic_pw`, `tic_ldesc`, `tic_crc`. For local: `upload_method` (`'web'`/`'terminal'`), `upload_ip`.
- `active` — boolean (soft delete; deactivated files hidden from listings)
- `flagged` — boolean (admin flag for review)
- `created_at`, `updated_at`

### file_distribution

Outbound distribution tracking. Each row = one file to be sent to one peer. Join table between `file_entries` and `peer_connections`.

- `id` (BIGSERIAL) — identifier
- `file_entry_id` — FK to file_entries
- `peer_connection_id` — FK to peer_connections
- `sent_at` — timestamp when successfully sent
- `protocol` — `'tic'` (currently only protocol)
- `status` — `'pending'` / `'sent'` / `'failed'` / `'skipped'`
- `attempts` — retry counter
- `last_attempt` — timestamp of last attempt
- `error_message` — failure details
- `created_at`

### file_network_areas

Maps file areas to FTN networks via areatags (analogous to `network_areas` for messages).

- `id` (BIGSERIAL) — identifier
- `network_id` — FK to message_networks
- `area_id` — FK to file_areas
- `areatag` — file echo tag (uppercased, unique per network)
- `active` — boolean
- `created_at`, `updated_at`, `created_by_uuid`, `created_by_name`, `updated_by_uuid`, `updated_by_name`

### file_peer_subscriptions

Per-connection subscription state for file areas. Two-flag model controls distribution.

- `id` (BIGSERIAL) — identifier
- `peer_connection_id` — FK to peer_connections
- `file_area_id` — FK to file_areas
- `allowed` — sysop has permitted this connection to send/receive this area
- `enabled` — sysop has activated distribution (both must be true for distribution)
- `created_at`, `updated_at`, `created_by_uuid`, `created_by_name`, `updated_by_uuid`, `updated_by_name`

### user_file_pointers

Per-user scan pointers for file areas (mirrors `user_msg_pointers`). Floor-based: any `file_entries.id <= scan_pointer` is "seen".

- `id` (SERIAL) — identifier
- `user_id` — FK to users
- `area_shortcode` — file area shortcode
- `scan_pointer` — highest seen file entry ID
- `last_read_at` — timestamp

UNIQUE constraint on `(user_id, area_shortcode)`. Table bootstrapped via `ensureConstraintsAndIndexes()` at startup.

### user_file_subscriptions

Per-user area subscription overrides for newscan filtering (mirrors `user_area_subscriptions`).

- `id` (SERIAL) — identifier
- `user_id` — FK to users
- `area_shortcode` — file area shortcode
- `subscribed` — boolean (overrides area's `newscan_default`)
- `updated_at`

---

## Directory Structure

### Three-Level Resolution

File paths are resolved by `resolveAreaPath(group, area)`:

```
global file_base_dir     (appConfig 'file_base_dir', default: 'files')
  └── group.base_dir     (overrides global if set)
       └── area.sub_dir  (defaults to lowercase shortcode)
```

Example: If `file_base_dir = '/data/files'`, group has `base_dir = '/data/files'`, and area has `sub_dir = 'dos_games'`, the resolved path is `/data/files/dos_games/`.

If a group has a custom `base_dir`, that replaces the global base entirely. The area's `sub_dir` is always appended.

### Disk Layout

```
files/                          ← file_base_dir (configurable)
  staging/                      ← file_upload_staging_dir (web + terminal uploads land here first)
  <area_sub_dir>/               ← one directory per area
    FILENAME.ZIP                ← actual files
    ...

ftn/
  in/                           ← ftninbound (TIC + attached files arrive here)
  out/                          ← ftnoutbound (staged TIC + files for mailer pickup)
  tossed/                       ← processed TIC files moved here
  bad/                          ← rejected TIC files moved here
  tic_staging/                  ← tic_staging_dir (reserved)
```

### Config Defaults (category: 'files')

| Key | Default | Description |
|-----|---------|-------------|
| `file_base_dir` | `'files'` | Base directory for file area storage |
| `file_upload_staging_dir` | `'files/staging'` | Staging directory for uploads before processing |
| `file_max_upload_size` | `10485760` (10 MB) | Maximum upload file size in bytes |
| `file_allowed_extensions` | `''` (all) | Comma-separated whitelist (empty = allow all) |
| `tic_staging_dir` | `'ftn/tic_staging'` | TIC processing staging directory |
| `tic_inbound_dir` | `''` | TIC inbound dir (defaults to `ftninbound`) |
| `tic_auto_forward` | `'true'` | Auto-forward received TIC files to subscribed peers |

---

## File Entry Lifecycle

### Local Upload — Web

1. User navigates to `/files/area/:shortcode/upload` (upload access checked)
2. `multer` receives the file into `file_upload_staging_dir` with size limit from `file_max_upload_size`
3. Extension whitelist checked (if configured)
4. `computeHashes()` produces CRC-32 + SHA-256
5. `checkDupe()` by area + filename + CRC-32
6. File moved from staging to resolved area directory (`resolveAreaPath`)
7. `applyDescriptions()` extracts FILE_ID.DIZ from ZIP archives
8. User-provided `short_desc` overrides extracted description if present
9. `addFileEntry()` creates the database record with `source_type: 'local'`, `source_data: { upload_method: 'web', upload_ip }`
10. `updateStatsForArea()` refreshes cached area stats

### Local Upload — Terminal

1. `fileUpload` sub-module checks area selection and upload access
2. `ZmodemReceiveProtocol.receive()` spawns `rz -b -e` in staging dir
3. After transfer, scans staging dir for received files
4. For each file: hash, dupe check, move to area dir, `applyDescriptions()`, `addFileEntry()` with `source_data: { upload_method: 'terminal', upload_ip }`
5. `updateStatsForArea()` refreshes stats

### Network Import — TIC

1. Worker picks up `tic:inbound` job from the `toss` queue
2. `tossInbound()` scans inbound dir for `.tic` files
3. For each TIC file: parse, find attached file (case-insensitive), resolve source connection, validate password, resolve areatag via `file_network_areas`, verify CRC-32, dupe check, handle Replaces (deactivate old entry), move file to area dir, build entry with descriptions from TIC LDesc or FILE_ID.DIZ fallback, create entry, create distribution rows for subscribed peers (excluding source + seenby), update area stats
4. TIC file moved to tossed dir (or bad dir on error)
5. Worker publishes `FILES_IMPORTED` event via Redis pub/sub

### Download — Web

1. User hits `/files/download/:uuid`
2. Access check (authentication + area read access)
3. Path resolved via `resolveAreaPath` + `disk_path`
4. File existence verified on disk
5. `incrementDownloadCount()` updates the entry
6. `res.download()` sends the file with original filename

### Download — Terminal (Single)

1. In `fileBrowser`, user presses `D` on a file (list or detail view)
2. Path resolved, existence verified
3. `ZmodemProtocol.send([fullPath])` spawns `sz` with raw stdio pipes
4. Client auto-detects ZMODEM initiation sequence
5. On success: `incrementDownloadCount()`

### Download — Terminal (Batch)

1. User tags files with `T` in fileBrowser (stored on `call.file_batch`, max 50)
2. User presses `B` or invokes `fileBatchDownload` menu command
3. All tagged file paths resolved and existence verified
4. `ZmodemProtocol.send(filePaths)` — `sz` supports multiple files in one invocation
5. On success: increment counts for all files, clear batch

---

## Description Pipeline

### FILE_ID.DIZ Extraction

`fileDescExtractor.js` handles archive description extraction:

1. Attempt to open file as ZIP via `adm-zip`
2. Search entries for `FILE_ID.DIZ` (case-insensitive basename match)
3. Extract text content
4. `long_desc` = cleaned DIZ text (normalized line endings, trimmed)
5. `long_desc_html` = `formatBodyHtml(dizText)` — same pipeline as message `body_html` (handles ANSI art, pipe codes, CP437)
6. `short_desc` = first non-blank line (truncated to 255 chars)

Currently supports ZIP archives only. Non-ZIP files and corrupt archives are silently skipped.

### `applyDescriptions(entryObj, filePath)`

Mutates the entry object in place. Only fills fields that are currently null/empty — preserves existing values. Called by:
- Web upload route (after user-provided description)
- Terminal upload handler
- TIC tosser (when no LDesc in TIC file)

---

## Read Tracking

### Scan Pointer Pattern

File read tracking uses a single-tier pointer system (simpler than messages' two-tier system, since files have no threading):

- Each `user_file_pointers` row stores the highest `file_entries.id` the user has "seen" in that area
- Any file with `id > scan_pointer` is "new"
- Pointer only advances forward (GREATEST in upsert)

### Pointer Advancement

- **Web area view**: advances pointer to max ID in the loaded file list
- **Web JSON pagination**: advances pointer on each page load
- **Terminal fileBrowser**: advances pointer when viewing a file's detail
- **Mark area read**: jumps pointer to current `MAX(id)` for the area

### Pre-Population

- **New area created**: `initPointersForArea()` creates rows for all active users with `scan_pointer = 0` (all existing files appear as new)
- **New user created**: `initPointersForUser()` creates rows for all active areas with `scan_pointer = MAX(id)` (history hidden, only future files appear new)

---

## Access Control

Same pattern as the message system: security level + permission flags + restriction flags.

### Read Access (`checkFileAreaReadAccess` / `checkReadFlags`)

1. `user.security >= area.read_security` (or group's `read_security`)
2. User has ALL flags in `read_perm_flags` (must-have)
3. User has NONE of the flags in `read_rest_flags` (must-not-have)

Applied to: group listing, area listing, file listing, file detail, download, JSON pagination.

### Upload Access (`checkFileAreaUploadAccess` / `checkUploadAccess`)

1. `user.security >= area.post_security`
2. User has ALL flags in `post_perm_flags`
3. User has NONE of the flags in `post_rest_flags`

Applied to: upload form display, upload POST, terminal upload handler.

Groups and areas use the same column names (`read_security`, `post_security`, `read_perm_flags`, etc.) so the same check functions work on both.

---

## TIC Processing

### Inbound Flow

```
Mailer receives files → ftn/in/
  ├── FILENAME.ZIP         (attached file)
  └── FILENAME.TIC         (descriptor)

Worker: tic:inbound job
  1. Scan ftn/in/ for *.tic files
  2. Parse TIC file (key-value format)
  3. Find attached file (case-insensitive match)
  4. Resolve source peer connection from From address
  5. Validate TIC password (if configured)
  6. Resolve Area tag → file_area via file_network_areas
  7. Validate To address against system addresses
  8. Check peer subscription (logged but not rejected)
  9. Verify CRC-32 hash
  10. Dupe check (area + filename + CRC-32)
  11. Handle Replaces (deactivate old entry)
  12. Move file to area directory
  13. Extract descriptions (TIC LDesc or FILE_ID.DIZ)
  14. Create file_entries row
  15. Create file_distribution rows for subscribed peers
      (excluding source connection + seenby addresses)
  16. Move .tic to ftn/tossed/
  17. Update area stats
  18. Publish FILES_IMPORTED event
```

### Outbound Flow

```
Worker: tic:outbound job
  1. Get all pending file_distribution rows
  2. Group by peer_connection_id
  3. For each connection:
     a. Validate connection is active and has FTN address
     b. Get system address for the network
     c. For each pending file:
        - Resolve areatag via file_network_areas
        - Resolve file on disk via resolveAreaPath
        - Build TIC descriptor (append our address to path/seenby)
        - Write .tic file to ftn/out/
        - Copy/hardlink attached file to ftn/out/
        - Mark distribution row as 'sent'
     d. Signal mailer for CRASH-status connections
```

### TIC File Format

Standard key-value pairs, one per line:

```
Area FILECHO_TAG
File FILENAME.ZIP
Desc Short description
LDesc Long description line 1
LDesc Long description line 2
Size 12345
Date 1616161616
CRC 1A2B3C4D
Origin 1:2/3
From 1:2/3
To 1:2/4
Path 1:2/3 1616161616
Seenby 1:2/3
Pw TICPASSWORD
```

Multi-value keys (LDesc, Path, Seenby) accumulate into arrays. The parser is case-insensitive on keys and ignores unknown vendor extensions.

### BullMQ Job Integration

| Job Name | Queue | Trigger | Handler |
|----------|-------|---------|---------|
| `tic:inbound` | `toss` | CLI tosser (`--in --ftn`), mailer file arrival, admin | `ticTosser.tossInbound()` |
| `tic:outbound` | `toss` | CLI tosser (`--out --ftn`), after inbound processing, admin | `ticTosser.tossOutbound()` |

Job ID deduplication: `tic-inbound--<connectionUUID or timestamp>`, `tic-outbound--<connectionUUID or timestamp>`.

### Events

| Event | Channel | Payload | Published By |
|-------|---------|---------|--------------|
| `FILES_IMPORTED` | `files:imported` | `{ source: 'tic', direction: 'inbound' }` | Worker after `tic:inbound` |
| `TOSS_COMPLETE` | (standard) | `{ source: 'tic', direction: 'outbound' }` | Worker after `tic:outbound` |

---

## Transfer Protocols

### Architecture

```
BaseProtocol (EventEmitter)
  ├── send(filePaths)         — raw stdio pipes (spawn)
  ├── receiveInto(dir, cmd)   — node-pty (rz needs tty)
  └── receiveIntoRaw(dir, cmd) — raw pipes fallback

ZmodemProtocol extends BaseProtocol
  └── _buildCommand() → { cmd: 'sz', args: ['-b', '-e', '-B', '4096', ...files] }

ZmodemReceiveProtocol extends BaseProtocol
  └── receive(dir) → receiveIntoRaw(dir, { cmd: 'rz', args: ['-b', '-e'] })
```

### Raw Mode Pattern

File transfers use the same raw mode pattern as door games:

1. Save current `call.rawmode` and `call.rawtarget`
2. Set `call.rawmode = true` and `call.rawtarget` to write to child stdin
3. Child stdout piped to client via `call.cmds.senddata()`
4. On completion, restore previous raw mode state

This ensures WebSocket client bytes go directly to `sz`/`rz` without handler interpretation.

### Send vs Receive

- **Send (`sz`)**: Uses `child_process.spawn` with raw stdio pipes. Binary data integrity preserved — no terminal line-ending conversion. The terminal client auto-detects the ZMODEM initiation sequence.
- **Receive (`rz`)**: Currently uses `receiveIntoRaw` (raw pipes). The `receiveInto` method with node-pty is available but not currently used for ZMODEM receive.

### Safety

- Timeout: 5 minutes per file for send (minimum 60 seconds), 5 minutes flat for receive
- Binary integrity: `Buffer.isBuffer()` check on client data; string data converted via `Buffer.from(data, 'binary')` to avoid UTF-8 corruption of bytes > 127

---

## Terminal Interface

### fileAreaSelector

Lightbar-style area selector with group headers and area rows.

**Data**: Loads all active groups and areas, filters by user security + flags, computes new file counts per area. Rows are typed as `ROW_GROUP` or `ROW_AREA` in a flattened list.

**Geometry**: Title (row 1), info/search (row 2), list (row 3 to H-1), status (row H). Viewport height adapts to terminal size.

**Navigation**: Up/Down (skip group headers), PgUp/PgDn, Home/End. Enter selects. S enters search mode (incremental filter on name, shortcode, description, group name). Q/Esc exits.

**Selection**: Sets `call.file_group`, `call.file_group_title`, `call.file_area`, `call.file_area_title`. Persists to user record via `updateUserFileGroup`/`updateUserFileArea`.

**Visual**: CP437/UTF-8 glyph support. Highlighted row with blue background bar. Current area marked with bullet. New count in green. Configurable colors via theme object.

### fileBrowser

Two-state file browser with state machine (`STATE.LOADING`, `STATE.FILE_LIST`, `STATE.FILE_DETAIL`).

**File List State**:
- Column layout: filename (35%), description, size (8 chars), date (6 chars, "Mon DD")
- Highlighted row with blue bar, new files in green, tagged files in magenta
- Navigation: Up/Down, PgUp/PgDn, Home/End, Enter (detail), D (download), T (tag), B (batch download), S (search), M (mark read), Q (back)
- Lazy pagination: loads 50 files at a time, triggers load-ahead when near bottom

**File Detail State**:
- Header rows: filename, size, date, uploader, downloads, short_desc, area name, new indicator
- Scrollable body: word-wrapped long_desc
- Navigation: Up/Down (scroll body), PgUp/PgDn (page body), Left/Right (prev/next file), D (download), T (tag), B (batch), Space (page down), Q/Esc (back to list)

**Batch System**: Files tagged with T are stored on `call.file_batch` (array of `{ uuid, id, filename, file_size, area_shortcode, disk_path }`). Maximum 50 files. Batch persists across file browser sessions within the same call. B key triggers batch download from either list or detail view.

**Dumb Terminal**: Numbered list with 20-line paging, text-mode detail, `D#` download command, `S` search, `M` mark read.

### fileBatchDownload

Standalone sub-module for batch downloads (can be invoked as a separate menu command). Shows batch summary, resolves all file paths, runs single `ZmodemProtocol.send()` with all paths, increments download counts on success, clears batch.

### fileUpload

Standalone upload sub-module. Validates area selection and upload access, runs `ZmodemReceiveProtocol.receive()` into staging dir, processes each received file (hash, dupe check, move, describe, create entry).

---

## Web Interface

### User-Facing Routes (`/files`)

| Method | Route | View | Description |
|--------|-------|------|-------------|
| GET | `/files` | `files/index` | File group listing (filtered by read access, new counts) |
| GET | `/files/group/:shortcode` | `files/groups/view` | Areas in a group (filtered, new counts, upload indicators) |
| GET | `/files/area/:shortcode` | `files/areas/view` | File listing in area (paginated, advances scan pointer) |
| GET | `/files/view/:uuid` | `files/view` | Single file detail (breadcrumb to area/group) |
| GET | `/files/download/:uuid` | — | File download (increments count, `res.download()`) |
| GET | `/files/area/:shortcode/files.json` | — | JSON pagination (sortable, advances pointer) |
| GET | `/files/area/:shortcode/upload` | `files/upload` | Upload form (gated by upload access) |
| POST | `/files/area/:shortcode/upload` | — | Handle upload (multer → staging → area dir) |

Shared middleware injects `boardname`, `faviconlink`, `currentPath`, `DateTime`, `ismobile`, `pmUnreadCount`.

### Admin Routes (`/admin`)

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/admin/fileGroups` | List all file groups |
| POST | `/admin/fileGroup/new` | Create file group |
| GET | `/admin/fileGroup/:shortcode` | View group detail + areas |
| POST | `/admin/fileGroup/:shortcode/update` | Update group |
| POST | `/admin/fileGroup/:shortcode/delete` | Delete group (optional disk cleanup) |
| POST | `/admin/fileGroups/recalculateAreaCounts` | Force area count recalc |
| POST | `/admin/fileGroup/:shortcode/newArea` | Create area in group |
| GET | `/admin/fileAreas` | List all areas across groups |
| GET | `/admin/fileArea/:shortcode` | View area detail (entries, network mappings, resolved path) |
| POST | `/admin/fileArea/:shortcode/update` | Update area |
| POST | `/admin/fileArea/:shortcode/delete` | Delete area (optional disk cleanup) |
| POST | `/admin/fileEntry/:uuid/update` | Update file entry metadata |
| POST | `/admin/fileEntry/:uuid/delete` | Delete entry (optional disk file removal) |
| POST | `/admin/fileEntry/:uuid/move` | Move entry to different area (moves file on disk) |

Network area mappings and peer file subscriptions are managed through the existing network/peer admin pages (inline in `/admin/networks/:shortcode`).

---

## Key Design Decisions

### Single `file_entries` Table (vs per-area tables)

The message system creates per-area backing tables (`mb_<shortcode>_msgs`, `mb_<shortcode>_threads`) because message areas need different schemas, threading behavior, and high-volume partitioning. File areas have uniform schemas and lower write volume, so a single table with `area_id` FK is simpler, avoids DDL on area creation, and enables cross-area search.

### `file_distribution` Join Table

Rather than embedding distribution state in `file_entries` or `source_data`, a separate join table tracks per-peer delivery status. This allows independent retry/skip per peer, status history, and clean separation of concerns. The pattern mirrors how message networking tracks per-peer export state.

### TIC on the Toss Queue

TIC processing runs on the existing `toss` BullMQ queue alongside FTN/QWK/NNTP message tossing. This keeps all networking I/O in the Worker process and reuses the existing job infrastructure. The `tic:inbound` and `tic:outbound` job names are distinct from message toss jobs.

### Scan Pointer (Single-Tier)

Files use a single scan pointer (floor-based) without the second thread-pointer tier that messages have. Files have no threading, so the simpler model suffices. The pointer is the highest `file_entries.id` the user has seen — any file above that ID is "new".

### `source_data` JSONB

Network import metadata (TIC path, seenby, origin, passwords) is stored as JSONB rather than in dedicated columns. This keeps the schema clean for local uploads while preserving full TIC metadata for outbound re-generation without column sprawl.

### External Transfer Tools

ZMODEM transfers use external `sz`/`rz` (lrzsz package) rather than a pure-JS implementation. This is the pragmatic choice for protocol correctness and compatibility with terminal clients. The `BaseProtocol` class handles the spawn/pipe/rawmode lifecycle.

---

## Known Issues

### SyncTERM ZMODEM Upload Bug

SyncTERM has a known issue with ZMODEM uploads where the protocol handshake may not complete properly through WebSocket connections. The `ZmodemReceiveProtocol` currently uses `receiveIntoRaw` (raw pipes) rather than a PTY-based approach. The `receiveInto` method with node-pty exists in `BaseProtocol` as an alternative but is not currently wired into the receive path.

### `rz` TTY Requirement

The `rz` command may require a TTY for proper ZMODEM handshaking. The current raw pipes approach (`receiveIntoRaw`) works in some configurations but may fail in others. The `BaseProtocol.receiveInto()` method provides a PTY-based alternative using node-pty.

### Cross-Area Search

`searchEntries()` supports searching within a single area or globally, but the web interface currently only exposes per-area search. Global search across all accessible areas is not yet available in the web UI.

---

## Future Development

### Planned/Possible Enhancements

- **Global file search** — web route for cross-area search with access filtering
- **Maintenance tasks** — `--regen-file-html` for regenerating `long_desc_html`, `--recalc-file-stats` for refreshing all area stats
- **Additional archive formats** — RAR, 7z, ARJ, LHA support in `fileDescExtractor.js`
- **Upload protocol improvements** — resolve SyncTERM ZMODEM receive compatibility
- **File newscan** — terminal newscan integration for new file notifications (user_file_subscriptions infrastructure is in place)
- **QWK/NNTP file support** — currently TIC-only for network distribution
