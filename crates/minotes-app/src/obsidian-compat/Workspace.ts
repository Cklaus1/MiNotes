import { Events } from './Events';
import { TFile } from './Vault';

export class WorkspaceLeaf {
  view: any = null;
}

export class Workspace extends Events {
  private _activeFile: TFile | null = null;

  getActiveFile(): TFile | null {
    return this._activeFile;
  }

  _setActiveFile(file: TFile | null) {
    this._activeFile = file;
    this.trigger('file-open', file);
    this.trigger('active-leaf-change', null);
  }

  getLeaf(_newLeaf?: boolean | string): WorkspaceLeaf {
    return new WorkspaceLeaf();
  }

  getActiveViewOfType<T>(_type: any): T | null {
    return null; // Simplified — full MarkdownView not supported
  }

  onLayoutReady(callback: () => void): void {
    // Layout is always ready in MiNotes
    setTimeout(callback, 0);
  }
}
