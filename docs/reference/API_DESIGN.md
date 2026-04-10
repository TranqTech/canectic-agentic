# REST API v1

Programmatic access to Canectic BBS over HTTP with Bearer token authentication. Designed for QWK offline readers, scripted clients, and personal automation. The `/api/v1` namespace establishes versioning convention for future breaking changes while retaining legacy support.

## Rationale

Terminal and web access cover interactive use, but offline mail readers and automation scripts benefit from a clean, versioned HTTP API that bypasses session cookies, CSRF, and HTML rendering. Phase 1 exposes QWK download and REP upload since that is the largest pain point for integrating existing BBS clients. The same framework (auth middleware, router, token model, call logging) will carry future endpoints (PM, files, stats) without reshaping the foundation.

## URL Scheme

All endpoints live under `/api/v1`. Breaking changes will ship under `/api/v2` and both can run side-by-side indefinitely. CSRF middleware is skipped for all `/api/*` paths since Bearer tokens are not stealable via cross-site requests the way cookies are.

| Endpoint | Method | Auth | Scope | Description |
|---|---|---|---|---|
| `/api/v1/ping` | GET | none | - | Health check, returns `{ ok: true, version: 'v1' }` |
| `/api/v1/me` | GET | required | any | Returns authenticated user summary |
| `/api/v1/qwk/download` | POST | required | `qwk` | Build and stream personal QWK packet |
| `/api/v1/qwk/upload` | POST | required | `qwk_rw` | Import REP packet (multipart or raw) |

Authentication failures return JSON (`401 auth_required`, `401 invalid_token`, `403 insufficient_scope`, `403 account_restricted`, `500 auth_error`). The v1 router owns its 404 handler so unknown paths also return JSON, not HTML.

## Tokens

Tokens are stored in the `user_api_tokens` table:

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `user_id` | INTEGER NOT NULL | FK to `users` |
| `label` | VARCHAR(128) | Human description (e.g. "iPhone MultiMail") |
| `token_hash` | VARCHAR(255) | bcrypt hash of plaintext |
| `scope` | VARCHAR(32) | `qwk` or `qwk_rw` |
| `active` | BOOLEAN | Revoked tokens stay in table with active=false for audit |
| `created_at` | TIMESTAMPTZ | |
| `last_used_at` | TIMESTAMPTZ | Updated on every successful auth |
| `expires_at` | TIMESTAMPTZ | Optional hard expiry |

Plaintext format: `canectic_<base64url(48 random bytes)>`. The `canectic_` prefix is grep-friendly and lets future leak scanners (GitHub secret scanning, trufflehog) recognise the format. bcrypt cost 10 matches password hashing. Plaintext is shown exactly once at creation; the model never persists or returns it afterwards.

### Scope model

- `qwk` -- download-only. Can call `/qwk/download` and read-only endpoints.
- `qwk_rw` -- read + write. Can call both download and upload. `scopeAllows('qwk_rw', 'qwk')` returns true (rw implies read).

More scopes will be added as endpoints grow (`pm`, `files`, `admin`, etc.). The registry lives in `src/models/apiTokens.js` exports (`VALID_SCOPES`, `SCOPE_LABELS`).

### Auth middleware

`src/middleware/apiAuth.js` exports:

- `apiAuth` -- parses `Authorization: Bearer <token>`, resolves token via `apiTokens.resolveToken()`, loads the user, blocks Banned users, attaches `req.apiUser` and `req.apiToken`. On success calls `apiTokens.touchLastUsed()`.
- `requireScope(scope)` -- factory returning middleware that checks the token's scope against the required one (with `qwk_rw` implying `qwk`).

Token resolution iterates active tokens and bcrypt-compares. The scan is bounded by per-user token counts in practice and a future optimisation could add a keyed HMAC prefix lookup if needed.

## Call Logging

Every successful API call is logged so the sysop sees API activity in the caller log, and active users still show up as regulars. But a polling QWK reader should not inflate logoncount once per poll. The implementation:

