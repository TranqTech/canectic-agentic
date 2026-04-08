# Canectic BBS - Changelog

## Pending (since v0.9.5a)

### Bugfixes
- Fix: Notification dropdown populated with recent unread notifications on connect (#1)
- Fix: Sysop notifications create one row per sysop (not shared broadcast rows) for correct per-user read state (#1)
- Fix: Menu JSON import NaN error from null colour values (#2)
- Fix: FTN NC addresses (node 0, e.g. 1:134/0) no longer rejected as invalid (#3)
- Fix: Message group creation security field handling hardened (#4)
- Fix: Message group create modal had single "Required Security" field instead of separate Read/Post Security + flags (#4)
- Fix: Duplicate admin view template files (flat file shadowing index.pug) consolidated
- Fix: Removing a network address crashed with "Cannot read properties of null" due to `postgres.write()` return value mismatch (#7)
- Fix: Missing `alogger` import in menus.js caused "alogger is not defined" error on menu import/duplicate
- Fix: Call flow completion loop when redirected from /callflow (return URL now sanitized to avoid redirect back to callflow)
- Fix: User-to-user telegram chat close button not appearing (CSS class specificity overriding inline style)
- Fix: Nodelist import crash on duplicate addresses in same batch (e.g. ZC and RC both listed as zone:net/0)
- Fix: SMB import crash on missing CP437 export name (convertCP437toUTF8 vs cp437ToUtf8)
- Fix: SMB import empty string for integer columns (source/destination zone/net/node now null when no FTN address)
- Fix: SMB import null bytes in text fields causing PostgreSQL rejection (0x00 stripped from all string fields)
- Fix: SMB parser header layout corrected (dataOffset at 64, totalDfields at 68, dfields-before-hfields order)
- Fix: SMB parser encoding changed from binary (Latin-1) to utf8
- Fix: Message table seen_by/path columns widened from VARCHAR(255) to TEXT (FTN paths can be thousands of chars)
- Fix: Callflow completion not updating session (session_index missing for pre-index sessions, added direct session ID fallback)
- Fix: Callflow force redirect restricted to GET only and excludes admin/pm/notification routes
- Fix: Callflow pending flag cleared on page render to break redirect loops
- Fix: SMB index record size corrected (20 bytes, not 28) -- was only finding 18 of 125 messages
- Fix: SMB import threading: flush thread stats every 10 messages during import for accurate subject matching
- Fix: Threading fallback: when reply parent is missing, falls back to subject matching instead of orphaning
- Fix: Threading window widened to 365 days for messages with "Re:" subject (was 30 days, missed long-running threads)
- Fix: Outbound FTN packets missing REPLY kludge -- replies sent from Canectic had no @REPLY, breaking threading on downstream systems
- Fix: Maintenance jobs blocked re-runs after completion (BullMQ jobId deduplication, added removeOnComplete/removeOnFail)
- Fix: Echolist/filebone import not back-filling local_area_id for pre-existing network area mappings
- Fix: Echolist reconciliation SQL using invalid table alias in UPDATE FROM clause
- Fix: Combined echolist/filebone view page scroll caused by modals inside main-wrapper (moved to page level)
- Fix: Filebone upload form field name mismatch with multer (filebone_file vs echolist_file)
- Fix: Filebone view/index routes matching :networkId before view/:id (Express route ordering)
- Fix: Filebone templates using renamed variable names (filebone/filebones) but routes passing echolist/echolists
- Fix: Area list parser not handling % comment lines or SBBSecho "Area AREATAG flags description" filebone format
- Fix: Cron schedule patterns had minute/hour fields swapped (hour 30 invalid)
- Fix: File group/area ~ path expansion (Node.js fs treats ~ literally, not as home directory)
- Fix: Echolist/filebone duplicate creation (same name on same network now re-uses existing entry)

### Features
- Group and area ordering: drag-to-reorder on message groups, message areas, file groups, file areas with Save Order button (#6)
- Mocha upgraded to 11.3.0 (fixes diff DoS vulnerability) (#5)
- sbbsecho.ini import: two-step migration tool to import linked FTN nodes from Synchronet, with network/address resolution, drag-and-drop peer grouping, and per-connection network selection
- Migrations hub: admin page consolidating all import and export tools at /admin/migrations
- Network echolist registry: per-network echolist management with import, diff preview, historical tracking, local-carried status, sysop notifications on area removals, multiple echolists per network with default flag
- Filebone registry: file echo list management (mirrors echolist system) with import, diff, historical tracking, sysop notifications on removals
- Admin dashboard redesign: tabbed layout with icon cards and instant search, System tab as default, all tools accessible
- Admin navbar reorganised: dedicated Networking dropdown (Networks, Peers, Nodelists, Echolists, Filebones, FREQ, Migrations), Config removed from nav
- Legacy admin netmail routes and views removed (netmail flows through PM system)
- User navbar: added Chat (links to who's online/telegrams) and Wall links
- PostgreSQL setup: install guide now includes manual DB/user creation walkthrough with PG 15+ schema grant instructions
- Admin message/thread deletion: per-message delete buttons in thread view, per-thread delete buttons in area view, Delete Thread in sidebar with confirmation modals
- Thread rebuild maintenance tool: `--rethread` CLI flag, admin Rebuild Threads button, re-processes all messages in chronological order
- Queue status panel on Jobs & Maintenance page: view active/waiting/delayed/failed jobs, remove stuck jobs, retry/remove failed, drain queues
- Combined echolist view: tabbed (All/Carried/Available/Orphaned) with counts on tabs, subscribe and unsubscribe/unmap actions, DataTables search on All tab
- Combined filebone view: same tabbed layout with browse/download/upload security fields and flag selectors
- Echolist/filebone subscribe modal: config-based security defaults, permission/restriction flag selectors, group auto-populate, separate Allow/Enable peer checkboxes
- Echolist/filebone unmap modal: cascading delete options (remove area, optionally delete tables/files)
- Echolist/filebone create from file upload: name derived from filename, import in one step
- Echolist/filebone local_area_id reconciliation: daily maintenance job + admin button, bidirectional sync
- Select All / Deselect All buttons on peer connection subscription modals (message and file, allowed and enabled)
- Message group post_as setting (username/realname) with push defaults to areas
- Configurable default security levels: config keys for message read/post and file browse/download/upload defaults
- Door collection membership: Collections tab on New Door and Edit Door modals with checkbox selection
- File group directory check/create: Check button on base_dir field shows whether directory exists, offers inline Create button
- Filebone subscribe modal: sub directory field for file area disk location
- Delete confirmation modals on all-echolists and all-filebones listing pages (replaces alert confirms)
- Standalone update.sh script: copies code, merges data, runs npm install and db migrations automatically
- 57 new unit tests for sbbsecho parser (2,016 total)
- Per-peer outbound fileboxes: optional `outbox_dir` on FTN peer connections, BSO scanner picks up files and sends with delete-after-send, admin UI field on connection forms
- Inbound file wildcards: sysop-configurable glob pattern rules route inbound files to specific directories, skip toss by default with still_toss override, admin CRUD at /admin/wildcards with drag-to-reorder and test tool
- %X variable substitution in filebox paths, wildcard target directories, file group base_dir, and file area sub_dir (e.g. %M for DOSemu drive_c)
- `filebox_base_dir` config key for per-peer filebox parent directory
- Inbound Wildcards link added to admin Networking dropdown
- Automated echolist/filebone scanning: daily maintenance job with four-tier priority: per-list scan_area, network echolist_area, network filebone_area, network infopack_area. Each tier checks for direct file match then newest ZIP. Auto-imports via diff pipeline with sysop notifications on locally-carried removals.
- Network file area config: echolist_area, filebone_area, and infopack_area fields on network edit form for configuring where network list files and infopacks are received
- Per-echolist/filebone scan_area: optional file area override for individual list scanning (highest priority)
- Scan Echolists/Filebones button on Jobs & Maintenance page for manual trigger
- Echolist reconciliation schedule moved to 4:30 AM (after echolist scan at 4:15 AM)
- File area retention limits: optional max_age_days and max_files on file areas and file groups (group defaults inherited by new areas), enforced by daily file-maintenance job (removes oldest files from DB and disk). Useful for nodelist/nodediff/infopack areas. 0 or blank clears the limit.
- Fix: fileAreas.newArea not returning insertId -- file areas created from filebone combined subscribe were not getting their network mapping created
- Fix: Binkp session race -- TransferEngine was created after async multi-address discovery, so M_FILE offers from fast remotes (e.g. binkd) during the await were lost, causing 60s timeout
- Fix: Peer polling with no remote_host now falls back to nodelist lookup for connection info
- Fix: FTN address matching normalizes .0 point suffix (169:1/107.0 matches 169:1/107) for mailers like Argus that advertise point 0 explicitly
- Fix: New message area with network mapping now sets allowed=true for peers (was leaving both allowed and enabled as false)
- Fix: Combined echolist/filebone subscribe allow/enable peer checkboxes -- both tabs had same-named checkboxes in one form, Express received array instead of string, sync was silently skipped
- Fix: FTN outbound packet buffer overflow on messages with long SEEN-BY/PATH lines (fixed 10KB buffer replaced with dynamic sizing)
- Fix: FTN outbound zone awareness -- packets and .flo files were always written to ftn/out/ regardless of destination zone, now uses BSO zone directories (ftn/out.015/ for zone 21, etc.)
- Fix: TIC outbound delivery broken -- staged TIC descriptors and attached files had no .flo flow file entries, so the mailer never discovered or sent them. Now creates .flo entries with zone-aware directories.
- Timed events system: sysop-configurable scheduled commands for door maintenance, backups, etc. Launch types: Native Command (shell) and Dosemu (headless). Cron scheduling via BullMQ, %X variable substitution, timeout enforcement, output capture. Admin CRUD at /admin/timed-events with run-now button.
- Update script: txtfiles/ now completely skipped during updates (was copying new files which could still interfere with custom art). Use --include-art to merge art files explicitly.
- Call flow editor: DB-backed call flows and call pools, replacing hardcoded arrays. Admin UI at /admin/callflows with drag-to-reorder stage editor, add/remove stages, pool-to-flow assignment, WS path config. System flows (Standard, Doorserver, WebDoor) seeded on first run, protected from deletion.
- displayScreen menu command: display art files from menus and call flow stages with type:Welcome/Goodbye random selection or specific subdir/filename targeting
- Missing menu commands added to admin dropdown: QWK Transfer, News Viewer, Notifications
- Honeypot login detection with fail2ban integration: login attempts with known-bad usernames (root, admin, etc.) logged to security.log with [HONEYPOT] tag. Normal auth failures logged with [AUTHFAIL] tag. Terminal connections using honeypot names are immediately disconnected. Honeypot names blocked from registration (show as "taken"). Config keys: honeypot_enabled, honeypot_usernames, trust_proxy. Example fail2ban filter + jail configs in examples/fail2ban/.
- Reverse proxy support: trust_proxy config key for correct client IP resolution behind nginx/Caddy/HAProxy (X-Forwarded-For headers)
- Fix: Terminal login and registration now accept special characters in passwords (was restricted to alphanumeric only)
- Bad echomail handling: messages received for unknown areatags are stored in a holding table instead of being silently lost. Tracked per-areatag with first/last seen, counts, and source addresses. Admin UI at /admin/bad-echomail with per-tag message browser, recover (import to area when created), and purge. Daily auto-purge via bad_echo_retention_days config (default 30). Fixes packets retrying endlessly when they contain messages for areas we don't carry.
- Inbound file log: tracks every file received via binkp/EMSI sessions with peer connection info. Tosser uses it to populate received_from on bad echomail entries. Config: inbound_log_retention_days (default 90 days).
- Newscan default on message groups and areas: new column (default false) on groups and areas, admin UI on all group/area create/edit forms and echolist subscribe modal. Groups inherit to new areas.
- Combined area browser for messages and files: single page grouped by group with Subscribed/All toggle, instant search, AJAX subscribe/unsubscribe buttons, and help modal. Replaces two-page group list + area list navigation.
- Fix: Message body_html with unclosed tags (del/s) no longer cascades strikethrough to subsequent messages (CSS containment on .msg-card)

## v0.9.5a (2026-04-04)

### Notification System
- Centralised notification model (`notifications` table) with user-targeted and sysop-broadcast types
- Bell icon in both admin and user nav bars with unread count badge and dropdown (10 recent items)
- `/notifications` full history page with pagination
- Real-time push via PresenceSocket: unread count on connect, new notifications pushed instantly
- Terminal `notificationReader` menu command: lightbar list, detail view, mark all read
- Notification producers wired: sysop receives `tic_error`, `pm_undeliverable`, `areafix_request`, `filefix_request`, `user_registered`; users receive `pm_received`
- Daily purge job for old read notifications
- Config keys: `notifications_enabled`, `notifications_retention_days`

### Call Flow Improvements
- Login always routes through callflow regardless of redirect target; original destination preserved and restored after completion
- Time-based triggers: 2+ hours shows prominent banner and redirects home page; 24+ hours force-redirects all pages
- Prominent "Welcome back" banner: blue bar with stars icon, large "See What's New" button, dismiss button
- `last_callflow_at` cached on session (loaded from DB once per session, not every request)
- Callflow completion updates all sessions for user via `sessionUpdateUser()` (multi-tab/device safe)

### WebSocket Background Tab Fixes
- Background tabs no longer attempt WebSocket reconnect (deferred to visibilitychange event)
- Server prune tolerance increased to 5 missed cycles for better background tab survival
- Session expired redirect deferred for background tabs until they become visible

### PM File Attachments
- File attachments on private messages across all transport types
- `pm_attachments` table linked by `message_uuid`, `has_attachments` boolean on pm_inbox/pm_outbox
- Attachment storage: `{pm_attachment_dir}/{YYYY-MM}/{uuid}/{filename}`
- Config keys: `pm_attachment_dir`, `pm_max_attachment_size` (10MB default), `pm_max_attachments` (5 default)
- LOCAL: shared file on disk, refs in both inbox and outbox
- EMAIL inbound: SMTP MIME multipart extraction with recursive nested multipart, base64/QP decode
- EMAIL outbound: nodemailer attachment passthrough
- FTN inbound: file-attach flag (0x0010) parsed from type-2 packet, files linked from ftn/in
- FTN outbound: flag set on attribute word, .flo flow file entries written for binkp delivery
- Web: multer upload on compose/reply forms, download route with ownership check
- IMAP: dynamic BODYSTRUCTURE (multipart/mixed), full RFC 2822 rendering with base64 attachment parts
- Terminal: text indicator "[Attachments available -- use web or IMAP to download]"

### Session Management
- Remember Me checkbox on login (configurable via `remember_me_days`, default 14)
- Session TTL default 12 hours (`session_ttl` config key), stored per-session for correct renewal
- Log Out All Other Sessions on user profile (password protected)
- Admin Kill Sessions button on user management page
- Session expiry detection: PresenceSocket heartbeat validates session, expired sessions redirect to login
- WebSocket reconnect with exponential backoff (5s to 60s max) on both user and admin layouts
- Node >= 18.0.0 engine requirement added to package.json

### Web Art and Seasonal Art
- Web art system: images served from `txtfiles/webart/{arttype}/` (PNG, JPG, SVG, GIF, WebP)
- Random image selection per page load for call flow welcome splash
- Seasonal/holiday art overrides: admin-configurable date ranges at Content > Seasonal Art
- When today's date matches an active season, art from `{arttype}/{season}/` is used before default pool
- Works for both terminal (ANSI/ASCII) and web (image) art
- Seeded defaults: Christmas (Dec 15 - Jan 2), Halloween (Oct 25-31), New Year (Jan 1-3)
- Auto-creates directories across all art formats when a new season is added
- Prompts whether to delete directories when a season is removed
- "Welcome" art type added to terminal (drawrandomscreen, drawscreen, menu display file types)
- Call flow welcome stage shows random web art + BBS name + greeting before data stages
- Install script creates all standard art directories on fresh install

### Menu Management
- Duplicate menu: copies all settings, layout, colours, and entries to a new menu identifier
- Export to JSON: download a menu and all entries as a portable `.json` file (DB IDs stripped)
- Import from JSON: upload a previously exported file to create a menu, with optional name override
- Buttons on menu list page (Import) and individual menu page (Duplicate, Export JSON)

### News Files
- Admin-configurable news/score files at Content > News Files
- Displays ANSI/ASCII art files from door games, scores, or BBS news in the call flow
- Terminal: `newsViewer` menu command displays files in sequence with any-key advance, ESC to skip
- Web: rendered as HTML via `formatBodyHtml` in monospace cards with black background
- Optional centering for oversized terminals (configurable source width per file, default 80)
- Drag-to-reorder, active/inactive toggle, add/edit/delete modals
- Integrates into both web and terminal call flows as a "News" stage

### Home Page
- Tabbed layout with Announcements and Wall tabs
- Font size bump to 1.2rem site-wide for improved readability

### Web Call Flow
- Guided login experience at /callflow mirroring the terminal call flow
- Stages: new announcements, last callers, who's online, wall (with inline post), new message summary, new file summary
- Auto-triggered on web login, prompted on idle session resume with "Welcome back" bar
- AJAX-driven single page with smooth stage transitions, no full page reloads
- Stages with no data auto-skip (e.g. no new announcements = stage skipped)
- Keyboard navigable: Enter/Space to advance, S/Escape to skip all
- New message and file summaries link directly to the relevant areas
- `users.last_callflow_at` column tracks "new since last visit" for announcement filtering
- Config keys: `callflow_enabled`, `callflow_on_resume`

### Theme System
- PostgreSQL-backed terminal colour themes with admin CRUD at /admin/themes
- Colour category accordion editor (General, Menu, Content, Messages, Files, Terminal)
- Cascade: per-entry colour > per-menu override > theme default > handler fallback
- Duplicate theme, set default, reset to theme defaults per menu
- Seeded from `config/themes/canectic.json` on first run
- TinyMCE "Theme Default" colour bridge: `#010101` sentinel maps to theme content colour via CSS
- Web colour bridge: `resolveWebColour(theme, context)` maps page contexts to theme properties for web content containers
- Themes button added to admin dashboard

### Menu System Overhaul
- Margin-based entry regions with configurable top/bottom/left/right margins
- Auto-column sizing: system calculates how many columns fit based on region width and entry text
- Max columns setting, column gap, fill order toggle (columns vs rows)
- Vertical centering within the entry region
- Lightbar mode: arrow-key highlight bar navigation with Home/End/PgUp/PgDn
- Featured entries rendered in a separate colour
- Art-defined entry positioning mode via `@Enn@`/`@Fnn@` codes in ANSI art

### Art Code System
- `@XX@` codes embedded in ANSI/ASCII art files, replaced inline at render time
- Universal codes: `@BN@` board name, `@UN@` username, `@DT@` date/time, `@ND@` node, etc.
- Width specifier: `@BN20@` for wider fields (pad/truncate to width)
- Menu codes: `@Enn@`/`@Fnn@` entry slot positioning, `@MT@`/`@HK@`/`@PR@`/`@ER@` UI positions
- Async pipeline for DB-backed codes (`@TC@` total calls, `@TU@` total users, `@ON@` online count)
- Fast path skips processing when no `@` byte found
- `drawfileWithCodes()` / `drawscreenWithCodes()` async rendering entry points

### Size-Aware Art Discovery
- Art file walk order: exact size match (`filename-WxH.ext`) > column match (within 5 cols, best row fit) > default (`filename.ext`)
- Size fit beats format capability (sixel > utf8 > ansi > ascii)
- Applies to all art rendering system-wide (menus, headers, screens)
- Sixel companion overlay: `.six` + `.ans` pairing for art-defined menus on sixel terminals

### Door Collections
- Many-to-many category grouping for door games
- Admin CRUD at /admin/doorCollections with drag-to-reorder
- Terminal door browser with collection navigation and description panel
- Web door listing with collection cards and play/info buttons
- Door browser auto-resume: returns to collection after door exit

### Door Runner Consolidation
- Five launch types: NativeShell (PTY), NativeCommand (piped stdio), Dosemu (console), DosemuPty (full), SyncJS
- Legacy ExecNative/SpawnNative/SyncJS types mapped to the consolidated set
- All launch types support output parser (CP437 conversion + DECSTBM centering)

### NodeSpy System
- Web dashboard at /admin/nodespy with auto-updating card grid (4-second AJAX poll)
- Live terminal snoop via xterm.js with OutputRingBuffer catch-up history
- Sysop-to-terminal chat: split-screen DECSTBM on target, web chat bar for sysop
- Chat queue: if user not at menu, chat fires automatically when they return
- One-time Redis token authentication for WebSocket connections
- Terminal `nodeSpy` menu command: node list, live watch, chat initiate

### Sysop Chat
- Break-in chat from NodeSpy (both web dashboard and terminal command)
- SplitScreenChat engine: DECSTBM scroll region, conversation history, input line, peek line
- Target input hijacked via `call.rawmode` during active chat
- 5 beeps on chat start, ESC to exit (sysop only)
- Chat queue indicator on both web (pulsing badge) and terminal (bold status badge)

### Web Sysop Chat
- Sysop can initiate real-time chat with web-browsing users from NodeSpy dashboard
- NodeSpy dashboard now shows web presence users alongside terminal nodes
- Chat routed through PresenceSocket (`/ws/presence`) with Redis-backed session persistence
- Floating chat overlay widget on all pages (both user and admin layouts)
- Chat survives page navigation via `chat_restore` with full message history from Redis
- Minimise to badge with unread count, typing indicators, notification sounds
- Config keys: `web_chat_enabled`, `web_chat_sound`

### User-to-User Telegrams
- Any authenticated web user can send a real-time message to another online web user
- "Message" button on Who's Online page next to web users
- Same chat overlay and PresenceSocket infrastructure as sysop chat
- Two chat modes: `sysop` (admin-only, target can only minimise) and `telegram` (any user, both can close)

### Wall / Oneliners
- Terminal wall handler: display recent messages, post prompt, call flow stage + menu command
- Web wall at /wall with post form, also embedded on home page
- Access control: `wall_post_security`, `wall_post_required_flags`, `wall_post_restricted_flags`
- Auto-purge: oldest messages removed when count exceeds `wall_max_messages` (default 60)
- Admin management at /admin/wall with delete capability
- One-post-per-session soft limit (web form hidden after posting, terminal skips prompt)
- Terminal colour highlight for own posts
- Config keys: `wall_display_count`, `wall_max_length`, `wall_max_messages`

### Bulletin System
- DB-backed bulletins with admin CRUD at /admin/bulletins (Content menu)
- TinyMCE editor for bulletin content, drag-to-reorder, active/inactive toggle
- Terminal `bulletinViewer` menu command: numbered selection, art file display with scrolling
- Web bulletin listing at /bulletins with detail view
- Art file association: bulletins can reference ANSI art files for terminal display

### System Statistics
- Terminal `sysInfo` menu command + call flow stage (SubModuleAdapter)
- Web /stats page with system info card
- Aggregated statistics: total users, total calls, total messages, total files, online count
- `formatFileSize()` utility for human-readable file sizes

### File Subscriptions and Newscan
- User file area subscriptions: T key toggle in file area selector (mirrors message area pattern)
- `user_file_subscriptions` table with user override > area `newscan_default` resolution
- `fileNewscan` terminal menu command: scan subscribed areas for new files since last visit
- File area selector shows new file counts per area

### Custom Permission and Restriction Flags
- Sysops can define custom flags beyond the built-in set (Sysop, Mod, Adult, etc.)
- Config keys: `custom_permission_flags`, `custom_restriction_flags` (comma-separated)
- Custom flags appear in all flag selectors: area access, menu entries, wall posting
- Built-in flags always present, custom flags appended

### User QWK/REP Packet Handling
- Personal QWK packet download: subscribed message areas + unread PMs, uses existing scan pointers
- REP packet upload: replies posted to message areas via standard posting path, PM replies delivered
- Web interface at /qwk with download button and upload form
- Terminal menu command `qwkTransfer` with D/U/Q hotkey menu and ZMODEM/XMODEM protocol selection
- Conference numbers via `message_areas.qwk_conf_number` column (defaults to area ID, sysop-editable)
- Config keys: `qwk_enabled`, `qwk_bbsid`, `qwk_max_msgs_per_area`

### areas.bbs Import
- Admin tool at Messages > Import areas.bbs for batch-creating message areas from FTN hub area lists
- Upload areas.bbs file, select target message group and network
- Preview with per-area controls: include/exclude, action (Create New or map existing unmapped area), allow peers, enable peers
- Bulk controls: Select All, Deselect All, Toggle All Allow, Toggle All Enable
- New areas inherit group security level and permission/restriction flags

### Who's Online and Activity Tracking
- Web activity middleware: session renewal, Redis presence with `setActivity()` for page-specific labels
- PresenceSocket (`/ws/presence`): lightweight WebSocket for heartbeats, presence tracking, chat
- Activity map: central display label resolution for both terminal and web activities
- Who's Online page: merged terminal nodes + web presence, deduplication, activity labels
- Who's Online partial reusable for home page and call flow embedding
- Last Callers page with source badge (Web/Terminal), reusable partial

### Goodbye Handler
- Confirm logoff prompt with batch download check
- If user has tagged files in batch, prompts to download before disconnecting
- Protocol selection (XMODEM/ZMODEM) for batch download on exit

### Web Activity Tracking
- Centralized session renewal in `webActivity.js` middleware
- Redis presence with `setActivity()` for page-specific activity labels
- `getOnlineUsers()` API merging terminal and web sources
- Configurable idle threshold for new call record logging

### File Area Maintenance
- Duplicate file cleanup (hash-based detection)
- Missing file removal (DB entries for files no longer on disk)

### Testing
- 471 new unit tests (1,649 total, up from 1,178)
- New test coverage: areaAccess, activityMap, wall, bulletins, announcements, systemStats, artCodes, qwkUser
- Bulletin `updateById` argument order bugfix found and fixed via testing

### AreaFix / FileFix
- Automated echomail area management via FTN netmail (AreaFix)
- Automated TIC file area management via FTN netmail (FileFix)
- Commands: +AREATAG (subscribe), -AREATAG (unsubscribe), %LIST, %QUERY, %AREAS, %HELP, %PAUSE, %RESUME
- Authentication via `areafix_password` in peer connection_data (password in Subject line)
- Auto-generates response netmail queued as outbound packet
- Processor routing in `ftnNetmailAdapter.js`: 'areafix'/'areamgr' and 'filefix'/'filemgr'/'tic'

### FREQ (File Request)
- Three-layer file resolver: magic aliases > filebox directory > file entries database
- Inbound: binkp session detects `.req` files, resolves and queues files for sending back
- Outbound: admin UI at Messages > File Requests to create `.req` for any FTN peer
- Magic alias CRUD with file/filelist/nodelist types (seeded with FILES=filelist)
- Auto-generated BBS-wide file listing (magic type `filelist`, written to filebox as `_FILES.LST`)
- Filebox browser showing current files in `ftn/filebox`
- Config keys: `freq_enabled`, `freq_filebox_dir`, `freq_max_files` (default 10)

### areas.bbs / files.bbs Export
- `generateAreasBbs()` utility for generating areas.bbs/files.bbs from network mappings
- Admin download routes: `/admin/export/areasbbs/:networkId`, `/admin/export/filesbbs/:networkId`
- Download buttons on network detail pages in admin
- `%AREAS` command in AreaFix and FileFix returns the listing in areas.bbs/files.bbs format

### Tossed Packet Retention
- `ftn_keep_tossed_days` config key controls retention of tossed FTN packets (default 7 days)
- 0 = delete immediately after tossing, 999 = keep forever
- Daily maintenance job `purge-tossed` at 2 AM removes expired packets
- Tosser reads config at runtime instead of using hardcoded constants

### Admin Panel
- Scan Nodelists and Purge Tossed Packets buttons added to Jobs & Maintenance page

### Multi-Address Binkp Sessions
- Binkp sessions now handle multiple peer connections when the remote advertises multiple AKAs in M_ADR
- Password-filtered grouping: additional connections only included if their session_password matches the authenticated password and is non-empty
- Outbound file list built independently for each grouped connection (no cross-contamination)
- All active FTN addresses advertised in M_ADR with defaults first
- Session deduplication checks all grouped connections to prevent duplicate outbound polls
- Backward compatible: single-address sessions work identically

### Bugfixes
- Fixed DataTables column mismatch on nodelist view (missing Connects Via column in AJAX rebuild)
- Fixed bulletin `updateById` argument order (arguments were reversed)
- Fixed duplicate web call logging (activity timestamp now set on login)
- Fixed stale web sessions causing reconnect loops (session expiry detection added)

### Documentation
- Door server design doc captured (design for multi-BBS door game sharing, not yet built)
- Process separation architecture note in `PROCESS_ARCHITECTURE.md` (future web/terminal split guidance)

### Infrastructure
- Version read from `package.json` via config system (not per-call file reads)
- Shared access check utility (`src/utils/areaAccess.js`) extracted from route code
- `areasBbsParser.js` utility for areas.bbs file parsing and generation
- Web presence `userSockets` reverse index for targeted WebSocket message delivery
- Redis-backed chat sessions with TTL safety net and automatic reconnect restore

## v0.9.1-alpha.1 (2026-03-29)

### Web Door Launcher
- Browser-based door game access via xterm.js embedded terminal
- Token-based WebSocket authentication (server-generated, one-time use, 60s TTL)
- Fixed 80x25 terminal with auto-scaling font in centered card layout
- Door listing page at /doors with play links
- Auto-redirect to door list on door exit

### Terminal Scaling and Centering
- DECSTBM scroll region for vertical + horizontal centering of door output on oversized terminals
- Output parser extended to all door launch types (NativeShell, ExecNative, SpawnNative, Dosemu, DosemuPty, SyncJS)
- Per-door `fixed_size` flag in admin door editor for doors that need forced 80x25 centering
- CP437-to-UTF8 conversion in output parser without byte mangling on raw CP437 terminals
- Form feed (0x0C) intercepted and converted to proper ESC[2J clear for xterm.js compatibility
- Scroll region preserved across door screen clears, reset on parser destroy

### Encoding Detection
- Fixed UTF-8 test character sending 4 bytes instead of 2 (JS string encoding issue)
- TTYPE-based encoding override for modern terminals (xterm, gnome, konsole, etc.)
- TTYPE response now stored on call object from telnet subnegotiation
- Populated UTF-8 charset glyphs (30 characters) and box drawing characters (40 characters)
- Fixed getboxes() returning wrong array for UTF8 encoding

### User Verification
- 6-digit verification code sent via email (SMTP relay) or FTN netmail on registration
- Auto-send on registration and address change
- Terminal verification handler (call flow + menu command) with send/enter/change address
- Web verification page with send, enter code, change address, days remaining countdown
- Unverified restriction flag added to new accounts on creation
- Security level bump on verification (configurable via verified_security)
- Sysop auto-verified on promotion
- Unverified account purge (configurable retention period, daily maintenance job)
- Mail type auto-detection for email vs netmail (handles 5D FTN addresses)

### Password Reset
- Pre-login: code-based reset from logon screen (username, send code, enter 8-char code, set password)
- Web: forgot password page with token link, password change form
- Post-login: change password menu command (current password required)
- 4-hour token expiry, 2-minute rate limit between sends
- "Forgot Password?" link on login page

### Profile Editing
- Editable fields: username (with configurable cooldown, default 90 days), name, location, gender
- Inline password change section on profile page
- Verification status badge with link to verify/change address
- Username change updates session immediately

### Admin Panel
- Jobs & Maintenance page with tabbed manual triggers for all worker jobs
- Announcement drag-to-reorder with save button
- Menu entry drag-to-reorder with save button
- User maintenance button on admin users page
- SMB message base import (upload .shd/.sdt/.sid, preview, import to target area)
- Door editor: fixed_size toggle for per-door centering control
- TinyMCE GPL license key configured

### Infrastructure
- Empty-string DB config values now fall back to defaults (was overriding with blank)
- Menu entry permission/restriction flag parsing handles JSON strings
- User maintenance worker (mailtype reconciliation + unverified account purge)
- Daily user maintenance schedule (5:00 AM)
- Legacy TCP/Telnet servers start when their ports are explicitly set
- Default menu entries (redrawMenu on ?) added to new menus automatically
- Hotkey prefix on menu entries using menu/theme hotkey color

### Synchronet JS Doors
- Output parser wired for SyncJS doors (CP437 conversion + optional centering)
- Fixed noyes() return value (true=No, false=Yes) matching Synchronet convention
- Fixed deny() to pass through noyes() directly
- Documentation warning about yesno()/noyes() return value asymmetry

---

## v0.9.0-alpha.1 "Handshake" (2026-03-24)

First public alpha release.

### Core Systems
- Terminal server with auto-detect TCP/Telnet and WebSocket support
- ANSI/CP437 and UTF-8 terminal with auto-detection and wide terminal support
- Hotkey menu system with configurable colors and layout
- Threaded message reader with scrolling viewport and quoting
- Full-screen message editor with word wrap and quote system
- File browser with native XMODEM and ZMODEM transfer engines
- Batch file downloads with tag-and-download
- Door game support (NativeShell, ExecNative, SpawnNative, Dosemu, DosemuPty, SyncJS)
- Private messaging across 5 transport types (LOCAL, FTN, QWK, EMAIL)

### Web Interface
- Responsive web forum with Bootstrap 5 Darkly theme
- File browsing, download, and multipart upload with hash verification
- Webmail-style private messaging with split-pane inbox
- 6-step registration wizard with AJAX validation and gender field
- Landing page with announcement/bulletin system
- Admin dashboard with full CRUD for all system entities

### Networking
- FTN type-2 packet tosser with binkp mailer (TCP + WebSocket)
- BSO outbound scanner with nodelist routing
- QWK client pull/push and hub mode
- NNTP article pull/push
- TIC file echo distribution with auto-forwarding
- Internet email transport (outbound SMTP relay, inbound trusted gateway)

### Mail Client Access
- IMAP4rev1 server for PM access from mail clients
- SMTP submission server with multi-transport addressing
- Cross-process IMAP IDLE push notifications

### Infrastructure
- Four-process model (gateway, worker, mail, mailer) managed by PM2
- BullMQ job queues with scheduled toss cycles and maintenance
- Three-tier configuration (.env > database > defaults) with admin UI
- Declarative database migrations
- CSRF protection, startup DB/Redis validation, health check endpoint
- Install/update script, .env.example template
- 1,178 tests passing
