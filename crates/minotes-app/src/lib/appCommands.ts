/**
 * Every app-wide action as a palette command (UX Wave 4; registry in
 * lib/commands.ts). App calls `useAppCommands` with its state and actions;
 * shortcut hints match lib/shortcuts.ts.
 */
import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import * as api from "./api";
import type { CanvasModeType } from "../components/CanvasMode";
import { useCommands, type AppCommand, type PickItem } from "./commands";
import { goBack, goForward, canGoBack, canGoForward } from "./navHistory";
import { toggleTheme } from "./theme";
import { askNewPage } from "./newPage";
import { OPEN_SHORTCUTS_EVENT } from "./shortcuts";
import { openImport } from "./importPicks";
import { exportNotebook, importNotebookFromZip, switchNotebook, NOTEBOOK_SWITCHED, NOTEBOOKS_CHANGED } from "./notebooks";
import { LOCK_CHANGED, lockNow } from "./encryption";
import { promptDialog } from "./confirm";
import { showToast, showUndoToast } from "./toast";
import { errorMessage } from "./errors";
import { pageAsText } from "./pageText";
import { downloadHtml } from "./exportPage";
import { recentSectionShown, setRecentSectionShown } from "./sidebarRecent";
import {
  activateTab, closeOtherTabs, closeTab, cycleTab, duplicateTab, getTabsSnapshot, reopenClosedTab, togglePin,
} from "./tabs";
import type { TabBarItem } from "./tabBarTypes";

type MainView = null | "tasks" | "pages" | "trash" | "archive";

export interface AppCommandDeps {
  activePage: api.Page | null;
  activeTree: api.PageTree | null;
  canvasMode: CanvasModeType | null;
  mainView: MainView;
  setOpenPanel: Dispatch<SetStateAction<string | null>>;
  setCanvasMode: Dispatch<SetStateAction<CanvasModeType | null>>;
  setMainView: Dispatch<SetStateAction<MainView>>;
  openJournal: (date?: string) => Promise<void>;
  createPage: (title: string) => Promise<boolean>;
  deletePage: (id: string, title?: string) => Promise<void> | void;
  renameActivePage: (pageId: string, title: string) => Promise<void>;
  openNewWhiteboard: (pageId: string) => void;
  toggleSidebar: () => void;
  toggleRightSidebar: () => void;
  syncNow: () => void;
  openPdf: () => void;
  refresh: () => Promise<void> | void;
  /** "+" / Ctrl+T (the destination from Settings → Editor → New tabs open). */
  newTab: () => void;
  /** The tab row as drawn (titles for "Go to tab…"), read when the palette lists. */
  tabItems: () => TabBarItem[];
  /** The tab row is shown (not on Android): only then are there tab commands. */
  tabsOn: boolean;
}

/** Event NotebookSwitcher listens to: open one of its dialogs. */
const OPEN_NOTEBOOK_DIALOG = "minotes-open-notebook-dialog";

const sidebarRefresh = () => window.dispatchEvent(new Event("minotes-sidebar-refresh"));

/** Projects as "Work / Clients / Acme", depth-first. */
function projectPaths(tree: api.FolderTreeRoot): Array<{ id: string; path: string }> {
  const out: Array<{ id: string; path: string }> = [];
  const walk = (fs: api.FolderTree[], prefix: string) => {
    for (const f of fs) {
      const path = prefix ? `${prefix} / ${f.name}` : f.name;
      out.push({ id: f.id, path });
      walk(f.children ?? [], path);
    }
  };
  walk(tree.folders, "");
  return out;
}

