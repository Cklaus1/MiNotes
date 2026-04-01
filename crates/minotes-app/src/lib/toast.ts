/** Simple imperative toast notification — no React component needed. */
export function showToast(message: string, duration = 5000): void {
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

/** Toast with an Undo button. Returns true if undo was clicked (within timeout). */
export function showUndoToast(message: string, onUndo: () => void, duration = 5000): void {
  const el = document.createElement("div");
  el.className = "minotes-toast minotes-toast-undo";

  const text = document.createElement("span");
  text.textContent = message;
  el.appendChild(text);

  const btn = document.createElement("button");
  btn.className = "minotes-toast-undo-btn";
  btn.textContent = "Undo";
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

  setTimeout(dismiss, duration);
}
