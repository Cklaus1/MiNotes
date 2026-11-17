import { useState, useEffect, useCallback, useRef } from "react";
import Sidebar from "./components/Sidebar";
import PageView from "./components/PageView";
import RightSidebar from "./components/RightSidebar";
import EmptyState from "./components/EmptyState";
import SearchPanel from "./components/SearchPanel";
import QueryPanel from "./components/QueryPanel";
import ReviewPanel from "./components/ReviewPanel";
import CanvasMode, { type CanvasModeType } from "./components/CanvasMode";
import { generateWhiteboardId, hasWhiteboardData } from "./lib/whiteboardUtils";
import { addRecentPage } from "./lib/recentFiles";
import { errorMessage, saveErrorMessage } from "./lib/errors";
import SyncPanel from "./components/SyncPanel";
import PdfViewer from "./components/PdfViewer";
import OpenPdfDialog from "./components/OpenPdfDialog";
import { getRecentPdfs, pickPdf } from "./lib/pdfFiles";
import MobileNav from "./components/MobileNav";
import ObsidianPluginBrowser from "./components/ObsidianPluginBrowser";
import CssSnippetManager from "./components/CssSnippetManager";
import SettingsPanel from "./components/SettingsPanel";
import FolderSettingsPanel from "./components/FolderSettingsPanel";
import { targetSettingsSection } from "./lib/settingsTarget";
import TasksView from "./components/TasksView";
import { cleanupGeneratedTodoPagesOnce } from "./lib/tasks";
import { composeWindowTitle, journalTitle, setWindowTitle } from "./lib/windowTitle";
import * as api from "./lib/api";
import { localDateKey, shiftDateKey } from "./lib/dates";
import { isTauri } from "./lib/api";
import { initTheme, toggleTheme } from "./lib/theme";
import { initTestApi, registerTestApi } from "./lib/testApi";
import { loadEnabledSnippets } from "./lib/cssLoader";
import { isOnboardingComplete, markOnboardingComplete, TUTORIAL_BLOCKS } from "./lib/onboarding";
import { executeUndo } from "./lib/undoManager";
import { undoStack } from "./lib/undoStack";
import { showToast, showUndoToast } from "./lib/toast";
import { plural } from "./lib/confirm";
import { installBrokenImageHints } from "./lib/brokenImages";
import { installRemoteImages } from "./lib/remoteImages";
import { pageAsText } from "./lib/pageText";
import { pageTitleConflict } from "./lib/pageNames";
import { getRecentPages } from "./lib/recentFiles";
import { getSettings } from "./lib/settings";
import NotebookBanner from "./components/NotebookBanner";
import ConflictBanner from "./components/ConflictBanner";
import { CONFLICT_RESOLVED } from "./lib/conflicts";
import {
  applySyncStatus, getSyncView, phaseOf, setSyncView, SYNC_CONFIRM_EVENT, SYNC_NOW_EVENT,
} from "./lib/syncStatus";
import { listenOutsideEdits, OUTSIDE_PAGES_CHANGED } from "./lib/outsideEdits";
import {
  NOTEBOOK_SWITCHED, NOTEBOOKS_CHANGED, setNextExportDest, setNextPickedFolder, setNextZipPick, switchNotebook, useCapabilities,
} from "./lib/notebooks";
import { OPEN_IN_NOTEBOOK, type OpenInNotebook } from "./lib/crossNotebook";
import { setPendingReveal } from "./lib/pendingReveal";
import { trackWrite } from "./lib/pendingEdits";
import { notifyCardsChanged } from "./lib/cards";
// ── AI platform ──
import AiMount from "./components/AiMount";
// ── Import ──
import ImportMount from "./components/ImportMount";
import { openImport } from "./lib/importPicks";
import { askNewPage } from "./lib/newPage";
import Icon from "./components/Icon";
import { DRAWER_BELOW_PX, isDrawerWidth, isSidebarToggleKey, loadSidebarCollapsed, saveSidebarCollapsed, useDrawerWidth } from "./lib/sidebarLayout";
import { useLayer } from "./lib/layers";
import ShortcutsOverlay from "./components/ShortcutsOverlay";
// UX Wave 4 (views): remembered page views, image lightbox
import { useRememberedPageView } from "./lib/pageView";
import MediaHost from "./components/MediaHost";
// ── Navigation (UX Wave 4) ──
import AllPagesView from "./components/AllPagesView";
import TrashView from "./components/TrashView";
import { cancelNavStep, noteLocation, setNavExecutor, takePendingNav, goBack, goForward, goToCurrent, navHistorySnapshot, setPendingNav, useNavHistory, type NavEntry } from "./lib/navHistory";
import { useAppCommands } from "./lib/appCommands";
// ── Tabs (PRD-tabs) ──
import TabBar from "./components/TabBar";
import type { TabBarItem } from "./lib/tabBarTypes";
import {
  activateTab, closeOtherTabs, closeTab, closeTabsToRight, cycleTab, duplicateTab, getTabsSnapshot, goToTab,
  loadNotebookTabs, moveActiveTab, moveTab, newEmptyTab, newTab, openInNewTab, reopenClosedTab, tabsNotebook,
  togglePin, useNotebookTabs, useTabs,
} from "./lib/tabs";
import { openInTab, setOpenInTabHandler, type OpenMode } from "./lib/openIntent";
import { openInNotebook } from "./lib/crossNotebook";
import { tabLabel } from "./lib/tabLabels";
import { isConfirmOpen } from "./lib/confirm";
import { isBusy } from "./lib/busy";
type MainView = null | "tasks" | "pages" | "trash" | "archive";
// ── End import ──
// ── End AI platform ──

