# Terminal Architecture

Reference document for the terminal-side BBS architecture. Covers the call lifecycle, handler system, input/output pipeline, door execution, and menu framework. Intended as a living reference for ongoing, future, and parallel development sessions.

For the shared message platform (schemas, read tracking, body_html pipeline, posting, web views), see `message_architecture.md`.
For the networking/tosser stack, see `NETWORKING_ARCHITECTURE.md`.
For the web application (Express, sessions, admin panel, WebSockets), see `web_architecture.md`.
For the process model, job queues, and inter-process signaling, see `PROCESS_ARCHITECTURE.md`.

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
Standard:   negotiate -> logon -> last_callers -> check_online -> announcements -> wall -> verify_mail -> check_email -> check_batch -> menu -> goodbye
Doorserver: door_auth -> door_launch -> goodbye
WebDoor:    webdoor_auth -> door_launch -> goodbye
Test:       negotiate -> goodbye
```

Flow entries can be strings or objects with a `stage` key and additional args that get applied to the call object. Handlers can override flow progression by emitting `NextStage` with a specific stage name, or advance linearly by emitting `ModuleReturn`.

### Handler Registry

Maps stage names to factory functions:

| Stage | Handler | Notes |
|-------|---------|-------|
| `negotiate` | `TerminalNegotiator` | Detects terminal capabilities, sets `call.zmodem_crc_mode` |
| `logon` | `LogonHandler` | Pre-login display/new user flow |
| `login` | `LoginHandler` | Authentication |
| `door_auth` | `DoorAuthHandler` | External door authentication |
| `event_login` | `DoorAuthHandler` | Alias for door auth |
| `menu` | `MenuHandler` | Main interactive menu system |
| `door_launch` | `DoorLaunchHandler` | Routes to door target or door menu |
| `last_callers` | `SubModuleAdapter(LastCallers)` | Recent caller display |
| `whos_online` | `SubModuleAdapter(WhosOnline)` | Active node display |
| `check_online` | `SubModuleAdapter(whosOnlineCheck)` | Shows who's online if other users are active |
| `announcements` | `AnnouncementHandler` | Displays unread system announcements sequentially |
| `verify_mail` | `SubModuleAdapter(mailVerifyCheck)` | Prompts unverified users to verify their email address |
| `check_email` | `SubModuleAdapter(pmCheck)` | Unread PM prompt, optionally launches reader |
| `check_batch` | `SubModuleAdapter(fileBatchCheck)` | Prompts to download pending file batch from previous session |
| `webdoor_auth` | `WebDoorAuthHandler` | Token-based auth for browser door launcher sessions |

### TerminalNegotiator (`terminalnegotiator.js`)

Detects terminal type, encoding, and dimensions. Also sets ZMODEM transfer parameters:

- **ZMODEM CRC mode**: `call.zmodem_crc_mode` is set based on the detected terminal. `ZMODEM_MODERN_TERMINALS` (a Set containing SyncTERM, IcyTerm, MagiTerm) get ZBIN32+CRC-32; legacy/unknown terminals get ZBIN+CRC-16. Connections arriving on a WebSocket pool with the `legacy` flag inherit CRC-16 unconditionally. The `zmodem_default_crc` appConfig setting (`auto`/`zbin32`/`zbin_crc16`) can override auto-detection.

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
- **Art system**: `drawfile()`, `drawscreen()`, `drawrandomscreen()` with format fallback chain (RIP → Sixel → UTF-8 → ANSI → ASCII). SAUCE record stripping. Sixel DCS handling. Size-aware art discovery (`_findArtFile()`): exact size match → column match (within 5 cols) → default, preferring size fit over format capability.
- **Art code processing**: `drawfileWithCodes()` / `drawscreenWithCodes()` — async variants that process `@` codes embedded in art files via `artCodes.js`. Universal codes (`@BN@`, `@UN@`, `@DT@`, etc.) are replaced inline in all art. Menu codes (`@Enn@`, `@Fnn@`, `@MT@`, `@HK@`, `@PR@`, `@ER@`) are extracted into a slot map for art-defined menu positioning. Width specifiers supported (`@BN20@` for 20-char field). Fast path skips processing when no `@` byte found.
- **Sixel overlay**: `findSixelOverlay()` locates companion `.ans` for sixel art (same filename, `ans/` directory). `scanOverlaySlotMap()` scans the overlay for menu slot positions without rendering it.
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

**Configuration** (loaded from PostgreSQL via `getMenu()` in `src/models/menus.js`):
- `menu_type`: Input behavior -- `Hotkey` (single-keypress dispatch) or `Lightbar` (arrow-key navigable highlight bar with visual selection indicator). Dumb terminals fall back to Hotkey mode regardless of setting.
- `menu_entries`: Array of entry objects with `hotkey`, `display`, `command_name`, `command_arg`, `featured` (boolean), access control fields (`min_security`, `required_flags`, `prohibited_flags`), and display colors (`fg_clr`, `bg_clr`). Entry `fg_clr` and `bg_clr` are nullable. Colour cascade for foreground: explicit `fg_clr` > theme/menu `featured_clr` (when the entry has `featured = true`) > theme/menu `opt_clr`. When `bg_clr` is null, no background colour is set. Featured entries use `featured_clr` from the theme or menu override as their default foreground, making them visually distinct without requiring per-entry colour configuration.
- `display_file` / `display_file_type`: Optional art file shown as menu background. `display_file` is a bare filename (no path or extension) — the art system resolves via `drawscreen()` → `_findArtFile()`, walking the terminal's format priority chain. `display_file_type` maps to a subdirectory: `"Screen"` → `screens/`, `"Header"` → `headers/`, `""` → `misc/`.
- `display_title`: Boolean (default true). When false, the title text is not drawn at the top of the screen. Useful when art replaces the title visually.
- `display_entries`: Three-state enum: `auto` (entries flow into margin-defined region with auto-column layout), `off` (art-only menu, no entry rendering), `art` (entry positions determined by `@Enn@`/`@Fnn@` codes embedded in the art file — see Art-Defined Mode below).
- Layout controls: `margin_top`, `margin_bottom`, `margin_left`, `margin_right` (define the entry region), `max_columns`, `col_gap`, `fill_order` (`columns` or `rows`), `center_vertical` (boolean). Margins are best-effort -- the layout engine relaxes them if entries don't fit, first by adding columns, then by expanding the region toward hard limits (row 2 at top, 3 rows from bottom for prompt area).
- Theme color overrides: `title_clr`, `input_clr`, `prompt_clr`, `error_clr`, `hotkey_clr`, `menu_prompt_clr`, `featured_clr`. These are nullable -- `getMenu()` strips null values (via `delete`) so they arrive as `undefined` in `_applyConfig()`, and the handler's `config.X !== undefined` check falls through to theme defaults. `menu_prompt_clr` controls the colour of the "Active Hotkeys:" prompt line. `featured_clr` is the default foreground for entries marked as featured.

Menu `name` is the programmatic identifier, enforced as slug-safe (`[a-z0-9_-]+`). The `title` field is the user-facing display label. Menu lookups (`getMenu()`, `menuExists()`) are case-insensitive. Menu and entry data is managed via the admin web UI (`/admin/menus`). The schemas are defined in `menus.conf` and `menu_entries.conf` for the DB migration system.

**Access control**: `_isEntryAccessible()` checks caller's security level, permission flags (must have ALL required), and restriction flags (must have NONE of prohibited). Built-in flags are hardcoded; sysops add custom flags via `custom_permission_flags` / `custom_restriction_flags` config keys (appear in all admin flag dropdowns).

**Layout engine**: `_calcLayout()` computes the entry region from margins, auto-calculates column count based on region width and longest entry, determines fill order (column-first or row-first), and paginates entries. Row-first mode uses all available columns; column-first uses the minimum needed. When entries overflow the margin region, the engine tries adding columns first, then expands the region. `center_vertical` offsets the entry block to the vertical centre of the region. Dumb terminals get a single-column linear listing with pause-on-overflow.

**Lightbar mode**: When `menu_type = 'Lightbar'`, the selected entry is drawn with a highlight bar using theme lightbar colours (`lb_clr` background, `lb_cmd_clr` for hotkey, `lb_opt_clr` for text). The bar extends 1 column before and after the entry text for visual padding. Arrow keys navigate (direction-aware for fill order), Enter selects, Home/End/PgUp/PgDn jump. Hotkeys still work for direct access. The prompt area shows navigation instructions instead of the hotkey list. Cursor parks at the input prompt after each redraw.

**Art-defined mode** (`display_entries = 'art'`): Entries are positioned by `@` codes embedded in the art file rather than computed by the layout engine. `_drawMenuArtDefined()` loads the display file via `drawfileWithCodes()` with `menuMode: true`, receiving a slot map of entry positions. Entry slots (`@E01@`..`@E99@`) fill with visible non-featured entries; featured slots (`@F01@`..`@F99@`) fill with featured entries. If there are more featured entries than F slots, the overflow spills into E slots, preserving sort order. UI codes (`@MT@`, `@HK@`, `@PR@`, `@ER@`) override default title/hotkey/prompt/error positions. All codes support width specifiers (`@E0120@` = slot 1, 20 chars wide; default width is 20 for entries, 40 for UI elements). Unused slots are blanked with spaces.

For sixel terminals, the `.six` art renders visually while a companion `.ans` overlay (same filename, `ans/` directory) provides the slot positions via `scanOverlaySlotMap()`. On ANSI terminals, the same `.ans` file serves as both the visual art and the positioning source. This dual-purpose design means sysops create one ANSI file that works for both.

**Navigation**: Menu history stack (max 20) on the call object. `_navigateToMenu()` pushes current menu and emits `NextStage "menu"`. `_navigateBack()` pops history. Root menus (currently just "Main") clear the history stack.

**Command dispatch** (`_doMenuCommand()`):

| Command | Behavior |
|---------|----------|
| `logOff` | Emits `HangupSignal` (immediate disconnect) |
| `goodbye` | Sub-module: confirm logoff, offer batch download if files queued, then disconnect |
| `nodeSpy` | Sub-module: list active nodes, enter number to watch live terminal output (ESC exits) |
| `wall` | Sub-module: display recent oneliners, prompt to post. Also a call flow stage after announcements |
| `sysInfo` | Sub-module: system information display (board info + aggregate stats). Also available as call flow stage `sysinfo` |
| `bulletins` | Sub-module: numbered bulletin selection menu, displays art file or body_text. Also available as call flow stage |
| `fileNewscan` | Sub-module: scans subscribed file areas for new files since last pointer, displays summary |
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
| `email` | Sub-module (PM reader) |
| `checkEmail` | Sub-module (PM check) |
| `newScan` | Sub-module (all areas) |
| `newScanGroup` | Sub-module (current group) |
| `testDownload` | Sub-module |
| `passwordReset` | Sub-module (logged-in password change) |
| `mailVerify` | Sub-module (request email verification) |
| `fileGroupChange` | Sub-module |
| `fileAreaChange` | Sub-module |
| `fileBrowser` | Sub-module |
| `downloadBatch` | Sub-module |
| `fileSearch` | Sub-module |
| `fileUpload` | Sub-module |
| `doorBrowser` | Sub-module (door browser with collections) |
| `announcements` | Sub-module |
| `verifyMail` | Sub-module (request email verification) |

**Sub-module management**: `_runSubModule()` pauses the menu, wires `ModuleReturn` and `HangupSignal`, starts the module. Menu handler owns inactivity timeouts even while a sub-module is active. On return, `_doModuleReturn()` cleans up and redraws.

---

## Theme System

### Theme Model (`src/models/themes.js`)

PostgreSQL-backed terminal colour theme management. Themes define the default colour palette for all terminal UI elements. Each theme is a named set of colour values (ANSI 0-15) organized into categories.

**Schema** (`themes.conf`): `id`, `slug` (unique identifier), `name`, `description`, `is_default`, plus 37 colour/layout properties covering General, System, Menu, Lightbar, Input, Editor, Messages, and Layout categories.

**Colour cascade** (highest to lowest priority):
1. Per-entry explicit colour (fg_clr, bg_clr on menu_entries)
2. Per-menu colour override (title_clr, prompt_clr, etc. on menus)
3. Theme default (the active theme's colour values)
4. Handler fallback (hardcoded values if theme is missing)

**Loading**: `callmanager.loadTheme()` loads the theme by slug from the `theme` config key. Falls back to the default theme (is_default=true), then to the legacy JSON file in `config/themes/`. The theme object is stored on `call.theme` and passed to all handlers.

**Seeding**: On first startup, `seedDefaultTheme()` imports the bundled `config/themes/canectic.json` into the database as the default theme.

**Admin UI**: `/admin/themes` provides full CRUD with category-organized accordion colour editor, ANSI colour select dropdowns with live preview, theme duplication, and set-as-default. Accessible from the "Menus" dropdown in the admin nav.

**Key properties** (by category):
- **General**: title_clr, header_clr, box_border_clr, error_clr, warn_clr, progress_clr, df_clr, label_clr
- **Menu**: prompt_clr, menu_prompt_clr, hotkey_clr, cmd_clr, opt_clr, featured_clr
- **Input**: input_clr, field_clr, uname_clr, passwd_clr
- **Content**: door_desc_clr, announcement_clr (used by both terminal handlers and web theme colour bridge)
- **Messages**: msg_body_clr, msg_quote_clr, msg_tear_clr, msg_origin_clr, msg_tagline_clr
- **Layout**: msg_x_margin, msg_y_margin

**Web theme colour bridge**: `resolveWebColour(theme, context)` maps page contexts (`'doors'`, `'announcements'`, `'messages'`, `'pm'`) to theme properties and returns a hex colour string. Used by web routes to set the default text colour on HTML content containers, allowing the TinyMCE "Theme Default" sentinel (`#010101`) to inherit the terminal theme's colour on the web side. See web_architecture.md for the full pipeline.

