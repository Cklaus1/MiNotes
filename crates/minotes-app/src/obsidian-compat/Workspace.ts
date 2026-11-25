import { Events } from './Events';
import { TFile } from './Vault';
import type { ViewCreator, WorkspaceLeafInstance } from './types';
import { ItemView } from './ItemView';

export class WorkspaceLeaf implements WorkspaceLeafInstance {
  view: ItemView | null = null;
  containerEl: HTMLElement;

  constructor() {
    this.containerEl = document.createElement('div');
    this.containerEl.className = 'workspace-leaf-content';
  }

  // Open a view in this leaf
  async setViewState(_state: { type: string; active?: boolean }): Promise<void> {
    // Will be handled by Workspace
  }
}

export class Workspace extends Events {
  private _activeFile: TFile | null = null;
  private viewRegistry: Map<string, ViewCreator> = new Map();
  private activeViews: Map<string, { leaf: WorkspaceLeaf; view: ItemView }> = new Map();

  // Callback to notify React when custom views change
  private _onViewChange?: (views: Array<{ type: string; displayText: string; containerEl: HTMLElement }>) => void;

  getActiveFile(): TFile | null {
    return this._activeFile;
  }

  _setActiveFile(file: TFile | null) {
    this._activeFile = file;
    this.trigger('file-open', file);
    this.trigger('active-leaf-change', null);
  }

  // Register a custom view type (Obsidian API)
  registerViewType(type: string, creator: ViewCreator): void {
    this.viewRegistry.set(type, creator);
  }

  // Get or create a leaf
  getLeaf(_newLeaf?: boolean | string): WorkspaceLeaf {
    return new WorkspaceLeaf();
  }

  // Open a custom view by type (called internally)
  async openView(type: string): Promise<WorkspaceLeaf | null> {
    const creator = this.viewRegistry.get(type);
    if (!creator) return null;

    // If already open, return existing
    const existing = this.activeViews.get(type);
    if (existing) return existing.leaf;

    const leaf = new WorkspaceLeaf();
    const view = creator(leaf);
    leaf.view = view;

    this.activeViews.set(type, { leaf, view });

    // Lifecycle
    await view.onload();
    await view.onOpen();

    this._notifyViewChange();
    return leaf;
  }

  // Close a custom view
  async closeView(type: string): Promise<void> {
    const entry = this.activeViews.get(type);
    if (!entry) return;

    await entry.view.onClose();
    entry.view.onunload();
    entry.leaf.containerEl.remove();
    this.activeViews.delete(type);

    this._notifyViewChange();
  }

  detachLeavesOfType(viewType: string): void {
    this.closeView(viewType);
  }

  revealLeaf(_leaf: WorkspaceLeaf): void {
    // No-op in MiNotes — views are always visible when open
  }

  getActiveViewOfType<T>(_type: any): T | null {
    // Check if it's MarkdownView
    return null;
  }

  onLayoutReady(callback: () => void): void {
    setTimeout(callback, 0);
  }

  // Get all registered view types
  getRegisteredViewTypes(): string[] {
    return Array.from(this.viewRegistry.keys());
  }

  // Get active custom views for React rendering
  getActiveViews(): Array<{ type: string; displayText: string; containerEl: HTMLElement }> {
    return Array.from(this.activeViews.entries()).map(([type, { view, leaf }]) => ({
      type,
      displayText: view.getDisplayText(),
      containerEl: leaf.containerEl,
    }));
  }

  // Set callback for React to re-render when views change
  _setViewChangeCallback(cb: (views: Array<{ type: string; displayText: string; containerEl: HTMLElement }>) => void) {
    this._onViewChange = cb;
  }

  private _notifyViewChange() {
    this._onViewChange?.(this.getActiveViews());
  }
}
