# Pre-Release Test Checklist

Manual testing checklist for verifying Canectic BBS features before a release.
Work through each section and check items as verified. This checklist is
mirrored to the Tranqsoft MCP knowledge base (project "Canectic BBS") for
distribution to testers — run `list_checklists` on the project to see the
live copy.

Last updated: 2026-04-11 (matches `git log` HEAD of this commit)

---

## Installation & First Boot

- [ ] Fresh clone: `setup/install.sh` runs to completion without prompts
- [ ] Fresh `.env` from `examples/env.example`: bootstrap vars filled in
- [ ] `pm2 start ecosystem.config.cjs` brings up all four processes cleanly
- [ ] `pm2 logs` shows `appConfig Loaded` line per process with config key count
- [ ] `ps` / `pm2 status` shows gateway, mail, worker, mailer all online
- [ ] Gateway startup auto-seeds `config_settings` defaults on first run
- [ ] Gateway startup runs schema migrations (column + constraint ensures)
- [ ] `/health` endpoint returns 200 with JSON status
- [ ] Admin can log into the web UI immediately on first boot
- [ ] Admin user is seeded from `.env` SYSOP variables if set
- [ ] Seasonal art directories auto-created on first run

## Authentication, Registration, Sessions

- [ ] Login page renders with Darkly theme
- [ ] Remember Me checkbox labelled with configured days (default 14)
- [ ] Valid login succeeds, caller log entry created with source "Web"
- [ ] Invalid login leaves user on login page with flash message
- [ ] Honeypot username blocks registration
- [ ] Honeypot username on login writes to `security.log` for fail2ban
- [ ] Honeypot terminal connection disconnects immediately
- [ ] Registration: 6-step wizard completes, AJAX validates username + email
- [ ] Registration: gender selection renders as hotkey selector
- [ ] Registration: auto-login after completion
- [ ] Registration: new account has Unverified restriction flag
- [ ] Registration: caller log entry created for new user
- [ ] Mail verification auto-sent on registration (check `email_transports` log)
- [ ] Mail verification: enter code removes Unverified, bumps security level
- [ ] Mail verification: change address cancels old code, sends new
- [ ] Password reset: forgot password page accepts email, sends code + token link
- [ ] Password reset: web token link opens reset form, sets new password
- [ ] Password reset: pre-login code entry path works from login page
- [ ] Logged-in inline password change on profile page works
- [ ] Session TTL default 12h: inactivity past TTL forces re-login
- [ ] Remember Me: session persists across browser close/reopen
- [ ] Profile "Log Out All Other Sessions": correct password kills others, wrong preserves
- [ ] Admin user list "Kill Sessions": confirm dialog, kills target's sessions
- [ ] Username change cooldown: second change within cooldown period blocked with friendly error

## Web UI — Call Flow, Home, Navigation

- [ ] Fresh login redirects to `/callflow`
- [ ] Welcome stage shows BBS name and web art (if configured)
- [ ] Announcements stage shows new + pinned announcements, theme colours on black bg
- [ ] Last Callers stage shows recent callers with terminal colour classes
- [ ] Who's Online stage shows terminal + web users
- [ ] Wall stage shows messages, inline post input works, form disappears after posting
- [ ] News files stage shows configured news files (skip if none)
- [ ] New Messages stage shows summary (skip if none)
- [ ] New Files stage shows summary (skip if none)
- [ ] Continue button and Enter advance stages; Skip / Escape jump to end
- [ ] Stages with no data auto-skip
- [ ] Progress text shows "Stage X of Y"
- [ ] Call flow completion redirects to home page
- [ ] Idle resume: leave tab open past threshold, return, "Welcome back" bar appears
- [ ] "Welcome back" bar link goes to `/callflow`; dismiss clears prompt
- [ ] Wall post form reappears after idle resume (sessionStorage cleared)
- [ ] Home page: Announcements tab active by default, Wall tab only when logged in
- [ ] Announcement cards show black background with theme text colour
- [ ] Pinned announcements show "Pinned" badge
- [ ] Font size noticeably larger than default Bootstrap (1.2rem)
- [ ] Navbar: bell icon with unread notification count
- [ ] Navbar: notification dropdown shows 10 most recent
- [ ] `/notifications`: full history with pagination
- [ ] `/whosonline`: terminal nodes + web presence, activity labels
- [ ] `/wall`: post, form disappears, revisit keeps form hidden, after idle form reappears
- [ ] `/users/profile`: read-only verification status badge
- [ ] `/users/profile/edit`: username cooldown respected, inline password change works
- [ ] `/files` browse: groups, areas, download link works
- [ ] `/files` upload: multipart, hash check, DIZ extraction populates description
- [ ] `/pm` inbox / sent / trash: split-pane reader renders
- [ ] `/pm/compose`: local and network transport compose forms work
- [ ] Public message browse: groups, areas, thread view, reply
- [ ] `/doors`: card layout with collection filtering
- [ ] `/doors/play/:slug`: xterm.js launches in browser, returns to collection on exit
- [ ] `/qwk`: shows subscribed area count + unread message count

