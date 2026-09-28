# NodeSpy System

Sysop node monitoring system. Allows sysops to view active terminal sessions in real-time from both the web admin panel (xterm.js) and the terminal (menu command).

**Status: implemented**, including the sysop chat extension (section 5.5) and web presence users on the dashboard (see `WEB_CHAT_DESIGN.md`). Section 7 lists what is still future work.

---

## 1. Overview

NodeSpy provides two capabilities:

1. **Node status dashboard** -- view all active nodes with username, activity, connection type, duration. Auto-updating card grid with "Watch" buttons.
2. **Live session snoop** -- real-time mirror of a node's terminal output. Read-only. Shows buffered history on connect, then streams live output.

Both web and terminal interfaces are sysop-only (admin security level + Sysop permission flag).

---

## 2. Infrastructure

### 2.1 OutputRingBuffer (`src/handlers/ringbuffer.js`)

Each `IncomingCall` creates an `OutputRingBuffer` at construction:
```
this.outputBuffer = new OutputRingBuffer(2000)
```

The buffer:
- Stores all terminal output as **UTF-8** (CP437 sessions convert on write via `_writeRingBuffer()` in `terminalcommands.js`, door subprocess output converts via `writeOverrideBuffer()` in `callmanager.js`)
- Emits `"data"` events on `outputBuffer.emitter` for live watchers
- Emits `"end"` on `destroy()` for disconnect detection
- Provides `getHistory()` for catch-up on snoop attach (returns a single Buffer)
- Line-based ring buffer with 2000-line capacity, up to 20 concurrent listeners

### 2.2 Ring Buffer Encoding

The ring buffer always stores UTF-8. This allows web snoop viewers (xterm.js) to pipe data raw with no conversion.

**Write paths**:
- `_writeRingBuffer()` in `BaseCommands` (`terminalcommands.js`): called from every `_send()`. CP437 sessions convert via `cp437ToUtf8()` before writing; UTF-8 sessions pass through.
- `writeOverrideBuffer()` in `IncomingCall` (`callmanager.js`): used by DosemuPty door subprocesses. Same CP437-to-UTF-8 conversion.

**Read paths**:
- Web snoop (xterm.js via WebSocket): raw passthrough, no conversion needed.
- Terminal snoop on UTF-8 terminal: raw passthrough.
- Terminal snoop on CP437 terminal: `utf8ToCp437()` before sending.

**Known limitation**: DosemuPty doors where dosemu outputs VT100 DEC line-drawing sequences (all ASCII-range bytes like `l`, `q`, `x` under `ESC(0` mode). These pass through encoding conversion unchanged since they are < 128. The DEC graphics mode switch (`ESC(0`) may rotate off the ring buffer, causing CP437 terminal snoop viewers to see literal ASCII characters instead of box-drawing. The web snoop (xterm.js) handles this correctly as it maintains VT100 terminal state. This only affects sysops snooping DosemuPty doors from an oversized CP437 terminal client.

### 2.3 Call Lookup

`CallManager.getCallByNode(nodenum)` iterates all pools' `connectedcalls` and returns the call with matching `nodenum`. Returns `null` if not found.

### 2.4 Gateway Exposure

`callManager` is accessible to Express routes via `webserver.locals.callManager` (set in `bin/gateway.js` alongside `webserver.locals.nodeManager`).

Terminal sub-modules access it via `call.callPool.callManager` (back-reference set during `CallManager.createNewPool()`).

---

## 3. Web Interface

### 3.1 Node Dashboard

**Route**: `GET /admin/nodespy`
**JSON**: `GET /admin/nodespy/status.json` (same data, for AJAX polling)
**Template**: `src/views/admin/nodespy/index.pug`

Card grid of active terminal nodes. Each card shows node number, username, activity (via `formatActivity()`), connection type badge, terminal dimensions, and duration. "Watch" button navigates to the snoop view.

Dashboard auto-updates every 4 seconds (`POLL_INTERVAL = 4000`) via `fetch()` to `status.json`, rebuilding cards from JSON. Initial render is server-side and lists terminal nodes only; `status.json` returns `{ nodes, webUsers }`, where `webUsers` are web presence users from `getOnlineUsers()` (excluding usernames already on a terminal node), so web user cards appear from the first poll onwards. Web user cards offer chat rather than Watch (see `WEB_CHAT_DESIGN.md`).

Empty state shown when no terminal nodes are active.

### 3.2 Live Snoop Page

**Route**: `GET /admin/nodespy/:nodenum`
**Template**: `src/views/admin/nodespy/watch.pug`

xterm.js terminal matched to the target node's dimensions (`call.term_width` x `call.term_height`). Font scaling algorithm from the door player fits the viewport.

**Auth flow**:
1. Route generates a one-time Redis token (UUID, 60-second TTL) containing target node number
2. Token passed to template as WebSocket URL parameter
3. xterm.js connects to `/ws/nodespy?token=<token>`

**Status bar**: Shows node number, username, "Read-Only" badge, "Watching"/"Ended" status, Exit button.

**Session end handling**: When the target disconnects, the WebSocket receives `[Session ended]`, the status changes to "Ended", and the page redirects to the dashboard after 2 seconds.

### 3.3 WebSocket Endpoint (`src/servers/nodespySocket.js`)

**Path**: `/ws/nodespy`
**Registration**: Raw `WebSocketServer` on `WsManager.pathMap` (not a `WsPool`).

