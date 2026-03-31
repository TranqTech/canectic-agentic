# Menu Configuration

Menus are the primary navigation system for terminal users. Each menu defines a set of hotkey commands that users can invoke. Menus are managed via the admin panel at **Menus > Menu Editor**.

## Menu Basics

### Creating a Menu

Click **Add New Menu** on the menu list page. The modal has three tabs:

**Configuration tab:**
- **Menu Identifier** -- Unique programmatic ID (lowercase letters, numbers, hyphens, underscores only). This is what other menus reference when loading this menu. Examples: `main`, `messages`, `doors`, `files`.
- **Display Title Text** -- The title shown to users on the terminal. Can include spaces and mixed case.
- **Menu Type** -- "Hotkey" (single keypress dispatch) or "Lightbar" (arrow-key navigation with visual highlight bar). See the Lightbar Mode section below.
- **Display Title** -- Yes/No. When No, the title text is not rendered at the top of the screen. Useful when ANSI art provides the title visually.
- **Display Entries** -- Auto (entries flow in the margin-defined region), Off (art-only, no entries rendered), or Art Defined (entry positions from art codes, future).
- **Display File** -- Optional ANSI art file shown as the menu background. Bare filename only (no path or extension). The art system resolves the full path based on terminal capabilities.
- **Display File Type** -- Art subdirectory: "Screen" (full-screen art) or "Header" (header art).

**Layout tab:**
- **Entry Region Margins** -- Top, Bottom, Left, Right. Defines the rectangular area where entries are rendered. Margins are best-effort: if entries don't fit, the system first tries adding columns, then expands the region.
- **Max Columns** -- Maximum columns for entry layout (default 3). The system auto-calculates how many columns fit based on the region width and the longest entry text.
- **Col Gap** -- Spacing between columns (default 2).
- **Fill Order** -- "Columns" fills top-to-bottom per column (default, traditional BBS style). "Rows" fills left-to-right per row (spreads entries horizontally).
- **Centre Vertical** -- When Yes, the entry block is vertically centred within the entry region.

**Colours tab:**
- Per-menu colour overrides. Leave as "Theme Default" to inherit from the active theme. See the [Theme Configuration](THEMES.md) guide for details on the colour cascade.
- **Reset All to Theme** button clears all overrides back to theme defaults.

### Menu Identifiers

Menu identifiers follow the same pattern as door slugs: lowercase, alphanumeric with hyphens and underscores. They serve as the programmatic reference used by:
- The `loadMenu` command (entries that navigate to other menus)
- The call flow (`main` is the root menu loaded after login)
- Menu history stack (back navigation)

Menu lookups are case-insensitive, so existing menus with mixed-case names will continue to work. New menus enforce lowercase.

## Menu Entries

Each menu has a list of entries. Click into a menu from the list to manage its entries.

### Adding an Entry

Click **Add Entry**. Fields:

- **Hotkey** -- 1-4 character key combination. Users press this to activate the entry. Examples: `M`, `Q`, `1`, `?`, `PG`.
- **Display Text** -- Text shown in the menu entry list. Leave blank for hidden hotkeys (the hotkey still works but nothing is displayed).
- **Command** -- What happens when the user presses the hotkey. The dropdown is sorted alphabetically.
- **Argument** -- Only shown for commands that need it. For "Load Menu", shows a dropdown of all other menus. For "Run Door Game", shows a dropdown of all doors.
- **Sort Order** -- Controls display position. Entries are sorted ascending.
- **Min Security** -- Minimum security level required to see/use this entry. Leave blank for no restriction.
- **Featured** -- Mark as "Yes" to use the featured colour instead of the standard option colour. Use for important entries like Log Off or Verify Address.
- **FG/BG Colour** -- Explicit foreground and background colours. "Theme" inherits from the active theme (recommended).
- **Required/Prohibited Flags** -- Access control. User must have ALL required flags and NONE of the prohibited flags.

### Reordering Entries

Drag entries by the grip handle on the left side of the table. Click **Save Order** when done.

### Default Entry

Every new menu automatically gets a `?` hotkey mapped to "Redraw Menu". This gives users a consistent way to refresh the screen.

## Available Commands

