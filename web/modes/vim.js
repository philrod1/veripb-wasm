// Vim-style editing of the Proof pane: the TUI's key set (veripb-repl's
// tui/mod.rs, `VimState` and the `vim_*` methods), with each commit sent to
// the session as one undoable edit (web-repl's vr_buffer_edit). Beyond the
// TUI: in Insert mode, Backspace at a line's start and Delete at its end
// join it with the neighbouring line (the reverse of Enter's split).
//
// createVim({ edit, toggleBreakpoint, note, render, toPrompt, onFocus }) -> vim
//   edit({op, index, text?, after?}) -> Promise<{ok} | {error}>
//   toggleBreakpoint(index); note(text): a line in Output; render(): redraw
//   the Proof pane; toPrompt(text): focus the command line with `text`;
//   onFocus(): put keyboard focus on the Proof pane.
// vim: { active, line, col, mode ("normal" | "insert"), input, text(line),
//        sync(base, generation), startEdit(line), startInsert(n),
//        doubleClick(line), click(line, col), key(event) -> handled, settle(),
//        exit() }
//   Lines are display lines: buffer index i is line i + 3 (two preamble lines).
//   sync({count, get(index) -> text | undefined}, generation) gives the
//   session's lines as last fetched (`get` may only know the lines near the
//   cursor) and the session generation they are from. Edits not yet in them
//   are kept in a log and applied on top, so further keys see each edit at
//   once; an edit leaves the log when a fetch at or after its generation
//   arrives.
//   input is the <input> to place on the cursor line in Insert mode; call
//   settle() after each draw of the Proof pane, to focus it when it was asked
//   for before its row was drawn.

const FIRST = 3;
const EDITING = "Editing — hjkl/arrows to move, i/a/o/O to insert, x to delete a char, dd a line, Esc to leave.";

const clampCol = (col, len) => Math.max(0, Math.min(col, len - 1));

