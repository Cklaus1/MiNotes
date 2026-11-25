const MAX_TOASTS = 5;

function enforceToastCap(): void {
  const existing = document.querySelectorAll(".minotes-toast");
  if (existing.length >= MAX_TOASTS) {
    // Remove the oldest toasts to keep the cap
    const toRemove = existing.length - MAX_TOASTS + 1;
    for (let i = 0; i < toRemove; i++) {
      existing[i]?.remove();
    }
  }
}

/** Simple imperative toast notification — no React component needed. */
export function showToast(message: string, duration = 5000): void {
  enforceToastCap();
  const el = document.createElement("div");
  el.className = "minotes-toast";
  el.textContent = message;
  document.body.appendChild(el);

  requestAnimationFrame(() => el.classList.add("minotes-toast-visible"));

  setTimeout(() => {
    el.classList.remove("minotes-toast-visible");
    el.addEventListener("transitionend", () => el.remove());
    setTimeout(() => el.remove(), 500);
  }, duration);
}

/**
 * Toast with an Undo button. The button is a real <button> (Tab reaches it) and
 * the toast is announced to screen readers. Hovering or focusing the toast keeps
 * it open. Returns a function that dismisses it.
 */
export function showUndoToast(message: string, onUndo: () => void, duration = 5000, undoLabel = "Undo"): () => void {
  enforceToastCap();
  const el = document.createElement("div");
  el.className = "minotes-toast minotes-toast-undo";
  el.setAttribute("role", "status");

  const text = document.createElement("span");
  text.textContent = message;
  el.appendChild(text);

  const btn = document.createElement("button");
  btn.className = "minotes-toast-undo-btn";
  btn.textContent = undoLabel;
  btn.type = "button";
  btn.onclick = (e) => {
    e.stopPropagation();
    onUndo();
    dismiss();
  };
  el.appendChild(btn);

  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("minotes-toast-visible"));

  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    el.classList.remove("minotes-toast-visible");
    el.addEventListener("transitionend", () => el.remove());
    setTimeout(() => el.remove(), 500);
  };

  let timer = setTimeout(dismiss, duration);
  const hold = () => clearTimeout(timer);
  const release = () => {
    if (el.matches(":hover") || el.contains(document.activeElement)) return;
    clearTimeout(timer);
    timer = setTimeout(dismiss, 2500);
  };
  el.addEventListener("mouseenter", hold);
  el.addEventListener("focusin", hold);
  el.addEventListener("mouseleave", release);
  el.addEventListener("focusout", () => setTimeout(release, 0));
  return dismiss;
}
