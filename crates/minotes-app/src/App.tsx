import { useState, useEffect, useCallback } from "react";
import Sidebar from "./components/Sidebar";
import PageView from "./components/PageView";
import EmptyState from "./components/EmptyState";
import SearchPanel from "./components/SearchPanel";
import * as api from "./lib/api";

export default function App() {
  const [pages, setPages] = useState<api.Page[]>([]);
  const [activePage, setActivePage] = useState<api.PageTree | null>(null);
  const [stats, setStats] = useState<api.GraphStats | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);

  const loadPages = useCallback(async () => {
    try {
      const p = await api.listPages();
      setPages(p);
      const s = await api.getGraphStats();
      setStats(s);
    } catch (e) {
      console.error("Failed to load pages:", e);
    }
  }, []);

  const openPage = useCallback(async (titleOrId: string) => {
    try {
      const tree = await api.getPageTree(titleOrId);
      setActivePage(tree);
      // Refresh page list in case new pages were auto-created via [[links]]
      const p = await api.listPages();
      setPages(p);
    } catch (e) {
      console.error("Failed to open page:", e);
    }
  }, []);

  const createPage = useCallback(async (title: string) => {
    try {
      const page = await api.createPage(title);
      await loadPages();
      await openPage(page.id);
    } catch (e) {
      console.error("Failed to create page:", e);
    }
  }, [loadPages, openPage]);

  const openJournal = useCallback(async () => {
    try {
      const tree = await api.getJournal();
      setActivePage(tree);
      await loadPages();
    } catch (e) {
      console.error("Failed to open journal:", e);
    }
  }, [loadPages]);

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
      await loadPages();
    } catch (e) {
      console.error("Failed to delete page:", e);
    }
  }, [activePage, loadPages]);

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
      // Cmd/Ctrl+N — new page
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        const title = prompt("Page title:");
        if (title?.trim()) createPage(title.trim());
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [openJournal, createPage]);

  useEffect(() => {
    loadPages();
  }, [loadPages]);

  return (
    <div className="app">
      <Sidebar
        pages={pages}
        activePage={activePage?.page ?? null}
        stats={stats}
        onPageClick={openPage}
        onCreatePage={createPage}
        onDeletePage={deletePage}
        onJournalClick={openJournal}
        onSearchClick={() => setSearchOpen(true)}
      />
      <div className="main">
        {activePage ? (
          <PageView
            pageTree={activePage}
            onCreateBlock={createBlock}
            onUpdateBlock={updateBlock}
            onDeleteBlock={deleteBlock}
            onPageLinkClick={openPage}
          />
        ) : (
          <EmptyState onCreatePage={createPage} />
        )}
      </div>
      <SearchPanel
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onPageClick={(id) => { openPage(id); setSearchOpen(false); }}
      />
    </div>
  );
}
