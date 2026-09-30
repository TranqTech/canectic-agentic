# Canectic BBS — Web Architecture Reference

## Overview

The web application provides both a public-facing user interface (message browsing, posting, registration, login) and an administrative panel for managing the BBS. It shares the HTTP server with the WebSocket infrastructure that serves terminal connections, and shares models/middleware with the terminal side.

For the shared message platform (schemas, read tracking, access control, posting, body_html pipeline), see `message_architecture.md`.
For the terminal-side architecture, see `terminal_architecture.md`.
For the networking/tosser stack, see `NETWORKING_ARCHITECTURE.md`.
For the FTN mailer system, see `MAILER_ARCHITECTURE.md`.
For the private messaging system (unified PM model, transport adapters, webmail UI), see `PM_ARCHITECTURE.md`.
For the process model, job queues, and inter-process signaling, see `PROCESS_ARCHITECTURE.md`.

---

## Startup Sequence

Entry point: `bin/gateway.js` (renamed from `doorserver.js`; the stale copy left at `bin/doorserver.js` was deleted in #86). Orchestrates the gateway process startup:

1. **Pre-run maintenance** (`prerunMaint()`): `ensureConstraintsAndIndexes()` for `userMsgPointers`, `userAreaSubs`, `userFilePointers`, `userFileSubs`, then QWK conference numbers, several `ensureTable()` calls (news files, PM attachments, notifications, FREQ, seasonal art), and call flow/pool seeding plus loading. Runs after `appConfig.load()` and the theme, nodelist flag and template event seeds.
2. **Node manager** — Tracks active terminal nodes (allocated slots for connected users).
3. **Socat manager** — Manages socat bridge processes for legacy connections.
4. **Call pools**: `CallManager` creates the pools read from the `call_pools` table (`PrimaryBBS`, `Doorserver`, `WebDoor` by default; hardcoded fallbacks if the table is empty), each with its call flow. Call pools handle the terminal-side call lifecycle.
5. **HTTP server**: `http.createServer(webserver)` wraps the Express app. Listens on `process.env.webport` (default 8080). **Single HTTP server** shared by Express routes and all WebSocket pools. The QWK hub FTP server starts next when `qwk_ftp_enabled` is on.
6. **WebSocket pools**: `WsManager` created with the HTTP server. One pool per path in each call pool's `ws_paths`, linked to that call pool. Then `/ws/presence`, `/ws/adminlogs` and `/ws/nodespy` handlers are registered. Upgrade requests are path-routed. Then the unified terminal server (and legacy TCP/Telnet servers if their ports are set).
7. **Process mode startup** — If `PROCESS_MODE=embedded`, starts the mailer (`MailerManager`) and BullMQ workers in-process. If `PROCESS_MODE=separate` (default), the mailer and worker run as independent processes (`bin/mailer.js`, `bin/worker.js`). See `PROCESS_ARCHITECTURE.md`.
8. **Event subscriber**: listens for cross-process notifications (new messages imported, PMs delivered, cache invalidations) for real-time UI updates.
9. **Maintenance watch**: `startMaintenanceWatch()` follows the `.maintenance` flag file and attaches the terminal, web and (embedded) queue drains (see Maintenance Mode below).
10. **Job schedules**: registers BullMQ repeatable jobs for poll cycles, toss schedules, and maintenance tasks.
11. **QWK ID audit and worker watchdog**: `auditQwkIdsAndNotify()`, then `startWorkerWatchdog()` (skipped in embedded mode).

Shutdown handlers on `SIGINT`/`SIGTERM` drain embedded workers (if any), close BullMQ connections, clean up socat processes, close the Postgres pool, and shut down Redis.

Global `uncaughtException` and `unhandledRejection` handlers log to alogger but don't crash the process.

---

## Express Application (`src/servers/webserver.js`)

Express 5 (`express` ^5.2.1) with the Pug view engine. Under Express 5 `req.body` is `undefined`, not `{}`, when a request has no body, so handlers read fields as `(req.body && req.body.x)`.

### Middleware Stack (in order)

0. `trust proxy` — Configured via `trust_proxy` config key for reverse proxy support (nginx, Caddy, HAProxy). Ensures `req.ip` returns the real client IP from `X-Forwarded-For` headers.
1. `express.json()` — JSON body parsing
2. `express.urlencoded({ extended: false })` — URL-encoded form bodies
3. `cookieParser()` — Parses cookies (session ID lives here)
4. `express.static('public')`: serves static assets (CSS, JS, images) with dotfiles allowed; `/webart` serves `<textdir>/webart`
5. CSRF check: every non-GET/HEAD/OPTIONS request must carry an `Origin` (or, failing that, `Referer`) whose host matches `Host`, else 403 JSON. `/health` and `/api/*` are exempt (bearer-token auth)
6. View helpers: `res.locals.formatTimestamp` / `timestampMs` (see Dates in tables)
7. `maintenanceMiddleware()` (`src/middleware/maintenanceWeb.js`): maintenance mode on the web, see Maintenance Mode below. Placed after static files so the maintenance page keeps its CSS, and before activity tracking so a refused request is not logged as a call
8. `activityMiddleware`: session renewal, web engagement tracking, idle detection (fires before all route handlers)

### Route Mounting

| Mount Point | Router | Purpose |
|---|---|---|
| `/api/v1` | `apiV1Router` (`src/routes/api.js`) | REST API v1, bearer-token auth, JSON 404 fallback. QWK user routes (`src/routes/api/qwk.js`: `POST /qwk/download`, `POST /qwk/upload`) and the QWK HTTP hub (`src/routes/api/qnet.js`: `GET /qnet/hello`, `GET /qnet/packet`, `POST /qnet/packet/:id/ack`, `POST /qnet/rep`, HTTP Basic auth as a QWK node, failures to `security.log`). Mounted before `/`. See `API_DESIGN.md` and `QWK_ARCHITECTURE.md` |
| `/` | `indexRouter` (`src/routes/index.js`) | Public landing page, message browsing/posting, and also `/doors`, `/lastcallers`, `/whosonline`, `/bulletins`, `/stats`, `/wall`, `/qwk` (+ `/qwk/settings`, `/qwk/download`, `/qwk/upload`), `/notifications` |
| `/admin` | `adminRouter` (`src/routes/admin.js`) | Admin panel — all admin routes are prepended with `/admin` |
| `/users` | `usersRouter` (`src/routes/users.js`) | Authentication (login/logout/register) |
| `/pm` | `pmRouter` (`src/routes/pm.js`) | Private messaging — webmail UI, compose/reply with multer file attachments, attachment download (`/pm/attachment/:id` with ownership check), AJAX reader, admin undeliverable queue. See `PM_ARCHITECTURE.md`. |
| `/files` | `filesRouter` (`src/routes/files.js`) | File browsing -- group/area/file listing, file detail, download, JSON pagination |
| `/adminlogs` | `adminLogRouter` (`src/routes/adminLogs.js`) | Admin log viewer (plus the `/ws/adminlogs` socket) |
| `/callflow` | `callflowRouter` (`src/routes/callflow.js`) | Web login call flow -- AJAX stage sequence, wall post, completion. Stages are web blocks from `src/webBlocks/` (see `WEB_CALLFLOW_DESIGN.md`) |

There is no separate doors or notifications router: `/doors*` and `/notifications*` are routes in `index.js`. `GET /health` (DB and Redis ping, 503 when degraded) is defined directly in `webserver.js`, after the routers.

### Dates in tables

Every DataTables view renders a date through one mixin, `+ts(value[, 'date'])` in `views/partials/mixins/timestamp.pug`, included by the admin and user layouts, inside a cell that carries `data-order=timestampMs(value) || 0` (#56). The text is `yyyy-MM-dd HH:mm:ss` (or `yyyy-MM-dd`), zero padded and 24-hour, from `dateFormat.formatTimestamp`, in the server's timezone; `public/js/localTime.js` rewrites each `<time data-ts>` in the viewer's timezone in the same format and again on every table draw, and names the zone in the tooltip. Sorting uses the epoch in `data-order` and never the text. They used `toLocaleString()` ("9/22/2026, 5:57:03 PM") or month-name formats, and every date column sorted as text. `formatTimestamp` and `timestampMs` are set in `res.locals` app-wide by a middleware in `webserver.js`. `tests/tableTimestamps.test.js` fails a DataTables view that formats a date itself or has a date cell without `data-order`. User-facing views that show a date for reading rather than sorting use `dateFormat.formatFriendly` (#59) through the `+when(value[, 'date'])` mixin in the same file, or `res.locals.formatFriendly`: SERVER time and timezone, deliberately not rewritten in the browser because a board runs by the system's clock. Today is a bare `17:30`, then `Yesterday 17:30`, `3 days ago` for 2-6 days (no time), `Sep 25` within six months, `Dec 25, 2025` beyond; date-only gives `Today`/`Yesterday`; the tooltip is the full `formatTimestamp`. Days are calendar days on the server clock. The maintenance page, banner and presence push carry server-formatted `deadlineText`/`expectedBackText`. `tests/friendlyDates.test.js` fails a non-admin view that formats a date with `toLocale*`. Admin views are out of scope. List columns that want a short date use `formatListDate` (`MMM dd` while recent, `MMM yyyy` once older than six months), exposed as `res.locals.formatListDate` / `formatListDateFull`.

### Error Handling

404s are caught by a fallback middleware and forwarded to the error handler (`src/middleware/errorHandler.js`). The error handler renders `views/error.pug` and only exposes stack traces on the page in development mode (`NODE_ENV=development`). It logs every 5xx at level 1 with the method, the path (query string removed) and the stack, in every mode, and deliberately does not log 4xx, since scanner 404s would bury real errors. It used to log nothing, so an exception in an admin route showed an error page and left the logs clean.

---

## Session Management (`src/middleware/db/sessionstore.js`)

### Storage

Sessions are stored in Redis as hash maps. Each session is keyed by `session:{sessionId}` where `sessionId` is a v4 UUID generated at login time. TTL comes from the `session_ttl` config key, in MINUTES (default 720 = 12 hours), converted to seconds by `sessionStore()`.

### Session Data

The session hash contains flat string fields from the user record (Redis hashes store strings only). On retrieval, `sessionGet()` parses typed fields back to native types: `permissionflags` and `restrictionflags` are JSON-parsed to arrays, `isSysop` to boolean, `security` to integer. The user model's `buildSessionData(userobj)` prepares the flat representation at login time.

### Session-User Index

A reverse lookup maps `session_index:{username}` → Set of session IDs. This enables `sessionUpdateUser(username, fields)` to update specific fields across all active sessions for a user (e.g., when an admin changes a user's security level or flags — the change takes effect on all their active sessions without requiring re-login).

### Session Lifecycle

| Operation | Function | Notes |
|---|---|---|
| Create | `sessionStore(id, data, ttl)` | Sets hash + TTL, indexes by username |
| Read | `sessionGet(id)` | Returns parsed session object or null |
| Renew | `sessionRenew(id, ttl)` | Resets TTL (using the session's stored `_session_ttl`) and re-adds the session to the username index, so the index lives as long as the session. Called centrally by the activity middleware on every authenticated request |
| Destroy | `sessionDestroy(id)` | Removes from Redis + username index |
| Exists | `sessionExists(id)` | Boolean check |
| List | `sessionList()` | Returns all session keys (admin use) |
| Update one | `sessionUpdate(id, fields)` | Writes fields on one session |
| Bulk update | `sessionUpdateUser(username, fields)` | Updates fields on all sessions for a username |
| Kill all | `destroyAllForUser(username, exceptId)` | Destroys all sessions for a user except the current one (Log Out All Other Sessions) |

### Session TTL

Default session TTL is 12 hours (`session_ttl` config key, in minutes, default 720). The TTL is stored per-session in the Redis hash so that `sessionRenew()` uses the correct value for each session rather than a global default. Remember Me sessions use a longer TTL based on `remember_me_days` (default 14 days).

### Cookie

Session ID is stored in a `sessionid` HTTP-only cookie. Max age matches the session TTL (12 hours default, or Remember Me duration). Domain set from the `sitetld` config key, which is empty by default; empty means no `Domain` attribute is sent, so the cookie is host-only and always matches the FQDN the request arrived on. Setting `sitetld` to a domain the browsed FQDN is not at or under makes the browser discard the cookie silently, which presents as a login that redirects straight back to the login form with no error. SameSite `lax`.

`setSessionCookie()` and the logout path both call `clearSessionCookieAllVariants()`, which emits a `clearCookie` for the host-only and the domain-scoped variant, so changing `sitetld` cannot strand a companion cookie from the previous setting.

### Remember Me

The login form includes a "Remember Me" checkbox. When checked, the session is created with a TTL of `remember_me_days` (default 14) converted to seconds, and the cookie max age is extended to match. The per-session TTL storage ensures correct renewal regardless of the Remember Me setting.

### Log Out All Other Sessions

Available on the user profile page. Requires password confirmation. Calls `destroyAllForUser(username, currentSessionId)` to remove all sessions except the current one from Redis. Admin users can also kill all sessions for any user via the admin user management panel.

---

## Authentication (`src/routes/users.js`)

### Routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/users/login` | Login page (redirects to `/` if already authenticated) |
| POST | `/users/login` | Authenticate — accepts both form and AJAX (JSON). Form redirects; AJAX returns `{ status, redirect }`. |
| GET | `/users/logout` | Destroys session, clears cookie, redirects to login |
| GET | `/users/register` | Multi-step registration wizard (passes `minage`, `pwmin`, `boardname`, `faviconlink`) |
| POST | `/users/register` | Create account via `userAccounts.createNewUser()` with server-side validation (age, username availability, password length/match, required fields, birthdate age check) |

### Login Flow

1. `userAccounts.checkUserPass(username, password)` validates credentials (salt+pepper hashing)
2. On success: `buildSessionData(userobj)` prepares session fields, `sessionStore()` saves to Redis, `setSessionCookie()` sets the HTTP-only cookie
3. Post-login redirect: `req.body.redirect` with `safeRedirect()` validation (rejects absolute URLs and protocol-relative paths to prevent open redirect)
4. When `callflow_enabled` is on, that destination is saved as `callflow_return_url` on the session and the login goes to `/callflow` instead (see `WEB_CALLFLOW_DESIGN.md`). `buildSessionData` also records `prev_logon` (the previous visit's start, read before `updateUserCalls` overwrites `users.lastlogon`) for "new files since the previous visit"
5. While maintenance mode is on, a login by anyone but a sysop is refused

### Registration Flow

The registration page (`src/views/users/register.pug`) is a 6-step client-side wizard:

1. **Age Verification** — Yes/No buttons; "No" disables proceeding and shows rejection message
2. **Account Details** — Username (min 3 chars), Password (min `pwmin` chars), Password Confirmation
3. **Personal Info** — First Name, Last Name, Gender (Male/Female/Other/Undisclosed)
4. **Contact & Location** — Location, Email/Netmail Address
5. **Birthdate** — Date input (YYYY-MM-DD)
6. **Review & Submit** — Summary table of all entered data, single POST submit

Client-side: step navigation via JS (no server round-trips), per-step validation, progress bar. All data submitted as a single POST to `/users/register` on the final step. A hidden `age_verified` field tracks the age gate response.

Server-side POST validation: age verification, username (required, min 3 chars, availability via `checkUsernameAvailable`), password (required, min `pwmin`, confirmation match), first/last name required, birthdate (required, valid date, minimum age check). On validation failure, form data is passed back as `form` local for field repopulation.

The `gender` column (`VARCHAR(16)`) was added to the `users` table schema. Values: `Male`, `Female`, `Other`, `Undisclosed`, or `null`.

### Registration Wizard

The registration page (`src/views/users/register.pug`) is a 6-step client-side wizard with AJAX validation:

1. **Age Verification** -- Yes/No buttons; "No" disables proceeding
2. **Account Details** -- Username (min 3 chars, AJAX availability check via `/users/check-username`), Password (min `pwmin` chars), Confirmation
3. **Personal Info** -- First Name, Last Name, Gender (Male/Female/Other/Undisclosed)
4. **Contact & Location** -- Location, Email/Netmail Address (AJAX check via `/users/check-email`)
5. **Birthdate** -- Date input with minimum age validation
6. **Review & Submit** -- Summary table, single POST to `/users/register`

### User Profile (`/users/profile`)

Authenticated users can view and edit their profile. Features:

- **Username change** with cooldown enforcement (`username_change_cooldown` config setting). Displays days remaining if cooldown is active.
- **Name fields** -- First name, last name editing
- **Location** -- Editable text field
- **Gender** -- Select dropdown (Male/Female/Other/Undisclosed)
- **Inline password change** -- Current password, new password, confirmation fields. Validates current password server-side before allowing change.

### Mail Verification

Routes for email address verification:

| Method | Path | Purpose |
|---|---|---|
| GET | `/users/verify` | Verification status page, shows current email and verification state |
| POST | `/users/verify/send` | Sends verification code to user's email address |
| GET | `/users/verify/check` | Form for entering verification code |
| POST | `/users/verify/check` | Validates verification code, upgrades security level on success |
| POST | `/users/verify/change` | Change email address (resets verification status) |

The `mailVerification` model manages verification tokens with expiry. On successful verification, users may receive a security level upgrade based on the `verified_security` config setting. The `Unverified` restriction flag is removed on verification.

### Password Reset (Unauthenticated)

Routes for forgotten password recovery:

| Method | Path | Purpose |
|---|---|---|
| GET | `/users/forgot` | Password reset request form (email input) |
| POST | `/users/forgot` | Generates reset token, sends email with reset link |
| GET | `/users/reset/:token` | Password reset form (validates token) |
| POST | `/users/reset/:token` | Sets new password, invalidates token |

The `passwordReset` model manages time-limited tokens. Tokens are single-use and expire after a configurable period.

### AJAX Validation Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/users/check-username` | Returns `{ available: boolean }` for username availability |
| GET | `/users/check-email` | Returns `{ available: boolean }` for email uniqueness |

Used by the registration wizard for real-time field validation without full form submission.

### Door Listing and Web Launcher

| Method | Path | Purpose |
|---|---|---|
| GET | `/doors` | Lists available door games with descriptions, filtered by user access level |
| GET | `/doors/collection/:slug` | Doors in one door collection |
| GET | `/doors/play/:slug` | Web door launcher page with embedded xterm.js terminal |

The web door launcher (`/doors/play/:slug`) provides browser-based door game access:

- Generates a one-time authentication token for the WebSocket connection
- Renders an xterm.js terminal instance that connects via WebSocket to the `WebDoor` call flow
- The `WebDoorAuthHandler` validates the token on the server side
- Supports full ANSI rendering through xterm.js with CP437 font support

### Shared Login Partial

User-facing views that require authentication use a guard chain pattern. When `!currentuser`, they render a login partial inline (with `loginMode = 'guard'` and `loginRedirect = currentPath`) instead of redirecting to `/users/login`. This keeps the user on the same URL after authenticating. The login partial supports both in-page form submission and AJAX login.

### AJAX Support

Both login and register accept `Accept: application/json` requests. Error responses return `{ status: false, errors: [...] }`. Success returns `{ status: true, redirect: '...' }`. The caller is responsible for performing the redirect client-side.

---

## Route Architecture

### Shared Middleware Pattern

Each router (`index.js`, `admin.js`, `users.js`, `pm.js`) uses a consistent pattern:

1. **Cookie parser** — `router.use(cookieParser())`
2. **Shared locals injection** -- A `router.use()` middleware that sets template variables available to all views in that router: `boardname`, `faviconlink`, `currentPath`, `activelink`, and (for index.js, users.js, files.js) `ismobile`
3. **Unread PM count** -- `index.js`, `admin.js`, and `pm.js` all fetch `pmUnreadCount` via `privateMessages.getUnreadCount(userId)` in their shared middleware, making it available to nav templates for the mail badge
4. **Flash messages** -- one-shot feedback after a redirect via `flash.setOne(req, type, text)` / `flash.get(req)` (`src/middleware/db/flash.js`, Redis, 30 s TTL). Used by `pm.js`, `index.js` (QWK page) and widely by `admin.js`: the network and peer detail pages, message group view, config, update, maintenance, nodelists, echolist and filebone pages load `res.locals.flash` and include `partials/flash`

### getCurrentUser Pattern

All four routers define a `getCurrentUser(req)` helper that reads the session cookie and returns the parsed session object from Redis (or null). This is called at the top of every route handler that needs user context.

### resolveUserId Pattern

In `index.js` and `pm.js`, `resolveUserId(sessionUser)` handles the string-to-integer conversion for `sessionUser.id` (Redis stores everything as strings). Falls back to a DB lookup by UUID or username for sessions created before the `id` field was added. All routes that need a numeric user ID (pointer operations, unread counts) use this.

---

## Admin Panel (`src/routes/admin.js`)

### Access Control

Two-layer admin check:

1. **Security level**: `parseInt(user.security) >= adminsecurity` (config key `adminsecurity`, default 200)
2. **Sysop flag** — `user.permissionflags` must include `"Sysop"`

`checkAdminAccess(user)` performs both checks. GET routes call it to set a `sufficientAccess` boolean that templates use for guard chains. POST routes (and newer GET pages such as Update, Maintenance, Mailer, Transfers and the logs) use `requireAdmin` middleware, which blocks the request with a 403: JSON `{ error, message }` when the request wants JSON, otherwise the `admin/unauthorized` page. Refusals are logged at level 3.

### Route Structure

| Category | Routes | Purpose |
|---|---|---|
| Dashboard | `GET /admin` | Admin landing page |
| Styles | `GET /admin/styles` | Terminal style editor |
| Message Groups | `GET/POST /admin/msgGroups`, `GET/POST /admin/msgGroup/:shortcode/*` | Group CRUD, area counts |
| Message Areas | `GET /admin/msgAreas`, `GET/POST /admin/msgArea/:shortcode/*` | Area CRUD (all areas view + per-group view) |
| Networks | Network management routes | FTN/QWK/NNTP network configuration, message area mappings, file area mappings |
| Peers | Peer connection management | Remote system configuration, message area subscriptions, file area subscriptions |
| File Network Areas | `POST /admin/network/:uuid/addfilearea`, `POST /admin/network/filearea/:id/{update,remove}` | Map file areas to networks (areatag), manage TIC file echo mappings. Uses `fileNetworkAreas` model. |
| File Peer Subscriptions | `POST /admin/connection/:uuid/setfile{allowed,enabled}` | Per-connection allowed/enabled file areas for TIC distribution. Uses `filePeerSubscriptions` model. |
| Retention preview | `GET /admin/msgArea/:shortcode/retention/preview` | JSON: what proposed `max_age_days`/`max_messages` would prune, deletes nothing. Group limits are edited on the group's Retention tab (`msgGroups/view.pug`) and pushed via Push Group Defaults |
| Events | `GET /admin/events`, `POST /admin/events/{poll,trigger,clean}`, `GET /admin/events/queues.json` | Queue status and manual triggers (toss inbound/outbound per protocol, polls). There is no `/admin/tosser` or `/admin/netmail` route |
| Users | `GET /admin/users`, `POST /admin/users/:uuid/{update,resetpassword,kill-sessions}`, `POST /admin/users/maintenance` | User list, edit, password reset, kill sessions |
| Menus | `GET /admin/menus`, `GET /admin/menus/:id`, `POST /admin/menus/*` | Menu CRUD — list, view with entries, create/update/delete. Entry CRUD and reorder within a menu. Duplicate (`POST /:id/duplicate`), export (`GET /:id/export.json`), import (`POST /menus/import` multipart). |
| Doors | `GET /admin/doors`, `POST /admin/doors/*` | Door game CRUD — list, create/update/delete. Variable reference panel with %X tokens. |
| Group Defaults | `GET /admin/msgGroup/:shortcode/defaults` | JSON endpoint — returns group security/flag defaults for new area modal auto-populate |
| File Groups | `GET /admin/fileGroups`, `GET/POST /admin/fileGroup/:shortcode/*` | File group CRUD, area counts, base_dir management |
| File Areas | `GET /admin/fileAreas`, `POST /admin/fileArea/:shortcode/*` | File area CRUD (all areas view + per-group view), sub_dir, newscan_default |
| File Area Detail | `GET /admin/fileArea/:shortcode` | File browser — area info, paginated file listing (DataTables), file info/edit/move/delete modals, directory scan |
| File Entry Ops | `POST /admin/fileEntry/:uuid/{update,delete,move}` | File entry update (desc, active, flagged), delete (optional disk removal), move to another area (optional disk move) |
| Directory Scan | `POST /admin/fileArea/:shortcode/scan` | Scans area directory for untracked files, creates file_entries rows for new files, updates area stats |
| File Group Defaults | `GET /admin/fileGroup/:shortcode/defaults` | JSON endpoint — returns file group security/flag defaults for new area modal auto-populate |
| Config | `GET /admin/config`, `POST /admin/config`, `POST /admin/config/reset/:key`, `POST /admin/config/reload` | System configuration management: view/edit all config settings organized by category, reset individual keys to defaults. Uses accordion layout with per-category save forms. Environment-overridden settings shown as read-only. |
| Nodelists | `GET /admin/nodelists` | FTN nodelist management — per-network import status, stats, upload/clear actions. Requires admin access. |
| Nodelist Import | `POST /admin/nodelists/import` | Multipart file upload (multer). Saves to temp dir, enqueues `import-nodelist` BullMQ job. Flash message confirms queuing. |
| Nodelist Clear | `POST /admin/nodelists/clear/:networkId` | Deletes all nodelist data for a network via `ftnNodelist.clearNetwork()`. Confirmation modal in UI. |
| Nodelist Browser | `GET /admin/nodelist/:networkId` | Browse imported nodelist for a specific FTN network. DataTables listing with row-click detail modal. |
| Nodelist Search | `GET /admin/nodelist/:networkId/search.json` | JSON endpoint for AJAX search/filter. Params: `q` (search term), `filter` (active/added/removed/all), `limit`. |
| Echolists | `GET /admin/echolist/:networkId` | List echolists for a network. Cards showing name, area counts, import date. Create/edit/delete modals. |
| Echolist Create | `POST /admin/echolist/:networkId/new` | Create new echolist with name, description, is_default flag. |
| Echolist View | `GET /admin/echolist/view/:echolistId` | Browse echolist areas with stats bar, DataTable listing, collapsible import section. |
| Echolist Import | `POST /admin/echolist/:echolistId/import` | Upload echolist file (BACKBONE.NA etc.), parse with `parseAreasBbs`, show diff preview. |
| Echolist Import Run | `POST /admin/echolist/:echolistId/import/run` | Execute previewed import diff. Creates sysop notification if locally-carried areas removed. |
| Echolist Update | `POST /admin/echolist/:echolistId/update` | Update echolist name, description, default flag. |
| Echolist Remove | `POST /admin/echolist/:echolistId/remove` | Delete echolist and all area entries. |
| Echolist Area Update | `POST /admin/echolist/area/:areaId/update` | Update individual echolist area entry (description, tags, active, local_area_id). |
| Echolist Area Remove | `POST /admin/echolist/area/:areaId/remove` | Delete individual echolist area entry. |
| Node Spy | `GET /admin/nodespy` | Dashboard: card grid of active terminal nodes + web presence users with auto-updating AJAX poll. |
| Node Spy Status | `GET /admin/nodespy/status.json` | JSON endpoint for dashboard AJAX polling (terminal nodes + web users with activity, duration). |
| Node Spy Watch | `GET /admin/nodespy/:nodenum` | Live snoop viewer: xterm.js terminal matched to target node dimensions, one-time Redis token auth for WebSocket. |
| Import areas.bbs | `GET /admin/import/areasbbs` | Upload areas.bbs file, select group + network, preview with per-area action/allow/enable controls. |
| Import areas.bbs Preview | `POST /admin/import/areasbbs/preview` | Parse uploaded file, diff against existing network mappings, return preview table with unmapped group areas for manual mapping. |
| Import areas.bbs Run | `POST /admin/import/areasbbs/run` | Execute import: create new areas or map existing ones, sync peer subscriptions with per-area allow/enable flags. |
| Export areas.bbs | `GET /admin/export/areasbbs/:networkId` | Download areas.bbs for a message network (areatag + description per line). Button on network detail page. |
| Export files.bbs | `GET /admin/export/filesbbs/:networkId` | Download files.bbs for a file network (file echo areatag + description per line). Button on network detail page. |
| Mailer Diagnostics | `GET /admin/mailer?hours=N` | Per-connection FTN mailer session history and outcomes (`mailerSessions`), window 1-720 h, default 24 |
| QWK and NNTP Transfers | `GET /admin/transfers?hours=N&protocol=QWK|NNTP&failed=1` | Transfer history per QWK/NNTP connection (`networkTransfers`), including the HTTP hub side |
| Inbound / Outbound File Log | `GET /admin/inbound-log`, `GET /admin/outbound-log` | Files received / acknowledged by peers |
| Netmail Relay Log | `GET /admin/relay-log?days=N&decision=...` | One row per relay decision (`netmailRelayLog`), days 1-365, default 7 |
| Update | `GET /admin/update`, `POST /admin/update/{check,channel,apply}`, `GET /admin/update/progress(.json)` | Update check results and history, channel switch, upgrade notes, apply, progress page. See Update and Maintenance Pages below |
| Maintenance | `GET /admin/maintenance`, `GET /admin/maintenance/status.json`, `POST /admin/maintenance/{enter,leave}` | Close and reopen the board, drain status per process |
| Wall | `GET /admin/wall`, `POST /admin/wall/delete/:uuid` | Wall message list and delete |
| API Tokens | `GET /admin/api-tokens`, `POST /admin/api-tokens/{new,:id/revoke,:id/delete}` | REST API bearer tokens |

### Modal-Driven Editing Pattern

Admin views use a consistent pattern for CRUD:

1. **Table** — Lists items with data attributes on each `<tr>` (all editable fields stored as `data-bs-*` attributes)
2. **Info modal** — Clicking a row opens a read-only info modal populated from the row's data attributes via JS
3. **Edit modal** — "Edit" button in the info modal populates a form modal from the same data attributes, sets the form action dynamically
4. **Delete modal** — "Delete" button opens a confirmation modal with the item name and optional destructive options (e.g., "delete tables and all data")
5. **JS wiring** — `DOMContentLoaded` handler initializes Bootstrap modals, wires click events, and handles inter-modal transitions (info -> edit, info -> delete)

For tables using DataTables (e.g., users, all-areas index), event delegation on `tbody` survives DataTables redraws.

### Menu Admin Views (`views/admin/menus/`)

Two views: `index.pug` (menu list with create modal) and `view.pug` (menu detail with entries table, edit/delete modals, entry add/edit modals). Follows the standard modal-driven editing pattern.

**Enhanced features:**
- **Tabbed modals** -- Edit modals use Bootstrap nav tabs to separate Configuration and Colours into distinct panels
- **Featured entry flag** -- Entries can be marked as featured, shown with a star indicator in the entries table
- **Menu identifier validation** -- Slug-safe identifiers enforced on creation, case-insensitive lookup for menu resolution
- **Dynamic command argument selects** -- Command-specific argument fields (door list, menu list) populated dynamically based on the selected command type
- **"Reset All to Theme" button** -- On the Colours tab, resets all menu-level colour overrides to null so the handler falls through to theme defaults

Menu-level color fields use `<select>` dropdowns with inline `style="color:<hex>"` on each option, rendered against a `.bg-dark` background. A `syncSelectColor()` JS function copies the selected option's color onto the `<select>` element itself on change and on page load (browsers don't natively show option inline styles on the closed select). A "Theme Default" option submits an empty value, which the model stores as `null`; `getMenu()` strips null color keys via `delete` so they arrive as `undefined` in `_applyConfig()` and the handler falls through to theme defaults.

Entry-level `fg_clr`/`bg_clr` always have a value (default 7/0) — they're passed directly to `setfgcolor()` which renders `null` as black (ANSI color 0, invisible on dark backgrounds).

The `ANSI_COLORS` array in `menus.js` maps each of the 16 ANSI color values to a label, hex color, and CSS class from `styles.css`. This array is used by all color select dropdowns and by the entry table's colored name/swatch display.

### Door Admin Views (`views/admin/doors/`)

Single view: `index.pug` with table, info/edit/delete modals. Add and edit modals use a two-column layout (1100px wide): left column has identity and executable fields, right column has dropfile and options. All field descriptions are Bootstrap tooltips on `<label>` elements (small info icon) rather than `.form-text` blocks.

A collapsible "Variable Reference" panel below the door table shows all `%X` substitution tokens organized by category (node/session, user, terminal, connection, door config, system directories, system info). Sourced from `configvars.getVariableList()`, which means adding a new variable to the engine automatically updates the admin reference.

### Theme Admin Views (`views/admin/themes/`)

Accessible from "Menus > Themes" in the admin nav.

**Theme List** (`index.pug`): Table of all themes with name, slug, description, default badge. Actions: edit, set as default, duplicate, delete (blocked for default theme). New Theme modal for creation. Colour reference strip showing all 16 ANSI colours.

**Theme Editor** (`view.pug`): Identity fields (name, slug, description) plus colour properties organized in a Bootstrap accordion by category (General, System, Menu, Lightbar, Input, Editor, Messages, Layout). Each colour property uses an ANSI colour select dropdown with `syncSelectColor()` live preview. First category auto-expands on load. Save button at top and bottom.

**Set as Default**: POST action that clears the previous default, sets the new one, and updates the `theme` config key via configStore so the change takes effect for new terminal sessions.

### Config Admin Views (`views/admin/config/`)

Single view: `index.pug` with Bootstrap accordion layout. Each category (system, network, display, security, performance, maintenance, logging, terminal, doors, paths, mailer, worker) gets its own collapsible accordion section containing a form. Settings display type-appropriate inputs: text for strings, number for numbers, switch/checkbox for booleans. Each setting shows a source badge (Default/gray, Database/blue, Environment/yellow) and optionally a "Requires restart" badge. Environment-overridden settings are disabled/read-only. Database-overridden settings show a "Reset" button that POSTs to `/admin/config/reset/:key` to restore the default value. A key with an `options` list in `configDefaults.js` renders as a select, and the save route refuses a value outside the list. A Reload button (`POST /admin/config/reload`) re-reads the `.env` file and the database without a restart; `.env` keys are read from the file on disk, and a banner shows where it disagrees with the inherited environment. Each category form has its own "Save" button that submits all settings for that category. The POST handler uses `configStore.setValues()` for batch upsert, which automatically publishes `CONFIG_CHANGED` for cross-process invalidation via Redis pub/sub.

Data flow: `CONFIG_DEFINITIONS` from `configDefaults.js` provides metadata (type, category, description, restart flag, default value). `appConfig.getAll()` provides current merged values. `appConfig.getSource(key)` provides the tier each value comes from. The route pre-builds a flat array of setting objects combining all three sources for the template.

### Flag Editor Pattern

Used for permission/restriction flags on users, groups, and areas:

1. **Badge display** — Active flags shown as colored badges (green for permissions, red for restrictions). Click to remove.
2. **Select + Add button** — Dropdown shows only flags not already active. "Add" button appends the selected flag.
3. **Hidden inputs** — Each active flag has a `<input type="hidden" name="fieldname" value="flag">`. Multiple inputs with the same name submit as an array.
4. **renderFlags() function** — Rebuilds badges, hidden inputs, and select options. Called on init, add, and remove. Shared pattern across all flag editors.
5. **Available flags**: built-ins are constants in `admin.js`, `BUILTIN_PERMISSIONS` ("Sysop", "Mod", "Adult", "Admin", "Email", "Netmail") and `BUILTIN_RESTRICTIONS` ("Underage", "Unverified", "Banned", "Email", "Netmail", "Private Messages"), extended by the `custom_permission_flags` / `custom_restriction_flags` config keys through `getAvailablePermissions()` / `getAvailableRestrictions()`. Passed to templates as `availablePermissions` / `availableRestrictions`.

### AJAX Group Defaults

The all-areas index (`/admin/msgAreas`) uses an AJAX endpoint to populate new-area modal fields when the group selector changes:

```
GET /admin/msgGroup/:shortcode/defaults
-> { read_security, post_security, read_perm_flags, read_rest_flags, post_perm_flags, post_rest_flags }
```

The group select `change` handler fetches this endpoint, populates security fields, and calls `renderAreaFlags()` for all four flag groups. If the selector is cleared, fields reset to defaults (50/50, empty flags).

The same pattern is used for file areas:

```
GET /admin/fileGroup/:shortcode/defaults
-> { read_security, post_security, read_perm_flags, read_rest_flags, post_perm_flags, post_rest_flags }
```

### File Group/Area Admin Views

The file group and area admin views (`src/views/admin/fileGroups/`, `src/views/admin/fileAreas/`) mirror the message group/area admin views exactly in structure:

| View | Template | Purpose |
|---|---|---|
| File Groups List | `admin/fileGroups/index.pug` | Group listing with clickable rows, "Add Group" modal with base_dir field |
| File Group Detail | `admin/fileGroups/view.pug` | Group info + areas table, edit/delete group modals, add/edit/delete area modals |
| All File Areas | `admin/fileAreas/index.pug` | DataTables listing across all groups, group selector in new area modal, AJAX defaults |

Key differences from message area views:
- **Three-tier access model**: File areas have Browse Security (controls visibility in listings), Download Security (controls file download), and Upload Security (controls file upload). Each tier has a security level number plus permission and restriction flag arrays. Browse security fields are `browse_security`, `browse_perm_flags`, `browse_rest_flags`; download/upload use the existing `read_security`/`post_security` naming internally.
- **Labels**: "Browse Security" / "Download Security" / "Upload Security" instead of "Read Security" / "Post Security" (underlying field names for download/upload remain `read_security`/`post_security` for consistency)
- **File-specific fields**: `base_dir` (group), `sub_dir` (area), `newscan_default` (area)
- **File stats columns**: File Count, Total Size (formatted as B/KB/MB/GB), Last Upload date
- **Delete options**: "Delete files from disk" instead of "Delete tables and all data"
- **File networking (TIC)**: File areas can be mapped to networks via file echo areatags (managed on the Network detail view). Per-peer file area subscriptions (allowed/enabled) managed on the Peer detail view.

Models imported: `src/models/fileGroups.js`, `src/models/fileAreas.js`, `src/models/fileEntries.js`, `src/models/fileNetworkAreas.js`, `src/models/filePeerSubscriptions.js`.

### File Area Detail / Browser View

The file area detail view (`admin/fileAreas/view.pug`) provides a drill-down into individual file areas:

| View | Template | Purpose |
|---|---|---|
| File Area Detail | `admin/fileAreas/view.pug` | Area info card + file listing (DataTables) with info/edit/move/delete modals |

**Top section**: Area info card showing name, shortcode, description, sub_dir, resolved filesystem path, file count, total size, and link back to parent group.

**Main section**: DataTables file listing with columns: Filename, Size (human-readable), Date, Short Description, Downloads, Source, Status (active/flagged badges). Row click opens info modal.

**Modals**:
- **File Info Modal** — Read-only display of all file metadata (filename, disk_path, sizes, hashes, dates, uploader, source info, descriptions). Buttons: Edit, Move, Delete.
- **Edit File Modal** — Form to update short_desc, long_desc, active (checkbox), flagged (checkbox). POST to `/admin/fileEntry/:uuid/update`.
- **Move File Modal** — Select dropdown of all file areas (grouped by file group), checkbox for "Also move file on disk". POST to `/admin/fileEntry/:uuid/move`.
- **Delete File Modal** — Confirmation with checkbox for "Also delete file from disk" (unchecked by default for safety). POST to `/admin/fileEntry/:uuid/delete`.

**Quick Actions sidebar**: "Back to Group" link, "Scan Directory" button (POST to `/admin/fileArea/:shortcode/scan`).

**Directory scan**: Reads the area's resolved filesystem path, compares against tracked file_entries rows. For each untracked file: creates a new entry with source_type='local', source_data containing `{ "import_method": "directory_scan" }`. After scan, updates area stats and redirects with result counts in query params.

**Browse link from group view**: The file areas table in `fileGroups/view.pug` includes a "Browse" button on each row linking to `/admin/fileArea/:shortcode`.

---

## File Browsing (`src/routes/files.js`)

User-facing file browsing system. Follows the same architecture as `src/routes/index.js` (message browsing): shared middleware, `getCurrentUser`/`resolveUserId` helpers, `parseFlags`/`checkFileAreaReadAccess`/`checkFileAreaUploadAccess` access control helpers, guard chain pattern in templates.

### Routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/files` | List file groups (access-filtered, new file counts per group) |
| GET | `/files/group/:shortcode` | List areas in a file group (access-filtered, new counts, upload indicators) |
| GET | `/files/area/:shortcode` | Browse files in an area (paginated table; NEW marks files since the previous visit) |
| GET | `/files/view/:uuid` | File detail — metadata, descriptions, download button |
| GET | `/files/download/:uuid` | Download — access-checked, increments download count, sends file via `res.download()` |
| GET | `/files/area/:shortcode/files.json` | JSON pagination — `?offset=N&limit=N&sort=column&order=asc|desc` |
| GET | `/files/new` | New files since the previous visit, across subscribed areas |
| GET | `/files/search` | File search |
| GET | `/files/info/:uuid.json` | File info for the shared info modal (`files/partials/_fileInfoModal.pug`) |
| POST | `/files/area/:shortcode/subscribe` | Toggle the user's subscription to an area |
| GET/POST | `/files/area/:shortcode/upload` | Upload form and multipart upload (staging, hash, dupe check, FILE_ID.DIZ) |

### Templates

| Template | Layout | Purpose |
|---|---|---|
| `files/index.pug` | `../layouts/user` | File group listing — clickable rows, new badge |
| `files/groups/view.pug` | `../../layouts/user` | Areas in group — file counts, sizes, latest upload, new badge, upload icon |
| `files/areas/view.pug` | `../../layouts/user` | File listing in area — DataTables, breadcrumb, upload button placeholder |
| `files/view.pug` | `../layouts/user` | File detail — metadata table, long description, download button |
| `files/new.pug`, `files/search.pug`, `files/upload.pug` | `../layouts/user` | New files, search, upload |

On a phone (below Bootstrap `md`) the file index, file group and file area lists render each area or file as one stacked entry (details underneath, counts on the right) instead of a table; tablets and desktops keep the tables.

### Access Control

Uses the same pattern as message areas: `checkFileAreaReadAccess(sessionUser, areaOrGroup)` checks security level + permission flags + restriction flags. `checkFileAreaUploadAccess()` does the same for upload (post) access. Groups with zero accessible areas are hidden from the listing.

### New Files

A file is **new** if it arrived (`upload_date`) after the start of the user's PREVIOUS visit: the classic BBS "new since last call" (`src/utils/newSince.js`). A visit starts at terminal login, web login, and on the web after `web_idle_threshold` minutes idle (default 120); each runs `updateUserCalls`, which overwrites `users.lastlogon`, so the baseline is captured BEFORE that write: `session.prev_logon` on the web (`buildSessionData` at login/registration, `webActivity` on idle resume) and `call.prev_logon` on a terminal (login handler). No previous login falls back to the account's `created_at`. Nothing clears the marker during a visit. Read through `src/models/newFilesBaseline.js` (`forWeb`, `forCall`); counted and listed with `fileEntries.countNewSince` / `getNewSince`.

### Download Flow

1. Load entry by UUID
2. Load parent area + group
3. Check read access
4. Resolve filesystem path via `fileAreas.resolveAreaPath(group, area)` + `entry.disk_path`
5. Verify file exists on disk
6. Increment download count
7. Send via `res.download()` with original filename

---

## Pug Templating

### Layouts

Four layouts in `src/views/layouts/`:

| Layout | Nav Include | Usage |
|---|---|---|
| `admin.pug` | `includes/admin-nav.pug` | All admin views (`extends ../../layouts/admin`) |
| `user.pug` | `includes/user-nav.pug` | All public/user views (`extends ../../layouts/user`) |
| `public.pug` | `includes/user-nav.pug` | Minimal layout (Darkly, `styles.css`, `custom.css`, `bootstrap.min.js`) |
| `callflow.pug` | none | Call flow pages |

`admin.pug` and `user.pug` share asset loading: Bootstrap 5 (Darkly theme), Bootstrap Icons, `styles.css`, DataTables CSS/JS, jQuery, TinyMCE, `console.parsers.js` for pipe-code rendering, and `localTime.js` as a module. Both include the `ts` timestamp mixin (`partials/mixins/timestamp.pug`), `partials/maintenanceBanner` and `partials/chatOverlay`, and carry the presence WebSocket client inline. `public/css/custom.css` is loaded last in all four layouts so sysop rules win. Fixed-top navbar with 70px body padding.

### Navigation

**Admin nav** (`admin-nav.pug`): Brand links to `/`. Dashboard as a top-level nav item. Dropdowns and links, in order: Messages (Message Groups, Message Areas, Bad Echomail), Files (File Groups, File Areas), Networking (see Admin Dashboard below), Content (Announcements, Bulletins, Message Templates, Template Events, News Files, Seasonal Art, Wall Messages), Doors (Door Games, Door Collections), Users, Menus (Menu Editor, Themes), Update, Maintenance, Nodes (`/admin/nodespy`), Flows (`/admin/callflows`), Events (`/admin/timed-events`), Logs (`/adminlogs`). Right side: Notification bell (bell icon + unread count badge + dropdown with 10 recent items) + Mail link (envelope icon + "Mail" + unread badge from `pmUnreadCount`) + user dropdown with Logout, or Login link. Active state driven by `activelink` local variable.

**User nav** (`user-nav.pug`): Brand links to `/`. The left side is drawn from `web_nav_items` (#91, `src/models/webNav.js`, admin `/admin/webnav`): the webserver's view-helper middleware puts the cached rows in `res.locals.webNavItems` plus `buildWebNav` and `navPath`, and the template calls `buildWebNav(webNavItems, {user: currentuser, activelink: activenav, path: navPath})` itself, because only the route knows `currentuser` and `activelink` when the page renders. Seeded (empty table only, at gateway start) as the old hardcoded Messages, Files, Doors, Chat (`/whosonline`), Wall. Right side: Dashboard link (gear icon, only shown when `currentuser.isSysop` is true) + Notification bell (bell icon + unread count badge + dropdown) + Mail link (envelope icon + "Mail" + unread badge) + user dropdown with Profile + Logout, or Login link. Active state driven by `activelink` local variable.

Both navs display `boardname` (from `process.env.boardname`) as the brand text. The Mail unread badge uses `pmUnreadCount` fetched in each router's shared middleware. The notification bell uses `notificationUnreadCount` fetched by shared middleware; the dropdown loads the 10 most recent notifications via AJAX. Real-time push of new notifications via PresenceSocket updates the badge count without page reload.

### Template Conventions

- **Guard chains** — Views check `!currentuser` -> login partial, `!sufficientAccess` -> unauthorized partial, then render content. This avoids duplicating error handling in route handlers.
- **`activelink` variable** — Set by route handlers, used by nav includes to highlight the current section.
- **`currentPath`** — Set by shared middleware, used by login partials for post-login redirect.
- **`ismobile`** — Set by shared middleware via `is-mobile` package. Used for responsive layout decisions (offcanvas vs sidebar).
- **`DateTime`** — Luxon DateTime class injected as a template local by `index.js` middleware. Used for date formatting in views.
- **`boardname` / `faviconlink`** — From environment variables, injected by shared middleware.
- **`pmUnreadCount`** — Unread PM count for the current user, fetched by shared middleware in `index.js`, `admin.js`, and `pm.js`. Used by nav includes for the mail badge.
- **`notificationUnreadCount`** — Unread notification count for the current user, fetched by shared middleware. Used by nav includes for the notification bell badge.
- **`currentuser.isSysop`** — Boolean derived from `permissionflags` at session creation (`buildSessionData`). Used by `user-nav.pug` to conditionally show the admin Dashboard link.

### Mobile Detection

The `is-mobile` package checks `User-Agent` server-side. The result is passed to templates as `ismobile`. This drives decisions like hiding desktop nav buttons and showing the offcanvas hamburger menu on mobile.

---

## WebSocket Infrastructure (`src/servers/websockets.js`)

### Architecture

```
                     HTTP Server (gateway)
                  (shared with Express)

  upgrade event --+-- /ws/bbs -------> WsPool -> CallPool (PrimaryBBS)
                  |-- /ws/doorserver -> WsPool -> CallPool (Doorserver)
                  |-- /ws/webdoor ---> WsPool -> CallPool (WebDoor)
                  |-- /ws/presence, /ws/adminlogs, /ws/nodespy -> handlers
                  +-- /            --> WsPool -> CallPool (PrimaryBBS)

  Embedded mode only:
                  +-- /ws/mailer/binkp -> WsPool -> MailerManager (in-process)

  Separate mode:
      Mailer process (bin/mailer.js) binds its own HTTP listener
      on MAILER_WS_PORT for /ws/mailer/binkp WebSocket connections.
```

### WsManager

Created with the shared `httpServer` instance. Registers a single `httpServer.on('upgrade')` handler that routes by URL pathname to the matching `WsPool`. Unknown paths get a 404 response and socket destroy.

Maintains a `pathMap` (Map<string, WsPool>) for O(1) path lookup.

### WsPool

Each pool wraps a `WebSocketServer({ noServer: true })` — no standalone port, no standalone listener. Upgrade requests are handed off by the manager via `pool.handleUpgrade(request, socket, head)`.

The `WsPool` constructor accepts an `options` object. `WsManager.createNewPool(path, name, options)` passes options through. Currently supported option:

- `legacy` (boolean, default false) — marks this pool as serving legacy/connector clients (e.g. DosBox via vmodem). Connections on a legacy pool inherit the flag, which forces ZBIN+CRC-16 for ZMODEM transfers during terminal negotiation.

On connection, the pool creates a `WsConnection` and either forwards it to a linked `CallPool` (terminal BBS connections) or handles it directly (mailer connections).

### WsConnection

Wraps a single WebSocket connection. Provides `sendtext()`, `sendString()`, `sendData()` for output and routes incoming `message` events to the call handler. Announces connections and disconnections to the pool and alogger. Handles cleanup on close (removes from pool, notifies call handler). Inherits `legacy` from the parent `WsPool`; `IncomingCall` reads this flag to set the initial `call.zmodem_crc_mode`.

### Path Configuration

Configured in `bin/gateway.js` as an array of `{ name, path, callpool }` objects:

| Path | Pool Name | Call Pool | Purpose |
|---|---|---|---|
| `/ws/bbs` | BBS | PrimaryBBS | Main BBS terminal connections |
| `/ws/doorserver` | Doorserver | Doorserver | Door game server connections |
| `/ws/webdoor` | WebDoor | WebDoor | Web door launcher (one-time Redis token, `webdoor_auth` stage) |
| `/` | Catchall | PrimaryBBS | Default path for clients that don't specify |
| `/ws/presence` | (handler) | none | `PresenceServer`: heartbeat, web chat, notifications, maintenance push |
| `/ws/adminlogs` | (handler) | none | Admin live log viewer |
| `/ws/nodespy` | NodeSpy | (raw WSS) | Sysop live snoop and chat, token-auth, one-time use |

As built, the pool paths come from each row of the `call_pools` table (`ws_paths` JSONB, seeded by `src/models/callFlows.js`), with the array in `bin/gateway.js` only as the fallback when the table is empty. No pool is created with `{ legacy: true }` by default: the option is supported by `WsPool` but nothing configures a `/ws/legacy` path.

In **embedded mode**, an additional pool is registered for the mailer:

| Path | Pool Name | Call Pool | Purpose |
|---|---|---|---|
| `/ws/mailer/binkp` | Mailer Binkp Pool | (none) | FTN binkp-over-WebSocket connections (handled by MailerManager, not CallPool) |

In **separate mode**, `/ws/mailer/binkp` is served by the mailer process on its own port (`MAILER_WS_PORT`, default 24555). See `PROCESS_ARCHITECTURE.md`.

---

## Database Middleware

### PostgreSQL (`src/middleware/db/postgres.js`)

Connection pool (`pgpool`) using `pg` library. Shared across all models. Key functions:

| Function | Purpose |
|---|---|
| `query(sql, params)` | Returns array of rows |
| `queryOne(sql, params)` | Returns first row or null |
| `insertObject(obj, table)` | Builds INSERT from object keys/values, returns `{ status, insertId }` |
| `updateById(id, obj, table)` | Builds UPDATE from object keys/values where `id = $1` |
| `write(sql, params)` | Execute without return (DELETE, DDL) |
| `checkValueUnique(column, value, table)` | Returns boolean — used for shortcode uniqueness validation |

All queries are parameterized — no SQL injection risk from user input. Table names derive from admin-controlled shortcodes.

#### Admin-Managed Tables

| Table | Schema File | Purpose |
|---|---|---|
| `menus` | `menus.conf` | Menu definitions — name, title, menu_type, display file, layout, colors |
| `menu_entries` | `menu_entries.conf` | Menu items — hotkey, display text, command, colors, access control (flags, security) |
| `doors` | `doors.conf` | Door game configs — slug, launch type, command, directories, dropfile, capacity, real name flags |

### Redis (`src/middleware/db/redis.js`)

Redis client wrapper. Core key/value operations: `get`, `set`, `del`, `exists`, `expire`, `keys`. Hash operations: `hSet`, `hGet`, `hGetAll`. JSON cache helpers: `cacheSet`, `cacheGet`, `cacheInvalidate`, `cacheInvalidateAll`, `cacheThrough`. The client is created lazily on first use.

Used by:
- **Session storage** (`sessionstore.js`) — session hashes with TTL, username reverse index
- **Flash messages** (`flash.js`) — one-shot user feedback stored as JSON arrays under `flash:{sessionId}` with 30-second TTL. Used by PM routes for compose/reply/delete feedback. Generic — usable by any route. See `PM_ARCHITECTURE.md`.
- **Zone caching** (`msgZones.js`) — FTN zone lists cached per network for tosser source resolution

---

## Static Assets

Served from `public/` directory at the project root.

### CSS

| File | Purpose |
|---|---|
| `css/darkly/bootstrap.css` | Bootstrap 5 Darkly theme (dark mode) |
| `css/bootstrap-icons.css` | Bootstrap Icons font |
| `css/styles.css` | Custom BBS styles — `.monospace`, `.messagebody`, `.fg-*`/`.bg-*` color classes, Win95-style modal buttons, pipe-code color mapping |
| `css/dataTables.bootstrap5.min.css` | DataTables Bootstrap 5 integration |
| `css/Datatables.custom.css` | Custom DataTables pagination styling |
| `css/custom.css` | Sysop overrides, loaded last in every layout; seeded once on install, never overwritten by an update |
| `css/xterm.css` | xterm.js (web door player, NodeSpy) |

Other Bootswatch themes (`brite`, `cerulean`, `cyborg`, `flatly`, `materia`, `slate`, `vapor`) sit in `public/css/` but no layout loads them.

### JavaScript

| File | Purpose |
|---|---|
| `js/bootstrap.bundle.js` | Bootstrap 5 + Popper.js |
| `js/jquery-3.7.0.js` | jQuery (required by DataTables) |
| `js/jquery.dataTables.min.js` | DataTables library |
| `js/console.parsers.js` | Client-side pipe-code color parser — converts pipe codes in `.messagebody` elements to colored spans for message display |
| `js/tinymce/tinymce.min.js` | TinyMCE rich text editor (used for door descriptions and announcements; not yet for message composition) |
| `js/localTime.js` | Module: rewrites each `<time data-ts>` in the viewer's timezone, again on every DataTables draw |
| `js/readerWidth.js` | Module: message reader column sizing and the 40/80 switch (see Message Reader Width) |
| `js/fitHeight.js` | Sizes a scrolling list (`data-fit-height`) to the space left on screen, following `visualViewport` so a phone's address bar is allowed for. Used by the message views and the PM inbox |
| `js/messageAreas.js` | Module: `/messages` sort toggle (sysop order or most recently active), remembered in localStorage; also on `window.CanecticAreaSort` |
| `js/maintenanceBanner.js` | Module: maintenance countdown for users, standing reminder for sysops; fed by server-rendered data or the presence `maintenance` push |
| `js/xterm/` | xterm.js for the web door player and NodeSpy |

The project-authored modules keep their rules in pure exported functions so they are unit-tested (`readerWidth`, `fitHeight`, `messageAreas`).

---

## Shared Infrastructure

### HTTP Server Sharing

The Express app and WebSocket infrastructure share a single `http.Server` instance created in `bin/gateway.js`. Express handles normal HTTP requests; the `upgrade` event is intercepted by `WsManager` for WebSocket connections. This means:

- Single port for both web and terminal access
- No CORS issues between HTTP and WS on the same origin
- SSL/TLS can be terminated once at the proxy layer (HAProxy, nginx, etc.)

In **separate mode**, the mailer process binds its own HTTP listener on `MAILER_WS_PORT` — the gateway's HTTP server handles only terminal and web traffic. In **embedded mode**, the mailer's WsPool is added to the gateway's HTTP server. See `PROCESS_ARCHITECTURE.md` for the full process model and reverse proxy configuration.

### Model Layer Sharing

All models (`messages.js`, `msgAreas.js`, `msgGroups.js`, `menus.js`, `doors.js`, `useraccounts.js`, `userMsgPointers.js`, `userAreaSubs.js`, etc.) are ES module singletons shared between:

- Web routes (`src/routes/*.js`) — user-facing and admin
- Terminal handlers (`src/handlers/menucommands/*.js`) — area selector, reader, editor, newscan, PM reader/editor/check
- Tossers (`src/middleware/tossers/*.js`) — FTN, QWK, NNTP import/export (run in the worker process or embedded mode, not the gateway)
- Maintenance tools (`src/tools/*.js`, `src/maintenance/*.js`)

No model knows whether it's being called from a web route or a terminal handler. Access control is performed by the caller (route helper or terminal module), not the model.

#### Menu and Door Models

`menus.js` — PostgreSQL-backed menu and menu entry management. `getMenu(name)` returns the menu row with a `menu_entries` array attached (JSONB flags parsed, null color values stripped so the handler falls through to theme defaults). Full CRUD for menus and entries, plus `reorderEntries()` for drag-and-drop reordering. Exports `getAvailableCommands()` (command list for admin dropdowns), `getAnsiColors()` (16-color map with labels, hex values, and CSS classes for color pickers), and `getValidMenuTypes()` / `getValidDisplayFileTypes()` for admin form selects.

`doors.js` — PostgreSQL-backed door game configuration. `getDoorConfig(slug)` returns a normalized config object with camelCase keys matching what `DoorRunner` and `SyncJSDoorRunner` expect (e.g. `door_script` → `doorScript`, `pause_on_exit` → `pauseOnExit`). Full CRUD with slug uniqueness validation and launch type enforcement. Exports `getValidLaunchTypes()` and `getValidDropfileTypes()` for admin form selects.

#### Variable Substitution

`configvars.js` (`src/utils/`) — Runtime variable substitution for admin-configured strings. Any string field in door configuration (command, door directory, dropfile directory, door arguments) can contain `%X` tokens that are replaced at execution time with session, user, terminal, and system values. The `substitute(template, call, doorConfig)` function performs single-pass O(n) replacement. `substituteArray()` handles arrays (e.g. door arguments). `getVariableList()` exports the full token/description list for the admin variable reference panel. See `terminal_architecture.md` for the complete variable table.

### Environment Variables

Most operational config is now managed through `appConfig` (backed by the `settings` PostgreSQL table, `src/models/configStore.js`) and editable via `/admin/config`. The `.env` file is only required for bootstrap variables that are needed before the database is available, or that sit in circular dependency chains (logging, Redis).

**Bootstrap variables (must stay in `.env`):**

| Variable | Purpose | Default |
|---|---|---|
| `dbuser`, `dbhost`, `dbname`, `dbpass`, `dbport` | PostgreSQL connection | `canectic` / `localhost` / `canectic_bbs` / — / `5432` |
| `redis_url` | Redis connection URL | `redis://localhost:6379` |
| `REDIS_PASSWORD` | Redis password (if required) | — |
| `REDIS_BULLMQ_DB` | Redis database number for BullMQ job data | 2 |
| `NODE_ENV` | Express environment (controls error detail) | `development` |
| `PROCESS_MODE` | `separate` (gateway only) or `embedded` (all-in-one) | `separate` |
| `MAILER_ENABLED` | Enable FTN mailer (`true`/`false`) | `false` |

**Infrastructure variables (stay in `.env` due to circular import chains):**

| Variable | Purpose | Default |
|---|---|---|
| `loglevel` | Log verbosity (0=critical, 5=trace) | 3 |
| `logtoconsole` | Force console output in production | — |
| `logeverything` | Log all levels in development | — |
| `logfileindev` | Write log files in development mode | — |
| `defaultlogfile` | Default log filename | `system.log` |
| `LOG_BUS_RETENTION_HOURS` | Hours to retain log bus history in Redis | 8 |
| `cache_ttl` | Redis cache TTL in seconds | 3600 |

**All other config** (`boardname`, `adminsecurity`, `session_ttl`, `faviconlink`, `doordir`, mailer settings, terminal timeouts, etc.) is managed via `appConfig` and the admin config UI. Values set in `.env` override database values for any key.

---

## Web Activity Tracking and Presence

### Activity Middleware (`src/middleware/webActivity.js`)

Express middleware attached after CSRF protection, before route handlers. Tracks web engagement sessions for the caller log.

**How it works:**
- On every authenticated request (skips static assets and `/health`)
- Reads `web_activity:<sessionid>` timestamp from Redis
- If no previous activity, or gap exceeds `web_idle_threshold` (default 120 minutes): writes `prev_logon` to the session (the baseline for "new files since the previous visit", read before `updateUserCalls` overwrites `users.lastlogon`), logs a new call record via `callers.logCall()` and updates user login stats; on an idle resume (a previous timestamp existed) with `callflow_on_resume` on, also sets `callflow_pending`
- Updates the activity timestamp in Redis (expires with the session TTL)
- Non-blocking: fires async without waiting, never delays the response

**Config:** `web_idle_threshold` (network category, minutes, default 120)

### Presence WebSocket (`src/servers/presenceSocket.js`)

Lightweight WebSocket endpoint at `/ws/presence` for real-time online user tracking.

**Architecture:**
- Registered on the WsManager via `registerHandler('/ws/presence', presenceServer)` (no call pool, no terminal session)
- Authenticates via session cookie parsed from the HTTP upgrade request headers
- Client sends `{ type: "heartbeat" }` every 60 seconds
- Server refreshes Redis presence on each heartbeat (`presence:web:<userId>` key with 120s TTL)
- Dead connection pruning every 30 seconds (marks offline, terminates socket)
- Clean shutdown marks all users offline and resets state

**Redis keys:**
- `presence:web:<userId>` - JSON with `{ userId, username, lastSeen, source, activity }`. TTL 120s. The `activity` field holds a free-form string describing what the user is doing (e.g. "Reading Mail").
- `presence:web:online` - Redis SET of online user IDs. Pruned on read.

**Client integration:**
Both user and admin Pug layouts include an auto-connecting heartbeat script when `currentuser` is present. Reconnects with exponential backoff (5 s doubling to a 60 s cap).

**API:**
- `markOnline(userId, username)` - called by heartbeat handler. Preserves an existing `activity` field when refreshing the heartbeat so activity context survives across heartbeat cycles.
- `setActivity(userId, activity)` - sets a specific activity string on an online user's presence entry (e.g. "Reading Mail"). Preserves remaining TTL. Activity clears when the presence key expires.
- `markOffline(userId)` - called on disconnect and shutdown
- `getOnlineUsers()` - returns array of online user objects with automatic pruning of expired entries

**Session renewal:** The activity middleware now handles `sessionRenew()` centrally for all routes, replacing the per-router renewal calls that were previously scattered across index.js, admin.js, pm.js, files.js, and adminLogs.js.

**Display labels:** `formatActivity()` from `src/utils/activityMap.js` is the central display label resolver. It maps internal activity keys to human-readable labels for the Who's Online display and other presence views.

**Beyond heartbeats:** the same socket now carries sysop-to-web-user chat and user-to-user telegrams (`chat_initiate` with `mode` `sysop` or `telegram`, `chat_msg`, `chat_typing`, `chat_end`, `chat_restore` on reconnect; see `WEB_CHAT_DESIGN.md`), notifications (`notification`, `notification_count`, client `notification_read` / `notification_read_all`), and the maintenance-mode `maintenance` push from `src/maintenance/webDrain.js`. The server closes with code 4001 when the session has expired, and the client then goes to the login page. The client reconnects with exponential backoff from 5 s up to 60 s, and a hidden tab defers reconnecting until it is visible again.

---

## Theme Colour Bridge

Bridges the terminal theme colour system to the web UI, allowing TinyMCE-authored HTML content (door descriptions, announcements) to use theme-adaptive colours on both terminal and web.

### Problem

TinyMCE stores colours as inline `style="color: #RRGGBB"`. White text (`#FFFFFF`) is ambiguous -- it could be an explicit colour choice or just the default. The terminal converter (`htmlToTerminalText()`) can't distinguish "use theme colour" from "use bright white", leading to inconsistent rendering.

### Solution: Sentinel Colour

A "Theme Default" option in the TinyMCE colour picker uses the sentinel value `#010101` (near-black, visually indistinguishable from black but detectable in code).

**TinyMCE configuration** (doors + announcements admin views):
- `color_map` includes `'010101', 'Theme Default'` as the first entry
- `content_style` overrides `#010101` to `inherit` inside the editor preview
- `custom_colors: false` prevents arbitrary colours outside the ANSI 16 palette

### Terminal Pipeline

`htmlToTerminalText()` in `announcements.js` detects the sentinel (rgb where all channels are 0 or 1 but sum > 0) and emits `ANSI_RESET` instead of a colour code. The text renders in the terminal's current default colour, which is set by the handler from the theme.

### Web Pipeline

Three layers ensure the sentinel renders correctly on the web:

1. **Global CSS** (`public/css/styles.css`): `span[style*="color: #010101"] { color: inherit !important; }` -- sentinel spans inherit their container's colour.
2. **Container colour**: Routes load the default theme via `getDefaultTheme()` and resolve a hex colour for the page context via `resolveWebColour(theme, context)`. The hex colour is set as an inline `style="color: ..."` on the content container element.
3. **TinyMCE preview**: `content_style` in the editor config applies the same `inherit` rule inside the iframe.

### Context Mapping (`themes.js`)

`WEB_COLOUR_CONTEXTS` maps page context names to theme property keys:

| Context | Theme Property | Default ANSI | Used By |
|---------|---------------|-------------|---------|
| `doors` | `door_desc_clr` | 6 (cyan) | `/doors`, `/doors/collection/:slug` |
| `announcements` | `announcement_clr` | 6 (cyan) | `/` (home page) |
| `messages` | `msg_body_clr` | 11 (bright yellow) | Message views (stub) |
| `pm` | `msg_body_clr` | 11 (bright yellow) | PM views (stub) |

`resolveWebColour(theme, context)` returns a hex string (e.g. `#00AAAA`). Falls back to `WEB_COLOUR_DEFAULTS` if the theme property is missing (e.g. theme predates the column).

### Adding New Contexts

1. Add a theme property to `THEME_PROPERTIES` in `themes.js`
2. Add the column to `db/schema/tablecolumns/themes.conf`
3. Add seed value to `config/themes/canectic.json`
4. Add entry in `WEB_COLOUR_CONTEXTS` and `WEB_COLOUR_DEFAULTS`
5. Pass `themeTextColour` from the route, set on the content container

---

## Admin Dashboard

The admin dashboard (`/admin`) uses a tabbed card layout with 8 category tabs (System as default, plus Messages, Files, Networking, Content, Doors, Users, All). Each tool is an icon card with name and description. A search bar filters all cards in real-time, auto-switching to the All tab when typing.

Admin navbar order (`src/views/includes/admin-nav.pug`): Dashboard, Messages, Files, Networking, Content, Doors, Users, Menus, Update, Maintenance, Nodes, Flows, Events, Logs. The Networking dropdown contains: Networks, Linked Nodes, Nodelists, Nodelist Flags, Echolists, Filebones, File Requests (FREQ), Inbound Wildcards, Netmail Routes, Mailer Diagnostics, QWK and NNTP Transfers, Inbound File Log, Outbound File Log, Netmail Relay Log, Migrations.

## Update and Maintenance Pages

**Update** (`/admin/update`, `src/views/admin/update/index.pug`): the last update check re-judged against the running version (`reconcileWithRunning`), the check history, a Channel box (`POST /admin/update/channel`: refused when `.env` sets `update_channel`; a switch to development needs `confirmed=yes`, set by the page's confirm dialog showing `DEVELOPMENT_WARNING` from `src/release/channelSwitch.js`; saves the setting, reloads appConfig, runs a forced check), Check now (`POST /admin/update/check`, runs even when the daily check is off), the withdrawn-release notice (`partials/update/withdrawnNotice.pug`) and the upgrade notes panel (`partials/update/upgradeNotes.pug`). `POST /admin/update/apply` refuses unless the posted `ack` token matches the notes shown for exactly that version, records the sysops' session hashes for the progress page, and hands off to the updater. `GET /admin/update/progress` and `.json` render the same progress page the updater serves on the web port while the BBS is stopped (`src/maintenance/updateProgress.js`). See `UPDATE_SYSTEM_DESIGN.md` and `docs/sysop/UPDATING.md`.

**Maintenance** (`/admin/maintenance`, `/admin/maintenance/status.json`): `POST /admin/maintenance/enter` writes the `.maintenance` flag (reason, expected minutes, grace seconds, set by); re-entering updates the details but keeps the original start, so the grace does not restart. `POST /admin/maintenance/leave` removes it. The page shows the deadline and each process's drain status.

## Maintenance Mode on the Web

`src/middleware/maintenanceWeb.js`, `decide()` (pure): while the flag is set, `/admin`, `/adminlogs`, `/health`, `/users/login` and `/users/logout` always pass; `/api/*` gets a JSON 503; sysops pass everywhere; a logged-in user gets pages with a countdown banner until the grace deadline, then the maintenance page; anonymous visitors get the maintenance page at once. The page is a 503 with `Retry-After`. A non-sysop login is refused (`loginAllowed`, `src/routes/users.js`). On entering maintenance, `src/maintenance/webDrain.js` pushes a `maintenance` presence message to every open page and one notification per connected user (skipped when already past the deadline). The banner is `partials/maintenanceBanner.pug` + `public/js/maintenanceBanner.js`. See `docs/sysop/MAINTENANCE.md`.

## Message Reader Width

`public/js/readerWidth.js` (pure `viewCols` / `bodyCols` / `fontPx`, loaded by `partials/messages/_msgAutoSize.pug`) scales the monospace font so a message body fills the reader at a target column count: 80 on desktop; below 992 px (Bootstrap `lg`) the reader's 40 | 80 switch (`partials/messages/_readerWidth.pug`, remembered per area in localStorage `canectic.readerCols.<AREA>`), defaulting to 80 when the area's `ansi_area` ("Mostly ANSI art") is set and 40 otherwise. A body carrying `data-art` (from `detectAnsiArt(body_text)`, `msg.isArt`) is always sized to 80. Message lists and the PM inbox are sized to the visible screen by `fitHeight.js`. On a phone the thread list, message headers and PM reader header stack into rows rather than tables or single lines.

## User Navigation

User navbar, left side: sysop-edited links (#91 phase 3), by default Messages, Files, Doors, Chat (links to `/whosonline` for who's online and user-to-user telegrams), Wall (links to `/wall`).

`web_nav_items`: `parent_id` (one level: only a top-level `dropdown` may hold links), `sort_order`, `label`, `icon` (Bootstrap icon name, no `bi-`), `target_type` `builtin` | `url` | `dropdown`, `target` (a `BUILTINS` key or an address), `new_tab`, `audience` `all` | `public` (not logged in) | `users`, `min_security`, `required_flags`, `prohibited_flags`, `active`. `BUILTINS` gives each built-in page its href, the `activelink` its route passes (else the current link is matched on path, `href` or `href/...`, never `/`), and an optional `enabledKey` config switch that hides the link while the feature is off (`qwk_enabled`, `doorserver_enabled`). Access is `areaAccess.checkEntryAccess`, the terminal menu-entry rule (prohibited flags count as permissions or restrictions; a visitor is security 0, no flags). Addresses: `http(s)://host...` or a local path; `javascript:`, `data:`, `//host` and `/\host` are refused since the bar is on every page. `buildNav` is pure: drops hidden, unknown, switched-off and inaccessible links, drops a menu with no visible link, shows a link whose menu is gone at the top level. Rows are cached 60s and cleared by writes, so an edit from another process shows within a minute; an empty or unreadable table draws `DEFAULT_ITEMS`. The model refuses a parent that is not a top-level menu, removing a menu that holds links, or turning one into a link, and reorders within one parent only. Hiding a link does not disable the page. Sysop guide `docs/sysop/WEBSITE.md`, tests `tests/webNav.test.js`.

Right side (fixed, in the template, so the admin and account links cannot be removed from a web page): Admin Dashboard (sysop only), Mail with unread badge, notification bell, user dropdown (Profile, Logout).

## Echolist and Filebone Admin

Per-network echolist registries at `/admin/echolists` (all networks overview) and `/admin/echolist/:networkId` (per-network management). Browse areas, import from file with diff preview, edit individual entries. Filebones at `/admin/filebones` and `/admin/filebone/:networkId` (identical UI for file echo lists). Both linked from network detail pages. Create from file upload (name from filename, import in one step).

Combined views at `/admin/echolist/:networkId/combined` and `/admin/filebone/:networkId/combined`: tabbed layout (All/Carried/Available/Orphaned) with counts on tab labels. Subscribe modal with Create/Map tabs, config-based security defaults, flag selectors, group auto-populate, separate Allow/Enable peer checkboxes. Unsubscribe on carried areas, Unmap on orphaned areas with cascading delete options. Daily `reconcile-echolists` maintenance job ensures `local_area_id` stays in sync.

## Migration Tools

Consolidated at `/admin/migrations`. Import tools: SMB message base, areas.bbs, sbbsecho.ini (Synchronet linked nodes with two-step network/peer flow and drag-and-drop grouping). Export tools: areas.bbs and files.bbs downloads from network pages, menu JSON export from menu pages.

## Future Development

- **Rich text editor integration** - TinyMCE is loaded but not yet wired to message composition. See `message_architecture.md` future development section.
- **Admin real-time dashboard** - Live session counts, active mailer connections, tosser/worker status. Uses cross-process event subscriber (see `PROCESS_ARCHITECTURE.md`) for mailer session events and toss completion notifications. BullMQ dashboard integration for job queue visibility.
- **Rate limiting** - No rate limiting on login attempts or API endpoints currently (honeypot logins, failed logins from every service and rejected API tokens are logged to `security.log` for fail2ban, see LOGGING_SYSTEM.md).

### Recently Completed

- **User profile page** -- `/users/profile` with username change (cooldown), name/location/gender editing, inline password change.
- **Mail verification** -- Full verification flow with email codes, security level upgrade, `Unverified` restriction flag.
- **Password reset** -- Token-based forgotten password recovery via email.
- **Door listing and web launcher** -- `/doors` listing page, `/doors/play/:slug` with xterm.js and token-based WebSocket auth.
- **Last callers** -- `/lastcallers` public page with reusable `partials/lastCallers.pug` card. Shows username, time, source badge, location, call count.
- **Node Spy** -- `/admin/nodespy` dashboard with auto-updating cards, `/admin/nodespy/:nodenum` live snoop with xterm.js and token-based WebSocket auth. See `NODESPY_DESIGN.md`.
- **Theme colour bridge** -- TinyMCE colour picker includes a "Theme Default" option (sentinel `#010101`). Web routes resolve theme properties to hex colours via `resolveWebColour()` and set them on content containers. Sentinel spans use CSS `inherit` to cascade the theme colour. See Theme Colour Bridge section below.
- **Node Spy** -- `/admin/nodespy` dashboard with auto-updating cards, `/admin/nodespy/:nodenum` live snoop with xterm.js and token-auth WebSocket (`/ws/nodespy`). See `NODESPY_DESIGN.md`.
- **Who's online** -- `/whosonline` public page with reusable `partials/whosOnline.pug` card. Merges terminal nodes (via `req.app.locals.nodeManager`) with web presence users, deduplicates web-originated terminal sessions. Both partials designed for embedding in virtual call flow and dashboard.
- **The Wall** -- `/wall` public page with `partials/wall.pug` card and post form. `GET` shows recent messages (30), `POST` adds a message. Access controlled by `wall_post_security`, `wall_post_required_flags`, `wall_post_restricted_flags` config. Wall partial also embedded on the home page.
- **QWK Offline Mail** -- `/qwk` transfer page with download button and REP upload form. `/qwk/download` builds a `.qwk` packet of new messages from subscribed areas plus unread PMs, streams as file download. `/qwk/upload` accepts `.rep` multipart upload and posts replies. A Packet Settings card (`POST /qwk/settings`) sets the user's `qwk_files` (include NEWFILES.DAT) and `qwk_attach` (include PM attachments); files queued for download also travel in the next packet. Uses `qwkUser.js` model with `qwkPacketBuilder.js` low-level functions. Controlled by `qwk_enabled` config. See `QWK_USER_DESIGN.md`.
- **Web Call Flow** -- `/callflow` guided login experience. AJAX-driven single page that walks users through what's new: announcements (new since last visit), last callers, who's online, wall (with inline post), new message summary, new file summary. Login ALWAYS routes through callflow (regardless of redirect target); original destination stored as `callflow_return_url` on session and restored after completion. Time-based triggers: 2+ hours since last callflow shows prominent banner on non-home pages and redirects home page; 24+ hours force-redirects all pages. `last_callflow_at` cached on session (loaded from DB once per session, updated on all user sessions on completion via `sessionUpdateUser()`). Stages with no data auto-skip. Stages, order and per-stage settings come from the web flow (the `kind = 'web'` row of `call_flows`), edited at `/admin/callflows` beside the terminal flows (#91). Keyboard navigable (Enter to advance, Escape to skip). Config: `callflow_enabled`, `callflow_on_resume`. See `WEB_CALLFLOW_DESIGN.md` and `docs/sysop/CALLFLOWS.md`.
- **Notifications** -- Bell icon in both nav bars with unread count badge and dropdown showing 10 recent items. `/notifications` full history page with pagination. Centralised `notifications` model with user-targeted and sysop-broadcast notification types. Real-time push via PresenceSocket (count sent on connect, new notifications pushed as they arrive). Opening the dropdown marks everything read (no Mark All Read button there). Notification producers: `tic_error` (bad TIC), `pm_undeliverable`, `areafix_request`, `filefix_request`, `user_registered` (sysop); `pm_received` (user, terminal only: hidden from every web view since mail has its own nav counter, via the model's `{ web: true }` option). Daily purge job for old read notifications. Config: `notifications_enabled`, `notifications_retention_days`.
- **Web Sysop Chat** -- Sysop-to-web-user real-time chat via PresenceSocket (`/ws/presence`). Sysop initiates from NodeSpy dashboard (web user cards with Chat button). Chat sessions persisted in Redis (`chat:{id}`, `chat:{id}:msgs`, `chat:user:{userId}`) for page navigation survival. Floating overlay widget (`partials/chatOverlay.pug`) in both user and admin layouts, with minimise/restore, typing indicators, unread badge. `chat_restore` message replays history on page navigation. Controlled by `web_chat_enabled` config. See `WEB_CHAT_DESIGN.md`.
- **Custom flags** -- `custom_permission_flags` / `custom_restriction_flags` config keys allow sysops to add flags beyond the built-in set. Built-in flags (Sysop, Mod, etc.) are hardcoded and always present.
- **File upload** -- Web and terminal upload with staging, hash, dupe check, FILE_ID.DIZ extraction.
- **Registration wizard** -- 6-step wizard with AJAX validation, gender field.
- **Menu admin** -- Full web CRUD for menus and menu entries. PostgreSQL-backed (`menus` + `menu_entries` tables). Color picker selects with live preview using ANSI color map.
- **Door admin** -- Full web CRUD for door game configurations. PostgreSQL-backed (`doors` table). Two-column modal layout, tooltip field descriptions, variable reference panel.
- **Config variable substitution** -- `configvars.js` engine for `%X` token replacement in door commands, directories, and arguments. 36 variables across 6 categories.
- **Theme system** -- PostgreSQL-backed terminal colour themes with admin CRUD, colour category accordion, seeding from legacy JSON.
- **Who's Online** -- Terminal + web presence merged display, conditional call flow stage, activity map.
- **Web activity tracking** -- Centralized session renewal, presence WebSocket with activity field, idle detection.
- **Door collections** -- Many-to-many door categories with terminal browser and web card views.
- **Menu enhancements** -- Tabbed admin modals, featured entries, menu_prompt_clr, nullable entry colours with theme fallback, slug-safe identifiers.
- **ANSI colour palette** -- TinyMCE colour picker locked to 16 ANSI colours for terminal-safe rich text.
