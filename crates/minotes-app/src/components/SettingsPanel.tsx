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
    <div className="command-palette-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <span>Settings</span>
          <button className="btn btn-sm" onClick={onClose}>×</button>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Appearance</div>

          <div className="settings-row">
            <div className="settings-row-info">
              <div className="settings-row-name">Theme</div>
              <div className="settings-row-desc">Switch between dark and light mode.</div>
            </div>
            <select
              className="settings-select"
              value={currentTheme}
              onChange={e => handleThemeChange(e.target.value as "dark" | "light")}
            >
              <option value="dark">Dark (Catppuccin Mocha)</option>
              <option value="light">Light (Catppuccin Latte)</option>
            </select>
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Display</div>

          <div className="settings-row">
            <div className="settings-row-info">
              <div className="settings-row-name">Full Tree Mode</div>
              <div className="settings-row-desc">
                Show connector lines between blocks. Default is clean document mode.
              </div>
            </div>
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={settings.fullTreeMode}
                onChange={e => toggle("fullTreeMode", e.target.checked)}
              />
              <span className="settings-toggle-slider" />
            </label>
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Editor</div>

          <div className="settings-row">
            <div className="settings-row-info">
              <div className="settings-row-name">Obsidian Editor Mode</div>
              <div className="settings-row-desc">
                Per-block toggle between rich text and source markdown.
              </div>
            </div>
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
              <div className="settings-row-info">
                <div className="settings-row-name">Default Editor for New Blocks</div>
                <div className="settings-row-desc">
                  Which editor to use by default. You can always toggle per block.
                </div>
              </div>
              <select
                className="settings-select"
                value={settings.defaultEditorMode}
                onChange={e => toggle("defaultEditorMode", e.target.value)}
              >
                <option value="minotes">Mi Edit (Rich Text)</option>
                <option value="obsidian">Obsidian Edit (Source)</option>
              </select>
            </div>
          )}
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Keyboard Shortcuts</div>
          <div className="shortcuts-grid">
            {[
              ["Ctrl+K", "Search / Command Palette"],
              ["Ctrl+J", "Today's Journal"],
              ["Ctrl+N", "New Page"],
              ["Ctrl+Q", "SQL Query Panel"],
              ["Ctrl+G", "Graph View"],
              ["Ctrl+R", "Flashcard Review"],
              ["Ctrl+W", "Whiteboard"],
              ["Ctrl+P", "Open PDF"],
              ["Ctrl+Z", "Undo"],
              ["Ctrl+,", "Settings"],
              ["Ctrl+Shift+T", "Toggle Theme"],
              ["/", "Slash Commands (in editor)"],
              ["Esc", "Close Panel / Blur Editor"],
            ].map(([key, desc]) => (
              <div key={key} className="shortcut-row">
                <kbd className="shortcut-key">{key}</kbd>
                <span className="shortcut-desc">{desc}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">About</div>
          <div className="settings-row">
            <div className="settings-row-info">
              <div className="settings-row-desc" style={{ color: "var(--text-muted)" }}>
                MiNotes — Local-first knowledge management engine<br />
                Rust + TypeScript · Tauri 2 · TipTap + CodeMirror 6
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
