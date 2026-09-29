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

## Visiting another Canectic board's doors

1. Register your board on theirs (their Door Server page, or ask their sysop) to get a System ID and secret.
2. In Admin > Doors > Door Server, under **Remote door servers**, add it: a short name (used in menu entries), a title your callers see, their address (`wss://their.board/ws/doorserver`), your System ID and secret. **Test** checks the connection and lists their doors. The secret is kept but never shown again; leave it blank when editing to keep it.
3. Add a menu entry with the command **Remote Door Server** and the remote's name. Callers get that board's door list; `name:door` sends them straight to one door. They return to your menu when the door ends.

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
