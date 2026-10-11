# PRD: Editor & UX Improvements

Status: ~45% built · Revised 2026-10-10 · Owner: Chris Klaus

> **What changed in this revision.** The March 2026 version was ten features
> picked from Obsidian plugin download counts, each with a file-by-file plan. Since
> then, Kanban and the outline shipped, tables were built (in the `feat-tc`
> worktree, about to merge), and three specs landed that change the plan:
> plugins (`PRD-plugin-architecture.md`) give us a sandboxed home for renderers
> like Mermaid and math; import (`PRD-import.md`) adds an attachment store; and the
> AI platform (`PRD-ai-assistant.md`) provides one opt-in model layer. This
> revision: (1) adds a status per item, checked against the code; (2) re-ranks
> the list for what users expect from an outliner in 2026, adding three missing
> basics (attachments in blocks, find & replace, word count) and deciding build
> next / later / plugin / cut for each item; (3) adds **Where AI helps**; (4) drops
> stale implementation detail. Kanban moves out — it has its own spec
> (`PRD-kanban.md`).
>
> "~45%" counts the ten original items, with tables done once `feat-tc` merges.

## 1. Goal

Make daily writing in MiNotes feel complete: the things users of Logseq,
Obsidian, Notion or Tana reach for in their first week should exist, work in the
outliner model (blocks with `parent_id` + `position`), and save as plain
markdown that still reads correctly without MiNotes.

**Principles**
- **Portable storage.** Every feature saves as readable markdown in block
  content. If markdown has no syntax for something (table column widths, highlight
  colours), we either pick one plain convention or don't build it.
- **Exact things stay deterministic.** Dates, queries, titles and replacements
  are computed by code. AI only drafts content the user reviews (see §5).
- **Core vs plugin.** Core covers what nearly every user needs and anything that
  touches the block tree or storage. Renderers for specialist content (diagrams,
  math, charts) are plugins, using the code-fence renderer extension point.

## 2. Status of the original items

Checked against `main` and the `feat-tc` / `ux-int` worktrees on 2026-10-10. Paths
are under `crates/minotes-app/src/`.

| # | Item | Status | Where | Gap |
|---|---|---|---|---|
| 1 | Recent pages in sidebar | **Partial** | `lib/recentFiles.ts` tracks opens (`App.tsx`); shown only in the search/command palette (`components/SearchPanel.tsx`) | Not in the sidebar |
| 2 | WYSIWYG tables | **Done** (in `feat-tc`, unmerged) | `editor/tables.ts` (GFM round-trip serializer that escapes `\|` and keeps alignment), `editor/TableToolbar.tsx`, `/table` in `editor/slashCommands.ts`, Tab/Shift-Tab cell navigation | Pasting a markdown/TSV table doesn't produce one table block; no column widths |
| 3 | Dynamic templates | **Partial** | `lib/builtinTemplates.ts`, template slash items in `editor/slashCommands.ts`; backend `create_template`/`apply_template` | Only `{{date}}` and `{{time}}`; no `{{title}}`, `{{cursor}}`, date formats, `{{input:}}` |
| 4 | Multi-colour highlight | **Not started** | One highlight toggle in `editor/BubbleToolbar.tsx` | — |
| 5 | Outline / TOC | **Done** (differently) | `components/TableOfContents.tsx`, toggled overlay from the page header in `PageView.tsx` | Spec asked for a right-sidebar panel; overlay is enough (§3) |
| 6 | Kanban view | **Done** | `components/kanban/`; polish in `ux-int` | Tracked in `PRD-kanban.md` — removed from this spec |
| 7 | Live queries in blocks | **Not started** | `components/QueryPanel.tsx` is a separate panel running raw SQL (`run_query`) | No inline, live, safe query |
| 8 | Weekly / monthly notes | **Not started** | Daily journal only (`get_journal`) | — |
| 9 | Natural-language dates | **Not started** | — | — |
| 10 | URL auto-title on paste | **Partial** | Paste into an empty block makes a link-preview card that fetches the title (`fetch_og_metadata`, `components/BlockItem.tsx`); paste over selected text wraps it as a link (`editor/useBlockEditor.ts`) | Pasting a URL into text still inserts `[url](url)` |

Also merging soon from `ux-int`: code-block language labels
(`editor/codeLanguage.ts`) and an empty-page hint. From `feat-tc`: creating
flashcards from a block (`/flashcard`, context menu).

## 3. Priorities

Ranked by how much each item's absence hurts a user in their first week (S/M/L = rough effort).

### Build next

