# PRD: Tabs

Status: phases 1–2 shipped (2026-11-17) · Written 2026-11-12

## 1. Overview

A row of tabs at the top of the page area, so several pages and views can stay
open at once and you can flip between them. Modelled on Evernote's tabs (desktop app), with the parts of Obsidian and
Notion that suit an outliner.

**One-liner:** clicking a page changes the current tab; you get a new tab only
when you ask for one.

### Why

- People switching from Evernote expect it, and it is now standard in desktop
  note apps (Evernote, Obsidian, Notion, RemNote, SiYuan).
- MiNotes already has the parts tabs need: back/forward history
  (`lib/navHistory.ts`), main-pane views (Tasks, All Pages, Trash, Archive),
  per-notebook UI state (`ui_state`), and a window title that follows the page.
- Today the only ways to keep two pages at hand are the right sidebar
  (Shift+click) and the Recent list, both of which lose the page's place.

### How other apps do it

| App | A normal click | New tab | Close | Notes |
|---|---|---|---|---|
| **Evernote** | replaces the current tab | `+`, right-click → Open in New Tab, Ctrl/Cmd+click a link, Alt+Shift+T (Win) | ×, Ctrl+W; no × with one tab | tabs can hold Home, Tasks, Calendar, Notebooks, Templates; pinned tabs; drag to reorder; `+` opens a configurable default |
| **Notion** (desktop) | replaces the current tab | Ctrl+click, `+` | ×, Ctrl+W | simple |
| **Obsidian** | replaces the current tab | Ctrl+click, middle-click, `+` | ×, Ctrl+W | pinned tabs, stacked tabs, split panes, linked panes |
| **VS Code** | opens a "preview" tab that the next click replaces | double-click / edit keeps it | ×, Ctrl+W | preview tabs confuse non-developers |

MiNotes follows Evernote and Notion: no preview tabs, no splits in v1.

## 2. Goals and non-goals

Goals
1. A tab row that behaves like Evernote's: switch in place, open new tabs on
   request, back/forward per tab.
2. Tabs hold pages, journal days and the main-pane views.
3. Tabs survive a restart, per notebook, without leaking titles of a locked
   encrypted notebook.
4. Keyboard-first: every action has a shortcut and a palette command.

Non-goals (v1)
- Split panes, stacked tabs, dragging a tab out into a new window.
- One tab row shared across notebooks.
- Tabs on Android or below ~900 px window width (see §4.9).
- Preview ("italic") tabs.

## 3. User-facing behaviour

### 3.1 The row

```
[ ← ][ → ]  [ 📌 Roadmap ][ Journal · Nov 12  × ][ Project Alpha ]  [ + ]   [⌄]
```

- Sits at the top of the page area, above the page title; the sidebar is not
  covered. Always visible on desktop, even with one tab, so `+` can be found.
- **← →** on the left: back/forward *for the active tab* (§3.4). Disabled when
  there is nowhere to go. The existing sidebar arrows move here.
- **Tabs:** an icon for the kind (page, journal, Tasks, All Pages, Trash,
  Archive, Graph) and the title; the active tab is highlighted. Long titles are
  shortened with an ellipsis, with the full title in a tooltip.
- **×** shows on hover and always on the active tab. **No × when only one tab is
  open** (as in Evernote); Ctrl+W does nothing then.
- **+** opens a new tab (§3.3).
- **⌄** appears when tabs overflow: a list of every open tab (searchable), so
  nothing is unreachable. The row scrolls sideways; it never wraps.
- **Pinned tabs** sit at the left, show only their icon (title in the tooltip),
  have no ×, and are skipped by "Close others" / "Close to the right".

### 3.2 What a click does

| Action | Result |
|---|---|
| Click a page in the sidebar, search, a `[[link]]`, a backlink, Tasks, All Pages | opens it **in the current tab** |
| **Ctrl+click** or **middle-click** any of those | opens it in a **new tab**, next to the current one, without switching to it (Ctrl+Shift+click: new tab and switch) |
| Right-click a page (sidebar row, All Pages row, search result) → **Open in new tab** | new tab, switched to |
| **Shift+click** a link | unchanged: opens in the right sidebar |
| Search palette: **Ctrl+Enter** on a result | opens it in a new tab |
| Opening a view (Tasks badge, All Pages, Trash, Archive, Graph) | in the current tab; Ctrl+click → new tab |

The mind map, kanban and whiteboard stay **overlays of the page in the tab**,
not tabs of their own (they belong to that page). Switching tabs closes an open
overlay.

### 3.3 New tab (`+`, Ctrl+T)