---

## Who's Online

### WhosOnline (`whosonline.js`)

SubModule displaying currently active users from two sources: terminal nodes (from nodeManager) and web presence (from Redis).

**Data sources**:
- Terminal nodes: `nodeManager.getActiveNodes()` sorted by node number
- Web presence: `getOnlineUsers()` from `webActivity.js`, sorted alphabetically by username
- Web door users (nodes with `web_originated` flag) are deduped against web presence entries to avoid double-listing

**Display columns**: Node (number or `-` for web-only), Username, Activity, Connection (Terminal or Web)

**Activity formatting**: Uses the central `formatActivity()` from `src/utils/activityMap.js`. Terminal entries resolve status + detail into human-readable labels. Web entries display the `activity` field from the presence payload, defaulting to "Browsing Web".

### whosOnlineCheck (`menucommands/whosOnlineCheck.js`)

Call flow wrapper that checks for other online activity before showing the Who's Online display. If no other terminal nodes or web users are active (excluding the current caller), skips silently. Otherwise delegates to WhosOnline.

Used as the `check_online` call flow stage. The direct `whos_online` stage (no check) remains available as a menu command.

### Activity Map (`src/utils/activityMap.js`)

Central mapping of activity identifiers to display labels. Three components:

- **ACTIVITY_LABELS**: Static map covering call flow stages, menu commands, and web activity codes
- **ACTIVITY_FORMATTERS**: Dynamic formatters for activities with detail (menu name, door name)
- **formatActivity(status, detail, detailDisplay)**: Resolves any activity identifier to a display string