**Connection flow**:
1. Client connects with `?token=<token>` query parameter
2. Server reads and deletes the Redis token (one-time use)
3. Looks up target call via `callManager.getCallByNode(nodenum)`
4. Sends `outputBuffer.getHistory()` as catch-up (raw UTF-8)
5. Subscribes to `outputBuffer.emitter` `"data"` events, forwards to WebSocket
6. Subscribes to `"end"` event for disconnect detection
7. On target disconnect: sends `[Session ended]`, closes WebSocket
8. On WebSocket close: removes all listeners from outputBuffer

**Error handling**: Invalid/expired token closes with code 4001. Node not found sends error message and closes with 4004.

### 3.4 Admin Navigation

Link labelled "Nodes" in the admin navbar (`src/views/includes/admin-nav.pug`, included by `layouts/admin.pug`), pointing at `/admin/nodespy`; the page title is "Node Spy".

---

## 4. Terminal Interface

### 4.1 Menu Command

**Command**: `nodeSpy`
**Label**: "Node Spy" (in `menus.js` command dropdown)
**File**: `src/handlers/menucommands/nodeSpy.js`
**Access**: Sysop-only via menu entry access control (min_security + required Sysop flag)

### 4.2 Sub-Module States

**List state**:
- Displays active nodes (excluding self) in a table: node number, username, activity, connection type
- Same layout pattern as Who's Online
- Sysop types a node number + Enter to watch, ESC exits to menu
- Dumb terminal fallback with linear text output

**Watching state**:
- Clears screen, sends ring buffer catch-up history
- Subscribes to `outputBuffer.emitter` `"data"` events
- All output forwarded to sysop's terminal in real-time
- CP437 sysop terminals receive `utf8ToCp437()` converted output
- ESC exits watching, returns to node list
- Target disconnect shows "Session ended" message, returns to list after keypress

**Input handling while watching**: All input except ESC is discarded (read-only).

### 4.3 Cleanup

`clearHandler()` removes all data/end listeners from the target's outputBuffer, preventing listener leaks even if the sub-module is torn down without a clean exit sequence.

---

## 5. Security

- All access requires admin security level AND Sysop permission flag
- WebSocket tokens are one-time use with 60-second TTL, deleted on use
- Session validation at both HTTP (page load) and WebSocket (connect)
- OutputRingBuffer listener cleanup prevents resource leaks
- Max 20 concurrent snoop sessions per node (emitter limit)
- Sysop chat: only the sysop can exit chat (user cannot ESC out), preventing evasion during account lockdown

---

## 5.5 Sysop Chat

Extends the snoop system with bidirectional split-screen chat. See `SYSOP_CHAT_DESIGN.md` for the full design. Implementation summary:

**Split-screen engine** (`src/handlers/splitscreenchat.js`): DECSTBM-based layout with title, divider lines, scrolling conversation region, and input line. Encoding-aware (CP437 `0xC4` vs Unicode `U+2500` for dividers). Supports `showPeekLine` (sysop sees user's typing in real-time), `allowExit` (disabled for target user), and `onTyping` callbacks.

**Chat initiation**: Sysop presses `C` while watching (terminal) or clicks "Chat" button (web). Only allowed when target is at a menu (handler can be cleanly redrawn on exit). If target is not at a menu, chat is queued via `call.pendingChat` and fires automatically when `updateNodeStatus('menu')` is called.

**Queue indicator**: Terminal shows a persistent bold black-on-yellow "CHAT QUEUED" badge at top-right, redrawn after each ring buffer data event. Web shows a pulsing yellow "Chat Queued" badge in the header.

**Target-side**: Input hijacked via `call.rawmode`/`call.rawtarget`. User gets 5 beeps on chat start. User cannot ESC out. On chat end, rawmode restored and `currentHandler._drawMenu()` redraws the menu.

**Web chat**: JSON control messages (`chat_start`, `chat_end`, `chat_input`, `chat_started`, `chat_ended`, `chat_queued`, `chat_msg`, `chat_typing`) over the existing nodespy WebSocket. Chat input bar with text field, send button, and typing peek display.

---

## 6. File Index

| File | Purpose |
|------|---------|
| `src/handlers/ringbuffer.js` | OutputRingBuffer: line-based ring buffer with EventEmitter |
| `src/handlers/splitscreenchat.js` | DECSTBM split-screen chat engine |
| `src/servers/nodespySocket.js` | WebSocket endpoint for live snoop + chat |
| `src/handlers/menucommands/nodeSpy.js` | Terminal sub-module: node list, live snoop, chat |
| `src/views/admin/nodespy/index.pug` | Dashboard template (card grid + AJAX polling) |
| `src/views/admin/nodespy/watch.pug` | Snoop viewer template (xterm.js + chat UI) |
| `src/routes/admin.js` | Dashboard + snoop routes, token generation |
| `src/commandsets/terminalcommands.js` | `_writeRingBuffer()`, `setscrollregion()`, cursor save/restore |
| `src/managers/callmanager.js` | `getCallByNode()`, `writeOverrideBuffer()`, `pendingChat` queue |

---

## 7. Future Enhancements

- **Input forwarding**: Type on behalf of the snooped session (for troubleshooting)
- **Multi-node view**: Watch multiple nodes simultaneously in a split-pane layout
- **Session recording**: Save OutputRingBuffer history to file for later playback
- **DEC graphics conversion**: Stateful VT100 DEC graphics-to-Unicode converter for `writeOverrideBuffer`, resolving the DosemuPty CP437 terminal snoop limitation
- **Page system**: User-initiated sysop page request (`pageSysop` menu command) with dashboard alerts
