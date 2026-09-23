# Canectic BBS — Message Architecture Reference

## Overview

The shared message platform sits between the networking layer (FTN/QWK/NNTP tossers) and the presentation layers (web views, terminal handlers). This document covers everything that both sides consume: the data model, schemas, read tracking, body formatting pipeline, subscriptions, posting, sanitization, web view architecture, and maintenance tools.

For the networking/tosser stack, see `NETWORKING_ARCHITECTURE.md`.
For the terminal-side UI (readers, editors, menus), see `terminal_architecture.md`.
For the web application (Express, sessions, admin panel, WebSockets), see `web_architecture.md`.
For the process model, job queues, and inter-process signaling, see `PROCESS_ARCHITECTURE.md`.

---

## Core Files

### Models (shared business logic)

| File | Purpose |
|------|---------|
| `messages.js` | **Canonical message model** (post April 2026 consolidation). Owns all message CRUD, posting, threading, sanitization, and read operations. **Viewing:** `listMsgGroups(userSecurity)`, `getAreasInGroup(shortcode, userSecurity)`, `getMessage`, `getMessageById`, `getMessageCount`, `countMessagesBefore`, `getMessages` (paginated), `getMessagesForThread`, `getMessagesForArea`, `getThreadsForArea`, `getRecentThreadsForArea`, `getThreadsPage` (keyset pagination), `getThreadCount`, `getThreadByUUID`, `getThreadUUIDMap` (batch lookup), `buildMessageTree`, `formatBodyHtml` (re-exported from `terminalText.js`). **Posting:** `startNewThread`, `replyToThread`, `saveMessage` (dispatcher), `resolveAreaAddress(areaId)` (origin line and FTN address resolution). **Unified threading** (called by all three tossers FTN/QWK/NNTP): `threadMessage(message, messagetable, threadtable, shortcode)` — 4-step algorithm: Step A (pre-assigned threadid) → Step B (reply_to MSGID lookup, case-insensitive) → Step C (subject match, case-sensitive, 365d for replies/30d for new) → Step D (guaranteed thread creation). No message exits with NULL threadid. `getExistingThreadBySubject` — subject-based matching helper. `createThreadRow`, `updateThreadStats`, `rollbackThread` — low-level thread helpers. **Inbound orchestrator:** `handleInboundEchoMessage(message)` — called by FTN tosser; delegates FTN-specific conversion to `echomail.ftnToDb` then runs unified threading and insertion. **Thread update queue:** `threadUpdateArray`, `drainThreadUpdateArray`, `pushThreadIdToUpdateQueue`. **Orphan reconciliation:** `pushImportedMsgId`, `drainImportedMsgIds`, `reconcileOrphans(shortcode, batchMsgIds)` (post-batch re-linking), `applyThreadingForArea(shortcode)` (retroactive orphan repair). **Thread maintenance:** `updateThread`, `updateThreadArray`, `updateDailyThreads`, `updateAreaThreads`, `mergeThreads`, `mergeRecentThreads`. **Security:** `sanitizeMessageFields` — strips dangerous HTML and URIs; called by user posting and importable by tossers. **Deletion:** `deleteMessageByUUID`, `deleteThreadByUUID`. **Moderation:** `moderationForArea`, `moderationFor`, `attachModeration`, `moderationTargetAllowed`, `buildMoveTargets`, `networkedAreaIds`, `canMoveMessageToArea`, `areaIsNetworked`, `threadOriginSummary`, `moveThreadToArea`, `moveMessageToArea`, `messageForClient` (wire shape shared by both lazy-load endpoints). See the Moderation section. |
| `userMsgPointers.js` | Message read tracking model. Two-tier pointer system: area-level scan pointers (`user_msg_pointers`) and per-thread pointers (`user_thread_pointers`). Area pointer is a floor — any message with `id <= area_pointer` is read. Thread pointers add granularity above the floor. Effective read threshold for a thread: `MAX(area_pointer, COALESCE(thread_pointer, 0))`. Provides: `advancePointer`, `advanceThreadPointer`, `markAreaRead`, `getThreadUnreadCounts` (batch), `getUnreadCount`, `hasNewMessages`, `getNewscanSummary`, `getFirstUnreadInThread`, `getFirstUnreadInArea`. Pre-populates pointers on user/area creation. Table bootstrap via `ensureConstraintsAndIndexes()` at startup. |
| `userAreaSubs.js` | User area subscription model for newscan filtering. `getSubscriptionMap(userId)` returns `Map<shortcode, boolean>` resolving: user override → area `newscan_default` → true. `getSubscription(userId, shortcode)`, `setSubscription(userId, shortcode, subscribed)`, `removeSubscription(userId, shortcode)` for individual management. Used by terminal newscan, area selector, and future web newscan. |
| `msgAreas.js` | Message area CRUD. `newArea` (creates area record, backing tables, pointer rows, network mapping, area count recalculation), `updateArea`, `removeArea` (with cascading cleanup of pointers, subscriptions, optional table deletion), `recalculateAreaCounts` (correlated UPDATE from actual data, called on every add/remove). `normalizeFlags(input)` — coerces form input (string, array, or undefined) to JSON array for JSONB storage. Schema includes `thread_mode`, `post_as`, `newscan_default`, `ansi_area`, and four flag JSONB columns (`read_perm_flags`, `read_rest_flags`, `post_perm_flags`, `post_rest_flags`). |
| `msgGroups.js` | Message group CRUD. `getGroupByShortcode`, `getActiveGroups`, `getAllGroups`, `getAllGroupsWithAreas`, `newGroup`, `updateGroup`, `removeGroup` (cascading area removal). `normalizeFlags(input)` — same coercion as `msgAreas.js`. Schema includes `read_security`, `post_security`, and four flag JSONB columns (same names as areas). Groups act as default templates — new areas inherit the parent group's security levels and flags. |
| `echomail.js` | FTN protocol helpers only (post April 2026 consolidation). `ftnToDb(ftnMessage)` — converts FTN message object to DB row format. `dbToFtn(dbMessage)` — reverse conversion for outbound delivery. `getOutboundForConnection(conn)` — builds outbound message list for an FTN peer. All message reads, posting, threading, and inbound handling now live in `messages.js`. |

### Text Formatting Pipeline

