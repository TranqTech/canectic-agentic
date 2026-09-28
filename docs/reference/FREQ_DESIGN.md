# FREQ (File Request) Design

FTN file request handling for the binkp mailer. Allows remote nodes to request files during a session, and allows the local sysop to request files from remote nodes.

**Status**: Implemented (`src/models/freq.js`, `src/mailer/session.js` `_processFreqRequest`, admin at `/admin/freq`). Not built: the Pending Requests list, `!PASSWORD` checking (passwords are stripped and ignored), and the `ABOUT` seed. Details the implementation changed are corrected below.

## Overview

FREQ has two sides:
- **Responding**: a remote node sends us a `.req` file listing filenames they want. We look them up and offer them back.
- **Requesting**: we send a `.req` file to a remote node asking for files we want.

## Inbound FREQ (Responding to Requests)

### Flow

1. Remote sends a `.req` file during binkp session (normal M_FILE transfer)
2. When the file is complete, `session.js` (in its `receiveComplete` handler) sees the `.req` extension and calls `_processFreqRequest()`; nothing happens when `freq_enabled` is false
3. `freq.resolveRequest()` parses the file: one filename per line, the first whitespace-separated token is the filename, anything after it (password, flags) is dropped
4. For each requested filename, searches three sources in order:
   a. **Magic aliases** (`freq_magic` table): admin-configured name-to-path mappings
   b. **Filebox directory**: files dropped in `ftn/filebox/` (or configured path) -- sysop-curated, open to any authenticated session
   c. **File entries** (`file_entries` table): files in file areas the peer has access to -- broadest fallback, scoped to peer's subscribed areas
5. Found files are queued for sending via `transfer.queueFile()` (`deleteAfterSend: false`) and sending is restarted, in case M_EOB had already gone
6. Not-found files are logged at level 5; once `freq_max_files` files have been found, later lines are reported not found with reason "max files reached"
7. A summary (found / not found) is logged at level 3 straight away, and the `.req` is deleted from the inbound directory

### File Lookup: Three Layers (Priority Order)

#### Layer 1: Magic Aliases (Highest Priority)

Admin-configurable mappings from a requested name to a file path or auto-generated content. Checked first -- explicit sysop intent.

```sql
CREATE TABLE IF NOT EXISTS freq_magic (
    id SERIAL PRIMARY KEY,
    name VARCHAR(64) NOT NULL UNIQUE,
    file_path VARCHAR(512),
    magic_type VARCHAR(16) DEFAULT 'file',  -- 'file', 'filelist', 'nodelist'
    description VARCHAR(256) DEFAULT '',
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW()
);
```

Types:
- `file`: static file path on disk (e.g. `RULES` -> `/path/to/rules.txt`)
- `filelist`: auto-generate a file listing from all file areas (common FTN convention -- requesting `FILES` returns the BBS file list)
- `nodelist`: return the newest `NODELIST.nnn` or `NODEDIFF.nnn` (by mtime) in the FTN inbound directory (`ftninbound`, default `ftn/in`)

Names are stored uppercased and matched case-insensitively. The table is created by `freq.ensureTable()` (called at gateway and mailer startup), not by `db/schema`.

Seeded default (only when the table is empty):
- `FILES` -> type `filelist` (auto-generated)

The planned `ABOUT` seed was not built.

#### Layer 2: Filebox Directory

A sysop-curated directory on disk. Files dropped here are deliberately made available for FREQ. Open to any authenticated session. No per-area access control -- if the sysop put it in the filebox, it's available.

Config key: `freq_filebox_dir` (default: `ftn/filebox`, category paths). Only top-level regular files match, case-insensitively. A relative path resolves against the working directory (no `%X` substitution).

This is the same default directory as `filebox_base_dir`, under which relative per-peer `outbox_dir` paths resolve. Outbox subdirectories are not reachable by FREQ since only top-level files match, but a file placed at the top level is requestable by anyone.

This takes priority over file_entries so the sysop can override database files with specific versions for FREQ (e.g. a custom README, a specific release build).

Note: This global FREQ filebox is separate from the per-peer outbound fileboxes (`outbox_dir` on peer connections). The FREQ filebox serves files on request; outbound fileboxes are proactively sent. See `FILEBOX_WILDCARD_DESIGN.md` for the per-peer filebox system.

#### Layer 3: File Entries (Database, Broadest Fallback)

Search `file_entries` for an exact filename match (case-insensitive). This is the broadest search -- any file uploaded to the BBS file areas is potentially requestable.

Access control: only return files from areas where the requesting peer's connection has a `file_peer_subscriptions` row with `allowed = true AND enabled = true`. This prevents nodes from requesting files they shouldn't have access to. A session with no matched peer connection (no `connectionId`) skips this layer entirely.

Implemented as one query joining `file_entries`, `file_areas` and `file_peer_subscriptions` on `LOWER(filename)` with `LIMIT 1`, returning `disk_path` when that file exists on disk. If the filename matches multiple entries the peer can reach, which one is returned is not defined (no ORDER BY).

### .req File Format

