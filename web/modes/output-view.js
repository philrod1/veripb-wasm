// REPL output pane and command line, shared by plain and enhanced modes.
//
// Output lines arrive in batches with per-line `trace` flags (repl-worker.js):
// veripb's own lines are collected into a <details> block per run of
// consecutive lines. A block starts open and closes once it passes
// FOLD_LINES lines. Blank lines inside a block belong to it; blank lines
// after its last line do not. For commands in SHOW_IN_FULL the veripb lines
// are shown as ordinary output.
//
// `transcript` keeps every line as received (echoed input included,
// nothing folded); `onTranscript(lines)` is called with each new batch.

export const PROMPTS = ["pbp> ", "edit> ", "opb> ", "debug> "];
export const MODE_QUIT = 4;
const FOLD_LINES = 20;

// Resolution mirrors the REPL's `resolve_command`: exact name, else a
// unique prefix of COMMANDS.
const COMMANDS = ["check", "show", "explain", "list", "objective", "preserved", "undo", "delete",
  "formula", "debug", "insert", "reset", "load", "instance", "source", "verify", "save", "edit",
  "deassert", "help", "theme", "quit"];
const SHOW_IN_FULL = new Set(["check", "show", "explain", "list", "objective", "preserved", "help"]);
export function resolveCommand(text) {
  const word = text.trim().match(/^:(\S+)/)?.[1];
  if (!word) return null;
  if (COMMANDS.includes(word)) return word;
  const matches = COMMANDS.filter((name) => name.startsWith(word));
  return matches.length === 1 ? matches[0] : null;
}

const isError = (line) => line.startsWith("Error") || line.startsWith("[host]");

export class OutputView {
  /** `onSubmit(text)` runs an input line; the view disables input until `setMode`. */
  constructor({ onSubmit, onTranscript } = {}) {
    this.onSubmit = onSubmit;
    this.onTranscript = onTranscript;
    this.transcript = [];
    this.mode = null;
    this.history = [];
    this.historyPos = 0;
    this.loading = true;
    this.foldTrace = true;
    this.traceBlock = null;
    this.traceBlanks = [];

    this.out = Object.assign(document.createElement("pre"), { className: "plain-out" });
    this.out.appendChild(Object.assign(document.createElement("span"), { className: "note", textContent: "Loading WebAssembly modules…\n" }));
    this.form = Object.assign(document.createElement("form"), { className: "plain-form", autocomplete: "off" });
    this.prompt = Object.assign(document.createElement("span"), { className: "plain-prompt" });
    this.input = Object.assign(document.createElement("input"), { className: "plain-in", spellcheck: false, disabled: true });
    this.input.setAttribute("aria-label", "REPL input");
    this.form.append(this.prompt, this.input);

    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!this.input.disabled) this.submit(this.input.value);
    });
    this.input.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      this.historyPos = Math.max(0, Math.min(this.history.length, this.historyPos + (event.key === "ArrowUp" ? -1 : 1)));
      this.input.value = this.history[this.historyPos] ?? "";
    });
    this.out.addEventListener("click", () => { if (!getSelection().toString()) this.focus(); });
  }

  /** Runs `text` as if typed (echo, history, fold rule, then onSubmit). */
  submit(text) {
    this.append(PROMPTS[this.mode] + text, "echo");
    this.foldTrace = !SHOW_IN_FULL.has(resolveCommand(text));
    if (text.trim() && this.history[this.history.length - 1] !== text) this.history.push(text);
    this.historyPos = this.history.length;
    this.input.value = "";
    this.setReady(false);
    this.onSubmit?.(text);
  }

  ready() {
    return !this.input.disabled;
  }

  setReady(ready) {
    this.input.disabled = !ready;
    if (ready) this.input.focus();
  }

  focus() {
    this.input.focus();
  }

  /** Sets the input line without running it. */
  prefill(text) {
    this.input.value = text;
    this.focus();
  }

  #clearLoading() {
    if (this.loading) this.out.textContent = "";
    this.loading = false;
  }

  #newTraceBlock() {
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
  #endTrace() {
    const text = this.traceBlanks.map((l) => l + "\n").join("");
    this.traceBlock = null;
    this.traceBlanks = [];
    return text;
  }

  /**
   * Appends lines in one DOM update. `cls` styles every line; otherwise
   * error lines get the "error" style, and lines with trace[i] go into a
   * trace block. Layout is read once per call.
   */
  append(lines, cls, trace) {
    this.#clearLoading();
    if (typeof lines === "string") lines = [lines];
    if (cls !== "note") {
      this.transcript.push(...lines);
      this.onTranscript?.(lines);
    }
    const out = this.out;
    const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
    const fragment = document.createDocumentFragment();
    let plain = "";
    const flushPlain = () => {
      if (plain) fragment.appendChild(document.createTextNode(plain));
      plain = "";
    };
    lines.forEach((line, i) => {
      if (trace?.[i] && !cls && this.foldTrace) {
        if (!this.traceBlock) {
          flushPlain();
          this.traceBlock = this.#newTraceBlock();
          fragment.appendChild(this.traceBlock.details);
        }
        this.traceBlock.add([...this.traceBlanks, line]);
        this.traceBlanks = [];
        return;
      }
      if (this.traceBlock && !cls && line.trim() === "") {
        this.traceBlanks.push(line);
        return;
      }
      plain += this.#endTrace();
      const style = cls ?? (isError(line) ? "error" : null);
      if (!style) { plain += line + "\n"; return; }
      flushPlain();
      fragment.appendChild(Object.assign(document.createElement("span"), { className: style, textContent: line + "\n" }));
    });
    flushPlain();
    out.appendChild(fragment);
    if (atBottom) out.scrollTop = out.scrollHeight;
  }

  /**
   * The REPL finished a command and is in prompt mode `mode` (or quit/failed).
   * Also used after a command the page answers itself, with the current mode.
   */
  setMode(mode) {
    const trailing = this.#endTrace();
    if (trailing) this.out.appendChild(document.createTextNode(trailing));
    this.#clearLoading();
    this.mode = mode;
    if (mode === MODE_QUIT || mode < 0) {
      this.append(mode === MODE_QUIT ? "Session ended. Switch mode or reload the page to start again." : "Startup failed.", "note");
      this.prompt.textContent = "";
      this.setReady(false);
    } else {
      this.prompt.textContent = PROMPTS[mode];
      this.setReady(true);
    }
  }
}
