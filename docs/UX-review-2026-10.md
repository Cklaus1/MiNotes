# UI review: every feature, rated

Status: review complete; Waves 1–3 fixed (see the wave notes in §3), Wave 4 open · Owner: Chris Klaus · Reviewed 2026-10-19
Build reviewed: `main` at `9741b30` (debug build, production frontend + CSP).

## 1. How this was done

Four reviewers drove the **real desktop app** (Tauri/WebKitGTK, real Rust
backend), not the browser mock, each on a private virtual display with a
throwaway home folder and demo data (`seed-demo` plus their own pages: up to 200
pages, 2,400 blocks, a 1,200-block page, nested projects, three notebooks, an
encrypted notebook, a two-device git sync over a local remote, Obsidian and
Evernote fixture imports). They used real keyboard and mouse input (xdotool,
the X clipboard) wherever it matters and WebDriver only to set up state or
inspect the page, and looked at every screenshot. ~700 screenshots in total
(kept in the session scratchpad, not in the repo).

I spot-checked the most serious findings against the code: image paste (only
`clipboardData.files` is read, `useBlockEditor.ts:375`), `#tag` and highlight
serialisation (`TagNode` and the TipTap Highlight extension have no markdown
serializer), `window.confirm` (capabilities only allow `dialog:allow-open`;
7 call sites), whiteboard export (`savePngToDownloads`), page HTML export
(`<a download>`), subfolders (`Sidebar.tsx` hard-codes `isExpanded={false}`).

**Rating scale.** 10 = as good as the best apps in the category (Obsidian,
Logseq, Notion) at their best: polished, discoverable, fast, accessible, no
bugs. 7–9 solid, minor polish missing. 4–6 works but rough, confusing or
inconsistent. 1–3 partly broken or hard to use. 0 broken or missing.

Limits: Linux/WebKitGTK only (no macOS/Windows/Android), software rendering
(timings are relative), no real AI key (Ask was tested against a local
OpenAI-compatible stand-in server), and the PDF/clipboard behaviour is
WebKitGTK's.

## 2. Scoreboard

Average **5.2 / 10** across 72 features. Nothing scores 10; the best is 9
(outside edits of the markdown copy).

| Area | Features | Average |
|---|---|---|
| Editor and writing | 27 | 5.1 |
| Navigation, organisation, notebooks | 17 | 5.1 |
| Visual views (graph, mind map, kanban, whiteboard, PDF…) | 11 | 5.0 |
| Settings, sync, AI, import, power features | 17 | 5.8 |

### Editor and writing

