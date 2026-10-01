// Theme control. The first paint is set by a tiny inline script in the document head (so there is no
// flash of the wrong theme); this module only reads and flips the stored choice afterwards. System
// preference is the default when the user has made no choice.

type Theme = "light" | "dark";

const KEY = "overhear-sim-theme";

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

function systemTheme(): Theme {
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function currentTheme(): Theme {
  const attr = document.documentElement.getAttribute("data-theme");
  return attr === "light" || attr === "dark" ? attr : systemTheme();
}

function apply(theme: Theme, button: HTMLElement): void {
  document.documentElement.setAttribute("data-theme", theme);
  button.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
  button.textContent = theme === "dark" ? "Dark" : "Light";
  button.setAttribute("title", `Theme: ${theme}. Click to switch.`);
}

/** Wire a toggle button to flip and persist the theme. Returns nothing; state lives on the element. */
export function initThemeToggle(button: HTMLElement): void {
  apply(stored() ?? currentTheme(), button);
  button.addEventListener("click", () => {
    const next: Theme = currentTheme() === "dark" ? "light" : "dark";
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Storage can be unavailable or full; the theme still applies for this session.
    }
    apply(next, button);
  });
}
