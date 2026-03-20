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

Entry point: `bin/gateway.js` (renamed from `doorserver.js`). Orchestrates the gateway process startup:

1. **Pre-run maintenance** — `userMsgPointers.ensureConstraintsAndIndexes()`, `userAreaSubs.ensureConstraintsAndIndexes()`. Creates tables/indexes/constraints if missing.
2. **Node manager** — Tracks active terminal nodes (allocated slots for connected users).
3. **Socat manager** — Manages socat bridge processes for legacy connections.
4. **Call pools** — `CallManager` creates named pools (`PrimaryBBS`, `Doorserver`) with flow order configuration. Call pools handle the terminal-side call lifecycle.
5. **HTTP server** — `http.createServer(webserver)` wraps the Express app. Listens on `process.env.webport` (default 8080). **Single HTTP server** shared by Express routes and all WebSocket pools.
6. **WebSocket pools** — `WsManager` created with the HTTP server. Named pools created and linked to call pools by configuration. WebSocket upgrade requests are path-routed to the matching pool.
7. **Process mode startup** — If `PROCESS_MODE=embedded`, starts the mailer (`MailerManager`) and BullMQ workers in-process. If `PROCESS_MODE=separate` (default), the mailer and worker run as independent processes (`bin/mailer.js`, `bin/worker.js`). See `PROCESS_ARCHITECTURE.md`.
8. **Event subscriber** — Listens for cross-process notifications (new messages imported, PMs delivered) for real-time UI updates.
9. **Job schedules** — Registers BullMQ repeatable jobs for poll cycles, toss schedules, and maintenance tasks.

Shutdown handlers on `SIGINT`/`SIGTERM` drain embedded workers (if any), close BullMQ connections, clean up socat processes, close the Postgres pool, and shut down Redis.

Global `uncaughtException` and `unhandledRejection` handlers log to alogger but don't crash the process.

---

## Express Application (`src/servers/webserver.js`)

Standard Express 4 setup with Pug view engine.

### Middleware Stack (in order)

1. `express.json()` — JSON body parsing
2. `express.urlencoded({ extended: false })` — URL-encoded form bodies
3. `cookieParser()` — Parses cookies (session ID lives here)
4. `express.static('public')` — Serves static assets (CSS, JS, images) with dotfiles allowed

### Route Mounting

| Mount Point | Router | Purpose |
|---|---|---|
| `/` | `indexRouter` (`src/routes/index.js`) | Public landing page + message browsing/posting |
| `/admin` | `adminRouter` (`src/routes/admin.js`) | Admin panel — all admin routes are prepended with `/admin` |
| `/users` | `usersRouter` (`src/routes/users.js`) | Authentication (login/logout/register) |
| `/pm` | `pmRouter` (`src/routes/pm.js`) | Private messaging — webmail UI, compose/reply, AJAX reader, admin undeliverable queue. See `PM_ARCHITECTURE.md`. |

### Error Handling

404s are caught by a fallback middleware and forwarded to the error handler. The error handler renders `views/error.pug` and only exposes stack traces in development mode (`NODE_ENV=development`).

---

## Session Management (`src/middleware/db/sessionstore.js`)

### Storage

Sessions are stored in Redis as hash maps. Each session is keyed by `session:{sessionId}` where `sessionId` is a v4 UUID generated at login time. TTL is configurable via `process.env.session_ttl` (default 3600 seconds).

### Session Data

The session hash contains flat string fields from the user record (Redis hashes store strings only). On retrieval, `sessionGet()` parses typed fields back to native types: `permissionflags` and `restrictionflags` are JSON-parsed to arrays, `isSysop` to boolean, `security` to integer. The user model's `buildSessionData(userobj)` prepares the flat representation at login time.

### Session-User Index

