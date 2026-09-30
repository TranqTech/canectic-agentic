# Customising the Website

What a sysop can change about the website without touching code. Everything here is edited in the admin panel and survives updates.

- **Home page**: what the front page shows visitors and logged-in users (below).
- **Navigation bar**: the links across the top (below).
- **Web pages**: pages you write, each at its own address (below).
- **Web call flow**: the tour of what is new that users get after logging in. See `CALLFLOWS.md`.
- **Look**: colours and styles go in `public/css/custom.css`, which updates never overwrite; see `THEMES.md` for the theme colours the web shares with the terminal.

## Home page

Edited under **Content > Home Page** (`/admin/webhome`). There are two: one for visitors who are not logged in, and one for logged-in users, since someone finding the board for the first time needs different things (what the board is, how to connect, how to log in) from a caller coming back.

Each is a list of blocks, the same ones the web call flow uses (see `CALLFLOWS.md` for what each shows and its settings), plus **Log In**, a login form with links to register and to reset a password, shown only to visitors. Add, remove, drag to reorder and change settings exactly as on the Call Flows page. A block with nothing to show is left out, and blocks that only mean something to a logged-in user (New Messages, New Mail and so on) are never shown on the visitors' page even if added.

**Show the blocks as**: tabs, one block each (the home page as it has always been), or one above the other.

As shipped, visitors see Announcements and logged-in users see Announcements and The Wall, as tabs: the home page as it was before it could be edited. Announcements on the home page is set to show every current announcement; in the call flow it shows only new and pinned ones, and either can be changed with its gear. **Put back as shipped** returns a layout to that.

To put your own words on the home page (a welcome, how to connect, the rules), write a page under **Content > Web Pages** and add a **Page** block. If every block is empty, the home page shows a short welcome rather than nothing.

## Navigation bar

Edited under **Menus > Web Navigation** (`/admin/webnav`). It holds the links on the left of the bar, in order. Out of the box they are the links the bar has always had: Messages, Files, Doors, Chat and Wall.

The right side of the bar is fixed: Dashboard (for sysops), Mail, notifications, the account menu and Login. That is so there is always a way into the admin and into and out of an account, whatever happens to the links.

### What a link can point at

- **A page on this board**, chosen from a list: Messages, Files, Doors, Chat (Who's Online), Wall, Bulletins, System Info, Notifications, QWK and Door Server. QWK and Door Server are shown only while `qwk_enabled` and `doorserver_enabled` are on, so a link to a switched-off feature disappears by itself.
- **An address**: another website (`https://...`), or a path on this board (`/doors/play/lord` to start a door, say). Only `http://`, `https://` and paths starting with `/` are accepted. Tick **Open in a new tab** for links that leave the board.
- **A page you wrote**, from your Web Pages (below). The link is shown only to people who can read the page, and follows the page if you change its address.
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

## Web pages

Written under **Content > Web Pages** (`/admin/webpages`). A page is anything you want on the website that is not a message, file or door: how to connect, house rules, a history of the board, a list of other boards. Each has its own address, `/page/<address>`, made from the title unless you choose one.

Write it in the same editor as announcements and bulletins, with headings, links, images and tables as well. Untick **Show the title above the page** if the page starts with its own heading.

### Who can read it

The same choices as a navigation link: everyone, visitors who are not logged in, or logged-in users; a lowest security level; flags a reader needs, and flags that keep someone out. A visitor who opens a page they could read by logging in is taken to the login page and back; a logged-in user who may not read it is told so.

Untick **Published** to keep a page as a draft. A draft's address answers as though there were no page, so nobody can tell it is there.

### Using a page

- **In the navigation bar**: add a link under **Menus > Web Navigation** and choose **A page you wrote**. The link is shown only to people who can read the page, so a members' page does not show a link to visitors.
- **In the web call flow**: add the **Page** stage under **Flows** and choose the page with its gear. It can be added more than once, one page each; this is how to show a welcome notice or house rules in the tour. It is skipped for anyone who may not read the page. See `CALLFLOWS.md`.

Links and stages refer to a page itself, not its address, so changing the address never breaks them. A page that is linked or in the call flow cannot be removed until it is taken out of those; the Web Pages list shows where each is used. Unpublishing it hides it from both at once.
