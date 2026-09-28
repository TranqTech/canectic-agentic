# Notification System Design

Centralised notification system for both sysop operational alerts and user activity notifications. Delivered in real-time via PresenceSocket, persisted in PostgreSQL for history.

**Status: implemented, with deviations from this design.** Built: table and model (`src/models/notifications.js`), PresenceSocket push, bell and dropdown in both layouts, `/notifications` history page, terminal reader menu command, daily purge. Changed from the design: sysop notifications are one row PER SYSOP, not a `user_id = NULL` broadcast (see Schema); the terminal reader has fewer keys than designed; there is no `notifications_max_per_page` key. Not built: the call flow notification stage, the terminal sysop danger alert (`pendingNotification`), type/severity filters and bulk actions on `/notifications`, and most of the producers originally listed (see Notification Types). The model has no delete function.

Not to be confused with `privateMessages.notifySysops(subject, body)`, which delivers a private message to every sysop's PM inbox (used by the FTN netmail adapter and the QWK tosser) and does not write to this table.

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

Created by `notifications.ensureTable()`, not by a `db/schema` file. `user_id` is written for every row, but the column is nullable.

Indexes:
- `idx_notif_user_unread (user_id, read, created_at DESC)` -- fast unread query per user
- `idx_notif_sysop (created_at DESC) WHERE user_id IS NULL` -- left over from the broadcast design; nothing writes NULL rows now

### user_id conventions

- `user_id = N`: every notification, including sysop ones.
- `createSysop()` inserts one row for each active user with the Sysop permission flag and pushes each over PresenceSocket, so each sysop's read state is their own. It returns the first inserted id. The original `user_id = NULL` broadcast was replaced for this reason.

## Notification Types

Every producer in the code as of 0.9.12a (grep `createSysop(` and `notifications.create(`). `createSysop` defaults to severity `warning` and icon `exclamation-triangle` when a producer passes none.

### Sysop (one row per sysop, via `createSysop`)

| Type | Severity | Title Example | Produced By |
|------|----------|---------------|-------------|
| `tic_error` | danger | Bad TIC file: FILENAME.TIC | `src/middleware/tossers/ticTosser.js` |
| `pm_undeliverable` | warning | Undeliverable PM to "Username" | `src/models/privateMessages.js` |
| `areafix_request` | info | AreaFix request from 1:123/456 | `src/models/areafix.js` |
| `filefix_request` | info | FileFix request from 1:123/456 | `src/models/filefix.js` |
| `user_registered` | info | New user registered: Username | `src/models/useraccounts.js` `createNewUser()` |
| `echolist_removal` / `filebone_removal` | warning | Echolist areas removed: NAME | echolist/filebone import in `src/routes/admin.js`, and `src/maintenance/echolistScan.js` |
| `echolist_batch_subscribe` / `filebone_batch_subscribe` | info, or warning when some failed | Batch subscribe finished: N area(s) created | `src/maintenance/echolistBatchSubscribe.js`, `fileboneBatchSubscribe.js` |
| `worker_health` | danger by default; warning for overdue schedules | Scheduled jobs are overdue | `src/queues/workerWatchdog.js` |
| `schedule_removed` | warning | (names the connection, network and host) | `src/queues/schedules.js`, when gateway startup prunes a poll/QWK/NNTP schedule nothing in the database asks for (0.9.12a) |
| `update_available` | from the check result | (update check verdict) | `src/maintenance/updateCheck.js` |
| `qwk_id_problem` | warning | (lists QWK IDs that break the rules) | `src/maintenance/qwkIdAudit.js`, at startup (0.9.12a) |
| `qwk_file_received` | info | Received FILE from ID via QWK | `src/models/qwkFiles.js` (0.9.12a) |

### User (`create(userId, ...)`)

| Type | Severity | Title Example | Produced By |
|------|----------|---------------|-------------|
| `pm_received` | info | New PM from Username | `src/models/privateMessages.js` (terminal only; hidden on the web, see Bell) |
| `maintenance` | warning | (board closing for maintenance) | `src/maintenance/webDrain.js`, one per connected web user when maintenance mode is entered |

### Proposed in the original design, not produced

`tic_received`, `freq_served`, `freq_failed`, `user_verified`, `mailer_error`, `mailer_auth_fail`, `nodelist_imported`, `nodelist_error`, `toss_error`, `packet_rejected` (sysop); `thread_reply`, `file_new`, `announcement`, `security_change`, `verification` (user). Nothing in the code creates these.

## Model: src/models/notifications.js

```javascript
// Exports as implemented
async function ensureTable()
function setPresenceServer(server)                      // gateway hands over the PresenceSocket
async function create(userId, type, title, body, opts)  // opts: { link, icon, severity }
async function createSysop(type, title, body, opts)     // one row per active sysop
async function getUnread(userId, isSysop, limit)
async function getAll(userId, isSysop, limit, offset)
async function getUnreadCount(userId, isSysop)
async function markRead(id, userId)
async function markAllRead(userId)
async function getById(id)
async function purgeOld(days)                           // read rows older than N days
```