## Terminal UI

- [ ] Connect via Telnet: IAC negotiation, NAWS window size captured
- [ ] Connect via raw TCP: auto-detect skips Telnet negotiation
- [ ] Connect via WebSocket: web terminal client works
- [ ] Terminal type detected (for sixel and ZMODEM CRC mode selection)
- [ ] CP437 / UTF-8 charset toggle works
- [ ] Login with existing user: call flow runs per configured stages
- [ ] Registration call flow works over terminal
- [ ] Hotkey menu: single keypress navigates, art renders with `@` codes substituted
- [ ] Lightbar menu: arrow keys navigate highlight bar, Enter selects
- [ ] Menu art file discovery: size-aware walk (exact size match > column fit > default)
- [ ] Sixel art displays on sixel-capable terminal
- [ ] ANSI art displays with CP437 conversion on non-sixel terminal
- [ ] `@BN@` board name, `@UN@` username, `@DT@` date codes substitute
- [ ] `@TC@` / `@TU@` / `@ON@` DB-backed codes substitute
- [ ] Art-defined menu: `@Enn@` / `@Fnn@` entry slot codes place entries at marked positions
- [ ] Message area selector: lightbar navigation
- [ ] Message reader: thread view, scroll viewport, quote system
- [ ] Message editor: full-screen, word wrap, quote insertion, save
- [ ] Newscan: walks subscribed areas with new messages
- [ ] File area selector: lightbar, T key toggles subscription
- [ ] File browser: list, detail, D for download
- [ ] Batch download: T key tags, ZMODEM / XMODEM send
- [ ] File upload: ZMODEM receive, hash check, DIZ extraction
- [ ] File search: cross-area search results
- [ ] New file scan across subscribed areas
- [ ] PM reader: inbox/sent/trash navigation, reply, delete
- [ ] PM editor: transport selection (LOCAL/FTN/QWK/EMAIL)
- [ ] Door browser: collection navigation, description panel, ANSI rendering
- [ ] Who's online menu command
- [ ] Last callers menu command
- [ ] Wall / oneliners display in terminal, own username highlighted
- [ ] System statistics (`sysInfo`) command
- [ ] Bulletin viewer: selection menu, art file display
- [ ] News file viewer: full-screen, any key advances, ESC skips, centre option for wide terminals
- [ ] QWK transfer menu command: D/U/Q menu, ZMODEM download, REP upload
- [ ] Notification reader: lightbar list, detail view, mark-all-read
- [ ] ZMODEM: works with SyncTERM, NetRunner, MagiTerm (known issue with IcyTerm both directions)
- [ ] XMODEM-1K and XMODEM-CRC download fallback

## Messages — Admin, Post, Read, Newscan

