# Release Process

How a Canectic release is cut, what it publishes, and what a maintainer has to
do by hand.

Implements phase 4 of `UPDATE_SYSTEM_DESIGN.md`. Everything here exists on the
maintainer's machine; nothing in it runs on an install.

---

## 1. The two things a maintainer keeps up to date

A release cycle accumulates two records of the same work, one for people and one
for the updater. Both are edited as the work happens, not at cut time.

**`docs/sysop/CHANGELOG.md`, the `Pending` section.** Prose. What changed and
why. Its `### Upgrade Notes` block is the part a sysop must read before updating
a live board.

**`docs/releases/pending.json`.** The same upgrade actions, declared:

```json
{
  "min_upgrade_from": "0.9.0a",
  "steps": [
    {
      "id": "dbmigrations",
      "description": "Apply the declarative schema and the migration ledger",
      "automatic": true,
      "applies_when": "always",
      "command": "node src/tools/dbmigrations.js"
    }
  ],
  "notices": [
    { "level": "warning", "text": "allow_netmail_relay is deprecated and ignored." }
  ]
}
```

A **step** has something to run and a condition saying whether this install
needs it. A **notice** has nothing to run: it is a behaviour that changed
underneath the sysop, which is the kind that hurts most when missed because
nothing fails.

`min_upgrade_from` and `node_min` are standing facts and survive a cut. `steps`
and `notices` belong to one cycle and are cleared by it.

The two files are cross checked at cut time and a whole missing half is
reported, but neither is derived from the other. Parsing prose to decide what to
execute on someone's live board works right up until a bullet is reworded, and
the failure is silent.

---

## 2. Cutting

```bash
node scripts/release.mjs --stable 0.9.6a      # a stable release
node scripts/release.mjs --dev                # a development build
node scripts/release.mjs --stable 0.9.6a --dry-run
```

| Flag | Effect |
|------|--------|
| `--dry-run` | Report the plan, write nothing |
| `--output DIR` | Where artifacts land, default `dist/releases` |
| `--skip-tests` | Re-cut after a failure without waiting for the suite |
| `--skip-audit` | Do not audit dependencies. For a cut with no network |
| `--allow-advisories` | Cut despite a fixable high or critical advisory |
| `--allow-dirty` | Build from uncommitted work. Never for a real release |
| `--allow-migration-gap` | Publish a stable that drops a development migration |
| `--no-tag` | Skip the release commit and the tag |
| `--sign` | GPG sign `SHA256SUMS` |
| `--base-manifest PATH` | Point a delta at a base manifest held elsewhere |
| `--date YYYY-MM-DD` | Override the release date |
| `--counter N` | Force a same-day development build counter |

### The dependency audit

Both kinds of cut run `npm audit --json --omit=dev` and **refuse** on a high or
critical advisory in a production dependency that has a published fix.

Every clause of that rule is doing work, and loosening any of them makes the
gate useless in a different way:

- **Production**, because dev dependencies are not installed on a board, and a
  release held up by mocha's tree is noise.
- **High or critical**, because a cut blocked by a low-severity advisory in
  something transitive is a cut that never happens.
- **Fix available**, because a gate that cannot be satisfied gets bypassed every
  time until nobody reads it. An advisory with no published fix is reported
  loudly and does not block.

Everything the audit saw is printed either way, so nothing is silently passed
over. `--allow-advisories` overrides the refusal; `--skip-audit` skips the check
entirely, which is for cutting with no network.

An audit that could not run is **not** treated as a clean one. It warns that the
release has not been checked and carries on, rather than printing a tick for
something that never happened.

Why at cut time: a dependency sweep is correct on the day it is done and stale a
week later. adm-zip went to 0.6 on 2026-09-04, clearing every advisory that then
existed; 0.6.1 landed on 2026-09-11 fixing two more, and nothing would have
noticed until somebody happened to run an audit by hand. The cut is the moment
the tree stops being the maintainer's and starts being everybody's, so it is the
moment to look.

The rule itself is `summariseAudit` in `src/release/auditCheck.js`, pure and
tested in `tests/releaseAudit.test.js`, because "is this release safe to ship"
is not a question to answer with a regex over console output.

Note that `npm audit` reads the **lockfile**, not `node_modules`. That is the
right thing here: `package-lock.json` ships in the artifact and is what a board
installs from, so the audit describes what sysops will actually get rather than
what happens to be on the maintainer's disk.

### What a stable cut does

1. Refuses a dirty tree, a failing suite, a fixable high/critical advisory in a
   production dependency, an empty `Pending`, or a version that is not newer
   than what `package.json` claims
