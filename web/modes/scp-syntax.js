// Syntax helpers for the Solver tab: `.scp` models and cps's output.
//
// Tokens are as cp-solver's reader splits them (crates/lang/src/sexpr.rs):
// "(", ")" and atoms, runs of anything else up to whitespace or a
// parenthesis. Atoms are classed by where they stand, so no list of
// constraint names is needed:
//   scp-kw    a section's head (version, variables, constraints, prob_type)
//   scp-var   a variable: declared in `variables`, or used after that
//   scp-name  a constraint's name (first in its list in `constraints`)
//   scp-kind  a constraint's kind (second), or prob_type's words
//   scp-num   an integer
//   scp-paren a parenthesis; scp-bad one closing nothing
//
// highlightScp(text, marks) -> HTML: `text` with each token in a span.
//   marks: [{from, to, cls}] (string offsets), classes added to the text
//   in [from, to), such as an error's span or a matched bracket.
// completionContext(text, offset) -> {start, prefix, wantsVariable, wantsKind,
//   constraint, variables: [{name, lo, hi}]}: the atom being typed at
//   `offset` (from `start`; empty between atoms), whether a variable or a
//   constraint kind can stand there, the kind of the constraint the caret is
//   in (or null), and every variable the model declares.
// matchingBracket(text, offset) -> [open, close] | null: the bracket just
//   before `offset` (or else just after it) and its partner.
// solutionLine(line) -> Element: a line of cps's output, with each
//   `name=value` split into name and value, and its answer line marked.
// ANSWER: matches cps's answer line.

const TOKEN = /(\s+)|([()])|([^\s()]+)/g;
const INTEGER = /^-?\d+$/;
export const ANSWER = /^(SATISFIABLE|UNSATISFIABLE|UNKNOWN|\d+ solutions?)$/;

const escape = (text) => text.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));

/**
 * Walks `text`, calling visit({type, text, at, cls, depth, pos, section,
 * constraint, after}) for each token: type "space", "open", "close" or
 * "atom"; for an atom, `depth` and `pos` place it (its list's depth, its
 * index there) in `section`, and `constraint` is the kind of the constraint
 * it is in. after() gives the state the token leaves: {depth, next, section,
 * constraint}, `next` being the index the next item in the open list would
 * take. Returns the declared variables, in order, as [{name, lo, hi}].
 */
function walk(text, visit) {
  // One frame per open list: how many items it has so far.
  const stack = [];
  let section = null;
  const declared = new Map();
  let declaring = null;
  let constraint = null;
  const after = () => ({ depth: stack.length, next: stack.at(-1)?.items ?? 0, section, constraint });
  for (const m of text.matchAll(TOKEN)) {
    const [, space, paren, atom] = m;
    const at = m.index;
    if (space) { visit({ type: "space", text: space, at, after }); continue; }
    const top = stack.at(-1);
    if (paren === "(") {
      if (top) top.items += 1;
      stack.push({ items: 0 });
      if (stack.length === 3) constraint = null;
      visit({ type: "open", text: "(", at, cls: "scp-paren", after });
      continue;
    }
    if (paren === ")") {
      const closed = stack.pop();
      if (stack.length < 2) section = null;
      if (stack.length < 3) { declaring = null; constraint = null; }
      visit({ type: "close", text: ")", at, cls: closed ? "scp-paren" : "scp-bad", after });
      continue;
    }
    const pos = top ? top.items++ : 0;
    const depth = stack.length;
    let cls = null;
    if (depth === 2 && pos === 0) {
      section = atom;
      cls = "scp-kw";
    } else if (section === "variables" && depth === 3 && pos === 0) {
      declaring = { name: atom, lo: null, hi: null };
      if (!declared.has(atom)) declared.set(atom, declaring);
      cls = "scp-var";
    } else if (section === "constraints" && depth === 3 && pos === 0) {
      cls = "scp-name";
    } else if (section === "constraints" && depth === 3 && pos === 1) {
      constraint = atom;
      cls = "scp-kind";
    } else if (INTEGER.test(atom)) {
      if (declaring && depth === 3 && pos === 1) declaring.lo = atom;
      if (declaring && depth === 3 && pos === 2) declaring.hi = atom;
      cls = "scp-num";
    } else if (declared.has(atom)) {
      cls = "scp-var";
    } else if (section === "prob_type") {
      cls = "scp-kind";
    }
    visit({ type: "atom", text: atom, at, cls, depth, pos, section, constraint, after });
  }
  return [...declared.values()];
}

