# UI review: every feature, rated

Status: review complete, nothing fixed yet · Owner: Chris Klaus · Reviewed 2026-10-19
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
| Split / merge | 5 | Merge joins with a newline and puts the caret at the end, so split→merge isn't reversible |
| Multi-block selection | 4 | Works via Escape + Shift+arrows; Tab leaks focus; Ctrl+A → Backspace silently wipes the page |
| Drag reorder | 3 | Saved correctly, but the outline renders scrambled until reload; white-square drag image |
| Collapse / expand | 2 | Toggle can't be clicked (covered by other controls); collapsed blocks look like leaves |
| Inline formatting | 5 | Bold/italic/code/strike fine; **highlight is lost on save** |
| Bubble toolbar | 5 | Works; clipped under the header on the first block; ambiguous "H"; no link button |
| Headings | 7 | Work every way; bullet misaligned on large headings |
| Slash commands | 5 | Exact-substring matching (`/h2` finds nothing); invisible divider; missing common commands |
| Wiki links `[[` | 7 | Good autocomplete and creation; no `]]` auto-close |
| Block references / transclusion `((` | 3 | Raw `((uuid))` after any reload; content shown twice; stale until reload |
| TODO / DOING / DONE | 7 | Ctrl+Enter cycles with coloured badges; DONE not struck through |
| TODO badge / "All TODOs" | 2–3 | Writes a real page of raw `{{todo:pending}}` markup (both reviewers) |
| Tables | 7 | Tab between cells, clean markdown; columns resize while typing |
| Code blocks | 5 | Highlighting works; no language picker; typed fence + Enter saves escaped text |
| Quotes / callouts | 6 | Quote fine; no callout block |
| Templates | 4 | Six built-in, flat; no user templates |
| Flashcards + review | 7 | Nice keyboard flow; dialog jumps on reveal; no next-interval hints |
| Page and block properties | 5 | Work, but tiny inputs; page properties hidden; typed `key:: value` not recognised |
| Page title rename | 7 | References rewritten; layout shift; panels go stale |
| Backlinks + unlinked references | 4 | Raw markdown rows, 203 items flat, jumps to page not block, no "Link" action |
| Undo / redo | 5 | Works; structural undo needs Escape first; stray empty block; no feedback |
| Paste | 4 | Plain lines → blocks good; pasted markdown mangled; Wikipedia preview empty |
| Large page (1,200 blocks) | 6 | Typing fine; ~10 s to open (no virtualisation) |
| Empty page | 7 | Clear placeholder; inconsistent wording |
| Hashtags `#tag` | 1 | **Typing `#urgent ` saves as `[tag]t`** (data corruption) |
| Themes / narrow window | 7 | Both themes coherent; faint light-theme bullets; sidebar can't collapse |

### Navigation, organisation, notebooks

| Feature | Score | Verdict |
|---|---|---|
| First run / empty notebook | 6 | Good Getting Started page; new notebooks open bare and silent |
| Projects / folder tree | 3 | **Subfolders can never be expanded** — nested pages unreachable; max 2 open projects |
| Pinned / recent / TODO badge | 3 | Pinning works; TODO badge materialises the "All TODOs" page |
| Journal | 6 | Calendar with dots; Prev/Next jump position on empty days; no day shortcuts |
| All Pages | 6 | Sort and filter; no actions, no path, stray scrollbar, sidebar hidden |
| Trash and Archive | 3 | Delete has Undo, but **Empty trash and ✕ are permanent with no confirm**, and ✕ is clipped off-screen |
| Search palette (Ctrl+K) | 5 | Fast and keyboard-friendly; raw markup/UUIDs in results; no fuzzy matching |
| Command palette (`>`) | 4 | Only 10 commands |
| Cross-notebook `[[NB::Page]]` links | 7 | Clear states; a locked target is a dead end; no way back |
| Notebook switcher / New notebook / encryption | 7 | Excellent copy and recovery flow; disabled buttons look enabled; 5–10 s switches with no progress |
| Manage notebooks | 6 | Safe delete; list re-sorts after rename (the next click hit the wrong notebook) |
| Unlock / recovery / Lock now | 7 | Clear; lock takes ~5 s with no feedback |
| Settings → Security | 7 | Complete and honest; unreadable dropdowns |
| Shortcuts (help + do they work) | 5 | Full list buried in Settings; Ctrl+N opens a native `prompt()`; no back/forward |
| Window title | 2 | Always "MiNotes" |
| Narrow window (800 / 600 px) | 4 | Sidebar can't collapse; 600 px layout's Menu tab does nothing |
| Theme and contrast | 6 | Clean; tooltips cover menus; native dropdowns unreadable in dark theme |

