# Update System Design

Design for release engineering, distribution, and in-BBS installation and
update for Canectic.

**Status:** built. Written 2026-09-12 as a design; all eight phases in section
12 are implemented and in use (stable releases published so far: 0.9.6a,
0.9.9a, 0.9.10a, 0.9.11a, 0.9.12a; 0.9.7a and 0.9.8a withdrawn). Sections 1 to
11 are the original design and are kept as written, with notes where the build
differs; sections 13 to 17 record what each phase actually decided. Built since
the design and not described in it: maintenance mode and the drain during an
update (#52, `docs/sysop/MAINTENANCE.md`), the progress page served by the
updater on the gateway's port (#53), upgrade notices with acknowledgement (#55,
`src/release/upgradeNotices.js`), release withdrawal (`RELEASE_PROCESS.md`),
signed releases (a published key, `MANIFEST.asc` inside the archive, pinned
fingerprint in `setup/bootstrap.sh`), backup and staging housekeeping (#62,
`update.js --prune`), and the channel switch on `/admin/update`. Not built:
publishing a release into a file echo is still a manual step (section 17), and
there is no automatic database rollback (section 15, "The rollback line").
`RELEASE_PROCESS.md` is the maintainer guide; `docs/sysop/UPDATES.md`,
`UPDATING.md` and `INSTALL.md` are the sysop guides.

## Motivation

Installing Canectic today means cloning a repository, running a script from that
clone against a target directory, and keeping the clone. Updating means going
back to the clone, pulling, and running the script again. The sysop maintains a
second copy of the software whose only purpose is to install the first copy.

That shape causes the rest of the problems:

- **The source tree is a thing the sysop has to look after.** It can be stale,
  on the wrong branch, or at an untagged commit, and nothing checks.
- **Two programs claim to perform updates and have drifted.**
  `setup/install.sh` detects an existing install and offers update mode;
  `setup/update.sh` does the same job more carefully. They carry duplicate
  `CODE_DIRS` / `DATA_DIRS` lists, and `install.sh` never received the overlay
  work, so its update mode deletes `public/` including every sysop-added asset
  and `public/css/custom.css`. Filed as issue #44.
- **Upgrade steps are prose.** The v0.9.6 changelog carries eight of them
  (`--fix-msgids`, `qwkConfRenumber`, the `netmail_relay_mode` replacement,
  `pm2 delete all`, the systemd wrapper, the npm 12 allowlist, SQL_ASCII
  conversion, `dbmigrations`). The update script runs two. The rest are the
  sysop's job to read, match against their install, and execute, and several are
  silent when missed.
- **Nothing tells a sysop a release exists.** They have to go and look.

The goal is that a sysop installs with one command and updates from inside
Canectic, with the software knowing what it is, what is available, and whether
moving is safe.

## Principles

1. **Install and update are the same program.** Install is update from nothing.
   One implementation of the directory categorisation, one implementation of the
   file merge. The current duplication is the bug in #44.
2. **A release declares what it is.** Version, channel, checksum, and the steps
   applying it requires, in a form a machine reads. Prose in a changelog is for
   humans and cannot be executed.
3. **The update is never automatic.** Checking is opt-in and notifies. Applying
   is always a deliberate human action.
4. **No telemetry.** A version check is a plain GET carrying nothing
   identifying, and the FTN transport carries no outbound request at all.
5. **Nothing is trusted unverified.** Every artifact is checksummed before it is
   unpacked, whether it arrived over HTTP or down a file echo.

---

## 1. Versioning

### Stable

```
MAJOR.MINOR.PATCH[phase]
```

The phase letter is `a` for alpha, `b` for beta, absent for a final release.
This is the `0.9.5a` format already in use. The earlier `v0.9.1-alpha.1` form is
retired.

The phase letters line up with the release codenames: Handshake is the alpha
era, Carrier the beta, First Call is 1.0.

### Development

```
MAJOR.MINOR.PATCH[phase].YYYYMMDD
```

A development build carries **the last stable released**, plus its build date. A
build made on 13 September after stable `0.9.5a` shipped is `0.9.5a.20260913`.

It names where it came from, not where it is going.

A build is cut when there is something worth having rather than on a timer, so
the gap between two of them may be a day or may be two months. The date is the
build date and nothing depends on them being consecutive.

If two builds are ever cut on one day, a counter is appended:
`0.9.6a.20260913.2`.

**Why not "nightly".** The obvious name promises a cadence this channel does not
have. In common use it means an automated daily build off tip, so a sysop who
subscribes and then sees nothing for two months has a fair question about
whether it is broken, and that is a support burden created entirely by a word.
It also undersells what these are: they go through the same release machinery as
stable and are meant to be run on live boards, not merely inspected.

### Ordering

Compare left to right: major, minor, patch numerically; then phase, where `a` is
lower than `b` and both are lower than absent; then the date, where **absent
sorts below present**, because a dated build comes after the release it names.

```
0.9.5a < 0.9.5a.20260901 < 0.9.5a.20260913 < 0.9.5b < 0.9.5b.20261005 < 0.9.5 < 0.9.6a
```

Read as: a dated build is a *post*release of the version in its name, and an
earlier phase is a prerelease of a later one.

Implemented in `src/utils/version.js`, which is pure and has no dependencies.
`tests/version.test.js` asserts that chain as a whole, sorted from shuffled, as
well as pairwise and transitively, because a set of pairwise checks can all pass
while the overall order is incoherent. Inverting the date rule fails six of them.

**This is the rule to get right.** Which side of its base a dated build sorts on
is the single load-bearing decision in the scheme, and reversing it inverts every
comparison in the system: every sysop on development would be told they are
behind by builds they are ahead of. It belongs in one tested function, and the
tests should assert the full chain above rather than pairs.

### Why the last stable and not the next one

The obvious alternative is to name the version a build is heading toward, so work
toward `0.9.6a` produces `0.9.6a.20260913`. That was the first design and it is
worse in three ways.

**It makes a promise about the future that can turn out false.** Publish a run of
`0.9.6a.*` builds, then decide the work warrants calling it `1.0.0`, and every one
of them permanently names a release that never existed.

**It creates an obligation at release time.** Cutting stable `0.9.6a` would have
to bump the branch to `0.9.7a` in the same motion, or development builds keep
claiming `0.9.6a.<date>`, which now sorts below the stable that just shipped, and
everyone on the channel is told they are behind by a build that is ahead. Naming
the last stable removes that entirely: the version is derived from the most
recent tag plus today's date, so cutting `0.9.6a` makes the next development
build `0.9.6a.<date>` with nothing to remember.

