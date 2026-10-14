# Flight plan — PRD-encryption build loop

**Mission:** whole-notebook SQLCipher encryption (envelope keys, unlock/lock, recovery
key, keychain, convert, CLI, UI, leak-proof storage) built end to end; encrypted sync last.

**Engineering decisions (Step 2 + review corrections)**
- Q1 mirror for encrypted notebooks → off (sync off) → nothing to leak; encrypted mirror only with sync (E17).
- Q2 auto-lock default → 15 min, "never" allowed → as §4.4 says; a setting.
- Q3 passphrase strength → enforced "fair", built-in estimator → §5 decides; no zxcvbn dep. ⚠ close call: reviewer said product.
- Q4 biometric → later → no Android keychain; Touch ID flags not in `keyring`.
- Wrong passphrase detection → AES-GCM slot tag, not SQLCipher NOTADB → NOTADB is ambiguous.
- Key handoff → `sqlite3_key_v2` with `x'…'` from a zeroizing buffer, before first statement, no CREATE flag.
- Recovery key format → 32 B + 3 B SHA-256 checksum, base32, 8×7 groups; HKDF info `minotes recovery kek v1`; AAD binds slot type, not notebook id (copies must open).
- Rotate DEK → export+verify+swap path, new recovery key → `rekey` not resumable.
- Attachments in encrypted notebooks → inside the DB (`attachment_blobs`) → SQLCipher covers them; no second crypto format.
- Zip export of encrypted notebook → stays encrypted + slots; import asks passphrase.
- Legacy-location notebooks → must move to a folder first ⚠ close call (one slot location).
- notebook.json → `format_version: 2`, no name; older builds refuse cleanly.
- Only the open notebook is unlocked; switching away locks (keychain may reopen).
- Lock → backend drops DB + key cache, cancels AI; frontend reloads webview (no cached data survives).
- Sleep → wall-clock drift of a 15 s timer (no Tauri sleep event).
- "Securely remove" → delete + warn about backups (SSD/CoW can't be overwritten).
- Recent pages / kanban state of encrypted notebooks → DB `ui_state`, not localStorage.

**needs-human (excluded):** §8 CI leak test per release (no CI, ARCH X-1) — 0 tasks pruned;
§9 Q5 hide registry names — recommend No; v1 builds §4.4 as written — 0 tasks pruned.

**[REVISED] markers:** WAL wording; key handoff; wrong-key mechanism; Android keychain
out of v1; rotate mechanism; format v2; lock teardown; auto-lock sleep; link previews
(no cache exists); +attachments row (P0); +zip row (P1); +mirror-state/webview row;
+AI/plugins row; "securely remove"; legacy notebooks; Windows check; added steps 2b/2c/4b.

**Critical path:** E1 SQLCipher switch — gate: cargo 374/374, journeys = baseline,
stock-sqlite3 interop both ways, Android x86_64 APK, Windows-gnu CLI build, size delta.

**Shape:** 18 tasks, 6 tiers (A core-lib, B core, C backend/CLI/zip, D frontend, E
journeys/scale, F sync), longest chain 10 (E1→E2→E3→E4→E5→E8→E9→E10→E11→E14),
2 parallel candidates (E6∥E7, E9∥E12). TEST_CMD = cargo test --workspace + tsc + vite
(~2.5 min); RUN = desktop-check app + CLI; RUN_BUDGET unbounded. Baseline: cargo
374/374 ok, tsc/vite ok, desktop 223/230 (7 pre-existing), browser see opportunities.

**First 3 tasks:** E1 SQLCipher switch · E2 crypto module · E3 encrypted open + key cache.
