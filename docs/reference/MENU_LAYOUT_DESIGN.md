# Menu Layout & Art Integration Design

Design document for the enhanced menu layout system. Covers margin-based entry regions, auto-column sizing, vertical centering, art-embedded codes, and the three display modes.

---

## 1. Current State

The menu system renders entries using a simple offset model:
- `entries_x_offset` / `entries_y_offset` shift the entry block from a fixed anchor point (3, 4)
- `max_columns` caps column count, but requires many entries before multiple columns appear
- Column width is the widest entry + gap, no dynamic sizing
- Prompt/hotkey bar is pinned 2 rows from the bottom
- Art files are rendered as static backgrounds with no variable substitution
- `display_entries` is boolean (Yes/No)

### Problems
- Offset positioning is imprecise for aligning with art elements
- No way to constrain entries to a region within art (they can overwrite art borders)
- Column count is based on entry count vs available rows, not available width
- No vertical centering -- entries always start from the top of the region
- Hidden entries (access control) leave no visual trace, but the layout can't adapt to art that expects specific entries in specific positions
- No dynamic content in art files (system name, username, area names, etc.)

---

## 2. Display Modes

Change `display_entries` from boolean to a three-state enum:

| Mode | Value | Behaviour |
|------|-------|-----------|
| **Auto** | `auto` | Entries flow into a margin-defined region with auto-column layout |
| **Off** | `off` | No entry rendering. Art-only menu, hotkeys still active |
| **Art Defined** | `art` | Entry positions determined by @ codes embedded in the art file |

The `auto` mode replaces the current `true` behaviour with the enhanced margin/column system. Existing menus with `display_entries=true` migrate to `auto`; `false` migrates to `off`.

---

## 3. Auto Mode: Margin-Based Layout

### 3.1 Margins

Replace `entries_x_offset` / `entries_y_offset` with four margin values:

| Field | Default | Description |
|-------|---------|-------------|
| `margin_top` | 3 | Rows reserved at top (title area) |
| `margin_bottom` | 3 | Rows reserved at bottom (prompt/hotkey area) |
| `margin_left` | 2 | Columns reserved on left |
| `margin_right` | 2 | Columns reserved on right |

The **entry region** is:
```
top:    margin_top
bottom: term_height - margin_bottom - 1
left:   margin_left
right:  term_width - margin_right - 1
```

Region width: `term_width - margin_left - margin_right`
Region height: `(term_height - margin_top - margin_bottom)`

### 3.2 Auto Column Calculation

Instead of requiring many entries to trigger multiple columns, calculate based on the region width and entry content:

```
longest_entry = max visible entry display width (including hotkey prefix)
usable_width  = region_width
col_width     = longest_entry + col_gap
columns       = floor(usable_width / col_width)
columns       = clamp(columns, 1, max_columns)
```

This means a menu with 4 short entries on a wide terminal automatically gets 2-3 columns instead of a single column.

### 3.3 Fill Order

New field `fill_order` (default `columns`):

| Value | Behaviour | Example (6 entries, 2 cols) |
|-------|-----------|---------------------------|
| `columns` | Fill top-to-bottom per column, then next column | 1,2,3 / 4,5,6 |
| `rows` | Fill left-to-right per row, then next row | 1,2 / 3,4 / 5,6 |

Column-first is the default (matches current behaviour and BBS convention).

### 3.4 Vertical Centering

New boolean `center_vertical` (default `false`):

When true, the entry block is offset downward within the region so the block is vertically centered:

```
rows_needed   = ceil(visible_entry_count / columns)
region_height = bottom - top
v_offset      = floor((region_height - rows_needed) / 2)
entry_start_y = top + v_offset
```

When false, entries start from the top of the region (current behaviour).

### 3.5 Pagination

If visible entries exceed `region_height * columns`, paginate as today. Page indicator drawn at the bottom of the entry region. Pagination respects vertical centering (centred within available space minus the page indicator row).

---

## 4. Art Defined Mode: @ Codes

### 4.1 Art Code Syntax

