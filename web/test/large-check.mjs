// Checks that enhanced mode's views cope with a large proof: a synthetic proof
// of comment lines is sourced through pkg/repl.wasm, then the summary
// (vr_state), a window at its end and a filter over every line (vr_view) are
// read, as the page does. With a large enough proof the REPL's memory passes
// 2 GiB, where WebAssembly addresses no longer fit a signed i32 (host.js reads
// them as unsigned); where the allocator puts each buffer is not under the
// test's control, so this does not reliably fail without that.
// It does not verify: veripb.wasm runs in a second instance, and both
// together need more RAM than a small machine has.
//
// Usage: node --max-old-space-size=6000 web/test/large-check.mjs [lines] [padding]
//   lines: proof lines (default 1100000); padding: characters per line after
//   the line number (default 400; about 450 MB in all)
// Needs about 7 GB of RAM; not part of the default test set.
// Exit status 1 on any failure.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRoot, writeFile, startRepl } from "../host.js";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const lines = Number(process.argv[2] ?? 1_100_000);
const padding = Number(process.argv[3] ?? 400);
let failures = 0;

function check(name, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}

// Written straight into one byte array: no strings left for the GC.
const encoder = new TextEncoder();
const header = encoder.encode("pseudo-Boolean proof version 3.0\nf 4;\n");
const lineBytes = 2 + 7 + 1 + padding + 1;
const proof = new Uint8Array(header.length + lines * lineBytes);
proof.set(header);
const row = encoder.encode(`% 0000000 ${"x".repeat(padding)}\n`);
for (let i = 0, at = header.length; i < lines; i++, at += lineBytes) {
  proof.set(row, at);
  proof.set(encoder.encode(String(i).padStart(7, "0")), at + 2);
}
console.log(`proof: ${lines} lines, ${(proof.length / 1e6).toFixed(0)} MB`);

const root = createRoot();
writeFile(root, "f.opb", readFileSync(join(web, "pkg/demos/two-of-three.opb")));
writeFile(root, "p.pbp", proof);
let out = [];
const repl = startRepl({
  replModule: await WebAssembly.compile(readFileSync(join(web, "pkg/repl.wasm"))),
  veripbModule: await WebAssembly.compile(readFileSync(join(web, "pkg/veripb.wasm"))),
  root,
  onLine: (line) => out.push(line),
});

repl.line(":load f.opb");
out = [];
let t0 = performance.now();
repl.line(":source p.pbp");
check(`:source (${Math.round(performance.now() - t0)} ms)`, out.join("\n").includes(`Loaded ${lines} line(s)`), out.join("\n").slice(0, 160));

const timed = (fn) => {
  const t = performance.now();
  try {
    return [fn(), Math.round(performance.now() - t)];
  } catch (error) {
    return [String(error), Math.round(performance.now() - t)];
  }
};
const [summary, summaryMs] = timed(() => repl.state());
check(`the summary, vr_state (${summaryMs} ms)`, summary?.proof?.lines === lines, typeof summary === "string" ? summary.slice(0, 160) : `${summary?.proof?.lines} lines`);
const [tail, tailMs] = timed(() => repl.view({ pane: "proof", start: lines + 2 - 50, count: 100 }));
const last = tail?.rows?.at(-1);
check(`the last 50 rows, vr_view (${tailMs} ms)`, tail?.total === lines + 2 && tail.rows.length === 50 && last?.n === lines + 2,
  typeof tail === "string" ? tail.slice(0, 160) : `${tail?.rows?.length} rows, last line ${last?.n}`);
const wanted = String(lines - 7).padStart(7, "0");
// Text, not digits: a filter of digits alone matches a line number.
const [found, filterMs] = timed(() => repl.view({ pane: "proof", query: `% ${wanted}`, start: 0, count: 10 }));
check(`a filter over every line (${filterMs} ms)`, found?.total === 1 && found.rows[0]?.text.startsWith(`% ${wanted}`),
  typeof found === "string" ? found.slice(0, 160) : `${found?.total} match(es)`);
const [again, againMs] = timed(() => repl.view({ pane: "proof", query: `% ${wanted}`, start: 0, count: 10 }));
check(`the same filter again, cached (${againMs} ms)`, again?.total === 1 && againMs < filterMs);
console.log(`memory: ${(repl.memoryBytes() / 2 ** 30).toFixed(2)} GiB`);

console.log(failures ? `${failures} failures` : "all passed");
process.exit(failures ? 1 : 0);
