// Enhanced mode: browser-native panes over the REPL (repl-worker.js).
//
// Layout: Formula | Database | Proof on top (each with a filter box);
// Output / Transcript / Preserved / Extras tabs and the command line below. Splitters resize the panes (remembered).
// After every command the worker posts a session summary (web-repl
// src/state.rs: counts, mode, breakpoints, ...); each pane is a virtual list
// (modes/vlist.js) that fetches only the rows on screen, filtered in the REPL
// (src/views.rs), so a proof of any size costs the page only what it shows.
//
// Implements the mode interface described in modes/plain.js.

import { OutputView, PROMPTS, resolveCommand, setCommands } from "./output-view.js";
import { applyStoredOrSystem, resetTheme, setPalettes, storedTheme, themeCommand, themeNames } from "./themes.js";
import { connectReplWorker } from "./repl-client.js";
import { splitter } from "./splitter.js";
import { constraintRefs } from "./refs.js";
import { createLinks } from "./links.js";
import { createVim } from "./vim.js";
import { createVirtualList } from "./vlist.js";
import { createLineList } from "./linelist.js";

const LAYOUT_KEY = "veripb-repl-enhanced-layout";
const EXPLAIN_VIEW_KEY = "veripb-repl-enhanced-explain-view";
const GLOSSARY_KEY = "veripb-repl-enhanced-glossary-entry";
const LINKS_KEY = "veripb-repl-enhanced-links";
// Gutter between the top panes: a splitter, or a channel for the links.
const GAP = "6px";
const LINK_GAP = "56px";
const TAB_KEY = "veripb-repl-enhanced-tab";
const DEFAULT_LAYOUT = { b1: 1 / 3, b2: 2 / 3, top: 0.58 };
const MIN_COLUMN = 0.1;
const MIN_ROW = 0.15;
const MODE_PBP = 0;
const MODE_EDIT = 1;
const MODE_FORMULA = 2;
const MODE_DEBUG = 3;
// Zoomed sizes of the squeezed area: a header plus about three rows (top),
// or the tab bar, about three output rows and the command line (bottom).
const TOP_FLOOR = "6.5rem";
// The TUI's [▭] and [⛶], drawn so they render without either glyph in the font.
const ZOOM_ICONS = {
  wide: '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><rect x="1" y="3.5" width="10" height="5" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
  full: '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M1 4V1h3M8 1h3v3M11 8v3H8M4 11H1V8" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
};
const BOTTOM_FLOOR = "9rem";

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

/** A span that refers to a constraint: `ref` is constraintRefs()'s `{kind, value}`. */
function refSpan(text, ref) {
  const span = el("span", { className: `ref ${ref.kind === "label" ? "tok-label" : "tok-id"}`, textContent: text });
  span.dataset.refKind = ref.kind;
  span.dataset.ref = String(ref.value);
  return span;
}

/**
 * Text with `@label` and variable tokens wrapped for styling (the TUI's rule).
 * With `refs`, labels and constraint IDs (modes/refs.js) are hoverable refs.
 */