| Rank | Item | Effort | Why now | Scope |
|---|---|---|---|---|
| 1 | **Finish tables** (#2) | S | Nearly done; merging is cheap | Merge `feat-tc`. Pasting a GFM/TSV/CSV table, or cells copied from a spreadsheet, creates one table block. Column widths: **cut**, because markdown can't store them. |
| 2 | **Images and files in blocks** (new) | M | Pasted images are stored today as data URLs inside block content. That bloats the DB, git sync and the markdown mirror, and non-image files can't be added at all. Every competitor supports this. | Built on the attachment store in `PRD-import.md` §5 (`attachment:` references, `attachment://` protocol). Paste or drop images and files; resize an image (width saved as a plain attribute); click an image to open it full size; convert existing data-URL images on first edit or in a one-off migration. Ships with import Phase 1. |
| 3 | **Find & replace in a page** (new) | S–M | Ctrl+F in the webview can't see text inside unfocused editors, and there's no replace. Users expect this in any editor. | Ctrl+F searches the open page across all blocks, highlights matches and steps through them. Replace / Replace all with match case and whole word, as a single undo step. Searching across pages stays in global search. |
| 4 | **Recent pages in the sidebar** (#1) | S | The data already exists | Build it as the "Quick Access" section in `PRD-sidebar-navigation.md` (pinned + recent combined). Don't add a separate Recent section. |
| 5 | **URL title on inline paste** (#10) | S | Most of it is built | Paste a URL into text → insert `[url](url)` immediately, then replace the text with the fetched title (reuse `fetch_og_metadata`, 3 s timeout, keep the URL if it fails). Typing in the block before the title arrives cancels the replacement. A setting turns off URL fetching, because each fetch tells that site the URL was opened. |
| 6 | **Templates v2** (#3) | M | Templates are needed for periodic notes (below) and for AI drafting (§5) | Add `{{title}}`, `{{cursor}}`, `{{date:FORMAT}}`, `{{date:+7d}}` / `{{yesterday}}` / `{{tomorrow}}`, plus user templates saved as pages tagged `template`. `{{input:Label}}` comes later. |
| 7 | **Live queries** (#7) | L | The #3 Obsidian plugin. Also the base for "queries in plain English" (§5). | **First-party**, not a plugin: a small read-only query language in core, not raw SQL. Covers pages/blocks/tasks filtered by tag, property, path, date and status, with sort and limit. Written in a ```` ```query ```` fence; results render below it, with a live refresh. Runs in the CLI too (`minotes query`). The plugin "inline query" extension point (plugins Phase 4) renders custom views over this same engine. `QueryPanel` stays as the raw-SQL tool for power users. |

### Later

- **Natural-language dates** (#9), M. A `@` picker using a deterministic parser
  (chrono-node or similar): "next fri", "in 3 days", "mar 30". It shows what the
  phrase resolved to before inserting, stores an ISO date and renders it as a
  chip that opens that day's journal. It works in properties too. No AI (§5).
- **Weekly / monthly notes** (#8), M. Pages titled `2026-W41` and `2026-10`,
  each created from a template (needs Templates v2), with prev/next navigation in
  the journal header. Wait until users ask for it; daily journals with
  templates cover most cases.
- **Word count**, S. Words and characters for the page, or for the selection when
  there is one, in the page footer. Quick to build, so it can go into any release.
- **Block references polish**, S–M. Inserting with `((`, "Copy block reference" and
  zooming into a block already work. Still missing: a reference-count badge on
  referenced blocks, and embeds (a live, editable copy of a block elsewhere).
  Build embeds once users ask for them.
- **Multi-colour highlight** (#4), S. Low value, and markdown has no standard
  syntax for colours. If built, use four fixed colours, keep `==text==` for the
  default colour, and choose one plain convention for the others.

### Make a plugin

Each of these is a code-fence renderer from plugins Phase 1, and the data stays
readable as a fenced code block:
- **Mermaid / diagrams.** Already planned as an example plugin
  (`PRD-plugin-architecture.md` §9).
- **Math (KaTeX).** Inline `$…$` needs editor support, so v1 is block math in a
  ```` ```math ```` fence. If plugins Phase 1 slips past Q1 2027, consider building
  block math into core (open question 2).
- **"Insert TOC as blocks"** command, for people who want a static TOC in the
  page.

### Cut

- **Outline as a right-sidebar panel** (#5). The overlay works. Revisit only if
  the right sidebar becomes the home for page context (backlinks, outline,
  properties).
- **Table column resizing.** Widths can't be saved in markdown.
- **Focus / zen mode.** Zooming into a block plus collapsing the sidebar covers
  most of it. Reconsider if users ask.
- **Kanban** (#6). Shipped; it lives in `PRD-kanban.md`.

## 4. Requirements that apply to every item

- Everything saves into block content as markdown. Round-trip tests (parse →
  serialize → parse) are required for each new syntax (tables, images, query
  fences, date chips).
- Use the slash-command approach that already works: insert markdown text and let
  the sync path render it. Building content through TipTap commands loses
  formatting in the blur→save cycle (see `CLAUDE.md`).
- Each feature gets a `window.__MINOTES__` hook and a user journey in
  `tests/user-journey-test.sh`. Anything that uses IPC (attachments, URL fetch)
  also gets checked in the real desktop app with the desktop-check skill.
- Mock backend parity: `mockBackend.ts` gets a handler for every new command.

## 5. Where AI helps

All AI features run through the AI platform (`PRD-ai-assistant.md`): the user
configures a provider (their own key for a cloud model, or a local model), and
every feature is **off by default**. Nothing is sent except what the user starts
an action on. Every AI result is shown as a preview before it is inserted and can
be undone in one step. General writing help (rewrite, continue, summarise a
selection) is the platform's "AI in the editor" surface and isn't specified here.

The test for including an idea: a modern LLM must do clearly better than
deterministic code, and the result must be something the user reviews anyway.
Anything that has to be exact and happens silently (dates, titles, find &
replace, saving) stays deterministic.

### Kept

| Idea | User value | Why AI and not code | Priority |
|---|---|---|---|
| **Paste as clean outline.** Turn a pasted email thread, web article or meeting transcript into tidy nested blocks | High. Pasting is how most outside content gets into notes, and today it arrives as one wall of text or a messy HTML conversion | HTML→markdown keeps the clutter (signatures, quoted replies, nav text, cookie banners) and can't recover structure from plain text. Deciding what is content and how it nests is judgement. | **P1.** A separate action (paste chip "Clean up with AI", or Ctrl+Shift+Alt+V). Normal paste never calls AI. The preview shows the proposed blocks next to the original. |
| **Queries in plain English** ("open tasks tagged #launch due this week") compiled to the query language | Medium–high. People want queries but won't learn a syntax | Turning intent into a formal query is translation, which LLMs do well. The deterministic engine still produces the results, so they are exact. | **P2**, after live queries (#7). The generated query is written into the fence where the user can see and edit it. The model gets the query grammar and property/tag names only, not note content. |
| **Draft from a template instruction** ("weekly review for Project X") | Medium. Gets past the blank page in reviews and project kick-offs | Static templates can't fill in what happened in Project X this week. A model can draft it from the pages the user points it at. | **P2**, after Templates v2. Entry point in the template picker. Reading context is explicitly scoped (this project or these pages), and the draft is inserted as ordinary blocks. Writing quality comes from the writing assistant. |
| **Table from unstructured text** ("Alice 30 Berlin, Bob 41 Oslo…" or a pasted list of specs) | Low–medium | Delimited text (TSV/CSV/GFM) is handled by code in rank 1. AI is only for text without delimiters, where finding the columns needs judgement. | **P3.** An explicit "Make table with AI" action. The preview shows the table before it's inserted. |
| **Summary of a pasted link** | Low–medium, mainly for reading lists | The title comes from deterministic code (rank 5). A summary can't. | **P3.** Only when asked, from the link card's menu. The page text is fetched locally and sent to the configured model. Never runs automatically on paste. |

### Rejected

- **Natural-language dates via an LLM.** A deterministic parser handles "next
  friday" and "in 3 days" exactly, instantly and offline. A wrong date that gets
  inserted without notice is worse than no feature. Vague phrases ("after the
  offsite") can't be resolved without information the model doesn't have either.
- **Page titles via an LLM.** The page's `<title>` / Open Graph tags are the
  correct answer. Generating a title adds cost and a chance of hallucination for
  no benefit.
- **"Smart" find & replace.** Replace must be exact and predictable. Changing many
  places at once by meaning belongs to the writing assistant, with a preview.
- **AI ranking of recent pages, AI highlight colours, AI-picked table layout.**
  Little value; deterministic behaviour is easier to understand.
- **Running AI automatically on paste or save.** It would send content without
  the user asking, which breaks private-by-default.

## 6. Success measures

- Ranks 1–5 are built and covered by user journeys. No data-URL images remain in
  new content after attachments ship.
- Live queries: a query over a 10k-block notebook renders in under 200 ms (scale
  tool in desktop-check).
- AI features: share of previews accepted vs. dismissed, tracked locally and never
  sent anywhere. If paste cleanup is accepted less than half the time, rework it
  or cut it.

## 7. Open questions for the owner

1. **Query language:** design our own small DSL, or adopt an existing syntax
   (Logseq's simple queries, or a Dataview subset) so imported notes keep working?
   Adopting one helps import (`PRD-import.md`) but ties us to its quirks.
2. **Math:** wait for the plugin, or build block math into core now? Math is
   common among students and researchers and the KaTeX cost is small.
3. **Attachment migration:** convert existing data-URL images in one migration
   pass, or lazily on edit? A migration touches every page's sync history once.
4. **Spellcheck:** WebKitGTK spellcheck depends on the system's enchant/hunspell
   setup. Should we ship dictionaries and a language setting, or accept whatever
   the platform provides? Needs a desktop-check on Linux first.
5. **URL fetching:** keep fetching titles and previews on by default (convenient),
   or make it opt-in to match AI's private-by-default stance?
6. **Highlight colours:** worth a non-standard markdown convention, or drop it for
   good?
