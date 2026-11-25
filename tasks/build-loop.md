# Build loop: docs/PRD-encryption.md

Harness for building the whole-notebook encryption spec unattended. Commits are the
source of truth: a task is DONE when a commit titled `enc(<ID>): …` exists on this
branch. `tasks/todo.md` is a derived view.

## Resolved placeholders

| Slot | Value |
|---|---|
| SPEC | `docs/PRD-encryption.md` |
| TEST_CMD | `cargo test --workspace` + `cd crates/minotes-app && npx tsc --noEmit && npx vite build` (~2.5 min) |
| FULL regression gate | TEST_CMD + `tests/desktop-journey-test.sh` (display 281..289, WD port 6001..6039) + browser journeys (copy of `tests/user-journey-test.sh` on port 1611..1619) |
| RUN_CMD | the real desktop app via `.claude/skills/desktop-check/desktop.sh` (scratch HOME, private D-Bus) + the `minotes` CLI |
| SMOKE_SCENARIO | create an encrypted notebook, write a page, quit, relaunch → locked, wrong passphrase refused, unlock → page visible; `grep -c <marker>` over the notebook folder = 0; CLI with `MINOTES_PASSPHRASE` lists the page. Signal: journey assertions pass (exit 0 of the encryption journey block) |
| FULL_SUITE_BUDGET | one TEST_CMD run (~2.5 min); desktop+browser journeys once per tier (~25 min each, run in parallel) |
| RUN_BUDGET | unbounded (compound stop condition + poison-task ceiling) |
| REVIEW_MODEL | fable (Step 1 review done) |

Baseline (Step 0, HEAD 85c5af7): cargo 374/374 pass; tsc + vite ok; desktop journeys
223 pass / 7 fail (2 typing flakes in D2, 5 Evernote-import assertions); browser
journeys: see `tasks/opportunities.md` §Baseline.

## Task DAG

Groups follow the spec's §6 steps. `→` = depends on.

```
E1 SQLCipher switch (critical path) ─┬─► E2 crypto module ─► E3 encrypted open + key cache + errors
                                     │                         │
                                     │        ┌────────────────┼──────────────┬───────────────┐
                                     │        ▼                ▼              ▼               ▼
                                     │   E4 notebook-level   E7 keychain   E6 attachments   (E3→E12 CLI)
                                     │   (meta v2, create,     store         in DB
                                     │    unlock, passphrase,
                                     │    recovery, readable)
                                     │        │
                                     │        ├─► E5 conversion (encrypt/decrypt/rotate, resumable) ◄─ E6
                                     │        ├─► E15 zip export/import of encrypted notebooks
                                     │        ▼
                                     │   E8 app backend (Option<Database>, typed LOCKED, commands,
                                     │      startup locked, lock teardown, sync/mirror off) ◄─ E5, E6, E7
                                     │        │
                                     │        ├─► E9 api.ts + mock backend lock state
                                     │        │      └─► E10 frontend UI ─► E11 webview storage (ui_state)
                                     │        │                │
                                     │        │                └─► E13 browser journeys
                                     │        └─► E14 desktop journeys + leak scan ◄─ E10, E11, E12
                                     │                 └─► E16 scale overhead check
                                     └─► E17 encrypted mirror + git sync  (LAST; needs F-2/F-7 on main)
E18 docs (PRD status, CLAUDE.md) ◄─ everything else
```

