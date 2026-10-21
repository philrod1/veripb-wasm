// Enhanced mode: browser-native panes over the REPL (repl-worker.js).
//
// Layout: Formula | Database | Proof on top; Output / Transcript / Preserved
// tabs and the command line below. Splitters resize the panes (remembered).
// Pane contents come from the worker's session state (web-repl
// src/state.rs), posted after every command.
//
// Implements the mode interface described in modes/plain.js.

import { OutputView, resolveCommand } from "./output-view.js";
import { applyTheme, resetTheme, storedTheme, themeCommand } from "./themes.js";
import { connectReplWorker } from "./repl-client.js";
import { splitter } from "./splitter.js";

const LAYOUT_KEY = "veripb-repl-enhanced-layout";
const TAB_KEY = "veripb-repl-enhanced-tab";
const DEFAULT_LAYOUT = { b1: 1 / 3, b2: 2 / 3, top: 0.58 };
const MIN_COLUMN = 0.1;
const MIN_ROW = 0.15;
const MODE_DEBUG = 3;

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

function loadLayout() {
  try {
    const stored = JSON.parse(localStorage.getItem(LAYOUT_KEY));
    if (stored && [stored.b1, stored.b2, stored.top].every(Number.isFinite)) return stored;
  } catch {}
  return { ...DEFAULT_LAYOUT };
}

/** Text with `@label` and variable tokens wrapped for styling (the TUI's rule). */
function tokens(text, variables) {
  const fragment = document.createDocumentFragment();
  for (const part of text.split(/(\s+)/)) {
    if (!part) continue;
    const bare = part.startsWith("~") ? part.slice(1) : part;
    if (part.startsWith("@")) fragment.append(el("span", { className: "tok-label", textContent: part }));
    else if (variables.has(bare)) fragment.append(el("span", { className: "tok-var", textContent: part }));
    else fragment.append(part);
  }
  return fragment;
}

const stripSemicolon = (text) => text.replace(/\s*;\s*$/, "");

function pane(name, title) {
  const titleText = el("span", { className: "pane-title-text", textContent: title });
  const head = el("header", { className: "pane-head" }, titleText);
  const body = el("div", { className: "pane-body" });
  const section = el("section", { className: `pane pane-${name}` }, head, body);
  return { section, head, body, setTitle: (text) => { titleText.textContent = text; } };
}

