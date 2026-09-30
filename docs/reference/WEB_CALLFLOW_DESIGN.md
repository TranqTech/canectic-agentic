# Web Call Flow Design

A guided login experience for web users, mirroring the terminal call flow. Walks users through what's new since their last visit rather than dropping them on a static home page.

**Status: implemented** (`src/routes/callflow.js`, mounted at `/callflow`; stages are web blocks in `src/webBlocks/`; views in `src/views/callflow/`; trigger rule in `src/utils/callflowTrigger.js`). The build adds a Welcome stage and a News stage to the sequence below, and `POST /callflow/complete` answers JSON rather than redirecting; details inline. Since #91 phase 2 the stages, their order and their settings come from the web flow, the `kind = 'web'` row of `call_flows`, edited at `/admin/callflows`; see "Stages are web blocks" and "The editable web flow" below. Sysop guide: `docs/sysop/CALLFLOWS.md`.

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

As built, `GET /callflow/stages.json` returns: `welcome` (always), `announcements`, `lastcallers`, `whosonline`, `wall`, `newsfiles` (active news/score files, skipped when none), `newmsgs`, `newfiles`. The design's list:

1. **New Announcements** -- announcements created since the user's last completed call flow (`users.last_callflow_at`), plus any pinned announcement regardless of age. If none, skip this stage silently.

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
| New Announcements | `announcements.getActiveAnnouncements(20)` | `created_at > users.last_callflow_at`, or `pinned` |
| Last Callers | `callers.getLastCallers()` | Same as `/lastcallers` route |
| Who's Online | `getOnlineUsers()` + nodeManager | Same as `/whosonline` route |
| Wall | `wall.getRecentMessages()` | Same as `/wall` route |
| New Messages | `userMsgPointers.getNewscanSummary()` | With `userAreaSubs` filtering, same as newscan |
| New Files | `fileEntries.countNewSince` from `session.prev_logon` | Files arrived since the previous visit, as everywhere else (`src/utils/newSince.js`) |

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
GET  /callflow/stage/:name  -- HTML partial for one web block (welcome, announcements,
                               lastcallers, whosonline, wall, newsfiles, newmsgs,
                               newfiles; rendered with layout: false). Unknown name 404,
                               a block that needs a user 401 for a visitor
POST /callflow/wall         -- post a wall message inline (AJAX), answers { status }
POST /callflow/complete     -- mark call flow complete, clear flags, answer { redirect: <url> }
```

`POST /callflow/complete` takes an optional `return_url` form field. Under Express 5 `req.body` is undefined when nothing is posted, so both POST routes read it as `(req.body && req.body.x)`; a missing body falls back to `/` rather than answering 500. A `return_url` starting with `/callflow` is replaced by `/`. `GET /callflow` also clears a sticky `callflow_pending` flag on the session, and does nothing but redirect to the return URL when `callflow_enabled` is off.

### Session flags

```javascript
session.callflow_pending = true    // Set by webActivity on idle resume
session.callflow_return_url = '/messages/area/general'  // Where the user was going
session.last_callflow_at = Date.now()  // Updated on call flow completion
```

`last_callflow_at` is also persisted to the user record (or a Redis key) so it survives session expiry. Used to determine "new since last visit" for announcements.

## Login redirect

In `src/routes/users.js`, the login POST handler, when `callflow_enabled` is on, stores the original destination as `callflow_return_url` in the Redis session (`sessionStore.sessionUpdate`) and redirects to `/callflow` (or returns `{ status: true, redirect: '/callflow' }` for an AJAX login). It also caches `last_callflow_at` and `_callflow_checked` on the new session.

## Idle resume detection

In `src/middleware/webActivity.js`, when a request arrives after more than `web_idle_threshold` minutes (default 120) of inactivity, a new call record is logged, `prev_logon` is written to the session (the baseline for "new files since the previous visit"), and, if `callflow_on_resume` is on and there was a previous activity timestamp, `callflow_pending: 'true'` is set:

```javascript
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

## Stages are web blocks (#91)