- [ ] Admin Message Groups: create, edit, delete, reorder
- [ ] Admin Message Group: create modal includes QWK Conference Start field pre-filled with next available block
- [ ] Admin Message Group: edit form shows qwk_conf_start, changing it renumbers all areas preserving offsets
- [ ] Admin Message Group: renumber aborts cleanly on collision with another group's area
- [ ] Admin Message Areas: create under group inherits defaults
- [ ] Admin Message Areas: edit tabbed modal (Main/Access/Network)
- [ ] Admin Message Areas: QWK conference number auto-assigned from group block
- [ ] Admin Message Areas: per-area override saved if entered, validation rejects <=100 and collisions
- [ ] Admin Message Area: Move button on info modal moves area to another group
- [ ] Move area: apply defaults checkbox overwrites security/flags/post_as/newscan
- [ ] Move area: QWK conference number reassigned from target group's block
- [ ] Move area: block-full target aborts cleanly without touching the area
- [ ] Admin Message Area: delete with confirmation, optionally drops backing tables
- [ ] Admin Push Group Defaults: security / flags / post_as / newscan push works
- [ ] Admin Thread / Message deletion with confirmation modals
- [ ] Post new message from terminal: threads row created, body_html rendered
- [ ] Post new message from web: TinyMCE editor, body_html rendered on save
- [ ] Reply to existing message: thread link, reply_to MSGID set
- [ ] Newscan: area-level scan pointer advances, thread-level pointers work above floor
- [ ] Access control: security level, permission flags (AND), restriction flags (NONE)
- [ ] Custom permission/restriction flags from config are honoured
- [ ] FidoNet message round-trip: post from Canectic, toss out, receive back, no dupe
- [ ] MSGID uniqueness: `ftn_utils.genMsgId()` returns 8 hex chars exactly (FTS-0009)
- [ ] MSGID counter survives process restart (Postgres `msgid_day_watermark` table)

## Private Messaging

- [ ] Inbox: list view with unread count badge
- [ ] Trash: soft-deleted messages visible
- [ ] Deleted messages hidden from inbox / IMAP / QWK unread / attachment downloads
- [ ] Hard delete from trash (web or IMAP): `purged=true` tagged, row disappears immediately
- [ ] Background `pm-purged-cleanup` job runs hourly and on-demand after purge
- [ ] Attachment files cleaned up on purge
- [ ] Compose LOCAL: sends immediately, recipient inbox shows message
- [ ] Compose network (FTN): PM enters pending, tosser picks up
- [ ] Compose EMAIL: outbound relay sends via smart host
- [ ] Compose QWK: pending in user QWK queue
- [ ] Reply preserves thread context, attribution line, quote
- [ ] Attachment upload on compose: file appears on recipient's message view
- [ ] Attachment download link works, ownership check rejects non-owner access
- [ ] Max attachment size (`pm_max_attachment_size`) enforced
- [ ] Max attachment count (`pm_max_attachments`) enforced
- [ ] IMAP attachments: multipart/mixed BODYSTRUCTURE, base64 parts, Thunderbird downloads
- [ ] IMAP IDLE: message arrives in inbox, client auto-refreshes via push event
- [ ] IMAP read state sync: mark-read on one client reflects on web immediately
- [ ] SMTP submission: authenticated, multi-transport routing
- [ ] FTN inbound file attach: flag 0x0010 parsed, file linked to netmail PM
- [ ] FTN outbound file attach: `.flo` entry created for binkp delivery
- [ ] Terminal PM reader: shows "[Attachments available -- use web or IMAP to download]"
- [ ] Undeliverable PM queue: review, deliver manually, discard
- [ ] Bounce notifications: undeliverable returns to sender inbox

## Files

- [ ] Admin File Groups: create, edit, delete, reorder
- [ ] Admin File Areas: create under group, `base_dir` resolution works with `%X` substitution
- [ ] Admin File Areas: per-area `sub_dir` respected
- [ ] Admin File Areas: `max_age_days` and `max_files` retention limits honoured by daily job
- [ ] Admin File Area: file browser shows entries, scan/move/delete work
- [ ] Admin Push File Group Defaults: security / flags / newscan / retention push works
- [ ] File upload (web): multipart, hash, dupe check, DIZ extraction
- [ ] File upload (terminal): ZMODEM receive, hash, dupe check
- [ ] File download (web): single file, correct filename header
- [ ] File download (terminal): ZMODEM / XMODEM send
- [ ] Batch tagging and download in terminal browser
- [ ] File area subscription: T key toggles, persists
- [ ] New file scan: walks subscribed areas with new entries since last check
- [ ] Cross-area file search works
- [ ] FILE_ID.DIZ auto-extracted from ZIP on upload

## Doors

