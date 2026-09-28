# Sysop Chat Design

Design document for the sysop chat system. Extends NodeSpy with bidirectional communication: the sysop can page a user, break into their session, and conduct a split-screen chat conversation.

**Status: partly implemented.** Phases 1 to 3 (split-screen engine, terminal break-in, web break-in) are built. Phase 4 (the page system: `pageSysop` command, `call.chatState`, page indicators) and most of Phase 5 (chat logging beyond start/stop lines in the system log, configurable colours, multi-sysop coordination) are not. The build differs from this design in the ways listed below; the numbered sections are the original design and are kept for reference.

### Implementation notes (where the build differs)

- **Engine**: `SplitScreenChat` in `src/handlers/splitscreenchat.js`. `setscrollregion()`, `resetscrollregion()`, `savecursor()`, `restorecursor()` are on `BaseCommands` (`src/commandsets/terminalcommands.js`). Options include `allowExit`, `showPeekLine`, `onSend`, `onTyping`, `onExit`, `exitLabel`, colours.
- **Layout** is not a midpoint split. Target: title row 2, divider row 3, conversation rows 4 to N-3 (DECSTBM region), divider row N-2, input row N-1. The sysop's screen adds a peek line on row 3 showing what the user is typing, so its conversation starts at row 5.
- **Message flow**: each side has its own `SplitScreenChat` instance drawing to its own terminal. A sent line is appended to both instances directly, and does not rely on the ring buffer echo described in 4.4. The terminal sysop's snoop forwarding is suspended while chatting; the web viewer keeps receiving the target's ring buffer and gets chat lines as JSON `chat_msg` frames.
- **The user cannot exit**: the target instance is created with `allowExit: false`, so only the sysop ends the chat (see `NODESPY_DESIGN.md` section 5). Sections 4.7 and 8 below, which say the user can always ESC out, are superseded.
- **Only at a menu**: chat starts only when the target is at a menu. Otherwise it is queued on `call.pendingChat` and fires when the target's `updateNodeStatus('menu')` is called; the sysop sees a "CHAT QUEUED" indicator.
- **Start and end**: the user gets 5 beeps on start; both nodes get node status `sysop_chat`. On end, rawmode is restored and `call.currentHandler._drawMenu()` redraws the menu (not `_redrawMenu()` or `CMD_REDRAW`).
- **Web**: the watch page uses a chat input bar (text field, send button, typing peek), not xterm.js input. The nodespy WebSocket carries JSON `chat_start`, `chat_end`, `chat_input` from the client and `chat_started`, `chat_ended`, `chat_queued`, `chat_msg`, `chat_typing` from the server (`src/servers/nodespySocket.js`).

---

## 1. Overview

Three capabilities built on the existing NodeSpy infrastructure:

1. **Page** -- User requests sysop attention (sends a notification). Sysop sees page alert on the NodeSpy dashboard and in-terminal.
2. **Break-in** -- Sysop initiates chat from NodeSpy. Target user's session is paused, both sides enter split-screen chat mode.
3. **Split-screen chat** -- Top region shows conversation history (both sides visible to both parties). Bottom region is the input line. ESC exits chat, restoring the user's session.

Both web (from NodeSpy watch page) and terminal (from NodeSpy sub-module) interfaces.

---

## 2. Infrastructure

### 2.1 Text Injection (Existing)

Sending text to another node's terminal is trivial in the single-threaded Node.js model:
```javascript
targetCall.cmds.senddata(text)
```
This writes to the target's socket AND the OutputRingBuffer (via `_writeRingBuffer()`). No locking needed. The sysop's NodeSpy viewer already subscribes to the target's ring buffer, so injected text appears on both sides automatically.

### 2.2 Input Hijacking (Existing)

The `call.rawmode` / `call.rawtarget` pattern (used by DoorRunner) allows input interception without destroying the active handler:
```javascript
// Save current state
var prevRawmode = call.rawmode;
var prevRawtarget = call.rawtarget;

// Hijack input
call.rawmode = true;
call.rawtarget = chatInputHandler;

// Restore on chat exit
call.rawmode = prevRawmode;
call.rawtarget = prevRawtarget;
```
The user's current handler (menu, message reader, etc.) remains loaded but inactive. No data loss -- the handler resumes exactly where it left off.

### 2.3 ANSI Scroll Regions (New)

Split-screen chat requires DECSTBM (DEC Set Top and Bottom Margins):
```
ESC [ <top> ; <bottom> r    -- set scrolling region
ESC [ <top> ; <bottom> r    -- reset to full screen (top=1, bottom=max)
```
Text output within the scroll region wraps and scrolls normally without affecting content outside it. This is well-supported by SyncTERM, xterm.js, and all VT100-compatible terminals.

