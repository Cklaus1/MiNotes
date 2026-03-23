export type EventRef = { id: number };

export class Events {
  private handlers: Map<string, Array<{ id: number; fn: Function }>> = new Map();
  private nextId = 1;

  on(name: string, callback: (...args: any[]) => void): EventRef {
    if (!this.handlers.has(name)) this.handlers.set(name, []);
    const id = this.nextId++;
    this.handlers.get(name)!.push({ id, fn: callback });
    return { id };
  }

  off(name: string, callback: Function): void {
    const list = this.handlers.get(name);
    if (list) {
      const idx = list.findIndex(h => h.fn === callback);
      if (idx >= 0) list.splice(idx, 1);
    }
  }

  offref(ref: EventRef): void {
    for (const [, list] of this.handlers) {
      const idx = list.findIndex(h => h.id === ref.id);
      if (idx >= 0) { list.splice(idx, 1); return; }
    }
  }

  trigger(name: string, ...data: any[]): void {
    const list = this.handlers.get(name);
    if (list) list.forEach(h => h.fn(...data));
  }
}
