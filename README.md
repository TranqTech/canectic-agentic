# Canectic BBS

A modern Bulletin Board System built with Node.js — terminal and web, classic and connected.

Canectic brings together the BBS experience with modern infrastructure: a full-featured terminal server alongside a responsive web interface, three message networking protocols, file areas with native transfer engines, door game support, and internet email integration.

## Features

### Terminal
- ANSI/CP437 and UTF-8 terminal support with auto-detection
- Wide terminal formatting and auto-scaling geometry
- Hotkey menus with configurable colors and layout
- Threaded message reading with scrolling viewport and quoting
- Full-screen message editor with word wrap
- File browsing with native XMODEM and ZMODEM transfer engines
- Batch file downloads with tag-and-download
- Door game support: native shell, DOS (dosemu2), Synchronet JS shims
- Private messaging with multi-transport compose (Local, FTN, QWK, Email)

### Web
- Responsive web forum (Bootstrap 5 Darkly theme)
- Message browsing by group, area, and thread
- File browsing, download, and multipart upload with hash verification
- Webmail-style private messaging with split-pane inbox
- User registration wizard with AJAX validation
- Landing page with announcement/bulletin system
- Admin dashboard with full CRUD for all system entities

### Networking
- **FTN** — Type-2 packet tosser, binkp mailer (TCP + WebSocket), BSO outbound scanner, nodelist import
- **QWK** — Client pull/push and hub mode with REP packet support
- **NNTP** — Article pull/push with standard newsgroup interop
- **TIC** — File echo distribution with auto-forwarding
- **Email** — Internet email via SMTP relay (outbound) and trusted gateway (inbound)

### Mail Client Access
- IMAP4rev1 server — access BBS private messages from Thunderbird, etc.
- SMTP submission server — send PMs from mail clients with multi-transport addressing
- Cross-process event push for IMAP IDLE notifications

### Administration
- Web-based admin panel with DataTables and modal CRUD
- Message groups, areas, networks, and peer connections
- File groups, areas, and distribution management
- User management with security levels, permission/restriction flags
- Menu editor with ANSI color picker and hotkey configuration
- Door game configuration with variable substitution
- Announcement/bulletin management with TinyMCE rich text editor
- Configuration editor with category organization and live reload
- FTN nodelist browser with import, search, and flag glossary
- Live log viewer with WebSocket push

### Infrastructure
- Four-process model managed by PM2 (gateway, worker, mail, mailer)
- BullMQ job queues backed by Redis for inter-process work
- Redis pub/sub event bus for cross-process notifications
- PostgreSQL primary data store with declarative schema migrations
- Three-tier configuration: `.env` → database → defaults
- Health check endpoint for monitoring and container orchestration
- CSRF protection via Origin/Referer verification

## Quick Start

### Requirements

- Node.js 18+
- PostgreSQL 14+
- Redis 6+
- Linux (Debian/Ubuntu recommended)

```bash
# System packages
sudo apt install build-essential python3 postgresql redis-server zip lrzsz
sudo npm install -g pm2
```

### Install

Download the latest release from the [Releases page](https://gitlab.tranqsoft.com/drog007/canectic/-/releases), or clone a specific version:

```bash
git clone --branch v0.9.0-alpha.1 --depth 1 https://gitlab.tranqsoft.com/drog007/canectic.git
cd canectic
bash setup/install.sh          # choose install directory
cd /opt/canectic               # or your chosen path

bash setup/create_pg_db_user.sh   # create database and user
$EDITOR .env                      # set database credentials
npm install                       # install dependencies
node src/tools/dbmigrations.js    # create tables
pm2 start ecosystem.config.cjs    # start all processes
```

Register your first account at `http://localhost:8080/users/register` — the first user is automatically promoted to Sysop.

See [docs/sysop/INSTALL.md](docs/sysop/INSTALL.md) for the full installation guide.

## Running

```bash
# PM2 (production)
pm2 start ecosystem.config.cjs
pm2 logs
pm2 monit

# Single process (development)
PROCESS_MODE=embedded node bin/gateway.js

# Individual processes
node bin/gateway.js      # HTTP, WebSocket, terminal
node bin/worker.js       # tossers, maintenance
node bin/mail.js         # IMAP + SMTP
MAILER_ENABLED=true node bin/mailer.js   # FTN binkp
```

## Default Ports

| Service | Port | Notes |
|---------|------|-------|
| Web / HTTP | 8080 | Web UI and WebSocket connections |
| Terminal | 2023 | Auto-detects Telnet vs raw TCP |
| IMAP | 10143 | PM access from mail clients |
| SMTP | 10587 | Send PMs from mail clients |
| Binkp | 24554 | FTN mailer (when enabled) |

## Tests

```bash
npm test
```

## Documentation

- [Installation Guide](docs/sysop/INSTALL.md) — full setup walkthrough
- [Architecture Reference](docs/reference/) — developer documentation for all subsystems
- [Release Tracker](docs/RELEASE_TRACKER.md) — feature completion status
- [Example .env](examples/env.example) — environment configuration template

## License

MIT — see [LICENSE](LICENSE)