### Visual views

| Feature | Score | Verdict |
|---|---|---|
| Graph view | 4 | Fast (0.4 s at 200 nodes), but zoom drifts off the cursor, dragging opens the page, labels pile up |
| Mind map | 6 | Horizontal/vertical good, re-parenting and SVG/PNG export work; radial layout broken; markdown export drops links |
| Kanban | 5 | Looks good; **colour picker can't be clicked**; tiny drop zones; Esc closes the board |
| Whiteboard | 6 | Tools, undo, zoom and persistence work; light canvas in dark theme; export skips the save dialog |
| Switching canvas modes | 7 | Returns to the same board; Draw tab with no board is a dead end |
| PDF viewer | 3 | Renders and zooms; **highlights impossible** (no text layer); opening = typing a path into `prompt()` |
| Link preview cards | 6 | Real metadata; no loading/failure state; URL shown twice on failure |
| Remote images | 8 | Clear placeholders and bar; Never/Ask/Always work |
| Pasted images (attachments) | 2 | **Real image paste saved as a `blob:` URL — gone after restart** |
| Export flows | 3 | Mind map export good; page "Export as HTML" saves silently to the working directory; whiteboard writes straight to Downloads |
| Narrow window / light theme (views) | 5 | Graph stays dark in light theme; mind map and whiteboard don't refit |

### Settings, sync, AI, import, power features

| Feature | Score | Verdict |
|---|---|---|
| Settings panel | 5 | Changes apply instantly; 2,700 px scroll, unreadable dropdowns, misleading "AI Assistant" section |
| Markdown copy status / Rebuild / Open folder | 7 | Clear, live status; paths cut off; Open folder gives no feedback |
| Outside edits of the markdown copy | 9 | Live update with Undo; deleted file → Trash with Restore |
| Git sync end to end | 4 | Robust engine, but **no way to set a remote in the app**, no "Sync now", duplicate pages on first join |
| Conflict handling | 5 | Both versions kept; whole-page copy, no compare view; toast shows a literal `<device>` |
| Mass-deletion hold | 8 | Clear Review / Trash / Keep banner |
| Copied-folder trust banner | 7 | Clear and safe; Settings doesn't show sync is paused |
| Sync error states | 3 | A missing remote shows only a silent grey "Offline" |
| Import (Obsidian, Evernote) | 8 | Excellent preview, report and undo; undo has no confirmation |
| AI setup | 7 | Very good privacy wording; hard to find (not in Settings), controls unstyled |
| Ask panel | 7 | Streamed answer with clickable citations; slow to report a dead server; no Retry |
| Privacy / remote images (settings view) | 6 | Works; Wikimedia images always fail (no User-Agent sent) |
| Security / encryption (settings view) | 4 | Clear dialogs, but confirmations are broken (see C-1 below) |
| CSS snippets | 5 | Live apply, strips `url()`; delete without confirm |
| SQL Query panel | 6 | Presets and read-only guard; rows not clickable |
| Plugins | 1 | Only an unsafe-loader stub; the real plugin manager is never shown |
| Onboarding / help | 6 | Good Getting Started page; Ask/Import shortcuts missing from lists |

## 3. The bugs that matter most

Ranked by harm. **D** = data loss or corruption, **S** = safety/security, **B** = feature broken.

