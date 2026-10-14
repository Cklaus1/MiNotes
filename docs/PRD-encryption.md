# PRD: Notebook Encryption

Status: built, including encrypted git sync (step 5) — see §10 · Owner: Chris Klaus · Rewritten 2026-10-10

> **Supersedes the per-folder design.** The earlier version of this PRD encrypted
> individual fields (block content, page titles, property values) per Project
> folder with AES-256-GCM. It was never implemented. It is replaced because it
> left structure readable (folder names, counts, timestamps, link shape, property
> keys), left plaintext copies in the search index, the undo/event log, whiteboards
> and the git-sync files — each needing its own handling — and required every
> content query to know about locked/unlocked state. The original is in git history
> (`docs/PRD-encryption.md` before this rewrite). Kept from it: the passphrase and
> unlock dialogs, the Argon2id parameters, and the in-memory key rules.

## 1. Overview

Encrypt a whole notebook at rest. A notebook is either **encrypted** or not; an
encrypted notebook is **locked** (unreadable) or **unlocked** (fully usable).
Sensitive notes go in their own encrypted notebook (see `PRD-notebooks.md` —
notebooks are cheap to create and switch).

**One-liner:** the notebook's database file is encrypted with SQLCipher; the key
is random, wrapped by the user's passphrase and by a recovery key, and may be
remembered per device in the OS keychain.

## 2. Threat model

Protects against
- A lost or stolen device, or a disk pulled from one.
- A copied notebook folder, a leaked backup, a cloud-sync provider or git host
  reading the files.
- Another OS user on the same machine reading the files.

Does not protect against
- Malware or another person acting inside the user's unlocked session while the
  notebook is unlocked (auto-lock narrows this; nothing closes it).
- A weak passphrase (Argon2id slows guessing; it cannot fix "1234").
- The user losing both the passphrase and the recovery key. There is no backdoor.

## 3. Goals / non-goals

Goals
1. Nothing about an encrypted notebook's content or structure is readable without
   the key: text, titles, folder names, counts, search index, undo log, whiteboards.
2. Unlocked, the notebook behaves exactly like an unencrypted one — search,
   backlinks, kanban, undo all work with no special cases.
3. Changing the passphrase is instant and does not rewrite the notebook.
4. A forgotten passphrase is recoverable with a recovery key.
5. Sync still works for encrypted notebooks without exposing plaintext.

Non-goals
- Per-folder or per-page locking inside a notebook.
- Sharing an encrypted notebook with other people (multi-recipient keys).
- Hiding that a notebook exists or how large it is.
- Protecting memory against a local attacker with debugger access.

## 4. Design

### 4.1 Database encryption

- SQLCipher 4 via `rusqlite`'s `bundled-sqlcipher-vendored-openssl` feature
  (vendored so Windows and Android builds need no system OpenSSL).
- AES-256, page-level, with SQLCipher's per-page HMAC (tamper detection).
- The database is keyed with a **raw 256-bit key** (`PRAGMA key = "x'…'"`), so
  SQLCipher's own passphrase KDF is skipped — key derivation is ours (4.2).
- WAL and temp files: SQLCipher encrypts the WAL and journal pages; set
  `PRAGMA temp_store = MEMORY` so temp tables never touch disk in plaintext.
  [REVISED: wording, reason: WAL frame headers (page numbers, salts) and the
  `-shm` index are not encrypted — they reveal write timing/size only, no
  content. `temp_store = MEMORY` is already set for every notebook (`db.rs`
  `init`). Verified 2026-10-13: a marker string is absent from the db and WAL.]
