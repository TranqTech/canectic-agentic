# Dependency Audit

Snapshot taken 2026-09-04. Local development runs Node v24.13.1, where every
current pin works. **The target is Node 26**, which is what new systems will
install, and that is where the breakage appears.

Every dependency uses a caret range, so "pinned" below means the floor of that
range. `npm outdated` reports **20 outdated, 10 of them major** — but only one
package actually blocks Node 26.

---

## The blocker: better-sqlite3

`better-sqlite3` is the **only** dependency whose engines range excludes Node 26:

```
better-sqlite3 12.6.2   engines.node = 20.x || 22.x || 23.x || 24.x || 25.x
```

Every other package either declares an open lower bound (`>=18`, `>=20`, `>=22`)
or no constraint at all, and all of those admit 26.

**Why a fresh install fails rather than resolving past it.** The caret range
`^12.6.2` would permit a newer 12.x, but `package-lock.json` pins the exact
version:

```
package-lock.json -> node_modules/better-sqlite3 = 12.6.2   (lockfileVersion 3)
```

`npm ci`, and `npm install` honouring the lockfile, therefore install 12.6.2 on
the new box and hit `EBADENGINE` on Node 26. The dependency graph is not at
fault; the lockfile is holding an old version in place.

**Node 26 support arrived in 12.10.0:**

| Version | engines.node |
|---|---|
| 12.6.2 | `20.x \|\| 22.x \|\| 23.x \|\| 24.x \|\| 25.x` |
| 12.9.0 | `20.x \|\| 22.x \|\| 23.x \|\| 24.x \|\| 25.x` |
| **12.10.0** | `20.x \|\| 22.x \|\| 23.x \|\| 24.x \|\| 25.x \|\| 26.x` |
| 13.0.3 | `>=22` |

### Two ways to fix it

**Minimal:** raise the floor to `^12.10.0` and refresh the lockfile. No major
version, no API change, unblocks Node 26 today.

**Durable:** go to `^13`. v13 is *"the first version of better-sqlite3 to run on
the N-API"*. That matters because it is the difference between a binding tied to
V8 internals — which must be rebuilt for every Node major, which is precisely
this problem — and an ABI-stable one that keeps working across future releases.
v13 also ships prebuilt binaries with the package rather than fetching them via
`prebuild-install`.

**Recommendation: go to 13.** The minimal fix buys one Node release; the N-API
move stops this recurring. Blast radius is a single import site (the Synchronet
message base shim), and v13 documents no API-breaking changes — only additions
(`db.explain()`, `preparedStatement.toString()`).

## The other three natives are already safe

Native addons are the usual casualty of a Node major bump, so worth stating
explicitly: the rest are **N-API based and therefore ABI-stable**.

| Module | Binding | Node 26 |
|---|---|---|
| `bcrypt` 6.0.0 | node-addon-api / node-gyp-build, napi in `binding.gyp` | fine |
| `node-pty` 1.1.0 | node-addon-api / node-gyp-build, napi in `binding.gyp` | fine |
| `serialport` 13.0.0 | via `@serialport/bindings-cpp` 13.0.0, node-addon-api | fine |
| `better-sqlite3` 12.x | **not** N-API | **blocked** |

On this Node 24 box all four load cleanly, and `better-sqlite3` is built from
source (`node_modules/better-sqlite3/build/Release/`), which is also why a
machine without `build-essential` and `python3` fails at install.

---

## Tier 0 — dead weight, remove first

Nothing to test, and it shrinks everything downstream.

| Package | Finding |
|---|---|
| `mongodb ^7.1.0` | **Zero references** outside `package.json`. The platform is PostgreSQL, Redis and better-sqlite3. |
| `path ^0.12.7` | Userland shim for the built-in. Bare `path` specifiers resolve to the core module regardless, so it is inert. 72 files import `path`; all get the built-in. |
| `@xterm/xterm`, `@xterm/addon-fit` | Browser libraries. What is actually served is hand-vendored in `public/js/xterm/` and `public/css/xterm.css` (dated 28 Mar); no build step copies from `node_modules`. **Judgement call:** unused at runtime, but they record the provenance of the vendored copies. Keep as documented source, or remove and note the vendored version somewhere. |

`ssh2-sftp-client` looks unused to a static grep but is **not** — it is lazily
loaded at `qwkTransport.js:236`. Keep it.

## Tier 1 — in-range, no code changes  *(DONE 2026-09-04)*

Applied via `npm update`.

