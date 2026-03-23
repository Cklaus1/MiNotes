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