Opens a new tab after the current one with a default destination, chosen in
Settings → Editor → "New tabs open":

- **Today's journal** (default; MiNotes' home)
- A **new page** (title field focused; the page is created when the title is
  confirmed with Enter or "Create page", so an unused tab leaves nothing — no
  empty "Untitled" page)
- **All Pages**
- **Search** (the palette opens over the new tab; Esc leaves today's journal)

### 3.4 Back and forward

- Each tab has its own history (what `navHistory` keeps today, but per tab).
  ← / → , **Ctrl+[ / Ctrl+]** and the mouse back/forward buttons act on the
  active tab.
- A new tab opened from a link starts with that page; its Back goes nowhere
  (like a browser). "Duplicate tab" copies the history.
- Following a **cross-notebook link** switches notebooks and opens the target in
  that notebook's active tab; its Back returns to the source notebook (the
  current cross-notebook history behaviour, kept).

### 3.5 Closing and reopening

- × , **Ctrl+W**, middle-click on the tab. Closing the active tab activates the
  tab to its right (or left if it was last), as browsers do.
- Right-click a tab: **Close**, **Close others**, **Close to the right**, **Pin /
  Unpin**, **Duplicate**, **Reopen closed tab**.
- **Reopen closed tab:** remembers the last 10 closed tabs per notebook
  (with their history). Palette command and tab menu; no default shortcut
  (Ctrl+Shift+T is the theme toggle).

### 3.6 Reordering

Drag a tab to reorder; dragging onto/off the pinned group pins/unpins it.
Keyboard: Ctrl+Shift+PageUp / PageDown moves the active tab.

### 3.7 What a tab shows when its page changes

- **Renamed** (here, on another device via sync, or outside edit): the title
  updates live.
- **Moved to Trash / archived:** the tab stays and shows the page's Trash /
  Archive notice with Restore; it doesn't vanish under the user.
- **Deleted permanently** or not found after a sync: the tab shows "This page no
  longer exists" with Close.
- The **same page in two tabs** is allowed; only one tab is visible at a time, so
  there is still one live editor.

### 3.8 Notebooks and locking

- Tabs are **per notebook**. Switching notebooks swaps the tab row for that
  notebook's tabs (restored as they were).
- Stored in the notebook's own `ui_state` (key `tabs.v1`), never in browser
  storage, so an encrypted notebook's tab titles are encrypted with it.
- While a notebook is **locked**, the row shows no titles (the lock screen
  replaces the app, as today). After unlocking, its tabs come back.
- Restored on restart: tabs, order, pins, the active tab, each tab's history
  (capped), and scroll position where cheap.

### 3.9 Window title

The window title follows the **active tab** ("Page — Notebook — MiNotes"), as
it follows the page today.

## 4. Keyboard

| Shortcut | Action | Change from today |
|---|---|---|
| **Ctrl+T** | New tab | new (free today) |
| **Ctrl+W** | Close tab (nothing with one tab) | **was "New whiteboard"** |
| **Ctrl+Shift+W** | New whiteboard | moved from Ctrl+W |
| **Ctrl+Tab / Ctrl+Shift+Tab** | Next / previous tab (row order) | new |
| **Ctrl+PageDown / Ctrl+PageUp** | Next / previous tab | new |
| **Alt+1 … Alt+8** | Tab 1–8; **Alt+9** last tab | new (Ctrl+1–7 stay "pinned page") |
| **Ctrl+Shift+PageUp / PageDown** | Move the active tab left / right | new |
| Ctrl+[ / Ctrl+] , mouse 3/4 | Back / forward in the active tab | per tab now |
| Ctrl+click, middle-click | Open in new tab (background) | new |
| Ctrl+Shift+click | Open in new tab and switch | new |
| Ctrl+Enter (search palette) | Open result in new tab | new |

All of them are listed in the shortcut list (Settings and the Ctrl+/ overlay)
and as palette commands: New tab, Close tab, Close other tabs, Reopen closed
tab, Pin tab, Duplicate tab, Next/Previous tab, Go to tab… (a fuzzy list).

Keys typed inside the editor: Ctrl+Tab must not be swallowed by ProseMirror;
Tab / Shift+Tab inside the editor stay indent / outdent.

### 4.9 Small windows and Android

- Below ~900 px (where the sidebar becomes a drawer) the row shows only the
  active tab's title with ← → , `+` and ⌄; the ⌄ list switches tabs.
- Android: no tab row (`useCapabilities().mobile`); one page at a time, as
  today. Tab state of a notebook opened on Android is left untouched.

## 5. Design notes (for the implementer)

