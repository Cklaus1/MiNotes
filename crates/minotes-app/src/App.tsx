import { useState, useEffect, useCallback } from "react";
import Sidebar from "./components/Sidebar";
import PageView from "./components/PageView";
import EmptyState from "./components/EmptyState";
import SearchPanel from "./components/SearchPanel";
import QueryPanel from "./components/QueryPanel";
import GraphView from "./components/GraphView";
import ReviewPanel from "./components/ReviewPanel";
import PluginManager from "./components/PluginManager";
import * as api from "./lib/api";
import { initTheme, toggleTheme } from "./lib/theme";

export default function App() {
  const [activePage, setActivePage] = useState<api.PageTree | null>(null);
  const [stats, setStats] = useState<api.GraphStats | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [queryOpen, setQueryOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

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
      const tree = await api.getPageTree(titleOrId);
      setActivePage(tree);
      setRefreshKey(k => k + 1);
    } catch (e) {
      console.error("Failed to open page:", e);
    }
  }, []);

  const createPage = useCallback(async (title: string) => {
    try {
      const page = await api.createPage(title);
      await refresh();
      await openPage(page.id);
    } catch (e) {
      console.error("Failed to create page:", e);
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
      // Refresh to pick up any new [[links]] that were added
      if (activePage) {
        const tree = await api.getPageTree(activePage.page.id);
        setActivePage(tree);
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

  // Initialize theme on mount
  useEffect(() => {
    initTheme();
  }, []);

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
      // Cmd/Ctrl+N — new page
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        const title = prompt("Page title:");
        if (title?.trim()) createPage(title.trim());
      }
      // Ctrl+Shift+T — toggle theme
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "T") {
        e.preventDefault();
        toggleTheme();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [openJournal, createPage]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="app">
      <Sidebar
        activePage={activePage?.page ?? null}
        stats={stats}
        onPageClick={openPage}
        onCreatePage={createPage}
        onDeletePage={deletePage}
        onJournalClick={() => openJournal()}
        onSearchClick={() => setSearchOpen(true)}
        onGraphClick={() => setGraphOpen(prev => !prev)}
        refreshKey={refreshKey}
      />
      <div className="main" style={{ position: "relative" }}>
        {graphOpen && (
          <GraphView
            onPageClick={(id) => { openPage(id); setGraphOpen(false); }}
            onClose={() => setGraphOpen(false)}
          />
        )}
        {activePage ? (
          <PageView
            pageTree={activePage}
            onCreateBlock={createBlock}
            onUpdateBlock={updateBlock}
            onDeleteBlock={deleteBlock}
            onPageLinkClick={openPage}
            onJournalNav={openJournal}
          />
        ) : (
          <EmptyState onCreatePage={createPage} />
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
    </div>
  );
}
