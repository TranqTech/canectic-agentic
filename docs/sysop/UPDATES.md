# Update Checking

How to have Canectic tell you when a newer release exists, what it sends, and
what it will not do.

---

## What this is

An opt-in daily check that fetches a release index, compares it against what you
are running, and raises a sysop notification when something newer exists.

**It never downloads an artifact and never applies anything.** Installing an
update is still `setup/update.sh`. The in-BBS updater is not built yet.

---

## Turning it on

On `/admin/config`, under **Updates**:

| Setting | Default | What it does |
|---------|---------|--------------|
| `update_check_enabled` | off | Run the check once a day |
| `update_channel` | `stable` | Which channel this install follows |
| `update_check_url` | the release host | Where the channel indexes live (HTTP only) |
| `update_check_transport` | `http` | `http`, `ftn`, or `both` |
| `update_stable_file_area` | unset | File area carrying stable artifacts (FTN) |
| `update_dev_file_area` | unset | File area carrying development builds (FTN) |
| `update_check_retention_days` | 90 | How much check history to keep |

Turning it on registers the daily job, which needs a gateway restart or
`node src/tools/schedules.js --sync` to take effect. The same is true of turning
it off.

You do not have to turn it on to ask. `/admin/update` has a **Check now** button
that works whatever the setting says: the opt-out is about this system reaching
out on its own, and you pressing a button is not that.

---

## What it sends

A plain GET for a static JSON file. No query string, no identifier, no version,
no board name, nothing about your users or your configuration.

A server logging that request learns an IP address asked for a file, which is
what any web server learns about any fetch. There is no telemetry and there is
nothing to opt out of beyond the request itself.

With `update_check_enabled` off and Check now unpressed, this system makes no
outbound request at all.

---

## Getting releases over FTN

If your board has an FTN link and you would rather not have it reach out over
HTTP at all, set `update_check_transport` to `ftn` and point
`update_stable_file_area` at the file area carrying the release echo.

| Echo | Type | Carries |
|------|------|---------|
| `CANECTIC` | Message | Release announcements and support |
| `CANECTIC_FILES` | File | Stable releases |
| `CANECTIC_DEV` | File | Development builds |

Nothing else changes. The TIC tosser receives an artifact, checks it against the
TIC, hashes it and files it, and a new one appearing in that area **is** the
signal. There is no announcement to wait for and no outbound request of any
kind: the check becomes a database query and a read of a file already on your
disk.

There is no published index on this path, so one is worked out from what the
area holds. Each archive carries a `CANECTIC.ID` at its root saying what it is,
and an archive that does not carry one is ignored rather than offered, because
nothing would be known about what it needs.

### What this does and does not prove

Worth being plain about, because it is weaker than the HTTP path.

**Proved:** the file has not changed since it arrived. The TIC carries a CRC-32
that the tosser checks on arrival, and Canectic computes and stores a SHA-256 of
its own.

**Not proved:** that it is the file that was built and published. The published
checksum only travels if the sibling `.json` was TIC'd alongside the archive,
and two files in a file echo travel independently, so one can be lost. When the
published checksum is not there, the update tool says so rather than pretending
it checked.

Over FTN your trust rests on your link password and on whoever is feeding you
the echo, the same as it does for every other file you receive that way. A
signature will close that gap when a key is published.

The end-state check still runs regardless: after unpacking, every file is
verified against the manifest inside the archive, so a corrupted or truncated
download is caught before anything is applied.

## Channels

**Stable** is full releases. If other people call your board, this is the one.

**Development** builds are cut when there is something worth having, which may
be a day apart or two months. They go through the same release machinery as
stable and are meant to be run on live boards, not merely inspected. They carry
the last stable released plus a build date, so `0.9.6a.20260913` is a build made
on 13 September 2026 on top of stable `0.9.6a`.

A system on development is told about stable as well, because converging back
onto stable is a move worth being offered. A system on stable is never told
about development builds: that is a channel you did not choose.

---

## Reading `/admin/update`

Each channel gets one of four verdicts.

**Up to date.** Nothing newer.

**Available.** Something newer, and nothing stands in the way.

**Blocked.** Something newer that this system cannot take yet, with the reasons
named. Three things block a move:

- *Migration.* Your database has applied a one-time migration the target release
  does not ship, so the target cannot reason about the state your data is in.
  This is the one that catches work which went out on development and then got
  deferred out of a stable cut: the move is forward by version number and
  impossible in practice. The blocked release is still shown, with the migration
  named, rather than quietly offering you something older.
- *Too old to upgrade directly.* The release states the oldest version it knows
  how to upgrade from, and this install is below it.
- *Node too old.* The release needs a newer Node than you are running.

**Not resolved.** No index came back for that channel. A channel with nothing
published has no index, so this is the normal answer for development on a
project that has only cut stables. A real failure (a timeout, a server error, a
page that is not an index) is shown separately, with the error.

The History table lists every check, whether it found anything or not. That is
deliberate: a page showing only the last result cannot tell a check that found
nothing from a check that stopped running, and the second is the one worth
seeing.

---

## Notifications

When the check finds something, every sysop gets a notification in the bell
menu, linking to `/admin/update`.

It will not tell you the same thing every morning. A repeat notification only
happens when the available version changes, or when a release that was blocked
becomes reachable because you ran the migration or upgraded Node. That second
case is the one worth waiting for, which is why the version alone is not the
whole test.

---

## Troubleshooting

**Nothing ever happens.** Check that `update_check_enabled` is on, then that the
schedule registered: `node src/tools/schedules.js` lists it as
`update-check-daily`. A registered schedule whose next run is in the past means
the worker is not draining the maintenance queue, which is a bigger problem than
the update check.

**"Could not resolve the release index."** The URL in `update_check_url` is
wrong, the host is unreachable, or something between you and it is returning a
page instead of the file. The exact error is on the page. Press Check now after
fixing it rather than waiting a day.

**A release is blocked by a migration and you want to move anyway.** You cannot,
and the refusal is protecting your database rather than being fussy. Wait for a
release that ships the migration, which is normally the next one.

---

## Related

- `docs/reference/UPDATE_SYSTEM_DESIGN.md` for the whole design, including the
  parts not built yet
- `docs/reference/RELEASE_PROCESS.md` for how a release is cut in the first place
