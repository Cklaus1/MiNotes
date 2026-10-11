import { useEffect, useState } from "react";
import * as api from "../lib/api";
import { NOTEBOOKS_CHANGED, NOTEBOOK_SWITCHED } from "../lib/notebooks";
import "./notebooks.css";

/**
 * Read-only label of the open notebook in the Graph view toolbar. Notebooks are
 * switched, created and managed from the sidebar header.
 */
export default function NotebookLabel() {
  const [name, setName] = useState<string>("");

  useEffect(() => {
    const load = () => { api.getNotebookSession().then(s => setName(s?.name ?? "")).catch(() => {}); };
    load();
    window.addEventListener(NOTEBOOK_SWITCHED, load);
    window.addEventListener(NOTEBOOKS_CHANGED, load);
    return () => {
      window.removeEventListener(NOTEBOOK_SWITCHED, load);
      window.removeEventListener(NOTEBOOKS_CHANGED, load);
    };
  }, []);

  if (!name) return null;
  return (
    <span className="graph-notebook-label" title="Switch notebooks from the sidebar header" data-testid="graph-notebook-label">
      Notebook: {name}
    </span>
  );
}
