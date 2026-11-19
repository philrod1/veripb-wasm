// Module worker for the Solver tab: runs cp-solver's CLI (pkg/cps.wasm) on a
// model, in a filesystem of its own, and hands back what it printed and the
// OPB and proof files it wrote. Stopping a solve is terminating the worker.
//
// Page -> worker: {type: "solve", name, text}  name: the model's file name
//   (`<stem>.scp`); runs `cps /<name> --proof /<stem>`.
// Worker -> page: {type: "out", lines} | {type: "err", lines}  as printed,
//                   in batches
//                 | {type: "done", exit, ms, opb, pbp}  opb/pbp: the files'
//                   bytes (transferred), or null if not written
//                 | {type: "fatal", text}  cps.wasm could not be loaded or
//                   trapped

import { createRoot, readFile, runCommand, writeFile } from "./host.js";

const post = (message, transfer) => postMessage(message, transfer);
let module = null;

// Output is sent in batches: one message per BATCH lines, or every 100 ms,
// and at the end. An enumeration can print a line per solution.
const BATCH = 500;
const pending = { out: [], err: [] };
let lastFlush = 0;
function flush() {
  for (const type of ["out", "err"]) {
    if (pending[type].length) post({ type, lines: pending[type] });
    pending[type] = [];
  }
  lastFlush = performance.now();
}
function line(type, text) {
  pending[type].push(text);
  if (pending[type].length >= BATCH || performance.now() - lastFlush > 100) flush();
}

async function solve({ name, text }) {
  if (!module) {
    const response = await fetch("pkg/cps.wasm");
    if (!response.ok) throw new Error(`pkg/cps.wasm: HTTP ${response.status}`);
    module = await WebAssembly.compile(await response.arrayBuffer());
  }
  const stem = name.replace(/\.scp$/i, "");
  const root = createRoot();
  writeFile(root, name, text);
  const started = performance.now();
  lastFlush = started;
  const exit = runCommand(module, ["cps", `/${name}`, "--proof", `/${stem}`], root, {
    onStdout: (text) => line("out", text),
    onStderr: (text) => line("err", text),
  });
  const ms = performance.now() - started;
  flush();
  const copy = (file) => readFile(root, file)?.slice() ?? null;
  const opb = copy(`${stem}.opb`);
  const pbp = copy(`${stem}.pbp`);
  post({ type: "done", exit, ms, opb, pbp }, [opb, pbp].filter(Boolean).map((b) => b.buffer));
}

onmessage = async ({ data: message }) => {
  if (message.type !== "solve") return;
  try {
    await solve(message);
  } catch (e) {
    flush();
    post({ type: "fatal", text: String(e) });
  }
};
