import { useCallback, useEffect, useState } from "react";
import * as api from "../lib/api";
import { errorMessage } from "../lib/errors";
import { showToast } from "../lib/toast";
import { lockNow, refreshLockState, LOCK_CHANGED } from "../lib/encryption";
import { NOTEBOOKS_CHANGED, NOTEBOOK_SWITCHED, notebooksChanged, useCapabilities } from "../lib/notebooks";
import { passphraseProblem } from "../lib/passphrase";
import { updateSettings, useSettings } from "../lib/settings";
import { EncryptNotebookDialog, PassphraseFields, RecoveryKeyPanel } from "./EncryptionDialogs";
import Modal from "./Modal";

type Dialog = null | "encrypt" | "change" | "recovery" | "rotate" | "decrypt";

/** Ask for the current passphrase, then run `action` with it. */
function PassphraseAction({ title, intro, button, danger, onRun, onClose }: {
  title: string;
  intro: string;
  button: string;
  danger?: boolean;
  onRun: (passphrase: string) => Promise<string | void>;
  onClose: () => void;
}) {
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [name, setName] = useState("");
  useEffect(() => { api.getNotebookSession().then(s => setName(s.name)).catch(() => {}); }, []);
  const run = async () => {
    if (!pass || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await onRun(pass);
      if (typeof r === "string" && r) setKey(r);
      else onClose();
    } catch (e) {
      setError(api.isWrongPassphrase(e) ? "Wrong passphrase." : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  if (key) {
    return (
      <Modal title={title} onClose={() => { if (window.confirm("Close without confirming you saved the new recovery key?")) onClose(); }}>
        <RecoveryKeyPanel notebook={name} recoveryKey={key} onDone={onClose} />
        <p className="nb-hint">The previous recovery key no longer works.</p>
      </Modal>
    );
  }
  return (
    <Modal title={title} onClose={onClose} testId="security-passphrase-dialog">
      <form onSubmit={e => { e.preventDefault(); run(); }}>
        <p className="nb-hint">{intro}</p>
        <label className="nb-field">
          <span className="nb-label">Passphrase</span>
          <input type="password" className="search-input" autoFocus value={pass} onChange={e => setPass(e.target.value)}
            aria-label="Passphrase" data-testid="security-passphrase" />
        </label>
        {error && <div className="nb-field-error" role="alert">{error}</div>}
        <div className="nb-modal-actions">
          <button type="button" className="btn btn-sm" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className={`btn btn-sm ${danger ? "btn-danger" : "btn-primary"}`} disabled={!pass || busy} data-testid="security-go">
            {busy ? "Working…" : button}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ChangePassphraseDialog({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = passphraseProblem(next, confirm);
  const run = async () => {
    if (problem || !current || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.changePassphrase(current, next);
      showToast("Passphrase changed");
      onClose();
    } catch (e) {
      setError(api.isWrongPassphrase(e) ? "The current passphrase is wrong." : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Change passphrase" onClose={onClose} testId="change-passphrase-dialog">
      <form onSubmit={e => { e.preventDefault(); run(); }}>
        <label className="nb-field">
          <span className="nb-label">Current passphrase</span>
          <input type="password" className="search-input" autoFocus value={current} onChange={e => setCurrent(e.target.value)}
            aria-label="Current passphrase" data-testid="change-current" />
        </label>
        <PassphraseFields value={next} confirm={confirm} onChange={setNext} onConfirm={setConfirm} label="New passphrase" idPrefix="change" />
        <p className="nb-hint">The notebook isn't rewritten; devices that keep it unlocked stay unlocked.</p>
        {error && <div className="nb-field-error" role="alert">{error}</div>}
        <div className="nb-modal-actions">
          <button type="button" className="btn btn-sm" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-sm btn-primary" disabled={!!problem || !current || busy} data-testid="change-go">
            {busy ? "Changing…" : "Change passphrase"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

const AUTO_LOCK_CHOICES: Array<[number, string]> = [[1, "1 minute"], [5, "5 minutes"], [15, "15 minutes"], [30, "30 minutes"], [60, "1 hour"], [0, "Never (until quit)"]];

/**
 * Settings → Security (PRD-encryption §5): for an encrypted notebook — lock now,
 * keep unlocked on this device, auto-lock, change passphrase, new recovery key,
 * rotate the key, remove encryption; for another — "Encrypt this notebook…".
 */
export default function SecuritySettings() {
  const [session, setSession] = useState<api.NotebookSession | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const settings = useSettings();
  const caps = useCapabilities();

  const load = useCallback(() => {
    api.getNotebookSession().then(s => setSession(s ?? null)).catch(() => {});
  }, []);
  useEffect(() => {
    load();
    const evs = [NOTEBOOKS_CHANGED, NOTEBOOK_SWITCHED, LOCK_CHANGED];
    evs.forEach(e => window.addEventListener(e, load));
    return () => evs.forEach(e => window.removeEventListener(e, load));
  }, [load]);

  if (!session) return null;
  const close = () => { setDialog(null); load(); notebooksChanged(); };

  const toggleRemember = async (on: boolean) => {
    try {
      setSession(await api.setRememberDevice(on));
      showToast(on ? "This device keeps the notebook unlocked" : "Forgotten on this device");
    } catch (e) {
      showToast(`Couldn't change it: ${errorMessage(e)}`);
    }
  };

  return (
    <div className="settings-section" data-section="security">
      <div className="settings-section-title">Security</div>
      {session.encrypted ? (
        <>
          <div className="settings-row">
            <span className="settings-row-label">🔒 “{session.name}” is encrypted</span>
            <button className="btn btn-sm" onClick={() => lockNow().catch(e => showToast(errorMessage(e)))} data-testid="security-lock-now">
              Lock now
            </button>
          </div>
          <div className="settings-row">
            <span className="settings-row-label" title={session.keychain_available ? "The key is kept in this device's keychain" : "This device has no keychain MiNotes can use"}>
              Keep unlocked on this device
            </span>
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={!!session.remembered}
                disabled={!session.keychain_available || !caps.keychain}
                onChange={e => toggleRemember(e.target.checked)}
                data-testid="security-remember"
              />
              <span className="settings-toggle-slider" />
            </label>
          </div>
          <div className="settings-row">
            <span className="settings-row-label">Lock after</span>
            <select
              className="settings-select"
              value={settings.autoLockMinutes}
              onChange={e => updateSettings({ autoLockMinutes: Number(e.target.value) })}
              data-testid="security-auto-lock"
            >
              {AUTO_LOCK_CHOICES.map(([m, label]) => <option key={m} value={m}>{label}{m ? " without input" : ""}</option>)}
            </select>
          </div>
          <div className="settings-row">
            <span className="settings-row-label">Passphrase</span>
            <button className="btn btn-sm" onClick={() => setDialog("change")} data-testid="security-change">Change…</button>
          </div>
          <div className="settings-row">
            <span className="settings-row-label">Recovery key</span>
            <button className="btn btn-sm" onClick={() => setDialog("recovery")} data-testid="security-recovery">New recovery key…</button>
          </div>
          <div className="settings-row">
            <span className="settings-row-label">Advanced</span>
            <span style={{ display: "flex", gap: 6 }}>
              <button className="btn btn-sm" onClick={() => setDialog("rotate")} title="Re-encrypt with a new key (after a suspected compromise)">Rotate key…</button>
              <button className="btn btn-sm btn-danger" onClick={() => setDialog("decrypt")} data-testid="security-decrypt">Remove encryption…</button>
            </span>
          </div>
        </>
      ) : (
        <div className="settings-row">
          <span className="settings-row-label">Encryption</span>
          <button className="btn btn-sm" onClick={() => setDialog("encrypt")} disabled={session.read_only} data-testid="security-encrypt">
            Encrypt this notebook…
          </button>
        </div>
      )}
      {dialog === "encrypt" && <EncryptNotebookDialog session={session} onClose={() => { close(); refreshLockState(); }} />}
      {dialog === "change" && <ChangePassphraseDialog onClose={close} />}
      {dialog === "recovery" && (
        <PassphraseAction
          title="New recovery key"
          intro="A new recovery key replaces the current one, which stops working. Enter the passphrase to continue."
          button="Make a new recovery key"
          onRun={p => api.regenerateRecoveryKey(p)}
          onClose={close}
        />
      )}
      {dialog === "rotate" && (
        <PassphraseAction
          title="Rotate the encryption key"
          intro="Re-encrypts the whole notebook with a new key (for a suspected compromise). The passphrase stays; you get a new recovery key, and devices that kept the notebook unlocked must unlock it again."
          button="Rotate key"
          onRun={p => api.rotateNotebookKey(p)}
          onClose={close}
        />
      )}
      {dialog === "decrypt" && (
        <PassphraseAction
          title="Remove encryption"
          intro="The notebook is rewritten unencrypted: anyone who can read its folder can read your notes again, and the markdown copy comes back. Enter the passphrase to continue."
          button="Remove encryption"
          danger
          onRun={async p => { await api.decryptNotebook(p); showToast("Encryption removed"); await refreshLockState(); }}
          onClose={close}
        />
      )}
    </div>
  );
}