| Command | Needs Argument | Description |
|---------|---------------|-------------|
| Announcements | No | Display system announcements |
| Browsing Doors | No | Door game browser with collections |
| Change File Area | No | File area selector |
| Change File Group | No | File group selector |
| Change Message Area | No | Message area selector |
| Change Message Group | No | Message group selector |
| Change Password | No | Logged-in password change |
| Check Email | No | Check for new private messages |
| Download Batch | No | Download tagged files |
| Exit Stage | No | Advance to next call flow stage |
| File Browser | No | Browse files in current area |
| File Search | No | Search files across areas |
| Last Callers | No | View recent caller list |
| List Messages | No | List messages in current area |
| Load Menu | Menu identifier | Navigate to another menu |
| Log Off | No | End the session |
| New Scan (All) | No | Scan all areas for new messages |
| New Scan (Group) | No | Scan current group for new messages |
| Post Message | No | Compose a new message |
| Previous Menu | No | Go back to the previous menu |
| Private Messages | No | Open PM reader |
| Read Messages | No | Read messages in current area |
| Redraw Menu | No | Redraw the current menu screen |
| Run Door Game | Door slug | Launch a specific door game |
| Test Download | No | Test file transfer |
| Upload File | No | Upload a file to current area |
| User List | No | View registered users |
| Verify Address | No | Request email/netmail verification |
| Who's Online | No | View currently connected users |

## Active Hotkeys

The "Active Hotkeys" line at the bottom of each menu shows all available hotkeys sorted alphabetically. Its colour is controlled by the `menu_prompt_clr` theme property (or per-menu override). This is separate from:
- `hotkey_clr` -- The colour of the hotkey letter within each entry line
- `prompt_clr` -- The colour of the command input prompt

## Lightbar Mode

When Menu Type is set to "Lightbar", the menu displays a visual highlight bar on the currently selected entry instead of waiting for a hotkey press.

**How it works:**
- Arrow keys move the highlight between entries. Up/Down moves vertically, Left/Right moves between columns. The direction mapping adapts to the fill order setting.
- Enter executes the highlighted entry's command.
- Home/End jump to the first/last entry. PgUp/PgDn skip a full page.
- The highlight bar wraps around at boundaries (moving past the last entry goes to the first).
- Hotkeys still work for direct access even in lightbar mode.

**Visual appearance:**
- The selected entry is drawn with the lightbar theme colours: `lb_clr` (background), `lb_cmd_clr` (hotkey letter), `lb_opt_clr` (entry text).
- The highlight bar extends one column before and after the entry text for clean visual padding.
- The prompt area shows "Use arrows to navigate, Enter to select" instead of the hotkey list.

**Dumb terminals:** Lightbar mode is not available on dumb terminals. They fall back to hotkey mode automatically.

**Theme colours:** The Lightbar category in the theme editor controls the three lightbar colours. These can also be set per-menu via the Colours tab.

## Navigation

Menus maintain a history stack (up to 20 deep). The `previousMenu` command pops the last menu from the stack. The `main` menu is the root -- navigating to it clears the history.

The `loadMenu` command validates the target menu exists before navigating. If the target is not found, an error is displayed and the current menu remains active.

## Access Control

Both menu-level and entry-level access control use the same model:
- **Security level** -- Numeric threshold (0-255). User's level must meet or exceed.
- **Required flags** -- Permission flags the user must have ALL of.
- **Prohibited flags** -- Restriction flags the user must have NONE of.

Entries that fail access control are hidden from the display and their hotkeys are inactive. The user never sees or interacts with entries they cannot access.

## Call Flow Integration

The `main` menu is loaded automatically after the login flow completes. The standard call flow is:

```
negotiate -> logon -> last_callers -> check_online -> announcements -> verify_mail -> check_email -> check_batch -> menu -> goodbye
```

The `menu` stage loads the menu specified by `call.currentMenu` (defaults to `main`). When the menu handler's `exitStage` command is invoked, the flow advances to `goodbye` and the session ends.

## Tips

- Use short, memorable hotkeys. Single letters are best for common actions.
- Group related entries together using sort order.
- Use the Featured flag for important actions rather than hardcoding colours. This ensures they remain visible across theme changes.
- Hidden hotkeys (no display text) are useful for shortcuts that experienced users know about.
- The `?` hotkey for Redraw Menu is a convention users expect from BBS systems.
