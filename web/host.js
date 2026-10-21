// Runs veripb-repl (web-plain reactor) and veripb (WASI command) on one
// in-memory filesystem. Used by worker.js and test/transcript.mjs.
//
// Filesystem: `root` is the contents Map of the preopened directory "/".
// It always holds a "tmp" directory. Relative paths typed in the REPL
// resolve against "/".

import {
  WASI,
  File,
  Directory,
  OpenFile,
  PreopenDirectory,
  ConsoleStdout,
} from "./vendor/browser_wasi_shim/index.js";

/** Prompt text for each mode returned by vr_init / vr_line. */
export const PROMPTS = ["pbp> ", "edit> ", "opb> ", "debug> "];
export const MODE_QUIT = 4;

const ENV = ["HOME=/"];
const WASI_OPTIONS = { debug: false };

/** A new root directory listing containing an empty "tmp". */
export function createRoot() {
  return new Map([["tmp", new Directory(new Map())]]);
}

/**
 * Writes `data` (Uint8Array or string) to `name`, a path relative to the
 * root; missing directories are created.
 */
export function writeFile(root, name, data) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const parts = name.split("/").filter((part) => part && part !== ".");
  let dir = root;
  for (const part of parts.slice(0, -1)) {
    let entry = dir.get(part);
    if (!(entry instanceof Directory)) {
      entry = new Directory(new Map());
      dir.set(part, entry);
    }
    dir = entry.contents;
  }
  dir.set(parts.at(-1), new File(bytes));
}

/** Returns the bytes of root file `name`, or null. */
export function readFile(root, name) {
  const entry = root.get(name);
  return entry instanceof File ? entry.data : null;
}

/** Names and sizes of the regular files in the root directory. */
export function listFiles(root) {
  return [...root.entries()]
    .filter(([, entry]) => entry instanceof File)
    .map(([name, entry]) => ({ name, size: entry.data.byteLength }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The `veripb_host.run_veripb` import: runs veripb on `root` with the
 * NUL-terminated argv found in `memory()` (the calling module's memory) and
 * returns its exit code, or -1 if veripb could not be run. veripb's stdout
 * and stderr go to /tmp/.veripb-stdout and /tmp/.veripb-stderr.
 * Hooks: `onRun()` before each run, `onOutput(stdout, stderr)` after it,
 * `onError(message)` on failure. `stats.veripbRuns` counts runs.
 */
export function createVeripbRunner({ veripbModule, root, memory, onRun, onOutput, onError }) {
  const decoder = new TextDecoder();
  const stats = { veripbRuns: 0 };
  function runVeripb(ptr, len) {
    try {
      onRun?.();
      const bytes = new Uint8Array(memory().buffer, ptr, len);
      const args = decoder.decode(bytes).split("\0").slice(0, -1);
      // Regular files, not terminals: veripb then writes no colour codes,
      // as with the pipes a native subprocess gets.
      const stdout = new File([]);
      const stderr = new File([]);
      const wasi = new WASI(["veripb", ...args], ENV, [
        new OpenFile(new File([])),
        new OpenFile(stdout),
        new OpenFile(stderr),
        new PreopenDirectory("/", root),
      ], WASI_OPTIONS);
      const instance = new WebAssembly.Instance(veripbModule, {
        wasi_snapshot_preview1: wasi.wasiImport,
      });
      const code = wasi.start(instance);
      const tmp = root.get("tmp").contents;
      tmp.set(".veripb-stdout", stdout);
      tmp.set(".veripb-stderr", stderr);
      stats.veripbRuns += 1;
      onOutput?.(stdout.data, stderr.data);
      return code;
    } catch (e) {
      onError?.(`veripb failed: ${e}`);
      return -1;
    }
  }
  return { runVeripb, stats };
}

/**
 * A WASI instance for a REPL module on `root`: empty stdin, `stdout` and
 * `stderr` as given (shim Fds), the root directory preopened as "/".
 */
export function createWasi(args, { stdout, stderr, root, env = [] }) {
  return new WASI(args, [...ENV, ...env], [
    new OpenFile(new File([])),
    stdout,
    stderr,
    new PreopenDirectory("/", root),
  ], WASI_OPTIONS);
}

/**
 * Instantiates the plain-mode REPL and returns { mode, line(text) -> mode }.
 * `onLine(text)` receives every output line (stdout and stderr).
 * `onVeripbOutput(stdout, stderr)`, if given, receives the bytes of each
 * veripb run's stdout and stderr.
 * `stats.veripbRuns` counts veripb invocations.
 */
export function startRepl({ replModule, veripbModule, root, onLine, onVeripbOutput }) {
  const encoder = new TextEncoder();
  let repl;
  const { runVeripb, stats } = createVeripbRunner({
    veripbModule,
    root,
    memory: () => repl.exports.memory,
    onOutput: onVeripbOutput,
    onError: (message) => onLine(`[host] ${message}`),
  });

  const wasi = createWasi(["veripb-repl"], {
    stdout: ConsoleStdout.lineBuffered(onLine),
    stderr: ConsoleStdout.lineBuffered(onLine),
    root,
  });
  repl = new WebAssembly.Instance(replModule, {
    wasi_snapshot_preview1: wasi.wasiImport,
    veripb_host: { run_veripb: runVeripb },
  });
  wasi.initialize(repl);
  const mode = repl.exports.vr_init();

  function line(text) {
    const bytes = encoder.encode(text);
    const ptr = repl.exports.vr_alloc(bytes.length);
    new Uint8Array(repl.exports.memory.buffer, ptr, bytes.length).set(bytes);
    const next = repl.exports.vr_line(ptr, bytes.length);
    repl.exports.vr_free(ptr, bytes.length);
    return next;
  }

  return { mode, line, stats };
}
