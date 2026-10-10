# PRD: Import

Status: draft · Owner: Chris Klaus · Written 2026-10-10

## 1. Overview

Bring existing notes into MiNotes from an **Obsidian vault**, **Evernote**
(`.enex` exports), or a **plain folder of markdown**, through an Import dialog in
the app and the CLI.

**One-liner:** pick a source, preview what will be created, import into a new
notebook, get a report of everything that didn't convert cleanly.

### What exists today

- CLI only: `minotes import dir <folder>` reads `.md` files at the top level of
  one folder (no subfolders), `import file <path>`; core also has an org-mode
  importer. No UI.
- Not handled: subfolders, attachments, `![[embeds]]`, frontmatter → properties,
  Obsidian-specific syntax, Evernote in any form.
- MiNotes has **no attachment store**: images exist only as data URLs inside
  whiteboards. Import cannot be done well without one, so this PRD defines it (§5).

## 2. Goals / non-goals

Goals
1. A user with an Obsidian vault or Evernote notebooks can move in, in one sitting,
   without the command line.
2. Structure survives: folders/notebooks → Projects, links between notes keep
   working, tags and metadata are preserved, images and files come along.
3. Nothing is silently dropped: anything not converted is listed in a report and
   the original text is kept.
4. An import can be undone completely.
5. Re-running an import does not create duplicates.

Non-goals
- Two-way sync with Obsidian or Evernote (this is a one-time move, re-runnable).
- Reading Evernote's local database or cloud API (`.enex` is the supported route).
- Obsidian plugins' private data (Dataview queries, Canvas, Excalidraw): kept as
  text/attachments, not interpreted — except where noted.
- Notion, Roam, Logseq, OneNote: future sources; the pipeline (§4) is built so
  each is one new reader.

## 3. User flow

1. **File → Import…** (also in the notebook menu and the empty state of a new
   notebook).
2. **Choose a source**: Obsidian vault (pick a folder) · Evernote (pick one or
   more `.enex` files) · Markdown folder (pick a folder).
3. **Scan** (read-only, shows progress): counts of notes, folders, attachments,
   total size; detected source type confirmed (an `.obsidian/` directory marks a
   vault).
