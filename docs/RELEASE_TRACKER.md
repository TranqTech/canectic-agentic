# Canectic BBS - Release Tracker

Status tracking for releases.

Last updated: 2026-09-13

---

## Legend

- `[x]` - Complete
- `[-]` - In progress
- `[ ]` - Not started
- `[~]` - Partial / works but needs improvement

---

## Core Systems

### Terminal
- [x] Terminal server (auto-detect TCP/Telnet, WebSocket)
- [x] Terminal negotiation (NAWS, SGA, binary mode, sixel detection)
- [x] Menu system (hotkey + lightbar modes, margin layout, auto columns, fill order, vertical centering, art-defined mode)
- [x] Art code system (universal @ codes in all art files, menu entry/UI positioning codes)
- [x] Menu entry drag-to-reorder in admin
- [x] Default menu entries on new menu creation (redrawMenu)
- [x] Message area selector (lightbar)
- [x] Message reader (threaded, scroll viewport, quoting)
- [x] Message editor (full-screen, word wrap, quote system)
- [x] Newscan (new message scan across areas)
- [x] File area selector (lightbar)
- [x] File browser (list, detail, download)
- [x] File upload (ZMODEM)
- [x] Batch file download (tag + XMODEM/ZMODEM)
- [x] File search
- [x] Private mail reader (inbox/sent/trash, compose, reply)
- [x] Private mail editor (LOCAL + FTN/QWK/EMAIL transports)
- [x] Unread mail check (call flow stage + menu command)
- [x] Last callers display (source column, current caller highlight)
- [x] Who's online (terminal nodes + web presence, conditional call flow stage)
- [x] User list
- [x] Door game support (NativeShell, ExecNative, SpawnNative, Dosemu, DosemuPty)
- [x] Door browser (collection navigation, description panel, ANSI colour rendering)
- [x] Announcement viewer (scrolling viewport, arrow navigation, call flow + menu command)
- [x] Mail verification handler (call flow + menu command, send/enter/change address)
- [x] Registration with gender selection (hotkey selector)
- [x] Password reset handler (pre-login token + post-login change)
- [x] News file viewer (ANSI/ASCII art display with centering, menu command + call flow)
- [x] Moderation in the reader: delete and move on D and M, confirmed, with a
      scope question when a thread is on screen and a lightbar list of the
      destinations that message's own answer allows. The dumb-terminal path gets
      the same operations with a numbered list. The reader reads `.moderation`
      off the message rather than deciding for itself
- [x] Art code stat lookups no longer stall a redraw. `@TC@`/`@TU@`/`@ON@` cache
      per code and race a refresh against `art_stat_timeout_ms`, returning the
      last known value on timeout while the refresh fills the cache. A catch
      alone was not enough: both clients retry internally, so an outage produced
      a hang rather than a rejection
- [~] ZMODEM (works with most clients, known issue with IcyTerm both directions)

