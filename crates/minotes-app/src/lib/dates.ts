/**
 * Date helpers.
 *
 * A journal entry belongs to the user's *calendar* day, so date keys must be
 * built from local time. `toISOString().slice(0, 10)` yields the UTC day, which
 * for anyone west of UTC flips to tomorrow partway through their evening — the
 * sidebar (local) and Ctrl+J (UTC) then disagreed about what "today" is.
 */

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local YYYY-MM-DD key for a date (defaults to now). */
export function localDateKey(date: Date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local HH:MM for a date (defaults to now). */
export function localTimeKey(date: Date = new Date()): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
