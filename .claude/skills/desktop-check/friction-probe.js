// Measures how long after an Enter keydown a DIFFERENT block editor gets focus.
// Results (ms) accumulate in window.__lat. Installed by friction.sh.
if (!window.__lat) {
  window.__lat = [];
  let t0 = null, el0 = null;
  window.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.shiftKey && t0 === null) { t0 = performance.now(); el0 = document.activeElement; }
  }, true);
  document.addEventListener("focusin", (e) => {
    if (t0 !== null && e.target !== el0 && e.target.closest && e.target.closest(".ProseMirror")) {
      window.__lat.push(Math.round(performance.now() - t0)); t0 = null;
    }
  }, true);
}
return true;
