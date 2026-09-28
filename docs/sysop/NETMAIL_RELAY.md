# Netmail Relay

Whether your system carries netmail addressed to *other* nodes, rather than to
you. Sometimes called transit mail or routed netmail.

Setting: `netmail_relay_mode`, on `/admin/config` under **network**.

| Value | What it does |
| --- | --- |
| **Nodelist only** | Default. Carries a message only when the sender and the recipient are both listed in the same network's nodelist |
| **Off** | Refuses everything not addressed to you |
| **On** | Carries anything your system can route |

This page is about FTN netmail. `netmail_relay_mode` does not apply to QWK
netmail, which has its own setting per QWK network; see
[QWK netmail](#qwk-netmail) below.

## Which one you want

**Nodelist only** for almost everyone, including net and region coordinators.
It is safe to leave switched on, which is why it is the default: a message can
only pass if both ends are real, listed nodes of one network you carry. Routed
netmail works normally, including mail your nodes send outward and mail that
comes back down to them.

**Off** if you do not want to carry anyone else's mail at all. Points and nodes
with a single uplink that route for nobody lose nothing by this.

**On** only if you intend to be a general transit point and understand what
follows.

## Why "On" is stronger than it sounds

Your system finds routes by looking in the nodelist and, failing that, by
walking up to a node's hub, net host, regional coordinator or zone coordinator.
So it can find a way to very nearly anything.

That means **On** does not mean "carry mail for my links". It means carry mail
for the whole of every network you are in, in any direction, **including
between two of them**. If you carry both FidoNet and an othernet, a node on one
can reach any node on the other through you. Every individual link can be
perfectly trustworthy and the result is still an open relay.

Nodelist mode blocks exactly that: the two ends have to be listed in the *same*
network's nodelist, so mail cannot cross from one network you carry into
another.

## What nodelist mode checks

For every message not addressed to you:

1. The sender's zone and the recipient's zone must each belong to a network you
   hold an address in. A zone you have no address in is a network you do not
   carry, so there is nothing to carry mail within.
2. Both must be the **same** network.
3. Both must be present and active in that network's nodelist.

Points are checked as their boss node. `1:229/426.1` is looked up as
`1:229/426`, because points are not listed in nodelists and a point's mail is
its boss node's responsibility.

Note that step 3 is per network, not per net. A coordinator routes outbound
mail for their nodes, or lets the echo hub do it, so anything restricted to
your own net would break normal operation immediately. FidoNet also spans zones
1 to 6, so a zone restriction would refuse ordinary traffic.

## If you import no nodelist

**No nodelist for a network means no relay for that network.** Every transit
message for it is refused as "not in the nodelist", written to `ftn/bad`, and
raised as a sysop notification.

That is the correct failure direction but it looks like a fault, so check
`/admin/nodelists` before concluding relay is broken. If you carry a network
that does not distribute a nodelist, your options are to leave relay off for
practical purposes, or set the mode to **On** and accept what that means.

## What this does not protect against

It does not verify that a message came from who it says. FTN has no way to do
that: the origin address is whatever the packet claims, and there is no
signature to check it against. Session and packet passwords authenticate the
**link that handed you the packet**, not the **node that wrote the message**.

So nodelist mode stops your system being used to reach arbitrary networks and
non-existent nodes. It does not stop one of your own links handing you mail
with a forged origin. Real sender authentication needs a network whose nodelist
can carry public keys.

There is also no rate limiting and no per-peer policy.

## Reading refusals

A refused message is written to `ftn/bad` and raises a sysop notification
naming the rule that refused it and the address it could not find, for example:

```
Relay is set to nodelist only and this message did not qualify:
recipient 21:1/200 is not in the nodelist.
```

## Upgrading from `allow_netmail_relay`

The old `allow_netmail_relay` boolean is deprecated and ignored. Every system
lands on **nodelist only** regardless of what it was set to.

It could not be carried across. Default values are written into the settings
table on first run, so a sysop who deliberately set it `false` is
indistinguishable from one who never opened the page. Relay also did not work
correctly before this release, since transit messages went out with the sender
and the sending system swapped in the headers, so there is no working
configuration being replaced.

If you were deliberately running an open relay, set the mode to **On** again.

## Seeing what was relayed

Every relay decision writes one row to `netmail_relay_log`, whatever the decision was. Refusals are recorded alongside relays on purpose: a gate you cannot see refusing anything is a gate you cannot validate.

The admin page is at **Networking > Netmail Relay Log** (`/admin/relay-log`). It leads with anything relayed and not sent, then a summary by decision, then every decision with a detail view per row showing the Via chain as it arrived, the AKA you stamped, and the route taken. Filter by decision, and change the window with the selector.

The same thing from the command line:

```bash
node src/tools/relayLog.js                     # summary, plus anything stuck
node src/tools/relayLog.js --list 50           # the last 50 decisions
node src/tools/relayLog.js --decision refused  # only refusals
node src/tools/relayLog.js --stuck 6           # relayed but not sent after 6h
node src/tools/relayLog.js --sources           # who is sending you transit mail
node src/tools/relayLog.js --msgid <MSGID>     # everything about one message
```

Each row records who wrote the message and, separately, who handed you the packet. On mail a node originated those are the same; on transit they are not, and keeping both is the only way to see which of your links is actually feeding you transit traffic. It also keeps the Via chain as it arrived, the AKA you stamped, the next hop and how the route resolved, and the relay mode in effect at the time.

### The check worth running

```bash
node src/tools/relayLog.js --stuck
```

Relayed but never sent is the failure nothing else surfaces. Accepting a message for relay and queueing it looks like success at every other point, and a message then sitting unsent in `pm_outbox` produces no further event at all. Anything listed here was accepted and has not gone; start with whether the next hop is being polled (`node src/tools/schedules.js`).

QWK netmail decisions are in the same log, with relay mode `qwk`.

Rows are kept for `netmail_relay_log_retention_days`, default 180. That is longer than the other logs because relay disputes surface slowly: a downlink usually notices missing mail weeks after the fact.

## QWK netmail

QWK netmail that other systems send through yours is relayed under a separate
rule. Each QWK network has a **Relay QWK netmail between systems on this
network** setting (Networking > Networks, edit the network), on by default.
While it is on, the board passes QWK netmail on within the network it arrived
on, never from one network to another, by a direct link, a spelled-out path or
a route learned from the mail that arrives. Mail that cannot be passed on (no
route, relaying off, or a loop) goes back to its sender with the subject
`BADADDR:` and the reason, as Synchronet does. Nothing is written to `ftn/bad`
for QWK.

Every QWK decision is a row in the Netmail Relay Log with relay mode `qwk`,
alongside the FTN ones. See `QWK_NETWORKING.md` for the rest.
