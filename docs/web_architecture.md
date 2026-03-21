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
| `/files` | `filesRouter` (`src/routes/files.js`) | File browsing — group/area/file listing, file detail, download, JSON pagination |

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
| Networks | Network management routes | FTN/QWK/NNTP network configuration, message area mappings, file area mappings |
| Peers | Peer connection management | Remote system configuration, message area subscriptions, file area subscriptions |
| File Network Areas | `POST /admin/network/:uuid/addfilearea`, `POST /admin/network/filearea/:id/{update,remove}` | Map file areas to networks (areatag), manage TIC file echo mappings. Uses `fileNetworkAreas` model. |
| File Peer Subscriptions | `POST /admin/connection/:uuid/setfile{allowed,enabled}` | Per-connection allowed/enabled file areas for TIC distribution. Uses `filePeerSubscriptions` model. |
| Netmail | `GET/POST /admin/netmail/*` | Netmail browser and viewer |
| Tosser | `POST /admin/tosser/*` | Enqueues toss jobs on the BullMQ queue (replaces direct tosser calls) |
| Users | `GET /admin/users`, `POST /admin/users/:uuid/*` | User list, edit, password reset |
| Menus | `GET /admin/menus`, `GET /admin/menus/:id`, `POST /admin/menus/*` | Menu CRUD — list, view with entries, create/update/delete. Entry CRUD and reorder within a menu. |
| Doors | `GET /admin/doors`, `POST /admin/doors/*` | Door game CRUD — list, create/update/delete. Variable reference panel with %X tokens. |
| Group Defaults | `GET /admin/msgGroup/:shortcode/defaults` | JSON endpoint — returns group security/flag defaults for new area modal auto-populate |
| File Groups | `GET /admin/fileGroups`, `GET/POST /admin/fileGroup/:shortcode/*` | File group CRUD, area counts, base_dir management |
| File Areas | `GET /admin/fileAreas`, `POST /admin/fileArea/:shortcode/*` | File area CRUD (all areas view + per-group view), sub_dir, newscan_default |
| File Area Detail | `GET /admin/fileArea/:shortcode` | File browser — area info, paginated file listing (DataTables), file info/edit/move/delete modals, directory scan |
| File Entry Ops | `POST /admin/fileEntry/:uuid/{update,delete,move}` | File entry update (desc, active, flagged), delete (optional disk removal), move to another area (optional disk move) |
| Directory Scan | `POST /admin/fileArea/:shortcode/scan` | Scans area directory for untracked files, creates file_entries rows for new files, updates area stats |
| File Group Defaults | `GET /admin/fileGroup/:shortcode/defaults` | JSON endpoint — returns file group security/flag defaults for new area modal auto-populate |
| Config | `GET /admin/config`, `POST /admin/config`, `POST /admin/config/reset/:key` | System configuration management — view/edit all config settings organized by category, reset individual keys to defaults. Uses accordion layout with per-category save forms. Environment-overridden settings shown as read-only. |
| Nodelists | `GET /admin/nodelists` | FTN nodelist management — per-network import status, stats, upload/clear actions. Requires admin access. |
| Nodelist Import | `POST /admin/nodelists/import` | Multipart file upload (multer). Saves to temp dir, enqueues `import-nodelist` BullMQ job. Flash message confirms queuing. |
| Nodelist Clear | `POST /admin/nodelists/clear/:networkId` | Deletes all nodelist data for a network via `ftnNodelist.clearNetwork()`. Confirmation modal in UI. |
| Nodelist Browser | `GET /admin/nodelist/:networkId` | Browse imported nodelist for a specific FTN network. DataTables listing with row-click detail modal. |
| Nodelist Search | `GET /admin/nodelist/:networkId/search.json` | JSON endpoint for AJAX search/filter. Params: `q` (search term), `filter` (active/added/removed/all), `limit`. |

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

Menu-level color fields use `<select>` dropdowns with inline `style="color:<hex>"` on each option, rendered against a `.bg-dark` background. A `syncSelectColor()` JS function copies the selected option's color onto the `<select>` element itself on change and on page load (browsers don't natively show option inline styles on the closed select). A "Theme Default" option submits an empty value, which the model stores as `null`; `getMenu()` strips null color keys via `delete` so they arrive as `undefined` in `_applyConfig()` and the handler falls through to theme defaults.

Entry-level `fg_clr`/`bg_clr` always have a value (default 7/0) — they're passed directly to `setfgcolor()` which renders `null` as black (ANSI color 0, invisible on dark backgrounds).

The `ANSI_COLORS` array in `menus.js` maps each of the 16 ANSI color values to a label, hex color, and CSS class from `styles.css`. This array is used by all color select dropdowns and by the entry table's colored name/swatch display.

### Door Admin Views (`views/admin/doors/`)

Single view: `index.pug` with table, info/edit/delete modals. Add and edit modals use a two-column layout (1100px wide): left column has identity and executable fields, right column has dropfile and options. All field descriptions are Bootstrap tooltips on `<label>` elements (small info icon) rather than `.form-text` blocks.

