import { useState, useEffect, useRef } from "react";
import NotebookSettings from "./NotebookSettings";
import RemoteImageSettings from "./RemoteImageSettings";
import SecuritySettings from "./SecuritySettings";
import { prettyPath } from "../lib/notebooks";
import { getSettings, updateSettings, type MiNotesSettings } from "../lib/settings";
import { getTheme, setTheme } from "../lib/theme";
import * as api from "../lib/api";
import { errorMessage } from "../lib/errors";
import { showToast } from "../lib/toast";
import {
  ago, applySyncStatus, errorHint, errorTitle, requestSyncNow, SYNC_CONFIRM_EVENT, takeSyncSettingsTarget, useSyncView,
} from "../lib/syncStatus";
import SyncRemoteSettings from "./SyncRemoteSettings";
import "./sync.css";
import { useLayer } from "../lib/layers";
import { useDialogFocus } from "../lib/dialogFocus";
import ShortcutsList from "./ShortcutsList";
import TemplatesSettings from "./TemplatesSettings";
import { takeSettingsSection } from "../lib/settingsTarget";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Open the Page versions panel (local snapshots, not git sync). */
  onOpenSync?: () => void;
  /** Open the CSS snippets manager. */
  onOpenCssSnippets?: () => void;
}


/** Where sync stands, honestly: paused, failing (and why), local only, or when
 *  it last reached the remote — with Sync now / Retry / Sync it here. */
function SyncStateBox({ syncDir }: { syncDir: string }) {
  const v = useSyncView();
  const s = v.status;
  if (!s?.enabled) return null;
  const remote = s.remote_url;
  const syncNow = (
    <button className="btn btn-sm btn-primary" disabled={v.phase === "syncing"} onClick={requestSyncNow} data-testid="settings-sync-now">
      {v.phase === "syncing" ? "Syncing…" : v.phase === "error" || v.phase === "offline" ? "Retry" : "Sync now"}
    </button>
  );
  if (v.phase === "paused") {
    return (
      <div className="settings-sync-state paused" data-testid="settings-sync-state" data-phase="paused">
        <span className="settings-sync-state-title">Paused — waiting for your OK</span>
        <span className="settings-sync-state-text">
          This notebook folder was set up for sync on another computer. It doesn't sync here until you choose “Sync it here”.
        </span>
        <div className="settings-sync-state-actions">
          <button className="btn btn-sm btn-primary" onClick={() => window.dispatchEvent(new Event(SYNC_CONFIRM_EVENT))}>Sync it here</button>
        </div>
      </div>
    );
  }
  if (v.phase === "error" || v.phase === "offline") {
    return (
      <div className={`settings-sync-state ${v.phase}`} data-testid="settings-sync-state" data-phase={v.phase} role="alert">
        <span className="settings-sync-state-title">{errorTitle(v.errorKind)}</span>
        <span className="settings-sync-state-text">{errorHint(v.errorKind)}</span>
        {v.error && <span className="sync-pop-error" data-testid="settings-sync-error">{v.error}</span>}
        {remote && <span className="settings-sync-state-text">Remote: {remote}</span>}
        {s.last_sync && <span className="settings-sync-state-text">Last synced {ago(s.last_sync)}</span>}
        <div className="settings-sync-state-actions">{syncNow}</div>
      </div>
    );
  }
  if (!remote) {
    return (
      <div className="settings-sync-state" data-testid="settings-sync-state" data-phase="local">
        <span className="settings-sync-state-title">On — but no remote yet</span>
        <span className="settings-sync-state-text">
          Changes are committed in the sync folder ({syncDir}), a git repository, and sent nowhere else.
          To sync with your other devices, set up a remote below.
        </span>
        <div className="settings-sync-state-actions">{syncNow}</div>
      </div>
    );
  }
  return (
    <div className="settings-sync-state ok" data-testid="settings-sync-state" data-phase={v.phase}>
      <span className="settings-sync-state-title">{v.phase === "syncing" ? "Syncing…" : s.last_sync ? `Synced ${ago(s.last_sync)}` : "Not synced yet"}</span>
      {s.last_sync && <span className="settings-sync-state-text" data-testid="settings-last-synced">Last synced {new Date(s.last_sync).toLocaleString()}</span>}
      <div className="settings-sync-state-actions">{syncNow}</div>
    </div>
  );
}

