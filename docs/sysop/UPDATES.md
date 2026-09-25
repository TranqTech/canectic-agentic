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
the echo, the same as it does for every other file you receive that way, unless
you require signatures (below).

### Signatures

Stable releases are signed. Before an update applies anything, it checks the
release's signed `MANIFEST` against the release key your board already has
(`setup/canectic-release.asc`, installed with Canectic). The key your board
trusts comes from your installation, never from the release being checked, so a
release swapped for another cannot bring its own key with it.

- **A signature that is present and fails is always refused,** whatever your
  settings. That is somebody telling you something is wrong.
- **An unsigned release is allowed by default.** Development builds are never
  signed.
- **Turn on `update_require_signature`** to refuse anything not signed by the
  release key. That means stable releases only, and it needs `gpg` installed.

The update log says which it was: `signature verified`, `unsigned`, or why it
could not check.

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

### Switching channel

Pick the channel in the **Channel** box at the top of `/admin/update` and press
**Switch**. It is the same `update_channel` setting as on the Configuration
page, and the page checks the new channel straight away. Switching changes only
what you are offered; nothing is downloaded until you press Update. If `.env`
sets `update_channel`, the page shows it read-only and the change has to be
made there.

- **Stable to development.** The newest development build is offered at once,
  if it is newer than what you run.
- **Development to stable.** A development build is newer than the stable it
  was built on (0.9.11a.20261001 comes after 0.9.11a), so there is nothing to
  move to yet: the board stays on its build and moves onto stable with the first
  stable release after it. The Update page says so for as long as that is the
  case. If a development build applied a database change that next stable does
  not ship, the stable release shows as blocked with the reason, rather than
  being offered.

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

**If the check is older than the board.** The page shows the last check, and
the board may have changed version since, most often because it has just been
updated. What that check found is judged against the version running now, so the
page never offers the release you already run, and it says "The last check ran
while this board was on X". Press Check now to refresh it.

The History table lists every check, whether it found anything or not. That is
deliberate: a page showing only the last result cannot tell a check that found
nothing from a check that stopped running, and the second is the one worth
seeing.

---

## Upgrade notes

Some releases change something you need to know about before or after you
update: a log to clear, a limit that starts being enforced, a burst of files
your downlinks will receive. Each release declares these as upgrade notes, and
the Update page shows the ones that concern you in a **Before you update**
panel above the Update button.

- **Every release you would skip counts.** Moving from 0.9.6a straight to a
  later release shows the notes of every release in between as well, including
  withdrawn ones, since your board passes through what they changed. A note
  repeated by a later release is shown once.
- **Only the ones for your version.** A note can say which versions it
  concerns ("coming from 0.9.7a or earlier"), and a board outside that range is
  not shown it.
- **Warnings must be acknowledged.** When any note is a warning, the Update
  button stays disabled until you tick that you have read them. The tick is tied
  to the notes you were shown: if a check finds a newer release in the
  meantime, you are asked again.
- **Only notes proven to be the project's are shown.** They can tell you to run
  a command, so the check verifies them against the release's signed checksum
  list, with the release key your board already holds, before showing any. If
  that cannot be done (gpg missing, a signature that fails, a file echo with no
  signed list), the page says so and links the release notes instead, and the
  tick is for having read those.
- **After updating**, the notes the update brought stay on the Update page under
  the last update, and on the progress page, since several are instructions for
  afterwards. When the page you updated from did not collect them, the new
  release's updater fetches and verifies them itself, the same way, before it
  replaces any file; if it cannot, the update carries on and its warnings say to
  read the release notes.

Boards on 0.9.10a or earlier show nothing before updating, because the Update
page you see is the one from the release you are running. An update from 0.9.11a
or earlier into 0.9.11a showed nothing afterwards either; from the release after
0.9.11a on, the notes appear on the progress page and after updating whatever
you update from, and the panel before the button appears once you are running
0.9.11a or later.

---

## Withdrawn releases

A release found to be broken after it was published is withdrawn. It comes off
the channel's list of releases, so no board is offered it and the bootstrap will
not install it, including boards running releases from before withdrawal
existed. Its files stay published, and so do its release notes.

If the release you are **running** has been withdrawn, `/admin/update` says so at
the top, with the reason and, once there is one, the release that replaces it,
and the update check sends a notification saying the same (see below). When
the named replacement has itself been withdrawn since, you are pointed at the
newest release still listed rather than at one you would be refused. Until a replacement is published the advice is to stay where you are: the
withdrawn release is only as broken as the reason says, and moving back to an
older one is not something the updater does.

---

## Notifications

When the check finds something, every sysop gets a notification in the bell
menu, linking to `/admin/update`.

It will not tell you the same thing every morning. A repeat notification only
happens when the available version changes, or when a release that was blocked
becomes reachable because you ran the migration or upgraded Node. That second
case is the one worth waiting for, which is why the version alone is not the
whole test.

When upgrade notes apply to the move, the notification says how many, and how
many need attention before you update; they are read on the Update page.

Running a withdrawn release gets its own notification, sent even when nothing
newer is listed yet, and once for each release you run. When the replacement
is published later, that arrives as an ordinary "is available" notification.

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
