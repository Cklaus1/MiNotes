export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  minAppVersion?: string;
  description: string;
  author: string;
  authorUrl?: string;
  isDesktopOnly?: boolean;
}

export interface Command {
  id: string;
  name: string;
  callback?: () => void;
  editorCallback?: (editor: any, view: any) => void;
  checkCallback?: (checking: boolean) => boolean | void;
  hotkeys?: Array<{ modifiers: string[]; key: string }>;
}

export interface EditorPosition {
  line: number;
  ch: number;
}
