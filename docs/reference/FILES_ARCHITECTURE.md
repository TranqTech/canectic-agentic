# Canectic BBS — File Area System Architecture Reference

## Overview

The file area system provides hierarchical file storage and distribution across both terminal (ANSI/CP437/UTF-8) and web interfaces. Files are organized into groups and areas, stored on disk with metadata in PostgreSQL, and distributed to FTN peers via TIC file echo processing.

Unlike the message system's per-area backing tables, the file system uses a **single `file_entries` table** with an `area_id` foreign key. This simplifies queries and avoids the schema-per-area complexity, since file areas do not need the threading or per-area column customization that message areas require.

The file system integrates with the three-process model:

- **Gateway** — serves web file routes (`/files/*`), admin CRUD routes (`/admin/fileGroup/*`, `/admin/fileArea/*`, `/admin/fileEntry/*`), and runs terminal file handlers (area selector, file browser, batch download, upload)
- **Worker** — consumes `tic:inbound`, `tic:outbound` and `outbound-sweep` jobs on the `toss` BullMQ queue, runs the TIC tosser
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
| `fileEntries.js` | File entry CRUD, search, dupe checking. `addFileEntry`, `getEntryByUUID`, `getEntryById`, `getEntriesForArea` (paginated with configurable sort), `getEntryCount`, `searchEntries` (ILIKE across filename, short_desc, long_desc, full_text), `checkDupe` (by area + filename + optional CRC-32), `updateEntry`, `incrementDownloadCount`, `deactivateEntry`, `flagEntry`, `deleteEntry` (cascading distribution row cleanup), `getNewFileCount` (entries above scan pointer), `getNewEntriesForArea` (the entries themselves, `oldestFirst` for a catch-up listing that advances a pointer as it goes), `newEntriesOrderBy`, `getMaxIdForArea`. |
| `fileDistribution.js` | Outbound file distribution tracking. Each row = one file to one peer. `createDistributionRows` (bulk, idempotent via existence check), `getPendingForConnection`, `getAllPending` (joined with file_entries + peer_connections), `getDistributionForEntry`, `markSent`, `markFailed`, `markSkipped`, `retryFailed` (returns the count reset, and THROWS on a database error, unlike the other writes here, because it is a sysop waiting on a button), `summaryForConnection` (status counts plus recent failures, for the peer page), `partitionByAreatag` (pure). Status lifecycle: `pending` -> `sent` / `failed` / `skipped`. **`failed` is terminal**: the outbound pass reads pending rows only, so nothing retries a failed row on its own. That is why `partitionByAreatag` exists: the outbound pass needs an areatag to build a descriptor and fails a row without one, so a peer subscribed to an area not carried on its network used to collect one permanent dead row per file. All three creation paths (TIC inbound, web upload, terminal upload) now filter through it and log the mismatch. |
| `fileNetworkAreas.js` | Maps file areas to FTN networks with areatags. `getAreaByTag(networkId, areatag)` — resolves inbound TIC area tags. `getNetworksByFileArea`, `getMappingsForNetwork`, `getMapping`, `getMappingById`, `addMapping` (dupe checks on both network+area and network+areatag), `removeMapping`, `updateMapping`. |
| `filePeerSubscriptions.js` | Per-connection subscription state for file areas. Two-flag model: `allowed` (sysop permits) + `enabled` (sysop activates). `getSubscriptionsByConnection`, `getSubscribedConnections` (requires both allowed AND enabled AND connection active), `isSubscribed`, `setSubscriptions` (bulk toggle by field), `syncConnectionToFileAreas` (bootstrap missing rows), `allowAllFileAreas`, `enableAllAllowed`, `syncFileAreaToConnections` (propagate new area to all connections on a network), `removeSubscriptionsForFileArea`. |
| `userFilePointers.js` | Per-user per-area scan pointers (mirrors `userMsgPointers.js`). Floor-based: any file with `id <= scan_pointer` is considered "seen". `ensureConstraintsAndIndexes` (table bootstrap), `advancePointer` (GREATEST — only moves forward; coerces its argument, since postgres returns ids as strings), `highestId(rows)` (the numeric max id of a result set — the obvious loop comparing `row.id > max` turns lexicographic after the first assignment, where `'9' > '37'`, which pinned pointers below the true maximum and left new-file counts that nothing could clear), `markAreaRead` (jump to current max), `getPointer`, `getNewCount`, `initPointersForArea` (pre-populate all users when area created, pointer=0), `initPointersForUser` (pre-populate all areas when user created, pointer=max to hide history). |

