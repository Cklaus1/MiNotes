/**
 * Natural-language dates for the editor (PRD-editor-improvements "Natural-language
 * dates"): a small deterministic parser — no AI, no network, same answer every time.
 *
 *   today · tomorrow · yesterday
 *   friday · this friday · next friday · last friday   (next = the first one after today)
 *   in 3 days · in 2 weeks · in 1 month · 3 days ago · +3d · -2w · next week · last month
 *   2026-10-30 · mar 30 · 30 march · march 30 2027 · 30 mar 2027
 *
 * The result is a local calendar day (journal convention, lib/dates.ts).
 */
import { localDateKey } from "./dates";

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function weekday(word: string): number {
  const w = word.toLowerCase().replace(/\.$/, "");
  // "fri", "friday", "thu", "thurs", "tues"…
  return w.length >= 3 ? WEEKDAYS.findIndex(d => d.startsWith(w)) : -1;
}

function month(word: string): number {
  const w = word.toLowerCase().replace(/\.$/, "");
  if (w.length < 3) return -1;
  return MONTHS.findIndex(m => m.startsWith(w));
}

function atMidnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function addMonths(d: Date, n: number): Date {
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(d.getDate(), last));
}

function shift(d: Date, n: number, unit: string): Date | null {
  const u = unit.toLowerCase();
  if (/^(d|days?)$/.test(u)) return addDays(d, n);
  if (/^(w|wks?|weeks?)$/.test(u)) return addDays(d, 7 * n);
  if (/^(m|mos?|months?)$/.test(u)) return addMonths(d, n);
  if (/^(y|yrs?|years?)$/.test(u)) return addMonths(d, 12 * n);
  return null;
}

function validDay(y: number, m: number, d: number): Date | null {
  const date = new Date(y, m, d);
  return date.getFullYear() === y && date.getMonth() === m && date.getDate() === d ? date : null;
}

/** The day a phrase means, relative to `now` (null when it isn't a date). */
export function parseNaturalDate(phrase: string, now: Date = new Date()): Date | null {
  const today = atMidnight(now);
  const s = phrase.trim().toLowerCase().replace(/[,]/g, " ").replace(/\s+/g, " ");
  if (!s) return null;
  if (s === "today" || s === "now" || s === "tod") return today;
  if (s === "tomorrow" || s === "tmr" || s === "tom") return addDays(today, 1);
  if (s === "yesterday" || s === "yest") return addDays(today, -1);

  let m: RegExpExecArray | null;
  // ISO date
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) return validDay(+m[1], +m[2] - 1, +m[3]);
  // +3d / -2w / +1m
  if ((m = /^([+-])\s?(\d{1,4})\s?([a-z]+)$/.exec(s))) return shift(today, (m[1] === "-" ? -1 : 1) * +m[2], m[3]);
  // in 3 days / in a week
  if ((m = /^in (\d{1,4}|a|an|one) ([a-z]+)$/.exec(s))) return shift(today, /^\d/.test(m[1]) ? +m[1] : 1, m[2]);
  // 3 days ago / a week ago
  if ((m = /^(\d{1,4}|a|an|one) ([a-z]+) ago$/.exec(s))) return shift(today, -(/^\d/.test(m[1]) ? +m[1] : 1), m[2]);
  // next week / last month / next year
  if ((m = /^(next|last) (week|month|year)$/.exec(s))) return shift(today, m[1] === "next" ? 1 : -1, m[2]);
  // [this|next|last|on] <weekday>
  if ((m = /^(?:(this|next|last|on|coming|past) )?([a-z]+)$/.exec(s))) {
    const wd = weekday(m[2]);
    if (wd >= 0) {
      const cur = today.getDay();
      if (m[1] === "last" || m[1] === "past") {
        const back = ((cur - wd + 7) % 7) || 7;
        return addDays(today, -back);
      }
      const ahead = (wd - cur + 7) % 7;
      // "friday" / "this friday" on a Friday is today; "next friday" never is.
      if (ahead === 0) return m[1] === "next" || m[1] === "coming" ? addDays(today, 7) : today;
      return addDays(today, ahead);
    }
  }
  // mar 30 [2027] / march 30th
  if ((m = /^([a-z]+\.?) (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/.exec(s))) {
    const mo = month(m[1]);
    if (mo >= 0) return withYear(today, mo, +m[2], m[3]);
  }
  // 30 mar [2027] / 30th of march
  if ((m = /^(\d{1,2})(?:st|nd|rd|th)?(?: of)? ([a-z]+\.?)(?: (\d{4}))?$/.exec(s))) {
    const mo = month(m[2]);
    if (mo >= 0) return withYear(today, mo, +m[1], m[3]);
  }
  return null;
}

/** A month/day without a year is the next such day (today counts). */
function withYear(today: Date, mo: number, day: number, year?: string): Date | null {
  if (year) return validDay(+year, mo, day);
  const thisYear = validDay(today.getFullYear(), mo, day);
  if (thisYear && thisYear >= today) return thisYear;
  return validDay(today.getFullYear() + 1, mo, day) ?? thisYear;
}

/** `[[Journal/YYYY-MM-DD]]` for a day: a link to that day's journal page. */
export function journalLink(date: Date): string {
  return `[[Journal/${localDateKey(date)}]]`;
}

/** "Friday, 30 October 2026" — what a phrase resolved to, shown before inserting. */
export function describeDate(date: Date): string {
  return date.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}
