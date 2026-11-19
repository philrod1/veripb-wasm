// Checks the Solver tab's solver: pkg/cps.wasm, run by host.js's runCommand
// as solver-worker.js runs it, on each of pkg/models/*.scp. Its output must
// match a native cps (if $CPS names one) and the OPB and proof it writes must
// verify with pkg/veripb.wasm. A broken model must fail with cps's error and
// write no files.
//
// Usage: [CPS=<native cps>] node web/test/solver-check.mjs
// Exit status 1 on any failure.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRoot, readFile, runCommand, writeFile } from "../host.js";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}

const cps = await WebAssembly.compile(readFileSync(join(web, "pkg/cps.wasm")));
const veripb = await WebAssembly.compile(readFileSync(join(web, "pkg/veripb.wasm")));

/** Runs `module` with `args` on `root`: `{exit, out, err}` (lines). */
function run(module, args, root) {
  const out = [];
  const err = [];
  const exit = runCommand(module, args, root, { onStdout: (l) => out.push(l), onStderr: (l) => err.push(l) });
  return { exit, out, err };
}

const models = readdirSync(join(web, "pkg/models")).filter((n) => n.endsWith(".scp"));
check("example models", models.length > 0, models.join(", "));
for (const name of models) {
  const stem = name.replace(/\.scp$/, "");
  const text = readFileSync(join(web, "pkg/models", name));
  const root = createRoot();
  writeFile(root, name, text);
  const solve = run(cps, ["cps", `/${name}`, "--proof", `/${stem}`], root);
  check(`${name}: cps exits 0`, solve.exit === 0, solve.err.join(" | "));
  if (process.env.CPS) {
    const dir = mkdtempSync(join(tmpdir(), "solver-check-"));
    try {
      writeFileSync(join(dir, name), text);
      const native = execFileSync(process.env.CPS, [name, "--proof", stem], { cwd: dir, encoding: "utf8" });
      check(`${name}: output matches native cps`, native === solve.out.map((l) => `${l}\n`).join(""));
      for (const ext of ["opb", "pbp"]) {
        const ours = readFile(root, `${stem}.${ext}`);
        check(`${name}: .${ext} matches native cps`, ours && Buffer.from(ours).equals(readFileSync(join(dir, `${stem}.${ext}`))));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const opb = readFile(root, `${stem}.opb`);
  const pbp = readFile(root, `${stem}.pbp`);
  check(`${name}: wrote .opb and .pbp`, !!opb && !!pbp);
  if (!opb || !pbp) continue;
  const verify = run(veripb, ["veripb", `/${stem}.opb`, `/${stem}.pbp`], root);
  const status = verify.out.find((l) => l.startsWith("s ")) ?? "";
  // A proof with unchecked steps (cp-solver's `Justification::Unchecked`,
  // written as `a`) verifies "UNDER ASSERTIONS": a warning, not a failure.
  check(`${name}: veripb verifies the proof`, verify.exit === 0 && /^s (VERIFIED|UNDER ASSERTIONS) /.test(status),
    `exit ${verify.exit}, ${status || verify.err.slice(-1)[0] || "no status"}`);
  if (status.startsWith("s UNDER ASSERTIONS")) console.log(`warn ${name}: the proof has unchecked assertions`);
}

const broken = createRoot();
writeFile(broken, "broken.scp", "( (version 1) (variables (x 0 1))");
const bad = run(cps, ["cps", "/broken.scp", "--proof", "/broken"], broken);
check("broken model: cps exits 1", bad.exit === 1, `exit ${bad.exit}`);
check("broken model: cps's error on stderr", bad.err.some((l) => l.startsWith("cps: /broken.scp: ")), bad.err.join(" | "));
check("broken model: no files written", !readFile(broken, "broken.opb") && !readFile(broken, "broken.pbp"));

console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
