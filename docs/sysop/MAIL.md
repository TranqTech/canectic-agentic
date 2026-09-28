# Mail Setup

Canectic can send and receive real internet email on behalf of your users. Users compose PMs with `EMAIL` transport (from the web UI, terminal, or a standard mail client), and the tosser delivers them through a configured SMTP relay. Inbound mail arrives from an external MTA that you front the BBS with (Postfix, Proxmox Mail Gateway, Amazon SES, etc.) and injects via a trusted SMTP listener.

This guide walks through the full setup: outbound relay, inbound gateway, mail client access for your users, and the common failure modes.

For the template/notification side (verification codes, password reset emails, birthday messages), see [TEMPLATES.md](TEMPLATES.md). For the programmatic API, see [API.md](API.md).

## Overview

Canectic's mail subsystem has three independent pieces, each of which you can enable or leave disabled:

1. **Outbound relay** -- sends PMs with `EMAIL` transport out through a configured SMTP smart relay. Required for your users to email anyone outside the BBS.
2. **Inbound gateway** -- accepts mail injection from a trusted upstream MTA on an allowlisted port. Required for your users to receive email from outside the BBS.
3. **Mail client access** -- IMAP and SMTP submission servers on authenticated ports so users can read and send PMs from Thunderbird, Apple Mail, K-9, etc.

None of these run an internet-facing MTA directly. Canectic does not handle MX records, TLS certificate negotiation from random clients, spam filtering, DKIM signing, or bounce processing. Those responsibilities stay with a real mail gateway (Postfix, Proxmox MG, Mailgun, SES) that you deploy in front of the BBS. The BBS talks to that gateway over a trusted link.

Admin pages:
- `/admin/config` -- email category (all settings)
- `/admin/users` -- user mailaddress/mailtype fields

## Prerequisites

Before any of this works you need:

- **`mail_domain`** set in `.env` (preferred) or `/admin/config` network category. This is the IANA domain your BBS uses for mail -- e.g. `bbs.undermine.ca`. All user email addresses are of the form `<username>@<mail_domain>`. Until it is set, the mail process starts no servers at all (IMAP, SMTP submission and the inbound gateway alike): it logs `[Mail] Waiting: mail_domain is not configured` and starts them as soon as the setting is saved, without a restart.
- Your BBS hostname reachable from wherever the inbound MTA is running (on a private network, internal IP is fine).
- An SMTP relay you have credentials for (outbound only), and/or an upstream MTA you control (inbound only).

## Outbound Relay

Every outbound email from the BBS goes through an SMTP smart relay using nodemailer. You give Canectic the host, port, credentials, and a "from" address -- the relay handles MX lookups, TLS, retry queues, deliverability, SPF/DKIM alignment, and anything else required for modern email delivery.

### Configure the relay

Go to `/admin/config` -> email category and fill in:

| Key | Example | Notes |
|---|---|---|
| `email_relay_host` | `smtp.gmail.com` / `email-smtp.us-east-1.amazonaws.com` / `smtp.mailgun.org` | Leave blank to disable outbound entirely |
| `email_relay_port` | `587` or `465` | 587 = STARTTLS (most common), 465 = implicit TLS, 25 = plain/STARTTLS |
| `email_relay_secure` | `false` for 587, `true` for 465 | Auto-reconciled if it disagrees with the port -- see "TLS gotchas" below |
| `email_relay_user` | `bbs@example.com` | Relay auth username |
| `email_relay_password` | (app password or relay key) | Stored as-is; use an app-specific password, not your account password |
| `email_from_address` | `bbs@example.com` | Used for **system** email only (see below) |
| `email_from_name` | `My BBS` | Display name for system email. Falls back to `boardname` if blank. |
| `email_max_outbound_batch` | `50` | Emails per toss cycle. Raise for high-volume, lower if your relay rate-limits. |

After saving, the change takes effect on the next toss cycle (no worker restart needed -- the tosser subscribes to config changes).

### Known-good relay configurations

**Amazon SES:**
```
email_relay_host      = email-smtp.us-east-1.amazonaws.com
email_relay_port      = 587
email_relay_secure    = false
email_relay_user      = <IAM SES SMTP username>
email_relay_password  = <IAM SES SMTP password>
```
SES requires you to verify the `email_from_address` in the SES console before it will accept mail from it. In sandbox mode you also need to verify every recipient; move out of sandbox before putting real users on it.