---

## Node Spy

### nodeSpy (`menucommands/nodeSpy.js`)

Sysop-only sub-module for live node monitoring. Lists active terminal nodes and allows real-time snooping of their terminal output. See `NODESPY_DESIGN.md` for the full system design including web interface.

**States**: `list` -> `watching` -> `message` -> `list` (or return)

**List state**: Displays active nodes (excluding self) in a columnar table matching the Who's Online layout. Sysop types a node number + Enter to watch. ESC exits to menu. Dumb terminal fallback included.

**Watching state**: Clears screen, sends OutputRingBuffer catch-up history, subscribes to live `"data"` events. All target output forwarded to sysop's terminal in real-time. ESC exits watching. Target disconnect detected via `"end"` event, returns to list after keypress.

**Encoding**: Ring buffer always stores UTF-8. For CP437 sysop terminals, output is converted via `utf8ToCp437()` before sending. UTF-8 terminals receive raw passthrough.

**Access**: Sysop-only via menu entry access control (min_security + Sysop flag). Wire `nodeSpy` command to a menu entry in the admin panel.

**CallManager access**: `this.call.callPool.callManager.getCallByNode(nodenum)` -- back-reference set during pool creation.

**Cleanup**: `clearHandler()` removes all listeners from the target's outputBuffer to prevent leaks.

---

## Door System

### Door Configuration (`src/models/doors.js`)

Door game configurations are stored in PostgreSQL (schema: `doors.conf`) and managed via the admin web UI (`/admin/doors`). `getDoorConfig(slug)` returns a normalized config object with camelCase keys matching what `DoorRunner` and `SyncJSDoorRunner` expect. The old hardcoded `testingarray` has been replaced.

### Variable Substitution (`src/utils/configvars.js`)

Admin-configured strings in door config (command, door directory, dropfile directory, door arguments) support `%X` token substitution. Tokens are replaced at runtime by `substitute(template, call, doorConfig)` with live session data. The engine is a single-pass O(n) parser (no regex, no repeated string replacement).

