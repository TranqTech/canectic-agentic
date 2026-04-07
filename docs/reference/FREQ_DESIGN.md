# FREQ (File Request) Design

FTN file request handling for the binkp mailer. Allows remote nodes to request files during a session, and allows the local sysop to request files from remote nodes.

## Overview

FREQ has two sides:
- **Responding**: a remote node sends us a `.req` file listing filenames they want. We look them up and offer them back.
- **Requesting**: we send a `.req` file to a remote node asking for files we want.

## Inbound FREQ (Responding to Requests)

### Flow

1. Remote sends a `.req` file during binkp session (normal M_FILE transfer)
2. After receiving, `transfer.js` detects the `.req` extension
3. Parses the file: one filename per line, optional flags/password after filename
4. For each requested filename, searches three sources in order:
   a. **Magic aliases** (`freq_magic` table): admin-configured name-to-path mappings
   b. **Filebox directory**: files dropped in `ftn/filebox/` (or configured path) -- sysop-curated, open to any authenticated session
   c. **File entries** (`file_entries` table): files in file areas the peer has access to -- broadest fallback, scoped to peer's subscribed areas
5. Found files are queued for sending via `transfer.queueFile()`
6. Not-found files are logged
7. Results summary logged at session end

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
- `nodelist`: return the latest nodelist file from the configured nodelist directory

Seeded defaults:
- `FILES` -> type `filelist` (auto-generated)
- `ABOUT` -> type `file`, path to a BBS info text file (sysop configures)

#### Layer 2: Filebox Directory

A sysop-curated directory on disk. Files dropped here are deliberately made available for FREQ. Open to any authenticated session. No per-area access control -- if the sysop put it in the filebox, it's available.

Config key: `freq_filebox_dir` (default: `ftn/filebox`)

This takes priority over file_entries so the sysop can override database files with specific versions for FREQ (e.g. a custom README, a specific release build).

Note: This global FREQ filebox is separate from the per-peer outbound fileboxes (`outbox_dir` on peer connections). The FREQ filebox serves files on request; outbound fileboxes are proactively sent. See `FILEBOX_WILDCARD_DESIGN.md` for the per-peer filebox system.

#### Layer 3: File Entries (Database, Broadest Fallback)

Search `file_entries` for an exact filename match (case-insensitive). This is the broadest search -- any file uploaded to the BBS file areas is potentially requestable.

Access control: only return files from areas where the requesting peer's connection has an enabled `file_peer_subscription`. This prevents nodes from requesting files they shouldn't have access to.

```javascript
// Pseudocode
var entry = await fileEntries.findByFilename(filename);
if (entry && peerHasAccessToArea(connectionId, entry.area_id)) {
    return entry.disk_path;
}
```

If the filename matches multiple entries (same name in different areas), return the first one the peer has access to.

### .req File Format

Standard FTN format, one request per line:
```
FILENAME
FILENAME !PASSWORD
FILENAME +UPDATEREQUEST
```

We handle:
- Bare filename (most common)
- `!PASSWORD` after filename (password-protected FREQ -- check against `freq_magic.password` or ignore)
- Lines starting with `;` are comments

We ignore update request flags (`+`, `-`) for v1.

## Outbound FREQ (Requesting Files)

### Admin UI

Admin page at `/admin/freq` (or section on peer connection page):

**Create File Request:**
- Select destination peer connection (dropdown of active FTN connections)
- Enter filenames (textarea, one per line)
- Submit creates the `.req` file in the BSO outbound directory

The `.req` filename follows BSO convention: `NNNNOOOOO.req` where NNNN = destination net hex, OOOO = destination node hex.

**Pending Requests:**
- List of `.req` files currently in the outbound directory
- Shows destination address, filenames requested, created date
- Delete button to cancel a request

### BSO Integration

`session._buildOutboundList()` already needs to scan for `.req` files alongside `.flo` and `.out`. The `.req` file is queued as a normal file for transmission. After successful send, it's deleted from the outbound directory.

## Session Integration

### transfer.js Changes

After a file is received and moved to the inbound directory:

```javascript
_onFileComplete(info) {
    // Existing: move file to inbound
    // NEW: if filename ends with .req, process as FREQ
    if (info.name.toLowerCase().endsWith('.req')) {
        this._processFreqRequest(info.path);
    }
}
```

`_processFreqRequest(reqFilePath)`:
1. Read the .req file
2. Parse filenames
3. For each filename, search magic -> file_entries -> filebox
4. Queue found files via `this.queueFile(filePath, { deleteAfterSend: false })`
5. Log results
6. Delete the .req file from inbound (it's been processed)

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
| `freq_enabled` | boolean | `true` | Enable/disable FREQ responses |
| `freq_filebox_dir` | string | `ftn/filebox` | Directory for FREQ filebox files |
| `freq_max_files` | number | `10` | Maximum files to send per FREQ request |

## Schema

### freq_magic table

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

Table of magic aliases with add/edit/delete. Same pattern as news files admin.

### Create Request

Form on the FREQ admin page or on peer connection detail pages:
- Peer connection dropdown
- Filenames textarea
- Submit button creates the .req file

## File Listing Generation

When `freq_magic` type is `filelist`, auto-generate a file listing:
- Header with BBS name and date
- For each active file area: area name, then files with filename, size, date, description
- Standard BBS file listing format

## Implementation Order

1. Config keys + freq_magic table + model
2. FREQ resolver (magic -> file_entries -> filebox lookup)
3. Inbound: transfer.js .req detection + processing
4. Outbound: session.js .req file scanning + queuing
5. Admin: magic aliases CRUD
6. Admin: create .req UI
7. Filelist auto-generation for magic type
8. Docs update

## Access Control

- **Responding**: Magic aliases and filebox are open to any authenticated session. File entries are scoped to areas the peer has enabled subscriptions for.
- **Requesting**: Sysop-only (admin UI creates .req files)
- **Config**: `freq_enabled` can disable the entire system
