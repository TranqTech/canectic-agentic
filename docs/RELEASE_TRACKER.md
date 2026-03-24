# Canectic BBS — Release Tracker

Status tracking for the first public test release (alpha).

Last updated: 2026-03-24

---

## Legend

- `[x]` — Complete
- `[-]` — In progress
- `[ ]` — Not started
- `[~]` — Partial / works but needs improvement

---

## Core Systems

### Terminal
- [x] Terminal server (auto-detect TCP/Telnet, WebSocket)
- [x] Terminal negotiation (NAWS, SGA, binary mode)
- [x] Menu system (hotkey menus, PostgreSQL-backed)
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
- [~] Password reset handler (sends message, token/link flow not implemented)
- [~] ZMODEM upload (works with most clients, known issue with SyncTERM)

### Web
- [x] Login page
- [ ] Registration page (route exists, template missing — will crash)
- [x] Public message browsing (groups, areas, threads)
- [x] Message posting (new thread, reply)
- [x] File browsing (groups, areas, file detail)
- [x] File download
- [x] File upload (multipart, hash check, DIZ extraction)
- [x] Private mail webmail UI (inbox/sent/trash, compose local + network, reply)
- [x] Bootstrap 5 Darkly theme, responsive layout
- [x] DataTables for sortable/searchable lists
- [x] TinyMCE rich text editor
- [ ] Announcement / bulletin system (landing page announcements, news posts)
- [ ] User profile / settings page

### Admin Panel
- [x] Dashboard
- [x] Configuration (category accordion, per-category save, source badges)
- [x] Message groups CRUD
- [x] Message areas CRUD (per-area tables, access control)
- [x] File groups CRUD
- [x] File areas CRUD (scan, move, delete files)
- [x] Users CRUD (edit, password reset, flags)
- [x] Menus CRUD (hotkey entries, ANSI color picker)
- [x] Doors CRUD (launch types, variable substitution)
- [x] Peer connections (FTN/QWK/NNTP, enable/disable, poll settings)
- [x] Nodelists (import, browse, search, flag glossary)
- [x] Admin log viewer (WebSocket push, live tail)
- [x] Undeliverable PM queue (review, deliver, discard)

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
- [x] Bounce notifications (undeliverable → sender inbox)
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

### Infrastructure
- [x] Four-process model (gateway, mail, worker, mailer)
- [x] PM2 ecosystem config
- [x] BullMQ job queues (toss, mailer, maintenance)
- [x] Redis pub/sub event bus
- [x] Centralized logging (alogger, Redis bus, admin viewer)
- [x] Configuration system (3-tier, admin UI, cross-process reload)
- [x] Database migrations (declarative schema management)

### Testing
- [x] 1,178 tests passing (mocha)
- [x] Protocol tests (XMODEM, ZMODEM, binkp, EMSI/Wazoo)
- [x] Routing tests (FTN router, BSO scanner)
- [x] Parsing tests (TIC, QWK, nodelist, codepage, terminal)
- [x] Config and access control tests
- [x] Email transport tests

---

## Release Blockers

Items that must be complete before handing to testers.

### Onboarding & Setup

| # | Item | Status | Notes |
|---|------|--------|-------|
| 1 | `.env.example` template | [x] | `examples/env.example` — all bootstrap vars documented |
| 2 | `INSTALL.md` setup guide | [x] | `docs/sysop/INSTALL.md` — full walkthrough with troubleshooting |
| 3 | First-run sysop account creation | [x] | User #1 auto-promotes to Sysop (document in INSTALL.md) |
| 4 | Fix `npm start` script | [x] | Points to `gateway.js` now |
| 5 | README overhaul | [x] | Full feature list, quick start, ports, running, docs links |

### Security

| # | Item | Status | Notes |
|---|------|--------|-------|
| 6 | CSRF protection | [x] | Origin/Referer check middleware on all state-changing requests |
| 7 | Startup DB/Redis validation | [x] | All processes fail fast with clear error message |

### Missing Web Features

| # | Item | Status | Notes |
|---|------|--------|-------|
| 8 | Registration page | [x] | 6-step wizard with AJAX validation, gender field, auto-login |
| 9 | Announcement / bulletin framework | [x] | DB-backed, admin CRUD, landing page display, pinning, scheduling |

### Stability

| # | Item | Status | Notes |
|---|------|--------|-------|
| 10 | Health check endpoint | [x] | `GET /health` — returns DB and Redis status, 503 if degraded |
| 11 | Install/update script | [x] | `setup/install.sh` — interactive target selection, fresh install + update with merge prompts |

---

## Post-Release (Beta Improvements)

Items that would improve the experience but aren't blocking the initial test release.

| # | Item | Status | Notes |
|---|------|--------|-------|
| 11 | Docker Compose setup | [ ] | Lower barrier to entry for testers |
| 12 | Password reset flow | [ ] | Token/link system (currently just sends a PM) |
| 13 | User profile/settings page | [~] | Basic profile view done, settings/edit not yet |
| 14 | ZMODEM upload SyncTERM fix | [ ] | Known issue, works with other clients |
| 15 | Systemd unit files | [ ] | Alternative to PM2 for production |
| 16 | Terminal reader pagination | [ ] | Lazy-load beyond 50-message batch |
| 17 | Terminal address book | [ ] | Quick-select recent recipients |
| 18 | Deployment guide (production) | [ ] | TLS, reverse proxy, MTA integration |

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
