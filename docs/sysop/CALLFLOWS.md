# Call Flows

A call flow is the sequence a caller goes through after connecting: log in, see who called last, read announcements, reach the main menu. Canectic has two kinds:

- **Terminal flows** run for telnet, TCP and browser-terminal callers. Each **call pool** (a set of connection paths) names the terminal flow its callers get.
- **The web call flow** runs for people logging in on the website. It walks them through what is new since their last visit, one card at a time, then sends them where they were going.

Both are edited under **Flows** (`/admin/callflows`) in the admin panel.

## The web call flow

It is the flow marked **Web** on the Call Flows page (normally called `Web`, or `WebLogin` if your board already had a flow of its own called Web). Out of the box it is:

```
Welcome -> Announcements -> Last Callers -> Who's Online -> The Wall -> News -> New Messages -> New Files
```

Changes to it take effect at once, with no restart.

### Editing it

- **Reorder** by dragging a stage.
- **Remove** a stage with its **x**.
- **Add** a stage from the list under the flow. The list offers only stages not already in the flow, because each stage can appear once.
- **Settings**: stages that have settings show a gear. Click it to change them. A stage whose settings differ from the default shows them on its badge, for example *The Wall (only when someone else has posted since their last visit; how many 5)*.

A stage with nothing to show is always skipped, whatever you set: nobody sees an empty New Messages card.

### Stages

| Stage | Shows | Settings |
|-------|-------|----------|
| Welcome | A greeting with a random piece of web art | none |
| Announcements | Announcements posted since the user's last visit, plus any pinned announcement | none |
| Last Callers | The most recent callers, terminal and web | **Show**: always, or only when someone else has called since the user's last visit. **How many**: 1 to 50, default 15 |
| Who's Online | Terminal nodes and web users online now | **Show**: always, or only when someone else is online |
| The Wall | Recent wall messages, with the post box for users allowed to post | **Show**: always, or only when someone else has posted since the user's last visit. **How many**: 1 to 50, default 15 |
| News | Your active news and score files (see News Files under Content) | none; shown only when there are some |
| New Messages | Unread messages in the user's subscribed areas | none; shown only when there are some |
| New Files | Files new since the user's previous visit in their subscribed file areas | none; shown only when there are some |

"Since their last visit" means since the last time they went through the web call flow. Someone going through it for the first time sees everything.

### Turning it off

Use `callflow_enabled` on the Configuration page (callflow category). The web flow itself has no Active switch, so there is only one place to look. `callflow_on_resume` decides whether someone coming back to an idle session is offered the flow again.

## Terminal flows and pools

Terminal flows are listed on the same page. They use terminal stages (Terminal Negotiation, Login/Registration, Main Menu and so on), and the Display Screen stage takes an argument, set with the pencil on its badge. Changes to terminal flows and pools take effect on the next gateway restart. See `MENUS.md` for how the `menu` stage leads into your menus.

## What the page refuses

The page will not save a change that would break callers, and it tells you why:

- **A web stage in a terminal flow, or a terminal stage in the web flow.** The terminal side disconnects a caller when it reaches a stage it does not know. Two stage names exist on both sides, Announcements and The Wall, and each kind has its own version.
- **A stage name the terminal side cannot run**, for example a typo in a flow's initial stages.
- **A pool on the web flow.** Pools run terminal flows only; the Web flow is not offered in the pool form. Even if a pool somehow named it, terminal callers would get the Standard flow instead.
- **A setting out of range**, such as asking Last Callers for 500.

A refused change leaves the flow exactly as it was.
