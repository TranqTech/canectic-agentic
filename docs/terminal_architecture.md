# Terminal Architecture

Reference document for the terminal-side BBS architecture. Covers the call lifecycle, handler system, input/output pipeline, door execution, and menu framework. Intended as a living reference for ongoing, future, and parallel development sessions.

For the message and message networking stack, see `network_architecture.md`.

---

## System Overview

The terminal side of the BBS is an event-driven Node.js application. There is no blocking I/O in the call path — input arrives as raw bytes, flows through a parser into token arrays, and is dispatched to the active handler. Output is sent through connection-specific command objects that abstract away transport differences.

The system supports three connection types (TCP, WebSocket, Telnet) and multiple terminal capabilities (ANSI, UTF-8, CP437, RIP, Sixel, dumb). A single `nodeManager` instance tracks all active sessions for node allocation, who's-online displays, and door capacity enforcement.

---

## Core Modules

### CallManager / CallPool / IncomingCall (`callmanager.js`)

Three-tier call management:

- **CallManager** — Top-level container. Holds an array of `CallPool` instances and a shared `nodeManager`. Creates pools and exposes pool listing.
- **CallPool** — Groups calls by purpose (e.g. a standard BBS pool vs. a door-server pool). Each pool has a `floworder` that determines the call flow its calls follow. Handles call creation (node allocation, `IncomingCall` instantiation) and removal (node release, cleanup).
- **IncomingCall** — The central object for a connected session. Holds all per-session state: user identity, terminal capabilities, permissions, current menu, handler reference, command set, input parser, output buffer, and flow position. Drives the handler lifecycle.

Key `IncomingCall` responsibilities:
- **Flow management**: Walks through a declared stage sequence, resolving what loads next on handler completion.
- **Handler lifecycle**: Loads, wires events for, and cleans up handlers via `loadHandler()`, `_wireHandlerEvents()`, and `_onHandlerComplete()`.
- **Data routing**: `handleData()` feeds raw bytes through the input parser or directly to a raw-mode target.
- **Door launching**: `launchDoor()` is an async method that fetches door config from the DB, checks capacity, and instantiates the appropriate runner.
- **Output buffering**: Writes to an `OutputRingBuffer` for sysop node-spy functionality.

### NodeManager (`nodemanager.js`)

Shared singleton managing node number allocation and a registry of active sessions.

- **Node allocation**: `getAvailNodeNum()` finds the lowest unused integer and reserves it. `releaseNodeNum()` frees it and emits `NodeReleased`.
- **Registry**: Each node entry tracks: `nodenum`, `username`, `status`, `detail`, `detail_display`, `connection_type`, `since` timestamp, and `callId`.
- **Status updates**: `updateNode()`, `setNodeUsername()`, `setNodeCallId()`, `setNodeConnectionType()`.
- **Door capacity**: `getDoorCount(doorSlug)` counts nodes with status "door" and matching detail. `doorHasCapacity(doorSlug, maxnodes)` checks against limits.
- **Who's online**: `getActiveNodes()` returns shallow copies of all registry entries. `getNodesInDoor(doorSlug)` filters to a specific door.

---

## Call Flows

Declared as ordered arrays of stage names in `callFlows`. The reserved name `"goodbye"` triggers hangup.

```
Standard:   negotiate → logon → last_callers → menu → goodbye
Doorserver: door_auth → door_launch → goodbye
Test:       negotiate → goodbye
```

Flow entries can be strings or objects with a `stage` key and additional args that get applied to the call object. Handlers can override flow progression by emitting `NextStage` with a specific stage name, or advance linearly by emitting `ModuleReturn`.

### Handler Registry

Maps stage names to factory functions:

| Stage | Handler | Notes |
|-------|---------|-------|
| `negotiate` | `TerminalNegotiator` | Detects terminal capabilities |
| `logon` | `LogonHandler` | Pre-login display/new user flow |
| `login` | `LoginHandler` | Authentication |
| `door_auth` | `DoorAuthHandler` | External door authentication |
| `event_login` | `DoorAuthHandler` | Alias for door auth |
| `menu` | `MenuHandler` | Main interactive menu system |
| `door_launch` | `DoorLaunchHandler` | Routes to door target or door menu |
| `last_callers` | `SubModuleAdapter(LastCallers)` | Recent caller display |
| `whos_online` | `SubModuleAdapter(WhosOnline)` | Active node display |

---

## Handler System

### BaseHandler (`basehandler.js`)

Abstract base for all handlers. Provides:

- **Timeout management**: `_setTimeout()` / `_clearAllTimeouts()` with a tracked `Set` of timer IDs. Callbacks are guarded against running after handler deactivation.
- **Inactivity system**: Configurable `inactivityTO` and `warnBuff` with `setInactivityTimeouts()` / `resetInactivityTimeouts()`. Fires `onInactivityWarn()` then `onInactivityKick()` (sends warning message, then hangs up).
- **Error isolation**: `_handleError()` logs, attempts hangup, and calls `clearHandler()`. Prevents cascading failures.
- **Input dispatch**: `handleInput(inputArray)` clears timeouts, iterates tokens, calls `_dispatchInput()` which routes `KEY_*` → `onKey()`, `CHAR_*` → `onChar()`, `CMD_*` → `onCmd()`. Resets inactivity after processing.
- **Lifecycle**: `startStage()` (override to begin), `signalReturn()` (emits `ModuleReturn`), `clearHandler()` (deactivates, clears timeouts, removes listeners, nulls call reference).

Subclasses override `onKey()`, `onChar()`, `onCmd()`, and `startStage()`.

### BaseSubModule (`basesubmodule.js`)

Lighter-weight unit for inline operations within a handler (typically MenuHandler):

- Same input dispatch pattern as BaseHandler (`handleInput` → `onKey`/`onChar`/`onCmd`).
- **Zombie timeout**: Safety net that re-emits `ModuleReturn` if the parent handler doesn't clean up promptly. Default 10 seconds.
- **Lifecycle**: `run()` (override for main logic, called by `startStage()`), `signalReturn()`, `signalHangup()`, `clearHandler()`.
- Tracks `dumb` terminal status from call's `term_type`.

---

## Input / Output Pipeline

### Input Path

```
Raw bytes from connection
  → IncomingCall.handleData()
    → if rawmode: directly to call.rawtarget(data)
    → else: hex-encode → ansiInputParser.hexbuffer
      → parseHexByte() per byte
        → escape sequence detection (timeout-based ESC disambiguation)
        → token generation: KEY_*, CHAR_*, CMD_*
      → flushOutput()
        → call.currentHandler.handleInput(tokenArray)
          → BaseHandler._dispatchInput()
            → onKey() / onChar() / onCmd()
```

