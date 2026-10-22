import { useState } from "react";
import * as api from "../lib/api";
import { withBusy } from "../lib/busy";
import { notebooksChanged, switchNotebook } from "../lib/notebooks";
import { applySyncStatus } from "../lib/syncStatus";
import { CREDENTIALS_NOTE, isEncryptedRemote, remoteError } from "../lib/syncRemote";
import Modal from "./Modal";
import RemoteAddressField from "./RemoteAddressField";

/**
 * "Join an existing notebook…" (one entry point for plain and encrypted
 * notebooks): the git remote another device syncs to, a name on this device —
 * and, when the remote turns out to hold an encrypted notebook, its passphrase
 * or recovery key. MiNotes fetches it into a new notebook folder, opens it and
 * turns sync on, which brings in every page. Nothing is sent to the remote
 * until it is open here.
 */
export default function JoinNotebookDialog({ onClose }: { onClose: () => void }) {
  const [remote, setRemote] = useState("");
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");
  /** The remote holds an encrypted notebook: the passphrase is needed. */
  const [encrypted, setEncrypted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const missing = !remote.trim() ? "Enter the remote's address." : !name.trim() ? "Name the notebook." : encrypted && !secret ? "Enter the passphrase or recovery key." : null;

  const join = async () => {
    if (missing || busy) return;
    setBusy(true);
    setError(null);
    try {
      await withBusy(`Joining “${name.trim()}”…`, async () => {
        const nb = await api.joinNotebook(remote.trim(), name.trim(), undefined, encrypted ? secret : undefined);
        setSecret("");
        await switchNotebook(nb.key);
        notebooksChanged();
        applySyncStatus(await api.gitSyncEnable());
        notebooksChanged();
        window.dispatchEvent(new Event("minotes-sidebar-refresh"));
        return nb;
      }, { done: (nb) => `Joined “${nb.name}” — it syncs with the other device`, failed: null });
      onClose();
    } catch (e) {
      if (isEncryptedRemote(e) && !encrypted) {
        setEncrypted(true);
        setError(null);
      } else {
        setError(api.isWrongPassphrase(e) ? "Wrong passphrase or recovery key." : remoteError(e));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Join an existing notebook" onClose={onClose} testId="join-notebook-dialog" wide>
      <form onSubmit={e => { e.preventDefault(); join(); }}>
        <p className="nb-hint">
          Another device already syncs a notebook to a git repository. MiNotes fetches it into a new notebook here and keeps
          the two in sync — plain or encrypted (then you need its passphrase).
        </p>
        <span className="nb-label">Remote address</span>
        <RemoteAddressField value={remote} onChange={v => { setRemote(v); setError(null); }} autoFocus disabled={busy} testId="join-remote" />
        <label className="nb-field">
          <span className="nb-label">Name on this device</span>
          <input className="search-input" value={name} onChange={e => setName(e.target.value)} aria-label="Notebook name" data-testid="join-name" disabled={busy} />
        </label>
        {encrypted && (
          <label className="nb-field" data-testid="join-encrypted">
            <span className="nb-label">This notebook is encrypted — its passphrase or recovery key</span>
            <input type="password" className="search-input" autoFocus value={secret} onChange={e => setSecret(e.target.value)}
              aria-label="Passphrase or recovery key" data-testid="join-passphrase" disabled={busy} />
          </label>
        )}
        <p className="nb-hint">{CREDENTIALS_NOTE}</p>
        {error && <div className="nb-field-error" role="alert" data-testid="join-error">{error}</div>}
        <div className="nb-modal-actions">
          {!busy && missing && <span className="disabled-reason" aria-live="polite">{missing}</span>}
          <button type="button" className="btn btn-sm" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !!missing} data-testid="join-go">
            {busy ? "Joining…" : "Join notebook"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