| File | Purpose |
|------|---------|
| `terminalText.js` | Terminal text formatter and shared HTML body generator. `VirtualTerminal` class converts ANSI escape codes, pipe codes (`|XX`), and Synchronet Ctrl-A attribute codes to HTML with CSS classes. Supports cursor positioning, color, and a virtual terminal buffer. **`noWrap` mode**: when enabled, lines extend without column wrapping — CSS handles responsive layout. Smart space handling in noWrap mode: single spaces between words stay as regular ` ` (browser can word-wrap), leading/multi-spaces use `&nbsp;` (preserves formatting). **`formatBodyHtml(displayText, forceWidth)`**: consolidated HTML formatter used by all three tossers and the maintenance regeneration tool. Pipeline: ANSI art detection (`detectAnsiArt`) on the RAW text → paragraph reflow (`reflowText`), SKIPPED when the body is art → routing: art uses fixed-width VT, colored text uses noWrap VT, plain text uses `formatTextForHtml` or `<br>` replacement. **Two causes FIXED Sep 2026 (see issue #50); the Othernets symptom remains open as #48.** The order was wrong: reflow ran before anything asked whether the body was art, and `reflowParagraphs` joins any consecutive line at or above the width threshold, which every 78-to-80 column art row is. Three rows collapsed to one, and detection then ran on the wreckage. Separately `detectAnsiArt` only counted cursor positioning, so art built from SGR colour plus CP437 block glyphs read as ordinary coloured text; that half affected the terminal too. Both are fixed: `formatBodyHtml` now detects on the RAW text and skips reflow for art, mirroring what `processMessageBody` always did, and `detectAnsiArt` carries a second signal for block-drawn art (two or more art-like lines, at least one 40+ columns wide). The deliberate trade is that prose carrying two or more full-width rules now reads as art and loses reflow; no shape test separates the two, and reflow was previously merging such a rule onto the preceding sentence anyway. `body_html` is pre-rendered at toss time, so this does not repair stored messages: those need `maintenance.js --regen-html`, and only recover if `body_text` survived import intact. Whether these fully explain the Othernets symptom is NOT settled — a raw sample off the hub is still wanted, and a separate encoding fault there is suspected. |
| `termMsgFormat.js` | Terminal message body formatting pipeline. CP437↔UTF-8 conversion, pipe/Ctrl-A/ANSI code conversion, semantic line classification (`classifyLine` → NORMAL/QUOTE/TEAR/TAGLINE/ORIGIN/KLUDGE), paragraph reflow (`reflowParagraphs` at 80% threshold reassembles text from wider editors), ANSI art detection (`detectAnsiArt` — cursor positioning CSI sequences, plus a second signal for block-drawn art via `artLineWidths`), and ANSI-aware word wrapping (`wordWrapLineAnsi` with `measureVisualWidth`/`findStringIndexAtVisualCol`). Exports `reflowText(text, wrapWidth)` — normalizes line endings, reflows, joins with `\r` for VirtualTerminal compatibility. Does NOT import `terminalText.js` (dependency flows one direction only). |
| `codepageConversions.js` | Shared CP437↔UTF-8 conversion utilities. `formatTextForHtml()` for lightweight space-preservation formatting of plain text with alignment. HTML entity escaping as defense-in-depth against XSS. |

### Routes

| File | Purpose |
|------|---------|
| `index.js` | User-facing message routes. Shared middleware injects `boardname`, `faviconlink`, `currentPath`, `DateTime`, `ismobile`. Helpers: `getCurrentUser`, `resolveUserId`, `resolvePostName`, `parseFlags`, `checkAreaReadAccess`, `checkAreaPostAccess`. Access checks combine security level + permission flags (must have ALL) + restriction flags (must have NONE). Works on both group and area objects (same column names). All area/thread routes pass `sufficientAccess` and `canPost` booleans. Group listing filters groups and areas by `checkAreaReadAccess`, hides groups with zero accessible areas. Area listing gates group access and filters child areas. All JSON lazy-load endpoints use `checkAreaReadAccess`. POST routes use `checkAreaPostAccess`. Guard chain pattern in templates. Bidirectional lazy scroll with auto-fill for short content. Mark-area-read. |

### Views

| File | Purpose |
|------|---------|
| `messages/index.pug` | User-facing message group listing. Groups and their areas filtered by `checkAreaReadAccess` (security + flags). Groups with zero accessible areas hidden. Aggregate unread counts per group computed from accessible areas only. |
| `messages/groups/view.pug` | User-facing area listing within a group. Group-level read access checked. Areas filtered by `checkAreaReadAccess`. Per-area unread counts, last post info. |
| `messages/areas/view.pug` | Threaded area view. Thread listing table with keyset-paginated lazy scroll. Unread badges per thread. New Thread modal. Mark Read button. Flat View toggle. |
| `messages/areas/flat.pug` | Flat area view. Guard chain: `!currentuser` → login, `!sufficientAccess` → unauthorized, `!msgArea` → not found. Column layout: `col-xl-6.offset-xl-3.col-lg-10.col-12`. Sidebar hidden below xl, replaced with offcanvas (hamburger ☰). Desktop nav buttons hidden on mobile. Stacked message headers. `data-force80` and `data-can-post` on container. Post/Reply buttons, modals, quote system, and JS `buildMsgHtml` all gated behind `canPost`. Auto-fill for short content (loads older messages when initial batch doesn't overflow container). |
| `messages/areas/thread.pug` | Thread reader. Same guard chain, column layout, offcanvas, and `canPost` gating as flat.pug. `← Threads` button hidden on mobile. Stacked message headers. Bidirectional lazy scroll from first unread with auto-fill for short content. Reply modal with quote panel. |
| `partials/messages/_msgAutoSize.pug` | Loads `public/js/readerWidth.js`, which sizes each `.messagebody` to a column count (#54): 80 on desktop (≥992px); below that the view's 40 or 80 (the reader's choice per area in localStorage, else `data-force80` from `ansi_area`, else 40), and 80 for any body with `data-art` whatever the view. Min 7px, max 32px, `setProperty('font-size', px, 'important')`. Exposed as `window.fitMessageBodies`. `partials/messages/_readerWidth.pug` is the 40 \| 80 switch (`d-lg-none`). |

### Maintenance

| File | Location | Purpose |
|------|----------|---------|
| `messageBase.js` | `src/maintenance/` | `regenerateAllBodyHtml(options)` and `regenerateAreaBodyHtml(shortcode, options)`. Iterates active areas, regenerates `body_html` from `utf8`/`body_text` using current `formatBodyHtml` pipeline. Keyset pagination by id. Options: `areas`, `batchSize`, `dryRun`, `forceWidth`, `onProgress`, `quiet`. |
| `maintenance.js` | `src/tools/` | CLI runner. Enqueues maintenance jobs on the BullMQ `maintenance` queue and waits for completion. `--regen-html`, `--regen-pm-html`, `--purge-pm-trash`, `--recalc-counts`, `--area SHORTCODE` (repeatable), `--dry-run`, `--width N`, `--batch N`, `--days N`. Concurrency managed by BullMQ jobId deduplication (replaces PID-file locking). See `PROCESS_ARCHITECTURE.md`. |

---

## Database Schema

### message_groups

Each row represents a message group containing one or more areas. Groups provide default security and flag settings that new areas inherit.

- `id` (BIGSERIAL), `uuid` — identifiers
- `name`, `description` — display info
- `shortcode` — unique internal identifier
- `read_security`, `post_security` — default security levels for child areas. `listMsgGroups()` filters by `read_security`. **Note:** the legacy `security` column has been removed; `read_security` replaces it for group visibility gating.
- `read_perm_flags`, `read_rest_flags` — JSONB arrays. Default read permission/restriction flags for child areas.
- `post_perm_flags`, `post_rest_flags` — JSONB arrays. Default post permission/restriction flags for child areas.
- `area_count` — cached count of child areas
- `active` — boolean
- `created_at`, `updated_at`, `created_by_uuid`, `created_by_name`

### message_areas

Each row represents a message area (forum/conference) belonging to a message group.

- `id`, `uuid` — identifiers
- `name`, `description` — display info
- `shortcode` — unique internal identifier, used to derive backing table names (`mb_<shortcode>_msgs`, `mb_<shortcode>_threads`)
- `group_shortcode`, `group_id`, `group_uuid` — FK to parent group
- `read_security`, `post_security` — minimum security level to read/post
- `read_perm_flags`, `read_rest_flags` — JSONB arrays. Required permission flags / blocking restriction flags for read access. User must have ALL permission flags and NONE of the restriction flags.
- `post_perm_flags`, `post_rest_flags` — JSONB arrays. Same pattern for post access.
- `min_age`, `max_age` — age restrictions for participants
- `active` — boolean
- `msg_count`, `last_message`, `last_from`, `last_subject`, `last_id` — cached stats
- `thread_mode` — VARCHAR(16), DEFAULT 'standard'. Controls threading behavior:
  - `standard` — normal threaded view with thread listing
  - `no_threads` — flat message list only, no thread grouping
  - `subscribe_only` — (future) only show subscribed threads in newscan

  Also on `message_groups`, where it is the default a new area inherits when
  the create form does not specify one. An explicit choice on the area form
  wins, and Push Group Defaults can apply the group value to existing areas
  (unticked by default, since it replaces a per-area choice).

  The three values are defined once in `src/utils/threadMode.js` and validated
  from there by both models and both admin forms. They were previously checked
  by four inline copies of the same array, and an unrecognised value is
  silently replaced with `standard` rather than rejected, so a copy falling out
  of step would quietly return an area to threaded on some paths and not
  others. `normaliseThreadMode(value, fallback)` coerces; `isThreadMode(value)`
  is separate so an update can distinguish "not submitted" (leave the stored
  value alone) from "submitted as nonsense" (do not write it).
- `post_as` — VARCHAR(16), DEFAULT 'username'. Controls how the poster's name appears:
  - `username` — posts display the user's login name
  - `realname` — posts display the user's full name (falling back to username)
- `newscan_default` — BOOLEAN, DEFAULT true. Whether this area is included in newscan by default for users who haven't set an explicit override. Resolved by `userAreaSubs.getSubscriptionMap()`: user override → this column → true.
- `ansi_area` — BOOLEAN, DEFAULT false. "Mostly ANSI art": the web reader starts this area at 80 columns on phones instead of 40 (#54). Set on the area form; `message_groups.ansi_area` is the default a new area inherits when the form does not say, and Push Group Defaults can apply it (unticked by default), the same shape as `thread_mode`. It only chooses the starting width; readers can switch, and messages detected as art show at 80 regardless. It does not control whether escape sequences survive or whether text is reflowed. Unsettable from March to September 2026 (#49).

### Message tables (per area)

Each message area has `mb_<shortcode>_msgs` and `mb_<shortcode>_threads` tables.

Key columns on message records:
- `msg_id` — canonical message ID (from @MSGID kludge or HEADERS.DAT Message-ID)
- `qwk_msg_id` — QWK-specific dupe ID: `{connectionUUID}:{confNum}:{msgNum}`
- `nntp_msg_id` — NNTP Message-ID (separate column, allows cross-posting)
- `source_network_id` — which network this message originated from (for echo suppression)
- `origin_line` — extracted origin/tagline (stored separately, may be stripped from body)
- `body_text` — message body (CP437 if from QWK/FTN, UTF-8 if from NNTP or local)
- `utf8` — UTF-8 version of body (null if body_text is already UTF-8)
- `body_html` — pre-rendered HTML for web display (see body_html Pipeline below)
- `thread_id`, `threadid`, `reply_to` — threading

Thread table columns:
- `id` (BIGSERIAL), `uuid`, `threadid` (FTN message-ID of root)
- `subject`, `started_at`, `started_by`
- `message_count`, `last_message`, `last_message_from`

---

## Moderation

Deleting and moving other people's messages. Gated on `areaAccess.canModerateArea()`,
which is the Sysop permission flag today and takes the area as an argument so
per-group and per-area moderators plug in at one place (issue #40).

### The answer travels with the message

Every view that shows a message asks the same question, so the question is
answered once, in `messages.js`, and attached to the item:

```js
var targets = await messages.buildMoveTargets(user, area.shortcode, checkAreaPostAccess);
area.moderation = messages.moderationForArea(user, area, targets);
messages.attachModeration(user, area, messageList, targets);
```

- `moderationForArea(user, area, targets)` gives `{ enabled, targets }`: may this
  user moderate here at all, and every destination before any one item narrows
  the list. Views use it to decide whether to render the dialogs.
- `moderationFor(user, area, item, targets)` gives
  `{ canDelete, canMove, fromNetwork, targets }` for one message or thread.
- `attachModeration(user, area, items, targets)` stamps `.moderation` on a list
  in one pass. It stamps a refusal too, so a view never has to tell "not
  computed" apart from "no".

Consumers read `item.moderation` and render it. They do not read permission
flags, and they do not look at `source_network_id`. The web thread and flat
views, both lazy-load endpoints and the terminal reader all go through this, so
a rule tightened here reaches all of them.

`buildMoveTargets` resolves the networked flag for every area with a single
query (`networkedAreaIds()`), not one query per area.

### The move rule

Re-export from the new area is the point of moving, not a hazard. The rule
guards provenance instead:

| Origin | May move to |
| --- | --- |
| Written locally (`source_network_id` null) | any area, networked or not |
| Arrived from a network | local-only areas |

So this system publishes its own mail wherever the sysop likes, and never
republishes someone else's into a network it did not come from. A message
carries its origin in `source_network_id`; a thread is as restricted as its most
restricted message, which `threadOriginSummary()` reports as `anyFromNetwork`.

`moderationTargetAllowed(fromNetwork, targetIsNetworked)` is the single line
both the decorator and the route guard read. `canMoveMessageToArea()` is the
same rule with a sysop-facing reason string, used by the routes to refuse a
posted destination regardless of what the browser offered.

Moving copies the row into the destination table and drops the `id`: ids are per
area and carry outbound high water mark meaning, so reusing one would put the
message behind peers' pointers and it would never be exported.

### Where the controls live

On the thread and flat views, where the message body is on screen: a thread
control in the thread header, and one per message in both views. Deliberately
not on the area's thread list, which shows subject lines only, where removing
something means removing content the moderator has not read.

Both views render messages twice, server side and again in JS as they lazily
append. `messages.messageForClient()` is the single definition of the wire
shape so the two halves cannot disagree about which fields exist.

### Terminal

`msgReader.js` reads the same `.moderation` field. `D` deletes and `M` moves
from the message view, both confirmed, with a scope question first
(message or whole thread) when a thread is on screen. Move shows a lightbar
list of the destinations that message's own answer allows. The dumb-terminal
path gets the same operations with a numbered list, and an open prompt owns the
keyboard until it is answered.

Messages are decorated in `_updateMessageBounds()`, which every load path ends
in, rather than at each of the six load sites.

### What deleting does not do

It removes the message from this system. Anything already sent to peers stays
where it is, and a peer may send it back on a later rescan. The dialogs say so.

---

## Retention

Optional per-area pruning of old messages. **Both limits default to NULL, and
NULL means keep everything**, so a fresh install and every existing area prune
nothing until a sysop opts in. Intended for areas that are inherently
disposable: nodelist distribution, BBS ads, announcement echoes.

| Column | On | Meaning |
|---|---|---|
| `max_age_days` | `message_areas`, `message_groups` | remove messages older than N days |
| `max_messages` | `message_areas`, `message_groups` | keep the N newest, remove the rest |

The group copies are defaults seeded into new areas created in that group, the
same relationship `file_groups` has with `file_areas`. To reach areas that
already exist, use `msgGroups.pushDefaultsToAreas(shortcode, ['retention'])`,
exposed as a Retention tickbox in the Push Group Defaults modal on the group
page.

That tickbox is **unticked by default**, unlike the other push fields. Both
retention columns are nullable and null means no pruning, so pushing retention
from a group with no limits set turns pruning off on every area in the group.
The modal warns when the group is in that state. `file_groups` has the same
property and ticks its Retention box by default, which is worth knowing before
using it.

Enforcement: `messages.enforceRetentionLimits()`, run by the
`message-maintenance` job at 04:00 daily. Both limits combine, so an area can
cap age and count together.

### Age is the message's own date

`max_age_days` measures against `COALESCE(system_time, created_at)`, the date the
message carries, not when it arrived. That is what a sysop means by "keep 90
days" and matches Synchronet and Mystic.

**This has a sharp edge for migrations.** A JAM or SMB import keeps the original
dates, and real imports on this system show lag between message date and import
date of up to 1999 days. So setting `max_age_days = 90` on an area holding a
freshly imported base will prune nearly all of it on the next run. That is
correct behaviour for the stated rule, but surprising, which is what the preview
endpoint exists for.

### Pruning is per message, not per thread

In FTN a reply whose parent has already rolled off the base is the normal state
of the network. Every node prunes at its own depth, and `threadMessage()` never
produces a NULL thread, so an orphaned reply still lands somewhere sensible.
Whole-thread pruning would also mean a single late reply keeps an ancient thread
alive indefinitely, which defeats the purpose on a busy ads or nodelist area.

Thread rows are kept honest afterwards, which matters because the reader lists
threads straight out of the thread table and orders by `last_message`:

- threads that lose some messages get `message_count` and `last_message` recomputed
- threads left with no messages are deleted, along with their `user_thread_pointers` rows
- area counters are refreshed via `msgAreas.updateStatsForArea()`

### Retention overrides peer high water marks

Echomail export runs `WHERE id > msg_idx` against `peer_area_subscriptions`, so
a pruned message is simply absent from a lagging peer's next feed. Nothing is
corrupted by pruning above a watermark.

An earlier version treated the lowest enabled `msg_idx` as a hard floor and
refused to prune past it, so nothing was deleted before every peer had
collected it. That is the right instinct and the wrong rule: one downlink that
stopped polling a year ago pins the floor at its old position and retention
silently does nothing, forever. A hub cannot have its message base held hostage
by a dead link, and the mail that peer "loses" was never going to be collected.

So retention is authoritative. After a prune, any subscription whose `msg_idx`
falls below the highest pruned id is dragged forward to it. That changes no
behaviour on the wire, since export would skip the deleted rows regardless; it
keeps the recorded position meaningful and stops the loss being invisible.

Both the real run and the preview report it:

```
peersAdvanced: 1
peersBehind: [{ peer, connectionUUID, previousIdx, messagesLost }]
```

and each advance is logged at level 2 naming the peer and the count. A sysop
setting a limit on an area with a lagging downlink sees what it will cost
before committing.

### Preview before committing

`GET /admin/msgArea/:shortcode/retention/preview` reports what a prune would
remove and deletes nothing. Optional `max_age_days` / `max_messages` query
parameters preview a limit **before it is saved**, which is the safe way to set
one on an area holding imported mail.

Both preview and the real run call the same `pruneArea()` selection logic, so
they cannot disagree.

## body_html Pipeline

All three tossers and the maintenance tool use `formatBodyHtml()` from `terminalText.js` — the single source of truth for HTML generation.

### Pipeline Steps

```
displayText (utf8 or body_text)
  → reflowText(text, wrapWidth)
      normalizes \r\n → \n, \r → \n, splits into lines
      reflowParagraphs(): normal text lines at ≥80% wrapWidth joined with next line and re-wrapped
      joins with \r (VirtualTerminal expects \r for line breaks)
  → detect color codes: \x1b[, |XX, \x01
      → if found:
          detectAnsiArt(): cursor positioning CSI (CUP, CUU/CUD/CUF/CUB),
                            or 2+ block-glyph lines with one 40+ wide
          NOT just color-only SGR
          → ANSI art: fixed-width VirtualTerminal (terminalWidth, wrap enabled)
          → colored text only: noWrap VirtualTerminal (CSS handles responsive layout)
      → if no color codes:
          triple-space alignment (3+ consecutive spaces) → formatTextForHtml()
          plain text → \r → <br> replacement
```

### VirtualTerminal noWrap Mode

When `noWrap` is true, the VT line buffer extends without column wrapping. `toHTML()` uses context-aware space handling:

| Space context | noWrap mode | Fixed-width mode |
|---|---|---|
| Single space between words | Regular ` ` (browser can wrap) | `&nbsp;` |
| Leading spaces (indentation) | `&nbsp;` | `&nbsp;` |
| Run of 2+ consecutive spaces | `&nbsp;` | `&nbsp;` |
| Trailing spaces | Trimmed | Trimmed |

### Non-Fatal Generation

`formatBodyHtml` is wrapped in try/catch and returns null on failure. Import succeeds without HTML — the view layer falls back to `body_text`. Older messages may have stale HTML from a previous pipeline version; `maintenance.js --regen-html` regenerates all stored body_html.

---

## Message Read Tracking

### Overview

Two-tier pointer system using area-level and thread-level scan pointers. The area pointer acts as a floor: any message with `id <= area_pointer` is considered read regardless of thread pointers. Thread pointers add per-thread granularity above the floor.

This design avoids per-message tracking rows (which would create massive tables) while correctly handling the interleaved nature of threaded messages (where thread A might have messages 10, 15, 22 and thread B has 12, 18, 55 — reading thread A shouldn't mark thread B's messages as read).

### Schema

#### user_msg_pointers

One row per user per area. Pre-populated when areas are created (all users get a row with pointer=0) and when users are created (new user gets rows for all areas with pointer set to current max message ID so history doesn't appear as "new").

```sql
CREATE TABLE user_msg_pointers (
    id SERIAL PRIMARY KEY,
    user_id INTEGER,
    area_shortcode VARCHAR(64),
    scan_pointer INTEGER DEFAULT 0,
    last_read_at TIMESTAMP,
    UNIQUE(user_id, area_shortcode)
);
CREATE INDEX idx_ump_user ON user_msg_pointers(user_id);
CREATE INDEX idx_ump_area ON user_msg_pointers(area_shortcode);
```

#### user_thread_pointers

One row per user per thread visited. Only created when a user actually views a thread. Stores the highest message ID seen within that specific thread.

```sql
CREATE TABLE user_thread_pointers (
    id SERIAL PRIMARY KEY,
    user_id INTEGER,
    area_shortcode VARCHAR(64),
    thread_id INTEGER,
    scan_pointer INTEGER DEFAULT 0,
    last_read_at TIMESTAMP,
    UNIQUE(user_id, area_shortcode, thread_id)
);
CREATE INDEX idx_utp_user ON user_thread_pointers(user_id);
CREATE INDEX idx_utp_user_area ON user_thread_pointers(user_id, area_shortcode);
CREATE INDEX idx_utp_user_area_thread ON user_thread_pointers(user_id, area_shortcode, thread_id);
```

#### user_msg_reads

Retained for future mark-unread functionality. Not used in normal read tracking. Currently empty.

```sql
CREATE TABLE user_msg_reads (
    id SERIAL PRIMARY KEY,
    user_id INTEGER,
    area_shortcode VARCHAR(64),
    msg_id INTEGER,
    is_read BOOLEAN,
    read_at TIMESTAMP,
    UNIQUE(user_id, area_shortcode, msg_id)
);
```

### Read-State Resolution

Effective read threshold for a thread = `MAX(area_pointer, COALESCE(thread_pointer, 0))`.

A message is **unread** if `msg.id > effective_threshold` for its thread.

| Scenario | Result |
|---|---|
| `msg.id <= area_pointer` | READ (area pointer is the floor) |
| `msg.id > area_pointer`, `msg.id <= thread_pointer` | READ (thread pointer covers it) |
| `msg.id > area_pointer`, no thread pointer row exists | UNREAD |
| `msg.id > area_pointer`, `msg.id > thread_pointer` | UNREAD |

### Pointer Advancement

**Viewing a thread**: `advanceThreadPointer(userId, area, threadId, maxMsgId)` — one UPSERT for the thread pointer with `GREATEST()` so it only moves forward, then floor consolidation. Consolidation finds the lowest unread message across all threads; if that boundary exceeds the current area pointer, the floor advances and thread pointer rows now below it are pruned. When all threads are fully read, the floor jumps to max and all thread pointer rows are deleted. This keeps `user_thread_pointers` from growing unbounded.

**Viewing flat mode**: `advancePointer(userId, area, maxMsgId)` — one UPDATE with `GREATEST()`. One DB operation.

**Mark area as read**: `markAreaRead(userId, area)` — jumps area pointer to `MAX(id)` in the area's message table. Thread pointers don't need updating because the area pointer is the floor.

**Scrolling down for newer messages (lazy-load)**: Advances the appropriate pointer (thread or area) to the highest ID in the new batch.

**Scrolling up for older messages (lazy-load)**: No pointer update — older messages are below the watermark.

### Unread Queries

**Per-thread unread count** (`getThreadUnreadCount`): Single query comparing `msg.id > GREATEST(area_pointer, thread_pointer)` within the thread.

**Batch thread unread counts** (`getThreadUnreadCounts`): Single query with `LEFT JOIN user_thread_pointers` and `GROUP BY thread_id`. Used for thread listings — one query instead of N.

**Area total unread** (`getUnreadCount`): Same LEFT JOIN pattern, area-wide.

**Quick check** (`hasNewMessages`): Fast path checks `MAX(id) > area_pointer`, slower path checks against per-thread pointers only if needed.

**First unread in thread/area** (`getFirstUnreadInThread`, `getFirstUnreadInArea`): Returns the lowest message ID above the effective threshold. Used to position the initial view.

### View Loading Strategy

Both thread reader and flat view find the first unread message first, then load a batch of 30 messages starting from that point going forward. If nothing is unread, they load the newest 30. The first unread message is always in the DOM so scroll-to-unread is a simple querySelector.

Bidirectional lazy scroll: scrolling up loads older messages (prepended), scrolling down loads newer messages (appended). Both views track `oldestId`, `newestId`, `hasOlder`, `hasNewer`.

**Auto-fill for short content**: If the initial batch doesn't overflow the scroll container (e.g., a thread with only one new message), the scroll event can never fire. Both views run an `autoFill()` function after initialization that detects `container.scrollHeight <= container.clientHeight` and auto-triggers `loadDirection('older')`. It recurses until the container overflows or there are no more older messages, with a safety check that `loaded` actually increased to prevent infinite loops on error.

### Position-Aware Progress Bar

The progress bar shows a positioned window within the total message count. Server passes `messagesBefore` (from `countMessagesBefore()`) along with `hasOlder`/`hasNewer` flags. Client tracks `msgBefore` and `loaded`, renders the bar with `margin-left` (position) and `width` (window size) as percentages.

---

## User Area Subscriptions

### Overview

Per-user newscan subscription overrides for message areas. Allows users to opt in/out of individual areas independent of the area's default newscan setting.

### Schema

```sql
CREATE TABLE user_area_subscriptions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER,
    area_shortcode VARCHAR(64),
    subscribed BOOLEAN DEFAULT true,
    updated_at TIMESTAMP,
    UNIQUE(user_id, area_shortcode)
);
CREATE INDEX idx_uas_user ON user_area_subscriptions(user_id);
```

### Resolution Order

`userAreaSubs.getSubscriptionMap(userId)` returns a `Map<shortcode, boolean>`:

1. Explicit user override (from `user_area_subscriptions` table)
2. Area's `newscan_default` column value
3. `true` (fallback — include by default)

### Usage

- **Terminal newscan** (`newscan.js`): calls `getSubscriptionMap()` to filter which areas to scan
- **Terminal area selector** (`msgAreaSelector.js`): unsubscribed areas displayed dimmed, T key toggles subscription
- **Future web newscan**: same `getSubscriptionMap()` filtering

---

## Input Sanitization

### Overview

Targeted sanitization at the model layer, covering both web posts and network packet imports. Designed to prevent XSS without stripping legitimate content that may be needed for future rich editing or ANSI art.

### sanitizeMessageFields (messages.js)

Called at the top of `startNewThread()` and `replyToThread()`. Exported for use by tossers on inbound packets.

**What gets stripped:**
- `<script>...</script>` and `<style>...</style>` (tags and content)
- Dangerous void/self-closing tags: `<iframe>`, `<object>`, `<embed>`, `<link>`, `<meta>`, `<base>`, `<form>`, `<input>`, `<button>`, `<select>`, `<textarea>`
- Event handler attributes (`onclick`, `onerror`, `onload`, etc.) on any surviving tags
- `javascript:`, `vbscript:`, `data:` URI schemes in `href`/`src`/`action` attributes

**What is preserved:**
- Plain text including literal `<` and `>` characters
- Safe HTML tags (`<b>`, `<i>`, `<u>`, `<br>`, `<p>`, `<div>`, `<span>`, `<font>`, `<table>`, etc.)
- ANSI escape sequences, pipe codes, Ctrl-A codes (byte sequences, not HTML)
- HTML entities (handled at render time)

### Defense-in-Depth Layers

| Layer | What | Covers |
|---|---|---|
| Model (`messages.js`) | `sanitizeMessageFields` strips dangerous constructs | All sources (web + FTN/NNTP/QWK) |
| Render (`formatBodyHtml`) | `escapeHtml()` on plain text path | Prevents XSS at display time |
| Render (`formatTextForHtml`) | HTML entity escaping before space formatting | Defense-in-depth for codepage path |
| View (`.pug`) | `= msg.body_text` (Pug auto-escape) for `body_text` fallback | Last resort if `body_html` is null |

### SQL Injection

Not a concern — all tossers and save functions use parameterized queries via `postgres.insertObject()`. Table names derive from admin-controlled shortcodes (not user input).

### Tosser Integration (Pending)

Add `sanitizeMessageFields(dbObj)` call in each tosser after constructing the DB object but before `postgres.insertObject()`:

- **messages.js** (in `handleInboundEchoMessage`) — after `var dbObj = await echomailModule.ftnToDb(message);`
- **nntpTosser.js** _(in `src/middleware/tossers/`)_ — after the `dbObj = { ... };` block
- **qwkTosser.js** _(in `src/middleware/tossers/`)_ — after the `dbObj = { ... };` block

---

## Message Posting

### Routes

- `POST /messages/area/:shortcode/newthread` — creates thread and first message. Redirects to thread (threaded view) or back to flat view.
- `POST /messages/area/:shortcode/thread/:uuid/reply` — posts reply to existing thread. Sets `reply_to` to the specific message being replied to (from the reply button's `data-bs-msgid`), falling back to the thread root (`dbthread.threadid`). This is critical for FTN `@REPLY` kludge generation during outbound tossing.

Both routes resolve `from_user` via `resolvePostName(sessionUser, msgArea)` which checks the area's `post_as` setting (username or realname). Input is sanitized at the model layer.

### Quote System

The reply modal includes a collapsible quote panel. When replying to a specific message:
1. The original message's plain text is extracted from the DOM (`getPlainText()` clones the element, converts `<br>`/block elements to `\n`, reads `textContent`)
2. Text is word-wrapped at 80 columns (with smart truncation for lines only a few chars over)
3. Lines are displayed with numbered rows in a scrollable panel
4. Clicking a line immediately inserts `"  > {line text}"` at the cursor position in the textarea (truncated to 80 chars after prefix)
5. Inserted lines dim to 40% opacity as visual feedback
6. Users can interleave quotes with their own text by positioning the cursor between inserts

### Flat View Reply Routing

In flat view, messages span multiple threads. Each message carries `thread_uuid` (resolved via `getThreadUUIDMap()` batch lookup). The reply modal's form action is set dynamically per-click to target the correct thread.

---

## Web View Architecture

### Responsive Layout

Both `flat.pug` and `thread.pug` use a responsive column layout:

| Breakpoint | Message column | Sidebar | Notes |
|---|---|---|---|
| xl (≥1200px) | `col-xl-6.offset-xl-3` | `col-xl-2.d-none.d-xl-block` | Centered card, sidebar visible as column |
| lg (992–1199px) | `col-lg-10` | Hidden | Message card fills most of the row |
| < lg (mobile) | `col-12` | Hidden | Full width, hamburger menu for navigation |

### Offcanvas Sidebar

Below xl, the sidebar is replaced by a Bootstrap offcanvas panel (`offcanvas-end`). Triggered by a hamburger ☰ button in the card header (`.d-xl-none`). Configured with `data-bs-backdrop='false'` (no dimming overlay) and `data-bs-scroll='true'` (page remains scrollable). Win95-style close button matches the reply modal aesthetic. Contains the same functionality as the desktop sidebar: scroll to oldest/newest, post/reply buttons, mark read, navigation links.

### Auto-Sizing (`_msgAutoSize.pug`)

Included by both view templates; the logic is `public/js/readerWidth.js` (#54), whose rules (`viewCols`, `bodyCols`, `fontPx`) are pure and tested in `tests/readerWidth.test.js`. A hidden monospace probe at 16px gives the width of one character; each body gets the font size that makes its column count fill the container, applied with `setProperty('font-size', px, 'important')`.

| Condition | Target columns | Effect |
|---|---|---|
| Desktop (≥992px) | 80 | Standard BBS column width; no switch shown |
| Mobile, the reader chose 40 or 80 for this area | as chosen | Remembered in localStorage (`canectic.readerCols.<AREA>`) |
| Mobile, area `ansi_area` true | 80 | Art areas open as written |
| Mobile otherwise | 40 | Larger, readable text |
| Body marked `data-art` (any mobile view) | 80 | Detected art is never shown broken at 40 |

`data-art` comes from `detectAnsiArt(body_text)` in the message loaders (`msg.isArt`, carried by `messageForClient`), computed when the page is rendered, so it needs no `body_html` regeneration. On the dev board it flagged 22 of 165 OTHERNETS messages, all labelled [ANSI] by their authors, and none of 6000 in the three busiest text areas.

Runs on page load, debounced on resize, again on every click of the switch, and as `window.fitMessageBodies` for the infinite scroll loader after inserting messages.

### Access Control

Access control uses a three-layer check at both group and area levels. Both `checkAreaReadAccess` and `checkAreaPostAccess` in the routes (and equivalent `checkReadFlags`/`checkPostAccess` in terminal modules) evaluate all three layers:

1. **Security level** — `user.security >= area.read_security` (or `post_security`). Filtered at the DB layer by `listMsgGroups` and `getAreasInGroup`.
2. **Required permission flags** — user must have ALL flags listed in `read_perm_flags` (or `post_perm_flags`). JSONB array on both groups and areas. User flags stored in `users.permissionflags` JSONB.
3. **Restriction flags** — user must have NONE of the flags listed in `read_rest_flags` (or `post_rest_flags`). JSONB array on both groups and areas. User flags stored in `users.restrictionflags` JSONB.

Empty flag arrays impose no constraint. All three layers must pass for access to be granted.

#### Web enforcement

**Group listing** (`GET /messages`): groups filtered by `checkAreaReadAccess` after DB query. Areas within each group filtered by `checkAreaReadAccess` for unread counting. Groups with zero accessible areas removed from listing.

**Area listing** (`GET /messages/group/:shortcode`): group-level `checkAreaReadAccess` gate. Areas filtered by `checkAreaReadAccess`.

**Area/thread views**: `sufficientAccess` from `checkAreaReadAccess`, `canPost` from `checkAreaPostAccess`, both passed to templates for guard chains and UI gating.

**JSON lazy-load endpoints**: all three (`threads.json`, `messages.json`, thread `messages.json`) use `checkAreaReadAccess`.

**POST routes**: `newthread` and `reply` use `checkAreaPostAccess`.

#### Template guard chains

```pug
if !currentuser → login partial
else if !sufficientAccess → unauthorized partial
else if !msgArea → not found
else → content (with canPost gating on post/reply UI)
```

`canPost` gates: Post button (header + sidebar + offcanvas), Reply buttons (per-message Pug + JS `buildMsgHtml`), reply/post modals (DOM presence), quote system JS, and reply handler JS. When false, modals are absent from the DOM and JS initializers use null checks (`if (replyModalEl) { ... }`) to avoid errors.

#### Terminal enforcement

**Area selector** (`msgAreaSelector.js`): `checkReadFlags(userRecord, group)` filters groups, `checkReadFlags(userRecord, area)` filters areas. Groups with zero accessible areas excluded.

**Reader** (`msgReader.js`): `_canPost` resolved via `checkPostAccess(userRecord, areaConfig)` after area config loads. When false, Reply key hidden from nav bar and R key input ignored.

**Editor** (`msgEditor.js`): `checkPostAccess(userRecord, areaConfig)` checked in `run()` after area config loads. Denied users see "You do not have permission to post in this area." and return to the caller after 2 seconds.

#### Admin management

Groups and areas share the same four flag columns. Flag values are JSONB arrays of string tags. The admin UI uses a badge + select + add-button pattern (same as user flag management). Available flags are defined in `admin.js` as `availablePermissions` ("Sysop", "Mod", "Adult", "Admin") and `availableRestrictions` ("Underage", "Banned").

Groups act as templates: when creating a new area, the new-area modal pre-populates read/post security and all four flag sets from the parent group. The `msgAreas/index` view fetches defaults via `GET /admin/msgGroup/:shortcode/defaults` (JSON endpoint) when the group selector changes. Individual areas can override any setting.

### Message Headers

Stacked two-line layout on all screen sizes: from/to/subject on top, date below. Reply button floated right with `flex-shrink-0`. Uses `d-flex align-items-start` (not `align-items-center`) so the button aligns to the top.

---

## Thread Preferences (Design — Not Yet Implemented)

### Overview

Separate from area newscan subscriptions. Allows users to subscribe to or ignore individual threads, independent of whether they're subscribed to the area's newscan. Some areas may also be flagged to function in "subscribe-to-threads" mode rather than "read everything" mode.

The `thread_mode` column is implemented on `message_areas` and on `message_groups` (standard/subscribe_only/no_threads), the group value acting as the default for areas created in it. The `user_thread_prefs` table and model logic are pending.

### Schema

#### user_thread_prefs

Only non-default rows need to exist. If no row exists for a user+thread, the thread follows the area's default behavior.

```sql
CREATE TABLE user_thread_prefs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    area_shortcode VARCHAR(64) NOT NULL,
    thread_id INTEGER NOT NULL,
    pref VARCHAR(16) NOT NULL DEFAULT 'normal',
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    UNIQUE(user_id, area_shortcode, thread_id)
);
CREATE INDEX idx_utp_user ON user_thread_prefs(user_id);
CREATE INDEX idx_utp_user_area ON user_thread_prefs(user_id, area_shortcode);
CREATE INDEX idx_utp_subscribed ON user_thread_prefs(user_id) WHERE pref = 'subscribe';
```

#### pref values

| Value | Meaning |
|---|---|
| `normal` | Follow area default. If user has area in newscan, thread is included. If not, thread is excluded. (Row can be deleted — absence = normal.) |
| `subscribe` | Always show new messages in this thread, even if the area is not in the user's newscan. |
| `ignore` | Never show new messages in this thread, even if the area is in the user's newscan. |
| `mute` | Like ignore but also suppress notifications (future). |

### Auto-subscribe Triggers (Future)

Threads could be auto-subscribed when:
- User posts a new message (starts a thread)
- User replies to a thread
- User is mentioned/tagged in a thread (requires mention system)
- User receives a private reply in a thread

---

## Maintenance CLI Usage

```bash
# Regenerate body_html for all active areas
node src/tools/maintenance.js --regen-html

# Dry run — preview without writing
node src/tools/maintenance.js --regen-html --dry-run

# Specific area(s)
node src/tools/maintenance.js --regen-html --area GENERAL --area ALTBBSADS

# Force 80-column HTML output
node src/tools/maintenance.js --regen-html --width 80

# Custom batch size (default 100)
node src/tools/maintenance.js --regen-html --batch 50
```

---

## Key Design Decisions

1. **Two-tier read tracking pointers over per-message tracking**: Area pointer is the floor, thread pointers add granularity. Normal reading generates at most 2 DB operations per page view instead of N writes for N messages.

2. **Bidirectional scroll from first unread**: Thread reader and flat view load starting from the first unread message going forward. Users scroll up for older content and down for newer.

3. **Keyset pagination for thread listings**: `getThreadsPage()` uses `(last_message DESC, id DESC)` cursor instead of OFFSET to avoid skipping/duplicating threads when new messages arrive between pages.

4. **body_html consolidated in terminalText.js**: Single `formatBodyHtml()` used by all tossers and the maintenance tool. Eliminates divergence between import paths. `reflowText()` joins with `\r` because VirtualTerminal only breaks on `\r` (FTN convention).

5. **noWrap VirtualTerminal for colored text**: Non-art colored text gets responsive layout via CSS instead of hard-wrapping at 80 columns. Single spaces between words stay as regular ` ` for browser word-wrap; `&nbsp;` only for leading/multi-spaces.

6. **ANSI art detection, two signals**: `detectAnsiArt()` checks for CSI sequences that move the cursor (CUP, CUU, CUD, CUF, CUB), and separately for block-drawn art — two or more lines built substantially from box/block glyphs (U+2500-U+259F), at least one of them 40+ columns wide. Colour-only SGR on ordinary prose still does not trigger art mode; it gets noWrap. The width test is what separates a drawing from a signature rule, and the second signal exists because the answer gates paragraph reflow: art that is not recognised gets its rows joined together, permanently.

7. **Paragraph reflow at 80% threshold**: `reflowParagraphs` joins consecutive normal text lines when the first line reaches ≥80% of wrapWidth. This reassembles paragraphs from wider editors without touching intentionally short lines, quote lines, or separators.

8. **Subscription resolution cascade**: user override → area `newscan_default` → true. Lets areas opt out of newscan by default while users can override either direction.

9. **Template guard chains over early-return renders**: Routes pass `sufficientAccess` and `canPost`; templates handle display. Avoids duplicating render parameters across multiple route branches.

10. **canPost gates all posting UI**: When false, buttons absent, modals absent from DOM, JS guarded by null checks. Zero orphan listeners.

11. **Responsive layout with offcanvas sidebar**: Desktop (xl) shows sidebar column. Below xl, offcanvas with `data-bs-backdrop='false'`. Desktop nav buttons hidden on mobile since they're in the offcanvas.

12. **Auto-sizing monospace text**: Probe measures at reference size, scales to fill container. `ansi_area` forces 80 cols. Desktop → 80, mobile → 40.

13. **Model-layer input sanitization**: `sanitizeMessageFields()` strips dangerous HTML at the model layer, covering both web posts and (future) network imports.

14. **Area counts by recalculation**: `recalculateAreaCounts()` runs a correlated UPDATE from actual data on every area add/remove. No increment/decrement drift.

15. **resolveUserId for session compatibility**: Redis stores session values as strings. `resolveUserId()` handles string→number conversion with fallback DB lookup.

16. **Three-layer access control (security + perm flags + restrict flags)**: Both read and post access check security level (numeric), required permission flags (JSONB array, must have ALL), and restriction flags (JSONB array, must have NONE). Same pattern on groups and areas, same column names, same `checkAreaReadAccess`/`checkAreaPostAccess` helpers work on both. DB handles security level filtering; application layer handles flag checks.

17. **Groups as area templates**: Groups carry `read_security`, `post_security`, and four flag columns. New area modals pre-populate from the parent group. `msgGroups_view.pug` uses server-rendered defaults; `msgAreas_index.pug` fetches via `GET /admin/msgGroup/:shortcode/defaults` AJAX when the group selector changes. Individual areas can override any inherited value.

18. **Group `security` column removed**: The legacy single `security` column on `message_groups` was replaced by `read_security` and `post_security`. `listMsgGroups()` now filters by `read_security IS NULL OR read_security <= $1` for backward compatibility during migration.

19. **Auto-fill for short lazy-load content**: When initial batch doesn't overflow the scroll container, scroll events can't fire. Both views run a recursive `autoFill()` that triggers `loadDirection('older')` until the container overflows, there's nothing left, or the loaded count stops increasing (error guard).

---

## Echolist Registry

Per-network registry of available echomail areas. See `NETWORKING_ARCHITECTURE.md` for full details.

- Tables: `network_echolists` (list definitions, multiple per network, `is_default` flag), `network_echolist_areas` (entries with `areatag`, `description`, `tags` JSONB, historical tracking, `local_area_id` nullable FK to `message_areas`)
- Model: `src/models/networkEcholist.js`
- Import from BACKBONE.NA format with diff preview (new/removed/changed)
- `local_area_id` sync: `networkAreas.addAreaToNetwork()` sets it, `removeAreaFromNetwork()` clears it
- Sysop notification when locally-carried areas disappear from an echolist import

---

## Future Development

- **Web newscan route/view**: `GET /messages/newscan` using `getNewscanSummary()` with `userAreaSubs` filtering
- **Thread preferences**: Subscribe/ignore per-thread (schema above). `user_thread_prefs` table and model pending
- **Rich text editor**: HTML composition with whitelist sanitization, plain text generation for network compatibility
- **ANSI art paste support**: Already works — escape sequences in `body_text` handled by `formatBodyHtml`'s ANSI branch
- **Tosser sanitization integration**: Wire `sanitizeMessageFields()` into all three tosser inbound paths
- **Message body word-wrapping on post**: Enforce 80 columns before DB save for FTN/QWK compatibility
- **Flat-mode reply thread UUID resolution**: Currently null for some messages — needs `getThreadByDbId()` lookup
- ~~**QWK packet integration**~~ — **Done**. `qwkUser.js` generates personal `.qwk` packets using `userMsgPointers` scan pointers and imports `.rep` replies via `echomail.startNewThread()`/`replyToThread()`. Conference numbers via `message_areas.qwk_conf_number`, allocated in per-group blocks (`message_groups.qwk_conf_start` + `qwk_group_stride`, default 1000). Numbers 1-100 reserved for system conferences (announcements, wall, bulletins). See `QWK_USER_DESIGN.md`.
