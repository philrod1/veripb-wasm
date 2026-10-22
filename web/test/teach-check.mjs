// Checks the plain-English explanations (web-repl/src/teach.rs), returned
// as `plain` by explain(line):
//   - content: sample rup, pol, red and a lines give the expected steps
//   - sweep: every checked rup, pol, red and a line of veripb's correct
//     version-3 instances gets one (implication syntax excepted), and each
//     rup replay reaches its conflict, and its glossary links exist
//   - glossary: concepts and rules, every link and see-also exists
//
// Usage: node web/test/teach-check.mjs   (after scripts/build-web.sh)
// Exit status 1 on any failure.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRoot, writeFile, startRepl } from "../host.js";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const instances = join(web, "..", "upstream/veripb/tests/instances/correct/version3");
const demos = join(web, "pkg/demos");
const replModule = await WebAssembly.compile(readFileSync(join(web, "pkg/repl.wasm")));
const veripbModule = await WebAssembly.compile(readFileSync(join(web, "pkg/veripb.wasm")));
let checks = 0;
let failures = 0;

function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}

/** A verified session over `<dir>/<base>.opb` and `.pbp`, after `edits` (REPL lines). */
function session(dir, base, edits = []) {
  const root = createRoot();
  writeFile(root, "f.opb", readFileSync(join(dir, `${base}.opb`)));
  writeFile(root, "f.pbp", readFileSync(join(dir, `${base}.pbp`)));
  const repl = startRepl({ replModule, veripbModule, root, onLine: () => {} });
  for (const line of [":load f.opb", ":source f.pbp", ...edits, ":verify"]) repl.line(line);
  return repl;
}

// Glossary and constraint links read as their text.
const unlink = (t) => t.replace(/\[([^\]]+)\]\([gc]:[\w-]+\)/g, "$1");
const text = (plain) => unlink(plain.blocks.map((b) => (b.kind === "steps" ? b.items.join("\n") : b.text)).join("\n"));
const steps = (plain) => plain.blocks.find((b) => b.kind === "steps")?.items ?? [];

// ---- Content ----

function content(repl, n, name, expect) {
  const plain = repl.explain(n)?.plain;
  if (!plain) return check(`${name}: has a plain explanation`, false);
  const body = text(plain);
  const missing = (expect.phrases ?? []).filter((p) => !body.includes(p));
  check(`${name}: ${plain.title}`, plain.title.includes(expect.title) && !missing.length, missing.length ? `missing ${JSON.stringify(missing)}` : "");
  if (expect.steps != null) check(`${name}: ${expect.steps} steps`, steps(plain).length === expect.steps, String(steps(plain).length));
}

const chain = session(demos, "chain", [":edit 3", "@x3 rup 1 x3 >= 1 : @x1_or_x2 @x1_imp_x3 @x2_imp_x3 ;"]);
content(chain, 3, "chain 3", {
  title: "reverse unit propagation", steps: 4,
  phrases: ["Suppose `x3 ≥ 1` is false", "That forces x3 = 0", "With x1 = 0 and x2 = 0", "a contradiction", "as `@x3` (constraint 6)"],
});
content(chain, 5, "chain 5", { title: "reverse unit propagation", steps: 2, phrases: ["claims `0 ≥ 1`", "constraints are contradictory"] });

const twoOfThree = session(demos, "two-of-three");
content(twoOfThree, 3, "two-of-three 3", { title: "cutting planes", steps: 3, phrases: ["Add `@not_12` and `@not_13`", "`@sum_12_13` (constraint 5)"] });
content(twoOfThree, 5, "two-of-three 5", { title: "cutting planes", steps: 2, phrases: ["Divide `@sum_all` by 2, rounding up", "at least 3/2, it is at least 2"] });
content(twoOfThree, 6, "two-of-three 6", { title: "cutting planes", phrases: ["`x1` cancels against `~x1`"] });