| Token | Description |
|-------|-------------|
| `%N`, `%#` | Node number |
| `%*` | Node number (zero-padded to 3 digits) |
| `%I` | Session UUID |
| `%U`, `%A` | Username (alias) |
| `%R` | Real name (fullname) |
| `%1`–`%4` | User record ID (with zero-padding) |
| `%$` | User security level |
| `%L` | User location |
| `%W` | Terminal width (columns) |
| `%H` | Terminal height (rows) |
| `%E` | Terminal encoding |
| `%Y` | Terminal type |
| `%B` | Baud rate |
| `%T` | Time left (seconds) |
| `%C` | Connection type |
| `%P` | Port number |
| `%D` | Door directory (from config) |
| `%F` | Dropfile directory (from config) |
| `%S` | Door script filename (from config) |
| `%X` | Door command (from config) |
| `%G` | Door slug |
| `%!` | Door base directory (env: `doordir`) |
| `%Z` | Text/art directory (env: `textdir`) |
| `%K` | Config directory (`cwd/config`) |
| `%J` | Data directory (`cwd/data`) |
| `%M` | DOSemu drive C (env: `dosemu_drive_c`, default `~/.dosemu/drive_c`) |
| `%O` | Board name (env: `boardname`) |
| `%Q` | System name (env: `system_name`) |
| `%V` | Web port (env: `webport`) |
| `%%` | Literal percent sign |

Adding a new variable is a single entry in `VARIABLE_DEFS` — the engine, admin reference panel, and substitution all pick it up automatically.

### DoorLaunchHandler (`doorlaunchhandler.js`)

Thin routing stage for call flows. If `call.doorTarget` is set, calls `call.launchDoor()` directly. Otherwise sets `currentMenu` to `"doorsession"` and emits `NextStage "menu"` so the user can pick a door from a menu. Doesn't process input.

### DoorRunner (`doorrunner.js`)

Extends `BaseHandler`. Manages the full lifecycle of launching an external door game.

**Launch types**:

| Type | Admin Label | Method | I/O | Use Case |
|------|-------------|--------|-----|----------|
| `NativeShell` | Native (PTY) | `node-pty` spawn | PTY | Interactive native doors that need a terminal (curses, ncurses) |
| `NativeCommand` | Native Commands | `child_process.exec` | stdin/stdout pipe | Simple native commands, scripts, non-interactive tools |
| `Dosemu` | Dosemu (Console Only) | `exec("dosemu ...")` | stdin/stdout pipe | DOS sysop utilities, non-interactive tools |
| `DosemuPty` | Dosemu (Full) | socat + SerialPort + exec | Virtual serial pair | DOS door games (recommended for all interactive DOS doors) |

Legacy DB values `ExecNative` and `SpawnNative` are mapped to `NativeCommand` at read time.

**Working directory**: All native launch types (`NativeShell`, `NativeCommand`) set `cwd` to the door's configured directory (`doorDir` with `%X` substitution). Falls back to the global `doordir` config, then `process.cwd()`. The command field (`cmd`) is resolved relative to this directory by the shell/PTY.

**Dropfile types**: `DOOR.SYS`, `DOOR32.SYS`, `DORINFO.DEF`, `CHAIN.TXT`, `CALLINFO.BBS`, `PCBOARD.SYS`. Created by `dropfile_handler.js` before door launch. Written to the configured `dropfileDir` (or `doorDir` if not set). Supports `usereal_local` / `usereal_doorsession` flags for real name vs handle.

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

**fixed_size flag**: Door configurations include a `fixed_size` boolean. When true, the door expects a fixed 80x25 terminal and the `DoorOutputParser` is used for CP437 conversion and DECSTBM centering on terminals larger than the door viewport.

### AnnouncementHandler (`announcementhandler.js`)

Displays unread system announcements to users during login. Placed in the call flow after `last_callers`. Queries `announcements.getUnreadForUser(userId)` and displays each announcement sequentially. Each announcement is marked as read after display. Users press any key to advance through announcements.

### WebDoorAuthHandler (`webdoorauthhandler.js`)

Handles token-based authentication for browser-based door game sessions. Used in the `WebDoor` call flow. Validates a one-time auth token passed during WebSocket connection, loads the associated user session, and sets up the call object with user data and door target. Proceeds to `door_launch` on success.

### Registration Handler

The terminal registration handler includes gender selection (Male/Female/Other/Undisclosed) as part of the new user creation flow, matching the web registration wizard.

### Mail Verification (`mailVerify.js`, `mailVerifyCheck.js`)

Two menu commands for email address verification:

- **mailVerify** - Initiates verification by sending a verification code to the user's email address. Available as a menu command for users who want to verify or change their address.
- **mailVerifyCheck** - Prompts for the verification code. Used in the call flow (after announcements) to prompt unverified users. On successful verification, the user's security level may be upgraded based on the `verified_security` config setting.

### Password Reset (`passwordReset.js`)

Menu command for logged-in password change. Prompts for current password, new password, and confirmation. Validates current password before allowing the change.

---

## Development Roadmap

### Planned / In Progress

_Section for tracking development plans, priorities, and stage completion._

| Area | Item | Status | Notes |
|------|------|--------|-------|
| Telnet | IAC escaping in `telnetCommands._send()` | TODO | Currently uses raw `socket.write()` |
| Menus | Lightbar menu type | TODO | `menu_type` column in schema, admin UI persists it, handler does not yet branch |
| Messages | Phase 1: Unified area selector with lightbar | **Done** | `msgAreaSelector.js` — replaces old msggroups + msgareas |
| Messages | Phase 2: Fullscreen message reader | **Done** | `msgReader.js` — thread list + message view + flat mode |
| Messages | Phase 2d: Newscan | **Done** | `newscan.js` — summary screen + sequential reader launch |
| Messages | Phase 3: Message editor | **Done** | `msgEditor.js` — fullscreen + dumb, new thread + reply. Wired into reader R key. |
| Admin | Menu admin (web) | **Done** | PostgreSQL-backed menus + menu_entries. Full CRUD via `/admin/menus`. Color picker selects with ANSI color map. |
| Admin | Door admin (web) | **Done** | PostgreSQL-backed doors. Full CRUD via `/admin/doors`. Two-column layout, tooltip labels, variable reference. |
| Admin | Config variable substitution | **Done** | `configvars.js` — %X token engine for door commands, directories, arguments. 36 variables. |
| Files | Phase 5: File area selector | **Done** | `fileAreaSelector.js` — lightbar selector with groups, new counts, search |
| Files | Phase 5: File browser | **Done** | `fileBrowser.js` — file list + detail view + XMODEM/ZMODEM download (single + batch) with protocol selection and hangup-after-transfer prompt. |

