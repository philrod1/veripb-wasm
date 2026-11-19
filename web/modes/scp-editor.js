// The Solver tab's model editor: a textarea with line numbers, highlighting
// (modes/scp-syntax.js), live diagnostics from cp-solver's checker
// (check-worker.js), bracket matching, auto-closed brackets, completion of
// variable names and constraint kinds, and the signature of the constraint
// at the caret (kinds from `cps --constraints --json`).
//
// createScpEditor({ onInput, onSolve }) -> { edit, signature, problems, textarea, refresh(), focus() }
//   edit: the editing area; signature and problems: the constraint at the
//   caret and the Problems list, to place below it in that order;
//   onInput(): after each change to the text; onSolve(): Ctrl+Enter.
//   refresh(): redraw and re-check after the text is set from outside.
//
// The textarea's text is transparent over `highlight`, a copy of it in
// coloured spans kept at the same scroll position; marks on the copy show
// errors (scp-err) and the bracket pair at the caret (scp-match).

import { completionContext, highlightScp, matchingBracket } from "./scp-syntax.js";

// Models past this many characters are shown without highlighting.
const HIGHLIGHT_LIMIT = 256 * 1024;
// Checked once typing pauses this long (ms).
const CHECK_DELAY = 300;
const MAX_SUGGESTIONS = 50;
const KIND_NOTES = { syntax: "syntax", malformed: "error", unsupported: "not supported yet" };

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

/** Inserts `text` over the selection, as typing would (so it can be undone). */
function insert(textarea, text) {
  if (!document.execCommand?.("insertText", false, text)) {
    textarea.setRangeText(text, textarea.selectionStart, textarea.selectionEnd, "end");
    textarea.dispatchEvent(new Event("input"));
  }
}

/** The string offset of 1-based `line` and `column` (in characters) in `text`. */
function offsetOf(text, line, column) {
  let at = 0;
  for (let l = 1; l < line; l++) {
    const next = text.indexOf("\n", at);
    if (next < 0) return text.length;
    at = next + 1;
  }
  for (let c = 1; c < column && at < text.length && text[at] !== "\n"; c++) {
    at += text.codePointAt(at) > 0xffff ? 2 : 1;
  }
  return at;
}

