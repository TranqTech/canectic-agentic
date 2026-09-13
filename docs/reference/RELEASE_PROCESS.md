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
| `--allow-dirty` | Build from uncommitted work. Never for a real release |
| `--allow-migration-gap` | Publish a stable that drops a development migration |
| `--no-tag` | Skip the release commit and the tag |
| `--sign` | GPG sign `SHA256SUMS` |
| `--base-manifest PATH` | Point a delta at a base manifest held elsewhere |
| `--date YYYY-MM-DD` | Override the release date |
| `--counter N` | Force a same-day development build counter |

### What a stable cut does

1. Refuses a dirty tree, a failing suite, an empty `Pending`, or a version that
   is not newer than what `package.json` claims
2. Checks that it ships every migration its own development builds already
   applied (section 4)
3. Closes `Pending` into `## v<version> (<date>)` and opens a fresh one
4. Writes `docs/releases/v<version>.md` from the declared steps, the notices and
   the closed changelog body
5. Clears `pending.json`, keeping the standing floor
6. Bumps `package.json`, commits, tags `v<version>`
7. Stages the shipped tree, builds `MANIFEST`, packs the tarball
8. Writes the metadata, the standalone manifest, the channel index and
   `SHA256SUMS`

The bookkeeping happens **before** the artifact is staged, so a release tarball
contains its own release notes and its own changelog entry. Building first would
ship a tarball whose changelog says the release is still pending.

### What a development cut does

Nothing to the repository. It derives its version from `package.json` (the last
stable released) plus today's date, builds a delta against that stable, and
publishes it. A second build on one day gets a counter rather than overwriting
the first, which somebody may already be running.

It refuses when nothing differs from the base but the version stamp. Every
development build rewrites the version in the staged `package.json`, so that one
file always differs; the script re-hashes it with the base's version put back to
tell a real change from the stamp.

---

## 3. What gets published

| File | Purpose |
|------|---------|
| `canectic-<version>.tar.gz` | The software. A delta for development builds, with `.delta` in the name |
| `canectic-<version>.json` | Release metadata: steps, notices, migrations, checksum |
| `canectic-<version>.manifest.json` | The full tree manifest, standalone |
| `index-<channel>.json` | Every release on the channel, newest first |
| `SHA256SUMS` | Checksums for everything above |
| `SHA256SUMS.asc` | Detached signature, with `--sign` |

The tarball unpacks to `canectic-<version>/` and carries a `MANIFEST` at its
root.

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

By hand, for now. Copy the contents of `dist/releases/` to wherever the channel
index is served, push the tag, and write the release notes the skeleton is
waiting for.

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
| `src/release/shippedTree.js` | What ships, and how each file may be treated |
| `src/release/manifest.js` | Content hashes and the diff between two trees |
| `src/release/metadata.js` | What a release says about itself, and its validation |
| `src/release/releaseIndex.js` | The per-channel index |
| `src/release/pipelineCheck.js` | The migration coverage rule, both callers |
| `src/release/changelog.js` | Reading and closing `Pending` |
| `docs/releases/pending.json` | The declarations accumulating this cycle |

Everything under `src/release/` is pure or filesystem-only, and unit tested in
`tests/release*.test.js` and `tests/shippedTree.test.js`. The CLI is
deliberately thin: it is the part a test cannot usefully assert.
