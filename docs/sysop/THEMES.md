# Theme Configuration

Themes control the colour palette for all terminal UI elements. Each theme defines default colours for menus, prompts, messages, and other components using the standard 16 ANSI colours (0-15).

## Managing Themes

Navigate to **Menus > Themes** in the admin panel.

### Creating a Theme

Click **New Theme** and provide:
- **Name** -- Display name (e.g. "Classic Blue")
- **Slug** -- Unique identifier, lowercase with hyphens/underscores (e.g. "classic-blue")
- **Description** -- Optional note for your reference

The theme is created with default colour values. Click into it to customize.

### Editing Colours

The theme editor organizes colour properties into categories via accordion panels:

| Category | Properties | Purpose |
|----------|-----------|---------|
| General | Title, Header, Borders, Error, Warning, Progress, Default Text, Label, Time, Version | Core UI chrome |
| System | Board Name, Board Location | System identification text |
| Menu | Prompt, Menu Prompt, Hotkey, Command, Option, Featured | Menu display elements |
| Lightbar | Lightbar, Lightbar Command, Lightbar Option | Arrow-key navigation (future) |
| Input | Input, Field, Username, Password (and their labels) | Login and input prompts |
| Editor | Editor Prompt | Message editor |
| Content | Door Description, Announcement Body | Rich text content defaults (terminal + web) |
| Messages | Body, Quoted Text, Tearline, Origin, Tagline | Message reader colours |
| Layout | Message X/Y Margins | Message display positioning |

Each colour property is an ANSI colour select (0-15) with a live colour preview in the dropdown.

### Setting the Default Theme

On the theme list, click the checkmark icon next to any theme to make it the system default. This updates the `theme` config setting automatically. New terminal sessions will use the updated theme.

### Duplicating a Theme

Click the copy icon to create a copy of an existing theme with a new name and slug. Useful for creating variations without starting from scratch.

### Deleting a Theme

The default theme cannot be deleted. Remove the default status first by setting a different theme as default.

## Colour Cascade

Terminal colours follow a priority chain. The first defined value wins:

1. **Per-entry colour** -- Explicit fg/bg set on a menu entry (overrides everything)
2. **Per-menu override** -- Colour overrides set on the menu itself (Colours tab)
3. **Theme default** -- The active theme's colour values
4. **Handler fallback** -- Hardcoded fallback if theme is missing (should never happen)

For menu entries, "Theme" is the default colour selection. This means the entry inherits the theme's `opt_clr` (or `featured_clr` for featured entries) rather than being locked to a specific colour. When you change themes, all entries set to "Theme" automatically pick up the new colours.

## Featured Entries

Menu entries can be marked as **Featured** (Yes/No toggle in the entry editor). Featured entries use the theme's `featured_clr` instead of `opt_clr` as their default foreground colour, making them visually distinct without hardcoding a specific colour.

Use this for entries you want to stand out, like Log Off, Verify Address, or other important options. The featured colour follows theme changes automatically.

## Menu Prompt Colour

The `menu_prompt_clr` theme property controls the "Active Hotkeys:" line displayed at the bottom of menus. This is separate from `prompt_clr` (which controls the command input prompt line) and `hotkey_clr` (which controls the hotkey letter in each entry).

## ANSI Colour Reference

| Value | Colour | Value | Colour |
|-------|--------|-------|--------|
| 0 | Black | 8 | Bright Black (Dark Grey) |
| 1 | Red | 9 | Bright Red |
| 2 | Green | 10 | Bright Green |
| 3 | Yellow (Dark) | 11 | Bright Yellow |
| 4 | Blue | 12 | Bright Blue |
| 5 | Magenta | 13 | Bright Magenta |
| 6 | Cyan | 14 | Bright Cyan |
| 7 | White (Grey) | 15 | Bright White |

## Theme Default Colour in Rich Text

When editing door descriptions or announcements in the admin panel, the TinyMCE colour picker includes a **Theme Default** option as the first colour in the palette.

Selecting "Theme Default" means the text will use the theme's configured colour for that content type, rather than being locked to a specific colour. This works on both the terminal and the web:

- **Terminal**: Text renders in the terminal's current default colour (set by the theme)
- **Web**: Text inherits the colour from the Content theme properties (`Door Description` or `Announcement Body`)

Use "Theme Default" for body text that should follow the theme. Use explicit colours (Red, Cyan, Bright Yellow, etc.) for text that should always be that colour regardless of theme.

**Tip**: If you want a door description to show as cyan on both terminal and web, set the `Door Description` theme property to 6 (Cyan) and use "Theme Default" for the body text. Highlighted words can use explicit colours like Bright Yellow.

## Default Theme

On first startup, the system automatically imports the bundled "Canectic" theme from `config/themes/canectic.json` into the database. This becomes the default theme. You can customize it or create new themes at any time.

The legacy JSON theme files in `config/themes/` are only used as a fallback if no database themes exist. Once themes are in the database, the JSON files are not consulted.
