import type { PluginManifest } from './types';

interface PluginLike {
  onload(): Promise<void> | void;
  onunload(): void;
  _cleanup(): void;
}

interface LoadedPlugin {
  manifest: PluginManifest;
  instance: PluginLike;
  enabled: boolean;
}

export class PluginLoader {
  app: any;
  private plugins: Map<string, LoadedPlugin> = new Map();

  constructor(app: any) {
    this.app = app;
  }

  // Load a plugin from a manifest + code string
  // The code string is the contents of main.js
  async loadPlugin(manifest: PluginManifest, code: string): Promise<void> {
    // Create a module scope with the obsidian shim
    const obsidianModule = await import('./index');

    // Create a fake require that returns the obsidian shim
    const fakeRequire = (name: string) => {
      if (name === 'obsidian') return obsidianModule;
      throw new Error(`Module not found: ${name}`);
    };

    const fakeModule = { exports: {} as any };
    const fakeExports = fakeModule.exports;

    try {
      const factory = new Function('module', 'exports', 'require', code);
      factory(fakeModule, fakeExports, fakeRequire);
    } catch (e) {
      console.error(`Failed to load plugin ${manifest.id}:`, e);
      throw e;
    }

    // Find the default export (should be a class extending Plugin)
    const PluginClass = fakeModule.exports.default || fakeModule.exports;

    if (typeof PluginClass !== 'function') {
      throw new Error(`Plugin ${manifest.id} does not export a class`);
    }

    // Instantiate the plugin
    const instance = new PluginClass(this.app, manifest);

    this.plugins.set(manifest.id, { manifest, instance, enabled: false });
  }

  // Enable a loaded plugin
  async enablePlugin(id: string): Promise<void> {
    const plugin = this.plugins.get(id);
    if (!plugin) throw new Error(`Plugin ${id} not loaded`);
    if (plugin.enabled) return;

    try {
      await plugin.instance.onload();
      plugin.enabled = true;
      console.log(`Plugin ${id} enabled`);
    } catch (e) {
      console.error(`Failed to enable plugin ${id}:`, e);
      throw e;
    }
  }

  // Disable a plugin
  async disablePlugin(id: string): Promise<void> {
    const plugin = this.plugins.get(id);
    if (!plugin || !plugin.enabled) return;

    try {
      plugin.instance.onunload();
      plugin.instance._cleanup();
      plugin.enabled = false;
      console.log(`Plugin ${id} disabled`);
    } catch (e) {
      console.error(`Failed to disable plugin ${id}:`, e);
    }
  }

  // Unload a plugin completely
  async unloadPlugin(id: string): Promise<void> {
    await this.disablePlugin(id);
    this.plugins.delete(id);
  }

  // Get all loaded plugins
  getLoadedPlugins(): LoadedPlugin[] {
    return Array.from(this.plugins.values());
  }

  // Get a loaded plugin by ID
  getPlugin(id: string): LoadedPlugin | undefined {
    return this.plugins.get(id);
  }

  // Get all commands registered by plugins
  getAllCommands(): Array<{ pluginId: string; command: any }> {
    const commands: Array<{ pluginId: string; command: any }> = [];
    if (this.app.getCommands) {
      for (const [pluginId, command] of this.app.getCommands()) {
        commands.push({ pluginId: pluginId.split(':')[0], command });
      }
    }
    return commands;
  }
}