| ID | Item (spec ref) | Depends | Files (scope) | Verification |
|---|---|---|---|---|
| E1 | rusqlite → `bundled-sqlcipher-vendored-openssl` (§6.1) | — | `Cargo.toml`, `Cargo.lock`, CLAUDE.md Android note | **Critical-path gate** (below) |
| E2 | `crypto` module: DEK, Argon2id, HKDF, AES-GCM slots, recovery key (§4.2) | E1 | `core/src/crypto.rs`, core Cargo.toml | fail-first unit tests: round-trips, wrong pass/recovery rejected, tampered slot, params from slot, checksum typo |
| E3 | `Database::open_encrypted`/`create_encrypted`, key before init, no-create, typed errors, unlocked-key cache, `run_query` refuses key pragmas (§4.1) | E2 | `core/src/db.rs`, `error.rs`, `core/src/keys.rs` | tests: no plaintext marker in db/WAL, wrong DEK → mismatch error, plaintext DBs unchanged |
| E4 | notebook-level: meta v2 `encryption` block (no name), create/unlock/change passphrase/recover/regenerate, `open_db` → Locked, `readable()` consults cache, mirror off, legacy refused, `open_folder` NOTADB guard (§4.2, §4.4, §4.5) | E3 | `core/src/notebook.rs`, `core/src/encryption.rs`, `cross_notebook.rs` | tests: change passphrase leaves db bytes identical; copied folder opens; older format refusal |
| E6 | attachments inside the DB for encrypted notebooks (§4.5 row) | E3 | `core/src/repo/attachments.rs`, `db.rs` migration | tests: store/get/gc with no file on disk |
| E7 | keychain store (DEK by notebook id), availability probe, trait + memory impl (§4.3) | E3 | `core/src/keychain.rs`, core Cargo.toml (keyring, non-Android) | tests on memory store; real keychain never touched |
| E5 | encrypt / decrypt / rotate with resume marker, verify, deletion plan (§4.6) | E4, E6 | `core/src/encryption.rs` (convert part) | tests: every table preserved; simulated crash at each step leaves old or new intact |
| E15 | zip export/import of an encrypted notebook (§4.5 row) | E4 | `core/src/notebook_zip.rs`, `src-tauri/notebook_transfer.rs` | tests: export → import with passphrase round-trip; wrong passphrase refused |
| E8 | app backend: `Mutex<Option<Database>>`, `NOTEBOOK_LOCKED`, session fields, commands (§6.3), attempt delay, lock teardown (AI cancel, temp files), git sync refuses, AI/plugins off | E5, E6, E7 | `src-tauri/src/*.rs` | cargo check + app unit tests; desktop smoke in E14 |
| E12 | CLI: keychain → env → TTY prompt; `notebook create --encrypt`; `notebook encrypt/decrypt/passphrase` (§4.4, §6.6) | E5, E7 | `minotes-cli/src/**` | CLI integration tests (`tests/cli.rs`) |
| E9 | api.ts wrappers + mock backend lock state, wrong passphrase (§6.7) | E8 | `lib/api.ts`, `lib/mockBackend.ts`, `lib/encryption.ts` | tsc; browser journeys in E13 |
| E10 | UI: unlock screen, create-encrypted + strength meter + recovery screen, lock icon / Lock now / Ctrl+Shift+L, Settings → Security, auto-lock + sleep drift, export confirmation, sync toggle disabled (§5) | E9 | components (new `Encryption*.tsx`), `App.tsx`, `NotebookSwitcher.tsx`, `NotebookDialogs.tsx`, `SettingsPanel.tsx`, `SyncPanel.tsx` | tsc + vite; journeys |
| E11 | webview storage: recent pages + kanban state in `ui_state` for encrypted notebooks; parked keys + legacy whiteboard copies deleted on encrypt (§4.5) | E10 | `lib/recentFiles.ts`, `lib/notebooks.ts`, `lib/whiteboardUtils.ts`, kanban, core `ui_state` | leak scan in E14 |
| E13 | browser journeys for the flows (mock) (§7) | E10 | `tests/user-journey-test.sh` | the journey itself, fail-first against pre-E10 build |
| E14 | desktop journeys: create/lock/wrong/unlock/restart/recovery/auto-lock/encrypt-existing + CLI + leak scan of the scratch HOME (§7) | E10, E11, E12 | `tests/desktop-journey-test.sh` | the journeys |
| E16 | overhead at scale (§7, ~15% budget) | E14 | none (measurement → spec §10) | numbers recorded |
| E17 | encrypted mirror + git sync (§4.5, §6.5) | E8 + F-2/F-7 on main | `mirror.rs`, `sync_manager.rs`, `export.rs` | **blocked-on-dependency** unless main has F-2/F-7 |
| E18 | docs: PRD §10 status, CLAUDE.md, PRD-git-sync §3.6/§4 row, PRD-import §5 note | all | docs | review |

