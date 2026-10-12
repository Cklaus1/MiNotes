# PRD: Notebooks

Status: draft · Owner: Chris Klaus · Written 2026-10-10

## 1. Overview

MiNotes already supports multiple independent databases ("graphs"), but almost
nobody would know: the only switcher is a dropdown inside the Graph view, the
databases live at a fixed hidden path, and the readable markdown copy of a graph
only exists if git sync is on. This PRD turns graphs into **notebooks**: visible
in the sidebar, stored in a folder the user chooses, and always accompanied by a
current plain-markdown copy.

**One-liner:** a notebook is a folder you own, containing a database (the source
of truth) and an always-current markdown mirror of everything in it.

### Decision this PRD rests on

The database stays the source of truth. MiNotes is a block outliner: block
references, flashcards, per-block properties, kanban and whiteboards all depend
on stable block ids and on multi-step changes being atomic. Files-as-truth would
put the fragile file↔database translation on every edit instead of only at sync
time. What a database costs — openness and trust — is bought back with the mirror.

## 2. Problem

- **Notebooks are undiscoverable.** The switcher lives in the Graph view toolbar.
- **The word "graph" means two things**: a database, and the link-graph view.
- **Storage is fixed and hidden**: `~/.minotes/<name>.db`. Users can't put a
  notebook in Dropbox/iCloud, on an external drive, or next to a project.
- **No readable copy unless sync is on.** The markdown export is written only
  during a git sync, into `~/MiNotes_Sync[-<name>]`.
- **Editing the exported files is silently destructive**: on the same device the
  next export overwrites them.
- **Backup is unclear**: the data is one file in a hidden directory, plus
  per-graph config files beside it.

## 3. Goals / non-goals

Goals
1. A notebook switcher in the sidebar header; "Notebook" as the user-facing word.
2. A notebook can live in any folder the user picks; copying that folder is a
   complete backup, and opening it on another machine just works.
3. Every notebook has a markdown mirror that is current within seconds of an edit.
4. Edits made to mirror files outside MiNotes are imported safely (ids preserved,
   nothing overwritten without a recoverable copy).
5. Existing graphs keep working with no action from the user.

Non-goals
- Files as the source of truth.
- Real-time collaboration, or two apps writing one notebook at the same moment.
- Cross-notebook backlinks (search and links were added later — see §10).
- Encryption (see §8 — designed to fit, specified separately).
- Importing from other apps (see `PRD-import.md`, to be written; §8).

## 4. Phases

### Phase 1 — Switcher in the sidebar (no spec needed; build directly)

- The sidebar header shows the current notebook's name next to "MiNotes"; clicking
  it opens a menu: the list of notebooks (current one checked), "New notebook…",
  "Manage notebooks…".
- UI text says **Notebook** everywhere. (Code, commands and the CLI followed
  later — see §9 Q5.)
- Switching closes any open view/panel and lands on that notebook's journal for
  today. Undo history is per notebook and is cleared on switch.
- The Graph view keeps a read-only label of the current notebook; its dropdown goes.
- Creating a notebook validates the name with the existing rules and switches to it.
- Deleting stays in "Manage notebooks…", is refused for the active notebook (as
  today), and requires typing the notebook's name.

### Phase 2 — Continuous markdown mirror

Today's export (`export_markdown_synced`) already produces the right shape:
one `.md` per page with id/title frontmatter, folders as directories with a
`.minotes-folder.json` identity file, whiteboards as
`.minotes-whiteboards/<id>.json`, stale files moved to `.minotes-trash/`.

- Run it **incrementally after edits**, not only at sync: debounce ~2 s after the
  last write, export only pages/folders/whiteboards whose `updated_at` moved since
  the last mirror pass, and prune as today. A full pass runs at startup and on
  demand ("Rebuild markdown copy").
- The mirror is on by default for every notebook, independent of git sync. Git
  sync becomes "the mirror folder is also a git repo" — it no longer owns the export.