### Utilities

| File | Purpose |
|------|---------|
| `fileHasher.js` | `computeCRC32` (via `zlib.crc32`, uppercase hex, zero-padded to 8), `computeSHA256`, `computeHashes` (both in one read). Used by TIC tosser, web upload, terminal upload. |
| `fileDescExtractor.js` | `extractDescription(filePath)` — extracts FILE_ID.DIZ from ZIP archives (via `adm-zip`), returns `{ long_desc, long_desc_html, short_desc }`. `long_desc_html` generated via `formatBodyHtml()` (shared with message system). `applyDescriptions(entryObj, filePath)` — mutates entry object in place, only filling empty fields. |

### Native Transfer Engines

| File | Purpose |
|------|---------|
| `transfers/constants.js` | Shared byte constants for XMODEM and ZMODEM protocols. |
| `transfers/crc.js` | CRC-16 (CCITT), CRC-32, and `crc16zmodem()` (lrzsz-variant reference) routines used by both engines. |
| `transfers/xmodem.js` | `XmodemEngine` — XMODEM-CRC and XMODEM-1K send/receive state machine. Single-file protocol. |
| `transfers/zmodem.js` | `ZmodemEngine` — ZMODEM send/receive with ZDLE escaping, hex/binary/ZBIN32 headers, CRC-16/CRC-32, streaming, crash recovery, ZCRC support. CRC mode pre-selected per session via `call.zmodem_crc_mode` (set during terminal negotiation). Auto-fallback chain: ZBIN32 -> ZBIN+CRC-32 -> ZBIN+CRC-16 (3s ZFILE timeout per step). Default 1024-byte subpackets. |

### Transfer Protocol Wrappers

| File | Purpose |
|------|---------|
| `protocols/xmodem_native.js` | StreamAdapter wrapper bridging `XmodemEngine` to call objects. Suppresses terminal output during transfers, resets inactivity timeouts on data flow. |
| `protocols/zmodem_native.js` | StreamAdapter wrapper bridging `ZmodemEngine` to call objects. Same output suppression and timeout reset pattern. |
| `protocols/base.js` | `BaseProtocol` — legacy lrzsz fallback. EventEmitter-based executor with raw mode management and child process spawning. |
| `protocols/zmodem.js` | `ZmodemProtocol` — lrzsz fallback, spawns `sz` for ZMODEM send. |
| `protocols/zmodem_receive.js` | `ZmodemReceiveProtocol` — lrzsz fallback, spawns `rz` for ZMODEM receive. |

### Terminal Handlers

| File | Purpose |
|------|---------|
| `menucommands/fileAreaSelector.js` | Lightbar area selector. Flattened group/area list, cursor navigation, incremental search, new file counts per area. Persists selection to `call.file_group`/`call.file_area` and user record. Dumb terminal fallback with numbered list. |
| `menucommands/fileBatchCheck.js` | Login flow batch check. If `call.file_batch` is non-empty at login, prompts user to download pending batch with hangup-after-transfer option. |
| `menucommands/fileBrowser.js` | Two-state file browser (FILE_LIST / FILE_DETAIL). Lightbar file list with columns (filename, desc, size, date), file detail view with scrollable long description. Download (single and batch) with protocol selection prompt (XMODEM/ZMODEM) and hangup-after-transfer prompt, batch tagging (T key, max 50 files stored on `call.file_batch`), search (DB-backed via ILIKE when >= 2 chars), mark area read. Lazy pagination (loads 50 at a time, load-ahead on scroll). Dumb terminal fallback with 20-line paging. |
| `menucommands/fileBatchDownload.js` | Standalone batch download module. State machine: `hangup_ask → downloading → result → done`. Shows batch summary, protocol selection and hangup prompts, resolves disk paths, runs native engine send with all paths, increments download counts, clears batch on success. Auto-disconnects or returns based on hangup choice. |
| `menucommands/fileUpload.js` | Terminal upload handler. Checks upload access, prompts for protocol selection (XMODEM/ZMODEM), receives files via native engine into staging dir, then for each file: hash, dupe check, move to area dir, extract FILE_ID.DIZ, create entry, update stats. XMODEM uploads prompt for filename. |
| `menucommands/fileSearch.js` | Terminal file search with scope selection (area/group/global), search input, lightbar results with detail view. Filters by browse access. Supports download with protocol selection (with hangup-after-transfer prompt on status row) and batch tagging from search results. |

