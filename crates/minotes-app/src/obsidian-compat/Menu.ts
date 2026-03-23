export class MenuItem {
  private _el: HTMLElement;
  private _callback?: () => void;

  constructor() { this._el = document.createElement('div'); }
  setTitle(title: string): this { this._el.textContent = title; return this; }
  setIcon(_icon: string): this { return this; }
  onClick(cb: () => void): this { this._callback = cb; return this; }
  _execute(): void { this._callback?.(); }
}

export class Menu {
  private items: MenuItem[] = [];

  addItem(cb: (item: MenuItem) => void): this {
    const item = new MenuItem();
    cb(item);
    this.items.push(item);
    return this;
  }

  showAtMouseEvent(_evt: MouseEvent): void {
    // Simplified: context menu not yet implemented
  }

  showAtPosition(_pos: { x: number; y: number }): void {}
}