**Gmail / Google Workspace:**
```
email_relay_host      = smtp.gmail.com
email_relay_port      = 587
email_relay_secure    = false
email_relay_user      = your-account@gmail.com
email_relay_password  = <app password from https://myaccount.google.com/apppasswords>
```
You cannot use your Google password directly. Generate an app password with 2FA enabled.

**Mailgun:**
```
email_relay_host      = smtp.mailgun.org
email_relay_port      = 587
email_relay_secure    = false
email_relay_user      = postmaster@mg.yourdomain.com
email_relay_password  = <SMTP password from Mailgun dashboard>
```

**Local Postfix on the same host:**
```
email_relay_host      = 127.0.0.1
email_relay_port      = 25
email_relay_secure    = false
email_relay_user      = (blank)
email_relay_password  = (blank)
```
Postfix should be configured for non-authenticated submission from localhost. This is the simplest setup if you already run Postfix for other services.

### System vs user email

Canectic distinguishes **system-generated** email (verification codes, password resets, message templates, sysop broadcasts) from **user-generated** email (one of your users composing a PM with `EMAIL` transport to someone outside the BBS).

- **System email** uses `email_from_address` and `email_from_name` verbatim. Every verification code email you see comes from `"My BBS" <bbs@example.com>`.
- **User email** uses `<username>@<mail_domain>` as the envelope from, header From local-part, and Reply-To. The display name prefers `users.fullname` (falling back to `users.username` if fullname is blank). So a user with username `kmuirhead` and fullname `Kostie Muirhead` produces:
  ```
  MAIL FROM:<kmuirhead@bbs.undermine.ca>
  From: "Kostie Muirhead" <kmuirhead@bbs.undermine.ca>
  Reply-To: "Kostie Muirhead" <kmuirhead@bbs.undermine.ca>
  ```

This is important because:

1. **Reply-To routes replies back to the actual user.** If external recipients reply to an email from `kmuirhead`, the reply comes back to `kmuirhead@bbs.undermine.ca` -- which your inbound gateway delivers to Kostie's BBS inbox.
2. **The address is always unique.** `users.username` is unique at the schema level. `users.fullname` isn't -- two users can both be "John Smith" -- so the display name can collide but the address never does.
3. **System messages stay clearly identified.** Verification codes always come from the system address so users can't impersonate the BBS itself.

If `mail_domain` isn't set, user-generated email falls back to using `email_from_address` with a warning logged each cycle. Delivery still works but replies won't route back to the user. Set `mail_domain`.

### TLS gotchas

The classic email setup failure is `email_relay_port` disagreeing with `email_relay_secure`. The standard conventions are:

| Port | What it expects |
|---|---|
| 465 | Implicit TLS -- `email_relay_secure = true` |
| 587 | STARTTLS (plaintext, upgrade) -- `email_relay_secure = false` |
| 25 | Plain SMTP, optional STARTTLS -- `email_relay_secure = false` |

If you get this wrong, the SMTP handshake fails with OpenSSL error `tls_validate_record_header:wrong version number`. Canectic auto-corrects this for the well-known ports: if you set port 587 with `secure=true`, the tosser logs a warning and overrides to `false` for the current cycle. Non-standard ports (anything other than 465/587/25) are left alone because Canectic can't guess your intent.

When a TLS mismatch is detected at runtime, the log line is explicit about the fix:

```
[EmailTosser] TLS handshake mismatch detected. This almost always means
email_relay_port and email_relay_secure disagree: port 465 needs
secure=true (implicit TLS); ports 587 and 25 need secure=false (STARTTLS).
Fix via /admin/config email category and retry.
```

The cached nodemailer transporter is also rebuilt on any TLS error so your fix takes effect on the next cycle without restarting the worker.

## Inbound Gateway

Canectic's inbound SMTP listener is **not** an internet-facing mail server. It accepts connections only from IP addresses you explicitly allowlist, and only for recipients that match local BBS users. The intended architecture is:

```
Internet -> Upstream MTA (Postfix/PMG/SES) -> Trusted SMTP listener on Canectic
             |
             MX records, TLS, spam filtering,
             DKIM verification, greylist, etc.
```

