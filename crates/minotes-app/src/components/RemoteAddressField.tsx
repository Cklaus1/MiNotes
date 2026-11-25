import { useRef, useState } from "react";
import * as api from "../lib/api";
import { useCapabilities } from "../lib/notebooks";
import { showToast } from "../lib/toast";
import { REMOTE_PLACEHOLDER, checkTitle, checkTone, remoteError } from "../lib/syncRemote";
import "./sync.css";

/**
 * A remote address with "Choose folder…" (desktop) and "Test connection".
 * The result is shown under it and reported to `onChecked` (null when the
 * address changes again).
 */
export default function RemoteAddressField({ value, onChange, onChecked, autoFocus, disabled, testId = "sync-remote" }: {
  value: string;
  onChange: (v: string) => void;
  onChecked?: (c: api.RemoteCheck | null) => void;
  autoFocus?: boolean;
  disabled?: boolean;
  testId?: string;
}) {
  const caps = useCapabilities();
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<api.RemoteCheck | null>(null);
  const tested = useRef("");
  const set = (c: api.RemoteCheck | null) => { setResult(c); onChecked?.(c); };
  const edit = (v: string) => {
    onChange(v);
    if (result && v.trim() !== tested.current) set(null);
  };
  const test = async () => {
    if (!value.trim() || checking) return;
    setChecking(true);
    try {
      tested.current = value.trim();
      set(await api.gitSyncTestRemote(value.trim()));
    } catch (e) {
      set({ status: "other", message: remoteError(e), branches: [], default_branch: null, warning: null, url: value.trim() });
    } finally {
      setChecking(false);
    }
  };
  const pick = async () => {
    try {
      const p = await api.pickSyncRemoteFolder();
      if (p) { onChange(p); set(null); }
    } catch (e) {
      showToast(`Couldn't choose a folder: ${remoteError(e)}`);
    }
  };
  return (
    <div className="sync-remote-field">
      <div className="sync-remote-input-row">
        <input
          className="search-input"
          value={value}
          onChange={e => edit(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); test(); } }}
          placeholder={REMOTE_PLACEHOLDER}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoFocus={autoFocus}
          disabled={disabled}
          aria-label="Remote address (git repository)"
          data-testid={`${testId}-input`}
        />
        {caps.open_folder && (
          <button type="button" className="btn btn-sm" onClick={pick} disabled={disabled}
            title="A bare git repository on a drive or a shared folder" data-testid={`${testId}-pick`}>
            Choose folder…
          </button>
        )}
        <button type="button" className="btn btn-sm" onClick={test} disabled={disabled || checking || !value.trim()}
          title="Check that git can reach it with your sign-in (nothing is changed)" data-testid={`${testId}-test`}>
          {checking ? "Testing…" : "Test connection"}
        </button>
      </div>
      {result && (
        <div className={`sync-remote-result ${checkTone(result)}`} role="status" data-testid={`${testId}-result`} data-status={result.status}>
          <span className="sync-remote-result-title">{checkTitle(result.status)}</span>
          <span className="sync-remote-result-text">{result.message}</span>
          {result.warning && <span className="sync-remote-result-text">{result.warning}</span>}
        </div>
      )}
    </div>
  );
}