2. Checks that it ships every migration its own development builds already
   applied (section 4)
3. Closes `Pending` into `## v<version> (<date>)` and opens a fresh one
4. Writes `docs/releases/v<version>.md` from the declared steps, the notices and
   the closed changelog body
5. Clears `pending.json`, keeping the standing floor
6. Bumps `package.json` and the root version in `package-lock.json`, commits,
   tags `v<version>`. The lockfile matters: npm syncs its root version to
   `package.json` on every install, and a lockfile left behind is rewritten on
   every board (see `src/release/lockfile.js`). Every build also stamps its
   version into the staged copy of both files
7. Stages the shipped tree, builds `MANIFEST`, packs the archive
8. Writes the metadata, the standalone manifest, the channel index, the
   bootstrap and its checksum, and `SHA256SUMS`
9. Creates the GitLab release for the tag, with the release notes as its
   description and the artifacts attached (see section 3)

The bookkeeping happens **before** the artifact is staged, so a release archive
contains its own release notes and its own changelog entry. Building first would
ship an archive whose changelog says the release is still pending.

### What a development cut does

Nothing to the repository. It derives its version from `package.json` (the last
stable released) plus today's date, builds a delta against that stable, and
publishes it. A second build on one day gets a counter rather than overwriting
the first, which somebody may already be running.

It refuses a `--base-manifest` that describes a different tree than the metadata
names. The version and the `base` field are both derived from the version
string, so they agree with each other whichever manifest was loaded, and nothing
else can catch a delta computed against the wrong tree. The manifest states
which version it describes, so the check costs one comparison and the failure it
prevents is a published delta nobody can reconstruct.

It refuses when nothing differs from the base but the version stamp. Every
development build rewrites the version in the staged `package.json`, so that one
file always differs; the script re-hashes it with the base's version put back to
tell a real change from the stamp.

---

### Withdrawing a release

A release can only be found defective after it is published. By then it is
signed, indexed, and reachable by every board that checks, so the thing to do
is stop it spreading at once, not after the fix has been cut.

```bash
# The moment the fault is found. No replacement needed.
node scripts/release.mjs --withdraw 0.9.8a --reason "the updater crashes if a browser is open on the board" --sign
node scripts/publish.mjs

# Once the fix is cut and in the index, point boards at it.
node scripts/release.mjs --supersede 0.9.8a --by 0.9.9a --sign
node scripts/publish.mjs
```

`--withdraw` needs `--reason`: a board running the release is told it, and
nothing else says why. `--by` is optional there and names the replacement if it
already exists. `--supersede` needs `--by`, and works on a release that is
still listed (withdrawing it as it goes) or already withdrawn (keeping the
original reason and time). Either refuses a `--by` that is not a listed
release, since a typo would point every affected board at nothing.

**A withdrawal takes the release out of the index's `releases` list** and puts
it in a `withdrawn` list with `withdrawn_at`, `withdrawn_reason` and
`superseded_by`. That is what makes it work on boards that have never heard of
withdrawal: every update check before 0.9.8a, and every bootstrap ever
published, takes the first entry in `releases` whatever it says, so the first
format (a mark on the entry, used once for 0.9.7a) protected nobody on an older
release. An index still in that format is converted by whatever new code reads
it next, and a withdrawn version can never be re-used by a later cut.

The withdrawal lands in the channel index, not in the release's own metadata
sidecar. The sidecar describes the archive, is covered by `SHA256SUMS`, and is
what a board verifies on download; rewriting it would invalidate a signature
over bytes that must never change. The index is the regenerated part, which is
why a withdrawal belongs there, and why `SHA256SUMS` is rebuilt and re-signed
afterwards. With `--sign`, the command proves it can sign before it touches
anything, so a run that cannot sign leaves the directory as it was.

What reads the `withdrawn` list:

- the update check tells a board **running** a withdrawn release so, with the
  reason, even before a replacement exists. That is the difference between
  "you are current" and "you are on a release that was pulled"
- asking for a withdrawn release by name (the Admin UI, `update.js --version`,
  `bootstrap.sh --version`) is refused with the reason and the replacement,
  rather than "not published"
- the publish script keeps its notes on the site
- the release-time migration coverage check still counts a withdrawn
  development build, because boards that took it applied its migrations

Nothing is deleted from the release host. The artifact stays downloadable,
because a development build may be based on it and because removing a file
people may already hold solves nothing.

