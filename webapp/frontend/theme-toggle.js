(() => {
  const storageKey = "gw_tdr_ui_theme";
  const root = document.documentElement;
  const toggleBtn = document.getElementById("theme-toggle");

  if (!toggleBtn) {
    return;
  }

  const getInitialTheme = () => {
    const stored = localStorage.getItem(storageKey);
    if (stored === "light" || stored === "dark") {
      return stored;
    }

    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  };

  const applyTheme = (theme, persist) => {
    root.setAttribute("data-theme", theme);
    toggleBtn.setAttribute("aria-pressed", String(theme === "dark"));
    toggleBtn.textContent = theme === "dark" ? "Switch to light" : "Switch to dark";

    if (persist) {
      localStorage.setItem(storageKey, theme);
    }
  };

  applyTheme(getInitialTheme(), false);

  toggleBtn.addEventListener("click", () => {
    const nextTheme = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    applyTheme(nextTheme, true);
  });
})();
