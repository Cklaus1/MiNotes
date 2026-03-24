import { useState, useEffect } from "react";
import { getSettings, updateSettings, type MiNotesSettings } from "../lib/settings";
import { getTheme, setTheme } from "../lib/theme";

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function SettingsPanel({ open, onClose }: Props) {
  const [settings, setSettings] = useState<MiNotesSettings>(getSettings);
  const [currentTheme, setCurrentTheme] = useState(getTheme);

  useEffect(() => {
    if (open) {
      setSettings(getSettings());
      setCurrentTheme(getTheme());
    }
  }, [open]);

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
    <div className="settings-slide-panel">
      <div className="settings-header">
        <span>Settings</span>
        <button className="btn btn-sm" onClick={onClose}>×</button>
      </div>

      {/* Theme row */}
      <div className="settings-section">
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-name">Theme</div>
          </div>
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

      {/* Toggles row — side by side */}
      <div className="settings-section">
        <div className="settings-toggles-row">
          <div className="settings-toggle-item">
            <span className="settings-toggle-label">Full Tree Mode</span>
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={settings.fullTreeMode}
                onChange={e => toggle("fullTreeMode", e.target.checked)}
              />
              <span className="settings-toggle-slider" />
            </label>
          </div>
          <div className="settings-toggle-item">
            <span className="settings-toggle-label">Obsidian Editor Mode</span>
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={settings.obsidianEditorEnabled}
                onChange={e => toggle("obsidianEditorEnabled", e.target.checked)}
              />
              <span className="settings-toggle-slider" />
            </label>
          </div>
        </div>

        {settings.obsidianEditorEnabled && (
          <div className="settings-row" style={{ marginTop: 8 }}>
            <div className="settings-row-info">
              <div className="settings-row-name" style={{ fontSize: 12 }}>Default Editor</div>
            </div>
            <select
              className="settings-select"
              value={settings.defaultEditorMode}
              onChange={e => toggle("defaultEditorMode", e.target.value)}
            >
              <option value="minotes">Mi Edit</option>
              <option value="obsidian">Obsidian Edit</option>
            </select>
          </div>
        )}
      </div>

      {/* Keyboard shortcuts — 2 column */}
      <div className="settings-section">
        <div className="settings-section-title">Keyboard Shortcuts</div>
        <div className="shortcuts-grid">
          {[
            ["Ctrl+K", "Search / Commands"],
            ["Ctrl+J", "Journal"],
            ["Ctrl+N", "New Page"],
            ["Ctrl+Q", "SQL Query"],
            ["Ctrl+G", "Graph View"],
            ["Ctrl+R", "Flashcards"],
            ["Ctrl+W", "Whiteboard"],
            ["Ctrl+M", "Mind Map"],
            ["Ctrl+P", "Open PDF"],
            ["Ctrl+,", "Settings"],
            ["Ctrl+Z", "Undo"],
            ["Ctrl+Shift+T", "Toggle Theme"],
            ["/", "Slash Commands"],
            ["Tab", "Indent Block"],
            ["Enter", "New Block"],
            ["Esc", "Close / Blur"],
          ].map(([key, desc]) => (
            <div key={key} className="shortcut-row">
              <kbd className="shortcut-key">{key}</kbd>
              <span className="shortcut-desc">{desc}</span>
            </div>
          ))}
        </div>
      </div>

      {/* About */}
      <div className="settings-section">
        <div style={{ fontSize: 11, color: "var(--text-muted)", textAlign: "center", padding: "4px 0" }}>
          MiNotes · Rust + TypeScript · Tauri 2
        </div>
      </div>
    </div>
  );
}
