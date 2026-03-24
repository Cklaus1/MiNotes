# MiNotes Encryption PRD

## Overview

Application-level encryption for MiNotes Project folders. Users can mark any Project folder as encrypted — all pages and blocks within that folder are encrypted at rest using AES-256-GCM. The encryption is transparent during use (unlock once per session) and protects data in the database file, in sync transit, and in backups.

## Problem Statement

Users store sensitive information in their notes — passwords, journal entries, medical info, business strategy, legal documents. Today, anyone with access to the SQLite database file (`~/.minotes/default.db`) can read all content in plaintext. Users need a way to protect specific folders without encrypting their entire knowledge base.

## Goals

1. Encrypt selected Project folders so content is unreadable without a passphrase
2. Encryption is transparent during use — unlock once, work normally
3. Encrypted data stays encrypted through sync, export, and backup
4. Zero-knowledge design — MiNotes (and any sync server) never sees plaintext
5. Simple UX — no key management, GPG, or certificates required

## Non-Goals

- End-to-end encrypted real-time collaboration (future)
- Encrypting the entire database (too disruptive to UX)
- Hardware key / biometric unlock (future enhancement)
- Key escrow or recovery (user is responsible for their passphrase)

## User Stories

### US-1: Encrypt a Project folder
As a user, I want to right-click a Project folder and select "Encrypt" so that all notes inside it are protected by a passphrase.

### US-2: Unlock an encrypted folder
As a user, I want to enter my passphrase once when I open the app (or click a locked folder) so I can read and edit my encrypted notes normally for the rest of the session.

### US-3: Lock encrypted folders
As a user, I want to lock all encrypted folders (manually or on app close) so that my data is protected when I walk away.

### US-4: Move pages into/out of encrypted folders
As a user, I want to drag a page into an encrypted folder and have it automatically encrypted, or drag it out and have it decrypted (with confirmation).

### US-5: Sync encrypted folders
As a user, I want encrypted folders to sync between devices with the encrypted content intact — the sync layer never sees plaintext.

### US-6: Change passphrase
As a user, I want to change the passphrase on an encrypted folder without losing any data.

### US-7: Search within encrypted folders
As a user, I want search to include results from unlocked encrypted folders, and exclude results from locked folders.

## Design

### Encryption Scheme

```
Passphrase
    │
    ▼
Argon2id (salt, 3 iterations, 64MB memory, 4 parallelism)
    │
    ▼
256-bit Derived Key (DEK wrapper)
    │
    ▼
Unwraps Folder Encryption Key (FEK) ──► AES-256-GCM encrypt/decrypt
    │
    ▼
Each block/page title encrypted with FEK + unique nonce
```

**Why two layers of keys?**
- The Folder Encryption Key (FEK) is a random 256-bit key generated once when encryption is enabled
- The FEK is wrapped (encrypted) by the passphrase-derived key
- Changing the passphrase only re-wraps the FEK — no need to re-encrypt every block
- Team sharing (future): the FEK can be wrapped with multiple passphrases or shared keys

### What Gets Encrypted

| Field | Encrypted | Rationale |
|-------|-----------|-----------|
| Block content | Yes | Primary sensitive data |
| Page title | Yes | Titles often reveal content |
| Page icon | No | Low sensitivity, needed for locked-state UI |
| Folder name | No | Needed for navigation when locked |
| Block position, parent_id | No | Structural, needed for tree rendering |
| Block timestamps | No | Low sensitivity |
| Properties (key) | No | Needed for query engine |
| Properties (value) | Yes | Values may be sensitive |
| Links (from_block, to_page) | Partially | Link targets within encrypted folder are encrypted; cross-folder links use page IDs (opaque) |

### Encrypted Data Format

Each encrypted field is stored as a base64-encoded blob:

```
ENC:v1:<12-byte-nonce-hex>:<ciphertext-base64>
```

- Prefix `ENC:v1:` allows detection of encrypted vs plaintext content
- Nonce is unique per write (regenerated on every update)
- Ciphertext includes the AES-GCM authentication tag (16 bytes)

### Database Schema Changes

```sql
-- Add to folders table
ALTER TABLE folders ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE folders ADD COLUMN encryption_salt BLOB;        -- Argon2 salt (16 bytes)
ALTER TABLE folders ADD COLUMN encrypted_fek BLOB;          -- FEK wrapped by derived key
ALTER TABLE folders ADD COLUMN fek_nonce BLOB;              -- Nonce used to wrap FEK
ALTER TABLE folders ADD COLUMN key_check BLOB;              -- Encrypted known plaintext for passphrase verification
```

### State Machine

