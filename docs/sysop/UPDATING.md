# Updating with the update tool

`src/tools/update.js` fetches a release, proves it is the release, works out
exactly what applying it would do to your installation, and optionally does it.

**This is half of the update system.** It puts files on disk and nothing else.
It does not stop your BBS, install dependencies, migrate the database, run the
release's upgrade steps or restart anything, and it tells you so when it
finishes. Until the rest is built, `setup/update.sh` remains the supported path
for a normal update.

---

## Seeing what an update would do

Nothing is written to your installation unless you pass `--apply`.

```bash
node src/tools/update.js --target /opt/canectic
```

That resolves the newest release on your configured channel, stages it, and
prints a summary:

```
  What applying 0.9.7a would do

    new files        2
    replaced         4
    already current  887
    left alone       2
    removed          2
    kept, yours      1

    168.4 KB written
```

Add `--verbose` to list every file rather than a summary.

| Line | Means |
|------|-------|
| new files | Not on your system; will be written |
| replaced | Ours, and out of date; will be overwritten |
| already current | Identical to the release; untouched |
| left alone | Yours by category: seeded files and art |
| removed | In a code directory, not in this release; will be deleted |
| kept, yours | You changed it and the release changed it too. Yours wins |

---

## Options

| Flag | Effect |
|------|--------|
| `--target DIR` | The installation. Defaults to the current directory |
| `--from-dir DIR` | Take artifacts from a directory instead of over HTTP |
| `--url BASE` | The release host. Defaults to `update_check_url` |
| `--channel NAME` | `stable` or `development`. Defaults to `update_channel` |
| `--version V` | A specific release rather than the newest |
| `--staging DIR` | Where to build the release. Defaults to `<target>/.canectic-update` |
| `--apply` | Actually write it, in this process. **Stop the BBS first** |
| `--handoff` | Hand off to the new release's updater, detached. **Stop the BBS first** |
| `--status` | Report the last update run on `--target` and stop |
| `--keep-staging` | Keep the staging directory, and with it the backup |
| `--verbose` | List every file |

`--from-dir` is not only for testing. An artifact that arrived down a file echo,
or that you copied onto a machine with no outbound HTTP, goes through exactly
the same verify and reconstruct path.

---

## What happens to your files

Every file in a release belongs to a category, and the category is a claim about
whose file it is.

| Category | What it holds | What an update does |
|----------|---------------|---------------------|
| code | `bin/ db/ docs/ examples/ setup/ src/ tests/` and the root files | Overwrites, and **deletes anything there that the release does not ship** |
| overlay | `public/` | Overwrites what we ship, leaves everything else |
| overlay-seed | `public/css/custom.css` | Written once at install, never again |
| data | `config/ xtrn/` | Takes the update only if you have not edited the file |
| art | `txtfiles/` | Adds what is new, never replaces what is there |

**Do not keep your own files in a code directory.** They will be deleted. That
has always been true of `update.sh` and it is still true here; the difference is
that this tool tells you which files beforehand.

Your door icons, custom images, branding, `custom.css`, edited config and your
own art all survive. That is asserted by the test suite, not merely intended.

### How it knows you edited a config file

Every release ships a `MANIFEST` of content hashes, and the copy left in your
installation records what the last release shipped. If a config file is still
byte for byte what shipped, nobody touched it and the update is safe to take. If
it differs, you changed it and yours is kept.

An installation from before this machinery existed has no `MANIFEST`, so the
question cannot be answered and **every changed data file is kept as yours**.
The first upgrade off such an install will report several conflicts; the one
after it will not.

---

## Applying

Stop the BBS first. This tool does not.

There are two ways to apply, and the difference is which copy of the code does
the work.

### `--apply`: this release applies the new one

```bash
pm2 stop all
node src/tools/update.js --target /opt/canectic --apply --keep-staging
```

Simple, synchronous, and fine when you are at the console.

### `--handoff`: the new release applies itself

