/**
 * The command palette's commands (UX Wave 4): one registry every part of the
 * app adds to — App registers the app-wide actions, a view may add its own
 * while it is mounted. The palette (Ctrl+K, then ">") lists them all, ranked by
 * lib/fuzzy.ts with recently run commands first inside each kind of match.
 *
 * A command either runs (`run`) or asks for one more choice first (`pick`:
 * the palette shows that list — notebooks, projects… — and runs `onPick`).
 */
import { useEffect, useRef } from "react";
import { fuzzyMatch, TIER, type Range } from "./fuzzy";

export interface PickItem {
  id: string;
  label: string;
  /** Shown dimmed after the label (a path, "open now"…). */
  detail?: string;
  /** Not selectable, with the reason as its tooltip. */
  disabled?: string;
}

export interface AppCommand {
  id: string;
  /** A function when it depends on state read at palette time ("Show/Hide …"). */
  label: string | (() => string);
  /** Shown on the right, e.g. "Ctrl+J" (keep in sync with lib/shortcuts.ts). */
  shortcut?: string;
  /** Extra words it is found by ("delete" for "Move Page to Trash"). */
  keywords?: string;
  /** Hidden when false (e.g. page commands with no page open); read when the palette lists. */
  available?: boolean | (() => boolean);
  run?: () => void | Promise<void>;
  pick?: {
    placeholder: string;
    items: () => PickItem[] | Promise<PickItem[]>;
    onPick: (item: PickItem) => void | Promise<void>;
  };
}

const sources = new Map<string, AppCommand[]>();
const listeners = new Set<() => void>();
let revision = 0;

function changed() {
  revision++;
  listeners.forEach(l => l());
}

/** Bumped on every change (a store snapshot for useSyncExternalStore). */
export function commandsRevision(): number {
  return revision;
}

/** Set (replace) the commands of one source; returns the remover. */
export function registerCommands(source: string, commands: AppCommand[]): () => void {
  sources.set(source, commands);
  changed();
  return () => {
    if (sources.get(source) === commands) {
      sources.delete(source);
      changed();
    }
  };
}

/** A command as listed now: its label resolved. */
export type ListedCommand = Omit<AppCommand, "label" | "available"> & { label: string };

/** Every available command, in registration order, de-duplicated by id. */
export function listCommands(): ListedCommand[] {
  const seen = new Set<string>();
  const out: ListedCommand[] = [];
  for (const cmds of sources.values()) {
    for (const c of cmds) {
      const available = typeof c.available === "function" ? c.available() : c.available;
      if (available === false || seen.has(c.id)) continue;
      seen.add(c.id);
      out.push({ ...c, label: typeof c.label === "function" ? c.label() : c.label });
    }
  }
  return out;
}

export function subscribeCommands(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Register `commands` (rebuilt whenever `deps` change) while the component is mounted. */
export function useCommands(source: string, build: () => AppCommand[], deps: unknown[]): void {
  const buildRef = useRef(build);
  buildRef.current = build;
  useEffect(() => registerCommands(source, buildRef.current()), deps); // eslint-disable-line react-hooks/exhaustive-deps
}

// ── Recently run commands (boosted in the ranking) ──

const RECENT_KEY = "minotes-recent-commands";
const RECENT_MAX = 8;

export function recentCommandIds(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function noteCommandRun(id: string): void {
  try {
    const next = [id, ...recentCommandIds().filter(x => x !== id)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* not remembered */ }
}

/** 0…1: how recently a command was run (1 = the last one). */
export function recencyBoost(recent: string[], id: string): number {
  const i = recent.indexOf(id);
  return i < 0 ? 0 : 1 - i / RECENT_MAX;
}

/**
 * Commands for a palette query, best first: by the label (lib/fuzzy tiers),
 * else by a keyword — only a clear keyword hit (whole word or words, never
 * scattered letters), ranked half a tier below the same kind of label hit.
 * Recently run commands come first among equals. `ranges` mark the label.
 */
export function rankCommands<C extends { id: string; label: string; keywords?: string }>(
  cmds: readonly C[], query: string, recent: string[],
): Array<{ cmd: C; ranges: Range[] }> {
  const scored: Array<{ cmd: C; ranges: Range[]; score: number; order: number }> = [];
  cmds.forEach((cmd, order) => {
    const m = fuzzyMatch(query, cmd.label);
    let score = m ? m.score : -Infinity;
    let ranges = m?.ranges ?? [];
    if (cmd.keywords && query.trim()) {
      const k = fuzzyMatch(query, cmd.keywords);
      if (k && k.tier <= TIER.words && k.score - 500 > score) { score = k.score - 500; ranges = []; }
    }
    if (score === -Infinity) return;
    scored.push({ cmd, ranges, score: score + recencyBoost(recent, cmd.id) * 200, order });
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.map(({ cmd, ranges }) => ({ cmd, ranges }));
}
