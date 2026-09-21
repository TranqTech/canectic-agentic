# Updating with the update tool

`src/tools/update.js` fetches a release, proves it is the release, works out
exactly what applying it would do to your installation, and optionally does it.

It does the whole thing: closes the board for maintenance, waits for it to
drain, stops the BBS, replaces the files, installs dependencies, dumps the
database, migrates it, runs the release's automatic upgrade steps, starts the
BBS again and reopens the board. Anything it skips it names, with the command
for you to run.

`setup/update.sh` still works and is not going anywhere yet.

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

## What it does, in order

| Phase | What happens |
|-------|--------------|
| preflight | Verifies the staged tree against its manifest, checks Node and disk |
| backup | Sets aside everything about to be overwritten or deleted |
| stop | Waits for the board to drain, then `pm2 stop all` |
| files | Writes the release |
| dependencies | `npm install --omit=dev` |
| schema | **Dumps the database**, then runs `dbmigrations.js` |
| migrations | Covered by the same `dbmigrations` run |
| steps | Runs the release's automatic upgrade steps |
| start | `pm2 start ecosystem.config.cjs` |
| verify | Confirms every written file matches the release |

The board is closed for maintenance before any of this, as soon as the update
starts, so connected callers and logged-in web users get their warning while the
backup is taken. The stop waits until the board has drained, and the board
reopens only after verify. What callers see, and what happens to the board if
the update fails, is in [MAINTENANCE.md](MAINTENANCE.md).

The file backup happens before the stop, because shipped files do not change
while the BBS is running and there is no reason to pay downtime for it. The
database dump happens after the stop and immediately before the migration,
because it exists to protect the migration: taken any earlier it would not
contain the writes in between.

**Starting from the ecosystem file starts every process in it.** If you had the
mailer deliberately stopped, it comes back up. `--status` shows what was running
before the update, so you can put it back.

### Turning parts off

| Flag | Effect |
|------|--------|
| `--no-dump` | Do not dump the database before migrating |
| `--no-deps` | Do not run `npm install` |
| `--no-schema` | Do not run `dbmigrations` |
| `--no-restart` | Do not stop or start the BBS |

Each one records itself as a skipped phase with the command you now owe.

## If something fails partway

**Before the database is migrated**, the files are put back automatically from
the backup, and the BBS is started again. The only thing that changed was files,
so undoing it is complete.

**After the database is migrated**, the files are left alone deliberately. Old
code over a migrated database is a worse state than the failure, so the update
stops, tells you where the backup and the dump are, and leaves the decision to
you. The BBS is still started again.

Either way **the board stays closed for maintenance** after a failure at or
after the stop, so nobody calls in while you look. Reopen it from the
Maintenance page, or with `node src/tools/maintenanceMode.js --off`, once you
are satisfied. A failure before the stop changed nothing and reopens it.

`--status` shows which phase failed and why.

---

## Programs the update expects to find

`/admin/update` checks for the external programs Canectic uses and names any
that are absent. None of them block an update and none are needed to run a
board, which is exactly why they go unnoticed: each one is discovered missing at
the moment somebody first uses the feature that needs it.

Two are worth acting on rather than noting.

**`pg_dump`.** The updater dumps the database immediately before migrating it,
and that dump is the thing that makes a failed migration recoverable. Without
it, the update has to run with `--no-dump` and a migration that goes wrong has
nothing to restore from. It comes with `postgresql-client`, which a local
PostgreSQL installs for you; a board using a remote or managed database has to
install it separately.

**`dosemu` and `socat`.** DOS doors need both, and `dosemu2` comes from a PPA
rather than the Ubuntu archive. This matters here and not only at install time,
because **an OS release upgrade disables third-party repositories**, so a board
that upgrades its operating system can arrive at a Canectic update having
quietly lost DOS door support. `OS_UPGRADE.md` covers re-pointing the source.

The full list, with what each one is for, is in `INSTALL.md`.

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

## Disk the updater is holding

Everything lives in `.canectic-update/` with three different lifetimes:

| Directory | Lifetime | Deleting it costs |
|-----------|----------|-------------------|
| `staging/` | One update | Nothing, once the update finished |
| `base/` | Across updates | A development update re-downloads its base stable |
| `backup/` | Until you reclaim it | Past updates can no longer be rolled back |

`/admin/update` shows the size of each. Deleting the whole directory is safe and
loses nothing but those three things.

The base cache is why a development update is fast the second time: a delta is
rebuilt against the stable it names, and that stable is kept rather than fetched
again. It is re-verified against its checksum on every use, because a local file
is no more trustworthy than a downloaded one.

## Updating from the web

`/admin/update` has an Update button when a release is available and nothing in
the preflight is blocking. It shows you what the update will do first, including
how many callers and web users will be warned and then disconnected.

Pressing it stops the BBS, so the page goes away. Come back to it and it reports
what happened, read from a file the update writes as it goes rather than from
the connection it was serving on.

## Updating over FTN

With `update_check_transport` set to `ftn`, the tool takes releases from your
configured file area instead of over HTTP. Everything else is identical: the
same plan, the same categories, the same phases.

One difference it will tell you about. A release that arrived down a file echo
may have no published checksum with it, because the sibling metadata file
travels separately and can be lost. The tool says so rather than pretending it
checked, and the manifest check after unpacking still runs.

See `docs/sysop/UPDATES.md` for what FTN integrity does and does not guarantee.

## Related

- `docs/sysop/UPDATES.md` for the update check, which tells you a release exists
- `docs/reference/UPDATE_SYSTEM_DESIGN.md` for what is still to come
