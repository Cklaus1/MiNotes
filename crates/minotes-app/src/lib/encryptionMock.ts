/**
 * Browser-mode mock of encrypted notebooks (src-tauri encryption_commands.rs),
 * so the browser journeys can cover create / lock / wrong passphrase / unlock /
 * recovery / encrypt-existing (PRD-encryption §6.7). No real crypto: the mock
 * keeps the passphrase in memory and compares strings. What it does model like
 * the real app: a locked notebook refuses every data command with
 * `NOTEBOOK_LOCKED`, a wrong secret is `WRONG_PASSPHRASE`, weak passphrases are
 * refused, switching away locks a notebook (unless "kept unlocked"), and the
 * recovery key is single-use after recovery.
 */
import { passphraseStrength, MIN_STRENGTH } from "./passphrase";

type Handlers = Record<string, (args: any) => any>;

interface EncState {
  passphrase: string;
  recovery: string;
  remembered: boolean;
  /** The key is not in memory: only unlocking helps. */
  locked: boolean;
}

/** Commands that never touch the open notebook's data (they work while it is locked). */
const WHILE_LOCKED = new Set([
  "list_notebooks", "get_notebook_session", "get_current_notebook", "switch_notebook", "dismiss_notebook_notice",
  "default_notebook_location", "create_notebook", "create_encrypted_notebook", "open_notebook_folder",
  "locate_notebook", "rename_notebook", "delete_notebook", "forget_notebook", "unlock_notebook", "lock_notebook",
  "recover_with_key", "get_platform_capabilities", "mirror_status", "git_available", "git_sync_status",
  "search_other_notebooks", "resolve_notebook_links", "list_notebook_pages", "import_notebook_zip",
  "encryption_plan", "ai_get_status",
]);

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function newRecoveryKey(): string {
  const groups: string[] = [];
  for (let g = 0; g < 8; g++) {
    let s = "";
    for (let i = 0; i < 7; i++) s += B32[Math.floor(Math.random() * 32)];
    groups.push(s);
  }
  return groups.join("-");
}

const normRecovery = (s: string) => s.toUpperCase().replace(/[\s-]/g, "");

function fail(msg: string): never {
  throw new Error(msg);
}

function checkStrength(p: string) {
  if (passphraseStrength(p) < MIN_STRENGTH) {
    fail("Invalid input: That passphrase is too easy to guess — use a longer one (several words work well)");
  }
}

