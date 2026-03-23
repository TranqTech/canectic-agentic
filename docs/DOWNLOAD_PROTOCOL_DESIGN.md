# Terminal File Transfer System -- Design Document

Design document for terminal-side file transfers in Canectic BBS. Covers protocol architecture, native XMODEM and ZMODEM engine implementation, batch management, and integration with the existing file browser and menu system.

For the file area system (schemas, storage, TIC networking), see `FILE_SYSTEM_DESIGN.md`.
For the terminal architecture (handlers, call lifecycle, raw mode, doors), see `terminal_architecture.md`.
For the process model, see `PROCESS_ARCHITECTURE.md`.

---

## 1. Architecture Summary

### 1.1 Approach: Native Protocol Engines

The system uses native JavaScript XMODEM and ZMODEM protocol engines (`src/transfers/`) for all file transfers. Terminal wrappers in `src/protocols/` bridge these engines to call objects using a StreamAdapter pattern. The previous lrzsz-based wrappers (`zmodem.js`, `zmodem_receive.js`) remain as fallback but are no longer the default path.

**Architecture**:

- `src/transfers/` contains protocol-agnostic engines: `XmodemEngine` (XMODEM-CRC and XMODEM-1K) and `ZmodemEngine` (full ZMODEM with ZDLE escaping, hex/binary/ZBIN32 headers, CRC-16/CRC-32, streaming, crash recovery, ZCRC).
- `src/protocols/xmodem_native.js` and `src/protocols/zmodem_native.js` are terminal wrappers that use the StreamAdapter pattern to bridge engine I/O to `call` objects. They suppress terminal output during transfers and reset inactivity timeouts on data flow.
- All five terminal download/upload handlers prompt for protocol selection (XMODEM or ZMODEM) before transfers begin. XMODEM uploads also prompt for a filename.
- ZMODEM sender adapts to receiver capabilities: uses ZBIN32+CRC-32 when the receiver advertises CANFC32, falls back to ZBIN+CRC-16 otherwise. ZRINIT flags use the ZF0=p3 byte position per the ZMODEM specification.

**No external dependencies**: Native engines eliminate the `lrzsz` system package requirement. The `lrzsz` wrappers remain available as fallback.

### 1.2 Engine vs Wrapper Separation

| Layer | Directory | Purpose |
|-------|-----------|---------|
| Engine | `src/transfers/` | Pure protocol logic. No call/terminal dependencies. Testable in isolation. |
| Wrapper | `src/protocols/` | Bridges engine to call object. Manages raw mode, output suppression, timeout resets. |
| Handler | `src/handlers/menucommands/` | User-facing. Protocol selection prompt, file resolution, download counts, batch management. |

Shared constants and CRC routines (`constants.js`, `crc.js`) are used by both XMODEM and ZMODEM engines.

### 1.3 WebSocket binary considerations

Both TCP and WebSocket connections send raw bytes through `call.cmds.senddata()` -> `_send()`. The WebSocket `_send()` calls `socket.send(Buffer.from(data))`, which transmits binary frames. ZMODEM auto-detection works at the byte level, so terminal clients connected via WebSocket will receive the ZMODEM initiation bytes and auto-switch to receive mode the same way TCP clients do.

The `ws` library (used by the Gateway) sends `Buffer` data as binary WebSocket frames by default. No special handling is needed.

---

## 2. Protocol Module Architecture

### 2.1 Directory structure

```
src/transfers/
  constants.js           -- Shared byte constants for XMODEM and ZMODEM
  crc.js                 -- CRC-16 (CCITT) and CRC-32 routines
  xmodem.js              -- XmodemEngine: XMODEM-CRC and XMODEM-1K send/receive state machine
  zmodem.js              -- ZmodemEngine: ZMODEM send/receive with full protocol support

src/protocols/
  base.js                -- BaseProtocol class (abstract, used by lrzsz fallback wrappers)
  xmodem_native.js       -- StreamAdapter wrapper for XmodemEngine
  zmodem_native.js       -- StreamAdapter wrapper for ZmodemEngine
  zmodem.js              -- lrzsz fallback: ZMODEM send via sz
  zmodem_receive.js      -- lrzsz fallback: ZMODEM receive via rz
```

