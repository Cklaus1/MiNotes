/** Simple imperative toast notification — no React component needed. */
export function showToast(message: string, duration = 5000): void {
  const el = document.createElement("div");
  el.className = "minotes-toast";
  el.textContent = message;
  document.body.appendChild(el);

  // Trigger enter animation
  requestAnimationFrame(() => el.classList.add("minotes-toast-visible"));

  setTimeout(() => {
    el.classList.remove("minotes-toast-visible");
    el.addEventListener("transitionend", () => el.remove());
    // Fallback removal if transition doesn't fire
    setTimeout(() => el.remove(), 500);
  }, duration);
}