### ansiInputParser (`terminalcommands.js`)

- Converts hex-encoded byte stream into semantic tokens.
- Handles ANSI escape sequence parsing with a configurable timeout (`df_esc_timeout = 50ms`) to distinguish bare ESC from ESC sequences.
- Key mappings: arrow keys, delete, home, end, tab, enter, backspace, Ctrl+A/S/Z.
- Batches output tokens and flushes to the active handler.

### Output Path

```
Handler logic
  → call.cmds.senddata() / sendstring() / setfgcolor() / movecursor() / etc.
    → BaseCommands._send() [abstract]
      → tcpCommands: socket.write()
      → websockCommands: socket.send()
      → telnetCommands: socket.write() (TODO: IAC escaping)
    → call.writeOutputBuffer() → OutputRingBuffer (for node-spy)
```

### Terminal Commands (`terminalcommands.js`)

`BaseCommands` provides the full output API:

- **Core output**: `senddata()`, `sendstring()`, `sendbeep()`
- **Art system**: `drawfile()`, `drawscreen()`, `drawrandomscreen()` with format fallback chain (RIP → Sixel → UTF-8 → ANSI → ASCII). SAUCE record stripping. Sixel DCS handling.
- **Colors**: `setfgcolor()` / `setbgcolor()` (numeric), `setfgcolorname()` / `setbgcolorname()` (named), `resetcolors()`. 16-color palette (0-15).
- **Cursor/screen**: `clearscreen()`, `movecursor()`, `clearline()`, `cleartoeol()`, directional moves, `homecursor()`.
- **Terminal awareness**: `_isDumb()`, `_isUTF8()`, `_useRip()`, `_useSixel()`, `_getTermType()`, `_getEncoding()`. Dumb terminals get graceful fallbacks (newlines instead of screen clears, etc.).

Connection subclasses only override `_send()`:
- `tcpCommands` — `socket.write()`
- `websockCommands` — `socket.send()`
- `telnetCommands` — `socket.write()` (IAC escaping TODO)

### OutputRingBuffer (`ringbuffer.js`)

Line-based ring buffer for sysop node-spy:

- Default capacity: 2000 lines.
- `write(data)` — splits on `\n`, maintains partial `currentLine`, trims when over capacity. Emits `"data"` event with raw buffer for live watchers.
- `getHistory()` — returns concatenated buffer of all stored lines plus current partial line (for catch-up on snoop attach).
- Max 20 event listeners (for multiple concurrent snoop sessions).

### DoorOutputParser (`outputParser.js`)

Translates door output for modern terminals:

- **CP437 → Unicode**: Full translation table for bytes 0x00-0xFF. Control codes (BEL, BS, TAB, LF, CR, ESC) pass through; others map to CP437 glyphs.
- **ANSI cursor remapping**: Tracks virtual cursor position through all CSI sequences (CUP, CUU/CUD/CUF/CUB, ED, EL, SCP/RCP). Translates positions by calculated offsets when centering is active.
- **Screen centering**: For terminals larger than 80x25. Calculates column/row offsets, draws a Unicode box-drawing border around the door viewport, and remaps all cursor positioning.
- **State machine parser**: NORMAL → ESC → CSI_PARAM → process. Handles intermediates, parameters, OSC sequences (discarded). Batches output for efficiency.

---

## Menu System

### MenuHandler (`menuhandler.js`)

Extends `BaseHandler`. The main interactive hub after login.

**Configuration** (loaded from DB via `getMenu()`):
- `menu_entries`: Array of entry objects with `hotkey`, `display`, `command_name`, `command_arg`, access control fields (`min_security`, `required_flags`, `prohibited_flags`), and display colors (`fg_clr`, `bg_clr`).
- `display_file` / `display_file_type`: Optional art file shown as menu background.
- `display_entries`: Whether to render entry list over the display file.
- Layout controls: `entries_x_offset`, `entries_y_offset`, `max_columns`, `col_gap`.
- Theme color overrides.

**Access control**: `_isEntryAccessible()` checks caller's security level, permission flags (must have ALL required), and restriction flags (must have NONE of prohibited).

**Layout engine**: `_calcLayout()` computes column count, column width, rows per page, and paginates entries. Column-first fill order. Adapts to terminal dimensions. Dumb terminals get a simple linear listing with pause-on-overflow.

**Navigation**: Menu history stack (max 20) on the call object. `_navigateToMenu()` pushes current menu and emits `NextStage "menu"`. `_navigateBack()` pops history. Root menus (currently just "Main") clear the history stack.

**Command dispatch** (`_doMenuCommand()`):

| Command | Behavior |
|---------|----------|
| `logOff` | Emits `HangupSignal` |
| `runXtrn` | Calls `call.launchDoor(arg, true)` |
| `loadMenu` | Validates existence, navigates to target menu |
| `previousMenu` | Pops menu history |
| `exitStage` | Sets `finished = true` to advance call flow |
| `redrawMenu` | Redraws screen |
| `msgGroupChange` | Sub-module |
| `msgAreaChange` | Sub-module |
| `listMessages` | Sub-module |
| `readMessages` | Sub-module |
| `postMessage` | Sub-module |
| `userList` | Sub-module |
| `lastCallers` | Sub-module |
| `whosOnline` | Sub-module |
| `testDownload` | Sub-module |

**Sub-module management**: `_runSubModule()` pauses the menu, wires `ModuleReturn` and `HangupSignal`, starts the module. Menu handler owns inactivity timeouts even while a sub-module is active. On return, `_doModuleReturn()` cleans up and redraws.

---

## Door System

### DoorLaunchHandler (`doorlaunchhandler.js`)

Thin routing stage for call flows. If `call.doorTarget` is set, calls `call.launchDoor()` directly. Otherwise sets `currentMenu` to `"doorsession"` and emits `NextStage "menu"` so the user can pick a door from a menu. Doesn't process input.

### DoorRunner (`doorrunner.js`)

Extends `BaseHandler`. Manages the full lifecycle of launching an external door game.

**Launch types**:

| Type | Method | I/O | Use Case |
|------|--------|-----|----------|
| `NativeShell` | `node-pty` spawn | PTY | Native Linux doors (default) |
| `ExecNative` | `child_process.exec` | stdin/stdout pipe | Native with shell interpretation |
| `SpawnNative` | `child_process.spawn` | stdin/stdout pipe | Native without shell features |
| `Dosemu` | `exec("dosemu ...")` | stdin/stdout pipe | DOS doors via dosemu (simple) |
| `DosemuPty` | socat + SerialPort + exec | Virtual serial pair | DOS doors with COM port emulation |

