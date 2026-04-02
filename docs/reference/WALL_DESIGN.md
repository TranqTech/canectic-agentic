# Wall / Oneliners Design

The Wall (also known as Oneliners or Graffiti Wall) is a public message board where users leave short one-line messages. A classic BBS social feature that appears during login and is accessible from menus.

---

## 1. Overview

- Users see the most recent wall messages during login (call flow stage)
- Users can read and post from a menu command
- Web visitors see the wall on the home page as a partial card
- Admin can delete messages from the admin panel

---

## 2. Database

### Schema (`wall_messages` table)

| Column | Type | Purpose |
|--------|------|---------|
| id | SERIAL PRIMARY KEY | Auto-increment ID |
| uuid | UUID NOT NULL | Public identifier |
| user_id | INTEGER | FK to users (nullable for system messages) |
| username | VARCHAR(64) | Denormalized for display (survives user deletion) |
| message | VARCHAR(78) | The one-liner (max ~78 chars to fit 80-col terminal with margin) |
| created_at | TIMESTAMP DEFAULT NOW() | Post time |

### Model (`src/models/wall.js`)

- `getRecentMessages(limit)` -- most recent N messages, newest last (for display order)
- `addMessage(userId, username, message)` -- insert with UUID generation
- `deleteMessage(uuid)` -- admin deletion
- `getCount()` -- total message count (for stats)

---

## 3. Terminal Interface

### Call Flow Stage: `wall`

Positioned in the Standard call flow after `announcements`, before `verify_mail`. Displays the last 15-20 messages, then prompts the user to add their own or press Enter to continue.

**Display**:
```
                        The Wall
------------------------------------------------------------
  <username>: message text here
  <username>: another message
  ...
------------------------------------------------------------
  Leave a message (or Enter to continue):
```

- Title centred, themed
- Messages displayed newest-last (chronological, most recent at bottom)
- Username in one colour, message in another
- Divider lines encoding-aware (CP437 0xC4 / Unicode U+2500)
- Prompt at bottom for input

**Input**: Single line, max ~78 chars. Enter submits (if non-empty) or skips. ESC skips without posting.

### Menu Command: `wall`

Same display as the call flow stage but returns to menu instead of advancing the call flow. Accessible from any menu entry configured with the `wall` command.

### Sub-Module: `src/handlers/menucommands/wallHandler.js`

Simple sub-module (extends BaseSubModule). Used both as a call flow stage (via SubModuleAdapter) and as a menu command (via _runSubModule).

---

## 4. Web Interface

### Partial: `src/views/partials/wall.pug`

Reusable card component showing the most recent wall messages. Same pattern as `lastCallers.pug` and `whosOnline.pug`.

### Home Page Integration

Added to `src/views/public/index.pug` alongside existing partials. Route passes `wallMessages` from `wall.getRecentMessages()`.

### Admin

Simple delete capability from an admin route. No full CRUD needed -- messages are user-created.

---

## 5. Implementation Plan

### Phase 1: Database + Model
- Create schema in `db/schema/tablecolumns/wall_messages.conf`
- Add table name to `db/schema/tables/tablenames.conf`
- Create `src/models/wall.js`
- Run migrations

### Phase 2: Terminal Handler
- Create `src/handlers/menucommands/wallHandler.js`
- Wire into menuhandler.js command dispatch
- Wire into callmanager.js handler registry + call flow
- Add to menus.js command list

### Phase 3: Web
- Create `src/views/partials/wall.pug`
- Add to home page template
- Pass data from index route

### Phase 4: Admin
- Add delete route in admin.js
- Optional: admin view of wall messages

---

## 6. Configuration

All settings are in the `wall` config category at `/admin/config`:

| Key | Default | Description |
|-----|---------|-------------|
| `wall_display_count` | 15 | Number of messages to display |
| `wall_max_length` | 78 | Maximum message length in characters |
| `wall_post_security` | 60 | Minimum security level to post (60 = verified users) |
| `wall_post_required_flags` | (empty) | Required permission flags (comma-separated, must have ALL) |
| `wall_post_restricted_flags` | Unverified | Restriction flags that block posting (comma-separated, must have NONE) |

Access check (`canPost()` in `wall.js`) is shared between web routes and the terminal handler. Users who don't meet requirements see the wall read-only.

Wall call flow stage can be removed from the flow by sysop if not desired.

## 7. File Index

| File | Purpose |
|------|---------|
| `db/schema/tablecolumns/wall_messages.conf` | Table schema |
| `src/models/wall.js` | Model: CRUD + `canPost()` access check |
| `src/handlers/menucommands/wallHandler.js` | Terminal sub-module (call flow + menu command) |
| `src/views/partials/wall.pug` | Reusable web partial (card) |
| `src/views/public/wall.pug` | Dedicated wall page with post form |
| `src/routes/index.js` | `GET /wall`, `POST /wall` routes |
| `docs/reference/WALL_DESIGN.md` | This document |