**It hides the delta base.** Development artifacts are deltas against the most
recent stable (section 3). Naming that stable means the version states its own
base rather than relying on a metadata field that could disagree with it.

The cost is that a development build no longer advertises what release it is
heading toward. That was speculation, and speculation is the thing that went
wrong.

---

## 2. Channels and branches

Two channels:

| Channel | Contents | Cut when |
|---------|----------|----------|
| `stable` | Tagged releases | Deliberately, with release notes and the test checklist |
| `development` | Builds off the development branch | When there is something worth shipping |

A development build still goes through the release machinery: it gets a version,
metadata, an artifact and a checksum. What it skips is the ceremony -- the full
manual test checklist and the written release notes.

### Channels are not branches

The channel model needs two channels. It does not need two long-lived branches,
and treating those as the same thing would cost something every day for a
benefit that is only occasionally needed.

A channel is a claim about a build: this one was blessed, that one is current. A
tag carries that claim, and the release metadata states the channel outright.
Nothing in resolution, verification, the handoff or the delta machinery asks
which branch a build came from.

So: **`main` is the trunk.** A stable release is a tag that has been through the
test checklist and has release notes. A development build is a tag that has not.
Topic branches for larger pieces of work continue as they already do, merging
back to `main`.

The one thing a long-lived `stable` branch would buy is hotfixing a shipped
release after development has moved on: `0.9.6a` ships, `main` advances to
half-finished `0.9.7a` work, and a bad bug in `0.9.6a` cannot be fixed by
cutting from `main`. That branch can be created from the tag at the moment it is
needed, which is a five second operation, so nothing is lost by not having it in
advance.

Having it in advance is not free. The version in `package.json` differs by
branch, so every stable-to-main merge conflicts on it, forever. `CHANGELOG.md`
has the same shape: `Pending` lives on the trunk and a hotfix entry would need to
exist on both sides. Both are solvable with merge drivers, but that is machinery
maintained for a problem created by the arrangement itself.

Revisit if two stable lines ever need supporting at once. One maintainer and an
alpha-stage board do not.

### Notification visibility

| Selected channel | Notified about |
|------------------|----------------|
| `stable` | stable only |
| `development` | development **and** stable |

Someone on development needs to know a stable shipped, both because it may be the
version they want to settle on and because it is often the safer move. Someone
on stable has not asked to hear about development builds.

---

## 3. Release artifacts and metadata

### What a release publishes

| File | Purpose |
|------|---------|
| `canectic-<version>.zip` | The software |
| `canectic-<version>.json` | Machine-readable release metadata |
| `SHA256SUMS` | Checksums for both |
| `SHA256SUMS.asc` | Detached signature (optional, see section 11) |

As built the publish directory also carries the standalone manifest, the
channel index, the bootstrap with its checksum, `INSTALL.md` and the public key
`canectic-release.asc`; development builds are named `canectic-<v>.delta.zip`.
Signing is by `scripts/release.mjs --sign`, which also signs `MANIFEST` inside
the archive (`MANIFEST.asc`). The full list is in `RELEASE_PROCESS.md` section 3.

The archive contains the code directories and the shipped data files, with a
`MANIFEST` of content hashes for every shipped file so the updater can tell a
file the sysop edited from one they never touched.

### Release metadata

```json
{
  "version": "0.9.6a",
  "channel": "stable",
  "codename": "Handshake",
  "released": "2026-09-20",
  "artifact": "canectic-0.9.6a.zip",
  "sha256": "...",
  "min_upgrade_from": "0.9.0a",
  "base": null,          // development builds: the stable they delta against,
                        // which is also the version in their own name
  "node_min": "22.0.0",
  "migrations": ["0001-msgid-tuple-split", "0002-qwk-conference-blocks"],
  "steps": [
    {
      "id": "fix-msgids",
      "description": "Split legacy full-string MSGIDs into the tuple columns",
      "automatic": true,
      "applies_when": "msgid_tuple_split_completed_at is unset"
    }
  ],
  "notices": [
    {
      "level": "warning",
      "text": "allow_netmail_relay is deprecated and ignored. Relay is now netmail_relay_mode, defaulting to nodelist."
    }
  ]
}
```

`steps` are the things currently living as prose in the changelog. `notices` are
the silent changes with no command attached, which are the ones that hurt most
when missed.

`migrations` lists the migration ids the release ships. That list is what makes
the safety check in section 7 possible.

### Development artifacts are deltas against stable

A development build ships only the files that differ from **the most recent
stable**, plus a full manifest of the complete target tree.

```
canectic-0.9.6a.20260913.delta.zip       bodies of differing files only
canectic-0.9.6a.20260913.json            metadata, including "base": "0.9.5a"
```

Down a file echo this matters: a build that touches five files ships five files
rather than the whole tree, on links that are often slow and sometimes
metered.

**Always against stable, never against the previous development build.** One
hop, always. The version names its own base (`0.9.5a.20260913` deltas against
`0.9.5a`), so the base cannot be ambiguous or disagree with the metadata.
Chaining deltas would mean replaying every intermediate build to reconstruct the
current one, and a single pruned artifact would break the chain for everyone
downstream of it.

**The manifest carries the complete tree, not just the changes.** Deletions then
fall out for free: present locally, absent from the target manifest, therefore
removed. A delta expressed only as changed files cannot say "this file is gone",
which is precisely why `update.sh` uses `rm -rf` on code directories today.

**Reconstruct into staging, verify, then swap.** The updater builds the complete
target tree from base plus delta in the staging directory, checks it against the
manifest, and only then replaces the live tree. It never patches in place.

That is not fussiness. Going from one development build to a later one, a file
that changed
in the earlier build and was reverted in the later one appears in neither delta
at its correct content: the local copy holds the earlier change, the target
manifest wants the base version, and the delta carries no body for it because it
does not differ from the base. Patching incrementally leaves that file silently
wrong. Reconstructing makes reverts, deletions and partial states correct by
construction, and verifying the result against the manifest gives an end-state
check the full-tarball path does not have.

**The base is usually already on disk.** A sysop on stable `0.9.5a` moving to a
development build based on `0.9.5a` already holds the base, so only the delta is
fetched.
Otherwise the base stable artifact is fetched once and cached.

Two consequences:

- **A stable artifact cannot be pruned while a development build references it.**
  The
  current stable base must stay available on both transports. This is a
  constraint, not a retention preference.