- The mirror never blocks an edit: it runs off the UI thread, takes the database
  lock only to read, and a failure shows a quiet status ("Markdown copy is behind —
  retry") rather than an error dialog.
- Status in Settings: mirror location, last written time, "Open folder".

### Phase 3 — Notebook in a folder you choose

Layout of a notebook folder:

```
My Notebook/
├── notebook.minotes        # the SQLite database (source of truth)
├── notebook.json           # name, id, format version, mirror settings
├── notes/                  # the markdown mirror (pages, folders, .minotes-* sidecars)
└── .minotes/               # app-private: sync state, last-mirror markers, locks
```

- "New notebook…" asks for a name and a location (default `~/MiNotes/<name>`).
  "Open notebook…" picks an existing notebook folder.
- MiNotes keeps a small registry of known notebooks (path + name + last opened) in
  `~/.minotes/notebooks.json`; the folder itself is self-describing, so the
  registry is a convenience, not a dependency.
- A lock file in `.minotes/` records which app instance has the notebook open. A
  second instance opens it read-only with a clear banner. (SQLite's own locking
  stays the real guard.)
- The CLI's `--notebook` accepts a notebook name (resolved through the registry),
  a notebook folder, or a `.db` path.
- If the folder is missing at launch (unplugged drive, moved folder): show the
  notebook as unavailable with "Locate…" — never silently create an empty one.

**Cloud-sync folders (Dropbox, iCloud, OneDrive).** A live SQLite database in a
file-sync folder can be corrupted when the service copies it mid-write. Phase 3
therefore ships with: WAL checkpoint + `PRAGMA wal_checkpoint(TRUNCATE)` on idle
and on quit; a warning when the chosen location looks like a known cloud folder,
recommending git sync (or the mirror alone) for multi-device use; and detection of
conflicted-copy files (`notebook (conflicted copy).minotes`) with a notice. This
risk is the main reason Phase 3 is its own phase.

### Phase 4 — Safe outside edits

- A watcher on `notes/` notices files changed by something other than MiNotes
  (compare against the content hash recorded at the last mirror write).
- Changed files are imported with the id-preserving reconcile that sync already
  uses (`reconcile_page_blocks`): block markers keep ids; new lines become new
  blocks; removed lines are deleted **to trash**, never hard-deleted.
- If the page was also edited in the app since the last mirror write, the outside
  version is imported as a separate "(edited outside)" page — the same policy as a
  sync conflict copy — and a notice explains it.
- New `.md` files dropped into `notes/` become new pages; deleting a file moves
  the page to trash (subject to the existing mass-delete guard).
- Files MiNotes cannot parse are left untouched and reported, never rewritten.

Built (`minotes-core/src/outside.rs`, watcher in `src-tauri/src/notebooks.rs`):
- The hashes live in the mirror state (`.minotes/mirror-state.json`, or
  `~/.minotes/mirror-state-<name>.json` for legacy notebooks), per page with the
  page fingerprint at the time. Every mirror write — incremental, full, and the
  pruner — refuses to overwrite or move a page file whose hash changed.
- Removed lines go to a Trash page "<title> (removed outside <time>)" (block ids
  kept); the app gets before/after snapshots and pushes one undo step per file.
- Watcher: `notify`, recursive on the mirror, 0.7 s debounce; dot paths,
  `_attachments/`, temp files and non-`.md` files are dropped; directories and
  removals widen the check to a full scan (moves vs. deletions). Full passes
  (startup, switch, rebuild, git sync) scan everything first, so edits made while
  the app was closed are imported too. Git sync re-baselines the files a pull
  changed. A read-only session neither watches nor imports.
- Not covered: folder renames/deletions made outside (pages follow their files,
  but folders are not renamed or trashed); undo restores blocks, not a title or
  folder the edit changed; archived pages' files are not imported.

## 5. Migration

- Existing graphs in `~/.minotes/<name>.db` keep working in place as "legacy
  location" notebooks; they get the mirror (Phase 2) at `~/MiNotes_Sync[-<name>]`,
  i.e. exactly where sync puts it today, so git-synced users see no change.
- "Move notebook to a folder…" converts one to the Phase 3 layout: checkpoint,
  copy the database, verify integrity (`PRAGMA integrity_check` + row counts),
  move the mirror (preserving its `.git`), update the registry, and only then
  remove the old files. Fully reversible until the last step.
- No automatic migration. Nothing moves unless the user asks.

## 6. Risks

| Risk | Mitigation |
|---|---|
| Mirror and database disagree | The database always wins; "Rebuild markdown copy" regenerates everything; mirror writes are atomic (temp file + rename). |
| Outside edit lost | Outside versions are never discarded: imported, or kept as an "(edited outside)" page; removed blocks go to trash. |
| Database corruption in cloud folders | Checkpointing, warning, conflicted-copy detection (Phase 3); git sync remains the supported multi-device path. |
| Mirror slows editing on large notebooks | Incremental, debounced, off the UI thread. Budget: an edit to one page mirrors in < 200 ms at 20,000 blocks (measure with the scale tool in the desktop-check skill). |
| Watcher loops on our own writes | Compare content hashes against the last mirror write, not timestamps. |
| Two machines open the same folder | Lock file + read-only second opener; documented as unsupported for writing. |

## 7. Testing

- Core tests for incremental mirroring (only touched pages rewritten; prune still
  correct), move-to-folder (integrity verified, rollback on failure), outside-edit
  import (ids kept; concurrent edit → conflict page; unparseable file untouched).
- Desktop journeys (`tests/desktop-journey-test.sh`): create a notebook in a chosen
  folder, write, quit, reopen from the folder; copy the folder and open the copy;
  edit a mirror file outside and see it appear; switch notebooks and confirm
  isolation (search, TODO count, trash do not leak across).
- Scale run before/after Phase 2 to hold the mirror budget.

## 8. How this fits import and encryption

**Import** (own PRD to follow). Importing an Obsidian vault or Evernote `.enex`
exports should default to creating a **new notebook**, so a large import can never
pollute an existing one and can be discarded by deleting one folder. Open question
owned by that PRD: an attachment store (images/PDFs), which the mirror must then
also carry (`notes/_attachments/`).

**Encryption** (`PRD-encryption.md` currently specifies per-folder, per-field
AES-GCM). Recommended revision: encrypt **the whole notebook** with SQLCipher,
keyed by a passphrase through Argon2id. One file covers content, titles, search
index, undo log and whiteboards, with no per-query "locked" logic. Sensitive notes
live in their own encrypted notebook — cheap once notebooks are first-class.
Consequences for this PRD: an encrypted notebook's mirror must be either disabled
or itself encrypted (e.g. age-encrypted files, which keeps git sync working but
loses readability by other tools), and `notebook.json` must not contain anything
sensitive. Decide in the encryption PRD; this layout accommodates both.

## 9. Open questions

1. ~~Default location for new notebooks: `~/MiNotes/<name>`, or keep `~/.minotes`
   and make "choose a folder" opt-in?~~ **Resolved: `~/MiNotes/<name>`** (app and
   `minotes notebook create`); Android uses app storage (§11).
2. Should the mirror include a human-readable index (`README.md` with a page list)?
3. ~~Cross-notebook search and links: out of scope here — worth a follow-up?~~
   **Resolved: built** — see §10.
4. ~~Mobile (the Android build): fixed app storage only, or folder access via the
   system picker?~~ **Resolved: app storage; the picker only for copies.** See
   §11 "Android storage (built)".
5. ~~Rename `graph` → `notebook` in the CLI and commands eventually, with aliases?~~
   **Resolved: renamed.** "Graph" now means only the link graph (Graph view,
   `minotes graph data|neighbors|stats`). The CLI's one selector is
   `--notebook <name|folder|path>`; `--graph <path>` stays as a hidden,
   deprecated alias (notice on stderr). `minotes notebook list|current|create|open|rename|delete`
   (`minotes notebooks` = list). Tauri commands are `switch_notebook` /
   `get_current_notebook` (the dead `list_graphs` / `create_graph_cmd` /
   `delete_graph_cmd` were removed in favour of the `*_notebook` commands). On-disk
   names are unchanged: `~/.minotes/active_graph`, `~/.minotes/<name>.db`,
   `~/MiNotes_Sync[-<name>]`.

## 10. Cross-notebook search and links (built)

Resolves §9 Q3. Core `minotes-core/src/cross_notebook.rs`, app commands in
`src-tauri/src/cross_notebook.rs`, frontend `lib/crossNotebook.ts`.

**Search.** The search palette (Ctrl+K — also the sidebar's Search button; there
is no separate full search view) has an **All notebooks** toggle, off by default
and remembered (`searchAllNotebooks` setting). On, the open notebook's results
come first as before, then every other registered notebook's (title and block
hits), grouped and labelled with the notebook name. Other notebooks are opened
strictly read-only — `SQLITE_OPEN_READ_ONLY` + `query_only`, no schema setup or
migrations, never the notebook lock, 200 ms busy timeout — off the UI thread
(async command), capped at 10 block + 5 title hits per notebook and 2.5 s in
total. Notebooks that can't be read are skipped with a quiet note ("Skipped: Work
(not available)"): missing folder, busy (held exclusively), unreadable, out of
time, or **locked** — the hook for encrypted notebooks: a `notebook.json` with an
`encryption` entry is "not searchable while locked" until unlocking exists.
Opening a hit switches notebooks with the normal switch flow, opens the page and
reveals the block. CLI: `minotes search <q> --all-notebooks` (every format
carries the notebook name; CSV prints skipped notebooks on stderr).

