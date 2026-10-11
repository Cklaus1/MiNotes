// In-page measurement helpers for scale-tour.sh. Prepended to every
// `desktop.sh js` call the tour makes; installs window.__sc once per page load.
//
// Everything is timed with performance.now() INSIDE the webview, so WebDriver
// round-trips are not part of the numbers. A measurement is started by one call
// (which returns at once) and its result is polled from window.__sc.res[name],
// because a slow view can outlive the 60 s cap on a single WebDriver script.
if (!window.__sc) {
  const sc = (window.__sc = { res: {}, ipc: {}, pending: 0, lastEnd: {} });
  const T = () => window.__MINOTES__;
  const api = () => T().modules["/src/lib/api.ts"];
  // Count Tauri IPC calls per command (evidence for N+1 patterns). The invoke
  // function itself is read-only, but every call goes out as fetch("ipc://localhost/<cmd>").
  try {
    const of = window.fetch;
    window.fetch = function (u) { const s = String((u && u.url) || u); if (!s.startsWith("ipc://")) return of.apply(this, arguments);
      const cmd = s.split("/").pop(); sc.ipc[cmd] = (sc.ipc[cmd] || 0) + 1; sc.pending++;
      const end = () => { sc.pending--; sc.lastEnd[cmd] = sc.lastEnd["*"] = performance.now(); };
      const p = of.apply(this, arguments); p.then(end, end); return p; };
    sc.ipcHook = true;
  } catch (e) { sc.ipcHook = false; }
  const nodeCount = sel => (sel ? document.querySelectorAll(sel + " *").length : document.getElementsByTagName("*").length);
  const firstBlockText = () => { const el = document.querySelector(".block-list .block .ProseMirror"); return el ? el.textContent : ""; };
  const ipcDelta = before => { const d = {}; let total = 0; for (const k in sc.ipc) { const n = sc.ipc[k] - (before[k] || 0); if (n) { d[k] = n; total += n; } } return { d, total }; };

  // watch(): run start(), then poll on a setTimeout(0) chain until done().
  //   first    ms until first() became true (e.g. first block of the new page)
  //   done     ms until done() became true
  //   painted  done + two animation frames (layout + paint of the result)
  //   freeze   longest gap between two polls = longest main-thread stall
  //   tail     optional: keep sampling for `tail` ms after done -> tailFreeze, tailFps
  sc.watch = (name, start, first, done, opt) => {
    opt = opt || {};
    sc.res[name] = null;
    const ipc0 = Object.assign({}, sc.ipc);
    const t0 = performance.now();
    let tFirst = null, last = t0, freeze = 0;
    const finish = ok => {
      const tDone = performance.now() - t0;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const r = { ok, first: tFirst, done: tDone, painted: performance.now() - t0, freeze, nodes: nodeCount(), ipc: ipcDelta(ipc0).d, ipcTotal: ipcDelta(ipc0).total };
        if (opt.extra) Object.assign(r, opt.extra());
        if (!opt.tail) { sc.res[name] = r; return; }
        const tEnd = performance.now() + opt.tail; let l = performance.now(), tf = 0, frames = 0;
        const fr = () => { frames++; if (performance.now() < tEnd) requestAnimationFrame(fr); };
        requestAnimationFrame(fr);
        const tk = () => { const n = performance.now(); tf = Math.max(tf, n - l); l = n; if (n < tEnd) setTimeout(tk, 0); else { r.tailFreeze = tf; r.tailFps = frames / (opt.tail / 1000); sc.res[name] = r; } };
        setTimeout(tk, 0);
      }));
    };
    const tick = () => {
      const now = performance.now(); freeze = Math.max(freeze, now - last); last = now;
      try { if (tFirst === null && first && first()) tFirst = now - t0; if (done()) return finish(true); } catch (e) { /* keep polling */ }
      if (now - t0 > (opt.timeout || 600000)) return finish(false);
      setTimeout(tick, 0);
    };
    try { start && start(); } catch (e) { sc.res[name] = { ok: false, error: String(e) }; return; }
    freeze = performance.now() - t0; last = performance.now();
    setTimeout(tick, 0);
  };

  // Open a page; `marker` is the unique text its first block starts with.
  sc.open = (name, title, marker, expect) => sc.watch(name, () => T().navigateTo(title),
    () => firstBlockText().includes(marker),
    () => firstBlockText().includes(marker) && document.querySelectorAll(".block-list .block").length >= expect,
    { extra: () => ({ blocks: document.querySelectorAll(".block-list .block").length, editors: document.querySelectorAll(".block-list .ProseMirror").length }) });
  // Open the heavily-linked page and wait for the Backlinks panel to list n items.
  sc.hub = (name, title, marker, n) => sc.watch(name, () => T().navigateTo(title),
    () => firstBlockText().includes(marker),
    () => firstBlockText().includes(marker) && document.querySelectorAll(".backlinks .backlink-item").length >= n,
    { extra: () => ({ backlinks: document.querySelectorAll(".backlinks .backlink-item").length }) });
  // Sidebar refresh: done when the IPC calls it triggered have all returned and
  // nothing new was sent for 300 ms; `settled` = last IPC response or last
  // sidebar DOM change, whichever is later (the 300 ms quiet wait is not counted).
  sc.sidebar = name => {
    let lastMut = null; const t0 = performance.now();
    const mo = new MutationObserver(() => { lastMut = performance.now(); });
    mo.observe(document.querySelector(".sidebar"), { childList: true, subtree: true, characterData: true, attributes: true });
    sc.watch(name, () => T().refreshSidebar(), null, () => { const le = sc.lastEnd["*"] || 0; const last = Math.max(le, lastMut || 0); return le > t0 && sc.pending === 0 && performance.now() - last > 300; },
      { timeout: 30000, extra: () => { mo.disconnect(); return { settled: Math.max(sc.lastEnd["*"] || 0, lastMut || 0) - t0, domChanged: lastMut !== null, sidebarNodes: nodeCount(".sidebar"), pageItems: document.querySelectorAll(".sidebar .page-item").length }; } });
  };
  // Graph view: the tour presses Control+g right after arming; t0 is that keydown.
  sc.graphArm = name => {
    sc.res[name] = null;
    const h = () => { window.removeEventListener("keydown", h, true);
      sc.watch(name, null, () => !!document.querySelector(".graph-view"), () => !!document.querySelector(".graph-view canvas"), { tail: 3000, timeout: 120000 }); };
    window.addEventListener("keydown", h, true);
  };
  // Search panel end to end: the panel is open and its input focused. Includes the
  // panel's own 150 ms debounce.
  sc.searchUi = (name, q) => {
    const el = document.querySelector(".command-palette-input");
    let t0;
    // done = the search_blocks call issued after typing has returned AND React has
    // rendered its block hits (or "No results"). "No results" alone is not enough:
    // the panel shows it during the debounce, before searching at all.
    sc.watch(name, () => { t0 = performance.now(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, q); el.dispatchEvent(new Event("input", { bubbles: true })); }, null,
      () => (sc.lastEnd.search_blocks || 0) > t0 && (document.querySelectorAll(".command-palette-item .result-content").length > 0 || !!document.querySelector(".command-palette-empty")),
      { timeout: 30000, extra: () => ({ hits: document.querySelectorAll(".command-palette-item .result-content").length, ipcMs: (sc.lastEnd.search_blocks || 0) - t0 }) });
  };
  // Time an api.ts function n times (IPC + backend only, no rendering).
  sc.times = async (fn, args, n) => {
    const ms = []; let bytes = 0, len = null;
    for (let i = 0; i < n; i++) { const t = performance.now(); const r = await api()[fn](...args); ms.push(performance.now() - t); if (i === 0) { const s = JSON.stringify(r === undefined ? null : r); bytes = s.length; len = Array.isArray(r) ? r.length : r && Array.isArray(r.blocks) ? r.blocks.length : r && Array.isArray(r.nodes) ? r.nodes.length : null; } }
    return { ms, bytes, len };
  };
  // Keystroke latency in the focused editor: keydown (capture) -> DOM mutation of
  // that editor -> next animation frame.
  sc.keysStart = idx => {
    const ed = document.querySelectorAll(".block-list .block .ProseMirror")[idx];
    if (!ed) return false;
    const k = (sc.keys = { ed, list: [], cur: null });
    k.onKey = e => { if (e.key.length !== 1) return; k.cur = { key: e.key, down: performance.now(), queued: performance.now() - e.timeStamp, mut: null, frame: null }; k.list.push(k.cur); };
    k.mo = new MutationObserver(() => { const c = k.cur; if (c && c.mut === null) { c.mut = performance.now() - c.down; requestAnimationFrame(() => { c.frame = performance.now() - c.down; }); } });
    k.mo.observe(ed, { childList: true, subtree: true, characterData: true });
    window.addEventListener("keydown", k.onKey, true);
    return true;
  };
  sc.keysStop = () => { const k = sc.keys; if (!k) return null; window.removeEventListener("keydown", k.onKey, true); k.mo.disconnect(); return { text: k.ed.textContent.slice(-40), keys: k.list.map(c => ({ key: c.key, queued: c.queued, mut: c.mut, frame: c.frame })) }; };
  sc.rect = idx => { const ed = document.querySelectorAll(".block-list .block .ProseMirror")[idx]; if (!ed) return null; ed.scrollIntoView({ block: "center" }); const r = ed.getBoundingClientRect(); return { x: Math.round(r.left + Math.min(r.width - 4, 200)), y: Math.round(r.top + r.height / 2) }; };
}
