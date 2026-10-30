// Checks web-repl's JSON session views against the REPL's own text output.
// After every line of each script that leaves the REPL at the pbp> prompt:
//   - view("proof") line statuses and breakpoints match `:list`
//   - view("database") ids, core/derived and texts match `:show`
//   - state()'s summary (line and constraint counts, breakpoints) matches
//     the rows
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

// The session as the page sees it: vr_state's summary, with every row of
// the Proof and Database panes fetched through vr_view.
function fullState(repl) {
  const summary = repl.state();
  if (!summary?.proof) return summary;
  const proof = repl.view({ pane: "proof", start: 0, count: 1e9 });
  const database = repl.view({ pane: "database", start: 0, count: 1e9 });
  return {
    ...summary,
    summary,
    proof: { ...summary.proof, lines: proof.rows.filter((row) => !row.preamble) },
    database: database.error ? { error: database.error } : { ...summary.database, entries: database.rows },
  };
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
  if (state.summary.proof.lines !== lines.length) fail(where, `summary says ${state.summary.proof.lines} lines, rows ${lines.length}`);
  const breakpoints = lines.filter((line) => line.breakpoint).map((line) => line.n);
  if (JSON.stringify(state.summary.proof.breakpoints) !== JSON.stringify(breakpoints)) {
    fail(where, `summary breakpoints ${state.summary.proof.breakpoints}, rows ${breakpoints}`);
  }
  const shown = parseShow(s.run(":show").lines);
  if (state.database.error) { fail(where, `database error ${state.database.error}`); return; }
  const entries = state.database.entries;
  if (entries.length !== shown.size) fail(where, `database has ${entries.length} entries, :show ${shown.size}`);
  if (state.summary.database.count !== entries.length) fail(where, `summary says ${state.summary.database.count} constraints, rows ${entries.length}`);
  if (state.summary.database.core !== entries.filter((e) => e.core).length) fail(where, "summary core count differs from the rows");
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
    let state = fullState(s.repl);
    if (mode !== 0 || !state.proof) continue;
    if (!toggled && state.proof.lines.length) {
      s.repl.toggleBreakpoint(0);
      toggled = true;
      state = fullState(s.repl);
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

// Filters (vr_view's query, core and derived), on the two-of-three demo.
{
  const s = session(demoFiles);
  s.run(":instance two-of-three");
  s.run(":verify");
  const view = (request) => s.repl.view({ start: 0, count: 1e9, ...request });
  const ns = (rows) => rows.map((row) => row.n ?? row.id ?? row.ids).join(",");
  const expect = (where, got, want) => {
    checks += 1;
    if (got !== want) fail(`filter ${where}`, `got ${got}, want ${want}`);
  };
  expect("proof, all", ns(view({ pane: "proof" }).rows), "1,2,3,4,5,6");
  expect("proof, a line number", ns(view({ pane: "proof", query: "4" }).rows), "4");
  expect("proof, a label", ns(view({ pane: "proof", query: "@SUM_ALL" }).rows), "4,5");
  expect("proof, a window", ns(view({ pane: "proof", start: 3, count: 2 }).rows), "4,5");
  expect("proof, the total", String(view({ pane: "proof", query: "pol", count: 1 }).total), "4");
  expect("database, an id", ns(view({ pane: "database", query: "6" }).rows), "6");
  expect("database, a label", ns(view({ pane: "database", query: "@not_1" }).rows), "2,3");
  expect("database, core only", ns(view({ pane: "database", derived: false }).rows), "1,2,3,4");
  expect("database, derived only", ns(view({ pane: "database", core: false }).rows), "5,6,7,8");
  expect("formula, an id", ns(view({ pane: "formula", query: "2" }).rows), "2");
  const quick = s.repl.stateQuick();
  const full = s.repl.state();
  expect("the quick summary has the database pending", JSON.stringify(quick.database), '{"pending":true}');
  expect("the quick summary matches the full one", JSON.stringify({ ...quick, database: null }), JSON.stringify({ ...full, database: null }));
  const found = s.repl.find({ label: "@sum_all" });
  expect("find, a label", JSON.stringify(found && [found.id, found.position]), "[6,5]");
  expect("find, a missing id", String(s.repl.find({ id: 99 })), "null");
}

// Editing a comment keeps the checked prefix (vr_buffer_edit); any other
// edit retracts it to the edited line.
{
  const s = session(demoFiles);
  s.run(":instance two-of-three");
  s.run(":insert 4");
  s.run("% a comment");
  s.run(":done");
  s.run(":verify");
  const expect = (where, got, want) => {
    checks += 1;
    if (got !== want) fail(`comment edit: ${where}`, `got ${got}, want ${want}`);
  };
  const summary = () => s.repl.state();
  const before = summary();
  expect("all checked first", `${before.proof.checked}/${before.proof.lines}`, "5/5");
  const edited = s.repl.bufferEdit({ op: "set", index: 1, text: "% the comment, reworded" });
  const after = summary();
  expect("a comment edit keeps everything checked", `${after.proof.checked}/${after.proof.lines}`, "5/5");
  expect("a comment edit keeps the generation", String(after.generation), String(before.generation));
  expect("a comment edit counts as an edit", String(edited.edits > before.edits), "true");
  expect("the new comment text", s.repl.view({ pane: "proof", start: 3, count: 1 }).rows[0]?.text, "% the comment, reworded");
  s.repl.bufferEdit({ op: "set", index: 1, text: "rup 1 ~x1 1 ~x2 >= 1 ;" });
  expect("a comment turned into a rule retracts", String(summary().proof.checked), "1");
  s.run(":undo");
  expect(":undo restores the comment", s.repl.view({ pane: "proof", start: 3, count: 1 }).rows[0]?.text, "% the comment, reworded");
}

// The Extras tab's sections: cached per session generation, and filled by
// :check and :objective typed at the prompt.
{
  // clique.opb has an objective; two solutions logged, as in demo 04.
  const s = session(demoFiles);
  s.run(":load clique.opb");
  s.run("soli x1 x2 x3 x4 ~x5 ;");
  s.run("@better soli x1 x2 x3 ~x4 ~x5 ;");
  s.run(":verify");
  const expect = (where, got, want) => {
    checks += 1;
    if (got !== want) fail(`extras: ${where}`, `got ${got}, want ${want}`);
  };
  const runs = () => s.repl.stats.veripbRuns;
  let before = runs();
  const objective = s.repl.extrasObjective();
  // :verify's own run already gave the bounds.
  expect("the objective section runs no veripb", String(runs() - before), "0");
  before = runs();
  expect("asked again, it is cached", JSON.stringify(s.repl.extrasObjective()) === JSON.stringify(objective) && runs() === before, true);
  const typed = s.run(":check").lines;
  before = runs();
  const status = s.repl.extrasStatus();
  expect("after :check at the prompt, the status costs no veripb run", runs() - before, 0);
  expect("the status is :check's verdict", status.status, typed.filter((l) => !l.startsWith("Running VeriPB")).at(-1));
  before = runs();
  const again = s.run(":check").lines;
  expect(":check again, the session unchanged: no veripb run", runs() - before, 0);
  expect(":check again: the same output", JSON.stringify(again), JSON.stringify(typed));
  before = runs();
  const unsat = s.run(":check UNSAT").lines;
  expect(":check with a conclusion is cached apart", runs() - before > 0, true);
  before = runs();
  expect(":check UNSAT again: cached", JSON.stringify(s.run(":check UNSAT").lines) === JSON.stringify(unsat) && runs() === before, true);
  const objectiveTyped = s.run(":objective").lines;
  expect(":objective matches the Extras section", JSON.stringify(objectiveTyped), JSON.stringify(objective.lines));
  s.run(":undo");
  before = runs();
  s.repl.extrasStatus();
  expect("after the proof changes, the status is worked out again", runs() > before, true);
  before = runs();
  s.run(":check");
  expect("and :check uses that, not the old output", runs() - before, 0);
}

// Bare :check tries the sourced file's own conclusion first (web-repl
// src/check.rs): one veripb run when it holds, and the true verdict, without
// trying a conclusion twice, when it does not.
{
  const proof = (conclusion) => new TextEncoder().encode([
    "pseudo-Boolean proof version 3.0", "f 3;",
    "@better soli x1 x2 x3 ~x4 ~x5 ;",
    "@colour_bound pol @better @no_15 + @no_34 + ;", "@contradiction rup >= 1 : @colour_bound ;",
    "output NONE;", `conclusion ${conclusion};`, "end pseudo-Boolean proof;", ""].join("\n"));
  const expect = (where, got, want) => {
    checks += 1;
    if (got !== want) fail(`check guesses: ${where}`, `got ${got}, want ${want}`);
  };
  const verdicts = {};
  for (const [name, conclusion] of [["right", "BOUNDS -3 -3"], ["wrong", "SAT"]]) {
    const s = session([...demoFiles, [`${name}.pbp`, proof(conclusion)]]);
    s.run(":load clique.opb");
    s.run(`:source ${name}.pbp`);
    s.run(":verify");
    const before = s.repl.stats.veripbRuns;
    verdicts[name] = s.run(":check").lines.at(-1);
    verdicts[`${name}Runs`] = s.repl.stats.veripbRuns - before;
  }
  expect("the file's conclusion holds: one veripb run", verdicts.rightRuns, 1);
  expect("and its verdict", verdicts.right, "s VERIFIED BOUNDS -3 <= obj <= -3");
  expect("a wrong conclusion in the file: the same verdict", verdicts.wrong, verdicts.right);
  expect("and no conclusion tried twice (SAT, UNSAT, the bounds, BOUNDS)", verdicts.wrongRuns <= 4, true);

  // Bare :save finds its conclusion the same way; the Extras Status shows the
  // intended conclusion (the file's) and whether veripb accepted it.
  const s = session([...demoFiles, ["right.pbp", proof("BOUNDS -3 -3")]]);
  s.run(":load clique.opb");
  s.run(":source right.pbp");
  s.run(":verify");
  let before = s.repl.stats.veripbRuns;
  const saved = s.run(":save out.pbp").lines;
  expect("bare :save: one veripb run", s.repl.stats.veripbRuns - before, 1);
  expect("bare :save: the verdict and the file", saved.join(" | "), "Running VeriPB version 3.0.2 | s VERIFIED BOUNDS -3 <= obj <= -3 | Saved 3 line(s) to out.pbp (conclusion BOUNDS -3 -3).");
  before = s.repl.stats.veripbRuns;
  const status = s.repl.extrasStatus();
  expect("Status: the intended conclusion", status.intended, "BOUNDS -3 -3");
  expect("Status: veripb accepted it", status.intendedVerified, true);

  // A new session counts its generation from 0 again: nothing cached for the
  // old one may answer for it. Both formulas below are loaded with no proof,
  // so both sessions are at generation 0.
  s.run(":load two-of-three.opb");
  const twoRows = s.repl.view({ pane: "database", start: 0, count: 1e9 }).rows.length;
  const twoObjective = s.repl.extrasObjective().lines.join(" ");
  s.run(":load clique.opb");
  expect("the first session's database", twoRows, 4);
  expect("a replaced session's database rows are not reused", s.repl.view({ pane: "database", start: 0, count: 1e9 }).rows.length, 3);
  expect("nor its Objective section", s.repl.extrasObjective().lines.join(" ") !== twoObjective && s.repl.extrasObjective().lines[0]?.startsWith("Objective: min"), true);
  expect("nor its intended conclusion", String(s.repl.extrasStatus().intended), "null");
}

// Pane statistics (vr_pane_stats) agree with the panes and the summary.
{
  const s = session(demoFiles);
  s.run(":instance two-of-three");
  s.run(":verify");
  const expect = (where, got, want) => {
    checks += 1;
    if (got !== want) fail(`stats ${where}`, `got ${got}, want ${want}`);
  };
  const summary = s.repl.state();
  const rows = (pane) => s.repl.view({ pane, start: 0, count: 1e9 }).rows;
  const formula = s.repl.paneStats(0);
  const database = s.repl.paneStats(1);
  const proof = s.repl.paneStats(2);
  expect("formula: constraints", formula.constraints, summary.formula.count);
  expect("formula: kinds cover every line", formula.kinds.reduce((n, k) => n + k.count, 0), formula.lines);
  expect("database: count and core", `${database.count} ${database.core}`, `${summary.database.count} ${summary.database.core}`);
  expect("database: kinds cover every row", database.kinds.reduce((n, k) => n + k.count, 0), rows("database").length);
  expect("database: from the formula", database.fromFormula, rows("database").filter((r) => r.id <= summary.formula.count).length);
  expect("proof: lines and checked", `${proof.lines} ${proof.checked}`, `${summary.proof.lines} ${summary.proof.checked}`);
  const keywords = {};
  for (const row of rows("proof").filter((r) => !r.preamble)) {
    const word = row.text.split(/\s+/).find((t) => t && !t.startsWith("@"))?.replace(/;$/, "") ?? "blank";
    keywords[word.startsWith("%") ? "comment" : word] = (keywords[word.startsWith("%") ? "comment" : word] ?? 0) + 1;
  }
  expect("proof: rule counts", JSON.stringify(Object.fromEntries(proof.rules.map((r) => [r.name, r.count]).sort())), JSON.stringify(Object.fromEntries(Object.entries(keywords).sort())));
  expect("proof: most frequent first", proof.rules.every((r, i) => i === 0 || proof.rules[i - 1].count >= r.count), true);
  expect("no session: null", String(session(demoFiles).repl.paneStats(2)), "null");
}

console.log(`${checks} checks, ${failures} mismatches`);
process.exit(failures ? 1 : 0);
