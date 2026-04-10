# REST API

Canectic ships a versioned HTTP API at `/api/v1` for scripted clients, offline QWK readers, and personal automation. Access is controlled by per-user Bearer tokens that sysops can audit and revoke at any time.

The first release focuses on QWK packet download and REP upload -- the biggest pain point for integrating existing BBS offline readers. More endpoints will be added under the same `/api/v1` namespace as the feature set grows.

## Overview

- **Base URL**: `/api/v1` on the same HTTP host as the web UI
- **Auth**: `Authorization: Bearer <token>` header on every request (except `/api/v1/ping`)
- **Content**: JSON in and JSON out for everything except QWK/REP binary transfers
- **Tokens**: issued from the user profile page or `/admin/api-tokens`; shown exactly once
- **Call logging**: every successful API call is recorded in the caller log (source `QWK-API`) with logoncount bump throttled per user

Tokens grant the same access the calling user has in terminal/web -- banned users' tokens are rejected at auth time. Put the system behind HTTPS (reverse proxy TLS termination) before handing out tokens.

## Endpoints

| Endpoint | Method | Auth | Scope | Purpose |
|---|---|---|---|---|
| `/api/v1/ping` | GET | none | -- | Health check |
| `/api/v1/me` | GET | required | any | Who am I (profile summary) |
| `/api/v1/qwk/download` | POST | required | `qwk` | Build + stream personal QWK packet |
| `/api/v1/qwk/upload` | POST | required | `qwk_rw` | Import REP packet |

Authentication errors return JSON: `401 auth_required`, `401 invalid_token`, `403 insufficient_scope`, `403 account_restricted`. Unknown paths under `/api/v1` also return JSON 404 (not the HTML error page).

### GET /api/v1/ping

No auth required. Returns `{ ok: true, version: "v1" }`. Use to verify the API is reachable and the namespace is correct.

### GET /api/v1/me

Requires any active token. Returns the authenticated user's summary:

```json
{
  "user": {
    "id": 42,
    "username": "bob",
    "security": 50,
    "mailaddress": "bob@example.org"
  },
  "token": {
    "label": "iPhone QWK reader",
    "scope": "qwk_rw",
    "last_used_at": "2026-04-10T12:34:56Z"
  }
}
```

Useful for confirming that a newly issued token is wired up correctly before scripting against the full endpoints.

### POST /api/v1/qwk/download

Requires scope `qwk` (or `qwk_rw`, which implies `qwk`). Builds a personal QWK packet containing new messages from the caller's subscribed message areas (respecting scan pointers) plus unread PMs.

- **Request body**: none
- **Success (200)**: `Content-Type: application/octet-stream`, `Content-Disposition: attachment; filename=<bbsid>.qwk`. Response headers include `X-Qwk-Message-Count` and `X-Qwk-Area-Count`. Body is the raw `.qwk` ZIP.
- **Nothing new (204)**: empty body, no headers -- the caller's pointers are already up to date.
- **Auth errors**: JSON 401/403 as above.

Scan pointers advance on successful download so subsequent calls only return newer messages.

### POST /api/v1/qwk/upload

Requires scope `qwk_rw`. Imports a REP packet and posts each reply through the same code path as interactive posting (access control, dupe check, threading, outbound federation all run).

Two body formats are accepted so both form-based and scripted clients work:

1. **Multipart**: field name `rep`, file upload. 10 MB limit.
2. **Raw**: `Content-Type: application/octet-stream`, body is the REP ZIP. 10 MB limit.

Response is JSON:

```json
{
  "ok": true,
  "posted": 3,
  "errors": []
}
```

`posted` is the number of successful replies; `errors` is an array of per-reply failure descriptions (access denied, unknown area, etc.). A partial success still returns `ok: true` -- inspect `errors.length` to tell.

## Token Scopes

| Scope | Can do |
|---|---|
| `qwk` | Call `/api/v1/qwk/download` and any read-only endpoints |
| `qwk_rw` | Everything `qwk` can do, plus `/api/v1/qwk/upload` |

`qwk_rw` implicitly grants `qwk`, so issuing a read/write token is sufficient for a two-way reader. More scopes will be added as endpoints grow (`pm`, `files`, `admin`, etc.) -- existing tokens are unaffected when new scopes appear.

## Issuing Tokens

### As a user

1. Log in to the web UI and go to **Profile** (top-right menu).
2. Scroll to the **API Tokens** card.
3. Click **New Token**, give it a descriptive label (e.g. "iPhone MultiMail"), pick a scope, and submit.
4. **Copy the token value immediately** -- it is displayed exactly once, in a green alert near the top of the page. Navigating away or refreshing discards the plaintext permanently. The stored form is a bcrypt hash, so nobody (including you or the sysop) can recover it later.
5. If you lose a token, revoke it and issue a new one.

Token format: `canectic_<random>`. The `canectic_` prefix is grep-friendly so you can spot leaked tokens in logs or configs.

### As a sysop (on behalf of a user)

1. Go to **Admin -> Users -> API Tokens** (or visit `/admin/api-tokens` directly).
2. Click **Issue Token**, enter the target user's username, label, scope, and optional expiry.
3. Submit -- the plaintext is flashed once on the admin page. Copy it and send it to the user over a secure channel.

Use this for support cases (helping a user set up their offline reader) or service accounts.

## Revoking and Deleting Tokens