needs-human (excluded, no subtree pruned): §8 "leak test in CI on every release"
(no CI, ARCH X-1); §9 Q5 (hide registry names) — v1 builds §4.4 as written.

## Critical-path gate (E1)

E1 changes the SQLite library under every crate. Required before anything else:
1. `cargo test --workspace` = baseline (374/374) with the SQLCipher build.
2. Desktop journeys and browser journeys: no new failures vs baseline.
3. Interop proof both directions: a DB written by the new build is read by stock
   `sqlite3` (integrity ok, FTS match works, `SQLite format 3` header) and a row
   written by stock `sqlite3` is read by the new CLI.
4. `npx tauri android build --debug --apk --target x86_64` produces an APK.
5. Windows: `cargo build -p minotes-cli --target x86_64-pc-windows-gnu` (MinGW present).
6. Binary-size delta recorded in the commit message.
If E1 is BLOCKED the run stops.

## Loops

- **Inner loop (one task):** read the scope files → write the failing test first for
  behaviour changes (refactors: the suite is the gate) → implement → run the
  task's tests + `cargo test -p <crate>` (+ tsc/vite if frontend) → self-review
  checklist: diff confined to scope; no TODO/dead code; no secret values in files;
  reused existing deps/modules (base64, sha2, hkdf, keyring, zip, tauri dialog);
  no speculative abstraction; matches the file's patterns; diff size proportionate;
  no non-component exports from .tsx; regenerated screenshots/gen schemas reverted
  → commit `enc(<ID>): <summary>`.
- **Outer loop:** next ready node by the DAG (topological, tier order A→F), skip
  needs-human, run inner loop, mark done in todo.md, re-check readiness.
- **Parallel dispatch:** only for provably disjoint scopes. Candidates: E6 ∥ E7
  (attachments.rs vs keychain.rs, both touch core Cargo.toml? E6 does not → disjoint);
  E12 ∥ E9 (CLI vs frontend). Default sequential; the main context keeps ownership
  of shared files (Cargo.toml, db.rs, lib.rs).
- **Meta loop:** after a failure/correction append mistake → rule to
  `tasks/lessons.md`; update this DAG if reality diverges.
- **Full-suite regression loop:** TEST_CMD after every task that touches Rust;
  desktop + browser journeys after tiers B (core done), C (backend), D (frontend),
  compared with the baseline lists.
- **Smoke loop:** after tier D, SMOKE_SCENARIO on the real app (bounded by the
  journey's timeouts; a hang is a failure).
- **Re-plan loop:** if a task's diff grows past ~2× its expected size, stop, split
  the node in this file, continue with the first part.

Poison-task ceiling: attempts 1–2 diagnose/re-plan/retry; attempt 3 failure → park
blocked, block dependents transitively, continue. Blocked critical-path → stop.

## Stop condition

DONE = every non-needs-human node DONE or blocked-and-logged; full suite no new
failures vs baseline; every spec item addressed or needs-human; SMOKE_SCENARIO passes
on the real app.

## Self-check

Topological order: E1, E2, E3, E4, E6, E7, E5, E15, E8, E12, E9, E10, E11, E13, E14,
E16, E17, E18 — acyclic; every §4–§7 item maps to exactly one node (§4.1→E1/E3,
§4.2→E2/E4, §4.3→E7, §4.4→E4/E8/E10, §4.5 rows→E4 (mirror off), E6, E8 (sync off,
AI/plugins), E10 (export confirm), E11, E15, E17; §4.6→E5; §5→E10; §6.1–7→E1,E2/E3,
E8,E10,E17,E12,E9; §7→tests in each + E13/E14/E16).
