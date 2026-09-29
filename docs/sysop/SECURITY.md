# Keeping Scanners Out

A BBS on port 23 draws a steady stream of internet scanners looking for routers and cameras with default passwords. None of them is a caller, and Canectic now turns them away before they cost anything.

## The terminal screen

Every new telnet or TCP connection is screened before it is given a node. Until it passes, it is not in the caller log or Who's Online, gets no login prompt, and touches nothing in the database.

- **A real terminal passes at once.** The board asks it where its cursor is, which any ANSI terminal answers by itself, so an ordinary caller sees nothing different.
- **A client that cannot answer** is shown `Press ESC twice to continue.` after a moment and a half; two presses of ESC let it in. Some older DOS terminal programs and bare telnet clients need this.
- **A scanner is dropped.** If the first thing a connection sends is a router login or a command (`root`, `admin`, `enable`, `sh`, `/bin/busybox ...`, a web or SSH request, and every name in `honeypot_usernames`), the connection is closed straight away and a `[HONEYPOT]` line is written to `security.log` (when `honeypot_enabled` is on).
- **Anything else is closed** after `terminal_screen_timeout` seconds (15).

The Node Spy page shows how many connections the screen let in, dropped as scanners, and closed without an answer, today and over the last seven days.

Settings, under Security on the Configuration page:

| Setting | Default | |
|---|---|---|
| `terminal_screen_enabled` | on | screen new terminal connections |
| `terminal_screen_timeout` | 15 | seconds to pass before the connection is closed |
| `terminal_screen_prompt` | `Press ESC twice to continue.` | shown to a client that does not answer |
| `honeypot_enabled` | on | write `[HONEYPOT]` lines to `security.log` |
| `honeypot_usernames` | `root,admin,...` | names no caller ever logs in with; also treated as scanner logins by the screen |

Web callers, the door server and RLogin are not screened: each has its own login.

## Banning scanners with fail2ban

Dropping a scanner stops it costing anything on the board; banning it stops it coming back. `examples/fail2ban/` has two filters and a jail file:

- `canectic-honeypot` matches the `[HONEYPOT]` lines, which the terminal screen and a login with a honeypot name both write. The example jail bans on the first line, for a day.
- `canectic-auth` matches failed logins (`[AUTHFAIL]`) on the terminal, the web, mail and the API. It is off in the example; turn it on with a higher `maxretry`, since real callers mistype passwords.

Copy the filters to `/etc/fail2ban/filter.d/` and the jail to `/etc/fail2ban/jail.d/`, set `logpath` to your board's `logs/production/security.log`, and restart fail2ban.

**Ban the ports the board actually listens on.** The example bans ports 23, 2023 (Canectic's default terminal port), 22, 80 and 443. If your router forwards port 23 to another port on the board, the board sees scanners arriving on that port, so it must be in the jail's `port=` list or the ban has no effect.