A collapsible "Variable Reference" panel below the door table shows all `%X` substitution tokens organized by category (node/session, user, terminal, connection, door config, system directories, system info). Sourced from `configvars.getVariableList()`, which means adding a new variable to the engine automatically updates the admin reference.

### Config Admin Views (`views/admin/config/`)

Single view: `index.pug` with Bootstrap accordion layout. Each category (system, network, display, security, performance, maintenance, logging, terminal, doors, paths, mailer, worker) gets its own collapsible accordion section containing a form. Settings display type-appropriate inputs: text for strings, number for numbers, switch/checkbox for booleans. Each setting shows a source badge (Default/gray, Database/blue, Environment/yellow) and optionally a "Requires restart" badge. Environment-overridden settings are disabled/read-only. Database-overridden settings show a "Reset" button that POSTs to `/admin/config/reset/:key` to restore the default value. Each category form has its own "Save" button that submits all settings for that category. The POST handler uses `configStore.setValues()` for batch upsert, which automatically publishes `CONFIG_CHANGED` for cross-process invalidation via Redis pub/sub.

Data flow: `CONFIG_DEFINITIONS` from `configDefaults.js` provides metadata (type, category, description, restart flag, default value). `appConfig.getAll()` provides current merged values. `appConfig.getSource(key)` provides the tier each value comes from. The route pre-builds a flat array of setting objects combining all three sources for the template.

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
| GET | `/files/area/:shortcode` | Browse files in an area (paginated table, advances scan pointer) |
| GET | `/files/view/:uuid` | File detail — metadata, descriptions, download button |
| GET | `/files/download/:uuid` | Download — access-checked, increments download count, sends file via `res.download()` |
| GET | `/files/area/:shortcode/files.json` | JSON pagination — `?offset=N&limit=N&sort=column&order=asc|desc` |

### Templates

| Template | Layout | Purpose |
|---|---|---|
| `files/index.pug` | `../layouts/user` | File group listing — clickable rows, new badge |
| `files/groups/view.pug` | `../../layouts/user` | Areas in group — file counts, sizes, latest upload, new badge, upload icon |
| `files/areas/view.pug` | `../../layouts/user` | File listing in area — DataTables, breadcrumb, upload button placeholder |
| `files/view.pug` | `../layouts/user` | File detail — metadata table, long description, download button |

### Access Control

Uses the same pattern as message areas: `checkFileAreaReadAccess(sessionUser, areaOrGroup)` checks security level + permission flags + restriction flags. `checkFileAreaUploadAccess()` does the same for upload (post) access. Groups with zero accessible areas are hidden from the listing.

### Scan Pointers

When a user views a file listing, the scan pointer is advanced to the highest file ID in the results (via `userFilePointers.advancePointer()`). New file counts are computed from the gap between the pointer and current max file ID per area.

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

Most operational config is now managed through `appConfig` (backed by the `config_settings` PostgreSQL table) and editable via `/admin/config`. The `.env` file is only required for bootstrap variables that are needed before the database is available, or that sit in circular dependency chains (logging, Redis).

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

## Future Development

- **File upload** — Phase 3 of the file area system. Upload button is present but disabled in the file area view.
- **User profile page** — `/users/profile` linked in user nav but not yet implemented.
- **Navigation polish** — Both nav includes are basic Bootstrap dropdowns, functional but need design attention.
- **Rich text editor integration** — TinyMCE is loaded but not yet wired to message composition. See `message_architecture.md` future development section.
- **Admin real-time dashboard** — Live session counts, active mailer connections, tosser/worker status. Uses cross-process event subscriber (see `PROCESS_ARCHITECTURE.md`) for mailer session events and toss completion notifications. BullMQ dashboard integration for job queue visibility.
- **WebSocket authentication** — Currently WebSocket connections are anonymous until the terminal login flow. Future: authenticate via session cookie on upgrade.
- **Rate limiting** — No rate limiting on login attempts or API endpoints currently.
- **CSRF protection** — Not currently implemented. POST routes rely on session cookies + same-origin policy.
- **Lightbar menu type** — `menu_type` column is in the schema and persisted through admin UI, but `MenuHandler` does not yet branch on it. Currently all menus use hotkey dispatch.

### Recently Completed

- **Menu admin** — Full web CRUD for menus and menu entries. PostgreSQL-backed (`menus` + `menu_entries` tables), replaces hardcoded `defaultmenuarray`. Color picker selects with live preview using ANSI color map. Entry reordering, flag-based access control editing.
- **Door admin** — Full web CRUD for door game configurations. PostgreSQL-backed (`doors` table), replaces hardcoded `testingarray`. Two-column modal layout, tooltip field descriptions, variable reference panel.
- **Config variable substitution** — `configvars.js` engine for `%X` token replacement in door commands, directories, and arguments. 36 variables across 6 categories. Admin reference panel on the doors page.