```
dotenv 17.3.1 -> 17.4.2      morgan 1.10.1 -> 1.12.0     multer 2.1.1 -> 2.3.0
pg 8.18.0 -> 8.23.0          pug 3.0.3 -> 3.0.4          sanitize-html 2.17.1 -> 2.17.7
ssh2-sftp-client 12.1.0 -> 12.1.1                        ws 8.19.0 -> 8.21.3
```

## Tier 2 — majors that are low risk for our usage

None of these are required for Node 26; they are housekeeping.

| Upgrade | Why it is safe here |
|---|---|
| `adm-zip` 0.5 → 0.6 **(DONE)** | **Fixes CVE-2026-39244**: a malicious archive declaring a huge uncompressed size could force unbounded memory allocation. We extract archives arriving over FTN, so untrusted zips do reach this code. The one breaking change is `extractEntryTo()` preserving subdirectories instead of flattening — and we never call it. Our surface is `new AdmZip(path)`, `.getEntries()`, `.extractAllTo()`. |
| `uuid` 13 → 14 | Needs Node 20+ and a global `crypto`. The `v4` export is unchanged and **all 37 import sites use exactly `{ v4 as uuidv4 }`**. The v14 fix hardens `v3`/`v5`/`v6` against a bad offset; we call none of them. |
| `chalk` 5 → 6 | Requires Node 22+. We use plain colour methods only (`gray`, `red`, `bold`, `blueBright` …), no builder or template-literal API. |
| `file-type` 21 → 22 | Requires Node 22+. Single import site. |
| `basic-ftp` 5 → 6 | Surface is `ftp.Client`, `ftp.verbose`, `access`, `list`, `uploadFrom`, `downloadTo`, `close`; engines unchanged at `>=10`. Narrow enough that one QWK FTP poll smoke-tests it. Check its changelog before merging. |
| `mocha` 11 → 12 | Dev only. The 2642-test suite is the check. |

## Tier 3 — majors needing a deliberate decision

### `ioredis` 5 → 6 and `redis` (node-redis) 5 → 6

Both make **RESP3 the default wire protocol**, changing reply shapes. Both offer
an explicit opt-out, which makes them low risk if taken:

- ioredis: `protocol: 2` in connection options
- node-redis: `createClient({ RESP: 2 })`

Upgrade with RESP2 pinned, then move to RESP3 separately, so a protocol change is
never entangled with a version bump.

Two node-redis defaults change even on RESP2:

- `commandOptions.timeout` `undefined` → **5000 ms**. Anything slow now throws
  where it previously waited.
- `socket.keepAliveInitialDelay` 5000 → 30000 ms.

Both now require Node >= 20.

### `bullmq` 5 → 6

v5 bundles `ioredis 5.9.3` as a dependency; **v6 does not**. v6 declares
`ioredis`, `redis`, `pg` and `bullmq-otel` as peers and **all four are
optional**, so nothing new is forced on us. We already depend on `ioredis`
directly and build the connection ourselves in `src/queues/connection.js`, which
is the shape v6 expects.

The consequence: ioredis is no longer version-locked by BullMQ, so the ioredis
5→6 decision becomes ours alone. Settle ioredis first with RESP2 pinned, then
BullMQ.

Blast radius is the whole four-process model — the `toss`, `mailer` and
`maintenance` queues, the schedulers, and embedded mode. Its own change, its own
verification pass.

### `nodemailer` 8 → 9

One breaking change: **TLS certificates are validated by default** when fetching
remote content (attachment `href`/`path` URLs, OAuth2 token endpoints, proxy
CONNECT). Self-signed, expired or hostname-mismatched certificates now fail.

`docs/sysop/MAIL.md` documents relaying through a local Postfix, and local
relays commonly present self-signed certificates. The escape hatch is
`tls.rejectUnauthorized = false`, which should be a recorded config decision
rather than a silent default.

---

## The engines question this forces

`package.json` declares `"node": ">=18.0.0"`, and `README.md` says "Node.js 18+".
Both are already behind reality, and Tier 2 pushes the real floor up:

| Package | Latest requires |
|---|---|
| `chalk` 6, `file-type` 22, `better-sqlite3` 13 | Node >= 22 |
| `ioredis` 6, `redis` 6, `uuid` 14 | Node >= 20 |
| `mocha` 12 | `^20.19.0 \|\| >=22.12.0` |

Taking Tier 2 and Tier 3 makes the declared floor **Node >= 22**. Update
`engines`, `README.md` and `docs/sysop/INSTALL.md` in the same change, so a sysop
on Node 18 gets a clear install-time failure rather than a confusing runtime one.

