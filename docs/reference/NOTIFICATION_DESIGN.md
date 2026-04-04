# Notification System Design

Centralised notification system for both sysop operational alerts and user activity notifications. Delivered in real-time via PresenceSocket, persisted in PostgreSQL for history.

## Overview

Two notification channels:
- **Sysop notifications**: operational events (errors, requests, new users, import results)
- **User notifications**: activity events (replies, new PMs, new files, announcements)

Both use the same infrastructure but different delivery and visibility rules.

## Schema

### notifications table

```sql
CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    user_id INTEGER,                    -- target user (NULL = sysop broadcast)
    type VARCHAR(32) NOT NULL,          -- category for filtering/icons
    title VARCHAR(256) NOT NULL,
    body TEXT,
    link VARCHAR(512),                  -- optional URL to navigate to
    icon VARCHAR(32) DEFAULT 'info',    -- bootstrap icon suffix (info, exclamation, check, etc.)
    severity VARCHAR(16) DEFAULT 'info', -- info, success, warning, danger
    read BOOLEAN DEFAULT false,
    read_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);
```

Indexes:
- `(user_id, read, created_at DESC)` -- fast unread query per user
- `(user_id IS NULL, read, created_at DESC)` -- sysop broadcast query

### user_id conventions

- `user_id = N`: notification for a specific user
- `user_id = NULL`: sysop broadcast (visible to all users with Sysop permission flag)

## Notification Types

### Sysop (user_id = NULL)

| Type | Severity | Title Example | Produced By |
|------|----------|---------------|-------------|
| `tic_error` | danger | Bad TIC file: FILENAME.TIC | ticTosser |
| `tic_received` | info | TIC file received: FILENAME in AREA | ticTosser |
| `pm_undeliverable` | warning | Undeliverable PM to "Username" | privateMessages |
| `areafix_request` | info | AreaFix request from 1:123/456 | areafix |
| `filefix_request` | info | FileFix request from 1:123/456 | filefix |
| `freq_served` | info | FREQ: served 3 file(s) to 1:123/456 | freq/session |
| `freq_failed` | warning | FREQ: 2 file(s) not found for 1:123/456 | freq/session |
| `user_registered` | info | New user registered: Username | useraccounts |
| `user_verified` | success | User verified: Username | mailVerification |
| `mailer_error` | danger | Mailer session failed: 1:123/456 | mailer/session |
| `mailer_auth_fail` | warning | Auth failure from 1.2.3.4 | mailer/session |
| `nodelist_imported` | success | Nodelist imported: 1234 nodes | nodelistImport |
| `nodelist_error` | danger | Nodelist import failed: reason | nodelistImport |
| `toss_error` | danger | FTN inbound error: reason | ftnTosser |
| `packet_rejected` | warning | Packet rejected: bad password | ftnTosser |

### User (user_id = specific)

| Type | Severity | Title Example | Produced By |
|------|----------|---------------|-------------|
| `pm_received` | info | New PM from Username | privateMessages |
| `thread_reply` | info | Reply in "Subject" by Username | echomail (future) |
| `file_new` | info | New file in Area Name: filename | fileEntries (future) |
| `announcement` | info | New announcement: Title | announcements (future) |
| `security_change` | warning | Your password was changed | useraccounts |
| `verification` | success | Address verified successfully | mailVerification |

## Model: src/models/notifications.js

```javascript
// Core functions
async function ensureTable()
async function create(userId, type, title, body, opts)  // opts: { link, icon, severity }
async function createSysop(type, title, body, opts)     // shorthand: userId = null
async function getUnread(userId, limit)
async function getAll(userId, limit, offset)
async function getSysopUnread(limit)                    // where user_id IS NULL
async function markRead(id, userId)
async function markAllRead(userId)
async function getUnreadCount(userId)
async function getSysopUnreadCount()
async function purgeOld(days)                           // maintenance cleanup
```

## Delivery via PresenceSocket

When a notification is created, push it to the target user's connected WebSocket(s):

```javascript
// In notifications.create():
presenceServer._sendToUser(userId, {
    type: 'notification',
    id: notificationId,
    notifType: type,
    title: title,
    body: body,
    link: link,
    icon: icon,
    severity: severity
});
```

For sysop broadcasts, send to all connected users with the Sysop permission flag. The PresenceServer already has session data including permission flags.

## UI: Nav Bar Bell Icon

Both user and admin layouts get a bell icon in the nav bar:

```
[Bell Icon] (3)     -- unread count badge
```

Click opens a dropdown showing the 10 most recent notifications:
- Unread items highlighted
- Click a notification with a link: navigate and mark read
- "Mark All Read" button at the bottom
- "View All" link to a full notifications page