- [ ] Admin Doors: create with TinyMCE description, icon/media, launch type
- [ ] Admin Door Collections: create, reorder, assign doors
- [ ] NativeShell door (PTY): interactive door launches, input/output flow
- [ ] NativeCommand door: scripted command runs with piped stdio
- [ ] Dosemu (Console Only): headless utility launches with `-dumb`
- [ ] DosemuPty (Full): interactive DOS door launches via socat serial pair
- [ ] Door dropfiles: DOOR.SYS, DOOR32.SYS, DORINFO.DEF, CHAIN.TXT, CALLINFO.BBS, PCBOARD.SYS all generated per configured type
- [ ] `%X` variables in door config (doorDir, arguments) substitute correctly
- [ ] Web door launcher (xterm.js): token auth, fractional scaling, mobile responsive
- [ ] Web door return button goes back to collection
- [ ] Door browser terminal: collection nav, description panel

## FTN Networking (Tosser, Mailer, Nodelist, FileBox)

- [ ] Admin Peer Connections: create FTN peer with binkp transport
- [ ] Admin Peer: `poll_enabled` toggle affects scheduled jobs
- [ ] Admin Peer: multi-address (AKA) configuration preserves all addresses in EMSI
- [ ] Mailer outbound: poll triggers binkp session, exchanges mail bundles, signs off cleanly
- [ ] Mailer outbound: session groups multiple peer connections by password match
- [ ] Mailer inbound: accepts binkp session, writes to inbound dir, triggers toss
- [ ] Mailer WebSocket transport: binkd-over-WS connections work
- [ ] BSO scanner: periodic + on-demand scan resolves routes, triggers sessions
- [ ] BSO scanner parses hex BSO filenames correctly
- [ ] Per-peer outbound filebox: files in `outbox_dir` sent to peer, deleted after successful send
- [ ] Inbound file wildcards: glob match routes files to target dir, skip-toss by default
- [ ] FTN tosser inbound: type-2 packet parsing, dupe detection, thread linkage
- [ ] FTN tosser bundle filename gate: only `.mo?`/`.tu?`/`.su?` etc unpacked via adm-zip
- [ ] FTN tosser kludge format: `^AMSGID: addr hex` with colon-space separator
- [ ] FTN tosser REPLY kludge on outbound replies
- [ ] Tossed packet retention: `ftn_keep_tossed_days` config honoured by daily purge job
- [ ] Bad echomail holding: unknown areatags stored, recovered on area creation, daily purge
- [ ] Inbound file log: peer and timestamp tracked per received file
- [ ] Nodelist import (manual): upload ZIP, parse, 5% error threshold, historical tracking
- [ ] Nodelist scan (automated): daily job picks newest file in configured area, imports
- [ ] Nodelist scan handles non-`NODELIST.*` filenames (AgoraNet, FsxNet, Micronet, TqwNet conventions)
- [ ] Nodelist scan upload_date-based gating handles year wraparound and `.Z00` placeholders
- [ ] Nodelist junk filter: FILE_ID.DIZ / readmes inside infopack ZIPs are not imported as nodelists
- [ ] Nodelist browser: search, flag glossary, filters work without DataTables error
- [ ] FTN router: direct lookup + coordinator walk (hub → host → region → zone)
- [ ] AreaFix: netmail with password in subject, `%LIST` / `+AREA` / `-AREA` / `%QUERY` / `%HELP` / `%PAUSE` / `%RESUME` / `%AREAS` commands
- [ ] FileFix: same command set for file areas
- [ ] FREQ inbound: `.req` file parsed, matching files queued for binkp delivery
- [ ] FREQ magic aliases: seeded "FILES" alias returns areas.bbs-style listing
- [ ] Admin FREQ: magic alias CRUD, filebox browser
- [ ] PM FTN transport: outbound netmail packets produced with correct kludges
- [ ] PM FTN transport: inbound netmail routed to user inbox via `ftnNetmailAdapter`

## QWK / NNTP / User QWK

- [ ] QWK tosser hub mode: packet received, messages imported, REP returned
- [ ] NNTP tosser: article pull + push, Newsgroup mapping
- [ ] User QWK web download (`/qwk/download`): packet streams with correct filename
- [ ] User QWK terminal download: ZMODEM sends packet, file correct
- [ ] User QWK packet contents: personal mail at conf 0, announcements / wall / bulletins at 1-3
- [ ] User QWK area conference numbers cluster by group (per-group blocks)
- [ ] User REP upload web: replies posted to correct areas
- [ ] User REP upload terminal: ZMODEM receive, posts to areas
- [ ] User REP for announcements / bulletins: rejected with feedback PM
- [ ] User REP for wall: first post accepted, extras rejected with feedback PM
- [ ] `last_qwk_download_at` advances after successful build
- [ ] System conference content filtered by `last_qwk_download_at`

