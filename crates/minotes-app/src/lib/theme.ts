import { useSyncExternalStore } from "react";

export function getTheme(): "dark" | "light" {
  return (localStorage.getItem("minotes-theme") as "dark" | "light") ?? "dark";
}

export function setTheme(theme: "dark" | "light") {
  localStorage.setItem("minotes-theme", theme);
  document.documentElement.setAttribute("data-theme", theme);
  document.body.classList.remove("theme-dark", "theme-light");
  document.body.classList.add(`theme-${theme}`);
}

export function toggleTheme() {
  setTheme(getTheme() === "dark" ? "light" : "dark");
}

export function initTheme() {
  const theme = getTheme();
  document.documentElement.setAttribute("data-theme", theme);
  document.body.classList.remove("theme-dark", "theme-light");
  document.body.classList.add(`theme-${theme}`);
}

// ── Following the theme from canvases (graph, whiteboard) ──

/** The theme the document shows right now. */
export function currentTheme(): "dark" | "light" {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

/** Calls `cb` whenever the theme changes; returns the unsubscribe function. */
export function onThemeChange(cb: () => void): () => void {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => mo.disconnect();
}

/** React hook: the current theme, re-rendering when it changes. */
export function useAppTheme(): "dark" | "light" {
  return useSyncExternalStore(onThemeChange, currentTheme, () => "dark");
}

/** A theme colour (CSS custom property on :root), e.g. themeColor("--accent"). */
export function themeColor(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