## Suggested order

1. **better-sqlite3 → `^13`, refresh the lockfile.** This alone unblocks Node 26
   and is what the new hub needs. Verify a Synchronet JS door opens its message
   base.
2. Tier 0 removals; `npm install`; run the suite.
3. Tier 1 `npm update`; run the suite.
4. Tier 2 as one change (`adm-zip` carries the CVE fix).
5. `ioredis` 6 and `redis` 6 with RESP2 pinned, as one change, exercised against
   a real toss and a terminal session.
6. `bullmq` 6 on its own, exercised across all four processes.
7. `nodemailer` 9 with a decision recorded about `rejectUnauthorized`.
8. Raise `engines` to `>=22`; update README and INSTALL together.

Steps 2 onward are housekeeping and can wait. Only step 1 is required for Node 26.

---

## Reachability review of `npm audit`

`npm audit` reports **17 advisories (10 high)**. Counting them is misleading:
most are not reachable in this codebase. Assessed against how Canectic actually
uses each package.

### Genuinely reachable — act on these

| Package | Severity | Why it is reachable | Fix |
|---|---|---|---|
| `ws` 8.19.0 | high | Uninitialised memory disclosure and memory-exhaustion DoS from tiny fragments. We run **internet-facing** WebSocket servers: terminal pools, PresenceSocket, NodeSpy snoop. Frames are attacker-controlled. | in-range → 8.21.3 |
| `adm-zip` 0.5.16 | high | Crafted ZIP forces a 4GB allocation. We extract archives arriving **over FTN** (nodelist and echolist scanning, TIC files, FILE_ID.DIZ). Untrusted input from peers. | 0.6.0 (Tier 2) |
| `multer` 2.1.1 | high | DoS via deeply nested field names, and incomplete cleanup of aborted uploads. Reachable through the file-area upload and message base import endpoints. Requires an authenticated user. | in-range → 2.3.0 |
| `qs` 6.15.0 | moderate | DoS via attacker-controlled `isBuffer`, array-limit bypass. Pulled by `express` and `body-parser`, so it parses the query string of **every** request. | in-range |
| `basic-ftp` 5.2.0 | high | A malicious FTP server can DoS the client through unbounded multiline control-response buffering, and `Client.list()` has unbounded memory growth. Reachable when polling a QWK hub over FTP. The CRLF-injection-via-credentials path is **not** reachable: credentials come from sysop config, not from an attacker. | v6 (major) |

### Not reachable — no action needed on their own merit

| Package | Severity | Why not |
|---|---|---|
| `serialize-javascript` | high (RCE) | Pulled only by `mocha`. **Dev dependency**, never deployed. |
| `js-yaml` | high | Pulled only by `mocha`. Dev only. |
| `brace-expansion` | high | Reaches us only via `minimatch` ← `glob` ← `mocha`. Dev only. |
| `sanitize-html` | moderate | **Imported in `routes/index.js` and `routes/admin.js` but never called.** Message sanitisation is hand-rolled in `messages.js:71` (`sanitizeMessageFields`). Dead import. |
| `postcss` | high | Enters only through `sanitize-html`, which is never called. |
| `nanoid` | high | Enters only through `postcss` ← `sanitize-html`. |
| `uuid` (v3/v5/v6 buffer bounds) | moderate | We use **`v4` only**, at all 37 import sites. The affected functions are never called. Same for the copy bundled inside `bullmq`. |
| `morgan` | moderate | Log forging via `:remote-user`. Imported at `webserver.js:6` but the middleware is **commented out** at `webserver.js:39`. |
| `body-parser` | moderate | DoS when an *invalid* limit value silently disables size enforcement. Our limits are valid (`'250mb'`, `parameterLimit: 50000`), so enforcement is active. Fix is free and in-range regardless. |
| `nodemailer` | high | The listed vectors need APIs we do not use: no `name` transport option (CRLF into EHLO/HELO), no `jsonTransport`, no message-level `raw`, no `List-*` headers, and no OAuth2 (we authenticate with user/password). Our transport passes only host, port, secure, auth and requireTLS. |

### What this means in practice

Four of the five reachable issues are closed by **`npm update` alone** — `ws`,
`multer`, `qs` and `body-parser` are all in-range. Combined with `adm-zip` 0.6.0
from Tier 2, that clears everything reachable except `basic-ftp`, which needs its
major and only matters when polling a QWK hub over FTP.

