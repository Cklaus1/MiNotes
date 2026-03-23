import { useState } from "react";
import * as api from "../lib/api";

interface Props {
  open: boolean;
  onClose: () => void;
  onPageClick: (id: string) => void;
}

const EXAMPLE_QUERIES = [
  { label: "All TODOs", sql: `SELECT b.content, p.title as page FROM blocks b JOIN pages p ON b.page_id = p.id WHERE b.content LIKE '%TODO%' LIMIT 50` },
  { label: "Recent blocks", sql: `SELECT content, created_at FROM blocks ORDER BY created_at DESC LIMIT 20` },
  { label: "Pages with most blocks", sql: `SELECT p.title, COUNT(b.id) as block_count FROM pages p LEFT JOIN blocks b ON b.page_id = p.id GROUP BY p.id ORDER BY block_count DESC LIMIT 20` },
  { label: "Orphan pages", sql: `SELECT p.title FROM pages p LEFT JOIN blocks b ON b.page_id = p.id LEFT JOIN links l ON l.to_page = p.id WHERE b.id IS NULL AND l.id IS NULL` },
  { label: "Blocks with properties", sql: `SELECT b.content, pr.key, pr.value FROM blocks b JOIN properties pr ON pr.entity_id = b.id ORDER BY pr.key LIMIT 50` },
];

export default function QueryPanel({ open, onClose, onPageClick }: Props) {
  const [sql, setSql] = useState("");
  const [result, setResult] = useState<api.QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  if (!open) return null;

  const runQuery = async () => {
    if (!sql.trim()) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.runQuery(sql.trim());
      setResult(res);
    } catch (e: any) {
      setError(typeof e === "string" ? e : e.message ?? "Query failed");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div className="query-panel" onClick={e => e.stopPropagation()}>
        <div className="query-panel-header">
          <span>SQL Query</span>
          <button className="btn btn-sm" onClick={onClose}>×</button>
        </div>

        <div className="query-examples">
          {EXAMPLE_QUERIES.map(q => (
            <button
              key={q.label}
              className="query-example-btn"
              onClick={() => setSql(q.sql)}
            >
              {q.label}
            </button>
          ))}
        </div>

        <textarea
          className="query-input"
          value={sql}
          onChange={e => setSql(e.target.value)}
          onKeyDown={e => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              runQuery();
            }
            if (e.key === "Escape") onClose();
          }}
          placeholder="SELECT * FROM blocks WHERE content LIKE '%...' LIMIT 20"
          rows={3}
          autoFocus
        />

        <div className="query-actions">
          <button className="btn btn-primary" onClick={runQuery} disabled={running}>
            {running ? "Running..." : "Run (Ctrl+Enter)"}
          </button>
          {result && (
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {result.rows.length} rows
            </span>
          )}
        </div>

        {error && (
          <div className="query-error">{error}</div>
        )}

        {result && result.rows.length > 0 && (
          <div className="query-results">
            <table className="query-table">
              <thead>
                <tr>
                  {result.columns.map(col => (
                    <th key={col}>{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, i) => (
                  <tr key={i}>
                    {result.columns.map(col => (
                      <td key={col}>
                        {formatCell(row[col])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {result && result.rows.length === 0 && !error && (
          <div style={{ padding: 16, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
            No results.
          </div>
        )}
      </div>
    </div>
  );
}

function formatCell(val: any): string {
  if (val === null || val === undefined) return "—";
  if (typeof val === "string" && val.length > 100) return val.slice(0, 100) + "...";
  return String(val);
}
