export class Notice {
  private el: HTMLElement;

  constructor(message: string | DocumentFragment, timeout: number = 5000) {
    this.el = document.createElement('div');
    this.el.className = 'obsidian-notice';
    if (typeof message === 'string') {
      this.el.textContent = message;
    } else {
      this.el.appendChild(message);
    }
    document.body.appendChild(this.el);
    if (timeout > 0) {
      setTimeout(() => this.hide(), timeout);
    }
  }

  hide(): void {
    this.el.remove();
  }
}
