# Canectic BBS - Release Tracker

Status tracking for releases.

Last updated: 2026-04-02

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
- [ ] JAM message base import

### Message Networking
- [x] FTN tosser (inbound/outbound, type-2 packets)
- [x] FTN binkp mailer (TCP + WebSocket transports)
- [x] BSO outbound scanner
- [x] QWK tosser (client pull/push, hub mode)
- [x] NNTP tosser (pull/push)
- [x] TIC file echo distribution
- [x] FTN nodelist import and routing

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
- [x] Inbound via trusted gateway (IP allowlist)
- [x] SMTP submission accepts external addresses
- [x] IMAP rendering with real email addresses
- [x] Web compose with email validation
- [x] Config keys (relay, inbound port, trusted hosts)

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
- [x] Database migrations (declarative schema management)
- [x] Startup DB/Redis validation (fail fast with clear error)
- [x] Health check endpoint (GET /health)
- [x] CSRF protection (Origin/Referer check middleware)
- [x] Install/update script (setup/install.sh)
- [x] .env.example template (examples/env.example)

### Testing
- [x] 1,948 tests passing (mocha)
- [x] Protocol tests (XMODEM, ZMODEM, binkp, EMSI/Wazoo)
- [x] Routing tests (FTN router, BSO scanner)
- [x] Parsing tests (TIC, QWK, nodelist, codepage, terminal)
- [x] Config and access control tests
- [x] Email transport tests
- [x] New feature tests (areaAccess, activityMap, wall, bulletins, announcements, systemStats, artCodes, qwkUser)

---

## Roadmap to 1.0

| # | Item | Status | Notes |
|---|------|--------|-------|
| 1 | Password reset flow | [x] | Pre-login code-based + web token link + post-login change |
| 2 | User profile editing | [x] | Username cooldown, name, location, gender, inline password change |
| 3 | Door menus and collections | [x] | Collections, terminal browser, web cards, TinyMCE descriptions, ANSI colour rendering |
| 4 | Door server BBS registration | [ ] | Register with door game servers |
| 5 | JAM message base import | [ ] | Parser + admin UI (SMB import done) |
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
| 20 | Birthday messages | [ ] | "Happy birthday" in call flow when users have birthdays today (birthdate column exists) |
| 21 | FTN netmail file attach | [x] | Inbound: recognize file-attach flag, link received files to netmail PM. Outbound: place attachment in BSO for binkp delivery. |
| 22 | PM file attachments | [x] | Full attachment system across all transports (LOCAL, EMAIL, FTN, Web, IMAP, terminal indicator). pm_attachments table, disk storage, config limits. |
| 23 | Session management | [x] | Remember Me, configurable session TTL, Log Out All Other Sessions, admin kill sessions |
| 24 | AreaFix | [x] | Automated echomail area management via netmail commands (+subscribe, -unsubscribe, %LIST, %QUERY, %HELP, %PAUSE, %RESUME). Password auth, auto-response netmail. |
| 25 | FileFix | [x] | Automated TIC file area management via netmail commands (+subscribe, -unsubscribe, %LIST, %QUERY, %HELP, %PAUSE, %RESUME). Parallel to AreaFix. |
| 26 | FREQ (File Request) | [x] | Three-layer resolver (magic aliases, filebox, file entries). Inbound .req processing in binkp. Outbound .req via admin. Auto-generated file listing. |
| 27 | areas.bbs/files.bbs export | [x] | Generate areas.bbs/files.bbs from network mappings. Admin download per network. %AREAS command in AreaFix/FileFix. |
| 28 | Tossed packet retention | [x] | `ftn_keep_tossed_days` config (default 7, 0 = immediate delete, 999 = keep forever). Daily `purge-tossed` maintenance job. |
| 29 | Notification system | [x] | Centralised notifications model, bell icon in nav bars, `/notifications` page, terminal reader, real-time push via PresenceSocket, sysop + user producers, daily purge. |
| 30 | Multi-address binkp sessions | [ ] | Handle remote advertising multiple AKAs mapping to local peer connections. Batch outbound for shared remotes. Verify no cross-connection data leakage. Determine which local addresses to advertise when answering (all AKAs vs filtered by caller). |

---

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
| `INSTALL.md` (sysop-facing) | [x] |
| `README.md` (user-facing) | [x] |