**New method needed** in `BaseCommands`:
```javascript
setscrollregion(top, bottom) {
    this._send('\x1b[' + top + ';' + bottom + 'r');
}
```

### 2.4 Chat State on Call Object

Each call needs a lightweight chat state so that page requests and chat sessions can be tracked:
```javascript
call.chatState = {
    active: false,          // currently in a chat session
    pagedSysop: false,      // user has paged and is waiting
    pagedAt: null,          // timestamp of page request
    sysopNode: null,        // node number of chatting sysop
    prevRawmode: false,     // saved input state
    prevRawtarget: null
}
```

---

## 3. Page System

### 3.1 User Page Request

A new menu command (`pageChat` or similar) allows users to request sysop attention:
1. User selects "Page Sysop" from a menu
2. `call.chatState.pagedSysop = true` and `call.chatState.pagedAt = Date.now()`
3. Node status updated via `updateNodeStatus('page_sysop')`
4. Terminal bell (`\x07`) sent to all active sysop nodes (nodes where caller has Sysop flag)
5. User sees "Paging sysop... press ESC to cancel"
6. If sysop responds, chat begins. If user cancels or times out, state resets.

### 3.2 Page Notification (Web)

The NodeSpy dashboard polls `status.json` every 4 seconds. Nodes with `pagedSysop: true` get a visual indicator (pulsing badge, different card colour). The watch page could show a "Chat" button alongside the existing "Read-Only" badge.

### 3.3 Page Notification (Terminal)

If the sysop is in the NodeSpy node list, paged nodes are highlighted. A bell character is sent to the sysop's terminal on new page requests.

---

## 4. Chat Session

### 4.1 Initiation

**From web (NodeSpy watch page)**:
- Sysop clicks "Chat" button
- WebSocket message `{ type: 'chat_start' }` sent to server
- Server initiates chat on target node (see 4.2)
- xterm.js switches from read-only to bidirectional

**From terminal (NodeSpy sub-module)**:
- While in watching state, sysop presses `C` (or similar hotkey) to initiate chat
- Sub-module transitions to `chatting` state

### 4.2 Target-Side Setup

When the sysop initiates chat:

1. **Hijack target input**: Save `call.rawmode`/`call.rawtarget`, set rawmode with chat handler
2. **Set up split screen on target terminal**:
   - Save cursor position
   - Draw horizontal divider at the midpoint (e.g. row 13 on a 25-row terminal)
   - Set scroll region for top half (rows 1-12) for conversation
   - Position cursor in top region
   - Display "Sysop chat -- press ESC to exit" in the divider
3. **Notify user**: Bell + "The sysop would like to chat with you"
4. Set `call.chatState.active = true`

### 4.3 Sysop-Side Setup

**Terminal**: The sysop's NodeSpy watching state transitions to `chatting`:
- Split screen on sysop's terminal (same layout as target)
- Input no longer discarded -- keystrokes are captured for chat
- Ring buffer subscription continues (sees both sides of conversation)

**Web**: xterm.js `term.onData()` handler enabled, sends keystrokes via WebSocket. The server injects them into the target's terminal and echoes to the sysop's viewer.

### 4.4 Message Flow

```
Sysop types     -->  sysop input captured
                -->  format: "Sysop: <text>"
                -->  targetCall.cmds.senddata() (appears on target terminal)
                -->  ring buffer captures it
                -->  sysop's viewer sees it via ring buffer subscription

User types      -->  rawmode captures input on target call
                -->  format: "Username: <text>"
                -->  targetCall.cmds.senddata() (appears on target terminal)
                -->  ring buffer captures it
                -->  sysop's viewer sees it via ring buffer subscription
```

Both sides see the full conversation because all chat output goes through `targetCall.cmds.senddata()`, which writes to both the socket and ring buffer. The sysop's viewer (web or terminal) subscribes to that ring buffer.

### 4.5 Line Editing

Chat input uses simple line editing:
- Characters accumulate in a buffer, echoed on the input line
- Enter sends the line, clears the input line, outputs formatted message to the conversation region
- Backspace erases last character
- No ANSI/cursor key handling needed (plain text chat)

### 4.6 Split-Screen Layout

```
+------------------------------------------+
| Sysop: Hey, need help with anything?     |  <- Conversation
| User: Yeah, the door game is stuck        |     region
| Sysop: Let me check                      |     (scrolling)
|                                           |
|                                           |
|                                           |
|========= Sysop Chat (ESC to exit) =======|  <- Divider
| > typing here...                          |  <- Input line
+------------------------------------------+
```

