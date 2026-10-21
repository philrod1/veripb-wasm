// Module worker for classic mode: runs the veripb-repl TUI (pkg/tui.wasm)
// until it exits. Terminal input, size and file requests arrive through
// the SharedArrayBuffer channel (tty-channel.js).
//
// Page -> worker: {type: "init", buffer, args?, files?}   (once; everything else uses the channel)
//   args: arguments after argv[0], e.g. a formula path.
//   files: [[path, bytes], ...] written before the TUI starts.
// Worker -> page: {type: "tty", data} | {type: "files", files}
//                 | {type: "file", id, data} | {type: "dump", id, files: [[name, data], ...]}
//                 | {type: "exited", code} | {type: "fatal", text}

import { ConsoleStdout } from "./vendor/browser_wasi_shim/index.js";
import { createRoot, createVeripbRunner, createWasi, writeFile, readFile, deleteFile, listFiles } from "./host.js";
import { ChannelReader, MAIL_PUT, MAIL_GET, MAIL_DUMP, MAIL_DELETE } from "./tty-channel.js";

// read_input result for a terminal resize (patches/crossterm/, terminal/sys/wasi.rs).
const RESIZED = -2;
// Terminal output is posted in chunks of at most this many bytes.
const TTY_FLUSH_BYTES = 256 * 1024;

const root = createRoot();
let channel = null;
const post = (message, transfer) => postMessage(message, transfer);

let ttyChunks = [];
let ttyBytes = 0;
function flushTty() {
  if (!ttyBytes) return;
  const data = new Uint8Array(ttyBytes);
  let pos = 0;
  for (const chunk of ttyChunks) {
    data.set(chunk, pos);
    pos += chunk.length;
  }
  ttyChunks = [];
  ttyBytes = 0;
  post({ type: "tty", data }, [data.buffer]);
}
function writeTty(data) {
  ttyChunks.push(data);
  ttyBytes += data.length;
  if (ttyBytes >= TTY_FLUSH_BYTES) flushTty();
}

let lastFiles = "";
function postFilesIfChanged() {
  const files = listFiles(root);
  const key = JSON.stringify(files);
  if (key !== lastFiles) {
    lastFiles = key;
    post({ type: "files", files });
  }
}

function serveMail(request) {
  switch (request.op) {
    case MAIL_PUT:
      writeFile(root, request.name, request.data);
      postFilesIfChanged();
      break;
    case MAIL_DELETE:
      deleteFile(root, request.name);
      postFilesIfChanged();
      break;
    case MAIL_GET:
      post({ type: "file", id: request.id, data: readFile(root, request.name) });
      break;
    case MAIL_DUMP:
      post({ type: "dump", id: request.id, files: listFiles(root).map(({ name }) => [name, readFile(root, name)]) });
      break;
  }
}

async function compile(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return WebAssembly.compile(await response.arrayBuffer());
}

async function run(args) {
  const [tuiModule, veripbModule] = await Promise.all([compile("pkg/tui.wasm"), compile("pkg/veripb.wasm")]);
  let tui;
  const memory = () => tui.exports.memory;

  // A frame is complete when the TUI asks for input, or (for the "Working…"
  // frame) when it starts a veripb run.
  const { runVeripb } = createVeripbRunner({
    veripbModule,
    root,
    memory,
    onRun: flushTty,
    onError: (message) => writeTty(new TextEncoder().encode(`\r\n[host] ${message}\r\n`)),
  });

  const crosstermHost = {
    terminal_size() {
      const [cols, rows] = channel.size();
      return ((cols & 0xffff) << 16) | (rows & 0xffff);
    },
    read_input(ptr, len, timeoutMs) {
      flushTty();
      postFilesIfChanged();
      const deadline = timeoutMs < 0 ? Infinity : performance.now() + timeoutMs;
      for (;;) {
        const seq = channel.seq();
        if (channel.takeResized()) return RESIZED;
        const n = channel.readInput(new Uint8Array(memory().buffer, ptr, len), len);
        if (n > 0) return n;
        const mail = channel.takeMail();
        if (mail) {
          serveMail(mail);
          continue;
        }
        const left = deadline - performance.now();
        if (left <= 0) return 0;
        channel.wait(seq, left === Infinity ? -1 : left);
      }
    },
  };

  const wasi = createWasi(["veripb-repl", ...args], {
    stdout: new ConsoleStdout(writeTty),
    stderr: new ConsoleStdout(writeTty),
    root,
    env: ["TERM=xterm-256color", "COLORTERM=truecolor"],
  });
  tui = new WebAssembly.Instance(tuiModule, {
    wasi_snapshot_preview1: wasi.wasiImport,
    veripb_host: { run_veripb: runVeripb },
    crossterm_host: crosstermHost,
  });
  postFilesIfChanged();
  const code = wasi.start(tui);
  flushTty();
  postFilesIfChanged();
  post({ type: "exited", code });
}

// After the TUI exits or fails, keep answering file requests.
function serveFilesForever() {
  for (;;) {
    const seq = channel.seq();
    const mail = channel.takeMail();
    if (mail) serveMail(mail);
    else channel.wait(seq, -1);
  }
}

onmessage = ({ data: message }) => {
  if (message.type !== "init" || channel) return;
  channel = new ChannelReader(message.buffer);
  for (const [name, data] of message.files ?? []) writeFile(root, name, data);
  run(message.args ?? [])
    .catch((error) => {
      flushTty();
      post({ type: "fatal", text: String(error?.stack ?? error) });
    })
    .finally(serveFilesForever);
};