**Raw mode**: Temporarily hijacks `call.rawmode` and `call.rawtarget` to bypass the input parser. Saves/restores previous state cleanly for nesting.

**DosemuPty pipeline**:
```
User ↔ SerialPort (port1) ↔ socat pair ↔ dosemu COM5 (port2)
                                          ↓
                              DoorOutputParser (optional)
                                          ↓
                              call.cmds.senddata()
```
- `socatManager.allocate()` creates a virtual serial port pair.
- One end opened with `SerialPort`, the other passed to dosemu as a COM device.
- `DoorOutputParser` inserted when the user's terminal needs CP437→UTF-8 conversion or centering (triggers: terminal wider than 90 cols or taller than 30 rows).
- dosemu stdout goes to `call.writeOverrideBuffer()` for node-spy (separate from the serial data path).

**Dropfile support**: `_doDropfile()` creates door drop files (e.g. DOOR.SYS) via `dropfile_handler`. Supports `usereal_doorsession` / `usereal_local` flags for real name vs. handle in the dropfile.

**Exit handling**: `_onDoorExit()` resets raw mode, resets colors. If `pauseOnExit` is configured, shows "Press any key to continue..." and waits in raw mode for one keypress before signaling return. `signalReturn()` respects `doorConfig.returnStage` for custom post-door routing.

**Cleanup**: `_killProcesses()` tears down all resources: serial port, PTY, child process, socat allocation, output parser, and raw mode state.

---

## Development Roadmap

### Planned / In Progress

_Section for tracking development plans, priorities, and stage completion._

| Area | Item | Status | Notes |
|------|------|--------|-------|
| Telnet | IAC escaping in `telnetCommands._send()` | TODO | Currently uses raw `socket.write()` |
| Messages | Phase 1: Unified area selector with lightbar | **Done** | `msgAreaSelector.js` — replaces old msggroups + msgareas |
| Messages | Phase 2: Fullscreen message reader | **Done** | `msgReader.js` — thread list + message view + flat mode |
| Messages | Phase 2d: Newscan | **Done** | `newscan.js` — summary screen + sequential reader launch |
| Messages | Phase 3: Message editor | **Done** | `msgEditor.js` — fullscreen + dumb, new thread + reply. Wired into reader R key. |

---

## Message System — Terminal Side

### Data Layer Summary

The message models are shared between the web and terminal sides. See `network_architecture.md` for the full data flow and schema. Key points for terminal development:

**Models used by terminal message commands:**

| Model | Key Functions | Notes |
|-------|---------------|-------|
| `messages.js` | `listMsgGroups(security)`, `getAreasInGroup(shortcode, security)`, `getMessages(shortcode, options)`, `getMessage(id, shortcode)`, `getThreadsForArea(shortcode)`, `getRecentThreadsForArea(shortcode)`, `getThreadsPage(shortcode, options)`, `getMessagesForThread(shortcode, threadId)`, `getMessageCount(shortcode)`, `countMessagesBefore(shortcode, beforeId, threadId)`, `saveMessage(formObj, shortcode, threaduuid)`, `startNewThread(formObj, shortcode)`, `replyToThread(formObj, shortcode, threaduuid)` | Central view and posting model |
| `userMsgPointers.js` | `advancePointer(userId, area, maxMsgId)`, `advanceThreadPointer(userId, area, threadId, maxMsgId)`, `markAreaRead(userId, area)`, `getUnreadCount(userId, area)`, `hasNewMessages(userId, area)`, `getNewscanSummary(userId)`, `getFirstUnreadInThread(userId, area, threadId)`, `getFirstUnreadInArea(userId, area)`, `getThreadUnreadCounts(userId, area, threadIds)` | Two-tier read tracking |
| `msgGroups.js` | `getGroupByShortcode(shortcode)`, `getActiveGroups()` | Group CRUD model |
| `msgAreas.js` | `getAreaByShortcode(shortcode)` | Area CRUD model |
| `useraccounts.js` | `updateUserMsgGroup(username, group)`, `updateUserMsgArea(username, area)` | Persists user's current group/area selection |

**Database schema (key tables for terminal):**

Per-area message tables: `mb_<shortcode>_msgs` — messages with `id` (BIGSERIAL), `uuid`, `msg_id`, `thread_id` (FK to threads.id), `threadid` (FTN message-ID string), `reply_to`, `from_user`, `to_user`, `subject`, `body_text`, `utf8`, `body_html`, `system_time`, `origin_line`.

Per-area thread tables: `mb_<shortcode>_threads` — threads with `id` (BIGSERIAL), `uuid`, `threadid` (FTN message-ID of root), `subject`, `started_at`, `started_by`, `message_count`, `last_message`, `last_message_from`.

`user_msg_pointers` — area-level scan pointer (floor): `user_id`, `area_shortcode`, `scan_pointer` (msg id), `last_read_at`.

`user_thread_pointers` — per-thread pointer (granularity above floor): `user_id`, `area_shortcode`, `thread_id`, `scan_pointer`, `last_read_at`.

**Read-state resolution:** A message is unread if `msg.id > MAX(area_pointer, COALESCE(thread_pointer, 0))`.

**Message body for terminal display:** Use `msg.utf8 || msg.body_text`. The `body_html` field is for web rendering only. Terminal messages may contain ANSI escape codes, pipe codes (`|XX`), or Ctrl-A codes that should be passed through directly to ANSI-capable terminals. For dumb terminals, strip escape sequences and display plain text.

**Area thread_mode:** Controls presentation: `standard` (threaded view with thread listing), `no_threads` (flat message list only), `subscribe_only` (future — only subscribed threads in newscan).

**Area post_as:** Controls poster name: `username` (login name) or `realname` (full name, falling back to username).

### Call Object Properties (Message State)

These properties on `IncomingCall` track the user's current message context:

| Property | Type | Source | Notes |
|----------|------|--------|-------|
| `msg_group` | string | `user_record.msg_group` | Current group shortcode (persisted to user record) |
| `msg_group_title` | string | Set by selector | Display name of current group |
| `msg_area` | string | `user_record.msg_area` | Current area shortcode (persisted to user record) |
| `msg_area_title` | string | Set by selector | Display name of current area |
| `security` | integer | `user_record.security` | Used to filter groups/areas by read_security |
| `user_record` | object | Set at login | Full user DB row, needed for `user_record.id` in pointer operations |

### Phase 1: Unified Area Selector — COMPLETE

**File:** `handlers/menucommands/msgAreaSelector.js`

Replaces the old separate `msggroups.js` and `msgareas.js` with a single unified lightbar selector. Loads all accessible groups and areas (filtered by `call.security`), displays areas nested under group headers, and lets the user navigate with a lightbar. Selecting an area updates both `call.msg_group` and `call.msg_area` and persists to the user record.