On the notes and the changelog: the changelog needs no special handling, being
append-only and chronological — the replacement gets its own section and the
withdrawn release keeps its own, which is exactly right for somebody reading
what they are about to receive. The release **notes** are a different matter,
since a sysop jumping from the version before the withdrawal to the replacement
would otherwise only read about the fix. Copy the withdrawn release's notes
into the replacement and add the hotfix section at the top. They are hand
written anyway, so this costs a minute and keeps the page complete.

## 3. What gets published

| File | Purpose |
|------|---------|
| `canectic-<version>.zip` | The software. A delta for development builds, with `.delta` in the name |
| `canectic-<version>.json` | Release metadata: steps, notices, migrations, checksum |
| `canectic-<version>.manifest.json` | The full tree manifest, standalone |
| `index-<channel>.json` | Every release on the channel, newest first |
| `bootstrap.sh` | The installer a new sysop fetches, from `setup/` |
| `bootstrap.sh.sha256` | Its checksum, in `sha256sum -c` format |
| `INSTALL.md` | The install guide, readable without downloading a release |
| `SHA256SUMS` | Checksums for everything above |
| `SHA256SUMS.asc` | Detached signature, with `--sign` |

The archive unpacks to `canectic-<version>/` and carries a `MANIFEST` at its
root.

`SHA256SUMS` is built by exclusion: everything in the publish directory except
the list itself and a signature over it. It used to be built from a pattern
naming release filenames, which stopped matching the artifact the day it became
a ZIP and never matched the channel index at all, so the published list vouched
for the sidecars and not for the software. A rule that enumerates what to
include has to be revisited whenever something new is published, and fails
silently when it is not.

### The GitLab releases page

A cut also creates the release object for its tag, with `docs/releases/v<version>.md`
as the description and the archive, its two sidecars, `SHA256SUMS`,
`SHA256SUMS.asc` and the public key uploaded to the project's generic package
registry. `--no-gitlab` skips it, and a missing or unauthenticated `glab` is
reported rather than failing a cut that is already complete.

The release host stays canonical: `update_check_url` points there and the
bootstrap fetches from there. The page is where a person finds a release.

A second fetch location is safe because the release is signed. The signature is
over the content rather than over a location, so a copy elsewhere cannot say
anything the original does not. Mirroring unsigned artifacts would be adding a
second thing that can drift.

`bootstrap.sh` is deliberately not attached, because it defaults to fetching
from the release host and a copy taken from a release page would be a trap while
that host is not serving.

Left alone, GitLab shows "Source code (zip)" for a tag, which looks like a
download and is a git tree: no `MANIFEST`, no `CANECTIC.ID`, and installing it
takes the from-source path. Every release before v0.9.6a offered that and
nothing else.

The bootstrap is the one file that cannot ship inside a release, because
resolving a release is its job, so the release script copies it out of `setup/`
on every cut. A stale bootstrap on the host is invisible: it resolves the newest
release perfectly well and then hands off to an installer it was never checked
against.

### The manifest

Every shipped file with its sha256, size, permission bit and category. Three
things need it:

- **Telling a sysop's edit from a shipped file.** `update.sh` compares mtimes,
  which says when a file was written and nothing about whether its contents
  differ from what shipped.
- **Deletions.** The manifest describes the complete target tree, so a file
  present locally and absent from the manifest is one to remove. A delta
  expressed only as changed files cannot say "this file is gone", which is why
  `update.sh` reaches for `rm -rf` on code directories.
- **An end-state check.** After reconstructing a tree from base plus delta, the
  manifest says whether the result is the tree that was published.

### Categories

`src/release/shippedTree.js` is the single definition of what ships and how each
file may be treated. The categories are behavioural:

| Category | The updater may |
|----------|-----------------|
| `code` | Overwrite, and delete target-only files in the directory |
| `overlay` | Overwrite shipped files, leave target-only files alone |
| `overlay-seed` | Write once when absent, never again |
| `data` | Merge, asking before replacing a file that differs |
| `art` | Skip unless asked, but always add new files |

The category travels in the manifest rather than being re-derived, so a release
that adds a directory carries the rule for it.

`scripts/` and `reference/` are tracked but deliberately not shipped: maintainer
tooling and research notes. A path with no rule does not ship at all rather than
defaulting to something, because defaulting a new top-level directory to `code`
would mean the first release after somebody adds one deletes whatever a sysop
keeps in it.

---

## 4. The pipeline check

Because a development build names its base in its own version, the set of builds
that put migrations into people's databases on this cycle is enumerable straight
out of the index. Cutting a stable asks whether it ships every one of them.

If a migration went out on development and then got deferred out of the cut, the
answer is no, and everyone running one of those builds is about to be refused
the upgrade by the runtime move rule. The script **refuses the cut** and names
the builds and the migrations.