const symmetry = session(instances, "redundance_explicit_subproof");
content(symmetry, 6, "explicit subproof 6", { title: "cutting planes", phrases: ["Saturate constraint 1", "at the right-hand side, 1"] });
content(symmetry, 15, "explicit subproof 15", {
  title: "redundance", steps: 2,
  phrases: ["witness is x1 → x3", "(so `~x1 ≥ 1` holds)", "Proved explicitly in lines 16–25", "lines 30–33", "Constraint 1, `2 ~x1 + ~x3 ≥ 1`,"],
});
content(symmetry, 24, "explicit subproof 24", { title: "cutting planes", phrases: ["literal axiom `x6 ≥ 0`", "constraint -1 (the newest one)", "result is `0 ≥ 1`"] });
content(symmetry, 38, "explicit subproof 38", { title: "reverse unit propagation", phrases: ["Constraint 18: `x1 ≥ 1`", "a contradiction"] });

const objective = session(instances, "redundance_symmetry_with_objective");
content(objective, 3, "symmetry with objective 3", {
  title: "redundance", steps: 4,
  phrases: ["nor the best one", "no worse for the objective", "follows directly from assuming C is false", "by unit propagation"],
});
content(objective, 4, "symmetry with objective 4", { title: "redundance", phrases: ["with no witness", "checks it as a `rup` step"] });

const assertion = session(instances, "assertion_rule");
content(assertion, 5, "assertion 5", { title: "assertion", phrases: ["without any proof", "`:deassert 5`"] });

// ---- Glossary ----

const glossary = chain.glossary();
const ids = new Set(glossary.map((e) => e.id));
const linkIds = (value) => [...JSON.stringify(value).matchAll(/\]\(g:([\w-]+)\)/g)].map((m) => m[1]);
const concepts = glossary.filter((e) => e.group === "concept");
const rules = glossary.filter((e) => e.group === "rule");
check(`glossary: ${concepts.length} concepts, ${rules.length} rules`, concepts.length >= 20 && ["rup", "pol", "red", "a"].every((r) => ids.has(`rule-${r}`)));
check("glossary: rule entries carry :help's usage", rules.find((e) => e.term === "pol")?.usage?.startsWith("pol "));
const broken = glossary.flatMap((e) => [...linkIds([e.body, e.example]), ...e.see].filter((id) => !ids.has(id)).map((id) => `${e.id} -> ${id}`));
check("glossary: every link and see-also exists", !broken.length, broken.join(", "));
check("glossary: ids are unique", ids.size === glossary.length);

// ---- Sweep ----

const RULES = new Set(["rup", "pol", "red", "a"]);
let lines = 0;
const missing = [];
const unfinished = [];
const badLinks = new Set();
for (const name of readdirSync(instances).filter((f) => f.endsWith(".pbp")).sort()) {
  const base = name.slice(0, -4);
  if (!existsSync(join(instances, `${base}.opb`))) continue;
  const repl = session(instances, base);
  for (const line of repl.state()?.proof?.lines ?? []) {
    const rule = line.text.split(/\s+/).find((t) => !t.startsWith("@"));
    if (line.status !== "checked" || !RULES.has(rule) || /==>|<==/.test(line.text)) continue;
    lines += 1;
    const plain = repl.explain(line.n)?.plain;
    if (!plain) missing.push(`${base}:${line.n} ${line.text}`);
    else if (text(plain).includes("did not reach")) unfinished.push(`${base}:${line.n} ${line.text}`);
    for (const id of linkIds(plain ?? {})) if (!ids.has(id)) badLinks.add(id);
  }
}
check(`sweep: ${lines} lines explained`, !missing.length, missing.slice(0, 5).join("; "));
check("sweep: every rup replay reaches its conflict", !unfinished.length, unfinished.slice(0, 5).join("; "));
check("sweep: every glossary link in an explanation exists", !badLinks.size, [...badLinks].join(", "));

console.log(`${checks} checks, ${failures} failures`);
process.exit(failures ? 1 : 0);