### Tosser

| File | Purpose |
|------|---------|
| `middleware/tossers/ticTosser.js` | FTN TIC file echo processor. **Inbound** (`tossInbound`): scan inbound dir for `.tic` files, parse TIC format, resolve source connection, validate password, resolve areatag via `file_network_areas`, verify CRC-32, dupe check, handle Replaces, move file to area dir, create entry, extract FILE_ID.DIZ if no LDesc, create distribution rows (excluding source + seenby), update area stats. **Outbound** (`tossOutbound`): get all pending distributions, group by connection, for each: resolve areatag, build TIC descriptor (append path/seenby), stage TIC + file in outbound dir (hardlink preferred, copy fallback), mark sent, signal mailer for CRASH connections. |
| `models/filefix.js` | FileFix automated TIC file area manager. Processes netmail commands from FTN peers to subscribe/unsubscribe file distribution areas. Same command set as AreaFix (+AREATAG, -AREATAG, %LIST, %QUERY, %AREAS, %HELP, %PAUSE, %RESUME). Authenticates via `areafix_password` in `connection_data`. Operates on `file_network_areas` + `file_peer_subscriptions`. See `NETWORKING_ARCHITECTURE.md` for full AreaFix/FileFix documentation. |

### Routes

| File | Purpose |
|------|---------|
| `routes/files.js` | User-facing file routes. Group listing (`/files`), new files (`/files/new`), area listing (`/files/group/:shortcode`), file listing (`/files/area/:shortcode`), file detail (`/files/view/:uuid`), download (`/files/download/:uuid`), JSON pagination (`/files/area/:shortcode/files.json`), upload form + POST (`/files/area/:shortcode/upload`). Access checks on all routes. |
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

All three levels support `%X` variable substitution via `configvars.js` (e.g. `%M` for DOSemu drive_c, `%!` for door base directory). Tilde (`~`) expansion is also applied. This allows file areas to target DOSemu or door game directories directly -- for example, a group `base_dir` of `%M/doors` or an area `sub_dir` of `%M/lord/files`.

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
2. User prompted for protocol selection (XMODEM / ZMODEM). XMODEM uploads also prompt for filename.
3. Native engine receives file(s) into staging dir via StreamAdapter wrapper
4. After transfer, scans staging dir for received files
5. For each file: hash, dupe check, move to area dir, `applyDescriptions()`, `addFileEntry()` with `source_data: { upload_method: 'terminal', upload_ip }`
6. `updateStatsForArea()` refreshes stats

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

1. In `fileBrowser` or `fileSearch`, user presses `D` on a file (list or detail view)
2. Path resolved, existence verified
3. User prompted for protocol selection (XMODEM / ZMODEM)
4. User prompted: "Hang up after transfer?" `[Y/n]` (Enter defaults to Yes)
5. Native engine sends file via StreamAdapter wrapper
6. On success: `incrementDownloadCount()`
7. If hangup chosen: auto-disconnect after 1500 ms delay. Otherwise: "press any key" returns to previous view.

### Download — Terminal (Batch)

1. User tags files with `T` in fileBrowser (stored on `call.file_batch`, max 50)
2. User presses `B` in fileBrowser, or invokes `fileBatchDownload` menu command, or is prompted at login via `fileBatchCheck`
3. User prompted for protocol selection (XMODEM / ZMODEM)
4. User prompted: "Hang up after transfer?" `[Y/n]` (Enter defaults to Yes)
5. All tagged file paths resolved and existence verified
6. Native engine sends files (ZMODEM supports batch natively; XMODEM sends sequentially)
7. On success: increment counts for all files, clear batch
8. If hangup chosen: auto-disconnect after 1500 ms delay. Otherwise: "press any key" returns to previous view.

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

Three-tier access model, extending the message system's two-tier pattern:

### Browse Access (`checkFileAreaBrowseAccess` / `checkBrowseFlags`)

1. `user.security >= area.browse_security` (falls back to `read_security` if not set)
2. User has ALL flags in `browse_perm_flags` (falls back to `read_perm_flags`)
3. User has NONE of the flags in `browse_rest_flags` (falls back to `read_rest_flags`)

Applied to: group listing, area listing, file listing in area, search results filtering, terminal file area selector.

### Download Access (`checkFileAreaReadAccess`)

1. `user.security >= area.read_security`
2. User has ALL flags in `read_perm_flags`
3. User has NONE of the flags in `read_rest_flags`

