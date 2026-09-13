# Update System Design

Design for release engineering, distribution, and in-BBS installation and
update for Canectic.

**Status:** design, not implemented. Written 2026-09-12.

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

### Nightly

```
MAJOR.MINOR.PATCH[phase].YYYYMMDD
```

A nightly carries **the version it is heading toward**, not the last one
released. While work is going on toward `0.9.6a`, nightlies are
`0.9.6a.20260913`.

"Nightly" names the branch, not a cadence. A build is cut when there is
something worth having rather than on a timer, so the gap between two nightlies
may be a day or may be two months. The date is the build date and nothing
depends on them being consecutive.

If two builds are ever cut on one day, a counter is appended:
`0.9.6a.20260913.2`.

### Ordering

Compare left to right: major, minor, patch numerically; then phase, where `a` is
lower than `b` and both are lower than absent; then the date, where a dated
build is lower than the undated one it is heading toward.

```
0.9.5a.20260901 < 0.9.5a.20260913 < 0.9.5a < 0.9.5b < 0.9.5 < 0.9.6a.20261001 < 0.9.6a
```

Read as: more prerelease is lower. A dated build is a prerelease of its target
version, and an earlier phase is a prerelease of a later one.

The property this buys is that **a nightly always converges onto its stable**.
Whoever is running `0.9.6a.<anything>` can move to `0.9.6a` the day it ships,
because it sorts above every nightly of that version.

### The obligation this creates

Cutting stable `0.9.6a` must bump the nightly branch to `0.9.7a` in the same
motion. Without that, nightlies keep claiming `0.9.6a.<date>`, which now sorts
*below* the stable that just shipped, and every nightly user is told they are
behind by a build that is actually ahead.

This is a step in the release script, not a thing to remember.

---

## 2. Channels and branches

Two channels:

| Channel | Contents | Cut when |
|---------|----------|----------|
| `stable` | Tagged releases | Deliberately, with release notes and the test checklist |
| `nightly` | Builds off the development branch | When there is something worth shipping |

A nightly build still goes through the release machinery: it gets a version,
metadata, an artifact and a checksum. What it skips is the ceremony -- the full
manual test checklist and the written release notes.

### Branches

Only `main` exists today. The channel model needs a development branch and a
stable branch. Which of the two `main` becomes is an open decision (section 11).

### Notification visibility

| Selected channel | Notified about |
|------------------|----------------|
| `stable` | stable only |
| `nightly` | nightly **and** stable |

Someone on nightly needs to know a stable shipped, both because it may be the
version they want to settle on and because it is often the safer move. Someone
on stable has not asked to hear about development builds.

---

## 3. Release artifacts and metadata

### What a release publishes

| File | Purpose |
|------|---------|
| `canectic-<version>.tar.gz` | The software |
| `canectic-<version>.json` | Machine-readable release metadata |
| `SHA256SUMS` | Checksums for both |
| `SHA256SUMS.asc` | Detached signature (optional, see section 11) |

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
  "artifact": "canectic-0.9.6a.tar.gz",
  "sha256": "...",
  "min_upgrade_from": "0.9.0a",
  "base": null,
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

### Nightly artifacts are deltas against stable

A nightly ships only the files that differ from **the most recent stable**, plus
a full manifest of the complete target tree.

```
canectic-0.9.6a.20260913.delta.tar.gz    bodies of differing files only
canectic-0.9.6a.20260913.json            metadata, including "base": "0.9.5a"
```

Down a file echo this matters: a nightly that touches five files ships five
files rather than the whole tree, on links that are often slow and sometimes
metered.

**Always against stable, never against the previous nightly.** One hop, always.
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

That is not fussiness. Going from one nightly to a later one, a file that changed
in the earlier build and was reverted in the later one appears in neither delta
at its correct content: the local copy holds the earlier change, the target
manifest wants the base version, and the delta carries no body for it because it
does not differ from the base. Patching incrementally leaves that file silently
wrong. Reconstructing makes reverts, deletions and partial states correct by
construction, and verifying the result against the manifest gives an end-state
check the full-tarball path does not have.

**The base is usually already on disk.** A sysop on stable `0.9.5a` moving to a
nightly based on `0.9.5a` already holds the base, so only the delta is fetched.
Otherwise the base stable artifact is fetched once and cached.

