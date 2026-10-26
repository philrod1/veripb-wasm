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

import { createLineList } from "./linelist.js";

export const PROMPTS = ["pbp> ", "edit> ", "opb> ", "debug> "];
export const MODE_QUIT = 4;
const FOLD_LINES = 20;
// A folded block of more lines than this is shown, once opened, as a virtual
// list (modes/linelist.js) rather than as text.
const LIST_LINES = 2000;

// Resolution mirrors the REPL's `resolve_command`: exact name, else a
// unique prefix of the REPL's commands (`setCommands`, from `vr_commands`).
let COMMANDS = [];
export function setCommands(names) {
  COMMANDS = names;
}
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
  /**
   * `onSubmit(text)` runs an input line; the view disables input until
   * `setMode`. `complete(text)`, if given, returns (a promise of) the REPL's
   * completion result `{candidates: [{line, left, right}], selected, common}`
   * and turns on the suggestion strip and Tab completion (`suggest`).
   * `onMode(mode)`, if given, runs after each `setMode` that leaves the
   * input ready. `progressTotal()`, if given, returns the proof's last line
   * number, for "line n of m" while a command runs. `onReady(ready)`, if
   * given, runs whenever the input is enabled or disabled.
   */
  constructor({ onSubmit, onTranscript, onMode, onReady, complete, progressTotal } = {}) {
    this.onReady = onReady;
    this.onSubmit = onSubmit;
    this.onMode = onMode;
    this.progressTotal = progressTotal;
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
    // While a command runs: what it is, for how long, and veripb's progress.
    this.busy = Object.assign(document.createElement("span"), { className: "busy", hidden: true });
    this.busy.setAttribute("aria-live", "polite");
    this.form.append(this.prompt, this.input, this.busy);
    // What a mode puts below its output: the form, plus the suggestion
    // strip when completion is on.
    this.commandLine = this.form;
    if (complete) this.#initCompletion(complete);

    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!this.input.disabled) this.submit(this.input.value);
    });
    this.input.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      // With suggestions showing, the arrows move the highlight instead.
      if (this.candidates?.length && !this.browsingHistory) return;
      event.preventDefault();
      this.historyPos = Math.max(0, Math.min(this.history.length, this.historyPos + (event.key === "ArrowUp" ? -1 : 1)));
      this.input.value = this.history[this.historyPos] ?? "";
      this.browsingHistory = this.historyPos < this.history.length;
      this.#refreshSuggestions?.();
    });
    this.out.addEventListener("click", () => { if (!getSelection().toString()) this.focus(); });
  }

  /** Runs `text` as if typed (echo, history, fold rule, then onSubmit). */
  submit(text) {
    if (this.strip) {
      this.candidates = [];
      this.strip.hidden = true;
    }
    this.append(PROMPTS[this.mode] + text, "echo");
    this.foldTrace = !SHOW_IN_FULL.has(resolveCommand(text));
    if (text.trim() && this.history[this.history.length - 1] !== text) this.history.push(text);
    this.historyPos = this.history.length;
    this.input.value = "";
    this.setReady(false);
    this.#startBusy(text);
    this.onSubmit?.(text);
  }

  // ---- Progress while a command runs ----
  //
  // Shown after half a second, so quick commands don't flicker: the command,
  // the time so far, which veripb run (if more than one) and the last proof
  // line it traced.
  #startBusy(text) {
    this.#stopBusy();
    const started = performance.now();
    this.progress = null;
    this.firstRun = null;
    this.busyTimer = setInterval(() => {
      const seconds = (performance.now() - started) / 1000;
      if (seconds < 0.5) return;
      const parts = [`${text.trim()} · ${seconds.toFixed(0)} s`];
      // Runs counted from this command's first.
      const { run, line } = this.progress ?? {};
      if (run - this.firstRun > 0) parts.push(`veripb run ${run - this.firstRun + 1}`);
      if (line) {
        const total = this.progressTotal?.();
        const of = total ? ` of ${total.toLocaleString()} (${Math.min(100, Math.floor((100 * line) / total))}%)` : "";
        parts.push(`line ${line.toLocaleString()}${of}`);
      }
      this.busy.textContent = parts.join(" · ");
      this.busy.hidden = false;
    }, 200);
  }

  #stopBusy() {
    clearInterval(this.busyTimer);
    this.busyTimer = null;
    this.busy.hidden = true;
  }

  /** veripb's progress during the running command: `{run, line}`. */
  setProgress(progress) {
    this.firstRun ??= progress.run;
    this.progress = { ...this.progress, ...progress, line: progress.line ?? (progress.run === this.progress?.run ? this.progress.line : null) };
  }

  ready() {
    return !this.input.disabled;
  }

  /** Runs `text` as if typed, or notes that the REPL is busy. */
  run(text) {
    if (this.ready()) this.submit(text);
    else this.append(`Busy: ${text} not run. Try again when the prompt returns.`, "note");
  }

  setReady(ready) {
    this.input.disabled = !ready;
    if (ready) this.input.focus();
    this.onReady?.(ready);
  }

  focus() {
    this.input.focus();
  }

  /** Sets the input line without running it. */
  prefill(text) {
    this.input.value = text;
    this.browsingHistory = false;
    this.#refreshSuggestions?.();
    this.focus();
  }

  // ---- Suggestion strip and Tab completion ----
  //
  // Follows the TUI (`tui::App`): candidates are recomputed whenever the
  // line changes; the highlight resets on a change and then takes the
  // completer's default pick; ↑/↓ move it (wrapping); Tab inserts the
  // highlighted candidate, or the only one, or the candidates' longest
  // common prefix. Nothing is submitted by Tab. Candidates are suppressed
  // while walking the history, until the line is edited or Tab is pressed.
  #refreshSuggestions = null;

  #initCompletion(complete) {
    this.candidates = [];
    this.selected = null;
    this.common = "";
    this.browsingHistory = false;
    let candidatesFor = null;
    let generation = 0;
    this.strip = Object.assign(document.createElement("div"), { className: "suggest", hidden: true });
    this.strip.setAttribute("role", "listbox");
    this.commandLine = Object.assign(document.createElement("div"), { className: "command-line" });
    this.commandLine.append(this.strip, this.form);

    const render = () => {
      this.strip.hidden = !this.candidates.length;
      this.strip.replaceChildren(...this.candidates.map((c, i) => {
        const row = Object.assign(document.createElement("div"), { className: `suggestion${i === this.selected ? " selected" : ""}` });
        row.setAttribute("role", "option");
        row.append(
          Object.assign(document.createElement("span"), { className: "left", textContent: c.left }),
          Object.assign(document.createElement("span"), { className: "right", textContent: c.right }),
        );
        row.addEventListener("mousedown", (event) => {
          event.preventDefault();
          this.#setLine(c.line);
        });
        return row;
      }));
      this.strip.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
    };

    this.#refreshSuggestions = async () => {
      const text = this.input.value;
      const mine = ++generation;
      if (this.browsingHistory || this.input.disabled) {
        this.candidates = [];
        render();
        return;
      }
      const result = text.trim() ? await complete(text) : { candidates: [], selected: null, common: "" };
      if (mine !== generation) return;
      if (text !== candidatesFor) {
        this.selected = null;
        candidatesFor = text;
      }
      this.candidates = result?.candidates ?? [];
      this.common = result?.common ?? "";
      if (this.selected != null && this.selected >= this.candidates.length) this.selected = null;
      if (this.selected == null) this.selected = result?.selected ?? null;
      render();
    };

    this.input.addEventListener("input", () => {
      this.browsingHistory = false;
      this.#refreshSuggestions();
    });
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Tab" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        if (this.browsingHistory) {
          this.browsingHistory = false;
          this.#refreshSuggestions().then(() => this.#tab());
        } else {
          this.#tab();
        }
        return;
      }
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && this.candidates.length && !this.browsingHistory) {
        event.preventDefault();
        const len = this.candidates.length;
        this.selected = event.key === "ArrowDown"
          ? (this.selected == null ? 0 : (this.selected + 1) % len)
          : (this.selected == null ? len - 1 : (this.selected + len - 1) % len);
        render();
      }
      if (event.key === "Escape" && this.candidates.length) {
        event.preventDefault();
        this.candidates = [];
        render();
      }
    });
  }

  #setLine(line) {
    this.input.value = line;
    this.input.setSelectionRange(line.length, line.length);
    this.browsingHistory = false;
    this.#refreshSuggestions?.();
    this.focus();
  }

  #tab() {
    const { candidates, selected } = this;
    if (selected != null && selected < candidates.length) this.#setLine(candidates[selected].line);
    else if (candidates.length === 1) this.#setLine(candidates[0].line);
    else if (candidates.length > 1 && this.common) this.#setLine(this.common);
  }

  #clearLoading() {
    if (this.loading) this.out.textContent = "";
    this.loading = false;
  }

  // A run's veripb lines, folded. They are drawn only while the block is
  // open: as text, or as a virtual list past LIST_LINES lines.
  #newTraceBlock() {
    const details = Object.assign(document.createElement("details"), { className: "trace", open: true });
    const summary = document.createElement("summary");
    const body = Object.assign(document.createElement("div"), { className: "body" });
    details.append(summary, body);
    const lines = [];
    let drawn = 0;
    let list = null;
    const show = () => {
      if (!details.open) return;
      if (lines.length > LIST_LINES) {
        if (!list) {
          body.textContent = "";
          body.classList.add("trace-list");
          list = createLineList(body, lines);
        }
        list.update();
      } else if (drawn < lines.length) {
        body.appendChild(document.createTextNode(lines.slice(drawn).map((l) => l + "\n").join("")));
        drawn = lines.length;
      }
    };
    details.addEventListener("toggle", show);
    return {
      details,
      add(more) {
        const before = lines.length;
        for (const line of more) lines.push(line);
        if (before <= FOLD_LINES && lines.length > FOLD_LINES) details.open = false;
        summary.textContent = `veripb output · ${lines.length} line${lines.length === 1 ? "" : "s"}`;
        show();
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
    this.#stopBusy();
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
      this.onMode?.(mode);
    }
  }
}
