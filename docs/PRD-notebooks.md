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
- Cross-notebook links or search (possible later; see §9).
- Encryption (see §8 — designed to fit, specified separately).
- Importing from other apps (see `PRD-import.md`, to be written; §8).

## 4. Phases

### Phase 1 — Switcher in the sidebar (no spec needed; build directly)

- The sidebar header shows the current notebook's name next to "MiNotes"; clicking
  it opens a menu: the list of notebooks (current one checked), "New notebook…",
  "Manage notebooks…".
- UI text says **Notebook** everywhere. Code, commands and the CLI keep `graph`
  for now (renaming them is churn with no user benefit).
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
- The CLI accepts a notebook folder for `--graph` as well as a `.db` path, and
  `--notebook <name>` resolves through the registry.
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

1. Default location for new notebooks: `~/MiNotes/<name>`, or keep `~/.minotes`
   and make "choose a folder" opt-in?
2. Should the mirror include a human-readable index (`README.md` with a page list)?
3. Cross-notebook search and links: out of scope here — worth a follow-up?
4. Mobile (the Android build): fixed app storage only, or folder access via the
   system picker?
5. Rename `graph` → `notebook` in the CLI and commands eventually, with aliases?
