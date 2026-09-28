# Filebox & Inbound Wildcard Design

Design for per-peer outbound fileboxes and sysop-configurable inbound file wildcard routing.

**Status**: Implemented, apart from inbound fileboxes (section 5, still deferred) and the `outbox_dir` existence warning in `validateConnectionData()` (not built). Code: `src/utils/fileboxPath.js`, `src/mailer/bsoScanner.js` (`_scanOutboundFileboxes`), `src/mailer/session.js`, `src/mailer/transfer.js` (`_routeInboundFile`), `src/models/fileWildcards.js`, admin at `/admin/wildcards`. Details below that the implementation changed have been corrected.

## Motivation

Inter-BBS (IBBS) door games (LORD, TradeWars, etc.) drop outbound files into directories and expect inbound files in specific directories. DOS-based games have no knowledge of Linux directory structures, BSO transports, or netmail file-attach. Fileboxes and wildcards bridge this gap by letting the mailer scan game output directories for outbound delivery and route inbound files to game input directories based on filename patterns.

## Scope

This document covers two features shipping together:

1. **Outbound fileboxes** -- per-peer outbox directories scanned by the BSO scanner
2. **Inbound wildcards** -- global filename pattern rules that route received files to specific directories

A third feature, **inbound fileboxes** (per-peer inbox directories), is deferred. It has open questions around tosser interaction and echomail/netmail handling that warrant separate design work. Outbound fileboxes + wildcards cover the primary IBBS use case.

---

## 1. Outbound Fileboxes

### Concept

Each peer connection can optionally have an `outbox_dir` configured. The BSO scanner checks these directories alongside its normal hex-addressed BSO scan. Any files found are queued for delivery to that peer and deleted after successful send.

### Configuration

**New config key:**

| Key | Default | Category | Type | Description |
|-----|---------|----------|------|-------------|
| `filebox_base_dir` | `ftn/filebox` | paths | string | Parent directory for filebox subdirectories. Configured filebox dirs that are not absolute paths are resolved relative to this. |

**New peer connection_data field:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `outbox_dir` | string | null | Outbox directory path. Absolute paths used as-is. Relative paths and `~` paths resolved against `filebox_base_dir`. |

### Path Resolution

Both `outbox_dir` (filebox) and `target_dir` (wildcards) support `%X` variable substitution via `configvars.js` before path resolution. This allows paths like `%M/lord/outbound/` to target DOSemu drive directories directly. Since these paths are resolved at mailer runtime (not in a terminal session), only system-level tokens are meaningful:

| Token | Description | Example |
|-------|-------------|---------|
| `%M` | DOSemu drive_c | `~/.dosemu/drive_c` |
| `%!` | Door base directory | From `doordir` config |
| `%J` | Data directory | `<cwd>/data` |
| `%K` | Config directory | `<cwd>/config` |
| `%Z` | Text/art directory | From `textdir` config |
| `%O` | Board name | From `boardname` config |
| `%%` | Literal percent sign | `%` |

Session/user/door tokens (`%N`, `%U`, `%D`, etc.) resolve to empty string in this context, which is expected -- these paths are not session-scoped.

```
resolveFileboxPath(configuredPath, baseDir):
  1. Run substitute(configuredPath) for %X variable expansion (includes ~ expansion)
  2. If absolute path (starts with /): use as-is
  3. Otherwise: path.join(baseDir, configuredPath)
  4. baseDir itself: substitute() then resolve relative to cwd
```

This mirrors the file area pattern where `file_base_dir` + area `sub_dir` works the same way.

### BSO Scanner Changes

In `bsoScanner.js`, after the normal BSO directory scan completes:

1. Query all active FTN peer connections that have `outbox_dir` set
2. For each, resolve the outbox path via `resolveFileboxPath()`
3. If directory exists and contains files, add them to the scan results
4. Use the connection's existing `status` field for flavour: `CRASH` and `HOLD` map to Crash and Hold, anything else to Normal. A HOLD peer is therefore never dialled for its filebox; the files go when it calls in
5. The address is only added when the BSO pass has not already found mail for it. The scanner only decides whether to connect; files are queued (with delete-after-send) by the session

### Session Integration

In `session.js _buildOutboundList()` (and the second, single-connection list builder in the same file):

1. For each peer connection in the session, check for `outbox_dir`
2. If set, resolve path and scan for files
3. Queue all regular files found with `deleteAfterSend: true`
4. These are queued after normal BSO flow files, direct packets and FREQ `.req` files

### Edge Cases

- **Empty/missing directory**: Skip silently (door game may not have run yet)
- **Directory creation**: Not automatic. Sysop creates directories as needed for their door game setup.
- **File locking**: No locking. Door games are typically not running during mailer sessions. If a game is writing while the scanner runs, the file will be picked up on the next scan cycle after the write completes.
- **Subdirectories**: Only top-level files in the outbox are scanned. Subdirectories are ignored.

---

## 2. Inbound Wildcards

### Concept

Sysop-configurable rules that match inbound filenames against glob patterns and route matched files to specific directories instead of the default `ftn/in/` landing zone. Rules are evaluated in priority order; first match wins. Matched files skip the toss queue by default.

### Schema

**New table: `file_wildcards`**

| Column | Type | Description |
|--------|------|-------------|
| `id` | serial | Primary key |
| `pattern` | varchar(255) | Glob pattern (case-insensitive, e.g. `LORD*.*`, `*.TIC`) |
| `target_dir` | varchar(512) | Destination directory path |
| `description` | varchar(255) | Sysop description of this rule |
| `still_toss` | boolean | If true, also queue for toss processing (default false) |
| `sort_order` | integer | Evaluation priority (lower = first) |
| `active` | boolean | Enable/disable without deleting |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

### Path Resolution

