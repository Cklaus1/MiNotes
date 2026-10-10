---
name: desktop-check
description: Run the REAL MiNotes desktop app (Tauri/WebKitGTK, production CSP, real Rust backend) on a private virtual display, drive it with clicks and keys, and review screenshots. Use to verify anything browser mode can't — CSP, IPC commands, file access, PDF viewer, link previews, whiteboard persistence — or when asked to "check the desktop app", "smoke test Tauri", or see how a change looks in the real app.
---

# Desktop check

Browser mode (`vite` + `tests/user-journey-test.sh`) uses a mock backend and does
not enforce the CSP. This skill runs the actual binary instead. It uses a
throwaway `HOME`, so the user's `~/.minotes` is never touched.

Playwright cannot attach to WebKitGTK. Two ways to drive the window, usable together:

- **Input + screenshots** (always available): `xdotool` clicks/keys, then **read the
  screenshots**.
- **WebDriver** (`up --webdriver`, via `tauri-driver` + `WebKitWebDriver`): run JS
  inside the real app, read the DOM, call Tauri commands directly.

Backend state can always be checked with `sqlite3` or the CLI.

## Driver

`D=.claude/skills/desktop-check/desktop.sh` (run from the repo root). Set
`DESKTOP_CHECK_DIR` to a directory in your scratchpad so state and screenshots
land there.

| Command | What it does |
|---|---|
| `$D up` | Start Xvfb, build (`tauri build --debug --no-bundle` + CLI), launch, wait for the window. `--no-build` reuses the last binary; `--webdriver` enables the DOM commands. Re-running restarts the app with a fresh HOME. |
| `$D shot <name>` | Screenshot the display → prints the PNG path. **Read it.** |
| `$D click <x> <y>` / `$D key <keys>` / `$D type <text>` | Input. The window sits at 0,0 (1200x800), so screenshot pixels == click coordinates. |
| `$D cli <args>` | `minotes` CLI against the scratch DB (seed pages/blocks; the app refreshes live). |
| `$D fixture-pdf` | Write a 1-page test PDF, print its path. |
| `$D js '<body>'` | *(webdriver)* Run an async function body in the app; prints the JSON result. `invoke(cmd, args)` calls a Tauri command. |
| `$D text <css>` / `$D wclick <css>` | *(webdriver)* innerText of / click the first match. |
| `$D wshot <name>` | *(webdriver)* Screenshot of the webview only (no native dialogs). |
| `$D paste-image` | *(webdriver)* Paste a generated red 96x96 PNG into the current view. |
| `$D status` / `$D log` / `$D down` | Health, app stderr, teardown. **Always `down` when finished.** |

Build takes ~1–2 min. After any action that loads data or opens a view, `sleep`
2–6 s before `shot`.

## Standard checklist

Run all of these unless asked for something narrower; take a screenshot per step
and look at each one.

1. **Startup** — `up`, `shot 01-startup`. Expect the dark UI, sidebar with
   "Getting Started", styled blocks. A blank/unstyled window ⇒ CSP or bundle problem; check `$D log`.
2. **Seed + live refresh** — `cli page create "Desktop Check"`, then
   `cli block create "Desktop Check" "{{link-preview:https://example.com}}"` and a
   block with `**bold** and [[Getting Started]]`. The page must appear in the
   sidebar without a restart (db watcher).
3. **Navigation + link preview** — `click 60 190` (first row under PAGES; rows are
   27 px apart), wait ~7 s. Expect an "Example Domain" card (needs network), bold
   text and a coloured wiki link.
4. **PDF viewer** — `click 700 500; key Escape` (leave any editor), `key ctrl+p`,
   `type "$($D fixture-pdf)"`, `key Return`, wait 6 s. Expect "1 / 1" and a white
   page with a blue square and "Desktop check". Close with `click 1154 20`.
5. **PDF error path** — same with `/nonexistent/missing.pdf`. Expect a
   "Couldn't open this PDF" card, not a blank page.
6. **Settings** — `key ctrl+comma`, shot, `key Escape`.
7. **Whiteboard persistence** — `click 125 780` (Draw), `click 229 62` (Draw tool),
   drag with `xdotool mousemove … mousedown 1 … mouseup 1` (export
   `DISPLAY=localhost:97` for raw xdotool), wait 3 s, `click 50 22` (← Notes). Then
   `sqlite3 "$DESKTOP_CHECK_DIR/home/.minotes/default.db" "select id,length(data) from whiteboards"`
   must return a row.
8. **Whiteboard image** *(webdriver)* — with a whiteboard open, `paste-image`, wait
   4 s, `wshot`. Expect a red square on the canvas, and
   `select data like '%data:image/png%' from whiteboards` → 1.
9. **Security rules** *(webdriver)* — each must hold in the real app:
   - `js 'try { eval("1"); return "NOT blocked" } catch { return "blocked" }'` → blocked (CSP)
   - `js 'return typeof window.__TAURI__'` → `"undefined"`
   - `invoke("read_file_base64", {path: "/etc/passwd"})` and
     `invoke("read_pdf_file", {path: "/etc/passwd"})` → rejected
   - `invoke("switch_graph", {name: "../../evil"})` → rejected
   - `invoke("run_query", {sql: "BEGIN"})` → rejected
   - SSRF: serve a page with a distinctive `<title>` on `127.0.0.1:<port>`
     (`python3 -m http.server`), call `invoke("fetch_og_metadata", {url})` for
     `127.0.0.1`, `localhost`, `[::1]`, `0.0.0.0` — the title must NOT come back and
     the server log must show no request from the app. (The command returns empty
     metadata on any failure, so an empty result alone proves nothing.)
   - **Never call `save_png_to_downloads` here** — on WSL it writes into the real
     Windows Downloads folder regardless of the scratch HOME.
10. `down`, then report pass/fail per step with what you saw.

Steps 1–7 work without `--webdriver`; start with `up --webdriver` to run everything
in one session.

Coordinates are for the default 1200x800 window; if the layout changed, take a
screenshot first and read positions off it.

## Limits and gotchas

- WebDriver mode needs `apt-get install webkit2gtk-driver` and
  `cargo install tauri-driver --locked` (installed on this machine 2026-10-10).
  `withGlobalTauri` is off, so use the `invoke` helper that `js` provides.
- ProseMirror ignores synthetic key events; type into editors with `$D click` +
  `$D type` (real X input), and use `js` to read the result.
- An OS file **drag-drop** still can't be simulated; `paste-image` exercises the same
  image-insert path, and `read_file_base64` (the drop fallback) can be called via `js`.
- JS `prompt()`/`confirm()` are native GTK dialogs: `type` + `key Return` works;
  screenshots are of the whole display so they show up.
- Xvfb must use Mesa EGL on this machine (the script sets
  `__EGL_VENDOR_LIBRARY_FILENAMES`); with the NVIDIA vendor it aborts at startup.
  It listens on TCP only because WSLg owns `/tmp/.X11-unix`. Never use WSLg's
  `DISPLAY=:0` — X clients hang on it.
- Don't use `pgrep -f`/`pkill -f` with a pattern that appears in your own command
  line; use `$D down`.