Codes are embedded directly in ANSI/ASCII art files. The art renderer scans for codes during display and either replaces them inline or records their positions for later entry rendering.

**Format**: `@XX@` or `@XXnn@` where XX is a two-letter code type and nn is an optional numeric index (01-99).

### 4.2 Universal Codes (All Art Files)

These codes work in any art file (menus, login screens, headers, etc.) and are replaced at render time:

| Code | Description | Source |
|------|-------------|--------|
| `@BN@` | Board name | `appConfig.get('boardname')` |
| `@SN@` | System name | `appConfig.get('system_name')` |
| `@UN@` | Current username | `call.caller_username` |
| `@RN@` | Real name | `call.caller_fullname` |
| `@ND@` | Node number | `call.nodenum` |
| `@DT@` | Current date | Formatted date |
| `@TM@` | Current time | Formatted time |
| `@MG@` | Current message group | Current group name |
| `@MA@` | Current message area | Current area name |
| `@FG@` | Current file group | Current file group name |
| `@FA@` | Current file area | Current file area name |
| `@VR@` | Software version | System version string |
| `@ON@` | Users online count | Node count + web presence count |
| `@TC@` | Total calls | Total call count |
| `@TU@` | Total users | Registered user count |

Universal codes are replaced with the value padded or truncated to fit the code's character width. The code itself is 4 characters (`@XX@`), so short values are right-padded with spaces and long values are truncated.

For values that need more space, a width specifier can be used: `@BN20@` reserves 20 characters for the board name. The number is the total display width including the @ delimiters' space.

### 4.3 Menu Entry Codes

Only processed in menu art files when `display_entries = 'art'`:

| Code | Description |
|------|-------------|
| `@Enn@` | Entry slot nn. Filled with the nth visible non-featured entry (sequential). |
| `@Fnn@` | Featured entry slot nn. Filled with the nth visible featured entry. |
| `@MT@` | Menu title position (replaces the default title drawing) |
| `@HK@` | Active hotkey list (replaces the bottom-of-screen hotkey bar) |
| `@PR@` | Command prompt (replaces the bottom-of-screen prompt line) |
| `@ER@` | Error/status message area |

**Entry slot behaviour:**
- `@E01@` gets the 1st visible non-featured entry, `@E02@` the 2nd, etc.
- `@F01@` gets the 1st visible featured entry, `@F02@` the 2nd, etc.
- If there are more visible featured entries than `@Fnn@` slots, the overflow featured entries spill into `@Enn@` slots alongside regular entries, maintaining their sort order position. This means featured entries always appear somewhere -- they are never dropped.
- If there are fewer visible entries than slots, excess slots are blanked (spaces)
- The hotkey prefix is prepended to the entry display text if the entry has a hotkey
- Entry colour is applied (explicit fg/bg, or featured_clr/opt_clr from theme)

**Width handling:**
Each code occupies a fixed width in the art. The entry text (hotkey + display) is padded or truncated to that width. The width is determined by a trailing number: `@E0120@` = entry slot 1, 20 characters wide. Without a width specifier, a default of 20 characters is used.

**UI element positioning:**
- If `@MT@` appears in the art, the menu title renders there instead of the default top-left position. Supports width specifier (`@MT30@` for 30 chars).
- If `@HK@` appears in the art, the hotkey list renders there instead of the bottom of the screen
- If `@PR@` appears in the art, the prompt renders there instead of the bottom of the screen
- If neither appears, prompt and hotkeys pin to the bottom of the terminal as usual
- `@ER@` defines where error/status messages appear (defaults to beside the hotkey line)

### 4.4 Art Processing Pipeline

1. Art file is loaded as raw bytes (existing `drawfile()` path)
2. Before sending to terminal, scan for `@` code markers
3. For universal codes: replace inline with resolved values
4. For menu codes: record positions (row, column) in a slot map, replace with spaces
5. Send processed art to terminal
6. Menu handler reads the slot map and renders entries at recorded positions
7. Prompt/hotkey/error positions override defaults if found in the slot map

This means the art renderer needs to become a two-pass system:
- **Pass 1**: Process universal codes (simple string replacement)
- **Pass 2**: For menus, extract positional codes and build the slot map

