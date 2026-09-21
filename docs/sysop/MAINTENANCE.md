# Maintenance mode

Maintenance mode closes the board to everyone but you, for anything that needs
it to itself: an update, a message base import, work on areas, or database work
by hand. It gives the people who are on the board notice, lets the network work
already in progress finish, and tells you when the board has gone quiet, so you
start once it is safe rather than hoping nobody posts halfway through.

Updates use it automatically. You can also switch it on yourself at any time.

---

## What closing the board does

| Who or what | New arrivals | Already there |
|-------------|--------------|---------------|
| Terminal callers | Told the board is closed, with your reason and when it expects to be back, and disconnected before they reach the login prompt. Sysops included: use the web admin while the board is closed. | Shown a countdown on the bottom line of their screen, reminded a minute and fifteen seconds before the end, then disconnected when the grace runs out. A caller in a door is disconnected too. |
| Web visitors who are not logged in | Shown the maintenance page, with your reason and when the board expects to be back. It checks again every minute. | (the same) |
| Logged-in web users | A login by anyone but a sysop is refused. | Sent a notification and a countdown banner on every page they have open. Anything they post before the countdown ends is kept. When it ends, every page except the admin shows them the maintenance page. The board does not wait for them. |
| Sysops on the web | Can log in. | Keep the whole site, so you can check things before reopening. The admin pages show a banner while the board is closed. |
| Mail clients (IMAP, SMTP) | Refused in the protocol's own terms: IMAP says `BYE`, SMTP says `421`, so a sending mail server keeps the message and tries again later. No internet mail is lost. | Closed when the grace runs out. |
| binkp links | Answered with `M_BSY`, which a remote mailer treats as "try later". No outbound calls are made; outbound mail waits in the outbound until you reopen. | Left to finish. Each session has its own time limit. |
| The worker | Stops taking new jobs. Tosses and maintenance jobs queue up and run when you reopen. | Jobs already running finish. |
| The REST API | Answered with a `503` and a JSON body saying why. | |

The **grace** is how long callers and logged-in web users get between the board
starting to close and it closing to them. It is `maintenance_grace_seconds`
(five minutes unless you change it), and you can set a different one each time.
A grace of 0 closes the board at once, which is the one to use in an emergency.

## Closing and reopening from the web

**Admin > Maintenance** (also on the dashboard's System tab).

To close the board, give a reason, how many minutes you expect it to take, and
a grace, then **Close the board**. The reason and the expected time are what
callers and visitors are shown. Both are optional, but a visitor told "back
around 3:15" waits; one told nothing wanders off.

While the board is closed the page shows:

- when the grace ends, counting down
- a **Drain** table: what each process still has in flight, updating every few
  seconds. When it says **Drained: nothing in flight**, the board is quiet and
  it is safe to start
- a form to change the reason or the expected time. The grace keeps running
  from when you first closed the board, so correcting a typo does not hand
  everybody a fresh countdown
- **Reopen the board**

## Closing and reopening from a shell

From the install directory:

```bash
node src/tools/maintenanceMode.js --status
node src/tools/maintenanceMode.js --on --reason "Rebuilding the file areas" --minutes 30
node src/tools/maintenanceMode.js --on --reason "Emergency" --grace 0
node src/tools/maintenanceMode.js --off
```

`--wait` holds until the board has drained, so a script can do its work only
once it is quiet:

```bash
node src/tools/maintenanceMode.js --on --reason "Database work" --wait \
  && pg_dump canectic_bbs > before.sql
```

Exit codes for `--wait`: 0 drained, 2 timed out (`--timeout SECONDS`), 3 no
process is reporting, 4 somebody reopened the board while it waited.

The tool needs nothing but Node: not the database, not the gateway, not the
installed packages. It is the one to reach for when the gateway will not start.

## The flag is a file

Maintenance mode is a file called `.maintenance` in the install directory, not a
setting, because the times you most want it are the times the database may be
the thing being worked on. Its presence closes the board; its contents are the
reason, times and who set it. Deleting it reopens the board, and
`touch .maintenance` closes it with the default grace.

Each process checks for it every couple of seconds, so closing or reopening
takes effect within that time. While it is set, each process writes what it
still has in flight to `tmp/maintenance/`, which is what the Drain table and
`--wait` read. A process that stops writing is taken to have stopped, and a
stopped process has nothing in flight.

## During an update

An update closes the board as soon as it starts, so the grace runs while the
backup is taken rather than after it. Before stopping the BBS it waits for the
board to drain: callers disconnected when the grace runs out, binkp sessions and
queue jobs finished. It waits at most the rest of the grace plus
`update_drain_timeout` (fifteen minutes unless you change it); anything still
running after that is ended by the stop, and a job ended that way is retried
when the board starts again.

While the BBS itself is stopped, the update answers on the board's web port in
its place: visitors keep seeing the maintenance page, and sysops who were logged
in when the update started see its progress. See "Updating from the web" in
[UPDATING.md](UPDATING.md).

The BBS comes back up still closed, and the update reopens it only once it has
checked every file it wrote. So:

- **The update succeeds:** the board reopens by itself.
- **It fails before stopping anything:** nothing changed, so the board reopens.
- **It fails at or after the stop:** the board stays closed, on purpose. A
  failed update is when you should decide whether the board is fit to open.
  Check the Update page, then reopen from the Maintenance page.

If you had closed the board yourself before starting the update, the update puts
your closure back afterwards rather than reopening a board you closed on
purpose.

**The first update into this release cannot drain.** The processes it is
replacing predate maintenance mode and never report, so the update notices that
after about twenty seconds and carries on as updates always have, stopping the
BBS without warning anyone. Updates after that one drain properly.

## Troubleshooting

**The Drain table says "No process has reported yet."** Either nothing is
running, or what is running predates maintenance mode. `pm2 status` tells you
which.

**It has said "Draining" for a long time.** The table names what is left. A
terminal caller or mail client is disconnected when the grace runs out, so if
the grace has passed it is a binkp session or a job. A binkp session ends on
its own time limit; a job that never finishes is the stuck-worker case, and
`node src/tools/schedules.js` shows how long it has been running.

**The board reopened by itself.** An update that completes reopens the board
it closed. If you had closed it yourself first, check the Maintenance page: the
update puts your closure back, so if the board is open, the flag file was
removed.

**Callers are refused but the page says the board is open.** The board is open
to everyone again within a couple of seconds of reopening. If it stays that
way, check for a `.maintenance` file in the install directory.
