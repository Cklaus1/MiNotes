# PRD: Plugins

Status: draft · Owner: Chris Klaus · Rewritten 2026-10-10

> **Supersedes the "hybrid tiered" design** (2026-10-07, never implemented). That
> version proposed native third-party plugins loaded with `libloading`, frontend
> plugins as dynamic imports in the app's window, and extracting built-in features
> (cards, snippets, graph, PDF, templates) into plugins first. Replaced because:
> a native library runs in-process with full access to the user's files and network
> — nothing can restrict it, so "Tauri permissions" were not a sandbox; any script
> in the app's window can invoke every backend command, so the frontend permission
> model did not hold either (its §7.3 claim was false); the CSP added in October
> 2026 deliberately blocks loading third-party code into the window; and extracting
> built-ins spent the first phases restructuring working features without enabling
> anything new. The original is in git history.

## 1. Overview

Let people extend MiNotes — add commands, render new kinds of blocks, import and
export formats, connect services, theme the app — without being able to read or
destroy notes they didn't grant access to, and without making the app slower or
less reliable.

**One-liner:** plugins are sandboxed packages (WebAssembly for logic, isolated
iframes for UI) that talk to MiNotes only through a small, versioned, permissioned
API, contribute features at named extension points, and are distributed through a
**public marketplace** where every listing shows what the plugin can access —
enforced, not just declared.

**Decision (2026-10-10): public marketplace.** Plugins are a product and growth
lever, not only personal automation. The benchmark is Obsidian's community
directory (large, central to its appeal, automated scanning of every release since
2026 — but no sandbox or enforced permissions; its own docs say plugins can access
files, the network and install programs). MiNotes competes on that gap: same
breadth of distribution, with isolation and verifiable permissions from day one.

**Decision (2026-10-10): free marketplace, no fees.** Every listing installs for
free; MiNotes processes no payments and charges authors nothing (no registration
fee). Authors may run their own upsell outside the marketplace (subscriptions,
licence keys, pro versions); the marketplace takes no part in it and shows no
pricing label at launch. Same model as the Chrome
Web Store since it retired its payments in 2020–21, Firefox Add-ons, VS Code and
Obsidian — and it avoids payments, payouts, tax, refunds and payment fraud.

## 2. Why plugins (jobs to be done)

Ranked by how often users of comparable apps (Obsidian, Logseq, VS Code) reach
for plugins:

1. **Render things the editor doesn't know**: diagrams (Mermaid, PlantUML), charts
   from tables, math, embeds (YouTube, Figma, maps), custom callouts.
2. **Automate**: commands that reshape notes (sort, dedupe, generate a table of
   contents, daily-note templates with logic), run on a schedule or on an event.
3. **Connect services**: Readwise/Kindle highlights, calendar, GitHub issues, Todoist,
   Zotero citations — pull data in, sometimes push it out.
4. **Import / export formats** beyond the built-ins (see `PRD-import.md`).
5. **Query and view data**: dataview-style tables over properties, custom page
   views (timeline, calendar, gallery).
6. **AI providers and tools**: bring your own model or API key (ties to
   `PRD-ai-assistant.md`).
7. **Look and feel**: themes and CSS snippets.

The extension points in §4 are chosen to cover these, in this order.

## 3. Principles

1. **Least privilege, enforced.** A plugin can only do what its granted permissions
   allow, enforced at a boundary the plugin cannot reach around — not by convention.
2. **The app never depends on a plugin.** A broken, slow or malicious plugin can be
   disabled, and MiNotes starts without plugins in safe mode.