A reverse lookup maps `session_index:{username}` → Set of session IDs. This enables `sessionUpdateUser(username, fields)` to update specific fields across all active sessions for a user (e.g., when an admin changes a user's security level or flags — the change takes effect on all their active sessions without requiring re-login).

### Session Lifecycle

| Operation | Function | Notes |
|---|---|---|
| Create | `sessionStore(id, data, ttl)` | Sets hash + TTL, indexes by username |
| Read | `sessionGet(id)` | Returns parsed session object or null |
| Renew | `sessionRenew(id, ttl)` | Resets TTL — called on every request by route middleware |
| Destroy | `sessionDestroy(id)` | Removes from Redis + username index |
| Exists | `sessionExists(id)` | Boolean check |
| List | `sessionList()` | Returns all session keys (admin use) |
| Bulk update | `sessionUpdateUser(username, fields)` | Updates fields on all sessions for a username |

### Cookie

Session ID is stored in a `sessionid` HTTP-only cookie. Max age 7 days. Domain set from `process.env.sitetld`. SameSite `lax`.

---

## Authentication (`src/routes/users.js`)

### Routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/users/login` | Login page (redirects to `/` if already authenticated) |
| POST | `/users/login` | Authenticate — accepts both form and AJAX (JSON). Form redirects; AJAX returns `{ status, redirect }`. |
| GET | `/users/logout` | Destroys session, clears cookie, redirects to login |
| GET | `/users/register` | Registration page |
| POST | `/users/register` | Create account via `userAccounts.saveUser()` |

### Login Flow

1. `userAccounts.checkUserPass(username, password)` validates credentials (salt+pepper hashing)
2. On success: `buildSessionData(userobj)` prepares session fields, `sessionStore()` saves to Redis, `setSessionCookie()` sets the HTTP-only cookie
3. Post-login redirect: `req.body.redirect` with `safeRedirect()` validation (rejects absolute URLs and protocol-relative paths to prevent open redirect)

### Shared Login Partial

User-facing views that require authentication use a guard chain pattern. When `!currentuser`, they render a login partial inline (with `loginMode = 'guard'` and `loginRedirect = currentPath`) instead of redirecting to `/users/login`. This keeps the user on the same URL after authenticating. The login partial supports both in-page form submission and AJAX login.

### AJAX Support

Both login and register accept `Accept: application/json` requests. Error responses return `{ status: false, errors: [...] }`. Success returns `{ status: true, redirect: '...' }`. The caller is responsible for performing the redirect client-side.

---

## Route Architecture

### Shared Middleware Pattern

Each router (`index.js`, `admin.js`, `users.js`, `pm.js`) uses a consistent pattern:

1. **Cookie parser** — `router.use(cookieParser())`
2. **Shared locals injection** — A `router.use()` middleware that sets template variables available to all views in that router: `boardname`, `faviconlink`, `currentPath`, `activelink`, and (for index.js) `DateTime` and `ismobile`
3. **Session renewal** — The shared locals middleware also calls `sessionStore.sessionRenew()` on every request if a session cookie exists, keeping active sessions alive
4. **Unread PM count** — `index.js`, `admin.js`, and `pm.js` all fetch `pmUnreadCount` via `privateMessages.getUnreadCount(userId)` in their shared middleware, making it available to nav templates for the mail badge
5. **Flash messages** — `pm.js` loads flash messages via `flash.get(req)` into `res.locals.flash` for one-shot user feedback after redirects

### getCurrentUser Pattern

All four routers define a `getCurrentUser(req)` helper that reads the session cookie and returns the parsed session object from Redis (or null). This is called at the top of every route handler that needs user context.

### resolveUserId Pattern

In `index.js` and `pm.js`, `resolveUserId(sessionUser)` handles the string-to-integer conversion for `sessionUser.id` (Redis stores everything as strings). Falls back to a DB lookup by UUID or username for sessions created before the `id` field was added. All routes that need a numeric user ID (pointer operations, unread counts) use this.

---

## Admin Panel (`src/routes/admin.js`)

### Access Control

Two-layer admin check:

1. **Security level** — `parseInt(user.security) >= adminsecurity` (from `process.env.adminsecurity`, default 200)
2. **Sysop flag** — `user.permissionflags` must include `"Sysop"`

`checkAdminAccess(user)` performs both checks. GET routes call it to set a `sufficientAccess` boolean that templates use for guard chains. POST routes use `requireAdmin` middleware that blocks the request entirely with a 403 if the check fails.

### Route Structure

| Category | Routes | Purpose |
|---|---|---|
| Dashboard | `GET /admin` | Admin landing page |
| Styles | `GET /admin/styles` | Terminal style editor |
| Message Groups | `GET/POST /admin/msgGroups`, `GET/POST /admin/msgGroup/:shortcode/*` | Group CRUD, area counts |
| Message Areas | `GET /admin/msgAreas`, `GET/POST /admin/msgArea/:shortcode/*` | Area CRUD (all areas view + per-group view) |
| Networks | Network management routes | FTN/QWK/NNTP network configuration |
| Peers | Peer connection management | Remote system configuration |
| Netmail | `GET/POST /admin/netmail/*` | Netmail browser and viewer |
| Tosser | `POST /admin/tosser/*` | Enqueues toss jobs on the BullMQ queue (replaces direct tosser calls) |
| Users | `GET /admin/users`, `POST /admin/users/:uuid/*` | User list, edit, password reset |
| Group Defaults | `GET /admin/msgGroup/:shortcode/defaults` | JSON endpoint — returns group security/flag defaults for new area modal auto-populate |

### Modal-Driven Editing Pattern

Admin views use a consistent pattern for CRUD:

1. **Table** — Lists items with data attributes on each `<tr>` (all editable fields stored as `data-bs-*` attributes)
2. **Info modal** — Clicking a row opens a read-only info modal populated from the row's data attributes via JS
3. **Edit modal** — "Edit" button in the info modal populates a form modal from the same data attributes, sets the form action dynamically
4. **Delete modal** — "Delete" button opens a confirmation modal with the item name and optional destructive options (e.g., "delete tables and all data")
5. **JS wiring** — `DOMContentLoaded` handler initializes Bootstrap modals, wires click events, and handles inter-modal transitions (info -> edit, info -> delete)

For tables using DataTables (e.g., users, all-areas index), event delegation on `tbody` survives DataTables redraws.

### Flag Editor Pattern

Used for permission/restriction flags on users, groups, and areas:

1. **Badge display** — Active flags shown as colored badges (green for permissions, red for restrictions). Click to remove.
2. **Select + Add button** — Dropdown shows only flags not already active. "Add" button appends the selected flag.
3. **Hidden inputs** — Each active flag has a `<input type="hidden" name="fieldname" value="flag">`. Multiple inputs with the same name submit as an array.
4. **renderFlags() function** — Rebuilds badges, hidden inputs, and select options. Called on init, add, and remove. Shared pattern across all flag editors.
5. **Available flags** — Defined as constants in `admin.js`: `availablePermissions` ("Sysop", "Mod", "Adult", "Admin") and `availableRestrictions` ("Underage", "Banned"). Passed to templates via render calls.

### AJAX Group Defaults

The all-areas index (`/admin/msgAreas`) uses an AJAX endpoint to populate new-area modal fields when the group selector changes:

```
GET /admin/msgGroup/:shortcode/defaults
-> { read_security, post_security, read_perm_flags, read_rest_flags, post_perm_flags, post_rest_flags }
```

The group select `change` handler fetches this endpoint, populates security fields, and calls `renderAreaFlags()` for all four flag groups. If the selector is cleared, fields reset to defaults (50/50, empty flags).

---

## Pug Templating

### Layouts

Two layouts in `src/views/layouts/`:

| Layout | Nav Include | Usage |
|---|---|---|
| `admin.pug` | `includes/admin-nav.pug` | All admin views (`extends ../../layouts/admin`) |
| `user.pug` | `includes/user-nav.pug` | All public/user views (`extends ../../layouts/user`) |

Both layouts share identical asset loading: Bootstrap 5 (Darkly theme), Bootstrap Icons, custom `styles.css`, DataTables CSS/JS, jQuery, TinyMCE, and a custom `console.parsers.js` for pipe-code rendering. Fixed-top navbar with 70px body padding.

### Navigation

**Admin nav** (`admin-nav.pug`): Brand links to `/`. Dashboard as a top-level nav item (`activelink === 'dashboard'`). Dropdown menus for Messages (Groups, Areas, Networks), Doors, Files. Direct link for Users. Right side: Mail link (envelope icon + "Mail" + unread badge from `pmUnreadCount`) + user dropdown with Logout, or Login link. Active state driven by `activelink` local variable.

**User nav** (`user-nav.pug`): Brand links to `/`. Direct links for Messages, Files, Doors. Right side: Dashboard link (gear icon, only shown when `currentuser.isSysop` is true) + Mail link (envelope icon + "Mail" + unread badge) + user dropdown with Profile + Logout, or Login link. Active state driven by `activelink` local variable.

Both navs display `boardname` (from `process.env.boardname`) as the brand text. The Mail unread badge uses `pmUnreadCount` fetched in each router's shared middleware.

### Template Conventions

- **Guard chains** — Views check `!currentuser` -> login partial, `!sufficientAccess` -> unauthorized partial, then render content. This avoids duplicating error handling in route handlers.
- **`activelink` variable** — Set by route handlers, used by nav includes to highlight the current section.
- **`currentPath`** — Set by shared middleware, used by login partials for post-login redirect.
- **`ismobile`** — Set by shared middleware via `is-mobile` package. Used for responsive layout decisions (offcanvas vs sidebar).
- **`DateTime`** — Luxon DateTime class injected as a template local by `index.js` middleware. Used for date formatting in views.
- **`boardname` / `faviconlink`** — From environment variables, injected by shared middleware.
- **`pmUnreadCount`** — Unread PM count for the current user, fetched by shared middleware in `index.js`, `admin.js`, and `pm.js`. Used by nav includes for the mail badge.
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
                  +-- /            --> WsPool -> CallPool (PrimaryBBS)

  Embedded mode only:
                  +-- /ws/mailer ----> WsPool -> MailerManager (in-process)

  Separate mode:
      Mailer process (bin/mailer.js) binds its own HTTP listener
      on MAILER_WS_PORT for /ws/mailer WebSocket connections.
```

### WsManager

Created with the shared `httpServer` instance. Registers a single `httpServer.on('upgrade')` handler that routes by URL pathname to the matching `WsPool`. Unknown paths get a 404 response and socket destroy.

Maintains a `pathMap` (Map<string, WsPool>) for O(1) path lookup.

### WsPool

Each pool wraps a `WebSocketServer({ noServer: true })` — no standalone port, no standalone listener. Upgrade requests are handed off by the manager via `pool.handleUpgrade(request, socket, head)`.

On connection, the pool creates a `WsConnection` and either forwards it to a linked `CallPool` (terminal BBS connections) or handles it directly (mailer connections).

### WsConnection

Wraps a single WebSocket connection. Provides `sendtext()`, `sendString()`, `sendData()` for output and routes incoming `message` events to the call handler. Announces connections and disconnections to the pool and alogger. Handles cleanup on close (removes from pool, notifies call handler).

### Path Configuration

Configured in `bin/gateway.js` as an array of `{ name, path, callpool }` objects:

| Path | Pool Name | Call Pool | Purpose |
|---|---|---|---|
| `/ws/bbs` | BBS | PrimaryBBS | Main BBS terminal connections |
| `/ws/doorserver` | Doorserver | Doorserver | Door game server connections |
| `/` | Catchall | PrimaryBBS | Default path for clients that don't specify |

In **embedded mode**, an additional pool is registered for the mailer:

| Path | Pool Name | Call Pool | Purpose |
|---|---|---|---|
| `/ws/mailer` | Mailer | (none) | FTN mailer connections (handled by MailerManager, not CallPool) |

In **separate mode**, `/ws/mailer` is served by the mailer process on its own port (`MAILER_WS_PORT`). See `PROCESS_ARCHITECTURE.md`.

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

### JavaScript

| File | Purpose |
|---|---|
| `js/bootstrap.bundle.js` | Bootstrap 5 + Popper.js |
| `js/jquery-3.7.0.js` | jQuery (required by DataTables) |
| `js/jquery.dataTables.min.js` | DataTables library |
| `js/console.parsers.js` | Client-side pipe-code color parser — converts pipe codes in `.messagebody` elements to colored spans for message display |
| `js/tinymce/tinymce.min.js` | TinyMCE rich text editor (loaded but not yet used — future rich message composition) |

---

## Shared Infrastructure

### HTTP Server Sharing

The Express app and WebSocket infrastructure share a single `http.Server` instance created in `bin/gateway.js`. Express handles normal HTTP requests; the `upgrade` event is intercepted by `WsManager` for WebSocket connections. This means:

- Single port for both web and terminal access
- No CORS issues between HTTP and WS on the same origin
- SSL/TLS can be terminated once at the proxy layer (HAProxy, nginx, etc.)

In **separate mode**, the mailer process binds its own HTTP listener on `MAILER_WS_PORT` — the gateway's HTTP server handles only terminal and web traffic. In **embedded mode**, the mailer's WsPool is added to the gateway's HTTP server. See `PROCESS_ARCHITECTURE.md` for the full process model and reverse proxy configuration.

### Model Layer Sharing

All models (`messages.js`, `msgAreas.js`, `msgGroups.js`, `useraccounts.js`, `userMsgPointers.js`, `userAreaSubs.js`, etc.) are ES module singletons shared between:

- Web routes (`src/routes/*.js`) — user-facing and admin
- Terminal handlers (`src/handlers/menucommands/*.js`) — area selector, reader, editor, newscan, PM reader/editor/check
- Tossers (`src/middleware/tossers/*.js`) — FTN, QWK, NNTP import/export (run in the worker process or embedded mode, not the gateway)
- Maintenance tools (`src/tools/*.js`, `src/maintenance/*.js`)

No model knows whether it's being called from a web route or a terminal handler. Access control is performed by the caller (route helper or terminal module), not the model.

### Environment Variables

Key configuration via `.env`:

| Variable | Purpose | Default |
|---|---|---|
| `webport` | HTTP server port | 8080 |
| `boardname` | System name (nav brand, origin lines) | — |
| `sitetld` | Cookie domain | — |
| `sitedomain` | Full domain for URL generation | — |
| `faviconlink` | Favicon path | `/images/favicon.ico` |
| `adminsecurity` | Minimum security level for admin access | 200 |
| `session_ttl` | Redis session TTL in seconds | 3600 |
| `cache_ttl` | Redis cache TTL in seconds | 3600 |
| `pm_trash_retention_days` | Days before hard-deleting trashed PMs | 30 |
| `DefaultUser` | Default poster name (legacy) | "John Doe" |
| `NODE_ENV` | Express environment (controls error detail) | "development" |
| `PROCESS_MODE` | `separate` (gateway only) or `embedded` (all-in-one) | `separate` |
| `MAILER_ENABLED` | Enable FTN mailer (`true`/`false`) | `false` |
| `MAILER_WS_PORT` | WebSocket listener port for mailer (separate mode) | 24555 |
| `REDIS_BULLMQ_DB` | Redis database number for BullMQ job data | 2 |
| `WORKER_CONCURRENCY` | Toss queue concurrency in worker process | 3 |

---

## Future Development

- **File area web routes** — File groups/areas, upload/download, file listings. Currently stub in nav only.
- **User profile page** — `/users/profile` linked in user nav but not yet implemented.
- **Navigation polish** — Both nav includes are basic Bootstrap dropdowns, functional but need design attention.
- **Rich text editor integration** — TinyMCE is loaded but not yet wired to message composition. See `message_architecture.md` future development section.
- **Admin real-time dashboard** — Live session counts, active mailer connections, tosser/worker status. Uses cross-process event subscriber (see `PROCESS_ARCHITECTURE.md`) for mailer session events and toss completion notifications. BullMQ dashboard integration for job queue visibility.
- **WebSocket authentication** — Currently WebSocket connections are anonymous until the terminal login flow. Future: authenticate via session cookie on upgrade.
- **Rate limiting** — No rate limiting on login attempts or API endpoints currently.
- **CSRF protection** — Not currently implemented. POST routes rely on session cookies + same-origin policy.
