import { Editor } from './Editor';
import { TFile } from './Vault';

export class MarkdownView {
  editor: Editor;
  file: TFile | null;
  containerEl: HTMLElement;

  constructor() {
    this.editor = new Editor();
    this.file = null;
    this.containerEl = document.createElement('div');
  }

  getMode(): 'source' | 'preview' { return 'source'; }
  getViewType(): string { return 'markdown'; }
}
