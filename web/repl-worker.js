// Module worker for plain and enhanced modes: owns the filesystem and the
// REPL; the page sends input lines and file operations and receives output.
//
// Page -> worker: {type: "line", text} | {type: "put", name, data} | {type: "delete", name}
//                 | {type: "get", id, name} | {type: "dump", id} | {type: "resources", id}
//                 | {type: "restart"}  a new REPL on the same files (after a crash or :quit)
//                 | {type: "watch", on}          post session state after every line
//                 | {type: "state", id} | {type: "preserved", id}
//                 | {type: "breakpoint", index} toggle; posts state if watching
//                 | {type: "query", id, kind: "complete" | "themes" | "commands" | "glossary" | "extrasStatus" | "extrasObjective" | "explain" | "paneStats" | "lineIds" | "source" | "view" | "find" | "edit",
//                    text?, line?, pane?, first?, last?, request?, edit?}
// Worker -> page: {type: "out", lines, trace} | {type: "mode", mode, ms, veripbRuns}
//                 | {type: "progress", run, line, settled}  veripb run n: proof line reached, last line accepted
//                 | {type: "updating"}  computing the session state that follows
//                 | {type: "files", files} | {type: "file", id, data}
//                 | {type: "dump", id, files: [[name, data], ...]} | {type: "fatal", text}
//                 | {type: "state", id?, state} | {type: "preserved", id, preserved}
//                 | {type: "resources", id, resources}  see `resources()`
//                 | {type: "usage", phase, run, runMs, veripbMemory, stdoutBytes, replMemory}
//                     during a command, from veripb's progress and as each run ends
//                 | {type: "query", id, result}
//
// Queries wait for the REPL to start.
//
// Files may be put before the REPL is ready; input lines may not.

import { createRoot, startRepl, writeFile, readFile, deleteFile, listFiles } from "./host.js";
import { Directory, File } from "./vendor/browser_wasi_shim/index.js";

const root = createRoot();
let repl;
let markReplReady;
const replReady = new Promise((resolve) => { markReplReady = resolve; });
let watching = false;
// The summary in two steps: at once without the database, then (after
// "updating") with it. The database can take a veripb run (the REPL replays
// the proof after it changes), and the page says so meanwhile. With
// `quickOnly` (after a command in :debug mode, where each step changes the
// proof's checked prefix) the page asks for the database itself, once the
// stepping pauses.
const MODE_DEBUG = 3;
const postState = (id, quickOnly = false) => {
  if (!id) post({ type: "state", state: repl.stateQuick() });
  if (quickOnly) return;
  post({ type: "updating" });
  post({ type: "state", id, state: repl.state() });
};

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
// Lines are recorded only during a command (the output being folded), and
// not from an output larger than RECORD_LIMIT: a whole-proof trace can run to
// gigabytes, past what one string may hold. Its lines are then not folded.
const RECORD_LIMIT = 64 << 20;
let inCommand = false;
function recordVeripbOutput(stdout, stderr) {
  if (!inCommand) return;
  for (const bytes of [stdout, stderr]) {
    if (bytes.byteLength > RECORD_LIMIT) continue;
    for (const line of decoder.decode(bytes).split("\n")) veripbLines.add(line);
  }
}
const postFiles = () => post({ type: "files", files: listFiles(root) });

// Time and memory for the resources view (since the REPL last started).
let startedAt = performance.now();
let commands = { count: 0, ms: 0, last: null };
/** Bytes held by the files under `dir`: `{files, bytes, allocated}`. */
function usage(dir) {
  const total = { files: 0, bytes: 0, allocated: 0 };
  for (const entry of dir.values()) {
    const part = entry instanceof Directory ? usage(entry.contents)
      : entry instanceof File ? { files: 1, bytes: entry.data.byteLength, allocated: entry.data.buffer.byteLength }
      : null;
    if (part) for (const key in total) total[key] += part[key];
  }
  return total;
}
/**
 * `{uptimeMs, repl: {memoryBytes} | null, commands: {count, ms, last},
 * veripb: {runs, ms, last, peakMemoryBytes} | null, files: [{name, size}],
 * filesystem: {files, bytes, allocated}, temp: {files, bytes, allocated}}`;
 * `last` is `{ms, ...}` of the latest command or veripb run.
 */
const resources = () => ({
  uptimeMs: performance.now() - startedAt,
  repl: repl ? { memoryBytes: repl.memoryBytes() } : null,
  commands,
  veripb: repl ? { runs: repl.stats.veripbRuns, ms: repl.stats.veripbMs, last: repl.stats.lastVeripb, peakMemoryBytes: repl.stats.peakVeripbMemory } : null,
  files: listFiles(root),
  filesystem: usage(root),
  temp: usage(root.get(".tmp").contents),
});

async function compile(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return WebAssembly.compile(await response.arrayBuffer());
}

let modules = null;
// Each restart starts web-repl's session count above the previous REPL's
// (it bumps the count once per :load or :instance).
let restarts = 0;
const SESSIONS_PER_REPL = 4096;

async function init() {
  const [replModule, veripbModule] = modules ?? await Promise.all([
    compile("pkg/repl.wasm"),
    compile("pkg/veripb.wasm"),
  ]);
  modules = [replModule, veripbModule];
  startedAt = performance.now();
  commands = { count: 0, ms: 0, last: null };
  repl = startRepl({
    replModule,
    veripbModule,
    root,
    onLine: output,
    onVeripbOutput: recordVeripbOutput,
    // Posted while the REPL is still running: the page shows it at once.
    onProgress: (progress) => post({ type: "progress", ...progress }),
    onUsage: (usage) => post({ type: "usage", ...usage }),
    sessionBase: restarts * SESSIONS_PER_REPL,
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
        inCommand = true;
        let mode;
        try {
          mode = repl.line(message.text);
        } finally {
          inCommand = false;
        }
        flush();
        const ms = performance.now() - t0;
        commands.count += 1;
        commands.ms += ms;
        commands.last = { ms, command: message.text, veripbRuns: repl.stats.veripbRuns - runs };
        post({ type: "mode", mode, ms, veripbRuns: repl.stats.veripbRuns - runs });
        if (watching) postState(undefined, mode === MODE_DEBUG);
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
            : message.kind === "lineIds" ? repl.lineIds(message.first, message.last)
            : message.kind === "source" ? repl.source(message.line)
            : message.kind === "view" ? repl.view(message.request)
            : message.kind === "find" ? repl.find(message.request)
            : message.kind === "extrasStatus" ? repl.extrasStatus()
            : message.kind === "extrasObjective" ? repl.extrasObjective()
            : message.kind === "explain" ? repl.explain(message.line)
            : message.kind === "paneStats" ? repl.paneStats(message.pane)
            : message.kind === "edit" ? repl.bufferEdit(message.edit)
            : null;
          post({ type: "query", id: message.id, result });
          // An edit changes the buffer: send the new state after the result.
          if (message.kind === "edit" && watching) postState();
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
      case "restart":
        // The old instance (and its memory) is dropped; the files stay.
        restarts += 1;
        repl = undefined;
        pending = [];
        pendingTrace = [];
        init().catch((error) => post({ type: "fatal", text: String(error?.stack ?? error) }));
        break;
      case "resources":
        post({ type: "resources", id: message.id, resources: resources() });
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