function tokens(text, variables, { refs = false } = {}) {
  const fragment = document.createDocumentFragment();
  const found = refs ? constraintRefs(text.split(/\s+/).filter(Boolean)) : new Map();
  let word = -1;
  for (const part of text.split(/(\s+)/)) {
    if (!part) continue;
    if (/^\s+$/.test(part)) { fragment.append(part); continue; }
    word += 1;
    const ref = found.get(word);
    const [, core, semis] = part.match(/^(.*?)(;*)$/);
    const bare = part.startsWith("~") ? part.slice(1) : part;
    if (ref) fragment.append(refSpan(core, ref), semis);
    else if (part.startsWith("@")) fragment.append(el("span", { className: "tok-label", textContent: part }));
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

  // While the worker computes the session summary that follows a command or
  // an edit (which may replay the proof to rebuild the database), the top
  // panes are out of date: say so, with veripb's progress, after 300 ms.
  const updating = (() => {
    const element = el("div", { className: "enh-updating", hidden: true });
    element.setAttribute("aria-live", "polite");
    let started = null;
    let line = null;
    let timer = null;
    const render = () => {
      const seconds = (performance.now() - started) / 1000;
      if (seconds < 0.3) return;
      const total = state?.proof ? state.proof.lines + 2 : null;
      const where = line ? ` · line ${line.toLocaleString()}${total ? ` of ${total.toLocaleString()} (${Math.min(100, Math.floor((100 * line) / total))}%)` : ""}` : "";
      element.textContent = `Updating the ${databasePending ? "Database pane" : "panes"} · ${seconds.toFixed(0)} s${where}`;
      element.hidden = false;
      element.parentElement?.classList.add("stale");
      element.parentElement?.classList.toggle("database-only", databasePending);
    };
    return {
      element,
      start() {
        if (started != null) return;
        started = performance.now();
        line = null;
        timer = setInterval(render, 200);
      },
      progress(progress) {
        if (started != null) line = progress.line ?? line;
      },
      done() {
        clearInterval(timer);
        started = null;
        element.hidden = true;
        element.parentElement?.classList.remove("stale");
      },
    };
  })();
  // While :verify runs, the proof lines its veripb run has certainly
  // accepted (host.js's `settled`) show as checked at once, provisionally,
  // until the session summary after the command gives the real statuses.
  // Only the command's first run counts: later runs (the database rebuild,
  // probes) are not checking the proof's unchecked lines.
  const live = { verifying: false, run: null, settled: 0 };
  let databasePending = false;
  const client = connectReplWorker(host, {
    what: "REPL",
    // A summary with `database: {pending}` comes first: the panes but the
    // Database take it at once; the full one follows.
    onState: (s) => {
      live.settled = 0;
      if (s?.database?.pending) {
        databasePending = true;
        update({ ...s, database: state?.database ?? null });
        return;
      }
      databasePending = false;
      updating.done();
      update(s);
    },
    onUpdating: () => {
      live.verifying = false;
      updating.start();
    },
    onProgress: (progress) => {
      updating.progress(progress);
      if (!live.verifying) return;
      live.run ??= progress.run;
      if (progress.run === live.run && progress.settled > live.settled) {
        live.settled = progress.settled;
        proofList.redraw();
        proofTitle();
      }
    },
  });
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
      const command = resolveCommand(text);
      const args = text.trim().replace(/^:\S+\s*/, "");
      if (command === "theme") {
        view.append(themeCommand(text.trim().replace(/^:\S+/, "")));
        view.setMode(view.mode);
        return;
      }
      // As in the TUI, `:edit` and `:insert` open the Vim-style editor.
      if (command === "verify" && view.mode === MODE_PBP) Object.assign(live, { verifying: true, run: null, settled: 0 });
      if (view.mode === MODE_PBP && (command === "edit" || command === "insert")) {
        view.setMode(view.mode);
        if (!state?.proof) return view.append("No formula loaded — use :load <formula.opb> first.");
        if (command === "edit") vim.startEdit(args);
        else vim.startInsert(args);
        return;
      }
      client.line(text);
    },
    onTranscript: () => appendTranscript(),
    // "line n of m" while a command runs: the proof's last line number.
    progressTotal: () => (state?.proof ? state.proof.lines + 2 : null),
    // Entering edit mode, the REPL prints `Line <n>: <text>` for the line to
    // retype: start the input with that text, to change in place.
    onMode: (mode) => {
      if (mode !== MODE_EDIT || view.input.value) return;
      for (let i = view.transcript.length - 1; i >= 0; i--) {
        const line = view.transcript[i];
        if (Object.values(PROMPTS).some((prompt) => line.startsWith(prompt))) break;
        const retype = line.match(/^Line \d+: (.*)$/);
        if (retype) return view.prefill(retype[1]);
      }
    },
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
  proof.body.tabIndex = -1;
  // Vim-style editing of the Proof pane (modes/vim.js).
  const vim = createVim({
    edit: (edit) => client.edit(edit),
    toggleBreakpoint: (index) => client.toggleBreakpoint(index),
    note: (text) => view.append(text),
    render: () => renderProof(true),
    toPrompt: (text) => view.prefill(text),
    onFocus: () => {
      if (zoom && zoom.pane !== "proof") {
        zoom = { pane: "proof", level: zoom.level };
        applyLayout();
      }
      proof.body.focus({ preventScroll: true });
    },
  });
  proof.body.addEventListener("keydown", (event) => {
    if (!vim.active || vim.mode !== "normal" || event.target !== proof.body) return;
    if (vim.key(event)) {
      event.preventDefault();
      event.stopPropagation();
    }
  });

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

  const top = el("div", { className: "enh-top" }, updating.element);
  const split1 = el("div");
  const split2 = el("div");
  top.append(formula.section, split1, database.section, split2, proof.section);

  // ---- Bottom: tabs ----
  // The transcript: every line of the session, as a virtual list (only the
  // lines on screen are in the DOM), with a filter in place of the browser's
  // find, which cannot see the rest.
  const transcriptText = el("div", { className: "transcript" });
  const copyButton = el("button", { type: "button", textContent: "Copy" });
  const downloadButton = el("button", { type: "button", textContent: "Download" });
  const transcriptFilter = el("input", { type: "search", className: "transcript-filter", placeholder: "filter the transcript" });
  transcriptFilter.setAttribute("aria-label", "Filter the transcript");
  const transcriptPanel = el("div", { className: "tab-panel tab-transcript" },
    el("div", { className: "tab-tools" }, copyButton, downloadButton, transcriptFilter), transcriptText);
  const preservedPanel = el("div", { className: "tab-panel tab-preserved" });
  const extrasPanel = el("div", { className: "tab-panel tab-extras" });
  const outputPanel = el("div", { className: "tab-panel tab-output" }, view.out);
  const glossaryPanel = el("div", { className: "tab-panel tab-glossary" });
  const panels = { output: outputPanel, transcript: transcriptPanel, preserved: preservedPanel, extras: extrasPanel, glossary: glossaryPanel };
  const tabButtons = {};
  const tabBar = el("div", { className: "tabs", role: "tablist" });
  for (const [name, label] of [["output", "Output"], ["transcript", "Transcript"], ["preserved", "Preserved"], ["extras", "Extras"], ["glossary", "Glossary"]]) {
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
  // Zoom, as in the TUI: `{ pane, level }` or null; see zoomButtons below.
  let zoom = null;
  const topPanes = { formula, database, proof };
  function applyLayout() {
    const { b1, b2, top: t } = layout;
    const solo = zoom && zoom.pane !== "output" ? zoom.pane : null;
    for (const [name, p] of Object.entries(topPanes)) p.section.hidden = !!solo && name !== solo;
    split1.hidden = split2.hidden = !!solo;
    const gap = links ? LINK_GAP : GAP;
    top.classList.toggle("linked", !!links);
    top.style.gridTemplateColumns = solo ? "minmax(0, 1fr)" : `${b1}fr ${gap} ${b2 - b1}fr ${gap} ${1 - b2}fr`;
    const outputFull = zoom?.pane === "output" && zoom.level === "full";
    top.hidden = splitH.hidden = outputFull;
    root.style.gridTemplateRows =
      outputFull ? "minmax(0, 1fr)"
      : zoom?.pane === "output" ? `${TOP_FLOOR} 6px minmax(0, 1fr)`
      : solo && zoom.level === "full" ? `minmax(0, 1fr) 6px ${BOTTOM_FLOOR}`
      : `${t}fr 6px ${1 - t}fr`;
    for (const [name, buttons] of Object.entries(zoomButtons)) {
      for (const [level, button] of Object.entries(buttons)) {
        button.setAttribute("aria-pressed", String(zoom?.pane === name && zoom.level === level));
      }
    }
  }
  function toggleZoom(pane, level) {
    zoom = zoom?.pane === pane && zoom.level === level ? null : { pane, level };
    applyLayout();
  }
  // Header buttons: ▭ (wide) then ⛶ (full), as in the TUI. A top pane's
  // wide takes the whole top row; full also shrinks the bottom area to a
  // floor. The bottom area's wide squeezes the top panes to a floor; full
  // hides them. Clicking the pressed button, or Esc, restores the layout.
  const ZOOM_TITLES = {
    top: { wide: "Take the whole top row", full: "Maximise" },
    output: { wide: "Squeeze the panes above", full: "Maximise (hide the panes above)" },
  };
  const zoomButtons = {};
  for (const [name, target] of [...Object.entries(topPanes).map(([n, p]) => [n, p.head]), ["output", tabBar]]) {
    const titles = ZOOM_TITLES[name === "output" ? "output" : "top"];
    const group = el("span", { className: "zoom-buttons" });
    zoomButtons[name] = {};
    for (const level of ["wide", "full"]) {
      const button = el("button", { type: "button", className: `zoom zoom-${level}`, innerHTML: ZOOM_ICONS[level], title: titles[level] });
      button.setAttribute("aria-label", `${name}: ${titles[level]}`);
      button.addEventListener("click", () => toggleZoom(name, level));
      zoomButtons[name][level] = button;
      group.append(button);
    }
    target.append(group);
  }
  // Links: curves from formula and proof lines to the Database rows they
  // created (modes/links.js), with the line IDs from vr_line_ids.
  // Off, the hovered row's curves only, or every curve.
  let links = null;
  const linksBox = el("select", {},
    el("option", { value: "off", textContent: "off" }),
    el("option", { value: "hover", textContent: "hovered row" }),
    el("option", { value: "all", textContent: "all" }));
  const linksToggle = el("label", { className: "links-toggle", title: "Curves from each formula and proof line to the Database rows it created" }, "Links", linksBox);
  tabBar.insertBefore(linksToggle, zoomButtons.output.wide.parentNode);
  // Links need the IDs of the proof lines on screen only.
  let lineIdsFor = null;
  const refreshLineIds = () => {
    if (!links || !state?.proof) return;
    const ns = [...proof.body.querySelectorAll(".row[data-n]")].map((row) => Number(row.dataset.n));
    if (!ns.length) return links.setLineIds({});
    const range = [Math.min(...ns), Math.max(...ns)];
    const key = JSON.stringify([state.generation, range]);
    if (key === lineIdsFor) return;
    lineIdsFor = key;
    client.lineIds(...range).then((map) => { if (lineIdsFor === key) links?.setLineIds(map); });
  };
  function setLinks(mode) {
    if (!["off", "hover", "all"].includes(mode)) mode = "off";
    linksBox.value = mode;
    try { localStorage.setItem(LINKS_KEY, mode); } catch {}
    if (mode !== "off" && !links) {
      links = createLinks({ top, formula, database, proof });
      refreshLineIds();
    } else if (mode === "off" && links) {
      links.destroy();
      links = null;
    }
    links?.setHoverOnly(mode === "hover");
    applyLayout();
  }
  linksBox.addEventListener("change", () => setLinks(linksBox.value));
  // Esc restores the layout when nothing else claims it (a dialog, debug
  // mode, the suggestion strip, another input).
  const escapeZoom = (event) => {
    if (event.key !== "Escape" || !zoom || event.defaultPrevented || document.querySelector("dialog[open]")) return;
    if (event.target instanceof HTMLInputElement && event.target !== view.input) return;
    zoom = null;
    applyLayout();
  };
  document.addEventListener("keydown", escapeZoom);
  // A pane being edited is brought into view (the TUI retargets its zoom).
  let lastMode = null;
  function followMode(mode) {
    if (mode === lastMode) return;
    lastMode = mode;
    const pane = mode === MODE_EDIT ? "proof" : mode === MODE_FORMULA ? "formula" : null;
    if (pane && zoom && zoom.pane !== pane) {
      zoom = { pane, level: zoom.level };
      applyLayout();
    }
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
    onMove: (f) => {
      if (zoom && (zoom.pane === "output" || zoom.level === "full")) zoom = null;
      layout.top = Math.min(Math.max(f, MIN_ROW), 1 - MIN_ROW);
      applyLayout();
      saveLayout();
    },
    onReset: reset(["top"]),
  });
  applyLayout();

  // ---- Tabs ----
  let transcriptList = null;
  function selectTab(name) {
    if (!panels[name]) name = "output";
    activeTab = name;
    try { localStorage.setItem(TAB_KEY, name); } catch {}
    for (const [key, panel] of Object.entries(panels)) {
      panel.hidden = key !== name;
      tabButtons[key].setAttribute("aria-selected", String(key === name));
    }
    if (name === "transcript") {
      transcriptList ??= createLineList(transcriptText, view.transcript);
      transcriptList.update();
    }
    if (name === "preserved") refreshPreserved();
    if (name === "extras") refreshExtras();
    if (name === "glossary") showGlossary();
    if (name === "output") outputPanel.querySelector(".plain-out")?.scrollTo(0, 1e9);
  }
  // New lines are already in view.transcript; follow them if at the bottom.
  function appendTranscript() {
    if (activeTab !== "transcript" || !transcriptList) return;
    const follow = transcriptList.atBottom();
    transcriptList.update();
    if (follow) transcriptList.toBottom();
  }
  transcriptFilter.addEventListener("input", () => transcriptList?.setFilter(transcriptFilter.value));
  copyButton.addEventListener("click", () => navigator.clipboard?.writeText(view.transcript.join("\n") + "\n"));
  downloadButton.addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([view.transcript.join("\n") + "\n"], { type: "text/plain" }));
    el("a", { href: url, download: "transcript.txt" }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  // Preserved and Extras tabs run veripb, so each is recomputed only while
  // open and when the formula or proof has changed since its last view.
  const sessionKey = () => JSON.stringify([state.generation, state.proof?.checked]);
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
    const progress = `${p.checked} of ${p.lines} line${p.lines === 1 ? "" : "s"} checked`
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
    const db = state.database ?? {};
    const breakpoints = state.proof.breakpoints;
    const modes = ["pbp (normal)", "edit", "opb (formula edit)", "debug"];
    target.replaceChildren(el("h3", { textContent: "Summary" }), facts(
      ["Formula", `${state.formula.count} constraint${state.formula.count === 1 ? "" : "s"}, ${state.variables.length} variable${state.variables.length === 1 ? "" : "s"}`],
      ["Database", db.error ? db.error : `${db.count} (${db.core} core, ${db.count - db.core} derived)`],
      ["Labels", String(db.labels ?? 0)],
      ["Breakpoints", breakpoints.length ? breakpoints.join(", ") : "none"],
      ["Prompt", modes[state.mode] ?? String(state.mode)],
    ));
  }

  // ---- Explain modal: `:explain <n>`'s output, without touching Output ----
  const explainTitle = el("h2");
  const explainLine = el("pre", { className: "explain-line" });
  const explainBody = el("pre", { className: "explain-body" });
  const plainBody = el("div", { className: "explain-plain" });
  const viewButtons = {
    plain: el("button", { type: "button", className: "explain-view", textContent: "Plain English" }),
    checker: el("button", { type: "button", className: "explain-view", textContent: "Checker" }),
  };
  const viewSwitch = el("div", { className: "explain-views", role: "group" }, viewButtons.plain, viewButtons.checker);
  viewSwitch.setAttribute("aria-label", "Explanation view");
  let explainView = "plain";
  try { explainView = localStorage.getItem(EXPLAIN_VIEW_KEY) || "plain"; } catch {}
  let hasPlain = false;
  function showExplainView(name, remember = false) {
    if (remember) {
      explainView = name;
      try { localStorage.setItem(EXPLAIN_VIEW_KEY, name); } catch {}
    }
    const plain = hasPlain && name === "plain";
    plainBody.hidden = !plain;
    explainBody.hidden = plain;
    viewSwitch.hidden = !hasPlain;
    for (const [key, button] of Object.entries(viewButtons)) button.setAttribute("aria-pressed", String(key === (plain ? "plain" : "checker")));
  }
  for (const [name, button] of Object.entries(viewButtons)) button.addEventListener("click", () => showExplainView(name, true));
  const explainCopy = el("button", { type: "button", textContent: "Copy" });
  const explainRule = el("button", { type: "button", className: "explain-rule", hidden: true });
  let explainRuleId = null;
  explainRule.addEventListener("click", () => openGlossary(explainRuleId));
  const explainClose = el("button", { type: "button", textContent: "Close", autofocus: true });
  const explainDialog = el("dialog", { className: "explain-modal" },
    el("header", {}, explainTitle, viewSwitch, el("div", { className: "explain-tools" }, explainRule, explainCopy, explainClose)),
    explainLine, plainBody, explainBody);
  root.append(explainDialog);
  let explainSeq = 0;
  explainClose.addEventListener("click", () => explainDialog.close());
  explainDialog.addEventListener("click", (event) => { if (event.target === explainDialog) explainDialog.close(); });
  explainDialog.addEventListener("close", () => view.focus());
  explainCopy.addEventListener("click", () =>
    navigator.clipboard?.writeText(plainBody.hidden ? explainBody.textContent : plainText(plainBody)));

  async function openExplain(line) {
    const mine = ++explainSeq;
    explainTitle.textContent = `Line ${line.n}`;
    explainLine.replaceChildren(tokens(line.text, variables, { refs: true }));
    const rule = line.text.split(/\s+/).find((t) => t && !t.startsWith("@"));
    explainRuleId = `rule-${rule}`;
    explainRule.textContent = `? ${rule}`;
    explainRule.title = `Look up ${rule} in the Glossary`;
    explainRule.hidden = !glossary?.has(explainRuleId);
    explainBody.replaceChildren(el("span", { className: "muted", textContent: "Explaining…" }));
    hasPlain = false;
    showExplainView(explainView);
    if (!explainDialog.open) explainDialog.showModal();
    const result = await client.explain(line.n);
    if (mine !== explainSeq) return;
    const lines = result?.lines ?? ["No formula loaded."];
    explainBody.replaceChildren(...lines.map((text) =>
      el("span", { className: /^(Error|.*still fails)/.test(text) ? "error" : "", textContent: text + "\n" })));
    hasPlain = !!result?.plain;
    if (hasPlain) {
      explainTitle.textContent = result.plain.title;
      plainBody.replaceChildren(...result.plain.blocks.map(renderBlock));
    }
    showExplainView(explainView);
  }

  // ---- Glossary tab (web-repl/src/glossary.rs) ----
  const glossarySearch = el("input", { type: "search", className: "glossary-search", placeholder: "search the glossary" });
  glossarySearch.setAttribute("aria-label", "Search the glossary");
  const glossaryList = el("nav", { className: "glossary-list" });
  const glossaryEntry = el("article", { className: "glossary-entry" });
  glossaryPanel.append(el("div", { className: "glossary-side" }, glossarySearch, glossaryList), glossaryEntry);
  let glossary = null;
  const glossaryReady = client.glossary().then((entries) => {
    glossary = new Map((entries ?? []).map((entry) => [entry.id, entry]));
    return glossary;
  });
  let glossaryCurrent = null;
  try { glossaryCurrent = localStorage.getItem(GLOSSARY_KEY); } catch {}
  const flat = (entry) => [entry.term, entry.usage, ...(entry.body ?? []), entry.example, ...(entry.details ?? [])]
    .filter(Boolean).join(" ").replace(/\]\(g:[\w-]+\)/g, "").toLowerCase();
  function renderGlossaryList() {
    const query = glossarySearch.value.trim().toLowerCase();
    const groups = [["concept", "Concepts"], ["rule", "Proof rules"]];
    glossaryList.replaceChildren(...groups.flatMap(([group, heading]) => {
      const entries = [...glossary.values()].filter((e) => e.group === group && (!query || flat(e).includes(query)));
      if (!entries.length) return [];
      return [el("h3", { textContent: heading }), ...entries.map((entry) => {
        const item = el("a", { href: "#", className: `glossary-item${entry.group === "rule" ? " rule" : ""}`, textContent: entry.term });
        if (entry.id === glossaryCurrent) item.setAttribute("aria-current", "true");
        item.addEventListener("click", (event) => { event.preventDefault(); openGlossary(entry.id); });
        return item;
      })];
    }));
    if (!glossaryList.children.length) glossaryList.append(el("p", { className: "muted", textContent: "No matches." }));
  }
  function renderGlossaryEntry() {
    const entry = glossary.get(glossaryCurrent) ?? glossary.values().next().value;
    if (!entry) return glossaryEntry.replaceChildren(el("p", { className: "muted", textContent: "No glossary." }));
    glossaryCurrent = entry.id;
    const parts = [el("h2", {}, entry.group === "rule" ? el("code", { textContent: entry.term }) : entry.term,
      entry.group === "rule" ? el("span", { className: "glossary-tag", textContent: "proof rule" }) : "")];
    if (entry.usage) parts.push(el("pre", { className: "glossary-usage", textContent: entry.usage }));
    for (const text of entry.body ?? []) parts.push(el("p", {}, ...inline(text)));
    if (entry.example) parts.push(el("p", { className: "glossary-example" }, el("strong", { textContent: "Example: " }), ...inline(entry.example)));
    if (entry.details?.length) parts.push(el("pre", { className: "glossary-details", textContent: entry.details.join("\n") }));
    const see = (entry.see ?? []).filter((id) => glossary.has(id));
    if (see.length) {
      const links = see.flatMap((id, i) => [i ? ", " : "", ...inline(`[${glossary.get(id).term}](g:${id})`)]);
      parts.push(el("p", { className: "glossary-see" }, el("strong", { textContent: "See also: " }), ...links));
    }
    glossaryEntry.replaceChildren(...parts);
    glossaryEntry.scrollTo(0, 0);
  }
  async function showGlossary() {
    if (!glossary) await glossaryReady;
    renderGlossaryList();
    renderGlossaryEntry();
  }
  /** Shows entry `id` in the Glossary tab (closing the explain modal). */
  async function openGlossary(id) {
    await glossaryReady;
    if (explainDialog.open) explainDialog.close();
    glossaryCurrent = glossary.has(id) ? id : glossaryCurrent;
    try { localStorage.setItem(GLOSSARY_KEY, glossaryCurrent); } catch {}
    if (glossarySearch.value && !flat(glossary.get(glossaryCurrent) ?? {}).includes(glossarySearch.value.trim().toLowerCase())) {
      glossarySearch.value = "";
    }
    if (activeTab !== "glossary") selectTab("glossary");
    else showGlossary();
    glossaryList.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
  }
  glossarySearch.addEventListener("input", () => { if (glossary) renderGlossaryList(); });

  // ---- Constraint refs: hover shows the constraint, click jumps to it ----
  const refTip = el("div", { className: "ref-tip", hidden: true });
  // Constraints by label or ID (vr_find), cached per session generation.
  const found = new Map();
  const lookup = (kind, value) => {
    if (kind !== "label" && kind !== "id") return Promise.resolve(null);
    const key = `${state?.generation}|${kind}|${value}`;
    if (!found.has(key)) found.set(key, client.find(kind === "label" ? { label: value } : { id: Number(value) }));
    return found.get(key);
  };
  function describeRef(target, entry) {
    const { refKind: kind, ref: value } = target.dataset;
    if (kind === "relative") {
      return [el("div", { className: "ref-tip-head", textContent: `${value}: relative ID` }),
        el("div", { textContent: value === "-1" ? "The newest constraint at this point in the proof." : `${-value} back from the newest constraint at this point in the proof.` })];
    }
    if (!entry) {
      return [el("div", { className: "ref-tip-head", textContent: kind === "label" ? value : `Constraint ${value}` }),
        el("div", { className: "muted", textContent: kind === "label" ? "Not a label in the current database." : "Not in the current database (deleted, or not derived yet)." })];
    }
    return [
      el("div", { className: "ref-tip-head" }, `Constraint ${entry.id} · ${entry.core ? "core" : "derived"}`,
        ...entry.labels.map((l) => el("span", { className: "tok-label", textContent: ` ${l}` }))),
      el("div", { className: "ref-tip-text" }, tokens(entry.text, variables)),
      el("div", { className: "muted ref-tip-hint", textContent: `${jumpNeedsKey(target) ? `${JUMP_KEY}+click` : "Click"} to show it in the Database pane.` }),
    ];
  }
  let tipFor = null;
  async function showRefTip(target) {
    tipFor = target;
    const entry = await lookup(target.dataset.refKind, target.dataset.ref);
    if (tipFor !== target) return;
    const host = target.closest("dialog") ?? root;
    if (refTip.parentNode !== host) host.append(refTip);
    refTip.replaceChildren(...describeRef(target, entry));
    refTip.hidden = false;
    const box = target.getBoundingClientRect();
    const tip = refTip.getBoundingClientRect();
    const left = Math.min(Math.max(8, box.left), innerWidth - tip.width - 8);
    const top = box.bottom + 6 + tip.height < innerHeight ? box.bottom + 6 : box.top - tip.height - 6;
    Object.assign(refTip.style, { left: `${left}px`, top: `${Math.max(8, top)}px` });
  }
  const hideRefTip = () => { tipFor = null; refTip.hidden = true; };
  root.addEventListener("mouseover", (event) => {
    const target = event.target.closest?.(".ref");
    if (target) showRefTip(target);
    else if (!event.target.closest?.(".ref-tip")) hideRefTip();
  });
  root.addEventListener("mouseleave", hideRefTip);
  // In the Proof pane a click on a line edits it, so a ref there jumps on
  // Ctrl+click (⌘+click); elsewhere a plain click jumps. Capture: a jump
  // must not also prefill `:edit`.
  const JUMP_KEY = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
  const jumpNeedsKey = (target) => !!target.closest(".pane-proof");
  root.addEventListener("click", (event) => {
    const target = event.target.closest?.(".ref");
    if (!target || (jumpNeedsKey(target) && !event.ctrlKey && !event.metaKey)) return;
    event.preventDefault();
    event.stopPropagation();
    hideRefTip();
    lookup(target.dataset.refKind, target.dataset.ref).then((entry) => { if (entry) jumpToConstraint(entry); });
  }, { capture: true });

  /**
   * Shows `entry` (vr_find's `{id, position}`) in the Database pane: unzooms,
   * clears filters (positions are among the unfiltered rows), scrolls to it
   * and flashes it once drawn.
   */
  let flashId = null;
  function jumpToConstraint(entry) {
    if (explainDialog.open) explainDialog.close();
    if (zoom && zoom.pane !== "database" && !(zoom.pane === "output" && zoom.level === "wide")) {
      zoom = null;
      applyLayout();
    }
    if (filter.value || !coreBox.checked || !derivedBox.checked) {
      filter.value = "";
      coreBox.checked = derivedBox.checked = true;
      renderDatabase();
    }
    flashId = entry.id;
    databaseList.scrollTo(entry.position, "center");
  }
  function flashJumped() {
    const row = flashId != null && database.body.querySelector(`.row[data-id="${flashId}"]`);
    if (!row) return;
    flashId = null;
    row.classList.remove("jumped");
    void row.offsetWidth;
    row.classList.add("jumped");
  }

  // ---- Rendering ----
  // Text with `code` spans and [glossary links](g:<id>) (teach.rs and
  // glossary.rs markup).
  // [constraint 3](c:3) and `@label` spans are constraint refs.
  const inline = (text) => text.split(/(`[^`]*`|\[[^\]]+\]\([gc]:[\w-]+\))/).filter(Boolean).map((part) => {
    if (part.startsWith("`")) {
      const code = part.slice(1, -1);
      return /^@\S+$/.test(code) ? el("code", {}, refSpan(code, { kind: "label", value: code })) : el("code", { textContent: code });
    }
    const constraint = part.match(/^\[([^\]]+)\]\(c:(\d+)\)$/);
    if (constraint) return refSpan(constraint[1], { kind: "id", value: Number(constraint[2]) });
    const link = part.match(/^\[([^\]]+)\]\(g:([\w-]+)\)$/);
    if (!link) return part;
    const a = el("a", { href: "#", className: "g-link", textContent: link[1], title: "Look it up in the Glossary" });
    a.addEventListener("click", (event) => { event.preventDefault(); openGlossary(link[2]); });
    return a;
  });
  const renderBlock = (block) =>
    block.kind === "steps" ? el("ol", {}, ...block.items.map((item) => el("li", {}, ...inline(item))))
    : el("p", { className: block.kind === "note" ? "note" : "" }, ...inline(block.text));
  const plainText = (node) => [...node.children].map((child) =>
    child.tagName === "OL" ? [...child.children].map((li, i) => `${i + 1}. ${li.textContent}`).join("\n") : child.textContent).join("\n\n");

  const placeholder = (text) => el("div", { className: "pane-empty", textContent: text });
  const changed = (key, value) => {
    const json = JSON.stringify(value);
    if (rendered[key] === json) return false;
    rendered[key] = json;
    return true;
  };

  // ---- Panes: virtual lists over vr_view ----
  // Each pane shows only the rows on screen (and a screen of slack), fetched
  // from the REPL; filtering happens there too. A list is refetched when its
  // data or filter changes (`refresh`) and redrawn from its cache when only
  // the presentation does (`redraw`).
  const emptyNote = (pane) => {
    const note = placeholder("");
    note.hidden = true;
    pane.body.append(note);
    return (text) => {
      note.textContent = text ?? "";
      note.hidden = !text;
    };
  };

  const formulaList = createVirtualList({
    body: formula.body,
    fetch: (start, count) => client.view({ pane: "formula", start, count, query: formulaFilter.value }),
    render: (row) => {
      if (row.meta) {
        return el("div", { className: "row meta" }, el("span", { className: "num", textContent: row.meta === "objective" ? "obj" : "pres" }),
          el("span", { className: "text", textContent: stripSemicolon(row.text) }));
      }
      const element = el("div", { className: "row" }, el("span", { className: "num", textContent: row.ids }),
        el("span", { className: "text" }, tokens(stripSemicolon(row.text), variables, { refs: true })));
      element.dataset.ids = row.ids;
      return element;
    },
    onLoad: (info) => {
      const f = state?.formula;
      formulaEmpty(f ? null : "No formula loaded. Add files, then :instance <name> or :load <file.opb>.");
      if (!f) return formula.setTitle("Formula");
      formula.setTitle(!formulaFilter.value.trim() ? `Formula: ${f.name} (${f.count})` : `Formula: ${f.name} (${info?.total ?? 0} of ${f.lines} lines)`);
    },
  });
  const formulaEmpty = emptyNote(formula);

  const databaseList = createVirtualList({
    body: database.body,
    fetch: (start, count) => client.view({ pane: "database", start, count, query: filter.value, core: coreBox.checked, derived: derivedBox.checked }),
    render: (entry) => {
      const lit = state?.mode === MODE_DEBUG && (state.proof?.lastStepIds ?? []).includes(entry.id);
      const row = el("div", { className: `row ${entry.core ? "core" : "derived"}${lit ? " lit" : ""}`, title: entry.core ? "core" : "derived" },
        el("span", { className: "num", textContent: entry.id }),
        el("span", { className: "text" },
          ...entry.labels.map((label) => el("span", { className: "tok-label", textContent: label + " " })),
          tokens(entry.text, variables)));
      row.dataset.id = entry.id;
      return row;
    },
    onLoad: (info) => {
      const db = state?.database;
      databaseEmpty(!db ? "No formula loaded." : db.error || info?.error ? `Error: ${db.error ?? info.error}` : null);
      if (!db || db.error) return database.setTitle("Database");
      const total = info?.total ?? 0;
      database.setTitle(total === db.count ? `Database (${db.count})` : `Database (${total} of ${db.count})`);
    },
    onRender: () => flashJumped(),
  });
  const databaseEmpty = emptyNote(database);

  const icon = { checked: "✓", unchecked: "○", rejected: "✗" };
  const proofList = createVirtualList({
    body: proof.body,
    fetch: (start, count) => client.view({ pane: "proof", start, count, query: proofFilter.value }),
    render: (line) => (line.preamble ? preambleRow(line) : proofRow(line)),
    onLoad: (info) => {
      const p = state?.proof;
      proofEmpty(p ? null : "No formula loaded.");
      if (!proofFilter.value.trim() && info?.generation != null) {
        vim.sync({ count: Math.max(0, info.total - 2), get: (i) => proofList.rowAt(i + 2)?.text }, info.generation);
      }
      proofTitle(info?.total);
    },
    onRender: () => {
      vim.settle();
      refreshLineIds();
    },
  });
  const proofEmpty = emptyNote(proof);
  function proofTitle(total = proofList.total) {
    const p = state?.proof;
    if (!p) return proof.setTitle("Proof");
    const count = !proofFilter.value.trim() ? `${p.lines}` : `${total} of ${p.lines}`;
    const unchecked = p.unchecked - Math.max(0, live.settled - 2 - p.checked);
    proof.setTitle(`Proof (${count})${unchecked > 0 ? ` (${unchecked} unchecked)` : ""}${vim.active ? (vim.mode === "insert" ? " -- INSERT --" : " -- NORMAL --") : ""}`);
  }

  function preambleRow(line) {
    return el("div", { className: "row preamble" }, el("span", { className: "gutter" }), el("span", { className: "status" }),
      el("span", { className: "num", textContent: line.n }), el("span", { className: "text", textContent: line.text }));
  }

  function proofRow(line) {
    const p = state?.proof ?? {};
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
    const provisional = line.status === "unchecked" && line.n <= live.settled;
    const row = el("div", {
      className: `row ${line.status}${provisional ? " provisional" : ""}${line.n === p.debugLine ? " debug-current" : ""}${line.assertion ? " assertion" : ""}`,
    },
      bp,
      el("span", {
        className: "status", textContent: provisional ? icon.checked : icon[line.status],
        title: provisional ? "checked (verifying…)" : line.status === "rejected" ? p.rejected?.message ?? "rejected" : line.status,
      }),
      el("span", { className: "num", textContent: line.n, title: `Click the line to put :edit ${line.n} in the command line` }),
      lineText(line),
      explain);
    row.dataset.n = line.n;
    if (vim.active && line.n === vim.line) row.classList.add("vim-line");
    row.addEventListener("click", (event) => {
      if (vim.active) return vim.click(line.n, clickColumn(row, event));
      if (view.mode === MODE_PBP && !getSelection().toString()) view.prefill(`:edit ${line.n}`);
    });
    row.addEventListener("dblclick", () => {
      if (view.mode !== MODE_PBP) return;
      if (view.input.value === `:edit ${line.n}`) view.prefill("");
      getSelection().removeAllRanges();
      if (proofFilter.value) {
        proofFilter.value = "";
        renderProof();
      }
      vim.doubleClick(line.n);
    });
    return row;
  }

  // Refetch a list when `data` changed, else redraw it when `look` did.
  function update3(key, list, data, look, force) {
    if (changed(`${key}:data`, data)) {
      changed(`${key}:look`, look);
      list.refresh();
    } else if (changed(`${key}:look`, look) || force) {
      list.redraw();
    }
  }
  function renderFormula(force = false) {
    update3("formula", formulaList, [state?.generation, state?.formula?.name, formulaFilter.value.trim()], [[...variables]], force);
  }
  function renderDatabase(force = false) {
    if (databasePending) return;
    const highlight = state?.mode === MODE_DEBUG ? state.proof?.lastStepIds ?? [] : [];
    update3("database", databaseList, [state?.generation, filter.value.trim(), coreBox.checked, derivedBox.checked], [highlight, [...variables]], force);
  }
  function renderProof(force = false) {
    const p = state?.proof;
    update3("proof", proofList, [state?.generation, p?.checked, p?.rejected, p?.breakpoints, proofFilter.value.trim()],
      [state?.mode, p?.debugLine, [...variables], vim.active && [vim.line, vim.col, vim.mode]], force);
    proofTitle();
    if (vim.active) proofList.scrollTo(vim.line - 1);
    // The editor focuses its input right after asking for a redraw: draw now.
    if (force) proofList.drawNow();
    else if (p?.debugLine && changed("proof:debugLine", p.debugLine)) proofList.scrollTo(p.debugLine - 1);
  }

  // A proof line's text: tokens, or on the Vim cursor line the cursor (Normal)
  // or the Insert-mode input.
  function lineText(line) {
    if (!vim.active || line.n !== vim.line) return el("span", { className: "text" }, tokens(line.text, variables, { refs: true }));
    if (vim.mode === "insert") return el("span", { className: "text" }, vim.input);
    const t = vim.text(line.n);
    return el("span", { className: "text" }, tokens(t.slice(0, vim.col), variables),
      el("span", { className: "vim-cursor", textContent: t[vim.col] ?? " " }), tokens(t.slice(vim.col + 1), variables));
  }
  // The character column of a click within a row's text.
  function clickColumn(row, event) {
    const textNode = row.querySelector(".text");
    const caret = document.caretRangeFromPoint?.(event.clientX, event.clientY);
    if (!textNode || !caret || !textNode.contains(caret.startContainer)) return 0;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(caret.startContainer, caret.startOffset);
    return range.toString().length;
  }

  function update(next) {
    state = next;
    if (state) followMode(state.mode);
    variables = new Set(state?.variables ?? []);
    renderFormula();
    renderDatabase();
    renderProof();
    refreshLineIds();
    if (activeTab === "preserved") refreshPreserved();
    if (activeTab === "extras") refreshExtras();
  }

  update(null);
  selectTab(activeTab);
  try { setLinks(localStorage.getItem(LINKS_KEY)); } catch {}

  return {
    putFile: client.putFile,
    deleteFile: client.deleteFile,
    getFile: client.getFile,
    snapshot: client.snapshot,
    run: (command) => view.run(command),
    note: (text) => view.append(text, "note"),
    focus: () => view.focus(),
    unmount() {
      client.terminate();
      links?.destroy();
      document.removeEventListener("keydown", escapeZoom);
      colorScheme.removeEventListener("change", followSystem);
      resetTheme();
      root.classList.remove("enhanced");
      root.style.gridTemplateRows = "";
    },
  };
}