## Email Transport & Mail Client Access

- [ ] Outbound SMTP relay: send via smart host (SES, Gmail, Postfix, etc.)
- [ ] Port/secure auto-reconciliation: 465/587/25 mismatches corrected with diagnostic
- [ ] TLS mismatch errors trigger transporter rebuild on next cycle
- [ ] Per-user sender identity: user PMs use `<username>@<mail_domain>` address
- [ ] System mail: `email_from_address` / `email_from_name` used for verification, password reset, templates
- [ ] Inbound trusted gateway: IPv4 CIDR allowlist blocks non-allowlisted sources
- [ ] Inbound SMTP: VRFY command in trusted mode returns canonical address or 550
- [ ] Inbound SMTP: empty-sender MAIL FROM / RCPT TO verification probes work
- [ ] Inbound SMTP: 8BITMIME accepted, multipart/mixed attachments extracted
- [ ] EHLO mode-aware: submission advertises AUTH, trusted advertises VRFY, both PIPELINING/8BITMIME/SIZE
- [ ] Inbound multipart message: attachment extraction writes to `pm_attachments` table
- [ ] Recipient resolver: dotted-local-part (`first.last@`) matches fullname
- [ ] Recipient resolver: username match, realname match, sysop alias match
- [ ] IMAP INBOX / Sent / Trash mailboxes visible
- [ ] IMAP COPY/MOVE between mailboxes
- [ ] IMAP EXPUNGE: flipped `\Deleted` messages purged via tag-only (fast)
- [ ] SMTP submission authenticated send via Thunderbird / Apple Mail / K-9
- [ ] Cross-process PM events: IMAP IDLE push from terminal / web compose
- [ ] Dotted-to-space fullname fallback on IMAP adapter inbound

## Echolists & Filebones

- [ ] Admin Echolists: create, upload file to seed first import, diff preview
- [ ] Admin Echolists: import shows new / removed / changed / unchanged counts
- [ ] Echolist historical tracking: `first_seen` / `last_seen` / `removed_at` populated
- [ ] Echolist auto-scan (daily job): walks infopack/echolist area, unzips, matches configured names
- [ ] Echolist scan `last_imported_at` bumped even when diff is empty (no re-parse loop)
- [ ] Echolist scan log: `Scan complete: N checked, U updated, V verified` summary
- [ ] Echolist scan `extract + match` failure logs at L2 with extracted contents
- [ ] Local area sync: adding/removing area mapping updates `local_area_id` on echolist
- [ ] Daily reconciliation job ensures `local_area_id` stays in sync
- [ ] Filebone registry: same CRUD and scan behaviour for file echoes
- [ ] Combined echolist view: tabs for All / Carried / Available / Orphaned
- [ ] Subscribe modal: security defaults, flag selectors, allow/enable peer checkboxes
- [ ] Unsubscribe from carried area: cascading delete options
- [ ] Orphaned area unmap: cleans stale network_areas rows
- [ ] Echolist scanner nodelist/echolist/filebone/infopack tier priority honoured

## Admin Panel & Content