export default function SettingsPanel({ open, onClose, onOpenSync, onOpenCssSnippets }: Props) {
  const [settings, setSettings] = useState<MiNotesSettings>(getSettings);
  const [currentTheme, setCurrentTheme] = useState(getTheme);
  const [stats, setStats] = useState<api.GraphStats | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [activeTooltip, setActiveTooltip] = useState<string | null>(null);
  const tooltipTimerRef = { current: null as ReturnType<typeof setTimeout> | null };
  const [gitInstalled, setGitInstalled] = useState<boolean | null>(null);
  const syncStatus = useSyncView().status;
  const [syncLoading, setSyncLoading] = useState(false);
  const [showSyncAdvanced, setShowSyncAdvanced] = useState(false);
  const [syncDir, setSyncDir] = useState("~/MiNotes_Sync");
  /** Encrypted notebooks sync encrypted files only (PRD-encryption §4.5). */
  const [encrypted, setEncrypted] = useState(false);
  const [notebookName, setNotebookName] = useState("this notebook");

  useEffect(() => {
    if (open) {
      api.getGraphStats().then(setStats).catch(() => {});
      setSettings(getSettings());
      setCurrentTheme(getTheme());
      api.gitAvailable().then(setGitInstalled).catch(() => setGitInstalled(false));
      api.gitSyncStatus().then(applySyncStatus).catch(() => {});
      api.getNotebookSession().then(s => {
        if (s?.mirror_dir) setSyncDir(prettyPath(s.mirror_dir));
        setEncrypted(!!s?.encrypted);
        if (s?.name) setNotebookName(s.name);
      }).catch(() => {});
    }
  }, [open]);

  // Esc closes Settings when it is the topmost layer (lib/layers.ts).
  useLayer(open, "panel", onClose);

  const panelRef = useRef<HTMLDivElement>(null);
  useDialogFocus(panelRef, open, { trap: false, initialFocus: false });
  // Section index (jump links): built from the section titles actually shown
  // (Security, Sync… depend on the notebook), so it never lists a missing one.
  const [sections, setSections] = useState<string[]>([]);
  useEffect(() => {
    if (!open) return;
    const read = () => {
      const titles = [...(panelRef.current?.querySelectorAll(".settings-section > .settings-section-title") ?? [])]
        .map(t => (t.textContent ?? "").trim()).filter(Boolean);
      setSections(prev => (prev.join("|") === titles.join("|") ? prev : titles));
    };
    read();
    const mo = new MutationObserver(read);
    if (panelRef.current) mo.observe(panelRef.current, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [open]);
  const jumpTo = (title: string) => {
    const t = [...(panelRef.current?.querySelectorAll(".settings-section > .settings-section-title") ?? [])]
      .find(e => (e.textContent ?? "").trim() === title);
    const section = t?.parentElement as HTMLElement | undefined;
    if (!section || !panelRef.current) return;
    const header = panelRef.current.querySelector<HTMLElement>(".settings-sticky");
    panelRef.current.scrollTo({ top: section.offsetTop - (header?.offsetHeight ?? 0), behavior: "smooth" });
    (section.querySelector<HTMLElement>("select, input, button") ?? null)?.focus({ preventScroll: true });
  };
  // Opened from the sync chip ("Sync settings…"): go to Sync & Backup once
  // that section is there (it waits for "is git installed?").
  const wantSync = useRef(false);
  useEffect(() => { if (open && takeSyncSettingsTarget()) wantSync.current = true; }, [open]);
  useEffect(() => {
    if (!open || !wantSync.current || !sections.includes("Sync & Backup")) return;
    wantSync.current = false;
    setTimeout(() => jumpTo("Sync & Backup"), 50);
  }, [open, sections]);
  // Any other section asked for by name (e.g. project settings → "Security").
  const wantSection = useRef<string | null>(null);
  useEffect(() => { if (open) { const t = takeSettingsSection(); if (t) wantSection.current = t; } }, [open]);
  useEffect(() => {
    const t = wantSection.current;
    if (!open || !t || !sections.includes(t)) return;
    wantSection.current = null;
    setTimeout(() => jumpTo(t), 50);
  }, [open, sections]);

  if (!open) return null;

  const toggle = (key: keyof MiNotesSettings, value: any) => {
    const updated = updateSettings({ [key]: value });
    setSettings(updated);
  };

  const toggleAi = (key: keyof NonNullable<MiNotesSettings["ai"]>, value: boolean) => {
    const current = settings.ai ?? { autoTag: true, linkSuggestions: true, todoExtraction: true };
    const updated = updateSettings({ ai: { ...current, [key]: value } });
    setSettings(updated);
  };

  const handleThemeChange = (theme: "dark" | "light") => {
    setTheme(theme);
    setCurrentTheme(theme);
  };

  return (
    <>
      {/* Click-outside overlay to close */}
      <div className="settings-backdrop" onClick={onClose} />

      <div ref={panelRef} className="settings-slide-panel" role="dialog" aria-label="Settings" data-testid="settings-panel">
        {/* Header + section index, kept in view while the panel scrolls */}
        <div className="settings-sticky">
          <div className="settings-header">
            <span className="settings-title">Settings</span>
            <button className="settings-close-btn" onClick={onClose} title="Close settings (Esc)" aria-label="Close settings">×</button>
          </div>
          {sections.length > 2 && (
            <nav className="settings-index" aria-label="Settings sections" data-testid="settings-index">
              {sections.map(s => (
                <button key={s} type="button" className="settings-index-link" onClick={() => jumpTo(s)}>
                  {s.replace(/^Keyboard Shortcuts$/, "Shortcuts").replace(/^Smart suggestions$/, "Suggestions")}
                </button>
              ))}
            </nav>
          )}
        </div>

        {/* Appearance */}
        <div className="settings-section">
          <div className="settings-section-title">Appearance</div>
          <div className="settings-row">
            <span className="settings-row-label">Theme</span>
            <select
              className="settings-select"
              value={currentTheme}
              onChange={e => handleThemeChange(e.target.value as "dark" | "light")}
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </div>
          {onOpenCssSnippets && (
            <div className="settings-row">
              <span className="settings-row-label">Custom CSS</span>
              <button className="btn btn-sm" onClick={() => { onClose(); onOpenCssSnippets(); }}>
                CSS snippets…
              </button>
            </div>
          )}
        </div>

        {/* Notebook: location + markdown copy (mirror) status */}
        <NotebookSettings />

        {/* Security: encryption, lock, passphrase, recovery key */}
        <SecuritySettings />

        {/* Privacy: remote images (blocked by default) */}
        <RemoteImageSettings />

        {/* Sync & Backup */}
        {gitInstalled && (
          <div className="settings-section">
            <div className="settings-section-title">Sync &amp; Backup</div>
            <div className="settings-row">
              <span className="settings-row-label">Enable Sync</span>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  aria-label="Enable sync"
                  data-testid="sync-enable"
                  checked={syncStatus?.enabled ?? false}
                  disabled={syncLoading}
                  onChange={async (e) => {
                    setSyncLoading(true);
                    const on = e.target.checked;
                    try {
                      if (on) {
                        applySyncStatus(await api.gitSyncEnable());
                      } else {
                        await api.gitSyncDisable();
                        applySyncStatus(await api.gitSyncStatus().catch(() => null));
                      }
                    } catch (err) {
                      showToast(`Couldn't turn sync ${on ? "on" : "off"}: ${errorMessage(err)}`);
                    } finally {
                      setSyncLoading(false);
                    }
                  }}
                />
                <span className="settings-toggle-slider" />
              </label>
            </div>
            {encrypted && (
              <div className="nb-hint" data-testid="sync-encrypted-note">
                This notebook is encrypted: git moves only encrypted files (opaque names, no titles or text).
                Other devices join it with “Join an existing notebook…” and the passphrase.
              </div>
            )}
            {syncStatus?.enabled && <SyncStateBox syncDir={syncDir} />}
            <SyncRemoteSettings encrypted={encrypted} notebookName={notebookName} />
            {syncStatus?.enabled && (
              <>
                <div
                  className="settings-advanced-toggle"
                  onClick={() => setShowSyncAdvanced(v => !v)}
                  style={{ marginTop: 4 }}
                >
                  <span>{showSyncAdvanced ? "▼" : "▶"} Show advanced</span>
                </div>
                {showSyncAdvanced && (
                  <div className="settings-advanced-content">
                    <div className="settings-row">
                      <span className="settings-row-label">Directory</span>
                      <span className="settings-row-value" title="The markdown copy is the git repository">{syncDir}</span>
                    </div>
                    <div className="settings-row">
                      <span className="settings-row-label">Branch</span>
                      <span className="settings-row-value">
                        {syncStatus.branch ?? "\u2014"}
                      </span>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Version history (works without git sync too) */}
        {onOpenSync && (
          <div className="settings-section">
            <div className="settings-section-title">History</div>
            <div className="settings-row">
              <span className="settings-row-label" title="Snapshots of a page saved on this device, to restore an earlier version. Not git sync.">
                Saved versions of pages
              </span>
              <button className="btn btn-sm" onClick={() => { onClose(); onOpenSync(); }}>
                Page versions…
              </button>
            </div>
          </div>
        )}

        {/* Keyboard shortcuts */}
        <div className="settings-section">
          <div className="settings-section-title">Keyboard Shortcuts</div>
          <ShortcutsList />
        </div>

        <TemplatesSettings />

        {/* Smart suggestions — local heuristics, no AI model involved; its own
            always-visible section (not part of Advanced, which stays last). The
            AI provider (Ask) has its own dialog, linked from here. */}
        <div className="settings-section" data-section="ai">
          <div className="settings-section-title">Smart suggestions</div>
          <div className="nb-hint">Worked out on this device from your notes — nothing is sent anywhere.</div>
          {([
            ["autoTag", "Suggest tags", "Suggest tags for a page from its content"],
            ["linkSuggestions", "Suggest links", "Suggest related pages to link from the current page"],
            ["todoExtraction", "Collect TODOs", "Gather TODOs from all notes into the sidebar count"],
          ] as const).map(([key, label, hint]) => (
            <div className="settings-row" key={key}>
              <span className="settings-row-label" title={hint}>{label}</span>
              <label className="settings-toggle" title={hint}>
                <input
                  type="checkbox"
                  aria-label={label}
                  checked={settings.ai?.[key] ?? true}
                  onChange={e => toggleAi(key, e.target.checked)}
                />
                <span className="settings-toggle-slider" />
              </label>
            </div>
          ))}
          <div className="settings-row">
            <span className="settings-row-label" title="Ask questions about your notes with an AI model you choose (Ctrl+Shift+A)">
              Ask AI (model and privacy)
            </span>
            <button
              className="btn btn-sm"
              data-testid="settings-ai-provider"
              onClick={() => { onClose(); window.dispatchEvent(new CustomEvent("minotes:open-ai", { detail: "settings" })); }}
            >
              AI provider…
            </button>
          </div>
        </div>

        {/* Advanced — collapsible */}
        <div className="settings-section">
          <div
            className="settings-advanced-toggle"
            onClick={() => setShowAdvanced((v) => !v)}
          >
            <span>{showAdvanced ? "▼" : "▶"} Advanced</span>
          </div>
          {showAdvanced && (
            <div className="settings-advanced-content">
              <div className="settings-row">
                <span className="settings-row-label">
                  Full Tree Mode
                  <span
                    className="settings-info-icon"
                    onMouseEnter={() => { tooltipTimerRef.current = setTimeout(() => setActiveTooltip("tree"), 250); }}
                    onMouseLeave={() => { if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current); if (activeTooltip === "tree") setActiveTooltip(null); }}
                    onClick={() => setActiveTooltip(activeTooltip === "tree" ? null : "tree")}
                  >
                    ?
                    {activeTooltip === "tree" && (
                      <span className="settings-tooltip">Show block connectors</span>
                    )}
                  </span>
                </span>
                <label className="settings-toggle">
                  <input
                    type="checkbox"
                    checked={settings.fullTreeMode}
                    onChange={e => toggle("fullTreeMode", e.target.checked)}
                  />
                  <span className="settings-toggle-slider" />
                </label>
              </div>
              <div className="settings-row">
                <span className="settings-row-label">
                  Source Editing Mode
                  <span
                    className="settings-info-icon"
                    onMouseEnter={() => { tooltipTimerRef.current = setTimeout(() => setActiveTooltip("source"), 250); }}
                    onMouseLeave={() => { if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current); if (activeTooltip === "source") setActiveTooltip(null); }}
                    onClick={() => setActiveTooltip(activeTooltip === "source" ? null : "source")}
                  >
                    ?
                    {activeTooltip === "source" && (
                      <span className="settings-tooltip">Edit blocks in a source-style editor (like Obsidian). Required for some plugins.</span>
                    )}
                  </span>
                </span>
                <label className="settings-toggle">
                  <input
                    type="checkbox"
                    checked={settings.obsidianEditorEnabled}
                    onChange={e => toggle("obsidianEditorEnabled", e.target.checked)}
                  />
                  <span className="settings-toggle-slider" />
                </label>
              </div>
              {settings.obsidianEditorEnabled && (
                <div className="settings-row">
                  <span className="settings-row-label">Default Editor</span>
                  <select
                    className="settings-select"
                    value={settings.defaultEditorMode}
                    onChange={e => toggle("defaultEditorMode", e.target.value)}
                  >
                    <option value="minotes">MiNotes</option>
                    <option value="obsidian">Obsidian</option>
                  </select>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Workspace — bottom, light status info */}
        {stats && (
          <div className="settings-workspace">
            {stats.pages} pages · {stats.blocks} blocks · {stats.links} links
          </div>
        )}
      </div>
    </>
  );
}