export function createVim({ edit, toggleBreakpoint, note, render, toPrompt, onFocus }) {
  let base = { count: 0, get: () => undefined };
  // Edits not yet in `base`, oldest first: {op, index, text, after, generation}.
  let log = [];
  let queue = Promise.resolve();
  const DELTA = { insert: 1, split: 1, delete: -1, join: -1, set: 0 };
  // Buffer index `i`'s text: through the log, newest edit first, to `base`.
  function get(i) {
    for (let k = log.length - 1; k >= 0; k--) {
      const e = log[k];
      if (e.op === "set" && i === e.index) return e.text;
      if (e.op === "insert") { if (i === e.index) return e.text; if (i > e.index) i -= 1; }
      if (e.op === "delete" && i >= e.index) i += 1;
      if (e.op === "split") { if (i === e.index) return e.text; if (i === e.index + 1) return e.after; if (i > e.index + 1) i -= 1; }
      if (e.op === "join") { if (i === e.index) return e.text; if (i > e.index) i += 1; }
    }
    return base.get(i) ?? "";
  }
  const length = () => log.reduce((n, e) => n + DELTA[e.op], base.count);
  const input = Object.assign(document.createElement("input"), { className: "vim-input", spellcheck: false });
  input.setAttribute("aria-label", "Proof line (Insert mode)");
  const vim = { active: false, line: FIRST, col: 0, mode: "normal", pendingD: false, input };

  const maxLine = () => FIRST + length() - 1;
  const text = (line) => get(line - FIRST);
  const index = (line) => line - FIRST;
  const editable = (line) => line >= FIRST && line <= maxLine();

  // Sends one edit, logging it so further keys see it before the session's
  // new lines arrive.
  function commit(op) {
    const entry = { ...op, generation: undefined };
    log.push(entry);
    queue = queue.then(() => edit(op)).then((result) => {
      entry.generation = result?.generation ?? -1;
      if (result?.error) note(`Error: ${result.error}`);
    });
  }

  // Focuses the Insert-mode input with the caret at `caret`, now if its row
  // is drawn, else when settle() finds it drawn.
  let pendingCaret = null;
  function focusInput(caret) {
    pendingCaret = caret;
    settle();
  }
  function settle() {
    if (pendingCaret == null || !vim.active || vim.mode !== "insert" || !input.isConnected) return;
    input.focus({ preventScroll: true });
    input.setSelectionRange(pendingCaret, pendingCaret);
    pendingCaret = null;
  }

  function start(line) {
    Object.assign(vim, { active: true, line, col: 0, mode: "normal", pendingD: false });
    onFocus();
    render();
  }

  function enterInsert(after) {
    const len = text(vim.line).length;
    if (after) vim.col = Math.min(vim.col + 1, len);
    vim.mode = "insert";
    input.value = text(vim.line);
    render();
    focusInput(vim.col);
  }

  function commitInsert() {
    const caret = input.selectionStart ?? input.value.length;
    const value = input.value;
    const i = index(vim.line);
    if (get(i) !== value) commit({ op: "set", index: i, text: value });
    vim.mode = "normal";
    vim.col = clampCol(caret, value.length);
    onFocus();
    render();
  }

  // Insert mode: move to another line, committing this one if it changed.
  function insertMoveTo(line, col) {
    if (line === vim.line || !editable(line)) return;
    const i = index(vim.line);
    const value = input.value;
    if (get(i) !== value) commit({ op: "set", index: i, text: value });
    vim.line = line;
    vim.col = Math.min(col, text(line).length);
    input.value = text(line);
    render();
    focusInput(vim.col);
  }

  function insertNewline() {
    const caret = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, caret);
    const after = input.value.slice(caret);
    const i = index(vim.line);
    commit({ op: "split", index: i, text: before, after });
    vim.line += 1;
    vim.col = 0;
    input.value = after;
    render();
    focusInput(0);
  }

  // Insert mode: join line `upper` and the line after it, the caret at the seam.
  function joinLines(upper) {
    const i = index(upper);
    const first = upper === vim.line ? input.value : text(upper);
    const second = upper === vim.line ? text(upper + 1) : input.value;
    const merged = first + second;
    commit({ op: "join", index: i, text: merged });
    vim.line = upper;
    vim.col = first.length;
    input.value = merged;
    render();
    focusInput(vim.col);
  }

  function openLine(below) {
    if (!editable(vim.line)) return note(`Error: line ${vim.line} is the synthesized preamble or past the end of the proof — nowhere to open a new line there.`);
    const at = index(vim.line) + (below ? 1 : 0);
    commit({ op: "insert", index: at, text: "" });
    vim.line = at + FIRST;
    vim.col = 0;
    enterInsert(false);
  }

  function deleteChar() {
    const i = index(vim.line);
    const current = text(vim.line);
    if (vim.col >= current.length) return;
    const next = current.slice(0, vim.col) + current.slice(vim.col + 1);
    commit({ op: "set", index: i, text: next });
    vim.col = clampCol(vim.col, next.length);
    render();
  }

  function deleteLine() {
    const i = index(vim.line);
    commit({ op: "delete", index: i });
    if (!length()) {
      vim.active = false;
      note("Left the editor — no proof lines left to edit.");
      toPrompt("");
      return render();
    }
    vim.line = Math.max(FIRST, Math.min(vim.line, maxLine()));
    vim.col = clampCol(vim.col, text(vim.line).length);
    render();
  }

  function wordLeft() {
    const t = text(vim.line);
    let i = Math.min(vim.col, t.length);
    while (i > 0 && /\s/.test(t[i - 1])) i -= 1;
    while (i > 0 && !/\s/.test(t[i - 1])) i -= 1;
    vim.col = i;
  }

  function wordRight() {
    const t = text(vim.line);
    let i = Math.min(vim.col, t.length);
    while (i < t.length && !/\s/.test(t[i])) i += 1;
    while (i < t.length && /\s/.test(t[i])) i += 1;
    vim.col = clampCol(i, t.length);
  }

  function moveVertical(delta) {
    vim.line = Math.max(FIRST, Math.min(vim.line + delta, maxLine()));
    vim.col = clampCol(vim.col, text(vim.line).length);
  }

  /** Normal mode: one key. Returns whether it was handled (and so swallowed). */
  function normalKey(event) {
    const { key } = event;
    const word = event.ctrlKey || event.altKey;
    if (event.metaKey || (event.ctrlKey && !["ArrowLeft", "ArrowRight"].includes(key))) return false;
    if (key !== "d") vim.pendingD = false;
    switch (key) {
      case "ArrowLeft": if (word) wordLeft(); else vim.col = Math.max(0, vim.col - 1); break;
      case "ArrowRight": if (word) wordRight(); else vim.col = clampCol(vim.col + 1, text(vim.line).length); break;
      case "h": vim.col = Math.max(0, vim.col - 1); break;
      case "l": vim.col = clampCol(vim.col + 1, text(vim.line).length); break;
      case "k": case "ArrowUp": moveVertical(-1); break;
      case "j": case "ArrowDown": moveVertical(1); break;
      case "i": return enterInsert(false), true;
      case "a": return enterInsert(true), true;
      case "o": return openLine(true), true;
      case "O": return openLine(false), true;
      case "x": return deleteChar(), true;
      case "b": toggleBreakpoint(index(vim.line)); return true;
      case "d":
        if (vim.pendingD) { vim.pendingD = false; deleteLine(); } else vim.pendingD = true;
        return true;
      case ":":
        vim.active = false;
        render();
        toPrompt(":");
        return true;
      case "Escape":
        vim.active = false;
        note("Left the editor.");
        render();
        toPrompt("");
        return true;
      default:
        // Normal mode types nothing; other printable keys are no-ops.
        return key.length === 1;
    }
    render();
    return true;
  }

  input.addEventListener("keydown", (event) => {
    if (!vim.active || vim.mode !== "insert") return;
    const caret = input.selectionStart;
    const collapsed = caret === input.selectionEnd;
    let handled = true;
    if (event.key === "Escape") commitInsert();
    else if (event.key === "Enter") insertNewline();
    else if (event.key === "Backspace" && collapsed && caret === 0 && vim.line > FIRST) joinLines(vim.line - 1);
    else if (event.key === "Delete" && collapsed && caret === input.value.length && vim.line < maxLine()) joinLines(vim.line);
    else if (event.key === "ArrowUp") insertMoveTo(Math.max(FIRST, vim.line - 1), caret);
    else if (event.key === "ArrowDown") insertMoveTo(Math.min(maxLine(), vim.line + 1), caret);
    else if (event.key === "ArrowLeft" && collapsed && caret === 0 && vim.line > FIRST && !event.shiftKey) insertMoveTo(vim.line - 1, text(vim.line - 1).length);
    else if (event.key === "ArrowRight" && collapsed && caret === input.value.length && vim.line < maxLine() && !event.shiftKey) insertMoveTo(vim.line + 1, 0);
    else handled = false;
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  });

  return Object.assign(vim, {
    text,
    sync(next, generation) {
      base = next;
      log = log.filter((e) => e.generation === undefined || e.generation > generation);
      if (!vim.active) return;
      if (!length()) {
        vim.active = false;
        note("Left the editor — no proof lines left to edit.");
        return;
      }
      if (vim.mode === "normal") {
        vim.line = Math.max(FIRST, Math.min(vim.line, maxLine()));
        vim.col = clampCol(vim.col, text(vim.line).length);
      }
    },
    /** `:edit [<n>[-<m>]]`: Normal mode on `n` (default: the last line). */
    startEdit(arg) {
      if (!length()) return note("Error: no proof lines yet to edit.");
      const m = arg.trim().match(/^(\d+)(?:-\d+)?$/);
      if (arg.trim() && !m) return note("Error: usage :edit [<n>] | :edit <n>-<m>");
      const line = m ? Number(m[1]) : maxLine();
      if (!editable(line)) return note(`Error: line ${line} is the synthesized preamble or past the end of the proof.`);
      start(line);
      note(EDITING);
    },
    /** `:insert <n>`: a blank line before `n` (or at the end), in Insert mode. */
    startInsert(arg) {
      const n = Number(arg.trim());
      if (!/^\d+$/.test(arg.trim())) return note("Error: usage :insert <n>");
      const end = FIRST + length();
      if (n !== end && !editable(n)) {
        return note(`Error: line ${n} is the synthesized preamble or past the end of the proof — nowhere to insert there. Use :insert ${end} to add lines at the end, or just type them normally.`);
      }
      const at = n - FIRST;
      commit({ op: "insert", index: at, text: "" });
      start(n);
      note("Inserting — type the new line, then Esc once you're satisfied.");
      enterInsert(false);
    },
    /** Double-click: enter Normal mode on `line`, or move there (not mid-insert). */
    doubleClick(line) {
      if (!editable(line)) return;
      if (vim.active && vim.mode === "insert") return;
      if (vim.active) {
        vim.line = line;
        vim.col = 0;
        onFocus();
        render();
      } else {
        start(line);
        note(EDITING);
      }
    },
    /** A click in Normal mode: put the cursor there. */
    click(line, col) {
      if (!vim.active || vim.mode !== "normal" || !editable(line)) return;
      vim.line = line;
      vim.col = clampCol(col, text(line).length);
      onFocus();
      render();
    },
    key: normalKey,
    settle,
    exit() {
      if (!vim.active) return;
      if (vim.mode === "insert") commitInsert();
      vim.active = false;
      render();
    },
  });
}