3. **Data stays readable without the plugin.** Plugin-rendered content is stored as
   plain markdown (e.g. a ```` ```mermaid ```` fence) that still makes sense if the
   plugin is gone.
4. **Small, stable API.** Fewer, well-versioned capabilities beat broad access.
5. **Built-ins stay built in** unless making one optional serves users.

## 4. Extension points (what a plugin can contribute)

| Extension point | Example | Phase |
|---|---|---|
| **Command** (palette, optional shortcut) | "Sort list", "Insert TOC" | 1 |
| **Slash-menu item** | `/mermaid`, `/today's meetings` | 1 |
| **Code-fence renderer** for a language | ```` ```mermaid ````, ```` ```chart ```` | 1 |
| **Block / page context-menu item** | "Send to Todoist" | 1 |
| **Settings page** for the plugin | API key, options | 1 |
| **Theme / CSS snippet** | colour themes | 1 (already exists — re-home as plugin type) |
| **Event hook** (block/page created, updated, deleted; app start; daily) | auto-tag, sync to service | 2 |
| **Importer / exporter** | Readwise import, Hugo export | 2 |
| **Sidebar panel** | calendar, highlights inbox | 2 |
| **Page view** (alternative to the outline, like kanban/mindmap) | timeline, gallery | 3 |
| **Inline query** (`{{query …}}` block) | dataview-style tables | 3 |
| **AI provider** (model endpoint behind the AI features) | local Ollama, OpenAI | 3 |
| **CLI subcommand** (headless, same Wasm module) | `minotes readwise sync` | 3 |

Not offered: patching the editor's internals, replacing core views, arbitrary DOM
access to the app window, raw SQL.

## 5. Runtime

### 5.1 Logic: WebAssembly (backend)

- Plugin logic is a **Wasm component** run by `wasmtime` in the Rust backend, using
  the component model with a WIT interface (`minotes:plugin@1.0`). Authors write in
  Rust, TypeScript/JavaScript (via `jco`/ComponentizeJS), Go or Python — anything
  that targets components.
- No ambient access: no filesystem, no network, no clock beyond what the host
  imports provide. Every capability is a host function that checks permissions.
- Resource limits per call: fuel/epoch interruption (default 2 s CPU), memory cap
  (default 64 MiB), and a per-plugin call budget. Exceeding them aborts the call,
  reports it, and after repeated failures disables the plugin.
- The same component runs in the desktop app and the CLI. (Android: same, once
  `wasmtime` is validated there; otherwise plugins are desktop-only at first.)

### 5.2 UI: sandboxed iframes

- A plugin's UI (settings page, sidebar panel, page view, code-fence renderer
  output) is an **iframe with `sandbox="allow-scripts"`** (no `allow-same-origin`)
  served from a dedicated `plugin://<id>/` protocol with its own strict CSP.
- It cannot touch the app's DOM, storage or Tauri IPC. It talks to the host only by
  `postMessage` with a typed, permission-checked message set (§6), relayed by the
  app to the plugin's Wasm module or to host APIs.
- Code-fence renderers return either sanitised SVG/HTML (rendered inline after
  sanitisation) or request an iframe for interactive output.
- Theming: the host passes CSS variables (colours, fonts) into each iframe so
  plugin UI matches the app.

### 5.3 What is not supported

- Native libraries (`.so/.dll/.dylib`): no sandbox is possible.
- Loading plugin JavaScript into the app window (incl. `new Function` / dynamic
  `import` of plugin code): blocked by the CSP by design.
- **Obsidian plugins**: their API assumes full DOM and Node access; a compatible
  shim cannot be sandboxed. The existing `obsidian-compat/` loader (disabled by
  default, already non-functional under the CSP) is **removed**. Common Obsidian
  plugin *ideas* are covered by first-party features or MiNotes plugins.

## 6. API and permissions

### 6.1 Host API (v1)

| Area | Calls | Permission |
|---|---|---|
| Read notes | get page, get page tree, search, backlinks, properties | `notes:read` (optionally scoped to a Project) |
| Write notes | create/update/move/delete block, create page, set property | `notes:write` (scoped) — all writes go through core with undo events attributed to the plugin |
| Plugin storage | get/set/delete keyed values, ≤ 10 MB | always granted (own namespace only) |
| Network | `fetch` to declared origins only | `network:<origin>` per origin |
| Secrets | store/read an API key in the OS keychain | `secrets` |
| UI | show toast, open plugin panel, prompt (host-rendered) | always granted |
| Clipboard | write text | `clipboard:write` |
| Events | subscribe to block/page events | `events` |
| Files | read/write **only files the user picks** in a host file dialog | always granted per-dialog; no path access |

Not available in v1: raw SQL, other plugins' storage, other notebooks, the
filesystem by path, process spawning.

### 6.2 Permission UX