---

## Message System — Terminal Side

### Data Layer Summary

The message models are shared between the web and terminal sides. See `message_architecture.md` for the full schema, model API, read tracking, body_html pipeline, subscriptions, and posting. Key points specific to terminal development:

**Models used by terminal message commands:** `messages.js` (viewing + posting), `userMsgPointers.js` (read tracking), `msgGroups.js`, `msgAreas.js`, `useraccounts.js` (persists current group/area), `userAreaSubs.js` (newscan subscription overrides).

**Message body for terminal display:** Use `msg.utf8 || msg.body_text`. The `body_html` field is for web rendering only. Terminal messages may contain ANSI escape codes, pipe codes (`|XX`), or Ctrl-A codes that should be passed through directly to ANSI-capable terminals. For dumb terminals, strip escape sequences and display plain text.

**Key area columns:** `thread_mode` (standard/no_threads/subscribe_only), `post_as` (username/realname), `newscan_default` (boolean), `ansi_area` (boolean), `read_security`/`post_security` (integer), `read_perm_flags`/`read_rest_flags`/`post_perm_flags`/`post_rest_flags` (JSONB arrays). Groups have the same security and flag columns. See `message_architecture.md` for full column documentation and access control logic.

**Access control in terminal modules:** Each terminal message module includes `parseFlags()` and `checkPostAccess()` (or `checkReadFlags()`) helpers that match the web route logic: security level + permission flags (must have ALL) + restriction flags (must have NONE). User flags come from `call.user_record.permissionflags` and `call.user_record.restrictionflags` (JSONB arrays on the users table).

### Call Object Properties (Message State)

These properties on `IncomingCall` track the user's current message context:

| Property | Type | Source | Notes |
|----------|------|--------|-------|
| `msg_group` | string | `user_record.msg_group` | Current group shortcode (persisted to user record) |
| `msg_group_title` | string | Set by selector | Display name of current group |
| `msg_area` | string | `user_record.msg_area` | Current area shortcode (persisted to user record) |
| `msg_area_title` | string | Set by selector | Display name of current area |
| `security` | integer | `user_record.security` | Used to filter groups/areas by read_security |
| `user_record` | object | Set at login | Full user DB row. Needed for `user_record.id` in pointer operations, `user_record.permissionflags`/`user_record.restrictionflags` for flag-based access control, and `user_record.security` for security level checks. |

### Phase 1: Unified Area Selector — COMPLETE

**File:** `handlers/menucommands/msgAreaSelector.js`

Replaces the old separate `msggroups.js` and `msgareas.js` with a single unified lightbar selector. Loads all accessible groups and areas (filtered by `call.security` at the DB layer, then by permission/restriction flags via `checkReadFlags(userRecord, group/area)` at the application layer). Groups with zero accessible areas after flag filtering are excluded. Displays areas nested under group headers and lets the user navigate with a lightbar. Selecting an area updates both `call.msg_group` and `call.msg_area` and persists to the user record.

Features: encoding-aware glyphs (CP437 vs UTF-8), search mode (S key, live filtering), dumb terminal fallback (numbered list), blue highlight bar with distinct colors for current selection vs cursor position. **Subscription toggle**: T key toggles newscan subscription for the highlighted area via `userAreaSubs.setSubscription()` / `removeSubscription()`. Unsubscribed areas are displayed dimmed. Subscription map loaded on entry via `userAreaSubs.getSubscriptionMap()`.

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
| MESSAGE_VIEW (any) | R | Reply | Launch message editor — only shown in nav bar and accepted as input when `_canPost` is true (resolved via `checkPostAccess(userRecord, areaConfig)` after area config loads) |
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
9. **Paragraph reflow** (`reflowParagraphs`): reassembles text from wider editors — if a normal text line meets the next normal text line and exceeds 80% of wrapWidth, they're joined and re-wrapped. Quote lines, separators, and short lines are left alone.
10. **Word-wrap** plain text lines to `(bodyWidth - 2)` columns. Lines with embedded color codes use **ANSI-aware wrapping** (`wordWrapLineAnsi` with `measureVisualWidth`/`findStringIndexAtVisualCol`) — escape sequences don't count toward column width, and wrap points only occur between visible characters.
11. **ANSI art detection** (`detectAnsiArt`): checks for cursor positioning CSI sequences (CUP, CUU, CUD, CUF, CUB), NOT just color-only SGR. Art lines are not reflowed or wrapped.
12. **Apply semantic color prefixes**: Each line gets an ANSI SGR prefix based on its type:
    - Normal text: bright yellow (default, theme key `msg_body_clr`)
    - Quote lines (`>`, `XX>`, `->`, `-=>`, `=>`, etc.): bright cyan (theme key `msg_quote_clr`)
    - Tear lines (`---`): bright white (theme key `msg_tear_clr`)
    - Tagline separators (`--`, `===`): bright green (theme key `msg_tagline_clr`)
    - Origin lines (anything after a tear or tagline separator): bright blue (theme key `msg_origin_clr`)
13. **Two-level footer tracking**: Tagline separator (`--`, `===`) and tear line (`---`) each trigger a different color cascade:
    - After a tagline separator: subsequent lines get tagline color (bright green) — this covers the actual tagline text
    - After a tear line: subsequent lines get origin color (bright blue) — tear overrides tagline, covering origin, SEEN-BY, PATH, etc.
    - A message with both (tagline before tear) gets green tagline text between the separators, then blue origin text after the tear
14. For messages WITH embedded color codes: semantic colors are still applied at the start of each line. Embedded codes naturally override as the terminal processes left to right. Exception: ANSI art (cursor positioning detected) gets no prefixes.
15. Store as `bodyLines[]` array of `{ text, type, colorPrefix }` objects

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
| R | Reply — launch message editor (only when `_canPost` is true) |
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

