// Module worker for plain mode: owns the filesystem and the REPL; the page
// sends input lines and file operations and receives output.
//
// Page -> worker: {type: "line", text} | {type: "put", name, data}
//                 | {type: "get", id, name} | {type: "dump", id}
// Worker -> page: {type: "out", lines, trace} | {type: "mode", mode, ms, veripbRuns}
//                 | {type: "files", files} | {type: "file", id, data}
//                 | {type: "dump", id, files: [[name, data], ...]} | {type: "fatal", text}
//
// Files may be put before the REPL is ready; input lines may not.

import { createRoot, startRepl, writeFile, readFile, listFiles } from "./host.js";

const root = createRoot();
let repl;

// Output lines are sent in batches: one message per OUT_BATCH lines and at
// the end of each command. `trace[i]` is true when lines[i] is, verbatim, a
// line veripb printed during the current command, other than a status line
// ("s VERIFIED …"), which is a result.
const OUT_BATCH = 200;
let pending = [];
let pendingTrace = [];
let veripbLines = new Set();
const decoder = new TextDecoder();

const post = (message) => postMessage(message);
function flush() {
  if (pending.length) post({ type: "out", lines: pending, trace: pendingTrace });
  pending = [];
  pendingTrace = [];
}
function output(text) {
  pending.push(text);
  pendingTrace.push(text.trim() !== "" && !/^s [A-Z]/.test(text) && veripbLines.has(text));
  if (pending.length >= OUT_BATCH) flush();
}
function recordVeripbOutput(stdout, stderr) {
  for (const bytes of [stdout, stderr]) {
    for (const line of decoder.decode(bytes).split("\n")) veripbLines.add(line);
  }
}
const postFiles = () => post({ type: "files", files: listFiles(root) });

async function compile(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return WebAssembly.compile(await response.arrayBuffer());
}

async function init() {
  const [replModule, veripbModule] = await Promise.all([
    compile("pkg/repl.wasm"),
    compile("pkg/veripb.wasm"),
  ]);
  repl = startRepl({
    replModule,
    veripbModule,
    root,
    onLine: output,
    onVeripbOutput: recordVeripbOutput,
  });
  flush();
  post({ type: "mode", mode: repl.mode, ms: 0, veripbRuns: 0 });
  postFiles();
}

onmessage = ({ data: message }) => {
  try {
    switch (message.type) {
      case "line": {
        veripbLines = new Set();
        const runs = repl.stats.veripbRuns;
        const t0 = performance.now();
        const mode = repl.line(message.text);
        flush();
        post({ type: "mode", mode, ms: performance.now() - t0, veripbRuns: repl.stats.veripbRuns - runs });
        postFiles();
        break;
      }
      case "put":
        writeFile(root, message.name, new Uint8Array(message.data));
        postFiles();
        break;
      case "get":
        post({ type: "file", id: message.id, data: readFile(root, message.name) });
        break;
      case "dump":
        post({ type: "dump", id: message.id, files: listFiles(root).map(({ name }) => [name, readFile(root, name)]) });
        break;
    }
  } catch (error) {
    flush();
    post({ type: "fatal", text: String(error?.stack ?? error) });
  }
};

init().catch((error) => post({ type: "fatal", text: String(error?.stack ?? error) }));