| # | Kind | Bug | Where | Effort |
|---|---|---|---|---|
| C-1 | S/D | **Every `window.confirm` auto-accepts in the desktop app.** The dialog plugin replaces `confirm` with a Promise (rejecting: `dialog.confirm not allowed`, only `dialog:allow-open` is granted); a Promise is truthy, so all seven call sites proceed. Effects: the "this export is unencrypted" warning for **encrypted notebooks is skipped** (`lib/encryption.ts:93`), the recovery-key screen closes without its "have you saved it?" check, snippet/plugin/kanban-column deletes don't ask | 7 call sites | S |
| C-2 | D | **Real image paste is saved as a `blob:` URL** and is gone after restart. WebKitGTK fills `clipboardData.items`, not `.files`. Tests pass because they paste a synthetic `DataTransfer` | `useBlockEditor.ts:375` | S/M |
| C-3 | D | **Typing `#tag` + space corrupts the block** (`#urgent ` → `[tag]t`); TagNode has no markdown serializer | `editor/TagNode.ts` | S |
| C-4 | D | **Highlights are dropped on save** (no `==…==` serializer) | `blockExtensions.ts` | S |
| C-5 | D | **Empty trash and per-item delete are permanent with no confirmation**; the ✕ button is clipped out of view | `Sidebar.tsx` ~672 | S |
| C-6 | D | **Pasted markdown is mangled** (escaped headings, flattened nesting, indented lines → code); typed ```` ```lang ```` + Enter saves escaped text | paste / input rules | M |
| C-7 | D | **Ctrl+A → Backspace outside the editor deletes the whole page** with no confirmation or toast (Ctrl+Z restores it, nothing says so) | multi-select | S |
| C-8 | D | **The TODO badge writes a real "All TODOs" page** of raw markup that pollutes the page list, every page's backlinks and search | `App.tsx` ~950 | M |
| C-9 | D | **Git sync: joining from a fresh device duplicates the onboarding page**, and copies multiply ("Getting Started (2) (2)") | sync import | M |
| C-10 | B | **Subfolders can never be expanded** — pages in nested projects are unreachable from the sidebar | `Sidebar.tsx` ~1283 | S |
| C-11 | B | **Collapse can't be done with the mouse** — the toggle is covered by the drag handle and zoom trigger | block controls CSS | S |
| C-12 | B | **Block references render as raw `((uuid))` after any reload** | markdown → node parse | S/M |
| C-13 | B | **After a drag, the outline renders scrambled** until reload (data is correct; positions sorted without outline order) | `PageView` `localBlocks` | S |
| C-14 | B | **PDF highlights can't be created** — no pdf.js text layer | `PdfViewer.tsx` | M |
| C-15 | B | **Page "Export as HTML" saves silently into the app's working directory** (found later as `Project Alpha.html` in the repo root) with no dialog or message; whiteboard export writes to Downloads with no dialog | `exportPage.ts`, `Whiteboard.tsx` | S |
| C-16 | B | **Kanban colour picker can't be clicked** (backdrop z-index 99 above picker 50) | `styles.css` | S |
| C-17 | B | **Git sync can't be set up in the app** — no remote field, no "Sync now", "Last synced" shown with no remote, a missing remote is a silent "Offline" | Settings / sync | M |
| C-18 | B | **Mind map radial layout overlaps nodes** | `blocksToFlow.ts` | M |
| C-19 | B | **Graph zoom drifts away from the cursor** (sign error) and **dragging a node opens its page** | `GraphView.tsx` ~461 | S |

Also worth fixing soon: link previews and remote images send no User-Agent
(Wikipedia/Wikimedia answer 403); Kanban Esc closes the whole board; the
whiteboard overlay lets typing reach the hidden page underneath; Manage
notebooks re-sorts rows after a rename; split→merge isn't reversible.

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
4. **No shared UI system.** Disabled buttons look enabled, native dropdowns
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

### Wave 3 — one UI system (M)
Styled selects, checkboxes, radios and visible disabled states with a reason;
custom tooltips that never cover menus; one rule for Esc (close the topmost
thing only); progress states for switch/lock/unlock/import; theme variables
for every canvas; an icon set instead of emoji; the app's own modal for
Ctrl+N and Ctrl+P instead of `prompt()`.

### Wave 4 — the features that make it feel complete (M/L)
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
