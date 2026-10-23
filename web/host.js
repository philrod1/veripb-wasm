// Runs veripb-repl (web-repl reactor) and veripb (WASI command) on one
// in-memory filesystem. Used by worker.js and test/transcript.mjs.
//
// Filesystem: `root` is the contents Map of the preopened directory "/".
// It always holds a ".tmp" directory for temp files. Relative paths typed in the REPL
// resolve against "/".

import {
  WASI,
  File,
  Directory,
  OpenFile,
  PreopenDirectory,
  ConsoleStdout,
  wasi as wasiDefs,
} from "./vendor/browser_wasi_shim/index.js";

// The shim grows a file to exactly fit each write, copying it every time, so
// n bytes written in small pieces cost O(n²): veripb writing a 178 MB trace a
// line at a time took minutes. Grow the storage geometrically instead; a
// file's `data` stays a view of exactly its size, so the rest of the shim is
// unchanged.
function reserve(file, size) {
  if (size <= file.data.byteLength) return;
  const { buffer, byteOffset } = file.data;
  if (byteOffset === 0 && size <= buffer.byteLength) {
    file.data = new Uint8Array(buffer, 0, size);
    return;
  }
  const grown = new Uint8Array(Math.max(size, 2 * file.data.byteLength, 4096));
  grown.set(file.data);
  file.data = grown.subarray(0, size);
}
OpenFile.prototype.fd_write = function (data) {
  if (this.file.readonly) return { ret: wasiDefs.ERRNO_BADF, nwritten: 0 };
  const at = Number(this.file_pos);
  reserve(this.file, at + data.byteLength);
  this.file.data.set(data, at);
  this.file_pos += BigInt(data.byteLength);
  return { ret: 0, nwritten: data.byteLength };
};
OpenFile.prototype.fd_pwrite = function (data, offset) {
  if (this.file.readonly) return { ret: wasiDefs.ERRNO_BADF, nwritten: 0 };
  reserve(this.file, Number(offset) + data.byteLength);
  this.file.data.set(data, Number(offset));
  return { ret: 0, nwritten: data.byteLength };
};

/** Prompt text for each mode returned by vr_init / vr_line. */
export const PROMPTS = ["pbp> ", "edit> ", "opb> ", "debug> "];
export const MODE_QUIT = 4;

const ENV = ["HOME=/"];
const WASI_OPTIONS = { debug: false };

/** A new root directory listing containing an empty ".tmp". */
export function createRoot() {
  return new Map([[".tmp", new Directory(new Map())]]);
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

/** Removes root file `name`, if it exists. */
export function deleteFile(root, name) {
  if (root.get(name) instanceof File) root.delete(name);
}

/** Returns the bytes of root file `name`, or null. */
export function readFile(root, name) {
  const entry = root.get(name);
  if (!(entry instanceof File)) return null;
  // A file with spare capacity (see reserve): copy just its bytes, since
  // posting a view would copy its whole buffer.
  const { data } = entry;
  return data.byteLength === data.buffer.byteLength ? data : data.slice();
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
 * and stderr go to /.tmp/.veripb-stdout and /.tmp/.veripb-stderr.
 * Hooks: `onRun()` before each run, `onOutput(stdout, stderr)` after it,
 * `onError(message)` on failure. `stats.veripbRuns` counts runs.
 */
export function createVeripbRunner({ veripbModule, root, memory, onRun, onOutput, onError }) {
  const decoder = new TextDecoder();
  const stats = { veripbRuns: 0 };
  function runVeripb(ptr, len) {
    try {
      onRun?.();
      const bytes = new Uint8Array(memory().buffer, ptr >>> 0, len >>> 0);
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
      const tmp = root.get(".tmp").contents;
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
  const wasi = new WASI(args, [...ENV, ...env], [
    new OpenFile(new File([])),
    stdout,
    stderr,
    new PreopenDirectory("/", root),
  ], WASI_OPTIONS);
  // WebAssembly passes i32 arguments to JavaScript as signed numbers, so an
  // address above 2 GiB arrives negative and the shim's DataView and
  // Uint8Array calls throw. No WASI i32 argument is negative by meaning
  // (addresses, lengths, descriptors, flags), so read each as unsigned; i64
  // arguments arrive as BigInts and pass through.
  for (const [name, fn] of Object.entries(wasi.wasiImport)) {
    wasi.wasiImport[name] = (...argv) => fn(...argv.map((a) => (typeof a === "number" ? a >>> 0 : a)));
  }
  return wasi;
}

/**
 * Instantiates the REPL (plain and enhanced modes) and returns
 * { mode, line(text) -> mode, state(), preserved(), toggleBreakpoint(index),
 *   complete(text), themes(), commands(), glossary(), extras(), explain(line),
 *   lineIds(first, last), view({pane, start, count, query?, core?, derived?}),
 *   find({label} | {id}), bufferEdit({op, index, text?, after?}), memoryBytes(), stats }.
 * `state()` and `preserved()` return the parsed JSON of web-repl's
 * `vr_state` / `vr_preserved` (web-repl/src/state.rs).
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
    const ptr = repl.exports.vr_alloc(bytes.length) >>> 0;
    new Uint8Array(repl.exports.memory.buffer, ptr, bytes.length).set(bytes);
    const next = repl.exports.vr_line(ptr, bytes.length);
    repl.exports.vr_free(ptr, bytes.length);
    return next;
  }

  // Calls an export taking a JSON argument (ptr, len) and returning a result.
  function jsonCall(fn, value) {
    const bytes = encoder.encode(JSON.stringify(value));
    const ptr = repl.exports.vr_alloc(bytes.length) >>> 0;
    new Uint8Array(repl.exports.memory.buffer, ptr, bytes.length).set(bytes);
    const len = fn(ptr, bytes.length);
    repl.exports.vr_free(ptr, bytes.length);
    return result(len);
  }

  const decoder = new TextDecoder();
  function result(len) {
    const bytes = new Uint8Array(repl.exports.memory.buffer, repl.exports.vr_result_ptr() >>> 0, len >>> 0);
    return JSON.parse(decoder.decode(bytes));
  }

  return {
    mode,
    line,
    state: () => result(repl.exports.vr_state()),
    preserved: () => result(repl.exports.vr_preserved()),
    toggleBreakpoint: (index) => repl.exports.vr_toggle_breakpoint(index) === 1,
    complete(text) {
      const bytes = encoder.encode(text);
      const ptr = repl.exports.vr_alloc(bytes.length) >>> 0;
      new Uint8Array(repl.exports.memory.buffer, ptr, bytes.length).set(bytes);
      const len = repl.exports.vr_complete(ptr, bytes.length);
      repl.exports.vr_free(ptr, bytes.length);
      return result(len);
    },
    themes: () => result(repl.exports.vr_themes()),
    commands: () => result(repl.exports.vr_commands()),
    glossary: () => result(repl.exports.vr_glossary()),
    lineIds: (first, last) => result(repl.exports.vr_line_ids(first, last)),
    view: (request) => jsonCall(repl.exports.vr_view, request),
    find: (request) => jsonCall(repl.exports.vr_find, request),
    bufferEdit: (edit) => jsonCall(repl.exports.vr_buffer_edit, edit),
    extras: () => result(repl.exports.vr_extras()),
    explain: (line) => result(repl.exports.vr_explain(line)),
    memoryBytes: () => repl.exports.memory.buffer.byteLength,
    stats,
  };
}
