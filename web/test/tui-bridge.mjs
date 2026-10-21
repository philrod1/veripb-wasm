// Runs classic-worker.js (the TUI) in a Node worker thread, driven by JSON
// lines on stdin; answers with JSON lines on stdout. Used by compare-tui.py
// in place of a pseudo-terminal.
//
// Usage: node web/test/tui-bridge.mjs <cols> <rows> <files-dir> [<tui arg> ...]
//   <files-dir>: copied, recursively, into the root directory first.
// stdin:  {"keys": "<text>"}      terminal input
//         {"idle": true}          wait until the TUI is waiting for input
// stdout: {"tty": "<base64>"}     terminal output since the previous reply
//         {"idle": true}          reply to "idle"
//         {"exited": <code>} | {"fatal": "<text>"}

import { Worker } from "node:worker_threads";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { createChannelBuffer, ChannelWriter } from "../tty-channel.js";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const [cols, rows, filesDir, ...tuiArgs] = process.argv.slice(2);

const buffer = createChannelBuffer();
const channel = new ChannelWriter(buffer);
channel.setSize(Number(cols), Number(rows));

const reply = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const pendingTty = [];
let finished = false;

// The worker module expects browser globals: postMessage, onmessage, fetch.
const bootstrap = `
  import { parentPort } from "node:worker_threads";
  import { readFileSync } from "node:fs";
  globalThis.onmessage = null;
  globalThis.postMessage = (message, transfer) => parentPort.postMessage(message, transfer);
  globalThis.fetch = async (url) => {
    const bytes = readFileSync(${JSON.stringify(web)} + "/" + url);
    return { ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
  };
  parentPort.on("message", (data) => globalThis.onmessage({ data }));
  await import(${JSON.stringify(new URL("../classic-worker.js", import.meta.url).href)});
`;
const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`));
worker.on("message", (message) => {
  if (message.type === "tty") pendingTty.push(Buffer.from(message.data));
  else if (message.type === "exited") { finished = true; reply({ exited: message.code }); }
  else if (message.type === "fatal") { finished = true; reply({ fatal: message.text }); }
});
worker.on("error", (error) => { finished = true; reply({ fatal: String(error?.stack ?? error) }); });

const files = [];
(function collect(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) collect(path);
    else files.push([relative(filesDir, path), readFileSync(path)]);
  }
})(filesDir);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
worker.postMessage({ type: "init", buffer, args: tuiArgs, files });

function flushTty() {
  const data = Buffer.concat(pendingTty.splice(0));
  reply({ tty: data.toString("base64") });
}

// Idle: the worker is waiting with no unread input, files delivered, and
// that state has held for a short while (its last tty message has arrived).
async function untilIdle() {
  let stable = 0;
  while (!finished && stable < 5) {
    await sleep(10);
    stable = channel.workerWaiting() && channel.mailboxIdle() ? stable + 1 : 0;
  }
  flushTty();
  reply({ idle: true });
}

const lines = createInterface({ input: process.stdin });
const queue = [];
let busy = false;
lines.on("line", (line) => { queue.push(JSON.parse(line)); pump(); });
lines.on("close", () => { queue.push({ close: true }); pump(); });

async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const command = queue.shift();
    if (command.close) { await worker.terminate(); process.exit(0); }
    if (command.keys !== undefined) channel.writeInput(command.keys);
    if (command.idle) await untilIdle();
  }
  busy = false;
}
