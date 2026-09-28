# Canectic BBS — Internet Email Transport Architecture

## Overview

The internet email transport enables BBS users to send and receive real email through standard internet infrastructure. Outbound messages are relayed through a configured SMTP smart relay (e.g. Gmail, Mailgun, Postfix). Inbound messages arrive from an external MTA/gateway that handles MX records, TLS termination, and spam filtering, then injects into the BBS via a trusted SMTP listener.

Email is integrated as a transport type within the existing private messaging system — no separate tables or delivery pipelines. The `EMAIL` transport type was already defined in `TRANSPORT_ACCESS_RULES` and is now fully implemented.

For the unified PM system (schema, access control, delivery pipeline), see `PM_ARCHITECTURE.md`.
For the IMAP/SMTP mail client access servers, see the mail process section in `PROCESS_ARCHITECTURE.md`.
For the web and terminal compose interfaces, see `PM_ARCHITECTURE.md` and `web_architecture.md`.

---

## Core Files

| File | Location | Purpose |
|------|----------|---------|
| `emailTosser.js` | `src/middleware/tossers/` | Outbound email relay via nodemailer. Queries `getPendingByTransport('EMAIL')`, sends through configured SMTP relay, handles permanent/transient failures. |
| `smtpServer.js` | `src/servers/` | SMTP server with two modes: authenticated submission (outbound) and trusted inbound (gateway injection). |
| `imapAdapter.js` | `src/models/` | IMAP rendering for EMAIL transport — real email addresses in From/To headers. |
| `privateMessages.js` | `src/models/` | EMAIL wired into `_triggerOutboundToss()` → `enqueueEmailOutbound()`. |
| `jobs.js` | `src/queues/` | `enqueueEmailOutbound()` job helper. |
| `configDefaults.js` | `src/config/` | Ten `email` category config keys, plus `mail_domain`, `imapport` and `smtpport` under `network`. |
| `pm.js` | `src/routes/` | EMAIL address validation and transport_data building in web compose. |
| `mail.js` | `bin/` | Starts trusted inbound SMTP listener alongside existing IMAP/SMTP servers. With no `mail_domain`, or every mail port 0, it waits rather than exiting and starts its servers on a `CONFIG_CHANGED` reload that allows it. Under maintenance mode every mail server refuses new connections and closes open sessions at the deadline (`setMaintenance`, `closeSessionsForMaintenance`). |
| `mailStartup.js` | `src/servers/` | `mailDisabledReason(cfg)`: the pure rule for whether the mail process can start (needs `mail_domain`, and at least one of `imapport`, `smtpport`, `email_inbound_port` above 0). |
| `worker.js` | `bin/` | `email:outbound` job handler in toss processor. |
| `outboundSweep.js` | `src/maintenance/` | The periodic all-protocol outbound sweep, which includes email. |

---

## Configuration

All keys below are in the `email` category in `configDefaults.js` except `mail_domain`, which is in `network`; all are managed via Admin UI at `/admin/config`.

### Outbound Relay

| Key | Default | Description |
|-----|---------|-------------|
| `email_relay_host` | _(empty)_ | SMTP relay hostname. Empty = outbound email disabled. |
| `email_relay_port` | `587` | Relay port. 587 = STARTTLS, 465 = implicit TLS, 25 = plain/STARTTLS. |
| `email_relay_secure` | `false` | `true` = implicit TLS (port 465), `false` = STARTTLS (ports 587/25). The tosser auto-reconciles obvious mismatches — see "Port/secure reconciliation" below. |
| `email_relay_user` | _(empty)_ | Relay auth username. |
| `email_relay_password` | _(empty)_ | Relay auth password. |
| `email_from_address` | _(empty)_ | Envelope From address for **system-generated** email (verification, password reset, templates, sysop broadcasts). Required for outbound. User-generated PMs use a per-user address instead (see "Sender identity"). |
| `email_from_name` | _(empty)_ | Display name for **system-generated** email. Falls back to `boardname`. |
| `email_max_outbound_batch` | `50` | Maximum emails sent per toss cycle. Prevents relay rate-limit issues. |
| `mail_domain` | _(empty)_ | (`network` category.) IANA domain name the BBS uses for all mail addressing. Required for user-generated outbound to build `<username>@<mail_domain>` sender addresses, and for the mail process to start any server at all. |