- **State:** a small store `lib/tabs.ts` — `{ tabs: Tab[], activeId }` with
  `Tab = { id, history: NavEntry[], index, pinned, title?, scrollY? }`.
  `navHistory` becomes per-tab (the active tab's history) instead of global;
  `noteLocation` writes into the active tab. Keep `NavEntry` as is.
- **Persistence:** debounced write of `tabs.v1` to `ui_state` (≤ 1/s), loaded on
  notebook open before the first page renders; history capped at 50 entries per
  tab, closed-tab stack at 10.
- **Switching tabs** = navigating: it goes through the existing save barrier
  (`flushPendingEdits`) like a page change, so typing is never lost.
- **One live editor:** only the active tab's page is mounted; inactive tabs keep
  just their entry and scroll position. No hidden mounted pages.
- **Titles:** resolved from the page id via the existing page cache, so renames
  update every tab.
- **Shortcut move:** Ctrl+W → close tab; whiteboard to Ctrl+Shift+W. Update the
  shortcut list, palette hints, CLAUDE.md, and any journey that presses Ctrl+W
  for a whiteboard.
- **Middle-click on Linux:** WebKitGTK may paste the X primary selection on
  middle-click; the link and tab handlers must `preventDefault` on `auxclick`
  so middle-click never pastes into a block.
- Icons from `lib/icons.ts`; tooltips via `lib/tooltip.ts`; Esc rule unaffected
  (the tab row is not a layer); disabled ← → use the shared disabled style.

## 6. Phases

1. **Core:** the row, current-tab switching, `+` / Ctrl+T (journal default), ×
   and Ctrl+W (no × with one tab), Ctrl/middle-click to open in a new tab,
   per-tab back/forward, per-notebook persistence, window title, the shortcut
   move. Views as tabs.
2. **Comfort:** pinned tabs, drag to reorder, the tab context menu (close
   others / to the right, duplicate, reopen closed), the ⌄ overflow list,
   Alt+1–9, the "New tabs open" setting, scroll restore.
3. **Later, if wanted:** split view (two tabs side by side), drag a tab into a
   new window.

## 7. Testing

- **Unit (vitest):** the tab store — open in current / new / background tab,
  close rules (no close of the last tab; active-tab choice after close),
  per-tab history back/forward, pin ordering, reopen-closed stack,
  serialisation round trip, history caps.
- **Browser journey:** click switches in place; Ctrl+click opens a background
  tab; `+` opens today's journal; × hidden with one tab; Ctrl+W closes; Back is
  per tab; a renamed page retitles its tab; a trashed page shows its notice;
  switching notebooks swaps the row and restores it.
- **Desktop journey (real keys and mouse):** Ctrl+T, Ctrl+Tab, Ctrl+W,
  Alt+2, a real middle-click on a link opens a tab **and pastes nothing**, mouse
  back button acts on the active tab, tabs restored after a restart, an
  encrypted notebook's tab titles are not in any file outside its database
  (extend the D13 leak scan), Ctrl+Shift+W makes a whiteboard.

## 8. Success measures

- No regression in navigation speed: switching tabs ≤ the cost of opening a
  page today.
- Zero lost edits on tab switch (covered by the save barrier tests).
- The tab row adds no visible change for someone who never opens a second tab,
  beyond the row itself.

## 9. Decisions (owner, 2026-11-12)

All four open questions were decided with the recommended option.

1. **`+` opens today's journal**, with the Settings choice "New tabs open:
   Today's journal / New page / All Pages / Search" (§3.3) — close to Evernote,
   which also lets you pick what new tabs show.
2. **Ctrl+Tab follows row order** (left to right, wrapping), as in Evernote and
   browsers. Back (Ctrl+[) covers "the page I was just on".
3. **The tab row is always shown**, even with one tab, so `+` and the ← → arrows
   have a fixed, discoverable place.
4. **A page already open in another tab still opens in the current tab** (the
   same page may be in two tabs). A "switch to the existing tab" setting can
   come later if asked for.

## Sources

- [Use tabs to multitask in Evernote — Evernote Help](https://help.evernote.com/hc/en-us/articles/52440426461075-Use-tabs-to-multitask-in-Evernote)
- [Pin and unpin tabs in Evernote — Evernote Help](https://help.evernote.com/hc/en-us/articles/51164135852563-Pin-and-unpin-tabs-in-Evernote)
- [Evernote finally brings back tabbed view — Digital Trends](https://www.digitaltrends.com/phones/evernote-finally-brings-back-tabbed-view-but-is-its-rising-prices-pushing-loyal-users-away/)
- [Essential Evernote shortcuts — Evernote blog](https://evernote.com/blog/command-control-essential-evernote-shortcuts/)
