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

## Tier 1 — in-range, no code changes

Already permitted by existing caret ranges; `npm update` takes them.

```
dotenv 17.3.1 -> 17.4.2      morgan 1.10.1 -> 1.12.0     multer 2.1.1 -> 2.3.0
pg 8.18.0 -> 8.23.0          pug 3.0.3 -> 3.0.4          sanitize-html 2.17.1 -> 2.17.7
ssh2-sftp-client 12.1.0 -> 12.1.1                        ws 8.19.0 -> 8.21.3
```

## Tier 2 — majors that are low risk for our usage

None of these are required for Node 26; they are housekeeping.

| Upgrade | Why it is safe here |
|---|---|
| `adm-zip` 0.5 → 0.6 | **Fixes CVE-2026-39244**: a malicious archive declaring a huge uncompressed size could force unbounded memory allocation. We extract archives arriving over FTN, so untrusted zips do reach this code. The one breaking change is `extractEntryTo()` preserving subdirectories instead of flattening — and we never call it. Our surface is `new AdmZip(path)`, `.getEntries()`, `.extractAllTo()`. |
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
