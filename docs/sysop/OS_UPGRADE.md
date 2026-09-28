# OS Upgrades

A BBS is expected to stay up for years, across several operating system releases. This guide covers upgrading the host OS underneath a running Canectic install without losing message bases, user records, or door games.

The short version: Canectic itself is barely affected by an OS upgrade. What breaks is the infrastructure around it, and almost all of the risk is concentrated in one place, the PostgreSQL cluster.

## What the OS actually controls

Knowing which pieces move with the distro and which do not is most of the job.

| Component | Tied to the OS? | What an upgrade does to it |
|---|---|---|
| **PostgreSQL** | Yes | Installs a new major version. **Does not migrate your data.** The old cluster is left behind and the new one starts empty. This is the main risk. |
| **Redis** | Yes | Version bump, usually smooth. Watch for a package rename (see [Redis](#2-redis-check-the-package-and-the-major-version)). |
| **Third-party PPAs** | Yes | Disabled during the upgrade. Anything installed from one (notably dosemu2) needs the source re-pointed at the new release afterwards. |
| **socat, zip, lrzsz** | Yes | Version bump only. No ABI coupling, nothing to do. |
| **Node** | **No** | If you installed Node with nvm, it lives in `~/.nvm` and the OS upgrade cannot touch it. See [Surviving Node Upgrades](INSTALL.md#surviving-node-upgrades). |
| **Canectic + node_modules** | **No** | Plain files in your install directory. |
| **pm2 + its systemd unit** | **No** | The unit lives in `/etc/systemd/system` and is not managed by the package manager. With the wrapper from `setup/canectic-pm2.sh` in place it does not name a Node version, so it survives. |

If you run Node natively from a distro package rather than nvm, add it to the "tied to the OS" list: the upgrade will move it, possibly below Canectic's floor of Node 22. That is the argument for nvm.

## If Canectic runs in a container

Check first, because it changes several steps:

```bash
systemd-detect-virt
```

If this reports `lxc` (or another container type) rather than `none` or a hypervisor name, then:

- **There is no kernel to upgrade.** `dpkg -l 'linux-image-*'` will be empty and the container runs the host's kernel. That removes a whole category of upgrade risk, and it means `/var/run/reboot-required` is about restarting services after library upgrades, not about booting a new kernel.
- **"Reboot" means restarting the container**, from the host (`pct reboot <id>` on Proxmox), not `reboot` from inside.
- **Snapshot from the host, not from inside.** This is the single best thing you can do before an OS upgrade. On Proxmox with LXC on ZFS or Ceph RBD:

```bash
# on the Proxmox host, not in the container
pct snapshot <ctid> preupgrade-$(date +%Y%m%d)
pct listsnapshot <ctid>
```

A snapshot turns the [rollback](#rollback) section from a data recovery exercise into a one command restore. If your storage backend supports it, take one and the rest of this guide becomes a safety net you probably will not need.

For a full VM rather than a container, the equivalent is `qm snapshot <vmid> <name>`, and the kernel does upgrade normally.

## Before you upgrade

### 1. Confirm the upgrade is offered

```bash
do-release-upgrade -c
```

Ubuntu only offers LTS to LTS upgrades once Canonical opens the path, which is normally some months after the target's first point release. If this reports no release available, that is the gate, not a fault on your machine.

You can see the gate directly. `do-release-upgrade` reads Canonical's release index and honours a per-release `Supported` flag:

```bash
curl -s https://changelogs.ubuntu.com/meta-release-lts | awk '/^Dist: <target>/,/^$/'
```

`Supported: 1` means the upgrade is open, `Supported: 0` means it is published but not yet enabled. The rest of the entry (`UpgradeTool`, release notes) is populated well before the flag flips, so its presence is not a signal that you can proceed. Re-check periodically rather than looking for an announcement.

Do not work around a closed gate. `-d` targets the development release, not your intended LTS, and hand-editing `sources.list` skips the upgrade tool's handling of held packages, obsolete package removal and third-party source disabling.

### 2. Record the current state

You want to be able to answer "what did this look like before" without guessing.

```bash
lsb_release -ds > ~/preupgrade-state.txt
pg_lsclusters >> ~/preupgrade-state.txt
redis-server --version >> ~/preupgrade-state.txt
node -v >> ~/preupgrade-state.txt
nvm alias default >> ~/preupgrade-state.txt 2>/dev/null
dpkg -l | grep -E '^ii' | awk '{print $2" "$3}' >> ~/preupgrade-state.txt
pm2 jlist > ~/preupgrade-pm2.json
```

### 3. Back up the database

**This is the step you cannot skip.** Everything Canectic owns lives here: users, message groups and areas, every per-area `mb_<shortcode>_msgs` and `mb_<shortcode>_threads` table, file entries, config settings, pointers, and network peer config.

```bash
sudo -u postgres pg_dumpall --clean --if-exists | gzip > ~/canectic-pg-$(date +%Y%m%d).sql.gz
ls -lh ~/canectic-pg-*.sql.gz
```

`pg_dumpall` captures roles and all databases, so it restores a working cluster rather than just table data. Verify the file is a plausible size before continuing, and copy it off the machine if you can.

### 4. Back up config and file data

The database does not contain your `.env`, your art, or your file areas.

```bash
cd /path/to/canectic
tar czf ~/canectic-files-$(date +%Y%m%d).tar.gz \
    .env config/ ftn/ qwk/ qnet/ files/ xtrn/ txtfiles/ public/css/custom.css
```

Also save the pm2 unit and wrapper, which are outside the repo:

```bash
cp /etc/systemd/system/pm2-*.service ~/
cp ~/.local/bin/canectic-pm2 ~/canectic-pm2.backup
```

### 5. Note your third-party sources

```bash
grep -rE 'URIs|Suites|^deb ' /etc/apt/sources.list.d/ 2>/dev/null
```

Write down every PPA and its suite. The upgrade disables all of them, and you will need to re-point each at the new release codename. Check ahead of time that each PPA actually publishes for the target release, since an abandoned PPA is a good reason to delay the upgrade.

### 6. Stop the BBS

Close the board for maintenance first, so connected callers and web users are
warned and network work in progress finishes, then stop it once it has drained:

```bash
node src/tools/maintenanceMode.js --on --reason "Operating system upgrade" --minutes 120 --wait
pm2 stop all
sudo systemctl stop pm2-$USER
```

The board stays closed until you reopen it, including across the reboot, which
is what you want while you check it afterwards. See `MAINTENANCE.md`.

Leaving it running risks writes landing in a database that is about to be replaced underneath it.

**Do not run `pm2 save` after stopping.** The dump records current state, so saving now records four *stopped* processes, and `pm2 resurrect` at boot faithfully restores them stopped. Save before you stop, or not at all.

Beware also of any command that starts a pm2 daemon behind your back. Plain `pm2 -v` or `pm2 list` will spawn one outside systemd, which then blocks the later `systemctl start` with a PID-ownership error. If you have run one, `pm2 kill` before starting the service.

## Running the upgrade

```bash
sudo do-release-upgrade
```

Answer the prompts. When asked about modified configuration files, keep your version for anything you have customised (`postgresql.conf`, `redis.conf`, `pg_hba.conf`) and take the maintainer's version for files you have never touched.

Expect a reboot at the end.

## After the upgrade

### 1. PostgreSQL: migrate the cluster

This is the step that most often gets missed, because nothing obviously fails. The release upgrade installs the new PostgreSQL major but leaves your data in the old cluster, and a new empty cluster answering on 5432 looks perfectly healthy while containing nothing.

```bash
pg_lsclusters
```

**What you see here varies, and it changes the command you run.** On a system where the new major auto-created its own cluster you will see two, the old one and a new empty one. On a system where `postgresql-common` detected the existing cluster it skips that, and you will see only the old one. Both are normal.

```bash
# ONLY if pg_lsclusters showed an empty new cluster:
sudo pg_dropcluster <NEW> main --stop

# then, in either case:
sudo pg_upgradecluster <OLD> main
```

Do not run `pg_dropcluster` blind. If no new cluster was created it fails, and on a system where one exists but is *not* empty you would be deleting real data.

A two major version jump (16 to 18, say) is handled in one step. There is no need to hop through intermediate versions.

#### If pg_upgradecluster is interrupted

Worth knowing before you start, because the recovery is not obvious.

While it runs, `pg_upgradecluster` starts the new cluster **itself, outside systemd**, with a temporary restricted `pg_hba.conf` (you will see `-c hba_file=/tmp/pg_hba.XXXXXX.conf` in the process list) so no client can connect mid-migration. Its final steps are to stop that instance, swap the ports so the new cluster takes the old one's port, and hand control back to systemd.

If it dies before those final steps, you get a confusing state:

- `pg_lsclusters` reports the new cluster **down** while it is very much running, because it reads systemd's view and systemd does not own the process
- `systemctl start postgresql@<NEW>-main` fails with `Cluster is already running` and a `New main PID ... does not belong to service` protocol error
- the ports are still unswapped, so your application's 5432 is pointed at the old cluster

The data is usually fine; only the cleanup was missed. Finish it by hand:

```bash
sudo pg_ctlcluster <OLD> main stop            # stop the old cluster
sudo pg_ctlcluster <NEW> main stop            # stop the temporary un-systemd instance
sudo pg_conftool <OLD> main set port 5433     # park the old one
sudo pg_conftool <NEW> main set port 5432     # new cluster takes the app's port
sudo systemctl reset-failed postgresql@<NEW>-main.service
sudo systemctl start postgresql@<NEW>-main.service
```

Confirm systemd owns it now and no temporary hba file remains:

```bash
pg_lsclusters                                  # <NEW>/main online on 5432
pgrep -af 'postgresql/<NEW>/bin/postgres' | grep -o 'hba_file=[^ ]*'   # should print nothing
```

#### Do not mistake page cache for memory pressure

The migration streams the whole cluster through `pg_dump`, which fills the page cache. `free` will show very little "free" memory while showing plenty "available", and monitoring or supervisors that watch the wrong column may decide the system is out of memory and kill something mid-migration.

Before reacting, check whether an OOM actually happened:

```bash
free -h                                   # look at "available", not "free"
cat /sys/fs/cgroup/memory.events          # oom_kill should be 0
pgrep -af pg_upgradecluster               # is it actually still running?
```

`buff/cache` is reclaimable and is exactly what heavy sequential reads are supposed to produce. If `oom_kill` is 0 and the process is alive, leave it alone. Killing a migration halfway is far worse than waiting.

#### Verify the data properly

Table counts alone are not enough. Compare **every table's row count** and **every sequence value** against the old cluster, which is still readable on its parked port. Unset sequences are the dangerous failure: the data looks perfect and then the next insert collides with an existing id.

```bash
OLD_PORT=5433; NEW_PORT=5432; DB=<your_db>
q() { sudo -u postgres psql -p "$1" -d "$DB" -tAc "$2" | tr -d ' '; }

for t in $(q $OLD_PORT "select table_name from information_schema.tables
                        where table_schema='public' and table_type='BASE TABLE' order by 1;"); do
    a=$(q $OLD_PORT "select count(*) from \"$t\";")
    b=$(q $NEW_PORT "select count(*) from \"$t\";")
    [ "$a" != "$b" ] && echo "MISMATCH $t: old=$a new=$b"
done

for s in $(q $OLD_PORT "select sequencename from pg_sequences where schemaname='public' order by 1;"); do
    a=$(q $OLD_PORT "select coalesce(last_value,0) from \"$s\";")
    b=$(q $NEW_PORT "select coalesce(last_value,0) from \"$s\";")
    [ "$a" != "$b" ] && echo "SEQUENCE DIFF $s: old=$a new=$b"
done
```

Silence from both loops means the migration is sound. Then confirm your application's own database user can authenticate over TCP, not just `postgres` over the unix socket, since that is the path Canectic actually uses:

```bash
PGPASSWORD=<pass> psql -h 127.0.0.1 -p 5432 -U <dbuser> -d <dbname> \
    -tAc "select current_setting('server_version');"
```

#### Rebuild the planner statistics

**Do not skip this.** A dump and restore carries no statistics, so the planner flies blind and queries that were fast become slow for no visible reason.

```bash
sudo -u postgres vacuumdb --analyze-only -d <your_db> -p 5432
```

Check it worked. The count should jump to roughly your number of non-empty tables:

```bash
sudo -u postgres psql -d <your_db> -tAc \
    "select count(distinct tablename) from pg_stats where schemaname='public';"
```

#### Keep the old cluster

Only once every check above passes should you remove it:

```bash
sudo pg_dropcluster <OLD> main
```

Keep it until you are certain. It costs nothing but disk and it is your fastest rollback.

If `pg_upgradecluster` fails outright, fall back to the dump: create a fresh cluster and `gunzip -c ~/canectic-pg-*.sql.gz | sudo -u postgres psql`.

### 2. Redis: check the package and the major version

```bash
systemctl status redis-server || systemctl status valkey
redis-cli ping
redis-server --version
```

Two separate things can move here: which server the distro packages, and how far the version jumps.

**Which server.** Debian and Ubuntu spent a period moving toward valkey as the packaged Redis-compatible server, following Redis's licence change. Redis 8 restored a permissive option, which let the distros package Redis itself again, so a release that once looked headed for valkey may well ship Redis. Ubuntu 26.04 does ship Redis, not valkey (confirmed on a 26.04 install). Canectic works with either: ioredis and BullMQ speak the same protocol to both, and `redis_url` does not change so long as the port is still 6379. What changes is the service name and config path (`/etc/valkey/valkey.conf` rather than `/etc/redis/redis.conf`).

**How far the version jumps.** 24.04 ships Redis 7.0.x and 26.04 ships 8.0.5, so an upgrade along that path crosses a major version. Two consequences worth planning for:

- **RDB format is forward-only.** Redis 8 writes a dump that Redis 7 refuses to load. If you roll the OS back, the Redis dataset does not come with you. Treat Redis data as expendable across the upgrade rather than something you can restore into the old version.
- **The `redis.conf` conffile prompt matters.** Taking the maintainer's version resets any tuning you have done. `maxmemory-policy` in particular must stay `noeviction`, because BullMQ cannot tolerate eviction of job keys.

Check it explicitly once the upgrade is done:

```bash
redis-cli config get maxmemory-policy    # must be: noeviction
redis-cli config get maxmemory           # 0 unless you deliberately capped it
```

**Blast radius if the Redis dataset is lost.** Unlike PostgreSQL, this is recoverable on its own, which is why Redis does not need the ceremony the database does:

| Redis DB | Holds | If lost |
|---|---|---|
| 0 | Sessions, presence, cache | Everyone is logged out and logs back in. No data loss. |
| 2 | BullMQ queues and job schedulers | `registerSchedules()` runs at gateway startup and uses `upsertJobScheduler`, which is idempotent, so every recurring job (polls, toss cycles, daily maintenance) re-registers itself on the next boot. |

The one real casualty is jobs that were queued but not yet processed. In practice these are re-discoverable: inbound packets are still on disk and get picked up by the inbound scan and BSO scanner on the next sweep. Run a manual toss pass afterwards to be sure:

```bash
node src/tools/tosser.js --in
```

Client compatibility needs no action: Canectic uses bullmq 6.x and ioredis 6.x, both of which support Redis 8.

Confirmed in practice on the 24.04 to 26.04 path: Redis 8.0.5 read the 7.0.x dataset without complaint, `maxmemory-policy` survived as `noeviction`, and both databases came through with their keys intact.

### 3. Node and native addons

With nvm, nothing should have moved:

```bash
node -v          # should match preupgrade-state.txt
which node       # should still be under ~/.nvm
```

Native addons compiled before the upgrade link against `libstdc++.so.6`, `libgcc_s.so.1` and `libc.so.6`. glibc is forward-compatible through symbol versioning, so binaries built on an older release keep running on a newer one. The prebuilt N-API modules (bcrypt, better-sqlite3, serialport) are stable across both Node versions and glibc by design.

This has been confirmed in practice across glibc 2.39 to 2.43 (24.04 to 26.04): the locally compiled addons (`node-pty`, ssh2's `sshcrypto`, `cpu-features`, `msgpackr-extract`) loaded without a rebuild and the full suite passed unchanged.

**Check the build toolchain is still installed.** A release upgrade can drop
`build-essential`, and the loss is silent: every native addon keeps working
because the compiled artefacts are already on disk. It only surfaces later, on
the next clean install, dependency bump or Node upgrade, as a wall of node-gyp
output ending in `Error: not found: make`.

```bash
which make gcc g++          # all three should resolve
dpkg -l build-essential | tail -1
```

If they are missing:

```bash
sudo apt-get install -y build-essential
```

This happened on a real 24.04 to 26.04 run: `build-essential` was present the
day before the upgrade and gone the day after, with `dpkg -l` reporting
`Installed: (none)`. Nothing failed until a clean `npm ci` was attempted.
Note that the rebuild advice below depends on this toolchain, so check it first.

If anything does misbehave, rebuild rather than debugging linkage:

```bash
cd /path/to/canectic
npm rebuild
npm test
```

Compare the suite against the count you recorded before the upgrade. An identical pass count is the single best signal that the runtime came through intact.

### 4. Third-party PPAs

The upgrade disables them, and there are **two** fields to fix, not one. It rewrites `Enabled: yes` to `Enabled: no` and leaves `Suites:` pointing at the old codename. Changing only the suite leaves the source silently inert.

Note also that the *filename* keeps the old codename (`dosemu2-ubuntu-ppa-noble.sources` stays that way after moving to resolute). That is cosmetic; only the fields inside matter.

```bash
F=/etc/apt/sources.list.d/dosemu2-*.sources
sudo sed -i 's/^Suites: <old-codename>/Suites: <new-codename>/' $F
sudo sed -i 's/^Enabled: no/Enabled: yes/' $F
grep -E '^(URIs|Suites|Enabled)' $F     # confirm all three before continuing

sudo apt update
apt-cache policy dosemu2                # candidate should carry the new release tag
sudo apt install --only-upgrade dosemu2
dosemu --version
```

Then actually launch a DOS door and confirm it runs. dosemu2 is more sensitive to kernel and glibc changes than most packages, so a version check alone is not proof.

### 5. Bring the BBS back and verify

```bash
sudo systemctl start pm2-$USER
pm2 status
```

Work through the checklist:

```bash
# All four processes online, zero restarts
pm2 jlist | python3 -c "import json,sys; [print(p['name'], p['pm2_env']['status'], p['pm2_env']['restart_time']) for p in json.load(sys.stdin)]"

# Children on the Node you expect (pm2's own reporting can lag; /proc is ground truth)
for p in $(pgrep -P $(pgrep -f 'PM2.*God Daemon')); do readlink -f /proc/$p/exe; done

# Listeners are back
ss -ltnp | grep -E ':(8080|2023|10143|10587|24554)'

# Web and health. /health is the single best check: it exercises the app's own
# database and Redis connections rather than probing them from outside.
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/   # 503 while closed for maintenance
curl -s http://127.0.0.1:8080/health
# expect: {"status":"ok","postgres":"ok","redis":"ok"}

# No new errors
tail -50 logs/production/*-error.log
```

The board is still closed for maintenance from before the upgrade. A closed
board refuses terminal callers (sysops included) and mail clients, so once the
checks above pass, reopen it before exercising the rest:

```bash
node src/tools/maintenanceMode.js --off
```

Then exercise the parts that touch the pieces you just moved:

- Log in over telnet and read a message (PostgreSQL, terminal path)
- Send yourself a PM and check it over IMAP (mail process)
- Launch a door, DOS and native (dosemu2, node-pty)
- Download a file over ZMODEM (transfer engines)
- Run a tosser pass, `node src/tools/tosser.js --in` (worker, BullMQ, Redis)

## Rollback

Ubuntu release upgrades cannot be reversed in place. Your recovery paths, in order of preference:

1. **Hypervisor or filesystem snapshot taken before the upgrade.** By far the best option, and on Proxmox it is one command (see [If Canectic runs in a container](#if-canectic-runs-in-a-container)). Take one and this whole section becomes a five minute problem.
2. **The old PostgreSQL cluster**, if you have not dropped it. Reinstall the old major and restart it.
3. **The `pg_dumpall` file**, restored into a fresh cluster on a rebuilt host.

Options 2 and 3 recover your data, not your OS. Plan on a snapshot if downtime matters.

## Reference: Ubuntu 24.04 to 26.04

This upgrade has been performed and verified end to end on a Canectic install (an LXC container, September 2026). Results:

| Item | Outcome |
|---|---|
| Upgrade path | Ran with `do-release-upgrade -d`. At the time the `resolute` entry in `meta-release-lts` still carried `Supported: 0`, so the normal path was closed, but `meta-release-development` listed resolute as `Supported: 1` and 26.10 as `Supported: 0`, meaning `-d` correctly targeted 26.04.1 rather than the next interim release. **Check that before using `-d`;** it is not always true. |
| Result | Ubuntu 26.04.1 LTS. 725 packages upgraded, 180 obsolete removed, **zero errors**. |
| PostgreSQL | **16.15 to 18.6**, a two major jump, handled by a single `pg_upgradecluster 16 main`. No empty 18 cluster was auto-created, so the `pg_dropcluster` step did not apply. All 126 tables and all 126 sequences matched exactly afterwards. |
| Redis | **7.0.15 to 8.0.5**, Redis rather than valkey. Read the old dataset cleanly, `maxmemory-policy` stayed `noeviction`, keys intact. |
| glibc | **2.39 to 2.43.** No addon rebuild required; the full test suite passed with an identical count (2670). |
| Node | **Untouched at v26.8.1** under nvm, along with pm2 and the systemd unit. The entire point of the runtime portability work. |
| dosemu2 | PPA publishes for `resolute` at the same source revision as `noble`. Upgraded cleanly once the source was re-pointed **and re-enabled**. |
| coreutils | 26.04 installs `rust-coreutils` and `coreutils-from-uutils` alongside `gnu-coreutils`, but on an upgraded system `/usr/bin/cp` remains a symlink to `gnucp`, the GNU implementation. Canectic's `install.sh` and `update.sh` therefore still run against GNU coreutils. Worth re-checking on a fresh 26.04 install, where the default may differ. |
| Container | No kernel packages, so nothing kernel related to do. dbus and polkitd both requested a restart, satisfied by restarting the container from the host. |

Codenames, for editing PPA suites: `noble` is 24.04, `resolute` is 26.04.
