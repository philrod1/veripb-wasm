// Solver tab: edit a constraint model (`.scp`), solve it with cp-solver's
// CLI (`cps`, in solver-worker.js), and hand the OPB and proof it writes to
// the Verify tab.
//
// mount(root, host) -> instance
//   host: { setStatus(text), files() -> [{name, size}], getFile(name) -> Promise<Uint8Array|null>,
//           putFile(name, bytes), download(name, bytes), verify(stem) }
//     files: the files panel's; verify(stem): load stem.opb and stem.pbp in the REPL.
//   instance: { open(name), filesChanged(), note(text), focus(), dirty() -> bool }
//     open(name): edit model `name` from the files panel; filesChanged():
//     the files panel's list has changed.
//
// The model is solved under its file name: `cps /<stem>.scp --proof /<stem>`
// writes <stem>.opb and <stem>.pbp, which are added to the files panel.

import { createLineList } from "./linelist.js";
import { createScpEditor } from "./scp-editor.js";
import { ANSWER, solutionLine } from "./scp-syntax.js";
import { splitter } from "./splitter.js";
import { bytes } from "../resources.js";

const SPLIT_KEY = "veripb-repl-solver-split";
const UNTITLED = "untitled.scp";
// A new model: the example in cp-solver's crates/lang/src/scp.rs.
const TEMPLATE = `( (version 1)
  (variables (x 0 10) (y 0 10))
  (constraints (c1 lin_equals (2 x 1 y) 12) (c2 not_equals x y))
  (prob_type enumerate) )
`;
// Lines of output kept for the Result pane; past this, only how many more
// there were and the last.
const MAX_LINES = 200000;

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};
const button = (text, title) => el("button", { type: "button", textContent: text, title });

/** `name` as a model file name: no directories or spaces, ending in .scp. */
function modelName(name) {
  const base = name.trim().split(/[\\/]/).pop().replace(/\s+/g, "_");
  return !base ? null : /\.scp$/i.test(base) ? base : `${base}.scp`;
}
const stemOf = (name) => name.replace(/\.scp$/i, "");