| Feature | Score | Verdict |
|---|---|---|
| Basic block editing (type, Enter, Tab, Shift+Tab) | 7 | Solid and fast; no indent guides; cramped hover controls |
| Split / merge | 5 | **Fixed** (`9541610`: one-line join, caret at the join, the split's space restored) — Merge joins with a newline and puts the caret at the end, so split→merge isn't reversible |
| Multi-block selection | 4 | Works via Escape + Shift+arrows; Tab leaks focus; Ctrl+A → Backspace silently wipes the page |
| Drag reorder | 3 | **Fixed** (`6675717`: outline order after a drop, text drag image, drop as a child) — Saved correctly, but the outline renders scrambled until reload; white-square drag image |
| Collapse / expand | 2 | **Fixed** (`3b45b43`, C-11) — Toggle can't be clicked (covered by other controls); collapsed blocks look like leaves |
| Inline formatting | 5 | Bold/italic/code/strike fine; **highlight is lost on save** |
| Bubble toolbar | 5 | Works; clipped under the header on the first block; ambiguous "H"; no link button |
| Headings | 7 | Work every way; bullet misaligned on large headings |
| Slash commands | 5 | **Fixed** (`cac18f6`: prefix/alias/fuzzy matching, Enter on No results closes, visible divider, Numbered List; icons/groups are Wave 3/4) — Exact-substring matching (`/h2` finds nothing); invisible divider; missing common commands |
| Wiki links `[[` | 7 | Good autocomplete and creation; no `]]` auto-close |
| Block references / transclusion `((` | 3 | **Fixed** (`9e370f7` parse, `50a636d` C-12: live chip text, card only for `{{embed ((uuid))}}`, page names in the picker) — Raw `((uuid))` after any reload; content shown twice; stale until reload |
| TODO / DOING / DONE | 7 | **Fixed** (`e271c67`: DONE struck through and dimmed, room after the badge) — Ctrl+Enter cycles with coloured badges; DONE not struck through |
| TODO badge / "All TODOs" | 2–3 | **Fixed** (`0edbc9c`: a live Tasks view, see C-8) — Writes a real page of raw `{{todo:pending}}` markup (both reviewers) |
| Tables | 7 | Tab between cells, clean markdown; columns resize while typing |
| Code blocks | 5 | Highlighting works; no language picker; typed fence + Enter saves escaped text (**fixed**, `01d33e6`) |
| Quotes / callouts | 6 | Quote fine; no callout block |
| Templates | 4 | Six built-in, flat; no user templates |
| Flashcards + review | 7 | Nice keyboard flow; dialog jumps on reveal; no next-interval hints |
| Page and block properties | 5 | Work, but tiny inputs; page properties hidden; typed `key:: value` not recognised |
| Page title rename | 7 | References rewritten; layout shift; panels go stale |
| Backlinks + unlinked references | 4 | **Partly fixed** (`72064ad`: rich rows, a click opens and highlights the block, refresh after a rename; grouping/paging and "Link" are Wave 4) — Raw markdown rows, 203 items flat, jumps to page not block, no "Link" action |
| Undo / redo | 5 | Works; structural undo needs Escape first; stray empty block; no feedback |
| Paste | 4 | Plain lines → blocks good; pasted markdown mangled (**fixed**, `01d33e6`, C-6); Wikipedia preview empty |
| Large page (1,200 blocks) | 6 | Typing fine; ~10 s to open (no virtualisation) |
| Empty page | 7 | Clear placeholder; inconsistent wording |
| Hashtags `#tag` | 1 | **Typing `#urgent ` saves as `[tag]t`** (data corruption) |
| Themes / narrow window | 7 | **Partly fixed** (`aff6c6a`: the sidebar collapses, a drawer below 900 px; faint bullets not touched) — Both themes coherent; faint light-theme bullets; sidebar can't collapse |

### Navigation, organisation, notebooks

| Feature | Score | Verdict |
|---|---|---|
| First run / empty notebook | 6 | Good Getting Started page; new notebooks open bare and silent |
| Projects / folder tree | 3 | **Fixed** (`8cbd704`: any depth, no limit, Move to… the whole tree, projects into projects, New sub-project) — **Subfolders can never be expanded** — nested pages unreachable; max 2 open projects |
| Pinned / recent / TODO badge | 3 | **Fixed** (`44393ca`: pinned pages stay in their project, archived/trashed pages leave Recent; `0edbc9c`: Tasks view; Wave 4 `18f2356`: a Recent section in the sidebar — optional, collapsible, remembered, live pages only) — Pinning works; TODO badge materialises the "All TODOs" page |
| Journal | 6 | **Fixed** (`d132ce9`: same header on empty days, buttons lead it; open day marked in the calendar; Alt+↑/↓) — Calendar with dots; Prev/Next jump position on empty days; no day shortcuts |
| All Pages | 6 | **Fixed** (`18f2356`: a main-pane view — the sidebar stays; project path, created and modified with the time, Pages / Journals / All, row ⋮ and bulk actions on ticked rows — move to a project, pin, archive, trash with Undo; ↑/↓, Space, Enter, Del; a thin drawn scrollbar instead of WebKitGTK's outlined overlay thumb) — Sort and filter; no actions, no path, stray scrollbar, sidebar hidden |
| Trash and Archive | 3 | **Fixed** (`f2673b4`: confirm with counts, ✕ visible; `18f2356`: Trash and Archive are main-pane views with a preview of the page, the deletion/archive date and time, multi-select Restore / Unarchive / Delete permanently with counted confirmations, Empty trash; the sidebar entries open them) — Delete has Undo, but **Empty trash and ✕ are permanent with no confirm**, and ✕ is clipped off-screen |
| Search palette (Ctrl+K) | 5 | **Fixed** (`a0b0fd8`: plain-text block results with their page, word-by-word title match, visible checkbox; `18f2356`: typo-tolerant ranking — "roadmp" / "raodmap" find Roadmap — highlighted matches in titles and snippets, Pages / Blocks / Journals / Other notebooks sections, Tab-cycled filters, a key-hint row; ~30 ms per keystroke at 5,000 pages in the browser journey) — Fast and keyboard-friendly; raw markup/UUIDs in results; no fuzzy matching |
| Command palette (`>`) | 4 | **Fixed** (`18f2356`: 40 commands from one registry — every app action with its shortcut; fuzzy ranking, recently run commands first; Switch notebook / Move page ask a second choice in the palette) — Only 10 commands |
| Cross-notebook `[[NB::Page]]` links | 7 | **Fixed** (`18f2356`: a locked target offers "Unlock and open" — the in-app passphrase prompt, then the page; a missing page in an existing notebook asks "Create page in <Notebook>"; Back returns to the source notebook) — Clear states; a locked target is a dead end; no way back |
| Notebook switcher / New notebook / encryption | 7 | **Fixed** (`3b9c8b1`: disabled buttons in the notebook dialogs look disabled and say why; `4e09469`: a switch shows a busy pill at once, holds input and ends with “Opened …”) — Excellent copy and recovery flow; disabled buttons look enabled; 5–10 s switches with no progress |
| Manage notebooks | 6 | **Fixed** (`efd9451`: rows keep their order, errors clear, Open per row, lock badge, quiet Delete) — Safe delete; list re-sorts after rename (the next click hit the wrong notebook) |
| Unlock / recovery / Lock now | 7 | **Fixed** (`4e09469`: lock and unlock show progress at once and end with a toast) — Clear; lock takes ~5 s with no feedback |
| Settings → Security | 7 | **Fixed** (`8ec2aff`: the app's own selects, both themes) — Complete and honest; unreadable dropdowns |
| Shortcuts (help + do they work) | 5 | **Fixed** (`52217c5`: Ctrl+/ and the palette open the list; `b100798`: Ctrl+N opens the in-app New page field; `18f2356`: back / forward — Ctrl+[ / Ctrl+], the mouse's back/forward buttons, toolbar arrows — across pages, views and notebooks) — Full list buried in Settings; Ctrl+N opens a native `prompt()`; no back/forward |
| Window title | 2 | **Fixed** (`fad7c73`: "Page — Notebook — MiNotes", "Locked — Notebook — MiNotes") — Always "MiNotes" |
| Narrow window (800 / 600 px) | 4 | **Partly fixed** (`aff6c6a`: collapsible sidebar, a drawer below 900 px; the ≤768 px Menu tab is unchanged — not reachable on the desktop) — Sidebar can't collapse; 600 px layout's Menu tab does nothing |
| Theme and contrast | 6 | **Fixed** (`33a1581` the `--text-muted` cycle, `8ec2aff` selects/checkboxes/radios, `e3c1ac5`+`660a0fa` the app's tooltip, `f3cb932` remaining fixed colours) — Clean; tooltips cover menus; native dropdowns unreadable in dark theme |

### Visual views

| Feature | Score | Verdict |
|---|---|---|
| Graph view | 4 | Fast (0.4 s at 200 nodes), but zoom drifts off the cursor, dragging opens the page, labels pile up. **Fixed** (`c91ae6a`): zoom anchored at the cursor, 4 px drag threshold, collision-culled labels by link count + hover neighbourhood, theme colours |
| Mind map | 6 | Horizontal/vertical good, re-parenting and SVG/PNG export work; radial layout broken; markdown export drops links. **Fixed** (`5117060`): leaf-weighted radial layout with no overlaps, export keeps links/headings, title once, refit on resize |
| Kanban | 5 | Looks good; **colour picker can't be clicked**; tiny drop zones; Esc closes the board. **Fixed** (`6f3a0fd`): picker clickable, colour synced as a block property, whole-column drop target, Esc closes the topmost popover, wiki chips open pages |
| Whiteboard | 6 | Tools, undo, zoom and persistence work; light canvas in dark theme; export skips the save dialog. **Fixed** (`ccb7fb4`, `d6cde77`): follows the theme, zoom % and undo/redo buttons, keyboard focus, save dialog + SVG export |
| Switching canvas modes | 7 | Returns to the same board; Draw tab with no board is a dead end. **Fixed** (`ccb7fb4`): Draw tab offers this page's board or a new one; no stale board on another page |
| PDF viewer | 3 | Renders and zooms; **highlights impossible** (no text layer); opening = typing a path into `prompt()`. **Fixed** (`c0af3c1`): text layer + highlights, native picker with recent PDFs, file name, disabled controls on errors |
| Link preview cards | 6 | Real metadata; no loading/failure state; URL shown twice on failure. **Fixed** (`02556ad`): loading / loaded / "Preview unavailable · open link" with the domain; User-Agent sent |
| Remote images | 8 | Clear placeholders and bar; Never/Ask/Always work |
| Pasted images (attachments) | 2 | **Real image paste saved as a `blob:` URL — gone after restart** |
| Export flows | 3 | Mind map export good; page "Export as HTML" saves silently to the working directory; whiteboard writes straight to Downloads. **Fixed** (`d6cde77`): every export through the save dialog with a toast naming the file |
| Narrow window / light theme (views) | 5 | Graph stays dark in light theme; mind map and whiteboard don't refit. **Fixed** (`c91ae6a`, `5117060`, `ccb7fb4`): graph and whiteboard follow the theme, the mind map refits on resize (the whiteboard keeps its camera, Fit/F refits) |

### Settings, sync, AI, import, power features

| Feature | Score | Verdict |
|---|---|---|
| Settings panel | 5 | Changes apply instantly; 2,700 px scroll, unreadable dropdowns, misleading "AI Assistant" section — **Fixed** (`abcc76d`: "Smart suggestions", says nothing is sent, "AI provider…" row; `52217c5`: a sticky section index; `8ec2aff`: readable selects) |
| Markdown copy status / Rebuild / Open folder | 7 | Clear, live status; paths cut off; Open folder gives no feedback |
| Outside edits of the markdown copy | 9 | Live update with Undo; deleted file → Trash with Restore |
| Git sync end to end | 4 | Robust engine, but **no way to set a remote in the app**, no "Sync now", duplicate pages on first join — **Fixed**: duplicates (`29f6908`, C-9), "Sync now" in Settings and the palette + status chip (`6721a80`, `abcc76d`); the remote field is Wave 4 |
| Conflict handling | 5 | Both versions kept; whole-page copy, no compare view; toast shows a literal `<device>` — **Fixed** (`6721a80`: the toast names the page, the device and the copy, with Open; copies leave the TODO count alone); compare view is Wave 4 |
| Mass-deletion hold | 8 | Clear Review / Trash / Keep banner; "25 pages (of 36)" next to a sidebar "Pages (35)" — **Fixed** (`46f87ba`: counts pages like the sidebar, journal days and projects named apart) |
| Copied-folder trust banner | 7 | Clear and safe; Settings doesn't show sync is paused — **Fixed** (`6721a80`: "Paused — waiting for your OK" with "Sync it here"; the other computer's "Last synced" is not shown) |
| Sync error states | 3 | A missing remote shows only a silent grey "Offline" — **Fixed** (`6721a80`: offline vs remote-not-found vs auth; chip tooltip, click → error, Retry; error in Settings; "Last synced" only after a push) |
| Import (Obsidian, Evernote) | 8 | Excellent preview, report and undo; undo has no confirmation — **Fixed** (`93911f8`: confirm with the page count and the edited pages it keeps) |
| AI setup | 7 | Very good privacy wording; hard to find (not in Settings), controls unstyled — **Fixed** (findability, `abcc76d`: Settings row, palette "Ask AI" / "AI Settings", shortcuts listed; styling `8ec2aff`: radios, checkboxes, the "▸ Advanced" button) |
| Ask panel | 7 | Streamed answer with clickable citations; slow to report a dead server; no Retry — **Fixed** (`abcc76d`: 2 s connect timeout for a server on this computer, "isn't running", Retry) |
| Privacy / remote images (settings view) | 6 | Works; Wikimedia images always fail (no User-Agent sent) |
| Security / encryption (settings view) | 4 | Clear dialogs, but confirmations are broken (see C-1 below) |
| CSS snippets | 5 | Live apply, strips `url()`; delete without confirm |
| SQL Query panel | 6 | Presets and read-only guard; rows not clickable |
| Plugins | 1 | Only an unsafe-loader stub; the real plugin manager is never shown — **Fixed** (stub hidden: `bbcc1a1`, development builds only); the plugin system is its own spec |
| Onboarding / help | 6 | Good Getting Started page; Ask/Import shortcuts missing from lists — **Fixed** (`abcc76d`) |
| Sync & version history dialog | — | (found in Wave 2) Local page snapshots called "Sync"; "Synced" and "Pending" counted the same pages — **Fixed** (`3c75d46`: "Page versions", non-overlapping counters) |

## 3. The bugs that matter most

Ranked by harm. **D** = data loss or corruption, **S** = safety/security, **B** = feature broken.

| # | Kind | Bug | Where | Effort |
|---|---|---|---|---|
| C-1 | S/D | **Fixed** (`7d345d4`: app-wide confirm dialog, `lib/confirm.ts`) — **Every `window.confirm` auto-accepts in the desktop app.** The dialog plugin replaces `confirm` with a Promise (rejecting: `dialog.confirm not allowed`, only `dialog:allow-open` is granted); a Promise is truthy, so all seven call sites proceed. Effects: the "this export is unencrypted" warning for **encrypted notebooks is skipped** (`lib/encryption.ts:93`), the recovery-key screen closes without its "have you saved it?" check, snippet/plugin/kanban-column deletes don't ask | 7 call sites | S |
| C-2 | D | **Fixed** (`922a083`: reads `clipboardData.items`; `blob:` images never stored) — **Real image paste is saved as a `blob:` URL** and is gone after restart. WebKitGTK fills `clipboardData.items`, not `.files`. Tests pass because they paste a synthetic `DataTransfer` | `useBlockEditor.ts:375` | S/M |
| C-3 | D | **Fixed** (`ce5747b`: serializer + parser + input rule) — **Typing `#tag` + space corrupts the block** (`#urgent ` → `[tag]t`); TagNode has no markdown serializer | `editor/TagNode.ts` | S |
| C-4 | D | **Fixed** (`20734b7`: `==text==` both ways) — **Highlights are dropped on save** (no `==…==` serializer) | `blockExtensions.ts` | S |
| C-5 | D | **Fixed** (`f2673b4`: confirm with counts; title ellipsis keeps ✕ visible) — **Empty trash and per-item delete are permanent with no confirmation**; the ✕ button is clipped out of view | `Sidebar.tsx` ~672 | S |
| C-6 | D | **Fixed** (`01d33e6`: structure-aware paste, `editor/pasteMarkdown.ts`; ```` ```lang ```` + Enter makes a code block) — **Pasted markdown is mangled** (escaped headings, flattened nesting, indented lines → code); typed ```` ```lang ```` + Enter saves escaped text | paste / input rules | M |
| C-7 | D | **Fixed** (`01ddbfa`: "N blocks deleted · Undo" toast; confirm before deleting every block) — **Ctrl+A → Backspace outside the editor deletes the whole page** with no confirmation or toast (Ctrl+Z restores it, nothing says so) | multi-select | S |
| C-8 | D | **Fixed** (`0edbc9c`: a virtual Tasks view; generated pages moved to the Trash once per notebook) — **The TODO badge writes a real "All TODOs" page** of raw markup that pollutes the page list, every page's backlinks and search | `App.tsx` ~950 | M |
| C-9 | D | **Fixed** (`29f6908`: the seeded onboarding page is recorded and, while untouched, gives way to a pulled page of the same title; an empty local journal gives way too; numbering is idempotent; the mirror state follows a file the pull gave to another page) — **Git sync: joining from a fresh device duplicates the onboarding page**, and copies multiply ("Getting Started (2) (2)") | sync import | M |
| C-10 | B | **Fixed** (`8cbd704`: expanded state per project at any depth, no 2-project limit) — **Subfolders can never be expanded** — pages in nested projects are unreachable from the sidebar | `Sidebar.tsx` ~1283 | S |
| C-11 | B | **Fixed** (`3b45b43`: gutter columns, arrow on top; ringed bullet + hidden count; Ctrl+Up/Down, block menu, Collapse all) — **Collapse can't be done with the mouse** — the toggle is covered by the drag handle and zoom trigger | block controls CSS | S |
| C-12 | B | **Fixed** (`9e370f7`: `((uuid))` parses into a block-ref chip; `50a636d`: the chip shows the referenced text, live, via `lib/blockRefs.ts`; the card only for `{{embed ((uuid))}}`) — **Block references render as raw `((uuid))` after any reload** | markdown → node parse | S/M |
| C-13 | B | **Fixed** (`6675717`: `lib/blockTree.ts` applyDrop + outline order; text drag image; drop as a child) — **After a drag, the outline renders scrambled** until reload (data is correct; positions sorted without outline order) | `PageView` `localBlocks` | S |
| C-14 | B | **PDF highlights can't be created** — no pdf.js text layer. **Fixed** in `c0af3c1` (text layer; Ctrl+P native picker + recent PDFs) | `PdfViewer.tsx` | M |
| C-15 | B | **Page "Export as HTML" saves silently into the app's working directory** (found later as `Project Alpha.html` in the repo root) with no dialog or message; whiteboard export writes to Downloads with no dialog. **Fixed** in `d6cde77` (save dialog + toast for every export; `save_png_to_downloads` removed) | `exportPage.ts`, `Whiteboard.tsx` | S |
| C-16 | B | **Kanban colour picker can't be clicked** (backdrop z-index 99 above picker 50). **Fixed** in `6f3a0fd` | `styles.css` | S |
| C-17 | B | **Partly fixed** (`6721a80`, `abcc76d`: "Sync now", status chip, "Last synced" only after a push, a missing remote is an error with Retry; the remote field / join wizard is Wave 4) — **Git sync can't be set up in the app** — no remote field, no "Sync now", "Last synced" shown with no remote, a missing remote is a silent "Offline" | Settings / sync | M |
| C-18 | B | **Mind map radial layout overlaps nodes**. **Fixed** in `5117060` | `blocksToFlow.ts` | M |
| C-19 | B | **Graph zoom drifts away from the cursor** (sign error) and **dragging a node opens its page**. **Fixed** in `c91ae6a` | `GraphView.tsx` ~461 | S |

Also worth fixing soon: link previews and remote images send no User-Agent
(Wikipedia/Wikimedia answer 403) (**fixed** in `02556ad`); Kanban Esc closes the
whole board (**fixed** in `6f3a0fd`); the whiteboard overlay lets typing reach
the hidden page underneath (**fixed** in `ccb7fb4`); Manage notebooks re-sorts rows
after a rename; split→merge isn't reversible (**fixed**, `9541610`).
(Wikipedia/Wikimedia answer 403); Kanban Esc closes the whole board; the
whiteboard overlay lets typing reach the hidden page underneath; Manage
notebooks re-sorts rows after a rename (**fixed**, `efd9451`); split→merge isn't reversible.

**Wave 1 notes (2026-10-21).** The markdown round-trip suite
(`src/editor/markdownRoundTrip.test.ts`, `npm test`) also found and fixed: task
lists came back loose (a blank line between `- [ ]` items). Logged, not fixed:
two marks that start at the same character are written in schema order
(`==**hi** there==` → `**==hi==** ==there==`, `*__b__ c*` likewise; same
formatting, the space between loses the outer mark) — a prosemirror-markdown
limitation. Native `prompt()` remains for Ctrl+N, Ctrl+P (PDF path), the
notebook-folder and `.zip` path fallbacks and the Evernote import path (Wave 3);
none of them relies on a `confirm` result. Journeys added: browser 66–67 and
65 (recovery key), desktop D15 (real X-clipboard paste, real typing, the app's
confirm dialog).

**Wave 2 notes — editor (2026-10-21).** Also fixed: the "AI suggested links"
bar no longer shifts the page (`cb44790`): it appeared above the blocks ~250 ms
after a page opened (the setting is on by default and the bar only showed with
suggestions — that part was right), so both suggestion bars now sit below the
last block. Block embeds use Logseq's syntax, `{{embed ((uuid))}}` (block menu →
"Copy block embed"); a plain `((uuid))` is only an inline chip with the
referenced block's text. Pasting: headings stay headings, list markers are
dropped (each item is a block, nested by indentation), task checkboxes are
kept, a fenced block is one code block; plain lines still paste one block per
line. Found on the way, not fixed (it touches every view): `styles.css` defines
`--text-muted: var(--text-muted)` in its Obsidian-compat block, a cycle, so
`var(--text-muted)` resolves to nothing everywhere — muted text falls back to
the inherited colour and borders drawn with it vanish (the invisible divider).
Deleting the two self-references fixes it app-wide; the new editor rules avoid
the variable. Journeys added: browser 69–77, desktop D16 (real mouse click on
the collapse arrow, real drags, markdown pasted through the X clipboard, a
typed ```` ```python ```` + Enter); journey 51 now expects the one-line merge.

**Wave 2 notes — settings, sync, AI, import (2026-10-21).** Root cause of
C-9: each device seeds its own "Getting Started" (different ids); the join
imported the other one as "(2)", the title went back to the first device in
the file's frontmatter, and when the two pages swapped names the mirror state
still tied the old path to the old page, so every sync made a new "(n)" copy
(an outside-edit import of the renamed file); numbering also re-suffixed
("(2) (2)"). Fixed in core with tests that failed before
(`test_fresh_device_join_keeps_one_getting_started`, `…_keeps_the_edited_…`,
`test_same_title_pages_from_two_devices_get_one_number_and_converge`: before,
`Getting Started (2) (2)` and `Ideas (2) (2)`). Two devices' own same-titled
pages (both edited) still both stay — "Ideas" and "Ideas (2)", the same on both
devices and stable; merging or naming them by device is an opportunity, not
done. The Ask "timeout" was this environment dropping packets to closed
loopback ports (curl times out too); on most machines a refused connection is
immediate — the 2 s loopback connect timeout covers both. Not done here
(Wave 4): a remote field / join wizard, a conflict compare view; the chip's
details popover doesn't scroll Settings to its Sync section.

**Wave 2 notes — navigation (2026-10-21).** Decisions: a project's count
includes its subprojects' pages (tooltip: "N here, M in subprojects"); Move to…
lists Top level and the whole tree (the current place disabled); open projects
are remembered per notebook at any depth. Pinned is a shortcut, so a pinned
page also stays in its project and in Pages. The Tasks view is not a page:
Open/TODO/DOING/DONE/All, a checkbox and a state chip rewrite the task's own
line (a `todo:`-style line becomes `DONE …`; a checkbox has no DOING, so DOING
turns it into a marker). The one-time cleanup trashes only pages titled "All
TODOs" whose every block is empty or exactly `{{todo:pending}} [[Title|<uuid>]]
text` at the top level (the old generated shape), logs them, says so in a
toast, and sets the `cleanup.all-todos-v1` UI-state flag. Journal Prev / Today /
Next now lead the header so the date's length can't move them. Alt+↑/↓ (free:
Alt+←/→ zoom blocks) step days. Manage notebooks keeps the rows' order from
when it opened; Escape in its rename field no longer closes the dialog
(`data-escape-local` in `Modal`). The window title shows the notebook's name
while locked (PRD-encryption §9 Q5: names shown), never a page title; the
desktop harness now finds the window by a title ending in "MiNotes". Journeys:
browser 79–84 (+ title and disabled-button checks in 65), desktop D18 (real
clicks: nested projects, Tasks toggle → database, Prev ×3 at one spot, rename in
Manage notebooks, `xdotool getwindowname`).

**Wave 3 notes — one UI system (2026-10-21).** All twelve items, each its own
commit on top of `3a307a7`. (1) `33a1581`: the Obsidian-compat block defined
`--text-muted: var(--text-muted)`; muted text inherited the normal colour and
everything *drawn* with it (borders, the AI select's arrow, sync dots) vanished.
Removed, and the muted tokens raised to AA (dark `#9399b2`, light `#565970`)
because fixing the cycle made muted text appear for the first time; a vitest
lint now fails on any custom-property cycle. (2) `8ec2aff`: selects, checkboxes
and radios are drawn by the app (`appearance: none`, theme arrow and check mark,
`color-scheme` per theme) with zero-specificity `:where()` rules; the open
option list is still GTK's own popup (readable, light) — replacing it would
need a custom listbox. (3) `8ec2aff`/`53ede19`: every disabled button and
control looks disabled (`.btn-gated` folded into the base styles); primary
buttons that silently did nothing now say why (import, join, move notebook,
read-only rebuild/encrypt, Open folder outside the desktop app). (4)
`e3c1ac5`/`660a0fa`: `lib/tooltip.ts` — every `title` gets the app's bubble;
it lifts the hovered element's and its ancestors' titles while hovered
(WebKitGTK otherwise drew the *row's* title over the page menu) and restores
them on leave, never shows while a menu/popover/dialog is open unless the
element is inside it, never over a menu, placed away from the pointer. (5)
`5e8d81e`: `lib/layers.ts` — one Esc rule: popover > menu > dialog > side panel
> canvas, newest first; ~20 window-level Escape handlers became layer
registrations; canvases with their own Esc steps yield while covered; the
editor yields Esc to an open layer (ProseMirror always `preventDefault`s Esc,
so it marks the key with `yieldEscape`). Before: Settings over the graph, the
palette over the graph and the notebook menu over Settings each closed two
things (journey 85 on the base: 3 of 5 failed). (6) `4e09469`: `lib/busy.ts` —
switch, lock, unlock and notebook .zip export/import show a busy pill in the
same task as the click (D19: 3 ms), hold input and end with a toast; import and
Sync now already had progress + toast. D10's "type then switch at once" race
did not reproduce standalone or under 28–40 busy CPU loops (5 + 3 + 6 runs);
an earlier full run's database showed the edit arriving *after* the check, i.e.
the barrier didn't see it. Two holes closed: the editor flush now reads
ProseMirror's pending DOM changes first (`domObserver.forceFlush`), and the
switch lets input already queued reach the page (`settleInput`) before the
barrier, then holds all keys until the new notebook is open — nothing can be
typed into a view that is going away. (7) `b100798`: no `prompt()` left: Ctrl+N
and the palette's New Page open the sidebar's own field (or `promptDialog` when
the sidebar is hidden); the browser-mode path fallbacks use `promptDialog`; the
dialog lint forbids `prompt(`. (8) `9b0b92f`: core `repo/page_titles.rs`
(`find_pages_by_title`, `title_in_use`, `find_journal_page`,
`list_journal_pages`, `link_candidates`; the name `search_page_titles` was
taken by the cross-notebook search) + Tauri commands + mock; All Pages and the
palette list every page. (9) `b684b64`: `lib/icons.ts` + `<Icon/>` (Lucide
shapes as path data, no dependency); user-picked page/project emoji stay;
lint against emoji UI icons; view-bar labels 11 px under 18 px icons. (10)
`f3cb932`: kanban header band and status edges, links in notes (attachment
links were the platform's blue/purple), danger/success text; the audit
(`desktop-check/audit.js`, 14 screens × 2 themes) found one AA miss left, the
page ⋮ button on the active row (4.45:1), fixed in `660a0fa`. (11) `52217c5`:
`useDialogFocus` (focus in, Tab trapped, focus back to the opener — read during
render, before an `autoFocus` field takes it) in `Modal` and every dialog
frame; Settings has a sticky section index; Ctrl+/ and the palette open the
shortcut list. (12) `aff6c6a`: the sidebar collapses (header button,
Ctrl+Shift+\, remembered in localStorage) and is a drawer below 900 px.
Journeys: browser 85–91 (21 of their 31 assertions fail on `3a307a7`),
desktop D19. Not done: a custom option list for selects; slash-menu icons
(Wave 4); the light theme's faint bullets.

**Wave 4 notes — navigation (2026-10-21).** All seven items in `18f2356`
(plus `43b0581`: Recent leaves out pinned pages; `911bb28`: an older reload
never overwrites a newer list — on the real backend the outside-write refresh
of the first page moved could land after the bulk move's own reload).
(1) Back / forward (`lib/navHistory.ts`): one history of pages, journal days,
the main views (Tasks, All Pages, Trash, Archive, Graph) and notebooks. App
reports where the user is and performs a step; the history, the keys and a
step waiting for its notebook live outside App, because the lock gate unmounts
App — Back into a locked notebook shows its unlock screen, and unlocking lands
on the page, not today's journal. Keys: Ctrl+[ / Ctrl+] (free in the app and
the editor; Alt+←/→ already zoom blocks), the mouse's back/forward
buttons (X buttons 8/9 arrive as DOM buttons 3/4; the webview's own history is
suppressed), arrows in the sidebar's action bar (floating next to "Show
sidebar" while it is hidden). Places passed on the way during a step (a
switch's landing on the journal) are not recorded; the landing of a switch the
user made is a place like any other. A page that went to the Trash or was
deleted is not reopened by Back (a toast says so). (2) Commands come from one
registry (`lib/commands.ts`; the app's 40 in `lib/appCommands.ts`), each with
its shortcut hint; Switch notebook and Move page ask their second choice in the
palette; "Move Page to Trash" is labelled "Delete Page" so that "move page"
finds only the move. (3) Ranking (`lib/fuzzy.ts`): exact > prefix > word start
> inside a word > words in any order > letters in order ("roadmp", "gtd") >
one typo per word (two from 8 letters; swaps count once); keywords count only
as whole words, half a tier down; recently run commands first among equals.
Search: Pages / Blocks / Journals / Other notebooks sections (journal days and
blocks on journal days under Journals), Tab-cycled filters, highlighted titles
and snippets cut around the first hit, a key-hint row, the "Create page" row
kept. Measured: 24–33 ms from a keystroke to the drawn results with 5,000+
pages in the browser journey (ranking alone 5–15 ms in `fuzzy.test.ts`); the
palette is now as tall as its results. (4) Trash and Archive are main-pane
views (preview, date and time, multi-select, counted confirmations; Archive
has Unarchive and Open). (5) All Pages moved from the canvas overlay to the
main pane (the sidebar stays; the canvas tab still works); the "stray
scrollbar" was WebKitGTK's overlay thumb drawn as an outline, now a thin drawn
scrollbar like the sidebar's. A move or pin keeps the rows ticked; archive and
trash clear them. (6) Recent in the sidebar: the last 5 live pages, collapsible
and hideable (palette), remembered on this device. (7) A chip into a locked
notebook: "Unlock and open" (the app's passphrase prompt; a wrong passphrase
asks again; Cancel leaves the unlock screen, Back returns); a not-found chip in
an existing notebook asks "Create page in <Notebook>" first. Journeys: browser
96–101, desktop D21 (real keys and mouse buttons, palette typing, real clicks;
checked in the database); existing journeys 62, 66, 84, D8 and the All Pages
Esc step follow the new views and the asking not-found chip. On the base
`571a120` the new browser journeys fail 38 of their 39 assertions (the one
that passes is the kept "Create page" row). Not done: back/forward per pane (the right sidebar has
none); a history list (long-press); the canvas's own Pages tab still shows the
old table without bulk actions.

## 4. Patterns behind the scores

1. **The markdown round trip is the weak seam.** Tags, highlights, block
   references, code-fence languages, pasted markdown and `key:: value` all
   break between the editor and the stored text (C-3, C-4, C-6, C-12). One
   round-trip test suite over every mark and node would have caught all of
   them.
2. **Tests drove the app in ways users don't.** Journeys pasted a synthetic
   `DataTransfer`, set collapse through the test API, and never pressed Esc
   on a confirmation — so C-1, C-2 and C-11 passed CI while broken for real
   users. Journeys for these flows need real input (the X clipboard, real
   clicks, real dialogs).
3. **Desktop-only gaps.** Several features use browser behaviour the desktop
   webview doesn't have: `confirm()`, `<a download>`, `prompt()` for Ctrl+N
   and Ctrl+P, native `<select>` styling. Each needs the app's own modal,
   save dialog or styled control.
4. **No shared UI system** (**fixed** in Wave 3, see its notes). Disabled buttons look enabled, native dropdowns
   are unreadable in the dark theme, tooltips cover menus, Esc closes too much
   or too little, icons are mixed emoji, slow operations (notebook switch,
   lock, unlock: 5–10 s) show no progress, and canvases ignore the theme.
5. **Navigation basics are missing.** No back/forward, a window title that
   never changes, a sidebar that can't collapse, a thin command palette, a
   shortcut list buried in Settings.
6. **Where it's strong:** everything built recently with the safety rules —
   outside edits (9), mass-deletion hold (8), import (8), remote images (8),
   the encryption dialogs' wording, cross-notebook links — is clearly better
   than the older editor and sidebar code.

## 5. Plan to raise the scores

### Wave 1 — stop data loss (all S; days)
C-1 one app-wide confirm modal replacing `window.confirm` (and grant nothing
new to the dialog plugin) · C-2 read `clipboardData.items`, never store a
`blob:` URL · C-3 / C-4 tag and highlight serializers · C-5 confirmations for
permanent deletes and fix the clipping · C-7 "N blocks deleted · Undo" toast
and a confirm for whole-page deletes · a **markdown round-trip test suite**
(every mark and node) · journeys that paste through the real X clipboard and
click real controls.

### Wave 2 — fix broken features (S/M; ~1–2 weeks)
C-10 subfolder expansion and drop the 2-project limit · C-11 clickable
collapse with a visible collapsed state · C-12 block-ref rendering · C-13
post-drop outline order · C-15 every export through the save dialog with a
toast · C-16 kanban z-index · C-19 graph zoom and drag threshold · C-8 a
virtual Tasks view instead of the "All TODOs" page (and remove existing ones)
· C-9 don't import a fresh device's onboarding page on first join · User-Agent
on outbound fetches · C-6 structure-aware paste.

### Wave 3 — one UI system (M) — done 2026-10-21 (see Wave 3 notes)
Styled selects, checkboxes, radios and visible disabled states with a reason;
custom tooltips that never cover menus; one rule for Esc (close the topmost
thing only); progress states for switch/lock/unlock/import; theme variables
for every canvas; an icon set instead of emoji; the app's own modal for
Ctrl+N and Ctrl+P instead of `prompt()`.

### Wave 4 — the features that make it feel complete (M/L)
Navigation part done 2026-10-21 (back/forward, the full command palette,
fuzzy search with sections and highlights, Trash/Archive and All Pages views,
Recent, cross-notebook chip actions — see "Wave 4 notes — navigation").

Sync setup in the app (remote field or "join existing", Test connection,
"Sync now", status chip, real error view) and a conflict compare view ·
navigation history (back/forward), a window title with page and notebook, a
collapsible sidebar, a Ctrl+/ shortcut overlay and a full command palette ·
search with rendered snippets, page context and fuzzy matching · backlinks
grouped by page with jump-to-block and "Link" for unlinked mentions · PDF text
layer and file picker · graph labels, local graph and search · mind map radial
layout · kanban "group by status" · slash menu with fuzzy matching, icons and
the missing commands (numbered list, callout, image, date, embed) · user
templates · list virtualisation for large pages · the plugin manager (or hide
the stub).

Doing waves 1–3 would move most features from 3–6 to 7–8; wave 4 is what it
takes to reach 9–10.

## 6. Process notes from this review

- **Harness fix:** `desktop.sh cli` ran the CLI with the real `HOME`, so
  `cli notebook list` read the real `~/.minotes` registry (read-only, once).
  It now always uses the scratch home (commit on the `review` branch).
- **Shared scratchpad collision:** two reviewers wrote a wrapper script to the
  same path at the same moment and one restarted the other's app once. Both
  noticed, moved to private folders and discarded the affected observations.
  Reviewers now need unique folders for helper scripts, not just for state.
- The desktop build's `Ctrl+Shift+I` also opens the WebKit inspector (debug
  builds only); not a product issue.
