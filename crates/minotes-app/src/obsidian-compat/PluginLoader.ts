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

  // Whether unsandboxed plugin execution is currently permitted. The UI uses this to
  // disclose that the feature is disabled rather than presenting a functional-looking
  // form that always errors (Bug #15).
  static isLoadingEnabled(): boolean {
    return (
      typeof localStorage !== "undefined" &&
      localStorage.getItem("minotes-allow-unsafe-plugin-loading") === "1"
    );
  }

  // Load a plugin from a manifest + code string.
  //
  // SECURITY: Executing untrusted plugin code via `new Function(...)` is
  // equivalent to `eval()` and gives the plugin full access to the host page
  // (DOM, network, Tauri IPC, file system, etc.). Until we have a real
  // sandbox (e.g. an iframe or a worker with a restricted message bridge),
  // this method is intentionally disabled.
  //
  // To re-enable for trusted local development only, set
  // `localStorage.setItem("minotes-allow-unsafe-plugin-loading", "1")`.
  async loadPlugin(manifest: PluginManifest, code: string): Promise<void> {
    const allowUnsafe = PluginLoader.isLoadingEnabled();
    if (!allowUnsafe) {
      throw new Error(
        `Plugin '${manifest.id}' refused: unsandboxed plugin execution is disabled. ` +
          `See PluginLoader.loadPlugin for details.`,
      );
    }

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
      // eslint-disable-next-line no-new-func -- gated by allowUnsafe flag above
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
