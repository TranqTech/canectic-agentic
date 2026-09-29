# Door Server

The door server lets other BBSes send their callers to door games you run, and lets your callers visit door games on another Canectic board. Everything is off until you switch it on.

## Offering your doors to other BBSes

1. **Choose the doors, by collection.** In Admin > Doors > Door Collections, set a collection's **Shown to** to **Door server** (only BBSes connecting to your door server see it) or **Both** (your callers and theirs). When you change an existing collection, you are shown its doors, all ticked, and choose which to offer before the change takes effect. On the collection's page each door has an **Offered** button to switch it on or off, and a door you add to such a collection is offered straight away. A door that is not offered in any collection shown to the door server can never be reached from outside, whatever a remote BBS asks for.
   - A collection shown to the door server only is hidden from your own callers; a door in it still shows to them through any other collection it is in.
   - A remote BBS's caller who does not name a door gets a menu of your offered collections, then the doors in the one they pick (straight to the doors if you offer one collection).
   - A door that runs on another system (a remote door) is never offered through your door server.
2. **Switch it on.** On the Configuration page, under Doors, turn on `doorserver_enabled`. Until then every door-server connection is refused.
3. **Register the BBSes that may connect.** Either:
   - **Add them yourself** in Admin > Doors > Door Server with **Add BBS**. Give it a System ID (2 to 12 letters, digits, `_` or `-`, such as `UNDERMINE`) and its details. It is approved at once, and you are shown its **secret** once: send that to the other sysop. If it is lost, use **New secret**; the old one stops working at once.
   - **Or let your users register their own BBS.** Any verified user can: their security level must reach `doorserver_register_security`, which left blank is the level verifying an address gives (`verified_security`, 60 by default), and they must not still be marked Unverified. They find a link on the Doors page to the Door Server page, register their BBS there and are shown its secret once. The registration stays tied to their account, and they can update its details or make a new secret themselves.
   - **Approval.** You get a notification of each registration, and it waits for you to **Approve** or **Reject** it; the user is notified of your decision. Users you trust can skip that: a registration is approved at once when the user's security reaches `doorserver_auto_approve_security`, or when they hold any permission flag listed in `doorserver_auto_approve_flags` (add one such as `Trusted` to `custom_permission_flags` and give it to the users you choose). Leave both blank to review every registration; set the level to the registration level to approve them all.
4. **Limits.** Each BBS may have `doorserver_max_concurrent` callers on at once (5 by default; change it per BBS with Edit). **Suspend** stops a BBS connecting until you approve it again.

A remote caller appears on your board as `<prefix>_<their name>` (the prefix is the System ID unless you set another), with the security level `doorserver_security` in the door's drop file. Door-server callers are listed in your caller log with their BBS's name. A failed door-server login is written to `security.log` in the form the fail2ban filter in `examples/fail2ban/` matches.

## Connecting another BBS to your door server

**Another Canectic board** adds yours as a remote door server (next section).

**Other BBS software** uses `doorclient.js`, a single file that needs only Node 22 or later. Their sysop downloads it from your Door Server page (it is also `bin/doorclient.js` in your install) and sets it up as a standard-I/O door, passing the drop file their BBS writes:

```
node doorclient.js --server wss://your.board/ws/doorserver \
  --system THEIRID --secret-file /path/to/secret \
  --dropfile /path/to/DOOR32.SYS
```

It reads the caller's name from DOOR32.SYS or DOOR.SYS. Without `--door SLUG` the caller picks from your list; `--encoding utf8` is for a UTF-8 terminal; `--list` prints the doors on offer and exits.

**RLogin**, for software that can open RLogin connections but cannot run the client: turn on `doorserver_rlogin_enabled` and restart the gateway. It listens on `doorserver_rlogin_port` (5513; the traditional 513 needs the board to run as root). The RLogin user name is `THEIRID:username`, the password is the secret, and the terminal type names a door, or is a terminal type such as `ansi` for the list. The same approval, limits and door settings apply. RLogin sends the secret unencrypted, so prefer the WebSocket client where you can.

## Doors on other systems

Your callers can play doors that run somewhere else: on another Canectic board's door server, on DoorParty, on BBSLink, or on any RLogin door server such as a Synchronet game server. In Admin > Doors > Door Server, under **Doors on other systems**, add a **door provider** with the button for its kind, then add its doors on the provider's page. Each door becomes an ordinary door entry (launch type **Remote**): put it in a collection your callers see, or in a menu with the Door command and its slug, exactly like a door of your own. A door on another system is never offered through your own door server.

