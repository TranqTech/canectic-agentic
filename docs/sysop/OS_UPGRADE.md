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
    .env config/ ftn/ qwk/ files/ xtrn/ public/css/custom.css
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

```bash
pm2 stop all
sudo systemctl stop pm2-$USER
```

Leaving it running risks writes landing in a database that is about to be replaced underneath it.

## Running the upgrade

```bash
sudo do-release-upgrade
```

Answer the prompts. When asked about modified configuration files, keep your version for anything you have customised (`postgresql.conf`, `redis.conf`, `pg_hba.conf`) and take the maintainer's version for files you have never touched.

Expect a reboot at the end.

## After the upgrade

### 1. PostgreSQL: migrate the cluster

This is the step that most often gets missed, because nothing obviously fails: the new PostgreSQL is running, it just has none of your data in it.

```bash
pg_lsclusters
```

You will see two clusters, for example the old `16/main` (now `down`, on a different port) and a new empty one on 5432.

Migrate the old cluster forward. Substitute your actual old and new version numbers:

```bash
sudo pg_dropcluster <NEW> main --stop      # discard the empty new cluster
sudo pg_upgradecluster 16 main             # upgrade the old one in its place
pg_lsclusters                              # new cluster should now be online on 5432
```

Port continuity matters: Canectic connects on 5432 per your `.env`, and `pg_upgradecluster` gives the upgraded cluster the old cluster's port. Confirm that before moving on.

Verify your data actually arrived:

```bash
sudo -u postgres psql -tAc \
    "select datname, pg_size_pretty(pg_database_size(datname)) from pg_database where datistemplate=false;"
sudo -u postgres psql -d <your_db> -tAc \
    "select count(*) from information_schema.tables where table_schema='public';"
```

The size and table count should match what you recorded before the upgrade. Only once you are satisfied should you remove the old cluster:

```bash
sudo pg_dropcluster 16 main
```

Keep it until you are certain. It costs nothing but disk, and it is your fastest rollback.

If `pg_upgradecluster` fails, fall back to the dump: create a fresh cluster and `gunzip -c ~/canectic-pg-*.sql.gz | sudo -u postgres psql`.

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

### 3. Node and native addons

With nvm, nothing should have moved:

```bash
node -v          # should match preupgrade-state.txt
which node       # should still be under ~/.nvm
```

Native addons compiled before the upgrade link against `libstdc++.so.6`, `libgcc_s.so.1` and `libc.so.6`. glibc is forward-compatible through symbol versioning, so binaries built on an older release keep running on a newer one. The prebuilt N-API modules (bcrypt, better-sqlite3, serialport) are stable across both Node versions and glibc by design.

If anything misbehaves, rebuild rather than debugging linkage:

```bash
cd /path/to/canectic
npm rebuild
npm test
```

### 4. Third-party PPAs

The upgrade disables them. Re-point each at the new release codename and re-enable. For dosemu2, which matters if you run DOS door games:

```bash
sudo sed -i 's/Suites: <old-codename>/Suites: <new-codename>/' \
    /etc/apt/sources.list.d/dosemu2-*.sources
sudo apt update
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

# Web and health
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/
curl -s http://127.0.0.1:8080/health

# No new errors
tail -50 logs/production/*-error.log
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

Findings from checking this specific path, current as of September 2026:

| Item | Status |
|---|---|
| Upgrade offered | **Not yet.** The `resolute` entry in `meta-release-lts` is complete but carries `Supported: 0`, while `noble` has `Supported: 1`. Canonical has published the 26.04.1 path and not yet enabled it. Nothing to fix locally; re-check periodically. |
| PostgreSQL | 24.04 ships 16. Expect a major version jump and a mandatory `pg_upgradecluster`. The main work. |
| dosemu2 | **Covered.** The PPA publishes for `resolute` (26.04) at the same source revision as the `noble` build, so DOS doors have a path forward. |
| Redis | **Redis 8.0.5, not valkey** (confirmed on a 26.04 install). Major jump from 24.04's 7.0.x. RDB is forward-only, so the dataset does not survive a rollback; see the Redis section for why that is tolerable. |
| Node | Unaffected under nvm. |
| Native addons | Low risk. Prebuilt N-API modules are version-stable; locally compiled ones link only to backward-compatible system libraries. |
| glibc | 2.39 on 24.04. Existing binaries keep working on newer via symbol versioning. |

Codenames, for editing PPA suites: `noble` is 24.04, `resolute` is 26.04.