Applied to: file detail view, file download, file info JSON endpoint.

### Upload Access (`checkFileAreaUploadAccess` / `checkUploadAccess`)

1. `user.security >= area.post_security`
2. User has ALL flags in `post_perm_flags`
3. User has NONE of the flags in `post_rest_flags`

Applied to: upload form display, upload POST, terminal upload handler.

The browse tier allows users to see files they cannot download. If `browse_security` / `browse_*_flags` are not set (null), they fall back to the download-tier values for backward compatibility.

Groups and areas use the same column names so the same check functions work on both. Admin UI labels: "Browse Security" / "Download Security" / "Upload Security".

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
   9b. LOOP CHECK: our own address in Path means the file has been
       through here before — tossed, not imported, not forwarded.
       Path only: Seenby always lists us (see Loop prevention)
  10. Dupe check (area + filename case-insensitively + CRC-32, or CRC-32 + size
      under any name)
  11. Find the entry Replaces names (not yet deactivated)
  12. Move file to area directory (placeInboundFile): the replaced entry's
      file is set aside first, so a same-name replacement keeps its name;
      a same-name file that is NOT being replaced still gets NAME_N
  13. Extract descriptions (TIC LDesc or FILE_ID.DIZ)
  14. Create file_entries row. On failure: roll the files back, TIC + file
      to bad. On success: deactivate the replaced entry, delete its file
  15. Create file_distribution rows for subscribed peers
      (excluding source connection, everything in Seenby/Path/From compared
       by normaliseAddress — see forwardExclusions — and any peer whose
       network carries no areatag for this area — see partitionByAreatag)
  16. Move .tic to ftn/tossed/
  17. Update area stats
  18. Publish FILES_IMPORTED event
  19. Enqueue tic:outbound if anything was processed, to forward to downlinks
```

Step 19 is what makes this board a hub rather than a leaf. Steps 15 and 19 are
separate for a reason worth remembering: step 15 records the *intent* to send,
and nothing about a pending row causes it to be sent. Between shipping and
0.9.6a this step did not exist and neither did TIC in the outbound sweep, so
every file received was filed, queued and then left, and no downlink of a board
whose users did not upload ever received anything.

### Loop prevention

A file that reads as new is imported **and hatched onward to every subscribed
downlink**. In a mesh that means an unrecognised file does not simply get stored
twice: it circulates, and every system that fails to recognise it forwards it
again. Two independent brakes, answering different questions:

| Guard | Question | Survives retention? |
|---|---|---|
| Path (`ticHasPassedThrough`) | Has this file been through **this system** before? | Yes — it travels with the file |
| Dupe check (`fileEntries.checkDupe`) | Does this area hold this file **now**? | No — `file-maintenance` hard-deletes rows |

Neither substitutes for the other, which is why both are needed. The dupe check
consults a table that retention prunes, so a file held, pruned, and then offered
again by a peer who still has it reads as brand new to it. Only the Path stamp
survives that, because it lives in the file rather than here. We add our
address to Path on every TIC we send.

**Seenby is not a loop signal.** It lists the systems a file has been *sent*
to, and a sender adds each recipient before sending (our outbound builder adds
the destination peer, and every uplink does the same). So every TIC a downlink
receives names that downlink in Seenby. The guard shipped in 0.9.7a checking
Seenby as well as Path, and from then until 0.9.11a it refused every file an
uplink sent, logging it at level 2 as a loop and counting it as a dupe: the
hub's daily nodelists from 1:153/757 never reached their areas and nothing
read as an error. Seenby is read on inbound for one thing, choosing who *not*
to forward to (step 15).

Both brakes had holes before this. The loop check did not exist at all. And the dupe check compared filenames case-sensitively and
required an exact name match even when the CRC matched, so a file coming back
from a chain that had uppercased it (which chains do — see the same note on
`ftnReleaseSource.js`) read as new with an identical checksum.

Matching rules now:

- Name compared with `LOWER()`, so case changes in transit do not defeat it
- **or** CRC-32 **and** size both matching, under any name at all
- `active` is deliberately ignored, so a file deactivated by a `Replaces` still
  counts as seen
- Size is in the content comparison on purpose: CRC-32 alone is too weak to
  reject a file over, since across ten thousand files in one area the chance of
  some pair colliding is around one percent, and a false dupe silently refuses a
  legitimate file

### Outbound Flow

```
Worker: tic:outbound job
  1. Get all pending file_distribution rows
  2. Group by peer_connection_id
  3. For each connection:
     a. Validate connection is active and has FTN address
     b. Get system address for the network
     c. Resolve zone-aware outbound directory (ftn/out/ for zone 1, ftn/out.NNN/ for others)
     d. For each pending file:
        - Resolve areatag via file_network_areas
        - Resolve file on disk via resolveAreaPath
        - Build TIC descriptor (append our address to path/seenby)
        - Write .tic file to zone outbound dir
        - Copy/hardlink attached file to zone outbound dir
        - Create .flo flow file entry for both TIC + attached file (^ = delete after send)
        - Mark distribution row as 'sent'
     e. Enqueue bso-scan job to trigger mailer delivery
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
| `tic:inbound` | `toss` | Mailer file arrival, `scan-inbound` maintenance job, admin | `ticTosser.tossInbound()` |
| `tic:outbound` | `toss` | End of `tic:inbound` (forwarding), local upload to a networked area, file-area rescan, admin | `ticTosser.tossOutbound()` |
| `outbound-sweep` | `toss` | Repeatable, `outbound_toss_interval` (120 min) | `outboundSweep.runOutboundSweep()`, which includes `ticTosser.tossOutbound()` |