- [ ] Dashboard: tabbed categories (System / Messages / Files / Networking / Content / Doors / Users / All)
- [ ] Dashboard: System tab default, instant search filters cards
- [ ] Configuration: category accordion, per-category save, source badges, reset-to-default
- [ ] Configuration: changing a key invalidates cache in all processes via `CONFIG_CHANGED` event
- [ ] Users: CRUD, password reset, flags, Unverified restriction toggle
- [ ] Peer connections: CRUD, enable/disable, poll settings, multi-address AKA
- [ ] Menus: create, edit (tabbed modal), duplicate, export, import, reorder entries
- [ ] Menus: art-defined mode, featured entries, nullable colours cascade
- [ ] Themes: colour categories, accordion editor, duplicate, set default, seed from JSON
- [ ] Themes: per-entry > per-menu > theme default > handler fallback cascade
- [ ] Doors: tabbed modals, TinyMCE descriptions, icon/media, launch types, `%X` vars
- [ ] Door Collections: create, reorder, assign
- [ ] Admin log viewer: WebSocket push, live tail, level filter
- [ ] Jobs & Maintenance: manual triggers for every worker job category
- [ ] Queue status panel: active/waiting/delayed/failed jobs visible, retry/drain/remove work
- [ ] Migrations hub: SMB import, areas.bbs import, sbbsecho.ini import links
- [ ] SMB import: upload .shd/.sdt/.sid, preview, import to target area
- [ ] areas.bbs import: preview, per-area Create / Map / Skip, creates mappings + peer subs
- [ ] sbbsecho.ini import: two-step Synchronet migration with drag-and-drop peer grouping
- [ ] Announcements CRUD: TinyMCE editor, drag-reorder, pinning, scheduling windows
- [ ] News files CRUD: path to ANSI art, active flag, ordering
- [ ] Seasonal art: add season (directories created), delete (optional dir removal)
- [ ] Web art: `txtfiles/webart/` random selection, seasonal override on matching date
- [ ] Bulletin CRUD: groupings, active flag
- [ ] Wall admin: delete messages at `/admin/wall`
- [ ] Call flow editor: drag-reorder stages, add/remove, pool-to-flow assignment
- [ ] Thread rebuild: `--rethread` CLI and admin button
- [ ] Seed sync tool: `node src/tools/seedSync.js` upserts JSON seed data
- [ ] Message templates CRUD: event selection, delivery channel (PM/email/netmail), conditions
- [ ] Message templates manual fire via `fireEvent.js` tool
- [ ] Timed events CRUD: cron schedule, launch type, `%X` vars, timeout, output capture
- [ ] Bad echomail admin page: view held messages, delete
- [ ] Inbound file log admin: per-peer trace of received files
- [ ] API tokens admin: list all, revoke, scope audit
- [ ] API tokens user: CRUD on profile page, one-time plaintext reveal
- [ ] Nodelist flag definitions: category, argument metadata, auto_managed, seed from JSON

## Notifications & Sysop Tools

- [ ] Bell icon: navbar unread badge updates in real-time via PresenceSocket
- [ ] Notification dropdown: 10 most recent items, mark-read inline
- [ ] `/notifications` page: full history with pagination, mark-all-read
- [ ] Terminal notification reader menu command: lightbar list, detail view
- [ ] Sysop notifications: one row per sysop for correct per-user read state
- [ ] Producers: PM received, TIC error, PM undeliverable, AreaFix request, user registered
- [ ] Daily purge of old read notifications honours `notifications_retention_days`
- [ ] NodeSpy dashboard: lists terminal nodes + web presence users
- [ ] NodeSpy live snoop terminal: follow a node's output via OutputRingBuffer
- [ ] NodeSpy web live snoop: xterm.js streams target node output
- [ ] Sysop chat (terminal): page request, break-in, split-screen DECSTBM chat engine
- [ ] Sysop chat (web): overlay on user's browser, persistence via Redis, typing indicator
- [ ] Sysop chat (web): sysop can close, user can minimise only
- [ ] User telegrams: Who's Online "Message" button starts chat with another web user
- [ ] User telegrams: both parties can close chat, persists across navigation
- [ ] Web chat restore after reconnect (`chat_restore` payload)

## Scheduled Jobs & Maintenance

- [ ] Daily nodelist scan job runs and logs results
- [ ] Daily echolist scan job runs, touches `last_imported_at` on no-change runs
- [ ] Daily `purge-tossed` job honours `ftn_keep_tossed_days`
- [ ] Daily file-maintenance job enforces area retention limits
- [ ] Daily unverified user purge honours `unverified_retention_days`
- [ ] Daily bad-echomail purge honours `bad_echo_retention_days`
- [ ] Daily inbound file log purge honours `inbound_log_retention_days`
- [ ] Daily notifications purge honours `notifications_retention_days`
- [ ] Hourly PM purged-cleanup job drains queue + runs on-demand after trash empty
- [ ] Timed events: cron schedules fire configured commands, output captured in DB
- [ ] Timed event: command timeout enforced, exit code recorded
- [ ] Scheduled mailer polls: `poll_enabled` peers polled at configured interval
- [ ] Echolist reconciliation job keeps `local_area_id` consistent bidirectionally

## Message Templates & Events

