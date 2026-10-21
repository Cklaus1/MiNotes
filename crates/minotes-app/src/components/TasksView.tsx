import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../lib/api";
import { setTaskState, type TaskState } from "../lib/tasks";
import { blockPlainText } from "../lib/plainText";
import { useEscapeToClose } from "../lib/escapeStack";
import { showToast } from "../lib/toast";
import { errorMessage } from "../lib/errors";
import "./tasks.css";

type Filter = "open" | "todo" | "doing" | "done" | "all";
const FILTERS: Array<[Filter, string]> = [["open", "Open"], ["todo", "TODO"], ["doing", "DOING"], ["done", "DONE"], ["all", "All"]];
const FILTER_KEY = "minotes-tasks-filter";
const NEXT_STATE: Record<TaskState, TaskState> = { todo: "doing", doing: "done", done: "todo" };

function journalLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y, (m ?? 1) - 1, d ?? 1);
  return isNaN(dt.getTime()) ? date : dt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

/**
 * Every task in the notebook, grouped by page — a view, not a page: nothing is
 * stored, the checkboxes and state chips write the real blocks, and a click
 * jumps to the block. Opened from the sidebar's TODO badge.
 */
export default function TasksView({ onOpenTask, onClose }: {
  onOpenTask: (task: api.TaskItem) => void;
  onClose: () => void;
}) {
  const [tasks, setTasks] = useState<api.TaskItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>(() => {
    try { return (localStorage.getItem(FILTER_KEY) as Filter) || "open"; } catch { return "open"; }
  });
  const busy = useRef(new Set<string>());

  const load = useCallback(async () => {
    try {
      setTasks(await api.listTasks());
      setError(null);
    } catch (e) {
      setError(`Couldn't load tasks: ${errorMessage(e)}`);
    }
  }, []);

  useEffect(() => {
    load();
    const reload = () => { load(); };
    window.addEventListener("minotes-sidebar-refresh", reload);
    window.addEventListener("minotes-content-saved", reload);
    return () => {
      window.removeEventListener("minotes-sidebar-refresh", reload);
      window.removeEventListener("minotes-content-saved", reload);
    };
  }, [load]);

  useEscapeToClose(true, onClose);

  const chooseFilter = (f: Filter) => {
    setFilter(f);
    try { localStorage.setItem(FILTER_KEY, f); } catch { /* not remembered */ }
  };

  /** Write the new state into the real block (re-read first: it may have changed). */
  const changeState = async (task: api.TaskItem, state: TaskState) => {
    const key = `${task.block_id}:${task.line}`;
    if (busy.current.has(key)) return;
    busy.current.add(key);
    try {
      const block = await api.getBlock(task.block_id);
      const next = block ? setTaskState(block.content, task.line, state) : null;
      if (next === null) {
        showToast("That task changed meanwhile — the list is refreshed");
        await load();
        return;
      }
      if (next !== block!.content) await api.updateBlock(task.block_id, next);
      setTasks(prev => prev?.map(t => t.block_id === task.block_id && t.line === task.line ? { ...t, state } : t) ?? prev);
      window.dispatchEvent(new Event("minotes-sidebar-refresh")); // the badge count
    } catch (e) {
      showToast(`Couldn't update the task: ${errorMessage(e)}`);
    } finally {
      busy.current.delete(key);
    }
  };

  const shown = useMemo(() => (tasks ?? []).filter(t =>
    filter === "all" ? true : filter === "open" ? t.state !== "done" : t.state === filter), [tasks, filter]);

  const groups = useMemo(() => {
    const out: Array<{ pageId: string; title: string; tasks: api.TaskItem[] }> = [];
    const byPage = new Map<string, (typeof out)[number]>();
    for (const t of shown) {
      let g = byPage.get(t.page_id);
      if (!g) {
        g = { pageId: t.page_id, title: t.is_journal && t.journal_date ? journalLabel(t.journal_date) : t.page_title, tasks: [] };
        byPage.set(t.page_id, g);
        out.push(g);
      }
      g.tasks.push(t);
    }
    return out;
  }, [shown]);

  const counts = useMemo(() => {
    const c = { open: 0, todo: 0, doing: 0, done: 0, all: 0 };
    for (const t of tasks ?? []) { c.all++; c[t.state]++; if (t.state !== "done") c.open++; }
    return c;
  }, [tasks]);

  return (
    <div className="tasks-view" data-testid="tasks-view" role="region" aria-label="Tasks">
      <div className="tasks-header">
        <h2>Tasks</h2>
        <div className="tasks-filters" role="tablist" aria-label="Show">
          {FILTERS.map(([f, label]) => (
            <button
              key={f}
              role="tab"
              aria-selected={filter === f}
              className={`tasks-filter${filter === f ? " active" : ""}`}
              onClick={() => chooseFilter(f)}
              data-testid={`tasks-filter-${f}`}
            >
              {label} <span className="tasks-filter-count">{counts[f]}</span>
            </button>
          ))}
        </div>
        <button className="btn btn-sm tasks-close" onClick={onClose} title="Close (Esc)" aria-label="Close tasks">✕</button>
      </div>
      {error && <div className="nb-field-error" role="alert">{error}</div>}
      <div className="tasks-body">
        {tasks === null && !error && <div className="tasks-empty">Loading…</div>}
        {tasks !== null && groups.length === 0 && (
          <div className="tasks-empty">
            {filter === "open" || filter === "todo"
              ? <>No open tasks. Start a block with <code>TODO</code> or press <kbd>Ctrl+Enter</kbd> in it.</>
              : `No ${filter === "all" ? "" : filter.toUpperCase() + " "}tasks.`}
          </div>
        )}
        {groups.map(g => (
          <section key={g.pageId} className="tasks-group" data-testid="tasks-group" data-page-id={g.pageId}>
            <button className="tasks-group-title" onClick={() => onOpenTask(g.tasks[0])} title={`Open ${g.title}`}>
              {g.title} <span className="tasks-filter-count">{g.tasks.length}</span>
            </button>
            <ul className="tasks-list">
              {g.tasks.map(t => {
                const plain = blockPlainText(t.text).text || t.text;
                return (
                  <li
                    key={`${t.block_id}:${t.line}`}
                    className={`tasks-row state-${t.state}`}
                    data-testid="task-row"
                    data-block-id={t.block_id}
                    data-state={t.state}
                  >
                    <input
                      type="checkbox"
                      className="tasks-check"
                      checked={t.state === "done"}
                      onChange={() => changeState(t, t.state === "done" ? "todo" : "done")}
                      aria-label={`${t.state === "done" ? "Reopen" : "Done:"} ${plain}`}
                      data-testid="task-toggle"
                    />
                    {t.kind !== "checkbox" && (
                      <button
                        className={`tasks-state tasks-state-${t.state}`}
                        onClick={() => changeState(t, NEXT_STATE[t.state])}
                        title={`${t.state.toUpperCase()} — click for ${NEXT_STATE[t.state].toUpperCase()}`}
                        data-testid="task-state"
                      >
                        {t.state.toUpperCase()}
                      </button>
                    )}
                    <button className="tasks-text" onClick={() => onOpenTask(t)} title="Go to this task" data-testid="task-open">
                      {plain}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