export default function App() {
  const [activePage, setActivePage] = useState<api.PageTree | null>(null);
  // Navigation token: bumped on every navigation. Every async page fetch captures it
  // and drops its result if the user navigated in the meantime, so a slow or
  // out-of-order response can never yank the user back to a page they left.
  const navTokenRef = useRef(0);
  const activePageIdRef = useRef<string | null>(null);
  activePageIdRef.current = activePage?.page.id ?? null;
  const [pendingJournalDate, setPendingJournalDate] = useState<string | null>(null);
  const [stats, setStats] = useState<api.GraphStats | null>(null);
  const caps = useCapabilities();
  const [openPanel, setOpenPanel] = useState<string | null>(null);
  const [canvasMode, setCanvasMode] = useState<CanvasModeType | null>(null);
  const [whiteboardId, setWhiteboardId] = useState<string | null>(null);
  // A page marked "open as board / mind map" (view:: property) opens in that view.
  useRememberedPageView(activePage?.page.id, (mode) => setCanvasMode(mode));
  const [pdfViewerPath, setPdfViewerPath] = useState<string | null>(null);
  // Ctrl+P with PDFs opened before: pick from the recent ones or choose a file.
  const [pdfChooser, setPdfChooser] = useState<string[] | null>(null);
  const choosePdf = useCallback(async () => {
    setPdfChooser(null);
    try {
      const path = await pickPdf();
      if (path) setPdfViewerPath(path);
    } catch (err) {
      showToast(`Couldn't open the file picker: ${errorMessage(err)}`);
    }
  }, []);
  const openPdfFlow = useCallback(async () => {
    const recent = await getRecentPdfs();
    if (recent.length > 0) setPdfChooser(recent);
    else void choosePdf();
  }, [choosePdf]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [mobileTab, setMobileTab] = useState("pages");
  const [lastError, setLastError] = useState<string | null>(null);
  const [rightSidebarPanels, setRightSidebarPanels] = useState<Array<{id: string, title: string}>>([]);
  const [rightSidebarVisible, setRightSidebarVisible] = useState(true);
  // Left sidebar: hidden by the user (remembered on this device), or a drawer
  // in a narrow window (lib/sidebarLayout.ts). Ctrl+Shift+\ toggles it.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(loadSidebarCollapsed);
  const drawerWidth = useDrawerWidth();
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => { if (!drawerWidth) setDrawerOpen(false); }, [drawerWidth]);
  const sidebarHidden = drawerWidth ? !drawerOpen : sidebarCollapsed;
  const toggleSidebar = useCallback(() => {
    if (isDrawerWidth()) setDrawerOpen(v => !v);
    else setSidebarCollapsed(v => { saveSidebarCollapsed(!v); return !v; });
  }, []);
  useLayer(drawerWidth && drawerOpen, "panel", () => setDrawerOpen(false));
  const [folderSettingsId, setFolderSettingsId] = useState<string | null>(null);
  // A view shown in place of the page (the page stays open underneath): Tasks
  // (sidebar TODO badge), All Pages, Trash, Archive.
  const [mainView, setMainView] = useState<MainView>(null);
  const showTasks = mainView === "tasks";

  // Git Sync state: the shared status lives in lib/syncStatus (chip, Settings).
  const syncingRef = useRef(false);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Deletions from another device that sync's mass-delete guard is holding.
  const [heldDeletions, setHeldDeletions] = useState<api.HeldDeletions | null>(null);
  // Sync is on in a folder set up on another computer: ask before syncing it here.
  const [syncNeedsConfirm, setSyncNeedsConfirm] = useState(false);
  // Key of the open notebook (remounts per-notebook views such as the AI panel).
  const [notebookKey, setNotebookKey] = useState<string>("");
  const notebookKeyRef = useRef("");
  notebookKeyRef.current = notebookKey;

  // ── Tabs (PRD-tabs): lib/tabs.ts holds them (per notebook, ui_state "tabs.v1");
  // App shows the active tab's place. Android: no tab row (one page at a time).
  const tabsOn = !caps.mobile;
  const tabsView = useTabs();
  const { canBack, canForward } = useNavHistory();
  useNotebookTabs(notebookKey);
  // The notebook the tab store already had when App mounted (remounted after
  // unlocking: its tabs are in memory, App reopens the active one).
  const tabsNotebookAtMount = useRef(tabsNotebook());
  // A tab opened by "+" with New tabs open → "A new page": a title field, the
  // page is created when the title is confirmed (an unused tab leaves nothing).
  const draftTabIds = useRef(new Set<string>());
  const [newPageDraft, setNewPageDraft] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  // The tab's page went to the Trash or no longer exists (shown in its place).
  const [goneNotice, setGoneNotice] = useState<{ kind: "trash" | "missing"; pageId: string; title: string } | null>(null);
  // New tabs open → "Search": the palette opens once the new tab's page is shown.
  const openSearchAfterNavRef = useRef(false);
  const openNewTabRef = useRef<() => void>(() => {});
  const [narrowWindow, setNarrowWindow] = useState(() => typeof window !== "undefined" && window.innerWidth < DRAWER_BELOW_PX);
  useEffect(() => {
    const onResize = () => setNarrowWindow(window.innerWidth < DRAWER_BELOW_PX);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const s = await api.getGraphStats();
      setStats(s);
      setRefreshKey(k => k + 1);
    } catch (e) {
      console.error("Failed to refresh:", e);
    }
  }, []);

  // Once per notebook: the old TODO badge's generated "All TODOs" pages go to the
  // Trash (the Tasks view replaces them). Says so, so nothing vanishes silently.
  const runTodoPageCleanup = useCallback(() => {
    cleanupGeneratedTodoPagesOnce().then(titles => {
      if (titles.length === 0) return;
      showToast("Moved the old generated “All TODOs” page to the Trash — the TODO badge now opens the Tasks view", 8000);
      refresh();
      window.dispatchEvent(new Event("minotes-sidebar-refresh"));
    });
  }, [refresh]);

  // Mobile: the OS may kill a backgrounded app at any time, and the editor saves
  // a block on blur. Blur it when the app goes to the background so the normal
  // save runs while the process is still alive.
  useEffect(() => {
    if (!caps.mobile) return;
    const onHide = () => {
      if (document.visibilityState !== "hidden") return;
      const el = document.activeElement as HTMLElement | null;
      if (el && el !== document.body) el.blur();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [caps.mobile]);

  // Listen for external DB writes (e.g. CLI) and refresh the sidebar automatically
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen<null>("db-changed", () => {
        window.dispatchEvent(new Event("minotes-sidebar-refresh"));
      }).then(fn => { unlisten = fn; });
    });
    return () => { unlisten?.(); };
  }, []);

  const openPage = useCallback(async (titleOrId: string) => {
    // Re-opening the page already shown is a REFRESH, not a navigation: it must not
    // invalidate a navigation the user started meanwhile, and must itself be dropped
    // if the user navigates away before it resolves.
    const isRefresh = titleOrId === activePageIdRef.current;
    const token = isRefresh ? navTokenRef.current : ++navTokenRef.current;
    const refreshedId = activePageIdRef.current;
    const stale = () => token !== navTokenRef.current ||
      (isRefresh && activePageIdRef.current !== refreshedId);
    try {
      setLastError(null);
      console.log("[openPage]", titleOrId);
      let tree;
      try {
        tree = await api.getPageTree(titleOrId);
      } catch (notFound) {
        // Bug #32: pages are no longer auto-created on every save. Instead, create
        // a [[wiki-link]] target on demand the first time the user navigates to it.
        // Only do this for title-based navigation (a UUID means a real page that
        // genuinely doesn't exist — don't fabricate one).
        const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(titleOrId);
        if (looksLikeUuid) throw notFound;
        // A mistyped link ("[[Project Alpha ]]") means the page without the stray
        // whitespace — open that one, and never create a title with edge spaces.
        const title = titleOrId.trim();
        if (!title) throw notFound;
        if (title !== titleOrId) {
          try { tree = await api.getPageTree(title); } catch { /* create below */ }
        }
        if (!tree) {
          const created = await api.createPage(title);
          tree = await api.getPageTree(created.id);
        }
      }
      console.log("[openPage] got tree:", tree.page.title, "blocks:", tree.blocks.length);
      if (stale()) return; // superseded by a later navigation
      if (!isRefresh) setMainView(null);
      setActivePage(tree);
      setRefreshKey(k => k + 1);
      addRecentPage(tree.page.id, tree.page.title);
    } catch (e: any) {
      if (stale()) return;
      const msg = errorMessage(e);
      console.error("Failed to open page:", msg);
      setLastError(`Couldn't open page: ${msg}`);
    }
  }, []);

  // Draw (Ctrl+W / sidebar button) opens a NEW whiteboard without touching the page:
  // the `{{whiteboard:<id>}}` block is only appended once the board is saved with
  // real content (first stroke/note/text/image). Just peeking leaves nothing behind.
  // Map: whiteboard id -> page id that should receive the block.
  const pendingBoardsRef = useRef<Map<string, string>>(new Map());
  const openNewWhiteboard = useCallback((pageId: string) => {
    const wbId = generateWhiteboardId();
    pendingBoardsRef.current.set(wbId, pageId);
    setWhiteboardId(wbId);
    setCanvasMode("draw");
  }, []);
  // A board belongs to the page it was opened from: once the canvas closes, the
  // Draw tab must not silently reopen it over another page.
  useEffect(() => { if (!canvasMode) setWhiteboardId(null); }, [canvasMode]);
  useEffect(() => {
    const onSaved = (e: Event) => {
      const wbId = (e as CustomEvent).detail as string;
      const pageId = pendingBoardsRef.current.get(wbId);
      // Camera/grid-only saves have no content — keep waiting.
      if (!pageId || !hasWhiteboardData(wbId)) return;
      pendingBoardsRef.current.delete(wbId);
      // Tracked: a notebook switch waits for it (the save barrier flushes the
      // board, which lands here; the block must go into the SAME notebook).
      trackWrite(api.createBlock(pageId, `{{whiteboard:${wbId}}}`))
        .then(() => { if (activePageIdRef.current === pageId) return openPage(pageId); })
        .catch((err) => {
          pendingBoardsRef.current.set(wbId, pageId); // retry on the next save
          console.error("Failed to add whiteboard block:", err);
        });
    };
    window.addEventListener("whiteboard-saved", onSaved);
    return () => window.removeEventListener("whiteboard-saved", onSaved);
  }, [openPage]);

  // Resolves true once the page exists and is open. On failure it shows the reason
  // and stays where it is — a rejected create never navigates.
  const createPage = useCallback(async (rawTitle: string): Promise<boolean> => {
    const title = rawTitle.trim();
    if (!title) return false;
    try {
      setLastError(null);
      console.log("[createPage]", title);
      const page = await api.createPage(title);
      console.log("[createPage] created:", page.id, page.title);
      await refresh();
      await openPage(page.id);
      return true;
    } catch (e: any) {
      const msg = errorMessage(e);
      console.error("Failed to create page:", msg);
      setLastError(`Couldn't create page "${title}": ${msg}`);
      return false;
    }
  }, [refresh, openPage]);

  // Rename the open page. Rejections (e.g. the title is taken) are shown and the
  // page keeps its old title; the promise rejects so callers can react too.
  const renameActivePage = useCallback(async (pageId: string, rawTitle: string) => {
    const title = rawTitle.trim();
    if (!title) return;
    let failure: unknown = null;
    try {
      const conflict = await pageTitleConflict(title, pageId);
      if (conflict) throw new Error(conflict);
      await api.renamePage(pageId, title);
    } catch (e) {
      failure = e;
    }
    // Re-read the page either way so the title shown is the one stored
    // (openPage clears the banner, so the error is set after it).
    if (activePageIdRef.current === pageId) await openPage(pageId);
    refresh();
    if (failure !== null) {
      const msg = errorMessage(failure).replace(/^Already exists:\s*/i, "");
      const text = `Couldn't rename to "${title}": ${msg}`;
      setLastError(text);
      setTimeout(() => setLastError(prev => prev === text ? null : prev), 8000);
      throw failure;
    }
  }, [openPage, refresh]);

  const openJournal = useCallback(async (date?: string) => {
    const token = ++navTokenRef.current;
    setMainView(null);
    try {
      const d = date ?? localDateKey();
      const isToday = !date || d === localDateKey();

      if (isToday) {
        // Today's journal: always force-create (expected UX on launch and Ctrl+J)
        const tree = await api.getJournal(d);
        if (token !== navTokenRef.current) return;
        setActivePage(tree);
        setRefreshKey(k => k + 1);
        addRecentPage(tree.page.id, tree.page.title);
        setPendingJournalDate(null);
        return;
      }

      // Other dates: soft-create (check if exists first)
      const existing = await api.findJournalPage(d);
      if (token !== navTokenRef.current) return;
      if (existing) {
        const tree = await api.getPageTree(existing.id);
        if (token !== navTokenRef.current) return;
        setActivePage(tree);
        setRefreshKey(k => k + 1);
        addRecentPage(tree.page.id, tree.page.title);
        setPendingJournalDate(null);
      } else {
        // Show pending state — don't create page yet
        setActivePage(null);
        setPendingJournalDate(d);
      }
    } catch (e) {
      console.error("Failed to open journal:", e);
    }
  }, []);

  // Materialize a pending journal when user clicks "Start writing"
  const materializeJournal = useCallback(async () => {
    if (!pendingJournalDate) return;
    const token = ++navTokenRef.current;
    try {
      // Create the journal page by title — the backend treats Journal/YYYY-MM-DD as journal pages
      const title = `Journal/${pendingJournalDate}`;
      await api.createPage(title).catch(() => {}); // OK if it already exists
      // Now open it — it should exist in the database
      const tree = await api.getPageTree(title);
      if (token !== navTokenRef.current) return;
      setActivePage(tree);
      setRefreshKey(k => k + 1);
      addRecentPage(tree.page.id, tree.page.title);
      setPendingJournalDate(null);
    } catch (e) {
      console.error("Failed to create journal:", e);
    }
  }, [pendingJournalDate]);

  const createBlock = useCallback(async (content: string) => {
    if (!activePage) return;
    try {
      await api.createBlock(activePage.page.id, content);
      await openPage(activePage.page.id);
    } catch (e) {
      console.error("Failed to create block:", e);
    }
  }, [activePage, openPage]);

  const updateBlock = useCallback(async (id: string, content: string) => {
    try {
      await api.updateBlock(id, content);
      window.dispatchEvent(new Event("minotes-content-saved"));
      // Don't refresh the full page on every keystroke save — it kills focus.
      // Only refresh if content contains [[ links that might need resolving.
      if (content.includes("[[") && activePage) {
        // Delay the refresh slightly so it doesn't steal focus. It must never
        // navigate: drop it if the user moved on (token) or the page changed.
        const token = navTokenRef.current;
        const pageId = activePage.page.id;
        setTimeout(async () => {
          if (token !== navTokenRef.current || activePageIdRef.current !== pageId) return;
          try {
            const tree = await api.getPageTree(pageId);
            if (token !== navTokenRef.current || activePageIdRef.current !== pageId) return;
            setActivePage(tree);
          } catch {}
        }, 500);
      }
    } catch (e) {
      console.error("Failed to update block:", e);
      setLastError(saveErrorMessage(e));
      setTimeout(() => setLastError(null), 8000);
    }
  }, [activePage]);

  const deleteBlock = useCallback(async (id: string) => {
    try {
      // Snapshot the block's subtree (deleteBlock cascades) so Ctrl+Z restores
      // it with its original ids. Uses a fresh tree: activePage.blocks lags
      // PageView's optimistic creates.
      const restore = activePage
        ? await api.getPageTree(activePage.page.id)
            .then(tree => api.snapshotSubtrees([id], tree.blocks))
            .catch(() => [] as api.RestoreBlock[])
        : [];
      await api.deleteBlock(id);
      if (activePage && restore.length > 0) {
        undoStack.push({ type: 'delete', blockId: id, pageId: activePage.page.id, restore, timestamp: Date.now() });
      }
      if (activePage) await openPage(activePage.page.id);
    } catch (e) {
      console.error("Failed to delete block:", e);
      setLastError("Failed to delete block — check your connection");
      setTimeout(() => setLastError(null), 5000);
    }
  }, [activePage, openPage]);

  // Undo for the most recent page delete. Ctrl+Z (outside an editor) restores it
  // as long as nothing newer happened: any edit, save or block action afterwards
  // makes block-level undo the "most recent" again.
  const pageUndoRef = useRef<{ id: string; title: string; restore: () => Promise<void> } | null>(null);
  useEffect(() => {
    const invalidate = () => { pageUndoRef.current = null; };
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (["Shift", "Control", "Meta", "Alt", "CapsLock"].includes(e.key)) return;
      if (t?.closest?.(".ProseMirror, .cm-editor") && !(e.ctrlKey || e.metaKey)) invalidate();
    };
    // Ctrl+Z right after a page delete restores the page — even when the cursor
    // already sits in a block of the page shown next (capture phase, so it runs
    // before the editor's own undo, which has nothing to undo on a fresh page).
    const onUndoKey = (e: KeyboardEvent) => {
      if (!pageUndoRef.current || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      if (e.key.toLowerCase() !== "z") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      e.preventDefault();
      e.stopPropagation();
      pageUndoRef.current.restore();
    };
    const onPointer = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.(".page-view, .canvas-layer")) invalidate();
    };
    window.addEventListener("minotes-content-saved", invalidate);
    window.addEventListener("keydown", onUndoKey, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("minotes-content-saved", invalidate);
      window.removeEventListener("keydown", onUndoKey, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, []);

  // Move a page to Trash. If it is the open page, leave it first (to the page
  // visited before it, else today's journal) so nothing can be typed into a
  // trashed page. Undo: the toast button (10 s) or Ctrl+Z.
  const deletePage = useCallback(async (id: string, title?: string) => {
    const wasOpen = activePageIdRef.current === id;
    const label = title ?? (wasOpen ? activePage?.page.title : undefined) ?? "Page";
    try {
      await api.trashPage(id); // explicit soft delete (the mock's delete_page is a hard delete)
    } catch (e) {
      console.error("Failed to delete page:", e);
      setLastError(`Couldn't delete "${label}": ${errorMessage(e)}`);
      setTimeout(() => setLastError(null), 8000);
      return;
    }
    if (wasOpen) {
      const previous = getRecentPages().find(r => r.id !== id);
      let left = false;
      if (previous) {
        try {
          const tree = await api.getPageTree(previous.id);
          const trashed = await api.listTrash().catch(() => [] as api.TrashItem[]);
          if (!trashed.some(t => t.id === tree.page.id)) {
            await openPage(tree.page.id);
            left = true;
          }
        } catch { /* fall back to the journal */ }
      }
      if (!left) {
        ++navTokenRef.current;
        setActivePage(null);
        await openJournal();
      }
    }
    await refresh();
    window.dispatchEvent(new Event("minotes-sidebar-refresh"));
    let undone = false;
    let dismissToast = () => {};
    const restore = async () => {
      if (undone) return;
      undone = true;
      pageUndoRef.current = null;
      dismissToast();
      try {
        await api.restoreFromTrash(id, "page");
        await refresh();
        window.dispatchEvent(new Event("minotes-sidebar-refresh"));
        if (wasOpen) await openPage(id);
        showToast(`Restored "${label}"`);
      } catch (e) {
        setLastError(`Couldn't restore "${label}": ${errorMessage(e)}`);
      }
    };
    pageUndoRef.current = { id, title: label, restore };
    dismissToast = showUndoToast(`"${label}" moved to Trash`, restore, 10000, "Undo (Ctrl+Z)");
  }, [activePage, refresh, openPage, openJournal]);

  // All Pages → select → Move to Trash: one toast with Undo for all of them.
  const trashPages = useCallback(async (items: Array<{ id: string; title: string }>) => {
    if (items.length === 1) { await deletePage(items[0].id, items[0].title); return; }
    const done: typeof items = [];
    const failed: string[] = [];
    for (const it of items) {
      try { await api.trashPage(it.id); done.push(it); } catch { failed.push(it.title); }
    }
    if (activePageIdRef.current && done.some(d => d.id === activePageIdRef.current)) {
      ++navTokenRef.current;
      setActivePage(null); // nothing can be typed into a trashed page
    }
    await refresh();
    window.dispatchEvent(new Event("minotes-sidebar-refresh"));
    if (failed.length) showToast(`Couldn't move ${failed.map(t => `“${t}”`).join(", ")} to the Trash`, 8000);
    if (done.length === 0) return;
    showUndoToast(`${plural(done.length, "page")} moved to Trash`, async () => {
      for (const d of done) await api.restoreFromTrash(d.id, "page").catch(() => {});
      await refresh();
      window.dispatchEvent(new Event("minotes-sidebar-refresh"));
      showToast(`Restored ${plural(done.length, "page")}`);
    }, 10000);
  }, [deletePage, refresh]);

  // Leaving All Pages / Trash / Archive shows the page underneath (today's
  // journal if that page went to the Trash meanwhile).
  const closeMainView = useCallback(() => {
    setMainView(null);
    if (!activePageIdRef.current && !pendingJournalDate) openJournal().catch(() => {});
  }, [openJournal, pendingJournalDate]);

  const openInSidebar = useCallback(async (titleOrId: string) => {
    try {
      const tree = await api.getPageTree(titleOrId);
      setRightSidebarPanels(prev => {
        if (prev.some(p => p.id === tree.page.id)) return prev;
        return [...prev, { id: tree.page.id, title: tree.page.title }];
      });
      setRightSidebarVisible(true);
    } catch (e) {
      console.error("Failed to open in sidebar:", e);
    }
  }, []);

  // ── Git Sync ──

  // After a sync brought changes: re-open the page shown. A journal is found
  // again by its date — sync merges two devices' journals of one day into one
  // page, so the one shown may now be in the Trash.
  const reopenAfterSync = useCallback(async () => {
    const p = activePage?.page;
    if (!p) return;
    if (p.is_journal && p.journal_date) {
      const tree = await api.getJournal(p.journal_date).catch(() => null);
      if (tree && tree.page.id !== p.id && activePageIdRef.current === p.id) {
        openJournal(p.journal_date).catch(() => {});
        return;
      }
    }
    openPage(p.id).catch(() => {});
  }, [activePage, openPage, openJournal]);

  // `manual`: the user asked ("Sync now") — say what happened, also when
  // nothing could run. Automatic syncs (open, focus, after edits) stay quiet
  // unless something new goes wrong.
  const triggerSync = useCallback(async (manual = false) => {
    if (syncingRef.current) {
      if (manual) showToast("Already syncing…");
      return;
    }
    const refreshStatus = async () => applySyncStatus(await api.gitSyncStatus().catch(() => getSyncView().status));
    try {
      const status = await api.gitSyncStatus().catch(() => null);
      applySyncStatus(status);
      if (!status?.enabled) {
        if (manual) showToast("Sync is off for this notebook. Turn it on in Settings → Sync & Backup.");
        return;
      }
      if (status.needs_confirmation) {
        setSyncNeedsConfirm(true);
        if (manual) showToast("Sync is paused: this folder was set up on another computer. Choose “Sync it here” first.");
        return;
      }
      const previousError = getSyncView().error;
      syncingRef.current = true;
      setSyncView({ phase: "syncing" });
      const result = await api.gitSync();
      syncingRef.current = false;
      await refreshStatus();
      if (result.needs_confirmation) {
        setSyncNeedsConfirm(true);
        return;
      }
      setHeldDeletions(result.held_deletions ?? null);
      // Git conflicts are merged per block; only a block changed on both
      // devices keeps the other version as a separate page.
      const copies = result.conflict_pages ?? [];
      if (copies.length > 0) {
        const m = /^(.*) \(conflict from (.+?)\)(?: \(\d+\))?$/.exec(copies[0]);
        const page = m?.[1] ?? copies[0];
        const device = m?.[2] ?? "another device";
        const msg = copies.length === 1
          ? `Sync conflict: “${page}” was changed here and on ${device}. Both versions are kept — yours stays in place, ${device}'s is the page “${copies[0]}”.`
          : `Sync conflict in ${copies.length} pages (${copies.map(c => `“${(/^(.*) \(conflict from /.exec(c)?.[1]) ?? c}”`).join(", ")}). Both versions are kept — the other device's versions are the “(conflict from ${device})” pages.`;
        const open = copies[0];
        showUndoToast(msg, () => {
          api.getPageTree(open).then(t => openPage(t.page.id)).catch(() => showToast(`Couldn't open “${open}”`));
        }, 15000, "Open");
      }
      if (result.pages_imported > 0) {
        // (An import problem still brought the rest of the other device's changes.)
        refresh();
        reopenAfterSync();
      }
      if (result.success) {
        if (manual) {
          showToast(result.no_remote
            ? "Saved in the sync folder only: no remote is set, so nothing was sent anywhere."
            : "Synced");
        }
      } else if (result.offline) {
        // Remote unreachable: not a failure — local edits are kept and synced later.
        if (manual) showToast(`Can't reach the sync remote right now. Your notes are kept here and sync later.`);
      } else if (manual || result.error !== previousError) {
        showToast(`Sync failed: ${result.error ?? "Unknown error"}`);
      }
    } catch (e) {
      setSyncView({ phase: "error", error: errorMessage(e), errorKind: "other" });
      if (manual) showToast(`Sync failed: ${errorMessage(e)}`);
    } finally {
      syncingRef.current = false;
      if (getSyncView().phase === "syncing") setSyncView({ phase: phaseOf(getSyncView().status) });
    }
  }, [refresh, reopenAfterSync]);

  // A sync conflict copy was resolved (or that was undone): show the page it
  // went into (or the copy again) and let the sidebar drop / show the copy.
  useEffect(() => {
    const onResolved = (e: Event) => {
      const d = (e as CustomEvent<{ pageId: string; copyId: string; undone?: boolean }>).detail;
      if (d) openPage(d.undone ? d.copyId : d.pageId).catch(() => {});
      refresh();
      window.dispatchEvent(new Event("minotes-sidebar-refresh"));
    };
    window.addEventListener(CONFLICT_RESOLVED, onResolved);
    return () => window.removeEventListener(CONFLICT_RESOLVED, onResolved);
  }, [openPage, refresh]);

  // Files of the markdown copy edited in another app were imported: reload the
  // open page if it was one of them (the sidebar refreshes on its own).
  useEffect(() => listenOutsideEdits(), []);
  useEffect(() => {
    const onChanged = (e: Event) => {
      const ids = (e as CustomEvent<{ ids: string[] }>).detail?.ids ?? [];
      const cur = activePageIdRef.current;
      if (cur && ids.includes(cur)) openPage(cur).catch(() => {});
      refresh();
    };
    window.addEventListener(OUTSIDE_PAGES_CHANGED, onChanged);
    return () => window.removeEventListener(OUTSIDE_PAGES_CHANGED, onChanged);
  }, [openPage, refresh]);

  // The other device's mass deletion: the user decides.
  const resolveHeldDeletions = useCallback(async (action: "trash" | "keep", keep?: string[]) => {
    try {
      const n = await api.gitSyncResolveDeletions(action, keep);
      setHeldDeletions(null);
      showToast(action === "trash"
        ? `Moved ${n} item(s) to trash, as on the other device${keep?.length ? ` — kept ${keep.length}, the next sync sends them back` : ""}`
        : "Kept the pages; the next sync sends them back to the other device");
      refresh();
      if (activePage) openPage(activePage.page.id).catch(() => {});
    } catch (e) {
      showToast(`Couldn't apply that: ${errorMessage(e)}`);
    }
  }, [refresh, openPage, activePage]);

  // The user confirmed syncing a folder whose sync was set up elsewhere.
  const confirmSync = useCallback(async () => {
    try {
      const removed = await api.gitSyncConfirm();
      setSyncNeedsConfirm(false);
      showToast(removed.length
        ? `Syncing this folder here. Removed ${removed.length} setting(s) from its git config that could run programs.`
        : "Syncing this folder on this computer.");
      triggerSync();
    } catch (e) {
      showToast(`Couldn't turn on sync here: ${errorMessage(e)}`);
    }
  }, [triggerSync]);

  // Another notebook was opened: close views and panels, forget per-notebook UI
  // state, and land on that notebook's journal for today.
  useEffect(() => {
    api.getCurrentNotebook().then(k => setNotebookKey(k ?? "")).catch(() => {});
    const onSwitch = (e: Event) => {
      const key = (e as CustomEvent<{ key: string }>).detail?.key ?? "";
      setNotebookKey(key);
      navTokenRef.current++;
      // Boards opened in the old notebook are saved (save barrier) or empty:
      // their block must never be created in this one.
      pendingBoardsRef.current.clear();
      setOpenPanel(null);
      setCanvasMode(null);
      setWhiteboardId(null);
      setPdfViewerPath(null);
      setRightSidebarPanels([]);
      setFolderSettingsId(null);
      setMainView(null);
      setLastError(null);
      setPendingJournalDate(null);
      setActivePage(null);
      setHeldDeletions(null);
      setSyncNeedsConfirm(false);
      setSyncView({ phase: "off", status: null, error: null, errorKind: null });
      undoStack.clear();
      notifyCardsChanged();
      refresh();
      window.dispatchEvent(new Event("minotes-sidebar-refresh"));
      setGoneNotice(null);
      // This notebook's tabs first (lib/tabs): restored ones open the active
      // tab's page themselves. Back/forward into this notebook, a link, "Unlock
      // and open", "Create page in…": that step. Otherwise today's journal.
      void loadNotebookTabs(key).then(() => {
        const step = takePendingNav(key);
        if (step) runNavRef.current(step);
        else if (!activeTabHasPlace()) openJournal().catch(() => {});
      });
      runTodoPageCleanup();
      api.gitSyncStatus().then(status => {
        applySyncStatus(status);
        if (status.enabled) setTimeout(() => window.dispatchEvent(new Event("minotes-trigger-sync")), 0);
      }).catch(() => applySyncStatus(null));
    };
    window.addEventListener(NOTEBOOK_SWITCHED, onSwitch);
    return () => window.removeEventListener(NOTEBOOK_SWITCHED, onSwitch);
  }, [refresh, openJournal, runTodoPageCleanup]);

  // A cross-notebook search result or [[Notebook::Page]] link: switch notebooks
  // (the usual flow: views reset, undo cleared) and open the page there. The
  // switch's own landing on today's journal is superseded by this navigation.
  useEffect(() => {
    const onOpen = async (e: Event) => {
      const d = (e as CustomEvent<OpenInNotebook>).detail;
      if (!d?.pageId && !d?.title) return;
      try {
        if (d.key && d.key !== (await api.getCurrentNotebook())) {
          // Opened by the switch (a pending step, lib/navHistory) in that
          // notebook's active tab — never raced by its restored tabs.
          setPendingReveal(d.blockId ?? null);
          setPendingNav({ notebook: d.key, kind: "page", pageId: d.pageId || undefined, title: d.title, create: !d.pageId || undefined });
          await switchNotebook(d.key);
          return;
        }
        setPendingReveal(d.blockId ?? null);
        setOpenPanel(null);
        setCanvasMode(null);
        setMainView(null);
        await openPage(d.pageId || d.title!);
      } catch (err) {
        setLastError(`Couldn't open the page: ${errorMessage(err)}`);
      }
    };
    window.addEventListener(OPEN_IN_NOTEBOOK, onOpen);
    return () => window.removeEventListener(OPEN_IN_NOTEBOOK, onOpen);
  }, [openPage]);

  useEffect(() => {
    const h = () => { triggerSync(); };
    const now = () => { triggerSync(true); };
    const ok = () => { confirmSync(); };
    window.addEventListener("minotes-trigger-sync", h);
    window.addEventListener(SYNC_NOW_EVENT, now);
    window.addEventListener(SYNC_CONFIRM_EVENT, ok);
    return () => {
      window.removeEventListener("minotes-trigger-sync", h);
      window.removeEventListener(SYNC_NOW_EVENT, now);
      window.removeEventListener(SYNC_CONFIRM_EVENT, ok);
    };
  }, [triggerSync, confirmSync]);

  // Load sync status on mount + sync on app open
  useEffect(() => {
    api.gitSyncStatus().then(status => {
      applySyncStatus(status);
      if (status.enabled) triggerSync();
    }).catch(() => {});
  }, []);

  // Sync on app focus (visibilitychange)
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === "visible") triggerSync();
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [triggerSync]);

  // Sync on save (30s debounce) — listens for custom event from PageView
  useEffect(() => {
    const handler = () => {
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
      syncTimerRef.current = setTimeout(triggerSync, 30000);
    };
    window.addEventListener("minotes-content-saved", handler);
    return () => {
      window.removeEventListener("minotes-content-saved", handler);
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    };
  }, [triggerSync]);

  // Initialize test API, theme, and CSS snippets on mount
  useEffect(() => {
    initTestApi();
    initTheme();
    installBrokenImageHints();
    installRemoteImages();
    loadEnabledSnippets();
  }, []);

  // Register test API navigation methods
  useEffect(() => {
    registerTestApi({
      navigateTo: (titleOrId: string) => {
        openPage(titleOrId).catch(e => console.error("[testApi] navigateTo error:", e));
        return true;
      },
      refreshSidebar: () => {
        refresh();
        return true;
      },
      openJournal: (date?: string) => {
        openJournal(date);
        return true;
      },
      openSearch: () => {
        setOpenPanel("search");
        return true;
      },
      openSettings: () => {
        setOpenPanel("settings");
        return true;
      },
      openPdf: (path: string) => {
        setPdfViewerPath(path);
        return true;
      },
      closePanel: () => {
        setOpenPanel(null);
        setCanvasMode(null);
        setWhiteboardId(null);
        return true;
      },
      createPage: async (title: string) => {
        await createPage(title);
        return true;
      },
      createBlockInCurrentPage: async (content: string) => {
        if (!activePage) return false;
        await api.createBlock(activePage.page.id, content);
        openPage(activePage.page.id);
        return true;
      },
      getCurrentPage: () => activePage?.page.title ?? null,
      getOpenWhiteboardId: () => (canvasMode === "draw" ? whiteboardId : null),
      isPanelOpen: (name: string) => {
        const map: Record<string, boolean> = {
          search: openPanel === "search", query: openPanel === "query", graph: canvasMode === "graph",
          review: openPanel === "review", settings: openPanel === "settings", tasks: showTasks,
          pages: mainView === "pages", trash: mainView === "trash", archive: mainView === "archive",
        };
        return map[name] ?? false;
      },
    });
    // Back / forward and the main views (UX Wave 4).
    registerTestApi({
      goBack: () => { void goBack(); return true; },
      goForward: () => { void goForward(); return true; },
      navHistory: () => navHistorySnapshot(),
      openView: (name: string) => { setCanvasMode(null); setMainView(name === "none" ? null : name as MainView); return true; },
      getMainView: () => mainView,
    } as any);
    // Notebooks: switch like the sidebar menu does; drive the folder dialog
    // (automation can't drive the native picker).
    registerTestApi({
      switchNotebook: (key: string) => switchNotebook(key).then(() => true),
      setNextPickedFolder: (path: string | null) => { setNextPickedFolder(path); return true; },
      setNextZipPick: (path: string | null) => { setNextZipPick(path); return true; },
      setNextExportDest: (path: string | null) => { setNextExportDest(path); return true; },
      getNotebookKey: () => notebookKey,
    } as any);
  }, [activePage, openPanel, canvasMode, whiteboardId, notebookKey, showTasks, mainView]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      // A key something else already handled (the editor's own bindings, a
      // panel, the page-delete undo below) is not an app shortcut.
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement;
      // Block editor (ProseMirror / CodeMirror): app chords work here too — the
      // editor binds none of them — but a key the editor already handled
      // (preventDefault) is left alone.
      const inEditor =
        !!target.closest?.(".ProseMirror, .cm-editor") || target.isContentEditable;
      // Plain text fields (search, titles, kanban inputs, SQL): only the small
      // always-on set (search, settings, theme, sidebar) acts here.
      const inTextField = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const plain = !e.shiftKey && !e.altKey;
      const appChord = !inTextField; // chords that would disrupt typing in a field

      // Cmd/Ctrl+K — search
      if (key === "k" && plain) {
        e.preventDefault();
        setOpenPanel(prev => prev === "search" ? null : "search");
      }
      // Cmd/Ctrl+J — today's journal
      if (key === "j" && plain && appChord) {
        e.preventDefault();
        setCanvasMode(null);
        openJournal();
      }
      // Cmd/Ctrl+Q — query panel
      if (key === "q" && plain && appChord) {
        e.preventDefault();
        setOpenPanel(prev => prev === "query" ? null : "query");
      }
      // Cmd/Ctrl+G — graph view
      if (key === "g" && plain && appChord) {
        e.preventDefault();
        setCanvasMode(prev => prev === "graph" ? null : "graph");
      }
      // Cmd/Ctrl+R — review panel
      if (key === "r" && plain && appChord) {
        e.preventDefault();
        setOpenPanel(prev => prev === "review" ? null : "review");
      }
      // Cmd/Ctrl+Z — undo (inside an editor the editor's own undo runs; a page
      // delete is undone by the capture-phase listener below)
      if (key === "z" && !e.shiftKey && !e.altKey) {
        if (!inEditor && !inTextField) {
          e.preventDefault();
          executeUndo()
            .then(() => activePage ? openPage(activePage.page.id) : Promise.resolve())
            .then(() => refresh())
            .catch(() => setLastError("Undo failed"));
        }
      }
      // Cmd/Ctrl+Shift+Z / Ctrl+Y — redo: handled by PageView (capture phase).
      // Cmd/Ctrl+N — new page
      if (key === "n" && plain && appChord) {
        e.preventDefault();
        askNewPage().then(title => { if (title) createPage(title); });
      }
      // Cmd/Ctrl+T — new tab; Cmd/Ctrl+W — close the tab (never the last one)
      if (key === "t" && plain && tabsOn) {
        e.preventDefault();
        if (!isConfirmOpen() && !isBusy()) openNewTabRef.current();
      }
      if (key === "w" && plain && tabsOn) {
        e.preventDefault();
        const snap = getTabsSnapshot();
        if (!isConfirmOpen() && !isBusy() && snap.tabs.length > 1) closeTab(snap.activeId);
      }
      // Cmd/Ctrl+Shift+W — new whiteboard / toggle draw mode
      if (key === "w" && e.shiftKey && !e.altKey && appChord) {
        e.preventDefault();
        if (canvasMode === "draw") {
          setCanvasMode(null);
          setWhiteboardId(null);
        } else if (activePage) {
          openNewWhiteboard(activePage.page.id);
        } else {
          showToast("Open a page first — a new board is added to the page you draw it on");
        }
      }
      // Cmd/Ctrl+M — mind map view
      if (key === "m" && plain && appChord) {
        e.preventDefault();
        if (activePage) setCanvasMode(prev => prev === "mindmap" ? null : "mindmap");
      }
      // Cmd/Ctrl+Shift+K — kanban view
      if (key === "k" && e.shiftKey && !e.altKey && appChord) {
        e.preventDefault();
        if (activePage) setCanvasMode(prev => prev === "kanban" ? null : "kanban");
      }
      // Cmd/Ctrl+Shift+C — copy the open page as text
      if (key === "c" && e.shiftKey && !e.altKey && appChord && activePage) {
        e.preventDefault();
        const pageId = activePage.page.id;
        const title = activePage.page.title;
        api.getPageTree(pageId)
          .then(tree => navigator.clipboard.writeText(pageAsText(tree.blocks)))
          .then(() => showToast(`Copied "${title}" to the clipboard`))
          .catch(err => showToast(`Couldn't copy the page: ${errorMessage(err)}`));
      }
      // Cmd/Ctrl+P — open a PDF (native file picker; recent PDFs first if any)
      if (key === "p" && plain && appChord) {
        e.preventDefault();
        void openPdfFlow();
      }
      // Ctrl+Shift+T — toggle theme
      if (key === "t" && e.shiftKey && !e.altKey) {
        e.preventDefault();
        toggleTheme();
      }
      // Ctrl+, — settings
      if (key === "," && plain) {
        e.preventDefault();
        setOpenPanel(prev => prev === "settings" ? null : "settings");
      }
      // Ctrl+Shift+\ — show/hide the left sidebar (a drawer in a narrow window)
      if (isSidebarToggleKey(e)) {
        e.preventDefault();
        toggleSidebar();
        return;
      }
      // Ctrl+\ — toggle right sidebar
      if (key === "\\" && plain) {
        e.preventDefault();
        setRightSidebarVisible(prev => !prev);
      }
      // Phase 4: Ctrl+1-7 — open pinned pages by position
      if (plain && appChord) {
        const num = parseInt(key, 10);
        if (num >= 1 && num <= 7) {
          e.preventDefault();
          api.listFavorites().then(favs => {
            if (favs.length >= num) {
              setCanvasMode(null);
              openPage(favs[num - 1].id);
            }
          }).catch(() => {});
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [openJournal, createPage, activePage, whiteboardId, canvasMode, openNewWhiteboard, openPage, refresh, openPdfFlow, tabsOn]);

  // ── Back / forward (lib/navHistory): where the user is, and how to go back there ──
  const navLocation: NavEntry | null = !notebookKey ? null
    : mainView ? { notebook: notebookKey, kind: "view", view: mainView }
    : canvasMode === "graph" ? { notebook: notebookKey, kind: "view", view: "graph" }
    : activePage ? { notebook: notebookKey, kind: "page", pageId: activePage.page.id, title: activePage.page.title }
    : pendingJournalDate ? { notebook: notebookKey, kind: "journal-day", date: pendingJournalDate }
    : null;
  const navKey = navLocation ? JSON.stringify(navLocation) : "";
  useEffect(() => { noteLocation(navLocation); }, [navKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const runNav = useCallback(async (e: NavEntry) => {
    // A tab switch closes what is open over the page (palette, overlays); "+"
    // with New tabs open → Search opens the palette over the new tab.
    setOpenPanel(openSearchAfterNavRef.current ? "search" : null);
    openSearchAfterNavRef.current = false;
    setPdfViewerPath(null);
    setGoneNotice(null);
    if (e.kind === "view") {
      if (e.view === "graph") { setMainView(null); setCanvasMode("graph"); }
      else { setCanvasMode(null); setMainView(e.view ?? null); }
      return;
    }
    setCanvasMode(null);
    setMainView(null);
    if (e.kind === "journal-day" && e.date) { await openJournal(e.date); return; }
    const label = e.title ?? "That page";
    if (e.pageId) {
      // A page that is gone or in the Trash is not opened again by Back or a
      // tab: the tab shows why, in place of the page (Restore / Close tab).
      const gone = (kind: "trash" | "missing") => {
        ++navTokenRef.current;
        setActivePage(null);
        setPendingJournalDate(null);
        setGoneNotice({ kind, pageId: e.pageId!, title: label });
        cancelNavStep();
      };
      const trashed = await api.listTrash().catch(() => [] as api.TrashItem[]);
      if (trashed.some(t => t.id === e.pageId)) { gone("trash"); return; }
      try {
        await api.getPageTree(e.pageId);
      } catch {
        gone("missing");
        return;
      }
      await openPage(e.pageId);
      return;
    }
    if (!e.title) return;
    if (!e.create) {
      // By name (a link into a notebook that was locked): never create it silently.
      try {
        await api.getPageTree(e.title);
      } catch {
        showToast(`This notebook has no page “${e.title}”`);
        cancelNavStep();
        openJournal().catch(() => {});
        return;
      }
    }
    await openPage(e.title);
  }, [openPage, openJournal]);
  const runNavRef = useRef(runNav);
  runNavRef.current = runNav;
  useEffect(() => setNavExecutor((e) => { void runNavRef.current(e); }), []);

  // ── Tabs (PRD-tabs) ──

  // "+" / Ctrl+T: a new tab after the active one, opening what Settings →
  // Editor → "New tabs open" says.
  const openNewTab = useCallback(async () => {
    const key = notebookKeyRef.current;
    if (!key) return;
    const dest = getSettings().newTabOpens;
    if (dest === "pages") { newTab({ notebook: key, kind: "view", view: "pages" }); return; }
    if (dest === "page") { draftTabIds.current.add(newEmptyTab()); return; }
    try {
      const today = await api.getJournal(localDateKey());
      if (dest === "search") openSearchAfterNavRef.current = true;
      newTab({ notebook: key, kind: "page", pageId: today.page.id, title: today.page.title });
    } catch (err) {
      openSearchAfterNavRef.current = false;
      showToast(`Couldn't open a new tab: ${errorMessage(err)}`);
    }
  }, []);

  openNewTabRef.current = () => { void openNewTab(); };

  // Ctrl/middle-click on a page, link or view (lib/openIntent): a new tab.
  // Another notebook's page opens in the current tab (switching notebooks).
  const openEntryInTab = useCallback(async (raw: NavEntry, mode: Exclude<OpenMode, "current">) => {
    const key = notebookKeyRef.current || ((await api.getCurrentNotebook().catch(() => "")) ?? "");
    if (raw.notebook && raw.notebook !== key) {
      openInNotebook({ key: raw.notebook, pageId: raw.pageId ?? "", title: raw.pageId ? undefined : raw.title });
      return;
    }
    let entry: NavEntry;
    try {
      entry = await resolveTabEntry({ ...raw, notebook: key });
    } catch (err) {
      showToast(`Couldn't open that in a new tab: ${errorMessage(err)}`);
      return;
    }
    if (mode === "foreground") { openInNewTab(entry, { activate: true }); return; }
    openInNewTab(entry, { activate: false });
    const label = tabLabel(entry, { today: localDateKey() }).fullTitle;
    showToast(`Opened “${label}” in a background tab`, 2500);
  }, []);
  useEffect(() => (tabsOn ? setOpenInTabHandler((e, mode) => { void openEntryInTab(e, mode); }) : undefined), [tabsOn, openEntryInTab]);

  // Live page titles for the tabs that aren't shown (renames here, by sync, outside edits).
  const [pageTitles, setPageTitles] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [titlesTick, setTitlesTick] = useState(0);
  useEffect(() => {
    const bump = () => setTitlesTick(t => t + 1);
    window.addEventListener("minotes-sidebar-refresh", bump);
    window.addEventListener(OUTSIDE_PAGES_CHANGED, bump);
    return () => {
      window.removeEventListener("minotes-sidebar-refresh", bump);
      window.removeEventListener(OUTSIDE_PAGES_CHANGED, bump);
    };
  }, []);
  const severalTabs = tabsView.tabs.length > 1;
  useEffect(() => {
    if (!severalTabs || !tabsOn) return;
    let live = true;
    api.getFolderTree().then(tree => {
      if (!live) return;
      const m = new Map<string, string>();
      tree.root_pages.forEach(p => m.set(p.id, p.title));
      const walk = (fs: api.FolderTree[]) => { for (const f of fs) { f.pages.forEach(p => m.set(p.id, p.title)); walk(f.children ?? []); } };
      walk(tree.folders);
      setPageTitles(m);
    }).catch(() => {});
    return () => { live = false; };
  }, [severalTabs, tabsOn, stats, titlesTick, notebookKey]);

  const todayKey = localDateKey();
  const tabItems: TabBarItem[] = tabsView.tabs.map(t => {
    const active = t.id === tabsView.activeId;
    const label = active && newPageDraft && !t.entry ? { icon: "file-plus" as const, title: "New page", fullTitle: "New page" }
      // The shown page's own title is the freshest (a rename right here).
      : active && activePage && t.entry?.kind === "page" && t.entry.pageId === activePage.page.id
        ? tabLabel({ ...t.entry, title: activePage.page.title }, { today: todayKey })
        : tabLabel(t.entry, { titles: pageTitles, today: todayKey });
    return { id: t.id, pinned: t.pinned, ...label };
  });
  const tabItemsRef = useRef(tabItems);
  tabItemsRef.current = tabItems;
  const getTabItems = useCallback(() => tabItemsRef.current, []);

  // A "new page" tab shows its title field (also when switched back to).
  const activeTabView = tabsView.tabs.find(t => t.id === tabsView.activeId);
  const activeIsDraft = !!activeTabView && !activeTabView.entry && draftTabIds.current.has(activeTabView.id);
  useEffect(() => {
    if (!activeIsDraft) { setNewPageDraft(false); return; }
    ++navTokenRef.current;
    setOpenPanel(null);
    setCanvasMode(null);
    setPdfViewerPath(null);
    setMainView(null);
    setPendingJournalDate(null);
    setActivePage(null);
    setGoneNotice(null);
    setLastError(null);
    setDraftTitle("");
    setNewPageDraft(true);
  }, [activeIsDraft, tabsView.activeId]);
  // Anything shown in the tab replaces the Trash / gone notice.
  useEffect(() => { if (activePage || pendingJournalDate || mainView) setGoneNotice(null); }, [activePage, pendingJournalDate, mainView]);

  // Tab keys that must work while typing in a block (capture phase, before
  // ProseMirror): Ctrl+Tab / Ctrl+Shift+Tab, Ctrl+PgDn / PgUp (next /
  // previous), Ctrl+Shift+PgUp / PgDn (move the tab), Alt+1…8, Alt+9 (last).
  useEffect(() => {
    if (!tabsOn) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isConfirmOpen() || isBusy()) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const page = e.key === "PageDown" ? 1 : e.key === "PageUp" ? -1 : 0;
      const digit = e.altKey && !ctrl && !e.shiftKey
        ? Number(/^Digit([1-9])$/.exec(e.code)?.[1] ?? (/^[1-9]$/.test(e.key) ? e.key : 0))
        : 0;
      let act: (() => void) | null = null;
      if (ctrl && !e.altKey && e.key === "Tab") act = () => cycleTab(e.shiftKey ? -1 : 1);
      else if (ctrl && !e.altKey && !e.shiftKey && page) act = () => cycleTab(page as 1 | -1);
      else if (ctrl && !e.altKey && e.shiftKey && page) act = () => moveActiveTab(page as 1 | -1);
      else if (digit) act = () => goToTab(digit);
      if (!act) return;
      e.preventDefault();
      e.stopPropagation();
      act();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [tabsOn]);

  // Test hooks (journeys): the tab row as data, and its actions by index.
  useEffect(() => {
    const byIndex = (i?: number) => {
      const snap = getTabsSnapshot();
      return i === undefined ? snap.activeId : snap.tabs[i]?.id;
    };
    registerTestApi({
      tabs: () => {
        const snap = getTabsSnapshot();
        const items = tabItemsRef.current;
        return {
          activeId: snap.activeId,
          active: snap.tabs.findIndex(t => t.id === snap.activeId),
          closed: snap.closed,
          tabs: snap.tabs.map(t => {
            const cur = t.entries[t.index] ?? null;
            return {
              id: t.id, pinned: t.pinned, history: t.entries.length, index: t.index,
              title: items.find(x => x.id === t.id)?.fullTitle ?? null,
              kind: cur?.kind ?? null, pageId: cur?.pageId ?? null, pageTitle: cur?.title ?? null,
              view: cur?.view ?? null, date: cur?.date ?? null,
            };
          }),
        };
      },
      newTab: () => { openNewTabRef.current(); return true; },
      activateTab: (i: number) => { const id = byIndex(i); if (id) activateTab(id); return !!id; },
      closeTab: (i?: number) => { const id = byIndex(i); if (id) closeTab(id); return !!id; },
      pinTab: (i?: number) => { const id = byIndex(i); if (id) togglePin(id); return !!id; },
      duplicateTab: (i?: number) => { const id = byIndex(i); if (id) duplicateTab(id); return !!id; },
      reopenClosedTab: () => { reopenClosedTab(); return true; },
      cycleTab: (d: number) => { cycleTab(d < 0 ? -1 : 1); return true; },
      openInBackgroundTab: (titleOrId: string) => openInTab(tabTarget(titleOrId), "background"),
      openInForegroundTab: (titleOrId: string) => openInTab(tabTarget(titleOrId), "foreground"),
    } as any);
  }, []);

  const createDraftPage = useCallback(async () => {
    const title = draftTitle.trim();
    if (!title) return;
    await createPage(title);
  }, [draftTitle, createPage]);

  // Every app action in the command palette (lib/appCommands.ts).
  useAppCommands({
    activePage: activePage?.page ?? null,
    activeTree: activePage,
    canvasMode,
    mainView,
    setOpenPanel,
    setCanvasMode,
    setMainView,
    openJournal,
    createPage,
    deletePage,
    renameActivePage,
    openNewWhiteboard,
    toggleSidebar,
    toggleRightSidebar: () => setRightSidebarVisible(v => !v),
    syncNow: () => triggerSync(true),
    openPdf: () => { void openPdfFlow(); },
    refresh,
    newTab: () => { void openNewTab(); },
    tabItems: getTabItems,
  });

  // Window title: "Page — Notebook — MiNotes", following navigation, the view
  // shown, and notebook switches / renames. (Locked: LockGate sets it.)
  const [notebookName, setNotebookName] = useState("");
  useEffect(() => {
    const load = () => { api.getNotebookSession().then(s => setNotebookName(s?.name ?? "")).catch(() => {}); };
    load();
    window.addEventListener(NOTEBOOK_SWITCHED, load);
    window.addEventListener(NOTEBOOKS_CHANGED, load);
    return () => {
      window.removeEventListener(NOTEBOOK_SWITCHED, load);
      window.removeEventListener(NOTEBOOKS_CHANGED, load);
    };
  }, []);
  const viewLabel = showTasks ? "Tasks"
    : mainView === "pages" ? "All pages"
    : mainView === "trash" ? "Trash"
    : mainView === "archive" ? "Archive"
    : canvasMode === "graph" ? "Graph"
    : canvasMode === "pages" ? "All pages"
    : activePage ? (activePage.page.is_journal && activePage.page.journal_date ? journalTitle(activePage.page.journal_date) : activePage.page.title)
    : pendingJournalDate ? journalTitle(pendingJournalDate)
    : goneNotice ? goneNotice.title
    : newPageDraft ? "New page"
    : null;
  useEffect(() => {
    setWindowTitle(composeWindowTitle(viewLabel, notebookName));
  }, [viewLabel, notebookName]);

  // Alt+↑ / Alt+↓: previous / next journal day, while a journal day is shown
  // (a written one or an empty one). Not in text fields; a key something else
  // already handled (e.g. an editor binding) is left alone. Alt+←/→ zoom blocks.
  const journalDateShown = mainView ? null : (activePage?.page.is_journal ? activePage.page.journal_date ?? null : pendingJournalDate);
  useEffect(() => {
    if (!journalDateShown || canvasMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.defaultPrevented) return;
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
      if (document.querySelector("[role=dialog], .command-palette-overlay")) return;
      e.preventDefault();
      openJournal(shiftDateKey(journalDateShown, e.key === "ArrowUp" ? -1 : 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [journalDateShown, canvasMode, openJournal]);

  // UX-009: Journal as default landing + UX-017: Onboarding tutorial on first launch
  useEffect(() => {
    const init = async () => {
      try {
        await refresh();
      } catch (e) {
        console.error("[init] refresh failed:", e);
      }

      if (!isOnboardingComplete()) {
        try {
          const page = await api.createPage("Getting Started");
          for (const text of TUTORIAL_BLOCKS) {
            await api.createBlock(page.id, text);
          }
          // Untouched, it gives way to another device's copy when sync joins (C-9).
          await api.markOnboardingSeed(page.id).catch(() => {});
          markOnboardingComplete();
          await openPage(page.id);
          return;
        } catch (e) {
          console.error("[init] onboarding failed:", e);
          markOnboardingComplete();
        }
      }

      runTodoPageCleanup();
      const key = (await api.getCurrentNotebook().catch(() => "")) ?? "";
      // The notebook's saved tabs first, so the journal never flashes before
      // the restored tab's page (the load opens it).
      await loadNotebookTabs(key);
      // Mounted after an unlock that was a step into this notebook (Back, or
      // "Unlock and open" on a link): go there instead of the journal.
      const step = takePendingNav(key);
      if (step) { runNavRef.current(step); return; }
      if (activeTabHasPlace()) {
        // Remounted (after unlocking) with this notebook's tabs in memory: reopen the active one.
        if (tabsNotebookAtMount.current === key) void goToCurrent();
        return;
      }
      try {
        await openJournal();
      } catch (e) {
        console.error("[init] openJournal failed:", e);
        setLastError(`Init failed: ${typeof e === "string" ? e : JSON.stringify(e)}`);
      }
    };
    init();
  }, []);

  return (
    <div className={`app workspace${sidebarHidden ? " sidebar-hidden" : ""}${drawerWidth ? " sidebar-drawer-mode" : ""}`}>
      <div className="sidebar-shell" data-testid="sidebar-shell">
      <Sidebar
        onToggleSidebar={toggleSidebar}
        activePage={activePage?.page ?? null}
        stats={stats}
        onPageClick={(id) => { if (drawerWidth) setDrawerOpen(false); setMainView(null); return openPage(id); }}
        onCreatePage={createPage}
        onDeletePage={deletePage}
        onJournalClick={(date?: string) => openJournal(date)}
        onSearchClick={() => setOpenPanel("search")}
        onGraphClick={() => setCanvasMode(prev => prev === "graph" ? null : "graph")}
        onMindmapClick={() => { if (activePage) setCanvasMode(prev => prev === "mindmap" ? null : "mindmap"); }}
        onWhiteboardClick={() => {
          if (activePage) openNewWhiteboard(activePage.page.id);
        }}
        onKanbanClick={() => { if (activePage) setCanvasMode(prev => prev === "kanban" ? null : "kanban"); }}
        onPagesClick={() => { setCanvasMode(null); setMainView(v => v === "pages" ? null : "pages"); }}
        onTrashClick={() => { setCanvasMode(null); setMainView(v => v === "trash" ? null : "trash"); }}
        onArchiveClick={() => { setCanvasMode(null); setMainView(v => v === "archive" ? null : "archive"); }}
        activeView={mainView}
        onSettingsClick={() => setOpenPanel(prev => prev === "settings" ? null : "settings")}
        onFolderSettings={(id) => setFolderSettingsId(prev => prev === id ? null : id)}
        onReviewClick={() => setOpenPanel("review")}
        onTodoBadgeClick={() => {
          if (getSettings().ai?.todoExtraction === false) return; // Settings → AI → TODO extraction off
          setCanvasMode(null);
          setMainView("tasks");
        }}
        tasksOpen={showTasks}
        selectedJournalDate={mainView ? null : (activePage?.page.is_journal ? activePage.page.journal_date ?? null : pendingJournalDate)}
        activeMode={canvasMode === "graph" ? "graph" : canvasMode === "mindmap" ? "mindmap" : canvasMode === "draw" ? "whiteboard" : canvasMode === "kanban" ? "kanban" : canvasMode === "pages" || mainView === "pages" ? "pages" : null}
        refreshKey={refreshKey}
      />
      </div>
      {drawerWidth && drawerOpen && <div className="sidebar-drawer-backdrop" onMouseDown={() => setDrawerOpen(false)} data-testid="sidebar-backdrop" />}
      {sidebarHidden && (
        <>
          <button className="sidebar-reveal-btn" onClick={toggleSidebar} title="Show sidebar (Ctrl+Shift+\)" aria-label="Show sidebar" data-testid="sidebar-reveal">
            <Icon name="sidebar" size={18} />
          </button>
        </>
      )}
      <div className="main workspace-split mod-root" style={{ position: "relative", display: "flex", flexDirection: "row" }}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
          {tabsOn && (
            <TabBar
              tabs={tabItems}
              activeId={tabsView.activeId}
              canBack={canBack}
              canForward={canForward}
              onBack={() => { void goBack(); }}
              onForward={() => { void goForward(); }}
              onActivate={activateTab}
              onClose={closeTab}
              onNewTab={() => { void openNewTab(); }}
              onCloseOthers={closeOtherTabs}
              onCloseRight={closeTabsToRight}
              onTogglePin={togglePin}
              onDuplicate={duplicateTab}
              onReopenClosed={reopenClosedTab}
              canReopen={tabsView.canReopen}
              onMove={moveTab}
              compact={narrowWindow}
            />
          )}
          <NotebookBanner
            heldDeletions={heldDeletions}
            onResolveHeld={resolveHeldDeletions}
            onOpenPage={id => { openPage(id).catch(() => {}); }}
            syncNeedsConfirm={syncNeedsConfirm}
            onConfirmSync={confirmSync}
            onDeclineSync={() => setSyncNeedsConfirm(false)}
          />
          {activePage && !showTasks && <ConflictBanner key={activePage.page.id} page={activePage.page} onOpenPage={id => { openPage(id).catch(() => {}); }} />}
          {lastError && (
            <div style={{ background: "#f38ba8", color: "#1e1e2e", padding: "8px 16px", fontSize: 13, fontWeight: 600 }}>
              {lastError}
            </div>
          )}
          {pdfChooser && (
            <OpenPdfDialog
              recent={pdfChooser}
              onOpen={(p) => { setPdfChooser(null); setPdfViewerPath(p); }}
              onChoose={() => void choosePdf()}
              onClose={() => setPdfChooser(null)}
            />
          )}
          {pdfViewerPath && (
            <PdfViewer
              filePath={pdfViewerPath}
              onClose={() => setPdfViewerPath(null)}
            />
          )}
          {canvasMode && (
            <CanvasMode
              initialMode={canvasMode}
              pageId={activePage?.page.id ?? null}
              pageTitle={activePage?.page.title ?? ""}
              isJournal={activePage?.page.is_journal}
              journalDate={activePage?.page.journal_date ? (() => {
                try {
                  const [y, m, d] = activePage.page.journal_date!.split("-").map(Number);
                  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
                } catch { return activePage.page.journal_date!; }
              })() : undefined}
              blocks={activePage?.blocks ?? []}
              whiteboardId={whiteboardId}
              whiteboardIsNew={!!whiteboardId && pendingBoardsRef.current.has(whiteboardId)}
              onOpenWhiteboard={(wbId) => setWhiteboardId(wbId)}
              onNewWhiteboard={() => { if (activePage) openNewWhiteboard(activePage.page.id); }}
              onClose={() => { setCanvasMode(null); }}
              onPageClick={(id) => { openPage(id); setCanvasMode(null); }}
              onRefreshPage={() => { if (activePage) openPage(activePage.page.id); }}
              onWhiteboardClose={() => { setWhiteboardId(null); setCanvasMode(null); }}
              onRenameTitle={activePage ? (newTitle: string) => {
                if (activePage.page.is_journal) {
                  // Journal: save display title as property, don't rename system title
                  api.setProperty(activePage.page.id, "page", "display_title", newTitle).then(() => {
                    openPage(activePage.page.id);
                    refresh();
                  });
                } else {
                  // Regular page: rename actual title (errors are shown by renameActivePage)
                  renameActivePage(activePage.page.id, newTitle).catch(() => {});
                }
              } : undefined}
            />
          )}
          {mainView === "pages" ? (
            <AllPagesView
              activePageId={activePage?.page.id ?? null}
              onPageClick={(id) => { setMainView(null); openPage(id).catch(() => {}); }}
              onClose={closeMainView}
              onTrashPages={trashPages}
              onChanged={() => { refresh(); window.dispatchEvent(new Event("minotes-sidebar-refresh")); }}
            />
          ) : mainView === "trash" || mainView === "archive" ? (
            <TrashView
              kind={mainView}
              onOpenPage={(id) => { setMainView(null); openPage(id).catch(() => {}); }}
              onClose={closeMainView}
              onChanged={() => { refresh(); window.dispatchEvent(new Event("minotes-sidebar-refresh")); }}
            />
          ) : showTasks ? (
            <TasksView
              onOpenTask={(t) => {
                setPendingReveal(t.block_id);
                openPage(t.page_id).catch(() => {});
              }}
              onClose={() => {
                setMainView(null);
                if (activePage) openPage(activePage.page.id).catch(() => {}); // tasks may have changed it
              }}
            />
          ) : activePage ? (
            <PageView
              pageTree={activePage}
              onUpdateBlock={updateBlock}
              onDeleteBlock={deleteBlock}
              onPageLinkClick={openPage}
              onShiftClick={openInSidebar}
              onJournalNav={openJournal}
              onRefreshPage={() => openPage(activePage.page.id)}
              onOpenWhiteboard={(wbId: string) => { setWhiteboardId(wbId); setCanvasMode("draw"); }}
              onRenamePage={(newTitle: string) => {
                // Errors (e.g. title taken) show above the title; the old title stays.
                renameActivePage(activePage.page.id, newTitle).catch(() => {});
              }}
            />
          ) : pendingJournalDate ? (
            <div className="pending-journal" data-date={pendingJournalDate}>
              {/* The same header as a journal page (title, Prev / Today / Next in
                  the same place), so stepping through days never moves the
                  buttons and a not-yet-written day is never a dead end. */}
              <div className="main-header">
                <h2 className="pending-journal-date">
                  <Icon name="calendar" size={20} className="title-icon" /> {(() => {
                    const [y, m, d] = pendingJournalDate.split("-").map(Number);
                    const dt = new Date(y, m - 1, d);
                    return isNaN(dt.getTime()) ? pendingJournalDate : dt.toLocaleDateString(undefined, {
                      weekday: "long", year: "numeric", month: "long", day: "numeric",
                    });
                  })()}
                </h2>
                <div className="journal-nav">
                  <button className="btn btn-sm" onClick={() => openJournal(shiftDateKey(pendingJournalDate, -1))} title="Previous day (Alt+↑)">← Prev</button>
                  <button className="btn btn-sm" onClick={() => openJournal(localDateKey())} title="Today (Ctrl+J)">Today</button>
                  <button className="btn btn-sm" onClick={() => openJournal(shiftDateKey(pendingJournalDate, 1))} title="Next day (Alt+↓)">Next →</button>
                </div>
              </div>
              <div className="pending-journal-body">
                <p className="pending-journal-hint">No journal entry yet</p>
                <button className="btn btn-primary" onClick={materializeJournal}>+ Start writing</button>
                {/* ── Import: an empty notebook offers to bring notes in ── */}
                {stats?.pages === 0 && caps.import_from_files && (
                  <button className="btn btn-sm pending-journal-import" onClick={() => openImport()} data-testid="empty-import">Import notes from Obsidian, Evernote or markdown…</button>
                )}
              </div>
            </div>
          ) : goneNotice ? (
            <div className="pending-journal tab-gone" data-testid="tab-gone" data-kind={goneNotice.kind}>
              <div className="main-header">
                <h2 className="pending-journal-date">
                  <Icon name={goneNotice.kind === "trash" ? "trash" : "warning"} size={20} className="title-icon" /> {goneNotice.title}
                </h2>
              </div>
              <div className="pending-journal-body">
                <p className="pending-journal-hint">
                  {goneNotice.kind === "trash" ? "This page is in the Trash." : "This page no longer exists."}
                </p>
                {goneNotice.kind === "trash" && (
                  <button className="btn btn-primary" data-testid="tab-gone-restore" onClick={async () => {
                    const { pageId, title } = goneNotice;
                    try {
                      await api.restoreFromTrash(pageId, "page");
                    } catch (err) {
                      showToast(`Couldn't restore “${title}”: ${errorMessage(err)}`);
                      return;
                    }
                    await refresh();
                    window.dispatchEvent(new Event("minotes-sidebar-refresh"));
                    await openPage(pageId);
                    showToast(`Restored “${title}”`);
                  }}>Restore</button>
                )}
                {tabsView.tabs.length > 1 ? (
                  <button className="btn btn-sm" data-testid="tab-gone-close" onClick={() => closeTab(tabsView.activeId)}>Close tab</button>
                ) : (
                  <button className="btn btn-sm" onClick={() => { openJournal().catch(() => {}); }}>Open today's journal</button>
                )}
              </div>
            </div>
          ) : newPageDraft ? (
            <div className="pending-journal new-page-draft" data-testid="new-page-draft">
              <div className="main-header">
                <input
                  className="page-title-input new-page-draft-title"
                  autoFocus
                  value={draftTitle}
                  placeholder="Untitled"
                  aria-label="New page title"
                  onChange={e => setDraftTitle(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void createDraftPage(); } }}
                  data-testid="new-page-draft-title"
                />
              </div>
              <div className="pending-journal-body">
                <p className="pending-journal-hint">Type a title and press Enter to create the page. A tab left empty creates nothing.</p>
                <button className="btn btn-primary" disabled={!draftTitle.trim()} title={draftTitle.trim() ? undefined : "Type a title first"} onClick={() => { void createDraftPage(); }}>Create page</button>
              </div>
            </div>
          ) : (
            <EmptyState onCreatePage={createPage} />
          )}
        </div>
        {rightSidebarVisible && rightSidebarPanels.length > 0 && (
          <RightSidebar
            panels={rightSidebarPanels}
            onClose={(id) => setRightSidebarPanels(prev => prev.filter(p => p.id !== id))}
            onPageClick={openPage}
          />
        )}
        {folderSettingsId && (
          <FolderSettingsPanel
            folderId={folderSettingsId}
            onClose={() => setFolderSettingsId(null)}
            onRefresh={refresh}
            onOpenSecurity={() => { setFolderSettingsId(null); targetSettingsSection("Security"); setOpenPanel("settings"); }}
          />
        )}
      </div>
      <SearchPanel
        open={openPanel === "search"}
        onClose={() => setOpenPanel(null)}
        onPageClick={(id) => { setOpenPanel(null); setCanvasMode(null); setMainView(null); openPage(id); }}
        onCreatePage={createPage}
      />
      <QueryPanel
        open={openPanel === "query"}
        onClose={() => setOpenPanel(null)}
        onPageClick={(id) => { openPage(id); setOpenPanel(null); }}
      />
      <ReviewPanel
        open={openPanel === "review"}
        onClose={() => setOpenPanel(null)}
      />
      {import.meta.env.DEV && (
        <ObsidianPluginBrowser
          open={openPanel === "obsidianPlugins"}
          onClose={() => setOpenPanel(null)}
        />
      )}
      <CssSnippetManager
        open={openPanel === "cssManager"}
        onClose={() => setOpenPanel(null)}
      />
      <SettingsPanel
        open={openPanel === "settings"}
        onClose={() => setOpenPanel(null)}
        onOpenSync={() => setOpenPanel("sync")}
        onOpenCssSnippets={() => setOpenPanel("cssManager")}
      />
      <SyncPanel
        open={openPanel === "sync"}
        onClose={() => setOpenPanel(null)}
        currentPageId={activePage?.page.id ?? null}
        onPageRestored={() => {
          if (activePage) openPage(activePage.page.id);
        }}
      />
      {/* ── Import ── */}
      <ImportMount onOpenPage={openPage} onRefresh={refresh} />
      {/* ── End import ── */}
      <ShortcutsOverlay />
      <MediaHost />
      {/* ── AI platform ── */}
      <AiMount key={notebookKey} activePageId={activePage?.page.id ?? null} onOpenPage={openPage} />
      {/* ── End AI platform ── */}
      <MobileNav
        activeTab={mobileTab}
        onPagesClick={() => setMobileTab("pages")}
        onJournalClick={() => { setMobileTab("journal"); openJournal(); }}
        onSearchClick={() => { setMobileTab("search"); setOpenPanel("search"); }}
        onGraphClick={() => { setMobileTab("graph"); setCanvasMode(prev => prev === "graph" ? null : "graph"); }}
        onMenuClick={() => setMobileTab("menu")}
      />
    </div>
  );
}

/** Does the active tab have a place to show (restored tabs, or one already visited)? */
function activeTabHasPlace(): boolean {
  const s = getTabsSnapshot();
  const t = s.tabs.find(x => x.id === s.activeId);
  return !!t && t.index >= 0 && !!t.entries[t.index];
}

/**
 * An entry handed to "open in a new tab": a page known only by its title gets
 * its id (or opens / creates by title, like a click on that link would); a
 * written journal day becomes its page (today's is created, as Ctrl+J does).
 */
async function resolveTabEntry(e: NavEntry): Promise<NavEntry> {
  if (e.kind === "journal-day" && e.date) {
    if (e.date === localDateKey()) {
      const t = await api.getJournal(e.date);
      return { notebook: e.notebook, kind: "page", pageId: t.page.id, title: t.page.title };
    }
    const p = await api.findJournalPage(e.date).catch(() => null);
    return p ? { notebook: e.notebook, kind: "page", pageId: p.id, title: p.title } : e;
  }
  if (e.kind === "page" && !e.pageId && e.title) {
    const title = e.title.trim();
    const hits = await api.findPagesByTitle(title, 10).catch(() => [] as api.Page[]);
    const hit = hits.find(p => p.title.toLowerCase() === title.toLowerCase());
    return hit ? { notebook: e.notebook, kind: "page", pageId: hit.id, title: hit.title } : { notebook: e.notebook, kind: "page", title, create: true };
  }
  if (e.kind === "page" && e.pageId && !e.title) {
    const t = await api.getPageTree(e.pageId).catch(() => null);
    return t ? { ...e, title: t.page.title } : e;
  }
  return e;
}

/** A page by title or id, as "open in a new tab" receives it (test hooks). */
function tabTarget(titleOrId: string): NavEntry {
  const isId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(titleOrId);
  return isId ? { notebook: "", kind: "page", pageId: titleOrId } : { notebook: "", kind: "page", title: titleOrId };
}