- [ ] Built-in events: `user_registered`, `user_verified`, `user_qwk_fetched`, `pm_received`, etc.
- [ ] Custom event registered via admin and fired via `fireEvent.js` tool
- [ ] Template conditions evaluated (e.g. "only on first login")
- [ ] Template delivery via PM transport reaches recipient inbox
- [ ] Template delivery via email: outbound relay sends
- [ ] Template delivery via netmail: FTN tosser picks up
- [ ] Per-user and per-many dispatch: `fireEventForMany` reaches all matched users
- [ ] Built-in template seed from JSON runs on first boot

## REST API v1

- [ ] `/api/v1` root returns 401 without Bearer token
- [ ] Bearer token auth: valid `canectic_<hash>` token returns 200
- [ ] Scope gate: `qwk` scope reads, `qwk_rw` scope required for writes
- [ ] User token CRUD on profile: create shows plaintext once, list shows last-used, delete revokes
- [ ] Admin token audit at `/admin/api-tokens`: list all, revoke any
- [ ] `/api/v1/qwk/download`: returns `.qwk` packet
- [ ] `/api/v1/qwk/upload`: accepts `.rep` packet, posts replies
- [ ] Token usage updates `last_used_at` on every call
- [ ] `logoncount` incremented once per `api_call_count_interval_hours` throttle window
- [ ] Caller log entries created for API calls
- [ ] `user_qwk_fetched` template event fires on successful download

## Security

- [ ] CSRF middleware: Origin / Referer check blocks cross-origin POSTs
- [ ] `trust_proxy` config: client IP resolved via `X-Forwarded-For` when behind reverse proxy
- [ ] Honeypot usernames config comma-separated, matched on login and registration
- [ ] Honeypot login failure writes to `security.log` in fail2ban-parseable format
- [ ] `examples/fail2ban/` configs ban source IPs on repeated honeypot hits
- [ ] Session cookie: HttpOnly, Secure (when HTTPS), SameSite
- [ ] Admin access: requires security level >= `adminsecurity` AND "Sysop" permission flag
- [ ] Parameterized queries: all model code uses `postgres.insertObject` / `postgres.query` — no string concat
- [ ] Table names from shortcodes validated as slug-safe
- [ ] Password hashing: bcrypt with correct rounds
- [ ] Mail verification tokens expire correctly

## Infrastructure

- [ ] Four-process model: gateway, mail, worker, mailer run independently
- [ ] PM2 ecosystem config: all four apps defined, `MAILER_ENABLED` gate on mailer
- [ ] Embedded mode: `PROCESS_MODE=embedded node bin/gateway.js` runs single-process
- [ ] BullMQ queues: `toss`, `mailer`, `maintenance` have correct concurrency
- [ ] Redis pub/sub: `CONFIG_CHANGED`, `PM_DELIVERED`, `PM_READ_CHANGED` events propagate
- [ ] Cross-process IDLE push: PM arrives via tosser, IMAP client on mail process sees it
- [ ] Session store: Redis-backed, survives gateway restart
- [ ] Database migrations: `dbmigrations.js` applies schema changes idempotently
- [ ] Startup DB/Redis validation: fails fast with clear error if unreachable
- [ ] `/health` endpoint returns 200 when system is healthy
- [ ] Health check covers DB + Redis + BullMQ connectivity
- [ ] PM2 timezone: child processes honour `TZ` from `.env`
- [ ] Alogger: Redis pub/sub log bus, level filtering, colour codes
- [ ] Admin log viewer shows all four processes, channel filtering

## Final Checks

- [ ] `npm test` — all 2,308+ tests pass
- [ ] `git status` clean (no uncommitted work)
- [ ] `docs/sysop/CHANGELOG.md` updated with release notes
- [ ] `docs/RELEASE_TRACKER.md` reflects actual feature status
- [ ] MCP doc sync run: `node scripts/syncMcpDocs.mjs $(git rev-parse --short HEAD)`
- [ ] Release tag: `git tag -a vX.Y.Z -m "..."` and push
- [ ] Release notes on GitLab / GitHub referenced by install docs
- [ ] Install docs (`docs/sysop/INSTALL.md`) cross-link to tagged release
- [ ] Upgrade-path tools in `src/tools/` noted in changelog with `node src/tools/...` invocation
- [ ] Known issues documented in release notes (e.g. ZMODEM IcyTerm)
