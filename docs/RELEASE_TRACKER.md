# Canectic BBS - Release Tracker

Status tracking for releases.

Last updated: 2026-03-28

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
- [x] Menu system (hotkey menus, PostgreSQL-backed, hotkey prefix display)
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
- [x] Last callers display
- [x] User list
- [x] Door game support (NativeShell, ExecNative, SpawnNative, Dosemu, DosemuPty)
- [x] Announcement viewer (scrolling viewport, arrow navigation, call flow + menu command)
- [x] Mail verification handler (call flow + menu command, send/enter/change address)
- [x] Registration with gender selection (hotkey selector)
- [~] Password reset handler (sends message, token/link flow not implemented)
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
- [ ] User profile editing (change password, display preferences)

### Admin Panel
- [x] Dashboard
- [x] Configuration (category accordion, per-category save, source badges)
- [x] Message groups CRUD
- [x] Message areas CRUD (per-area tables, access control)
- [x] File groups CRUD
- [x] File areas CRUD (scan, move, delete files)
- [x] Users CRUD (edit, password reset, flags, Unverified restriction)
- [x] Menus CRUD (hotkey entries, ANSI color picker, drag-to-reorder)
- [x] Doors CRUD (launch types, variable substitution)
- [x] Peer connections (FTN/QWK/NNTP, enable/disable, poll settings)
- [x] Nodelists (import, browse, search, flag glossary)
- [x] Admin log viewer (WebSocket push, live tail)
- [x] Undeliverable PM queue (review, deliver, discard)
- [x] Announcements CRUD (TinyMCE editor, drag-to-reorder, pinning, scheduling)
- [x] Jobs & Maintenance page (manual trigger for all worker jobs by category)
- [x] SMB message base import (upload .shd/.sdt/.sid, preview, import to area)
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
- [x] 1,178 tests passing (mocha)
- [x] Protocol tests (XMODEM, ZMODEM, binkp, EMSI/Wazoo)
- [x] Routing tests (FTN router, BSO scanner)
- [x] Parsing tests (TIC, QWK, nodelist, codepage, terminal)
- [x] Config and access control tests
- [x] Email transport tests

---

## Roadmap to 1.0

| # | Item | Status | Notes |
|---|------|--------|-------|
| 1 | Password reset flow | [x] | Pre-login code-based + web token link + post-login change |
| 2 | User profile editing | [x] | Username cooldown, name, location, gender, inline password change |
| 3 | Door menus and collections | [ ] | Categories/groups, presentation (ANSI art per category), terminal door selector, web door browser with filtering |
| 4 | Door server BBS registration | [ ] | Register with door game servers |
| 5 | JAM message base import | [ ] | Parser + admin UI (SMB import done) |

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
| `INSTALL.md` (sysop-facing) | [x] |
| `README.md` (user-facing) | [x] |