`target_dir` follows the same `%X` substitution + resolution pattern as outbox paths (`TransferEngine` calls `resolveFileboxPath(target_dir)` with no base argument):
- `substitute()` applied first for `%X` variable expansion (includes `~` expansion)
- Absolute paths used as-is
- Relative paths resolved against `filebox_base_dir` (not the current working directory, as first planned)

Example: `%M/lord/inbound/` expands to `~/.dosemu/drive_c/lord/inbound/` then to the full home path.

### Pattern Matching

- Case-insensitive glob matching (DOS filenames)
- Standard glob syntax: `*` matches any characters, `?` matches single character
- Examples: `LORD*.*`, `TW2002*.PKT`, `NODEDIFF.*`, `*.TIC`
- No path separators in patterns (matching is filename-only)
- Implemented as a hand-rolled glob (`_globMatch` in `fileWildcards.js`) converting `*` and `?` to a case-insensitive anchored regex; no `minimatch`

### Transfer Integration

`transfer.js _onFileComplete()` verifies the received size, then calls `_routeInboundFile()`:

```
1. Load active wildcard rules (cached until WILDCARDS_CHANGED)
2. Test filename against each rule in sort_order
3. If match found:
   a. Resolve target_dir via resolveFileboxPath()
   b. Ensure target directory exists (create if needed)
   c. Move file to target_dir (an existing name gets a _<timestamp> suffix)
   d. skipToss = !still_toss
4. If no match (or matching throws): existing ftn/in/ placement
5. Send M_GOT, emit receiveComplete with { path, wildcardMatch, skipToss }
   so the session decides whether to enqueue a toss
```

### Caching

Wildcard rules are loaded once per process and cached in memory. Admin CRUD happens in the gateway, but live matching happens in the mailer's `TransferEngine` (and, for netmail analogues, in the worker's tosser). Without cross-process invalidation, mailer/worker caches go stale whenever a sysop edits rules.

Cache invalidation wiring:
- CRUD in `fileWildcards.js` calls local `invalidateCache()` and publishes `WILDCARDS_CHANGED` via the Redis pub/sub event bus.
- Mailer and worker main loops subscribe to `WILDCARDS_CHANGED` and call `invalidateCache()` on receipt.
- Gateway also subscribes (for embedded mode and its own admin-side reads).
- Next `matchFilename()` lazy-loads rules from DB.

### Model

**New model: `src/models/fileWildcards.js`**

- `getAll()` -- all rules ordered by sort_order
- `getActive()` -- active rules only, ordered by sort_order (used by transfer engine)
- `getById(id)` -- single rule
- `create(data)` -- insert new rule
- `update(id, data)` -- update rule
- `remove(id)` -- remove rule (named `remove`, not `delete`)
- `invalidateCache()` -- drop the in-process rule cache
- `reorder(ids)` -- bulk update sort_order
- `matchFilename(filename, rules)` -- test filename against rule set, return first match or null

### Admin UI

New section under Networking in the admin navbar, or as a tab on an existing page.

**Route: `/admin/wildcards`**

- DataTable listing all rules (pattern, target_dir, description, still_toss, active, sort_order)
- Drag-to-reorder for sort_order (same pattern as announcements, menu entries)
- Modal for create/edit with fields: pattern, target_dir, description, still_toss checkbox, active checkbox
- `%X` variable reference tooltip/popover on target_dir field (same pattern as door config forms)
- Delete with confirmation
- Test tool: enter a filename, see which rule matches (or "no match -- would go to ftn/in/"); `POST /admin/wildcards/test`

Built as a page under Networking (Inbound Wildcards) with routes `GET /admin/wildcards`, `POST /admin/wildcards/new`, `/:id/update`, `/:id/delete`, `/reorder` and `/test`.

---

## 3. Peer Connection Admin Changes

### Outbox Directory Field

Add `outbox_dir` field to the FTN peer connection edit form:

- New text input in the connection details section
- Label: "Outbox Directory"
- Help text: "Files in this directory will be sent to this peer. Supports %X variables (e.g. %M for DOSemu drive). Relative paths resolve under the filebox base directory."
- `%X` variable reference tooltip/popover (same pattern as door config forms)
- Optional (null/empty = no outbox)
- Stored in `connection_data` JSON alongside existing fields

### Validation

- `buildConnectionData()`: extracts `outbox_dir` from the form field `ftn_outbox_dir` (or `outbox_dir`), trimmed; stored as an empty string when blank
- `validateConnectionData()`: the planned warning for a missing directory was not built; `outbox_dir` is not validated

---

## 4. Implementation Order

1. **Config key**: Add `filebox_base_dir` to configDefaults.js
2. **Path resolver**: Shared utility function `resolveFileboxPath()` with ~ expansion
3. **Peer connection_data**: Add `outbox_dir` field to build/validate, admin form
4. **Outbound fileboxes**: BSO scanner + session outbound list changes
5. **Wildcard schema**: Table creation, model
6. **Wildcard transfer integration**: `_onFileComplete()` changes
7. **Wildcard admin UI**: Routes, views, CRUD
8. **Tests**: BSO scanner outbox tests, wildcard matching tests, transfer routing tests

---

## 5. Future: Inbound Fileboxes

Deferred. Open questions to resolve:

- Should echomail PKTs and TIC files be excluded from inbox routing (always tossed normally)?
- Should the tosser scan peer inboxes in addition to `ftn/in/`, or should inbox files be copied to both locations?
- Should inbox placement be in addition to (copy) or instead of (move) normal inbound placement?
- How does this interact with inbound wildcards? (Wildcards evaluated first? Inbox as final fallback before `ftn/in/`?)

The likely design is: wildcards evaluated first, then peer inbox check, then `ftn/in/` default. But the tosser interaction needs careful thought.
