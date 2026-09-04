# Canectic BBS — Installation Guide

## Prerequisites

### Operating System

Canectic BBS runs on Linux. Tested on Debian/Ubuntu-based systems. Other distributions should work with equivalent packages.

### System Packages

```bash
# Required
sudo apt install build-essential python3 postgresql redis-server

# Required for file transfers (native engines are used by default; lrzsz is a legacy fallback)
sudo apt install lrzsz

# Required for QWK packet creation
sudo apt install zip

# Recommended
sudo npm install -g pm2        # Process management (or: npm install -g pm2)

# Optional — for DOS door games
sudo apt install dosemu2
```

### Node.js

Node.js 22 or later is required. The project uses ES modules, Express 5, and the `--experimental-vm-modules` flag for Synchronet JS door shims.

The floor is 22 because `better-sqlite3` v13 requires it. That version is worth
having: it is the first release built on N-API, so its native binary is stable
across Node major versions and ships prebuilt. Earlier releases had to be
compiled against each Node version's V8 internals, which is what made installs
fail on newer Node and required `build-essential` and `python3` to be present.

```bash
# Using nvm (recommended)
nvm install 20
nvm use 20
```

---

## Quick Start

### 1. Get the Source

**From a release archive (recommended):**

Download the latest release from the [Canectic Releases page](https://gitlab.tranqsoft.com/drog007/canectic/-/releases) and extract:
```bash
tar xzf canectic-v0.9.5a.tar.gz
cd canectic-v0.9.5a
```

**From git (specific release):**
```bash
git clone --branch v0.9.5a --depth 1 https://gitlab.tranqsoft.com/drog007/canectic.git
cd canectic
```

**From git (latest development):**
```bash
git clone https://gitlab.tranqsoft.com/drog007/canectic.git
cd canectic
```

### 2. Run the Installer

The install script copies files from the source into a run directory, keeping your config and data separate from the source repo.

```bash
bash setup/install.sh
```

You'll be prompted to choose an installation directory:
1. `/opt/canectic`
2. `~/canectic`
3. Custom path

Then switch to the run directory for all remaining steps:

```bash
cd /opt/canectic    # or your chosen path
```

### 3. Set Up PostgreSQL

Create a database and user for Canectic. You can use the helper script or do it manually.

**Option A: Helper script**

```bash
bash setup/create_pg_db_user.sh
```

This prompts for a database name, username, and password. If it fails (common on systems where `sudo -u postgres` or `createuser` is restricted), use Option B instead.

**Option B: Manual setup**

Connect to PostgreSQL as the postgres superuser:

```bash
sudo -u postgres psql
```

Then run these commands (replace the values as desired):

```sql
CREATE USER canectic WITH PASSWORD 'your_password_here';
CREATE DATABASE canectic_bbs OWNER canectic
  TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C';
```

The `ENCODING` clause is not optional. Without it the database inherits its
encoding from `template1`, and a cluster whose `initdb` ran under a C or POSIX
locale defaults to `SQL_ASCII`. `SQL_ASCII` performs no encoding validation
whatsoever: invalid byte sequences are stored silently and returned unchanged,
so any component writing non-UTF-8 corrupts data without raising an error.
Message bodies carry CP437 art and accented names, so this matters in practice.

`TEMPLATE template0` is what allows an encoding different from the cluster
default. Keeping `LC_COLLATE` and `LC_CTYPE` as `C` means any encoding is
permitted, sorting is byte order, and case folding stays ASCII-only, which is
what Canectic already expects.

Check what you ended up with:

```sql
SELECT pg_encoding_to_char(encoding), datcollate, datctype
  FROM pg_database WHERE datname = 'canectic_bbs';
```

PostgreSQL 15+ changed the default permissions on the `public` schema. You must grant access explicitly. Connect to the new database and grant permissions:

```sql
\c canectic_bbs
GRANT ALL ON SCHEMA public TO canectic;
\q
```

Verify the connection works:

```bash
psql -U canectic -h localhost -d canectic_bbs
```

If prompted for a password, enter what you set above. If the connection fails with "peer authentication failed", ensure `pg_hba.conf` allows password auth for local connections (change `peer` to `md5` or `scram-sha-256` for the local IPv4/IPv6 lines, then `sudo systemctl reload postgresql`).

Remember the database name, username, and password -- you'll need them for `.env`.

### 4. Configure Environment

Edit `.env` (created from `examples/env.example` during install):

```bash
$EDITOR .env
```

**Required settings:**
```ini
dbuser=canectic          # PostgreSQL username (from step 3)
dbhost=localhost
dbname=canectic_bbs      # Database name (from step 3)
dbpass=YOUR_PASSWORD      # Password (from step 3)
```

**Optional but recommended:**
```ini
boardname=My BBS          # Displayed in nav bar, origin lines, mailer
SYSOP_USERNAME=YourName   # Sysop username for PM system notifications
mail_domain=mybbs.example.com  # Required for IMAP/SMTP and internet email
```

All other configuration is managed through the Admin UI at `/admin/config` after first login. For a full walkthrough of the mail subsystem (outbound SMTP relay, inbound gateway, mail client access, user verification), see [MAIL.md](MAIL.md).

### 5. Install Dependencies

```bash
npm install
```

This compiles native addons (node-pty, bcrypt, better-sqlite3). The `build-essential` and `python3` packages are required for this step.

### 6. Run Database Migrations

```bash
node src/tools/dbmigrations.js
```

This creates all tables and columns. Safe to run multiple times — it only adds what's missing.

### 7. Start the BBS

**With PM2 (recommended for production):**
```bash
pm2 start ecosystem.config.cjs
pm2 save      # persist across reboots
pm2 startup   # generate system startup script
```

**Single process (development/testing):**
```bash
PROCESS_MODE=embedded node bin/gateway.js
```

**Direct multi-process (without PM2):**
```bash
node bin/gateway.js &
node bin/worker.js &
node bin/mail.js &
# Only if FTN mailer is needed:
MAILER_ENABLED=true node bin/mailer.js &
```

### 8. Create Your Sysop Account

The **first user to register** is automatically promoted to Sysop with full admin access.

**Web:**
Open `http://localhost:8080/users/register` and complete the registration wizard.

**Terminal:**
Connect with a terminal client:
```bash
telnet localhost 2023
```
Choose "New User" and complete registration.

### 9. Verify

- **Web UI:** `http://localhost:8080` — you should see the landing page
- **Admin panel:** `http://localhost:8080/admin` — accessible after logging in as Sysop
- **Health check:** `http://localhost:8080/health` — should return `{"status":"ok"}`
- **Terminal:** `telnet localhost 2023` — should show terminal negotiation and login prompt

---

## Process Model

Canectic runs as four independent processes, all sharing PostgreSQL and Redis:

| Process | Script | Purpose |
|---------|--------|---------|
| **Gateway** | `bin/gateway.js` | Web UI, terminal connections, WebSocket pools |
| **Worker** | `bin/worker.js` | Message tossing (FTN/QWK/NNTP/Email), maintenance jobs |
| **Mail** | `bin/mail.js` | IMAP and SMTP servers for mail client access |
| **Mailer** | `bin/mailer.js` | FTN binkp mailer sessions (requires `MAILER_ENABLED=true`) |

For development or simple setups, use `PROCESS_MODE=embedded` to run everything in a single process.

PM2 commands:
```bash
pm2 start ecosystem.config.cjs    # start all
pm2 restart gateway                # restart one process
pm2 logs worker                    # tail logs
pm2 monit                          # live monitoring dashboard
```

---

## Default Ports

| Service | Port | Config Key | Notes |
|---------|------|-----------|-------|
| Web / HTTP | 8080 | `webport` | Web UI + WebSocket |
| Terminal | 2023 | `terminalport` | Auto-detects TCP vs Telnet |
| IMAP | 10143 | `imapport` | PM access from mail clients |
| SMTP Submission | 10587 | `smtpport` | Send PMs from mail clients |
| Binkp (FTN) | 24554 | `MAILER_BINKP_PORT` | FTN mailer (if enabled) |

Set any port to `0` to disable that listener. Port changes require a process restart.

---

## Updating

### From Git

```bash
cd /path/to/canectic-bbs-repo
git pull
bash setup/update.sh /opt/canectic
```

The update script:
- Overwrites code files cleanly
- Preserves your `.env` and data directories
- Prompts before overwriting locally-modified config/data files
- Installs/updates npm dependencies
- Runs database migrations automatically

After the script completes, restart services:

```bash
pm2 restart all
```

---

## Directory Structure

After installation, your run directory contains:

```
/opt/canectic/
├── .env                    # Your configuration (not overwritten on update)
├── ecosystem.config.cjs    # PM2 process configuration
├── bin/                    # Process entry points
├── src/                    # Application source code
├── db/                     # Schema definitions
├── public/                 # Static web assets
├── config/                 # Terminal themes, default menus
│   ├── default/            # Default menu configurations
│   └── themes/             # Terminal color themes
├── txtfiles/               # ANSI/ASCII art and text files
│   ├── ans/                # ANSI art files
│   └── asc/                # ASCII text files
├── ftn/                    # FTN network directories
│   ├── in/                 # Inbound packets
│   ├── out/                # Outbound packets
│   ├── tossed/             # Processed packets
│   ├── bad/                # Bad/rejected packets
│   └── tmp/                # Temp working directory
├── qwk/                    # QWK network packet staging
├── files/                  # File area storage
│   └── staging/            # Upload staging directory
├── logs/                   # Log files
│   └── production/         # PM2 process logs
├── xtrn/                   # Door game programs
├── setup/                  # Setup scripts
├── examples/               # Example configuration files
├── docs/                   # Documentation
│   ├── sysop/              # This guide and other sysop docs
│   └── reference/          # Architecture reference (developers)
└── tests/                  # Test suite
```

---

## Troubleshooting

### "PostgreSQL is not reachable"

- Check that PostgreSQL is running: `sudo systemctl status postgresql`
- Verify credentials in `.env` match what you created in step 3
- Test manually: `psql -U canectic -h localhost -d canectic_bbs`

### "Redis is not reachable"

- Check that Redis is running: `sudo systemctl status redis-server`
- Verify `redis_url` in `.env` (default: `redis://localhost:6379`)
- Test manually: `redis-cli ping`

### Web UI shows "Internal Server Error"

- Check the gateway logs: `pm2 logs gateway`
- Ensure database migrations have run: `node src/tools/dbmigrations.js`

### Existing database is SQL_ASCII instead of UTF8

Installs created before the encoding was set explicitly inherited whatever
`template1` used, which on a C-locale cluster is `SQL_ASCII`. Check with:

```sql
SELECT pg_encoding_to_char(encoding), datcollate, datctype
  FROM pg_database WHERE datname = current_database();
```

Encoding cannot be altered in place, so converting means dumping and reloading
into a new database. Because the collation stays `C`, sort order and case
folding are byte-identical afterwards; the only change is that PostgreSQL
starts validating bytes on write.

There is a script for this:

```bash
pm2 stop all
bash setup/convert_db_encoding.sh --source canectic_bbs
pm2 start ecosystem.config.cjs
```

The converted database takes over the original name and the old one is renamed
aside to `canectic_bbs_sqlascii_<timestamp>`, so **`.env` needs no change**.

The order matters: it dumps, restores into a staging database, and compares row
counts table by table, and only renames anything once that has passed. A
failure at any earlier point leaves the original exactly where it was. Before
starting it also scans every text column for bytes that are not valid UTF-8 and
refuses if it finds any, since those would fail the reload.

Stopping the processes is required rather than advisory, and the script
enforces it: PostgreSQL cannot rename a database while anything is connected.
It refuses if it finds a connection, then sets `CONNECTION LIMIT 0` on the
source for the duration so nothing can reconnect part way through. An idle
connection pool reports zero connections and will happily reconnect, which
would put writes into the backup instead of the live database.

To roll back, stop everything and swap the two names again; the script prints
the exact commands.

If you would rather keep the original in place and have the copy under a new
name, pass `--target`. Nothing is renamed in that mode, and you repoint `dbname`
in `.env` yourself:

```bash
bash setup/convert_db_encoding.sh --source canectic_bbs --target canectic_utf8
```

To check whether a database needs converting without changing anything:

```bash
bash setup/convert_db_encoding.sh --source canectic_bbs --preflight-only
```

Stop the processes first. A dump taken while the system is writing is
internally consistent but misses anything committed after it starts.

The equivalent by hand, if you would rather do it yourself:

```bash
pg_dump -Fc canectic_bbs > canectic_bbs.dump
createdb -T template0 -E UTF8 --lc-collate=C --lc-ctype=C -O canectic canectic_utf8
pg_restore -d canectic_utf8 canectic_bbs.dump
```

`pg_restore` validates every byte on the way in, so an invalid sequence fails
the restore loudly rather than corrupting the new database. If the restore
succeeds, compare a few row counts, point `dbname` in `.env` at the new
database, and restart. Keep the original database until you are satisfied.

### Web login returns to the login page with no error

Terminal login works for the same account, but the web login form just
redirects back to itself. Authentication is succeeding; the browser is
discarding the session cookie.

- Check `sitetld` (admin > config > network). It sets the cookie `Domain`,
  and the FQDN you browse must be at or under it. `example.com` covers
  `bbs.example.com`, but not `example.org`, and not a bare IP address.
- Leave `sitetld` empty unless you need the session shared across
  subdomains. Empty sends a host-only cookie that always matches whatever
  host the request arrived on.
- Confirm in browser devtools: if no `sessionid` cookie is stored after
  the login POST, it is the domain mismatch. If the cookie is present and
  you are still bounced, look at Redis instead (`redis-cli ping`), since
  a failed session write shows an explicit "Login failed" error rather
  than a silent redirect.

### Terminal connection hangs or drops

- Verify `terminalport` is not 0 in your config
- Check firewall rules: `sudo ufw status`
- Try raw TCP: `nc localhost 2023`

### Native addon build failures (npm install)

- Ensure `build-essential` and `python3` are installed
- For node-pty: may need `sudo apt install libutil-dev` on some systems
- Try clearing and rebuilding: `rm -rf node_modules && npm install`

### Health check returns 503

- One or both databases are unreachable
- Check the response body for which service is down
- `curl -s http://localhost:8080/health | python3 -m json.tool`