```bash
pm2 stop all
node src/tools/update.js --target /opt/canectic --handoff
```

This stages the release, then launches the **new** version's updater as a
detached process and returns immediately. Two reasons it exists:

- **A process cannot replace its own files while running.** If an update is ever
  started from the running BBS, the thing doing the work is also the thing being
  replaced. The handoff puts the work in a process that survives the BBS being
  stopped, including `pm2 stop all`, which signals the whole process group.
- **Applying an upgrade is version specific and is where the bugs are.** Doing
  it with the new release's code means a release can ship a fixed updater and it
  takes effect for *that* upgrade rather than the one after.

It prints a run id, a state file and a log file. Watch it with:

```bash
node src/tools/update.js --status --target /opt/canectic
```

```
  run      20260913-162739-p29p   COMPLETE
  moving   0.9.6a -> 0.9.8a
  elapsed  1s

    done  preflight    920 files verified
    done  backup       /opt/canectic/logs/update/20260913-162739-p29p.backup
    skip  stop         this updater does not stop the BBS; stop it yourself
    done  files        38 written, 2 removed, 14 backed up
    skip  dependencies run npm install --omit=dev yourself
    skip  schema       run node src/tools/dbmigrations.js yourself
    ...
    done  verify       all written files match the release
```

Progress is a file under `logs/update/`, not a database row, because the updater
is replacing the database layer's own code and may be running while the BBS is
stopped. It survives everything, and `--status` reads it long after the run
finished.

A release cut before this mechanism existed ships no updater to hand off to. The
tool says so and tells you to use `--apply` instead.

### Staging lives inside the installation

Under `.canectic-update/`. That is not tidiness: `node_modules` resolves by
walking up from a module's own directory, and a release ships none, so an
updater staged in `/tmp` cannot import anything with a dependency. Nothing
scans, replaces or backs up that directory. It is safe to delete once an update
has finished and you no longer want the backup.

Everything either mode overwrites or deletes is copied into a backup directory
first, at its own relative path, before anything is touched. `--apply` puts it
under the staging directory; `--handoff` puts it beside the run state in
`logs/update/`. Both print the path.

After it finishes, you still have to do the rest by hand:

```bash
npm install --omit=dev
node src/tools/dbmigrations.js
# the upgrade steps listed in canectic-<version>.json
pm2 start all
```

---

## When it refuses

**"this system cannot move to X yet."** The move rule. Your database has applied
a one-time migration the target release does not ship, you are below the
release's upgrade floor, or your Node is too old. It says which, and it refuses
before downloading anything.

**"does not match its published checksum."** The artifact is corrupt or is not
the artifact that was published. It is not unpacked, and nothing on your system
is touched.

**"could not read the migration ledger."** The database did not answer within
ten seconds. The upgrade floor and the Node check still run, since neither needs
it, but whether a migration blocks the move cannot be established, so `--apply`
and `--handoff` are refused. A plan-only run continues and says so.

**"the staged tree does not match its manifest."** A delta and its base did not
reconstruct into the published tree. Again, nothing is applied. Try a fresh
staging directory; if it persists, the published artifact is wrong and it is
worth reporting.

All three happen in the staging directory, and none of them can leave your
installation half updated.

---

## Going back

The backup holds every file that was displaced, at its own relative path, so a
restore is a copy back:

```bash
cp -a <staging>/backup/. /opt/canectic/
```

That returns the files that were overwritten or deleted. Files the update
created are not in the backup, because they were not there before; the
`rollback` function in `src/maintenance/updateApply.js` removes those as well
and is what the finished updater will use.

Rolling back code is nearly free. Rolling back a database migration is not, so
the order matters: apply files, confirm the BBS starts, and only then run
`dbmigrations.js`.

---

## Related

- `docs/sysop/UPDATES.md` for the update check, which tells you a release exists
- `docs/reference/UPDATE_SYSTEM_DESIGN.md` for what is still to come