- **Conversation region**: Rows 1 to `midpoint - 1`. DECSTBM scroll region set here. New messages append at the bottom of this region, old messages scroll up.
- **Divider**: Single row at `midpoint`. Static, not part of scroll region.
- **Input line**: Rows `midpoint + 1` to bottom. Cursor parked here during typing. Cleared on Enter.

### 4.7 Termination

Either side can exit:
- **User presses ESC**: Chat ends, rawmode restored, scroll region reset, screen redrawn
- **Sysop presses ESC** (terminal): NodeSpy returns to watching state (or node list)
- **Sysop clicks Exit** (web): WebSocket sends `{ type: 'chat_end' }`, server tears down chat
- **User disconnects**: Ring buffer `"end"` event fires, chat torn down

On exit:
1. Restore target's `call.rawmode` / `call.rawtarget`
2. Reset scroll region to full screen: `ESC [ 1 ; <max> r`
3. Redraw target's current screen (the handler that was paused needs a redraw signal)
4. Clear `call.chatState`

### 4.8 Handler Redraw

After chat exits, the user's paused handler needs to redraw its screen. Options:
- Call `handler.redraw()` if the handler supports it (MenuHandler has `_redrawMenu()`)
- Send a synthetic `CMD_REDRAW` input token
- Simply clear screen and let the user press a key to trigger redraw

---

## 5. Web Interface Changes

### 5.1 NodeSpy Watch Page

- Add "Chat" button (disabled when not watching, enabled when watching)
- Toggle xterm.js between read-only and bidirectional
- Send/receive chat control messages over existing WebSocket
- Status bar shows "Chatting" instead of "Watching" during chat

### 5.2 WebSocket Protocol Extension

Add message types to the nodespy WebSocket:
```
Server -> Client:  binary frames (terminal output, as now)
Client -> Server:  { type: 'chat_start' }
Client -> Server:  { type: 'chat_end' }
Client -> Server:  { type: 'chat_input', data: '<keystrokes>' }
Server -> Client:  { type: 'chat_started' }
Server -> Client:  { type: 'chat_ended', reason: '<reason>' }
```

Binary frames continue for terminal output (no change). JSON frames used for chat control.

### 5.3 Dashboard Page

- Paged nodes get a visual indicator (pulsing border, bell icon)
- "Chat" quick-action button on paged node cards

---

## 6. Terminal Interface Changes

### 6.1 NodeSpy Sub-Module

Add `chatting` state to the existing state machine:
- `list` -> `watching` -> `chatting` -> `watching` -> `list`
- `C` key during watching state initiates chat
- ESC during chatting returns to watching
- Split-screen managed with DECSTBM on the sysop's terminal

### 6.2 Page Sysop Command

New menu command `pageSysop`:
- Sets page state on call object
- Sends bell to sysop nodes
- Waits for response or timeout/cancel
- Optional: configurable page message ("reason for page")

---

## 7. Implementation Plan

### Phase 1: Split-Screen Foundation
- Add `setscrollregion()` to BaseCommands
- Build a reusable `SplitScreenChat` helper class (manages regions, line input, message display)
- Test with a simple echo mode

### Phase 2: Sysop Break-In (Terminal)
- Add `chatting` state to NodeSpy sub-module
- Implement target-side input hijacking and split-screen setup
- Sysop types in NodeSpy, text injected to target via `cmds.senddata()`
- Target types in rawmode, text injected to own terminal
- Both sides see conversation via ring buffer

### Phase 3: Sysop Break-In (Web)
- Extend nodespy WebSocket with chat control messages
- Enable xterm.js input during chat
- Server-side chat session management

### Phase 4: Page System
- Add `pageSysop` menu command
- Page notification on NodeSpy dashboard (web)
- Page notification in NodeSpy node list (terminal)
- Bell delivery to sysop nodes

### Phase 5: Polish
- Chat logging (store conversation history)
- Configurable chat colours (sysop vs user)
- "Sysop is typing" indicator
- Multi-sysop coordination (prevent two sysops chatting same user)

---

## 8. Security Considerations

- Only sysop-flagged users can initiate chat or respond to pages
- Chat input from web is validated (length limits, no control injection beyond chat protocol)
- Page rate limiting prevents spam (one active page per user)
- Chat sessions are logged for audit
- Target user can always ESC out of chat (cannot be trapped). **Not as built**: the target cannot exit; only the sysop ends a chat

---

## 9. Dependencies

- NodeSpy system (complete): ring buffer, output subscription, call lookup, WebSocket endpoint
- DECSTBM support in terminal clients (SyncTERM, xterm.js, NetRunner -- broadly supported)
- No new npm packages required
- No database schema changes (chat state is in-memory only)
