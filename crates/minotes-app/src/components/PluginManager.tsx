import { useState, useEffect, useCallback } from "react";
import * as api from "../lib/api";

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function PluginManager({ open, onClose }: Props) {
  const [plugins, setPlugins] = useState<api.Plugin[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.listPlugins();
      setPlugins(list);
    } catch (e: any) {
      setError(typeof e === "string" ? e : e.message ?? "Failed to load plugins");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  const togglePlugin = async (plugin: api.Plugin) => {
    try {
      if (plugin.enabled) {
        await api.disablePlugin(plugin.name);
      } else {
        await api.enablePlugin(plugin.name);
      }
      await refresh();
    } catch (e: any) {
      setError(typeof e === "string" ? e : e.message ?? "Toggle failed");
    }
  };

  const uninstall = async (name: string) => {
    if (!confirm(`Uninstall plugin "${name}"? This will remove all its data.`)) return;
    try {
      await api.uninstallPlugin(name);
      await refresh();
    } catch (e: any) {
      setError(typeof e === "string" ? e : e.message ?? "Uninstall failed");
    }
  };

  if (!open) return null;

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div className="plugin-manager" onClick={e => e.stopPropagation()}>
        <div className="plugin-manager-header">
          <span>Plugins</span>
          <button className="btn btn-sm" onClick={onClose}>x</button>
        </div>

        {error && <div className="plugin-manager-error">{error}</div>}

        {loading && plugins.length === 0 && (
          <div className="plugin-manager-empty">Loading...</div>
        )}

        {!loading && plugins.length === 0 && !error && (
          <div className="plugin-manager-empty">
            No plugins installed. Plugins extend MiNotes with custom features.
          </div>
        )}

        <div className="plugin-manager-list">
          {plugins.map(p => (
            <div key={p.id} className={`plugin-item ${p.enabled ? "" : "plugin-disabled"}`}>
              <div className="plugin-info">
                <div className="plugin-name-row">
                  <span className="plugin-name">{p.name}</span>
                  <span className="plugin-version">v{p.version}</span>
                </div>
                {p.description && (
                  <div className="plugin-description">{p.description}</div>
                )}
                {p.author && (
                  <div className="plugin-author">by {p.author}</div>
                )}
              </div>
              <div className="plugin-actions">
                <button
                  className={`btn btn-sm ${p.enabled ? "" : "btn-primary"}`}
                  onClick={() => togglePlugin(p)}
                >
                  {p.enabled ? "Disable" : "Enable"}
                </button>
                <button
                  className="btn btn-sm plugin-uninstall-btn"
                  onClick={() => uninstall(p.name)}
                >
                  Uninstall
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