### Notification dropdown item format

```
[icon] Title                              2m ago
Body text preview...
```

Colour-coded by severity: info (blue), success (green), warning (yellow), danger (red).

## Web Page: /notifications

Full notification history with pagination. Table or card list with:
- Filter by type/severity
- Mark read/unread toggle
- Bulk mark read
- Sysop sees both their personal notifications and sysop broadcasts

## PresenceSocket Message Types

### Server -> Client

```javascript
{ type: 'notification', id, notifType, title, body, link, icon, severity }
{ type: 'notification_count', count: N }  // sent on connect and after changes
```

### Client -> Server

```javascript
{ type: 'notification_read', id: N }
{ type: 'notification_read_all' }
```

## Producer Integration Points

Each producer calls `notifications.create()` or `notifications.createSysop()` at the point where the event occurs. Examples:

### ticTosser.js -- bad TIC file
```javascript
await notifications.createSysop('tic_error', 'Bad TIC file: ' + filename, errorDetails, {
    severity: 'danger', icon: 'exclamation-triangle'
});
```

### privateMessages.js -- PM delivered
```javascript
await notifications.create(recipientUserId, 'pm_received',
    'New PM from ' + fromUser, subject, {
    link: '/pm/inbox', icon: 'envelope', severity: 'info'
});
```

### areafix.js -- request processed
```javascript
await notifications.createSysop('areafix_request',
    'AreaFix request from ' + fromAddress,
    commands.length + ' command(s) processed', {
    severity: 'info', icon: 'diagram-3'
});
```

## Config Keys

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `notifications_enabled` | boolean | `true` | Enable/disable notification system |
| `notifications_retention_days` | number | `30` | Days to keep read notifications before purge |
| `notifications_max_per_page` | number | `50` | Pagination limit for notification history |

## Maintenance

Daily purge job (add to schedules.js):
- Delete read notifications older than `notifications_retention_days`
- Keep unread notifications indefinitely (until explicitly read or manually purged)

## Terminal: Notification Reader

Menu command `notifications` (`BaseSubModule` in `handlers/menucommands/notificationReader.js`).

### Display

Lightbar list of recent notifications (newest first), similar to the PM reader pattern:
- Unread items highlighted (bright colour)
- Read items dimmed
- Columns: severity indicator, title, age (e.g. "2h ago", "3d ago")
- Sysop sees both personal and sysop broadcast notifications

### Controls

- **Up/Down**: navigate list
- **Enter**: view notification detail (title, full body, link info)
- **R**: mark selected as read
- **A**: mark all as read
- **D**: delete selected
- **ESC/Q**: exit

### Call flow integration

Optional call flow stage: if the user has unread notifications, show a summary before or after the PM check stage. "You have N unread notification(s). View now? [Y/n]"

This mirrors the terminal `check_email` pattern -- a brief prompt that can be added to the call flow or used as a standalone menu command.

### Sysop terminal priority

For sysop notifications with severity `danger`, the terminal could display an immediate alert when the sysop returns to a menu -- similar to how `pendingChat` fires when returning to menu. A `pendingNotification` flag on the call object would trigger a brief "!! ALERT: Bad TIC file: filename.tic -- press any key !!" before the menu redraws.

## Implementation Order

1. Schema + model (create, query, mark read, counts)
2. PresenceSocket delivery (push on create, count on connect)
3. Nav bar bell icon + dropdown (both layouts)
4. Sysop producers (tic_error, pm_undeliverable, mailer errors -- highest value)
5. User producers (pm_received)
6. /notifications page with full history
7. Terminal notification reader (menu command + call flow stage)
8. Terminal sysop alert on danger severity
9. Remaining producers (wired incrementally)
10. Maintenance purge job

## Design Decisions

1. **Single table, not per-type tables**: notifications are structurally identical regardless of type. The `type` column enables filtering. Simpler schema, simpler queries.

2. **user_id NULL for sysop broadcasts**: avoids duplicating rows for every sysop user. The query just checks `user_id = $1 OR (user_id IS NULL AND user_is_sysop)`.

3. **PresenceSocket for delivery**: already connected on every page, already handles session auth and multi-tab routing. No new WebSocket endpoint needed.

4. **PostgreSQL not Redis for persistence**: notifications need to survive restarts and be queryable with pagination/filtering. Redis is for ephemeral state; notifications are durable records.

5. **Severity levels match Bootstrap**: info/success/warning/danger map directly to alert colours and icon variants. No translation layer needed.

6. **Producers are fire-and-forget**: `create()` is async but callers don't need to await it. A failed notification shouldn't break the operation that triggered it. Wrap in try/catch at the call site.