Features: encoding-aware glyphs (CP437 vs UTF-8), search mode (S key, live filtering), dumb terminal fallback (numbered list), blue highlight bar with distinct colors for current selection vs cursor position.

Fixes from old code: stores shortcodes not names, passes security for filtering, uses correct `.name` column from DB rows.

### Phase 2: Message Reader (`handlers/menucommands/msgReader.js`)

Single unified `BaseSubModule` with an internal state machine. Handles thread listing, message viewing, flat browsing, and mode switching. Dumb terminals get a line-mode fallback.

#### State Machine

```
                    ┌─────────────────────────────────────────┐
                    │           LOADING                        │
                    │  fetch area config, threads/pointers     │
                    └──────┬───────────────┬──────────────────┘
                           │               │
                   thread_mode=standard    thread_mode=no_threads
                           │               │
                           ▼               ▼
              ┌────────────────────┐  ┌──────────────────────┐
              │   THREAD_LIST      │  │   MESSAGE_VIEW       │
              │   lightbar over    │  │   flat mode           │
              │   threads          │  │   start at pointer    │
              └──┬──┬──┬──────────┘  └──┬────────────────────┘
                 │  │  │                │
          Enter  │  │  │ F (flat)       │ ESC/Q
                 │  │  │                ▼
                 │  │  │          signalReturn
                 ▼  │  ▼
   ┌─────────────┐  │  ┌──────────────────────┐
   │MESSAGE_VIEW │  │  │   MESSAGE_VIEW        │
   │ threaded    │  │  │   flat mode            │
   │ within      │  │  │   all messages         │
   │ thread      │  │  │                        │
   └──┬──────────┘  │  └──┬────────────────────┘
      │             │     │
      │ ESC/Q       │     │ T (threaded toggle)
      ▼             │     ▼
   THREAD_LIST ◄────┘  THREAD_LIST
```

**State transitions:**

