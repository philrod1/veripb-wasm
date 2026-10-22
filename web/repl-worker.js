// Module worker for plain and enhanced modes: owns the filesystem and the
// REPL; the page sends input lines and file operations and receives output.
//
// Page -> worker: {type: "line", text} | {type: "put", name, data} | {type: "delete", name}
//                 | {type: "get", id, name} | {type: "dump", id}
//                 | {type: "watch", on}          post session state after every line
//                 | {type: "state", id} | {type: "preserved", id}
//                 | {type: "breakpoint", index} toggle; posts state if watching
//                 | {type: "query", id, kind: "complete" | "themes" | "commands" | "glossary" | "extras" | "explain" | "lineIds", text?, line?}
// Worker -> page: {type: "out", lines, trace} | {type: "mode", mode, ms, veripbRuns}
//                 | {type: "files", files} | {type: "file", id, data}
//                 | {type: "dump", id, files: [[name, data], ...]} | {type: "fatal", text}
//                 | {type: "state", id?, state} | {type: "preserved", id, preserved}
//                 | {type: "query", id, result}
//
// Queries wait for the REPL to start.
//
// Files may be put before the REPL is ready; input lines may not.

import { createRoot, startRepl, writeFile, readFile, deleteFile, listFiles } from "./host.js";

const root = createRoot();
let repl;
let markReplReady;
const replReady = new Promise((resolve) => { markReplReady = resolve; });
let watching = false;
const postState = (id) => post({ type: "state", id, state: repl.state() });

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
  markReplReady();
  post({ type: "mode", mode: repl.mode, ms: 0, veripbRuns: 0 });
  if (watching) postState();
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
        if (watching) postState();
        postFiles();
        break;
      }
      case "watch":
        watching = message.on;
        if (watching && repl) postState();
        break;
      case "state":
        if (repl) postState(message.id);
        break;
      case "preserved":
        post({ type: "preserved", id: message.id, preserved: repl ? repl.preserved() : null });
        break;
      case "query":
        replReady.then(() => {
          const result = message.kind === "complete" ? repl.complete(message.text)
            : message.kind === "themes" ? repl.themes()
            : message.kind === "commands" ? repl.commands()
            : message.kind === "glossary" ? repl.glossary()
            : message.kind === "lineIds" ? repl.lineIds()
            : message.kind === "extras" ? repl.extras()
            : message.kind === "explain" ? repl.explain(message.line)
            : null;
          post({ type: "query", id: message.id, result });
        });
        break;
      case "breakpoint":
        if (repl?.toggleBreakpoint(message.index) && watching) postState();
        break;
      case "put":
        writeFile(root, message.name, new Uint8Array(message.data));
        postFiles();
        break;
      case "delete":
        deleteFile(root, message.name);
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