- **A Canectic board.** Register your board on theirs (their Door Server page, or ask their sysop) to get a System ID and secret, and enter their address (`wss://their.board/ws/doorserver`) with those. **Fetch their door list** shows what they offer; tick the doors you want and they are added, optionally straight into a collection.
- **DoorParty.** Apply on Throwback BBS (`telnet bbs.throwbackbbs.com`, "apply for DoorParty") for a system tag and an SSH username and password. The DoorParty button fills in their servers; enter the tag (without brackets) and the SSH details. Canectic opens the SSH tunnel itself; you do not need their connector program. Add doors by their DoorParty door codes (their wiki lists them, for example `lord`, `tw2002`, `bre`); a door with no code opens DoorParty's own menu.
- **BBSLink.** Apply at bbslink.net for a system code, authorisation code and scheme code, and enter them. Add doors by their BBSLink codes (for example `lord`, `tw`, `bre`); the code `menu` lists every game.
- **Another RLogin server** (a Synchronet game server, or anything else that speaks RLogin): enter its host and port. The username sent is the template with `{alias}` (the caller's name) and `{tag}` filled in, and the door code goes in the terminal type through its template (`xtrn={door}` for Synchronet).

### Door lists

Each provider can keep a list of the doors it offers, which you tick doors from instead of typing codes. On a BBSLink or DoorParty provider's page, the Doors card offers **Load the BBSLink list** (or DoorParty) straight away; on another Canectic board's, **Load the doors it offers**. Loading chooses that list and fills it in. To use another source, choose it under **Door list** in the provider's settings:

- **A list shipped with Canectic.** DoorParty and BBSLink lists come with Canectic (in `config/doorlists/`) and are updated with each release; the DoorParty and BBSLink buttons choose them for you.
- **A file in a file area**: the newest file whose name matches the pattern you give (`*` and `?` allowed, for example `DPLIST*.ZIP`), either a list file or an archive holding one. This is how a list can reach you by file echo.
- **Their own list**, for another Canectic board, which sends it over the connection.

Once a list is loaded, **Check for changes** shows what a newer list would change (new doors, renamed ones, doors no longer offered) before you **Apply** it. The list appears on the page with a filter; tick doors and **Add the ticked doors**, optionally straight into a collection. A door you have added shows **Remove** in the list, and under **Door entries** each door can be switched off or on, or removed. Tick **Check every day** and the board checks the list each morning and applies it, sending you a notification of what changed. A door that leaves the list is kept in it, marked "no longer offered", and any door entry for it is made inactive so callers stop seeing it; nothing is deleted. The daily check refuses a list that would remove more than half the doors, or an empty one, and tells you instead, since that is far more likely a damaged file than half a network's doors vanishing overnight. Canectic never reads anyone's web pages for a list: a page changes without notice, and what it then yields is wrong.

A list file is JSON:

```
{ "format": "canectic-doorlist-v1", "list": "mylist", "title": "My doors", "updated": "2026-09-29",
  "doors": [ { "code": "lord", "name": "Legend of the Red Dragon", "category": "RPG" } ] }
```

or plain text, one door per line: the code, then spaces, then the name, optionally a tab and a category. Lines starting with `#` are comments.

A few things worth knowing:

- **Who can use them.** Only callers who are logged in, at the provider's **Minimum security** (blank means the verified level, `verified_security`), so guests and unverified callers are kept out, as DoorParty asks.
- **Each caller's password.** For an RLogin provider set to "One per caller", Canectic makes each caller a password the first time they visit and always sends the same one. DoorParty and Synchronet create the player's account on that first visit and tie it to the password. The name sent is the caller's current name, so a caller who changes their username starts again there as a new player, unless you tick **Keep sending the name a caller first used**. BBSLink knows players by their user number on your board, which never changes.
- **The SSH host key.** The first connection through SSH records the server's key, and a different key is refused after that, so nobody can pose as the server. If the server really did change its key, use **Forget the SSH host key** on the provider page.
- **Character sets.** DoorParty, BBSLink and RLogin servers send CP437; a caller with a UTF-8 terminal sees it converted, as with your own DOS doors.
- A menu entry with the command **Remote Door Server** and a provider's name (or `name:door`) still works too.

## Settings

| Setting | Default | |
|---|---|---|
| `doorserver_enabled` | off | accept door-server connections |
| `doorserver_register_security` | blank | lowest security level that may register a BBS; blank means `verified_security` |
| `doorserver_auto_approve_security` | blank | registrations by users at or above this level are approved at once |
| `doorserver_auto_approve_flags` | blank | registrations by users holding any of these flags are approved at once |
| `doorserver_max_concurrent` | 5 | callers per BBS at once (per BBS in its settings) |
| `doorserver_security` | 50 | security level remote callers carry in drop files |
| `doorserver_rlogin_enabled` | off | RLogin access (restart to apply) |
| `doorserver_rlogin_port` | 5513 | RLogin port (restart to apply) |

The protocol and design are in `docs/reference/DOORSERVER_DESIGN.md`.
