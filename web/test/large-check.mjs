// Checks that the REPL works with a proof large enough to take its memory
// past 2 GiB, where WebAssembly addresses no longer fit a signed i32 (host.js
// reads them as unsigned): a synthetic proof of comment lines is sourced
// through pkg/repl.wasm, then the session view (vr_state) is read. Where the
// allocator puts each buffer is not under the test's control, so it does not
// reliably fail without the unsigned reads; it checks that large proofs work.
// It does not verify: veripb.wasm runs in a second instance, and both
// together need more RAM than a small machine has.
//
// Usage: node --max-old-space-size=6000 web/test/large-check.mjs [lines] [padding]
//   lines: proof lines (default 1000000); padding: characters per line after
//   the line number (default 400; about 450 MB in all)
// Needs about 7 GB of RAM; not part of the default test set.
// Exit status 1 on any failure.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRoot, writeFile, startRepl } from "../host.js";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const lines = Number(process.argv[2] ?? 1_000_000);
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

let state;
t0 = performance.now();
try {
  state = repl.state();
} catch (error) {
  state = String(error);
}
check(`the session view, vr_state (${Math.round(performance.now() - t0)} ms)`, state?.proof?.lines?.length === lines,
  typeof state === "string" ? state.slice(0, 160) : `${state?.proof?.lines?.length} lines`);
check("memory past 2 GiB", repl.memoryBytes() > 2 ** 31, `${(repl.memoryBytes() / 2 ** 30).toFixed(2)} GiB`);

console.log(failures ? `${failures} failures` : "all passed");
process.exit(failures ? 1 : 0);
