// Module worker: owns the filesystem and the REPL; the page sends input
// lines and file operations and receives output.
//
// Page -> worker: {type: "line", text} | {type: "put", name, data} | {type: "get", name}
// Worker -> page: {type: "out", lines} | {type: "mode", mode, ms, veripbRuns}
//                 | {type: "files", files}
//                 | {type: "file", name, data} | {type: "fatal", text}

import { createRoot, startRepl, writeFile, readFile, listFiles } from "./host.js";

let root;
let repl;

// Output lines are sent in batches: one message per OUT_BATCH lines and at
// the end of each command.
const OUT_BATCH = 200;
let pending = [];

const post = (message) => postMessage(message);
function flush() {
  if (pending.length) post({ type: "out", lines: pending });
  pending = [];
}
function output(text) {
  pending.push(text);
  if (pending.length >= OUT_BATCH) flush();
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
  root = createRoot();
  repl = startRepl({
    replModule,
    veripbModule,
    root,
    onLine: output,
  });
  flush();
  post({ type: "mode", mode: repl.mode, ms: 0, veripbRuns: 0 });
  postFiles();
}

onmessage = ({ data: message }) => {
  try {
    switch (message.type) {
      case "line": {
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
        post({ type: "file", name: message.name, data: readFile(root, message.name) });
        break;
    }
  } catch (error) {
    flush();
    post({ type: "fatal", text: String(error?.stack ?? error) });
  }
};

init().catch((error) => post({ type: "fatal", text: String(error?.stack ?? error) }));
