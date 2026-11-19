// Syntax highlighting for the Solver tab: `.scp` models and cps's output.
//
// highlightScp(text) -> HTML: `text` with each token in a span. Tokens are
// as cp-solver's reader splits them (crates/lang/src/sexpr.rs): "(", ")" and
// atoms, runs of anything else up to whitespace or a parenthesis. Atoms are
// classed by where they stand, so no list of constraint names is needed:
//   scp-kw    a section's head (version, variables, constraints, prob_type)
//   scp-var   a variable: declared in `variables`, or used after that
//   scp-name  a constraint's name (first in its list in `constraints`)
//   scp-kind  a constraint's kind (second), or prob_type's words
//   scp-num   an integer
//   scp-paren a parenthesis; scp-bad one closing nothing
// solutionLine(line) -> Element: a line of cps's output, with each
// `name=value` split into name and value, and its answer line marked.
// ANSWER: matches cps's answer line.

const TOKEN = /(\s+)|([()])|([^\s()]+)/g;
const INTEGER = /^-?\d+$/;
export const ANSWER = /^(SATISFIABLE|UNSATISFIABLE|UNKNOWN|\d+ solutions?)$/;

const escape = (text) => text.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
const span = (cls, text) => `<span class="${cls}">${escape(text)}</span>`;

export function highlightScp(text) {
  let html = "";
  // One frame per open list: how many items it has so far, and its place
  // in its parent.
  const stack = [];
  let section = null;
  const variables = new Set();
  for (const [, space, paren, atom] of text.matchAll(TOKEN)) {
    if (space) { html += space; continue; }
    const top = stack.at(-1);
    if (paren === "(") {
      stack.push({ items: 0, pos: top ? top.items++ : 0 });
      html += span("scp-paren", "(");
      continue;
    }
    if (paren === ")") {
      html += span(stack.pop() ? "scp-paren" : "scp-bad", ")");
      if (stack.length < 2) section = null;
      continue;
    }
    const pos = top ? top.items++ : 0;
    const depth = stack.length;
    let cls = null;
    if (depth === 2 && pos === 0) {
      section = atom;
      cls = "scp-kw";
    } else if (section === "variables" && depth === 3 && pos === 0) {
      variables.add(atom);
      cls = "scp-var";
    } else if (section === "constraints" && depth === 3 && pos === 0) {
      cls = "scp-name";
    } else if (section === "constraints" && depth === 3 && pos === 1) {
      cls = "scp-kind";
    } else if (INTEGER.test(atom)) {
      cls = "scp-num";
    } else if (variables.has(atom)) {
      cls = "scp-var";
    } else if (section === "prob_type") {
      cls = "scp-kind";
    }
    html += cls ? span(cls, atom) : escape(atom);
  }
  return html;
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
