import { useEffect, useState } from "react";
import * as api from "../lib/api";
import { errorMessage } from "../lib/errors";
import { showToast } from "../lib/toast";
import { MIN_STRENGTH, STRENGTH_LABELS, passphraseProblem, passphraseStrength } from "../lib/passphrase";
import { recoveryKeyFileText, unlock, refreshLockState, resetNotebookCaches } from "../lib/encryption";
import { notebooksChanged, switchNotebook } from "../lib/notebooks";
import Modal from "./Modal";
import "./encryption.css";

/** "Wrong passphrase" for WRONG_PASSPHRASE errors, else the message itself. */
function friendly(e: unknown): string {
  if (api.isWrongPassphrase(e)) return "Wrong passphrase.";
  return errorMessage(e).replace(/^Invalid input: /, "");
}

/** Passphrase twice, with a strength meter (minimum "fair"). */
export function PassphraseFields({ value, confirm, onChange, onConfirm, label = "Passphrase", autoFocus, idPrefix = "enc" }: {
  value: string;
  confirm: string;
  onChange: (v: string) => void;
  onConfirm: (v: string) => void;
  label?: string;
  autoFocus?: boolean;
  idPrefix?: string;
}) {
  const strength = value ? passphraseStrength(value) : -1;
  const mismatch = confirm.length > 0 && confirm !== value;
  return (
    <div className="enc-pass-fields">
      <label className="nb-field">
        <span className="nb-label">{label}</span>
        <input
          type="password"
          className="search-input"
          autoFocus={autoFocus}
          autoComplete="new-password"
          value={value}
          onChange={e => onChange(e.target.value)}
          aria-label={label}
          data-testid={`${idPrefix}-passphrase`}
        />
      </label>
      {strength >= 0 && (
        <div className="enc-meter" data-strength={strength} aria-live="polite">
          <div className="enc-meter-bar"><span style={{ width: `${(strength + 1) * 20}%` }} /></div>
          <span className="enc-meter-label" data-testid={`${idPrefix}-strength`}>
            {STRENGTH_LABELS[strength]}{strength < MIN_STRENGTH ? " — too easy to guess" : ""}
          </span>
        </div>
      )}
      <label className="nb-field">
        <span className="nb-label">Repeat it</span>
        <input
          type="password"
          className="search-input"
          autoComplete="new-password"
          value={confirm}
          onChange={e => onConfirm(e.target.value)}
          aria-label="Repeat the passphrase"
          data-testid={`${idPrefix}-passphrase-confirm`}
        />
      </label>
      {mismatch && <div className="nb-field-error">The two passphrases don't match.</div>}
      <div className="nb-hint">
        Several unrelated words make a passphrase that is long and easy to remember. MiNotes cannot
        recover a notebook if both the passphrase and the recovery key are lost.
      </div>
    </div>
  );
}

/** Shown once after creating / encrypting / recovering: the recovery key, with
 *  Copy / Save to file / Print and a required "I have saved it" checkbox. */
export function RecoveryKeyPanel({ notebook, recoveryKey, onDone, doneLabel = "Continue" }: {
  notebook: string;
  recoveryKey: string;
  onDone: () => void;
  doneLabel?: string;
}) {
  const [saved, setSaved] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(recoveryKey);
      showToast("Recovery key copied — paste it somewhere safe, then clear the clipboard");
    } catch (e) {
      showToast(`Couldn't copy: ${errorMessage(e)}`);
    }
  };
  const saveFile = async () => {
    const text = recoveryKeyFileText(notebook, recoveryKey);
    try {
      if (api.isTauri) {
        const p = await api.saveExportFile(`${notebook} recovery key.txt`, Array.from(new TextEncoder().encode(text)));
        if (p) showToast(`Saved to ${p}`);
      } else {
        const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = `${notebook} recovery key.txt`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      showToast(`Couldn't save: ${errorMessage(e)}`);
    }
  };
  const print = () => {
    document.body.classList.add("enc-printing");
    const done = () => { document.body.classList.remove("enc-printing"); window.removeEventListener("afterprint", done); };
    window.addEventListener("afterprint", done);
    window.print();
    setTimeout(done, 1000);
  };
  return (
    <div className="enc-recovery" data-testid="recovery-key-panel">
      <p>
        This is the <strong>recovery key</strong> for “{notebook}”. It opens the notebook if you forget
        the passphrase. <strong>It is shown only now.</strong> Keep it somewhere safe and separate from
        this computer.
      </p>
      <code className="enc-recovery-key" data-testid="recovery-key" translate="no">{recoveryKey}</code>
      <div className="enc-recovery-actions">
        <button className="btn btn-sm" onClick={copy}>Copy</button>
        <button className="btn btn-sm" onClick={saveFile}>Save to file…</button>
        <button className="btn btn-sm" onClick={print}>Print…</button>
      </div>
      <label className="enc-check">
        <input type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)} data-testid="recovery-saved" />
        I have saved my recovery key
      </label>
      <div className="nb-modal-actions">
        <button className="btn btn-sm btn-primary" disabled={!saved} onClick={onDone} data-testid="recovery-done">
          {doneLabel}
        </button>
      </div>
    </div>
  );
}