Job ID deduplication: `tic-inbound--<connectionUUID or timestamp>`, `tic-outbound--<connectionUUID or timestamp>`.

**Both consumers of the `toss` queue must handle every one of these names.** There are two: `bin/worker.js` and, under `PROCESS_MODE=embedded`, `src/queues/embedded.js`. A name missing from either does not raise anything — BullMQ delivers the job, the switch falls through to `default`, one line is logged at level 3, and the job is marked complete. The queue drains and the work never happens. `tests/tossJobCoverage.test.js` derives the required set from the producers and holds both switches to it.

`tic:outbound` is reachable two ways on purpose. The signal at the end of `tic:inbound` is the fast path, and the outbound sweep is the backstop for anything it misses: a worker restarted mid-toss, a signal that failed to enqueue, rows left pending by a rescan. Distribution rows are inert until something stages them, so a file echo with only the on-demand path is one missed signal away from stopping for ever, with nothing to show for it.

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
2. Set `call.rawmode = true` and `call.rawtarget` to forward data to the engine
3. Engine output sent to client via `call.cmds.senddata()`
4. On completion, restore previous raw mode state

The StreamAdapter wrappers additionally suppress terminal output during transfers (preventing protocol bytes from being interpreted as terminal commands) and reset call inactivity timeouts on data flow.

### Send vs Receive

- **Send (ZMODEM)**: ZmodemEngine handles ZRINIT negotiation, ZFILE/ZDATA/ZEOF/ZFIN sequence, ZDLE escaping, streaming subpackets. Initial CRC mode pre-selected from `call.zmodem_crc_mode` (terminal-based: modern terminals get ZBIN32+CRC-32, legacy/unknown get ZBIN+CRC-16). Auto-fallback chain on ZFILE timeout (3s per step): ZBIN32 -> ZBIN+CRC-32 -> ZBIN+CRC-16. ZEOF timeout is proportional (1s/KB, min 60s). Default 1024-byte subpackets for legacy compatibility.
- **Send (XMODEM)**: XmodemEngine waits for receiver initiation ('C' for CRC mode, NAK for checksum), sends 128-byte or 1024-byte blocks with CRC-16.
- **Receive (ZMODEM)**: ZmodemEngine sends ZRINIT with capability flags, receives ZDATA stream, validates CRC per subpacket, supports crash recovery via ZRPOS.
- **Receive (XMODEM)**: XmodemEngine sends 'C' to initiate CRC mode, validates each block, sends ACK/NAK. Prompts user for filename since XMODEM does not transmit filenames.

### Safety

- Inactivity timeout reset on data flow via StreamAdapter wrappers
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

**Hangup-After-Transfer Prompt**: All download paths (D key single file, B key batch) prompt for protocol selection (XMODEM/ZMODEM) and display a "Hang up after transfer?" `[Y/n]` prompt. Enter defaults to Yes. After a successful transfer, if the user chose hangup the system auto-disconnects after a 1500 ms delay; otherwise it shows "press any key" and returns to the previous view. Managed via `_hangupPrompt`/`_hangupResult` flags on the browser instance.

**Dumb Terminal**: Numbered list with 20-line paging, text-mode detail, `D#` download command, `S` search, `M` mark read.

