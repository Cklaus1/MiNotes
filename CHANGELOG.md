# Changelog

All notable changes to MiNotes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - unreleased

First public release: desktop installers for Windows and Linux (unsigned at first).

### Editor
- Block outliner: indent and outdent, collapse, drag to reorder, split and merge blocks, block zoom.
- Rich text with headings, bold, italic, strikethrough, highlight, inline code, quotes, task lists, tables, callouts (`> [!note]`) and code blocks with a language picker. Optional markdown source mode per block.
- Slash (`/`) menu with icons, groups and descriptions; user templates; natural-language dates that link to journal pages.
- `[[Page links]]` with autocomplete, hover previews, backlinks grouped by page, unlinked mentions with a Link button.
- `((Block references))` and embeds, tags, and `key:: value` properties on blocks and pages.
- To-dos (`TODO`, `DOING`, `DONE`) and a Tasks view.
- Images (paste, drop, resize, lightbox), PDF reading and highlights, file attachments, link preview cards. Images from the web are blocked until you allow them.
- Large pages (over 300 blocks) are windowed so they stay fast.

### Navigation & tabs
- Tabs: open pages, journal days and views side by side; they are remembered per notebook. Ctrl+click opens in a background tab.
- Back and forward (Ctrl+[ / Ctrl+], mouse buttons), also across notebooks.
- Command palette and search (Ctrl+K): typo-tolerant, with pages, blocks, journals and other notebooks; `>` for commands.
- Projects (nested folders), pinned pages, recent pages, All Pages with bulk actions, Trash and Archive with restore.
- Daily journal with previous/next day and a calendar.
- Collapsible sidebar, light and dark themes, keyboard shortcut list (Ctrl+/).

### Notebooks & encryption
- Several notebooks, each a folder you can see and copy (`~/MiNotes/<name>`); switch from the sidebar. Links between notebooks (`[[Notebook::Page]]`) and search across notebooks.
- Readable markdown copy of each notebook, with edits made outside the app picked up when you return.
- Encrypted notebooks (SQLCipher): passphrase, recovery key, optional "keep unlocked on this device" through the OS keychain, auto-lock, change passphrase, remove encryption.
- Notebook zip export and import.

### Sync
- Git sync between devices to a remote you choose, set up in Settings, Sync & Backup: Test connection, Set up sync, Change or Remove. Join an existing notebook from a second device.
- Status chip and Sync now. Conflicting edits are kept as "(conflict from device)" copies with a side-by-side Compare view and Keep mine / theirs / both.
- Deletions from another device are held for review when large.
- Encrypted notebooks sync as encrypted files only, merged per block after decryption.

### Import
- Import from Evernote (`.enex`), Obsidian vaults and markdown folders: preview, report of anything that did not convert, re-run without duplicates, and Undo import.
- Attachments, tags, properties, links between notes and Evernote web clips are carried over.

### Views
- Link graph with local graph, filters, search and colours.
- Kanban board by status or property; mind map; per-block whiteboards with shapes, text, connectors and PNG/SVG export.
- Exports: markdown, HTML site, PDF, and copy as text.
- Flashcard review and a SQL query panel.

### CLI
- `minotes` command: pages, blocks, folders, properties, search, journal, backlinks and graph, notebooks, import and export, in JSON, text, markdown, CSV or OPML.
- Works on the same notebooks as the app, including encrypted ones (`MINOTES_PASSPHRASE`).

### Optional
- Ask AI about your notes. Off by default; needs a provider and your own key.
- Android builds exist for testing (debug APK only).
