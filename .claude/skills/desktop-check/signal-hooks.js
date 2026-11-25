// Installed by the signal tools (silent-errors.sh, dead-ends.sh, shortcuts.sh, friction.sh)
// through `desktop.sh js "$(cat signal-hooks.js)"`. Idempotent. No single quotes in this file.
//
// window.__sig.events  — every problem seen, each tagged with the scenario that was running
//                        (window.__sig.mark) and with what the USER could see right after it.
// window.__sig.dialogs — native alert/confirm/prompt calls (replaced so they never block the
//                        webview; answers come from window.__sig.answer).
if (!window.__sig) {
  const S = window.__sig = { events: [], dialogs: [], mark: "startup", baseline: [], answer: null, invokes: 0, seq: 0 };
  const str = (x) => {
    try { return typeof x === "string" ? x : (x && x.message) ? x.message : JSON.stringify(x); } catch (e) { return String(x); }
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && parseFloat(s.opacity || "1") > 0.05;
  };
  // What is on screen that tells the user something went wrong (or happened at all)?
  S.feedback = () => {
    const out = [];
    document.querySelectorAll(".minotes-toast").forEach((t) => { if (visible(t)) out.push("toast: " + t.innerText.trim().slice(0, 120)); });
    // App.tsx renders lastError as an unclassed red banner (#f38ba8).
    document.querySelectorAll(".main div").forEach((d) => {
      if (d.children.length === 0 && getComputedStyle(d).backgroundColor === "rgb(243, 139, 168)" && visible(d)) out.push("banner: " + d.innerText.trim().slice(0, 160));
    });
    document.querySelectorAll("[class*=error],[class*=Error],[role=alert],[class*=warning],[class*=sync-error]").forEach((d) => {
      const t = (d.innerText || "").trim();
      if (t && visible(d) && t.length < 300 && !d.querySelector("[class*=error],[class*=Error]")) out.push("inline(" + String(d.className).slice(0, 40) + "): " + t.slice(0, 160));
    });
    return [...new Set(out)];
  };
  const push = (kind, msg, extra) => {
    if (S.events.length >= 600) return;
    const ev = Object.assign({ n: ++S.seq, kind, msg: str(msg).slice(0, 400), mark: S.mark, t: Math.round(performance.now()), seenNow: [], seenLater: [] }, extra || {});
    S.events.push(ev);
    // Feedback is usually rendered a tick after the rejection: look twice.
    // S.baseline = what was already on screen when the scenario started (not caused by it).
    const base = S.baseline || [];
    const fresh = () => S.feedback().filter((f) => !base.includes(f));
    setTimeout(() => { try { ev.seenNow = fresh(); } catch (e) {} }, 250);
    setTimeout(() => { try { ev.seenLater = fresh(); } catch (e) {} }, 1500);
  };
  S.push = push;

  // 1. Every Tauri command that rejects. __TAURI_INTERNALS__.invoke is non-writable and
  //    non-configurable, but it sends each command as fetch("ipc://localhost/<cmd>") and the
  //    response header Tauri-Response says ok|error — so wrap fetch instead.
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = String((input && input.url) || input);
    const m = /^ipc:\/\/localhost\/(.+)$/.exec(url);
    const p = origFetch.apply(this, arguments);
    if (!m) {
      p.then((r) => { if (!r.ok) push("fetch-failed", r.status + " " + url.slice(0, 200)); }, (e) => push("fetch-failed", str(e) + " " + url.slice(0, 200)));
      return p;
    }
    S.invokes++;
    const cmd = decodeURIComponent(m[1]);
    let args = "";
    try { const b = init && init.body; args = (typeof b === "string" ? b : b ? new TextDecoder().decode(b) : "").slice(0, 160); } catch (e) {}
    p.then((r) => {
      if (r.headers.get("Tauri-Response") === "ok") return;
      r.clone().text().then((t) => push("invoke-rejected", cmd + " → " + t.slice(0, 300), { cmd, args }), () => push("invoke-rejected", cmd + " → (unreadable error)", { cmd, args }));
    }, (e) => push("invoke-transport", cmd + " → " + str(e), { cmd, args }));
    return p;
  };
  S.invokeHooked = true;

  // 2. console.error / console.warn
  ["error", "warn"].forEach((lvl) => {
    const o = console[lvl].bind(console);
    console[lvl] = (...a) => { push("console." + lvl, a.map(str).join(" ")); o(...a); };
  });
  // 3. Uncaught errors, failed resource loads (capture phase: resource errors do not bubble).
  window.addEventListener("error", (e) => {
    const t = e.target;
    if (t && t !== window && t.tagName) {
      push("resource-failed", t.tagName.toLowerCase() + " " + String(t.src || t.href || t.currentSrc || "").slice(0, 200));
    } else if (!/ResizeObserver loop/.test(e.message || "")) {
      push("uncaught", (e.message || str(e.error)) + (e.filename ? " @" + String(e.filename).split("/").pop() + ":" + e.lineno : ""));
    }
  }, true);
  window.addEventListener("unhandledrejection", (e) => push("unhandledrejection", str(e.reason) || "unknown"));
  document.addEventListener("securitypolicyviolation", (e) => push("csp", e.effectiveDirective + " blocked " + (e.blockedURI || "inline") + (e.sourceFile ? " from " + String(e.sourceFile).split("/").pop() : "")));

  // 4. Native dialogs: record, never block.
  window.alert = (m) => { S.dialogs.push({ type: "alert", msg: str(m), mark: S.mark }); };
  window.confirm = (m) => { S.dialogs.push({ type: "confirm", msg: str(m), mark: S.mark }); return S.answer === null ? true : !!S.answer; };
  window.prompt = (m, d) => { S.dialogs.push({ type: "prompt", msg: str(m), mark: S.mark }); return S.answer === null || S.answer === true ? null : String(S.answer); };

  // Helpers shared by the tools -------------------------------------------------
  // Set a React-controlled input the way typing would.
  S.fill = (el, value) => {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  };
  S.key = (el, key, opts) => el.dispatchEvent(new KeyboardEvent("keydown", Object.assign({ key, bubbles: true, cancelable: true }, opts || {})));
  S.byText = (sel, text) => [...document.querySelectorAll(sel)].find((e) => visible(e) && (e.innerText || "").trim().includes(text)) || null;
  S.visible = visible;
  S.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Centre of an element in page px (== screen px: the window is at 0,0).
  S.center = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; };
}
return { hooked: window.__sig.invokeHooked, events: window.__sig.events.length };
