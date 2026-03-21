# Canectic BBS -- File Area System Architecture

## Overview

The file area system adds file distribution capabilities to Canectic BBS, supporting local uploads/downloads via both web and terminal interfaces, and networked file distribution via TIC (FTN file echoes) with extensibility for future protocols.

The architecture mirrors the message group/area pattern established in the codebase: hierarchical groups containing areas, PostgreSQL-backed with the same access control model (security level + permission flags + restriction flags), integrated with the existing peer/network subscription infrastructure, and processed via BullMQ job queues in the Worker process.

For the message platform architecture, see `message_architecture.md`.
For the process model and job queues, see `PROCESS_ARCHITECTURE.md`.
For the networking/tosser stack, see `NETWORKING_ARCHITECTURE.md`.
For the FTN mailer, see `MAILER_ARCHITECTURE.md`.

---

## 1. Database Schema

### 1.1 `file_groups`

Mirrors `message_groups`. Contains file areas. One shortcode per group, unique across the system.

```
id              BIGSERIAL PRIMARY KEY
uuid            VARCHAR(255)
name            VARCHAR(255)
description     VARCHAR(255)
shortcode       VARCHAR(255)          -- unique, uppercased
base_dir        VARCHAR(512)          -- optional base directory override for this group
read_security   INTEGER               -- min security level to list/browse
post_security   INTEGER               -- min security level to upload
created_at      TIMESTAMPTZ
updated_at      TIMESTAMPTZ
area_count      INTEGER               -- denormalized, recalculated like message_groups
active          BOOLEAN
created_by_uuid VARCHAR(255)
created_by_name VARCHAR(255)
read_perm_flags JSONB                 -- JSON array of required permission flags for browsing
read_rest_flags JSONB                 -- JSON array of restriction flags that deny browsing
post_perm_flags JSONB                 -- JSON array of required permission flags for uploading
post_rest_flags JSONB                 -- JSON array of restriction flags that deny uploading
```

**Schema file**: `db/schema/tablecolumns/file_groups.conf`

**Naming note**: `read_security`/`post_security` map to "download"/"upload" in the file context but retain the message area naming convention for consistency across the access control system. The admin UI labels them as "Download Security" / "Upload Security".

### 1.2 `file_areas`

Mirrors `message_areas`. Each area belongs to one group and represents a topical file collection (e.g., "DOS Games", "Network Utilities", "DOVE-NET Files").

```
id              BIGSERIAL PRIMARY KEY
uuid            VARCHAR(255)
group_shortcode VARCHAR(255)          -- denormalized for fast lookups (mirrors message_areas)
group_uuid      VARCHAR(255)
group_id        INTEGER               -- FK to file_groups
name            VARCHAR(255)
description     VARCHAR(255)
shortcode       VARCHAR(255)          -- unique, uppercased
sub_dir         VARCHAR(255)          -- subdirectory name under group base_dir (or global root)
read_security   INTEGER
post_security   INTEGER
created_at      TIMESTAMPTZ
updated_at      TIMESTAMPTZ
active          BOOLEAN
created_by_uuid VARCHAR(255)
created_by_name VARCHAR(255)
file_count      INTEGER DEFAULT 0     -- denormalized, recalculated periodically
total_bytes     BIGINT DEFAULT 0      -- denormalized total size
last_upload     TIMESTAMPTZ           -- most recent file added
last_filename   VARCHAR(255)          -- most recent filename
last_uploader   VARCHAR(255)          -- who uploaded the most recent file
newscan_default BOOLEAN DEFAULT true   -- included in file newscan by default
read_perm_flags JSONB
read_rest_flags JSONB
post_perm_flags JSONB
post_rest_flags JSONB
```

**Schema file**: `db/schema/tablecolumns/file_areas.conf`

**Design decision -- no per-area backing tables**: Unlike message areas which create `mb_<shortcode>_msgs` and `mb_<shortcode>_threads` tables per area, file entries all live in a single `file_entries` table with an `area_id` foreign key. Rationale:

1. Message areas need per-area tables because each area has its own `id` sequence for scan pointers and HWM tracking. File areas use per-area scan pointers (`user_file_pointers`) on the global `file_entries.id` column — the `area_id` filter on queries makes non-contiguous IDs work correctly without per-area tables.
2. File entry counts are orders of magnitude lower than message counts (thousands vs. millions). A single indexed table handles the load.
3. Simpler schema management -- no dynamic table creation/deletion.
4. Cross-area search (e.g., "find all files matching *.zip") becomes a simple query rather than a UNION across dynamic tables.

### 1.3 `file_entries`

The core file record. One row per file in the system.

