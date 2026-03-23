import { useState, useEffect } from "react";
import { getSettings, updateSettings, type MiNotesSettings } from "../lib/settings";

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function SettingsPanel({ open, onClose }: Props) {
  const [settings, setSettings] = useState<MiNotesSettings>(getSettings);

  useEffect(() => {
    if (open) setSettings(getSettings());
  }, [open]);

  if (!open) return null;

  const toggle = (key: keyof MiNotesSettings, value: any) => {
    const updated = updateSettings({ [key]: value });
    setSettings(updated);
  };

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <span>Settings</span>
          <button className="btn btn-sm" onClick={onClose}>×</button>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Editor</div>

          <div className="settings-row">
            <div className="settings-row-info">
              <div className="settings-row-name">Obsidian Editor Mode</div>
              <div className="settings-row-desc">
                Enable CodeMirror 6 source editor as an alternative to the default rich-text editor.
                When enabled, each block and page shows a toggle to switch between "Mi Edit" (WYSIWYG) and
                "Obsidian Edit" (source markdown). This unlocks compatibility with Obsidian CM6 editor plugins.
                <br /><br />
                <strong>Default: Off.</strong> Only enable if you use Obsidian plugins that require the source editor.
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
