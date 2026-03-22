# Terminal File Download System -- Design Document

Design document for terminal-side file downloads in Canectic BBS. Covers protocol architecture, ZMODEM implementation approach, batch management, and integration with the existing file browser and menu system.

For the file area system (schemas, storage, TIC networking), see `FILE_SYSTEM_DESIGN.md`.
For the terminal architecture (handlers, call lifecycle, raw mode, doors), see `terminal_architecture.md`.
For the process model, see `PROCESS_ARCHITECTURE.md`.

---

## 1. Architecture Summary

### 1.1 Approach: External `sz` via PTY

The system uses the external `lrzsz` package (`sz` command) spawned via `node-pty` to handle ZMODEM transfers. This is the same PTY-based approach used by `DoorRunner` for native shell doors, and is the standard approach used by modern BBS software (Synchronet, Enigma 1/2, SBBS).

**Rationale**:

- ZMODEM is a complex protocol (CRC-16/CRC-32 negotiation, windowed streaming, error recovery, auto-start detection). A native JS implementation would be thousands of lines with extensive edge-case handling for different terminal clients.
- `lrzsz` is battle-tested, handles all ZMODEM variants, and is available as a system package on every Linux distribution (`apt install lrzsz`).
- The existing `DoorRunner` already demonstrates the PTY + raw mode pattern. The download handler reuses the same architecture.
- Terminal clients (SyncTERM, NetRunner, Tera Term, MagiTerm) auto-detect ZMODEM initiation sequences from `sz` and switch to receive mode automatically -- no manual protocol selection needed on the client side.

**System dependency**: `lrzsz` package must be installed (`apt install lrzsz`). The `sz` binary must be in PATH. This should be documented alongside the existing `zip` (Info-ZIP) requirement.

### 1.2 Why not native JS ZMODEM?

| Factor | External `sz` | Native JS |
|--------|--------------|-----------|
| Implementation time | Hours (wrapper only) | Weeks (full protocol) |
| Protocol correctness | Proven, decades of use | Risk of client-specific bugs |
| Client compatibility | All terminal clients | Requires extensive testing |
| YMODEM/XMODEM | `sb`/`sx` from same package | Separate implementations |
| Maintenance burden | None (system package) | Ongoing |
| Dependency | `lrzsz` package | None |

The dependency cost is minimal -- `lrzsz` is a standard package in every Linux distribution and is already expected by any sysop running a BBS.

### 1.3 WebSocket binary considerations

Both TCP and WebSocket connections send raw bytes through `call.cmds.senddata()` -> `_send()`. The WebSocket `_send()` calls `socket.send(Buffer.from(data))`, which transmits binary frames. ZMODEM auto-detection works at the byte level, so terminal clients connected via WebSocket will receive the ZMODEM initiation bytes and auto-switch to receive mode the same way TCP clients do.

The `ws` library (used by the Gateway) sends `Buffer` data as binary WebSocket frames by default. No special handling is needed.

---

## 2. Protocol Module Architecture

### 2.1 Directory structure

```
src/protocols/
  base.js              -- BaseProtocol class (abstract)
  zmodem.js            -- ZMODEM via external sz
  ymodem.js            -- YMODEM via external sb (future)
  xmodem.js            -- XMODEM via external sx (future)
```

### 2.2 BaseProtocol class

Abstract base providing the shared lifecycle for all external-tool-based transfer protocols.

```
class BaseProtocol
  constructor(call, files, opts)
    -- call: IncomingCall reference
    -- files: array of { filePath, filename, fileSize }
    -- opts: { timeout, onProgress, onFileStart, onFileComplete }

  Properties:
    call, files, emitter, active, _ptySocket
    _previousRawmode, _previousRawtarget   -- saved state for restore

  Methods:
    start()              -- spawn external tool, enable raw mode, wire I/O
    abort()              -- kill process, restore state, emit Aborted
    _enableRawMode()     -- save + hijack call.rawmode/rawtarget (DoorRunner pattern)
    _disableRawMode()    -- restore saved state
    _onRawInput(data)    -- forward client bytes to PTY stdin
    _onProcessData(data) -- forward PTY stdout to client via call.cmds.senddata()
    _onProcessExit(code) -- disable raw mode, emit Complete or Error
    _cleanup()           -- kill PTY, restore raw mode, null references

  Events (via emitter):
    "Complete"           -- transfer finished successfully
    "Error"              -- transfer failed (with error info)
    "Aborted"            -- transfer cancelled by user or timeout
    "FileStart"          -- individual file transfer starting (batch)
    "FileComplete"       -- individual file transfer complete (batch)
```