Extends `BaseSubModule`. Scans across areas for unread messages. Supports "all groups" and "current group only" modes. **Filters by subscription**: loads `userAreaSubs.getSubscriptionMap()` on entry and skips areas where the user has explicitly unsubscribed (or where `newscan_default` is false with no user override).

**Flow:**
1. Load subscription map via `userAreaSubs.getSubscriptionMap(userId)`
2. Load all accessible areas, filter by subscription, get unread counts via `getUnreadCount()` per subscribed area
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

#### Post Access Gate

On `run()`, after loading the area config via `_resolveFromName()`, the editor checks `checkPostAccess(call.user_record, areaConfig)`. If the user lacks permission (security level too low, missing required permission flags, or has a blocking restriction flag), the editor displays "You do not have permission to post in this area." (bright red on fullscreen, plain text on dumb) and returns to the caller after 2 seconds without entering the editing state. This is a defense-in-depth check — the reader already hides the R key when `_canPost` is false, but the editor enforces independently in case it's invoked from a menu command or future code path.

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

Several pieces of logic are shared across the message modules:

**Terminal text formatting** (`termMsgFormat.js`) — CP437↔UTF-8 conversion, pipe/Ctrl-A→ANSI, paragraph reflow (`reflowText`/`reflowParagraphs`), ANSI art detection (`detectAnsiArt`), ANSI-aware word wrapping (`wordWrapLineAnsi`), semantic line classification and coloring. `reflowText()` joins with `\r` (not `\n`) because VirtualTerminal breaks on `\r` (FTN convention). Does NOT import `terminalText.js` — dependency flows one direction only.

**HTML body formatting** (`terminalText.js`) — `formatBodyHtml(displayText, forceWidth)` is the consolidated single source for all tossers and the maintenance tool. Pipeline: reflow → ANSI art detection → VirtualTerminal routing. `VirtualTerminal` noWrap mode: single spaces between words are regular ` ` (browser word-wrap), leading/multi-spaces use `&nbsp;`.

**Thread helpers** (`echomail.js`) — `createThreadRow`, `updateThreadStats`, `rollbackThread` shared by QWK and NNTP tossers.

**Message header formatting** — Consistent header block rendering (From/To/Subject/Date/Area) used by both readers and the lister detail view.

**Pointer management** — Wrapper that handles advancing area and thread pointers after viewing, used by both reader modes and newscan.

**Subscription management** (`userAreaSubs.js`) — Resolution cascade: user override → area `newscan_default` → true. Used by newscan (filters scan list) and area selector (T key toggle, dimmed display).

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
| `email` | `pmReader` | Full terminal mail reader with inbox/sent/trash folders |
| `checkEmail` | `pmCheck` | Unread count prompt, optionally launches pmReader |
| `fileGroupChange` | `fileAreaSelector` (Phase 5) | Unified file area selector — same module for both commands |
| `fileAreaChange` | `fileAreaSelector` (Phase 5) | Same module — both hotkeys open same selector |
| `fileBrowser` | `fileBrowser` (Phase 5) | File listing browser for current file area |
| `fileList` | `fileBrowser` (Phase 5) | Alias for fileBrowser |
| `fileBatchDownload` | `fileBatchDownload` | Standalone batch download menu command |

The `readMessages` wrapper should detect `call.term_type` and route to line reader (dumb terminals) or fullscreen reader (ANSI terminals). Same pattern for the editor.

### Future Considerations

- ~~File transfer protocols (Zmodem, etc.)~~ — **Done**. Native XMODEM and ZMODEM engines (`src/transfers/`) with protocol selection prompts. All five handlers (fileBrowser, fileBatchDownload, fileSearch, fileBatchCheck, fileUpload) use native engines. lrzsz wrappers remain as fallback.
- Announcement handler
- Top menu handler
- Logoff handler with call statistics
- RIP graphics support depth
- Sixel image rendering pipeline
- Inter-node messaging / chat
- Node-spy (sysop) live terminal mirroring (infrastructure exists via `OutputRingBuffer`)
- Thread preferences (subscribe/ignore/mute) — schema designed, not yet implemented
- ~~User QWK download/upload from terminal menu~~ — **Done**. `qwkTransfer` menu command with D/U/Q hotkey menu, ZMODEM/XMODEM protocol selection.
- Web newscan route/view using `getNewscanSummary()` with `userAreaSubs` filtering
- Flat-mode reply thread UUID resolution (currently null for some messages)
- Terminal PM reader pagination for mailboxes exceeding batch size
- Terminal PM address book for quick recipient selection

---

## Private Messaging — Terminal Side

Full terminal-side PM access is provided by three `BaseSubModule` modules. They follow the same architecture as the echomail modules (state machine, geometry, CP437/UTF-8 glyphs, dumb fallback, sub-module spawning). Detailed architecture is in `PM_ARCHITECTURE.md` under "Terminal UI Architecture" — this section summarizes the key patterns.

### PM Reader (`handlers/menucommands/pmReader.js`)

**State machine**: `LOADING → MESSAGE_LIST ↔ MESSAGE_VIEW`

Provides a lightbar message list with three switchable folders (Inbox/Sent/Trash), and a message view with 4-row header, scrolling body viewport, and full navigation (prev/next, jump to last, space-page-advance). Network messages display `"name @ address"` in the From/To header fields.

Key differences from `msgReader`:
- **No threads**: Flat chronological list (newest at bottom), not threaded
- **Folder switching**: I/S/T hotkeys switch between inbox, sent, and trash without leaving the list
- **Read state sync**: Opening a message marks it read in DB; the read flag is synced back to the in-memory list entry so the list reflects the change immediately on return
- **Cursor positioning**: Starts on first unread message, or last message if all read
- **Smart date column** (9 chars): Today → `15:45    `, Yesterday → `Yesterday`, Older → `Mar 18'25`
- **Compose/Reply**: Spawns `pmEditor` with transport and address context

