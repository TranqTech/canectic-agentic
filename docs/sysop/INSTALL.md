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
sudo apt install zip unzip

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

#### Install with nvm (recommended)

```bash
nvm install 26
nvm alias default 26
```

nvm is the recommended way to run Canectic, and the rest of this guide assumes
it. A BBS is expected to stay up for years, across several OS upgrades, and nvm
decouples the Node version from the distro: you upgrade the OS without the
packaged Node moving underneath the BBS, and you upgrade Node without waiting
for your distro to ship it. Setting the `default` alias matters, because that is
what the boot path follows.

Note that global npm packages are installed per Node version under nvm. After
`nvm install` of a new major, re-install anything you rely on globally
(`npm install -g pm2`).

#### Install natively

A distro or NodeSource package works too, and is fully supported. Canectic never
hardcodes an interpreter path, so nothing in the tree assumes one layout or the
other.

```bash
# Debian/Ubuntu, via NodeSource
curl -fsSL https://deb.nodesource.com/setup_26.x | sudo -E bash -
sudo apt install -y nodejs
```

The trade-off is that the Node version is then tied to your distro packaging, so
an OS upgrade can move it without warning. If you go this route, pin the package
and check `node -v` after any OS upgrade.

---

## Quick Start

### One command

```bash
curl -fsSLO https://canectic.tranqsoft.com/releases/bootstrap.sh
curl -fsSLO https://canectic.tranqsoft.com/releases/bootstrap.sh.sha256
sha256sum -c bootstrap.sh.sha256 && bash bootstrap.sh --target /opt/canectic
```

That resolves the newest stable release, downloads it, **verifies its checksum
before unpacking anything**, extracts it, and hands off to that release's own
installer. There is no git clone and no source directory to look after
afterwards.

Verifying the bootstrap first is two extra lines and it is the recommended path.
Piping it straight into a shell works:

```bash
curl -fsSL https://canectic.tranqsoft.com/releases/bootstrap.sh | bash -s -- --target /opt/canectic
```

### Checking the signature

Releases are signed. Import the key once and the bootstrap checks every release
you ever fetch:

```bash
curl -fsSLO https://canectic.tranqsoft.com/releases/canectic-release.asc
gpg --import canectic-release.asc
```

Compare the fingerprint against the one below before you trust it. This is the
number that matters: it does not change if the release host ever moves, and it
is what an installed board pins so that later releases can be checked without
fetching anything.

```
F3F1 6D36 59AF 25FB F947  4C6D B5D8 AB14 3016 761F
```

Without the key imported the bootstrap says the release was not signature
checked and carries on, because a checksum is still a checksum. With it you get
`signature verified` and the whole publish is accounted for: the signature
covers the checksum list, the checksum list covers the release metadata, and the
metadata covers the archive.

A release that arrives down a file echo has no checksum list beside it, only the
archive, which is normal. The archive carries a signed `MANIFEST` inside it
instead, covering every file in the tree.

| Flag | Effect |
|------|--------|
| `--target DIR` | Where to install. Asked for if not given |
| `--channel development` | Track development builds rather than stable |
| `--version 0.9.6a` | A specific release |
| `--from DIR` | Artifacts already on disk, from a file echo or copied by hand |
| `--download-only` | Fetch and verify, then stop, so you can inspect it |
| `--create-database` | Also create the PostgreSQL role and database |
| `--no-deps` / `--no-database` / `--no-start` | Leave those to you |

The installer asks where to install and for database credentials, writes `.env`
at mode 600, creates the runtime directories, installs dependencies, runs the
schema, and starts the processes. Anything it skips it names, with the command
you now owe.

It refuses to install over a directory that already holds Canectic, and points
you at the updater instead, which knows which of your files to leave alone. See
`docs/sysop/UPDATING.md`.

**A development build cannot be installed from nothing.** It is a delta against
a stable release, so install the stable it names first and then update to it.

### Doing it by hand

If you would rather not run a script that downloads things, `--download-only`
gets you a verified artifact and stops:

```bash
bash bootstrap.sh --download-only
unzip canectic-0.9.6a.zip
cd canectic-0.9.6a
node src/tools/install.js --target /opt/canectic
```

The installer inside the release is the same one the bootstrap would have run.

---

## Installing from the source repository

The older path, still supported, and what you want if you are working on
Canectic itself rather than running it.

### 1. Get the Source

