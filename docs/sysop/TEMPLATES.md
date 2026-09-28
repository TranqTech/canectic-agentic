# Message Templates

Message templates let you write reusable messages that are automatically delivered to users when specific events happen -- new user registration, email verification, birthdays, password resets, login milestones, and more. Each template can deliver via PM, email, netmail, or any combination. Sysops can also define custom events and fire them manually or on a schedule.

## Overview

- **Events** are the triggers (e.g. `user_registered`, `user_birthday`). Events come in two flavours:
  - **Built-in**: 15 events seeded on install, fired automatically from user lifecycle code, the QWK API and the daily maintenance job. Cannot be deleted.
  - **Custom**: Sysop-defined events with their own codes. Fired manually via admin UI, CLI, menu command, or timed event.
- **Templates** bind to events. A template specifies the subject, body, delivery methods, and optional conditions. Multiple templates can target the same event -- all matching templates fire in sort order.

Admin pages:
- `/admin/templates` -- list, create, edit, delete templates; test-fire a template to yourself
- `/admin/template-events` -- manage the event registry; add custom events
- `/admin/templates/fire` -- manually fire an event to a user or group

## Built-in Events

| Code | When it fires | Extra vars |
|---|---|---|
| `user_registered` | New account created | -- |
| `user_verified` | Email/netmail verification completed | -- |
| `password_reset_completed` | User successfully changes password via reset flow | -- |
| `user_purge_warning` | 1-3 days before an unverified account is auto-purged | `event.days_until_purge` |
| `user_first_login` | First successful login (logoncount = 1) | `event.login_number` |
| `user_nth_login` | Every login; use `conditions.nth_count` to filter which counts matter | `event.login_number` |
| `user_login_anniversary` | Daily, if today matches user's firstlogon date | `event.anniversary_years` |
| `user_account_anniversary` | Daily, if today matches user's created_at date | `event.anniversary_years` |
| `user_birthday` | Daily, if today matches user's birthdate | `event.age` |
| `user_dormant` | Daily for users inactive >= 30 days; templates filter by `conditions.days_inactive` | -- |
| `user_qwk_fetched` | A QWK packet downloaded or a REP uploaded through the REST API (not the web QWK page or the terminal) | `event.kind`, `event.area_count`, `event.message_count`, `event.posted_count`, `event.error_count` (see [API.md](API.md#template-event-integration)) |

Four more built-in events are listed on the Template Events page, `user_first_message_post`, `user_nth_post`, `user_first_file_upload` and `user_nth_upload`, but nothing fires them yet, so a template attached to one is never sent.

Birthday / anniversary / dormant events fire from the daily `user-maintenance` job. Ensure that job is enabled (it is by default).

## Template Fields

- **Name**: sysop-facing label (e.g. "Welcome New User")
- **Description**: sysop notes
- **Event**: pick from the registered event list
- **From (sender name)**: defaults to boardname if blank; can be a custom string like "The Sysop"
- **Subject**: template string with `{vars}`
- **Body (plain text)**: template string for PM, netmail, and email fallback. `{vars}` supported.
- **Body HTML**: optional rich HTML for email/web delivery. Same `{vars}` supported.
- **Conditions**: optional JSON filter. See below.
- **Delivery methods**: enable any combination of PM, Email, Netmail.
- **Active**: toggle for templates you're drafting or temporarily disabling.
- **Sort order**: when multiple templates fire on the same event, they fire in this order.

## Variable Substitution

Templates support `{var}` and `{nested.path}` substitution. Unknown tokens are left in place (surrounded by braces) so you can see which ones didn't resolve when testing.

**Standard vars (always available):**

- `{boardname}` -- from appConfig
- `{sysopname}` -- from appConfig
- `{sysop_alias}` -- from appConfig
- `{sitedomain}` -- from appConfig
- `{date}`, `{time}`, `{year}` -- current date/time

**User vars (available when an event fires for a user):**

- `{user.username}`, `{user.fullname}`, `{user.firstname}`, `{user.lastname}`
- `{user.email}` (the user's mailaddress)
- `{user.mailtype}` -- `email` or `netmail`
- `{user.location}`
- `{user.security}` -- security level integer
- `{user.logoncount}` -- total login count
- `{user.firstlogon}`, `{user.lastlogon}` -- dates
- `{user.birthdate}`, `{user.created_at}` -- dates

**Event-specific vars:**

Each event can expose additional vars under the `event.*` namespace. See the event row's "Variables" column on the Template Events page for what's available.

Booleans format as `yes`/`no`. Dates format as locale strings. Null values become empty strings.

## Conditions

Optional JSONB filter that narrows which users receive a template. All listed conditions must match (AND semantics).

| Key | Example | Meaning |
|---|---|---|
| `security_min` | `50` | User security level >= 50 |
| `security_max` | `100` | User security level <= 100 |
| `verified` | `true` | User is email/netmail verified |
| `has_email` | `true` | User has `mailtype=email` and a mailaddress |
| `has_netmail` | `true` | User has `mailtype=netmail` and a mailaddress |
| `nth_count` | `[1, 10, 100]` | Event-specific count (login_number, post_count, etc.) is in the list |
| `days_inactive` | `30` | User's lastlogon is >= 30 days ago (for `user_dormant`) |
| `permission_flags` | `["Sysop"]` | User has ALL listed flags |
| `restriction_flags` | `["Banned"]` | User has NONE of the listed flags |

Example condition for "fire this template only on 10th, 100th, and 1000th login":

```json
{"nth_count": [10, 100, 1000]}
```

## Delivery Behavior

Per-transport skip semantics: each enabled delivery method is independent.

- **PM**: always delivers if enabled. The message goes to the user's local inbox and fires a `pm_received` notification.
- **Email**: only delivers if the user has `mailtype=email` and a mailaddress on file, AND the email relay is configured in admin. Otherwise skipped with a log warning. See [MAIL.md](MAIL.md) for the full outbound relay setup.
- **Netmail**: only delivers if the user has `mailtype=netmail` and a parseable FTN address. Queued via the standard PM outbox for the next binkp session.

A template can enable all three safely -- users with only an email address will get PM + email; users with only netmail will get PM + netmail; users with neither will get PM only.

## Custom Events

Go to `/admin/template-events` and click **Add Custom Event**. Custom events need:

- **Code**: lowercase, letters/digits/underscores, must start with a letter (e.g. `custom_xmas_2026`, `door_completed`)
- **Label**: display name
- **Description**: what fires this event
- **Available variables**: comma-separated list documenting which vars templates can use

Custom events can be fired four ways:

### 1. Admin UI manual fire

Go to `/admin/templates/fire`. Pick the event and target (single user / all active / all verified). Optional extra JSON vars for event-specific data like `{"event":{"holiday":"Christmas"}}`.

### 2. CLI

```
node src/tools/fireEvent.js --event custom_xmas_2026 --all
node src/tools/fireEvent.js --event holiday_greeting --user bob --extra '{"event":{"holiday_name":"New Year"}}'
node src/tools/fireEvent.js --list
```

Useful for cron jobs, shell scripts, or external integrations.

### 3. Menu command

Add a menu entry with the command **Fire Template Event** (`fireEvent`) and the event code as its argument, optionally followed by `|` and JSON extra variables (`event_code|{json extra vars}`). It fires for the current session user and returns straight to the menu.

Example: fire a custom `door_played` event after a door launch, with the door slug as extra data:

```
command_name: fireEvent
command_arg: door_played|{"event":{"door":"LORD"}}
```

### 4. Timed events

Admin > **Timed Events** > add an event with launch type **Fire Template Event**. Enter the event code and an optional user filter SQL WHERE clause (restricted to safe columns; no DELETE/DROP/UPDATE/etc allowed). Runs on the configured cron schedule.

Example: send a monthly engagement message to active verified users on the 1st of the month at 9 AM:
- Launch type: Fire Template Event
- Event Code: `monthly_engagement`
- User Filter: `mailverified = true AND lastlogon > NOW() - INTERVAL '90 days'`
- Cron: `0 9 1 * *`

## Test Firing

On `/admin/templates`, each template row has a **send** (paper plane) icon. Click it to fire the template to yourself (the current admin user). Useful for verifying variable substitution and delivery before enabling broadly.

## Troubleshooting

- **Template doesn't fire**: check that the event code is correct, the template is active, and conditions (if any) match the target user. At log level 4 the system log shows `[Template] Event X fired for user Y: N delivered, M skipped` whenever a template was delivered or failed.
- **Email skipped**: user may not have an email address on file, mailtype may be set to netmail, or the email relay isn't configured (admin > config > email category). Full email troubleshooting is in [MAIL.md](MAIL.md#troubleshooting).
- **Netmail skipped**: user may not have a parseable FTN address.
- **Unresolved tokens in delivered message**: you typo'd a variable name; tokens that don't resolve are left in place with their braces so you can see what broke.
- **Built-in event hook doesn't fire**: the hook runs in try/catch so it won't block the host operation. Check the worker/gateway logs for `[Template]` messages. Birthday/anniversary/dormant events require the `user-maintenance` daily job to be running.
