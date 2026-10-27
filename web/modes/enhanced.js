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
  // accepted (host.js's `settled`) show as checked at once, provisionally.
  // Only the command's first run counts: later runs (the database rebuild,
  // probes) are not checking the proof's unchecked lines. When a summary
  // arrives, its checked count stands in for them until the Proof pane has
  // rows from that same session generation (the worker may be busy with the
  // database rebuild before it can send them).
  const live = { verifying: false, run: null, settled: 0, generation: null };
  let databasePending = false;
  function applyState(s) {
    live.settled = s?.proof ? s.proof.checked + 2 : 0;
    live.generation = s?.generation ?? null;
    if (s?.database?.pending) {
      databasePending = true;
      update({ ...s, database: state?.database ?? null });
      if (s.mode === MODE_DEBUG) databaseWhenIdle();
      return;
    }
    clearTimeout(databaseTimer);
    databasePending = false;
    updating.done();
    update(s);
  }
  // In :debug mode the worker sends only the quick summary after each step
  // (each would otherwise cost a second replay of the proof for the
  // database): ask for the full one once stepping pauses. A new command
  // cancels the wait.
  let databaseTimer = null;
  function databaseWhenIdle() {
    clearTimeout(databaseTimer);
    updating.start();
    databaseTimer = setTimeout(async () => {
      const full = await client.state();
      if (full && !full.database?.pending) applyState(full);
    }, 600);
  }
  const client = connectReplWorker(host, {
    what: "REPL",
    // A summary with `database: {pending}` comes first: the panes but the
    // Database take it at once; the full one follows.
    onState: (s) => applyState(s),
    onUpdating: () => {
      live.verifying = false;
      updating.start();
    },
    onProgress: (progress) => {
      updating.progress(progress);
      extrasProgress(progress);
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
  client.commands().then((commands) => {
    setCommands(commands.filter((c) => !c.mode).map((c) => c.name));
    commandBar.describe(commands);
  });
  let commandBar = null;
  const view = new OutputView({
    complete: (text) => client.complete(text),
    // `:theme` recolours this page (the REPL itself answers "TUI only").
    onSubmit: (text) => {
      clearTimeout(databaseTimer);
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
    onReady: () => commandBar?.update(),
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

  // Buttons for common commands, above the prompt. Each runs its command as
  // if typed (`view.run`): echoed, in history and the transcript. At the
  // pbp> prompt (and, disabled, in the edit modes) Verify, Check, Undo and
  // Debug, enabled with a formula loaded; at debug>, Step, Back, Continue and
  // Done. Only while the REPL is idle. Tooltips are the commands' usage and
  // summary from veripb-repl (help::COMMANDS, debug::MODE_VOCABULARY).
  commandBar = (() => {
    const sets = {
      pbp: [["verify", "Verify"], ["check", "Check"], ["undo", "Undo"], ["debug", "Debug"]],
      debug: [["step", "Step"], ["back", "Back"], ["continue", "Continue"], ["done", "Done"]],
    };
    const buttons = Object.entries(sets).flatMap(([set, commands]) => commands.map(([name, label]) => {
      const button = el("button", { type: "button", className: "cmd", textContent: label, disabled: true });
      button.dataset.command = name;
      button.dataset.set = set;
      button.addEventListener("click", () => {
        view.run(`:${name}`);
      });
      return button;
    }));
    const element = el("div", { className: "cmd-bar", role: "toolbar" }, ...buttons);
    element.setAttribute("aria-label", "Commands");
    return {
      element,
      update() {
        const debugging = view.mode === MODE_DEBUG;
        const enabled = view.ready() && (debugging || (view.mode === MODE_PBP && !!state?.formula));
        for (const button of buttons) {
          button.hidden = (button.dataset.set === "debug") !== debugging;
          button.disabled = !enabled;
        }
      },
      describe(commands) {
        for (const button of buttons) {
          const command = commands.find((c) => c.name === button.dataset.command && (c.mode === "debug") === (button.dataset.set === "debug"));
          if (command) button.title = `${command.usage} — ${command.summary}`;
        }
      },
    };
  })();
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
  const bottom = el("div", { className: "enh-bottom" }, tabBar, ...Object.values(panels), commandBar.element, view.commandLine);
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

  // Extras: Status (`:check`'s verdict) and Objective (`:objective`'s
  // report) each cost veripb runs; the REPL caches them per session
  // generation, also from `:check` and `:objective` typed at the prompt.
  // Summary comes from the session summary. The tab shows at once, and each
  // slow section fills in as it arrives, with veripb's progress meanwhile.
  let extrasFor = null;
  let extrasWaiting = null;
  const working = () => el("p", { className: "muted working", textContent: "Working…" });
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
    const status = section("Status", working());
    const objective = section("Objective", working());
    extrasPanel.replaceChildren(status, objective, el("section", { className: "extra extra-summary" }));
    renderSummary();
    for (const [slot, fetch, make] of [[objective, client.extrasObjective, objectiveSection], [status, client.extrasStatus, statusSection]]) {
      extrasWaiting = slot;
      const result = await fetch();
      if (extrasFor !== key) return;
      if (result) slot.replaceWith(make(result));
    }
    extrasWaiting = null;
  }
  // veripb's progress, in the section being worked out.
  function extrasProgress(progress) {
    const note = extrasWaiting?.querySelector(".working");
    if (!note || !progress.line) return;
    const total = state?.proof ? state.proof.lines + 2 : null;
    note.textContent = `Working · line ${progress.line.toLocaleString()}${total ? ` of ${total.toLocaleString()}` : ""}`;
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
        // What the sourced file claims, beside what veripb accepted.
        ...(conclusion.fileConclusion
          ? [["Proof file", `concludes ${conclusion.fileConclusion}${conclusion.conclusion === conclusion.fileConclusion ? " (verified)" : " (not verified yet)"}`]]
          : []),
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

  // ---- Stats modal: click a pane's title (web-repl/src/stats.rs) ----
  // Categorical slots (fixed order) for the light and dark surfaces; a
  // seventh, grey, for "other".
  const SERIES = {
    light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300"],
    dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300"],
  };
  const OTHER = "#898781";
  const MAX_SLICES = 6;
  const PANE_NUMBER = { formula: 0, database: 1, proof: 2 };
  const KIND_NOTES = {
    clause: "any one true literal satisfies it",
    cardinality: "equal coefficients",
    general: "general pseudo-Boolean",
    equality: "an = constraint",
    implication: "==>, <== or <==>",
    trivial: "always satisfied",
    contradiction: "never satisfied",
  };
  const statsTitle = el("h2");
  const statsBody = el("div", { className: "stats-body" });
  const statsClose = el("button", { type: "button", textContent: "Close", autofocus: true });
  const statsDialog = el("dialog", { className: "explain-modal stats-modal" },
    el("header", {}, statsTitle, el("div", { className: "explain-tools" }, statsClose)), statsBody);
  root.append(statsDialog);
  statsClose.addEventListener("click", () => statsDialog.close());
  statsDialog.addEventListener("click", (event) => { if (event.target === statsDialog) statsDialog.close(); });
  statsDialog.addEventListener("close", () => view.focus());
  let statsSeq = 0;

  const number = (n) => (n ?? 0).toLocaleString();
  const percent = (part, whole) => (whole ? `${((100 * part) / whole).toFixed(part / whole < 0.01 ? 2 : 1)}%` : "–");
  /** The series colours for the page's current background. */
  function seriesColours() {
    const [r, g, b] = (getComputedStyle(document.body).backgroundColor.match(/\d+(\.\d+)?/g) ?? [255, 255, 255]).map(Number);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5 ? SERIES.dark : SERIES.light;
  }
  const tiles = (...pairs) => el("div", { className: "stat-tiles" }, ...pairs.map(([label, value, note]) =>
    el("div", { className: "stat-tile" }, el("div", { className: "stat-value", textContent: value }),
      el("div", { className: "stat-label", textContent: label }), ...(note ? [el("div", { className: "stat-note", textContent: note })] : []))));
  const statsSection = (title, ...body) => el("section", { className: "stats-section" }, el("h3", { textContent: title }), ...body);

  /** A donut of `items` ({name, count}, largest first): the first five, and the rest as "other" (or six if that is all). */
  function donut(items, total, unit) {
    const colours = seriesColours();
    const slices = items.length <= MAX_SLICES ? items.map((item, i) => ({ ...item, colour: colours[i] }))
      : [...items.slice(0, MAX_SLICES - 1).map((item, i) => ({ ...item, colour: colours[i] })),
        { name: "other", count: items.slice(MAX_SLICES - 1).reduce((sum, item) => sum + item.count, 0), colour: OTHER,
          rest: items.slice(MAX_SLICES - 1).map((item) => item.name) }];
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "-100 -100 200 200");
    svg.setAttribute("class", "donut");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", slices.map((s) => `${s.name} ${percent(s.count, total)}`).join(", "));
    const value = document.createElementNS(NS, "text");
    value.setAttribute("class", "donut-value");
    value.setAttribute("y", "4");
    const label = document.createElementNS(NS, "text");
    label.setAttribute("class", "donut-label");
    label.setAttribute("y", "24");
    const centre = (slice) => {
      value.textContent = slice ? percent(slice.count, total) : number(total);
      label.textContent = slice ? slice.name : unit;
    };
    const legend = el("ul", { className: "donut-legend" });
    const marks = [];
    const highlight = (index) => {
      marks.forEach((mark, i) => mark.classList.toggle("faded", index != null && i !== index));
      [...legend.children].forEach((row, i) => row.classList.toggle("active", i === index));
      centre(index == null ? null : slices[index]);
    };
    const OUTER = 92;
    const INNER = 58;
    let angle = -Math.PI / 2;
    slices.forEach((slice, index) => {
      const sweep = (2 * Math.PI * slice.count) / total;
      let mark;
      if (slices.length === 1) {
        mark = document.createElementNS(NS, "circle");
        mark.setAttribute("r", String((OUTER + INNER) / 2));
        mark.setAttribute("fill", "none");
        mark.setAttribute("stroke", slice.colour);
        mark.setAttribute("stroke-width", String(OUTER - INNER));
      } else {
        const point = (r, a) => `${(r * Math.cos(a)).toFixed(3)} ${(r * Math.sin(a)).toFixed(3)}`;
        const end = angle + sweep;
        const large = sweep > Math.PI ? 1 : 0;
        mark = document.createElementNS(NS, "path");
        mark.setAttribute("d", `M ${point(OUTER, angle)} A ${OUTER} ${OUTER} 0 ${large} 1 ${point(OUTER, end)} L ${point(INNER, end)} A ${INNER} ${INNER} 0 ${large} 0 ${point(INNER, angle)} Z`);
        mark.setAttribute("fill", slice.colour);
        mark.setAttribute("class", "donut-slice");
        angle = end;
      }
      const tip = document.createElementNS(NS, "title");
      tip.textContent = `${slice.name}: ${number(slice.count)} (${percent(slice.count, total)})${slice.rest ? `\n${slice.rest.join(", ")}` : ""}`;
      mark.append(tip);
      mark.addEventListener("pointerenter", () => highlight(index));
      mark.addEventListener("pointerleave", () => highlight(null));
      marks.push(mark);
      svg.append(mark);
      const row = el("li", { title: slice.rest ? slice.rest.join(", ") : "" },
        el("span", { className: "swatch" }), el("span", { className: "legend-name", textContent: slice.name }),
        el("span", { className: "legend-count", textContent: number(slice.count) }),
        el("span", { className: "legend-share", textContent: percent(slice.count, total) }));
      row.querySelector(".swatch").style.background = slice.colour;
      row.addEventListener("pointerenter", () => highlight(index));
      row.addEventListener("pointerleave", () => highlight(null));
      legend.append(row);
    });
    svg.append(value, label);
    centre(null);
    return el("div", { className: "donut-chart" }, svg, legend);
  }

  /** One stacked bar of two or three parts ([{name, count}]), with a legend. */
  function partsBar(parts) {
    const colours = seriesColours();
    const total = parts.reduce((sum, part) => sum + part.count, 0);
    const bar = el("div", { className: "parts-bar", role: "img" });
    bar.setAttribute("aria-label", parts.map((p) => `${p.name} ${percent(p.count, total)}`).join(", "));
    const legend = el("ul", { className: "donut-legend parts-legend" });
    parts.forEach((part, i) => {
      if (part.count) {
        const segment = el("div", { className: "parts-segment", title: `${part.name}: ${number(part.count)} (${percent(part.count, total)})` });
        segment.style.flexGrow = String(part.count);
        segment.style.background = colours[i];
        bar.append(segment);
      }
      const row = el("li", {}, el("span", { className: "swatch" }), el("span", { className: "legend-name", textContent: part.name }),
        el("span", { className: "legend-count", textContent: number(part.count) }),
        el("span", { className: "legend-share", textContent: percent(part.count, total) }));
      row.querySelector(".swatch").style.background = colours[i];
      legend.append(row);
    });
    return el("div", { className: "parts" }, bar, legend);
  }

  /** Horizontal bars, one hue, each labelled with its count and share. */
  function bars(items, notes = {}) {
    const total = items.reduce((sum, item) => sum + item.count, 0);
    const largest = Math.max(1, ...items.map((item) => item.count));
    const colour = seriesColours()[0];
    return el("div", { className: "hbars" }, ...items.map((item) => {
      const fill = el("div", { className: "hbar-fill" });
      fill.style.width = `${(100 * item.count) / largest}%`;
      fill.style.background = colour;
      return el("div", { className: "hbar", title: notes[item.name] ?? "" },
        el("span", { className: "hbar-name", textContent: item.name }),
        el("div", { className: "hbar-track" }, fill),
        el("span", { className: "hbar-value", textContent: `${number(item.count)} · ${percent(item.count, total)}` }));
    }));
  }

  function shapeSections(stats, noun) {
    const t = stats.terms;
    return [
      statsSection(`${noun} by kind`, stats.kinds.length ? bars(stats.kinds, KIND_NOTES) : el("p", { className: "muted", textContent: "None." })),
      statsSection("Size", facts(
        ["Terms per constraint", t ? `min ${number(t.min)} · median ${number(t.median)} · mean ${t.mean.toFixed(1)} · max ${number(t.max)}` : "–"],
        ["Largest coefficient", stats.largestCoefficient ?? "–"],
      )),
    ];
  }

  function formulaStats(s) {
    return [
      tiles(["Constraints", number(s.constraints)], ["Variables", number(s.variables)],
        ["Lines", number(s.lines), s.twoConstraintLines ? `${number(s.twoConstraintLines)} give two constraints` : null],
        ["Labelled", number(s.labelled), percent(s.labelled, s.lines)]),
      ...shapeSections(s, "Lines"),
      statsSection("Also", facts(
        ["Objective", s.objectiveTerms == null ? "none" : `${number(s.objectiveTerms)} term${s.objectiveTerms === 1 ? "" : "s"}`],
        ["Preserved set", s.preserved == null ? "none declared" : `${number(s.preserved)} variable${s.preserved === 1 ? "" : "s"}`],
      )),
    ];
  }

  function databaseStats(s) {
    if (s.error) return [el("p", { className: "error", textContent: s.error })];
    const fromProof = s.count - s.fromFormula;
    return [
      tiles(["Constraints", number(s.count)], ["Core", number(s.core), percent(s.core, s.count)],
        ["Derived", number(s.count - s.core), percent(s.count - s.core, s.count)],
        ["Labelled", number(s.labelled), percent(s.labelled, s.count)]),
      statsSection("Core and derived", partsBar([{ name: "core", count: s.core }, { name: "derived", count: s.count - s.core }])),
      statsSection("Where they came from", partsBar([{ name: "formula", count: s.fromFormula }, { name: "proof", count: fromProof }]),
        el("p", { className: "muted stats-note", textContent: `${number(s.fromFormula)} of the formula's ${number(s.formulaConstraints)} constraints are still in the database; the highest constraint ID is ${number(s.highestId)}.` })),
      ...shapeSections(s, "Constraints"),
    ];
  }

  function proofStats(s) {
    const used = s.rules.filter((rule) => rule.name !== "comment" && rule.name !== "blank");
    const table = el("table", { className: "stats-table" },
      el("thead", {}, el("tr", {}, ...["Rule", "Lines", "Share", "Checked"].map((h) => el("th", { textContent: h })))),
      el("tbody", {}, ...s.rules.map((rule) => {
        const id = `rule-${rule.name}`;
        const name = glossary?.has(id)
          ? el("a", { href: "#", textContent: rule.name, title: `Look up ${rule.name} in the Glossary` })
          : el("span", { textContent: rule.name });
        if (name.tagName === "A") name.addEventListener("click", (event) => { event.preventDefault(); openGlossary(id); });
        return el("tr", {}, el("td", {}, name), el("td", { textContent: number(rule.count) }),
          el("td", { textContent: percent(rule.count, s.lines) }),
          el("td", { textContent: rule.checked === rule.count ? "all" : number(rule.checked) }));
      })));
    return [
      tiles(["Lines", number(s.lines), s.preamble ? `plus ${number(s.preamble)} preamble` : null],
        ["Checked", number(s.checked), s.rejected ? "then a rejected line" : percent(s.checked, s.lines)],
        ["Rules used", number(used.length)], ["Labelled", number(s.labelled), percent(s.labelled, s.lines)]),
      s.lines
        ? el("div", { className: "stats-pair" }, statsSection("Lines by rule", donut(s.rules, s.lines, "lines")), statsSection("Every rule", table))
        : el("p", { className: "muted", textContent: "The proof is empty." }),
    ];
  }

  async function openStats(name) {
    const mine = ++statsSeq;
    const titles = { formula: "Formula statistics", database: "Database statistics", proof: "Proof statistics" };
    statsTitle.textContent = titles[name];
    statsBody.replaceChildren(el("p", { className: "muted", textContent: name === "database" ? "Counting (may need the database rebuilt)…" : "Counting…" }));
    if (!statsDialog.open) statsDialog.showModal();
    if (name === "proof") await glossaryReady;
    const stats = await client.paneStats(PANE_NUMBER[name]);
    if (mine !== statsSeq) return;
    if (!stats) return statsBody.replaceChildren(el("p", { className: "muted", textContent: "No formula loaded." }));
    statsBody.replaceChildren(...(name === "formula" ? formulaStats(stats) : name === "database" ? databaseStats(stats) : proofStats(stats)));
  }
  for (const [name, target] of Object.entries({ formula, database, proof })) {
    const title = target.head.querySelector(".pane-title-text");
    title.classList.add("stats-link");
    title.tabIndex = 0;
    title.setAttribute("role", "button");
    title.title = "Statistics";
    title.addEventListener("click", () => openStats(name));
    title.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openStats(name);
    });
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
  /** Shows entry `id` in the Glossary tab (closing any modal). */
  async function openGlossary(id) {
    await glossaryReady;
    for (const dialog of root.querySelectorAll("dialog[open]")) dialog.close();
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

  // ---- Jumps between a line and its constraints ----
  // Clicking a row's number: a Formula or Proof line shows its constraints in
  // the Database pane; a Database row shows the line it came from. The pane
  // jumped to is unzoomed and unfiltered (positions are among its unfiltered
  // rows), scrolled to the row, which flashes once drawn.
  const flash = { database: new Set(), formula: null, proof: null };
  const paneParts = () => ({ formula: [formula, formulaList, formulaFilter], database: [database, databaseList, filter], proof: [proof, proofList, proofFilter] });
  function reveal(pane) {
    if (zoom && zoom.pane !== pane && !(zoom.pane === "output" && zoom.level === "wide")) {
      zoom = null;
      applyLayout();
    }
    const box = paneParts()[pane][2];
    if (box.value || (pane === "database" && (!coreBox.checked || !derivedBox.checked))) {
      box.value = "";
      if (pane === "database") coreBox.checked = derivedBox.checked = true;
      ({ formula: renderFormula, database: renderDatabase, proof: renderProof })[pane]();
    }
  }
  /** Shows `entry` (vr_find's `{id, position}`), flashing `ids` (default: its own). */
  function jumpToConstraint(entry, ids = [entry.id]) {
    if (explainDialog.open) explainDialog.close();
    reveal("database");
    flash.database = new Set(ids);
    databaseList.scrollTo(entry.position, "center");
  }
  /** Shows row `position` of the Formula or Proof pane. */
  function jumpToRow(pane, position) {
    reveal(pane);
    flash[pane] = position;
    paneParts()[pane][1].scrollTo(position, "center");
  }
  const flashRow = (row) => {
    row.classList.remove("jumped");
    void row.offsetWidth;
    row.classList.add("jumped");
  };
  function flashJumped() {
    if (!flash.database.size) return;
    const rows = [...database.body.querySelectorAll(".row[data-id]")].filter((row) => flash.database.has(Number(row.dataset.id)));
    if (!rows.length) return;
    rows.forEach(flashRow);
    flash.database = new Set();
  }
  function flashAt(pane) {
    const row = flash[pane] != null && paneParts()[pane][0].body.querySelector(`.row[data-pos="${flash[pane]}"]`);
    if (!row) return;
    flashRow(row);
    flash[pane] = null;
  }

  // A lookup can take a veripb run (a proof line's constraints need the
  // traced replay): it says so after 300 ms; a dead end is said for 3 s.
  const locating = el("div", { className: "enh-updating enh-locating", hidden: true });
  top.append(locating);
  let locatingTimer = null;
  async function locate(text, work) {
    clearTimeout(locatingTimer);
    locatingTimer = setTimeout(() => { locating.textContent = text; locating.hidden = false; }, 300);
    try {
      return await work();
    } finally {
      clearTimeout(locatingTimer);
      locating.hidden = true;
    }
  }
  function sayBriefly(text) {
    clearTimeout(locatingTimer);
    locating.textContent = text;
    locating.hidden = false;
    locatingTimer = setTimeout(() => { locating.hidden = true; }, 3000);
  }
  /** The first of `ids` still in the database, scrolled to; all of them flashed. */
  async function showConstraints(ids, what) {
    const entries = await locate(`Finding ${what}'s constraints…`, () => Promise.all(ids.map((id) => client.find({ id }))));
    const first = entries.find(Boolean);
    if (!first) return sayBriefly(ids.length ? `The constraints of ${what} are no longer in the database.` : `${what[0].toUpperCase()}${what.slice(1)} derived no constraints.`);
    jumpToConstraint(first, ids);
  }
  async function showProofLine(n) {
    const ids = await locate(`Finding line ${n}'s constraints…`, () => client.lineIds(n, n));
    if (ids?.error) return sayBriefly(`Error: ${ids.error}`);
    if (!ids?.[n]) return sayBriefly(`Line ${n} is not checked: :verify it to see its constraints.`);
    showConstraints(ids[n], `line ${n}`);
  }
  async function showSource(id) {
    const source = await locate(`Finding where constraint ${id} came from…`, () => client.source(id));
    if (!source) return sayBriefly(`Constraint ${id}: no checked line derived it.`);
    jumpToRow(source.pane, source.position);
  }
  // "1-2" -> [1, 2]; "3" -> [3].
  const expandIds = (text) => {
    const [lo, hi = lo] = String(text).split("-").map(Number);
    return Array.from({ length: hi - lo + 1 }, (_, k) => lo + k);
  };

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
    render: (row, position) => {
      if (row.meta) {
        return el("div", { className: "row meta" }, el("span", { className: "num", textContent: row.meta === "objective" ? "obj" : "pres" }),
          el("span", { className: "text", textContent: stripSemicolon(row.text) }));
      }
      const element = el("div", { className: "row" },
        jumpNum(row.ids, "Show in the Database pane", () => showConstraints(expandIds(row.ids), `formula line ${row.ids}`)),
        el("span", { className: "text" }, tokens(stripSemicolon(row.text), variables, { refs: true })));
      element.dataset.ids = row.ids;
      element.dataset.pos = position;
      return element;
    },
    onRender: () => flashAt("formula"),
    onLoad: (info) => {
      const f = state?.formula;
      formulaEmpty(f ? null : "No formula loaded. Add files, then :instance <name> or :load <file.opb>.");
      if (!f) return formula.setTitle("Formula");
      formula.setTitle(!formulaFilter.value.trim() ? `Formula: ${f.name} (${f.count})` : `Formula: ${f.name} (${info?.total ?? 0} of ${f.lines} lines)`);
    },
  });
  const formulaEmpty = emptyNote(formula);
  // A row number that jumps (see "Jumps between a line and its constraints").
  function jumpNum(text, title, jump) {
    const num = el("span", { className: "num jump", textContent: text, title });
    num.addEventListener("click", (event) => {
      event.stopPropagation();
      jump();
    });
    return num;
  }

  const databaseList = createVirtualList({
    body: database.body,
    fetch: (start, count) => client.view({ pane: "database", start, count, query: filter.value, core: coreBox.checked, derived: derivedBox.checked }),
    render: (entry) => {
      const lit = state?.mode === MODE_DEBUG && (state.proof?.lastStepIds ?? []).includes(entry.id);
      const row = el("div", { className: `row ${entry.core ? "core" : "derived"}${lit ? " lit" : ""}`, title: entry.core ? "core" : "derived" },
        jumpNum(entry.id, entry.id <= (state?.formula?.count ?? 0) ? "Show its formula line" : "Show the proof line that derived it", () => showSource(entry.id)),
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
    render: (line, position) => {
      const row = line.preamble ? preambleRow(line) : proofRow(line);
      row.dataset.pos = position;
      return row;
    },
    // Not fetched yet (the worker may be busy verifying): the line number,
    // known without it, and a provisional tick if it is settled.
    placeholder: (position) => {
      const n = position + 1;
      const ticked = !proofFilter.value.trim() && n > 2 && n <= live.settled;
      return el("div", { className: `row vlist-loading${ticked ? " provisional" : ""}` }, el("span", { className: "gutter" }),
        el("span", { className: "status", textContent: ticked ? icon.checked : "" }),
        el("span", { className: "num", textContent: proofFilter.value.trim() ? "" : n }), el("span", { className: "text", textContent: "…" }));
    },
    onLoad: (info) => {
      const p = state?.proof;
      proofEmpty(p ? null : "No formula loaded.");
      // Rows from the summary's own session generation: their statuses are
      // the REPL's, so the stand-in ticks are no longer needed.
      if (info?.generation != null && info.generation === live.generation && !live.verifying) live.settled = 0;
      if (!proofFilter.value.trim() && info?.edits != null) {
        vim.sync({ count: Math.max(0, info.total - 2), get: (i) => proofList.rowAt(i + 2)?.text }, info.edits);
      }
      proofTitle(info?.total);
    },
    onRender: () => {
      vim.settle();
      refreshLineIds();
      flashAt("proof");
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
      jumpNum(line.n, "Show the constraints it derived in the Database pane", () => showProofLine(line.n)),
      lineText(line),
      explain);
    row.dataset.n = line.n;
    if (vim.active && line.n === vim.line) row.classList.add("vim-line");
    if (vim.active && vim.isHeld(line.n)) row.classList.add("held");
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
    update3("proof", proofList, [state?.generation, state?.edits, p?.checked, p?.rejected, p?.breakpoints, proofFilter.value.trim()],
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
    if (vim.active && line.n !== vim.line && vim.isHeld(line.n)) {
      return el("span", { className: "text", title: "Edited; committed when you press Esc" }, tokens(vim.text(line.n), variables));
    }
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
    commandBar.update();
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
    resources: client.resources,
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
