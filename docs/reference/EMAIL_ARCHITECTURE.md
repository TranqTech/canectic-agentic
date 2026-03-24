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
| `configDefaults.js` | `src/config/` | Ten `email` category config keys. |
| `pm.js` | `src/routes/` | EMAIL address validation and transport_data building in web compose. |
| `mail.js` | `bin/` | Starts trusted inbound SMTP listener alongside existing IMAP/SMTP servers. |
| `worker.js` | `bin/` | `email:outbound` job handler in toss processor, email in outbound-sweep. |

---

## Configuration

All keys are in the `email` category in `configDefaults.js`, managed via Admin UI at `/admin/config`.

### Outbound Relay

| Key | Default | Description |
|-----|---------|-------------|
| `email_relay_host` | _(empty)_ | SMTP relay hostname. Empty = outbound email disabled. |
| `email_relay_port` | `587` | Relay port. 587 = STARTTLS, 465 = implicit TLS. |
| `email_relay_secure` | `false` | `true` = implicit TLS (port 465), `false` = STARTTLS (port 587). |
| `email_relay_user` | _(empty)_ | Relay auth username. |
| `email_relay_password` | _(empty)_ | Relay auth password. |
| `email_from_address` | _(empty)_ | Envelope From address (e.g. `bbs@mybbs.com`). Required for outbound. |
| `email_from_name` | _(empty)_ | Display name in From header. Falls back to `boardname`. |
| `email_max_outbound_batch` | `50` | Maximum emails sent per toss cycle. Prevents relay rate-limit issues. |

### Inbound Gateway

| Key | Default | Description |
|-----|---------|-------------|
| `email_inbound_port` | `0` | Trusted inbound SMTP port (e.g. 1026). `0` = disabled. Requires restart. |
| `email_trusted_hosts` | `127.0.0.1` | Comma-separated IPs allowed to inject without authentication. |

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
            → getPendingByTransport('EMAIL')
            → for each PM (up to email_max_outbound_batch):
              → nodemailer.sendMail() to configured relay
              → success: markSent(id, 'EmailTosser')
              → 5xx permanent: markOutboxUndeliverable(id, reason)
                → notifySenderUndeliverable() — bounce to sender inbox
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
        → deliverMessage() to pm_inbox
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

`SmtpServer` and `SmtpSession` support two modes controlled by constructor options:

### Submission Mode (default)

- Requires authentication (AUTH PLAIN or AUTH LOGIN)
- Resolves addresses across all transport types (LOCAL, FTN, QWK, EMAIL)
- External domains → EMAIL transport (new behavior)
- Access control enforced via `queueMessage(messageObj, session)`

### Trusted Inbound Mode

- Enabled by `SmtpServer(port, domain, { trusted: true, trustedHosts: '...' })`
- Connecting IP verified against `_trustedHosts` Set — rejected if not trusted
- Authentication skipped — `SmtpSession.authenticated` defaults to `true`
- `_resolveAddress()` short-circuits: only resolves local users on `mail_domain`
- Rejects all external domains, `.ftn`, `.qwk` (no outbound relay from trusted port)
- `_processInboundData()` delivers directly via `deliverMessage()` (not `queueMessage()`)

### IPv6 Handling

Trusted host verification normalizes `::ffff:127.0.0.1` to `127.0.0.1` for IPv4-mapped IPv6 addresses.

---

## Email Tosser

`src/middleware/tossers/emailTosser.js` follows the same pattern as other tossers:

### Transporter Management

- Lazy-initialized nodemailer transporter from appConfig values
- `resetTransporter()` called on `CONFIG_CHANGED` events (worker subscribes)
- Returns `null` (skip) if `email_relay_host` is empty

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
- Permission: `"Email"` in `availablePermissions`
- Restriction: `"Email"` in `availableRestrictions`

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

The periodic `outbound-sweep` job (all-protocol backstop) includes email:

```javascript
try { await emailTosser.tossOutbound(); } catch (e) {
    alogger.writeAlog(3, "[Worker] Email outbound sweep error: " + e.message, "yellow");
}
```

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

41 tests in `tests/emailTransport.test.js` covering:

- **IMAP adapter rendering** — EMAIL From/To headers, display name format, bare address fallback
- **SMTP address resolution** — external domains → EMAIL, .ftn/.qwk still correct
- **Trusted inbound mode** — rejects external domains, .ftn, .qwk, wrong domain
- **SmtpServer trusted host config** — comma parsing, defaults, non-trusted mode
- **Transport access control** — Email permission/restriction flags, Sysop override
- **SMTP message parsing** — plain text, multipart MIME, HTML-only, no body
- **Config defaults** — all 10 email keys exist with correct category and defaults

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
