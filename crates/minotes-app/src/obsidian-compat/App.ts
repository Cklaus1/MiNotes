import { Vault } from './Vault';
import { Workspace } from './Workspace';
import type { Command } from './types';

export class App {
  vault: Vault;
  workspace: Workspace;
  private commands: Map<string, Command> = new Map();
  private settingTabs: Map<string, any> = new Map();

  constructor() {
    this.vault = new Vault();
    this.workspace = new Workspace();
  }

  async init(): Promise<void> {
    await this.vault._syncFileCache();
  }

  _registerCommand(pluginId: string, command: Command): void {
    this.commands.set(`${pluginId}:${command.id}`, command);
  }

  _registerSettingTab(pluginId: string, tab: any): void {
    this.settingTabs.set(pluginId, tab);
  }

  getCommands(): Map<string, Command> { return this.commands; }
  getSettingTabs(): Map<string, any> { return this.settingTabs; }
}
