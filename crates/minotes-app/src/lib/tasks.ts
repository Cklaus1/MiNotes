/**
 * Tasks view helpers: what a task line is, how to change its state in the
 * block's text, and the one-time cleanup of the old generated "All TODOs" page.
 *
 * `parseTaskLine` mirrors `parse_task_line` in
 * crates/minotes-core/src/repo/ai_suggestions.rs (the backend's list_tasks), and
 * its pending lines are exactly todoExtractor's pending ones (the badge count).
 */
import * as api from "./api";
import { parseTaskLine, type TaskState } from "./todoExtractor";

export type { TaskState, TaskKind, TaskLine } from "./todoExtractor";
export { parseTaskLine };

const MARKERS: Array<[string, TaskState]> = [["TODO ", "todo"], ["DOING ", "doing"], ["DONE ", "done"]];
const KEYWORD_RE = /^(todo|action|follow up|follow-up|next):\s*/i;
const CHECKBOX_RE = /^([-*+]\s+)\[([ xX])\](\s+)/;

/**
 * `content` with task line `lineIndex` set to `state`. TODO/DOING/DONE markers
 * swap the keyword; a checkbox is ticked or cleared (it has no DOING, which
 * becomes a DOING marker); a `todo:`-style line becomes a DONE/DOING marker
 * line (or stays as it is for "todo"). Indentation is kept. Returns null when
 * that line is no longer a task (the block changed meanwhile).
 */
export function setTaskState(content: string, lineIndex: number, state: TaskState): string | null {
  const lines = content.split("\n");
  const line = lines[lineIndex];
  if (line === undefined) return null;
  const task = parseTaskLine(line);
  if (!task) return null;
  if (task.state === state) return content;
  const bom = line.startsWith("﻿") ? "﻿" : "";
  const body = line.slice(bom.length);
  const indent = body.slice(0, body.length - body.trimStart().length);
  const rest = body.trimStart();
  const marker = state === "todo" ? "TODO " : state === "doing" ? "DOING " : "DONE ";
  let next: string;
  if (task.kind === "marker") {
    const kw = MARKERS.find(([k]) => rest.startsWith(k))![0];
    next = indent + marker + rest.slice(kw.length);
  } else if (task.kind === "checkbox" && state !== "doing") {
    next = indent + rest.replace(CHECKBOX_RE, (_m, lead, _box, gap) => `${lead}[${state === "done" ? "x" : " "}]${gap}`);
  } else if (task.kind === "checkbox") {
    next = indent + marker + task.text;
  } else {
    // todo: / action: … lines are pending by their keyword.
    next = state === "todo" ? body : indent + marker + rest.replace(KEYWORD_RE, "");
  }
  lines[lineIndex] = bom + next;
  return lines.join("\n");
}

/** ui_state key: the generated "All TODOs" pages were cleaned up in this notebook. */
const CLEANUP_KEY = "cleanup.all-todos-v1";

/**
 * Once per notebook: move the "All TODOs" pages the old TODO badge generated to
 * the Trash (only pages of exactly that generated shape — see the backend), log
 * what was removed and return their titles. A locked or failing notebook is
 * retried next time.
 */
export async function cleanupGeneratedTodoPagesOnce(): Promise<string[]> {
  try {
    if ((await api.getUiState(CLEANUP_KEY)) === "done") return [];
    const removed = await api.cleanupGeneratedTodoPages();
    await api.setUiState(CLEANUP_KEY, "done");
    for (const [id, title] of removed) {
      console.info(`[tasks] moved the generated "${title}" page (${id}) to the Trash; the Tasks view replaces it`);
    }
    return removed.map(([, title]) => title);
  } catch {
    return [];
  }
}
