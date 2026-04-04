# Pre-Release Test Checklist

Manual testing checklist for verifying all features before a release. Work through each section and check items as verified.

## Web Call Flow

- [ ] Fresh login redirects to /callflow
- [ ] Welcome stage shows BBS name (and web art if configured)
- [ ] Announcements stage shows new + pinned announcements with theme colours on black bg
- [ ] Last Callers stage shows recent callers with terminal colour classes
- [ ] Who's Online stage shows terminal + web users
- [ ] Wall stage shows messages, post input works inline, form disappears after posting
- [ ] News files stage shows configured news files (skip if none configured)
- [ ] New Messages stage shows summary without links (skip if no new messages)
- [ ] New Files stage shows summary without links (skip if no new files)
- [ ] Continue button and Enter key advance stages
- [ ] Skip All and Escape/S key jump to end
- [ ] Stages with no data auto-skip
- [ ] Progress text shows "Stage X of Y" at top
- [ ] Call flow completion redirects to home page
- [ ] Idle resume: leave a tab open past idle threshold, return, see "Welcome back" bar
- [ ] "Welcome back" bar "See what's new" link goes to /callflow
- [ ] "Welcome back" bar dismiss clears the prompt
- [ ] Wall post form reappears after idle resume (sessionStorage cleared)

## Session Management

- [ ] Login page shows "Remember Me (14 Days)" checkbox
- [ ] Login WITHOUT Remember Me: session expires after ~12 hours of inactivity
- [ ] Login WITH Remember Me: session persists across browser close/reopen
- [ ] Profile page shows "Log Out All Other Sessions" with password field
- [ ] Entering correct password kills other sessions (test with two browsers)
- [ ] Entering wrong password shows error, sessions preserved
- [ ] Admin user list: "Kill Sessions" button kills all sessions for target user
- [ ] Stale session: leave tab open until session expires, verify redirect to login (not stuck)
- [ ] PresenceSocket reconnect: after brief network interruption, reconnects with backoff

## PM Attachments

