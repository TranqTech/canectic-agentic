# Integration Guide — messages.js migration + pointer system

## Overview

Two new model files:
- **`messages.js`** — view-facing message retrieval and user posting (migrated from echomail.js + new methods)
- **`userMsgPointers.js`** — read tracking with scan pointer + exceptions

One SQL migration:
- **`migrations/001_pointer_system.sql`** — creates `user_msg_pointers` and `user_msg_reads` tables, seeds existing user+area combos

---

## 1. messages.js — what changed

### Methods migrated FROM echomail.js → messages.js

These methods are now in `messages.js` and should be imported from there by routes/views:

| Method | Notes |
|--------|-------|
| `getMessagesForThread(shortcode, threadid)` | Includes body_html fallback rendering |
| `getThreadsForArea(shortcode)` | Direct move |
| `getRecentThreadsForArea(shortcode)` | Direct move |
| `getMessageById(id, shortcode)` | Raw retrieval (no body_html fallback) |
| `getMessagesForArea(shortcode, options)` | Implemented (was a TODO stub) — now accepts `{limit, offset, order}` |
| `getThreadByUUID(uuid, shortcode)` | Direct move |
| `buildMessageTree(messages)` | Direct move |
| `startNewThread(formObj, shortcode)` | Moved; FTN address resolution extracted to shared `resolveAreaAddress()` |
| `replyToThread(formObj, shortcode, threaduuid)` | Same extraction |
| `deleteMessageByUUID(uuid, shortcode)` | Direct move |
| `updateThread(id, shortcode)` | Moved (used internally by replyToThread, also exported) |

### New methods in messages.js

| Method | Purpose |
|--------|---------|
| `listMsgGroups(userSecurity)` | Returns active groups where `security <= userSecurity` |
| `getAreasInGroup(groupShortcode, userSecurity)` | Returns active areas in a group where `read_security <= userSecurity` |
| `getMessage(id, shortcode)` | Like `getMessageById` but with body_html fallback + isAnsi detection |
| `getMessageCount(shortcode)` | Returns total message count for an area |
| `getMessages(shortcode, options)` | Paginated retrieval with `{limit, offset, order, threadId, afterId, beforeId}` |
| `saveMessage(formObj, shortcode, threaduuid?)` | Unified posting: if `threaduuid` is provided → reply, otherwise → new thread |

### What stays in echomail.js

These methods remain in echomail.js (network tossing concerns):

- `handleInboundEchoMessage` — inbound import from all tossers
- `ftnToDb` / `dbToFtn` — FTN ↔ DB field conversion
- `threadMessage` — thread resolution during import
- `formatBodyHtml` — import-time pre-rendering (echomail.js keeps its own copy)
- `getOutboundForConnection` — FTN outbound delivery
- `updateSeenbyArray`, `updateMsgIndexes` — outbound support
- `mergeThreads`, `mergeRecentThreads` — thread maintenance (called by tosser)
- `updateAreaThreads`, `updateDailyThreads`, `updateThreadArray` — batch thread updates
- `applyThreadingForArea` — retroactive threading pass
- `threadUpdateArray` — shared state for batched thread updates

### echomail.js export changes needed

Remove from echomail.js exports (now in messages.js):
```javascript
// REMOVE these from echomail.js export block:
deleteMessageByUUID,
getMessagesForArea,
getThreadsForArea,
getRecentThreadsForArea,
getMessagesForThread,
getMessageById,
getThreadByUUID,
startNewThread,
replyToThread
```

Keep in echomail.js exports:
```javascript
export {
    handleInboundEchoMessage,
    applyThreadingForArea,
    updateAreaThreads,
    updateThread,
    updateThreadArray,
    updateDailyThreads,
    threadUpdateArray,
    mergeRecentThreads,
    getOutboundForConnection
};
```

Note: `updateThread` is exported from both files during transition. echomail.js callers that
use it for batch thread maintenance can continue importing from echomail.js. View-layer
callers should import from messages.js.

---

## 2. Route/view import changes

Every route file that currently does:
```javascript
import * as echomail from './models/echomail.js';
// then calls echomail.getMessagesForThread(), echomail.startNewThread(), etc.
```

Should change to:
```javascript
import * as messages from './models/messages.js';
// then calls messages.getMessagesForThread(), messages.startNewThread(), etc.
```

Specific patterns to find and update:

| Old call | New call |
|----------|----------|
| `echomail.getMessagesForThread(sc, tid)` | `messages.getMessagesForThread(sc, tid)` |
| `echomail.getThreadsForArea(sc)` | `messages.getThreadsForArea(sc)` |
| `echomail.getRecentThreadsForArea(sc)` | `messages.getRecentThreadsForArea(sc)` |
| `echomail.getMessageById(id, sc)` | `messages.getMessage(id, sc)` (preferred) or `messages.getMessageById(id, sc)` |
| `echomail.getThreadByUUID(uuid, sc)` | `messages.getThreadByUUID(uuid, sc)` |
| `echomail.buildMessageTree(msgs)` | `messages.buildMessageTree(msgs)` |
| `echomail.startNewThread(form, sc)` | `messages.startNewThread(form, sc)` or `messages.saveMessage(form, sc)` |
| `echomail.replyToThread(form, sc, tuuid)` | `messages.replyToThread(form, sc, tuuid)` or `messages.saveMessage(form, sc, tuuid)` |
| `echomail.deleteMessageByUUID(uuid, sc)` | `messages.deleteMessageByUUID(uuid, sc)` |

---

## 3. userMsgPointers.js — integration hooks

### A. Table creation (one-time)

Run the SQL migration, OR call at startup:
```javascript
import * as userMsgPointers from './models/userMsgPointers.js';
await userMsgPointers.createTables();
```

### B. Hook into user creation (useraccounts.js)

In `createNewUser()`, after the user record is successfully inserted, add:

```javascript
// After: var dbres = await postgres.insertObject(rec, "users");
// After: if (dbres.status) { ... }

if (dbres.status) {
    // ... existing success handling ...

    // Pre-populate message pointers for the new user
    var pointerMod = await import('./userMsgPointers.js');
    await pointerMod.initPointersForUser(dbres.insertId);
}
```

Uses lazy import to avoid circular dependency risk (same pattern as msgAreas.js).

### C. Hook into area creation (msgAreas.js)

In `newArea()`, after backing tables are created successfully, add:

```javascript
// After: var tableResult = await createTablesForArea(shorty.toLowerCase());
// After: if (!tableResult.status) { ... } (the rollback block)
// Before or after the network mapping block:

// Pre-populate message pointers for the new area
var pointerMod = await import('./userMsgPointers.js');
await pointerMod.initPointersForArea(shorty);
```

### D. Hook into area deletion (msgAreas.js)

In `removeArea()`, before deleting the area record, add:

```javascript
// Before: var subErr = await postgres.write("DELETE FROM peer_area_subscriptions ...")

// Clean up pointer/read-tracking rows for this area
var pointerMod = await import('./userMsgPointers.js');
await pointerMod.removePointersForArea(shorty);
```

### E. Message read tracking in routes

When a user views a message:
```javascript
import * as userMsgPointers from './models/userMsgPointers.js';

// After retrieving and displaying a message:
await userMsgPointers.markRead(user.id, areaShortcode, message.id);
```

When rendering a thread, get read states in batch:
```javascript
var msgIds = threadMessages.map(m => m.id);
var readStates = await userMsgPointers.getReadStates(user.id, areaShortcode, msgIds);
// readStates is [ { msg_id, is_read }, ... ]
```

Newscan for all areas:
```javascript
var newscan = await userMsgPointers.getNewscanSummary(user.id);
// newscan is [ { area_shortcode, unread_count }, ... ]
```

Newscan for specific subscribed areas:
```javascript
var newscan = await userMsgPointers.getNewscanSummary(user.id, ['5150', 'DOVENET', 'MYSTIC']);
```

### F. QWK packet integration

After a successful user QWK download:
```javascript
// For each conference included in the packet:
await userMsgPointers.advancePointer(user.id, areaShortcode, highestMsgIdInPacket);
```

---

## 4. File placement

Both new model files go in the models directory alongside echomail.js:

```
src/models/
├── echomail.js          (trimmed — network tossing only)
├── messages.js          (NEW — view/posting)
├── userMsgPointers.js   (NEW — read tracking)
├── msgAreas.js          (hooks added)
├── msgGroups.js         (unchanged)
├── useraccounts.js      (hook added)
├── ...
```

Migration SQL goes wherever you keep migrations:
```
migrations/
└── 001_pointer_system.sql
```
