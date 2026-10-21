// Plain mode: veripb-repl's `--plain` line interface, run by plain-worker.js.
//
// Mode interface (shared by all modes, see shell.js):
//   mount(root, host) -> instance
//     root: element to render into (emptied by the shell on unmount)
//     host: { files: Map<name, Uint8Array>, setStatus(text), setFiles([{name, size}]) }
//   instance: { putFile(name, bytes), getFile(name) -> Promise<Uint8Array|null>,
//               snapshot() -> Promise<Map<name, Uint8Array>>, note(text), focus(), unmount() }

const PROMPTS = ["pbp> ", "edit> ", "opb> ", "debug> "];
const MODE_QUIT = 4;

// veripb's own output lines (flagged by the worker) are collected into a
// <details> block per run of consecutive lines. A block starts open and
// closes once it passes FOLD_LINES lines. Blank lines inside a block belong
// to it; blank lines after its last line do not.
const FOLD_LINES = 20;

// Commands whose output is what the user asked to see: their veripb lines
// are shown as ordinary output, never folded. Resolution mirrors the REPL's
// `resolve_command`: exact name, else a unique prefix of COMMANDS.
const COMMANDS = ["check", "show", "explain", "list", "objective", "preserved", "undo", "delete",
  "formula", "debug", "insert", "reset", "load", "instance", "source", "verify", "save", "edit",
  "deassert", "help", "theme", "quit"];
const SHOW_IN_FULL = new Set(["check", "show", "explain", "list", "objective", "preserved", "help"]);
function resolveCommand(text) {
  const word = text.trim().match(/^:(\S+)/)?.[1];
  if (!word) return null;
  if (COMMANDS.includes(word)) return word;
  const matches = COMMANDS.filter((name) => name.startsWith(word));
  return matches.length === 1 ? matches[0] : null;
}

const isError = (line) => line.startsWith("Error") || line.startsWith("[host]");

export function mount(root, host) {
  root.classList.add("plain");
  const out = Object.assign(document.createElement("pre"), { className: "plain-out" });
  out.appendChild(Object.assign(document.createElement("span"), { className: "note", textContent: "Loading WebAssembly modules…\n" }));
  const form = Object.assign(document.createElement("form"), { className: "plain-form", autocomplete: "off" });
  const prompt = Object.assign(document.createElement("span"), { className: "plain-prompt" });
  const input = Object.assign(document.createElement("input"), { className: "plain-in", spellcheck: false, disabled: true });
  input.setAttribute("aria-label", "REPL input");
  form.append(prompt, input);
  root.append(out, form);

  const worker = new Worker(new URL("../plain-worker.js", import.meta.url), { type: "module" });
  let mode = null;
  const history = [];
  let historyPos = 0;
  let nextId = 1;
  const waiting = new Map();
  const request = (message) => new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    worker.postMessage({ ...message, id });
  });

  // The "Loading…" note is removed by the first output or prompt.
  let loading = true;
  function clearLoading() {
    if (loading) out.textContent = "";
    loading = false;
  }

  let foldTrace = true;
  let traceBlock = null;
  let traceBlanks = [];

  function newTraceBlock() {
    const details = Object.assign(document.createElement("details"), { className: "trace", open: true });
    const summary = document.createElement("summary");
    const body = Object.assign(document.createElement("div"), { className: "body" });
    details.append(summary, body);
    let count = 0;
    return {
      details,
      add(lines) {
        body.appendChild(document.createTextNode(lines.map((l) => l + "\n").join("")));
        const before = count;
        count += lines.length;
        if (before <= FOLD_LINES && count > FOLD_LINES) details.open = false;
        summary.textContent = `veripb output · ${count} line${count === 1 ? "" : "s"}`;
      },
    };
  }

  // Closes the current trace block; returns its trailing blank lines as text.
  function endTrace() {
    const text = traceBlanks.map((l) => l + "\n").join("");
    traceBlock = null;
    traceBlanks = [];
    return text;
  }

  // Appends lines in one DOM update. `cls` styles every line; otherwise error
  // lines get the "error" style, and lines with trace[i] go into a trace
  // block. Layout is read once per call.
  function append(lines, cls, trace) {
    clearLoading();
    if (typeof lines === "string") lines = [lines];
    const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
    const fragment = document.createDocumentFragment();
    let plain = "";
    const flushPlain = () => {
      if (plain) fragment.appendChild(document.createTextNode(plain));
      plain = "";
    };
    lines.forEach((line, i) => {
      if (trace?.[i] && !cls && foldTrace) {
        if (!traceBlock) {
          flushPlain();
          traceBlock = newTraceBlock();
          fragment.appendChild(traceBlock.details);
        }
        traceBlock.add([...traceBlanks, line]);
        traceBlanks = [];
        return;
      }
      if (traceBlock && !cls && line.trim() === "") {
        traceBlanks.push(line);
        return;
      }
      plain += endTrace();
      const style = cls ?? (isError(line) ? "error" : null);
      if (!style) { plain += line + "\n"; return; }
      flushPlain();
      fragment.appendChild(Object.assign(document.createElement("span"), { className: style, textContent: line + "\n" }));
    });
    flushPlain();
    out.appendChild(fragment);
    if (atBottom) out.scrollTop = out.scrollHeight;
  }

  function setReady(ready) {
    input.disabled = !ready;
    if (ready) input.focus();
  }

  worker.onmessage = ({ data: message }) => {
    switch (message.type) {
      case "out":
        append(message.lines, null, message.trace);
        break;
      case "mode": {
        const trailing = endTrace();
        if (trailing) out.appendChild(document.createTextNode(trailing));
        if (mode === null) clearLoading();
        mode = message.mode;
        if (message.ms > 0) {
          host.setStatus(`${message.ms.toFixed(0)} ms · ${message.veripbRuns} veripb run${message.veripbRuns === 1 ? "" : "s"}`);
        }
        if (mode === MODE_QUIT || mode < 0) {
          append(mode === MODE_QUIT ? "Session ended. Switch mode or reload the page to start again." : "Startup failed.", "note");
          prompt.textContent = "";
          setReady(false);
        } else {
          prompt.textContent = PROMPTS[mode];
          setReady(true);
        }
        break;
      }
      case "files":
        host.setFiles(message.files);
        break;
      case "file":
      case "dump":
        waiting.get(message.id)?.(message.type === "file" ? message.data : new Map(message.files));
        waiting.delete(message.id);
        break;
      case "fatal":
        append(`Internal error: ${message.text}\nReload the page to start again.`, "error");
        setReady(false);
        break;
    }
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (input.disabled) return;
    const text = input.value;
    append(PROMPTS[mode] + text, "echo");
    foldTrace = !SHOW_IN_FULL.has(resolveCommand(text));
    if (text.trim() && history[history.length - 1] !== text) history.push(text);
    historyPos = history.length;
    input.value = "";
    setReady(false);
    worker.postMessage({ type: "line", text });
  });

  input.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    historyPos = Math.max(0, Math.min(history.length, historyPos + (event.key === "ArrowUp" ? -1 : 1)));
    input.value = history[historyPos] ?? "";
  });

  out.addEventListener("click", () => { if (!getSelection().toString()) input.focus(); });

  const putFile = (name, bytes) => worker.postMessage({ type: "put", name, data: bytes });
  for (const [name, bytes] of host.files) putFile(name, bytes);

  return {
    putFile,
    getFile: (name) => request({ type: "get", name }),
    snapshot: () => request({ type: "dump" }),
    note: (text) => append(text, "note"),
    focus: () => input.focus(),
    unmount() {
      worker.terminate();
      root.classList.remove("plain");
    },
  };
}