- [ ] Web compose (local): file upload field present, can attach files
- [ ] Web compose (network): file upload field present
- [ ] Web reply: file upload field present
- [ ] Sent message: attachments shown in message view with download links
- [ ] Received message: attachments shown with download links
- [ ] Download link works, correct filename
- [ ] Attachment access denied for non-owner (try accessing another user's attachment ID)
- [ ] Max file size enforced (> 10MB rejected)
- [ ] Max file count enforced (> 5 files, extras dropped)
- [ ] Terminal PM reader: shows "[Attachments available -- use web or IMAP to download]"

## PM Attachments -- IMAP

- [ ] Connect mail client (Thunderbird/Apple Mail) to IMAP
- [ ] Message with attachments shows paperclip/attachment indicator in message list
- [ ] Opening message shows attachment(s) available for download/save
- [ ] Downloading attachment from mail client works, correct file content

## PM Attachments -- SMTP

- [ ] Send email with attachment TO the BBS from an external mail client
- [ ] Message arrives in inbox with attachment(s) linked
- [ ] Send PM with attachment FROM the BBS via email relay
- [ ] Recipient's mail client shows the attachment

## PM Attachments -- FTN (if FTN peer available)

- [ ] Send netmail with file-attach flag from peer: file arrives and links to PM
- [ ] Send PM with attachment to FTN address: .flo entry created, file sent on next session

## Web Sysop Chat

- [ ] NodeSpy dashboard shows web presence users alongside terminal nodes
- [ ] Click "Chat" on a web user card: chat overlay appears on their browser
- [ ] Sysop can type messages, they appear in the user's overlay
- [ ] User can type messages, they appear in the sysop's overlay
- [ ] User navigates to a different page: chat overlay persists (Redis restore)
- [ ] Sysop can close chat (X button visible for sysop)
- [ ] User can only minimise, not close sysop chat
- [ ] Minimised badge shows unread count
- [ ] Click badge to restore overlay
- [ ] Typing indicator shows while other party types

## User-to-User Telegrams

- [ ] Who's Online page shows "Message" button next to web users (not yourself)
- [ ] Click message button: chat overlay appears on both sides
- [ ] Both parties can send messages
- [ ] Both parties can close the chat (X button visible for both)
- [ ] Chat persists across page navigation

## QWK Packets

- [ ] Web /qwk page shows subscribed area count and new message count
- [ ] Download QWK packet: file downloads with correct .qwk extension
- [ ] Open packet in QWK reader (MultiMail, BluWave, etc.): messages readable
- [ ] Compose replies in reader, save as .rep
- [ ] Upload REP packet: messages posted to correct areas
- [ ] Conference 0 PM replies delivered as PMs
- [ ] "No new messages" shown when nothing to download
- [ ] Terminal: qwkTransfer menu command works (D/U/Q menu)
- [ ] Terminal: ZMODEM download of QWK packet
- [ ] Terminal: ZMODEM upload of REP packet

## AreaFix / FileFix

- [ ] Send netmail to "AreaFix" with password in subject
- [ ] Body with `%LIST`: response lists all areas with * for subscribed
- [ ] Body with `+AREATAG`: area subscribed, confirmation in response
- [ ] Body with `-AREATAG`: area unsubscribed, confirmation in response
- [ ] Body with `%QUERY`: lists currently subscribed areas
- [ ] Body with `%AREAS`: returns areas.bbs format listing
- [ ] Body with `%HELP`: returns command reference
- [ ] Body with `%PAUSE` / `%RESUME`: toggles all subscriptions
- [ ] Response netmail arrives in sender's inbox
- [ ] Wrong password: authentication failed response
- [ ] FileFix: same commands work for file areas (send to "FileFix" or "TIC")

## FREQ (File Requests)

- [ ] Admin FREQ page: magic aliases list shows seeded "FILES" entry
- [ ] Add a magic alias: appears in list
- [ ] Edit / delete magic alias works
- [ ] Create file request: select peer, enter filenames, .req file created in BSO outbound
- [ ] Filebox browser shows files in configured filebox directory
- [ ] (If FTN peer available) Inbound .req processed: requested files offered back

## areas.bbs Import / Export

- [ ] Admin Messages > Import areas.bbs: upload form works
- [ ] Preview shows areatags with New/Already mapped status
- [ ] Per-area action dropdown: Create New or map existing area
- [ ] Per-area allow/enable checkboxes default correctly (allow on, enable off)
- [ ] Execute creates areas and maps to network
- [ ] Network detail page: "areas.bbs" download button produces valid file
- [ ] Export file contains all network areas in correct format

## News Files

- [ ] Admin Content > News Files: add a news file with path to ANSI/ASCII file
- [ ] News file appears in web call flow as a card with monospace rendering
- [ ] Terminal newsViewer: file displays full-screen, any key advances, ESC skips
- [ ] Centre option: wide terminal centers the content
- [ ] Inactive news files don't appear in call flow

## Seasonal Art

- [ ] Admin Content > Seasonal Art: default seasons present (Christmas, Halloween, New Year)
- [ ] Add a new season: directories created automatically
- [ ] Delete season with "delete directories" checked: empty dirs removed
- [ ] (To test resolution: temporarily add a season matching today's date, drop art in seasonal subdir)

## Menu Management

- [ ] Duplicate menu: new menu created with all entries copied
- [ ] Export JSON: downloads valid JSON file
- [ ] Import JSON: creates menu from uploaded file
- [ ] Import with name override: uses the provided name instead of file's name

## Wall / Oneliners

- [ ] Web /wall: post a message, form disappears
- [ ] Revisit /wall: form still hidden (sessionStorage)
- [ ] After idle resume: form reappears
- [ ] Call flow wall stage: own username shows in bright yellow
- [ ] Home page Wall tab only visible when logged in

## Home Page

- [ ] Announcements tab active by default
- [ ] Wall tab visible only when logged in
- [ ] Announcement cards have black background with theme text colour
- [ ] Pinned announcements show "Pinned" badge

## Admin

- [ ] Dashboard: News Files button present and works
- [ ] Jobs & Maintenance: "Scan Nodelists" button triggers job
- [ ] Jobs & Maintenance: "Purge Tossed Packets" button triggers job
- [ ] Admin user Kill Sessions: confirm dialog, sessions killed, count shown
- [ ] QWK Conference # field visible on message area editor
- [ ] Nodelist view: filter buttons work without DataTables error

## General

- [ ] Font size: text is noticeably larger than default Bootstrap (1.2rem)
- [ ] Node engine: verify `node -v` returns >= 18.0.0
- [ ] npm test: all 1,948 tests pass
