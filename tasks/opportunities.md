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

## Found while building E17 (encrypted sync)
- ~~P2 · Changing the passphrase does not update the sync repo's key file~~ **Done
  2026-10-19** (a43a01b): new slots are published at the next sync; rotation
  re-encrypts the repo and old-key devices fail closed (`KEY_CHANGED`).

## Found while fixing the D14 race / key-file gap (2026-10-19)
- P2 · needs-human · A device on a rotated-away key must re-join (new folder); re-key
  in place (unlock the remote's new slots with the passphrase, rotate the local DB
  to that key, keep unsynced edits) is a product decision. `sync_encrypted.rs`.
- P2 · Devices other than the one that changed the passphrase keep their old local
  slots (by design — a remote can't push slots a device can't verify). A "your
  passphrase was changed on another device — use the new one here too?" prompt
  (unlock with the new passphrase against the remote's slots, then adopt them)
  would make one passphrase everywhere. needs-human (UX).
- P3 · Same-day journal pairs that already exist as "Journal/<day> (2)" from before
  the fold are not merged retroactively (only new incoming journals fold). A one-off
  repair on sync would tidy them. `repo/sync.rs` `fold_journals`.
- P3 · PageView's empty-page auto-block calls `api.createPage(page.title)` for any
  journal it shows with no blocks; if that title is free (e.g. the page was renamed
  by sync) it creates a stray non-journal page. Use `getJournal(date)` instead.
  `components/PageView.tsx` ~l.317.
- P3 · Non-journal pages created with the same title on two devices still become
  "<title> (2)" and the devices can disagree on which is which (rename fails
  silently when the title is taken) → title ping-pong. Encrypted import now takes
  known pages first (as plain does), which avoids the common order; a deterministic
  tie-break (smaller id keeps the title) would remove it. `repo/sync.rs` `sync_page`.
- P3 · D14 "C imported nothing" once returned '' (1 of 6 local runs, old binary): the
  `ev` right after creating a notebook on a fresh profile can race the app. Harness.
- P3 · Encrypted sync never prunes whiteboard / attachment files, and keeps the file of a
  page that was permanently deleted here (only trashed pages are pruned): the repo only
  grows, and such a page stays on other devices. Needs an exported-ids manifest like
  the plain mirror's.
- P3 · Commit messages carry the hostname (`sync: <host> @ <time>`) — for encrypted
  notebooks that is the one readable detail besides sizes and timing.
- P3 · Browser mock: "Join encrypted notebook…" is desktop-only (git), so the browser
  suite can't cover it; D14 does.