| From | Input | To | Notes |
|------|-------|----|-------|
| LOADING | data ready, standard | THREAD_LIST | Fetch threads + unread counts |
| LOADING | data ready, no_threads | MESSAGE_VIEW (flat) | Start at first unread via pointer |
| THREAD_LIST | Enter | MESSAGE_VIEW (threaded) | Load messages for selected thread, start at first unread |
| THREAD_LIST | F | MESSAGE_VIEW (flat) | Switch to flat chronological view |
| THREAD_LIST | ESC/Q | signalReturn | Back to menu |
| MESSAGE_VIEW (threaded) | ESC/Q | THREAD_LIST | Return to thread list |
| MESSAGE_VIEW (threaded) | T | THREAD_LIST | Toggle back to thread list view |
| MESSAGE_VIEW (flat) | T | THREAD_LIST | Switch to threaded view (only if area is standard) |
| MESSAGE_VIEW (flat) | ESC/Q | THREAD_LIST if standard, else signalReturn | Context-dependent exit |
| MESSAGE_VIEW (any) | Right | Next message | Within thread or flat list |
| MESSAGE_VIEW (any) | Left | Previous message | Within thread or flat list |
| MESSAGE_VIEW (any) | L | Last message | Jump to newest message in thread/flat list |
| MESSAGE_VIEW (any) | R | Reply | Launch message editor (Phase 3 — stub for now) |
| MESSAGE_VIEW (threaded) | ] | Next thread | Jump to first unread in next thread |
| MESSAGE_VIEW (threaded) | [ | Previous thread | Jump to first message in prev thread |

#### Data Loading Strategy

**Thread list mode:**
- Initial load: `getRecentThreadsForArea(shortcode)` — returns threads active in last 180 days, minimum 50.
- Unread counts: `getThreadUnreadCounts(userId, shortcode, threadIds)` — single batch query.
- Lazy extend: `getThreadsPage(shortcode, { beforeDate, beforeId, limit: 30 })` for keyset pagination when scrolling past loaded threads.

**Entering a thread:**
- First unread position: `getFirstUnreadInThread(userId, shortcode, threadId)` → returns msg ID.
- Load batch: `getMessages(shortcode, { threadId, afterId: firstUnread - 1, limit: 30, order: 'ASC' })`.
- Lazy load older: `getMessages(shortcode, { threadId, beforeId: oldestLoadedId, limit: 30, order: 'DESC' })` → reverse result.
- Lazy load newer: `getMessages(shortcode, { threadId, afterId: newestLoadedId, limit: 30, order: 'ASC' })`.

**Flat mode:**
- First unread: `getFirstUnreadInArea(userId, shortcode)` → returns msg ID.
- Same lazy-load pattern as threads but without `threadId` filter.

**Thread switching (] / [):**
- Reader keeps a reference to the thread list and current thread index.
- `]` increments thread index, loads the new thread's messages starting at first unread.
- `[` decrements. Wrapping at boundaries is optional.

#### Viewport Geometry — Wide Terminal Handling

Two geometry zones in message view:

- **Full-width zone** — message header (rows 1-3), separator, status bar, nav bar. These use the full `term_width`. The header benefits from extra space for field layout.
- **Body zone** — message body viewport and thread list content. Capped at **100 columns** max width, horizontally centered on wide terminals.

```
Calculation:
  bodyWidth = min(term_width, 100)
  bodyLeft  = floor((term_width - bodyWidth) / 2) + 1   (1-based cursor coords)
  bodyRight = bodyLeft + bodyWidth - 1
```

Stored in `_calcGeometry()` as `this.bodyWidth`, `this.bodyLeft`, `this.bodyRight`. Full-width elements just use column 1 through `term_width`.

This applies per zone:

**Full-width (col 1 to term_width):**
- Message header fields (From/To/Subject/Date/Area) — spread across full width
- Separator line — spans full terminal width
- Status bar
- Nav bar

**Body zone (bodyLeft to bodyRight, max 100 cols):**
- Message body text — word-wrapped to `bodyWidth - 2` (1 col margin each side within body zone)
- Thread list — columns calculated from `bodyWidth`, rows positioned at `bodyLeft`
- Thread list lightbar and search — within body zone

#### Screen Layout — Thread List

Thread list uses the body zone for content, full width for status/nav:

```
                          |<--- bodyWidth (max 100) --->|
                          |                              |
Row 1:      (bodyLeft)    ┌ AreaName              42 threads  5 unread
Row 2:                    Info/search line
Row 3-H-1:                Thread list with lightbar
                            Subject             From          Msgs  Last    New
                          ► Welcome to the BBS  SysOp           15  Jan 15    3
                            BBS Discussion      JohnDoe         42  Jan 14
                            Old Topic           Guest            2  Jan 01
Row H:      (col 1)       [Enter] Read  [F] Flat View  [S] Search  [ESC/Q] Back
```

**Thread list columns** (computed to fit `bodyWidth`):
- Subject: flexible width (fills remaining space)
- From: 16 chars
- Msgs: 5 chars (right-aligned count)
- Last: 6 chars (short date — "Jan 15" or "Mar 12")
- New: 4 chars (unread count or blank)

Column header row is part of the viewport (row 3), pinned during scroll. Lightbar skips it.

Threads with unread messages get a distinct color for the "New" column. Currently selected thread highlighted with blue bar (same as area selector).

#### Screen Layout — Message View

Header uses full width, body is centered/constrained:

```
|<------------------------ term_width (full) ---------------------------->|
|                                                                          |
Row 1:  From: sender                                    Date: 2024-01-15 14:32
Row 2:  To: recipient                                   Area: AreaName
Row 3:  Subject: Re: Something
Row 4:  ──────────────────────────────────────────────────────────────────────
        |                                                                  |
        |             |<--- bodyWidth (max 100) --->|                      |
        |             |                              |                     |
Row 5-H-2:  (bodyLeft) Message body (scrollable viewport)
                       > This is a quoted line
                       > from the previous message

                       Here is my reply text that continues
                       across multiple lines...

Row H-1: Msg 3/15 | Thread: "Welcome" (5/42) | 3 unread  ^v
Row H:   [Left] Prev [Right] Next [R]eply [L]ast [[] []] Thd [T]oggle [Q]uit
```

**Header block** (rows 1-3): Full terminal width. Fixed position, redrawn when message changes. Colors distinguish field labels from values. Date/Area right-aligned.

**Separator** (row 4): Encoding-aware horizontal line (─ in UTF-8, 0xC4 in CP437). Spans full `term_width`.

**Body viewport** (rows 5 to H-2): Positioned within body zone (`bodyLeft` to `bodyRight`). Scrollable view into the message body lines.
- Body text is pre-processed into an array of display lines (word-wrapped to `bodyWidth - 2`).
- `bodyLines[]` array, `bodyScrollOffset` tracks the top visible line.
- PgUp/PgDn scroll the viewport by one page.
- Up/Down arrow keys scroll one line at a time. **They never change messages** — body scroll only.
- Space bar scrolls down one page (classic BBS behavior). At the end of the body, advances to the next message.

**Status bar** (row H-1): Full terminal width. Shows position within thread/area, scroll indicator (`^`/`v`/both/neither using ASCII-safe chars), unread remaining.

**Nav bar** (row H): Full terminal width. Context-sensitive — shows thread nav keys `[[]` `[]]` only in threaded mode. Shows `[T]oggle` only if area supports both modes. Shows `[L]ast` always. Shows `[R]eply` always (stub until Phase 3).

#### Body Text Processing

Handled by `termMsgFormat.js` utility module, called from `msgReader._prepareBodyLines()`.

**Processing pipeline per message:**
1. Get raw text: `msg.utf8 || msg.body_text || ''`
2. **CP437 → UTF-8 conversion**: If terminal is UTF-8 and message has no `utf8` field (body is CP437), convert extended bytes (0x80-0xFF) to Unicode equivalents
3. **Pipe code conversion**: `|XX` patterns (|00-|23) → ANSI SGR escape sequences
4. **Ctrl-A code conversion**: `\x01X` patterns → ANSI SGR escape sequences (Synchronet-style)
5. **ANSI passthrough**: Existing `\x1b[` escape sequences are preserved, never stripped
6. Normalize line endings: `\r\n` → `\n`, lone `\r` → `\n`
7. Split on `\n` into lines
8. **Classify each line**: normal, quote, tear, origin, or kludge (kludge lines are hidden)
9. **Word-wrap** plain text lines to `(bodyWidth - 2)` columns. Lines with embedded color codes are NOT wrapped (ANSI positioning would break)
10. **Apply semantic color prefixes**: Each line gets an ANSI SGR prefix based on its type:
    - Normal text: bright yellow (default, theme key `msg_body_clr`)
    - Quote lines (`>`, `XX>`, `->`, `-=>`, `=>`, etc.): bright cyan (theme key `msg_quote_clr`)
    - Tear lines (`---`): bright white (theme key `msg_tear_clr`)
    - Tagline separators (`--`, `===`): bright green (theme key `msg_tagline_clr`)
    - Origin lines (anything after a tear or tagline separator): bright blue (theme key `msg_origin_clr`)
11. **Two-level footer tracking**: Tagline separator (`--`, `===`) and tear line (`---`) each trigger a different color cascade:
    - After a tagline separator: subsequent lines get tagline color (bright green) — this covers the actual tagline text
    - After a tear line: subsequent lines get origin color (bright blue) — tear overrides tagline, covering origin, SEEN-BY, PATH, etc.
    - A message with both (tagline before tear) gets green tagline text between the separators, then blue origin text after the tear
12. For messages WITH embedded color codes: semantic colors are still applied at the start of each line. Embedded codes naturally override as the terminal processes left to right. Exception: ANSI art (cursor positioning detected) gets no prefixes.
13. Store as `bodyLines[]` array of `{ text, type, colorPrefix }` objects

**Line classification rules:**
- Quote: line starts with `>`, `>>`, or 1-3 letter initials followed by `>` or `>>` then space (e.g. `De> `, `JD>> `). Also any mix of `-` and `=` arrow indicators followed by `>` and space (e.g. `-> `, `-=> `, `=> `, `==> `).
- Tear: line is exactly `---` or starts with `--- ` (FTN tear line)
- Tagline: line is `--` (signature separator) or `===`+ (three or more equals signs)
- Origin: line matches `* Origin:` (with optional leading whitespace), OR any line appearing after a tear or tagline separator
- Kludge: line starts with `\x01` (SOH — FTN internal, never displayed)
- Everything else: normal text

**Theme color overrides** (in theme JSON config):
```json
{
    "msg_body_clr": 11,
    "msg_quote_clr": 14,
    "msg_tear_clr": 15,
    "msg_tagline_clr": 10,
    "msg_origin_clr": 12
}
```

**Dumb terminal fallback**: CP437 conversion and pipe/ctrl-a conversion are applied. Lines are paginated with `[More]` prompts. No semantic coloring.

#### Pointer Advancement

Pointers advance as the user views messages, not on exit. This ensures progress is saved even if the connection drops.

| Context | On message view | Function |
|---------|----------------|----------|
| Threaded mode | Each message displayed | `advanceThreadPointer(userId, shortcode, threadId, msg.id)` |
| Flat mode | Each message displayed | `advancePointer(userId, shortcode, msg.id)` |
| Mark area read (hotkey) | M key in thread list | `markAreaRead(userId, shortcode)` |

Both pointer functions use `GREATEST()` — they only move forward, so re-viewing an older message is harmless.

#### Thread Navigation (] and [)

The reader maintains:
- `threadList[]` — the loaded thread array (same data as the thread list view)
- `threadIdx` — current position in that array

When `]` is pressed:
1. Increment `threadIdx` (stop at end, or lazy-load more threads)
2. `getFirstUnreadInThread()` for the new thread
3. Load message batch starting at first unread
4. Redraw message view

When `[` is pressed:
1. Decrement `threadIdx` (stop at 0)
2. Load first message of previous thread
3. Redraw message view

The thread list and message view share the `threadList` reference, so selecting a thread in the list view sets `threadIdx`, and thread nav in message view updates it — returning to the thread list will have the cursor on the thread you navigated to.

#### Input Handling Summary

**Thread list mode:**

| Input | Action |
|-------|--------|
| Up/Down | Move lightbar |
| PgUp/PgDn | Page through threads |
| Home/End | Jump to first/last |
| Enter | Open selected thread at first unread |
| F | Switch to flat message view |
| S | Enter search mode (filter threads by subject/author) |
| M | Mark entire area as read |
| ESC/Q | Return to menu |

**Message view mode:**

| Input | Action |
|-------|--------|
| Up | Scroll body up one line (never changes message) |
| Down | Scroll body down one line (never changes message) |
| PgUp | Scroll body up one page |
| PgDn | Scroll body down one page |
| Space | Scroll body down one page; at end of body, advance to next message |
| Right | Next message |
| Left | Previous message |
| L | Jump to last (newest) message in thread or flat list |
| ] | Next thread (threaded mode only) |
| [ | Previous thread (threaded mode only) |
| T | Toggle threaded/flat (standard areas only) |
| R | Reply — launch message editor (Phase 3 stub) |
| ESC/Q | Back to thread list (threaded) or exit (flat in no_threads area) |

#### Module Structure

Single file `msgReader.js`, single class extending `BaseSubModule`. Internal state tracked by `this._state` enum. Major method groups:

```
// State management
_setState(newState)
_loadThreadList()
_loadMessagesForThread(threadId)
_loadMessagesFlat()

// Geometry
_calcGeometry()        // bodyWidth, bodyLeft, bodyRight (constrained), body height; full-width uses term_width directly

// Thread list rendering
_drawThreadListScreen()
_drawThreadRow(thread, screenY, isHighlighted)
_drawThreadStatusBar()

// Message view rendering
_drawMessageScreen()
_drawMessageHeader(msg)
_drawSeparator()
_drawBodyViewport()
_drawMessageStatusBar()
_drawMessageNavBar()

// Body text processing
_prepareBodyLines(msg)  // word-wrap to bodyWidth - 2
_scrollBody(direction, pages)

// Navigation
_nextMessage()
_prevMessage()
_jumpToLast()
_nextThread()
_prevThread()
_openThread(threadIdx)
_switchToFlat()
_switchToThreaded()

// Pointer management
_advancePointer(msg)

// Input routing
onKey(key) — routes to _onKeyThreadList() or _onKeyMessageView()
onChar(ch) — routes to _onCharThreadList() or _onCharMessageView()
```

#### Encoding-Aware Glyphs

Uses same `_sendGlyph(utf8Char, cp437Byte)` pattern as `msgAreaSelector`:

| Glyph | Usage | UTF-8 | CP437 |
|-------|-------|-------|-------|
| ─ | Header separator | U+2500 | 0xC4 |
| ┌ | Group prefix in thread list | U+250C | 0xDA |
| ► | Lightbar arrow | U+25BA | 0xAF |
| • | Current/unread marker | U+2022 | 0xF9 |
| ^ | Scroll up indicator | `^` (ASCII) | `^` (ASCII) |
| v | Scroll down indicator | `v` (ASCII) | `v` (ASCII) |

Scroll indicators use plain ASCII in both encodings — the CP437 triangle glyphs (0x1E/0x1F) are in the control code range and would be eaten by the terminal.

For scroll indicators, use ASCII fallbacks (`^` / `v`) in CP437 mode since 0x1E/0x1F are in the control code range.

### Phase 2d — Newscan (`handlers/menucommands/newscan.js`)

Extends `BaseSubModule`. Scans across areas for unread messages. Supports "all groups" and "current group only" modes.

**Flow:**
1. Load all accessible areas with unread counts via `getUnreadCount()` per area
2. Display summary screen with lightbar — area names, unread counts, totals
3. User presses Enter to start sequential scan, or G to jump to selected area
4. For each area with unreads: set call's area context → instantiate `msgReader` → run it
5. When reader signals `ModuleReturn` (user pressed ESC/Q), advance to next area with unreads
6. When all areas scanned, show completion screen and return
7. Restores original `call.msg_area` / `call.msg_group` on exit

**Summary screen hotkeys:** Enter (start scan), G (go to selected area), M (mark all read), Up/Down (navigate), ESC/Q (back to menu).

**Constructor options:**
```javascript
new newscan(call, { scanMode: "all" })    // scan all groups
new newscan(call, { scanMode: "group" })  // scan current group only
```

**MenuHandler integration:** Two menu commands, one for each mode:
```javascript
case "newscan":
    this._runSubModule(new newscan(this.call, { scanMode: "all" }));
    return;
case "newscanGroup":
    this._runSubModule(new newscan(this.call, { scanMode: "group" }));
    return;
```

### Phase 3: Message Editor (`handlers/menucommands/msgEditor.js`)

Single unified `BaseSubModule` with fullscreen editing for ANSI terminals and line-mode fallback for dumb terminals. Called from the reader's `R` key (reply) or from a menu command (new thread).

#### Invocation Modes

The editor receives an options object at construction:

```javascript
new msgEditor(call, {
    mode: "reply",              // "reply" or "new"
    shortcode: "GENERAL",       // area shortcode
    threadUUID: "abc-123-...",  // reply mode only — thread to reply in
    replyToMsg: { ... },        // reply mode only — parent message object (for quoting + reply_to)
})
```

**New thread mode**: Empty To (defaults to "All"), empty Subject, empty body.
**Reply mode**: To pre-filled with parent message's `from_user`, Subject pre-filled with `Re: <parent subject>`, body empty but quote panel available.

#### post_as Resolution

The area's `post_as` setting determines the `from_user` field:
- `username` → `call.caller_username`
- `realname` → `call.caller_fullname || call.caller_username`

Resolved at construction time from the call object and area config. The user cannot edit the From field — it's display-only.

#### formObj for saveMessage()

```javascript
{
    from_user:  resolvedName,
    to_user:    toFieldValue || "All",
    subject:    subjectFieldValue,
    body_text:  bodyText,           // joined from lines, \r\n line endings
    reply_to:   parentMsg.msg_id,   // reply mode only — for FTN @REPLY kludge
}
```

Called via `saveMessage(formObj, shortcode, threadUUID)` — dispatches to `startNewThread` or `replyToThread` internally.

#### Word Wrap Constraint

Body text is hard-wrapped at **79 columns** during editing (not just display-wrapped). This ensures outbound FTN/QWK messages render correctly on remote systems with 80-column terminals. The wrap happens live as the user types — when a line exceeds 79 chars, the last word is moved to the next line (push-down wrap, like classic BBS editors).

#### State Machine

```
FIELD_TO → (Tab/Enter) → FIELD_SUBJECT → (Enter) → BODY → (Ctrl+Z) → CONFIRM_SAVE
                                                        → (Ctrl+A) → CONFIRM_ABORT
                                                        → (Ctrl+Q) → QUOTING → BODY
```

| State | Description |
|-------|-------------|
| FIELD_TO | Editing the To field (single line, inline edit) |
| FIELD_SUBJECT | Editing the Subject field (single line, inline edit) |
| BODY | Main body editing area with cursor and scroll |
| QUOTING | Quote panel — select lines from parent to insert |
| CONFIRM_SAVE | "Save message? Y/N" prompt |
| CONFIRM_ABORT | "Abort message? Y/N" prompt |

#### Screen Layout — Fullscreen Editor

```
|<------------------------ term_width (full) ---------------------------->|
|                                                                          |
Row 1:  From: YourName (display-only)                    Area: AreaName
Row 2:    To: [All_________________________]
Row 3:  Subj: [Re: Welcome to the BBS_____]
Row 4:  ──────────────────────────────────────────────────────────────────
        |             |<--- bodyWidth (max 79) ---->|                      |
Row 5-H-2: (bodyLeft)  Message body editing area
                       > Quoted line from parent
                       > Another quoted line
                       
                       Here is what I'm typing now_
                       
Row H-1: Line 3/5  Col 32  Ins                                      ^v
Row H:   [Ctrl+Z] Save  [Ctrl+A] Abort  [Ctrl+Q] Quote  [Tab] Fields
```

**Header fields** (rows 1-3): Full terminal width. Row 1 is display-only (From + Area). Rows 2-3 are editable single-line fields with visible cursor. The active field gets a distinct color.

**Separator** (row 4): Full width, same as reader.

**Body area** (rows 5 to H-2): Centered, max 79 columns. This is the editing viewport. Cursor rendered as the terminal's native cursor positioned via ANSI. Scrolls when cursor moves beyond visible area.

**Status bar** (row H-1): Line/column position, scroll indicators.

**Command bar** (row H): Available commands.

#### Body Editing Buffer

```javascript
this._lines = [""];        // Array of strings, one per line
this._cursorLine = 0;      // Current line index
this._cursorCol = 0;       // Column within current line
this._scrollOffset = 0;    // First visible line in viewport
this._insertMode = true;   // Insert vs overwrite
```

**Character input**: Insert character at cursor position. If line exceeds 79 chars, perform word-wrap: find the last space before column 79, split there, push remainder to next line (creating a new line if at end of buffer). Move cursor to the appropriate position on the wrapped line.

**Enter**: Split current line at cursor. Text after cursor becomes a new line below.

**Backspace**: Delete character before cursor. If at column 0, merge current line with previous line (pull-up).

**Delete**: Delete character at cursor. If at end of line, merge next line into current (pull-up).

**Arrow keys**: Move cursor. Up/Down move between lines (clamping column to line length). Left at column 0 moves to end of previous line. Right at end of line moves to start of next line.

**PgUp/PgDn**: Scroll viewport by page height, move cursor to keep it visible.

**Home/End**: Move cursor to start/end of current line.

#### Quote System

When `Ctrl+Q` is pressed in reply mode:

1. Transition to QUOTING state
2. Display parent message body as numbered lines in the body area
3. Lightbar or number selection to pick lines
4. Selected lines are inserted at the cursor position with `> ` prefix
5. Multiple lines can be selected (toggle with Enter, submit with Ctrl+Q or ESC)
6. Return to BODY state

**Quote line formatting**: Lines from parent are word-wrapped to 76 columns (79 minus `> ` prefix length of 2, minus 1 for safety). Each inserted line gets `> ` prepended.

#### Save Flow

1. User presses Ctrl+Z → CONFIRM_SAVE state
2. Prompt "Save message? (Y/N): " on status bar
3. Y → join lines with `\r\n`, build formObj, call `saveMessage()`, display result, signalReturn
4. N → return to BODY state

#### Input Handling Summary

**Field editing (To/Subject):**

| Input | Action |
|-------|--------|
| Printable char | Insert at cursor |
| Backspace | Delete before cursor |
| Delete | Delete at cursor |
| Left/Right | Move cursor |
| Home/End | Start/end of field |
| Tab / Enter (To) | Move to Subject field |
| Enter (Subject) | Move to Body |
| Ctrl+A | Abort confirmation |
| ESC | Abort confirmation |

**Body editing:**

| Input | Action |
|-------|--------|
| Printable char | Insert at cursor, auto-wrap at 79 cols |
| Enter | Split line at cursor |
| Backspace | Delete before cursor, merge lines if at col 0 |
| Delete | Delete at cursor, merge next line if at end |
| Up/Down | Move cursor between lines |
| Left/Right | Move cursor within line, wrap to adjacent lines at boundaries |
| PgUp/PgDn | Scroll viewport by page |
| Home/End | Start/end of current line |
| Tab | Return to To field |
| Ctrl+Z | Save confirmation |
| Ctrl+A | Abort confirmation |
| Ctrl+Q | Enter quote mode (reply mode only) |

**Quote selection:**

| Input | Action |
|-------|--------|
| Up/Down | Move selection cursor |
| Enter | Toggle line selection |
| Ctrl+Q / ESC | Insert selected lines at body cursor, return to BODY |

**Confirm prompts:**

| Input | Action |
|-------|--------|
| Y | Execute (save or abort) |
| N / ESC | Cancel, return to BODY |

#### Dumb Terminal Fallback

Sequential prompts, no cursor positioning:

```
To [All]: 
Subject: Re: Welcome
────────────────
Enter message. /S to save, /A to abort, /Q to quote.
> 
> Here is the quoted line from parent
> 
This is my reply text.
More text here.
/S
Save message? (Y/N): Y
Message saved.
```

Line-mode editor accepts text line by line. Commands start with `/` at the beginning of a line:
- `/S` — save
- `/A` — abort
- `/Q` — show quote panel (numbered lines, enter number to insert)
- `/D` — delete last line

#### Module Structure

```
// State management
_setState(newState)

// Geometry
_calcGeometry()        // bodyWidth (max 79), bodyLeft, field positions

// Name resolution
_resolveFromName()     // post_as → username or realname

// Header rendering
_drawScreen()
_drawHeader()
_drawSeparator()
_drawStatusBar()
_drawCommandBar()

// Field editing
_drawField(row, label, value, cursorPos, isActive)
_handleFieldInput(key, ch)

// Body rendering
_drawBodyViewport()
_drawBodyLine(lineIdx)

// Body editing
_insertChar(ch)
_doEnter()
_doBackspace()
_doDelete()
_doWordWrap(lineIdx)    // auto-wrap at 79 cols with word-boundary split

// Cursor management
_moveCursor(dLine, dCol)
_ensureCursorVisible()

// Quoting
_enterQuoteMode()
_exitQuoteMode()
_drawQuotePanel()
_insertQuotedLines()

// Save/abort
_confirmSave()
_confirmAbort()
_doSave()

// Input routing
onKey(key)
onChar(ch)
```

### Shared Utilities

Several pieces of logic will be shared across the message modules:

**Terminal text display** — Word-wrapping body text to terminal width, handling ANSI passthrough vs. stripping for dumb terminals. May warrant a small `termTextUtils.js` helper.

**Message header formatting** — Consistent header block rendering (From/To/Subject/Date/Area) used by both readers and the lister detail view.

**Pointer management** — Wrapper that handles advancing area and thread pointers after viewing, used by both reader modes and newscan.

### MenuHandler Integration

The menu command dispatch in `menuhandler.js` already has slots for these commands. The mapping:

| Menu Command | Module | Notes |
|--------------|--------|-------|
| `msgGroupChange` | `msgAreaSelector` (Phase 1) | Unified selector replaces both old commands |
| `msgAreaChange` | `msgAreaSelector` (Phase 1) | Same module — both hotkeys open same selector |
| `listMessages` | `msgReader` (Phase 2) | Opens in thread list or flat mode based on area config |
| `readMessages` | `msgReader` (Phase 2) | Same module, could start at first unread directly |
| `postMessage` | `msgEditor` (Phase 3) | New thread mode via menu; reply mode via reader's R key |
| `newscan` | `newscan` (Phase 2d) | All-groups mode; new slot in menu command dispatch |
| `newscanGroup` | `newscan` (Phase 2d) | Current-group mode; new slot in menu command dispatch |
| `markAreaRead` | Inline in menu dispatch | Calls `markAreaRead()` directly, no sub-module needed |

The `readMessages` wrapper should detect `call.term_type` and route to line reader (dumb terminals) or fullscreen reader (ANSI terminals). Same pattern for the editor.

### Future Considerations

- File transfer protocols (Zmodem, etc.)
- Announcement handler
- Top menu handler
- Logoff handler with call statistics
- RIP graphics support depth
- Sixel image rendering pipeline
- Inter-node messaging / chat
- Node-spy (sysop) live terminal mirroring (infrastructure exists via `OutputRingBuffer`)
- Thread preferences (subscribe/ignore/mute) — schema designed, not yet implemented
- User QWK download/upload from terminal menu

---

## Known Issues / Bugs

| File | Issue | Status |
|------|-------|--------|
| `doorrunner.js` | `needsCP437` undefined in `_startSerial()` — should be `needsUTF8` | Fixed |
| `msggroups.js` (old) | References `.title` on DB rows — actual column is `.name` | Fixed — replaced by `msgAreaSelector.js` |
| `msgareas.js` (old) | References `.title` on DB rows — actual column is `.name` | Fixed — replaced by `msgAreaSelector.js` |
| `msggroups.js` (old) | Doesn't pass `call.security` to `listMsgGroups()` | Fixed — replaced by `msgAreaSelector.js` |
| `msggroups.js` (old) | Stores group `.name` in `call.msg_group` instead of `.shortcode` | Fixed — replaced by `msgAreaSelector.js` |
| `msgareas.js` (old) | Same name-vs-shortcode issue for `call.msg_area` | Fixed — replaced by `msgAreaSelector.js` |
| `terminalcommands.js` | Missing PgUp/PgDn/Insert escape sequence mappings in `ansiInputParser` | Fixed — added `[5~`, `[6~`, `[2~`, `[1~`, `[4~` |

---

## File Index

| File | Location | Purpose |
|------|----------|---------|
| `callmanager.js` | core | CallManager, CallPool, IncomingCall — call lifecycle and flow engine |
| `nodemanager.js` | core | Node number allocation, session registry, door capacity |
| `terminalcommands.js` | commandsets | BaseCommands, TCP/WS/Telnet subclasses, ansiInputParser |
| `basehandler.js` | handlers | Abstract handler base — timeouts, input dispatch, error isolation |
| `basesubmodule.js` | handlers | Lighter sub-module base for inline operations |
| `menuhandler.js` | handlers | Menu system — config loading, layout, navigation, command dispatch |
| `doorlaunchhandler.js` | handlers | Thin routing stage for door launching in call flows |
| `doorrunner.js` | handlers | Door execution — 5 launch types, raw mode, process lifecycle |
| `ringbuffer.js` | handlers | Line-based output ring buffer for node-spy |
| `outputParser.js` | helpers | CP437→Unicode, ANSI cursor remapping, door output centering |
| `msgAreaSelector.js` | handlers/menucommands | Unified group/area selector with lightbar and search (Phase 1) |
| `msgReader.js` | handlers/menucommands | Fullscreen message reader — thread list, message view, flat mode (Phase 2) |
| `msgEditor.js` | handlers/menucommands | Message editor — fullscreen + dumb fallback, new thread + reply (Phase 3) |
| `newscan.js` | handlers/menucommands | Cross-area newscan, wraps msgReader (Phase 2d) |
| `termMsgFormat.js` | utils | Terminal message formatting — CP437 conversion, pipe/Ctrl-A→ANSI, semantic line coloring |
| **Shared models** | | |
| `messages.js` | models | Message viewing, posting, sanitization |
| `msgGroups.js` | models | Message group CRUD |
| `msgAreas.js` | models | Message area CRUD, table management |
| `userMsgPointers.js` | models | Two-tier read tracking (area pointers + thread pointers) |
| `echomail.js` | models | FTN echomail import/export, threading |
