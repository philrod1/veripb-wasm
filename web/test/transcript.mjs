// Runs REPL input lines through pkg/repl.wasm + pkg/veripb.wasm in Node and
// prints all output lines.
//
// Usage: node web/test/transcript.mjs <files-dir> [<dump-dir>] < input.txt
//   <files-dir>: every regular file in it is copied into the root directory.
//   <dump-dir>: afterwards, every root file is written there.
// Stderr gets one summary line: veripb runs and elapsed time.

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRoot, writeFile, readFile, listFiles, startRepl, MODE_QUIT } from "../host.js";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const [filesDir, dumpDir] = process.argv.slice(2);

const replModule = await WebAssembly.compile(readFileSync(join(web, "pkg/repl.wasm")));
const veripbModule = await WebAssembly.compile(readFileSync(join(web, "pkg/veripb.wasm")));

const root = createRoot();
if (filesDir) {
  for (const name of readdirSync(filesDir)) {
    const path = join(filesDir, name);
    if (statSync(path).isFile()) writeFile(root, name, readFileSync(path));
  }
}

const out = [];
const t0 = performance.now();
const repl = startRepl({ replModule, veripbModule, root, onLine: (l) => out.push(l) });
for (const line of readFileSync(0, "utf8").split("\n")) {
  if (repl.line(line) === MODE_QUIT) break;
}
process.stdout.write(out.map((l) => l + "\n").join(""));
if (dumpDir) {
  mkdirSync(dumpDir, { recursive: true });
  for (const { name } of listFiles(root)) writeFileSync(join(dumpDir, name), readFile(root, name));
}
console.error(`[${repl.stats.veripbRuns} veripb runs, ${(performance.now() - t0).toFixed(0)} ms]`);