**Links.** `[[Notebook::Page title]]`; the notebook is matched by its registry
name, case-insensitively. `::` had no meaning inside `[[…]]` before (it is only
the line-level `key:: value` property separator, and property keys may not
contain it), so no alternative syntax was needed. Kept for old data: if no
notebook has that name and this notebook has a page literally titled `A::B`,
`[[A::B]]` stays a normal local link.

- Storage: link sync records each link in the `notebook_links` table (block; the
  notebook and title as written; the resolved notebook key + page id). The table
  is created idempotently (`CREATE TABLE IF NOT EXISTS`, no version bump). Rows
  whose text is unchanged keep their ids across edits; a link to a page that
  didn't exist yet is pinned when it first resolves. Resolution tries the stored
  ids first, so renaming the target page or notebook keeps the link working; the
  chip shows the current names while the block text stays as written.
- Never a row in `links`: no local page, nothing in the local graph, no
  backlinks, unlinked references or rename rewriting. Following a link never
  creates a page, here or in the other notebook.
- Rendering: a chip "Notebook › Page", styled apart from local links; click →
  switch and open. Unresolvable → a muted, dashed "not found" (or "unavailable")
  chip with a tooltip; clicking it explains in a toast.
- Autocomplete: `[[` also offers the other notebooks as `Name::`; after
  `[[Work::` it lists Work's page titles (read-only). Enter on an unknown title
  inserts the link anyway (nothing is created).