### Inbound Gateway

| Key | Default | Description |
|-----|---------|-------------|
| `email_inbound_port` | `0` | Trusted inbound SMTP port (e.g. 1026). `0` = disabled. Requires restart. |

The submission and IMAP ports are `smtpport` (10587) and `imapport` (10143), both `network` category, restart required, `0` disables.
| `email_trusted_hosts` | `127.0.0.1` | Comma-separated mix of IPv4 addresses and IPv4 CIDR blocks allowed to inject without authentication. E.g. `127.0.0.1, 10.0.0.0/8, 192.168.1.5`. IPv6 still requires exact addresses. |

---

## Architecture

### Outbound Flow (BBS → Internet)

```
User composes EMAIL PM (web, terminal, or mail client)
  → queueMessage(messageObj, userSession)
    → checkTransportAccess — requires "Email" permission flag
    → INSERT pm_outbox (queued=true, sent=false)
    → _triggerOutboundToss('EMAIL')
      → enqueueEmailOutbound() on toss queue
        → worker picks up email:outbound job
          → emailTosser.tossOutbound()
            → getTransporter() with port/secure reconciliation
            → getPendingByTransport('EMAIL')
            → for each PM (up to email_max_outbound_batch):
              → _isSystemMessage(pm, transportData) classifies sender
                → system → email_from_address / email_from_name
                → user   → _resolveSender() looks up users row by pm.user_id
                           → _pickSenderIdentity(userRow, pm) picks
                             address (users.username) + display (users.fullname)
                           → builds <username>@<mail_domain> envelope
              → load pm_attachments if has_attachments=true
              → nodemailer.sendMail() to configured relay
              → success: markSent(id, 'EmailTosser')
              → 5xx permanent: markOutboxUndeliverable(id, reason)
                → notifySenderUndeliverable() — bounce to sender inbox
              → TLS mismatch: diagnostic log + resetTransporter()
              → transient: markSendError(id, errorText) — retry next cycle
```

### Inbound Flow (Internet → BBS)

```
External MTA receives email (MX, TLS, spam filtering)
  → forwards to BBS trusted SMTP port (e.g. 1026)
    → SmtpServer verifies connecting IP against email_trusted_hosts
    → SmtpSession in trustedMode:
      → EHLO/MAIL FROM accepted without auth
      → RCPT TO: _resolveAddress() — local users on mail_domain only
        → resolveRecipient(localPart) — username/realname/sysop alias
        → rejects: external domains, .ftn, .qwk (no relay out)
      → DATA: _processInboundData()
        → parse RFC 2822 headers + body
        → extract MIME attachments (recursive nested multipart traversal)
          → base64 and quoted-printable content-transfer-encoding decoded
          → files saved to pm_attachment_dir, linked via pm_attachments table
        → deliverMessage() to pm_inbox (has_attachments=true if any)
          → transport_type: 'EMAIL'
          → transport_data: { email_address: senderEnvelope, inbound: true }
          → from_user: parsed display name from From header
          → from_address: envelope sender address
```

### SMTP Submission (Mail Client → BBS → Internet)

```
Mail client (Thunderbird, etc.) connects to SMTP submission port (10587)
  → SmtpSession: standard authenticated mode
  → AUTH PLAIN/LOGIN → checkUserPass()
  → RCPT TO: _resolveAddress()
    → our domain → LOCAL (existing behavior)
    → .ftn TLD → FTN (existing behavior)
    → .qwk TLD → QWK (existing behavior)
    → external domain → EMAIL transport
      → transportData: { email_address: fullAddress }
  → DATA: queueMessage() with session for access control
    → EMAIL permission flag enforced
```