export function highlightScp(text, marks = []) {
  let html = "";
  const piece = (classes, part) => {
    const cls = classes.filter(Boolean).join(" ");
    html += cls ? `<span class="${cls}">${escape(part)}</span>` : escape(part);
  };
  walk(text, ({ text: token, at, cls }) => {
    const end = at + token.length;
    const touching = marks.filter((m) => m.from < end && m.to > at);
    if (!touching.length) { piece([cls], token); return; }
    // Split the token where marks start and end.
    const cuts = [...new Set([at, end, ...touching.flatMap((m) => [m.from, m.to])])]
      .filter((x) => x >= at && x <= end).sort((a, b) => a - b);
    for (let i = 0; i + 1 < cuts.length; i++) {
      const [from, to] = [cuts[i], cuts[i + 1]];
      piece([cls, ...touching.filter((m) => m.from <= from && m.to >= to).map((m) => m.cls)], token.slice(from - at, to - at));
    }
  });
  return html;
}

export function completionContext(text, offset) {
  // The atom the caret is in or just after, else the state between tokens.
  let atom = null;
  let state = { depth: 0, next: 0, section: null };
  const variables = walk(text, (token) => {
    const end = token.at + token.text.length;
    if (token.at >= offset) return;
    if (token.type === "atom" && end >= offset) atom = token;
    else if (end <= offset) state = token.after();
  });
  const where = atom
    ? { start: atom.at, prefix: text.slice(atom.at, offset), depth: atom.depth, pos: atom.pos, section: atom.section, constraint: atom.constraint }
    : { start: offset, prefix: "", depth: state.depth, pos: state.next, section: state.section, constraint: state.constraint };
  const wantsVariable = (where.section === "constraints" && (where.depth > 3 || (where.depth === 3 && where.pos >= 2)))
    || (where.section === "prob_type" && where.depth >= 3 && where.pos >= 1);
  const wantsKind = where.section === "constraints" && where.depth === 3 && where.pos === 1;
  return { start: where.start, prefix: where.prefix, wantsVariable, wantsKind, constraint: where.constraint, variables };
}

export function matchingBracket(text, offset) {
  const isBracket = (c) => c === "(" || c === ")";
  const at = isBracket(text[offset - 1]) ? offset - 1 : isBracket(text[offset]) ? offset : -1;
  if (at < 0) return null;
  const step = text[at] === "(" ? 1 : -1;
  let depth = 0;
  for (let i = at; i >= 0 && i < text.length; i += step) {
    if (text[i] === "(") depth += step;
    else if (text[i] === ")") depth -= step;
    if (depth === 0) return step > 0 ? [at, i] : [i, at];
  }
  return null;
}

export function solutionLine(line) {
  const row = document.createElement("div");
  row.className = "row line";
  if (ANSWER.test(line)) {
    row.classList.add("sol-answer");
    row.textContent = line;
    return row;
  }
  if (!line.includes("=")) {
    row.textContent = line || " ";
    return row;
  }
  for (const part of line.split(/(\s+)/)) {
    const at = part.indexOf("=");
    if (at <= 0) { row.append(part); continue; }
    const name = Object.assign(document.createElement("span"), { className: "sol-var", textContent: part.slice(0, at) });
    const eq = Object.assign(document.createElement("span"), { className: "sol-eq", textContent: "=" });
    const value = Object.assign(document.createElement("span"), { className: "sol-val", textContent: part.slice(at + 1) });
    row.append(name, eq, value);
  }
  return row;
}
