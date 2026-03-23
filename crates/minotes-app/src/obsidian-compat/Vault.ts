import * as api from '../lib/api';
import { Events, EventRef } from './Events';

export class TAbstractFile {
  name: string;
  path: string;
  parent: TFolder | null = null;
  constructor(name: string, path: string) { this.name = name; this.path = path; }
}

export class TFile extends TAbstractFile {
  basename: string;
  extension: string = 'md';
  stat = { ctime: Date.now(), mtime: Date.now(), size: 0 };
  // Internal: MiNotes page ID
  _pageId: string;

  constructor(page: api.Page) {
    super(page.title + '.md', page.title + '.md');
    this.basename = page.title;
    this._pageId = page.id;
    this.stat.ctime = new Date(page.created_at).getTime();
    this.stat.mtime = new Date(page.updated_at).getTime();
  }
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
  isRoot: boolean;
  constructor(name: string, path: string, isRoot = false) {
    super(name, path);
    this.isRoot = isRoot;
  }
}

export class Vault extends Events {
  private fileCache: Map<string, TFile> = new Map();

  async read(file: TFile): Promise<string> {
    const tree = await api.getPageTree(file._pageId);
    return tree.blocks.map((b: api.Block) => b.content).join('\n');
  }

  async cachedRead(file: TFile): Promise<string> {
    return this.read(file);
  }

  async create(path: string, data: string): Promise<TFile> {
    const title = path.replace(/\.md$/, '');
    const page = await api.createPage(title);
    if (data.trim()) {
      const lines = data.split('\n').filter((l: string) => l.trim());
      for (const line of lines) {
        await api.createBlock(page.id, line);
      }
    }
    const tfile = new TFile(page);
    this.fileCache.set(path, tfile);
    this.trigger('create', tfile);
    return tfile;
  }

  async modify(file: TFile, data: string): Promise<void> {
    // Get existing blocks, update or recreate
    const tree = await api.getPageTree(file._pageId);
    const newLines = data.split('\n').filter((l: string) => l.trim());

    // Delete existing blocks
    for (const block of tree.blocks) {
      await api.deleteBlock(block.id);
    }
    // Create new blocks
    for (const line of newLines) {
      await api.createBlock(file._pageId, line);
    }
    this.trigger('modify', file);
  }

  async append(file: TFile, data: string): Promise<void> {
    const lines = data.split('\n').filter((l: string) => l.trim());
    for (const line of lines) {
      await api.createBlock(file._pageId, line);
    }
    this.trigger('modify', file);
  }

  async delete(file: TAbstractFile): Promise<void> {
    if (file instanceof TFile) {
      await api.deletePage(file._pageId);
      this.fileCache.delete(file.path);
      this.trigger('delete', file);
    }
  }

  async trash(file: TAbstractFile): Promise<void> {
    return this.delete(file);
  }

  async rename(file: TAbstractFile, newPath: string): Promise<void> {
    if (file instanceof TFile) {
      const newTitle = newPath.replace(/\.md$/, '');
      await api.renamePage(file._pageId, newTitle);
      this.fileCache.delete(file.path);
      file.name = newTitle + '.md';
      file.path = newPath;
      file.basename = newTitle;
      this.fileCache.set(newPath, file);
      this.trigger('rename', file, file.path);
    }
  }

  getFiles(): TFile[] {
    return Array.from(this.fileCache.values());
  }

  getMarkdownFiles(): TFile[] {
    return this.getFiles();
  }

  getAbstractFileByPath(path: string): TAbstractFile | null {
    return this.fileCache.get(path) ?? null;
  }

  getRoot(): TFolder {
    return new TFolder('', '/', true);
  }

  // Internal: sync file cache from MiNotes pages
  async _syncFileCache(): Promise<void> {
    const pages = await api.listPages(10000);
    this.fileCache.clear();
    for (const page of pages) {
      const tfile = new TFile(page);
      this.fileCache.set(tfile.path, tfile);
    }
  }
}