### 2.2 Native Engine Classes

#### XmodemEngine (`src/transfers/xmodem.js`)

XMODEM-CRC and XMODEM-1K send/receive state machine. Single-file protocol.

- **Send**: Waits for NAK (checksum) or 'C' (CRC) from receiver, then sends 128-byte (XMODEM-CRC) or 1024-byte (XMODEM-1K) blocks with CRC-16. Handles ACK/NAK retries.
- **Receive**: Sends 'C' to initiate CRC mode, receives blocks, validates CRC-16, sends ACK/NAK.

#### ZmodemEngine (`src/transfers/zmodem.js`)

Full ZMODEM implementation with streaming, crash recovery, and receiver capability adaptation.

- **Send**: ZRINIT negotiation, ZFILE/ZDATA/ZEOF/ZFIN sequence, ZDLE escaping, streaming with ZCRCG/ZCRCQ subpackets. Adapts to receiver: ZBIN32+CRC-32 when CANFC32 advertised, ZBIN+CRC-16 otherwise. Crash recovery via ZRPOS. ZCRC file integrity support.
- **Receive**: Sends ZRINIT with capability flags (ZF0=p3 byte position per spec), receives ZFILE metadata, ZDATA streaming, validates CRC per subpacket, sends ZRPOS on errors.
- **Headers**: Hex (ZPAD+ZDLE+ZHEX), binary (ZBIN+CRC-16), binary32 (ZBIN32+CRC-32).

### 2.3 StreamAdapter Wrappers

`xmodem_native.js` and `zmodem_native.js` bridge engines to call objects:

- Suppress normal terminal output during transfers (prevent protocol bytes from being interpreted as terminal commands)
- Reset call inactivity timeouts on data flow (prevents session timeout during long transfers)
- Wire `call.cmds.senddata()` for outbound data and `call.rawtarget` for inbound data
- Restore terminal state on completion or error

### 2.4 Legacy lrzsz Wrappers

`BaseProtocol`, `ZmodemProtocol`, and `ZmodemReceiveProtocol` remain for fallback use. They spawn external `sz`/`rz` via child_process with raw stdio pipes. These require the `lrzsz` system package.

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
  |-- Show pre-transfer screen (file list, total size)
  |-- Prompt: protocol selection (XMODEM / ZMODEM)
  |-- Prompt: "Hang up after transfer?" [Y/n] (Enter defaults to Yes)
  |-- Wait for user confirmation (Enter to start, Q to cancel)
  |
  v (on confirmation)
  |-- Instantiate native protocol wrapper (zmodem_native or xmodem_native)
  |-- protocol.send(filePaths) / protocol.receive(targetDir)
  |     |-- StreamAdapter bridges engine I/O to call object
  |     |-- Suppresses terminal output, resets inactivity timeout on data flow
  |     |-- Transfer runs via native engine state machine
  |     v
  |-- Protocol resolves on completion or rejects on error
  |
  v
  |-- Restore terminal state (automatic via wrapper cleanup)
  |-- Increment download counts for successfully transferred files
  |-- Clear batch if this was a batch download
  |-- Show result screen ("Transfer complete" or error details)
  |-- If hangup chosen: auto-disconnect after 1500 ms delay
  |-- Otherwise: wait for keypress, signalReturn() -> back to menu/file browser
```

### 3.3 Pre-transfer screen

Before starting the transfer, display a confirmation screen:

```
  Download Files
  ────────────────────────────────
  1) filename1.zip          2.4 MB
  2) filename2.txt         14.1 KB
  ────────────────────────────────
  Total: 2 files, 2.4 MB

  Protocol: [Z] ZMODEM  [X] XMODEM

  Hang up after transfer? [Y/n]

  [Enter] Start   [Q] Cancel
