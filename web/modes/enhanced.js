// Enhanced mode: browser-native panes over the REPL (repl-worker.js).
//
// Layout: Formula | Database | Proof on top (each with a filter box);
// Output / Transcript / Preserved / Extras tabs and the command line below. Splitters resize the panes (remembered).
// Pane contents come from the worker's session state (web-repl
// src/state.rs), posted after every command.
//
// Implements the mode interface described in modes/plain.js.

import { OutputView, resolveCommand, setCommands } from "./output-view.js";
import { applyStoredOrSystem, resetTheme, setPalettes, storedTheme, themeCommand, themeNames } from "./themes.js";
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
  // Palettes and the command list come from the REPL.
  const colorScheme = matchMedia("(prefers-color-scheme: dark)");
  const followSystem = () => { if (!themeNames().includes(storedTheme())) applyStoredOrSystem(); };
  client.themes().then((data) => { setPalettes(data); applyStoredOrSystem(); });
  colorScheme.addEventListener("change", followSystem);
  client.commands().then((commands) => setCommands(commands.map((c) => c.name)));
  const view = new OutputView({
    complete: (text) => client.complete(text),
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
  // The TUI's debug-mode keys: Shift+↓ `:step`, Shift+↑ `:back`, Esc `:done`.
  // Caught on the form, ahead of history and the suggestion strip; the
  // typed text stays.
  view.form.addEventListener("keydown", (event) => {
    if (view.mode !== MODE_DEBUG || view.input.disabled || event.target !== view.input) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const command = event.key === "Escape" ? ":done"
      : event.shiftKey && event.key === "ArrowDown" ? ":step"
      : event.shiftKey && event.key === "ArrowUp" ? ":back"
      : null;
    if (!command) return;
    event.preventDefault();
    event.stopPropagation();
    const typed = view.input.value;
    view.submit(command);
    view.input.value = typed;
  }, { capture: true });

  // ---- Panes ----
  const formula = pane("formula", "Formula");
  const database = pane("database", "Database");
  const proof = pane("proof", "Proof");

  // Filter boxes: a number matches that id (formula, database) or line
  // (proof); anything else is a case-insensitive substring of the text.
  const filterBox = (target, className, placeholder, label, render) => {
    const input = el("input", { className: `pane-filter ${className}`, type: "search", placeholder });
    input.setAttribute("aria-label", label);
    input.addEventListener("input", () => render(true));
    target.head.append(input);
    return input;
  };
  const formulaFilter = filterBox(formula, "formula-filter", "filter: id, @label, text", "Filter formula", (f) => renderFormula(f));
  const proofFilter = filterBox(proof, "proof-filter", "filter: line, @label, text", "Filter proof", (f) => renderProof(f));
  const filter = filterBox(database, "db-filter", "filter: id, @label, text", "Filter database", (f) => renderDatabase(f));
  const coreBox = el("input", { type: "checkbox", checked: true });
  const derivedBox = el("input", { type: "checkbox", checked: true });
  database.head.title = "Grey bar: core constraint; blue bar: derived";
  database.head.append(
    el("label", { className: "db-kind", title: "Show core constraints" }, coreBox, "core"),
    el("label", { className: "db-kind", title: "Show derived constraints" }, derivedBox, "derived"));
  for (const control of [coreBox, derivedBox]) control.addEventListener("input", () => renderDatabase(true));

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
  const extrasPanel = el("div", { className: "tab-panel tab-extras" });
  const outputPanel = el("div", { className: "tab-panel tab-output" }, view.out);
  const panels = { output: outputPanel, transcript: transcriptPanel, preserved: preservedPanel, extras: extrasPanel };
  const tabButtons = {};
  const tabBar = el("div", { className: "tabs", role: "tablist" });
  for (const [name, label] of [["output", "Output"], ["transcript", "Transcript"], ["preserved", "Preserved"], ["extras", "Extras"]]) {
    const button = el("button", { type: "button", className: "tab", textContent: label });
    button.setAttribute("role", "tab");
    button.addEventListener("click", () => selectTab(name));
    tabButtons[name] = button;
    tabBar.append(button);
  }
  const bottom = el("div", { className: "enh-bottom" }, tabBar, ...Object.values(panels), view.commandLine);
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
    if (name === "extras") refreshExtras();
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

  // Preserved and Extras tabs run veripb, so each is recomputed only while
  // open and when the formula or proof has changed since its last view.
  const sessionKey = () => JSON.stringify([state.formula, state.proof?.lines.map((l) => [l.text, l.status]), state.proof?.checked]);
  const noFormula = () => el("p", { className: "muted", textContent: "No formula loaded." });

  let preservedFor = null;
  async function refreshPreserved() {
    if (!state?.formula) {
      preservedFor = null;
      preservedPanel.replaceChildren(noFormula());
      return;
    }
    const key = sessionKey();
    if (key === preservedFor) return;
    preservedFor = key;
    const set = await client.preserved();
    if (activeTab !== "preserved" || preservedFor !== key || !set) return;
    preservedPanel.replaceChildren(preservedSection(set));
  }

  // Extras: status (`:check`'s verdict), objective (`:objective`'s report
  // and bounds), and counts.
  let extrasFor = null;
  async function refreshExtras() {
    if (!state?.formula) {
      extrasFor = null;
      extrasPanel.replaceChildren(noFormula());
      return;
    }
    const key = sessionKey();
    if (key === extrasFor) {
      renderSummary();
      return;
    }
    extrasFor = key;
    const extras = await client.extras();
    if (activeTab !== "extras" || extrasFor !== key || !extras) return;
    extrasPanel.replaceChildren(statusSection(extras.conclusion), objectiveSection(extras.objective),
      el("section", { className: "extra extra-summary" }));
    renderSummary();
  }

  const section = (title, ...body) => el("section", { className: "extra" }, el("h3", { textContent: title }), ...body);
  const facts = (...pairs) => el("dl", {}, ...pairs.flatMap(([term, value]) =>
    [el("dt", { textContent: term }), value instanceof Node ? el("dd", {}, value) : el("dd", { textContent: value })]));

  function statusSection(conclusion) {
    if (conclusion.error) return section("Status", el("p", { className: "error", textContent: conclusion.error }));
    const verified = conclusion.status?.startsWith("s VERIFIED");
    const p = state.proof;
    const progress = `${p.checked} of ${p.lines.length} line${p.lines.length === 1 ? "" : "s"} checked`
      + (p.unchecked ? `, ${p.unchecked} unchecked` : "");
    return section("Status",
      el("p", { className: `verdict ${verified ? "ok" : "muted"}`, textContent: conclusion.status ?? "" }),
      facts(
        ["Proof", progress],
        ...(p.rejected ? [["Rejected", `line ${p.rejected.n}: ${p.rejected.message}`]] : []),
        ...(conclusion.version ? [["veripb", conclusion.version]] : []),
      ));
  }

  function objectiveSection(objective) {
    const body = el("pre", { className: "report", textContent: objective.lines.join("\n") });
    return section("Objective", body, ...(objective.error ? [el("p", { className: "error", textContent: objective.error })] : []));
  }

  function preservedSection(set) {
    if (set.error) return section("Preserved set", el("p", { className: "error", textContent: set.error }));
    if (!set.declared) return section("Preserved set", el("p", { className: "muted", textContent: "The formula declares no preserved set." }));
    const declared = new Set(set.declared);
    const current = new Set(set.current ?? []);
    const chips = (names, cls) => el("div", { className: "chips" }, ...names.map((n) => el("span", { className: `chip ${cls(n)}`, textContent: n })));
    const added = [...current].filter((n) => !declared.has(n));
    const removed = [...declared].filter((n) => !current.has(n));
    return section("Preserved set", facts(
      [`Current (${current.size})`, chips([...current], (n) => (declared.has(n) ? "" : "added"))],
      [`Declared (${declared.size})`, chips([...declared], (n) => (current.has(n) ? "" : "removed"))],
      ["Last change", set.lastChange == null ? "none (as declared)" : `proof line ${set.lastChange}`],
      ["Changes", added.length || removed.length
        ? [added.length && `added ${added.join(" ")}`, removed.length && `removed ${removed.join(" ")}`].filter(Boolean).join("; ")
        : "none"],
    ));
  }

  // Counts from the session state; no veripb run.
  function renderSummary() {
    const target = extrasPanel.querySelector(".extra-summary");
    if (!target || !state?.formula) return;
    const entries = state.database?.entries ?? [];
    const core = entries.filter((e) => e.core).length;
    const labels = new Set(entries.flatMap((e) => e.labels)).size;
    const breakpoints = state.proof.lines.filter((l) => l.breakpoint).length;
    const modes = ["pbp (normal)", "edit", "opb (formula edit)", "debug"];
    target.replaceChildren(el("h3", { textContent: "Summary" }), facts(
      ["Formula", `${state.formula.count} constraint${state.formula.count === 1 ? "" : "s"}, ${state.variables.length} variable${state.variables.length === 1 ? "" : "s"}`],
      ["Database", state.database?.error ? state.database.error : `${entries.length} (${core} core, ${entries.length - core} derived)`],
      ["Labels", String(labels)],
      ["Breakpoints", breakpoints ? state.proof.lines.filter((l) => l.breakpoint).map((l) => l.n).join(", ") : "none"],
      ["Prompt", modes[state.mode] ?? String(state.mode)],
    ));
  }

  // ---- Explain modal: `:explain <n>`'s output, without touching Output ----
  const explainTitle = el("h2");
  const explainLine = el("pre", { className: "explain-line" });
  const explainBody = el("pre", { className: "explain-body" });
  const explainCopy = el("button", { type: "button", textContent: "Copy" });
  const explainClose = el("button", { type: "button", textContent: "Close", autofocus: true });
  const explainDialog = el("dialog", { className: "explain-modal" },
    el("header", {}, explainTitle, el("div", { className: "explain-tools" }, explainCopy, explainClose)),
    explainLine, explainBody);
  root.append(explainDialog);
  let explainSeq = 0;
  explainClose.addEventListener("click", () => explainDialog.close());
  explainDialog.addEventListener("click", (event) => { if (event.target === explainDialog) explainDialog.close(); });
  explainDialog.addEventListener("close", () => view.focus());
  explainCopy.addEventListener("click", () => navigator.clipboard?.writeText(explainBody.textContent));

  async function openExplain(line) {
    const mine = ++explainSeq;
    explainTitle.textContent = `Line ${line.n}`;
    explainLine.replaceChildren(tokens(line.text, variables));
    explainBody.replaceChildren(el("span", { className: "muted", textContent: "Explaining…" }));
    if (!explainDialog.open) explainDialog.showModal();
    const result = await client.explain(line.n);
    if (mine !== explainSeq) return;
    const lines = result?.lines ?? ["No formula loaded."];
    explainBody.replaceChildren(...lines.map((text) =>
      el("span", { className: /^(Error|.*still fails)/.test(text) ? "error" : "", textContent: text + "\n" })));
  }

  // ---- Rendering ----
  const placeholder = (text) => el("div", { className: "pane-empty", textContent: text });
  const changed = (key, value) => {
    const json = JSON.stringify(value);
    if (rendered[key] === json) return false;
    rendered[key] = json;
    return true;
  };

  // Whether a row matches a filter `query` (lower-cased): a number matches
  // the row's id or line (`ids` may be a range "1-2"); other text matches
  // a case-insensitive substring of the row's text.
  const matchesQuery = (query, ids, text) => {
    if (!query) return true;
    if (/^\d+$/.test(query)) {
      const [lo, hi = lo] = String(ids).split("-").map(Number);
      return Number(query) >= lo && Number(query) <= hi;
    }
    return text.toLowerCase().includes(query);
  };

  function renderFormula(force = false) {
    const f = state?.formula ?? null;
    const query = formulaFilter.value.trim().toLowerCase();
    if (!changed("formula", [f, [...variables], query]) && !force) return;
    if (!f) {
      formula.setTitle("Formula");
      formula.body.replaceChildren(placeholder("No formula loaded. Add files, then :instance <name> or :load <file.opb>."));
      return;
    }
    const shown = f.lines.filter(({ ids, text }) => matchesQuery(query, ids, text));
    formula.setTitle(shown.length === f.lines.length ? `Formula: ${f.name} (${f.count})` : `Formula: ${f.name} (${shown.length} of ${f.lines.length} lines)`);
    const rows = shown.map(({ ids, text }) =>
      el("div", { className: "row" }, el("span", { className: "num", textContent: ids }), el("span", { className: "text" }, tokens(stripSemicolon(text), variables))));
    if (f.objective && !query) rows.unshift(el("div", { className: "row meta" }, el("span", { className: "num", textContent: "obj" }), el("span", { className: "text", textContent: stripSemicolon(f.objective) })));
    if (f.preserved && !query) rows.unshift(el("div", { className: "row meta" }, el("span", { className: "num", textContent: "pres" }), el("span", { className: "text", textContent: stripSemicolon(f.preserved) })));
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
      return matchesQuery(query, entry.id, [...entry.labels, entry.text].join(" "));
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

  function renderProof(force = false) {
    const p = state?.proof ?? null;
    const query = proofFilter.value.trim().toLowerCase();
    if (!changed("proof", [p, state?.mode, [...variables], query]) && !force) return;
    if (!p) {
      proof.setTitle("Proof");
      proof.body.replaceChildren(placeholder("No formula loaded."));
      return;
    }
    const shown = p.lines.filter((line) => matchesQuery(query, line.n, line.text));
    const count = shown.length === p.lines.length ? `${p.lines.length}` : `${shown.length} of ${p.lines.length}`;
    proof.setTitle(`Proof (${count})${p.unchecked ? ` (${p.unchecked} unchecked)` : ""}`);
    const rows = (query ? [] : p.preamble).map((text, i) =>
      el("div", { className: "row preamble" }, el("span", { className: "gutter" }), el("span", { className: "status" }),
        el("span", { className: "num", textContent: i + 1 }), el("span", { className: "text", textContent: text })));
    const icon = { checked: "✓", unchecked: "○", rejected: "✗" };
    for (const line of shown) {
      const bp = el("button", {
        type: "button", className: `gutter${line.breakpoint ? " on" : ""}`, textContent: "●",
        title: line.breakpoint ? "Remove breakpoint" : "Set breakpoint",
      });
      bp.addEventListener("click", (event) => { event.stopPropagation(); client.toggleBreakpoint(line.index); });
      const explain = el("button", { type: "button", className: "row-action", textContent: "explain", title: `Explain line ${line.n}` });
      explain.addEventListener("click", (event) => {
        event.stopPropagation();
        openExplain(line);
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
    if (activeTab === "extras") refreshExtras();
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
      colorScheme.removeEventListener("change", followSystem);
      resetTheme();
      root.classList.remove("enhanced");
      root.style.gridTemplateRows = "";
    },
  };
}