- **The delta size is a useful signal.** It grows through a cycle and resets to
  near-zero when stable is cut. A delta approaching full-tree size means a
  stable release is overdue.

Stable releases stay full tarballs. They are the base everything else is
expressed against, and they must be installable from nothing.

### The index

A single document per channel listing every release, newest first, so a client
can answer "is there anything newer than what I have" in one fetch.

### Cutting a release

A script, because there is no CI and the current manual process already let
`v0.9.5a` ship without release notes. It should:

1. Refuse if the working tree is dirty or the test suite fails
2. Refuse if the changelog `Pending` section is empty
3. Bump `package.json`
4. Close the changelog `Pending` heading into the version and open a new one
5. Generate the release note skeleton in `docs/releases/`
6. Build the artifact and `MANIFEST`
7. Write the release metadata, including steps and notices
8. Write and sign `SHA256SUMS`
9. Tag

On a stable cut, one more check belongs here, and it is the reason the version
scheme matters beyond tidiness. See below.

Note there is no branch version to bump. A development build derives its version
from the most recent stable tag plus its build date, so cutting a stable
automatically re-bases every development build that follows it.

### Checking the development to stable pipeline at release time

Because a development build names its base, the published set is enumerable: every
build whose version begins `0.9.5a.` was based on stable `0.9.5a`, readable
straight out of the release index. From that follows the set of migrations those
builds have already put into people's databases.

So when cutting stable `0.9.6a`, the release script can ask whether it ships every
one of them. If a migration went out on development and then got deferred out of
the stable cut, the answer is no, and everyone running development is about to be
refused the upgrade.

That is the same property the runtime rule in section 7 enforces, checked one step
earlier. The runtime rule is a net under the sysop; this is a check on the
maintainer's own machine before anything is published. The failure it catches is
identical, but here it costs a warning rather than a bug report from someone who
cannot move off development.

The same naming makes two other things derivable rather than asserted:

- **The delta base.** The version, the metadata `base` field, and the tag the
  build was actually made from must all agree. Three independent statements of
  one fact is a build-time check, and any disagreement is a packaging bug caught
  before publication.
- **How overdue a stable is.** A development delta grows through a cycle and
  resets when stable is cut. Since the base is named, the delta size relative to
  the full tree is computable per build, and one approaching full size says a
  release is due.

**The build stamps the version into the artifact.** `package.json` in the
repository carries the last stable released, because that is the only version the
tree can honestly claim between releases. The build writes the full computed
version into the `package.json` inside the artifact, so a development build
installs as `0.9.5a.20260913` rather than reporting itself as `0.9.5a`.

That matters because `currentversion` is read from `package.json` at startup and
is what the update check compares against. Without the stamp, every development
build would identify as the stable it was based on, be told it is up to date, and
never see a newer development build at all.

---

## 4. Distribution

Two transports for one step: resolve the newest release on my channel.
Everything after resolution is identical.

### HTTP

Fetch the channel index, compare versions, fetch the artifact and metadata.

### FTN

Release artifacts are distributed down file echoes, one per channel. This is how
BBS software was distributed for twenty years, it works for a system with an FTN
link and no outbound HTTP, and it does not depend on the GitLab instance being
reachable.

| Echo | Type | Carries |
|------|------|---------|
| `CANECTIC` | Message | Release announcements and support |
| `CANECTIC_FILES` | File | Stable artifacts |
| `CANECTIC_DEV` | File | Development artifacts |

Areatags are kept short deliberately. Other sysops type these by hand into
AreaFix requests and read them in echolists, so the abbreviation is worth more
than the extra clarity of a longer tag. It is also the one place where the
channel name is expensive to change later: renaming a config value costs
nothing, renaming an echo other systems have already subscribed to does not.

The file echoes carry artifacts only. The announcement is a message in the
message echo, written for a person to read.

Detection over FTN needs no announcement and no network: a new artifact
appearing in the configured file area **is** the signal, and finding it is a
query against `file_entries`. The TIC tosser has already verified and filed it
by then.

The sysop configures which file area holds each channel, the same way nodelist
and echolist scan areas are configured today.

---

## 5. The update check

A daily maintenance job, opt-in, off by default, that resolves the newest
release on the selected channel (plus stable, if the channel is development) and
writes a sysop notification when something newer exists.

It never downloads and never applies.

The notification system already carries a sysop-broadcast type wired to the bell
icon in both nav bars, so this needs no new delivery mechanism.

### Configuration

| Key | Default | Category | Description |
|-----|---------|----------|-------------|
| `update_channel` | `stable` | updates | Which channel this install follows |
| `update_check_enabled` | `false` | updates | Run the daily check |
| `update_check_transport` | `http` | updates | `http`, `ftn`, or `both` |
| `update_check_url` | `https://canectic.tranqsoft.com/releases/` | updates | Where the HTTP index lives |
| `update_stable_file_area` | empty | updates | File area shortcode carrying stable artifacts |
| `update_dev_file_area` | empty | updates | File area shortcode carrying development artifacts |

As built (`src/config/configDefaults.js`) the category is `updates`, not
`system` (section 14), and the updater added `update_process_control`,
`update_stop_command`, `update_start_command`, `update_backup_keep` (1),
`update_base_cache_keep` (2), `update_require_signature` (false),
`update_progress_page` (true) and `update_drain_timeout` (900);
`update_check_retention_days` (90) sits under `maintenance`.

Off by default because an outbound request from a sysop's box should be
something they turned on, not something they have to discover and turn off.

---

## 6. The updater

### The self-replacement problem

A process cannot replace its own files while running. The gateway serves the
admin page, and the update replaces `src/` and `node_modules`, which includes
the gateway's own code. The worker is no help; it is replaced too.

### The handoff

The running Canectic does four things and stops:

1. **Resolve** the newest release on the channel
2. **Download** the artifact
3. **Verify** its checksum against the signed sums
4. **Extract** it to a staging directory

Then it spawns the updater **from the staging tree**, detached, and gets out of
the way. The new version applies itself onto the install.

This split puts the fragile part in the right place. Applying an upgrade is
version-specific and is where the bugs are; doing it with the new release's code
means a release can ship a fixed updater and it takes effect for *that* upgrade
rather than the one after. The old code's job -- fetch, verify, extract, hand
off -- is small enough to get right once and then leave alone.