```

### 3.4 Hangup-after-transfer prompt

All four download handlers (`fileBatchCheck`, `fileBatchDownload`, `fileBrowser`, `fileSearch`) prompt for protocol selection (XMODEM or ZMODEM) and present a "Hang up after transfer?" `[Y/n]` prompt before starting the transfer. Enter defaults to Yes.

This is a common BBS pattern — users who are downloading a batch often want to disconnect immediately rather than navigate back through menus. The prompt appears after file confirmation but before the transfer starts. XMODEM uploads additionally prompt for a filename since the protocol does not transmit filenames.

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
- **Transfer cancelled by user**: Engine detects receiver abort (CAN bytes for XMODEM, ZCAN for ZMODEM). Clean up and return to caller.
- **Connection dropped**: `call.connectionClosed()` propagates through the handler chain. `BaseSubModule.clearHandler()` deactivates. The wrapper cleans up engine state.
- **Timeout**: The wrapper resets the call inactivity timeout on every data flow event. If no data flows for the configured timeout period, the transfer is aborted.

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

## 8. Implementation Status

All phases are complete. The system uses native XMODEM and ZMODEM engines with protocol selection prompts in all handlers.

### Completed

1. Native protocol engines in `src/transfers/` (XmodemEngine, ZmodemEngine, shared CRC and constants).
2. StreamAdapter wrappers in `src/protocols/` (xmodem_native.js, zmodem_native.js).
3. All five terminal handlers (fileBrowser, fileBatchDownload, fileBatchCheck, fileSearch, fileUpload) use native engines with protocol selection.
4. Batch management with tagging, batch download, login-flow batch check.
5. Menu commands: `downloadBatch`, `viewBatch`, `clearBatch`.
6. Upload support via native XMODEM and ZMODEM receive. XMODEM uploads prompt for filename.
7. Test suite: `tests/transferCrc.test.js`, `tests/xmodem.test.js`, `tests/zmodemSend.test.js`, `tests/zmodemRecv.test.js`.

---

## 9. Dependency Requirements

### 9.1 No required system packages

Native engines have no external dependencies. The `lrzsz` package (`sz`/`rz`) is optional for fallback use only.

### 9.2 No new npm dependencies

The implementation uses only Node.js built-ins (`path`, `fs`, `zlib` for CRC-32).

---

## 10. Security Considerations

### 10.1 File path validation

When resolving file paths for download, the handler must:
- Verify the file entry exists in the database and is `active = true`.
- Resolve the path through `resolveAreaPath()` (never accept user-supplied paths).
- Verify the resolved file exists on disk before passing to the engine.
- Check that the user has read access to the file's area (security level + permission flags + restriction flags).

### 10.2 File path handling

Native engines receive only fully resolved absolute file paths computed from database records. No user input is used in path construction. Upload filenames from ZMODEM ZFILE headers or XMODEM user prompts are sanitized before use.

### 10.3 Rate limiting

No explicit rate limiting in the initial implementation. The batch size limit (50 files) and natural transfer speed provide implicit limits. Future consideration: per-user daily download byte limits if needed.

---

## 11. Relationship to Existing Code

### 11.1 Old testdownload.js

The file `src/handlers/menucommands/Old/testdownload.js` contains an earlier attempt that referenced a `transferHandler` and `sexyz` (Synchronet's external protocol handler). That code is inactive and replaced by the native engine implementation.

### 11.2 Raw mode pattern

The StreamAdapter wrappers reuse the same raw mode pattern as `DoorRunner`:

- Save `call.rawmode` and `call.rawtarget`
- Set `call.rawmode = true` and `call.rawtarget` to forward data to the engine
- Suppress terminal output during transfer to prevent protocol bytes from being interpreted
- Reset inactivity timeout on data flow
- On completion, restore saved state

### 11.3 File path resolution

Downloads use the same `resolveAreaPath(group, area)` function from `fileAreas.js` that TIC processing and the web download route use. Single source of truth for file locations.