- The markdown mirror, export, sync and outside-edit import keep the text
  unchanged (it is block content); the Obsidian/markdown importer keeps
  `[[A::B]]` as written instead of resolving it to an imported note.
- **No cross-notebook backlinks in v1**: the target notebook never learns who
  links to it (it isn't even opened for writing).
- Caveat: the chip follows renames, but the markdown text keeps the title as
  written (`[[Work::Old title]]`) until the link is edited.

## 11. Android storage (built)

Decision (Q4): on Android the database always lives in app-private storage.
SQLite never runs on a Storage Access Framework `content://` URI (no real file
path, unsafe locking). The system picker is used only for copies.

- **One place decides the directories** — `minotes_core::notebook` (`home_dir`,
  `base_dir`, `notebooks_dir`, `default_location`, `legacy_mirror_dir`). Desktop and
  the CLI are unchanged (`~/.minotes`, `~/MiNotes/<name>`, `~/MiNotes_Sync[-<name>]`).
  On Android the app injects its data dir at startup (`set_app_storage`):
  `<app_data>` is the legacy `.minotes` base (`default.db`, `notebooks.json`,
  `active_graph`), folder notebooks go to `<app_data>/notebooks/<name>/` with the
  desktop layout, and a legacy notebook's mirror / git sync dir is
  `<app_data>/MiNotes_Sync[-<name>]`. `TMPDIR`/`SQLITE_TMPDIR` point at the app's
  cache dir (Android has no writable `/tmp`). The pre-fix APK crashed at launch
  opening `./.minotes/default.db` because Android sets no `HOME`.
- **Export notebook… / Import notebook…** (`notebook_zip`, commands
  `export_notebook_zip` / `import_notebook_zip`; notebook menu, Manage notebooks,
  Settings; also on desktop as a one-file backup). The zip is a notebook folder:
  a `VACUUM INTO` snapshot checked against live row counts, `notebook.json`, a
  freshly rendered `notes/` (without `_attachments/`, whose originals are in
  `attachments/`), and the attachment store. Import refuses unsafe names (`..`,
  absolute, drive letters, backslashes), symlinks, encrypted entries and duplicate
  names before writing anything; caps entries (200k), total size (8 GB) and the
  database (4 GB) and counts real bytes while extracting (lying headers are caught);
  drops attachments whose content does not hash to their name; requires
  `integrity_check` = ok and the MiNotes tables; ignores `notes/` and `.minotes/`
  (derived / device-private). It always becomes a new notebook in a new folder:
  a known id gets a new one, a taken name becomes "Name 2", an existing folder is
  never written into.
- **Capabilities, not user-agent sniffing**: `get_platform_capabilities`. On
  Android the UI hides choosing a location, Open notebook… / Locate…, Move to a
  folder…, Open folder, and Import from other apps (those need real paths).
- **Mirror on Android: off unless git sync is on.** Nobody else can read
  app-private files, so a continuous second copy only costs battery and space; the
  zip export is the readable copy, and git sync (which commits the mirror) turns it
  back on. The outside-edit watcher and imports never run in app storage.
- **Keychain**: `keyring` is not compiled for Android (it only has an in-memory
  mock there that would silently forget the key); the AI settings report "no
  keychain".
- **Mobile save-on-background**: the editor saves a block on blur; on mobile the
  focused editor is blurred when the app goes to the background, so an OS kill
  doesn't lose the block being typed.

Verified on an Android 14 (API 34, x86_64) emulator with a debug APK: the app
starts and creates `default.db` in `/data/user/0/com.minotes.app/`; "New
notebook…" (real taps and typing) creates `notebooks/Phone/` with the desktop
layout and no location field; a page written there survives a force-stop and
relaunch; the menu shows New / Manage / Export / Import only; capabilities report
`app_storage`; Export notebook… goes through the system save picker and writes
`Download/Phone.minotes.zip` (pulled with adb: snapshot + notebook.json + notes/);
Import notebook… through the open picker (`content://` URI) creates and opens
"Phone 2"; Settings shows "This device (app storage)" and the mirror off.
Not verified on a device: a physical phone, ARM builds (only `--target x86_64`
was built), git sync on Android (no `git` binary there — the sync UI reports git
unavailable), very large zips, and the share sheet (the save picker is used).

Later (not built): a markdown copy written to a user-picked SAF folder
(`ACTION_OPEN_DOCUMENT_TREE`, persisted URI permission, export-only); an Android
Keystore-backed store for the AI key; importing Obsidian / Evernote / markdown
folders on Android (needs SAF tree reading).
