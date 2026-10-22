/**
 * A block's markdown as a short run of inline pieces for compact views (kanban
 * cards, mind map nodes): plain text, [[page links]] (to show as clickable
 * chips with the page's title, never the raw `[[x|id]]`) and #tags — plus the
 * badges a card shows (tags, due / scheduled dates, properties). Built on the
 * same rules as lib/plainText.ts (search results, Tasks view).
 */
import { blockPlainText } from "./plainText";

export type Segment =
  | { kind: "text"; text: string }
  | { kind: "link"; target: string; label: string; notebook?: string }
  | { kind: "tag"; tag: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROPERTY_LINE = /^\s*([A-Za-z][\w-]*)::\s*(.*)$/;
const SCHEDULE_LINE = /^\s*(SCHEDULED|DEADLINE):\s*<?([^>]*)>?\s*$/;

/** `[[inner]]` → target page (title or id), label shown, and its notebook. */
export function parseWikiLink(inner: string): { target: string; label: string; notebook?: string } {
  let t = inner;
  let label: string | null = null;
  const bar = t.lastIndexOf("|");
  if (bar >= 0) {
    const after = t.slice(bar + 1).trim();
    t = t.slice(0, bar);
    if (!UUID.test(after)) label = after; // [[Title|alias]] shows the alias; [[Title|<id>]] the title
  }
  const nb = t.indexOf("::");
  const notebook = nb >= 0 ? t.slice(0, nb).trim() : undefined;
  const page = (nb >= 0 ? t.slice(nb + 2) : t).trim();
  return { target: page, label: label || page, ...(notebook ? { notebook } : {}) };
}

/**
 * The first line of a block (TODO/DOING/DONE marker removed — views show it as
 * a badge) as segments; property and SCHEDULED/DEADLINE lines are not text.
 * `withTags: false` drops #tags (the card shows them as badges instead).
 */
export function inlineSegments(content: string, opts: { withTags?: boolean; maxLen?: number } = {}): Segment[] {
  const withTags = opts.withTags ?? true;
  const maxLen = opts.maxLen ?? 240;
  const line = content.replace(/^﻿/, "").split("\n").find((l) => !PROPERTY_LINE.test(l) && !SCHEDULE_LINE.test(l) && l.trim() !== "") ?? "";
  const body = line.replace(/^\s*(TODO|DOING|DONE) /, "");
  const out: Segment[] = [];
  const pushText = (raw: string) => {
    if (!raw) return;
    // Formatting marks etc. go the plainText way; keep surrounding spaces.
    const lead = /^\s/.test(raw) ? " " : "";
    const trail = /\s$/.test(raw) && raw.trim() ? " " : "";
    const t = blockPlainText(raw).text;
    const text = t ? lead + t + trail : raw.trim() ? "" : " ";
    if (!text) return;
    const last = out[out.length - 1];
    if (last?.kind === "text") last.text += text; else out.push({ kind: "text", text });
  };
  // A link never spans another "[[" (e.g. "Type **[[** to link … [[Page]]").
  const re = /\[\[((?:(?!\[\[)[^\]])+?)\]\]|(^|\s)#([a-zA-Z][\w/-]*)/g;
  let at = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (m[1] !== undefined) {
      pushText(body.slice(at, m.index));
      out.push({ kind: "link", ...parseWikiLink(m[1]) });
    } else {
      pushText(body.slice(at, m.index) + m[2]);
      const tag = m[3].replace(/\/+$/, "");
      if (withTags) out.push({ kind: "tag", tag });
    }
    at = m.index + m[0].length;
  }
  pushText(body.slice(at));
  // Trim, and cap the visible length.
  let left = maxLen;
  const capped: Segment[] = [];
  for (const s of out) {
    if (left <= 0) break;
    if (s.kind === "text") {
      const t = s.text.length > left ? s.text.slice(0, left - 1).trimEnd() + "…" : s.text;
      capped.push({ kind: "text", text: t });
      left -= t.length;
    } else {
      capped.push(s);
      left -= s.kind === "link" ? s.label.length : s.tag.length + 1;
    }
  }
  const first = capped[0], last = capped[capped.length - 1];
  if (first?.kind === "text") first.text = first.text.trimStart();
  if (last?.kind === "text") last.text = last.text.trimEnd();
  return capped.filter((s) => s.kind !== "text" || s.text !== "");
}

/** Plain text of the segments (aria labels, tooltips, search). */
export function segmentsText(segs: Segment[]): string {
  return segs.map((s) => (s.kind === "text" ? s.text : s.kind === "link" ? s.label : `#${s.tag}`)).join("");
}

export interface Badge {
  kind: "tag" | "date" | "prop";
  label: string;
  /** For dates: "overdue" | "today" | "later". */
  when?: "overdue" | "today" | "later";
  title: string;
}

const DATE_KEYS = new Set(["due", "deadline", "scheduled", "date", "due-date", "due_date"]);
const HIDDEN_KEYS = new Set(["kanban-color", "color", "collapsed", "id", "view", "kanban-group", "mindmap-layout"]);

function dateBadge(key: string, value: string, today: string): Badge | null {
  const m = /(\d{4}-\d{2}-\d{2})/.exec(value);
  if (!m) return null;
  const d = m[1];
  const when = d < today ? "overdue" : d === today ? "today" : "later";
  const name = key.toLowerCase() === "scheduled" ? "Scheduled" : "Due";
  return { kind: "date", label: `${name} ${d}`, when, title: `${name}: ${d}${when === "overdue" ? " (overdue)" : when === "today" ? " (today)" : ""}` };
}

/**
 * Up to `max` badges for a card: due / scheduled dates first (inline
 * `due:: 2026-11-02`, `SCHEDULED: <2026-11-02>`, or a stored property), then
 * #tags, then other properties.
 */
export function cardBadges(content: string, props: { key: string; value?: string }[], today: string, max = 4): Badge[] {
  const dates: Badge[] = [];
  const tags: Badge[] = [];
  const others: Badge[] = [];
  const seenKeys = new Set<string>();
  const addProp = (key: string, value: string) => {
    const k = key.toLowerCase();
    if (seenKeys.has(k) || HIDDEN_KEYS.has(k) || k.startsWith("_")) return;
    seenKeys.add(k);
    if (DATE_KEYS.has(k)) {
      const b = dateBadge(k, value, today);
      if (b) { dates.push(b); return; }
    }
    if (k === "tags" || k === "tag") {
      for (const t of value.split(/[,\s]+/).map((x) => x.replace(/^#/, "").replace(/^\[\[|\]\]$/g, "")).filter(Boolean)) {
        tags.push({ kind: "tag", label: `#${t}`, title: `Tag: ${t}` });
      }
      return;
    }
    const v = value.length > 24 ? value.slice(0, 23) + "…" : value;
    others.push({ kind: "prop", label: `${key}: ${v}`, title: `${key}: ${value}` });
  };
  for (const line of content.split("\n")) {
    const p = PROPERTY_LINE.exec(line);
    if (p) { addProp(p[1], p[2]); continue; }
    const s = SCHEDULE_LINE.exec(line);
    if (s) {
      const b = dateBadge(s[1] === "DEADLINE" ? "due" : "scheduled", s[2], today);
      if (b && !seenKeys.has(s[1].toLowerCase())) { seenKeys.add(s[1].toLowerCase()); dates.push(b); }
    }
  }
  for (const p of props) addProp(p.key, p.value ?? "");
  const seenTags = new Set(tags.map((t) => t.label.toLowerCase()));
  for (const s of inlineSegments(content, { maxLen: 10_000 })) {
    if (s.kind !== "tag") continue;
    const label = `#${s.tag}`;
    if (seenTags.has(label.toLowerCase())) continue;
    seenTags.add(label.toLowerCase());
    tags.push({ kind: "tag", label, title: `Tag: ${s.tag}` });
  }
  return [...dates, ...tags, ...others].slice(0, max);
}