### 2.3 ZmodemProtocol class

Extends `BaseProtocol`. Spawns `sz` via `node-pty`.

```
class ZmodemProtocol extends BaseProtocol
  start():
    -- Validate all file paths exist on disk
    -- Build command: sz [options] file1 file2 file3 ...
    -- Options: --zmodem --binary --overwrite
    -- Spawn via pty.spawn("sz", args, { name: "xterm", cols, rows })
    -- Wire PTY data -> call.cmds.senddata()
    -- Wire raw input -> PTY write
    -- Wire PTY close -> _onProcessExit()
    -- Enable raw mode
```

**sz command construction**:
```
sz --zmodem --binary --overwrite /full/path/to/file1.zip /full/path/to/file2.zip
```

Key `sz` flags:
- `--zmodem`: Force ZMODEM protocol (default, but explicit is clearer)
- `--binary`: Binary transfer mode (no text conversion)
- `--overwrite`: Allow overwriting on the receiver side

### 2.4 Future protocol stubs

YMODEM and XMODEM follow the same pattern with different binaries:
- `sb` for YMODEM (batch capable, uses `--ymodem` flag)
- `sx` for XMODEM (single file only)

These are stub files initially, to be implemented when needed. The base class does all the heavy lifting.

---

## 3. Download Handler

### 3.1 FileTransferHandler -- BaseSubModule

A new `BaseSubModule` subclass at `src/handlers/menucommands/fileTransfer.js`. This is the terminal-facing handler that manages the full download lifecycle within the menu system.

**Why BaseSubModule, not BaseHandler**: Downloads are launched from within the menu system (from the file browser or a menu command). `BaseSubModule` is the correct pattern for inline operations within `MenuHandler`, following the same approach as `msgReader`, `fileBrowser`, and all other menu commands. The menu handler manages inactivity timeouts and cleanup.

### 3.2 Lifecycle

```
MenuHandler._runSubModule(new FileTransferHandler(call, files, opts))
  |
  v
FileTransferHandler.run()
  |-- Validate files array (non-empty, all paths exist)
  |-- Show pre-transfer screen (file list, total size, protocol)
  |-- Prompt: "Hang up after transfer?" [Y/n] (Enter defaults to Yes)
  |-- Wait for user confirmation (Enter to start, Q to cancel)
  |
  v (on confirmation)
  |-- Instantiate ZmodemProtocol(call, files)
  |-- protocol.start()
  |     |-- Spawns sz via PTY
  |     |-- Enables raw mode (client bytes -> sz, sz bytes -> client)
  |     |-- Terminal client auto-detects ZMODEM, switches to receive
  |     |-- Transfer runs...
  |     |-- PTY exits
  |     v
  |-- protocol emits "Complete" or "Error"
  |
  v
  |-- Disable raw mode (automatic via BaseProtocol._onProcessExit)
  |-- Increment download counts for successfully transferred files
  |-- Clear batch if this was a batch download
  |-- Show result screen ("Transfer complete" or error details)
  |-- If hangup chosen: auto-disconnect after 1500 ms delay
  |-- Otherwise: wait for keypress, signalReturn() -> back to menu/file browser
```

### 3.3 Pre-transfer screen

Before starting the transfer, display a confirmation screen:

```
  Download Files via ZMODEM
  ────────────────────────────────
  1) filename1.zip          2.4 MB
  2) filename2.txt         14.1 KB
  ────────────────────────────────
  Total: 2 files, 2.4 MB

  Hang up after transfer? [Y/n]

  Your terminal client should auto-detect the transfer.

  [Enter] Start   [Q] Cancel
```

### 3.4 Hangup-after-transfer prompt

All four download handlers (`fileBatchCheck`, `fileBatchDownload`, `fileBrowser`, `fileSearch`) present a "Hang up after transfer?" `[Y/n]` prompt before starting the ZMODEM transfer. Enter defaults to Yes.

This is a common BBS pattern — users who are downloading a batch often want to disconnect immediately rather than navigate back through menus. The prompt appears after file confirmation but before `sz` is spawned.