- On success, `logApiCall()` inspects `user.api_last_counted_at` and `api_call_count_interval_hours` config (default 4).
- If the interval has elapsed (or the column is null), `calls.logCall()` creates a normal caller log entry and `UPDATE users` bumps `logoncount`, `lastlogon`, and `api_last_counted_at`.
- If the interval has not elapsed, a lightweight `calls` row is inserted (endtime=starttime, duration=0, source='QWK-API') and only `lastlogon` is updated. `logoncount` is unchanged.
- `source='QWK-API'` distinguishes API calls from terminal/web sessions in the caller log UI.

Setting `api_call_count_interval_hours` to `0` disables throttling and bumps `logoncount` on every call.

## Template Event

`user_qwk_fetched` is seeded in `config/default/message-template-events.json` and fires after every successful API call (download or upload). Context vars:

- `user.*` -- standard user fields
- `event.kind` -- `download` or `upload`
- `event.area_count`, `event.message_count` -- download only
- `event.posted_count`, `event.error_count` -- upload only

Sysops can attach a template to this event (e.g. "Your QWK download is ready" confirmation or usage tracking) through the standard message templates system.

## QWK Endpoints

### POST /api/v1/qwk/download

Calls `qwkUser.buildQwkForUser(userId)` to generate a personal QWK packet from the caller's subscribed message areas (respecting scan pointers) and unread PMs. Returns:

- `200 OK` with `Content-Type: application/octet-stream`, `Content-Disposition: attachment; filename=<bbsid>.qwk`, headers `X-Qwk-Message-Count` and `X-Qwk-Area-Count`. Body is the raw ZIP.
- `204 No Content` when there is nothing new to send.

### POST /api/v1/qwk/upload

Accepts two body formats for compatibility with both interactive form posts and scripted clients:

1. **Multipart** -- field name `rep`, file upload via multer (memory storage, 10 MB limit).
2. **Raw octet-stream** -- full request body is the REP ZIP, same limit.

Calls `qwkUser.importRepForUser(userId, buffer)` which runs each reply through `messages.startNewThread()` / `messages.replyToThread()` as if the user posted interactively (access control, dupe check, threading, outbound federation are all reused).

Returns JSON `{ ok: true, posted: N, errors: [...] }`. `posted` is the number of successful replies; `errors` is an array of per-reply failure reasons (access denied, unknown area, etc.).

## Admin and User UIs

### Admin

`/admin/api-tokens` lists all tokens system-wide with columns: user, label, scope, last used, created, expires, status, actions (revoke / delete). An "Issue Token" modal lets the sysop create a token on behalf of a user by username for support scenarios (e.g. helping a user set up their offline reader).

### User profile

`/users/profile` now includes an "API Tokens" card showing the user's own tokens with the same actions. The "New Token" modal asks for label and scope. After creation, the plaintext token is displayed exactly once in a copy-to-clipboard-friendly alert; navigating away discards it permanently.

Route ownership is enforced: `/users/profile/api-tokens/:id/revoke` and `/users/profile/api-tokens/:id/delete` verify the target token belongs to the current user before mutating.

## Configuration

| Key | Default | Category | Purpose |
|---|---|---|---|
| `api_call_count_interval_hours` | `4` | network | Minimum hours between logoncount bumps for API calls from the same user. `0` disables throttling. |

## Future Work

Phase 1 scope is intentionally narrow (QWK only). Planned expansions:

- **PM endpoints** -- list inbox, read message, send new PM, list attachments, download attachment.
- **File endpoints** -- browse areas, list new files, download files, upload with DIZ extraction.
- **Stats endpoints** -- who's online, caller log, system stats.
- **Admin endpoints** (requires new `admin` scope) -- user management, peer polling, toss triggers.
- **OAuth-style token issuance** -- if we ever want third-party apps. Current model assumes personal-use tokens managed in the profile.

## Security Considerations

- Bearer tokens must be sent over HTTPS in production. Canectic does not enforce TLS termination; deploy behind a reverse proxy.
- Tokens grant the same access the user has in terminal/web. Banned users' tokens are rejected at auth time regardless of active status.
- No rate limiting yet. A malicious or broken client could flood `/qwk/download`. Add fail2ban-style limits or an IP/user rate limiter if abuse emerges.
- CSRF exemption is safe only for Bearer-auth paths. Do not add cookie-auth endpoints under `/api/*` without revisiting this.
- Token leaks can be detected via GitHub secret scanning once the `canectic_` prefix is registered upstream.
