// veripb-repl's TUI palettes as CSS custom properties for enhanced mode.
// The palettes come from the REPL itself (`vr_themes`, i.e.
// `tui::theme::ThemeName::ALL`); `setPalettes` must run before the others.
// `:theme` messages follow the TUI's.

const STORAGE_KEY = "veripb-repl-theme";
let palettes = new Map();

/** Installs the REPL's palettes: `{themes: [{name, colors}]}`. */
export function setPalettes(data) {
  palettes = new Map((data?.themes ?? []).map(({ name, colors }) => [name, colors]));
}

export const themeNames = () => [...palettes.keys()];

/** Page custom properties for a palette (style.css uses these names). */
function properties(t) {
  const mix = (a, b, pct) => `color-mix(in srgb, ${a} ${pct}%, ${b})`;
  return {
    "--bg": t.bg, "--fg": t.fg, "--muted": t.dim,
    "--panel": mix(t.fg, t.bg, 6), "--border": mix(t.dim, t.bg, 55),
    "--accent": t.variable, "--echo": t.okFg, "--error": t.errorFg,
    "--label": t.label, "--variable": t.variable, "--cursor-accent": t.cursorAccent,
    "--cursor-bg": t.cursorBg, "--assertion-bg": t.assertionBg, "--core-bg": t.coreBg,
    "--derived-bg": t.derivedBg, "--error-bg": t.errorBg, "--breakpoint": t.breakpoint, "--ok": t.okFg,
  };
}

let applied = [];
function clear() {
  for (const name of applied) document.documentElement.style.removeProperty(name);
  applied = [];
  delete document.documentElement.dataset.theme;
}

/** Applies palette `name` to the page; any other value means the system default. */
export function applyTheme(name) {
  clear();
  const colors = palettes.get(name);
  if (!colors) return;
  for (const [prop, value] of Object.entries(properties(colors))) {
    document.documentElement.style.setProperty(prop, value);
    applied.push(prop);
  }
  document.documentElement.dataset.theme = name;
}

export function storedTheme() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Applies the remembered theme, or else the REPL's "dark" or "light"
 * palette following the browser's colour scheme.
 */
export function applyStoredOrSystem() {
  const stored = storedTheme();
  if (palettes.has(stored)) applyTheme(stored);
  else applyTheme(matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
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
  const current = palettes.has(storedTheme()) ? storedTheme() : null;
  const available = themeNames().join(", ");
  if (!name) {
    return [`Current theme: ${current ?? "system (light or dark, from the browser)"} (available: ${available}).`];
  }
  if (!palettes.has(name)) return [`Error: no theme named '${name}' — available: ${available}.`];
  try { localStorage.setItem(STORAGE_KEY, name); } catch {}
  applyTheme(name);
  return [`Theme set to ${name}.`];
}