**Implementation varies by handler:**
- `fileBatchDownload` uses a state machine (`hangup_ask → downloading → result → done`).
- `fileBrowser` uses `_hangupPrompt`/`_hangupResult` flags on the browser instance (both D and B keys).
- `fileSearch` shows the prompt on the status row during the D key flow.
- `fileBatchCheck` includes the prompt in its login-flow batch check sequence.

After a successful transfer, if hangup was chosen the system auto-disconnects after a 1500 ms delay. Otherwise it shows "press any key" and returns to the previous view.

### 3.5 Post-transfer screen

After transfer completion:

```
  Transfer Complete
  ────────────────────────────────
  2 files sent successfully.

  Press any key to continue...       (if hangup=no)
  -- or --
  Disconnecting...                   (if hangup=yes, after 1500 ms)
```

On error:

```
  Transfer Error
  ────────────────────────────────
  sz exited with code 1
  The transfer may have been cancelled or timed out.

  Press any key to continue...
```

### 3.6 Error handling

- **File not found on disk**: Skip the file, log a warning, continue with remaining files. Show which files were skipped in the post-transfer screen.
- **sz not installed**: Detect at handler start (`which sz` or check exit code). Show a message: "ZMODEM transfer is not available. Please download via the web interface." Fall back to showing the web URL.
- **Transfer cancelled by user**: `sz` exits with a non-zero code. Clean up and return to caller.
- **Connection dropped**: `call.connectionClosed()` propagates through the handler chain. `BaseSubModule.clearHandler()` deactivates. The protocol's `_cleanup()` kills the PTY process.
- **Timeout**: Configurable inactivity timeout (default 120 seconds). If no data flows for the timeout period, abort the transfer.

### 3.7 Dumb terminal fallback

Dumb terminals cannot run ZMODEM. The handler detects `this.dumb` and falls back to displaying the web download URL for each file:

```
  Download these files via the web interface:
  /files/download/<uuid1>  (filename1.zip)
  /files/download/<uuid2>  (filename2.txt)

  Press Enter to continue...
```

---

## 4. Batch Management

### 4.1 call.file_batch

A new property on `IncomingCall`, initialized as an empty array in the constructor:

```js
this.file_batch = []
```

Each entry in the array is a lightweight reference object:

```js
{
  uuid: "file-entry-uuid",
  id: 42,                    // file_entries.id (for download count increment)
  filename: "doom.zip",
  file_size: 2457600,
  area_shortcode: "DOSGAMES",
  area_id: 5,
  disk_path: "doom.zip"      // relative to area directory
}
```

**Why lightweight references instead of full DB rows**: The batch may persist for the entire session. Storing only the fields needed for transfer and display keeps memory usage low and avoids stale data issues. The full file path is resolved at download time by looking up the group and area.

### 4.2 Batch operations

These are utility functions, not a separate class. They can live in a small module `src/utils/fileBatch.js` or be methods directly on the handler that uses them:

- **addToBatch(call, fileEntry, areaConfig)** -- Push a batch reference. Deduplicate by UUID (skip if already tagged).
- **removeFromBatch(call, uuid)** -- Remove by UUID.
- **clearBatch(call)** -- Empty the array.
- **isBatchEmpty(call)** -- Boolean check.
- **getBatchCount(call)** -- Return length.
- **getBatchTotalSize(call)** -- Sum of file_size values.
- **isInBatch(call, uuid)** -- Check if a specific file is already tagged.

### 4.3 Batch size limit

Configurable maximum batch size (default: 50 files). Prevents users from tagging the entire file base. Enforced in `addToBatch()`.

### 4.4 Resolving file paths at download time

When the transfer starts, each batch entry's full disk path must be resolved:

```
for each batch entry:
  area = await getAreaByShortcode(entry.area_shortcode)
  group = await getGroupByShortcode(area.group_shortcode)  // or cache from area row
  basePath = resolveAreaPath(group, area)
  fullPath = path.join(basePath, entry.disk_path)
  -- verify file exists on disk
```

This deferred resolution means batch entries survive area path config changes during the session.

---

## 5. File Browser Integration

### 5.1 New hotkeys in fileBrowser.js

| Key | Context | Action |
|-----|---------|--------|
| `T` | File list (lightbar) | Tag/untag highlighted file for batch |
| `T` | File detail view | Tag/untag current file for batch |
| `D` | File list | Download highlighted file immediately (single file) |
| `D` | File detail view | Download current file immediately (single file) |
| `B` | File list | Download entire batch |

