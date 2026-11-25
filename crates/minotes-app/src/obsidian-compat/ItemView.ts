import { Component } from './Plugin';
import type { WorkspaceLeafInstance } from './types';

export abstract class ItemView extends Component {
  containerEl: HTMLElement;
  contentEl: HTMLElement;
  leaf: WorkspaceLeafInstance;

  constructor(leaf: WorkspaceLeafInstance) {
    super();
    this.leaf = leaf;
    this.containerEl = leaf.containerEl;
    this.contentEl = document.createElement('div');
    this.contentEl.className = 'view-content';
    this.containerEl.appendChild(this.contentEl);
  }

  abstract getViewType(): string;
  abstract getDisplayText(): string;
  getIcon(): string { return 'document'; }

  // Called when the view should render
  async onOpen(): Promise<void> {}
  // Called when the view is closed
  async onClose(): Promise<void> {}
}

// Convenience class many plugins use
export class MarkdownRenderChild extends Component {
  containerEl: HTMLElement;
  constructor(containerEl: HTMLElement) {
    super();
    this.containerEl = containerEl;
  }
}