Two consequences:

- **A stable artifact cannot be pruned while a nightly references it.** The
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
10. Bump the nightly branch version if this was a stable cut, which also
    resets the nightly delta base to the version just cut

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
| `CANECTIC_NIGHTLY` | File | Nightly artifacts |

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
release on the selected channel (plus stable, if the channel is nightly) and
writes a sysop notification when something newer exists.

It never downloads and never applies.

The notification system already carries a sysop-broadcast type wired to the bell
icon in both nav bars, so this needs no new delivery mechanism.

### Configuration

| Key | Default | Category | Description |
|-----|---------|----------|-------------|
| `update_channel` | `stable` | system | Which channel this install follows |
| `update_check_enabled` | `false` | system | Run the daily check |
| `update_check_transport` | `http` | system | `http`, `ftn`, or `both` |
| `update_check_url` | (release index) | system | Where the HTTP index lives |
| `update_stable_file_area` | null | system | File area carrying stable artifacts |
| `update_nightly_file_area` | null | system | File area carrying nightly artifacts |

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
created and deleted per update.

### Detachment

The updater must survive the gateway being stopped. It runs in its own session
with its output to a file, and it must not execute from the tree it is
replacing. Same lesson as `setup/canectic-pm2.sh` needing to live outside
`setup/`, which `update.sh` wipes.

### Progress

Progress has to survive the gateway going away and coming back, so each phase
writes a durable row. When the browser reconnects, the page reads the state and
reports what happened rather than showing a lost connection.

Phases: preflight, backup, stop, files, dependencies, schema, migrations, steps,
start, verify.

---

## 7. Safety

### The move rule

A move is safe when **every migration already applied to this database also
exists in the target release**.

Channel is not the test. Neither is version, quite. Someone on a nightly from
1 September moving to a stable released on the 10th is moving forward, and
should be allowed. What actually constrains them is whether the target
understands the state their database is in.

The case version comparison misses is work that was in nightly and got deferred
out of the stable cut. Version-wise the move is forward; in practice the
database carries a migration the target does not ship and cannot reason about.
Normal convergence, nightly `0.9.6a.*` to stable `0.9.6a`, is always safe
because stable contains every migration its nightlies had.

On refusal, name the migration id and what it was for. "You cannot move to
stable" is not actionable; "your database has applied `0007-fileecho-hashes`,
which stable 0.9.6a does not ship" is.

**Dependency:** this rule needs a recorded migration ledger, which does not exist
yet. Today there is no migrations table and four different ad-hoc answers to
"has this one-time step run" (schema sniffing in `migrateMenuLayout`, a marker
row in `settings` for the MSGID split, nothing at all for `qwkConfRenumber`, and
an unanswerable question for `allow_netmail_relay`). That work is a prerequisite
and is designed separately.

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
(section 11).

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

Both channels are shown whatever is selected, since a nightly user needs to be
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

1. **Which branch is which.** Does `main` become the development branch with
   `stable` cut from it, or does `main` stay stable with development elsewhere?
2. **Signing.** GPG-signed `SHA256SUMS` is the right answer for a sysop
   audience, but it means key management and a documented verification path.
   Checksums alone are weaker but free.
3. **Does the update page offer "check now"?** If the daily check is off, a
   sysop still needs a way to ask, and that is an outbound request they opted
   out of. Probably allowed as an explicit action, since it is a human asking.
4. **Is a database dump required before migrating**, offered, or only warned
   about?
5. **How is the cached stable base stored**, and when is it discarded? It has to
   outlive the nightlies that reference it, which means it cannot simply be
   cleaned up with the staging directory.

Resolved during design:

- *Nightly artifact contents* -- deltas against the most recent stable, with a
  full manifest. See section 3.
- *File echo retention* -- nightly can prune freely on `max_files`, but the
  stable base a nightly references must be retained. Not a preference.

---

## 12. Phasing

1. Fix #44 so the two scripts stop disagreeing while the rest is built
2. Migration ledger (prerequisite, designed separately)
3. Version parsing and comparison, with tests, since everything depends on it
4. Release script and metadata, published by hand at first
5. Update check and notification (read-only, no apply)
6. The updater, with the handoff model
7. Bootstrap installer
8. FTN transport