### 5.2 Tag indicator

In the file list, tagged files show a marker in the prefix column:

- Untagged: `  ` (two spaces)
- Tagged: ` +` (space + plus sign, or a glyph like the bullet character)
- Highlighted + tagged: shows the arrow indicator but with a distinct color

### 5.3 Status bar batch count

When the batch is non-empty, the status bar (row `_statusRow`) includes the batch count:

```
 File 3/47                          Batch: 5 files (12.3 MB)
```

### 5.4 Download trigger from file browser

When `D` is pressed:
1. If no file is highlighted or the file list is empty, do nothing.
2. Build a single-entry file array from the highlighted/current file.
3. Resolve the full disk path.
4. The file browser emits a custom event or calls a callback to signal the parent `MenuHandler` to launch the `FileTransferHandler` sub-module. **Alternatively**, the file browser can handle this internally by instantiating the protocol directly (since it already has `call` access and raw mode is managed by the protocol, not the sub-module hierarchy).

**Recommended approach**: The file browser should signal back to the `MenuHandler` to launch `FileTransferHandler` as a new sub-module. This keeps the sub-module lifecycle clean -- one active sub-module at a time, managed by the menu handler. The file browser emits `ModuleReturn` with a payload indicating "launch download with these files," and the menu handler starts the transfer handler. When the transfer handler completes, the menu handler restarts the file browser.

**Simpler alternative**: Since the download is a transient operation that returns to the same state, the file browser could directly manage the protocol instance (enable raw mode, run sz, restore, redraw). This avoids the sub-module dance but means the file browser manages raw mode itself. Given that the file browser already has significant state (cursor position, scroll, loaded files, search), re-entering it cleanly after a sub-module return is complex. **The direct approach is recommended for single-file downloads from within the browser.** Batch downloads from the menu command use the sub-module approach.

### 5.5 Batch download trigger

When `B` is pressed in the file list:
1. Check if `call.file_batch` is non-empty. If empty, show a brief message ("No files tagged").
2. Follow the same launch pattern as `D` but with the full batch array.

---

## 6. Call Object Modifications

### 6.1 New properties on IncomingCall

Add to the constructor in `callmanager.js`:

```js
this.file_batch = []
```

This is the only change to the call object. The batch array persists for the session lifetime and is cleaned up when the call ends (garbage collected with the call object).

### 6.2 No new properties needed for protocol state

The protocol and handler manage their own state. Raw mode save/restore is handled within the protocol class (same pattern as `DoorRunner`). No additional call properties are needed.

---

## 7. Menu Command Additions

### 7.1 New menu commands

Add to the command dispatch table in `menuhandler.js` and the command list in `menus.js`:

| Command | Arg | Action |
|---------|-----|--------|
| `downloadBatch` | (none) | Launch FileTransferHandler with `call.file_batch` contents |
| `viewBatch` | (none) | Show tagged files, allow remove/clear/download |
| `clearBatch` | (none) | Clear `call.file_batch` |

### 7.2 downloadBatch command

Launched as a sub-module. Checks if the batch is non-empty. If empty, shows "No files in batch" and returns. Otherwise launches `FileTransferHandler` with the batch contents.

### 7.3 viewBatch command

A small sub-module that displays the current batch contents in a scrollable list:

```
  Download Batch (5 files, 12.3 MB)
  ────────────────────────────────
  1) doom.zip           2.4 MB  [DOSGAMES]
  2) quake.zip          8.1 MB  [DOSGAMES]
  3) readme.txt         1.2 KB  [UTILS]
  ...

  [D] Download All  [R] Remove  [C] Clear  [Q] Back
```

This can be a simple implementation -- the batch is small (max 50 items), so no pagination complexity is needed for most cases.

---

## 8. Implementation Phases

### Phase 1: Core Protocol + Single File Download

**Goal**: Get a working ZMODEM download from the file browser detail view.

1. Install `lrzsz` package on the server.
2. Create `src/protocols/base.js` -- `BaseProtocol` class with PTY spawn, raw mode save/restore, I/O wiring, cleanup.
3. Create `src/protocols/zmodem.js` -- `ZmodemProtocol` extending base, builds `sz` command, spawns via PTY.
4. Modify `fileBrowser.js` -- Replace `_showDownloadInfo()` with actual download when `D` is pressed. The browser directly instantiates `ZmodemProtocol`, runs the transfer, then redraws.
5. Add `file_batch` property to `IncomingCall` constructor (prep for Phase 2).
6. Test with SyncTERM and NetRunner over both TCP and WebSocket.