```
id              BIGSERIAL PRIMARY KEY
uuid            VARCHAR(255)
area_id         INTEGER               -- FK to file_areas
area_shortcode  VARCHAR(255)          -- denormalized for convenience

-- File identity
filename        VARCHAR(255) NOT NULL  -- filename as stored on disk
disk_path       VARCHAR(512)          -- relative path from area directory (usually just filename)
file_size       BIGINT                -- size in bytes
file_date       TIMESTAMPTZ           -- original file date (from filesystem or TIC)
file_hash_crc32 VARCHAR(16)           -- CRC-32 (TIC standard, fast dupe check)
file_hash_sha256 VARCHAR(64)          -- SHA-256 (modern integrity check, optional)

-- Descriptions
short_desc      VARCHAR(255)          -- one-line description for compact listings
long_desc       TEXT                  -- multi-line extended description (file_id.diz content)
long_desc_html  TEXT                  -- pre-rendered HTML of long_desc (same pattern as body_html)
full_text       TEXT                  -- extracted text content for full-text search (nullable)

-- Tracking
upload_date     TIMESTAMPTZ           -- when this entry was added to the system
uploader_uuid   VARCHAR(255)          -- user UUID (null for network imports)
uploader_name   VARCHAR(255)          -- display name of uploader
download_count  INTEGER DEFAULT 0

-- Source tracking (protocol-agnostic)
source_type     VARCHAR(32)           -- 'local', 'ftn', 'qwk', 'meshtastic', etc.
source_network_id INTEGER             -- FK to message_networks (nullable)
source_peer_id  INTEGER               -- FK to peers (nullable)
source_data     JSONB                 -- protocol-specific import metadata (see 1.3.1)

-- State
active          BOOLEAN DEFAULT true  -- soft-delete (admin can hide files)
flagged         BOOLEAN DEFAULT false -- flagged for review (virus scan fail, etc.)

-- Timestamps
created_at      TIMESTAMPTZ
updated_at      TIMESTAMPTZ
```

**Schema file**: `db/schema/tablecolumns/file_entries.conf`

**Indexes** (defined in `tableTools` or manual migration):
- `idx_file_entries_area_id` on `area_id`
- `idx_file_entries_filename` on `filename`
- `idx_file_entries_hash_crc32` on `file_hash_crc32` (dupe detection)
- `idx_file_entries_source` on `(source_type, source_network_id)`
- Full-text index on `full_text` using `tsvector` (future, when search is implemented)

#### 1.3.1 `source_data` JSONB structure

Protocol-specific metadata stored in the `source_data` column. Keeps the main schema protocol-agnostic while preserving all import details.

**FTN/TIC source:**
```json
{
  "tic_origin": "1:123/456",
  "tic_from": "1:123/456",
  "tic_area": "DOVE-NET_FILES",
  "tic_replaces": "oldfile.zip",
  "tic_magic": "DOVE_LATEST",
  "tic_path": ["1:123/456", "1:1/1"],
  "tic_seenby": ["1:123/456", "1:1/1", "1:2/3"],
  "tic_pw": "verified",
  "tic_ldesc": ["line1", "line2"],
  "tic_crc": "1A2B3C4D"
}
```

**Local upload source:**
```json
{
  "upload_ip": "192.168.1.1",
  "upload_method": "web"
}
```

**Future protocol source** (e.g., Meshtastic):
```json
{
  "mesh_node_id": "!abcd1234",
  "mesh_channel": "files"
}
```

### 1.4 `file_distribution`

Tracks which peers have received which files. This is the outbound distribution tracking equivalent of `peer_area_subscriptions.msg_idx` for messages, but file-level rather than sequential-index-level because files are not sequentially ordered the same way messages are.

```
id              BIGSERIAL PRIMARY KEY
file_entry_id   INTEGER               -- FK to file_entries
peer_connection_id INTEGER            -- FK to peer_connections
sent_at         TIMESTAMPTZ           -- when the file was sent/offered
protocol        VARCHAR(32)           -- 'ftn', 'tic', etc.
status          VARCHAR(32) DEFAULT 'pending'  -- 'pending', 'sent', 'failed', 'skipped'
attempts        INTEGER DEFAULT 0
last_attempt    TIMESTAMPTZ
error_message   TEXT                  -- last error if failed
created_at      TIMESTAMPTZ
```

**Schema file**: `db/schema/tablecolumns/file_distribution.conf`

**Indexes**:
- `idx_file_dist_entry` on `file_entry_id`
- `idx_file_dist_conn_status` on `(peer_connection_id, status)`
- `UNIQUE(file_entry_id, peer_connection_id)` -- prevents duplicate distribution rows

**Design decision -- explicit join table vs. sequential HWM**: Messages use `msg_idx` (a sequential high-water mark) because messages are strictly ordered by ID within an area. Files are not necessarily processed in ID order, and individual file transfers can fail and need retry. An explicit join table provides:
- Per-file retry tracking
- Ability to skip individual files without blocking the queue
- Clear audit trail of what was sent where and when
- Works correctly when files are added retroactively or out of order

### 1.5 `file_network_areas`

Maps file areas to networks with file echo tags. Analogous to `network_areas` for messages.

```
id              BIGSERIAL PRIMARY KEY
network_id      INTEGER               -- FK to message_networks
area_id         INTEGER               -- FK to file_areas
areatag         VARCHAR(255)          -- file echo tag (e.g., "DOVE-NET_FILES")
active          BOOLEAN DEFAULT true
created_at      TIMESTAMPTZ
updated_at      TIMESTAMPTZ
created_by_uuid VARCHAR(255)
created_by_name VARCHAR(255)
updated_by_uuid VARCHAR(255)
updated_by_name VARCHAR(255)
```

**Schema file**: `db/schema/tablecolumns/file_network_areas.conf`

