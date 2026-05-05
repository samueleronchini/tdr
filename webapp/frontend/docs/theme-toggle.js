(() => {
  const storageKey = "gw_tdr_docs_theme";
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

    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    return prefersDark ? "dark" : "light";
  };

  const updateTheme = (theme, persist) => {
    root.setAttribute("data-theme", theme);
    toggleBtn.setAttribute("aria-pressed", String(theme === "dark"));
    toggleBtn.textContent = theme === "dark" ? "Switch to light" : "Switch to dark";

    if (persist) {
      localStorage.setItem(storageKey, theme);
    }
  };

  updateTheme(getInitialTheme(), false);

  toggleBtn.addEventListener("click", () => {
    const nextTheme = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    updateTheme(nextTheme, true);
  });
})();