It also means there is no source directory the sysop maintains. Staging is
created and deleted per update. (As built, staging lives under
`.canectic-update/staging/<version>`; the directory the updater runs from cannot
delete itself, so it is removed by the housekeeping after the next completed
update, #62.)

### Detachment

The updater must survive the gateway being stopped. It runs in its own session
with its output to a file, and it must not execute from the tree it is
replacing. Same lesson as `setup/canectic-pm2.sh` needing to live outside
`setup/`, which `update.sh` wipes.

### Progress

Progress has to survive the gateway going away and coming back, so each phase
writes a durable row. When the browser reconnects, the page reads the state and
reports what happened rather than showing a lost connection. (As built it is a
JSON run file under `logs/update/`, not a row; see section 15.)

Phases: preflight, backup, stop, files, dependencies, schema, migrations, steps,
start, verify. As built (`PHASES` in `src/release/updatePhases.js`) there are
twelve: `directories` and `env` were added after `files` for the installer, and
an update skips `env`.

---

## 7. Safety

### The move rule

A move is safe when **every migration already applied to this database also
exists in the target release**.

Channel is not the test. Neither is version, quite. Someone on a development
build from
1 September moving to a stable released on the 10th is moving forward, and
should be allowed. What actually constrains them is whether the target
understands the state their database is in.

The case version comparison misses is work that was on development and got
deferred
out of the stable cut. Version-wise the move is forward; in practice the
database carries a migration the target does not ship and cannot reason about.
Normal convergence, development `0.9.6a.*` to stable `0.9.6a`, is always safe
because stable contains every migration its development builds had.

This is also checkable before publication rather than only at update time: see
"Checking the development to stable pipeline at release time" in section 3.

On refusal, name the migration id and what it was for. "You cannot move to
stable" is not actionable; "your database has applied `0007-fileecho-hashes`,
which stable 0.9.6a does not ship" is.

**Dependency: built.** This rule needs a recorded migration ledger, which now
exists: `schema_migrations` plus `db/migrations/` and
`src/maintenance/migrationLedger.js`. Migration ids in release metadata are the
ids in that table.

Before it there was no migrations table and four different ad-hoc answers to
"has this one-time step run": schema sniffing in `migrateMenuLayout`, a marker
row in `settings` for the MSGID split, nothing at all for `qwkConfRenumber`, and
an unanswerable question for `allow_netmail_relay`. The first two are now
ledger entries. `qwkConfRenumber` should become one. `allow_netmail_relay`
remains unanswerable, because it is a config problem rather than a migration
one: `configStore` seeds every default into `settings`, so a deliberately-set
value cannot be told from an untouched key. Fixing that needs the settings table
to record whether a row was seeded or set by a person.

### Preflight

Run before the update is offered, not after it is started:

- Node version against `node_min`
- Disk space for staging plus the backup
- Database reachable
- Build toolchain present, if the release changes a native module
- Jobs currently in flight, so an update does not land mid-toss
- **Callers currently online**, with the count

The last one is the single most useful thing the page can say. The presence data
already exists, and "this will disconnect 3 connected users" is what a sysop
actually needs to decide when to do it.

### Backup and rollback

Code rollback is nearly free: keep the previous tree until the new one has
started cleanly.

Database rollback is not. A `pg_dump` on a real hub is minutes and gigabytes.
Whether that is required, offered, or merely warned about is an open decision
(section 11). (Resolved: offered and on by default, `--no-dump` to skip.)

---

## 8. Installation

Install is the same program with nothing to preserve.

A bootstrap script is the only thing a new sysop touches. It resolves the
channel, downloads and verifies a release, and hands off to that release's
installer, which creates the directory structure, writes `.env` from the
template, creates the database and user, runs the schema, seeds defaults and the
sysop account, and starts the processes.

No `git clone`, and no second tree afterwards.

The checksum should be published prominently and the verify-then-run path
documented, rather than only offering `curl | bash`. This audience cares about
provenance and it costs one line of documentation.

---

## 9. Admin UI

`/admin/update`:

- Current version, channel, and when the last check ran
- What is available, per channel, with a verdict each: available and safe,
  available but blocked by migration `X`, or already current
- The release notes, rendered
- What applying it will do: the declared steps and notices
- Preflight results, including the connected-caller count
- An Update button, gated on preflight passing
- The outcome of the last update, read from the durable phase rows

Both channels are shown whatever is selected, since someone on development needs
to be
told stable is available and reachable.

---

## 10. What this replaces

| Today | After |
|-------|-------|
| `setup/install.sh` (install + update modes) | Bootstrap plus one installer |
| `setup/update.sh` | The same program, update entry point |
| Duplicate `CODE_DIRS` / `DATA_DIRS` in two scripts | One definition |
| mtime comparison for data files | Manifest hash comparison |
| Upgrade steps as changelog prose | Declared steps in release metadata |
| Checking the releases page by hand | Opt-in daily check and a notification |

---

## 11. Open decisions

1. ~~**Signing.** GPG-signed `SHA256SUMS` is the right answer for a sysop
   audience, but it means key management and a documented verification path.
   Checksums alone are weaker but free.~~ **Resolved: signed.** The release key
   is published as `setup/canectic-release.asc` (and beside the releases), its
   primary fingerprint is pinned in `setup/bootstrap.sh`, and a cut with
   `--sign` signs `SHA256SUMS`, the in-archive `MANIFEST` and the tag. A board
   checks `MANIFEST.asc` against the key it already holds
   (`signing.verifyTreeSignature`): a bad signature is always refused, an
   unsigned or unverifiable one only when `update_require_signature` is on.
2. ~~**Does the update page offer "check now"?**~~ **Resolved: yes.** The
   opt-out is about this system reaching out on its own, unprompted. A person
   pressing a button is not that, and refusing them would mean the only way to
   ask a question is to change a setting. `/admin/update` offers it and it runs
   with `force`, whatever `update_check_enabled` says.
3. ~~**Is a database dump required before migrating**, offered, or only warned
   about?~~ **Resolved: offered, on by default.** It is taken unless `--no-dump`
   is passed, and the free space is checked against the database size first so
   it fails before starting rather than halfway. Required was rejected because a
   hub whose message base outgrows its free disk would then be unable to update
   at all; warn-only was rejected because the one time it matters there would be
   nothing to restore from.
4. ~~**How is the cached stable base stored**, and when is it discarded?~~
   **Resolved:** `.canectic-update/base/`, holding the artifact, its metadata
   and its manifest. Kept to `update_base_cache_keep` (2) most recent, with the
   base the installed version deltas against never evicted and never consuming
   the budget. Pruned after a successful update, not on a timer. See section 15.

Resolved during design:

- *Branch layout* -- no stable branch. `main` is the trunk, stable releases are
  blessed tags, and the stable branch is created from a tag the first time a
  hotfix is actually needed. See section 2.
- *Development artifact contents* -- deltas against the most recent stable, with
  a full manifest. See section 3.
- *File echo retention* -- development can prune freely on `max_files`, but the
  stable base a development build references must be retained. Not a
  preference.

---

## 12. Phasing

1. ~~Migration ledger~~ **done**: `schema_migrations`, `db/migrations/`,
   `src/maintenance/migrationLedger.js`
2. ~~Fix #44 so the two scripts stop disagreeing~~ **done**: `install.sh`
   refuses to update and its duplicate implementation is gone
3. ~~Version parsing and comparison~~ **done**: `src/utils/version.js`
4. ~~Release script and metadata, published by hand at first~~ **done**:
   `scripts/release.mjs`, `src/release/`, `docs/releases/pending.json`. See
   `RELEASE_PROCESS.md` and section 13 below for what was decided while
   building it
5. ~~Update check and notification (read-only, no apply)~~ **done**:
   `src/release/updateVerdict.js`, `src/maintenance/updateCheck.js`,
   `src/models/updateChecks.js`, `/admin/update`. See section 14
6. ~~The updater, with the handoff model~~ **done**: staging with a base cache,
   the apply plan, the applier with backup and rollback, the detached handoff,
   durable progress, the whole phase sequence, preflight, and the Update button.
   See section 15
7. ~~Bootstrap installer~~ **done**: `setup/bootstrap.sh`, `src/tools/install.js`,
   `src/maintenance/installer.js`. See section 16
8. ~~FTN transport~~ **done**: `src/maintenance/ftnReleaseSource.js`, the
   `update_check_transport` keys, and the sidecars that let an archive describe
   itself. See section 17

---

## 13. Phase 4 as built

The release script and the metadata format exist. `RELEASE_PROCESS.md` is the
maintainer-facing guide; this records what the build decided that the design
above did not.

### Steps and notices are declared beside the changelog, not parsed out of it

`docs/releases/pending.json` accumulates the machine-readable half of a cycle
while the changelog `Pending` section accumulates the human half. Deriving one
from the other was the obvious saving and is the wrong trade: parsing prose to
decide what to execute on someone's live board works right up until a bullet is
reworded, and the failure is silent.

What the script does instead is cross check. A changelog carrying upgrade notes
with nothing declared, or declarations with no upgrade notes, is reported at cut
time, when the person who wrote one of them is still in the room. It is presence
based rather than count based, because one note can be two steps and a notice
and matching them one to one would be a rule nobody could follow.

`min_upgrade_from` and `node_min` survive a cut; `steps` and `notices` do not.
The floor is a standing fact about what the software can upgrade from and run
on, and clearing it would leave every release after the first declaring none.

### The pipeline check refuses rather than warns

Section 3 called for a warning when a stable does not ship every migration its
development builds already applied. It is a refusal, with
`--allow-migration-gap` to override.

A warning in script output is a warning nobody reads, and what it is warning
about is a class of user who cannot upgrade at all until the next release. The
override exists because retiring a migration that never reached anybody is a
legitimate thing to do.

Only builds on the stable being superseded are considered. Builds on an older
base were checked when their own stable was cut, and considering every build
ever published would mean no migration could ever be retired.

### The file categories moved into the manifest

`src/release/shippedTree.js` is the single definition section 10 promised, and
the category travels per file inside the manifest rather than being re-derived
by the updater. A release that adds a directory then carries the rule for it,
which matters because the updater runs from the NEW version's tree: without the
category in the data, an old install's updater would be applying new
directories under rules it does not have.

A path with no rule does not ship, rather than defaulting. Defaulting a new
top-level directory to `code` would mean the first release after somebody adds
one deletes whatever a sysop keeps in it, silently.

`scripts/` is excluded, so the release script does not ship inside its own
artifact. Beyond being dead weight on an install, shipping it invites cutting a
release from a deployed board.

### A development build refuses to publish nothing

Every development build rewrites the version in the staged `package.json`, so
that one file always differs from the base and "nothing has changed since the
last build" would never be true. The script re-hashes the staged file with the
base's version put back, which answers the question exactly, because the base's
own hash was computed over a file written by the same serialisation.

### Bookkeeping happens before the artifact is staged

A release tarball contains its own release notes and its own changelog entry.
Building first would ship a tarball whose changelog says the release is still
pending, which is the state v0.9.5a shipped in.

### Still open after phase 4

(Historical. Publishing is now `scripts/publish.mjs` to the release host,
signing is resolved (section 11), and phases 5 and 6 consume the index and
`verifyTree`.)

- Publishing is by hand. There is no upload step and no channel host.
- Signing is wired (`--sign` runs `gpg --detach-sign --armor`) but no key is
  published and no verification path is documented. Open decision 1 stands.
- Nothing consumes the index yet. That is phase 5.
- The manifest's `verifyTree` and `pathsToRemove` are written and tested but
  have no caller until the updater exists in phase 6.

---

## 14. Phase 5 as built

The check exists, is off by default, and never downloads anything.
`docs/sysop/UPDATES.md` is the sysop-facing guide; this records what the build
decided that the design above did not.

### Only what works is configurable

`update_check_enabled`, `update_channel`, `update_check_url` and
`update_check_retention_days`. The three FTN keys in section 5's table
(`update_check_transport`, `update_stable_file_area`, `update_dev_file_area`)
were deliberately absent until phase 8 shipped that transport; they exist now,
with `update_check_transport` offering `http`, `ftn` and `both` as `options`.

Shipping a setting whose only other value does nothing is precisely what the
`options` mechanism exists to prevent: a sysop selects `ftn`, nothing changes,
nothing errors, and the settings page displays their choice as though it were in
effect. They go in with the transport.

The category is `updates` rather than the `system` the design's table named.
`wall`, `qwk`, `chat`, `callflow` and `pm` are all their own category already, so
four keys of their own is the established shape, not an exception.

### The move rule reads only `applied`

`migrationLedger.appliedIds()` is narrower than `settledIds()`. A `skipped`
migration decided this system did not need it, and `preinstalled` means the
database was born current, so in neither case is there a transformation for a
target release to understand. `applied` is the only outcome that means data here
changed.

The conservative reading would have been to block on every settled id, and it is
wrong in a way that would have been hard to see: a fresh install records every
migration as `preinstalled`, so it would refuse every upgrade on a brand new
board.

### The notification deduplicates on version AND verdict

Not in the design, and load-bearing. A daily job that says the same thing every
morning is a job a sysop turns off, after which they hear about nothing at all.

The key is both halves because a release that was blocked and is now reachable,
because they ran the migration or upgraded Node, is news even though the version
has not moved. Keying on version alone would swallow exactly the notification
they have been waiting for.

### A missing index is unknown, not an error

A channel with nothing published has no index, and a 404 there is the normal
state of a project that has cut no development builds. Treating it as a failure
would put a red error on the page of every stable-only install, daily, for ever.
A channel that resolves nothing reads as `unknown`; a 500, a timeout, or a
document that is not an index is an error and is recorded as one.

One channel failing does not discard the other. A system on development whose
own index is unreachable is still told about stable.

### The schedule is registered only when the check is on

Rather than registered and skipped. `src/tools/schedules.js` reports every
registered scheduler and compares it against what the database says should
exist, so a permanently inert entry would be a line in the diagnostics that
means nothing, on the one page whose value is that everything on it means
something.

The consequence is that turning the check on needs a gateway restart or a
schedule sync, the same as every other schedule-affecting setting.

### What phase 5 does not do

(Historical: phases 6 to 8 added all of this.)

No download, no verify, no apply, no preflight. `/admin/update` reports and
offers Check now. The page says plainly that applying is not implemented and
points at `setup/update.sh`.

The FTN transport is phase 8, so an install with no outbound HTTP cannot check
yet. It also cannot be harmed by one: with `update_check_enabled` off, which is
the default, this system makes no outbound request at all.

---

## 15. Phase 6 as built

Phase 6 is complete. This section was first written when only the half up to
putting files on disk existed, and the parts below that say so are kept as the
record of that step. `docs/sysop/UPDATING.md` covers the
tool. This records the decisions.

### What is built

| Piece | Where |
|-------|-------|
| Download, verify, extract, reconstruct a delta, verify against the manifest | `src/maintenance/updateStaging.js` |
| What applying a release does to an install | `src/release/applyPlan.js` |
| Carrying that out, with backup and rollback | `src/maintenance/updateApply.js` |
| Describing an installation the way an artifact is described | `shippedTree.scanInstalledFiles` |
| The tool | `src/tools/update.js` |

### The handoff

`src/tools/update.js --handoff` stages, then spawns
`<staged>/src/tools/applyUpdate.js` detached and returns. The child applies the
release as the new version, against an installation that is still the old one.

**Detachment is the load-bearing property.** `pm2 stop all` signals the process
group, so an updater launched from the gateway without `detached: true` dies
with the thing it was updating, halfway through. Verified by SIGKILLing the
launcher's entire process group immediately after the spawn and confirming the
update still completed.

**The contract between the two releases is a JSON run file, not a command
line.** One argument, `--run <path>`. The release that launches and the release
that applies are different versions of this software and both will keep
changing: a newer updater reading an older file defaults what is missing, an
older updater ignores what it does not know, and a positional argument list can
do neither.

**Staging lives inside the installation**, under `.canectic-update/`. Not
tidiness: `node_modules` resolves by walking up from a module's own directory
and a release artifact ships none, so an updater staged in `/tmp` cannot import
anything with a dependency, which includes `alogger`. The dot directory is not a
shipped category, so nothing scans or replaces it. The updater's working
directory is the installation, where `.env` and `node_modules` are; only its
code comes from staging.

A release that ships no `src/tools/applyUpdate.js` cannot be handed off to, and
the launcher says so and points at `--apply` instead. That is not hypothetical:
it is every release cut before this existed.

### Progress is a file, not a database row

The design says "durable row". It is a JSON file under `logs/update/`, because
the updater is replacing `src/` including the database layer and may be running
while the BBS is stopped. Making the one record of what happened depend on
Postgres would put it out of reach exactly when it is wanted. Writes are atomic,
and `latest.json` is a copy rather than a symlink.

`completeRun` refuses over a failed or still-running phase. A run reporting
success across a failure would tell a sysop their board is updated when it is
half replaced, and nothing else in the system would contradict it. "Never
reached" and "deliberately not done" are also distinct: this updater performs
four of the ten phases and records the other six as skipped with reasons, so the
run reads as incomplete on purpose rather than as stuck. (That was the first
cut. The runner now performs every phase an update needs; it skips `env`
always, `migrations` because `schema` applies them, `stop`/`start` when process
control is off, and whatever `--no-deps`/`--no-schema` asked for.)

### One phase sequence, two ways in

`updateRunner.js` owns the ten phases. `update.js --apply` runs it in process
and `applyUpdate.js` runs it detached after a handoff. One implementation on
purpose: two programs that both claim to apply an update is the exact shape that
let `install.sh` and `update.sh` drift until one of them deleted every
sysop-added asset under `public/`.

Two placements are worth stating. The FILE backup runs before the processes are
stopped, because shipped files do not change while the BBS runs and there is no
reason to pay downtime for it. The DATABASE dump runs at the top of the schema
phase, after the stop and immediately before migrations, because it exists to
protect the migration: taken any earlier it would not contain the writes in
between, and taken before the stop that window would be as long as the dump.

`schema` runs `dbmigrations.js`, which does the declarative pass and the ledger
in one invocation, so `migrations` is recorded as skipped with that as the
reason. Marking it done would imply a second thing happened.

### The rollback line

Up to and including `dependencies`, the only thing that changed is files, so
putting them back is correct and complete. From `schema` onwards it is not: old
code over a migrated database is a worse state than the failure, so the run
stops, says the backup is there, and leaves the decision to a person.

`ROLLBACK_SAFE` is written out rather than derived from the phase order,
because a phase drifting to the wrong side of that line is silent and only shows
up during a failure, which is the worst moment to discover it.

A failure that stopped the BBS starts it again. A board left down by a failure
partway through is its own problem, separate from whatever failed.

### Process control

`update_process_control` (on), `update_stop_command` (`pm2 stop all`) and
`update_start_command` (`pm2 start ecosystem.config.cjs`). A bare `pm2` is
resolved next to the running Node before PATH, reusing `resolveRestartCommand`
from the worker watchdog, because under nvm the supervisor's PATH may never have
held the version the BBS runs on.

Starting from the ecosystem file starts every process in it, including one the
sysop had deliberately stopped. That is a known consequence of the simpler
option and is documented rather than worked around; the pm2 state is recorded in
the run file so `--status` at least shows what was running beforehand.

### Preflight runs twice, for different reasons

At OFFER time, in the gateway or the tool, with the board up: connected callers,
jobs in flight, disk, toolchain, database. Several of those are only answerable
then, because once the updater has stopped the processes nobody is online and
nothing is in flight, and asking would be asking a question the asking has
already changed.

Inside the updater it re-checks only the cheap invariants it can still see, as
the new code, because by then the old release's word for them is worth less than
its own.

Blocking is reserved for things that make the update fail. Connected callers
warn, because whether three people mid-door is a reason to wait is the sysop's
call, and a preflight that refused on judgement calls is one they learn to
bypass. Unknown is never treated as bad: free space that cannot be measured
warns, since blocking would make every filesystem without `statfs` un-updatable.

### The Update button

`/admin/update` has one, gated on preflight passing and on no run already live.
The ordering is the whole trick: check, **respond**, then stage and hand off in
the background. The gateway is about to spawn something that stops the gateway,
so the response has to be gone first, and the page has to be able to report
afterwards from something other than the connection it was serving on. The run
state exists from the moment the button is pressed, so a failure during staging
is visible on the page rather than looking like nothing happened.

### The base cache

`.canectic-update/base/`. A delta is always one hop against its own named base,
so a sysop tracking development needs the same stable archive for every build
cut on it, and re-fetching 7.6 MB each time is waste over HTTP and worse down a
file echo.

A cached base is re-verified on every use. A local file is not more trustworthy
than a downloaded one: it can rot on disk or be edited, and it is the base
everything else is rebuilt from, so a corrupted cache would silently produce a
tree that passes its own manifest check while not being the release. A hit means
verified, not present, and a failed check discards the entry rather than
reporting it.

The honest limit: storing the metadata alongside the artifact makes this trust
on first fetch. The checksum is only as good as the fetch that brought it in,
which is the gap a published signature closes.

### Reclaiming disk

`.canectic-update/` holds three things with three lifetimes: `staging/` per
update, `base/` across updates, `backup/` until reclaimed. `reclaimable()` says
what each costs to delete, and `/admin/update` shows it, so "I need that space
back" has an answer that is not guesswork.

The split from `logs/update/` is deliberate: that holds the RECORD, which is
small and worth keeping for ever, and this holds the BYTES.

### The plan is a value, not a loop

`buildApplyPlan` is pure and returns a decision per file. The alternative, a
function that walks the tree writing as it goes, is how `install.sh` came to
delete every sysop-added asset under `public/`: the rule about what may be
overwritten was expressed as control flow in a shell script, so it could not be
read, tested, or shown to anybody before it ran.

A dry run is now the same code path with the writes turned off, so what a sysop
is shown is what will happen rather than a separate description of it.

### Categories are claims about whose file it is

`code` ours, overwrite and delete strays. `overlay` ours to add to, theirs to
extend. `overlay-seed` theirs the moment it exists. `data` theirs once touched.
`art` theirs.

**Removal is limited to `code`.** Present locally and absent from the manifest
means remove only there. Everywhere else a file we did not ship and do not ship
now is the sysop's, and the general form of the rule would delete their door
icons, their branding and their art. That is the install.sh bug restated, and it
is the assertion the tests care most about.

**An unknown category falls to conflict.** A release that adds a category this
code predates must not have its files written blindly, because the updater runs
from the new tree onto an old install and the categoriser it uses is whichever
one is on disk.

### The data rule is what the manifest was for

`update.sh` compares mtimes, which say when a file was written and nothing about
whether it differs from what shipped, so it has to stop and ask about every data
file. With the previous release's hashes the question is answerable: still
exactly what the last release shipped means nobody touched it, so take the
update.

An install with no `MANIFEST`, which is every install predating the release
machinery, cannot answer it and **fails to conflict**: their file is kept and
they are told. Guessing the other way would overwrite edits nobody can recover.
The first upgrade off a pre-manifest install will therefore report every changed
data file as a conflict, and the one after it will not.

### The install's MANIFEST is written last, and is part of the backup

`MANIFEST` describes the tree so it cannot appear in its own file list, and no
plan will ever write it. It needs an explicit step, it happens only after
everything else succeeded, and it is recorded in the backup like any other file.

Both halves were bugs during the build. Without the write, an install stays at
the old release's hashes and every data file the new release legitimately
changed reads as a sysop edit for ever after. Without the backup entry, a
rollback leaves the install claiming the release it just backed out of, which is
the one lie that makes the next update reason from the wrong hashes.

### Reconstruct, never patch

A delta is laid over its base in staging and the result is pruned to the
manifest and verified. The revert case is why: a file changed in an earlier
development build and put back in a later one appears in neither delta at its
correct content, so patching a live tree leaves it silently wrong. Rebuilding
from the base makes reverts, deletions and half-applied states correct by
construction, and the manifest check is an end-state assertion the full-tarball
path never had.

### The ledger read is bounded, and fails closed on the half it covers

The pg pool retries internally, so an update tool that asks the migration ledger
a question on a stopped database hangs for ever. It is raced against a bound,
and an unreadable ledger comes back as null rather than as an empty list:
treating "we do not know" as "nothing has been applied" would clear every
migration blocker and wave through exactly the move the rule exists to stop.

The upgrade floor and the Node requirement are still evaluated, because neither
needs the ledger, and they are the checks a fresh or misconfigured install is
most likely to trip. `--apply` is refused outright; a plan-only run continues
with a warning saying which half could not be checked.

### Still to decide before this is finished

Open decisions 1, 3 and 4 all land in the rest of this phase: signing, whether a
database dump is required before migrating, and how the cached stable base is
stored and retired. Nothing built so far forecloses any of them. (All three are
now resolved, see section 11.)

---

## 16. Phase 7 as built

`setup/bootstrap.sh` is the only thing a new sysop touches. It resolves a
release, downloads it, verifies its checksum, extracts it, and hands off to that
release's own installer. No `git clone`, and no second tree afterwards.

`docs/sysop/INSTALL.md` is the sysop-facing guide; this records the decisions.

### Install is update from nothing, literally

`buildApplyPlan` against an empty directory. Every file comes out as `create`
and the categories that protect a sysop's work on an update simply have nothing
to protect. There is no second copier, which is the point: the first one was
`install.sh`, and it drifted from `update.sh` until it deleted every sysop-added
asset under `public/`.

The phase vocabulary is shared too. An install skips `backup` because there is
nothing to preserve and `stop` because nothing is running; an update skips `env`
because the `.env` is the sysop's. Two new phases, `directories` and `env`, join
the sequence for that.

### The installer's imports must resolve with no node_modules

A hard constraint, discovered by the first end-to-end run failing on
`Cannot find package 'luxon'`. A fresh machine has an extracted release and
nothing else: `npm install` is something the installer RUNS, so it cannot be
something the installer needs.

`updateApply.js` lost its `alogger` import, and `runCommand`, `nodeCommand` and
`createRuntimeDirs` moved out of `updateRunner.js` into `updateCommands.js`,
because the runner reaches `appConfig` and therefore `dotenv`.
`tests/installPath.test.js` walks the import graph from `src/tools/install.js`
and fails on anything non-builtin, because this is exactly the kind of rule that
holds until somebody adds one convenient import. The updater is deliberately not
held to it and the test asserts the difference.

### Runtime directories are created on BOTH paths

A release ships no empty directories, because an empty directory is not a file,
so the FTN spool, the logs and the art tree have to be made. That used to be a
block of `mkdir` calls in `install.sh` that an update never ran, which means a
release that starts writing somewhere new works on a fresh install and fails on
every upgraded one, at the moment the feature is first used rather than at
update time. `runtimeDirs()` is a list, `createRuntimeDirs()` is idempotent, and
the update sequence runs it as its own phase.

### `.env` is written once and never rewritten

From `examples/env.example`, with the values the installer was given filled in,
at mode 600 because it holds the database password. A directory that already has
one belongs to somebody who set it up, and their credentials are worth more than
the template. A password is never defaulted or generated: a credential nobody
was told about, in a file nobody looked at, is worse than being asked.

### Installing over an installation is refused

It would treat every one of the sysop's files as new. The refusal names the
version it found and prints the updater command instead. `--force` overrides it.

### Where automation stops

The role and the database need `sudo -u postgres`, which is restricted on plenty
of hosts and absent on managed Postgres. `--create-database` runs the script that
already handles that case properly; without it the schema phase is skipped and
the command is printed. Everything after the credentials exist is automated:
dependencies, schema, seed, and starting the processes.

A failed install is not rolled back. There was nothing underneath, so deleting
the directory and starting again is simpler and safer than unpicking it, and the
run says so.

### A development build cannot be installed from nothing

It is a delta against a stable, so the bootstrap refuses one and names the
stable to install first. The alternative would be the bootstrap reimplementing
reconstruction, which is the updater's job and already tested.

### Verify before you run

The documented path is download, check the published checksum, then run.
`curl | bash` works and is not what the docs lead with. This audience cares
about provenance and it costs one line.

Signature verification is wired: when `SHA256SUMS.asc` is published and `gpg` is
present it is checked against the primary fingerprint built into
`setup/bootstrap.sh` (`RELEASE_KEY_FPR`, overridable with
`CANECTIC_RELEASE_KEY_FPR` for testing). A bad signature, an expired or revoked
key, or a signature by any other key stops the install before anything is
unpacked; a signature that cannot be checked because no copy of the key could
be had warns and falls back to the checksums. An absent `SHA256SUMS.asc` is
still not a refusal.

---

## 17. Phase 8 as built

Releases travel down file echoes. This is how BBS software was distributed for
twenty years, it works for a system with an FTN link and no outbound HTTP, and
it does not depend on the web host being reachable.

Almost nothing new happens on this path, which was the point of building it
last. By the time a release is interesting the TIC tosser has received it,
checked its CRC against the TIC, hashed it and filed it in a file area. So
detection is a database query, and downloading is a copy.

### There is no index document

A file echo carries files, not indexes. So the channel index is DERIVED from
what the area holds: each archive carries `CANECTIC.ID` and its own metadata at
the root, which is exactly why those sidecars exist.

Everything after derivation is the HTTP path unchanged. `dirSource` was written
to take a directory as well as a URL for this, and the whole FTN transport is a
`file_entries` lookup in front of it.

### An archive that cannot identify itself is dropped

Not offered with an empty description: dropped. Its migration list would be
empty, and an empty migration list clears every blocker in the move rule, so an
unidentifiable file would be presented as safe to install against a database it
says nothing about.

The filename is a hint and nothing more. It survives a distribution chain that
may rename, truncate or uppercase it, and nothing stops anybody naming a file
anything. `CANECTIC.ID` inside settles it. Uppercased names are normalised,
because 8.3 habits are still alive in parts of the network.

### What FTN integrity actually guarantees, stated plainly

A file echo does not carry the published checksum unless the sibling metadata
file was TIC'd too, and two TIC'd files travel independently so one can be lost.

What is guaranteed: the TIC's CRC-32, verified by the tosser on arrival, and the
SHA-256 the tosser computed and stored. Both prove the file has not changed
since it got here.

What is NOT guaranteed: that it is the file the maintainer built. The locally
computed hash is therefore never put in the `sha256` field, which means
"published checksum". It goes in `local_sha256`, and the difference is the
difference between integrity and provenance.

Staging a release with no published checksum requires `allowUnpublishedChecksum`
from the caller. Refusing outright would make the transport useless; skipping
quietly would make the HTTP path a lie. The FTN path sets it and the reason is
logged and recorded on the run.

Over FTN the trust boundary is the link password and, when a key is published,
the signature. The manifest end-state check still runs and still catches a
corrupted or truncated tree.

### Absent metadata is normal; corrupt metadata is not

The sibling is tried first, because over HTTP it is always there and 3 KB
decides whether you want 8 MB. When it is absent the archive's own copy is used.
When it is PRESENT and does not parse, staging stops: that is somebody telling
you something is wrong, and quietly using a different copy would hide it. The
two cases are distinguished by a flag on the error rather than by catching
everything.

### Echo tags

| Echo | Type | Carries |
|------|------|---------|
| `CANECTIC` | Message | Release announcements and support |
| `CANECTIC_FILES` | File | Stable artifacts |
| `CANECTIC_DEV` | File | Development artifacts |

Confirmed as designed. Short because other sysops type them into AreaFix
requests by hand, and renaming an echo other systems have subscribed to is the
one genuinely expensive change here.

### Publishing is still by hand

Consistent with phase 4. The maintainer drops the artifact into their own file
area and the existing TIC machinery distributes it, which is a path already
built and tested. A publish-to-echo flag can wait until a release has actually
gone out this way once. (`scripts/release.mjs --publish` exists but is
unrelated: it creates the GitLab release page for a pushed tag.)