export function createEncryptionMockHandlers(h: Handlers): Handlers {
  const enc = new Map<string, EncState>();

  const current = () => h.get_current_notebook({}) as string;
  const stateOf = (key: string) => enc.get(key);
  const lockedNow = () => !!stateOf(current())?.locked;
  const nameOf = (key: string) => (h.list_notebooks({}) as any[]).find(n => n.key === key)?.name ?? key;
  const lockedError = () => fail(`NOTEBOOK_LOCKED: Notebook “${nameOf(current())}” is locked`);
  const requireEncrypted = () => stateOf(current()) ?? fail(`Notebook “${nameOf(current())}” is not encrypted`);

  // Every data command refuses while the open notebook is locked.
  for (const [cmd, fn] of Object.entries(h)) {
    if (WHILE_LOCKED.has(cmd)) continue;
    h[cmd] = (args: any) => (lockedNow() ? lockedError() : fn(args));
  }

  const decorate = (nb: any) => {
    const st = stateOf(nb.key);
    return { ...nb, encrypted: !!st, locked: !!st?.locked };
  };

  const baseList = h.list_notebooks;
  const baseSession = h.get_notebook_session;
  const baseSwitch = h.switch_notebook;
  const baseDelete = h.delete_notebook;
  const baseSyncEnable = h.git_sync_enable;

  return {
    list_notebooks: (a: any) => (baseList(a) as any[]).map(decorate),
    get_notebook_session: (a: any) => {
      const s = baseSession(a);
      const st = stateOf(s.key);
      return { ...s, encrypted: !!st, locked: !!st?.locked, remembered: !!st?.remembered, keychain_available: true };
    },
    switch_notebook: (a: { key: string }) => {
      const from = current();
      const r = baseSwitch(a);
      if (from !== a.key) {
        const old = stateOf(from);
        if (old && !old.remembered) old.locked = true; // only the open notebook stays unlocked
      }
      return r;
    },
    delete_notebook: (a: { key: string }) => {
      const r = baseDelete(a);
      enc.delete(a.key);
      return r;
    },
    create_encrypted_notebook: ({ name, location, passphrase }: { name: string; location?: string | null; passphrase: string }) => {
      checkStrength(passphrase ?? "");
      const nb = h.create_notebook({ name, location });
      const recovery = newRecoveryKey();
      enc.set(nb.key, { passphrase, recovery, remembered: false, locked: false });
      return { notebook: decorate(nb), recovery_key: recovery };
    },
    unlock_notebook: ({ secret, recovery, remember }: { secret: string; recovery?: boolean; remember?: boolean }) => {
      const st = requireEncrypted();
      const ok = recovery ? normRecovery(secret ?? "") === normRecovery(st.recovery) : secret === st.passphrase;
      if (!ok) fail("WRONG_PASSPHRASE: Wrong passphrase");
      st.locked = false;
      if (remember) st.remembered = true;
      return h.get_notebook_session({});
    },
    lock_notebook: () => {
      const st = requireEncrypted();
      st.locked = true;
      return h.get_notebook_session({});
    },
    change_passphrase: ({ currentPassphrase, newPassphrase }: { currentPassphrase: string; newPassphrase: string }) => {
      const st = requireEncrypted();
      if (st.locked) lockedError();
      checkStrength(newPassphrase ?? "");
      if (currentPassphrase !== st.passphrase) fail("WRONG_PASSPHRASE: Wrong passphrase");
      st.passphrase = newPassphrase;
    },
    recover_with_key: ({ recoveryKey, newPassphrase }: { recoveryKey: string; newPassphrase: string }) => {
      const st = requireEncrypted();
      checkStrength(newPassphrase ?? "");
      if (normRecovery(recoveryKey ?? "").length !== 56) fail("Invalid input: This is not a valid recovery key — check for typos");
      if (normRecovery(recoveryKey) !== normRecovery(st.recovery)) fail("WRONG_PASSPHRASE: Wrong passphrase");
      st.passphrase = newPassphrase;
      st.recovery = newRecoveryKey();
      st.locked = false;
      return st.recovery;
    },
    regenerate_recovery_key: ({ passphrase }: { passphrase: string }) => {
      const st = requireEncrypted();
      if (st.locked) lockedError();
      if (passphrase !== st.passphrase) fail("WRONG_PASSPHRASE: Wrong passphrase");
      st.recovery = newRecoveryKey();
      return st.recovery;
    },
    set_remember_device: ({ remember }: { remember: boolean }) => {
      const st = requireEncrypted();
      if (st.locked) lockedError();
      st.remembered = !!remember;
      return h.get_notebook_session({});
    },
    encryption_plan: () => {
      const s = baseSession({});
      return {
        deletes: s.kind === "folder" ? [s.db_path, s.mirror_dir] : [],
        needs_folder: s.kind !== "folder",
        has_git: false,
      };
    },
    encrypt_notebook: ({ passphrase }: { passphrase: string }) => {
      const s = baseSession({});
      if (s.kind !== "folder") fail("Invalid input: Only notebooks in a folder can be encrypted — use “Move notebook to a folder…” first");
      if (stateOf(s.key)) fail("Invalid input: This notebook is already encrypted");
      checkStrength(passphrase ?? "");
      const recovery = newRecoveryKey();
      enc.set(s.key, { passphrase, recovery, remembered: false, locked: false });
      return recovery;
    },
    decrypt_notebook: ({ passphrase }: { passphrase: string }) => {
      const st = requireEncrypted();
      if (passphrase !== st.passphrase) fail("WRONG_PASSPHRASE: Wrong passphrase");
      enc.delete(current());
    },
    rotate_notebook_key: ({ passphrase }: { passphrase: string }) => {
      const st = requireEncrypted();
      if (passphrase !== st.passphrase) fail("WRONG_PASSPHRASE: Wrong passphrase");
      st.recovery = newRecoveryKey();
      st.remembered = false;
      return st.recovery;
    },
    // Sync is off for encrypted notebooks (no plaintext markdown copy).
    git_sync_enable: (a: any) => {
      if (stateOf(current())) fail("Sync is off for encrypted notebooks: they have no plaintext markdown copy to sync");
      return baseSyncEnable(a);
    },
  };
}
