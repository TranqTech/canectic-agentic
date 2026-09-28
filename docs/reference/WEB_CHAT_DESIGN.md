# Web Sysop Chat Design

Extends sysop chat to web-browsing users. The sysop initiates chat from the NodeSpy dashboard; the web user sees a chat overlay on whatever page they're viewing. The same infrastructure also carries user-to-user telegrams (IMs).

**Status: implemented**, using the "Sysop-side via PresenceSocket (preferred approach)" below; the AJAX-route alternative (`/admin/nodespy/web-chat/...`) was not built. User-to-user telegrams, listed under "later" at the end, are also built. The "Current State" section describes the situation before this work.

### Implementation notes (where the build differs)

- **No `activeChats` map.** Sessions live only in Redis; `userSockets` (userId -> Set of ws) is the in-memory routing index in `src/servers/presenceSocket.js`.
- **`chat:{chatId}` is a JSON string** (`SET ... EX`), not a hash, with `chatId, initiatorUserId, initiatorName, targetUserId, targetName, mode, startedAt`. `chat:{chatId}:msgs` is a list; `chat:user:{userId}` holds the active chatId. TTL `CHAT_TTL` is 3600 s, refreshed on each message.
- **`chat_initiate` takes `mode`**: `sysop` (default, requires the admin check) or `telegram` (any logged-in user; started from the who's online partial via `window._webChat.telegram(userId)`). Refusals come back as `{ type: 'chat_error', error }` (chat disabled, insufficient permissions, invalid target, user not online, either side already in a chat).
- **Messages carry more fields**: server `chat_start` has `targetName` (to the initiator) or `peerName` (to the target) plus `mode`; `chat_msg` has `from` and `name`; `chat_restore` adds `role` (`initiator`/`target`) and `mode`.
- **Who can close**: in sysop mode only the initiator (the sysop) gets a close control; the target cannot end a sysop chat. Either side can close a telegram.
- **UI**: the overlay markup is `src/views/partials/chatOverlay.pug`, included by BOTH `layouts/user.pug` and `layouts/admin.pug`; the `window._webChat` client code is inline in each layout.
- **Config keys** are in the `chat` category, not `system`.
- The same socket also carries `notification`, `notification_count`, `notification_read(_all)` and the maintenance-mode `maintenance` push (`src/maintenance/webDrain.js`); see `web_architecture.md`.

## Current State

### Terminal sysop chat (already works)
- Sysop watches a terminal node via NodeSpy (web dashboard or terminal command)
- Sysop clicks "Chat" or presses C to initiate
- If the user is at a menu: SplitScreenChat starts immediately (DECSTBM split-screen on target terminal)
- If not at menu: chat is queued via `call.pendingChat`, fires automatically when user returns to menu
- Sysop types via web chat bar (JSON messages over `/ws/nodespy`) or terminal input
- Target types via raw input hijacking (`call.rawmode = true`)
- Both sides see the conversation in the split-screen layout

### What's missing
- No way to chat with web-only users (they have no terminal/call object)
- Web users tracked via PresenceSocket heartbeats, but the socket only handles `heartbeat` messages
- The NodeSpy dashboard only shows terminal nodes, not web presence users

## Design

### Architecture overview

```
Sysop (web NodeSpy)                    Web User (any page)
      |                                       |
  /ws/nodespy                          /ws/presence
      |                                       |
  nodespySocket.js                    presenceSocket.js
      |                                       |
      +-------- Redis pub/sub --------+-------+
                 (chat channel)
```

The sysop side uses the existing `/ws/nodespy` WebSocket (or a new action on the NodeSpy dashboard). The web user side uses the existing `/ws/presence` WebSocket, which is already connected on every authenticated page. Chat messages flow through the PresenceSocket using the same JSON message protocol that already handles heartbeats.

### Why extend PresenceSocket instead of creating a new WebSocket

1. **Already connected** -- every authenticated web page connects to `/ws/presence` on load. No new client-side connection code needed.
2. **Session-authenticated** -- the connection already validates the session cookie and knows the userId/username.
3. **Reconnect handling** -- the client already reconnects on disconnect with a 5-second delay.
4. **The original design anticipated this** -- the comment on line 6 of presenceSocket.js says "Future: user-to-user instant messaging via this channel" and there's a placeholder `case 'im'` in the message handler.

### Message protocol additions (PresenceSocket)

**Server -> Client:**
```javascript
{ type: 'chat_start', chatId: <string>, sysopName: <string> }
{ type: 'chat_msg', chatId: <string>, from: 'sysop', text: <string> }
{ type: 'chat_end', chatId: <string>, reason: <string> }
```

**Client -> Server:**
```javascript
{ type: 'chat_msg', chatId: <string>, text: <string> }
{ type: 'chat_typing', chatId: <string>, text: <string> }
```

The `chatId` is a UUID that identifies the chat session. This allows multiple overlapping chat features later (sysop chat, user IMs) without ambiguity.

### Sysop initiation flow

The NodeSpy dashboard currently only shows terminal nodes. We extend it to also show web presence users, with a "Chat" button on each web user card.

1. **Dashboard shows web users**: `/admin/nodespy/status.json` already returns terminal nodes. Add a `webUsers` array from `getOnlineUsers()` to the response.
2. **Sysop clicks "Chat" on a web user card**: POST to `/admin/nodespy/web-chat/:userId` (new route). Server:
   a. Validates sysop permissions
   b. Generates a `chatId` (UUID)
   c. Stores chat session in `PresenceServer.activeChats` map: `{ chatId, sysopWs, targetUserId, targetUsername, sysopName, startedAt }`
   d. Finds the target user's PresenceSocket connection(s) by userId
   e. Sends `{ type: 'chat_start', chatId, sysopName }` to the target's WebSocket
   f. Returns `{ chatId }` to the sysop's browser
3. **Sysop's chat interface**: The NodeSpy dashboard opens a chat panel (similar to the existing chat bar on the snoop page) bound to the `chatId`. Sysop messages are sent via AJAX POST to `/admin/nodespy/web-chat/:chatId/send` or via the existing `/ws/nodespy` if the sysop has a snoop connection.

**Simpler alternative for sysop-side transport**: Since the sysop is already on the admin panel (which also connects to `/ws/presence`), we could route sysop chat messages through the *sysop's* PresenceSocket connection too. Both sides use the same protocol. The server matches messages by `chatId` and routes between the two PresenceSocket connections.

This is cleaner -- no new WebSocket endpoints, no new AJAX routes for message sending. The PresenceSocket becomes the universal real-time channel for all web chat.

### Sysop-side via PresenceSocket (preferred approach)

**Sysop -> Server (via PresenceSocket):**
```javascript
{ type: 'chat_initiate', targetUserId: <int> }   // Start chat with web user
{ type: 'chat_msg', chatId: <string>, text: <string> }
{ type: 'chat_end', chatId: <string> }
```

**Server -> Sysop (via PresenceSocket):**
```javascript
{ type: 'chat_start', chatId: <string>, targetName: <string> }
{ type: 'chat_msg', chatId: <string>, from: 'user', text: <string> }
{ type: 'chat_typing', chatId: <string>, text: <string> }
{ type: 'chat_end', chatId: <string>, reason: <string> }
```

The sysop initiates by sending `chat_initiate` with the target userId. The server creates the session, notifies the target, and responds to the sysop with `chat_start`. From there, both sides exchange `chat_msg` and the server routes between the two connections.

### Chat session management -- Redis-backed

Chat sessions and message history are stored in Redis so they survive page navigations and brief WebSocket reconnects. When a user navigates to a new page, the PresenceSocket disconnects and reconnects -- the server checks Redis for an active chat and restores the full state.

**Redis keys:**

```
chat:{chatId}              -- Hash: session metadata
  sysopUserId, sysopName, targetUserId, targetName, startedAt, status

chat:{chatId}:msgs         -- List: message history (JSON per entry)
  { from: 'sysop'|'user', name: <string>, text: <string>, ts: <timestamp> }

chat:user:{userId}         -- String: active chatId for this user (both sysop and target)
```

All chat keys use a TTL (e.g. 1 hour) as a safety net -- if both sides disconnect without a clean `chat_end`, the session expires automatically. TTL is refreshed on each message.

**Session lifecycle:**

1. **Initiate**: Server creates `chat:{chatId}` hash, sets `chat:user:{sysopUserId}` and `chat:user:{targetUserId}` to `chatId`
2. **Messages**: Each `chat_msg` is pushed to `chat:{chatId}:msgs` and TTL refreshed
3. **Reconnect**: On PresenceSocket connect, server checks `chat:user:{userId}`. If present, loads chat session and full message history, sends `chat_restore` to client
4. **End**: Server deletes all three keys (`chat:{chatId}`, `chat:{chatId}:msgs`, `chat:user:{sysopUserId}`, `chat:user:{targetUserId}`)

**Reconnect message (Server -> Client):**
```javascript
{ type: 'chat_restore', chatId: <string>, peerName: <string>, messages: [
    { from: 'sysop'|'user', name: <string>, text: <string>, ts: <timestamp> },
    ...
]}
```

The client receives this on reconnect and re-renders the chat overlay with full history. This makes page navigation seamless -- the user sees the same conversation after clicking a link.

**In-memory indexes on PresenceServer (for WebSocket routing):**

```javascript
this.userSockets = new Map();  // userId -> Set<ws>
```

The PresenceServer already has `this.clients` mapping `ws -> { userId, username }`. The `userSockets` reverse index enables finding a user's WebSocket connection(s) by userId for message delivery. Updated on connect/disconnect. A user may have multiple tabs open -- chat messages go to all of them.

The in-memory `userSockets` map is the live routing table. Redis is the persistence layer. If the server restarts, active chats are recoverable from Redis (clients reconnect and get `chat_restore`).

### Permission check

Chat initiation requires the same admin check as NodeSpy: `security >= adminsecurity AND permissionflags includes 'Sysop'`. The PresenceServer validates this by looking up the initiating user's session.

### Web user chat UI

A floating chat overlay that appears on any page when a chat is active. Injected via the existing layout template (`layouts/user.pug`) since the PresenceSocket script is already there.

**UI structure:**
```
+------------------------------------------+
| Sysop Chat - <SysopName>           [X]   |
+------------------------------------------+
| [Sysop]: Hello, how can I help?          |
| [You]: I have a question about...        |
| [Sysop]: Sure, let me check.            |
|                                          |
+------------------------------------------+
| [Type a message...              ] [Send] |
+------------------------------------------+
```

- Fixed-position overlay in bottom-right corner (like a support chat widget)
- Appears when `chat_start` message received, hidden when `chat_end` received
- User can close with X button (sends `chat_end` to server)
- Scrolling message area, input field with Enter-to-send
- Sound notification (optional beep/chime) on chat start and new messages
- Minimise to a badge/icon while browsing

**Implementation**: A `<div id="sysop-chat">` hidden by default in `layouts/user.pug`, shown/hidden via JavaScript responding to PresenceSocket messages. No new page loads needed.

### Sysop chat UI on NodeSpy dashboard

Extend the existing NodeSpy dashboard to show web users alongside terminal nodes.

**Web user cards** show:
- Username, activity label, duration online
- "Chat" button (initiates web chat)
- Badge: "Web" source indicator

**Active chat panel** (appears when sysop initiates):
- Similar layout to the existing chat bar on the snoop watch page
- Message history, input field, send button
- Typing indicator from target
- "End Chat" button

This could be a modal overlay or a slide-out panel on the NodeSpy dashboard.

### NodeSpy status.json extension

Current response:
```javascript
{ nodes: [ { nodenum, username, status, ... } ] }
```

Extended response:
```javascript
{
  nodes: [ ... ],            // terminal nodes (unchanged)
  webUsers: [                // NEW: web presence users
    { userId, username, activity, lastSeen, source: 'web' }
  ]
}
```

### Cross-tab and page navigation behaviour

A web user may have multiple tabs open, each with its own PresenceSocket connection. Chat messages are sent to ALL connections for that userId (via `userSockets` map). The chat UI uses `chatId` to deduplicate -- if a chat overlay is already showing for this `chatId`, additional `chat_start` messages are ignored.

**Page navigation**: When a user clicks a link, the current page's PresenceSocket closes and the new page's PresenceSocket connects. On the new connection, the server checks `chat:user:{userId}` in Redis. If an active chat exists, the server sends `chat_restore` with the full message history. The client-side code in the layout template sees this and re-renders the chat overlay. From the user's perspective, the chat follows them across pages seamlessly.

**Brief disconnect window**: There is a small gap between the old page's socket closing and the new page's socket opening. Messages sent by the sysop during this gap are stored in the Redis message list. On reconnect, `chat_restore` delivers them. No messages are lost.

### What about sysop chatting with terminal users from web?

This already works via the existing NodeSpy snoop page (`/admin/nodespy/:nodenum`). The web sysop chat system is specifically for reaching web-only users who have no terminal node.

### What this enables for user-to-user IMs later

The same PresenceSocket message protocol and `activeChats` session management can be extended for user-to-user telegrams:

1. User A sends `{ type: 'chat_initiate', targetUserId: B }` (with different permission checks -- not admin-only)
2. Server creates chat session, notifies User B
3. Both users see the same floating overlay
4. Same `chat_msg`, `chat_typing`, `chat_end` message types

The only differences from sysop chat: permission model (any user can initiate, not just sysops) and UI labelling.

## Implementation order

1. **PresenceServer extensions**: `userSockets` reverse index, `activeChats` map, message routing for `chat_initiate`/`chat_msg`/`chat_end`/`chat_typing`, permission check
2. **Web user chat overlay**: HTML/CSS/JS in `layouts/user.pug` -- hidden div, show/hide on PresenceSocket messages, message display, input field
3. **NodeSpy dashboard extension**: Add web users to `status.json`, render web user cards with Chat button, chat panel UI
4. **Sysop-side chat in PresenceSocket**: Handle `chat_initiate` from admin users, route messages, teardown
5. **Sound notifications**: Optional audio cue on chat start/new message

## Config keys

| Key | Type | Default | Category | Description |
|-----|------|---------|----------|-------------|
| `web_chat_enabled` | boolean | `true` | chat | Enable/disable sysop-to-web-user chat |
| `web_chat_sound` | boolean | `true` | chat | Play notification sound on chat events |

## Files to modify/create

| File | Changes |
|------|---------|
| `src/servers/presenceSocket.js` | Add userSockets index, activeChats, chat message routing |
| `src/views/layouts/user.pug` | Add hidden chat overlay div, PresenceSocket chat message handlers |
| `src/views/admin/nodespy/index.pug` | Add web user cards, chat panel |
| `src/routes/admin.js` | Extend `/admin/nodespy/status.json` to include web users |
| `public/css/styles.css` | Chat overlay styling |
| `src/config/configDefaults.js` | Add `web_chat_enabled`, `web_chat_sound` |
