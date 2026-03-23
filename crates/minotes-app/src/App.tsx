import { useState, useEffect, useCallback } from "react";
import Sidebar from "./components/Sidebar";
import PageView from "./components/PageView";
import EmptyState from "./components/EmptyState";
import * as api from "./lib/api";

export default function App() {
  const [pages, setPages] = useState<api.Page[]>([]);
  const [activePage, setActivePage] = useState<api.PageTree | null>(null);
  const [stats, setStats] = useState<api.GraphStats | null>(null);

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
    } catch (e) {
      console.error("Failed to update block:", e);
    }
  }, []);

  const deleteBlock = useCallback(async (id: string) => {
    try {
      await api.deleteBlock(id);
      if (activePage) await openPage(activePage.page.id);
    } catch (e) {
      console.error("Failed to delete block:", e);
    }
  }, [activePage, openPage]);

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
    </div>
  );
}
