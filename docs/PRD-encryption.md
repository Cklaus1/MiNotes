# PRD: Notebook Encryption

Status: not started · Owner: Chris Klaus · Rewritten 2026-10-10

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
- WAL and temp files: SQLCipher encrypts the WAL and journal; set
  `PRAGMA temp_store = MEMORY` so temp tables never touch disk in plaintext.
- `Database::open` gains an optional key. A wrong key surfaces as a clear
  "wrong passphrase" error (SQLCipher fails on the first read), never as a panic
  or as "database is corrupt".

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
- `notebook.json` otherwise holds only the notebook's id and format version for an
  encrypted notebook — **not its name** (the registry in `~/.minotes` keeps a local
  display name).

### 4.3 Remembering the key on a device

Off by default. "Keep unlocked on this device" stores the **DEK** in the OS
keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service,
Android Keystore), keyed by notebook id, via the `keyring` crate.

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
- Auto-lock: after N minutes without input (default 15, configurable, "never"
  allowed) and on system sleep/lock where the platform reports it.
- A locked notebook shows only: its local display name, a lock icon, and the
  unlock dialog. No titles, counts or recent pages.
- The CLI reads the passphrase from a prompt, `MINOTES_PASSPHRASE`, or the
  keychain; it never accepts it as a command-line argument (visible in `ps`).

### 4.5 Plaintext outside the database

Everything that would leak must be handled explicitly:

| Copy | Encrypted notebook behaviour |
|---|---|
| Markdown mirror (`notes/`) | **Off by default.** Option: an *encrypted mirror* — each file encrypted with a key derived from the DEK (age-style, one file per page, filenames are opaque ids). Readable only by MiNotes; exists so git sync has files to move. |
| Git sync | Syncs the encrypted mirror. Merges become "newer file wins per page" (ciphertext cannot be three-way merged); conflicting edits keep both as today's conflict-copy pages after decryption. The remote sees file count, sizes and timing only. |
| Export / publish site | Allowed while unlocked, with a one-time "this writes unencrypted files" confirmation. |
| Whiteboard legacy localStorage copies | Deleted when a notebook is encrypted. |
| Webview storage (settings, collapsed state, recent pages) | Recent-page titles and anything content-derived move into the database; only non-sensitive UI preferences stay in webview storage. |
| OS swap / crash dumps | Out of scope; documented. |
| Link previews fetched for a page | Fetched while unlocked only; cached inside the database. |

### 4.6 Converting

- **Encrypt an existing notebook**: create an encrypted copy with
  `sqlcipher_export`, verify (integrity check + row counts per table), swap it in,
  then securely remove the plaintext database, its WAL/SHM, the plaintext mirror
  (including `.git` history — warn that old commits on any remote still contain
  plaintext), `.minotes-trash/`, and legacy whiteboard storage. Show exactly what
  will be deleted before starting.
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
   Android builds and binary-size impact. All unencrypted notebooks keep working
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
5. Encrypted mirror + sync adaptation (can ship after 1–4: until then, encrypted
   notebooks simply have mirror and sync off).
6. CLI: prompt / env / keychain.
7. Mock backend: lock state and wrong-passphrase behaviour (no real crypto) so
   browser journeys can cover the flows.

Depends on `PRD-notebooks.md` Phase 1 (switcher) and Phase 3 (`notebook.json`).
Encryption of a notebook in the legacy `~/.minotes/<name>.db` location stores its
slots in `~/.minotes/<name>.encryption.json`.

## 7. Testing

- Core: wrap/unwrap round-trips; wrong passphrase and wrong recovery key rejected;
  change passphrase leaves database bytes unchanged; tampered slot or database page
  detected; Argon2 parameters read from the slot; convert/deconvert preserve every
  table and survive a simulated crash at each step.
- **Leak test** (the important one): create an encrypted notebook with distinctive
  marker strings in titles, blocks, folder names, properties, whiteboards and
  search queries; then scan every file the app wrote (notebook folder, registry,
  webview storage, temp dir, logs) for the markers. None may appear.
- Desktop journeys (`tests/desktop-journey-test.sh`): create encrypted, lock,
  wrong passphrase, unlock, restart → locked, remembered device → unlocked,
  recovery-key flow, auto-lock, encrypt an existing notebook, two-device sync of an
  encrypted notebook.
- Scale run on an encrypted notebook to confirm overhead stays within ~15%.

## 8. Risks

| Risk | Mitigation |
|---|---|
| User loses passphrase and recovery key | Recovery key is mandatory at setup and re-printable while unlocked; plain-language warning; nothing else is possible by design. |
| A plaintext copy is missed | The leak test in §7 runs in CI against every release. |
| Keychain entry leaks the DEK to other software in the session | Opt-in, explained; auto-lock; "Forget on this device". |
| Conversion interrupted | Resumable with verification before any deletion. |
| Build complexity (vendored OpenSSL on Windows/Android) | Spike first (step 1) before committing to the rest. |
| Encrypted sync loses fine-grained merging | Conflict copies preserve both versions; documented trade-off. |

## 9. Open questions

1. Should the mirror be off or encrypted-by-default for encrypted notebooks? (Off
   is simpler and ships sooner; encrypted is needed for sync.)
2. Default auto-lock time: 15 minutes, or never-until-quit?
3. Is the minimum passphrase strength enforced or advisory?
4. Offer biometric unlock on Android/macOS in v1, or later?
5. Should the registry hide encrypted notebooks' display names until unlocked?