export function mount(root, host) {
  root.classList.add("solver");
  const decoder = new TextDecoder();

  // ---- Model bar ----
  const nameText = el("span", { className: "solver-name" });
  const picker = el("select", { className: "solver-picker", title: "Open a model from the files panel" });
  const examples = el("select", { className: "solver-examples", title: "Open one of cp-solver's example models" });
  const upload = el("input", { type: "file", accept: ".scp", hidden: true });
  const newButton = button("New", "Start a new model");
  const openButton = button("Open…", "Open a model from this computer (it is added to the files panel)");
  const saveButton = button("Save", "Save the model to the files panel (Ctrl+S)");
  const saveAsButton = button("Save as…", "Save the model to the files panel under a new name");
  const downloadButton = button("Download", "Download the model");
  const bar = el("div", { className: "solver-bar" },
    el("span", { className: "solver-bar-label", textContent: "Model" }), nameText, picker, examples,
    newButton, openButton, upload, saveButton, saveAsButton, downloadButton);

  // ---- Editor (modes/scp-editor.js) ----
  const scp = createScpEditor({ onInput: () => renderState(), onSolve: () => solve() });
  const editor = scp.textarea;
  const editorPane = el("section", { className: "pane pane-model" },
    el("header", { className: "pane-head" }, el("span", { className: "pane-title-text", textContent: "Model (.scp)" }),
      el("span", { className: "solver-hint", textContent: "Ctrl+Space completes · Ctrl+Enter solves" })),
    scp.edit, scp.problems);

  // ---- Result ----
  const resultTitle = el("span", { className: "pane-title-text", textContent: "Result" });
  const filter = el("input", { type: "search", className: "pane-filter", placeholder: "filter" });
  const errors = el("pre", { className: "solver-errors", hidden: true });
  const output = el("div", { className: "solver-output" });
  const resultPane = el("section", { className: "pane pane-result" },
    el("header", { className: "pane-head" }, resultTitle, filter), errors, output);

  const split = el("div");
  const main = el("div", { className: "solver-main" }, editorPane, split, resultPane);

  // ---- Actions ----
  const solveButton = button("Solve", "Solve the model (Ctrl+Enter)");
  solveButton.classList.add("primary");
  const stopButton = button("Stop", "Stop the solver");
  stopButton.hidden = true;
  const verifyButton = button("Verify ▸", "Load the OPB and proof the solver wrote into the REPL (Verify tab)");
  verifyButton.classList.add("primary");
  const message = el("span", { className: "solver-message" });
  message.setAttribute("aria-live", "polite");
  const actions = el("div", { className: "solver-actions" }, solveButton, stopButton, verifyButton, message);

  root.append(bar, main, actions);

  // ---- Layout: the splitter between editor and result, remembered ----
  const setSplit = (fraction) => {
    main.style.gridTemplateColumns = `minmax(0, ${fraction}fr) 6px minmax(0, ${1 - fraction}fr)`;
  };
  try { setSplit(Number(localStorage.getItem(SPLIT_KEY)) || 0.55); } catch { setSplit(0.55); }
  splitter(split, main, {
    axis: "x",
    onMove(fraction) {
      const f = Math.min(0.85, Math.max(0.15, fraction));
      setSplit(f);
      try { localStorage.setItem(SPLIT_KEY, String(f)); } catch {}
    },
    onReset() {
      setSplit(0.55);
      try { localStorage.removeItem(SPLIT_KEY); } catch {}
    },
  });

  // ---- Model state ----
  let name = UNTITLED;
  let saved = "";      // the text as last opened or saved
  let named = false;   // saved to the files panel under `name` at least once
  let solved = null;   // {text, stem} of the last solve that wrote both files
  const dirty = () => editor.value !== saved;

  function renderState() {
    nameText.textContent = `${name}${dirty() ? " •" : ""}`;
    nameText.title = dirty() ? `${name}, edited since it was opened or saved` : name;
    verifyButton.disabled = running || !solved || solved.text !== editor.value;
    verifyButton.title = !solved ? "Solve the model first: Verify loads the OPB and proof it writes"
      : solved.text !== editor.value ? "The model has changed since it was solved: solve it again first"
      : `Load ${solved.stem}.opb and ${solved.stem}.pbp into the REPL (Verify tab)`;
  }
  function setModel(newName, text, { isNamed = true } = {}) {
    name = newName;
    named = isNamed;
    saved = text;
    editor.value = text;
    editor.scrollTop = 0;
    scp.refresh();
    renderState();
  }
  const discardOk = () => !dirty() || confirm(`Discard the changes to ${name}?`);

  root.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); save(); }
  });

  // ---- Opening ----
  async function open(fileName) {
    if (fileName === name && !dirty() && named) return;
    if (!discardOk()) return;
    const data = await host.getFile(fileName);
    if (!data) { note(`${fileName} is not in the files panel.`); return; }
    setModel(fileName, decoder.decode(data));
    note(`Opened ${fileName}.`);
  }

  function refreshPicker() {
    const models = host.files().map((f) => f.name).filter((n) => /\.scp$/i.test(n));
    picker.replaceChildren(el("option", { value: "", textContent: models.length ? "From files…" : "No models in files" }),
      ...models.map((n) => el("option", { value: n, textContent: n })));
    picker.value = "";
  }
  refreshPicker();
  picker.addEventListener("change", () => {
    const chosen = picker.value;
    picker.value = "";
    if (chosen) open(chosen);
  });

  examples.append(el("option", { value: "", textContent: "Examples…" }));
  fetch("pkg/models/index.json").then((r) => (r.ok ? r.json() : [])).then((names) => {
    examples.append(...names.map((n) => el("option", { value: n, textContent: n })));
  }).catch(() => {});
  examples.addEventListener("change", async () => {
    const chosen = examples.value;
    examples.value = "";
    if (!chosen || !discardOk()) return;
    const response = await fetch(`pkg/models/${chosen}`);
    if (!response.ok) { note(`Could not load the example ${chosen}: HTTP ${response.status}.`); return; }
    const data = new Uint8Array(await response.arrayBuffer());
    host.putFile(chosen, data);
    setModel(chosen, decoder.decode(data));
    note(`Opened the example ${chosen} (added to the files panel).`);
  });

  newButton.addEventListener("click", () => {
    if (!discardOk()) return;
    setModel(UNTITLED, TEMPLATE, { isNamed: false });
    editor.focus();
  });

  openButton.addEventListener("click", () => upload.click());
  upload.addEventListener("change", async () => {
    const [file] = upload.files;
    upload.value = "";
    if (!file || !discardOk()) return;
    const fileName = modelName(file.name);
    const data = new Uint8Array(await file.arrayBuffer());
    host.putFile(fileName, data);
    setModel(fileName, decoder.decode(data));
    note(`Opened ${fileName} (added to the files panel).`);
  });

  // ---- Saving ----
  function saveTo(fileName) {
    host.putFile(fileName, new TextEncoder().encode(editor.value));
    name = fileName;
    named = true;
    saved = editor.value;
    renderState();
    note(`Saved ${fileName} to the files panel.`);
  }
  function save() {
    if (named) saveTo(name);
    else saveAs();
  }
  function saveAs() {
    const answer = prompt("Save the model in the files panel as:", name);
    if (answer == null) return;
    const fileName = modelName(answer);
    if (!fileName) return;
    if (fileName !== name && host.files().some((f) => f.name === fileName)
      && !confirm(`${fileName} is already in the files panel. Replace it?`)) return;
    saveTo(fileName);
  }
  saveButton.addEventListener("click", save);
  saveAsButton.addEventListener("click", saveAs);
  downloadButton.addEventListener("click", () => host.download(name, new TextEncoder().encode(editor.value)));

  // ---- Solving ----
  let worker = null;
  let running = false;
  let started = 0;
  let timer = null;
  // cps's stdout; the list is made on the first solve.
  const lines = [];
  let dropped = 0;
  let lastLine = null;
  let answerLine = null;
  let list = null;
  let drawQueued = false;

  const seconds = (ms) => `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
  function drawSoon() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => {
      drawQueued = false;
      const follow = list.atBottom();
      list.update();
      if (follow && running) list.toBottom();
    });
  }
  function showErrors(text) {
    errors.textContent = errors.textContent ? `${errors.textContent}\n${text}` : text;
    errors.hidden = false;
  }
  function finish(title, status) {
    running = false;
    clearInterval(timer);
    resultTitle.textContent = title;
    host.setStatus(status);
    solveButton.disabled = false;
    stopButton.hidden = true;
    drawSoon();
    renderState();
  }

  function startWorker() {
    worker = new Worker(new URL("../solver-worker.js", import.meta.url), { type: "module" });
    worker.onerror = (event) => {
      showErrors(`The solver failed: ${event.message ?? "the worker could not start"}`);
      worker = null;
      if (running) finish("Result: error", "solver failed");
    };
  }

  function solve() {
    if (running) return;
    const text = editor.value;
    const stem = stemOf(name);
    lines.length = 0;
    dropped = 0;
    lastLine = null;
    answerLine = null;
    list ??= createLineList(output, lines, { render: solutionLine });
    list.setFilter(filter.value);
    errors.textContent = "";
    errors.hidden = true;
    solved = null;
    running = true;
    started = performance.now();
    resultTitle.textContent = "Solving…";
    timer = setInterval(() => { resultTitle.textContent = `Solving… ${seconds(performance.now() - started)}`; }, 200);
    solveButton.disabled = true;
    stopButton.hidden = false;
    note(`cps ${stem}.scp --proof ${stem}`);
    renderState();
    if (!worker) startWorker();
    worker.onmessage = ({ data: msg }) => {
      if (msg.type === "out") received(msg.lines);
      else if (msg.type === "err") showErrors(msg.lines.join("\n"));
      else if (msg.type === "fatal") {
        showErrors(`The solver failed: ${msg.text}`);
        finish("Result: error", "solver failed");
      } else if (msg.type === "done") done(msg, text, stem);
    };
    worker.postMessage({ type: "solve", name: `${stem}.scp`, text });
  }

  function received(batch) {
    lastLine = batch.at(-1) ?? lastLine;
    for (const line of batch) if (ANSWER.test(line)) answerLine = line;
    const room = Math.max(0, MAX_LINES - lines.length);
    lines.push(...batch.slice(0, room));
    dropped += Math.max(0, batch.length - room);
    drawSoon();
  }
  // After the run: say how many lines were left out, and show the last.
  function closeLines() {
    if (dropped) lines.push(`… ${dropped.toLocaleString()} more lines not shown …`, lastLine);
  }

  function done({ exit, ms, opb, pbp }, text, stem) {
    closeLines();
    const answer = answerLine;
    const time = seconds(ms);
    if (exit !== 0) {
      finish(`Result: error (exit ${exit}) · ${time}`, `cps: exit ${exit}`);
      note("The solver stopped with an error; no files were written.");
      return;
    }
    if (opb && pbp) {
      host.putFile(`${stem}.opb`, opb);
      host.putFile(`${stem}.pbp`, pbp);
      solved = { text, stem };
      note(`Wrote ${stem}.opb (${bytes(opb.byteLength)}) and ${stem}.pbp (${bytes(pbp.byteLength)}) to the files panel.`);
    } else {
      note("The solver wrote no proof files.");
    }
    finish(`Result: ${answer ?? "done"} · ${time}`, `${answer ?? "done"} · ${time}`);
  }

  stopButton.addEventListener("click", () => {
    if (!running) return;
    worker?.terminate();
    worker = null;
    closeLines();
    finish(`Result: stopped after ${seconds(performance.now() - started)}`, "solver stopped");
    note("Stopped. The output so far is shown; no files were written.");
  });
  solveButton.addEventListener("click", solve);
  verifyButton.addEventListener("click", () => {
    if (solved && solved.text === editor.value) host.verify(solved.stem);
  });
  filter.addEventListener("input", () => list?.setFilter(filter.value));

  function note(text) {
    message.textContent = text;
  }

  setModel(UNTITLED, TEMPLATE, { isNamed: false });
  output.append(el("p", { className: "pane-empty", textContent: "Open a model or an example, or edit this one, then Solve." }));

  return {
    open,
    filesChanged: refreshPicker,
    note,
    focus: () => editor.focus(),
    dirty,
  };
}
