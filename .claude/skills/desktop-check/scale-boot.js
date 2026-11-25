// Run right after scale-tour.sh triggers location.reload(): time from the
// reloaded page's navigation start until the app is usable (a block editor is on
// screen and the sidebar lists pages). performance.now() counts from navigation
// start, so the number does not depend on when WebDriver got to run this.
const marker = Number(sessionStorage.getItem("__scReload") || 0);
if (!marker || performance.timeOrigin < marker) return { stale: true };
const ready = () => !!document.querySelector(".block-list .block .ProseMirror") && document.querySelectorAll(".sidebar .page-item").length > 0;
const at0 = performance.now(), already = ready();
let freeze = 0, last = at0;
while (!ready()) {
  await new Promise(r => setTimeout(r, 0));
  const now = performance.now(); freeze = Math.max(freeze, now - last); last = now;
  if (now - at0 > 50000) break;
}
const n = performance.getEntriesByType("navigation")[0];
const fcp = performance.getEntriesByType("paint").find(p => p.name === "first-contentful-paint");
return { ok: ready(), interactive: already ? at0 : performance.now(), upperBound: already, freeze, dcl: n ? n.domContentLoadedEventEnd : null, fcp: fcp ? fcp.startTime : null,
  page: window.__MINOTES__ && window.__MINOTES__.getCurrentPage ? window.__MINOTES__.getCurrentPage() : null, sidebarItems: document.querySelectorAll(".sidebar .page-item").length, nodes: document.getElementsByTagName("*").length };