### fileBatchCheck

Login flow batch check. If `call.file_batch` is non-empty when the user logs in, prompts to download the pending batch. Includes the same hangup-after-transfer prompt and auto-disconnect behaviour as other download paths.

### fileBatchDownload

Standalone sub-module for batch downloads (can be invoked as a separate menu command). Implements a state machine: `hangup_ask → downloading → result → done`. Shows batch summary, presents protocol selection and hangup prompts, resolves all file paths, runs native engine send with all paths, increments download counts on success, clears batch. Auto-disconnects after 1500 ms if hangup was chosen, otherwise returns on keypress.

### fileUpload

Standalone upload sub-module. Validates area selection and upload access, prompts for protocol selection (XMODEM/ZMODEM), receives files via native engine into staging dir, processes each received file (hash, dupe check, move, describe, create entry). XMODEM uploads prompt for filename.

---

## Web Interface

### User-Facing Routes (`/files`)

| Method | Route | View | Description |
|--------|-------|------|-------------|
| GET | `/files` | `files/index` | File group listing (filtered by read access, new counts, total-new button) |
| GET | `/files/new` | `files/new` | New files across subscribed areas, with a per-area preview. Read-only: advances no pointer |
| GET | `/files/group/:shortcode` | `files/groups/view` | Areas in a group (filtered, new counts, upload indicators) |
| GET | `/files/area/:shortcode` | `files/areas/view` | File listing in area (paginated, advances scan pointer). `?new=1` lists only files above the pointer, oldest first |
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

### Native Transfer Engines

File transfers use native JavaScript XMODEM and ZMODEM engines (`src/transfers/`) rather than external tools. The engines are protocol-agnostic and testable in isolation. StreamAdapter wrappers (`src/protocols/xmodem_native.js`, `zmodem_native.js`) bridge engines to call objects. The lrzsz-based wrappers remain as fallback. ZMODEM CRC mode is pre-selected per session during terminal negotiation (`call.zmodem_crc_mode`) with an auto-fallback chain for misdetected terminals. See `DOWNLOAD_PROTOCOL_DESIGN.md` section 2.5.

### Cross-Area Search

`searchEntries()` supports searching within a single area or globally, but the web interface currently only exposes per-area search. Global search across all accessible areas is not yet available in the web UI.

---

## Maintenance

### File Maintenance Worker Job

The `file-maintenance` job on the `maintenance` BullMQ queue runs two cleanup functions:

- **`cleanDuplicates()`** -- Scans for duplicate file entries within the same area (matching filename + CRC-32). Deactivates the older duplicate, keeping the most recent entry active.
- **`cleanMissingFiles()`** -- Checks each active file entry's resolved disk path. If the file no longer exists on disk, the entry is deactivated. Logs each removal for audit.

Both functions are also available for direct invocation from admin routes.

### SMB Import

Synchronet message base (SMB) import support for migrating from Synchronet BBS:

- **`src/utils/smbParser.js`** -- Parser for Synchronet's SMB (Synchronet Message Base) binary format. Reads `.shd` (header) and `.sdt` (data) files, extracts message metadata and body text.
- **`src/maintenance/smbImport.js`** -- Import orchestrator. Reads SMB files, converts messages to Canectic format, imports into target message areas with `formatBodyHtml()` for body_html generation.
- **Admin UI** at `/admin/import/msgbase` -- Upload interface for SMB file sets, area selection, import progress display.

---

## Filebone Registry

Per-network registry of available file echo areas, imported from FILEBONE.NA or similar area list files. Identical architecture to message echolists (see `NETWORKING_ARCHITECTURE.md` for full details).

- Tables: `file_echolists` (list definitions), `file_echolist_areas` (area entries with historical tracking)
- Model: `src/models/fileEcholist.js`
- `local_area_id` nullable FK links entries to `file_areas` when locally carried
- Sync hooks in `fileNetworkAreas.addMapping()` / `removeMapping()` maintain `local_area_id`
- Admin: `/admin/filebones` (overview), `/admin/filebone/:networkId` (per-network), `/admin/filebone/view/:id` (browse + import)

---

## Future Development

### Planned/Possible Enhancements

- **Additional archive formats** -- RAR, 7z, ARJ, LHA support in `fileDescExtractor.js`
- **File newscan** -- terminal newscan integration for new file notifications (user_file_subscriptions infrastructure is in place)
- **QWK/NNTP file support** -- currently TIC-only for network distribution