```
                    ┌─────────────────┐
                    │   UNENCRYPTED   │
                    └────────┬────────┘
                             │ User enables encryption
                             │ (enters new passphrase)
                             ▼
                    ┌─────────────────┐
          ┌────────│    UNLOCKED     │────────┐
          │        └────────┬────────┘        │
          │                 │                 │
     User locks        App closes       User works
     manually          (auto-lock)       normally
          │                 │                 │
          ▼                 ▼                 │
     ┌─────────────────────────┐              │
     │        LOCKED           │──────────────┘
     │  (passphrase required)  │  User enters passphrase
     └─────────────────────────┘
```

### Key Management In Memory

```rust
struct AppState {
    db: Mutex<Database>,
    current_graph: Mutex<String>,
    // New: encryption keys held in memory for unlocked folders
    folder_keys: Mutex<HashMap<Uuid, Vec<u8>>>,  // folder_id → decrypted FEK
}
```

- Keys are held in memory only while folders are unlocked
- On lock or app close, `folder_keys` is cleared
- Keys are never written to disk in plaintext
- Keys are never sent over the network

## UX Design

### Sidebar — Locked Folder

```
📁 🔒 Private Journal          (locked)
    Click to unlock...
```

- Locked folders show a lock icon
- Clicking expands to show "Enter passphrase to unlock"
- Pages inside are not listed (titles are encrypted)

### Sidebar — Unlocked Folder

```
📁 🔓 Private Journal          (unlocked)
    📄 Therapy Notes
    📄 Financial Planning
    📄 Health Records
```

- Unlocked folders show an open lock icon
- Pages listed normally — decrypted in memory
- Right-click folder → "Lock" to re-lock

### Unlock Dialog

```
┌─────────────────────────────────┐
│  🔒 Unlock "Private Journal"   │
│                                 │
│  Passphrase: [••••••••••••]    │
│                                 │
│  [ ] Remember until app closes  │
│                                 │
│  [Cancel]          [Unlock]     │
└─────────────────────────────────┘
```

### Enable Encryption Dialog

```
┌──────────────────────────────────────┐
│  🔐 Encrypt "Private Journal"       │
│                                      │
│  All pages in this folder will be    │
│  encrypted. You must remember your   │
│  passphrase — there is no recovery.  │
│                                      │
│  Passphrase:  [••••••••••••]        │
│  Confirm:     [••••••••••••]        │
│                                      │
│  Strength: ████████░░ Strong         │
│                                      │
│  ⚠ If you forget your passphrase,   │
│  your data cannot be recovered.      │
│                                      │
│  [Cancel]           [Encrypt]        │
└──────────────────────────────────────┘
```

### Move Page Into Encrypted Folder

```
"Meeting Notes" will be encrypted and
protected by the folder's passphrase.

[Cancel]  [Encrypt & Move]
```

### Move Page Out of Encrypted Folder

```
"Meeting Notes" will be decrypted and
stored in plaintext. Anyone with database
access will be able to read it.

[Cancel]  [Decrypt & Move]
```

## API / Tauri Commands

### New Commands

```rust
#[tauri::command]
fn enable_folder_encryption(folder_id: String, passphrase: String) -> Result<(), String>
// Generate FEK, derive key from passphrase, wrap FEK, encrypt all existing content

#[tauri::command]
fn disable_folder_encryption(folder_id: String, passphrase: String) -> Result<(), String>
// Verify passphrase, decrypt all content, remove encryption metadata

#[tauri::command]
fn unlock_folder(folder_id: String, passphrase: String) -> Result<bool, String>
// Derive key, unwrap FEK, verify via key_check, store FEK in folder_keys

#[tauri::command]
fn lock_folder(folder_id: String) -> Result<(), String>
// Remove FEK from folder_keys

#[tauri::command]
fn lock_all_folders() -> Result<(), String>
// Clear all keys from folder_keys

#[tauri::command]
fn change_folder_passphrase(folder_id: String, old_passphrase: String, new_passphrase: String) -> Result<(), String>
// Verify old, derive new key, re-wrap FEK (content unchanged)

#[tauri::command]
fn is_folder_unlocked(folder_id: String) -> Result<bool, String>
// Check if FEK is in folder_keys
```

### Modified Commands

```rust
// These commands must decrypt on read if folder is encrypted + unlocked:
fn get_page_tree(...)   // Decrypt page title + block content
fn list_pages(...)      // Decrypt page titles for unlocked folders, show "[Locked]" for locked
fn search_blocks(...)   // Only search unlocked encrypted folders

// These commands must encrypt on write if folder is encrypted:
fn create_block(...)    // Encrypt content before DB write
fn update_block(...)    // Encrypt content before DB write
fn create_page(...)     // Encrypt title before DB write
fn rename_page(...)     // Encrypt new title before DB write
```

## Implementation Plan

### Phase 1: Core Encryption (Backend)

