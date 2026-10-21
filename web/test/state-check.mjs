// Checks web-repl's JSON session views against the REPL's own text output.
// After every line of each script that leaves the REPL at the pbp> prompt:
//   - state().proof line statuses and breakpoints match `:list`
//   - state().database ids, core/derived and texts match `:show`
// For each preserved-set instance: preserved() matches `:preserved`.
//
// Usage: node web/test/state-check.mjs   (after scripts/build-web.sh)
// Exit status 1 on any mismatch.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRoot, writeFile, startRepl } from "../host.js";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(web, "..");
const replModule = await WebAssembly.compile(readFileSync(join(web, "pkg/repl.wasm")));
const veripbModule = await WebAssembly.compile(readFileSync(join(web, "pkg/veripb.wasm")));
let failures = 0;

function session(files) {
  const fsRoot = createRoot();
  for (const [name, data] of files) writeFile(fsRoot, name, data);
  let out = [];
  const repl = startRepl({ replModule, veripbModule, root: fsRoot, onLine: (l) => out.push(l) });
  return {
    repl,
    run(text) {
      out = [];
      const mode = repl.line(text);
      return { mode, lines: out };
    },
  };
}

function fail(where, message) {
  failures += 1;
  console.log(`MISMATCH ${where}: ${message}`);
}

// `:list` rows: "<n>: <text> [<tag>] [<tag>] ..."; preamble rows are tagged [preamble].
function parseList(lines) {
  const rows = new Map();
  for (const line of lines) {
    const m = line.match(/^\s*(\d+): (.*?)((?: \[[^\]]*\])*)$/);
    if (!m) continue;
    const tags = m[3];
    if (tags.includes("[preamble]")) continue;
    rows.set(Number(m[1]), {
      status: tags.includes("failed") ? "rejected" : tags.includes("unchecked") ? "unchecked" : "checked",
      breakpoint: tags.includes("breakpoint"),
    });
  }
  return rows;
}

// `:show` rows: "  ConstraintId <id>: [@label ...] <text> [core|derived]".
function parseShow(lines) {
  const rows = new Map();
  for (const line of lines) {
    const m = line.match(/^\s*ConstraintId (\d+): (.*) \[(core|derived)\]$/);
    if (m) rows.set(Number(m[1]), { text: m[2], core: m[3] === "core" });
  }
  return rows;
}

function compareState(where, s, state) {
  const listed = parseList(s.run(":list").lines);
  const lines = state.proof.lines;
  if (lines.length !== listed.size) fail(where, `proof has ${lines.length} lines, :list ${listed.size}`);
  for (const line of lines) {
    const row = listed.get(line.n);
    if (!row) { fail(where, `line ${line.n} missing from :list`); continue; }
    if (row.status !== line.status) fail(where, `line ${line.n} status ${line.status}, :list ${row.status}`);
    if (row.breakpoint !== line.breakpoint) fail(where, `line ${line.n} breakpoint ${line.breakpoint}, :list ${row.breakpoint}`);
  }
  if (state.proof.checked + state.proof.unchecked !== lines.length) fail(where, "checked + unchecked != lines");
  const shown = parseShow(s.run(":show").lines);
  if (state.database.error) { fail(where, `database error ${state.database.error}`); return; }
  const entries = state.database.entries;
  if (entries.length !== shown.size) fail(where, `database has ${entries.length} entries, :show ${shown.size}`);
  for (const entry of entries) {
    const row = shown.get(entry.id);
    if (!row) { fail(where, `id ${entry.id} missing from :show`); continue; }
    if (row.core !== entry.core) fail(where, `id ${entry.id} core ${entry.core}, :show ${row.core}`);
    const expected = [...entry.labels, entry.text].join(" ");
    if (row.text !== expected) fail(where, `id ${entry.id} text ${JSON.stringify(expected)}, :show ${JSON.stringify(row.text)}`);
  }
}

const demoFiles = readdirSync(join(web, "pkg/demos"))
  .filter((name) => name !== "index.json")
  .map((name) => [name, readFileSync(join(web, "pkg/demos", name))]);

let checks = 0;
for (const script of readdirSync(join(web, "test/scripts")).sort()) {
  const s = session(demoFiles);
  const input = readFileSync(join(web, "test/scripts", script), "utf8").trim().split("\n");
  // Breakpoints too: toggle one on the first proof line after loading.
  let toggled = false;
  for (const [i, text] of input.entries()) {
    const { mode } = s.run(text);
    let state = s.repl.state();
    if (mode !== 0 || !state.proof) continue;
    if (!toggled && state.proof.lines.length) {
      s.repl.toggleBreakpoint(0);
      toggled = true;
      state = s.repl.state();
    }
    compareState(`${script}:${i + 1} (${text})`, s, state);
    checks += 1;
  }
}

// Preserved sets, from veripb's own test instances.
const instances = join(root, "work/veripb/tests/instances/correct/version3");
const preservedStems = existsSync(instances)
  ? readdirSync(instances).filter((n) => n.startsWith("add_preserved_var") && n.endsWith(".opb")).map((n) => n.slice(0, -4))
  : [];
for (const stem of preservedStems) {
  if (!existsSync(join(instances, `${stem}.pbp`))) continue;
  const s = session([[`${stem}.opb`, readFileSync(join(instances, `${stem}.opb`))], [`${stem}.pbp`, readFileSync(join(instances, `${stem}.pbp`))]]);
  s.run(`:instance ${stem}`);
  s.run(":verify");
  const text = s.run(":preserved").lines.join("\n");
  const set = s.repl.preserved();
  const where = `preserved ${stem}`;
  if (!set || set.error) { fail(where, `preserved() = ${JSON.stringify(set)}`); continue; }
  for (const name of set.current ?? []) if (!text.includes(name)) fail(where, `current ${name} not in :preserved output`);
  for (const name of set.declared ?? []) if (!text.includes(name)) fail(where, `declared ${name} not in :preserved output`);
  if (set.lastChange != null && !text.includes(String(set.lastChange))) fail(where, `lastChange ${set.lastChange} not in :preserved output`);
  console.log(`${where}: declared ${JSON.stringify(set.declared)}, current ${JSON.stringify(set.current)}, lastChange ${set.lastChange}`);
  checks += 1;
}

console.log(`${checks} checks, ${failures} mismatches`);
process.exit(failures ? 1 : 0);