Your upstream MTA handles everything email-standard, then hands off clean mail to Canectic over the trusted link.

### Enable the inbound port

Go to `/admin/config` -> email category:

| Key | Example | Notes |
|---|---|---|
| `email_inbound_port` | `1026` | Any unused port >= 1024. `0` disables. Requires `pm2 restart mail` after change. |
| `email_trusted_hosts` | `127.0.0.1, 10.0.0.0/8` | Comma-separated mix of IPv4 addresses and CIDR blocks. IPs not matched here get `554 Access denied`. |

Then restart the mail process so the listener picks up the new port:
```bash
pm2 restart mail
```

### Trusted host allowlist (CIDR support)

`email_trusted_hosts` accepts a comma-separated mix of:

- Exact IPv4 addresses: `127.0.0.1`, `10.0.30.50`
- IPv4 CIDR blocks: `10.0.0.0/8`, `192.168.1.0/24`, `172.16.0.0/12`
- Both combined: `127.0.0.1, 10.0.0.0/8, 192.168.1.5`

Notes:

- `/32` means a single host; `/0` matches any IPv4.
- Non-canonical bases like `10.0.0.1/8` are accepted and normalised to `10.0.0.0/8`.
- Invalid entries (bad prefix, non-IP base) log a warning at level 2 and are skipped -- a typo in one entry doesn't kill the rest of the list.
- IPv6 is not yet supported. List exact IPv6 addresses if your upstream MTA connects over IPv6.

When an inbound connection is rejected, the log line at level 2 shows the full allowlist and a pointer to the config field:

```
SMTP inbound: rejected untrusted host 10.0.30.50 (allowlist has
127.0.0.1). Add this IP or a containing CIDR block to
email_trusted_hosts in /admin/config if the sender is legitimate.
```

### Point your upstream MTA at Canectic

This is MTA-specific. Common setups:

**Postfix** (`/etc/postfix/main.cf` + a transport map):

```
# main.cf
transport_maps = hash:/etc/postfix/transport
relay_domains = bbs.undermine.ca

# /etc/postfix/transport
bbs.undermine.ca   smtp:[10.0.30.50]:1026
```

Then `postmap /etc/postfix/transport && systemctl reload postfix`. Postfix will now route any mail for `bbs.undermine.ca` to Canectic over the trusted port.

**Proxmox Mail Gateway**: add `bbs.undermine.ca` as a relay domain under Configuration -> Mail Proxy -> Relay Domains, and set the relay target to your BBS host on the inbound port. PMG handles all spam filtering and TLS on the internet-facing side.

**Amazon SES as inbound** (SES Receiving): forward matched rules via SNS -> Lambda to your BBS. More complex than a local Postfix and usually overkill for a personal BBS.

### Recipient verification probes

Modern mail gateways often do **recipient address verification** before accepting a message -- the upstream MTA tries to verify that a local recipient exists on the downstream server before committing the connection to the sender. Canectic supports both probe styles used by Postfix / PMG / Exchange / GroupWise:

1. **MAIL FROM / RCPT TO probe** (default for Postfix `reject_unverified_recipient`): the gateway connects, sends `MAIL FROM: <>` / `RCPT TO: <user@mail_domain>` / `RSET`, reads the response codes, disconnects without sending DATA. Canectic responds `250 2.1.5 OK` for known users and `550 5.1.1 Recipient address unknown` for unknown. The empty-sender bounce-style `MAIL FROM: <>` is explicitly supported.

2. **VRFY command** (some gateways prefer this): the gateway connects, sends `VRFY username` or `VRFY username@domain`, reads the response. Canectic advertises VRFY in EHLO in trusted mode only (never on the public submission port), and responds with `250 <canonical@domain>` for known users and `550 5.1.1 User unknown` for unknown.

VRFY accepts a range of argument formats:
- `VRFY kostie` -- bare username
- `VRFY kostie.muirhead` -- dotted local-part, matched against `users.fullname` via dot-to-space fallback
- `VRFY kostie@bbs.undermine.ca`
- `VRFY kostie.muirhead@bbs.undermine.ca`
- `VRFY <kostie@bbs.undermine.ca>`