**Estimated scope**: ~200-300 lines of new code across 3 files.

### Phase 2: Batch Management

**Goal**: Users can tag files and download them as a batch.

1. Add batch utility functions (add, remove, clear, dedupe).
2. Add `T` hotkey to `fileBrowser.js` for tagging in both list and detail views.
3. Add tag indicator to file list row rendering.
4. Add batch count to status bar.
5. Add `B` hotkey for batch download trigger.
6. Increment download counts after successful batch transfer.

**Estimated scope**: ~150-200 lines of modifications to `fileBrowser.js`, ~50 lines for batch utilities.

### Phase 3: Menu Commands + Transfer Handler Sub-Module

**Goal**: Downloads accessible from menu commands, not just the file browser.

1. Create `src/handlers/menucommands/fileTransfer.js` -- `FileTransferHandler` sub-module with pre-transfer screen, confirmation, protocol launch, post-transfer screen, download count incrementing.
2. Add `downloadBatch`, `viewBatch`, `clearBatch` commands to `menuhandler.js` dispatch.
3. Add command entries to `menus.js` command list.
4. Create `viewBatch` sub-module with batch display/management.

**Estimated scope**: ~300-400 lines across new files, ~30 lines of wiring in existing files.

### Phase 4: Polish + Future Protocols (Lower Priority)

1. Add configurable transfer timeout (appConfig key).
2. Add server-side transfer logging (alogger entries for started/completed/failed transfers).
3. Implement YMODEM stub (`sb` binary).
4. Implement XMODEM stub (`sx` binary).
5. Add protocol selection if multiple protocols are available (most users will just use ZMODEM).
6. Consider upload support (reverse direction -- `rz` binary, `call.file_batch` for staging).

---

## 9. Dependency Requirements

### 9.1 System packages

Add to the documented system requirements:

```bash
apt install lrzsz    # provides sz, sb, sx (ZMODEM/YMODEM/XMODEM send)
                     # and rz, rb, rx (receive, for future upload support)
```

### 9.2 No new npm dependencies

The implementation uses only existing npm packages:
- `node-pty` (already used by DoorRunner)
- `path`, `fs` (Node.js built-ins)

---

## 10. Security Considerations

### 10.1 File path validation

When resolving file paths for download, the handler must:
- Verify the file entry exists in the database and is `active = true`.
- Resolve the path through `resolveAreaPath()` (never accept user-supplied paths).
- Verify the resolved file exists on disk before passing to `sz`.
- Check that the user has read access to the file's area (security level + permission flags + restriction flags).

### 10.2 sz command construction

The `sz` command receives only fully resolved absolute file paths computed from database records. No user input is interpolated into the command string. The PTY spawn uses an argument array, not a shell string:

```js
pty.spawn("sz", ["--zmodem", "--binary", fullPath1, fullPath2], opts)
```

### 10.3 Rate limiting

No explicit rate limiting in the initial implementation. The batch size limit (50 files) and natural transfer speed provide implicit limits. Future consideration: per-user daily download byte limits if needed.

---

## 11. Relationship to Existing Code

### 11.1 Old testdownload.js

The file `src/handlers/menucommands/Old/testdownload.js` contains an earlier attempt that referenced a `transferHandler` and `sexyz` (Synchronet's external protocol handler). That code is inactive -- the current `testdownload.js` is an empty stub class. The old approach used `sexyz` which is a Synchronet-specific binary and not appropriate for a standalone system.

The new design replaces this entirely with the standard `lrzsz` package, which is protocol-native and does not depend on Synchronet infrastructure.

### 11.2 DoorRunner pattern reuse

The protocol classes reuse the exact same raw mode pattern from `DoorRunner`:

- Save `call.rawmode` and `call.rawtarget`
- Set `call.rawmode = true`
- Set `call.rawtarget` to a function that forwards data to the PTY
- On exit, restore both saved values

This is a proven pattern already handling door games across all connection types.

### 11.3 File path resolution

Downloads use the same `resolveAreaPath(group, area)` function from `fileAreas.js` that TIC processing and the web download route use. Single source of truth for file locations.
