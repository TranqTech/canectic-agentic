# Netmail Routes

Custom routing rules for inbound FTN netmail. Lets a sysop alias, dump, or ignore specific messages before they reach the built-in processor dispatch and local user resolution.

Admin UI: `/admin/netmail-routes` (Networking dropdown in the admin navbar).

## When routes are evaluated

Inbound netmail flows through `ftnNetmailAdapter.importFtnNetmail()` in these steps. Custom routes run second, after the address check:

1. Is the destination address ours? (relay/reject if not)
2. **Custom routes match?** (alias / dump / ignore)
3. Is `to_user` a built-in processor? (`areafix`, `areamgr`, `filefix`, `filemgr`, `tic`, `raidfix`, `ping`; `raidfix` is recognised but has no handler, so mail to it is consumed without a reply)
4. Resolve `to_user` to a local user account, deliver to PM inbox

Custom routes beat built-in processors, so a route aliasing `areamanager` to `areafix` wins over the hardcoded list. A route with `action=ignore` wins over everything else -- the message is dropped before any dispatch.

## Rule matching

Each rule has three match fields:

| Field | Required | Purpose |
| --- | --- | --- |
| `match_to_user` | Yes | Pattern against the netmail `ToUser` field |
| `match_from_user` | No | Additional filter on `FromUser` (AND with to_user) |
| `match_from_addr` | No | Additional filter on the origin FTN address |

All three share the same `match_type`:

- **exact**: case-insensitive string equality. `"areafix"` matches `"AreaFix"` and `"AREAFIX"`, but not `"areafixx"`.
- **glob**: shell-style wildcards, case-insensitive. `*` matches any run of characters, `?` matches exactly one.

Rules are evaluated in `sort_order` ascending. The first matching rule wins. Reorder via drag-and-drop in the admin UI. Inactive rules are skipped entirely.

## Actions

### alias

Rewrite `to_user` to the configured target and fall through to normal dispatch. Common uses:

- Route nonstandard processor names to real processors: `areamanager` → `areafix`
- Redirect mail for a retired handle to the new one: `old-sysop-name` → `sysop`
- Funnel everything matching `*admin*` to a single account

The target has to be a valid value that will resolve in Step 3 or 4 (a known processor name or a local user).

### dump

Write the netmail to a JSON file in the configured target directory and consume the message. Meant for external handlers that want to process netmail on their own terms.

- Target is a directory path. Supports `%X` substitution (same as filebox / wildcards). Relative paths resolve under `filebox_base_dir`.
- Filename format: `<iso-timestamp>-<from_addr>-<to_user>-<rand>.json`
- JSON payload: `from_user`, `from_address`, `to_user`, `to_address`, `subject`, `date_time`, `msg_id`, `msg_orig_addr`, `attribute`, `file_attach` (bool), `body`, `received_at`
- Attached files are NOT copied or moved -- they stay in the inbound directory for wildcards/TIC/etc to handle.
- Dump failure (bad path, permission denied) falls back to the undeliverable queue so the sysop sees it rather than silently losing the message.

### ignore

Silently drop the netmail packet. No PM delivery, no undeliverable queue, no AreaFix-style response back to sender. Use for:

- IBBS game noise (`BRE System`, `LORD Mail`, etc)
- Known spam patterns from a specific address
- Retired processor names you don't want to trip alerts

Attached files are untouched. If your IBBS game delivers a `.QWK`/`.REP` as a netmail attachment, the netmail pointer gets swallowed but the file stays in the inbound dir for a wildcard rule (e.g. `*.REP → games/bre/inbound/`) to pick up.

## Log levels

Each rule has an optional `log_level` (default `0` = silent). When set, rule matches log at that level via alogger:

- `0`: silent (default). The whole point of `ignore` is noise reduction; silent is correct for normal operation.
- `3`: normal. Visible at default log verbosity.
- `4` to `5`: verbose / debug. Bump a single rule while diagnosing why it's (not) matching.

## Examples

Ignore IBBS BRE game mail from anywhere:

- name: `Ignore BRE mail`
- match_type: `exact`
- match_to_user: `BRE System`
- action: `ignore`

Ignore anything `*MAIL*` from one specific peer:

- match_type: `glob`
- match_to_user: `*MAIL*`
- match_from_addr: `1:234/56`
- action: `ignore`

Alias `areamanager` requests into the standard AreaFix processor:

- match_type: `exact`
- match_to_user: `areamanager`
- action: `alias`
- target: `areafix`

Dump messages addressed to `bbs-link` for a custom handler:

- match_type: `exact`
- match_to_user: `bbs-link`
- action: `dump`
- target: `netmail/bbs-link` (resolves under `filebox_base_dir` to e.g. `/home/bbs/ftn/filebox/netmail/bbs-link/`)

## Caching and live reload

Active rules are cached in memory inside the model. Every CRUD operation invalidates the cache, so changes take effect on the next inbound netmail without a service restart.

The rules are matched in the worker (the FTN tosser), while you edit them in the gateway. Each change is announced to the other processes, and the worker drops its cached copy when it hears it, so no restart is needed in the four-process layout either.

## Test tool

The admin page has a dry-run form: enter a `to_user` (plus optional `from_user` / `from_addr`) and it reports which rule (if any) would match. Useful for sanity-checking glob patterns before enabling them on live traffic.
