# Opportunities (deferred work found during the encryption build)

Each entry: proposed severity · what · where · why deferred.

## Baseline (pre-existing, not caused by this run)
- P2 · Desktop journey D2 real typing drops trailing characters under Xvfb ("seed and
  typ", "third lin") — timing flake in xdotool typing on the baseline too.
  `tests/desktop-journey-test.sh` D2.
- P1 · Desktop journey "Evernote scan/import" fails on the baseline (5 assertions:
  scan/import empty, undo leaves 15 pages). `tests/desktop-journey-test.sh`
  (Evernote block). Needs its own investigation.

## Found during the build
- P2 · Desktop journey launches can time out under heavy CPU load (E1 gate run: "launch
  outside: app did not start" while an Android build ran; passed alone and in the next
  full run). `desktop.sh up` wait budget. Harness, not app.
- P2 · CLI `resume_conversion` runs on every open of a folder notebook: if the app is in
  the middle of encrypting the same notebook, the CLI could roll it forward/back
  concurrently. Take the notebook lock (or skip resume when the lock is held by another
  live process). `crates/minotes-cli/src/unlock.rs` `open_db`.
- P2 · Biometric unlock / Android Keystore store for "Keep unlocked" (PRD §4.3, Q4 →
  later). Needs a Tauri plugin; `keyring` has no Android backend.
- P2 · OS screen-lock detection for auto-lock (only idle time + clock-jump sleep detection
  are built). `components/LockGate.tsx`.
- P3 · Rust and TS strength estimators are two copies of one rule set
  (`crypto::passphrase_strength`, `lib/passphrase.ts`); a shared test vector file would
  keep them in step.
- P2 · The recovery key panel's disabled "Continue" button looks the same as the enabled
  one (global `.btn-primary:disabled` style). `components/notebooks.css` / styles.css.
- P2 · `session_info` reads the keychain secret (`keychain::is_remembered` → `recall`) on
  every `get_notebook_session` for an encrypted notebook. Cache "remembered" in the
  Session when it is set/unset; on macOS each read can mean a keychain access check.
  `src-tauri/src/notebooks.rs` `session_info`.
- P2 · Desktop D6 "Open report page" lands on today's journal under heavy load (1 of 3
  full runs; passes alone): the switch's `openJournal()` can finish after the click's
  navigation. Navigation-token check missing on that path. `App.tsx` onSwitch.
- P3 · The idle-refresh loop fixed in E14 (watcher counting read events) likely also
  affected plain notebooks with a non-empty WAL (1 Hz `db-changed`); worth a
  before/after look with `scale-tour.sh` timings.
- P3 · `export.rs` gained an `AttachmentCopy.data` field for encrypted exports — touches a
  file the concurrent F-2/F-7 work also edits; expect a small merge.