### Web
- [x] Login page (caller log on login)
- [x] Registration page (6-step wizard, AJAX validation, gender, auto-login, caller log)
- [x] User profile page (read-only, verification status badge)
- [x] Mail verification page (send code, enter code, change address, days remaining)
- [x] Public message browsing (groups, areas, threads)
- [x] Message posting (new thread, reply)
- [x] File browsing (groups, areas, file detail)
- [x] File download
- [x] File upload (multipart, hash check, DIZ extraction)
- [x] Private mail webmail UI (inbox/sent/trash, compose local + network, reply)
- [x] Landing page with announcements (logged-in user detection)
- [x] Bootstrap 5 Darkly theme, responsive layout
- [x] DataTables for sortable/searchable lists
- [x] TinyMCE rich text editor
- [x] User profile editing (username cooldown, name, location, gender, inline password change)
- [x] Door listing with collections (card layout, play + more info buttons)
- [x] Web door launcher (xterm.js, fractional scaling, mobile-responsive, return to collection)
- [x] Web activity tracking (session renewal, idle detection, presence)
- [x] Who's online (web presence integration, activity labels)
- [x] Last callers page (web view of recent callers, reusable partial)
- [x] Who's online page (web view of terminal nodes + web presence, reusable partial)
- [x] Virtual call flow (web equivalent of the terminal login experience: announcements, last callers, who's online, wall, message newscan, file newscan)
- [x] Call flow no longer forces itself forever on a session that a completion
      broadcast missed. The username index is refreshed on session renew, the
      completing session is always written directly, and loading the call flow
      reconciles its cached timestamp against the database
- [x] Message moderation from the content views: thread delete in the thread
      header, per-message delete in both thread and flat views, and move. Never
      on the area thread list, which shows subjects only, so deleting from it
      would be blind. The check is in the routes as well as the templates
- [x] Message areas list sort toggle (sysop ordering or most recently active,
      within each group, remembered in `localStorage`), and a last-message
      column that shows the year once a date is older than six months

### Admin Panel
- [x] Dashboard
- [x] Configuration (category accordion, per-category save, source badges)
- [x] Message groups CRUD
- [x] Message areas CRUD (per-area tables, access control)
- [x] File groups CRUD
- [x] File areas CRUD (scan, move, delete files)
- [x] Users CRUD (edit, password reset, flags, Unverified restriction)
- [x] Menus CRUD (tabbed modals, featured entries, colour cascade, dynamic arg selects, slug-safe IDs)
- [x] Doors CRUD (tabbed modals, TinyMCE descriptions, icon/media, launch types, variable substitution)
- [x] Door collections CRUD (create, reorder, assign doors)
- [x] Themes CRUD (colour categories, accordion editor, duplicate, set default, seed from JSON)
- [x] Peer connections (FTN/QWK/NNTP, enable/disable, poll settings)
- [x] Nodelists (import, browse, search, flag glossary)
- [x] Admin log viewer (WebSocket push, live tail)
- [x] Undeliverable PM queue (review, deliver, discard)
- [x] Announcements CRUD (TinyMCE editor, drag-to-reorder, pinning, scheduling)
- [x] Jobs & Maintenance page (manual trigger for all worker jobs by category)
- [x] SMB message base import (upload .shd/.sdt/.sid, preview, import to area)
- [x] areas.bbs import (upload, preview with per-area controls, create/map areas, sync peer subscriptions)
- [x] sbbsecho.ini import (two-step Synchronet linked node migration with drag-and-drop peer grouping)
- [x] Migrations hub (consolidated import/export tools page)
- [x] Network echolist registry (per-network echolist management, import, diff preview, historical tracking, sysop notifications)
- [x] Filebone registry (file echo list management, mirrors echolist system)
- [x] Combined echolist view (deduplicated cross-echolist areas, orphaned areas, subscribe/unmap modals)
- [x] Admin dashboard redesign (tabbed categories, icon cards, instant search, System tab default)
- [x] Admin message/thread deletion (per-message and per-thread with confirmation modals)
- [x] Queue status panel (view active/waiting/delayed/failed jobs, remove/retry/drain)
- [x] Thread rebuild maintenance tool (--rethread CLI, admin button)
- [x] Push group defaults to areas (security, flags, post_as, newscan)
- [x] Push file group defaults to areas (security, flags, newscan, retention)
- [x] Nodelist flag definitions (DB-backed, category, argument metadata, auto_managed, FTS-5001 seed)
- [x] Seed sync tool (`node src/tools/seedSync.js` -- upsert JSON seed data to DB)
- [x] Message templates (event-triggered sysop-authored messages with PM/email/netmail delivery, built-in + custom events, admin CRUD, manual fire, CLI, menu command, timed event integration)
- [x] API tokens (admin audit + revoke at /admin/api-tokens, per-user CRUD on profile page, Bearer auth, scopes, bcrypt hashing, one-time plaintext reveal)
- [x] JAM message base import (parser with spec-verified offsets, single-base preview/import UI, bulk scan-and-map directory import on the worker queue)
- [x] File area add/edit forms have a submit button again. Collapsing three forms
      into a shared mixin dropped it, and the conversion was checked by diffing
      element ids, which a submit input does not have. `tests/adminFormSubmit`
      now asserts every admin form has something to submit it with
- [x] Netmail Relay Log page (`/admin/relay-log`): stuck deliveries first, then
      counts by decision, every decision with a per-row detail view, and transit
      mail grouped by sender
- [x] Tabbed layout for the message group and file group create/edit forms and
      all three file area forms, with the three near-identical file area copies
      collapsed into one mixin
- [x] Post As on the new message group modal. The backend already read it; the
      form never sent it, so a group created there silently took the default
- [x] Mailer diagnostics (`/admin/mailer`): one row per session attempt in both
      directions including connects that never opened a socket, with outcome,
      files and bytes each way, the peer's banner and every AKA it presented
- [x] A refused admin request returns 403 rather than 500. requireAdmin rendered
      a template that did not exist, so the render threw and Express turned the
      refusal into a server error while the log said 403. JSON callers now get a
      JSON refusal, and every literal render target in src/routes is checked
      against the views directory by a test


### Message Networking
- [x] FTN tosser (inbound/outbound, type-2 packets, REPLY kludge)
- [x] Unified message threading across all tossers (messages.threadMessage, guaranteed thread creation, orphan reconciliation)
- [x] echomail.js/messages.js consolidation (single canonical model, no duplicate function definitions)
- [x] FTN binkp mailer (TCP + WebSocket transports)
- [x] BSO outbound scanner
- [x] QWK tosser (client pull/push, hub mode)
- [x] NNTP tosser (pull/push)
- [x] TIC file echo distribution
- [x] FTN nodelist import and routing
- [x] Batch subscribe from an echolist or filebone (per-network page, filter-aware
      select-all, one shared settings block, runs on the worker with a sysop
      notification; create-only)
- [x] Message retention limits (optional `max_age_days` / `max_messages` per area,
      group defaults, daily prune, admin preview before committing; both NULL by
      default so nothing prunes until opted in)
- [x] %RESCAN on AreaFix and FileFix (bare/ALL/*, optional day count, /FULL;
      windowed by default. Message areas rewind msg_idx, file areas re-queue
      distribution rows). Also a Rescan button per connection on the peer page
- [x] Outbound eligibility extracted to `evaluateOutbound()` and tested: imported
      history, don't-send-back-to-source, SEEN-BY (FTS-0004, compressed form),
      PATH. Does not consult source_network_id
- [x] Netmail packet password. Both writers now take it from the peer's
      `packet_password`, keyed on the packet destination so relayed mail gets the
      hop's password. Netmail previously used only the global `PacketPwd`, so a
      configured link sent authenticated echomail and unauthenticated netmail
- [x] Netmail relay decision log (`netmail_relay_log`): one row per decision
      including refusals, keeps message author apart from packet sender, links to
      the outbound row so "relayed but never sent" is answerable. Admin page at
      `/admin/relay-log`, CLI `src/tools/relayLog.js`, 180-day retention
- [x] Inbound backstop covers arcmail bundles, not just `.pkt`, via a predicate
      shared with the tosser so the two cannot drift
- [x] Netmail relay modes: `netmail_relay_mode` is `off`, `nodelist` or `on`,
      defaulting to `nodelist`, which requires both ends to be listed in the
      same network's nodelist. The old `allow_netmail_relay` boolean's "on" was
      an open relay between every network this system carries, because route
      resolution walks the nodelist and the coordinator tree. Deprecated and
      ignored. Sysop guide at `docs/sysop/NETMAIL_RELAY.md`
- [x] Relayed netmail no longer misreports its origin. The message header says
      who wrote it and the packet header says who handed the packet over; the
      two were swapped on every transit message, so replies went to the wrong
      system. `resolveOutboundSource()` answers both in one tested place
- [x] Via chain: written on relay, parsed on inbound keeping the raw line, and
      used for loop refusal on the bare address. An enabled relay
      previously had no loop protection at all
- [x] Netmail addressed to Ping answered with a Pong showing the Via chain the
      request accumulated. Replies from the address the ping was aimed at, not
      the default AKA. Config `netmail_ping_enabled`
- [x] Mailer session history (`mailer_sessions`): one row per attempt in both
      directions, including connects that never opened a socket, since the peer
      failing hardest is the one that never gets far enough to have a session.
      Plus `outbound_file_log`, written on M_GOT so a row means the peer
      acknowledged the file
- [x] Connect backoff moved to `_connectToPeer`, the choke point every outbound
      path passes. It was in `pollConnection` only, so the BSO scanner bypassed
      it entirely whenever mail was waiting. Nodelist-routed addresses, which
      have no peer row to hold state, get an in-memory equivalent
- [x] Flow files with nothing left to send no longer trigger a session a minute.
      The scanner decides a node has mail from the filename, so a spent `.flo`
      read as pending work for ever. `floFile.pruneFlowFile()` marks vanished
      lines and deletes an exhausted file; `pendingCount()` is the honest answer
- [x] Poll interval changes from the admin UI apply immediately instead of at
      the next gateway restart, and deleting a connection removes its schedule.
      Nothing called `updateConnectionSchedule` despite its doc comment saying to
- [x] Deleting an area clears the echolist entries pointing at it. local_area_id
      is what makes an areatag read as locally carried, and area ids are reusable,
      so a stale pointer eventually names whichever area took the id rather than
      staying visibly broken. Reconciliation also clears pointers at areas that
      no longer exist, repairing databases that already carry them
- [x] Message dates that cannot be true are rejected at both ingest points
      (`echomail.ftnToDb` and `smbImport`), falling back to the receive time. A
      corrupt future date otherwise pins an area to the top of the recently
      active sort for ever and keeps it inside every retention window
- [ ] Peer interop: BBBS has no `%RESCAN` on either AreaFix or FileFix, so file
      echo backfill from a BBBS uplink needs the sysop to re-send by hand. Its
      FREQ support over binkp specifically is unverified. See PEER_INTEROP.md

### Private Messaging
- [x] Unified PM model (LOCAL, FTN, QWK, EMAIL)
- [x] Transport access control (permission + restriction flags)
- [x] Recipient resolution (username, realname, sysop alias)
- [x] Dupe checking
- [x] Bounce notifications (undeliverable to sender inbox)
- [x] Sysop notifications
- [x] Soft delete with trash purge
- [x] File attachments (pm_attachments table, disk storage, all transports)
- [x] FTN file-attach flag (inbound parse + outbound .flo flow file entries)
- [x] EMAIL MIME attachment extraction (inbound) and nodemailer passthrough (outbound)
- [x] IMAP BODYSTRUCTURE multipart/mixed with base64 attachment parts
- [x] Web multer upload on compose/reply, download with ownership check
- [x] Terminal attachment indicator text

### Session Management
- [x] Remember Me checkbox (configurable days, default 14)
- [x] Session TTL default 12 hours, per-session TTL storage for correct renewal
- [x] Log Out All Other Sessions (password protected, user profile)
- [x] Admin Kill Sessions button on user management

### Email Transport
- [x] Outbound via SMTP smart relay (nodemailer)
- [x] Inbound via trusted gateway (IP allowlist with IPv4 CIDR support)
- [x] SMTP submission accepts external addresses
- [x] IMAP rendering with real email addresses
- [x] Web compose with email validation
- [x] Config keys (relay, inbound port, trusted hosts)
- [x] Port/secure reconciliation (auto-correct for 465/587/25 mismatches, `requireTLS` on 587, TLS mismatch diagnostics)
- [x] Per-user sender identity on user-generated PMs (`<username>@<mail_domain>` address, `users.fullname` display name) while system messages use `email_from_address`/`email_from_name`
- [x] Inbound recipient verification for upstream mail gateways (VRFY command in trusted mode, empty-sender MAIL FROM / RCPT TO probe support, enhanced status codes on accept/reject, level-2 rejection logging)
- [x] Mode-aware EHLO (submission advertises AUTH, trusted advertises VRFY, both advertise PIPELINING/8BITMIME/SIZE)
- [x] Dotted-local-part fallback in `resolveRecipient` (matches `first.last` local-parts against `users.fullname` via dot-to-space transformation, round-tripping the IMAP adapter's outbound slugification convention)

### Mail Client Access
- [x] IMAP4rev1 server (INBOX, Sent, Trash, network addressing)
- [x] SMTP submission server (authenticated, multi-transport routing)
- [x] Cross-process PM events (IDLE push, read sync)
- [x] COPY/MOVE between mailboxes
- [x] IMAP PURGE/EXPUNGE

### User Verification
- [x] Verification code generation and sending (email + FTN netmail transports)
- [x] Auto-send on registration
- [x] Auto-send on address change
- [x] Unverified restriction flag on new accounts
- [x] Security level bump on verification (verified_security config)
- [x] Sysop auto-verified on promotion
- [x] Unverified account purge (configurable retention, daily maintenance)
- [x] Mail type auto-detection (email vs netmail, handles 5D FTN addresses)
- [x] User maintenance worker (reconcile mail types, purge unverified)
- [x] Terminal verification handler (call flow wrapper + menu command)
- [x] Web verification page (send, enter, change address, days remaining)

### Infrastructure
- [x] Four-process model (gateway, worker, mail, mailer)
- [x] PM2 ecosystem config
- [x] BullMQ job queues (toss, mailer, maintenance)
- [x] Redis pub/sub event bus
- [x] Centralized logging (alogger, Redis bus, admin viewer)
- [x] Configuration system (3-tier, admin UI, cross-process reload)
- [x] Config tier 1 reads the `.env` file from disk, not `process.env`, so a stale
      inherited environment (pm2 replaying `dump.pm2`) cannot silently beat a
      `.env` edit. Divergence is logged and shown on `/admin/config`
- [x] Apply a `.env` edit without restarting (Reload button on `/admin/config`,
      POST `/admin/config/reload`, fans out via CONFIG_CHANGED)
- [x] Database migrations (declarative schema management)
- [x] Version parsing and comparison (`src/utils/version.js`): the scheme the
      update system rests on. A development build carries the last stable plus
      its build date and sorts above the version it names, which is the rule
      that inverts every comparison if reversed. `baseStable()` derives a
      build's delta base from its own version
- [x] Settings provenance: `settings.source` records whether a value was chosen
      by a sysop or seeded from the defaults, which the table could not express
      before and which is what made a config key impossible to deprecate in
      place. Also fixes the `/admin/config` source badge, which reported the
      database for every seeded default
- [x] Migration ledger (`schema_migrations` + `db/migrations/`): ordered,
      recorded, one-shot data migrations, which the declarative schema cannot
      express because it converges on a shape rather than performing an event.
      Pre and post phases relative to the schema pass, manual migrations that
      are reported rather than run, one row per attempt so a failure is history,
      and a fresh database recorded as born current
- [x] Release engineering (`scripts/release.mjs` + `src/release/`): one command
      cuts a stable or a development build, closes the changelog `Pending`
      section into the version, writes the release note skeleton, builds the
      tarball with a content-hash `MANIFEST`, and publishes metadata, a
      per-channel index and `SHA256SUMS`. Upgrade steps and notices are declared
      in `docs/releases/pending.json` rather than living only as changelog
      prose. A stable cut refuses to publish if it drops a migration its own
      development builds already applied
- [x] Startup DB/Redis validation (fail fast with clear error)
- [x] Health check endpoint (GET /health)
- [x] Worker liveness. The worker publishes a heartbeat with its per-queue
      consumer state and the age of the longest job in flight; the gateway
      watches it, notifies the sysop, and restarts after a grace window with a
      cooldown and an attempt cap. Both queue processors are wrapped in a
      timeout, since BullMQ's stalled-job detection cannot see a job parked on an
      await that never settles, and three of those stop the pipeline silently
- [x] Queue diagnostics: `src/tools/schedules.js` reports the heartbeat, per-queue
      depth with active-job ages, and each scheduler's next run. A BullMQ
      scheduler is not a timer, so a `next` in the past means nothing is draining
      that queue
- [x] pm2 worker restart backoff. A flat delay with a 3s `min_uptime` burned all
      fifteen restarts inside a minute when a dependency was slow to start, after
      which pm2 left the process stopped for good
- [x] CSRF protection (Origin/Referer check middleware)
- [x] Install/update script (setup/install.sh)
- [x] .env.example template (examples/env.example)
- [x] Runtime portability: no hardcoded interpreter or Node version paths
      anywhere. `ecosystem.config.cjs` resolves the child interpreter at start
      time, `setup/canectic-pm2.sh` follows nvm's `default` alias with a plain
      PATH fallback so the same wrapper serves native Node installs
- [x] systemd boot unit routed through the installed wrapper, so an nvm Node
      upgrade no longer breaks boot (verified by cold boot, not just restart)
- [x] OS upgrade runbook (docs/sysop/OS_UPGRADE.md), written against a real
      24.04 to 26.04 run with PostgreSQL 16 to 18 and Redis 7 to 8
- [x] Node 26 target, Node 22 floor. Every dependency at its current release,
      `npm outdated` empty and `npm audit` at 0 from 17 advisories. `better-sqlite3`
      13 is N-API, so the native binary survives a Node major upgrade
- [x] npm 12 `allowScripts`: the three native modules plus `better-sqlite3`
      approved and pinned to version, three optional accelerators denied
      explicitly rather than omitted so the decision is visible
- [x] Both Redis clients pinned to RESP2 so the client majors could not silently
      change reply shapes. Adopting RESP3 is tracked separately as high priority
- [x] Schema maintenance reads a table's columns in one query rather than one
      per column, on both the static tables and the per-area message tables,
      sharing the reader so the two cannot drift. 31 areas went from 6.9s to
      0.47s and the static pass from 3.2s to 0.95s, paid on every migration run.
      The per-area varchar-to-TEXT widening is now conditional instead of two
      ALTER TABLE locks per area per run
- [x] Databases created as UTF8 explicitly, with `setup/convert_db_encoding.sh`
      to convert an existing SQL_ASCII database (invalid-byte preflight, row
      count verification, name swap so `.env` needs no edit)
- [x] Orphan job schedules removed automatically at gateway startup. Registration
      rebuilds the managed set from the database, so anything in a managed family
      it did not write has no row behind it and would otherwise fire its job for
      ever. Confined by an explicit allowlist, and only run after a registration
      pass that completed, since pruning against a half-built expected set would
      delete live schedules

### Testing
- [x] 3,278 tests passing (mocha)
- [x] Protocol tests (XMODEM, ZMODEM, binkp, EMSI/Wazoo)
- [x] Routing tests (FTN router, BSO scanner)
- [x] Parsing tests (TIC, QWK, nodelist, codepage, terminal)
- [x] Config and access control tests
- [x] Email transport tests
- [x] New feature tests (areaAccess, activityMap, wall, bulletins, announcements, systemStats, artCodes, qwkUser)
- [x] Message base parser tests (SMB, JAM) with synthesised binary fixtures
- [x] Redis and BullMQ integration tests (skip cleanly when Redis is unreachable)
- [x] Suite skips cleanly when PostgreSQL or Redis is unavailable, so a clean
      checkout can tell a real regression from a missing service. Both probes
      race against a bound and swallow the hang as well as the rejection, since
      each client retries internally and an await in a `before` hook turns a
      missing service into a hook timeout reported as a failure
- [x] Networking correctness tests: outbound eligibility, the Via chain, relay
      decisions, rescan grammar and pointer arithmetic, AreaFix end to end from
      netmail arrival to response body, flow file pruning
- [x] Worker health detection, schedule registration against a real BullMQ
      queue, and every admin form having something to submit it with

---

## Roadmap to 1.0

| # | Item | Status | Notes |
|---|------|--------|-------|
| 1 | Password reset flow | [x] | Pre-login code-based + web token link + post-login change |
| 2 | User profile editing | [x] | Username cooldown, name, location, gender, inline password change |
| 3 | Door menus and collections | [x] | Collections, terminal browser, web cards, TinyMCE descriptions, ANSI colour rendering |
| 4 | Door server BBS registration | [ ] | Register with door game servers |
| 5 | JAM message base import | [x] | JAM parser (spec-verified struct offsets, CP437, streaming), adapter reusing the FTN kludge splitter, single-base UI, bulk scan-and-map directory import on the worker queue, outbound high water mark seal. Shared import loop with SMB. |
| 6 | Full nodespy implementation | [x] | Web dashboard + live snoop + terminal command |
| 7 | Sysop chat | [x] | Break-in, split-screen DECSTBM chat from NodeSpy (web + terminal), chat queue |
| 8 | User QWK/REP packet handling | [x] | User-facing QWK packet download and REP packet upload for offline message reading |
| 9 | Wall / Oneliners | [x] | Public graffiti wall, terminal + web display, call flow integration |
| 10 | Bulletin system | [x] | DB-backed bulletins with admin CRUD, terminal selection menu + art file display, web list/view pages |
| 11 | System statistics | [x] | Terminal sysInfo command + call flow stage, web /stats page |
| 12 | New file scan | [x] | File area subscriptions (T key toggle in selector), new file scan command |
| 13 | Wall maintenance | [x] | Auto-purge (wall_max_messages config, default 60), admin delete at /admin/wall |
| 14 | Voting / polls | [ ] | Classic BBS voting booths |
| 15 | User-to-user telegrams | [x] | Send one-line message to another online user |
| 16 | Sysop chat for web users | [x] | Break-in chat with users browsing the web UI (presence-based, not terminal) |
| 17 | areas.bbs import | [x] | Parse areas.bbs from FTN hub, batch-create message areas + network mappings + peer subscriptions |
| 18 | Web art + seasonal art | [x] | Web art from txtfiles/webart/, random selection, seasonal overrides with admin CRUD, call flow welcome splash |
| 19 | Top 10 lists | [ ] | Top posters, top downloaders, most active users (week/month). Web page + terminal command |
| 20 | Birthday messages | [~] | Detection and delivery are done: the daily template sweep in `bin/worker.js` fires the built-in `user_birthday` event (with `event.age`) through `messageTemplates`, so a sysop can already send a birthday PM, email or netmail. The call flow greeting is still missing, which is the half this item was originally about. No `birthday` stage exists in `call_flows`, terminal or web. |
| 21 | FTN netmail file attach | [x] | Inbound: recognize file-attach flag, link received files to netmail PM. Outbound: place attachment in BSO for binkp delivery. |
| 22 | PM file attachments | [x] | Full attachment system across all transports (LOCAL, EMAIL, FTN, Web, IMAP, terminal indicator). pm_attachments table, disk storage, config limits. |
| 23 | Session management | [x] | Remember Me, configurable session TTL, Log Out All Other Sessions, admin kill sessions |
| 24 | AreaFix | [x] | Automated echomail area management via netmail commands (+subscribe, -unsubscribe, %LIST, %QUERY, %HELP, %PAUSE, %RESUME). Password auth, auto-response netmail. |
| 25 | FileFix | [x] | Automated TIC file area management via netmail commands (+subscribe, -unsubscribe, %LIST, %QUERY, %HELP, %PAUSE, %RESUME). Parallel to AreaFix. |
| 26 | FREQ (File Request) | [x] | Three-layer resolver (magic aliases, filebox, file entries). Inbound .req processing in binkp. Outbound .req via admin. Auto-generated file listing. |
| 27 | areas.bbs/files.bbs export | [x] | Generate areas.bbs/files.bbs from network mappings. Admin download per network. %AREAS command in AreaFix/FileFix. |
| 28 | Tossed packet retention | [x] | `ftn_keep_tossed_days` config (default 7, 0 = immediate delete, 999 = keep forever). Daily `purge-tossed` maintenance job. |
| 29 | Notification system | [x] | Centralised notifications model, bell icon in nav bars, `/notifications` page, terminal reader, real-time push via PresenceSocket, sysop + user producers, daily purge. |
| 30 | Multi-address binkp sessions | [x] | Password-filtered grouping of multiple peer connections per session. Per-connection outbound isolation. All FTN addresses advertised (defaults first). Session dedup across grouped connections. |
| 31 | Default/example menus | [ ] | Ship a complete set of starter menus (main, messages, files, doors, sysop) so new installs have a working menu structure out of the box. |
| 32 | Default/placeholder art | [ ] | Ship placeholder ANSI/ASCII art for login, logon, welcome, goodbye screens. First-run experience without requiring sysop art creation. |
| 33 | Echolist hub associations | [ ] | Link specific peer connections as hubs per echolist. Subscribe from echolist auto-enables on hub peers only (not all). |
| 34 | Direct echolist editing | [ ] | Add/remove/edit areas and tags within echolists from the admin UI (for network administrators). |
| 35 | Echolist subscribe from AreaFix | [ ] | Parse inbound AreaFix %LIST responses to auto-update echolist registry. Admin "request %LIST from upstream" action. |
| 36 | Automated echolist/filebone scanning | [x] | Daily scan job checks network infopack areas (ZIP) and per-list override areas. Auto-imports via existing diff pipeline. Sysop notifications on locally-carried removals. |
| 37 | Cross-network orphaned area overview | [ ] | Summary view showing which networks have orphaned areas with counts and links. |
| 38 | Echolist/filebone navigation improvements | [ ] | UX pass on echolist/filebone page organization, navigation flow, breadcrumbs, and view consolidation. |
| 39 | File group base_dir change: move area subdirectories | [ ] | When group base_dir changes, preview and move member area subdirs. Skip absolute/external paths. Handle edge cases. |
| 40 | Per-peer outbound fileboxes | [x] | Optional outbox_dir on FTN peer connections. BSO scanner picks up files, sends with delete-after-send. %X variable substitution for paths. |
| 41 | Inbound file wildcards | [x] | Sysop-configurable glob pattern rules route inbound files to specific directories. Skip toss by default, still_toss flag. Admin CRUD with drag-to-reorder and test tool. |
| 42 | File area retention limits | [x] | Optional max_age_days and max_files on file areas and file groups. Daily file-maintenance job enforces limits (DB + disk cleanup). |
| 43 | Timed events | [x] | Sysop-configurable scheduled commands (door maintenance, backups). NativeCommand + Dosemu launch types, cron scheduling, %X variables, timeout, output capture. Admin CRUD. |
| 44 | Call flow editor | [x] | DB-backed call flows and pools. Admin stage editor with drag-to-reorder, pool-to-flow assignment. Replaces hardcoded arrays. |
| 45 | Honeypot + fail2ban integration | [x] | Honeypot login detection, security.log for fail2ban, immediate disconnect, registration block. trust_proxy for reverse proxies. |
| 46 | displayScreen menu command | [x] | Art file display from menus/call flow. Random by type or specific subdir/filename. |
| 47 | Bad echomail handling | [x] | Holding table for unknown areatags with recovery, tracking, and auto-purge. Inbound file log for peer traceability. |
| 48 | Combined area browser | [x] | Single-page grouped view with Subscribed/All toggle, search, AJAX subscribe/unsubscribe for both messages and files. |
| 49 | REST API v1 (QWK download/upload) | [x] | `/api/v1` Bearer token auth, user + admin token CRUD, `/qwk/download` + `/qwk/upload`, throttled logoncount via `api_call_count_interval_hours`, caller log entries, `user_qwk_fetched` template event. Scopes: qwk, qwk_rw. |
| 50 | **RESP3 migration** | [ ] | **HIGH PRIORITY.** node-redis 6 and ioredis 6 both default to RESP3; both are currently pinned to RESP2 (`RESP: 2` in `middleware/db/redis.js`, `protocol: 2` in `queues/connection.js`) so the dependency upgrade could not change reply shapes. Migrating means auditing every reply-shape assumption: `hGetAll`/`hgetall` results, `exists` truthiness, pub/sub on shared connections, and `sessionstore.js` in particular. Gains real types (maps, sets, booleans, doubles) and push messages for client-side caching. See `docs/DEPENDENCY_AUDIT.md`. |

---

## Post-Release (Alpha+)

| # | Item | Status | Notes |
|---|------|--------|-------|
| 1 | JS Door SDK (dorkit-style) | [ ] | Library for writing JS doors that integrate with Canectic. Provide terminal I/O helpers, user context, drop file parsing, colour/cursor utilities, input handling. Similar to Synchronet's dorkit. Publish as standalone npm package. |
| 2 | Hub / Network Coordinator tools | [x] | Nested segment hierarchy with internal/external sources, per-network role configuration, managed flag definitions, tree-walk compilation, post-batch orphan reconciliation. See `HUB_COORDINATOR_DESIGN.md`. |

## Post-Release (Beta+)

| # | Item | Status | Notes |
|---|------|--------|-------|
| 5 | Docker Compose setup | [ ] | Lower barrier to entry for testers |
| 6 | ZMODEM IcyTerm compatibility | [ ] | Send/receive fails with IcyTerm; all other clients work |
| 7 | Systemd unit files | [ ] | Alternative to PM2 for production |
| 8 | Terminal reader pagination | [ ] | Lazy-load beyond 50-message batch |
| 9 | Terminal address book | [ ] | Quick-select recent recipients |
| 10 | Deployment guide (production) | [ ] | TLS, reverse proxy, MTA integration |

---

## Architecture Documentation

| Document | Status |
|----------|--------|
| `PROCESS_ARCHITECTURE.md` | [x] |
| `NETWORKING_ARCHITECTURE.md` | [x] |
| `message_architecture.md` | [x] |
| `terminal_architecture.md` | [x] |
| `web_architecture.md` | [x] |
| `MAILER_ARCHITECTURE.md` | [x] |
| `PM_ARCHITECTURE.md` | [x] |
| `EMAIL_ARCHITECTURE.md` | [x] |
| `FILES_ARCHITECTURE.md` | [x] |
| `DOWNLOAD_PROTOCOL_DESIGN.md` | [x] |
| `NODELIST_DESIGN.md` | [x] |
| `BSO_SCANNER_DESIGN.md` | [x] |
| `LOGGING_SYSTEM.md` | [x] |
| `CONFIG_SYSTEM_DESIGN.md` | [x] |
| `EMSI_WAZOO_DESIGN.md` | [x] |
| `NODESPY_DESIGN.md` | [x] |
| `SYSOP_CHAT_DESIGN.md` | [x] |
| `WALL_DESIGN.md` | [x] |
| `MENU_LAYOUT_DESIGN.md` | [x] |
| `QWK_USER_DESIGN.md` | [x] |
| `WEB_CHAT_DESIGN.md` | [x] |
| `WEB_CALLFLOW_DESIGN.md` | [x] |
| `FILEBOX_WILDCARD_DESIGN.md` | [x] |
| `API_DESIGN.md` | [x] |
| `PEER_INTEROP.md` | [x] |
| `HUB_COORDINATOR_DESIGN.md` | [x] |
| `UPDATE_SYSTEM_DESIGN.md` | [x] design, unimplemented |
| `INSTALL.md` (sysop-facing) | [x] |
| `README.md` (user-facing) | [x] |
