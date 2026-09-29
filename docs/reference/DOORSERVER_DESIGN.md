# Door Server Design

Lets other BBSes send their callers to doors hosted here, and lets this board send its callers to doors hosted on another Canectic board. Tracked in #86 (which absorbs #9).

**Status: built (#86), all five phases; sysop guide `docs/sysop/DOORSERVER.md`.** Decisions made 2026-09-29, recorded below. Build order: A security, B server, C shipped client, D Canectic as a client, E RLogin. This header is updated as each phase lands.

- **A, done:** stub login refuses every system; `doorserver_enabled` (off) refuses every connection before auth; `doors.doorserver_available` (default false) checked by `doors.mayLaunchDoor` in `CallManager.launchDoor`; failed logins to `security.log`; stale `bin/doorserver.js` deleted.
- **B, done:** `doorserver_systems` + `src/models/doorserver.js` (create by sysop or user, pending/approved/suspended/rejected, bcrypt secret shown once, `verifyLogin`, `recordSession`); `src/handlers/doorauthhandler.js` speaks `canectic-doorserver/1` (string-aware `takeFrames`, auth, list, door or a later `launch` frame, per-system concurrency from the pool's live calls, caller identity and `doorserver_security`, caller log source `Doorserver`); admin page `/admin/doorserver` (Doors menu); user page `/doorserver` (router `src/routes/doorserver.js`) for users at `doorserver_register_security`, linked from `/doors`; "Available to Door Server" in the door editor. Checked live on the dev board: list, wrong secret (logged), unflagged door refused, launch by name and by launch frame, concurrency refusal; and in headless Chromium: admin add, user registration pending, approval notifying the owner.
- **C, done:** `bin/doorclient.js` (pure parts `parseArgs`, `readDropfile`, `problems`, `takeJsonLines`; `run(opts, io)`), offered to eligible users as a download at `/doorserver/doorclient.js` with a command line filled in. Tested against a stub `ws` server and live against the dev gateway (list, door by name, numbered menu).
- **D, done:** `src/utils/doorserverClient.js` (`openSession`, `listDoors`), `doorserver_remotes` + `src/models/doorserverRemotes.js` (secret stored as given, never shown back; blank on update keeps it), `src/handlers/remotedoorrunner.js` adopted by `CallManager.launchRemoteDoor(arg, fromMenu)` like a local door (numbered menu when no door is named, door inactivity without the warning text, "press any key" then `_doorReturn`), menu command `remoteDoor` (editor suggests remote names), admin section "Remote door servers" on `/admin/doorserver` with Test (door list). Checked live as a loopback on the dev board: admin Test listed the door, and the runner took a caller through the menu into it.
- **#89 collections, done:** what the door server offers moved from the per-door flag to collections (below).
- **#89 remote doors, done:** door providers of three kinds and Remote door entries (section "Doors on other systems" below). Tested against in-process RLogin, SSH (ssh2 Server) and telnet servers and through `IncomingCall.launchDoor`; not yet against the real DoorParty or BBSLink, which need approved credentials. Next in #89: distributed door lists with optional file/echo updates.
- **E, done:** `src/servers/rloginserver.js`, started by the gateway only with `doorserver_rlogin_enabled` (restart). The connection becomes an ordinary Doorserver-pool call and its wrapper speaks the JSON protocol for the RLogin client (auth frame from the handshake, numbered menu into a launch frame), so every rule of the WebSocket path applies. Default port 5513, not 513: ports below 1024 need root. Checked live: list and choose, door slug, wrong secret refused.

## Why this was rewritten

The first design (self-registration on a public page, username and password, WebSocket only) was never built. What existed was a pool, `/ws/doorserver` (pool and flow `Doorserver`: `door_auth -> door_launch -> goodbye`), whose auth was a stub: `src/models/doorserver.js` `getClientBBS()` returned one hardcoded test BBS for ANY system id with the token `12345654`, published in the repo, and `CallManager.launchDoor()` launched any door named in the auth frame with no check at all. Confirmed on the dev board 2026-09-28: every board running it, the hub included, let anyone reaching the web port launch any configured door. Phase A closes that before anything else.

## Decisions (2026-09-29)

- **WebSocket is the primary transport, with a shipped client program.** WebSocket over the board's own HTTPS port lets the client send structured details (who the caller is, terminal size and encoding, which door) in one authenticated frame, and keeps the secret off any plaintext protocol. RLogin is supported for software that can only speak it, **off by default**.
- **Registration is by the sysop, or by this board's own verified users.** No public form. The sysop can add a system by hand in admin. A verified user (the verified security level by default, never one still marked Unverified) can register their BBS and keep its details current; the registration is tied to their account, which is the contact. It waits for the sysop's approval unless the user reaches an auto-approve security level or holds an auto-approve flag, so long-standing or trusted users skip review (decided 2026-09-29, replacing an on/off auto-approve).
- **Canectic is also a client.** A board can add a remote Canectic door server (address, system id, secret) and give its callers a menu command that connects them to a door there.

## Access control

- **By collection (#89):** `door_collections.audience` is `local` (this board's callers, the default), `doorserver` or `both`, and in a collection the door server sees each `door_collection_entries.doorserver` says whether that door is offered. A door-server session may launch only a door ticked in at least one active collection shown to the door server (`doorCollections.isDoorOffered`, which `doors.getDoorConfig` puts in `doorserverAvailable` for `doors.mayLaunchDoor`), enforced in `CallManager.launchDoor` for every door-server path, whatever the client asks for. A door of launch type `Remote` (a door on another system) is never offered (`NEVER_OFFERED_TYPES`): it would be passed on under our credentials and could loop.
  - A door added to a collection the door server sees is offered at once; a duplicated door is not. Changing a collection to include the door server does not take effect until the sysop confirms which of its doors are offered (`/admin/doorCollections/:id/audience`, all ticked); narrowing needs no confirmation.
  - A `doorserver` collection is hidden from local callers (`getLocalCollections`; the web collection page refuses it), and a door only in such collections is left out of the flat door list shown when a board has no local collections (`doorIdsHiddenLocally`). A door in any local collection still shows. Local callers can still launch any door their menus name: hidden is not forbidden.
  - `doors.doorserver_available`, the per-door setting 0.9.13a shipped, is no longer read or written; migration `0011-doorserver-collections` carried it over (ticks the door's entries, widens a `local` collection holding one to `both`, puts an uncollected one in a new `doorserver` collection "Door Server"). A later release drops the column.
- **Per system:** status must be `approved`; `max_concurrent` sessions at once.
- **Global:** `doorserver_enabled` (default false). Off, the pool refuses every connection.
- **Failed logins** are written to `security.log` through `authFailLog.logAuthFail` (`via door server`), which the shipped fail2ban filter matches.

## Doors on other systems (#89)

**Providers** are rows of `doorserver_remotes` (`src/models/doorserverRemotes.js`) with a `kind`:

| kind | settings (JSONB) | secrets (JSONB, never shown back; blank on update keeps) |
|---|---|---|
| `canectic` | `url`, `system_id` (columns) | `secret` (column) |
| `rlogin` | `host`, `port`, `ssh`, `ssh_host`, `ssh_port`, `ssh_user`, `username_template` (`{alias}`, `{tag}`), `tag`, `password_mode` (`per_user`/`fixed`), `terminal_template` (`{door}`), `menu_terminal`, `keep_first_name` | `ssh_password`, `password` (fixed) |
| `bbslink` | `system_code`, `host`, `http_base`, `telnet_port` | `auth_code`, `scheme_code` |

plus `min_security` (null = `verified_security`) and `host_key` (SSH, `SHA256:...`, recorded on first connect by `rloginClient`'s host verifier, refused when different, cleared by the provider page's Forget button). `PRESETS` (doorparty, synchronet, bbslink) only fill the new-provider form. Admin: the Door Server page lists providers and has an Add button per kind/preset; each provider has a page `/admin/doorserver/remotes/:uuid` (settings, its doors, add a door by code, Canectic Fetch list with tick-to-add into a collection). A provider with doors cannot be deleted.

**Remote door entries** are `doors` rows with `launch_type = 'Remote'`, `remote_provider` (provider name) and `remote_door` (code, blank = the provider's menu). `doors.createRemoteDoor` slugs them `<provider>-<code>`. They appear wherever doors do. `IncomingCall.launchDoor` hands them to `_launchRemote(name, door, fromMenu, label)`, which the `remoteDoor` menu command also uses; it refuses an inactive provider and anything `mayUseRemote` refuses (a door-server session; a caller with no `user_record`; security below the provider's minimum). `NEVER_OFFERED_TYPES` keeps them out of the door server.

**Sessions** (`src/utils/doorProviders.js` `openProviderSession`) share one event interface for `RemoteDoorRunner`: `auth_ok(doors, collections)` (Canectic only, drives the menu), `launch_ok`, `data`, `auth_fail`/`error`/`error_frame`, `close`; `send`, `launch`, `close`; `cp437: true` for RLogin and BBSLink, whose output the runner converts with `DoorOutputParser` for a UTF-8 caller.

- **RLogin** (`src/utils/rloginClient.js`): `\0<client-user>\0<server-user>\0<terminal>\0`, server acknowledges `\0` (not passed on). client-user is the caller's password from `identityFor` (`door_remote_identities`: one row per provider and user, oldest wins, random 12-character password made once and never changed, `remote_name` first used) or the fixed secret; server-user is the template; terminal is the door code through `terminal_template`, or `menu_terminal`. Through SSH (`ssh2` Client, a direct dependency since #89; it was already present through ssh2-sftp-client, native cpu-features skipped by allowScripts): password login, `forwardOut` to the RLogin host/port, RLogin inside. DoorParty's servers: SSH `dp.throwbackbbs.com:2022`, RLogin `dp.throwbackbbs.com:513` inside the tunnel, username `[TAG]alias`, door code as terminal type.
- **BBSLink** (`src/utils/bbslinkClient.js`, reimplemented from their connector scripts, which ask not to be redistributed): random 6-character `xkey`; `GET <http_base>/token.php?key=xkey`; `GET auth.php?key=xkey` with `X-User` (users.id), `X-System`, `X-Auth`=md5(auth code+token), `X-Code`=md5(scheme code+token), `X-Rows`, `X-Key`, `X-Door` (lower case), `X-Token`, `X-Type: Canectic`, `X-Version`; body `complete` means go, anything else is the reason shown; then telnet to `host:telnet_port`. Minimal telnet (`createTelnet`): DO ECHO/SGA/BINARY to the server's WILL, WILL TTYPE (IS "ANSI") and NAWS (our size) to its DO, refuse the rest; IAC sequences stripped, IAC IAC read as 0xFF, 0xFF in input doubled.

Accepted risk (decided 2026-09-29): a caller who renames starts over on DoorParty unless the provider keeps the first name.

**Door lists (#89 part 3)**, `src/models/remoteDoorCatalog.js`, table `remote_door_catalog` (remote_id, code, name, category, description, first_seen, last_seen, removed_at, active). Provider `settings.list_source`: `shipped` (`config/doorlists/<list_name>.json`, data category so a release updates an unedited copy), `file` (newest `file_entries` row in `list_area` whose filename matches the `list_file` glob; `.json`/`.txt`, or a `.zip` unpacked with `unzip -j` and its first `.json`/`.txt` read), `remote` (Canectic only, `doorserverClient.listDoors`), `none`; `list_auto` for the daily `check-door-lists` maintenance job (04:45, `checkAll`). NEVER fetched from third-party web pages (decided 2026-09-29): the shipped DoorParty (170) and BBSLink (36, `test` left out) lists were read by hand from their published pages on 2026-09-29 and are refreshed the same way for a release. Format `canectic-doorlist-v1` JSON, or text lines `code name[\tcategory]`; `parseDoorList` reports every problem and skips bad codes (`[A-Za-z0-9!_.=-]{1,64}`). `diffCatalog` (pure, case-insensitive codes) gives added/changed/removed/returning/unchanged; `applyList` inserts, updates, marks removed rows inactive with `removed_at` (never deletes) and makes the Remote door entries for removed codes inactive; returning codes reactivate the catalog row but not the door entry. `safeToApply` (automatic only): refuse an empty list, or one removing more than half of 4+ active doors; the provider page's Check shows the preview (and whether the daily check would refuse it) and Apply applies it without the half rule. Sysop notifications (type `door_list`) for a list that could not be read, one refused, and one that changed.

## Schema

`doorserver_systems` (one row per registered remote BBS):

| column | notes |
|---|---|
| `id`, `uuid` | |
| `system_id` | the tag the client sends; unique, 2-12 of `[A-Z0-9_-]`, stored upper case |
| `bbs_name`, `sysop_name`, `contact_email`, `location`, `address` | descriptive; `address` is where the BBS itself is reached |
| `owner_user_id` | the local user who registered it; null when the sysop added it |
| `secret_hash`, `secret_prefix` | bcrypt of the generated secret, and its first characters for recognising it; the secret is shown once |
| `username_prefix` | prefixed to remote usernames here (`<prefix>_<name>`); defaults to the system id |
| `status` | `pending`, `approved`, `suspended`, `rejected` |
| `max_concurrent` | default `doorserver_max_concurrent` |
| `notes` | sysop only |
| `created_at`, `updated_at`, `approved_at`, `approved_by` | |
| `last_connect`, `session_count` | |

`doorserver_remotes` (door servers THIS board connects out to, phase D): `name`, `url`, `system_id`, `secret` (our own credential for that server, stored as given since it has to be sent), `active`.

`door_collections.audience` (`local` default, `doorserver`, `both`) and `door_collection_entries.doorserver` (boolean, default false; set true by `addDoorToCollection` when the collection's audience includes the door server) decide what the door server offers (#89).

## WebSocket protocol (`canectic-doorserver/1`)

1. Client opens `wss://<board>/ws/doorserver`.
2. Server sends `{"type":"hello","protocol":"canectic-doorserver/1","board":"<name>"}`.
3. Client sends one frame: `{"type":"auth","system_id":"...","secret":"...","user":{"name":"...","real_name":"..."},"door":"<slug or omitted>","term":{"width":80,"height":25,"encoding":"cp437"|"utf8","type":"ansi"},"list":false}`.
4. Server answers `{"type":"auth_ok","node":N,"doors":[{"slug","name","description"}],"collections":[{"slug","name","description","doors":["slug",...]}]}` or `{"type":"auth_fail","reason":"..."}` and closes. `doors` is every offered door once; `collections` (since #89) groups them, and a client that ignores it still works.
   - `list: true`: the server answers with the door list and closes. How a client builds its own menu.
   - `door` given: the door launches.
   - neither: the client shows a menu and sends `{"type":"launch","door":"<slug>"}`. With more than one collection the menu has two levels, collections then doors (Q goes back); otherwise it is the door list. The menu is `createDoorMenu` in `bin/doorclient.js`, exported so the RLogin wrapper and `RemoteDoorRunner` import the same one while the client stays a single file.
5. After `auth_ok` the socket carries the terminal stream, as any other pool.

The earlier stub frame (`system_id` + `auth_token`) is not accepted.

## Client program (phase C)

`bin/doorclient.js`: one file, no dependencies (Node's built-in `WebSocket`), shipped for sysops of other BBS software to run as a standard-I/O door. Reads the caller's name, real name and terminal from a DOOR32.SYS or DOOR.SYS path, or takes them as arguments; connects; bridges stdin/stdout to the socket. Options: server URL, system id, secret (or a file holding it), door slug, encoding.

## Canectic as a client (phase D)

Admin page of remote door servers. Menu command `remoteDoor`, argument `<remote name>[:<door slug>]`, connects the caller over WebSocket, sending their name, terminal size and encoding, and bridges their session until the remote door ends.

## RLogin (phase E, off by default)

`doorserver_rlogin_enabled`, `doorserver_rlogin_port` (default 5513). Handshake fields: client user = the system's secret, server user = `<SYSTEM_ID>:<username>`, terminal type = door slug, or a terminal type such as `ansi` for the door list. Same systems, flags and limits as WebSocket.

## Config keys

| Key | Default | |
|---|---|---|
| `doorserver_enabled` | false | accept door-server connections at all |
| `doorserver_register_security` | blank | lowest security level that may register a BBS; blank follows `verified_security`; users with the `Unverified` restriction never can (`doorserver.mayRegister`) |
| `doorserver_auto_approve_security` | blank | a registration by a user at or above this level is approved at once (`doorserver.autoApproves`) |
| `doorserver_auto_approve_flags` | blank | or by a user holding any of these permission flags (comma-separated, case-insensitive); both blank means every registration waits |
| `doorserver_max_concurrent` | 5 | default sessions per system |
| `doorserver_security` | 50 | security level door-server callers carry in drop files |
| `doorserver_rlogin_enabled` | false | phase E |
| `doorserver_rlogin_port` | 5513 | phase E (513 needs root) |

## Sessions

- Identity: `<username_prefix>_<remote username>`; the drop file handler already falls back to `call.caller_username` / `caller_fullname` and user number 512 when there is no local account.
- Logged in the caller log as source `Doorserver` with the remote BBS name; shown in Who's Online with the remote BBS.
- `last_connect` and `session_count` updated per session; concurrency counted from live calls.
