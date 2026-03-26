import { useState, useEffect } from "react";
import { getSettings, updateSettings, type MiNotesSettings } from "../lib/settings";
import { getTheme, setTheme } from "../lib/theme";
import * as api from "../lib/api";

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function SettingsPanel({ open, onClose }: Props) {
  const [settings, setSettings] = useState<MiNotesSettings>(getSettings);
  const [currentTheme, setCurrentTheme] = useState(getTheme);
  const [stats, setStats] = useState<api.GraphStats | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [activeTooltip, setActiveTooltip] = useState<string | null>(null);
  const tooltipTimerRef = { current: null as ReturnType<typeof setTimeout> | null };

  useEffect(() => {
    if (open) {
      api.getGraphStats().then(setStats).catch(() => {});
      setSettings(getSettings());
      setCurrentTheme(getTheme());
    }
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const toggle = (key: keyof MiNotesSettings, value: any) => {
    const updated = updateSettings({ [key]: value });
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
          <button className="settings-close-btn" onClick={onClose}>×</button>
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
        </div>

        {/* Keyboard shortcuts */}
        <div className="settings-section">
          <div className="settings-section-title">Keyboard Shortcuts</div>
          <div className="shortcuts-grid">
            {[
              ["Ctrl+K", "Search"],
              ["Ctrl+J", "Journal"],
              ["Ctrl+N", "New Page"],
              ["Ctrl+G", "Graph"],
              ["Ctrl+M", "Mind Map"],
              ["Ctrl+W", "Draw"],
              ["Ctrl+,", "Settings"],
              ["Ctrl+Z", "Undo"],
              ["/", "Commands"],
              ["Tab", "Indent"],
              ["Enter", "New Block"],
              ["Esc", "Close"],
            ].map(([key, desc]) => (
              <div key={key} className="shortcut-row">
                <kbd className="shortcut-key">{key}</kbd>
                <span className="shortcut-desc">{desc}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Workspace */}
        {stats && (
          <div className="settings-section">
            <div className="settings-section-title">Workspace</div>
            <div className="settings-workspace-stats">
              {stats.pages} pages · {stats.blocks} blocks · {stats.links} links
            </div>
          </div>
        )}

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
      </div>
    </>
  );
}
