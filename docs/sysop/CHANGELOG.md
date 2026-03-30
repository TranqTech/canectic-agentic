# Canectic BBS - Changelog

## v0.9.1-alpha.1 (2026-03-29)

### Web Door Launcher
- Browser-based door game access via xterm.js embedded terminal
- Token-based WebSocket authentication (server-generated, one-time use, 60s TTL)
- Fixed 80x25 terminal with auto-scaling font in centered card layout
- Door listing page at /doors with play links
- Auto-redirect to door list on door exit

### Terminal Scaling and Centering
- DECSTBM scroll region for vertical + horizontal centering of door output on oversized terminals
- Output parser extended to all door launch types (NativeShell, ExecNative, SpawnNative, Dosemu, DosemuPty, SyncJS)
- Per-door `fixed_size` flag in admin door editor for doors that need forced 80x25 centering
- CP437-to-UTF8 conversion in output parser without byte mangling on raw CP437 terminals
- Form feed (0x0C) intercepted and converted to proper ESC[2J clear for xterm.js compatibility
- Scroll region preserved across door screen clears, reset on parser destroy

### Encoding Detection
- Fixed UTF-8 test character sending 4 bytes instead of 2 (JS string encoding issue)
- TTYPE-based encoding override for modern terminals (xterm, gnome, konsole, etc.)
- TTYPE response now stored on call object from telnet subnegotiation
- Populated UTF-8 charset glyphs (30 characters) and box drawing characters (40 characters)
- Fixed getboxes() returning wrong array for UTF8 encoding

### User Verification
- 6-digit verification code sent via email (SMTP relay) or FTN netmail on registration
- Auto-send on registration and address change
- Terminal verification handler (call flow + menu command) with send/enter/change address
- Web verification page with send, enter code, change address, days remaining countdown
- Unverified restriction flag added to new accounts on creation
- Security level bump on verification (configurable via verified_security)
- Sysop auto-verified on promotion
- Unverified account purge (configurable retention period, daily maintenance job)
- Mail type auto-detection for email vs netmail (handles 5D FTN addresses)

### Password Reset
- Pre-login: code-based reset from logon screen (username, send code, enter 8-char code, set password)
- Web: forgot password page with token link, password change form
- Post-login: change password menu command (current password required)
- 4-hour token expiry, 2-minute rate limit between sends
- "Forgot Password?" link on login page

### Profile Editing
- Editable fields: username (with configurable cooldown, default 90 days), name, location, gender
- Inline password change section on profile page
- Verification status badge with link to verify/change address
- Username change updates session immediately

### Admin Panel
- Jobs & Maintenance page with tabbed manual triggers for all worker jobs
- Announcement drag-to-reorder with save button
- Menu entry drag-to-reorder with save button
- User maintenance button on admin users page
- SMB message base import (upload .shd/.sdt/.sid, preview, import to target area)
- Door editor: fixed_size toggle for per-door centering control
- TinyMCE GPL license key configured

### Infrastructure
- Empty-string DB config values now fall back to defaults (was overriding with blank)
- Menu entry permission/restriction flag parsing handles JSON strings
- User maintenance worker (mailtype reconciliation + unverified account purge)
- Daily user maintenance schedule (5:00 AM)
- Legacy TCP/Telnet servers start when their ports are explicitly set
- Default menu entries (redrawMenu on ?) added to new menus automatically
- Hotkey prefix on menu entries using menu/theme hotkey color

### Synchronet JS Doors
- Output parser wired for SyncJS doors (CP437 conversion + optional centering)
- Fixed noyes() return value (true=No, false=Yes) matching Synchronet convention
- Fixed deny() to pass through noyes() directly
- Documentation warning about yesno()/noyes() return value asymmetry

---

## v0.9.0-alpha.1 "Handshake" (2026-03-24)

First public alpha release.

### Core Systems
- Terminal server with auto-detect TCP/Telnet and WebSocket support
- ANSI/CP437 and UTF-8 terminal with auto-detection and wide terminal support
- Hotkey menu system with configurable colors and layout
- Threaded message reader with scrolling viewport and quoting
- Full-screen message editor with word wrap and quote system
- File browser with native XMODEM and ZMODEM transfer engines
- Batch file downloads with tag-and-download
- Door game support (NativeShell, ExecNative, SpawnNative, Dosemu, DosemuPty, SyncJS)
- Private messaging across 5 transport types (LOCAL, FTN, QWK, EMAIL)

### Web Interface
- Responsive web forum with Bootstrap 5 Darkly theme
- File browsing, download, and multipart upload with hash verification
- Webmail-style private messaging with split-pane inbox
- 6-step registration wizard with AJAX validation and gender field
- Landing page with announcement/bulletin system
- Admin dashboard with full CRUD for all system entities

### Networking
- FTN type-2 packet tosser with binkp mailer (TCP + WebSocket)
- BSO outbound scanner with nodelist routing
- QWK client pull/push and hub mode
- NNTP article pull/push
- TIC file echo distribution with auto-forwarding
- Internet email transport (outbound SMTP relay, inbound trusted gateway)

### Mail Client Access
- IMAP4rev1 server for PM access from mail clients
- SMTP submission server with multi-transport addressing
- Cross-process IMAP IDLE push notifications

### Infrastructure
- Four-process model (gateway, worker, mail, mailer) managed by PM2
- BullMQ job queues with scheduled toss cycles and maintenance
- Three-tier configuration (.env > database > defaults) with admin UI
- Declarative database migrations
- CSRF protection, startup DB/Redis validation, health check endpoint
- Install/update script, .env.example template
- 1,178 tests passing