export function mount(root, host) {
  root.classList.add("enhanced");
  let state = null;
  let variables = new Set();
  let rendered = {};
  let activeTab = "output";
  try { activeTab = localStorage.getItem(TAB_KEY) || "output"; } catch {}

  const client = connectReplWorker(host, { what: "REPL", onState: (s) => update(s) });
  applyTheme(storedTheme());
  const view = new OutputView({
    // `:theme` recolours this page (the REPL itself answers "TUI only").
    onSubmit: (text) => {
      if (resolveCommand(text) === "theme") {
        view.append(themeCommand(text.trim().replace(/^:\S+/, "")));
        view.setMode(view.mode);
        return;
      }
      client.line(text);
    },
    onTranscript: (lines) => appendTranscript(lines),
  });
  client.attach(view);
  client.watch(true);

  // ---- Panes ----
  const formula = pane("formula", "Formula");
  const database = pane("database", "Database");
  const proof = pane("proof", "Proof");

  const filter = el("input", { className: "db-filter", type: "search", placeholder: "filter: id, @label, text" });
  filter.setAttribute("aria-label", "Filter database");
  const coreBox = el("input", { type: "checkbox", checked: true });
  const derivedBox = el("input", { type: "checkbox", checked: true });
  database.head.title = "Grey bar: core constraint; blue bar: derived";
  database.head.append(filter,
    el("label", { className: "db-kind", title: "Show core constraints" }, coreBox, "core"),
    el("label", { className: "db-kind", title: "Show derived constraints" }, derivedBox, "derived"));
  for (const control of [filter, coreBox, derivedBox]) control.addEventListener("input", () => renderDatabase(true));

  const top = el("div", { className: "enh-top" });
  const split1 = el("div");
  const split2 = el("div");
  top.append(formula.section, split1, database.section, split2, proof.section);

  // ---- Bottom: tabs ----
  const transcriptText = el("pre", { className: "transcript" });
  const copyButton = el("button", { type: "button", textContent: "Copy" });
  const downloadButton = el("button", { type: "button", textContent: "Download" });
  const transcriptPanel = el("div", { className: "tab-panel tab-transcript" },
    el("div", { className: "tab-tools" }, copyButton, downloadButton), transcriptText);
  const preservedPanel = el("div", { className: "tab-panel tab-preserved" });
  const outputPanel = el("div", { className: "tab-panel tab-output" }, view.out);
  const panels = { output: outputPanel, transcript: transcriptPanel, preserved: preservedPanel };
  const tabButtons = {};
  const tabBar = el("div", { className: "tabs", role: "tablist" });
  for (const [name, label] of [["output", "Output"], ["transcript", "Transcript"], ["preserved", "Preserved"]]) {
    const button = el("button", { type: "button", className: "tab", textContent: label });
    button.setAttribute("role", "tab");
    button.addEventListener("click", () => selectTab(name));
    tabButtons[name] = button;
    tabBar.append(button);
  }
  const bottom = el("div", { className: "enh-bottom" }, tabBar, ...Object.values(panels), view.form);
  const splitH = el("div");
  root.append(top, splitH, bottom);

  // ---- Layout ----
  let layout = loadLayout();
  function applyLayout() {
    const { b1, b2, top: t } = layout;
    top.style.gridTemplateColumns = `${b1}fr 6px ${b2 - b1}fr 6px ${1 - b2}fr`;
    root.style.gridTemplateRows = `${t}fr 6px ${1 - t}fr`;
  }
  function saveLayout() {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch {}
  }
  const reset = (keys) => () => {
    for (const key of keys) layout[key] = DEFAULT_LAYOUT[key];
    applyLayout();
    saveLayout();
  };
  splitter(split1, top, {
    axis: "x",
    onMove: (f) => { layout.b1 = Math.min(Math.max(f, MIN_COLUMN), layout.b2 - MIN_COLUMN); applyLayout(); saveLayout(); },
    onReset: reset(["b1", "b2"]),
  });
  splitter(split2, top, {
    axis: "x",
    onMove: (f) => { layout.b2 = Math.max(Math.min(f, 1 - MIN_COLUMN), layout.b1 + MIN_COLUMN); applyLayout(); saveLayout(); },
    onReset: reset(["b1", "b2"]),
  });
  splitter(splitH, root, {
    axis: "y",
    onMove: (f) => { layout.top = Math.min(Math.max(f, MIN_ROW), 1 - MIN_ROW); applyLayout(); saveLayout(); },
    onReset: reset(["top"]),
  });
  applyLayout();

  // ---- Tabs ----
  let transcriptDirty = true;
  function selectTab(name) {
    if (!panels[name]) name = "output";
    activeTab = name;
    try { localStorage.setItem(TAB_KEY, name); } catch {}
    for (const [key, panel] of Object.entries(panels)) {
      panel.hidden = key !== name;
      tabButtons[key].setAttribute("aria-selected", String(key === name));
    }
    if (name === "transcript" && transcriptDirty) {
      transcriptText.textContent = view.transcript.map((l) => l + "\n").join("");
      transcriptDirty = false;
    }
    if (name === "preserved") refreshPreserved();
    if (name === "output") outputPanel.querySelector(".plain-out")?.scrollTo(0, 1e9);
  }
  function appendTranscript(lines) {
    if (activeTab === "transcript" && !transcriptDirty) {
      transcriptText.append(lines.map((l) => l + "\n").join(""));
    } else {
      transcriptDirty = true;
    }
  }
  copyButton.addEventListener("click", () => navigator.clipboard?.writeText(view.transcript.join("\n") + "\n"));
  downloadButton.addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([view.transcript.join("\n") + "\n"], { type: "text/plain" }));
    el("a", { href: url, download: "transcript.txt" }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  async function refreshPreserved() {
    if (!state?.formula) {
      preservedPanel.replaceChildren(el("p", { className: "muted", textContent: "No formula loaded." }));
      return;
    }
    const set = await client.preserved();
    if (activeTab !== "preserved") return;
    if (!set) {
      preservedPanel.replaceChildren(el("p", { className: "muted", textContent: "No formula loaded." }));
    } else if (set.error) {
      preservedPanel.replaceChildren(el("p", { className: "error", textContent: set.error }));
    } else if (!set.declared) {
      preservedPanel.replaceChildren(el("p", { className: "muted", textContent: "The formula declares no preserved set." }));
    } else {
      const declared = new Set(set.declared);
      const current = new Set(set.current ?? []);
      const chips = (names, cls) => el("div", { className: "chips" }, ...names.map((n) => el("span", { className: `chip ${cls(n)}`, textContent: n })));
      const added = [...current].filter((n) => !declared.has(n));
      const removed = [...declared].filter((n) => !current.has(n));
      preservedPanel.replaceChildren(
        el("dl", {},
          el("dt", { textContent: `Current (${current.size})` }),
          el("dd", {}, chips([...current], (n) => (declared.has(n) ? "" : "added"))),
          el("dt", { textContent: `Declared (${declared.size})` }),
          el("dd", {}, chips([...declared], (n) => (current.has(n) ? "" : "removed"))),
          el("dt", { textContent: "Last change" }),
          el("dd", { textContent: set.lastChange == null ? "none (as declared)" : `proof line ${set.lastChange}` }),
          el("dt", { textContent: "Changes" }),
          el("dd", { textContent: added.length || removed.length
            ? [added.length && `added ${added.join(" ")}`, removed.length && `removed ${removed.join(" ")}`].filter(Boolean).join("; ")
            : "none" }),
        ));
    }
  }

  // ---- Rendering ----
  const placeholder = (text) => el("div", { className: "pane-empty", textContent: text });
  const changed = (key, value) => {
    const json = JSON.stringify(value);
    if (rendered[key] === json) return false;
    rendered[key] = json;
    return true;
  };

  function renderFormula() {
    const f = state?.formula ?? null;
    if (!changed("formula", [f, [...variables]])) return;
    if (!f) {
      formula.setTitle("Formula");
      formula.body.replaceChildren(placeholder("No formula loaded. Add files, then :instance <name> or :load <file.opb>."));
      return;
    }
    formula.setTitle(`Formula: ${f.name} (${f.count})`);
    const rows = f.lines.map(({ ids, text }) =>
      el("div", { className: "row" }, el("span", { className: "num", textContent: ids }), el("span", { className: "text" }, tokens(stripSemicolon(text), variables))));
    if (f.objective) rows.unshift(el("div", { className: "row meta" }, el("span", { className: "num", textContent: "obj" }), el("span", { className: "text", textContent: stripSemicolon(f.objective) })));
    if (f.preserved) rows.unshift(el("div", { className: "row meta" }, el("span", { className: "num", textContent: "pres" }), el("span", { className: "text", textContent: stripSemicolon(f.preserved) })));
    formula.body.replaceChildren(...rows);
  }

  function renderDatabase(force = false) {
    const db = state?.database ?? null;
    const highlight = state?.mode === MODE_DEBUG ? state.proof?.lastStepIds ?? [] : [];
    if (!changed("database", [db, highlight, [...variables]]) && !force) return;
    if (!db) {
      database.setTitle("Database");
      database.body.replaceChildren(placeholder("No formula loaded."));
      return;
    }
    if (db.error) {
      database.setTitle("Database");
      database.body.replaceChildren(el("div", { className: "row error", textContent: `Error: ${db.error}` }));
      return;
    }
    const query = filter.value.trim().toLowerCase();
    const shown = db.entries.filter((entry) => {
      if (entry.core ? !coreBox.checked : !derivedBox.checked) return false;
      if (!query) return true;
      return String(entry.id) === query
        || entry.labels.some((label) => label.toLowerCase().includes(query))
        || entry.text.toLowerCase().includes(query);
    });
    const lit = new Set(highlight);
    database.setTitle(shown.length === db.entries.length ? `Database (${db.entries.length})` : `Database (${shown.length} of ${db.entries.length})`);
    database.body.replaceChildren(...shown.map((entry) =>
      el("div", { className: `row ${entry.core ? "core" : "derived"}${lit.has(entry.id) ? " lit" : ""}`, title: entry.core ? "core" : "derived" },
        el("span", { className: "num", textContent: entry.id }),
        el("span", { className: "text" },
          ...entry.labels.map((label) => el("span", { className: "tok-label", textContent: label + " " })),
          tokens(entry.text, variables)))));
  }

  function renderProof() {
    const p = state?.proof ?? null;
    if (!changed("proof", [p, state?.mode, [...variables]])) return;
    if (!p) {
      proof.setTitle("Proof");
      proof.body.replaceChildren(placeholder("No formula loaded."));
      return;
    }
    proof.setTitle(`Proof (${p.lines.length})${p.unchecked ? ` (${p.unchecked} unchecked)` : ""}`);
    const rows = p.preamble.map((text, i) =>
      el("div", { className: "row preamble" }, el("span", { className: "gutter" }), el("span", { className: "status" }),
        el("span", { className: "num", textContent: i + 1 }), el("span", { className: "text", textContent: text })));
    const icon = { checked: "✓", unchecked: "○", rejected: "✗" };
    for (const line of p.lines) {
      const bp = el("button", {
        type: "button", className: `gutter${line.breakpoint ? " on" : ""}`, textContent: "●",
        title: line.breakpoint ? "Remove breakpoint" : "Set breakpoint",
      });
      bp.addEventListener("click", (event) => { event.stopPropagation(); client.toggleBreakpoint(line.index); });
      const explain = el("button", { type: "button", className: "row-action", textContent: "explain", title: `:explain ${line.n}` });
      explain.addEventListener("click", (event) => {
        event.stopPropagation();
        if (view.ready()) view.submit(`:explain ${line.n}`);
      });
      const row = el("div", {
        className: `row ${line.status}${line.n === p.debugLine ? " debug-current" : ""}${line.assertion ? " assertion" : ""}`,
        title: line.status === "rejected" ? p.rejected?.message ?? "rejected" : `click: :edit ${line.n}`,
      },
        bp,
        el("span", { className: "status", textContent: icon[line.status] }),
        el("span", { className: "num", textContent: line.n }),
        el("span", { className: "text" }, tokens(line.text, variables)),
        explain);
      row.addEventListener("click", () => { if (!getSelection().toString()) view.prefill(`:edit ${line.n}`); });
      rows.push(row);
    }
    proof.body.replaceChildren(...rows);
  }

  function update(next) {
    state = next;
    variables = new Set(state?.variables ?? []);
    renderFormula();
    renderDatabase();
    renderProof();
    if (activeTab === "preserved") refreshPreserved();
  }

  update(null);
  selectTab(activeTab);

  return {
    putFile: client.putFile,
    deleteFile: client.deleteFile,
    getFile: client.getFile,
    snapshot: client.snapshot,
    note: (text) => view.append(text, "note"),
    focus: () => view.focus(),
    unmount() {
      client.terminate();
      resetTheme();
      root.classList.remove("enhanced");
      root.style.gridTemplateRows = "";
    },
  };
}
