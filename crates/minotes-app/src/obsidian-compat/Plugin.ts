import { App } from './App';
import { EventRef } from './Events';
import type { Command, PluginManifest } from './types';

export class Component {
  private eventRefs: EventRef[] = [];
  private intervals: number[] = [];

  onload(): void {}
  onunload(): void {}

  registerEvent(ref: EventRef): EventRef {
    this.eventRefs.push(ref);
    return ref;
  }

  registerInterval(id: number): number {
    this.intervals.push(id);
    return id;
  }

  registerDomEvent(el: any, type: string, callback: any, options?: any): void {
    el.addEventListener(type, callback, options);
  }

  _cleanup(): void {
    this.intervals.forEach(id => clearInterval(id));
    this.intervals = [];
  }
}

export class Plugin extends Component {
  app: App;
  manifest: PluginManifest;
  private commands: Command[] = [];
  private settingTabs: PluginSettingTab[] = [];

  constructor(app: App, manifest: PluginManifest) {
    super();
    this.app = app;
    this.manifest = manifest;
  }

  addCommand(command: Command): Command {
    this.commands.push(command);
    this.app._registerCommand(this.manifest.id, command);
    return command;
  }

  addSettingTab(tab: PluginSettingTab): void {
    this.settingTabs.push(tab);
    this.app._registerSettingTab(this.manifest.id, tab);
  }

  registerView(type: string, creator: (leaf: any) => any): void {
    this.app.workspace.registerViewType(type, creator);
  }

  addRibbonIcon(icon: string, title: string, callback: (evt: MouseEvent) => void): HTMLElement {
    // Return a dummy element — ribbon icons map to command palette entries
    this.addCommand({ id: `ribbon-${icon}`, name: title, callback: callback as () => void });
    return document.createElement('div');
  }

  async loadData(): Promise<any> {
    // Load from plugin_storage
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const result = await invoke('plugin_storage_get', { pluginName: this.manifest.id, key: '_data' });
      return result ? JSON.parse(result as string) : null;
    } catch { return null; }
  }

  async saveData(data: any): Promise<void> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('plugin_storage_set', { pluginName: this.manifest.id, key: '_data', value: JSON.stringify(data) });
    } catch { /* silently fail */ }
  }
}

export class PluginSettingTab {
  app: App;
  containerEl: HTMLElement;
  plugin: Plugin;

  constructor(app: App, plugin: Plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = document.createElement('div');
  }

  display(): void {}
  hide(): void {}
}
