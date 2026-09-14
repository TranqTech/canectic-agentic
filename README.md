# Canectic BBS

A modern Bulletin Board System built with Node.js. Terminal and web, classic and connected.

Canectic brings together the BBS experience with modern infrastructure: a full-featured terminal server alongside a responsive web interface, three message networking protocols, file areas with native transfer engines, door game support, and internet email integration.

## Features

### Terminal
- WebSocket terminal support for proxy-friendly connections and reduced bot exposure vs open Telnet ports
- ANSI/CP437 and UTF-8 terminal support with auto-detection
- Telnet and raw TCP with auto-detection on a single port
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
- **FTN** - Type-2 packet tosser, binkp mailer (TCP + WebSocket), BSO outbound scanner, nodelist import
- **QWK** - Client pull/push and hub mode with REP packet support
- **NNTP** - Article pull/push with standard newsgroup interop
- **TIC** - File echo distribution with auto-forwarding
- **Email** - Internet email via SMTP relay (outbound) and trusted gateway (inbound)

### Mail Client Access
- IMAP4rev1 server for accessing BBS private messages from Thunderbird, etc.
- SMTP submission server for sending PMs from mail clients with multi-transport addressing
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
- Three-tier configuration: `.env` > database > defaults
- Health check endpoint for monitoring and container orchestration
- CSRF protection via Origin/Referer verification

## Quick Start

### Requirements

- Node.js 22+
- PostgreSQL 14+
- Redis 6+
- Linux (Debian/Ubuntu recommended)

```bash
# System packages
sudo apt install build-essential python3 postgresql redis-server zip unzip lrzsz
sudo npm install -g pm2
```

### Install

One script. It resolves the current release, verifies its checksum before
unpacking anything, and hands off to that release's own installer.

```bash
curl -fsSLO https://canectic.tranqsoft.com/releases/bootstrap.sh
curl -fsSLO https://canectic.tranqsoft.com/releases/bootstrap.sh.sha256
sha256sum -c bootstrap.sh.sha256 && bash bootstrap.sh --target /opt/canectic --create-database
```

The installer asks where to install and for database credentials, writes `.env`,
creates the directory structure, installs dependencies, builds the schema and
starts the processes. Drop `--create-database` if you have already created the
PostgreSQL role and database yourself (see below).

To read the documentation and run the setup scripts before committing to an
install, unpack it first and stop:

```bash
bash bootstrap.sh --extract-only ~/canectic
cd ~/canectic
less docs/sysop/INSTALL.md
bash setup/create_pg_db_user.sh
node src/tools/install.js --target /opt/canectic
```

### Updating

```bash
node src/tools/update.js --handoff    # stage, then hand off to the new release
node src/tools/update.js --status     # what the last update did
```

Or press the button on `/admin/update`, which shows what is available, what
applying it would do, and how many users are connected. An opt-in daily check
raises a notification when a release exists; it never downloads or applies
anything by itself. Boards with an FTN link can take releases down a file echo
instead, with no outbound connection at all.

Installations predating 0.9.6a upgrade once with `setup/update.sh` from a source
tree, and use the above from then on. See
[docs/sysop/UPDATING.md](docs/sysop/UPDATING.md).

### Creating the database by hand

`setup/create_pg_db_user.sh` needs `sudo -u postgres psql` to work. On systems
where that is restricted, where PostgreSQL runs under a different admin role,
or where peer authentication is disabled, the script fails and you create the
role and database yourself.

```bash
sudo -u postgres psql
```

```sql
CREATE USER canectic WITH PASSWORD 'your_password_here';

CREATE DATABASE canectic_bbs OWNER canectic
  TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C';

\c canectic_bbs
GRANT USAGE, CREATE ON SCHEMA public TO canectic;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO canectic;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO canectic;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO canectic;
\q
```

Three things there are easy to get wrong:

- **`ENCODING 'UTF8'` is required.** Without it the database inherits
  `template1`, which on a C-locale cluster is `SQL_ASCII`. That performs no
  encoding validation at all, so invalid bytes are stored silently and handed
  back unchanged. `TEMPLATE template0` is what permits a different encoding.
- **PostgreSQL 15+ revoked the default `public` schema grants.** Without the
  `GRANT USAGE, CREATE` line, `dbmigrations.js` fails with permission errors.
- **`peer` authentication** is the usual reason a correct password still fails.
  If `psql -U canectic -h localhost -d canectic_bbs` reports "peer
  authentication failed", change the local lines in `pg_hba.conf` from `peer`
  to `scram-sha-256` and `sudo systemctl reload postgresql`.

Verify before continuing:

```bash
psql -U canectic -h localhost -d canectic_bbs -c "SELECT pg_encoding_to_char(encoding) FROM pg_database WHERE datname = current_database();"
```

That should print `UTF8`. Put the same database name, user and password into
`.env`.

Register your first account at `http://localhost:8080/users/register`. The first user is automatically promoted to Sysop.

See [docs/sysop/INSTALL.md](docs/sysop/INSTALL.md) for the full installation guide, including how to convert an existing `SQL_ASCII` database.

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

- [Installation Guide](docs/sysop/INSTALL.md) - Full setup walkthrough
- [Updating](docs/sysop/UPDATING.md) - Applying a release, and what it does to your files
- [Update Checking](docs/sysop/UPDATES.md) - The opt-in release check, channels and FTN delivery
- [Changelog](docs/sysop/CHANGELOG.md) - Every change, by release
- [Architecture Reference](docs/reference/) - Developer documentation for all subsystems
- [Release Tracker](docs/RELEASE_TRACKER.md) - Feature completion status
- [Example .env](examples/env.example) - Environment configuration template

## License

[MIT](LICENSE)
