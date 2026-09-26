# QWK Networking

QWK networking moves echomail between boards in QWK packets. One board is the
**hub**: it holds the conferences and builds a packet of new messages for each
board that connects to it. The others are **nodes**: each collects its packet
from the hub (a `.qwk`) and sends back its own users' replies (a `.rep`).

Canectic can be either side, and both at once on different networks.

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

A Synchronet node on the same machine can still use
`src/external/synchronet/qnet-directory.js` to drop REPs into
`qnet/<NODE_ID>/in/`. Canectic does not yet build that node's packet for it
to collect, so for now use a node over HTTP, or link the two boards over FTN
instead.

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
- QWK private mail is not yet addressed to a particular connection. With more
  than one QWK connection, whichever one sends first carries all waiting QWK
  private mail.
