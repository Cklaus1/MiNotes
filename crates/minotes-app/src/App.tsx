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
import MobileNav from "./components/MobileNav";
import ObsidianPluginBrowser from "./components/ObsidianPluginBrowser";
import CssSnippetManager from "./components/CssSnippetManager";
import SettingsPanel from "./components/SettingsPanel";
import FolderSettingsPanel from "./components/FolderSettingsPanel";
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
import { installBrokenImageHints } from "./lib/brokenImages";
import { installRemoteImages } from "./lib/remoteImages";
import { pageAsText } from "./lib/pageText";
import { pageTitleConflict } from "./lib/pageNames";
import { getRecentPages } from "./lib/recentFiles";
import { getSettings } from "./lib/settings";
import NotebookBanner from "./components/NotebookBanner";
import { listenOutsideEdits, OUTSIDE_PAGES_CHANGED } from "./lib/outsideEdits";
import {
  NOTEBOOK_SWITCHED, setNextExportDest, setNextPickedFolder, setNextZipPick, switchNotebook, useCapabilities,
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
  const [pdfViewerPath, setPdfViewerPath] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [mobileTab, setMobileTab] = useState("pages");
  const [lastError, setLastError] = useState<string | null>(null);
  const [rightSidebarPanels, setRightSidebarPanels] = useState<Array<{id: string, title: string}>>([]);
  const [rightSidebarVisible, setRightSidebarVisible] = useState(true);
  const [folderSettingsId, setFolderSettingsId] = useState<string | null>(null);

  // Git Sync state
  const [syncStatus, setSyncStatus] = useState<api.GitSyncStatus | null>(null);
  const [syncState, setSyncState] = useState<"idle" | "syncing" | "error" | "offline">("idle");
  const [syncErrorMsg, setSyncErrorMsg] = useState<string | null>(null);
  const syncingRef = useRef(false);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Deletions from another device that sync's mass-delete guard is holding.
  const [heldDeletions, setHeldDeletions] = useState<api.HeldDeletions | null>(null);
  // Sync is on in a folder set up on another computer: ask before syncing it here.
  const [syncNeedsConfirm, setSyncNeedsConfirm] = useState(false);
  // Key of the open notebook (remounts per-notebook views such as the AI panel).
  const [notebookKey, setNotebookKey] = useState<string>("");

  const refresh = useCallback(async () => {
    try {
      const s = await api.getGraphStats();
      setStats(s);
      setRefreshKey(k => k + 1);
    } catch (e) {
      console.error("Failed to refresh:", e);
    }
  }, []);

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
      const allPages = await api.listPages(200);
      if (token !== navTokenRef.current) return;
      const existing = allPages.find(p => p.is_journal && p.journal_date === d);
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

  const triggerSync = useCallback(async () => {
    if (syncingRef.current) return;
    try {
      const status = await api.gitSyncStatus().catch(() => null);
      if (!status?.enabled) return;
      if (status.needs_confirmation) {
        setSyncNeedsConfirm(true);
        return;
      }
      syncingRef.current = true;
      setSyncState("syncing");
      const result = await api.gitSync();
      if (result.needs_confirmation) {
        setSyncNeedsConfirm(true);
        setSyncState("idle");
        return;
      }
      setHeldDeletions(result.held_deletions ?? null);
      if (result.success) {
        setSyncState("idle");
        setSyncErrorMsg(null);
        setSyncStatus(prev => prev ? { ...prev, last_sync: new Date().toISOString() } : prev);
        if (result.conflicts_resolved > 0) {
          showToast(
            `⚠ Sync conflict in ${result.conflicts_resolved} page(s) — both versions were kept. ` +
              `Your local version stays in place; the other device's version was saved as a separate page ` +
              `titled "… (conflict from <device>)". Compare them and merge or delete the copy.`,
            10000,
          );
        }
        if (result.pages_imported > 0) {
          refresh();
          if (activePage) openPage(activePage.page.id).catch(() => {});
        }
      } else if (result.offline) {
        // Remote unreachable: not a failure — local edits are kept and synced later.
        setSyncState("offline");
        setSyncErrorMsg(result.error ?? "The sync remote can't be reached");
      } else {
        const errMsg = result.error ?? "Unknown error";
        setSyncState("error");
        setSyncErrorMsg(errMsg);
        showToast(`Sync failed: ${errMsg}`);
        // An import problem still brought the rest of the other device's changes.
        if (result.pages_imported > 0) {
          refresh();
          if (activePage) openPage(activePage.page.id).catch(() => {});
        }
      }
    } catch (e) {
      setSyncState("error");
      setSyncErrorMsg(String(e));
    } finally {
      syncingRef.current = false;
    }
  }, [activePage, refresh, openPage, openJournal]);

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
  const resolveHeldDeletions = useCallback(async (action: "trash" | "keep") => {
    try {
      const n = await api.gitSyncResolveDeletions(action);
      setHeldDeletions(null);
      showToast(action === "trash"
        ? `Moved ${n} item(s) to trash, as on the other device`
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
      setLastError(null);
      setPendingJournalDate(null);
      setActivePage(null);
      setHeldDeletions(null);
      setSyncNeedsConfirm(false);
      setSyncState("idle");
      setSyncErrorMsg(null);
      undoStack.clear();
      notifyCardsChanged();
      refresh();
      window.dispatchEvent(new Event("minotes-sidebar-refresh"));
      openJournal().catch(() => {});
      api.gitSyncStatus().then(status => {
        setSyncStatus(status);
        if (status.enabled) setTimeout(() => window.dispatchEvent(new Event("minotes-trigger-sync")), 0);
      }).catch(() => setSyncStatus(null));
    };
    window.addEventListener(NOTEBOOK_SWITCHED, onSwitch);
    return () => window.removeEventListener(NOTEBOOK_SWITCHED, onSwitch);
  }, [refresh, openJournal]);

  // A cross-notebook search result or [[Notebook::Page]] link: switch notebooks
  // (the usual flow: views reset, undo cleared) and open the page there. The
  // switch's own landing on today's journal is superseded by this navigation.
  useEffect(() => {
    const onOpen = async (e: Event) => {
      const d = (e as CustomEvent<OpenInNotebook>).detail;
      if (!d?.pageId) return;
      try {
        if (d.key && d.key !== (await api.getCurrentNotebook())) await switchNotebook(d.key);
        setPendingReveal(d.blockId ?? null);
        setOpenPanel(null);
        setCanvasMode(null);
        await openPage(d.pageId);
      } catch (err) {
        setLastError(`Couldn't open the page: ${errorMessage(err)}`);
      }
    };
    window.addEventListener(OPEN_IN_NOTEBOOK, onOpen);
    return () => window.removeEventListener(OPEN_IN_NOTEBOOK, onOpen);
  }, [openPage]);

  useEffect(() => {
    const h = () => { triggerSync(); };
    window.addEventListener("minotes-trigger-sync", h);
    return () => window.removeEventListener("minotes-trigger-sync", h);
  }, [triggerSync]);

  // Load sync status on mount + sync on app open
  useEffect(() => {
    api.gitSyncStatus().then(status => {
      setSyncStatus(status);
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
          review: openPanel === "review", settings: openPanel === "settings",
        };
        return map[name] ?? false;
      },
    });
    // Notebooks: switch like the sidebar menu does; drive the folder dialog
    // (automation can't drive the native picker).
    registerTestApi({
      switchNotebook: (key: string) => switchNotebook(key).then(() => true),
      setNextPickedFolder: (path: string | null) => { setNextPickedFolder(path); return true; },
      setNextZipPick: (path: string | null) => { setNextZipPick(path); return true; },
      setNextExportDest: (path: string | null) => { setNextExportDest(path); return true; },
      getNotebookKey: () => notebookKey,
    } as any);
  }, [activePage, openPanel, canvasMode, whiteboardId, notebookKey]);

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
        const title = prompt("Page title:");
        if (title?.trim()) createPage(title.trim());
      }
      // Cmd/Ctrl+W — new whiteboard / toggle draw mode
      if (key === "w" && plain && appChord) {
        e.preventDefault();
        if (canvasMode === "draw") {
          setCanvasMode(null);
          setWhiteboardId(null);
        } else if (activePage) {
          openNewWhiteboard(activePage.page.id);
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
      // Cmd/Ctrl+P — open PDF
      if (key === "p" && plain && appChord) {
        e.preventDefault();
        const path = prompt("PDF file path:");
        if (path?.trim()) setPdfViewerPath(path.trim());
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
  }, [openJournal, createPage, activePage, whiteboardId, canvasMode, openNewWhiteboard, openPage, refresh]);

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
          markOnboardingComplete();
          await openPage(page.id);
          return;
        } catch (e) {
          console.error("[init] onboarding failed:", e);
          markOnboardingComplete();
        }
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
    <div className="app workspace">
      <Sidebar
        activePage={activePage?.page ?? null}
        stats={stats}
        onPageClick={openPage}
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
        onPagesClick={() => setCanvasMode(prev => prev === "pages" ? null : "pages")}
        onSettingsClick={() => setOpenPanel(prev => prev === "settings" ? null : "settings")}
        onFolderSettings={(id) => setFolderSettingsId(prev => prev === id ? null : id)}
        onReviewClick={() => setOpenPanel("review")}
        onTodoBadgeClick={async () => {
          if (getSettings().ai?.todoExtraction === false) return; // Settings → AI → TODO extraction off
          try {
            const allPages = await api.listPages();
            let todoPage = allPages.find(p => p.title === "All TODOs");
            if (!todoPage) {
              todoPage = await api.createPage("All TODOs");
            }
            const todos = await api.listPendingTodosWithIds();
            const tree = await api.getPageTree(todoPage.id);
            const existingTodoIds = tree.blocks.filter(b => b.content.startsWith("{{todo:")).map(b => b.id);
            for (const id of existingTodoIds) {
              await api.deleteBlock(id);
            }
            for (const todo of todos) {
              const blockContent = `{{todo:pending}} [[${todo.page_title}|${todo.page_id}]] ${todo.text}`;
              await api.createBlock(todoPage.id, blockContent);
            }
            openPage(todoPage.id);
          } catch {
            // ignore
          }
        }}
        activeMode={canvasMode === "graph" ? "graph" : canvasMode === "mindmap" ? "mindmap" : canvasMode === "draw" ? "whiteboard" : canvasMode === "kanban" ? "kanban" : canvasMode === "pages" ? "pages" : null}
        refreshKey={refreshKey}
        syncState={syncStatus?.enabled ? syncState : undefined}
      />
      <div className="main workspace-split mod-root" style={{ position: "relative", display: "flex", flexDirection: "row" }}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
          <NotebookBanner
            heldDeletions={heldDeletions}
            onResolveHeld={resolveHeldDeletions}
            onOpenPage={id => { openPage(id).catch(() => {}); }}
            syncNeedsConfirm={syncNeedsConfirm}
            onConfirmSync={confirmSync}
            onDeclineSync={() => setSyncNeedsConfirm(false)}
          />
          {lastError && (
            <div style={{ background: "#f38ba8", color: "#1e1e2e", padding: "8px 16px", fontSize: 13, fontWeight: 600 }}>
              {lastError}
            </div>
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
          {activePage ? (
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
            <div className="pending-journal">
              {/* Same Prev / Today / Next as a journal page, so a future (not yet
                  written) day is never a dead end. */}
              <div className="journal-nav pending-journal-nav">
                <button className="btn btn-sm" onClick={() => openJournal(shiftDateKey(pendingJournalDate, -1))}>← Prev</button>
                <button className="btn btn-sm" onClick={() => openJournal(localDateKey())}>Today</button>
                <button className="btn btn-sm" onClick={() => openJournal(shiftDateKey(pendingJournalDate, 1))}>Next →</button>
              </div>
              <div className="pending-journal-date">
                {(() => {
                  const [y, m, d] = pendingJournalDate.split("-").map(Number);
                  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
                    weekday: "long", month: "long", day: "numeric", year: "numeric",
                  });
                })()}
              </div>
              <p className="pending-journal-hint">No journal entry yet</p>
              <button className="btn btn-primary" onClick={materializeJournal}>+ Start writing</button>
              {/* ── Import: an empty notebook offers to bring notes in ── */}
              {stats?.pages === 0 && caps.import_from_files && (
                <button className="btn btn-sm pending-journal-import" onClick={() => openImport()} data-testid="empty-import">Import notes from Obsidian, Evernote or markdown…</button>
              )}
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
          />
        )}
      </div>
      <SearchPanel
        open={openPanel === "search"}
        onClose={() => setOpenPanel(null)}
        onPageClick={(id) => { openPage(id); setOpenPanel(null); }}
        onToggleTheme={() => { toggleTheme(); setOpenPanel(null); }}
        onCreatePage={createPage}
        onNewPage={() => {
          setOpenPanel(null);
          const title = prompt("Page title:");
          if (title?.trim()) createPage(title.trim());
        }}
        onJournal={() => { openJournal(); setOpenPanel(null); }}
        onGraph={() => { setCanvasMode(prev => prev === "graph" ? null : "graph"); setOpenPanel(null); }}
        onQuery={() => { setOpenPanel("query"); }}
        onReview={() => { setOpenPanel("review"); }}
        onSync={() => { setOpenPanel("sync"); }}
        onObsidianPlugins={() => { setOpenPanel("obsidianPlugins"); }}
        onCssManager={() => { setOpenPanel("cssManager"); }}
        onSettings={() => { setOpenPanel("settings"); }}
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
      <ObsidianPluginBrowser
        open={openPanel === "obsidianPlugins"}
        onClose={() => setOpenPanel(null)}
      />
      <CssSnippetManager
        open={openPanel === "cssManager"}
        onClose={() => setOpenPanel(null)}
      />
      <SettingsPanel
        open={openPanel === "settings"}
        onClose={() => setOpenPanel(null)}
        syncError={syncState === "error" ? syncErrorMsg : null}
        onSyncRetry={triggerSync}
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