**From a release archive (recommended):**

Download the latest release from the [Canectic Releases page](https://gitlab.tranqsoft.com/drog007/canectic/-/releases) and extract:
```bash
unzip canectic-0.9.5a.zip
cd canectic-0.9.5a
```

**From git (specific release):**
```bash
git clone --branch v0.9.6a --depth 1 https://gitlab.tranqsoft.com/drog007/canectic.git
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

This resolves the native addons. `bcrypt`, `node-pty` and `@serialport/bindings-cpp`
build from source when no prebuilt binary matches your platform, which is why
`build-essential` and `python3` are required. `better-sqlite3` v13 ships
prebuilt binaries and does not compile.

On npm 12 and later, which ships with Node 26, dependency install scripts are
blocked unless allowed. Canectic ships the allowlist, so this step needs no
action; see the troubleshooting section if you see a block warning.

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

If you installed Node with nvm, patch the unit `pm2 startup` generates before
you rely on it. As generated it hardcodes the Node version and will stop
booting after an upgrade. See [Surviving Node Upgrades](#surviving-node-upgrades).

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

### Surviving Node Upgrades

`pm2 startup` generates a systemd unit that hardcodes the Node version in both
`PATH` and every `Exec*` line:

```ini
Environment=PATH=/home/you/.nvm/versions/node/v26.8.1/bin:...
ExecStart=/home/you/.nvm/versions/node/v26.8.1/lib/node_modules/pm2/bin/pm2 resurrect
```

Under nvm that pins the service to whichever Node was current the day the unit
was generated. After `nvm alias default 27` the BBS still boots on 26, and once
26 is uninstalled it stops booting at all.

A native Node install has a milder version of the same problem: the unit points
at `/usr/bin/pm2`, which keeps working, but an OS upgrade can move the Node
underneath it without warning.

Canectic ships a wrapper that resolves Node at start time instead of freezing it
into the unit. It follows nvm's `default` alias when nvm is present, and falls
back to whatever `pm2` is on `PATH` when it is not, so the same unit works on
both kinds of install. Install it once, to a path outside the repo (`setup/` is
wiped and recopied by `update.sh`, so a boot during an update would find no
wrapper):

```bash
install -m 755 setup/canectic-pm2.sh ~/.local/bin/canectic-pm2
```

Then edit `/etc/systemd/system/pm2-<user>.service` to drop the nvm directory
from `PATH`, add `NVM_DIR`, and route the `Exec*` lines through the wrapper:

```ini
Environment=PATH=/home/you/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=PM2_HOME=/home/you/.pm2
Environment=NVM_DIR=/home/you/.nvm

ExecStart=/home/you/.local/bin/canectic-pm2 resurrect
ExecReload=/home/you/.local/bin/canectic-pm2 reload all
ExecStop=/home/you/.local/bin/canectic-pm2 kill
```

On a native install, leave `NVM_DIR` out. The wrapper then finds no `nvm.sh` and
goes straight to `pm2` on `PATH`.

Reload systemd and restart once to confirm the new path boots:

```bash
sudo systemctl daemon-reload
sudo systemctl restart pm2-<user>
```

Upgrading Node then needs no unit edit, but it does still need a `pm2 save`,
because `dump.pm2` stores an absolute interpreter path for each of the four
children. Under nvm:

```bash
nvm install 27 && nvm alias default 27
npm install -g pm2                  # globals are per-version under nvm
sudo systemctl restart pm2-<user>
pm2 save                            # re-pin the children in dump.pm2
```

Natively, the package upgrade replaces Node in place, so only the last two steps
apply:

```bash
sudo apt install --only-upgrade nodejs
sudo systemctl restart pm2-<user>
pm2 save
```

Upgrading the operating system underneath a running BBS is a separate job with
its own risks, chiefly the PostgreSQL cluster. See [OS_UPGRADE.md](OS_UPGRADE.md).

Skip the `pm2 save` and the daemon comes up on the new Node while `resurrect`
still spawns the four children under the old interpreter recorded in the dump.
`ecosystem.config.cjs` pins `interpreter` to `process.execPath`, so a plain
`pm2 start ecosystem.config.cjs` followed by `pm2 save` always re-pins the
children to the daemon's own Node. Verify with:

```bash
pm2 jlist | python3 -c "import json,sys; [print(p['name'], p['pm2_env']['node_version']) for p in json.load(sys.stdin)]"
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

### From 0.9.6a onward

```bash
node src/tools/update.js --handoff    # stage the release, hand off to its updater
node src/tools/update.js --status     # what the last update did
```

Or press the button on `/admin/update`, which shows what is available, what
applying it would do to your installation, and how many users are connected.

Either route stops the processes, replaces the files, installs dependencies,
dumps the database, migrates it, runs the release's declared upgrade steps and
starts everything again. Your art, `public/css/custom.css`, door icons and
anything you have edited under `config/` are kept, and the update tells you what
it left alone.

Everything it displaces is copied aside first. A failure before the database has
been migrated puts your files back automatically; after that point it stops and
tells you where the backup and the dump are.

`docs/sysop/UPDATING.md` covers the flags, the phases and how to go back.
`docs/sysop/UPDATES.md` covers the opt-in release check and taking releases over
FTN.

### From a source tree

The old path, needed once to get an installation from 0.9.5a or earlier onto
0.9.6a, and still supported afterwards.

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

After the script completes, re-register the processes:

```bash
pm2 delete all && pm2 start ecosystem.config.cjs && pm2 save
```

`pm2 restart` is not enough. The four apps pin their interpreter when the config
is evaluated, and `pm2 resurrect` replays the previously saved settings, so a
restart can leave the board running on whichever Node was current when you last
saved, with nothing to tell you.

### One-time repairs

Migrations do not run one-time data repairs, because a repair that can only ever
find something once should not scan every message table on every update. Where
one is outstanding, the migration output says so and gives the command.

Currently there is one, the **MSGID tuple split**, for message bases written
before `msg_id` and `msg_orig_addr` were separate columns. If migrations tell
you it has not run:

```bash
node src/tools/maintenance.js --fix-msgids --dry-run   # report only
node src/tools/maintenance.js --fix-msgids             # repair
```

It needs the worker running, takes a while on a large message base, and only
ever needs doing once. Migrations stop mentioning it afterwards.

A fresh install has nothing to repair and is marked done automatically, so you
will only see this on a system carrying older message bases.

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

### npm reports "install scripts blocked" for a native module

npm 12, which ships with Node 26, no longer runs dependency `install` and
`postinstall` scripts by default. That is a supply chain measure: a package can
no longer execute code on your machine simply by being installed. Packages must
be listed in the `allowScripts` field of `package.json`.

Canectic ships that allowlist, so a normal install needs no action. Three
dependencies are approved because their install script is what resolves the
native binary, and nothing works without it:

| Package | Why it must run | What breaks without it |
|---|---|---|
| `bcrypt` | `node-gyp-build` | password hashing, so nobody can log in |
| `node-pty` | prebuild or `node-gyp rebuild` | door games |
| `@serialport/bindings-cpp` | `node-gyp-build` | DOS doors over socat serial pairs |
| `better-sqlite3` | `node-gyp rebuild` | Synchronet JS door data, on platforms with no prebuilt binary |

`better-sqlite3` is a special case worth understanding. It ships prebuilt
binaries for Linux, macOS and Windows on x64 and arm64, including a musl
variant, and on those platforms it never compiles: it loads
`prebuilds/<platform>-<arch>.node` directly. It even sets `gypfile: false` in
its manifest to say so. npm still flags it, because it keys off the
`binding.gyp` file shipped in the package rather than that field. Blocking it is
harmless on a mainstream platform, but it is approved anyway so that a system
with no matching prebuild falls back to compiling rather than failing at first
door launch with a missing-bindings error.

Three more are deliberately **denied**, because each is an optional accelerator
with a working fallback: `msgpackr-extract` (an optional dependency of
`msgpackr`, which uses a JavaScript path without it), `cpu-features` (an
optional dependency of `ssh2`, whose `require` is wrapped in a `try`), and
`ssh2` itself, whose install script builds an *optional* crypto binding and
exits successfully when that fails. Denying them costs a little SFTP and
queue-serialisation speed and nothing else.

The three approvals are **pinned to versions**. After upgrading any of them you
will see the block warning again, which is intended: re-approve deliberately
with

```bash
npm install-scripts approve bcrypt node-pty @serialport/bindings-cpp better-sqlite3
npm install-scripts ls        # review anything still unreviewed
```

and commit the updated `package.json`. If you see the warning for a package not
listed above, review it before approving rather than approving to clear the
message.

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
