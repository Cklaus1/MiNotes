import { useState, useEffect, useCallback } from "react";
import Sidebar from "./components/Sidebar";
import PageView from "./components/PageView";
import RightSidebar from "./components/RightSidebar";
import EmptyState from "./components/EmptyState";
import SearchPanel from "./components/SearchPanel";
import QueryPanel from "./components/QueryPanel";
import GraphView from "./components/GraphView";
import ReviewPanel from "./components/ReviewPanel";
import PluginManager from "./components/PluginManager";
import Whiteboard from "./components/Whiteboard";
import { generateWhiteboardId } from "./lib/whiteboardUtils";
import SyncPanel from "./components/SyncPanel";
import PdfViewer from "./components/PdfViewer";
import MobileNav from "./components/MobileNav";
import ObsidianPluginBrowser from "./components/ObsidianPluginBrowser";
import CssSnippetManager from "./components/CssSnippetManager";
import CustomViewContainer from "./components/CustomViewContainer";
import SettingsPanel from "./components/SettingsPanel";
import * as api from "./lib/api";
import { initTheme, toggleTheme } from "./lib/theme";
import { initTestApi, registerTestApi } from "./lib/testApi";
import { loadEnabledSnippets } from "./lib/cssLoader";
import { isOnboardingComplete, markOnboardingComplete, TUTORIAL_BLOCKS } from "./lib/onboarding";
import { executeUndo, executeRedo } from "./lib/undoManager";