All recipient resolution paths (VRFY, RCPT TO, netmail-to-PM delivery, web compose) go through the same `resolveRecipient()` function, so there's a single source of truth for "does this local user exist". The lookup cascade:

1. Exact `users.username` match (case-insensitive)
2. Exact `users.fullname` match (case-insensitive)
3. Dotted-local-part fallback -- `first.last` -> `first last` against `users.fullname`
4. Sysop alias list (`sysop`, `sysadmin`, `system operator`)

Ambiguous fullname matches (two users both named "Kostie Muirhead") return "ambiguous" so the sender is forced to use the unique username.

Every probe in trusted mode is logged at level 3 on the tosser channel so you can watch verification activity live:

```
SMTP inbound: verify probe started (MAIL FROM: <>) from 10.0.30.50
SMTP inbound: verify probe <kostie@bbs.undermine.ca> accepted (empty sender)
SMTP inbound: VRFY <underminer> accepted
```

### Testing the inbound gateway

Once the mail process is up with the inbound port enabled, you can test directly from an allowlisted host with telnet:

```
$ telnet 10.0.30.50 1026
Trying 10.0.30.50...
Connected to 10.0.30.50.
220 bbs.undermine.ca Canectic BBS ESMTP
EHLO test.local
250-bbs.undermine.ca
250-VRFY
250-PIPELINING
250-8BITMIME
250 SIZE 10485760
VRFY kostie
250 <kostie@bbs.undermine.ca>
VRFY nosuchuser
550 5.1.1 <nosuchuser> User unknown
MAIL FROM:<>
250 2.1.0 OK
RCPT TO:<kostie@bbs.undermine.ca>
250 2.1.5 OK
RSET
250 OK
QUIT
221 Bye
```

If the BBS rejects you with 554, your IP isn't in `email_trusted_hosts`. If the BBS refuses the connection entirely, the mail process isn't listening -- check `pm2 logs mail` for `SMTP inbound (trusted) server listening on port 1026`, or a `[Mail] Waiting:` line saying why it has not started.

## Mail Client Access (IMAP + SMTP Submission)

Users can read and send their BBS private messages from any standard mail client (Thunderbird, Apple Mail, K-9, Outlook, etc.) via authenticated IMAP and SMTP submission. This is independent of the outbound relay and inbound gateway -- it's purely about letting your users access their BBS inbox from a mail client.

### Default ports

| Service | Default port | Config key |
|---|---|---|
| IMAP4rev1 | 10143 | `imapport` |
| SMTP submission | 10587 | `smtpport` |

Both listen on all interfaces. The mail process runs both servers when `mail_domain` is set and `imapport` / `smtpport` are non-zero (they default on). Both ports are in the network category of `/admin/config` and need `pm2 restart mail` after a change.

### Client configuration

Users configure their mail client with:

- **IMAP server**: your BBS hostname, port `10143`, plaintext (or STARTTLS if you front with a TLS-terminating proxy)
- **SMTP server**: your BBS hostname, port `10587`, plaintext/STARTTLS
- **Username**: their BBS username
- **Password**: their BBS password (same credentials as web/terminal login)

After authenticating, they see `INBOX`, `Sent`, and `Trash` folders populated from their PM data. Read state syncs both directions (IMAP `\Seen` flag <-> BBS read flag) via a Redis pub/sub event so marking read in the mail client shows read in the web UI and vice versa.

### Trash and disk reclaim

Deleting a message from inbox or sent moves it to Trash where it can be restored. Deleting it from Trash (or hitting "Empty Trash" in the mail client) hard-deletes it. The two stages are:

1. **User action** (web Delete-from-Trash button or IMAP `STORE \Deleted` + `EXPUNGE` while Trash is selected): the row is tagged for cleanup. Instant; no disk work happens here. Tagged rows disappear from every view immediately, even though their attachment files are still on disk.
2. **Background cleanup** runs hourly (`pm-purged-cleanup-hourly` BullMQ schedule, or on-demand within seconds of the user action). This is the job that actually unlinks the files and removes the rows. Failures here are retried on the next cycle, not surfaced to the user.

This split keeps user actions non-blocking even when a mail client like Thunderbird fires "Empty Trash" against hundreds of messages: the IMAP `EXPUNGE` returns instantly and the file unlinks happen behind the scenes.

