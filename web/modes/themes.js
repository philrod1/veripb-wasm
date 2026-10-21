// veripb-repl's TUI palettes (src/tui/theme.rs), as CSS custom properties
// for enhanced mode. Names, colours and `:theme` messages follow the TUI.

const THEMES = {
  dark: {
    bg: "#282c34", fg: "#abb2bf", dim: "#5c6370", variable: "#56b6c2", label: "#e5c07b",
    cursorAccent: "#c678dd", cursorBg: "#3b2c42", assertionBg: "#4a2529", coreBg: "#253d28",
    derivedBg: "#4a3e10", errorBg: "#7f1d1d", breakpoint: "#e06c75", errorFg: "#e06c75", okFg: "#98c379",
  },
  light: {
    bg: "#fafafa", fg: "#1a1a1a", dim: "#a0a1a7", variable: "#0184bc", label: "#c18401",
    cursorAccent: "#a626a4", cursorBg: "#e9d8f5", assertionBg: "#f8d7da", coreBg: "#d4edda",
    derivedBg: "#f6e6be", errorBg: "#fca5a5", breakpoint: "#e45649", errorFg: "#e45649", okFg: "#50a14f",
  },
  "hi-contrast": {
    bg: "#000000", fg: "#ffffff", dim: "#b0b0b0", variable: "#00d7d7", label: "#ffd700",
    cursorAccent: "#d700ff", cursorBg: "#5f0087", assertionBg: "#870000", coreBg: "#005f00",
    derivedBg: "#b85c00", errorBg: "#ff0000", breakpoint: "#ffa500", errorFg: "#ff5f5f", okFg: "#00ff5f",
  },
  colorblind: {
    bg: "#282c34", fg: "#abb2bf", dim: "#5c6370", variable: "#56b4e9", label: "#f0e442",
    cursorAccent: "#cc79a7", cursorBg: "#472a3a", assertionBg: "#4b2100", coreBg: "#003728",
    derivedBg: "#545017", errorBg: "#d55e00", breakpoint: "#e69f00", errorFg: "#d55e00", okFg: "#009e73",
  },
};
export const THEME_NAMES = Object.keys(THEMES);
const STORAGE_KEY = "veripb-repl-theme";

/** Page custom properties for a palette (style.css uses these names). */
function properties(t) {
  const mix = (a, b, pct) => `color-mix(in srgb, ${a} ${pct}%, ${b})`;
  return {
    "--bg": t.bg, "--fg": t.fg, "--muted": t.dim,
    "--panel": mix(t.fg, t.bg, 6), "--border": mix(t.dim, t.bg, 55),
    "--accent": t.variable, "--echo": t.okFg, "--error": t.errorFg,
    "--label": t.label, "--variable": t.variable, "--cursor-accent": t.cursorAccent,
    "--assertion-bg": t.assertionBg, "--core-bg": t.coreBg, "--derived-bg": t.derivedBg,
    "--error-bg": t.errorBg, "--breakpoint": t.breakpoint, "--ok": t.okFg,
  };
}

let applied = [];
function clear() {
  for (const name of applied) document.documentElement.style.removeProperty(name);
  applied = [];
  delete document.documentElement.dataset.theme;
}

/** Applies `name` (or the system default for null) to the page. */
export function applyTheme(name) {
  clear();
  if (!THEMES[name]) return;
  for (const [prop, value] of Object.entries(properties(THEMES[name]))) {
    document.documentElement.style.setProperty(prop, value);
    applied.push(prop);
  }
  document.documentElement.dataset.theme = name;
}

export function storedTheme() {
  try {
    const name = localStorage.getItem(STORAGE_KEY);
    return THEMES[name] ? name : null;
  } catch {
    return null;
  }
}

/** Removes the theme from the page (on leaving enhanced mode). */
export const resetTheme = clear;

/**
 * Runs `:theme [<name>]`: returns the output lines, applying and
 * remembering a valid name. Without a theme chosen the page follows the
 * system's light/dark setting.
 */
export function themeCommand(args) {
  const name = args.trim();
  const current = storedTheme();
  const available = THEME_NAMES.join(", ");
  if (!name) {
    return [`Current theme: ${current ?? "system (light or dark, from the browser)"} (available: ${available}).`];
  }
  if (!THEMES[name]) return [`Error: no theme named '${name}' — available: ${available}.`];
  try { localStorage.setItem(STORAGE_KEY, name); } catch {}
  applyTheme(name);
  return [`Theme set to ${name}.`];
}
