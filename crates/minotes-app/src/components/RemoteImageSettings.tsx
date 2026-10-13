import { useEffect, useState } from "react";
import {
  notebookAlways, remoteImageMode, setNotebookAlways, setRemoteImageMode,
  REMOTE_IMAGES_CHANGED, type RemoteImageMode,
} from "../lib/remoteImages";

/** Settings → Privacy: remote images (Never / Ask / Always) + this notebook's override. */
export default function RemoteImageSettings() {
  const [mode, setMode] = useState<RemoteImageMode>(remoteImageMode);
  const [always, setAlways] = useState(() => notebookAlways());

  useEffect(() => {
    const sync = () => { setMode(remoteImageMode()); setAlways(notebookAlways()); };
    window.addEventListener(REMOTE_IMAGES_CHANGED, sync);
    return () => window.removeEventListener(REMOTE_IMAGES_CHANGED, sync);
  }, []);

  return (
    <div className="settings-section" data-testid="remote-image-settings">
      <div className="settings-section-title">Privacy</div>
      <div className="settings-row">
        <span className="settings-row-label" title="Images from the web can tell their server when you open a note">
          Remote images
        </span>
        <select
          className="settings-select"
          aria-label="Remote images"
          data-testid="remote-images-mode"
          value={mode}
          onChange={(e) => { const m = e.target.value as RemoteImageMode; setRemoteImageMode(m); setMode(m); }}
        >
          <option value="never">Never load</option>
          <option value="ask">Ask (blocked until I load them)</option>
          <option value="always">Always load</option>
        </select>
      </div>
      {mode === "ask" && (
        <div className="settings-row">
          <span className="settings-row-label">Always load in this notebook</span>
          <label className="settings-toggle">
            <input
              type="checkbox"
              aria-label="Always load remote images in this notebook"
              data-testid="remote-images-notebook"
              checked={always}
              onChange={(e) => { setNotebookAlways(e.target.checked); setAlways(e.target.checked); }}
            />
            <span className="settings-toggle-slider" />
          </label>
        </div>
      )}
    </div>
  );
}
