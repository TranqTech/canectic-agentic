# Web Call Flow Design

A guided login experience for web users, mirroring the terminal call flow. Walks users through what's new since their last visit rather than dropping them on a static home page.

## Entry Modes

### 1. Fresh login (always)

After successful web login, ALWAYS redirect to `/callflow` regardless of the original redirect target. The intended destination is stored as `callflow_return_url` on the session. After callflow completion, the user is redirected to their original destination (e.g. `/pm/inbox` if they clicked a PM link before logging in, or `/` for a direct login).

### 2. Time-based triggers

`last_callflow_at` is cached on the session (loaded from DB once, updated on all user sessions on completion via `sessionUpdateUser()`).

| Condition | Behaviour |
|-----------|-----------|
| < 2 hours since last callflow | Normal browsing, no intervention |
| 2-24 hours | Prominent banner ("Welcome back! There's new activity") with "See What's New" button + Dismiss. Home page (`/`) auto-redirects to callflow. |
| 24+ hours | Force redirect to `/callflow` on ALL pages (except login, callflow itself, static assets) |
| Never done callflow | Force redirect |

The original page the user was trying to reach is stored as `callflow_return_url` so they land there after completion.

### 3. Idle resume (session flag)

When `webActivity.js` detects a session resumption that triggered a new call record (idle threshold exceeded), it sets `callflow_pending = true` on the session. This also triggers the banner on next page load.

### Banner design

Prominent blue bar with stars icon, large "See What's New" button, and separate "Dismiss" button. Not a dismissable Bootstrap alert -- a styled section with clear call-to-action. Dismiss hides the bar and calls `/callflow/complete` to clear the pending state.

## Flow Sequence

The call flow is a single page (`/callflow`) that presents stages as cards in sequence. The user advances through them with a "Continue" button or Enter key. Each stage loads its data via AJAX so the page doesn't reload between stages.

### Stages (in order)

1. **New Announcements** -- announcements created since the user's last visit (tracked via `user.last_callflow_at` or the previous call record timestamp). If no new announcements, skip this stage silently.

2. **Last Callers** -- recent callers list (reuses `partials/lastCallers.pug` data). Always shown.

3. **Who's Online** -- current online users (reuses `partials/whosOnline.pug` data). Always shown.

4. **The Wall** -- recent wall messages with a post input field. User can post a message inline or skip. Always shown.

5. **New Message Summary** -- "You have new messages in X area(s). View summary?" If the user says yes, show the newscan summary (area names + unread counts). If no new messages, skip silently. Does not enter the reader -- just shows the counts.

6. **New File Summary** -- "You have new files in X area(s). View summary?" Same pattern. Skip silently if no new files.

7. **Done** -- redirect to the home page (`/`), or to the URL the user was originally trying to reach (stored in `session.callflow_return_url`).

### Stage behaviour

- Each stage is a card that slides/fades in when the previous one completes
- "Continue" button (or Enter key) advances to the next stage
- "Skip" link below the button jumps to the end (goes straight to destination)
- Stages with no data (no new announcements, no new messages) are skipped automatically
- The wall stage pauses for interaction (post input) but has a Continue button to proceed without posting

## Data Sources

All data is already available from existing models:

| Stage | Data source | Query |
|-------|------------|-------|
| New Announcements | `announcements.getActiveAnnouncements()` | Filter by `created_at > user.last_callflow_at` |
| Last Callers | `callers.getLastCallers()` | Same as `/lastcallers` route |
| Who's Online | `getOnlineUsers()` + nodeManager | Same as `/whosonline` route |
| Wall | `wall.getRecentMessages()` | Same as `/wall` route |
| New Messages | `userMsgPointers.getNewscanSummary()` | With `userAreaSubs` filtering, same as newscan |
| New Files | `userFilePointers` scan | Same as file newscan |

## Implementation Approach

### Single-page with AJAX stages

The `/callflow` route renders a page with the full layout (nav, footer) and a central stage container. JavaScript drives the sequence:

1. On page load, fetch `/callflow/stages.json` -- returns the list of stages that have data (pre-computed server-side so empty stages are already excluded)
2. For each stage, fetch `/callflow/stage/:name` -- returns the HTML partial for that stage
3. Insert the partial into the stage container, wire up the Continue button
4. On Continue, fade out current stage, fetch and show next one
5. On last stage Continue, redirect to return URL

This keeps the server logic simple (one JSON endpoint + partials per stage) and the client interaction smooth (no full page reloads).

### Route structure

```
GET  /callflow              -- main page (layout + stage container + JS driver)
GET  /callflow/stages.json  -- list of active stages for this user (pre-filtered)
GET  /callflow/stage/:name  -- HTML partial for a specific stage
POST /callflow/wall         -- post a wall message inline (AJAX)
POST /callflow/complete     -- mark call flow complete, clear flags, redirect
```

### Session flags

```javascript
session.callflow_pending = true    // Set by webActivity on idle resume
session.callflow_return_url = '/messages/area/general'  // Where the user was going
session.last_callflow_at = Date.now()  // Updated on call flow completion
```