> The design called for a warning here. It is a refusal, because a warning in a
> script output is a warning nobody reads, and the consequence of missing it is
> a class of user who cannot upgrade at all. `--allow-migration-gap` publishes
> anyway when the trade is deliberate.

Only builds on the stable being superseded are considered. Builds on an older
base were already checked when their own stable was cut, and carrying every
build ever published forward would mean a migration could never be retired.

---

## 5. Versions

`package.json` in the repository carries **the last stable released**, because
that is the only version the tree can honestly claim between releases. The build
stamps the full computed version into the `package.json` inside the artifact, so
a development build installs as `0.9.5a.20260913` rather than reporting itself
as `0.9.5a`.

Without the stamp every development build would identify as the stable it was
based on, be told by the update check that it is current, and never see a newer
development build at all.

Parsing and ordering live in `src/utils/version.js`. The rule that matters:
a dated build sorts **above** the stable in its name.

---

## 6. Publishing

```bash
node scripts/publish.mjs               # publish, then verify over HTTPS
node scripts/publish.mjs --dry-run     # show what would be sent, change nothing
node scripts/publish.mjs --no-verify   # publish without the read-back
```

Write the release notes the skeleton is waiting for first, since they go out
with the release. The tag and the GitLab release page are a separate step, see
section 3.

| From | To, under the host's site root | Served at |
|------|--------------------------------|-----------|
| `dist/releases/*` | `releases/` | `/releases/<file>` |
| `docs/sysop/CHANGELOG.md` | `docs/CHANGELOG.md` | `/docs/changelog` |
| `docs/releases/v<version>.md` | `docs/releases/<version>.md` | `/releases/<version>/notes` |

Release notes lose their leading `v` on the way, because the site looks them up
by the version in the channel index. Only versions a published index names are
sent, so `v<version>-changes.md` and anything else kept beside the notes never
is.

Before sending, the script checks `dist/releases` against its own `SHA256SUMS`,
counting an unlisted file as a problem because the list is built by exclusion,
and verifies `SHA256SUMS.asc` when there is one. After sending, it downloads
every release file through the public URL and compares bytes, checks that a
missing file is a real 404 (the update check reads a 404 as "nothing published
on this channel"), and checks the changelog and notes pages answer. A file can
arrive intact on the host and still be served wrong.

The changelog goes as the tree has it, `Pending` included, so running the
script between releases is how the site's copy stays current. Re-sending an
unchanged release costs nothing.

**The host.** An ssh alias, `canectic-release` by default, with a key used for
nothing else:

```
Host canectic-release
    HostName <the web host>
    User <the account that owns the site>
    IdentityFile ~/.ssh/canectic_release
    IdentitiesOnly yes
```

`CANECTIC_PUBLISH_HOST`, `CANECTIC_PUBLISH_ROOT` (the site root relative to that
account's home, default `tranqsoft-website/canectic`) and `CANECTIC_PUBLISH_URL`
(default `https://canectic.tranqsoft.com`) override the defaults.

**Nothing is ever deleted on the host**, and no rsync the script runs may carry
`--delete`; `tests/publish.test.js` holds it to that. `dist/releases` holds only
what this machine cut, so mirroring it would remove whatever was published from
anywhere else, and the first constraint below would be broken without an error
anywhere.

Two retention constraints, neither of them a preference:

- **A stable artifact cannot be pruned while a development build references it.**
  A delta is reconstructed from its base, so the base must stay available.
- **The channel index must list every release still fetchable.** A client
  resolves through the index and cannot find what is not in it.

---

## 7. Where the code is

| Path | What |
|------|------|
| `scripts/release.mjs` | The CLI. Orchestration and process control |
| `scripts/publish.mjs` | Sending a cut, the changelog and release notes to the host, and reading them back |
| `src/release/shippedTree.js` | What ships, and how each file may be treated |
| `src/release/manifest.js` | Content hashes and the diff between two trees |
| `src/release/metadata.js` | What a release says about itself, and its validation |
| `src/release/releaseIndex.js` | The per-channel index |
| `src/release/pipelineCheck.js` | The migration coverage rule, both callers |
| `src/release/changelog.js` | Reading and closing `Pending` |
| `src/release/updateVerdict.js` | Whether an update exists and may be taken (phase 5) |
| `docs/releases/pending.json` | The declarations accumulating this cycle |

Everything under `src/release/` is pure or filesystem-only, and unit tested in
`tests/release*.test.js` and `tests/shippedTree.test.js`. The CLI is
deliberately thin: it is the part a test cannot usefully assert.