None of the high-severity advisories that sound most alarming — the
`serialize-javascript` RCE, `postcss` path traversal, `js-yaml` DoS — are
reachable in a deployed Canectic.

### Separate finding worth its own look

`sanitize-html` is a declared dependency, imported in two route files, and never
called. Message `body_html` is produced by `formatBodyHtml()` and sanitised by a
hand-rolled `sanitizeMessageFields()` in `messages.js`. Message bodies arrive
from FTN, QWK and NNTP and are rendered in the web UI, so the sanitiser sits on
an untrusted path. Either wire `sanitize-html` up or drop the dependency and the
dead imports, but the hand-rolled sanitiser deserves review on its own merits
rather than being left implicit. Not a dependency problem, so not tracked here.

---

## Status after the 2026-09-04 pass

Tier 1 (`npm update`) and `adm-zip` 0.6.0 are applied. `npm audit` went from
**17 advisories (10 high) to 4**, and **every reachable one is cleared**:

| Package | Now |
|---|---|
| `ws` | 8.21.3 |
| `multer` | 2.3.0 |
| `qs` | 6.16.0 |
| `body-parser` | 2.3.0 |
| `adm-zip` | 0.6.0 |
| `basic-ftp` | **5.3.1** |

`basic-ftp` resolved within the 5.x line: the advisory covered `<=5.3.0`, and
5.3.1 carries the fix, so the v6 major listed in Tier 2 is **not** required for
security. Evaluate it on its own merits or leave it.

The 4 remaining advisories are all unreachable in a deployed system:

- `diff` and `serialize-javascript` — both reach us only through `mocha`, a dev
  dependency
- `nodemailer` — only the message-level `raw` option advisory remains, and we
  never pass `raw`

Verified: 2642 tests pass; the adm-zip call sites are exercised by
`fileDescExtractor` and `ftnTosser.extractMailBundle` tests, including the
subdirectory case; the two untested sites (`qwkClasses.js`, `nodelistImport.js`)
use `extractAllTo` and `getEntries`, neither of which changed in 0.6. All four
processes restarted with no errors, HTTP serves 200 and a WebSocket upgrade
returns 101.

---

## Completed 2026-09-04: everything on latest

All tiers applied in one pass. `npm outdated` is empty and `npm audit` reports
**0 vulnerabilities**.

| Package | From | To |
|---|---|---|
| better-sqlite3 | 12.6.2 | **13.0.3** |
| bullmq | 5.71.0 | **6.3.4** |
| ioredis | 5.10.1 | **6.0.0** |
| redis | 5.11.0 | **6.2.1** |
| nodemailer | 8.0.4 | **10.0.0** |
| uuid | 13.0.0 | **14.0.2** |
| chalk | 5.6.2 | **6.0.0** |
| file-type | 21.3.3 | **22.0.2** |
| basic-ftp | 5.2.0 | **6.2.1** |
| adm-zip | 0.5.16 | **0.6.0** |
| mocha (dev) | 11.3.0 | **12.0.0** |
| ws, multer, qs, body-parser, pg, pug, dotenv, morgan, sanitize-html, ssh2-sftp-client | | latest |

Removed: `mongodb` (zero references) and `path` (inert shim for the built-in).

### Code changes required

Only two, both pinning the wire protocol so a version bump does not silently
change reply shapes:

- `src/middleware/db/redis.js` — `createClient({ url, RESP: 2 })`
- `src/queues/connection.js` — `protocol: 2` on both config paths

node-redis 6 and ioredis 6 default to RESP3. Adopting RESP3 remains available as
its own deliberate change.

BullMQ 6 needed **no** code change: it moved `ioredis` to an optional peer, and
we already depend on it directly and construct the connection ourselves.
Similarly nodemailer 10 needed none, since our transport passes only host, port,
secure, auth and requireTLS.

### Verification

- 2642 tests pass, including on mocha 12
- Live check against the running Redis: node-redis 6 string, hash and TTL round
  trips, with the hash returned as a plain object (RESP3 would differ); ioredis 6
  string and hash round trips; BullMQ 6 job enqueued, received by a worker and
  completed with a return value
- A real `recalc-area-counts` job enqueued through the CLI was picked up and
  completed by the running worker process
- All four processes restarted with zero errors; HTTP endpoints serve 200

### Node floor

`engines` is `>=22.0.0`. The binding constraints are `better-sqlite3` 13,
`chalk` 6 and `file-type` 22 at Node >= 22; `ioredis` 6, `redis` 6, `uuid` 14
and `nodemailer` 10 need >= 20. Node 26 installs cleanly.
