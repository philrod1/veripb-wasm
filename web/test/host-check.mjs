// Checks host.js's fixes to the WASI shim's in-memory files: many small
// writes take linear time (the shim alone copies the whole file on every
// write), and readFile returns just a file's bytes; and startRepl's
// onProgress, which reports the proof line a veripb run has read up to; and
// the veripb runner's watch, which stops a run whose watched file grows past
// its limit.
//
// Usage: node web/test/host-check.mjs
// Exit status 1 on any failure.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { File, OpenFile } from "../vendor/browser_wasi_shim/index.js";
import { createRoot, writeFile, readFile, startRepl, createVeripbRunner } from "../host.js";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}

// 300,000 writes of 100 bytes (30 MB): seconds at most when linear, hours
// when each write copies the file so far.
const file = new File([]);
const fd = new OpenFile(file);
const chunk = new Uint8Array(100).fill(120);
const t0 = performance.now();
for (let i = 0; i < 300_000; i++) {
  chunk[0] = i % 256;
  fd.fd_write(chunk);
}
const ms = performance.now() - t0;
check(`300000 small writes (${Math.round(ms)} ms)`, ms < 5000 && file.size === 30_000_000n, `${file.size} bytes`);
check("the written bytes", file.data[100 * 299_999] === 299_999 % 256 && file.data[1] === 120);

fd.fd_pwrite(new Uint8Array([7, 8, 9]), 29_999_999n);
check("a positioned write past the end", file.size === 30_000_002n && file.data[30_000_001] === 9);

const root = createRoot();
writeFile(root, "small.txt", new Uint8Array([1, 2, 3]));
const opened = root.get("small.txt");
new OpenFile(opened).fd_pwrite(new Uint8Array([4]), 3n);
const read = readFile(root, "small.txt");
check("readFile copies just the file's bytes", read.byteLength === 4 && read.buffer.byteLength === 4 && read[3] === 4,
  `${read.byteLength} of ${read.buffer.byteLength}`);

// Progress: each veripb run starts with {run, line: null}, then reports the
// proof line read up to.
const demo = createRoot();
for (const name of ["two-of-three.opb", "two-of-three.pbp"]) writeFile(demo, name, readFileSync(join(web, "pkg/demos", name)));
const progress = [];
const repl = startRepl({
  replModule: await WebAssembly.compile(readFileSync(join(web, "pkg/repl.wasm"))),
  veripbModule: await WebAssembly.compile(readFileSync(join(web, "pkg/veripb.wasm"))),
  root: demo,
  onLine: () => {},
  onProgress: (p) => progress.push(p),
});
repl.line(":instance two-of-three");
progress.length = 0;
repl.line(":verify");
const runs = new Set(progress.map((p) => p.run));
const lines = progress.filter((p) => p.line).map((p) => p.line);
check("progress during :verify", runs.size >= 1 && progress[0].line === null && lines.length >= 1 && lines.every((n) => n >= 1 && n <= 12),
  JSON.stringify(progress));

// The watch: veripb is stopped (-2) once the watched file passes the limit,
// and the file is emptied; under the limit, the run ends as usual.
const instances = join(web, "..", "upstream/veripb/tests/instances/correct/version3");
const veripbModule = await WebAssembly.compile(readFileSync(join(web, "pkg/veripb.wasm")));
function elaborate(limit) {
  const fs = createRoot();
  for (const ext of ["opb", "pbp"]) writeFile(fs, `f.${ext}`, readFileSync(join(instances, `set_level_withdraw.${ext}`)));
  writeFile(fs, ".tmp/elaborated", new Uint8Array());
  const memory = new WebAssembly.Memory({ initial: 1 });
  const put = (text, at) => {
    const bytes = new TextEncoder().encode(text);
    new Uint8Array(memory.buffer).set(bytes, at);
    return bytes.length;
  };
  const argsLen = put("f.opb\0f.pbp\0--elaborate\0/.tmp/elaborated\0", 0);
  const watchLen = put("/.tmp/elaborated", 1024);
  const usage = [];
  const { runVeripb } = createVeripbRunner({ veripbModule, root: fs, memory: () => memory, onUsage: (u) => usage.push(u) });
  const code = runVeripb(0, argsLen, 1024, watchLen, BigInt(limit));
  return { code, bytes: fs.get(".tmp").contents.get("elaborated").data.byteLength, stopped: usage.at(-1)?.stopped };
}
const stopped = elaborate(10);
check("watch: stopped past the limit", stopped.code === -2 && stopped.bytes === 0 && stopped.stopped === true, JSON.stringify(stopped));
const finished = elaborate(1 << 20);
check("watch: a run under the limit", finished.code === 0 && finished.bytes > 10 && finished.stopped === false, JSON.stringify(finished));

console.log(failures ? `${failures} failures` : "all passed");
process.exit(failures ? 1 : 0);