### PM Editor (`handlers/menucommands/pmEditor.js`)

**State machine**: `FIELD_FROM → FIELD_TO → FIELD_ADDRESS → FIELD_SUBJECT → BODY ↔ QUOTING → CONFIRM_SAVE/CONFIRM_ABORT`

5-row header with cycleable From name (username/fullname via ←→), editable To, Via/Addr with transport cycling (LOCAL/FTN/QWK via ←→), editable Subject. Body editor with auto-wrap at 79 columns. Quote system matches `msgEditor` (Enter toggles, Ctrl+Q/ESC inserts selected).

Key differences from `msgEditor`:
- **From name cycling**: Left/right on row 1 cycles between username and fullname
- **Transport cycling**: Left/right on Via/Addr row cycles through allowed transports
- **Dual save path**: LOCAL resolves recipient via `resolveRecipient()` and sets `recipient_user_id`. Network (FTN/QWK) skips resolution, uses address as-is, parses FTN zone:net/node
- **To name normalization**: Title-cases on save (`john smith` → `John Smith`), preserves for display
- **Error persistence**: `_showError()` is not followed by `_drawStatusBar()` so errors remain visible
- **Async save guard**: `_saving` flag blocks input during the async `resolveRecipient`/`queueMessage` pipeline
- **Transport is locked on reply**: Reply inherits the original message's transport type and pre-fills the network address

### PM Check (`handlers/menucommands/pmCheck.js`)

Minimal unread-mail prompt. Queries `getUnreadCount()`, shows "no messages" or "N new messages — read now?". Y launches `pmReader`, any other key exits. Works as both a menu command (`checkEmail`) and a call flow stage (`check_email` via `SubModuleAdapter`).

### Call Flow Registration

```javascript
// callmanager.js handler registry
"check_email": (call) => new SubModuleAdapter(call, pmCheck, "PmCheck"),

// Example call flow
"Standard": ["negotiate", "logon", "last_callers", "check_email", "menu", "goodbye"]
```

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
| `termMsgFormat.js` | `reflowText` joined with `\n` but VirtualTerminal only breaks on `\r` — entire message condensed to one line | Fixed — joins with `\r` |
| `termMsgFormat.js` | Stale duplicate `formatBodyHtml` function and circular import to `terminalText.js` | Fixed — removed, consolidated in `terminalText.js` |
| `terminalText.js` | VirtualTerminal `toHTML()` replaced all spaces with `&nbsp;` — browser had no word-break points, text overflowed or broke mid-word | Fixed — noWrap mode: single spaces between words stay as regular ` `, leading/multi-spaces use `&nbsp;` |
| `_msgAutoSize.pug` | Probe used `font-family:inherit` — measured wrong font, auto-sizing produced incorrect results | Fixed — inline `font-family:"Consolas",monospace` |
| `_msgAutoSize.pug` | `MAX_FONT_PX=16` too small for wide screens | Fixed — raised to 32 |
| `_msgAutoSize.pug` | `.text-12` class overrode calculated font-size | Fixed — removed `.text-12` from `.messagebody` in both views |
| `flat.pug` / `thread.pug` | Progress bar and `#messageContainer` indented inside `.card-header` instead of as siblings of `.card` | Fixed — outdented to `.card` children |
| `flat.pug` / `thread.pug` | Offcanvas backdrop dimmed screen and blocked input | Fixed — `data-bs-backdrop='false'` |
| `qwkTosser.js` _(in `src/middleware/tossers/`)_ | Downloaded `.qwk` could be lost if extraction failed — hub already deleted it | Fixed — Phase 1.5 checks for existing `.qwk` in inDir before downloading |
| `flat.pug` | Flat-mode reply `thread_uuid` is null for some messages | Pending — needs `getThreadByDbId()` lookup |
| `telnetCommands` | IAC escaping in `_send()` | Pending |

---

## File Areas — Terminal Side (Phase 5)

Terminal-side file browsing is provided by two `BaseSubModule` modules. They follow the same architecture as the echomail/PM modules (state machine, geometry, CP437/UTF-8 glyphs, dumb terminal fallback).

### File Area Selector (`handlers/menucommands/fileAreaSelector.js`)

Mirrors `msgAreaSelector.js` for file areas. Displays all accessible file groups and areas in a lightbar list with group headers. Shows file count and new file count per area.

**Key behaviors:**
- Loads active file groups via `fileGroups.getActiveGroups()`, areas via `fileAreas.getAreasInGroup()`
- Access control: security level + permission flags + restriction flags (both groups and areas)
- Groups with zero accessible areas are excluded
- New file count per area using `userFilePointers.getNewCount()`
- Selecting an area updates `call.file_group`, `call.file_area`, titles, and persists via `updateUserFileGroup/Area()`
- Search mode (S key) — live filtering by name/shortcode/description/group
- Dumb terminal fallback with numbered list

**Menu commands:** `fileGroupChange`, `fileAreaChange` — both launch the same selector

### File Browser (`handlers/menucommands/fileBrowser.js`)

**State machine:** `LOADING → FILE_LIST ↔ FILE_DETAIL`

**FILE_LIST state:**
- Header with area name, file count, new file count
- Lightbar list with columns: Filename, Description, Size, Date
- Files sorted by `upload_date DESC` (newest first)
- New files (id > scan pointer) highlighted in bright green
- Lazy loading: initial batch of 50, more loaded on scroll
- Search mode (S key) — uses DB-backed `searchEntries()` for 2+ char queries
- Mark Read (M key) — advances scan pointer to max

**FILE_DETAIL state:**
- Full-screen detail view: filename, size, date, uploader, download count, description, area
- Long description displayed in scrollable body zone (centered, max 100 cols)
- Left/Right arrows navigate between files
- Download (D key) triggers transfer with protocol selection (XMODEM/ZMODEM) and hangup-after-transfer prompt