`last_callflow_at` is also persisted to the user record (or a Redis key) so it survives session expiry. Used to determine "new since last visit" for announcements.

## Login redirect

In `src/routes/users.js`, the login POST handler currently redirects to `/` on success. Change to redirect to `/callflow` instead:

```javascript
// After successful login:
req.session.callflow_return_url = req.body.return_url || '/';
res.redirect('/callflow');
```

## Idle resume detection

In `src/middleware/webActivity.js`, when a new call record is logged (idle threshold exceeded):

```javascript
// In _trackActivity(), after logging the new call:
session.callflow_pending = true;
await sessionStore.sessionUpdate(sessionid, { callflow_pending: 'true' });
```

In the layout template (both `user.pug` and `admin.pug`), check for the flag:

```javascript
// Server-side: pass callflow_pending to the template
// Client-side: show the "Welcome back" toast with Yes/No
```

The flag is cleared when the user either completes the call flow or dismisses the prompt.

## Skip and keyboard navigation

- **Enter** or **Space** on the Continue button advances
- **S** key skips to the end (same as terminal behaviour)
- **Escape** skips to the end
- The call flow container is focusable so keyboard events work without clicking

## "New since last visit" tracking

The `last_callflow_at` timestamp determines what's "new." Options:

1. **User record column** (`users.last_callflow_at`) -- survives everything, queryable
2. **Redis key** (`callflow:last:{userId}`) -- fast, but lost on Redis flush
3. **Session field** -- lost on session expiry

Recommendation: user record column. It's a single timestamp, updated once per call flow completion. Announcements, wall messages, etc. are filtered by `created_at > last_callflow_at`.

## UI Design

The call flow page uses the standard user layout (nav bar, footer). The stage container is centered, max-width ~700px, with a clean card-based design:

```
+--------------------------------------------------+
|  [Stage Title]                                   |
+--------------------------------------------------+
|                                                  |
|  [Stage content: callers table, wall messages,   |
|   announcement text, newscan summary, etc.]      |
|                                                  |
+--------------------------------------------------+
|  [Continue]                          [Skip All]  |
+--------------------------------------------------+
```

Progress indicator (dots or step counter) shows position in the sequence.

## Files to create/modify

| File | Changes |
|------|---------|
| `src/routes/callflow.js` | New router: main page, stages.json, stage partials, wall post, complete |
| `src/views/callflow/index.pug` | Main page with stage container and JS driver |
| `src/views/callflow/announcements.pug` | Announcement stage partial |
| `src/views/callflow/lastcallers.pug` | Last callers stage partial (wraps existing partial) |
| `src/views/callflow/whosonline.pug` | Who's online stage partial (wraps existing partial) |
| `src/views/callflow/wall.pug` | Wall stage partial with inline post form |
| `src/views/callflow/newmsgs.pug` | New message summary stage partial |
| `src/views/callflow/newfiles.pug` | New file summary stage partial |
| `src/routes/users.js` | Redirect login to `/callflow` instead of `/` |
| `src/middleware/webActivity.js` | Set `callflow_pending` on idle resume |
| `src/views/layouts/user.pug` | Detect `callflow_pending`, show return prompt |
| `src/servers/webserver.js` | Mount callflow router |
| `db/schema/` | Add `last_callflow_at` column to users table |

## The cached timestamp, and how it loops

`last_callflow_at` is cached on the session so the trigger check does not query the database on every request. The cache has no expiry of its own. It is corrected only when something explicitly writes to the session, which makes every write path a place the cache can go permanently wrong.

A session holding a stale timestamp forces the call flow on every request. Completing the flow is supposed to end that, and it does so by writing the new timestamp to the session. If that write misses, completing changes nothing and the user is sent straight back, for as long as the session lives.

Three separate things had to hold for it to be endless, and all three did:

1. **The username index dropped the session.** `sessionUpdateUser` can only reach sessions listed in `session_index:<username>`. That key was written once at login with an expiry of twice `session_ttl` and never refreshed, while the session hash was renewed on every page view. A Remember Me session outlives its own index entry by days. `sessionRenew` now re-adds the session to the index, so the index lives as long as the thing it points at.

2. **Completion did not write the session in front of it.** It broadcast to the index and fell back to the current session only when the broadcast had updated *nothing at all*. A user with any newer session got a non-zero count, so the fallback never fired and the older window was skipped. Completion now always writes the current session first, unconditionally, then broadcasts to the rest.

3. **Nothing re-read the authoritative value.** The lazy database lookup in the root router is gated on `_callflow_checked`, which is set once and never cleared, so a session that has been checked once never consults the database again. `GET /callflow` now reconciles the session cache against `users.last_callflow_at` on every load. It is one query on a page nobody loads in a hot path, and it guarantees the loop terminates even if the first two fixes are somehow bypassed.

The decision itself lives in `src/utils/callflowTrigger.js` so it can be tested. `isRedirectablePath` holds the exemptions, and the call flow's own pages are the important one: redirecting those would be an immediate loop rather than a slow one.

## Config keys

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `callflow_enabled` | boolean | `true` | Enable/disable web call flow on login |
| `callflow_on_resume` | boolean | `true` | Prompt call flow on idle session resume |