- Install shows a plain-language summary ("Read and change notes in *Work*; connect
  to api.readwise.io") — not a list of identifiers.
- Permissions can be narrowed at install (e.g. pick which Projects).
- Network origins and write access are re-confirmed when an update adds them.
- **Activity log** per plugin: notes changed (with undo), network calls (origin,
  time, size), errors. Visible in the plugin's settings.
- Encrypted notebooks (`PRD-encryption.md`): plugins are off by default there;
  enabling one requires re-confirming its permissions for that notebook, and
  `network:*` plugins show a warning.

### 6.3 Versioning

- WIT package `minotes:plugin@1.x`; the manifest declares the API version it needs.
  Minor versions add capabilities; a major bump keeps the previous major supported
  for at least 12 months.

## 7. Packaging, distribution, updates

- Package: a `.minotes-plugin` zip with `manifest.json`, `plugin.wasm`, optional
  `ui/` (static files for iframes), icon, README, LICENSE.
- Manifest: `id` (reverse-DNS), name, version, author, description, homepage,
  `api_version`, `permissions`, `contributes` (the extension points), min app version.
- Install from the **marketplace** (§7a), or sideload from a file/URL (developer
  and team use; shown with a "not from the marketplace" warning).
- Packages are **signed** (ed25519/minisign). Marketplace packages must be signed
  by the author key registered with the listing, and are additionally
  countersigned by the marketplace after review; the app verifies both.
- Updates: checked daily for directory plugins; changelog shown; permission
  increases require consent; one-click rollback to the previous version.
- Per-notebook enablement; the installed set and settings travel with git sync
  (packages are re-fetched by hash, not committed).
- Uninstall removes code and offers to remove the plugin's storage; content it
  wrote stays (it is ordinary notes).

## 7a. Marketplace

### Listing
- Name, icon, screenshots, description, author (verified badge for verified
  identities), version history with changelogs, source-code link (required: open
  source, OSI licence, for v1), install count, ratings and reviews.
- **Access label generated from the manifest** — "Reads notes in projects you
  choose · Connects to api.readwise.io · No file access" — and because the sandbox
  enforces exactly those permissions, the label is a guarantee, not a claim.
- Review status and scan results per version; "last updated"; supported app versions.

### Publishing
- Author account (sign in with GitHub) and an author signing key registered once.
  **No fee.** Spam and throwaway accounts are handled instead by: GitHub account
  age/activity thresholds for new authors, a rate limit on new listings per
  author, manual review of every first submission, and invite-only during the beta.
- Submit by pushing a tagged release; the pipeline builds or fetches the package,
  verifies the author signature, and runs the review (below).
- Reserved ids and name-squatting rules; transfer of ownership through support.

### Review pipeline (every version, not just the first)
1. **Automated**: manifest validation; permission diff against the previous
   version (any new permission or network origin → manual review + user re-consent
   on update); static scan of the Wasm and UI bundle (known-malware signatures,
   obfuscation, crypto-miners, undeclared origins in code); licence check.
2. **Behavioural**: run in the hostile-harness sandbox against a canary notebook —
   record every host call; flag reads/writes or network use beyond what the listing
   describes.
3. **Manual**: first submission, any permission increase, network/write plugins
   above an install threshold, and anything flagged by 1–2 or by user reports.
4. Pass → countersigned and published; fail → author gets the reasons.

### Trust and safety
- **Revocation**: the app checks a signed revocation list daily; a revoked version
  is disabled on every device with a notice and an option to roll back to the last
  good version. Critical revocations are pushed on next app start.
- Report-a-plugin button on every listing and in the plugin's settings.
- Published policy: what is not allowed (data collection beyond the stated purpose,
  ads injected into notes, cryptomining, obfuscated code), takedown and appeal.
- Staged rollout for popular plugins' updates (e.g. 5% → 100% over 48 h) so a bad
  release is caught before it reaches everyone.

### Infrastructure
- Static catalogue (JSON + package files) on a CDN, generated from a git repo of
  listings — the app needs no MiNotes account to browse or install. Ratings,
  reviews, install counts and reports are a small hosted service.
- Privacy: the app sends no personal data when browsing; install counts are
  anonymous (no notebook or user identifiers).

### API stability promise
- A plugin built against API v1 keeps working for at least 18 months after v2
  ships. Deprecations announced with a version and date; the marketplace warns
  authors whose plugins use deprecated calls.

## 8. Reliability and performance

- **Safe mode**: start with all plugins disabled (hold Shift at launch, or
  `--safe-mode`; offered automatically after a crash during startup).
- A plugin that times out, traps or exceeds limits 3 times in 10 minutes is
  disabled with a notice.
- Budgets: plugin load adds ≤ 50 ms to startup in total for 10 plugins (lazy-load
  on first use of a contribution); a code-fence renderer must return within 500 ms
  or the block shows its source.
- Everything the plugin does is measurable by the desktop-check skill (startup and
  view timings with and without plugins).

## 9. Developer experience

- `create-minotes-plugin` template (Rust and TypeScript flavours) with the WIT
  bindings, a sample command, a sample code-fence renderer, and a settings page.
- **Dev mode**: load a plugin from a folder, reload on change, console output in a
  plugin log panel.
- Typed SDKs generated from the WIT definition; API docs generated from it too.
- Test harness: run the plugin against an in-memory notebook (core's test DB), plus
  a desktop-check recipe for UI contributions.
- Example plugins shipped in-repo: Mermaid renderer, "Sort block children",
  Readwise importer, a theme.

## 10. Built-in features

Built-ins stay in core. The existing pieces are reconciled:

| Today | Decision |
|---|---|
| `plugins` / `plugin_storage` tables | Reused for installed plugins and their storage; `plugin_storage` re-keyed by plugin id (Phase 0). |
| Plugin Manager panel (toggles that control nothing) | Replaced by the new Plugins settings page in Phase 1; removed now if Phase 1 slips. |
| CSS snippets | Become the "theme" plugin type: same UI, packaged form added. Existing snippets migrate as local themes. |
| SRS cards | Stay core. Optional on/off toggle in Settings if wanted. |
| `obsidian-compat/` loader | Removed (§5.3). |

## 11. Phases

0. **Clean-up** (small): remove `obsidian-compat/`, re-key `plugin_storage`, hide
   the non-functional Plugin Manager.
1. **Foundation + first contributions**: wasmtime host, WIT v1 (notes read/write,
   storage, toast, commands, slash items, context-menu items, code-fence renderers,
   settings page in an iframe), permissions + install-from-file, activity log, safe
   mode, dev mode, two example plugins (Mermaid renderer, Sort children).
2. **Integrations**: network + secrets, event hooks, importers/exporters, sidebar
   panels, signed packages, updates and rollback.
3. **Marketplace beta**: listings, author accounts and signing, automated +
   behavioural review, revocation list, in-app browse/install/update, invited
   authors only; API v1 frozen with the stability promise.
4. **Marketplace public**: open submissions, ratings/reviews, staged rollouts,
   verified authors, policy and takedown process; then advanced extension points
   (page views, inline queries, AI providers, CLI subcommands) and Android.

## 12. Success metrics

- Phase 1: two example plugins built only against the public SDK; a malicious test
  plugin (tries to read unpermitted notes, fetch an undeclared origin, read files,
  spin the CPU, exhaust memory) is stopped in every case — this suite runs in CI.
- Startup and typing latency unchanged within noise with 10 plugins installed
  (scale tool in the desktop-check skill).
- Marketplace beta: ≥ 15 plugins from ≥ 8 outside authors before opening up;
  median review time for a clean update < 1 hour (automated path).
- Marketplace public: ≥ 100 plugins and ≥ 30% of active users with at least one
  plugin within 12 months; zero incidents of a marketplace plugin exceeding its
  listed access; time from report to revocation of a malicious version < 24 h.

## 13. Risks

| Risk | Mitigation |
|---|---|
| Component-model toolchains are still maturing for some languages | Rust and JS first-class at launch; others "best effort". |
| iframe UI feels foreign | Host-provided CSS variables and a small component kit for plugin UI. |
| A permitted plugin misuses its access (e.g. exfiltrates notes it may read to an allowed origin) | Scoped read (Projects), per-origin network, activity log, directory review, signing, kill switch via directory revocation list. |
| API too small to be useful | Ship with real plugins in Phase 1; grow from what they needed. |
| Wasm on Android | Desktop-first; validate before committing Phase 4. |
| Marketplace becomes a support and moderation load | Automated review handles the clean path; manual review is targeted (permission increases, popular, flagged); budget reviewer time before opening submissions. |
| Supply-chain attack via a compromised author account | Author signing key separate from the GitHub login; permission-increase re-consent; staged rollouts; daily revocation list. |
| Ecosystem doesn't take off | Invite authors for the beta; ship the SDK, templates and examples first; port the most-requested Obsidian plugin ideas as first-party examples. |

## 14. Open questions

1. ~~Paid plugins~~ — decided: free marketplace, no author fees, no pricing label;
   authors handle any upsell themselves, outside the marketplace. Revisit a
   Free / Freemium / Subscription label if users report surprise paywalls.
2. Should plugins be allowed to define new **block types** with their own stored
   data, or only render markdown fences? (Fences keep data portable; block types
   are more powerful.)
3. Require open source for every marketplace plugin permanently, or allow closed
   source later once behavioural review is proven?
4. Team/managed deployments: an allow-list of plugins set by an admin?
