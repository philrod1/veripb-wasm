// Checks host.js's fixes to the WASI shim's in-memory files: many small
// writes take linear time (the shim alone copies the whole file on every
// write), and readFile returns just a file's bytes.
//
// Usage: node web/test/host-check.mjs
// Exit status 1 on any failure.

import { File, OpenFile } from "../vendor/browser_wasi_shim/index.js";
import { createRoot, writeFile, readFile } from "../host.js";

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

console.log(failures ? `${failures} failures` : "all passed");
process.exit(failures ? 1 : 0);