1. Add `aes-gcm` and `argon2` crates to `minotes-core`
2. Create `crypto.rs` module:
   - `derive_key(passphrase, salt) → [u8; 32]`
   - `generate_fek() → [u8; 32]`
   - `wrap_fek(fek, derived_key) → (encrypted_fek, nonce)`
   - `unwrap_fek(encrypted_fek, nonce, derived_key) → fek`
   - `encrypt_field(plaintext, fek) → "ENC:v1:nonce:ciphertext"`
   - `decrypt_field(encrypted, fek) → plaintext`
   - `is_encrypted(value) → bool`
3. Database migration: add encryption columns to `folders` table
4. Implement `enable_folder_encryption` — encrypts all existing blocks/titles
5. Implement `unlock_folder` / `lock_folder` — key management in `AppState`

### Phase 2: Read/Write Integration (Backend)

6. Modify `get_page_tree` — decrypt titles and content for unlocked folders
7. Modify `create_block` / `update_block` — encrypt if folder is encrypted
8. Modify `create_page` / `rename_page` — encrypt titles
9. Modify `search_blocks` — skip locked folders, decrypt results from unlocked
10. Modify `list_pages` — show encrypted titles as "[Locked]" or decrypt if unlocked
11. Modify `move_page_to_folder` — encrypt/decrypt on folder boundary crossing

### Phase 3: Frontend UX

12. Lock/unlock UI in sidebar (lock icon, unlock dialog)
13. Enable encryption dialog (right-click folder → Encrypt)
14. Change passphrase dialog (right-click encrypted folder → Change Passphrase)
15. Move page confirmation dialogs (encrypt/decrypt on drag)
16. Lock all on app close (cleanup handler)
17. Keyboard shortcut: Ctrl+L to lock all folders

### Phase 4: Sync Integration

18. Encrypted blocks sync as ciphertext — no changes to sync protocol
19. Encrypted folder metadata (salt, wrapped FEK) syncs to enable unlock on other devices
20. Conflict resolution works on ciphertext (last-write-wins still applies)

### Phase 5: Mock Backend

21. Implement encryption in `mockBackend.ts` using Web Crypto API (AES-GCM + PBKDF2)
22. Mirror the same `ENC:v1:` format for browser testing

## Security Considerations

### Threat Model

| Threat | Protected? | How |
|--------|-----------|-----|
| Someone copies your .db file | Yes | Content encrypted with AES-256-GCM |
| Someone accesses your machine while app is closed | Yes | Keys not in memory |
| Someone accesses your machine while app is open | Partial | Unlocked folders are readable in memory |
| Sync server reads your data | Yes | Server only sees ciphertext |
| Brute-force passphrase attack | Mitigated | Argon2id with high memory cost (64MB) |
| Known-plaintext attack | Mitigated | AES-GCM with unique nonces |
| Passphrase forgotten | Not recoverable | By design — no backdoor |

### What This Does NOT Protect

- Memory dumps while folders are unlocked
- Keyloggers capturing the passphrase
- Screenshots of decrypted content
- OS-level full-disk access while app is running
- Weak passphrases (mitigated by strength meter, not prevented)

### Passphrase Strength Requirements

- Minimum 8 characters
- Strength meter shown (zxcvbn or similar)
- No maximum length
- No character restrictions
- Warning shown for weak passphrases, but not blocked

## Testing

### Unit Tests (Rust)
- Encrypt/decrypt round-trip
- Wrong passphrase returns error
- Different nonces produce different ciphertext
- Key derivation is deterministic (same passphrase + salt = same key)
- FEK wrap/unwrap round-trip
- Passphrase change preserves data

### Integration Tests
- Enable encryption on folder with existing pages
- Create/read/update/delete blocks in encrypted folder
- Search includes unlocked, excludes locked
- Move page between encrypted and unencrypted folders
- Lock/unlock cycle preserves all data
- App restart requires re-unlock

### User Journey Tests
- Journey: Enable encryption, add notes, lock, verify unreadable, unlock, verify readable
- Journey: Move page into encrypted folder, move it out
- Journey: Change passphrase, verify old passphrase fails, new works
- Journey: Search across mix of encrypted and unencrypted folders

## Dependencies

### Rust Crates
- `aes-gcm` — AES-256-GCM encryption
- `argon2` — Argon2id key derivation
- `rand` — Cryptographic random number generation (nonces, salts, FEK)

### Frontend
- Web Crypto API (for mock backend) — built into browsers, no npm packages needed

## Rollout

1. Ship as opt-in feature behind Settings toggle: "Enable Folder Encryption"
2. Default: off — no encryption until user explicitly enables on a folder
3. No migration needed — existing folders remain unencrypted
4. Feature flag allows disabling if critical bugs found

## Future Enhancements

- Biometric unlock (OS keychain integration)
- Team encryption (FEK wrapped with multiple keys)
- Encrypted attachments (images, PDFs)
- Encrypted export (password-protected ZIP)
- Auto-lock timer (lock after N minutes of inactivity)
- Encrypted search index (currently search skips locked folders)