Standard FTN format, one request per line:
```
FILENAME
FILENAME !PASSWORD
FILENAME +UPDATEREQUEST
```

We handle:
- Bare filename (most common)
- `!PASSWORD` after filename: stripped and ignored (there is no `freq_magic.password` column)
- Lines starting with `;` are comments

Update request flags (`+`, `-`) are ignored too.

## Outbound FREQ (Requesting Files)

### Admin UI

Admin page at `/admin/freq`:

**Create File Request** (`POST /admin/freq/request`):
- Select destination peer connection (dropdown of active FTN connections)
- Enter filenames (textarea, one per line)
- Submit calls `freq.createReqFile(net, node, filenames, { zone })`, which writes (overwriting) the `.req` file in the zone outbound the mailer reads for that address: `MAILER_OUTBOUND_DIR` when set, else `ftnoutbound`, plus `.NNN` (hex) for any zone but 1. Path rule in `src/utils/bsoPaths.js`, shared with the mailer. Before #80 it always wrote to `ftnoutbound`, so a request to a peer outside zone 1 was never sent, and the form refused any node 0 address (a host or hub) outright

The `.req` filename follows BSO convention: `NNNNOOOO.req` where NNNN = destination net hex, OOOO = destination node hex. The BSO scanner treats a `.req` as pending mail (flavour Normal), so it triggers a connection on the next scan.

**Pending Requests** (list and cancel pending `.req` files): not built. The page instead lists the FREQ filebox contents (names starting `_`, such as the generated `_FILES.LST`, are hidden).

### BSO Integration

`session._buildOutboundList()` checks for `<desthex>.req` alongside `.flo` and `.out` for each address in the session. The `.req` file is queued as a normal file with `deleteAfterSend: true`, so it is deleted from the outbound directory after a successful send.

## Session Integration

### Inbound detection (built in session.js, not transfer.js)

`TransferEngine` places the received file (in `ftn/in/`, or wherever an inbound wildcard sends it) and emits `receiveComplete`. The session's handler for that event checks for a `.req` name and calls `SessionController._processFreqRequest(info.path)`:

1. Return if `freq_enabled` is false
2. `freq.resolveRequest(reqFilePath, connectionId)` reads and parses the file and resolves each name, magic -> filebox -> file_entries
3. Queue found files via `this.transfer.queueFile(filePath, { deleteAfterSend: false })`
4. Log results
5. Delete the .req file from inbound (it's been processed)
6. If anything was queued, `this.transfer.startSending()`

### session.js Changes

In `_buildOutboundList()`, add `.req` file detection:
```javascript
var reqFile = path.join(outDir, desthex + '.req');
if (fs.existsSync(reqFile)) {
    this.transfer.queueFile(reqFile, { deleteAfterSend: true });
}
```

## Config Keys

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `freq_enabled` | boolean | `true` | Enable/disable FREQ responses (category mailer) |
| `freq_filebox_dir` | string | `ftn/filebox` | Directory for FREQ filebox files (category paths) |
| `freq_max_files` | number | `10` | Maximum files to send per FREQ request (category mailer) |

## Schema

### freq_magic table

Created at runtime by `freq.ensureTable()`, not from `db/schema`:

```sql
CREATE TABLE IF NOT EXISTS freq_magic (
    id SERIAL PRIMARY KEY,
    name VARCHAR(64) NOT NULL UNIQUE,
    file_path VARCHAR(512),
    magic_type VARCHAR(16) DEFAULT 'file',
    description VARCHAR(256) DEFAULT '',
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP
);
```

## Admin UI

### Magic Aliases (`/admin/freq`)

Table of magic aliases with add/edit/delete (`POST /admin/freq/magic/new`, `/magic/:id/update`, `/magic/:id/delete`).

### Create Request

Form on the FREQ admin page (not on peer connection pages):
- Peer connection dropdown
- Filenames textarea
- Submit button creates the .req file

## File Listing Generation

When `freq_magic` type is `filelist`, auto-generate a file listing:
- `;` comment header with BBS name (`boardname`) and date
- For each active file area (ordered by group, then area name): a `; --- group / area ---` line, then one line per file with filename, size in KB and short description (no date), or `; (empty)`
- CRLF line endings, written to `_FILES.LST` in `freq_filebox_dir` and regenerated on every request

## Implementation Order

All steps done except the Pending Requests part of step 6.

1. Config keys + freq_magic table + model
2. FREQ resolver (magic -> file_entries -> filebox lookup)
3. Inbound: transfer.js .req detection + processing
4. Outbound: session.js .req file scanning + queuing
5. Admin: magic aliases CRUD
6. Admin: create .req UI
7. Filelist auto-generation for magic type
8. Docs update

## Access Control

- **Responding**: Magic aliases and filebox are open to any session that delivers a `.req` (FREQ itself applies no further check). File entries are scoped to areas the peer has allowed and enabled subscriptions for, and are unreachable when no peer connection was matched.
- **Requesting**: Sysop-only (admin UI creates .req files)
- **Config**: `freq_enabled` can disable the entire system