**Download:** Single file download via `D` key and batch download via `B` key prompt for protocol selection (XMODEM or ZMODEM) then use native engines via StreamAdapter wrappers. All download paths present a "Hang up after transfer?" `[Y/n]` prompt (Enter defaults to Yes). After a successful transfer, if the user chose hangup, the system auto-disconnects after a 1500 ms delay; otherwise it shows "press any key" and returns to the previous view. The hangup prompt is managed via `_hangupPrompt`/`_hangupResult` flags on the browser instance.

**Dumb terminal fallback:** Numbered file list with pagination, `#` for detail, `D#` for download info.

**Geometry:** Same pattern as `msgReader` — `_calcGeometry()` computes `bodyWidth`, `bodyLeft`, `bodyRight` centered on wide terminals, capped at `MAX_BODY_WIDTH` (100).

**Scan pointer management:** Viewing a file detail advances the pointer via `userFilePointers.advancePointer()`. "Mark Read" jumps to max file ID.

---

## QWK Mail Transfer (`handlers/menucommands/qwkTransfer.js`)

Terminal menu command for offline QWK packet download and REP upload. Menu command type: `qwkTransfer`.

**State machine:** `MENU → BUILDING → PROTOCOL → TRANSFERRING → RESULT` (download) or `MENU → PROTOCOL → UPLOADING → RESULT` (upload)

**MENU state:** D/U/Q hotkey menu. ESC returns to parent menu.

**Download flow:**
1. Calls `buildQwkForUser(userId)` — gathers new messages from subscribed areas + unread PMs, assembles `.qwk` packet, advances scan pointers
2. Displays summary (message count, area count)
3. Protocol prompt: X for XMODEM, Z or Enter for ZMODEM (default)
4. Sends packet via `NativeZmodemProtocol`/`NativeXmodemProtocol`
5. Cleans up temp files regardless of transfer outcome

**Upload flow:**
1. Protocol prompt (same as download)
2. Receives file to temp directory via protocol `.receive()`
3. Finds `.rep` file in received files (XMODEM single-file fallback if no `.rep` extension)
4. Calls `importRepForUser(userId, repPath)` — parses messages, posts to areas via `echomail`, delivers PMs
5. Displays result summary (posted count, errors)

**Dumb terminal fallback:** All prompts and results use plain `\r\n` text output.

**Transfer pause:** `_transferring` flag blocks input handling during active file transfers (same pattern as `fileBrowser.js`).

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
| `pmReader.js` | handlers/menucommands | Terminal private mail reader — inbox/sent/trash folders, message view, compose/reply launch |
| `pmEditor.js` | handlers/menucommands | Terminal PM editor — From/To/Addr/Subject fields, transport cycling, LOCAL+network save, quote system |
| `pmCheck.js` | handlers/menucommands | Unread mail check prompt — also works as call flow stage via SubModuleAdapter |
| `qwkTransfer.js` | handlers/menucommands | QWK packet download and REP upload — D/U/Q menu, ZMODEM/XMODEM protocol selection |
| `fileAreaSelector.js` | handlers/menucommands | File group/area selector with lightbar, search, new file counts (Phase 5) |
| `fileBatchCheck.js` | handlers/menucommands | Login flow batch check — prompts to download pending batch on login, with protocol selection and hangup-after-transfer option |
| `fileBrowser.js` | handlers/menucommands | File listing browser — file list, detail view, XMODEM/ZMODEM download (single + batch) via native engines, batch tagging (Phase 5) |
| `termMsgFormat.js` | utils | Terminal message formatting — CP437 conversion, pipe/Ctrl-A→ANSI, semantic line coloring, paragraph reflow (`reflowText`/`reflowParagraphs`), ANSI art detection (`detectAnsiArt`), ANSI-aware word wrapping (`wordWrapLineAnsi`) |
| `userAreaSubs.js` | models | Per-user newscan subscription overrides — resolution cascade, T key toggle in area selector |
| **Maintenance** | | |
| `messageBase.js` | maintenance | `regenerateAllBodyHtml`, `regenerateAreaBodyHtml` — batch body_html regeneration using current pipeline |
| `maintenance.js` | tools | CLI runner — `--regen-html`, `--area`, `--dry-run`, `--width`, `--batch` |
| **Shared models** | | |
| `messages.js` | models | Message viewing, posting, sanitization |
| `msgGroups.js` | models | Message group CRUD |
| `msgAreas.js` | models | Message area CRUD, table management |
| `menus.js` | models | PostgreSQL-backed menu and menu entry CRUD, color map, command list, display file types |
| `doors.js` | models | PostgreSQL-backed door game config CRUD, slug→camelCase normalization, launch/dropfile type validation |
| `userMsgPointers.js` | models | Two-tier read tracking (area pointers + thread pointers) |
| `fileGroups.js` | models | File group CRUD, active group listing |
| `fileAreas.js` | models | File area CRUD, directory resolution, stats |
| `fileEntries.js` | models | File entry CRUD, search, dupe checking, download counts |
| `userFilePointers.js` | models | Per-user per-area file scan pointers |
| `echomail.js` | models | FTN echomail import/export, threading. Shared thread helpers: `createThreadRow`, `updateThreadStats`, `rollbackThread` |
| `qwkUser.js` | models | User QWK packet generation (`buildQwkForUser`) and REP import (`importRepForUser`) |
| `areaAccess.js` | utils | Shared area read/write access checks (`checkAreaReadAccess`, `checkAreaPostAccess`) |
| `terminalText.js` | utils | VirtualTerminal, `formatTerminalText`, `formatBodyHtml` (consolidated single source for all tossers) |
| `configvars.js` | utils | Runtime %X variable substitution for door commands, directories, and arguments. Single-pass O(n) engine, 36 tokens. |
| **Schemas** | | |
| `menus.conf` | schemas | Menu table — name, title, menu_type, display file, layout, colors |
| `menu_entries.conf` | schemas | Menu entry table — hotkey, display, command, colors (default 7/0), access control flags |
| `doors.conf` | schemas | Door game table — slug, launch type, command, directories, dropfile, capacity, real name flags |