/** The whole window while the open notebook is locked: its name, a lock, the
 *  unlock form — and a way to open another notebook. */
export function UnlockScreen({ session }: { session: api.NotebookSession }) {
  const [mode, setMode] = useState<"passphrase" | "recovery">("passphrase");
  const [secret, setSecret] = useState("");
  const [remember, setRemember] = useState(false);
  const [newPass, setNewPass] = useState("");
  const [newConfirm, setNewConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [others, setOthers] = useState<api.NotebookInfo[]>([]);

  useEffect(() => {
    api.listNotebooks().then(l => setOthers((l ?? []).filter(n => n.key !== session.key && n.available))).catch(() => {});
  }, [session.key]);

  const submit = async () => {
    if (busy || !secret) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "passphrase") {
        await unlock(secret, { remember });
      } else {
        const p = passphraseProblem(newPass, newConfirm);
        if (p) { setError(p); return; }
        const k = await api.recoverWithKey(secret, newPass);
        setNewKey(k);
      }
    } catch (e) {
      setError(friendly(e));
      setSecret("");
    } finally {
      setBusy(false);
    }
  };

  if (newKey) {
    return (
      <div className="enc-lockscreen" data-testid="unlock-screen">
        <div className="enc-lock-card">
          <h2 className="enc-lock-title">New passphrase set</h2>
          <RecoveryKeyPanel
            notebook={session.name}
            recoveryKey={newKey}
            doneLabel="Open the notebook"
            onDone={() => { resetNotebookCaches(); refreshLockState(); }}
          />
          <p className="nb-hint">The old recovery key no longer works.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="enc-lockscreen" data-testid="unlock-screen">
      <form className="enc-lock-card" onSubmit={e => { e.preventDefault(); submit(); }}>
        <div className="enc-lock-icon" aria-hidden>🔒</div>
        <h2 className="enc-lock-title" data-testid="unlock-notebook-name">{session.name}</h2>
        <p className="enc-lock-sub">This notebook is encrypted and locked.</p>
        {mode === "passphrase" ? (
          <>
            <label className="nb-field">
              <span className="nb-label">Passphrase</span>
              <input
                type="password"
                className="search-input"
                autoFocus
                autoComplete="current-password"
                value={secret}
                onChange={e => setSecret(e.target.value)}
                aria-label="Passphrase"
                data-testid="unlock-passphrase"
              />
            </label>
            <label className={`enc-check${session.keychain_available ? "" : " disabled"}`}>
              <input
                type="checkbox"
                checked={remember}
                disabled={!session.keychain_available}
                onChange={e => setRemember(e.target.checked)}
                data-testid="unlock-remember"
              />
              Keep unlocked on this device
            </label>
            {!session.keychain_available && (
              <div className="nb-hint">
                Not available: this device has no keychain MiNotes can use (MiNotes never keeps the key in a plain file).
              </div>
            )}
          </>
        ) : (
          <>
            <label className="nb-field">
              <span className="nb-label">Recovery key</span>
              <input
                className="search-input enc-mono"
                autoFocus
                spellCheck={false}
                autoComplete="off"
                value={secret}
                placeholder="ABCDEFG-HIJKLMN-…"
                onChange={e => setSecret(e.target.value)}
                aria-label="Recovery key"
                data-testid="unlock-recovery-key"
              />
            </label>
            <PassphraseFields
              value={newPass}
              confirm={newConfirm}
              onChange={setNewPass}
              onConfirm={setNewConfirm}
              label="New passphrase"
              idPrefix="recover"
            />
          </>
        )}
        {error && <div className="nb-field-error" role="alert" data-testid="unlock-error">{error}</div>}
        <div className="nb-modal-actions">
          <button
            type="button"
            className="btn btn-sm enc-link"
            onClick={() => { setMode(m => (m === "passphrase" ? "recovery" : "passphrase")); setSecret(""); setError(null); }}
            data-testid="unlock-toggle-recovery"
          >
            {mode === "passphrase" ? "Use recovery key instead" : "Use the passphrase"}
          </button>
          <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !secret} data-testid="unlock-submit">
            {busy ? "Unlocking…" : mode === "passphrase" ? "Unlock" : "Recover"}
          </button>
        </div>
        {others.length > 0 && (
          <div className="enc-others">
            <span className="nb-label">Open another notebook</span>
            <div className="enc-others-list">
              {others.map(n => (
                <button
                  key={n.key}
                  type="button"
                  className="btn btn-sm"
                  onClick={async () => {
                    try {
                      await switchNotebook(n.key);
                      notebooksChanged();
                      await refreshLockState();
                    } catch (e) {
                      showToast(`Couldn't open “${n.name}”: ${errorMessage(e)}`);
                    }
                  }}
                >
                  {n.encrypted ? "🔒 " : ""}{n.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </form>
    </div>
  );
}

/** In-app passphrase prompt (importing an encrypted notebook archive …). */
export function PassphrasePrompt({ title, message, onDone }: { title: string; message: string; onDone: (s: string | null) => void }) {
  const [value, setValue] = useState("");
  return (
    <Modal title={title} onClose={() => onDone(null)} testId="passphrase-prompt">
      <form onSubmit={e => { e.preventDefault(); if (value) onDone(value); }}>
        <p className="nb-hint">{message}</p>
        <label className="nb-field">
          <span className="nb-label">Passphrase or recovery key</span>
          <input
            type="password"
            className="search-input"
            autoFocus
            value={value}
            onChange={e => setValue(e.target.value)}
            aria-label="Passphrase or recovery key"
            data-testid="passphrase-prompt-input"
          />
        </label>
        <div className="nb-modal-actions">
          <button type="button" className="btn btn-sm" onClick={() => onDone(null)}>Cancel</button>
          <button type="submit" className="btn btn-sm btn-primary" disabled={!value} data-testid="passphrase-prompt-ok">OK</button>
        </div>
      </form>
    </Modal>
  );
}

/** "Encrypt this notebook…": what will be deleted, a passphrase, then the
 *  recovery key. */
export function EncryptNotebookDialog({ session, onClose }: { session: api.NotebookSession; onClose: () => void }) {
  const [plan, setPlan] = useState<api.EncryptionPlan | null>(null);
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<string | null>(null);

  useEffect(() => {
    api.encryptionPlan().then(setPlan).catch(e => setError(errorMessage(e)));
  }, []);

  const problem = passphraseProblem(pass, confirm);
  const run = async () => {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { flushPendingEdits } = await import("../lib/pendingEdits");
      await flushPendingEdits();
      const rk = await api.encryptNotebook(pass);
      // Content-derived webview copies of this notebook go too (PRD §4.5).
      const { forgetPlaintextWebviewState } = await import("../lib/webviewState");
      forgetPlaintextWebviewState(session.key);
      setRecovery(rk);
      notebooksChanged();
    } catch (e) {
      setError(friendly(e));
    } finally {
      setBusy(false);
    }
  };

  if (recovery) {
    return (
      <Modal title={`“${session.name}” is encrypted`} onClose={() => { if (window.confirm("Close without confirming you saved the recovery key?")) onClose(); }} testId="encrypt-notebook-dialog">
        <RecoveryKeyPanel notebook={session.name} recoveryKey={recovery} onDone={() => { refreshLockState(); onClose(); }} />
      </Modal>
    );
  }
  return (
    <Modal title={`Encrypt “${session.name}”`} onClose={onClose} wide testId="encrypt-notebook-dialog">
      {plan?.needs_folder ? (
        <p>
          This notebook lives in MiNotes' data folder. Move it to a folder of its own first
          (Manage notebooks → Move to a folder…), then encrypt it.
        </p>
      ) : (
        <>
          <p className="nb-hint">
            MiNotes writes an encrypted copy of the notebook, checks it, and only then replaces the
            current one. These are then <strong>deleted</strong>:
          </p>
          <ul className="enc-deletes" data-testid="encrypt-deletes">
            {(plan?.deletes ?? []).map(d => <li key={d}><code>{d}</code></li>)}
          </ul>
          <div className="nb-warning" role="note">
            The plain-markdown copy is deleted — an encrypted notebook has none, and git sync is off for it.
            {plan?.has_git && <> Its git history goes too; <strong>commits already pushed to a remote still contain your notes in plain text.</strong></>}
            {" "}Backups made before now (Time Machine, File History, cloud copies) still hold plain text, and on
            SSDs deleted files can't be wiped reliably.
          </div>
          <PassphraseFields value={pass} confirm={confirm} onChange={setPass} onConfirm={setConfirm} autoFocus idPrefix="encrypt" />
        </>
      )}
      {error && <div className="nb-field-error" role="alert">{error}</div>}
      <div className="nb-modal-actions">
        <button className="btn btn-sm" onClick={onClose} disabled={busy}>Cancel</button>
        {!plan?.needs_folder && (
          <button className="btn btn-sm btn-primary" onClick={run} disabled={!!problem || busy || !plan} data-testid="encrypt-notebook-go">
            {busy ? "Encrypting…" : "Encrypt notebook"}
          </button>
        )}
      </div>
    </Modal>
  );
}