Revoking marks a token inactive so it stops authenticating, but keeps the row for audit. Deleting removes the row entirely. Revoke by default; delete only when you are sure you no longer need the history.

- **User**: Profile page -> API Tokens card -> revoke or delete button
- **Sysop**: `/admin/api-tokens` -> revoke or delete button on the target row

Revocation takes effect immediately -- the next request using the token returns `401 invalid_token`.

## Call Logging and Logoncount

Every successful API call appears in the caller log with `source=QWK-API` so you can see API activity alongside terminal and web sessions at `/admin/callers`.

To balance "active users show as regulars" against "polling clients don't inflate metrics", logoncount is throttled:

- First API call from a user, or first call after the throttle window elapses: a normal caller log entry is created and `logoncount` is bumped by 1.
- Subsequent calls within the window: a lightweight caller log row is written (endtime=starttime, duration=0), `lastlogon` is updated, but `logoncount` is **not** bumped.

The window is controlled by the `api_call_count_interval_hours` config key (default: 4). Set it to `0` to bump logoncount on every call, or raise it (e.g. 24) for heavy polling clients.

## Template Event Integration

The built-in event `user_qwk_fetched` fires after every successful QWK download or upload. Attach a [message template](TEMPLATES.md) to it to:

- Send a confirmation PM when a user downloads a packet
- Log API usage via notification
- Fire a welcome message on the first packet fetch

Context variables available in the template:

| Variable | Description |
|---|---|
| `{user.*}` | All standard user fields |
| `{event.kind}` | `download` or `upload` |
| `{event.area_count}` | Number of areas included (download only) |
| `{event.message_count}` | Number of messages packaged (download only) |
| `{event.posted_count}` | Number of replies successfully imported (upload only) |
| `{event.error_count}` | Number of rejected replies (upload only) |

Templates are optional -- the event fires whether you have one attached or not.

## Client Examples

### curl: download a QWK packet

```bash
curl -sS -o mypacket.qwk \
  -X POST \
  -H "Authorization: Bearer canectic_..." \
  https://bbs.example.org/api/v1/qwk/download
```

On success you get `mypacket.qwk` on disk. A 204 response writes nothing (no new mail).

### curl: upload a REP packet (raw body)

```bash
curl -sS \
  -X POST \
  -H "Authorization: Bearer canectic_..." \
  -H "Content-Type: application/octet-stream" \
  --data-binary @myreplies.rep \
  https://bbs.example.org/api/v1/qwk/upload
```

### curl: upload a REP packet (multipart)

```bash
curl -sS \
  -X POST \
  -H "Authorization: Bearer canectic_..." \
  -F "rep=@myreplies.rep" \
  https://bbs.example.org/api/v1/qwk/upload
```

### Node.js polling script

```js
import fs from 'fs';
import fetch from 'node-fetch';

const TOKEN = process.env.CANECTIC_TOKEN;
const BASE = 'https://bbs.example.org/api/v1';

// Download
var res = await fetch(BASE + '/qwk/download', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + TOKEN }
});

if (res.status === 204) {
  console.log('No new mail');
} else if (res.ok) {
  var buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync('packet.qwk', buf);
  console.log('Got', res.headers.get('x-qwk-message-count'), 'messages');
}

// ... user reads and replies offline ...

// Upload
var rep = fs.readFileSync('replies.rep');
var upRes = await fetch(BASE + '/qwk/upload', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer ' + TOKEN,
    'Content-Type': 'application/octet-stream'
  },
  body: rep
});
var result = await upRes.json();
console.log('Posted', result.posted, 'errors:', result.errors);
```

## Operational Notes

- **HTTPS**: do not deploy `/api/v1` over plain HTTP. Tokens are long-lived credentials. Terminate TLS at your reverse proxy (nginx/Caddy/HAProxy).
- **CSRF**: the `/api/*` path is exempt from CSRF middleware because Bearer auth is not vulnerable the way cookie auth is. Do not add cookie-authenticated endpoints under `/api/*`.
- **Rate limiting**: there is no built-in rate limit yet. If you expose the API to the open internet and notice abuse, block by IP at your reverse proxy or use fail2ban against the `401 invalid_token` log lines.
- **Token storage**: tokens are stored as bcrypt hashes with the same cost factor as user passwords. Leaked tokens cannot be recovered from the database -- only verified against.
- **Expiry**: tokens can have an optional `expires_at`. Leave blank for no expiry. Expired tokens still show in the UI but fail auth.
- **Monitoring**: watch the caller log for the `QWK-API` source and the application log for `[api]` entries. Every auth failure logs the reason at info level.

## Planned Endpoints

The `/api/v1` namespace will grow as needs emerge. Currently on the radar:

- **PM**: list inbox, read message, compose + send, attachment upload/download
- **Files**: browse areas, list new files, download, upload with DIZ extraction
- **Stats**: who's online, caller log, system stats
- **Admin**: user management, peer polling, toss triggers (requires a new `admin` scope)

When a new endpoint appears it will be added to the table at the top of this document. Breaking changes (if any) will ship under `/api/v2` and both versions will run side by side.

## Reference

- Architecture / design notes: [../reference/API_DESIGN.md](../reference/API_DESIGN.md)
- Message template integration: [TEMPLATES.md](TEMPLATES.md)
- Caller log viewing: admin panel -> Users -> Caller Log
