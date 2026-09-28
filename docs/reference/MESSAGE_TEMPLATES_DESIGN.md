# Message Templates System Design

Event-triggered sysop-authored message templates with PM/email/netmail delivery.

**Status: implemented.** The post and upload milestone events were seeded but never fired until #82; see "Post and upload events".

## Motivation

Sysops needed a way to customise system-generated messages (welcomes, verifications, password resets) without editing code, plus new capabilities like birthday greetings, anniversaries, and dormant-user nudges. Previously these messages were hardcoded strings buried in `mailVerification.js` and `passwordReset.js`, with no facility for sysop customisation or new events.

The goal was a **generic event framework** where:
- Built-in events fire automatically from lifecycle hook points
- Sysops can create custom events and fire them manually or on a schedule
- Templates subscribe to events with delivery options and filtering conditions
- Variable substitution personalises per user
- All delivery routes through the existing PM outbox pipeline

## Architecture

### Data Model

**`message_template_events`** -- event type registry

| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| code | VARCHAR(64) UNIQUE | `user_registered`, `user_birthday`, `custom_xmas_2026` |
| label | VARCHAR(128) | sysop-facing display name |
| description | TEXT | explanation of what fires this event |
| is_builtin | BOOLEAN | built-ins seeded from JSON, cannot be deleted |
| context_schema | JSONB | list of available template vars for this event |
| created_at / updated_at | TIMESTAMPTZ | |

**`message_templates`** -- sysop-authored templates

| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| uuid | VARCHAR(64) UNIQUE | |
| name, description | VARCHAR / TEXT | sysop labels |
| event_code | VARCHAR(64) | references `message_template_events.code` |
| from_user | VARCHAR(64) | sender name; defaults to boardname |
| subject, body_text, body_html | TEXT | template strings with `{vars}` |
| deliver_pm, deliver_email, deliver_netmail | BOOLEAN | transport toggles |
| conditions | JSONB | optional filter (security_min, verified, nth_count, etc.) |
| active | BOOLEAN | draft/enabled toggle |
| sort_order | INTEGER | for multiple templates per event |
| last_fired_at | TIMESTAMPTZ | admin visibility |
| fire_count | INTEGER | admin visibility |

### Core API (`src/models/messageTemplates.js`)

**`fireEvent(eventCode, userId, extraVars)`** -- dispatch entry point for all paths.

1. Look up active templates for the event
2. Load the user record
3. For each template: evaluate conditions, apply substitution, deliver per enabled transport
4. Per-transport skip semantics: PM always delivers if enabled; email/netmail skip individually when the user lacks the required address (log warning, continue with other transports)
5. Update fire_count and last_fired_at on each successful fire
6. Return `{ fired, skipped, errors, templatesMatched }`

**`fireEventForMany(eventCode, userIds, extraVars)`** -- batch wrapper used by admin bulk fire, CLI, and timed events.

**Variable substitution** -- delegated to `src/utils/templateVars.js`:
- `applyTemplate(template, ctx)` -- pure `{var}` and `{nested.path}` replacement
- `buildContext(user, extraVars)` -- assembles standard + user + event vars
- Unknown tokens left in place (surrounded by braces) for debugging

### Delivery Pipeline

All delivery routes through `src/models/privateMessages.js`:

- **PM**: `deliverMessage({ user_id, ..., transport_type: 'LOCAL' })` -- inserts into `pm_inbox` and fires a `pm_received` notification
- **Email**: `queueOutbound({ transport_type: 'EMAIL', transport_data: { email_address } })` -- email tosser picks up from `pm_outbox`
- **Netmail**: `queueOutbound({ transport_type: 'FTN', transport_data: { destination, destination_zone/net/node } })` -- FTN mailer picks up

No parallel delivery code -- everything goes through the canonical PM pipeline. Delivery failures in one transport don't block others; template-level failures don't block host operations (all hook calls are wrapped in try/catch).

### Hook Points

Built-in event hooks, one-line `fireEvent` calls in try/catch:

| Event | File | Location |
|---|---|---|
| `user_registered` | `src/models/useraccounts.js` `createNewUser()` | after DB insert, pointer init, and sysop notification |
| `user_verified` | `src/models/mailVerification.js` `verifyCode()` | after `mailverified=true` + security bump |
| `password_reset_completed` | `src/models/passwordReset.js` `completeReset()` | after password update + token clear |
| `user_first_login` / `user_nth_login` | `src/models/useraccounts.js` `updateUserCalls()` | after `logoncount` bump; first_login only when newcount === 1 |
| `user_purge_warning` | `src/models/useraccounts.js` `purgeUnverifiedUsers()` | fired for users in their last 3 days before purge (loop runs before the actual DELETE) |
| `user_birthday` / `user_account_anniversary` / `user_login_anniversary` / `user_dormant` | `src/models/useraccounts.js` `runDailyTemplateEvents()` | called by the daily `user-maintenance` job in `src/maintenance/maintenanceJobs.js` (worker or embedded mode) |
| `user_qwk_fetched` | `src/routes/api/qwk.js` `logApiCall()` | after each successful `/api/v1/qwk/download` or `/qwk/upload`; not for web or terminal QWK transfers (see `API_DESIGN.md`) |

### Custom Event Fire Sources

Four independent paths, all calling the same `fireEvent` / `fireEventForMany` (plus a per-template Test button, `POST /admin/templates/:id/test`, which fires that template's event for the current sysop with `event.test_fire = true`, so other active templates on the same event fire too):

1. **Admin UI** -- `/admin/templates/fire` (route in `src/routes/admin.js`, view `src/views/admin/templates/fire.pug`). Targets: single user, all active, all verified.

2. **CLI** -- `src/tools/fireEvent.js`. Flags: `--event`, `--user`, `--all`, `--verified`, `--extra`, `--list`. Suitable for cron jobs and scripts.

3. **Menu command** -- `src/handlers/menucommands/fireEvent.js` + register in `src/handlers/menuhandler.js`. `command_arg` format: `event_code` or `event_code|{json}`. Fires for the current session user. Non-interactive; returns to menu immediately.

4. **Timed events** -- `timed_events` extended with `launch_type='FireEvent'` plus `fire_event_code` and `fire_event_query` columns. `src/maintenance/timedEventRunner.js` `_runFireEvent` builds `SELECT id FROM users WHERE active = true AND (fire_event_query)` with an unsafe-keyword guard (rejects DELETE/DROP/UPDATE/INSERT/TRUNCATE/ALTER/CREATE/semicolons/comment markers), then calls `fireEventForMany`.

### Seeding

`src/models/messageTemplates.js` `seedBuiltinEvents()` runs at startup from `bin/gateway.js` next to the other seed calls. Reads `config/default/message-template-events.json` and:
- Inserts events not already present
- Refreshes the label, description, and context_schema on existing built-in rows (so sysops get any updates from version upgrades)
- Never touches custom events or user-added event rows

Also registered in `src/tools/seedSync.js` as `message-template-events` so the standard `seedSync` tool can reconcile on demand. Context schema is in `skipColumns` to preserve per-event overrides if sysops edit schemas via admin UI.

### Condition Evaluation

Pure function `evaluateConditions(conditions, user, extraVars)`:

| Key | Check |
|---|---|
| `security_min` / `security_max` | user.security range |
| `verified` | `user.mailverified === value` |
| `has_email` / `has_netmail` | mailtype + mailaddress present |
| `nth_count` | event.login_number / post_count / upload_count matches array |
| `days_inactive` | user.lastlogon >= N days ago |
| `permission_flags` | all listed flags present on user |
| `restriction_flags` | none of the listed flags present on user |

All conditions ANDed. JSON parsed on first access; invalid JSON treated as "no conditions" (pass through).

## Security Considerations

- **sanitizeMessageFields** is called by the PM pipeline on the final rendered body_text/body_html, so templated content is scrubbed before storage/delivery.
- **Custom event codes** validated against `/^[a-z][a-z0-9_]*$/` to prevent SQL injection via the code field.
- **Timed event `fire_event_query`** runs a sanitiser rejecting common SQL modification keywords and semicolons. It's not a full SQL parser -- sysops with admin panel access can still construct harmful queries if they try hard enough -- but it blocks the common accidents.
- **Rate limiting** is intentional: templates can fire 1000s of times in bulk scenarios. The batch fire path processes users sequentially to avoid overwhelming the PM outbox / mailer.
- **Built-in event guard**: `deleteEvent()` refuses to delete rows where `is_builtin = true`, and `updateEvent()` only lets sysops change label/description on built-ins (not the code or schema).

## Testing

Unit tests in `tests/messageTemplates.test.js` cover:
- `applyTemplate()` token substitution (single, nested, unknown, boolean, date, null)
- `buildContext()` variable assembly (standard + user + event)
- `evaluateConditions()` all 10 condition types and AND combinations
- Export validation for both modules

DB-dependent paths (full fireEvent roundtrip, admin CRUD, hook firing) require a test database harness which is not yet set up. Manual verification is documented in the Phase 5 checklist of the design plan.

## What's Not Included (Deferred)

- **Post and upload events (built, #82).** `users.post_count` / `users.upload_count`, kept by `src/models/userActivity.js`: `recordPost` from `messages.startNewThread` / `replyToThread` when the post carries a local author (`formObj.user_id`, which the web routes set from the session and never from the form, the terminal editor from the call, QWK REP from the user), and `recordUpload` from `fileEntries.addFileEntry` for an entry with an `uploader_uuid` (not TIC or scans). First fires at count 1, nth on every post/upload with the count, as login does. Posts now store `user_id` in `mb_*_msgs`; before #82 no local post did, so migration `0009-user-activity-counts` backfilled by id where set and otherwise by From name (username or full name) over rows with no `tosser_id` or `source_network_id` and not imported (`backfillPostCounts`, pure); uploads by `uploader_uuid`. Two users sharing a full name are both credited: the known limit of a best-effort count.
- **Upload milestone hooks** -- same situation.
- **Template preview / variable picker UI** -- the admin edit modal has a static reference panel listing standard vars. A dynamic "insert variable" dropdown driven by `context_schema` would be a future polish.
- **TinyMCE for body_html** -- the admin UI uses plain textareas for both body_text and body_html. Adding TinyMCE to match the announcements pattern is a future polish.
- **Example templates shipped inactive** -- planned but deferred in favour of clean docs. Sysops can author from the admin UI using this design doc + `docs/sysop/TEMPLATES.md` as reference.

## Related Files

**New:**
- `src/models/messageTemplates.js` -- CRUD + dispatch + condition engine + seed
- `src/utils/templateVars.js` -- substitution helper
- `src/tools/fireEvent.js` -- CLI
- `src/handlers/menucommands/fireEvent.js` -- menu command
- `src/maintenance/timedEventRunner.js` `_runFireEvent()` -- timed-event dispatcher
- `src/views/admin/templates/index.pug` + `fire.pug`
- `src/views/admin/templateEvents/index.pug`
- `db/schema/tablecolumns/message_template_events.conf`
- `db/schema/tablecolumns/message_templates.conf`
- `config/default/message-template-events.json`
- `tests/messageTemplates.test.js`

**Modified:**
- `bin/gateway.js` -- seed on startup
- `src/maintenance/maintenanceJobs.js` -- daily event scan in the `user-maintenance` job (originally `bin/worker.js`; the job switch now lives here for both worker and embedded mode)
- `src/models/useraccounts.js` -- user_registered, login milestones, purge warning, runDailyTemplateEvents
- `src/models/mailVerification.js` -- user_verified
- `src/models/passwordReset.js` -- password_reset_completed
- `src/models/timedEvents.js` -- FireEvent launch type, fire_event_code/query columns
- `db/schema/tablecolumns/timed_events.conf` -- new columns, command nullable
- `src/routes/admin.js` -- /admin/templates, /admin/templates/fire, /admin/template-events routes
- `src/views/admin/dashboard.pug` -- Content card
- `src/views/includes/admin-nav.pug` -- Content dropdown entries
- `src/views/admin/timedEvents/index.pug` -- FireEvent launch type fields + toggle JS
- `src/tools/seedSync.js` -- register seed
- `docs/sysop/TEMPLATES.md` -- sysop guide
- `docs/sysop/CHANGELOG.md` -- pending release entry
- `docs/RELEASE_TRACKER.md` -- roadmap item
- `CLAUDE.md` -- models list, CLI tools