export function useAppCommands(d: AppCommandDeps): void {
  // State the labels depend on: pinned? encrypted and unlocked?
  const [pinned, setPinned] = useState(false);
  const [session, setSession] = useState<api.NotebookSession | null>(null);
  const pageId = d.activePage?.id ?? null;
  useEffect(() => {
    if (!pageId) { setPinned(false); return; }
    let live = true;
    const load = () => api.listFavorites().then(f => { if (live) setPinned(f.some(p => p.id === pageId)); }).catch(() => {});
    load();
    window.addEventListener("minotes-sidebar-refresh", load);
    return () => { live = false; window.removeEventListener("minotes-sidebar-refresh", load); };
  }, [pageId]);
  useEffect(() => {
    const load = () => { api.getNotebookSession().then(setSession).catch(() => {}); };
    load();
    for (const ev of [LOCK_CHANGED, NOTEBOOK_SWITCHED, NOTEBOOKS_CHANGED]) window.addEventListener(ev, load);
    return () => { for (const ev of [LOCK_CHANGED, NOTEBOOK_SWITCHED, NOTEBOOKS_CHANGED]) window.removeEventListener(ev, load); };
  }, []);

  // Tabs (PRD-tabs §4): read the store when the palette lists / runs them.
  useCommands("tabs", () => {
    if (!d.tabsOn) return [];
    const snap = () => getTabsSnapshot();
    const several = () => snap().tabs.length > 1;
    const active = () => snap().activeId;
    const activePinned = () => !!snap().tabs.find(t => t.id === active())?.pinned;
    return [
      { id: "tab-new", label: "New Tab", shortcut: "Ctrl+T", keywords: "open tab", run: () => d.newTab() },
      { id: "tab-close", label: "Close Tab", shortcut: "Ctrl+W", available: several, run: () => closeTab(active()) },
      {
        id: "tab-close-others", label: "Close Other Tabs", keywords: "tabs",
        available: () => snap().tabs.some(t => t.id !== active() && !t.pinned), run: () => closeOtherTabs(active()),
      },
      { id: "tab-reopen", label: "Reopen Closed Tab", keywords: "undo close tab", available: () => snap().closed > 0, run: () => reopenClosedTab() },
      { id: "tab-pin", label: () => (activePinned() ? "Unpin Tab" : "Pin Tab"), keywords: "tab", run: () => togglePin(active()) },
      { id: "tab-duplicate", label: "Duplicate Tab", keywords: "copy tab", run: () => duplicateTab(active()) },
      { id: "tab-next", label: "Next Tab", shortcut: "Ctrl+Tab", available: several, run: () => cycleTab(1) },
      { id: "tab-previous", label: "Previous Tab", shortcut: "Ctrl+Shift+Tab", available: several, run: () => cycleTab(-1) },
      {
        id: "tab-go", label: "Go to Tab…", keywords: "switch tab open tabs", available: several,
        pick: {
          placeholder: "Go to tab…",
          items: () => d.tabItems().map(t => ({
            id: t.id, label: t.fullTitle,
            detail: t.id === active() ? "open now" : t.pinned ? "pinned" : undefined,
          })),
          onPick: (item) => activateTab(item.id),
        },
      },
    ];
  }, [d.newTab, d.tabItems, d.tabsOn]);

  useCommands("app", () => {
    const page = d.activePage;
    const hasPage = !!page;
    const isPage = hasPage && !page!.is_journal;
    const view = (v: Exclude<MainView, null>) => () => { d.setCanvasMode(null); d.setMainView(v); };
    const canvas = (m: CanvasModeType) => () => { d.setMainView(null); d.setCanvasMode(m); };
    const openDialog = (which: "new" | "manage" | "join") => () =>
      window.dispatchEvent(new CustomEvent(OPEN_NOTEBOOK_DIALOG, { detail: which }));

    const cmds: AppCommand[] = [
      // ── Navigate ──
      { id: "back", label: "Go Back", shortcut: "Ctrl+[", keywords: "history previous", available: () => canGoBack(), run: () => { void goBack(); } },
      { id: "forward", label: "Go Forward", shortcut: "Ctrl+]", keywords: "history next", available: () => canGoForward(), run: () => { void goForward(); } },
      { id: "journal", label: "Open Today's Journal", shortcut: "Ctrl+J", keywords: "daily today", run: () => { d.setCanvasMode(null); void d.openJournal(); } },
      { id: "all-pages", label: "All Pages", keywords: "list every page index", run: view("pages") },
      { id: "tasks", label: "Tasks", keywords: "todo doing done", run: view("tasks") },
      { id: "trash", label: "Trash", keywords: "deleted restore bin", run: view("trash") },
      { id: "archive", label: "Archive", keywords: "archived", run: view("archive") },
      { id: "graph", label: "Open Graph View", shortcut: "Ctrl+G", keywords: "links network", run: canvas("graph") },
      // ── This page ──
      { id: "mindmap", label: "Open Mind Map", shortcut: "Ctrl+M", available: hasPage, run: canvas("mindmap") },
      { id: "kanban", label: "Open Kanban Board", shortcut: "Ctrl+Shift+K", available: hasPage, run: canvas("kanban") },
      { id: "whiteboard", label: "New Whiteboard", shortcut: "Ctrl+Shift+W", keywords: "draw canvas board", available: hasPage, run: () => { d.setMainView(null); d.openNewWhiteboard(page!.id); } },
      {
        id: "pin", label: pinned ? "Unpin Page" : "Pin Page", keywords: "favorite pinned", available: hasPage,
        run: async () => {
          try {
            if (pinned) await api.removeFavorite(page!.id); else await api.addFavorite(page!.id);
            showToast(pinned ? `Unpinned “${page!.title}”` : `Pinned “${page!.title}”`);
            sidebarRefresh();
          } catch (e) { showToast(`Couldn't ${pinned ? "unpin" : "pin"} the page: ${errorMessage(e)}`); }
        },
      },
      {
        id: "move-page", label: "Move Page to Project…", keywords: "folder project", available: isPage,
        pick: {
          placeholder: `Move “${page?.title ?? ""}” to…`,
          items: async () => {
            const tree = await api.getFolderTree();
            const here = page?.folder_id ?? null;
            const top: PickItem = { id: "", label: "Top level", detail: "out of every project", disabled: here === null ? "It is already at the top level" : undefined };
            return [top, ...projectPaths(tree).map(p => ({ id: p.id, label: p.path, disabled: p.id === here ? "It is already here" : undefined }))];
          },
          onPick: async (item) => {
            const from = page!.folder_id ?? undefined;
            try {
              await api.movePageToFolder(page!.id, item.id || undefined);
            } catch (e) { showToast(`Couldn't move “${page!.title}”: ${errorMessage(e)}`); return; }
            sidebarRefresh();
            showUndoToast(item.id ? `Moved “${page!.title}” to ${item.label}` : `Moved “${page!.title}” to the top level`, async () => {
              await api.movePageToFolder(page!.id, from).catch(() => {});
              sidebarRefresh();
            }, 8000);
          },
        },
      },
      {
        id: "rename-page", label: "Rename Page…", keywords: "title", available: isPage,
        run: async () => {
          const title = await promptDialog({ title: "Rename page", label: "New title", defaultValue: page!.title, confirmLabel: "Rename" });
          if (title && title.trim() && title.trim() !== page!.title) await d.renameActivePage(page!.id, title).catch(() => {});
        },
      },
      {
        id: "archive-page", label: "Archive Page", keywords: "hide", available: isPage,
        run: async () => {
          try { await api.archivePage(page!.id); } catch (e) { showToast(`Couldn't archive the page: ${errorMessage(e)}`); return; }
          sidebarRefresh();
          await d.refresh();
          void d.openJournal();
          showUndoToast(`Archived “${page!.title}”`, async () => {
            await api.unarchivePage(page!.id).catch(() => {});
            sidebarRefresh();
          }, 8000);
        },
      },
      { id: "delete-page", label: "Delete Page", keywords: "trash remove bin", available: hasPage, run: () => { void d.deletePage(page!.id, page!.title); } },
      {
        id: "copy-page", label: "Copy Page as Text", shortcut: "Ctrl+Shift+C", keywords: "clipboard", available: hasPage,
        run: () => {
          api.getPageTree(page!.id)
            .then(t => navigator.clipboard.writeText(pageAsText(t.blocks)))
            .then(() => showToast(`Copied “${page!.title}” to the clipboard`))
            .catch(e => showToast(`Couldn't copy the page: ${errorMessage(e)}`));
        },
      },
      { id: "export-page", label: "Export Page as HTML…", keywords: "save download", available: !!d.activeTree, run: () => { if (d.activeTree) void downloadHtml(d.activeTree); } },
      { id: "sync", label: "Page Versions", keywords: "history snapshots restore", run: () => d.setOpenPanel("sync") },
      // ── Create ──
      { id: "new-page", label: "New Page", shortcut: "Ctrl+N", keywords: "create add", run: () => { askNewPage().then(t => { if (t) void d.createPage(t); }); } },
      // ── Notebooks ──
      {
        id: "switch-notebook", label: "Switch Notebook…", keywords: "open notebook change",
        pick: {
          placeholder: "Open notebook…",
          items: async () => {
            const [list, current] = await Promise.all([api.listNotebooks(), api.getCurrentNotebook().catch(() => "")]);
            return list.map(n => ({
              id: n.key, label: n.name,
              detail: n.key === current ? "open now" : n.locked ? "locked" : n.encrypted ? "encrypted" : undefined,
              disabled: n.key === current ? "It is open" : !n.available ? "Its folder was not found" : undefined,
            }));
          },
          onPick: (item) => { switchNotebook(item.id).catch(() => {}); },
        },
      },
      { id: "new-notebook", label: "New Notebook…", keywords: "create", run: openDialog("new") },
      { id: "manage-notebooks", label: "Manage Notebooks…", keywords: "rename delete notebooks", run: openDialog("manage") },
      { id: "lock", label: "Lock Notebook Now", shortcut: "Ctrl+Shift+L", keywords: "encrypted passphrase", available: !!session?.encrypted && !session.locked, run: () => { lockNow().catch(e => showToast(`Couldn't lock: ${errorMessage(e)}`)); } },
      { id: "export-notebook", label: "Export Notebook (.zip)…", keywords: "backup save", run: () => { void exportNotebook(); } },
      { id: "import-notebook", label: "Import Notebook (.zip)…", keywords: "restore backup", run: () => { void importNotebookFromZip(); } },
      { id: "import", label: "Import from Obsidian, Evernote or Markdown…", shortcut: "Ctrl+Shift+I", keywords: "enex vault", run: () => openImport() },
      { id: "sync-now", label: "Sync Now", keywords: "git push pull", run: () => d.syncNow() },
      // ── Tools ──
      { id: "query", label: "Open SQL Query Panel", shortcut: "Ctrl+Q", run: () => d.setOpenPanel("query") },
      { id: "review", label: "Open Flashcard Review", shortcut: "Ctrl+R", keywords: "cards spaced repetition", run: () => d.setOpenPanel("review") },
      { id: "pdf", label: "Open a PDF…", shortcut: "Ctrl+P", run: () => d.openPdf() },
      { id: "ask-ai", label: "Ask AI", shortcut: "Ctrl+Shift+A", keywords: "question chat", run: () => { window.dispatchEvent(new CustomEvent("minotes:open-ai", { detail: "ask" })); } },
      { id: "ai-settings", label: "AI Settings", keywords: "provider model key", run: () => { window.dispatchEvent(new CustomEvent("minotes:open-ai", { detail: "settings" })); } },
      { id: "css-snippets", label: "CSS Snippets", keywords: "style theme", run: () => d.setOpenPanel("cssManager") },
      // The Obsidian plugin loader is an unsafe stub: development builds only.
      ...(import.meta.env.DEV ? [{ id: "obsidian-plugins", label: "Obsidian Plugins (dev)", run: () => d.setOpenPanel("obsidianPlugins") }] : []),
      // ── App ──
      { id: "settings", label: "Settings", shortcut: "Ctrl+,", keywords: "preferences options", run: () => d.setOpenPanel("settings") },
      { id: "shortcuts", label: "Keyboard Shortcuts", shortcut: "Ctrl+/", keywords: "keys help", run: () => { window.dispatchEvent(new Event(OPEN_SHORTCUTS_EVENT)); } },
      { id: "toggle-theme", label: "Toggle Theme", shortcut: "Ctrl+Shift+T", keywords: "dark light", run: () => toggleTheme() },
      { id: "toggle-sidebar", label: "Show/Hide Sidebar", shortcut: "Ctrl+Shift+\\", keywords: "toggle collapse", run: () => d.toggleSidebar() },
      { id: "toggle-right-sidebar", label: "Show/Hide Right Sidebar", shortcut: "Ctrl+\\", keywords: "toggle", run: () => d.toggleRightSidebar() },
      {
        id: "toggle-recent", label: () => (recentSectionShown() ? "Hide Recent Pages in the Sidebar" : "Show Recent Pages in the Sidebar"), keywords: "recent sidebar toggle",
        run: () => setRecentSectionShown(!recentSectionShown()),
      },
    ];
    return cmds;
  }, [d.activePage, d.activeTree, d.canvasMode, d.mainView, pinned, session, d.openJournal, d.createPage, d.deletePage, d.renameActivePage, d.syncNow]);
}