4. **Preview**: the tree that will be created; a sample of 3 converted notes side
   by side with their source; a list of warnings by category with counts ("12
   Dataview blocks kept as code", "3 files over 50 MB skipped").
5. **Destination**: **a new notebook (default)**, named after the source — or an
   existing notebook, into a new top-level Project named "Imported from … (date)".
6. **Options** (sensible defaults, collapsed): how to split notes into blocks
   (§4.3); daily notes → journal pages; title collisions (keep both / skip).
7. **Import** with progress and Cancel. Cancelling rolls back.
8. **Report**: created counts, warnings with links to the affected pages, "Undo
   import", and the report saved as a page in the notebook ("Import report —
   date").

Importing into a new notebook means a bad import is discarded by deleting one
notebook, and a large vault can never pollute existing notes. See
`PRD-notebooks.md`.

## 4. Design

### 4.1 Pipeline

```
reader (per source) ──► neutral model ──► resolver ──► writer (core, one transaction per batch)
   obsidian / enex /       notes, folders,    links, tags,
   markdown                attachments        collisions
```

- **Readers** produce a neutral model: `Folder{path}`, `Note{title, path, created,
  modified, tags, properties, body_markdown, source_ref}`, `Attachment{name, bytes
  | path, mime, hash}`. Readers never touch the database.
- **Resolver** turns note references into page links, assigns final titles
  (collisions), maps tags, and rewrites attachment references.
- **Writer** creates folders, pages, blocks, properties and attachments through
  the core API inside transactions (`Database::tx`), in batches of ~200 notes so
  progress and cancel are responsive.
- Every created page gets properties `import_source` and `import_ref` (vault-
  relative path, or Evernote note GUID). These make re-import idempotent (§4.6)
  and "Undo import" exact.

Lives in `minotes-core` (`import/` module) so the CLI and the app share it:
`minotes import obsidian <vault>`, `minotes import evernote <file.enex>…`,
`minotes import markdown <folder>`, each with `--into <notebook>`, `--dry-run`
(prints the preview/report), `--json`.

### 4.2 Obsidian

| Obsidian | MiNotes |
|---|---|
| Folder | Project (nested folders → nested Projects) |
| `Note.md` | Page titled by filename (without `.md`) |
| YAML frontmatter | Page properties; `tags:` → tags; `aliases:` → page aliases; `title:` overrides the filename |
| `[[Note]]`, `[[Note\|alias]]` | Same syntax; resolved by Obsidian's rule (exact path, else unique basename) — unresolved links are kept and counted |
| `[[Note#Heading]]`, `[[Note#^blockid]]` | Link to the page; heading/block target kept as link text and counted (block targets become `((ref))` when the `^blockid` line is found) |
| `![[Note]]` (note embed) | Link to the page + warning (transclusion of whole pages is not supported) |
| `![[image.png]]`, `![](path)` | Attachment (§5), rendered inline |
| `#tag`, `#nested/tag` | Tags (nested kept as-is) |
| `- [ ]` / `- [x]` | Same (already supported) |
| Callouts `> [!note]` | Blockquote, callout type kept as bold first line |
| `%%comments%%` | Dropped from rendering, kept in the source block as an HTML comment |
| `$math$`, `$$math$$` | Kept as text (render when math support exists) |
| Code blocks incl. ```` ```dataview ```` | Code blocks, untouched; Dataview/Tasks queries counted in warnings |
| Daily notes (folder/format from `.obsidian/daily-notes.json`) | Journal pages for those dates (option; default on) |
| `.canvas`, Excalidraw files | Attached as files + a page linking to them; warning |
| `.obsidian/`, `.trash/` | Ignored |
| Non-markdown files not referenced by any note | Imported as attachments under an "Unlinked files" page (option; default on) |

Filename characters Obsidian allows but MiNotes titles don't are mapped and the
mapping is reported.

### 4.3 Splitting notes into blocks

MiNotes is an outliner; Obsidian and Evernote notes are documents. Rule
(option "Split into blocks": Outline (default) / One block per paragraph / One
block per note):

- **Outline**: each heading becomes a block; content under a heading becomes its
  children; list items become nested blocks following their indentation;
  consecutive non-list lines form one paragraph block; code fences, tables and
  blockquotes are single blocks. Round-trips with MiNotes' own markdown export.
- Blocks are created in outline order with per-parent positions (see CLAUDE.md:
  never order a page's blocks by position alone).

### 4.4 Evernote (`.enex`)

One `.enex` per Evernote notebook (Evernote: right-click notebook → Export →
ENEX). Each file → one Project named after the file; stacks are not in the export,
so the dialog lets the user group selected files under a parent Project.

- Streaming XML parse (files can be gigabytes) — never load a whole `.enex` in
  memory.
- `<note>`: `title`, `created`, `updated`, `tag*`, `note-attributes`
  (`source-url`, `author`, `latitude/longitude`, `reminder-*`) → page properties
  and tags.
- `<content>` is ENML (XHTML subset) → markdown via an HTML-to-markdown converter
  with ENML extensions:

| ENML | MiNotes |
|---|---|
| `<en-todo checked="…"/>` | `- [ ]` / `- [x]` |
| `<en-media hash="…"/>` | Attachment matched by MD5 hash to the note's `<resource>`; images inline, others as file links |
| `<en-crypt>` | Kept as an opaque block "Encrypted Evernote text — not imported", counted |
| Tables, lists, headings, bold/italic, links, code, `<hr>` | Markdown equivalents; nested tables flattened with a warning |
| Inline styles, fonts, colours | Dropped (highlight colour → `==highlight==`) |
| Web clips | Converted like any note; `source-url` property; heavy clips flagged if > 200 blocks |
| `evernote:///view/…` note links | Resolved to pages when the target note is in the imported set (matched by GUID if present, else by title); otherwise kept as text and counted |

- `<resource>`: base64 → attachment (§5); `recognition` (OCR) data ignored;
  `file-name` and mime preserved.
- Notes with identical titles in one notebook: "Title", "Title (2)" — reported.
- Reminders: property only (no reminders feature yet).

### 4.5 Plain markdown folder

The Obsidian reader without vault-specific rules: folders → Projects, frontmatter
→ properties, standard markdown links between files (`[text](other.md)`) →
`[[links]]`, relative image paths → attachments. Replaces today's flat
`import dir`.

### 4.6 Re-import, collisions, undo

- **Re-import** of the same source into the same destination: notes whose
  `import_ref` already exists are compared by content hash — unchanged → skipped;
  changed at source and untouched in MiNotes → updated; changed in both → imported
  as "Title (reimported)". Summary shown before applying.
- **Title collisions** with existing pages (when importing into an existing
  notebook): default "keep both" with a suffix; never merge or overwrite.
- **Undo import**: deletes exactly the pages, folders and attachments created by
  that import run (tracked by an `import_run` id), refusing for any page edited
  since, which it lists instead.

## 5. Attachments (new capability)

Needed by import; useful everywhere else (paste/drop an image into a note).

- **Storage**: content-addressed files in the notebook folder —
  `attachments/<sha256[0..2]>/<sha256>.<ext>` — plus an `attachments` table
  (`hash`, `name`, `mime`, `size`, `created_at`) and a join table to blocks.
  Identical files are stored once. For notebooks in the legacy location:
  `~/.minotes/<name>.attachments/`.
- **Reference syntax** in block content: `![alt](attachment:<hash>/<name>)` for
  images, `[name](attachment:<hash>/<name>)` for files. Stable under rename.
- **Serving to the webview**: a Tauri custom protocol `attachment://` that streams
  from the store (no base64 over IPC; add to the CSP's `img-src`/`media-src`).
  Path is derived from the hash only — no traversal surface.
- **Mirror / sync**: the markdown mirror carries attachments in
  `notes/_attachments/` and rewrites references to relative paths, so the mirror
  renders in any markdown viewer. Git sync moves them; large files warn (> 50 MB
  skipped by default, configurable; consider Git LFS later).
- **Garbage collection**: unreferenced attachments are removed on empty-trash,
  with the same "referenced by any block or undo-able event" rule as whiteboards.
- **Limits**: per-file cap (default 200 MB) and a preview-time total; both
  reported, never silent.
- **Encryption**: in an encrypted notebook, attachment files are encrypted with a
  key derived from the notebook key (see `PRD-encryption.md` §4.5).

Attachments are a prerequisite phase of this PRD (§7).

## 6. Risks

| Risk | Mitigation |
|---|---|
| Huge vaults (50k notes, GBs of attachments) | Streaming readers, batched transactions, progress, cancel; scan first so the user sees size before committing. Measure with the scale tool in the desktop-check skill. |
| Lossy conversion goes unnoticed | Every lossy rule increments a named counter; the report links to affected pages; original text is preserved wherever something isn't interpreted. |
| Broken links after import | Resolver reports unresolved links with their source note; they stay as `[[Text]]` so creating the page later fixes them. |
| Outline splitting mangles documents | Option to choose the split mode; preview shows real converted samples; "One block per note" is always lossless. |
| Malicious or malformed input (path traversal in vault paths, XML bombs in `.enex`, giant base64) | Paths confined to the chosen folder; XML parser with entity expansion off and size limits; attachments written only through the content-addressed store. |
| Import into the wrong place | New notebook by default; exact Undo. |

## 7. Phases

1. **Attachments** (§5): store, protocol, reference syntax, paste/drop an image
   into a note, mirror support, GC. Valuable on its own.
2. **Import core + Markdown folder + Obsidian**, CLI first (`--dry-run` report),
   then the dialog.
3. **Evernote `.enex`**.
4. **Re-import and Undo import** polish; further sources as separate readers.

## 8. Testing

- Fixture vaults in `tests/fixtures/import/` (small, hand-built): an Obsidian
  vault exercising every row of §4.2; an `.enex` exercising every row of §4.4; a
  hostile set (traversal paths, entity bombs, mismatched hashes, duplicate titles).
- Core tests assert the neutral model per reader, the resolver's link results, the
  writer's block tree (outline order), idempotent re-import, and exact undo.
- Golden-report tests: `--dry-run --json` output compared to a checked-in file.
- Desktop journey: import the fixture vault through the dialog into a new
  notebook; verify structure, a resolved link, an inline image, the report page;
  Undo; verify the notebook is empty.
- Scale: generated 10,000-note vault — time and peak memory.

## 9. Open questions

1. Default split mode: Outline, or one block per paragraph?
2. Should import into an existing notebook be offered at all in v1, or new-notebook
   only?
3. Evernote: is ENEX enough, or is reading Evernote's v10 local data worth a later
   phase (keeps stacks; fragile, undocumented)?
4. Per-file attachment cap and whether oversized files are skipped or linked in
   place.
5. Obsidian Canvas → MiNotes whiteboard conversion: worth doing, or attach-only?
