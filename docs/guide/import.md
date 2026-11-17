# Import your notes

MiNotes can import from **Evernote**, **Obsidian** and **a plain folder of markdown files**. An import is a one-time move: your original files are only read, never changed.

## In the app

1. Press **Ctrl+Shift+I**, or choose Import from the palette (Ctrl+K, type `import`). A new, empty notebook also offers it on its first screen.
2. Choose where your notes come from:
   - **Evernote:** pick one or more `.enex` files.
   - **Obsidian:** pick the vault folder (the one that contains `.obsidian`).
   - **Markdown folder:** pick the folder.
3. Look at the preview. It shows how many notes, folders and attachments were found and lists anything that will not convert cleanly.
4. By default the notes go into a **new notebook** named after the source, so a bad import is easy to throw away. You can also import into an existing notebook; they are then placed in a new project.
5. Start the import. When it finishes you get a report, also saved as a page called "Import report".

**Undo import** removes exactly the pages, projects and attachments that run created. It asks first, and keeps any page you have edited since and tells you which ones.

Running the same import again does not create duplicates: unchanged notes are skipped.

## Exporting from Evernote

In Evernote, right-click a notebook, choose **Export**, and pick **ENEX**. Do this once per notebook. Each `.enex` file becomes one project. Import them all at once and they can be grouped under one parent project.

## What is kept

| From | What carries over |
|---|---|
| All | Folders become projects. Links between notes keep working. Tags, creation and modification dates, and properties are kept. Images and files are copied into MiNotes as attachments. Checkboxes become to-dos. |
| Evernote | Text formatting, lists, tables, links, checklists, images and attached files. The source URL, author and similar details become page properties. Web clips and saved emails import as ordinary notes. Links to other imported notes are resolved. |
| Obsidian | `[[links]]` (including `[[Note\|alias]]`), tags and nested tags, frontmatter (becomes properties; `tags` and `aliases` are understood), image embeds, callouts, code blocks. Daily notes can become journal pages. |
| Markdown folder | Subfolders become projects. Frontmatter becomes properties. Links such as `[text](other.md)` become `[[links]]`. Relative images are attached. |

Documents are split into blocks by headings and list items so they work as an outline.

## What is not kept

- Fonts, colours and other visual styling (a highlight becomes MiNotes' highlight).
- Evernote's encrypted text, which is kept as a placeholder block saying it was not imported.
- Evernote text recognition (OCR) data, and reminders as reminders (the dates stay as properties).
- Whole-note embeds in Obsidian (`![[Note]]`) become a link to the note.
- Obsidian plugin content: Dataview and Tasks queries stay as plain code, and Canvas and Excalidraw files are attached as files instead of being drawn.
- Math (`$...$`) stays as text.

Anything that does not convert cleanly is counted in the report, and the original text is kept wherever possible.

## From the command line

```bash
minotes import evernote Work.enex Personal.enex
minotes import obsidian ~/Vaults/MyVault
minotes import markdown ~/Documents/notes
```

Add `--dry-run` to see the report without importing anything. `minotes import runs` lists earlier imports and `minotes import undo <run>` reverses one. See `minotes import --help` for the destination options.