`create` and `createSysop` return null without writing when `notifications_enabled` is false. The query functions accept `isSysop` but filter on `user_id` alone, since sysop rows are per user. There is no separate sysop-unread query.

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

`createSysop()` does the same for each sysop row it inserts. On connect, PresenceSocket sends `notification_count` and then replays up to 10 recent unread notifications to populate the dropdown.

## UI: Nav Bar Bell Icon

Both user and admin layouts get a bell icon in the nav bar:

```
[Bell Icon] (3)     -- unread count badge
```

Click opens a dropdown showing the 10 most recent unread notifications:
- OPENING THE DROPDOWN MARKS EVERYTHING READ (`notification_read_all` on Bootstrap's `shown.bs.dropdown`) and clears the badge. There is no Mark All Read button in the dropdown any more; `/notifications` keeps one
- Unread items stay highlighted while the dropdown is open and lose it when it closes, so what was new can still be told apart
- A notification pushed while the dropdown is open is marked read at once
- Click a notification with a link: navigate
- "View All" link to a full notifications page

**Hidden on the web: `pm_received`** (`WEB_HIDDEN_TYPES` in the model). Mail has its own unread counter and envelope in the nav bar, so a bell entry per PM said the same thing twice. The notification is still created, because the terminal notification reader shows it. The model's reads take an optional `{ web: true }` that leaves hidden types out, used by the presence socket (count, replay, mark all read), `/notifications` and its Mark All Read; `create()` does not push a hidden type. Mark all read from the web must leave them alone, or the terminal would lose a notification the web never showed.

### Notification dropdown item format

```
[icon] Title                              2m ago
Body text preview...
```

Colour-coded by severity: info (blue), success (green), warning (yellow), danger (red).

## Web Page: /notifications

Full notification history, 50 per page (`?page=N`, hardcoded), route in `src/routes/index.js`, view `src/views/notifications/index.pug`. Implemented: per-row Mark read (`POST /notifications/read/:id`) and Mark all read (`POST /notifications/read-all`). Not implemented: type/severity filters and a mark-unread toggle.

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
| `notifications_enabled` | boolean | `true` | Enable/disable notification system (category system) |
| `notifications_retention_days` | number | `30` | Days to keep read notifications before purge, `0` never purges (category maintenance) |

The designed `notifications_max_per_page` was not added; the page size is fixed at 50.

## Maintenance

Daily `purge-notifications` maintenance job (schedule `purge-notifications-daily`, 02:30), declared in `RETENTION_JOBS` in `src/maintenance/retention.js` and run by `src/maintenance/maintenanceJobs.js`. It reads `notifications_retention_days` when it runs, and `registerSchedules` removes its schedule when the setting is 0:
- Delete read notifications whose `read_at` is older than `notifications_retention_days`
- Keep unread notifications indefinitely (until explicitly read or manually purged)

## Terminal: Notification Reader

Menu command `notifications` (`BaseSubModule` in `handlers/menucommands/notificationReader.js`). Implemented as a menu command only; the controls and call flow stage below were the design, and what was built differs as noted.

### Display

Lightbar list of recent notifications (newest first), similar to the PM reader pattern:
- Unread items highlighted (bright colour)
- Read items dimmed
- Columns: severity indicator, title, age (e.g. "2h ago", "3d ago")
- Sysop sees both personal and sysop broadcast notifications

### Controls

As built:

- **Up/Down**: navigate list
- **Enter**: view notification detail (title and body) and mark it read; any key then leaves the reader
- **R**: mark ALL as read
- **ESC/Q**: exit

Designed but not built: mark one read with R, A for mark all, D to delete.

### Call flow integration

Not built: there is no notification call flow stage in `src/managers/callmanager.js` or `src/models/callFlows.js`. Designed as an optional call flow stage: if the user has unread notifications, show a summary before or after the PM check stage. "You have N unread notification(s). View now? [Y/n]"

This mirrors the terminal `check_email` pattern -- a brief prompt that can be added to the call flow or used as a standalone menu command.

### Sysop terminal priority

Not built (no `pendingNotification` in the code). Designed: for sysop notifications with severity `danger`, the terminal could display an immediate alert when the sysop returns to a menu -- similar to how `pendingChat` fires when returning to menu. A `pendingNotification` flag on the call object would trigger a brief "!! ALERT: Bad TIC file: filename.tic -- press any key !!" before the menu redraws.

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

2. **user_id NULL for sysop broadcasts** (superseded): the original idea avoided a row per sysop, but one row's read state would have been shared by every sysop. The implementation writes one row per sysop and queries on `user_id` alone.

3. **PresenceSocket for delivery**: already connected on every page, already handles session auth and multi-tab routing. No new WebSocket endpoint needed.

4. **PostgreSQL not Redis for persistence**: notifications need to survive restarts and be queryable with pagination/filtering. Redis is for ephemeral state; notifications are durable records.

5. **Severity levels match Bootstrap**: info/success/warning/danger map directly to alert colours and icon variants. No translation layer needed.

6. **Producers are fire-and-forget**: `create()` is async but callers don't need to await it. A failed notification shouldn't break the operation that triggered it. Wrap in try/catch at the call site.
