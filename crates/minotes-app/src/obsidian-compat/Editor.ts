import type { EditorPosition } from './types';

export type { EditorPosition } from './types';

export class Editor {
  private lines: string[] = [''];
  private cursor: EditorPosition = { line: 0, ch: 0 };

  getValue(): string { return this.lines.join('\n'); }
  setValue(value: string): void { this.lines = value.split('\n'); }
  getLine(n: number): string { return this.lines[n] ?? ''; }
  lineCount(): number { return this.lines.length; }
  lastLine(): number { return this.lines.length - 1; }

  getCursor(): EditorPosition { return { ...this.cursor }; }
  setCursor(pos: EditorPosition | number, ch?: number): void {
    if (typeof pos === 'number') {
      this.cursor = { line: pos, ch: ch ?? 0 };
    } else {
      this.cursor = { ...pos };
    }
  }

  getSelection(): string { return ''; }
  somethingSelected(): boolean { return false; }

  getRange(from: EditorPosition, to: EditorPosition): string {
    if (from.line === to.line) return this.lines[from.line]?.slice(from.ch, to.ch) ?? '';
    const result: string[] = [];
    result.push(this.lines[from.line]?.slice(from.ch) ?? '');
    for (let i = from.line + 1; i < to.line; i++) result.push(this.lines[i] ?? '');
    result.push(this.lines[to.line]?.slice(0, to.ch) ?? '');
    return result.join('\n');
  }

  replaceRange(text: string, from: EditorPosition, to?: EditorPosition): void {
    const end = to ?? from;
    const before = this.lines[from.line]?.slice(0, from.ch) ?? '';
    const after = this.lines[end.line]?.slice(end.ch) ?? '';
    const newLines = (before + text + after).split('\n');
    this.lines.splice(from.line, end.line - from.line + 1, ...newLines);
  }

  replaceSelection(text: string): void {
    this.replaceRange(text, this.cursor);
  }
}