**Design decision -- separate table from `network_areas`**: The existing `network_areas` table maps `message_areas` to networks. Creating a parallel `file_network_areas` table keeps the FK relationships clean (`area_id` points to `file_areas` here, `message_areas` there) and avoids adding a `type` discriminator column to the existing table. The admin UI and model code are also separate. The naming pattern (`file_*`) is consistent and makes the schema self-documenting.

### 1.6 `file_peer_subscriptions`

Per-connection subscription state for file areas. Analogous to `peer_area_subscriptions` for messages. Controls which file areas each peer connection is allowed to send/receive.

```
id                   BIGSERIAL PRIMARY KEY
peer_connection_id   INTEGER               -- FK to peer_connections
file_area_id         INTEGER               -- FK to file_areas
allowed              BOOLEAN DEFAULT false  -- sysop allows this area for this peer
enabled              BOOLEAN DEFAULT false  -- peer has requested/activated this area
created_at           TIMESTAMPTZ
updated_at           TIMESTAMPTZ
created_by_uuid      VARCHAR(255)
created_by_name      VARCHAR(255)
updated_by_uuid      VARCHAR(255)
updated_by_name      VARCHAR(255)
```

**Schema file**: `db/schema/tablecolumns/file_peer_subscriptions.conf`

**Design decision -- separate from `peer_area_subscriptions`**: Same rationale as `file_network_areas`. The FK target differs (`file_areas` vs. `message_areas`), and the subscription management lifecycle differs (no `msg_idx` equivalent; distribution is tracked in `file_distribution`).

### 1.7 `user_file_pointers`

Per-user per-area scan pointer for "new files" tracking. Same pattern as `user_msg_pointers` for messages. The pointer stores the highest `file_entries.id` the user has seen in that area. Any file with `id > pointer` in the area is considered "new."

```
id              SERIAL PRIMARY KEY
user_id         INTEGER
area_shortcode  VARCHAR(64)
scan_pointer    INTEGER DEFAULT 0
last_read_at    TIMESTAMP
UNIQUE(user_id, area_shortcode)
```

**Schema file**: `db/schema/tablecolumns/user_file_pointers.conf`

**Indexes**:
- `idx_ufp_user` on `user_id`
- `idx_ufp_area` on `area_shortcode`

