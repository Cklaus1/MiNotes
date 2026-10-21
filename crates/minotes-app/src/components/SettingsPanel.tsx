import { useState, useEffect } from "react";
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
  ago, applySyncStatus, errorHint, errorTitle, requestSyncNow, SYNC_CONFIRM_EVENT, useSyncView,
} from "../lib/syncStatus";
import "./sync.css";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Open the Page versions panel (local snapshots, not git sync). */
  onOpenSync?: () => void;
  /** Open the CSS snippets manager. */
  onOpenCssSnippets?: () => void;
}

// Every shortcut listed here was pressed in the real app and does what it says.
// Grouped by where it works; keep in sync with App.tsx and the views' handlers.
const SHORTCUT_GROUPS: Array<{ title: string; items: Array<[string, string]> }> = [
  {
    title: "Anywhere (also while editing a block)",
    items: [
      ["Ctrl+K", "Search; type > for commands"],
      ["Ctrl+J", "Today's journal"],
      ["Ctrl+N", "New page"],
      ["Ctrl+1 … Ctrl+7", "Open pinned page 1–7"],
      ["Ctrl+G", "Graph view"],
      ["Ctrl+M", "Mind map"],
      ["Ctrl+Shift+K", "Kanban board"],
      ["Ctrl+W", "New whiteboard (Draw)"],
      ["Ctrl+Q", "SQL query panel"],
      ["Ctrl+R", "Flashcard review"],
      ["Ctrl+P", "Open a PDF by path"],
      ["Ctrl+Shift+C", "Copy the page as text"],
      ["Ctrl+Shift+T", "Toggle light/dark theme"],
      ["Ctrl+Shift+L", "Lock an encrypted notebook"],
      ["Ctrl+,", "Settings"],
      ["Ctrl+\\", "Show/hide the right sidebar"],
      ["Esc", "Close the open panel, menu or view"],
    ],
  },
  {
    title: "Page (no block being edited)",
    items: [
      ["Ctrl+Z", "Undo (also restores a page you just deleted)"],
      ["Ctrl+Shift+Z", "Redo"],
      ["Ctrl+A", "Select all blocks"],
      ["Shift+click", "Extend the block selection"],
      ["Del / Backspace", "Delete the selected blocks"],
    ],
  },
  {
    title: "While editing a block",
    items: [
      ["Enter", "New block"],
      ["Tab", "Indent"],
      ["Esc", "Outdent a nested block"],
      ["Backspace", "At the start: merge into the block above"],
      ["Ctrl+Enter", "Cycle TODO → DOING → DONE"],
      ["Ctrl+B / Ctrl+I / Ctrl+E", "Bold / italic / inline code"],
      ["Ctrl+Z", "Undo typing"],
      ["/", "Insert menu (headings, todo, table, whiteboard…)"],
      ["[[", "Link to a page"],
      ["Alt+→ / Alt+←", "Zoom into the block / back out"],
    ],
  },
  {
    title: "Whiteboard",
    items: [
      ["S / D / T / A / B", "Select / draw / text / arrow / box tool"],
      ["F", "Fit everything in view"],
      ["Arrows", "Move the selected item (Shift: 10 px)"],
      ["Enter", "Edit the selected note or text"],
      ["Esc", "Back to Select, then close"],
    ],
  },
  {
    title: "Kanban",
    items: [
      ["Ctrl+F or /", "Filter cards"],
      ["Arrows", "Move between cards and columns"],
      ["N", "New card in the focused card's column"],
    ],
  },
  {
    title: "Mind map",
    items: [
      ["Arrows", "Move between nodes"],
      ["Tab / Enter", "Add a child / a sibling"],
      ["Del", "Delete the node"],
      ["Hold M", "Show the minimap"],
    ],
  },
  {
    title: "Flashcard review",
    items: [
      ["Space / Enter", "Show the answer"],
      ["1 / 2 / 3 / 4", "Again / hard / good / easy"],
    ],
  },
];

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
          To sync with other devices, add a remote to it (<code>git remote add origin &lt;url&gt;</code>).
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
      }).catch(() => {});
    }
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

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

      <div className="settings-slide-panel">
        {/* Header */}
        <div className="settings-header">
          <span className="settings-title">Settings</span>
          <button className="settings-close-btn" onClick={onClose} title="Close settings (Esc)" aria-label="Close settings">×</button>
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
                Other devices join it with “Join encrypted notebook…” and the passphrase.
              </div>
            )}
            {syncStatus?.enabled && (
              <>
                <SyncStateBox syncDir={syncDir} />
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
                      <span className="settings-row-label">Remote</span>
                      <span className="settings-row-value">
                        {syncStatus.remote_url ?? "Not configured"}
                      </span>
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
              <span className="settings-row-label">Sync status &amp; page versions</span>
              <button className="btn btn-sm" onClick={() => { onClose(); onOpenSync(); }}>
                Sync &amp; version history…
              </button>
            </div>
          </div>
        )}

        {/* Keyboard shortcuts */}
        <div className="settings-section">
          <div className="settings-section-title">Keyboard Shortcuts</div>
          {SHORTCUT_GROUPS.map(group => (
            <div key={group.title} className="shortcuts-group">
              <div className="shortcuts-group-title">{group.title}</div>
              <div className="shortcuts-grid">
                {group.items.map(([key, desc]) => (
                  <div key={key + desc} className="shortcut-row">
                    <kbd className="shortcut-key">{key}</kbd>
                    <span className="shortcut-desc">{desc}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* AI Assistant — its own always-visible section (not part of Advanced, which stays last) */}
        <div className="settings-section" data-section="ai">
          <div className="settings-section-title">AI Assistant</div>
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
