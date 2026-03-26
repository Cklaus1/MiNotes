import { useState, useMemo } from "react";

interface Props {
  journalDates: Set<string>;
  onDateClick: (date: string) => void;
}

const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function pad(n: number): string { return n < 10 ? `0${n}` : `${n}`; }

function toKey(y: number, m: number, d: number): string {
  return `${y}-${pad(m + 1)}-${pad(d)}`;
}

export default function CalendarWidget({ journalDates, onDateClick }: Props) {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());

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
        <button className="cal-nav" onClick={prev}>‹</button>
        <span className="cal-month">{MONTHS[month]} {year}</span>
        <button className="cal-nav" onClick={next}>›</button>
      </div>
      <div className="cal-grid">
        {DAYS.map((d) => (
          <span key={d} className="cal-day-label">{d}</span>
        ))}
        {days.map((cell, i) =>
          cell ? (
            <button
              key={i}
              className={`cal-day${journalDates.has(cell.key) ? " has-entry" : ""}${cell.key === todayKey ? " today" : ""}`}
              onClick={() => onDateClick(cell.key)}
              title={cell.key}
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