---

## transport_data JSONB Structures

### Outbound EMAIL

```json
{
  "email_address": "user@gmail.com"
}
```

### Inbound EMAIL

```json
{
  "email_address": "sender@example.com",
  "inbound": true
}
```

The `email_address` field holds the real internet email address in both directions — the recipient for outbound, the sender for inbound.

---

## SMTP Server Modes

`SmtpServer` and `SmtpSession` support two modes controlled by constructor options. EHLO capabilities, authentication requirements, and VRFY support all differ between the two.

### Submission Mode (default)

- Listens on the authenticated submission port (default 10587)
- Requires authentication (AUTH PLAIN or AUTH LOGIN)
- EHLO advertises: `AUTH PLAIN LOGIN`, `PIPELINING`, `8BITMIME`, `SIZE`
- Resolves addresses across all transport types (LOCAL, FTN, QWK, EMAIL)
- External domains → EMAIL transport (new behavior)
- VRFY returns `252 2.5.2 Cannot VRFY user, but will accept message` per
  RFC 5321 §3.5.3. Enabling VRFY on a public submission port would be an
  address-harvesting vector; the 252 response keeps the handshake RFC-compliant
  without leaking user existence.
- Access control enforced via `queueMessage(messageObj, session)`

### Trusted Inbound Mode

- Enabled by `SmtpServer(port, domain, { trusted: true, trustedHosts: '...' })`
- Typically port 1026, fronted by an external MTA that handles MX/TLS/spam
- Connecting IP verified against parsed allowlist — rejected if not matched
- Authentication skipped — `SmtpSession.authenticated` defaults to `true`
- EHLO advertises: `VRFY`, `PIPELINING`, `8BITMIME`, `SIZE` (no AUTH — the
  IP allowlist is the authentication)
- `_resolveAddress()` short-circuits: only resolves local users on `mail_domain`
- Rejects all external domains, `.ftn`, `.qwk` (no outbound relay from trusted port)
- `_processInboundData()` delivers directly via `deliverMessage()` (not `queueMessage()`)

### Trusted Host Allowlist (CIDR support)

`email_trusted_hosts` accepts a comma-separated mix of IPv4 addresses and
IPv4 CIDR blocks:

```
127.0.0.1, 10.0.0.0/8, 192.168.1.0/24, 172.16.0.0/12
```

Parsing is handled by `_parseTrustedHostList()` which splits into:

- `exact: Set<string>` — literal IPv4 matches for the hot path
- `cidrs: Array<{base, mask, text}>` — base and mask as 32-bit integers
  for fast bitwise matching

`_matchesTrustedHost(normalizedAddr, parsed)` tries the exact-match Set first
(O(1)) and falls back to iterating CIDRs only if no exact match. `_ipv4ToInt()`
is the shared parser; returns `null` for malformed input.

CIDR entries with non-zero host bits (`10.0.0.1/8`) are normalised by masking
the base against the prefix length — the stored `cidrs[].base` is always the
canonical network address. Invalid CIDR entries log a warning and are skipped
so a typo in one entry can't kill the whole allowlist. `/0` matches any IPv4;
`/32` is equivalent to an exact match. IPv6 is not yet supported — operators
wanting IPv6 allowlisting should list exact addresses.

On rejection the server logs at level 2 (visible in default logs) with the
full allowlist in the message, and responds with an enhanced-status 5.7.1:

```
554 5.7.1 Access denied: 10.0.30.50 is not in this host's SMTP allowlist
```

The enhanced status code means downstream postfix logs show "access denied"
rather than a generic "connection refused".

### Recipient Verification Probes (VRFY + RCPT TO)

