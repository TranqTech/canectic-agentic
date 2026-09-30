# Customising the Website

What a sysop can change about the website without touching code. Everything here is edited in the admin panel and survives updates.

- **Navigation bar**: the links across the top (this page).
- **Web call flow**: the tour of what is new that users get after logging in. See `CALLFLOWS.md`.
- **Look**: colours and styles go in `public/css/custom.css`, which updates never overwrite; see `THEMES.md` for the theme colours the web shares with the terminal.

## Navigation bar

Edited under **Menus > Web Navigation** (`/admin/webnav`). It holds the links on the left of the bar, in order. Out of the box they are the links the bar has always had: Messages, Files, Doors, Chat and Wall.

The right side of the bar is fixed: Dashboard (for sysops), Mail, notifications, the account menu and Login. That is so there is always a way into the admin and into and out of an account, whatever happens to the links.

### What a link can point at

- **A page on this board**, chosen from a list: Messages, Files, Doors, Chat (Who's Online), Wall, Bulletins, System Info, Notifications, QWK and Door Server. QWK and Door Server are shown only while `qwk_enabled` and `doorserver_enabled` are on, so a link to a switched-off feature disappears by itself.
- **An address**: another website (`https://...`), or a path on this board (`/doors/play/lord` to start a door, say). Only `http://`, `https://` and paths starting with `/` are accepted. Tick **Open in a new tab** for links that leave the board.
- **A menu**: a heading that opens a list of links. Put links in it by choosing it under **Put it in**. A menu cannot go inside another menu, and a menu with nothing its viewer may see is not shown at all.

### Who sees a link

- **Who sees it**: everyone, visitors who are not logged in (a "Register" or "How to connect" link, say), or logged-in users.
- **Lowest security**: blank for anyone, or a security level.
- **Needs all of these flags** / **Hidden from anyone with**: the same flag rules as menu entries on the terminal.
- **Shown**: untick to hide a link without removing it.

**Hiding a link does not switch the page off.** The page is still there for anyone who types its address. To keep people out of something, use the security and flag settings of the thing itself (the message area, the door, the file area).

### Order and removal

Drag rows to reorder them: the top level in the first table, and each menu's links in its own table. The current page is highlighted in the bar, and a menu is highlighted when the page is one of its links.

A menu that still holds links cannot be removed or turned into a plain link; move or remove its links first. If you remove every link, the next gateway start puts the original five back, so a board is never left with an empty bar. To show no links at all, keep them and untick **Shown**.

Changes show on the website within a minute.