Each stage is a block in `src/webBlocks/`, one file per block, registered in `src/webBlocks/index.js`. The same definitions are meant to serve the landing page (#87), which shows several blocks at once where the call flow shows one at a time. A block declares:

| Field | Meaning |
|-------|---------|
| `name` | Stable identifier, the value stored in a flow. Never rename one |
| `label` | Shown to the user and the sysop |
| `view` | Pug partial rendered with `load()`'s result |
| `requiresUser` | True when it means nothing to a visitor (announcements, newmsgs, newfiles) |
| `options` | The settings a sysop may give it in a flow (`select` with `choices`, or `number` with `min`/`max`), each with a `default` |
| `hint` | One line for the admin page |
| `available(ctx, opts)` | Optional. `null` means nothing to show, skip the stage; an object is extra detail for the stage list (`count`, `areas`). Omitted means always shown |
| `load(ctx, opts)` | The view's locals |

`name`, `label`, `requiresUser`, `options` and `hint` live in `src/webBlocks/catalog.js`, which imports nothing, so the call flow model and the admin page can validate a web flow without loading every model a block reads; each implementation spreads its entry from there, and the registry refuses to load if the two disagree. `opts` is always complete: `resolveOptions` fills every declared setting with the flow's value or its default, and quietly takes the default for a stored value that is no longer valid, since it runs for every visitor.

`available()` and `load()` are separate because the stage list is computed for every stage up front and must stay cheap; rendering news files reads each file from disk. `buildStageList(ctx, flow)` walks the flow in order, builds `{name, label, ...detail}` (detail cannot overwrite `name` or `label`), and leaves out and logs (level 1) a block that throws, so one broken query costs one stage instead of the whole call flow. An unknown name in a flow is skipped and logged at level 2.

`createContext(req, user)` makes one context per request: `user`, `userId`, `nodeManager`, `lastCallflowAt()`, and `once(key, fn)`, which memoises the promise so blocks needing the same lookup (the newscan, the relevant announcements) share one query, including between `available()` and `load()` in the same request.

`DEFAULT_WEB_FLOW` is the order the call flow has always had: what the seeded web flow holds, and what runs when there is no web flow row at all. `tests/webBlocks.test.js` pins the order, labels, paths, and the failure isolation.

## The editable web flow (#91 phase 2)

`call_flows.kind` is `terminal` (default, every existing row) or `web`. There is one web flow: `seedDefaults` inserts it when no `kind = 'web'` row exists, found by kind rather than name because a board may already have a flow of its own called Web (`firstFreeFlowName`: `Web`, else `WebLogin`, `WebLogin2`...). New flows made on the admin page are always terminal. The web flow is always active; `updateFlow` ignores `active` for it, since `callflow_enabled` is the switch.

Stored stages are `{ stage }` or `{ stage, options }`. Saving goes through `normaliseWebStages` (strict: unknown or terminal stage, a stage twice, a setting out of range are refused with a reason; unknown option keys are dropped; only valid values are stored). The editor stores only settings that differ from the default, so a later change of default reaches every stage nobody touched.

The route reads the flow through `callFlows.getWebFlowStages()`, which queries the database every time rather than using the model's flow cache: that cache lives for the process and is cleared only by writes in the same process. With no web flow, or a read error (logged at level 1), it runs `DEFAULT_WEB_FLOW`. `/stage/:name` looks the block up in the flow for its settings (`findStage` + `optionsFor`) and uses the defaults for a block not in the flow.

Settings as built: Last Callers `show` (always | new) and `count` (1-50, 15); Who's Online `show` (always | others); The Wall `show` (always | new) and `count` (1-50, 15). Blocks added in phase 2 and not in the default flow: `bulletins` (`show` always | new: new or changed since the last visit, by `updated_at` else `created_at`; each bulletin is a Bootstrap accordion item so reading one stays in the flow, and the new ones are open; a first visit marks nothing new), `sysinfo` (`systemStats.getStats`), `newmail` (`count` 1-50, 5; `getUnreadCount` for the total, `getInbox({unreadOnly})` for the list), `verifymail` (shown while `users.mailverified` is not true, as the terminal `verify_mail` stage; days left from `unverified_retention_days`, same arithmetic as `/users/verify`).

The `page` block (#91 phase 4) shows one of the sysop's Web Pages (`src/models/webPages.js`) and is the one REPEATABLE block: its catalog entry has `repeatable: 'page'`, naming the setting that tells its stages apart. `normaliseWebStages` requires that setting (a page id; the `page` option type) and refuses the same page twice rather than the same block twice; `callFlows.updateFlow` also refuses a page id with no row (`missingPages`), since the catalog reads no database. Every stage in `stages.json` now carries `path`, where the page fetches it from: `/callflow/stage/<name>`, plus `?page=<id>` for a repeatable one; the client uses `stage.path` and falls back to the name. `/stage/page` serves only a page placed in the current flow (`findStage(flow, name, which)`), 404 otherwise, and its `load` re-checks `pageVisibleTo` so a directly fetched stage never sends a page the visitor may not read. `available()` returns `{ label: page.title }`: a block's detail may now relabel its stage, but never change `name` or `path`.

The home page (#87, #91 phase 5) is the second consumer of the blocks: `web_home_layouts` (PK `audience` `public` | `users`, `display` `tabs` | `stacked`, `blocks` JSONB) via `src/models/webHome.js` (`getLayout` reads per request, no cache; `saveLayout` checks with `normaliseWebStages` + `webPages.missingPages`; `resetLayout` deletes the row). No row means `DEFAULT_LAYOUTS`, the old home page: announcements (`show: 'all'`) as a tab, plus the wall for users. `GET /` renders the layout with `webBlocks.renderBlocks(ctx, items, render)`, `render` being `res.render(view, locals, cb)` so each partial gets `res.locals`; it leaves out a requiresUser block for a visitor, a block with nothing, and a block that throws in `available`, `load` or its view. Screenshots of the old and new home page (visitor, user, wall tab) were byte-identical. For the home page `announcements` gained `show` (`new` default = the call flow's rule, `all` = every current one; `markAnnouncements`, with New marked under `all` only when there is a last visit) and became `requiresUser: false`; a `login` block (visitors only) was added and is left out of the call flow's add list (`callflowBlocks`). The web stage list editor is now shared: `partials/admin/webStageEditor.pug` (`+webStageList(stages, saveUrl, allowed)`, `+webStageEditorAssets()`) and `public/js/webStageEditor.js`, used by the Web flow card on `/admin/callflows` and both layouts on `/admin/webhome`; its classes are `wstage-*` so the Call Flows page's own terminal-flow script never touches a web list. The Wall block's post box is wired on the home page as on the call flow page (POST `/callflow/wall`), and the bulletins accordion style moved to `public/css/styles.css`.

A stage link marked `data-cf-finish="/path"` (Go to Mail, a message, Verify Now) is handled on the call flow page by a delegated click listener: it sets the return URL and calls `complete()`, so the flow is recorded as done before the user is taken there, rather than abandoned and offered again. Only local paths (`/x`, not `//x` or `/\x`) are honoured. "New" is since `users.last_callflow_at`, excluding the user's own calls or posts, and asked directly (`callers.hasCallsSince`, `wall.hasMessagesSince`) rather than read off the recent list, which one user's repeated logins can fill. Someone who has never completed the flow sees everything.

The guards between the kinds, because CallManager hangs up on a stage it does not know: saves checked per kind, pools refuse a web flow (`poolFlowProblem`), `getFlowStages` returns null for a web flow, and CallManager's `loadFlowsFromDB` skips non-terminal rows so a pool naming the web flow falls back to Standard. Five names exist on both sides (`announcements`, `bulletins`, `login`, `sysinfo`, `wall`), each meaning the same thing on each side; that is safe since the guard is the kind, and `tests/webCallFlow.test.js` pins the overlap so a new one is a decision.

## Files to create/modify

| File | Changes |
|------|---------|
| `src/routes/callflow.js` | Router: main page, stages.json, `/stage/:name` from the block registry, wall post, complete |
| `src/webBlocks/` | The stage definitions (added by #91): `index.js` registry, `context.js`, one file per block |
| `src/views/callflow/index.pug` | Main page with stage container and JS driver |
| `src/views/callflow/welcome.pug` | Welcome stage partial (added in the build) |
| `src/views/callflow/announcements.pug` | Announcement stage partial |
| `src/views/callflow/newsfiles.pug` | News/score files stage partial (added in the build) |
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