export default function App() {
  const [activePage, setActivePage] = useState<api.PageTree | null>(null);
  const [stats, setStats] = useState<api.GraphStats | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [queryOpen, setQueryOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [whiteboardId, setWhiteboardId] = useState<string | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  const [obsidianPluginsOpen, setObsidianPluginsOpen] = useState(false);
  const [cssManagerOpen, setCssManagerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pdfViewerPath, setPdfViewerPath] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [mobileTab, setMobileTab] = useState("pages");
  const [customViews, setCustomViews] = useState<Array<{ type: string; displayText: string; containerEl: HTMLElement }>>([]);
  const [lastError, setLastError] = useState<string | null>(null);
  const [rightSidebarPanels, setRightSidebarPanels] = useState<Array<{id: string, title: string}>>([]);
  const [rightSidebarVisible, setRightSidebarVisible] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const s = await api.getGraphStats();
      setStats(s);
      setRefreshKey(k => k + 1);
    } catch (e) {
      console.error("Failed to refresh:", e);
    }
  }, []);

  const openPage = useCallback(async (titleOrId: string) => {
    try {
      setLastError(null);
      console.log("[openPage]", titleOrId);
      const tree = await api.getPageTree(titleOrId);
      console.log("[openPage] got tree:", tree.page.title, "blocks:", tree.blocks.length);
      setActivePage(tree);
      setRefreshKey(k => k + 1);
    } catch (e: any) {
      const msg = typeof e === "string" ? e : e?.message ?? JSON.stringify(e);
      console.error("Failed to open page:", msg);
      setLastError(`openPage failed: ${msg}`);
    }
  }, []);

  const createPage = useCallback(async (title: string) => {
    try {
      setLastError(null);
      console.log("[createPage]", title);
      const page = await api.createPage(title);
      console.log("[createPage] created:", page.id, page.title);
      await refresh();
      await openPage(page.id);
    } catch (e: any) {
      const msg = typeof e === "string" ? e : e?.message ?? JSON.stringify(e);
      console.error("Failed to create page:", msg);
      setLastError(`createPage failed: ${msg}`);
    }
  }, [refresh, openPage]);

  const openJournal = useCallback(async (date?: string) => {
    try {
      const tree = await api.getJournal(date);
      setActivePage(tree);
      await refresh();
    } catch (e) {
      console.error("Failed to open journal:", e);
    }
  }, [refresh]);

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
      // Don't refresh the full page on every keystroke save — it kills focus.
      // Only refresh if content contains [[ links that might need resolving.
      if (content.includes("[[") && activePage) {
        // Delay the refresh slightly so it doesn't steal focus
        setTimeout(async () => {
          try {
            const tree = await api.getPageTree(activePage.page.id);
            setActivePage(tree);
          } catch {}
        }, 500);
      }
    } catch (e) {
      console.error("Failed to update block:", e);
    }
  }, [activePage]);

  const deleteBlock = useCallback(async (id: string) => {
    try {
      await api.deleteBlock(id);
      if (activePage) await openPage(activePage.page.id);
    } catch (e) {
      console.error("Failed to delete block:", e);
    }
  }, [activePage, openPage]);

  const deletePage = useCallback(async (id: string) => {
    try {
      await api.deletePage(id);
      if (activePage?.page.id === id) {
        setActivePage(null);
      }
      await refresh();
    } catch (e) {
      console.error("Failed to delete page:", e);
    }
  }, [activePage, refresh]);

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

  // Initialize test API, theme, and CSS snippets on mount
  useEffect(() => {
    initTestApi();
    initTheme();
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
        setSearchOpen(true);
        return true;
      },
      openSettings: () => {
        setSettingsOpen(true);
        return true;
      },
      closePanel: () => {
        setSearchOpen(false);
        setQueryOpen(false);
        setGraphOpen(false);
        setReviewOpen(false);
        setPluginsOpen(false);
        setWhiteboardId(null);
        setSyncOpen(false);
        setObsidianPluginsOpen(false);
        setCssManagerOpen(false);
        setSettingsOpen(false);
        return true;
      },
      getCurrentPage: () => activePage?.page.title ?? null,
      isPanelOpen: (name: string) => {
        const map: Record<string, boolean> = {
          search: searchOpen, query: queryOpen, graph: graphOpen,
          review: reviewOpen, settings: settingsOpen,
        };
        return map[name] ?? false;
      },
    });
  }, [activePage, searchOpen, queryOpen, graphOpen, reviewOpen, settingsOpen]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Cmd/Ctrl+K — search
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen(prev => !prev);
      }
      // Cmd/Ctrl+J — today's journal
      if ((e.metaKey || e.ctrlKey) && e.key === "j") {
        e.preventDefault();
        openJournal();
      }
      // Cmd/Ctrl+Q — query panel
      if ((e.metaKey || e.ctrlKey) && e.key === "q") {
        e.preventDefault();
        setQueryOpen(prev => !prev);
      }
      // Cmd/Ctrl+G — graph view
      if ((e.metaKey || e.ctrlKey) && e.key === "g") {
        e.preventDefault();
        setGraphOpen(prev => !prev);
      }
      // Cmd/Ctrl+R — review panel
      if ((e.metaKey || e.ctrlKey) && e.key === "r") {
        e.preventDefault();
        setReviewOpen(prev => !prev);
      }
      // Cmd/Ctrl+Z — undo (only when not inside editor)
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey) {
        const target = e.target as HTMLElement;
        if (!target.closest(".ProseMirror")) {
          e.preventDefault();
          executeUndo().then(() => {
            if (activePage) openPage(activePage.page.id);
            refresh();
          });
        }
      }
      // Cmd/Ctrl+Shift+Z — redo
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && e.shiftKey) {
        e.preventDefault();
        executeRedo().then(() => {
          if (activePage) openPage(activePage.page.id);
          refresh();
        });
      }
      // Cmd/Ctrl+N — new page
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        const title = prompt("Page title:");
        if (title?.trim()) createPage(title.trim());
      }
      // Cmd/Ctrl+W — new whiteboard block in current page
      if ((e.metaKey || e.ctrlKey) && e.key === "w") {
        e.preventDefault();
        if (whiteboardId) {
          setWhiteboardId(null); // close if open
        } else if (activePage) {
          const wbId = generateWhiteboardId();
          api.createBlock(activePage.page.id, `{{whiteboard:${wbId}}}`).then(() => {
            openPage(activePage.page.id);
          });
          setWhiteboardId(wbId);
        }
      }
      // Cmd/Ctrl+P — open PDF
      if ((e.metaKey || e.ctrlKey) && e.key === "p") {
        e.preventDefault();
        const path = prompt("PDF file path:");
        if (path?.trim()) setPdfViewerPath(path.trim());
      }
      // Ctrl+Shift+T — toggle theme
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "T") {
        e.preventDefault();
        toggleTheme();
      }
      // Ctrl+, — settings
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(prev => !prev);
      }
      // Ctrl+\ — toggle right sidebar
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        setRightSidebarVisible(prev => !prev);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [openJournal, createPage]);

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
        onJournalClick={() => openJournal()}
        onSearchClick={() => setSearchOpen(true)}
        onGraphClick={() => setGraphOpen(prev => !prev)}
        onSettingsClick={() => setSettingsOpen(prev => !prev)}
        refreshKey={refreshKey}
      />
      <div className="main workspace-split mod-root" style={{ position: "relative", display: "flex", flexDirection: "row" }}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
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
          {whiteboardId && (
            <Whiteboard
              whiteboardId={whiteboardId}
              onClose={() => setWhiteboardId(null)}
            />
          )}
          {graphOpen && (
            <GraphView
              onPageClick={(id) => { openPage(id); setGraphOpen(false); }}
              onClose={() => setGraphOpen(false)}
            />
          )}
          {customViews.length > 0 && (
            <CustomViewContainer
              views={customViews}
              onClose={(type) => {
                setCustomViews(prev => prev.filter(v => v.type !== type));
              }}
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
              onOpenWhiteboard={(wbId: string) => setWhiteboardId(wbId)}
            />
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
      </div>
      <SearchPanel
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onPageClick={(id) => { openPage(id); setSearchOpen(false); }}
        onToggleTheme={() => { toggleTheme(); setSearchOpen(false); }}
        onNewPage={() => {
          setSearchOpen(false);
          const title = prompt("Page title:");
          if (title?.trim()) createPage(title.trim());
        }}
        onJournal={() => { openJournal(); setSearchOpen(false); }}
        onGraph={() => { setGraphOpen(prev => !prev); setSearchOpen(false); }}
        onQuery={() => { setQueryOpen(prev => !prev); setSearchOpen(false); }}
        onReview={() => { setReviewOpen(prev => !prev); setSearchOpen(false); }}
        onPlugins={() => { setPluginsOpen(prev => !prev); setSearchOpen(false); }}
        onSync={() => { setSyncOpen(prev => !prev); setSearchOpen(false); }}
        onObsidianPlugins={() => { setObsidianPluginsOpen(prev => !prev); setSearchOpen(false); }}
        onCssManager={() => { setCssManagerOpen(prev => !prev); setSearchOpen(false); }}
        onSettings={() => { setSettingsOpen(prev => !prev); setSearchOpen(false); }}
      />
      <QueryPanel
        open={queryOpen}
        onClose={() => setQueryOpen(false)}
        onPageClick={(id) => { openPage(id); setQueryOpen(false); }}
      />
      <ReviewPanel
        open={reviewOpen}
        onClose={() => setReviewOpen(false)}
      />
      <PluginManager
        open={pluginsOpen}
        onClose={() => setPluginsOpen(false)}
      />
      <ObsidianPluginBrowser
        open={obsidianPluginsOpen}
        onClose={() => setObsidianPluginsOpen(false)}
      />
      <CssSnippetManager
        open={cssManagerOpen}
        onClose={() => setCssManagerOpen(false)}
      />
      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
      <SyncPanel
        open={syncOpen}
        onClose={() => setSyncOpen(false)}
        currentPageId={activePage?.page.id ?? null}
        onPageRestored={() => {
          if (activePage) openPage(activePage.page.id);
        }}
      />
      <MobileNav
        activeTab={mobileTab}
        onPagesClick={() => setMobileTab("pages")}
        onJournalClick={() => { setMobileTab("journal"); openJournal(); }}
        onSearchClick={() => { setMobileTab("search"); setSearchOpen(true); }}
        onGraphClick={() => { setMobileTab("graph"); setGraphOpen(prev => !prev); }}
        onMenuClick={() => setMobileTab("menu")}
      />
    </div>
  );
}