The daily 03:00 retention sweep (`pm_trash_retention_days`, default 30) handles trash messages the user *didn't* explicitly purge: rows whose `deleted_at` is older than the retention window get tagged the same way and picked up by the next cleanup tick. Adjust the retention window via `pm_trash_retention_days` in `/admin/config` maintenance category.

### TLS for mail client access

Canectic does not terminate TLS on the IMAP/SMTP ports itself. If you expose these to the internet, front them with an nginx/HAProxy TLS terminator or put them behind a VPN. For a personal BBS where you're the only user, plain IMAP on a trusted network is fine.

## User Verification Flow

New user registration can require email (or FTN netmail) verification before granting normal access. The user picks their preferred verification type at registration and enters an address; Canectic sends a verification code via the chosen transport and upgrades their security level when they enter the code back on the verification page.

Relevant config keys (in `/admin/config` security category):

| Key | Default | Purpose |
|---|---|---|
| `verified_security` | `60` | Security level granted on successful verification (only if higher than the user's current level) |
| `unverified_retention_days` | `14` | Days before unverified accounts are auto-purged. `0` disables purge. |

Users in the unverified state have the `Unverified` restriction flag which blocks message posting, file upload, etc. until they complete verification. The email side of the flow requires outbound relay to be configured -- if `email_relay_host` is blank, an email verification request is refused with "Email relay is not configured. Contact the sysop." and the user can verify by netmail instead.

Email verification messages use the **system** sender (`email_from_address` / `email_from_name`) regardless of who the recipient is -- they're identified as coming from the BBS itself.

To customise the content of verification / password reset / welcome messages without touching code, use the [message templates](TEMPLATES.md) system and edit the appropriate event templates.

## Troubleshooting

### "Transient error: wrong version number"

TLS handshake mismatch. Your `email_relay_port` and `email_relay_secure` disagree. See "TLS gotchas" in the outbound section. Canectic should auto-correct on well-known ports (465/587/25) but if you're using a non-standard port you'll need to set the right value yourself.

### Inbound mail bouncing with "450 Recipient address rejected: unverified address"

Your upstream MTA is doing recipient verification against Canectic and either (a) Canectic is still rejecting it (verify the IP is in `email_trusted_hosts`, see the test with telnet) or (b) the upstream MTA has the earlier rejection cached. Postfix's address verification cache defaults to 3 hours; flush it on the MTA side:

```bash
# On a Postfix host:
postfix stop
rm /var/lib/postfix/verify_cache.db
postfix start
```

Or wait out the `address_verify_negative_cache_expire_time_limit` (default 3h) before retrying.

### Outbound cycle logs "DB query error: column 'X' does not exist"

Database migration mismatch. Run `node src/tools/dbmigrations.js` to apply missing columns. This should be idempotent -- safe to run on an already-migrated database.

### External recipients can't reply to a user's email

Check that `mail_domain` is set in config. Without it, user-generated email falls back to the system `email_from_address` as the sender, so replies go to the sysop inbox instead of the user. The tosser logs a warning each cycle when this happens:

```
[EmailTosser] mail_domain not configured -- user PM id=N will be sent with
system from-address. Set mail_domain in /admin/config network category to
route replies back to the sender.
```

### System email arrives but is flagged as spam

Your `email_from_address` domain probably has no SPF or DKIM alignment with the relay. Fix on the relay / DNS side:

- **SPF**: add a TXT record on your domain authorising the relay. E.g. for SES: `v=spf1 include:amazonses.com ~all`.
- **DKIM**: configure the relay to sign outbound mail with a key published at `<selector>._domainkey.<domain>`. Most commercial relays (SES, Mailgun, Postmark) provide the DNS records to add.
- **DMARC**: optional but increasingly expected. `v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com` is a safe starting point.

### "SMTP inbound: rejected untrusted host" in mail logs

Your upstream MTA's IP isn't in `email_trusted_hosts`. Add it (or a containing CIDR block) via `/admin/config` and `pm2 restart mail`. The log line shows the current allowlist so you can see what's being compared against.

### Mail client can't authenticate against IMAP/SMTP

Check:
1. `imapport` / `smtpport` are set and non-zero in `/admin/config`
2. The mail process is running: `pm2 list` should show `mail` as `online`
3. The user's BBS password is correct (same as web/terminal login)
4. No firewall is blocking the client from reaching the port

A failed login gets `NO LOGIN failed` (IMAP) or `535 Authentication failed` (SMTP), and is written to `security.log` as `[AUTHFAIL] Failed login for "<user>" from <address> via IMAP` (or `via SMTP`, or `Login attempt for unknown user` for a name that does not exist), which the fail2ban filter in `examples/fail2ban/` matches. At log level 4, `pm2 logs mail` shows each successful login as `IMAP LOGIN: <username>` or `SMTP AUTH: <username>`, so a user who never appears there is not getting past authentication.

### The port/secure override warning keeps firing

The auto-reconciliation only runs per-cycle; it doesn't persist the override to the DB. Update the config to match the port convention so the warning stops:

- Using port 465 -> set `email_relay_secure = true`
- Using port 587 or 25 -> set `email_relay_secure = false`

## Configuration Reference

All keys are in the `email` category of `/admin/config` unless otherwise noted.

### Outbound

| Key | Type | Default | Description |
|---|---|---|---|
| `email_relay_host` | string | empty | SMTP relay hostname. Empty disables outbound. |
| `email_relay_port` | number | `587` | Relay port. 587/STARTTLS, 465/TLS, 25/plain. |
| `email_relay_secure` | boolean | `false` | `true` = implicit TLS (465), `false` = STARTTLS (587/25). Auto-reconciled on known ports. |
| `email_relay_user` | string | empty | SMTP auth username. |
| `email_relay_password` | string | empty | SMTP auth password. |
| `email_from_address` | string | empty | System-email from address. Required for outbound. |
| `email_from_name` | string | empty | System-email display name. Falls back to `boardname`. |
| `email_max_outbound_batch` | number | `50` | Max emails per toss cycle. |

### Inbound

| Key | Type | Default | Description |
|---|---|---|---|
| `email_inbound_port` | number | `0` | Trusted inbound SMTP port. `0` disables. Requires `pm2 restart mail` after change. |
| `email_trusted_hosts` | string | `127.0.0.1` | Comma-separated IPv4 addresses and/or CIDR blocks. |

### Mail Client Access

These two are in the `network` category.

| Key | Type | Default | Description |
|---|---|---|---|
| `imapport` | number | `10143` | IMAP4rev1 server port. `0` disables. Requires `pm2 restart mail`. |
| `smtpport` | number | `10587` | SMTP submission server port. `0` disables. Requires `pm2 restart mail`. |

### Related (other categories)

| Key | Category | Purpose |
|---|---|---|
| `mail_domain` | network | IANA domain for user addresses. Required for the mail process to start any server, and for user-generated email to have routable reply addresses. |
| `verified_security` | security | Security level granted after email/netmail verification. |
| `unverified_retention_days` | security | Days before unverified accounts are auto-purged. |

## Process Architecture

The mail subsystem lives in the `mail` PM2 process (`bin/mail.js`), separate from the gateway, worker, and mailer. This isolation means mail client activity (especially long-lived IMAP IDLE connections) can't block terminal sessions or toss jobs. Cross-process events use Redis pub/sub:

- `PM_DELIVERED` -- gateway/worker publishes when a new PM arrives; mail process pushes to IDLE clients
- `PM_READ_CHANGED` -- mail process publishes when an IMAP client marks a message read; gateway updates the web UI

The outbound email tosser itself runs in the **worker** process (not mail), because it's a queue job like the other tossers. The worker consumes `email:outbound` jobs from the BullMQ toss queue.

When you change any email config via `/admin/config`, all processes subscribe to the `CONFIG_CHANGED` Redis event and reload their appConfig cache automatically -- no restart needed for most settings. The exceptions are:

- `email_inbound_port`, `imapport`, `smtpport` -- require `pm2 restart mail` because a listener has to be opened or closed (the one exception: when the mail process is still waiting for `mail_domain`, setting it starts every enabled server without a restart)
- `email_trusted_hosts` -- the SmtpServer instance caches the parsed allowlist at construction, so changes take effect on the next `pm2 restart mail`
