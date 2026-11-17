# Contributing to MiNotes

Thanks for helping. This page covers building from source, running the tests, the project layout, and the rules that keep the codebase working. If you only want to use MiNotes, see the [README](README.md) and the [user guide](docs/guide/README.md).

For questions and ideas, use [Discussions](https://github.com/Cklaus1/MiNotes/discussions). For a security problem, follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## Build from source

You need:

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) 18 or newer
- The [Tauri 2 system dependencies](https://v2.tauri.app/start/prerequisites/) for your OS:
  - **Linux:** WebKitGTK 4.1, GTK 3, libsoup 3 and a C toolchain (the Tauri page lists the exact packages for Debian, Fedora and Arch).
  - **Windows:** Microsoft C++ Build Tools and WebView2 (preinstalled on Windows 10/11).
  - **macOS:** Xcode command line tools.

SQLite is built as SQLCipher, with OpenSSL compiled from source, so the first build is slow and needs `perl` and `make`.

```bash
git clone https://github.com/Cklaus1/MiNotes.git
cd MiNotes

# Install frontend dependencies (first time)
cd crates/minotes-app && npm install

# Desktop app in dev mode
npm run tauri dev

# Frontend only, in a browser with an in-memory mock backend
npx vite --port 1420
```

On WSLg the window needs software rendering:

```bash
cd crates/minotes-app && \
  LIBGL_ALWAYS_SOFTWARE=1 WEBKIT_DISABLE_COMPOSITING_MODE=1 \
  WEBKIT_DISABLE_DMABUF_RENDERER=1 GDK_BACKEND=x11 npm run tauri dev
```

To build installers locally, run `npm run tauri build` in `crates/minotes-app`. Release installers are built by the project's GitHub workflows.

## Project layout

```
crates/
  minotes-core/    Rust library: SQLite, models, repo layer, search, sync, encryption, import
  minotes-cli/     the `minotes` command-line tool (Clap 4)
  minotes-app/
    src/           React 19 + TypeScript frontend (components/, editor/, lib/)
    src-tauri/     Tauri 2 backend commands
docs/              PRDs and design notes (docs/guide/ is the user guide)
tests/             user-journey and desktop-journey scripts
```

`CLAUDE.md` at the repository root is the detailed architecture guide (it is written for an AI coding assistant, but it is the most complete reference for how the pieces fit). The product specs are in `docs/PRD-*.md`.

## Checks and tests

Run these from the repository root unless noted.

```bash
# Rust
cargo check -p minotes-app -p minotes-cli
cargo test --workspace

# Frontend (from crates/minotes-app/)
cd crates/minotes-app
npx tsc --noEmit        # must run from this folder
npm test                # vitest: editor round trips, source lints
npx vite build
```

**User journeys** drive the real UI in headless Chrome with the mock backend. They need [`agent-browser`](https://www.npmjs.com/package/agent-browser) installed and a dev server running:

```bash
cd crates/minotes-app && npx vite --port 1591 &
JOURNEY_URL=http://localhost:1591 bash tests/user-journey-test.sh
```

**Desktop checks** run the real Tauri app (real backend, production CSP) on a virtual display. This catches what browser mode cannot: IPC, file access, persistence, sync.

```bash
bash tests/desktop-journey-test.sh                        # restart, real typing, CLI interop, 2-device sync
JOURNEY_BACKEND=desktop bash tests/user-journey-test.sh   # the browser journeys on the real backend
```

The harness is described in `.claude/skills/desktop-check/SKILL.md`. It uses a throwaway home directory, so it never touches your own notebooks.

## Rules that matter

The full list is in `CLAUDE.md`. The ones most likely to bite:

- **Component `.tsx` files export only React components.** A utility export breaks Vite's hot reload.
- **No `window.confirm`, `alert` or `prompt`.** Use `confirmDialog` / `promptDialog` from `lib/confirm.ts`. `npm test` fails on them.
- **Every editor node or mark needs a markdown serializer and a parser**, plus a case in `src/editor/markdownRoundTrip.test.ts`.
- **No emoji as UI icons** (use `lib/icons.ts`) and **colours only from theme tokens**. Both are linted by `npm test`.
- **Never read or write through a symlink inside a mirror or sync folder.** Use the helpers in `export.rs`, and run git only through `git_cmd::run_git`.
- **Locked notebooks:** in the app always go through `state.db_guard()?`.
- **Remote images are never loaded directly.** The CSP has no `https:` in `img-src`; use the backend `fetch_remote_image` path.
- **Paths come from `minotes_core::notebook`.** Never read `$HOME` directly (Android has none).
- A page's blocks are in outline order, not position order. Do not sort by position alone.
- Tests never touch the real OS keychain; they use the debug-only fake keychain.

## Pull requests

- Branch from `main`, keep the change focused, and fill in the pull request template.
- CI must pass: `cargo check` and `cargo test`, `tsc`, `npm test`, `vite build`, the browser journeys, and `cargo audit` / `npm audit`.
- Add or update a test for behaviour you change. For editor, sync or encryption changes, a journey (browser or desktop) is expected.
- Add one line under "Unreleased" in [CHANGELOG.md](CHANGELOG.md) for anything a user would notice.
- For UI changes, include a screenshot or a short recording.
- By contributing you agree that your work is released under the [MIT license](LICENSE).

## The `minotes` command-line tool

The CLI works on the same notebooks as the app.

```bash
cargo build --release -p minotes-cli          # binary: target/release/minotes

minotes notebook list
minotes notebook create "Research"            # ~/MiNotes/Research
minotes --notebook "Research" page list       # -n: a name, a notebook folder, or a .db path

minotes page create "My Page"
minotes page get "My Page" --tree
minotes block create "My Page" "Text with a [[link]]"
minotes search "meeting" --limit 20
minotes journal                               # today's journal
minotes backlinks "My Page"
minotes stats

minotes import obsidian <vault> --dry-run     # also: import evernote <file.enex>…, import markdown <folder>
minotes export markdown --output <folder>

minotes -f text page list                     # --format: json (default), text, md, csv, opml
```

Without `--notebook` the CLI uses the notebook currently open in the app. `page delete` moves a page to Trash; a permanent delete needs `--permanent --yes`. Run `minotes --help` or `minotes <command> --help` for everything else. Encrypted notebooks read the passphrase from `MINOTES_PASSPHRASE` or ask on a terminal.
