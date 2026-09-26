# QWK Networking

QWK networking moves echomail between boards in QWK packets. One board is the
**hub**: it holds the conferences and builds a packet of new messages for each
board that connects to it. The others are **nodes**: each collects its packet
from the hub (a `.qwk`) and sends back its own users' replies (a `.rep`).

Canectic can be either side, and both at once on different networks.

## QWK IDs

Every system on a QWK network has a QWK ID: yours is the address you give the
network under Networking > Networks, and each connection names the other
system's as its **Remote QWK ID**. Canectic holds them to the same rules as
Synchronet:

- Up to 8 characters, stored in upper case.
- None of these characters: a space, and `\ / | < > * ? + [ ] : = " ; ,`.
- An ID that starts with a digit, or contains `.` or `@`, is accepted with a
  warning: netmail cannot be addressed to it, because Synchronet reads
  `user@1...` as a FidoNet address and a dot as an internet one.
- **Each ID can be used once as your hub and once as your node.** A hub builds
  one packet per node, so two connections to the same hub would fight over
  it. One system can be both your hub and your node, as two connections.

A save that breaks a rule is refused, with the reason shown at the top of the
page. IDs saved before these rules existed keep working; if any break them, the
board sends a notification listing them when it starts, and each will need
fixing the next time its connection or address is saved.

### IDs longer than 8 characters

Tick **Allow QWK IDs longer than 8 characters** on a QWK network (edit the
network) to allow up to 32, for your own ID and every connection on that
network. Only do this on a network where every system accepts long IDs.
Synchronet and most QWK software stop at 8, and netmail to a longer ID cannot
pass through them. The setting cannot be turned off while a long ID is still
in use on the network; the refusal lists them.

## Being a node of another system

Add a QWK connection to the hub's peer (Networking > Peers, the peer, Add
Connection) and pick the transport the hub offers:

| Transport | Use it for |
|-----------|------------|
| **FTP** / **SFTP** | A hub that serves QWK packets over FTP or SFTP, such as a Synchronet hub. |
| **HTTP (Canectic hub)** | A hub running Canectic. |
| **Directory** | A hub on the same machine, or a directory both systems can see. |

**Remote QWK ID** is the hub's QWK ID. Then:

- **FTP / SFTP:** the hub's host and port, the login the hub's sysop gave
  you, and the paths the hub keeps packets in (often `/`).
- **HTTP:** **Host** is the hub's web address, such as
  `https://bbs.example.com` (put a port in the address if it needs one).
  **Username** is your QWK ID on the hub, and **Password** is the password
  the hub's sysop set for you. The port and path fields are not used.

Turn on **Polling** and set the interval to have the board collect and send
on its own. The pull and push buttons on the connection do it once.

## Being a hub for a Canectic node

Add a QWK connection for the node with the transport **Hub (Inbound)**.
**Remote QWK ID** is the node's QWK ID, and **Node password** is the password
the node will log in with. Give the node's sysop:

- your board's web address, as their **Host**;
- their QWK ID, as their **Username**;
- the password you set.

Subscribe the connection to the conferences the node should carry, as for any
peer. Polling stays off: the node calls you.

A hub connection with no password cannot be used over HTTP. Every QWK packet
carries the node's QWK ID, so the ID on its own proves nothing.

### What happens when a node calls

1. It logs in. A wrong password is refused and logged to `security.log` as a
   failed login, which the fail2ban filter in `examples/fail2ban/` already
   picks up.
2. It sends its REP, if it has one. The REP is saved and queued for import,
   so the worker must be running for the messages to appear.
3. It asks for its packet. The packet holds new messages in the conferences
   it is subscribed to, and any QWK private mail waiting.
4. Once the packet is safely stored on the node, the node confirms receipt.
   Only then are those messages counted as delivered. If the download fails
   part way, or the node never confirms, the next call gets the same packet
   again, so nothing is lost.

Setting **qnet_max_rep_bytes** (QWK settings, 20 MB by default) limits how
large a REP a node may send.

Run the board behind HTTPS (a reverse proxy) if nodes connect over the
internet, since the node's password is sent with every request.

### Nodes that use a shared directory

A Synchronet node on the same machine, or one that can see a directory of
yours, can exchange packets through `qnet/<NODE_ID>/` instead of calling over
HTTP. Copy `src/external/synchronet/qnet-directory.js` to the node's `exec/`
directory and set its call-out command for your hub to:

    ?qnet-directory <YOUR_QWK_ID> /path/to/canectic/qnet/<NODE_ID>

On your side, tick **Node collects from a shared directory** on the node's
Hub (Inbound) connection. It needs no password. Every
**qwk_hub_sweep_minutes** (QWK settings, 5 by default) the board then:

1. imports any REP the node has left in `qnet/<NODE_ID>/in/`;
2. builds the node's packet into `qnet/<NODE_ID>/out/`, named after your QWK
   ID, if there are new messages or private mail for it.

The node copies the packet away when it calls and deletes it from `out/`.
That is how the board knows the node has it: the messages in it are counted
as delivered at the next sweep, and a new packet is built. Until then the
same packet waits there, so a node that does not call for a while loses
nothing. Do not delete a packet from `out/` by hand unless you mean the node
to go without it, since the board takes a missing packet as collected. The
small `.qwk.json` file beside it records what the packet holds.

The sweep runs only while at least one node is set to collect from a shared
directory.

## Seeing what happened

Networking > **QWK and NNTP Transfers** lists every pull and push, with what
came of each: mail received, nothing waiting, a timeout, a refused login and
so on. It also shows when each connection last actually brought in mail, since
a link can succeed every time and still bring nothing. On a hub, packets
served to a node and REPs a node sent show there too, with the node's
address. Each connection on a peer's page shows its own recent transfers.

## Troubleshooting

- **Timeout at connect, or "no connect"** on an FTP connection: nothing is
  answering at that address and port. If the other board has moved to
  Canectic, switch the connection to HTTP.
- **Auth** on an HTTP connection: the username (your QWK ID) or password
  does not match the hub's connection for you.
- **HTTP 404 at connect:** the address is not a Canectic board, or it runs a
  release from before QWK over HTTP.
- **A node gets the same messages twice:** it collected a packet but its
  confirmation did not arrive, so the hub offered the packet again. Duplicate
  checking drops the repeats.
- **A QWK private message came back as undeliverable:** no active QWK
  connection has the QWK ID it was addressed to. Private mail goes only to
  the system named in its address, over the connection whose Remote QWK ID
  matches (a reply goes back over the connection the original came in on).
  Mail for a system you do not link with directly is not passed on through
  a hub.