export function createScpEditor({ onInput, onSolve }) {
  const gutter = el("pre", { className: "solver-gutter" });
  gutter.setAttribute("aria-hidden", "true");
  const highlight = el("pre", { className: "solver-highlight" });
  highlight.setAttribute("aria-hidden", "true");
  const textarea = el("textarea", { className: "solver-editor", spellcheck: false, wrap: "off" });
  textarea.setAttribute("aria-label", "Model");
  textarea.setAttribute("autocapitalize", "off");
  textarea.setAttribute("autocomplete", "off");
  const options = el("ul", { className: "scp-options" });
  options.setAttribute("role", "listbox");
  const optionNote = el("div", { className: "scp-option-note", hidden: true });
  const popup = el("div", { className: "scp-complete", hidden: true }, options, optionNote);
  const edit = el("div", { className: "solver-edit" }, gutter, el("div", { className: "solver-code" }, highlight, textarea, popup));

  // The constraint at the caret: its kind, arguments and what it says.
  const signature = el("div", { className: "solver-signature", hidden: true });
  const problemsTitle = el("span", { className: "solver-problems-title" });
  const problemsList = el("ul", { className: "solver-problems-list" });
  const problems = el("div", { className: "solver-problems" }, problemsTitle, problemsList);

  // ---- Drawing ----
  // [{from, to, line, column, kind, message}] for `checkedText`.
  let diagnostics = [];
  let checkedText = null;
  let checkFailed = null;
  let bracket = null;

  function render() {
    const text = textarea.value;
    const lines = text.split("\n").length;
    const errorLines = new Set(diagnostics.map((d) => d.line));
    const key = `${lines}|${[...errorLines].join()}`;
    if (gutter.dataset.key !== key) {
      gutter.innerHTML = Array.from({ length: lines }, (_, i) => (errorLines.has(i + 1) ? `<span class="err">${i + 1}</span>` : i + 1)).join("\n");
      gutter.dataset.key = key;
    }
    const highlighted = text.length <= HIGHLIGHT_LIMIT;
    textarea.classList.toggle("highlighted", highlighted);
    const marks = diagnostics.map((d) => ({ from: d.from, to: d.to, cls: "scp-err" }));
    if (bracket) marks.push(...bracket.map((at) => ({ from: at, to: at + 1, cls: "scp-match" })));
    // A last empty line still needs its height.
    highlight.innerHTML = highlighted ? `${highlightScp(text, marks)}\n` : "";
    syncScroll();
  }
  function syncScroll() {
    gutter.scrollTop = textarea.scrollTop;
    highlight.scrollTop = textarea.scrollTop;
    highlight.scrollLeft = textarea.scrollLeft;
  }

  // ---- Diagnostics: cp-solver's check_scp, once typing pauses ----
  let worker = null;
  let checkId = 0;
  let checkTimer = null;
  // The text the latest check was asked about.
  let pendingText = null;
  function scheduleCheck() {
    clearTimeout(checkTimer);
    problems.classList.add("stale");
    checkTimer = setTimeout(check, CHECK_DELAY);
  }
  // The constraint kinds cps accepts (`cps --constraints --json`), asked for
  // once: [{keyword, arguments, summary, example}].
  let kinds = [];
  function startWorker() {
    worker = new Worker(new URL("../check-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
      if (data.type === "constraints") {
        kinds = data.kinds ?? [];
        updateSignature();
        return;
      }
      if (data.id !== checkId) return;
      checkFailed = data.fatal ?? null;
      setDiagnostics(data.errors ?? []);
    };
    worker.onerror = (event) => {
      checkFailed = event.message ?? "the checker could not start";
      setDiagnostics([]);
    };
    worker.postMessage({ type: "constraints" });
  }
  function check() {
    checkId += 1;
    const text = textarea.value;
    pendingText = text;
    worker.postMessage({ type: "check", id: checkId, text });
  }
  function setDiagnostics(errors) {
    const text = pendingText;
    checkedText = text;
    diagnostics = errors.map((e) => {
      let from = offsetOf(text, e.start.line, e.start.column);
      let to = offsetOf(text, e.end.line, e.end.column);
      // Underline only the span's first line, and at least one character.
      const lineEnd = text.indexOf("\n", from);
      if (lineEnd >= 0 && to > lineEnd) to = Math.max(lineEnd, from + 1);
      if (to <= from) to = from + 1;
      if (from >= text.length && text.length) { from = text.length - 1; to = text.length; }
      return { from, to, line: e.start.line, column: e.start.column, kind: e.kind, message: e.message };
    });
    // Typed on since: the marks are for older text, so leave them until
    // the next check.
    if (text !== textarea.value) diagnostics = [];
    else problems.classList.remove("stale");
    renderProblems();
    render();
  }
  function renderProblems() {
    if (checkedText === null && !checkFailed) {
      problemsTitle.textContent = "Checking…";
      problemsList.replaceChildren();
      problems.dataset.state = "checking";
      return;
    }
    if (checkFailed) {
      problemsTitle.textContent = `Checking unavailable: ${checkFailed}`;
      problemsList.replaceChildren();
      problems.dataset.state = "failed";
      return;
    }
    problems.dataset.state = diagnostics.length ? "errors" : "clean";
    problemsTitle.textContent = diagnostics.length
      ? `${diagnostics.length} problem${diagnostics.length === 1 ? "" : "s"}`
      : "No problems: cp-solver accepts this model";
    problemsList.replaceChildren(...diagnostics.map((d) => {
      const item = el("li", { tabIndex: 0, title: "Go to it" },
        el("span", { className: "where", textContent: `${d.line}:${d.column}` }),
        el("span", { className: `what kind-${d.kind}`, textContent: KIND_NOTES[d.kind] ?? d.kind }),
        el("span", { className: "message", textContent: d.message }));
      const go = () => goTo(d);
      item.addEventListener("click", go);
      item.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); go(); } });
      return item;
    }));
  }
  function goTo({ from, to, line }) {
    textarea.focus();
    textarea.setSelectionRange(from, to);
    const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 21;
    textarea.scrollTop = Math.max(0, (line - 1) * lineHeight - textarea.clientHeight / 2);
    syncScroll();
  }

  // ---- Bracket at the caret and its partner ----
  function updateBracket() {
    const { selectionStart: at, selectionEnd: end } = textarea;
    const next = document.activeElement === textarea && at === end ? matchingBracket(textarea.value, at) : null;
    if (String(next) === String(bracket)) return;
    bracket = next;
    render();
  }
  document.addEventListener("selectionchange", () => {
    if (document.activeElement === textarea || bracket) updateBracket();
    if (document.activeElement === textarea) updateSignature();
    if (closeAt !== null && (textarea.selectionStart > closeAt || textarea.value[closeAt] !== ")")) closeAt = null;
    if (!popup.hidden && textarea.selectionStart !== caretAtShow) closeCompletion();
  });
  textarea.addEventListener("blur", () => { updateBracket(); closeCompletion(); });

  // ---- Auto-closed brackets: "(" adds ")", which typing ")" steps over ----
  // The offset of the ")" last added, while the caret is within it.
  let closeAt = null;
  let editFrom = 0;
  let lengthBefore = 0;
  textarea.addEventListener("beforeinput", () => {
    editFrom = textarea.selectionStart;
    lengthBefore = textarea.value.length;
  });

  // ---- Signature: the kind of the constraint the caret is in ----
  function updateSignature() {
    const text = textarea.value;
    const at = textarea.selectionStart;
    const ctx = kinds.length && text.length <= HIGHLIGHT_LIMIT ? completionContext(text, at) : null;
    const kind = ctx && kinds.find((k) => k.keyword === ctx.constraint);
    signature.hidden = !kind;
    if (!kind) return;
    signature.replaceChildren(
      el("span", { className: "scp-kind", textContent: kind.keyword }), " ",
      el("span", { className: "arguments", textContent: kind.arguments.join(" ") }),
      el("span", { className: "summary", textContent: ` · ${kind.summary}` }));
    signature.title = `${kind.keyword} ${kind.arguments.join(" ")}: ${kind.summary}. For example: (c ${kind.keyword} ${kind.example})`;
  }

  // ---- Completion: where a variable can stand, the model's variables;
  // where a constraint's kind goes, the kinds cps accepts ----
  // [{label, detail, insert, note}]
  let items = [];
  let selected = 0;
  let completeFrom = 0;
  let caretAtShow = -1;
  function closeCompletion() {
    popup.hidden = true;
    items = [];
  }
  function openCompletion(explicit) {
    const at = textarea.selectionStart;
    if (at !== textarea.selectionEnd) { closeCompletion(); return; }
    const ctx = completionContext(textarea.value, at);
    if (!explicit && !ctx.prefix) { closeCompletion(); return; }
    const matches = (label) => label.startsWith(ctx.prefix) && label !== ctx.prefix;
    // After a kind, a space, unless one follows already.
    const space = /\s/.test(textarea.value[at] ?? "") ? "" : " ";
    items = ctx.wantsKind
      ? kinds.filter((k) => matches(k.keyword)).map((k) => ({
        label: k.keyword, detail: k.arguments.join(" "), insert: k.keyword + space,
        note: `${k.summary} · e.g. (c ${k.keyword} ${k.example})`,
      }))
      : ctx.wantsVariable
        ? ctx.variables.filter((v) => matches(v.name)).map((v) => ({
          label: v.name, detail: v.lo !== null && v.hi !== null ? `${v.lo}..${v.hi}` : "", insert: v.name,
        }))
        : [];
    items = items.slice(0, MAX_SUGGESTIONS);
    if (!items.length) { closeCompletion(); return; }
    completeFrom = ctx.start;
    selected = 0;
    caretAtShow = at;
    options.replaceChildren(...items.map((choice, i) => {
      const item = el("li", {},
        el("span", { className: `name${ctx.wantsKind ? " kind" : ""}`, textContent: choice.label }),
        el("span", { className: "detail", textContent: choice.detail }));
      item.setAttribute("role", "option");
      item.addEventListener("mousedown", (event) => { event.preventDefault(); selected = i; accept(); });
      return item;
    }));
    showSelected();
    place(at);
    popup.hidden = false;
  }
  function showSelected() {
    [...options.children].forEach((item, i) => item.setAttribute("aria-selected", String(i === selected)));
    options.children[selected]?.scrollIntoView({ block: "nearest" });
    const note = items[selected]?.note;
    optionNote.hidden = !note;
    optionNote.textContent = note ?? "";
  }
  function place(at) {
    const style = getComputedStyle(textarea);
    const lineHeight = parseFloat(style.lineHeight) || 21;
    const measure = document.createElement("canvas").getContext("2d");
    measure.font = style.font;
    const charWidth = measure.measureText("0".repeat(100)).width / 100;
    const before = textarea.value.slice(0, at);
    const line = before.split("\n").length - 1;
    const column = at - (before.lastIndexOf("\n") + 1);
    const left = parseFloat(style.paddingLeft) + (column - (at - completeFrom)) * charWidth - textarea.scrollLeft;
    const top = parseFloat(style.paddingTop) + (line + 1) * lineHeight - textarea.scrollTop;
    popup.style.left = `${Math.max(0, left)}px`;
    // Above the line if there is no room below it.
    const height = (Math.min(items.length, 8) + (items[0]?.note ? 3 : 0)) * lineHeight + 8;
    const below = top + height <= textarea.clientHeight || top < height;
    popup.style.top = below ? `${top}px` : "";
    popup.style.bottom = below ? "" : `${textarea.clientHeight - top + lineHeight}px`;
  }
  let accepting = false;
  function accept() {
    const choice = items[selected];
    const at = textarea.selectionStart;
    closeCompletion();
    if (!choice) return;
    textarea.setSelectionRange(completeFrom, at);
    accepting = true;
    insert(textarea, choice.insert);
    accepting = false;
  }

  // ---- Input and keys ----
  textarea.addEventListener("input", (event) => {
    if (closeAt !== null && editFrom <= closeAt) closeAt += textarea.value.length - lengthBefore;
    render();
    updateBracket();
    scheduleCheck();
    const typing = event.inputType === "insertText" && event.data && /^[^\s()]+$/.test(event.data);
    const deleting = event.inputType === "deleteContentBackward";
    if (!accepting && (typing || deleting)) openCompletion(false);
    else closeCompletion();
    onInput?.();
  });
  textarea.addEventListener("scroll", () => { syncScroll(); closeCompletion(); });

  // Tab indents (two spaces); after Esc, Tab moves focus on as usual.
  let tabMoves = false;
  textarea.addEventListener("keydown", (event) => {
    const mod = event.ctrlKey || event.metaKey;
    const plain = !mod && !event.altKey;
    const { selectionStart: at, selectionEnd: end, value: text } = textarea;
    if (!popup.hidden) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        selected = (selected + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
        showSelected();
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && plain && !event.shiftKey) {
        event.preventDefault();
        accept();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeCompletion();
        return;
      }
    }
    if (event.key === " " && event.ctrlKey) {
      event.preventDefault();
      openCompletion(true);
      return;
    }
    if (event.key === "Escape") { tabMoves = true; return; }
    if (event.key === "Tab" && !tabMoves && plain && !event.shiftKey) {
      event.preventDefault();
      insert(textarea, "  ");
      return;
    }
    tabMoves = false;
    if (mod && event.key === "Enter") { event.preventDefault(); onSolve?.(); return; }
    if (!plain || at !== end) return;
    if (event.key === "(" && (at === text.length || /[\s)]/.test(text[at]))) {
      event.preventDefault();
      insert(textarea, "()");
      textarea.setSelectionRange(at + 1, at + 1);
      closeAt = at + 1;
    } else if (event.key === ")" && closeAt === at && text[at] === ")") {
      event.preventDefault();
      textarea.setSelectionRange(at + 1, at + 1);
      closeAt = null;
    } else if (event.key === "Backspace" && closeAt === at && text[at - 1] === "(" && text[at] === ")") {
      event.preventDefault();
      textarea.setSelectionRange(at - 1, at + 1);
      closeAt = null;
      if (!document.execCommand?.("delete")) {
        textarea.setRangeText("", at - 1, at + 1, "end");
        textarea.dispatchEvent(new Event("input"));
      }
    }
  });

  startWorker();

  return {
    edit,
    signature,
    problems,
    textarea,
    refresh() {
      closeAt = null;
      closeCompletion();
      diagnostics = [];
      checkedText = null;
      render();
      renderProblems();
      scheduleCheck();
    },
    focus: () => textarea.focus(),
  };
}