**Lifecycle**:
- Pre-populated when a file area is created (all users get a row with pointer=0)
- Pre-populated when a user is created (new user gets rows for all areas with pointer set to current max file ID so existing files don't appear as "new")
- Advanced when the user browses an area (set to the highest file ID visible)
- Advanced when the user marks an area as "caught up"

**New file count query**: `SELECT COUNT(*) FROM file_entries WHERE area_id = $1 AND id > $2 AND active = true`

This works correctly even though `file_entries` is a single table with non-contiguous IDs per area — the `area_id` filter scopes the count to the relevant area, and the pointer value is area-specific.

### 1.8 `user_file_subscriptions`

Per-user newscan subscription overrides for file areas. Same pattern as `user_area_subscriptions` for messages. Allows users to opt in/out of file areas for new-file scanning independently of the area's default.

```
id              SERIAL PRIMARY KEY
user_id         INTEGER
area_shortcode  VARCHAR(64)
subscribed      BOOLEAN DEFAULT true
updated_at      TIMESTAMP
UNIQUE(user_id, area_shortcode)
```

**Schema file**: `db/schema/tablecolumns/user_file_subscriptions.conf`

**Indexes**:
- `idx_ufs_user` on `user_id`

**Resolution order** (same cascade as message subscriptions):
1. Explicit user override (from `user_file_subscriptions` table)
2. Area's `newscan_default` column value
3. `true` (fallback — include by default)

**Usage**:
- Terminal file newscan: load subscription map → filter areas → query new file count per subscribed area → display summary
- Terminal file area selector: unsubscribed areas displayed dimmed, T key toggles subscription
- Web file group/area listing: show new file badges for subscribed areas

### 1.9 Reuse of existing tables

The following existing tables are reused without modification:

- **`message_networks`** -- File echo networks are defined in the same networks table. FTN networks already carry TIC files alongside echomail. A network's `network_type` already discriminates protocol behavior. No schema change needed.
- **`peer_connections`** -- Connections already have `connection_data` JSONB which includes `tic_password` for FTN connections. The same connection that exchanges echomail also exchanges TIC files. No schema change needed.
- **`peers`** -- Peers are the same remote systems regardless of whether they exchange messages, files, or both.

---

## 2. Directory Structure

### 2.1 Configuration hierarchy

File storage directories are resolved through a three-level hierarchy:

1. **Global root** -- appConfig key `file_base_dir` (default: `files/`). All file storage is relative to this root unless overridden.
2. **Group override** -- `file_groups.base_dir` column (nullable). If set, areas in this group use this as their root instead of the global root.
3. **Area subdirectory** -- `file_areas.sub_dir` column. Subdirectory name within the resolved group root.

Resolution algorithm:
```
function resolveAreaPath(group, area) {
    var root = group.base_dir || appConfig.get('file_base_dir', 'files');
    return path.join(root, area.sub_dir || area.shortcode.toLowerCase());
}
```

### 2.2 Disk layout example

```
files/                              # global file_base_dir
  dos_games/                        # file_areas.sub_dir for "DOS Games" area
    doom.zip
    quake.zip
  utilities/                        # file_areas.sub_dir for "Utilities" area
    pkzip.exe

/data/ftn_files/                    # file_groups.base_dir override for "FTN Files" group
  dove_net/                         # file_areas.sub_dir
    newsletter.zip
  fsxnet/                           # file_areas.sub_dir
    infopack.zip
```

### 2.3 Database path vs. filesystem

- `file_entries.disk_path` stores the path **relative to the area directory**. For most files, this is simply the filename. Subdirectories within an area are possible but discouraged.
- The full filesystem path is always computed at runtime: `resolveAreaPath(group, area) + '/' + entry.disk_path`
- This means moving the file_base_dir (e.g., to a different volume) requires changing only the config key, not updating every row.

### 2.4 TIC staging directories

TIC processing uses its own staging directories, separate from the file area storage:

```
ftn/in/                             # existing FTN inbound (packets AND tic+files arrive here)
ftn/tic_staging/                    # temp directory for TIC processing
ftn/out/                            # existing FTN outbound (TIC files staged here for mailer)
ftn/tossed/                         # existing processed directory
```

New appConfig keys:
- `tic_staging_dir` (default: `ftn/tic_staging`) -- working directory for TIC processor
- `tic_inbound_dir` (default: empty, falls back to `ftninbound`) -- override for TIC inbound scanning

These reuse the existing `ftninbound`/`ftnoutbound` paths because TIC files and packets arrive together via the mailer. The staging directory is separate to avoid interfering with packet processing.

### 2.5 Upload staging

Uploaded files (web and terminal) go through a staging directory before being moved to the final area directory:

```
files/staging/                      # upload staging area
  <uuid>.tmp                        # temp file during upload
```

AppConfig key: `file_upload_staging_dir` (default: `files/staging`)

After validation (virus scan hook, file_id.diz extraction, dupe check), the file is moved to the resolved area path and the `file_entries` row is created.

---

## 3. File Entry Lifecycle

### 3.1 Local upload flow (web)

```
User uploads via web form
  |
  v
POST /files/areas/:shortcode/upload
  |-- Save to staging dir with temp UUID filename
  |-- Validate: file size limits, extension whitelist (appConfig)
  |-- Compute CRC-32 and SHA-256 hashes
  |-- Dupe check: query file_entries WHERE file_hash_crc32 = $1 AND area_id = $2
  |-- Extract file_id.diz from ZIP archives (if present)
  |-- Extract text content for searchable files (.txt, .nfo, .diz, .doc)
  |-- Move file to resolved area path
  |-- Insert file_entries row
  |-- Update file_areas stats (file_count, total_bytes, last_upload)
  |-- Enqueue distribution job (if area is networked)
  |
  v
File available for download
```

### 3.2 Local upload flow (terminal)

```
User selects "Upload" from file area menu
  |
  v
Terminal upload handler (ZMODEM/XMODEM via node-pty or direct binary)
  |-- Receive file to staging dir
  |-- Prompt for short description
  |-- Same validation/processing as web flow
  |-- Insert file_entries row
  |-- Display confirmation
```

**Note**: Terminal file transfer protocol support (ZMODEM, etc.) is a significant implementation concern that will need its own design work. The file area architecture supports it but does not specify the transfer protocol implementation.

### 3.3 Network import flow (TIC/FTN)

```
Mailer receives .tic file + attached file via binkp
  |
  v
Files land in ftn/in/ (existing inbound directory)
  |
  v
Worker picks up tic:inbound job
  |-- Scan inbound directory for .tic files
  |-- For each .tic file:
  |   |-- Parse TIC descriptor (see section 4.1)
  |   |-- Validate TIC password against peer connection's tic_password
  |   |-- Locate attached file (same directory, filename from TIC Area field)
  |   |-- Resolve file area from TIC Area tag via file_network_areas
  |   |-- Dupe check (CRC-32 from TIC + filename + area)
  |   |-- Move file to resolved area path
  |   |-- Extract file_id.diz from ZIP if long_desc not in TIC
  |   |-- Insert file_entries row with source_type='ftn', source_data=TIC metadata
  |   |-- Create file_distribution rows (status='pending') for all subscribed peers
  |   |     EXCEPT the originating peer (seenby/path check)
  |   |-- Move .tic to tossed directory
  |   |-- Update file_areas stats
  |
  v
Outbound distribution triggered (see section 4.3)
```

### 3.4 file_id.diz extraction

Many BBS file archives contain a `FILE_ID.DIZ` file -- a short text description. Extraction logic:

1. Check if the file is a ZIP archive (using `file-type` library, same pattern as `ftnTosser.js`)
2. If ZIP, attempt to extract `FILE_ID.DIZ` (case-insensitive) using the system `unzip` command
3. If found, store contents in `file_entries.long_desc`
4. Pre-render to `file_entries.long_desc_html` using the existing `formatBodyHtml()` pipeline from `terminalText.js` (handles ANSI art, pipe codes, CP437)
5. If `short_desc` is empty and `long_desc` is available, use the first line of `long_desc` as `short_desc`

### 3.5 Text content extraction

For full-text search support, certain file types have their text content extracted:

- `.txt`, `.nfo`, `.diz`, `.doc` (plain text) -- read file content directly
- `.zip` containing `.txt`/`.nfo`/`.diz` -- extract and read
- All other types -- `full_text` remains NULL

Extracted text is stored in `file_entries.full_text` and indexed for search. This is an optional enhancement; the system works without it.

### 3.6 Download tracking

Downloads are tracked by incrementing `file_entries.download_count`:

- **Web**: `GET /files/download/:uuid` -- increment count, send file with `Content-Disposition: attachment`
- **Terminal**: file transfer protocol sends file -- increment count on successful completion

Download count updates use `UPDATE file_entries SET download_count = download_count + 1 WHERE id = $1` for atomicity.

### 3.7 long_desc_html rendering

The `long_desc_html` field follows the same pattern as `body_html` in the message system:

- Pre-rendered at import/upload time using `formatBodyHtml()` from `terminalText.js`
- Single source of truth for HTML display in web views
- Terminal views use `long_desc` directly (raw text)
- Regeneratable via maintenance task (see section 7)

---

## 4. TIC Processing Architecture

### 4.1 TIC file format

A TIC file is a plain-text descriptor accompanying a distributed file. Key fields:

```
Area DOVE-NET_FILES          -- file echo area tag (maps to file_network_areas.areatag)
File newsletter.zip          -- filename of the attached file
Replaces oldnews.zip         -- file this replaces (optional)
Desc One-line description    -- short description
LDesc Multi-line             -- extended description (multiple LDesc lines)
LDesc description here
Size 123456                  -- file size in bytes
Date 1234567890              -- Unix timestamp of file date
CRC 1A2B3C4D                -- CRC-32 of the file
Origin 1:123/456             -- system that originally hatched this file
From 1:123/456               -- system that sent this to us
To 1:1/1                     -- our address (for validation)
Path 1:123/456               -- transit path (multiple Path lines)
Seenby 1:123/456             -- seen-by list (multiple Seenby lines)
Pw TICPASSWORD               -- TIC password for authentication
Magic DOVE_LATEST            -- magic name for auto-request (optional)
```

### 4.2 TIC inbound processing

The TIC processor is a new tosser module: `src/middleware/tossers/ticTosser.js`

**Inbound flow (`tossInbound`)**:

1. Scan `tic_inbound_dir` (falls back to `ftninbound`) for `*.tic` files
2. For each `.tic` file:
   a. Parse the TIC descriptor into a structured object
   b. Validate `Pw` against the sending peer's `connection_data.tic_password`
   c. Validate `To` address matches one of our system addresses
   d. Locate the attached file (same directory as the `.tic`)
   e. Verify file CRC-32 matches TIC `CRC` field
   f. Resolve `Area` tag to a `file_areas` row via `file_network_areas`
   g. If area not found and auto-create is enabled (appConfig `tic_auto_create_areas`), log and skip (do not auto-create -- sysop must map areas manually)
   h. Check `file_peer_subscriptions` -- is this area allowed/enabled for the sending connection?
   i. Dupe check: `SELECT id FROM file_entries WHERE file_hash_crc32 = $1 AND area_id = $2 AND filename = $3`
   j. Handle `Replaces`: if present, mark the old file entry as `active = false`
   k. Move the attached file from inbound to the resolved area directory
   l. Extract `file_id.diz` if `LDesc` was not present in the TIC
   m. Compute SHA-256 hash
   n. Insert `file_entries` row
   o. Create `file_distribution` rows for all peer connections subscribed to this file area, excluding the source peer (check `Seenby`/`Path`)
   p. Move `.tic` to `ftntossed` directory
   q. Log via `alogger`

3. Return results summary (processed count, errors, skipped dupes)

### 4.3 TIC outbound processing

**Outbound flow (`tossOutbound`)**:

1. Query `file_distribution` for rows with `status = 'pending'`
2. Group by `peer_connection_id`
3. For each peer connection:
   a. Resolve peer connection, network, and system address
   b. For each pending file:
      i. Build TIC descriptor:
         - `Area`: from `file_network_areas.areatag`
         - `File`: from `file_entries.filename`
         - `Desc`: from `file_entries.short_desc`
         - `LDesc`: from `file_entries.long_desc` (split into lines)
         - `Size`, `Date`, `CRC`: from file entry
         - `Origin`: from `source_data.tic_origin` or our system address if locally uploaded
         - `From`: our system address
         - `To`: peer's FTN address (from `connection_data.address`)
         - `Path`: append our address to existing path
         - `Seenby`: append our address and the destination address
         - `Pw`: peer's `connection_data.tic_password`
      ii. Write `.tic` file to the peer's outbound directory (BSO structure)
      iii. Copy/link the attached file to the outbound directory
      iv. Update `file_distribution` row: `status = 'sent'`, `sent_at = now()`
   c. If the peer connection is CRASH status, enqueue `signal-outbound` mailer job

4. Errors: update `file_distribution` row with `status = 'failed'`, increment `attempts`, set `error_message`

### 4.4 Hatching (local file distribution)

"Hatching" is the TIC term for introducing a new file into the network. When a file is uploaded locally to a networked area:

1. The upload handler detects the area has `file_network_areas` mappings
2. Creates `file_distribution` rows (status='pending') for all subscribed peer connections
3. Enqueues a `tic:outbound` job

The file entry's `source_type` is `'local'`, `source_data` contains upload metadata, and the TIC outbound processor generates `Origin` from our system address.

### 4.5 Integration with BullMQ job topology

New job types on the **`toss` queue** (consumed by Worker):

| Job name | Description | jobId convention |
|----------|-------------|------------------|
| `tic:inbound` | Process inbound .tic files | `tic-inbound--<connectionUUID>` or `tic-inbound--<timestamp>` |
| `tic:outbound` | Build and stage outbound .tic files | `tic-outbound--<connectionUUID>` or `tic-outbound--<timestamp>` |

New job enqueue helpers in `src/queues/jobs.js`:

```javascript
export async function enqueueTicInbound(opts = {}) {
    return tossQueue.add('tic:inbound', {
        connectionUUID: opts.connectionUUID || null,
        sourceDir: opts.sourceDir || null,
    }, {
        jobId: opts.connectionUUID
            ? `tic-inbound--${opts.connectionUUID}`
            : `tic-inbound--${Date.now()}`,
    });
}

export async function enqueueTicOutbound(opts = {}) {
    return tossQueue.add('tic:outbound', {
        connectionUUID: opts.connectionUUID || null,
    }, {
        jobId: opts.connectionUUID
            ? `tic-outbound--${opts.connectionUUID}`
            : `tic-outbound--${Date.now()}`,
    });
}
```

**Trigger points**:
- `tic:inbound` is enqueued by: mailer (after file receive, alongside `ftn:inbound`), admin panel, CLI
- `tic:outbound` is enqueued by: upload handler (after local upload to networked area), `tic:inbound` processor (after processing inbound files that need forwarding), admin panel, CLI
- `enqueueTossCycle` should be extended to include TIC inbound/outbound when `doFtn` is true

New maintenance job:

| Job name | Queue | Description |
|----------|-------|-------------|
| `regen-file-desc-html` | `maintenance` | Regenerate `long_desc_html` for file entries |
| `recalc-file-counts` | `maintenance` | Recalculate file_count/total_bytes for all areas |

---

## 5. Network Extensibility

### 5.1 Protocol-agnostic source tracking

The `source_type` + `source_data` pattern on `file_entries` is deliberately protocol-agnostic:

- `source_type` is a simple string discriminator (`'local'`, `'ftn'`, `'qwk'`, `'meshtastic'`, etc.)
- `source_data` is a JSONB column that stores whatever metadata the import protocol provides
- `source_network_id` and `source_peer_id` reference the existing `message_networks` and `peers` tables

Adding a new protocol requires:
1. A new `source_type` value
2. A new tosser/importer module that populates `source_data` with protocol-specific metadata
3. No schema changes

### 5.2 Protocol-agnostic distribution tracking

The `file_distribution` table uses a `protocol` column to tag how each distribution was performed, but the table structure is the same regardless of protocol. Adding a new distribution protocol requires:

1. A new `protocol` value in `file_distribution`
2. A new outbound processor that queries pending rows for its protocol
3. No schema changes

### 5.3 Network areas and subscriptions

The `file_network_areas` and `file_peer_subscriptions` tables are protocol-agnostic wrappers around the existing `message_networks` and `peer_connections` tables. The `network_type` field on the network determines which tosser processes files for that network.

Future protocols add new values to `message_networks.network_type` (or a new `file_networks` table if the separation is warranted) and implement the corresponding tosser. The subscription model works identically.

---

## 6. Access Control

### 6.1 Permission model

File areas use the same access control model as message areas:

| Check | Column | Meaning |
|-------|--------|---------|
| Can browse/download | `read_security` | User security level >= this value |
| Can upload | `post_security` | User security level >= this value |
| Required browse permissions | `read_perm_flags` | User must have ALL listed flags |
| Browse restriction flags | `read_rest_flags` | User must have NONE of listed flags |
| Required upload permissions | `post_perm_flags` | User must have ALL listed flags |
| Upload restriction flags | `post_rest_flags` | User must have NONE of listed flags |

Access is checked at both group and area level -- the user must pass both.

### 6.2 Access check functions

New helper functions in the file area model (mirroring `checkAreaReadAccess`/`checkAreaPostAccess` from `src/routes/index.js`):

```javascript
function checkFileAreaDownloadAccess(user, group, area) { ... }
function checkFileAreaUploadAccess(user, group, area) { ... }
```

These check security level, permission flags, and restriction flags against both the group and the area, returning a boolean.

### 6.3 Web vs. terminal

Both interfaces use the same access check functions:
- **Web**: middleware checks access before rendering browse/download/upload views
- **Terminal**: handler checks access before displaying file listings and processing transfers

---

## 7. Integration Points

### 7.1 New models

| File | Purpose |
|------|---------|
| `src/models/fileGroups.js` | File group CRUD (mirrors `msgGroups.js` pattern) |
| `src/models/fileAreas.js` | File area CRUD (mirrors `msgAreas.js` pattern, minus per-area tables) |
| `src/models/fileEntries.js` | File entry CRUD, search, stats, dupe checking, hash computation |
| `src/models/fileDistribution.js` | Distribution tracking CRUD, pending query, status updates |
| `src/models/fileNetworkAreas.js` | File area to network mapping (mirrors `networkAreas.js`) |
| `src/models/filePeerSubscriptions.js` | File area peer subscriptions (mirrors `peerAreaSubscriptions.js`) |
| `src/models/userFilePointers.js` | Per-user per-area scan pointers for new file tracking (mirrors `userMsgPointers.js`) |
| `src/models/userFileSubs.js` | Per-user file area subscription overrides for newscan (mirrors `userAreaSubs.js`) |

### 7.2 New tosser

| File | Purpose |
|------|---------|
| `src/middleware/tossers/ticTosser.js` | TIC inbound/outbound processing |

### 7.3 New routes

| File | Purpose |
|------|---------|
| `src/routes/files.js` | User-facing file browsing, download, upload |
| `src/routes/admin.js` (modifications) | Admin CRUD for file groups, areas, entries; file network area management |

**User-facing routes (`src/routes/files.js`)**:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/files` | List file groups (with area counts, access-filtered) |
| GET | `/files/groups/:shortcode` | List areas in group (with file counts, access-filtered) |
| GET | `/files/areas/:shortcode` | Browse files in area (paginated, sortable) |
| GET | `/files/areas/:shortcode/search` | Search within area |
| GET | `/files/view/:uuid` | File detail view (descriptions, metadata) |
| GET | `/files/download/:uuid` | Download file (access-checked, count incremented) |
| POST | `/files/areas/:shortcode/upload` | Upload file (multipart form, access-checked) |
| GET | `/files/search` | Global file search (across all accessible areas) |

**Admin routes (additions to `src/routes/admin.js`)**:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/filegroups` | List/manage file groups |
| POST | `/admin/filegroups` | Create file group |
| PUT | `/admin/filegroups/:shortcode` | Update file group |
| DELETE | `/admin/filegroups/:shortcode` | Delete file group |
| GET | `/admin/filegroups/:shortcode` | View group with areas |
| POST | `/admin/filegroups/:shortcode/areas` | Create file area in group |
| PUT | `/admin/fileareas/:shortcode` | Update file area |
| DELETE | `/admin/fileareas/:shortcode` | Delete file area |
| POST | `/admin/fileareas/:shortcode/entries` | Manually add file entry |
| DELETE | `/admin/fileentries/:uuid` | Remove file entry |
| POST | `/admin/fileareas/:shortcode/scan` | Scan area directory for new files |

### 7.4 New terminal handlers

| File | Purpose |
|------|---------|
| `src/handlers/menucommands/fileAreaSelector.js` | Browse/select file groups and areas (mirrors `msgAreaSelector.js`) |
| `src/handlers/menucommands/fileBrowser.js` | List files in an area, view details, download |
| `src/handlers/menucommands/fileUpload.js` | Upload file to current area (when transfer protocol support is implemented) |

These are `BaseSubModule` implementations, consistent with the existing terminal architecture.

### 7.5 New views

| File | Purpose |
|------|---------|
| `src/views/files/index.pug` | File group listing |
| `src/views/files/groups/view.pug` | Areas within a group |
| `src/views/files/areas/view.pug` | File listing within an area |
| `src/views/files/view.pug` | Individual file detail |
| `src/views/admin/fileGroups/index.pug` | Admin file group management |
| `src/views/admin/fileGroups/view.pug` | Admin group detail with areas |

### 7.6 Existing files requiring modification

| File | Change |
|------|--------|
| `src/queues/jobs.js` | Add `enqueueTicInbound`, `enqueueTicOutbound`, `enqueueRegenFileDescHtml`, `enqueueRecalcFileCounts`. Extend `enqueueTossCycle` for TIC. |
| `bin/worker.js` | Register TIC job handlers on toss queue. Register file maintenance handlers. |
| `src/config/configDefaults.js` | Add file system config keys (see section 7.7) |
| `src/routes/admin.js` | Add file group/area admin routes |
| `src/views/includes/admin-nav.pug` | Add File Groups/Areas nav items |
| `src/views/layouts/user.pug` | Add "Files" link to user navigation |
| `src/middleware/tossers/ftnTosser.js` | After processing inbound, trigger `tic:inbound` if `.tic` files present |
| `src/mailer/session.js` | After file receive, enqueue `tic:inbound` alongside existing `ftn:inbound` |

### 7.7 New appConfig keys

Added to `src/config/configDefaults.js`:

```javascript
// -----------------------------------------------------------------------
// Files
// -----------------------------------------------------------------------
{ key: 'file_base_dir',           defaultValue: 'files',        type: 'string',  category: 'files', description: 'Base directory for file area storage' },
{ key: 'file_upload_staging_dir', defaultValue: 'files/staging', type: 'string',  category: 'files', description: 'Staging directory for file uploads' },
{ key: 'file_max_upload_size',    defaultValue: '10485760',     type: 'number',  category: 'files', description: 'Maximum upload file size in bytes (default 10MB)' },
{ key: 'file_allowed_extensions', defaultValue: '',             type: 'string',  category: 'files', description: 'Comma-separated allowed file extensions (empty = all)' },
{ key: 'tic_staging_dir',         defaultValue: 'ftn/tic_staging', type: 'string', category: 'files', description: 'TIC processing staging directory' },
{ key: 'tic_inbound_dir',         defaultValue: '',             type: 'string',  category: 'files', description: 'TIC inbound directory (defaults to ftninbound)' },
{ key: 'tic_auto_forward',        defaultValue: 'true',         type: 'boolean', category: 'files', description: 'Auto-forward received TIC files to subscribed peers' },
```

### 7.8 Schema definition files

New files in `db/schema/tablecolumns/`:

- `file_groups.conf`
- `file_areas.conf`
- `file_entries.conf`
- `file_distribution.conf`
- `file_network_areas.conf`
- `file_peer_subscriptions.conf`
- `user_file_pointers.conf`
- `user_file_subscriptions.conf`

---

## 8. Key Design Decisions

### 8.1 Single `file_entries` table vs. per-area tables

**Decision**: Single table with `area_id` foreign key.

**Rationale**: Message areas use per-area tables (`mb_<shortcode>_msgs`) because each area maintains its own sequential ID space for scan pointer tracking. File areas use scan pointers on the global `file_entries.id` column — queries filter by `area_id` so non-contiguous IDs work correctly. File counts per area are small enough (thousands, not millions) that a single indexed table performs well. Cross-area search is a primary use case for files and is dramatically simpler with a single table.

### 8.2 `file_distribution` join table vs. sequential HWM

**Decision**: Explicit per-file distribution tracking table.

**Rationale**: Message outbound uses `peer_area_subscriptions.msg_idx` as a sequential high-water mark -- the tosser scans messages with `id > msg_idx` for each peer. This works because messages are strictly ordered by insertion ID. Files are not -- they can arrive out of order, individual transfers can fail, and retries need per-file tracking. The join table provides retry capability, audit trail, and correct behavior for out-of-order file arrivals.

### 8.3 Separate `file_network_areas` and `file_peer_subscriptions`

**Decision**: New tables rather than reusing `network_areas` and `peer_area_subscriptions`.

**Rationale**: The FK targets differ (`file_areas.id` vs `message_areas.id`), meaning reuse would require either a discriminator column (ugly, breaks existing queries) or removing the FK constraint (unsafe). Separate tables maintain referential integrity and keep model code clean. The implementation cost is low -- the model code follows the same pattern and can be largely copied.

### 8.4 Reusing `message_networks` and `peer_connections`

**Decision**: Reuse existing tables.

**Rationale**: FTN networks inherently carry both echomail and file echoes over the same connections. A peer's binkp session transfers both packet bundles and TIC files. The `peer_connections.connection_data` JSONB already includes `tic_password`. Creating parallel `file_networks` and `file_connections` tables would duplicate data and create synchronization problems. The `message_networks` name is slightly misleading once files are added, but renaming it would break existing code throughout the system -- the minor naming inconsistency is acceptable.

### 8.5 `source_data` JSONB vs. dedicated TIC columns

**Decision**: Generic JSONB column with `source_type` discriminator.

**Rationale**: Adding `tic_origin`, `tic_area`, `tic_seenby`, etc. as dedicated columns would make the schema TIC-specific and require ALTER TABLE for each new protocol. The JSONB approach stores all protocol-specific metadata without schema changes and is queryable via PostgreSQL's JSONB operators when needed.

### 8.6 TIC processing as toss queue jobs

**Decision**: TIC processing runs on the existing `toss` BullMQ queue in the Worker process.

**Rationale**: Consistent with the established pattern -- FTN packet tossing, QWK pull/push, and NNTP pull/push all run as toss queue jobs. The Worker process already has database access, file system access, and the model layer loaded. TIC processing has the same characteristics as packet tossing: batch I/O, not latency-sensitive, should not run in the Gateway process. The jobId deduplication pattern prevents concurrent TIC processing for the same connection.

### 8.7 Directory admin scan operation

**Decision**: Provide an admin "scan directory" operation that reads the filesystem and creates `file_entries` rows for files not already tracked.

**Rationale**: Sysops often populate file areas by copying files to directories outside the BBS. The scan operation bridges filesystem reality to database state. This is a common BBS administration pattern (Synchronet, Mystic, etc. all have it). The scan operation computes hashes, extracts file_id.diz, and sets `source_type = 'local'` with `source_data = { "import_method": "directory_scan" }`.

---

## 9. Implementation Priority

Suggested implementation order, designed so each phase is independently useful:

### Phase 1 -- Core storage and admin
- Database schema (all six tables)
- `fileGroups.js`, `fileAreas.js`, `fileEntries.js` models
- Admin CRUD routes and views for groups and areas
- Directory resolution logic
- AppConfig keys

### Phase 2 -- Web browsing and downloads
- User-facing routes (`src/routes/files.js`)
- File listing, detail, and download views
- Access control enforcement
- Download counting
- `userFilePointers.js` and `userFileSubs.js` models
- New file badges on area listings
- File newscan summary

### Phase 3 -- Web uploads
- Upload staging and processing
- file_id.diz extraction
- Hash computation and dupe checking
- Upload form in area view

### Phase 4 -- TIC networking
- `ticTosser.js` (inbound and outbound)
- `fileNetworkAreas.js` and `filePeerSubscriptions.js` models
- `fileDistribution.js` model
- BullMQ job integration
- Admin UI for file network area mapping

### Phase 5 -- Terminal interface
- `fileAreaSelector.js`, `fileBrowser.js` menu commands
- Terminal file listing with short descriptions
- Download via terminal (protocol TBD)

### Phase 6 -- Search and maintenance
- Full-text search
- Directory scan operation
- `long_desc_html` regeneration maintenance task
- File count recalculation maintenance task
