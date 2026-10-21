import { useState, useMemo, useEffect } from "react";

interface Props {
  journalDates: Set<string>;
  onDateClick: (date: string) => void;
  /** The journal day that is open ("YYYY-MM-DD"): marked, and its month shown. */
  selectedDate?: string | null;
}

const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function pad(n: number): string { return n < 10 ? `0${n}` : `${n}`; }

function toKey(y: number, m: number, d: number): string {
  return `${y}-${pad(m + 1)}-${pad(d)}`;
}

function parseKey(key?: string | null): { y: number; m: number } | null {
  const m = key ? /^(\d{4})-(\d{2})-\d{2}$/.exec(key) : null;
  return m ? { y: Number(m[1]), m: Number(m[2]) - 1 } : null;
}

export default function CalendarWidget({ journalDates, onDateClick, selectedDate }: Props) {
  const today = new Date();
  const initial = parseKey(selectedDate);
  const [year, setYear] = useState(initial?.y ?? today.getFullYear());
  const [month, setMonth] = useState(initial?.m ?? today.getMonth());

  // Opening another day shows its month.
  useEffect(() => {
    const p = parseKey(selectedDate);
    if (p) { setYear(p.y); setMonth(p.m); }
  }, [selectedDate]);

  const days = useMemo(() => {
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells: Array<{ day: number; key: string } | null> = [];
    for (let i = 0; i < firstDay; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d, key: toKey(year, month, d) });
    return cells;
  }, [year, month]);

  const todayKey = toKey(today.getFullYear(), today.getMonth(), today.getDate());

  const prev = () => {
    if (month === 0) { setMonth(11); setYear(y => y - 1); }
    else setMonth(m => m - 1);
  };

  const next = () => {
    if (month === 11) { setMonth(0); setYear(y => y + 1); }
    else setMonth(m => m + 1);
  };

  return (
    <div className="cal-widget">
      <div className="cal-header">
        <button className="cal-nav" onClick={prev} aria-label="Previous month">‹</button>
        <span className="cal-month">{MONTHS[month]} {year}</span>
        <button className="cal-nav" onClick={next} aria-label="Next month">›</button>
      </div>
      <div className="cal-grid">
        {DAYS.map((d) => (
          <span key={d} className="cal-day-label">{d}</span>
        ))}
        {days.map((cell, i) =>
          cell ? (
            <button
              key={i}
              className={`cal-day${journalDates.has(cell.key) ? " has-entry" : ""}${cell.key === todayKey ? " today" : ""}${cell.key === selectedDate ? " selected" : ""}`}
              onClick={() => onDateClick(cell.key)}
              title={cell.key}
              aria-current={cell.key === selectedDate ? "date" : undefined}
            >
              {cell.day}
              {journalDates.has(cell.key) && <span className="cal-dot" />}
            </button>
          ) : (
            <span key={i} className="cal-day empty" />
          ),
        )}
      </div>
    </div>
  );
}
