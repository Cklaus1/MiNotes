<p align="center"><img src="docs/images/banner.jpg" alt="MiNotes: the outliner that keeps your notes yours" width="100%"></p>

<p align="center">
<a href="https://github.com/Cklaus1/MiNotes/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Cklaus1/MiNotes/actions/workflows/ci.yml/badge.svg"></a>
<a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-89b4fa"></a>
<img alt="Status: beta" src="https://img.shields.io/badge/status-beta-f9e2af">
</p>

# MiNotes

**The outliner that keeps your notes yours.** Linked notes, a daily journal and tabs, on your own computer. No account, no subscription, no MiNotes server.

> **Beta.** The Linux packages have been checked to install and start on Ubuntu and Fedora. Windows, macOS and Android builds still need testing by people. Keep a backup of notes you care about.

![MiNotes showing a page with links, open tabs and the sidebar](docs/images/screenshot-page.png)

## Why MiNotes

| You want to | MiNotes gives you |
|---|---|
| **Own your notes** | Notebooks are files on your disk, with a readable markdown copy (except encrypted notebooks) |
| **Leave Evernote or Obsidian** | An importer that brings over text, images, files, dates and tags, with a report of anything it couldn't keep. [What's kept](docs/guide/import.md) |
| **Keep private things private** | Encrypt a whole notebook with a passphrase and recovery key. [Encryption](docs/guide/encryption.md) |
| **Use more than one computer** | Sync through a git remote you choose, with a side-by-side view when both sides changed. [Sync](docs/guide/sync.md) |
| **Find and connect ideas** | `[[Links]]`, backlinks, typo-tolerant search, tabs, and graph, kanban, mind map and whiteboard views |

## How it works

```mermaid
flowchart LR
  I["Evernote, Obsidian,<br>markdown files"] -->|import| N
  subgraph PC["Your computer"]
    A["MiNotes app"] <--> N[("Notebook<br>database")]
    C["minotes command line"] <--> N
    N -->|"plain notebooks"| M["Readable<br>markdown copy"]
  end
  N <-->|"git sync, only if you set it up<br>(encrypted notebooks: encrypted files)"| G["Git remote<br>you choose"]
  G <--> O["Your other computer"]
```

## Download

Get the installer for your system from the **[latest release](https://github.com/Cklaus1/MiNotes/releases/latest)**.

| System | Pick this file |
|---|---|
| Windows 10 / 11 | `MiNotes_…_x64-setup.exe` (or the `.msi`) |
| Linux, any distribution | `MiNotes_….AppImage` |
| Debian, Ubuntu, Mint | `MiNotes_….deb` |
| Fedora, openSUSE | `MiNotes-….rpm` |
| Android (test build) | `MiNotes_…_android-debug.apk` — sideload it ("install unknown apps"); a debug build for trying out, not a store release |
| macOS (experimental) | `MiNotes_…_universal.dmg` (Apple Silicon and Intel). Not signed by Apple yet: the first time, right-click the app and choose **Open** |

**Windows:** the installers are not signed yet, so Windows SmartScreen may say "Windows protected your PC". Click **More info**, then **Run anyway**.

**Linux:**

```bash
chmod +x MiNotes_*.AppImage && ./MiNotes_*.AppImage     # AppImage
sudo apt install ./MiNotes_*.deb                         # Debian / Ubuntu
sudo dnf install ./MiNotes-*.rpm                         # Fedora
```

More detail, including where your notes are stored and how to uninstall: [Install guide](docs/guide/install.md).

## Quick start

1. Install and start MiNotes. The first page you see is **Getting Started**; it shows the basics and you can delete it whenever you like.
2. Click into a block and type. **Enter** starts a new block, **Tab** indents it under the one above, **Shift+Tab** moves it back out.
3. Type `[[` to link to another page. Pick an existing page from the list, or create a new one from there.
4. **Ctrl+K** searches everything; **Ctrl+J** opens today's journal; **Ctrl+T** opens a new tab; **Ctrl+/** lists every shortcut.
5. Coming from another app? Press **Ctrl+Shift+I** to [import your Evernote, Obsidian or markdown notes](docs/guide/import.md).

## Features

**Writing and linking**
- Block outliner with indent, collapse, drag to reorder, and slash (`/`) commands for headings, to-dos, tables, callouts, code and more.
- `[[Page links]]` with backlinks and unlinked mentions, `((block references))` and embeds, tags and page properties.
- To-dos (`TODO`, `DOING`, `DONE`) collected in a Tasks view; templates; per-day journal pages.
- Images, PDFs and file attachments in your notes.

**Finding your way around**
- Tabs, back and forward, a command palette (Ctrl+K) with typo-tolerant search across pages, blocks and journals, projects (folders) and pinned pages.
- Light and dark themes.

**Other ways to see your notes**
![The link graph, with the current page highlighted](docs/images/screenshot-graph.png)

- Link graph, kanban board (columns by status or by a property), mind map, and per-block whiteboards.

**Keeping notes safe**
- Encrypted notebooks (the whole database is encrypted, with a recovery key).
- A readable markdown copy of each notebook (not for encrypted ones), and zip export of a whole notebook.
- [Git sync](docs/guide/sync.md) between devices, with a conflict view that lets you keep either version or both.

**For power users**
- A `minotes` command-line tool for scripting and a SQL query panel. See [CONTRIBUTING.md](CONTRIBUTING.md#the-minotes-command-line-tool).

## Privacy

- **Local first.** Notebooks are files on your disk. There is no account and no MiNotes server.
- **No telemetry.** The app contains no analytics or crash-reporting code, and no automatic update check.
- **Sync goes only where you point it.** Git sync is off until you set it up, and it uses only the remote address you give it, with your own git credentials. Encrypted notebooks sync as encrypted files.
- **Images from the web are blocked by default.** A web image in a note shows a placeholder until you allow it (Settings, Privacy).
- **AI is off by default.** Nothing is sent anywhere unless you pick a provider and add your own key in Settings. Link preview cards fetch the title and image of a web address you put in a note.

## Documentation

[User guide](docs/guide/README.md): [install](docs/guide/install.md), [getting started](docs/guide/getting-started.md), [import](docs/guide/import.md), [sync](docs/guide/sync.md), [encryption](docs/guide/encryption.md), [FAQ](docs/guide/faq.md). Changes by version: [CHANGELOG](CHANGELOG.md).

Questions and ideas are welcome in [Discussions](https://github.com/Cklaus1/MiNotes/discussions); bugs go in [Issues](https://github.com/Cklaus1/MiNotes/issues/new/choose). To report a security problem privately, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE), copyright Fusen World. Components used by MiNotes: [third-party notices](THIRD_PARTY_NOTICES.md).

## Contributing

Build instructions, tests and project rules are in [CONTRIBUTING.md](CONTRIBUTING.md).