- The key is passed with `sqlite3_key_v2` (the `x'…'` raw-key form, from a
  zeroizing buffer) before the first statement on the connection — not as a
  formatted `PRAGMA key` SQL string, which would sit in the statement text.
  An encrypted database is opened without `SQLITE_OPEN_CREATE` (a wrong path must
  not become an empty new file). [REVISED: added, reason: adversarial review —
  key before `init()`'s first read; no SQL-text copy of the key.]
- `Database::open` gains an optional key. A wrong key surfaces as a clear
  "wrong passphrase" error, never as a panic or as "database is corrupt".
  [REVISED: mechanism, reason: SQLCipher reports a wrong key as `SQLITE_NOTADB`,
  the same error as a foreign or damaged file. The passphrase is checked by the
  AES-GCM tag of the slot unwrap (§4.2) before SQLite is touched; a `NOTADB`
  after a successful unwrap is reported as "the database does not match its
  key (damaged or replaced)", not as a wrong passphrase.]
- `rusqlite` features are workspace-wide, so the CLI and the app both link
  SQLCipher; a plaintext notebook opened without a key behaves exactly as with
  stock SQLite (same file format; verified both directions with `sqlite3`).

### 4.2 Keys (envelope encryption)

```
passphrase ──Argon2id──► KEK_p ─┐
                                ├─ wraps ─► DEK (random 256-bit) ─► SQLCipher
recovery key (random) ─HKDF──► KEK_r ─┘
```

- **DEK** (data key): 32 random bytes from the OS CSPRNG, generated once per
  notebook. Never shown, never derived from the passphrase.
- **KEK_p**: Argon2id(passphrase, 16-byte random salt, m = 64 MiB, t = 3, p = 4)
  → 32 bytes. Parameters are stored with the wrapped key so they can be raised
  later.
- **Recovery key**: 32 random bytes, shown once as 8 groups of base32 with a
  checksum; **KEK_r** = HKDF-SHA256 over it.
  [Resolved detail, engineering: 32 key bytes + the first 3 bytes of their
  SHA-256 = 35 bytes = 56 base32 characters (RFC 4648 alphabet, no padding) =
  8 groups of 7, e.g. `ABCDEFG-HIJKLMN-…`. Parsing ignores case, spaces and
  dashes; a checksum mismatch is "this is not a valid recovery key" (typo), not
  "wrong key". HKDF: no salt, info `minotes recovery kek v1`. Each slot's
  AES-GCM AAD is `minotes-dek-v1:<slot type>` (no notebook id: a copied folder
  gets a new id and must still open).]
- Each KEK wraps the DEK with AES-256-GCM (fresh 12-byte nonce). The two wrapped
  copies live in `notebook.json` (outside the encrypted database, by necessity):

```json
"encryption": {
  "version": 1, "cipher": "sqlcipher4",
  "slots": [
    {"type": "passphrase", "kdf": "argon2id", "m": 65536, "t": 3, "p": 4,
     "salt": "…", "nonce": "…", "wrapped": "…"},
    {"type": "recovery", "kdf": "hkdf-sha256", "nonce": "…", "wrapped": "…"}
  ]
}
```

- **Change passphrase** = unwrap the DEK with the old one, re-wrap with the new
  one, rewrite one slot atomically. The database is untouched.
- **Rotate the DEK** (after suspected compromise) = `PRAGMA rekey`, which rewrites
  the database; offered under "Advanced", not part of changing the passphrase.
  [REVISED: mechanism, reason: `rekey` rewrites in place and is not resumable;
  rotation reuses the §4.6 export-to-a-new-file + verify + swap path. A new DEK
  needs a new recovery slot, and the old recovery key cannot wrap it, so
  rotating also issues a new recovery key (shown once) and forgets remembered
  devices.]
- `notebook.json` otherwise holds only the notebook's id and format version for an
  encrypted notebook — **not its name** (the registry in `~/.minotes` keeps a local
  display name).
  [REVISED: added, reason: review — encrypted notebooks write `format_version: 2`
  so an older MiNotes refuses them cleanly ("made by a newer MiNotes") instead of
  failing on the ciphertext; unencrypted notebooks keep writing 1. Opening a
  copied encrypted folder that is not in the registry uses the folder name as
  the display name. The folder name itself (`~/MiNotes/<name>`, user-chosen) is
  visible on disk; documented, see Q5.]

### 4.3 Remembering the key on a device

Off by default. "Keep unlocked on this device" stores the **DEK** in the OS
keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service,
Android Keystore), keyed by notebook id, via the `keyring` crate.
[REVISED: Android removed from v1, reason: `keyring` is not compiled for Android
(only an in-memory mock exists there, PRD-notebooks §11); "Keep unlocked" is
disabled on Android (`get_platform_capabilities`) until a Keystore plugin
exists. Linux availability reuses the AI key's secret-service probe.]

- If the keychain is unavailable (headless Linux, WSL without a secret service),
  the option is disabled with an explanation — never fall back to a file.
- "Forget on this device" deletes the entry. Changing the passphrase does not
  invalidate remembered devices (they hold the DEK); rotating the DEK does.
- Not offered: key files, and "no passphrase" encryption. Biometric unlock can be
  layered on the keychain entry later where the platform supports it.

### 4.4 Lock state

```
            unlock (passphrase | recovery key | keychain)
  LOCKED ───────────────────────────────────────────────► UNLOCKED
     ▲                                                        │
     └──────── lock now · auto-lock timer · sleep · quit ◄────┘
```

- Locking closes the database connection, zeroizes the DEK and KEKs in memory
  (`zeroize` crate), clears undo history, closes open views of that notebook and
  drops any cached page data from the frontend.
  [REVISED: added, reason: review — locking also cancels running AI requests and
  drops the in-memory AI conversations; the frontend unmounts every view (a lock
  gate around the app shows only the unlock screen) and clears the per-notebook
  caches, so no page data survives in the window. (A webview reload was the first
  plan; it would also reset browser-mode tests' mock backend.) Limit, stated honestly: SQLCipher
  keeps its own key copy until the connection closes (it zeroes it then), and the
  OS may have paged memory out (§2 non-goal).]
- Only the open notebook can be unlocked: switching to another notebook locks an
  encrypted one (unless "Keep unlocked on this device" is on, in which case it
  reopens from the keychain). [Resolved, engineering: matches the one-session
  model (`AppState` holds the open notebook only).]
- Auto-lock: after N minutes without input (default 15, configurable, "never"
  allowed) and on system sleep/lock where the platform reports it.
  [REVISED: mechanism, reason: Tauri reports no sleep event. Sleep is detected
  by wall-clock drift of a 15 s timer (a gap > 60 s means the machine slept),
  which works on every platform; OS screen-lock detection is deferred.]
- A locked notebook shows only: its local display name, a lock icon, and the
  unlock dialog. No titles, counts or recent pages.
- The CLI reads the passphrase from a prompt, `MINOTES_PASSPHRASE`, or the
  keychain; it never accepts it as a command-line argument (visible in `ps`).
  [Added: order is keychain (if remembered) → `MINOTES_PASSPHRASE` → TTY prompt
  without echo; no TTY and no env → a clear "notebook is encrypted" error. The CLI
  cannot borrow the app's unlocked key. `run_query`'s PRAGMA allowlist already
  refuses `key`/`rekey`/`cipher_*` and `ATTACH`; a test pins it.]

### 4.5 Plaintext outside the database

Everything that would leak must be handled explicitly:

| Copy | Encrypted notebook behaviour |
|---|---|
| Markdown mirror (`notes/`) | **Off by default.** Option: an *encrypted mirror* — each file encrypted with a key derived from the DEK (age-style, one file per page, filenames are opaque ids). Readable only by MiNotes; exists so git sync has files to move. |
| Git sync | Syncs the encrypted mirror. Merges become "newer file wins per page" (ciphertext cannot be three-way merged); conflicting edits keep both as today's conflict-copy pages after decryption. The remote sees file count, sizes and timing only. [REVISED 2026-10-14 (built): **per-block merge is kept**, not "newer file wins" — a git conflict on a page file keeps the local file and records the other side's blob ids; once the database is open both versions are decrypted and merged per block against the common ancestor with the plain sync's F-2 merge, so edits to different blocks both survive and only a block changed on both sides becomes a conflict-copy page (today's rule). Format: `p/` `f/` `w/` `a/` one `.mne` file per page / folder / whiteboard / attachment, `MNE1:` + base64(nonce ‖ AES-256-GCM), key HKDF(DEK, "minotes sync file v1"), the path as associated data; names are HKDF(DEK, "minotes sync names v1")-keyed hashes of ids; a page decrypts to the plain mirror's markdown, so F-7 block properties sync unchanged. `.minotes-encryption.json` carries the key slots and a key check: another device joins with the passphrase ("Join encrypted notebook…"); a remote whose key check differs, or a plain remote, is refused before anything is rebased, imported or pushed. ⚠ close call: publishing the slots lets the git host try passphrases offline — the same exposure as a copied notebook folder (§2), Argon2id being the defence; see §9 Q6.] |
| Export / publish site | Allowed while unlocked, with a one-time "this writes unencrypted files" confirmation. |
| Whiteboard legacy localStorage copies | Deleted when a notebook is encrypted. |
| Webview storage (settings, collapsed state, recent pages) | Recent-page titles and anything content-derived move into the database; only non-sensitive UI preferences stay in webview storage. |
| OS swap / crash dumps | Out of scope; documented. |
| Link previews fetched for a page | Fetched while unlocked only; cached inside the database. [REVISED: no change needed, reason: `fetch_og_metadata` results are not cached on disk at all today, so nothing leaks.] |
| **Attachments** (`attachments/` store) [REVISED: added, P0, reason: review — the store holds plaintext files next to the DB] | Stored **inside the encrypted database** (an `attachment_blobs` table) instead of files, so SQLCipher covers them. Opening one in an external app writes a temporary copy in the OS temp dir, deleted on lock and quit (documented). Encrypting an existing notebook moves its files into the database. Supersedes PRD-import §5 "encrypted with a key derived from the notebook key". |
| **Notebook zip** (Export / Import notebook…) [REVISED: added, P1, reason: review — `VACUUM INTO` inherits the key, so today's export would ship ciphertext without slots and import would refuse it] | Export stays encrypted: the snapshot keeps the DEK and the zip carries `notebook.json` with the slots. Import detects `encryption`, asks for the passphrase (or recovery key), and keys the connection before the integrity check, scrub and migrations. |
| **Mirror state, sync config, parked webview keys** [REVISED: added, reason: review — `mirror-state.json` holds page paths (titles), `minotes-recent-pages@notebook:<key>` holds titles] | Deleted on encrypt. Recent pages of an encrypted notebook live in its database (`ui_state`), never in webview storage. Ids-only keys (`minotes-collapsed-<pageId>`, `minotes-expanded-projects`) reveal structure ids only and stay; so do `kanban-columns-<pageId>` / `kanban-colors-<pageId>` (column block ids and colours, no text — corrected during the build). |
| **AI and plugins** [REVISED: added, reason: PRD-ai-assistant §2.4, PRD-plugin-architecture §6.2] | AI is off for a new encrypted notebook (it is off by default everywhere) and its settings show an "encrypted notebook" warning recommending a local model; CSS snippets/plugins are disabled when a notebook is encrypted. |

### 4.6 Converting

- **Encrypt an existing notebook**: create an encrypted copy with
  `sqlcipher_export`, verify (integrity check + row counts per table), swap it in,
  then securely remove the plaintext database, its WAL/SHM, the plaintext mirror
  (including `.git` history — warn that old commits on any remote still contain
  plaintext), `.minotes-trash/`, and legacy whiteboard storage. Show exactly what
  will be deleted before starting.
  [REVISED: "securely remove" → "delete", reason: overwrite-in-place is not
  achievable on SSDs, copy-on-write file systems or OS snapshots; the UI says the
  files are deleted and warns that backups (Time Machine, File History, cloud
  sync) may still hold plaintext. Also deleted: `.minotes/mirror-state.json`,
  sync config, the attachment files (moved into the DB first). `sqlcipher_export`
  does not copy `user_version` (verified) — it is set explicitly. The slots are
  written to the resume marker *before* the swap, so a crash can never leave an
  encrypted database without its slots.]
- [REVISED: added, reason: review — legacy-location notebooks
  (`~/.minotes/<name>.db`) are not encrypted in place: the dialog offers "Move to a
  folder…" first. The `~/.minotes/<name>.encryption.json` file in §6 is dropped.
  ⚠ close call: keeps one slot location and one deletion list; the cost is one
  extra step for legacy users.]
- `open_folder` refuses a folder whose database is not readable as plain SQLite
  and has no `encryption` block (lost slots are not "a new notebook").
- **Remove encryption**: the reverse, behind the passphrase and a confirmation.
- Both are resumable: a marker file records the step, and a crash mid-way leaves
  either the old or the new notebook intact, never neither.

## 5. UX

- **Create**: "New notebook…" has an "Encrypt this notebook" option → passphrase
  twice with a strength meter (zxcvbn-style, minimum "fair") → recovery key screen:
  shown once, with Copy / Save to file / Print, and a required "I have saved my
  recovery key" checkbox.
- **Unlock dialog**: passphrase field, "Keep unlocked on this device", "Use
  recovery key instead". Wrong passphrase: inline message, exponential delay after
  5 attempts in a session (the KDF is the real defence; the delay is courtesy).
- **Sidebar**: lock icon beside the notebook name; "Lock now" in the notebook menu
  and a shortcut (Ctrl+Shift+L).
- **Settings → Security**: change passphrase, view/regenerate recovery key
  (requires passphrase; regenerating invalidates the old one), remembered-on-this-
  device toggle, auto-lock time, encrypt/decrypt notebook, rotate key.
- Using the recovery key forces setting a new passphrase and offers a new
  recovery key.

## 6. Implementation outline

1. `rusqlite` → `bundled-sqlcipher-vendored-openssl`; confirm Linux, Windows and
   Android builds and binary-size impact. [REVISED: Windows is checked by a
   cross `cargo check` only if a MinGW toolchain is present; otherwise logged as
   unverified — no Windows host here.] All unencrypted notebooks keep working
   (SQLCipher opens plain SQLite files when no key is given).
2. `minotes-core`: `crypto` module (DEK generation, Argon2id, HKDF, AES-GCM wrap,
   recovery-key encoding); `Database::open_encrypted`; key slots in `notebook.json`.
3. Tauri: `create_encrypted_notebook`, `unlock_notebook`, `lock_notebook`,
   `change_passphrase`, `recover_with_key`, `set_remember_device`,
   `encrypt_notebook`, `decrypt_notebook`. `AppState` holds
   `Option<Database>` per notebook; every command returns a typed "locked" error
   the frontend turns into the unlock dialog.
4. Frontend: dialogs, lock state in the notebook switcher, auto-lock timer,
   clearing caches on lock.
5. Encrypted mirror + sync adaptation [built 2026-10-14: `core/src/sync_encrypted.rs`] (can ship after 1–4: until then, encrypted
   notebooks simply have mirror and sync off).
6. CLI: prompt / env / keychain.
7. Mock backend: lock state and wrong-passphrase behaviour (no real crypto) so
   browser journeys can cover the flows.

Depends on `PRD-notebooks.md` Phase 1 (switcher) and Phase 3 (`notebook.json`).
Encryption of a notebook in the legacy `~/.minotes/<name>.db` location stores its
slots in `~/.minotes/<name>.encryption.json`. [REVISED: dropped, see §4.6 —
encryption requires a folder notebook.]

Added steps [REVISED: added, reason: review — leak-proofing must land before the
UI ships]: 2b attachments in the database (§4.5); 2c notebook zip export/import of
encrypted notebooks; 4b webview storage (`ui_state`) and legacy whiteboard copies.

## 7. Testing

- Core: wrap/unwrap round-trips; wrong passphrase and wrong recovery key rejected;
  change passphrase leaves database bytes unchanged; tampered slot or database page
  detected; Argon2 parameters read from the slot; convert/deconvert preserve every
  table and survive a simulated crash at each step.
- **Leak test** (the important one): create an encrypted notebook with distinctive
  marker strings in titles, blocks, folder names, properties, whiteboards and
  search queries; then scan every file the app wrote (notebook folder, registry,
  webview storage, temp dir, logs) for the markers. None may appear.
  [Added: two levels — a core test (every file under a temp dir after creating,
  writing, searching, attaching and converting) and a desktop journey that scans
  the whole scratch HOME of the real app, including WebKit's storage.]
- Desktop journeys (`tests/desktop-journey-test.sh`): create encrypted, lock,
  wrong passphrase, unlock, restart → locked, remembered device → unlocked,
  recovery-key flow, auto-lock, encrypt an existing notebook, two-device sync of an
  encrypted notebook.
- Scale run on an encrypted notebook to confirm overhead stays within ~15%.

## 8. Risks

| Risk | Mitigation |
|---|---|
| User loses passphrase and recovery key | Recovery key is mandatory at setup and re-printable while unlocked; plain-language warning; nothing else is possible by design. |
| A plaintext copy is missed | The leak test in §7 runs in CI against every release. **[needs-human: there is no CI yet (ARCH X-1); choosing a provider/budget is open (ARCH §7 Q4). Until then the leak test runs in `cargo test` and the desktop journeys.]** |
| Keychain entry leaks the DEK to other software in the session | Opt-in, explained; auto-lock; "Forget on this device". |
| Conversion interrupted | Resumable with verification before any deletion. |
| Build complexity (vendored OpenSSL on Windows/Android) | Spike first (step 1) before committing to the rest. |
| Encrypted sync loses fine-grained merging | Conflict copies preserve both versions; documented trade-off. |

## 9. Open questions

1. ~~Should the mirror be off or encrypted-by-default for encrypted notebooks?~~
   **Resolved (engineering): off.** Options: off; encrypted-by-default; plaintext.
   Off ships with steps 1–4, has nothing to leak and needs no file format;
   encrypted is only useful for sync (step 5), so it becomes the default *when
   sync is turned on* for an encrypted notebook. Git-sync PRD §3.6 already assumes this.
2. ~~Default auto-lock time~~ **Resolved (engineering, reversible setting): 15
   minutes**, "never" allowed — as §4.4 already states. Options: 15 min / never /
   5 min. 15 min matches the threat model (an unattended unlocked laptop) without
   locking during normal pauses; it is a setting, so the default is cheap to change.
3. ~~Minimum strength enforced or advisory?~~ **Resolved (engineering, per §5
   "minimum fair"): enforced** at "fair" by a built-in estimator (length,
   character classes, repeats/sequences, a short common-password list — no 800 KB
   zxcvbn dependency). Options: enforced / advisory / enforced with override.
   Enforced is what §5 says; the recovery key is mandatory anyway, so the minimum
   only blocks trivially guessable choices. Relaxing it later is safe.
   ⚠ close call: the reviewer rated this product-level; kept as canon because §5
   already decides it.
4. ~~Biometric unlock in v1?~~ **Resolved (engineering): later.** Options: v1 /
   later. Android has no keychain backend yet (§4.3); macOS Touch ID needs
   keychain access-control flags `keyring` does not expose. Nothing in v1
   precludes it (it layers on the keychain entry).
5. Should the registry hide encrypted notebooks' display names until unlocked?
   **needs-human** (product: changes what a locked notebook shows, §4.4).
   Options: (a) no — show the local display name (as §4.4 specifies); (b) hide
   until unlocked ("Encrypted notebook 1"); (c) a per-notebook choice.
   Recommendation: (a). The name is only in this device's registry, and the
   folder name on disk usually reveals it anyway; hiding it costs usability (which
   locked notebook is which?) for little protection. v1 builds §4.4 as written;
   nothing beyond it is adopted.

6. Publishing the key slots in the sync repo (needed to join with the passphrase)
   lets whoever can read the remote try passphrases offline. **needs-human
   (confirm):** options (a) publish — built; the exposure equals a copied
   notebook folder, Argon2id (64 MiB, t=3) is the defence and the strength
   minimum applies; (b) don't publish — joining then needs `notebook.json` copied
   by hand or a recovery-key-only slot; (c) a per-notebook choice. Recommendation:
   (a), documented in the sync settings.

## 10. Build status (build-loop 2026-10-13)

Harness: `tasks/build-loop.md` (DAG), `tasks/todo.md`, `tasks/lessons.md`,
`tasks/opportunities.md`.

| Step | Status | Where |
|---|---|---|
| 1 SQLCipher (`bundled-sqlcipher-vendored-openssl`) | Built. Plaintext notebooks unchanged (interop with stock `sqlite3` both ways). Linux, Windows-gnu CLI cross-build and the Android x86_64 APK build (needs `RANLIB_<target>` = NDK `llvm-ranlib`, see CLAUDE.md). | workspace `Cargo.toml` |
| 2 Keys, slots, recovery key, strength rule | Built | `core/src/crypto.rs` |
| 2 Encrypted open/create, unlocked-key cache, notebook-level ops | Built | `core/src/db.rs`, `core/src/encryption.rs`, `core/src/notebook.rs` |
| 2b Attachments inside the database | Built | `core/src/repo/attachments.rs` |
| 2c Notebook zip stays encrypted | Built | `core/src/notebook_zip.rs` |
| Keychain ("keep unlocked") | Built (desktop; Android: unavailable) | `core/src/keychain.rs` |
| Encrypt / decrypt / rotate, resumable | Built | `core/src/encryption.rs` |
| 3 App commands, locked state | Built | `src-tauri/src/encryption_commands.rs`, `lib.rs` (`db_guard`) |
| 4 UI: unlock screen, create, Security settings, lock / auto-lock | Built | `components/LockGate.tsx`, `EncryptionDialogs.tsx`, `SecuritySettings.tsx` |
| 4b Webview storage (`ui_state`) | Built | `lib/webviewState.ts`, `core/src/repo/ui_state.rs` |
| 5 Encrypted mirror + git sync | Built (after main's F-2/F-7): encrypted files only, per-block merge after decryption, fail closed on a foreign remote, join with the passphrase. | `core/src/sync_encrypted.rs`, `encryption_commands::join_encrypted_notebook`, journey D14 |
| 6 CLI (keychain → `MINOTES_PASSPHRASE` → prompt; `notebook create --encrypt`, `encrypt`, `decrypt`) | Built | `minotes-cli/src/unlock.rs` |
| 7 Mock backend | Built | `lib/encryptionMock.ts` |

Tests: core 368 (about 40 encryption-specific: slots, keys, no plaintext in db or
WAL, conversion with a simulated crash at every step, zip round trip, attachments,
mirror refusal, leak scan of a converted notebook), CLI 19, browser journey 65
(15 assertions), desktop journey D13 (22 assertions, including the leak scan of
the whole scratch HOME, TMPDIR and app log).

Overhead (§7 scale run, measured with a core micro-benchmark, release build, 20k
blocks): writes +13 % (dominated by fsync), 300 searches +0 %, 500 page reads +3 %
— inside the ~15 % budget. The full `scale-tour.sh` run on an encrypted notebook
was not done.

Not built / deferred (see `tasks/opportunities.md`): biometric / Android Keystore (Q4), OS screen-lock detection for auto-lock, the CI
leak test (needs-human: no CI).
