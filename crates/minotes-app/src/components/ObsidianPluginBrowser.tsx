import { useState, useEffect } from 'react';
import { PluginLoader } from '../obsidian-compat/PluginLoader';
import type { PluginManifest } from '../obsidian-compat/types';

interface Props {
  open: boolean;
  onClose: () => void;
}

// Singleton instances
let obsidianApp: any | null = null;
let pluginLoader: PluginLoader | null = null;

async function getLoader(): Promise<PluginLoader> {
  if (!pluginLoader) {
    const { App: ObsidianApp } = await import('../obsidian-compat/App');
    obsidianApp = new ObsidianApp();
    if (typeof obsidianApp.init === 'function') {
      await obsidianApp.init();
    }
    pluginLoader = new PluginLoader(obsidianApp);
  }
  return pluginLoader;
}

export default function ObsidianPluginBrowser({ open, onClose }: Props) {
  const [manifestJson, setManifestJson] = useState('');
  const [pluginCode, setPluginCode] = useState('');
  const [loaded, setLoaded] = useState<Array<{ id: string; name: string; enabled: boolean }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) refreshList();
  }, [open]);

  const refreshList = async () => {
    const loader = await getLoader();
    setLoaded(loader.getLoadedPlugins().map(p => ({
      id: p.manifest.id,
      name: p.manifest.name,
      enabled: p.enabled,
    })));
  };

  const handleLoad = async () => {
    setError(null);
    setLoading(true);
    try {
      const manifest: PluginManifest = JSON.parse(manifestJson);
      if (!manifest.id || !manifest.name) throw new Error('Manifest must have id and name');

      const loader = await getLoader();
      await loader.loadPlugin(manifest, pluginCode);
      await loader.enablePlugin(manifest.id);
      await refreshList();
      setManifestJson('');
      setPluginCode('');
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleToggle = async (id: string, currentlyEnabled: boolean) => {
    const loader = await getLoader();
    if (currentlyEnabled) {
      await loader.disablePlugin(id);
    } else {
      await loader.enablePlugin(id);
    }
    await refreshList();
  };

  const handleUnload = async (id: string) => {
    const loader = await getLoader();
    await loader.unloadPlugin(id);
    await refreshList();
  };

  if (!open) return null;

  // Render as modal overlay matching existing panel pattern
  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div className="query-panel" onClick={e => e.stopPropagation()} style={{ maxHeight: '85vh' }}>
        <div className="query-panel-header">
          <span>Obsidian Plugin Loader</span>
          <button className="btn btn-sm" onClick={onClose}>&times;</button>
        </div>

        {/* Loaded plugins list */}
        {loaded.length > 0 && (
          <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 4, textTransform: 'uppercase' }}>
              Loaded Plugins ({loaded.length})
            </div>
            {loaded.map(p => (
              <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 13 }}>
                <span style={{ flex: 1 }}>{p.name}</span>
                <button className="btn btn-sm" onClick={() => handleToggle(p.id, p.enabled)}>
                  {p.enabled ? 'Disable' : 'Enable'}
                </button>
                <button className="btn btn-sm" onClick={() => handleUnload(p.id)} style={{ color: 'var(--danger)' }}>
                  Unload
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Load new plugin form */}
        <div style={{ padding: '8px 16px' }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 4, textTransform: 'uppercase' }}>
            Load Obsidian Plugin
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
            Paste the plugin's manifest.json and main.js contents below.
          </div>

          <textarea
            className="query-input"
            value={manifestJson}
            onChange={e => setManifestJson(e.target.value)}
            placeholder='{"id": "my-plugin", "name": "My Plugin", "version": "1.0.0", "author": "Me", "description": "Does things"}'
            rows={2}
            style={{ marginBottom: 8 }}
          />

          <textarea
            className="query-input"
            value={pluginCode}
            onChange={e => setPluginCode(e.target.value)}
            placeholder="Paste main.js contents here..."
            rows={6}
          />
        </div>

        <div className="query-actions">
          <button className="btn btn-primary" onClick={handleLoad} disabled={loading || !manifestJson.trim() || !pluginCode.trim()}>
            {loading ? 'Loading...' : 'Load & Enable Plugin'}
          </button>
        </div>

        {error && <div className="query-error">{error}</div>}
      </div>
    </div>
  );
}
