import { useState, useEffect, useCallback, useMemo } from "react";
import type { Page, FolderTreeRoot } from "../lib/api";
import * as api from "../lib/api";

interface Props {
  onPageClick: (id: string) => void;
  onClose: () => void;
}

type SortField = "title" | "project" | "updated_at";
type SortDir = "asc" | "desc";

export default function AllPagesView({ onPageClick, onClose }: Props) {
  const [pages, setPages] = useState<Page[]>([]);
  const [treeData, setTreeData] = useState<FolderTreeRoot | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortField, setSortField] = useState<SortField>("updated_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const loadData = useCallback(async () => {
    try {
      const [allPages, tree] = await Promise.all([
        api.listPages(500),
        api.getFolderTree(),
      ]);
      setPages(allPages.filter(p => !p.is_journal));
      setTreeData(tree);
    } catch (e) {
      console.error("Failed to load all pages:", e);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Build folder ID -> name map
  const folderMap = useMemo(() => {
    const map = new Map<string, string>();
    if (!treeData) return map;
    const walk = (folders: typeof treeData.folders) => {
      for (const f of folders) {
        map.set(f.id, f.name);
        walk(f.children);
      }
    };
    walk(treeData.folders);
    return map;
  }, [treeData]);

  const getProjectName = (page: Page): string => {
    if (page.folder_id) return folderMap.get(page.folder_id) ?? "Unknown";
    return "—";
  };

  const filtered = useMemo(() => {
    let result = pages;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(p =>
        p.title.toLowerCase().includes(q) ||
        getProjectName(p).toLowerCase().includes(q)
      );
    }
    result = [...result].sort((a, b) => {
      let cmp = 0;
      if (sortField === "title") {
        cmp = a.title.localeCompare(b.title);
      } else if (sortField === "project") {
        cmp = getProjectName(a).localeCompare(getProjectName(b));
      } else {
        cmp = a.updated_at.localeCompare(b.updated_at);
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return result;
  }, [pages, searchQuery, sortField, sortDir, folderMap]);

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir(field === "updated_at" ? "desc" : "asc");
    }
  };

  const sortIndicator = (field: SortField) => {
    if (sortField !== field) return "";
    return sortDir === "asc" ? " \u25B2" : " \u25BC";
  };

  const formatDate = (dateStr: string) => {
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    } catch {
      return dateStr;
    }
  };

  return (
    <div className="all-pages-view">
      <div className="all-pages-header">
        <h2>All Pages</h2>
        <input
          className="all-pages-search"
          type="text"
          placeholder="Filter pages..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          autoFocus
        />
        <span className="all-pages-count">{filtered.length} page{filtered.length !== 1 ? "s" : ""}</span>
      </div>
      <div className="all-pages-table-wrap">
        <table className="all-pages-table">
          <thead>
            <tr>
              <th className="all-pages-th" onClick={() => toggleSort("title")}>
                Title{sortIndicator("title")}
              </th>
              <th className="all-pages-th" onClick={() => toggleSort("project")}>
                Project{sortIndicator("project")}
              </th>
              <th className="all-pages-th" onClick={() => toggleSort("updated_at")}>
                Modified{sortIndicator("updated_at")}
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(page => (
              <tr
                key={page.id}
                className="all-pages-row"
                onClick={() => onPageClick(page.id)}
              >
                <td className="all-pages-td all-pages-title">
                  {page.icon ?? "📄"} {page.title}
                </td>
                <td className="all-pages-td all-pages-project">
                  {getProjectName(page)}
                </td>
                <td className="all-pages-td all-pages-date">
                  {formatDate(page.updated_at)}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={3} className="all-pages-empty">
                  {searchQuery ? "No pages match your filter." : "No pages yet."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
