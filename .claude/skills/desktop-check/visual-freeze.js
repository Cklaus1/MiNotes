// Async function body run by visual-tour.sh right after launch and before any
// view is visited. Makes the UI reproducible WITHOUT changing app code:
//  1. Clock: Date starts at a fixed instant (FROZEN, local time) and then runs
//     at normal speed, so "today", the sidebar date label, the journal title and
//     calendars are the same every run, while timers and debounces still work.
//     The backend's own clock is not touched: anything the Rust side stamps
//     (created_at, "edited x ago") can still differ -> masked per view instead.
//  2. Motion: animations/transitions off, caret hidden, smooth scrolling off,
//     via a constructable stylesheet (CSSOM; not an inline <style>, so the CSP
//     does not apply). Checked below: returns whether it took effect.
const FROZEN = new Date(2026, 2, 24, 9, 30, 0).getTime(); // Tue 24 Mar 2026 09:30 local
if (!window.__vfFrozen) {
  const Real = Date, start = Real.now(), shift = FROZEN - start;
  class FakeDate extends Real {
    constructor(...a) { if (a.length === 0) super(Real.now() + shift); else super(...a); }
    static now() { return Real.now() + shift; }
  }
  FakeDate.UTC = Real.UTC; FakeDate.parse = Real.parse;
  window.Date = FakeDate;
  window.__vfFrozen = true;
}
let css = "unavailable";
try {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync("*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; scroll-behavior: auto !important; } ::-webkit-scrollbar { display: none !important; }");
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  const probe = document.createElement("div"); probe.style.transition = "opacity 2s"; document.body.appendChild(probe);
  css = getComputedStyle(probe).transitionDuration === "0s" ? "applied" : "not applied";
  probe.remove();
} catch (e) { css = "error: " + e.message; }
// Park the pointer-dependent state: blur whatever has focus.
if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
return { today: new Date().toDateString(), css };