Upstream mail gateways doing recipient address verification
(Postfix `reject_unverified_recipient`, Proxmox MG, Exchange, GroupWise)
can verify a local user exists without actually sending mail. Trusted mode
supports both probe styles:

**VRFY** (`_cmdVrfy()`) accepts:
```
VRFY username                   — matches users.username
VRFY first.last                 — matches users.fullname via dot-to-space fallback
VRFY username@domain
VRFY first.last@domain
VRFY <username@domain>
```

Bare usernames get the mail domain auto-appended. Angle brackets are stripped.
The resolver (`privateMessages.resolveRecipient()`) is the single source of
truth for "does this recipient exist" — see "Recipient resolution" below.

Responses:
- **Found**: `250 <kmuirhead@bbs.undermine.ca>` — canonical, lowercase local part
- **Not found**: `550 5.1.1 <addr> User unknown`
- **Empty arg**: `501 5.5.2 Empty VRFY argument`

**MAIL FROM / RCPT TO probe** is the "MAIL FROM: <> / RCPT TO: <addr> / RSET"
pattern Postfix uses by default. Empty sender is explicitly supported (the
earlier truthy check on `mailFrom` was tightened to a strict null check so
`""` doesn't trigger "503 Need MAIL FROM first"). Trusted-mode sessions log
every RCPT TO at level 3 on the tosser channel with `verify probe` vs `RCPT`
distinction so sysops can watch verification activity live:

```
SMTP inbound: verify probe started (MAIL FROM: <>) from 10.0.30.X
SMTP inbound: verify probe <underminer@bbs.undermine.ca> accepted (empty sender)
```

Unknown-recipient probes return `550 5.1.1 <addr> Recipient address unknown`
so downstream relays cache the correct verdict. Enhanced status codes
(`250 2.1.5` for accepted, `550 5.1.1` for unknown) match the VRFY response
shape.

### IPv6 Handling

Trusted host verification normalizes `::ffff:127.0.0.1` to `127.0.0.1` for IPv4-mapped IPv6 addresses. Bare IPv6 addresses in the allowlist are stored as literals in the `exact` Set (no CIDR support yet).

### Recipient Resolution

`privateMessages.resolveRecipient(toUser)` is the single source of truth
for "does this local recipient exist" across every delivery path (SMTP
RCPT TO, VRFY, FTN netmail local delivery, PM compose by name, IMAP
address lookup). Lookup cascade:

| Step | Matches against | Example input |
|---|---|---|
| 1 | `users.username` (case-insensitive) | `kostie`, `KOSTIE`, `dr.smith` (if literally that username) |
| 2 | `users.fullname` (exact, case-insensitive) | `Kostie Muirhead` — terminal/web compose |
| 3 | `users.fullname` with dot→space | `kostie.muirhead`, `first.last`, `KOSTIE.MUIRHEAD` |
| 4 | Sysop alias list | `sysop`, `sysadmin`, `system operator` |

Step 1 firing first means a legitimate dotted username like `dr.smith`
is resolved directly, not shadowed by the step-3 fallback.

**Dotted-local-part fallback** (`_dottedLocalToFullname()`) handles
the reverse of `imapAdapter.networkEmailAddress`'s outbound slugification
(`"Kostie Muirhead"` → `"kostie.muirhead"`): if steps 1 and 2 miss AND
the input contains a dot, it tries `input.replace(/\./g, ' ')` as an
additional `users.fullname` lookup. Normalisation collapses runs of
dots, trims leading/trailing dots, and returns `null` for dot-only
inputs so the resolver doesn't issue empty-string queries.

This makes the outbound `<first.last@mail_domain>` convention
round-trip correctly through upstream relay verification (VRFY or
RCPT TO) — critical for gateways like Postfix's
`reject_unverified_recipient` which cache recipient validity across
delivery attempts.

Ambiguous matches (same fullname for multiple users) return
`{ resolved: false, reason: 'ambiguous_match' }` at either step 2 or
step 3 so the caller can ask the sender to use the unique username
instead.

---

## Email Tosser

`src/middleware/tossers/emailTosser.js` follows the same pattern as other tossers:

### Transporter Management

- Lazy-initialized nodemailer transporter from appConfig values
- `resetTransporter()` called on `CONFIG_CHANGED` events (worker subscribes)
- `resetTransporter()` also called automatically on TLS mismatch errors so
  a sysop's config fix takes effect on the next cycle without a worker restart
- Returns `null` (skip) if `email_relay_host` is empty

### Port/Secure Reconciliation

OpenSSL's "wrong version number" handshake error is almost always caused by
`email_relay_port` and `email_relay_secure` disagreeing on convention. The
tosser auto-reconciles well-known ports in `_reconcileSecure(port, configured)`:

| Port | Convention | Action if misconfigured |
|---|---|---|
| 465 | Implicit TLS | Warn + override `secure` to `true` for this cycle |
| 587 | STARTTLS (submission) | Warn + override `secure` to `false` + set `requireTLS: true` |
| 25 | Plain + optional STARTTLS | Warn + override `secure` to `false` |
| anything else | Sysop intent | Left alone |

The warning log points at the exact config field to edit so the sysop can
silence it permanently. `requireTLS: true` on port 587 means nodemailer
refuses to fall back to plaintext even if the relay stops advertising
STARTTLS — defence in depth.

`_isTlsMismatchError(err)` detects OpenSSL errors by message pattern
(`wrong version number`, `tls_validate_record_header`, `unsupported protocol`,
`ssl3_get_record`) and triggers a diagnostic hint plus `resetTransporter()`.

### Sender Identity (system vs user)

System-generated email (verification, password reset, template notifications,
sysop broadcasts) and user-generated PMs use different sender addresses.
`_isSystemMessage(pm, transportData)` classifies each outbound PM:

- `transport_data.system_notification === true` → system
- `pm.from_user === 'SYSTEM'` → system
- `pm.user_id` null/0/undefined → system
- anything else → user-generated

System messages use `email_from_address` / `email_from_name` verbatim.
User messages go through `_pickSenderIdentity(userRow, pm)` which applies
two separate rules:

**Address** (envelope MAIL FROM, header From local-part, Reply-To) —
must always be `users.username`. It's the only schema-unique identifier;
`pm.from_user` is NOT safe because per-group `post_as` settings let it
be either `username` OR `fullname` (the `post_as` feature exists for
FTN netmail / QWK / NNTP where the protocol has one "from" slot). Email
has a proper separate display-name field, so the address stays canonical
regardless of what `post_as` allowed at compose time.

**Display name** (header From quoted portion) — prefers `users.fullname`
because that's the human-readable form recipients see in their inbox
list. Falls back to `users.username` when fullname is blank.

Fallback chains if the DB lookup failed (deleted account, DB error):

```
senderUsername: users.username > pm.from_user > 'user'
displayName:    users.fullname > users.username > pm.from_user > 'User'
```

Local-part slugification (`_usernameToLocal()`) matches the convention in
`imapAdapter.networkEmailAddress`: lowercase + whitespace → dots. This
ensures the outbound address round-trips correctly when external mailers
verify it via VRFY or RCPT TO (the resolver's dotted-local-part fallback,
see "Recipient resolution" below, handles the reverse transformation).

Produced headers for a user `kmuirhead` with fullname `Kostie Muirhead`:

```
MAIL FROM:<kmuirhead@bbs.undermine.ca>
From: "Kostie Muirhead" <kmuirhead@bbs.undermine.ca>
Reply-To: "Kostie Muirhead" <kmuirhead@bbs.undermine.ca>
```

If `mail_domain` isn't configured, user-generated email falls back to the
system `email_from_address` with a warning so the tosser keeps making
forward progress rather than blocking on an incomplete config.

### Failure Handling

| SMTP Response | Action | Result |
|---------------|--------|--------|
| Success (2xx) | `markSent(id, 'EmailTosser')` | Message marked sent, removed from queue |
| Permanent (5xx) | `markOutboxUndeliverable(id, reason)` | Bounce notification to sender inbox, stops retrying |
| Transient (4xx, network) | `markSendError(id, errorText)` | Error recorded, retried next cycle |
| Missing email_address | `markOutboxUndeliverable(id, reason)` | Immediate bounce — malformed transport_data |

### Batch Limiting

`email_max_outbound_batch` (default 50) caps the number of emails sent per toss cycle. This prevents overwhelming the relay and hitting rate limits. Remaining messages are sent in subsequent cycles.

---

## IMAP Rendering

`imapAdapter.js` renders EMAIL transport messages with real email addresses:

### networkEmailAddress (EMAIL transport)

- Splits `networkAddress` at `@` → returns `{ local, domain }` as-is
- Bare address (no `@`) → uses address as local part with `mailDomain` as domain
- Example: `"user@gmail.com"` → `{ local: "user", domain: "gmail.com" }`

### networkDisplayName (EMAIL transport)

- Format: `"displayName <emailAddress>"` (angle-bracket style)
- Example: `"John Doe <john@gmail.com>"`
- Other transports use parenthetical: `"kostie (1:134/101)"`

This means EMAIL messages in Thunderbird/mail clients show real email addresses that can be replied to naturally.

---

## Web Compose

`POST /pm/compose/network` in `src/routes/pm.js` handles EMAIL:

### Validation

- Basic email format check: must contain `@` with non-empty local and domain parts, domain must contain `.`
- Transport access check via `checkTransportAccess(session, 'EMAIL')`

### transport_data Building

```javascript
if (transportType === 'EMAIL') {
    messageObj.to_address = toAddress;
    messageObj.transport_data = {
        email_address: toAddress
    };
}
```

The `to_user` field holds the recipient's display name (required), `to_address` holds the email address.

---

## Access Control

EMAIL uses its own permission and restriction flags, separate from FTN/QWK netmail:

| Transport | Permission Required | Restriction Flag | Default |
|-----------|-------------------|-----------------|---------|
| EMAIL | "Email" | "Email" | Require permission |

- Users need the "Email" permission flag to send internet email
- The "Email" restriction flag blocks email even for Sysop
- Sysop flag bypasses the permission requirement (but not the restriction)
- `getAllowedTransports(session)` includes EMAIL only when permitted

Admin flags in `admin.js`:
- Permission: `"Email"` in `BUILTIN_PERMISSIONS`
- Restriction: `"Email"` in `BUILTIN_RESTRICTIONS`

---

## Worker Integration

### Job Processing

The `email:outbound` job is handled in the toss processor:

```javascript
case 'email:outbound':
    await emailTosser.tossOutbound();
    break;
```

### Outbound Sweep

The periodic `outbound-sweep` job (all-protocol backstop) includes email. The sweep lives in `src/maintenance/outboundSweep.js` (`SWEEP_PROTOCOLS = ['tic', 'ftn', 'qwk', 'nntp', 'email']`); each protocol runs as an isolated step, so an email failure is logged and does not stop the others.

### Config Change Handling

Worker subscribes to `CONFIG_CHANGED` events and calls `emailTosser.resetTransporter()` to recreate the nodemailer transporter with updated relay settings.

---

## Deployment Architecture

### Typical Setup

```
Internet
    │
    ▼
┌─────────────┐     ┌──────────────┐
│ External MTA │────▶│ BBS Mail     │ port 1026 (trusted inbound)
│ (Postfix,   │     │ Process      │
│  Haraka)    │     │              │ port 10587 (SMTP submission)
└─────────────┘     │              │ port 10143 (IMAP)
    ▲                └──────┬───────┘
    │                       │
    │               ┌──────┴───────┐
    │               │ BBS Worker   │ email:outbound jobs
    │               │ Process      │
    │               └──────┬───────┘
    │                      │
    │               ┌──────┴───────┐
    └───────────────│ SMTP Relay   │ (Gmail, Mailgun, local Postfix)
                    │ (outbound)   │
                    └──────────────┘
```

### External MTA Configuration

The external MTA handles:
- **MX records**: DNS points to the MTA, not the BBS
- **TLS termination**: STARTTLS/implicit TLS for internet-facing connections
- **Spam filtering**: SpamAssassin, DKIM verification, SPF checks, DMARC
- **Forwarding**: Delivers accepted mail to `localhost:1026` (or configured port)

Example Postfix `transport_maps` entry:
```
mybbs.example.com    smtp:[127.0.0.1]:1026
```

### Outbound Relay Configuration

Any SMTP relay that accepts authenticated submissions:
- **Gmail**: `smtp.gmail.com:587`, app password, STARTTLS
- **Mailgun/SendGrid**: API credentials, dedicated sending domain
- **Local Postfix**: `localhost:25` or `localhost:587`, may not need auth

---

## Testing

`tests/emailTransport.test.js` (114 tests at 0.9.12a) covers:

- **IMAP adapter rendering** — EMAIL From/To headers, display name format, bare address fallback
- **SMTP address resolution** — external domains → EMAIL, .ftn/.qwk still correct
- **Trusted inbound mode** — rejects external domains, .ftn, .qwk, wrong domain
- **SmtpServer trusted host config** — comma parsing, defaults, non-trusted mode
- **Transport access control** — Email permission/restriction flags, Sysop override
- **SMTP message parsing** — plain text, multipart MIME, HTML-only, no body
- **Config defaults**: all 10 email keys exist with correct category and defaults

Related: `tests/mailStartup.test.js` (the `mailDisabledReason` rule) and `tests/mailServerMaintenance.test.js` (mail servers under maintenance mode).

---

## Key Design Decisions

1. **Smart relay over direct delivery**: The BBS does not handle MX lookups, TLS negotiation, retry queues, or bounce processing for outbound email. A configured relay (Gmail, Mailgun, local Postfix) handles all of that. This avoids the complexity and deliverability challenges of running a full MTA.

2. **Trusted inbound over open relay**: The inbound SMTP listener requires IP allowlisting and only accepts mail for local users. It is not an internet-facing mail server — an external MTA handles MX, TLS, and spam filtering, then injects clean mail into the BBS. This avoids exposing the BBS to spam, backscatter, and abuse.

3. **Separate permission flag**: EMAIL uses "Email" rather than sharing "Netmail" with FTN/QWK. Internet email has different risk profiles (spam, abuse, legal) than BBS network mail, so sysops need independent control.

4. **Batch limiting**: `email_max_outbound_batch` prevents a burst of queued messages from overwhelming the relay. Relay rate limits vary widely (Gmail: ~500/day, Mailgun: thousands/minute), so the sysop tunes this per their provider.

5. **Nodemailer over raw SMTP**: Nodemailer handles STARTTLS negotiation, AUTH mechanisms, MIME encoding, and connection pooling. Zero additional dependencies (nodemailer has none). Rolling a raw SMTP client would be fragile and incomplete.

6. **Transporter lazy-init with reset**: The nodemailer transporter is created on first use and recreated when config changes. This avoids connecting to the relay at startup (which may fail if not yet configured) while ensuring config changes take effect without a process restart.

7. **Two SmtpServer instances over mode flag**: The trusted inbound listener runs as a separate `SmtpServer` instance on a different port, rather than adding mode-switching logic to the existing submission server. Clean separation — different ports, different security models, different session behavior.

8. **Inbound delivers as EMAIL transport, not LOCAL**: Inbound internet email is stored with `transport_type: 'EMAIL'` so the IMAP adapter renders real email addresses and the UI shows the email origin. If it were stored as LOCAL, the sender's email address would be lost.