### 4.5 Colour Handling in Art Mode

Entry slots in art inherit the ANSI colour state at the slot position (whatever colour the art has set). The entry's own colour (fg_clr, featured_clr, theme) overrides the art colour for the entry text. After the entry text, colours reset to the art's state.

If the entry has no explicit colour (set to Theme), the art's colour at that position is used. This lets sysops design art that pre-colours entry regions.

---

## 5. Schema Changes

### menus table

| Change | Field | Type | Default | Notes |
|--------|-------|------|---------|-------|
| Modify | `display_entries` | VARCHAR(8) | 'auto' | Was BOOLEAN. Values: 'auto', 'off', 'art' |
| Add | `margin_top` | INTEGER | 3 | Rows reserved at top |
| Add | `margin_bottom` | INTEGER | 3 | Rows reserved at bottom |
| Add | `margin_left` | INTEGER | 2 | Columns reserved on left |
| Add | `margin_right` | INTEGER | 2 | Columns reserved on right |
| Add | `fill_order` | VARCHAR(8) | 'columns' | 'columns' or 'rows' |
| Add | `center_vertical` | BOOLEAN | false | Centre entry block in region |
| Remove | `entries_x_offset` | - | - | Replaced by margins |
| Remove | `entries_y_offset` | - | - | Replaced by margins |

Migration: existing `display_entries=true` becomes `'auto'`, `false` becomes `'off'`. Existing offsets translate to `margin_left = entries_x_offset + 2`, `margin_top = entries_y_offset + 3`.

---

## 6. Art Code Renderer

New module: `src/utils/artCodes.js`

Responsible for scanning art content for @ codes and producing either replaced content (universal codes) or a position map (menu codes).

```
processArtCodes(artBuffer, call, options)
  -> { processed: Buffer, slotMap: { entries: [], featured: [], title: pos, prompt: pos, hotkeys: pos, error: pos } }
```

The slot map is passed back to the menu handler, which uses it for entry placement instead of the column layout engine.

This module is independent of the menu system -- any handler that renders art can use it for universal code substitution.

---

## 7. UI Element Positioning

**Default behaviour** (Auto mode and Art Defined mode without positioning codes):
- Title: row `margin_top - 1` (or row 2), starting at column `margin_left`
- Hotkey list: row `term_height - 2`, starting at column `margin_left`
- Prompt: row `term_height - 1`, starting at column `margin_left`
- Error/status: same row as hotkey list, to the right of the hotkey text

**Art Defined override**:
- If `@MT@` found: menu title renders at the code's position instead of the default
- If `@HK@` found: hotkey list renders at the code's position
- If `@PR@` found: prompt renders at the code's position, input cursor follows
- If `@ER@` found: error messages render at the code's position
- All UI elements pin to their default positions unless art codes reposition them

---

## 8. Implementation Phases

### Phase 1: Margin Layout
- Add margin fields to schema and admin UI
- Replace offset-based positioning with margin-based region calculation
- Auto column sizing based on region width
- Fill order toggle
- Vertical centering
- Migrate existing menus (offsets to margins)

### Phase 2: Universal Art Codes
- Art code scanner/replacer in `artCodes.js`
- Wire into `drawscreen()` / `drawfile()` pipeline
- Implement universal codes (@BN@, @UN@, @DT@, etc.)
- Works for all art files, not just menus

### Phase 3: Art Defined Menu Mode
- Menu entry codes (@Enn@, @Fnn@) with slot mapping
- Prompt/hotkey/error position codes (@HK@, @PR@, @ER@)
- display_entries='art' mode in menu handler
- Admin UI for art defined mode

---

## 9. Backward Compatibility

- Menus with no art file and `display_entries='auto'` behave identically to current `true` with default margins matching current anchor points
- Menus with `display_entries='off'` behave identically to current `false`
- Art files without @ codes render identically (no processing overhead -- fast path when no `@` found)
- The `max_columns` and `col_gap` fields remain and work as before within the margin-defined region
- Dumb terminals ignore margins and art codes, use the existing linear rendering path
