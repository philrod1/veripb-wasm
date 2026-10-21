// Classic mode: the veripb-repl TUI (pkg/tui.wasm, run by classic-worker.js)
// in an xterm.js terminal. Needs a cross-origin-isolated page
// (SharedArrayBuffer), e.g. served by scripts/serve.py.
//
// Implements the mode interface described in modes/plain.js.

import { createChannelBuffer, ChannelWriter, MAIL_PUT, MAIL_GET, MAIL_DUMP } from "../tty-channel.js";

const FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", monospace';
const STARTUP_TIMEOUT_MS = 15000;
// Waited for a file snapshot before falling back to the files given at mount.
const SNAPSHOT_TIMEOUT_MS = 3000;

function loadStylesheet() {
  const href = new URL("../vendor/xterm/xterm.css", import.meta.url).href;
  if (!document.querySelector(`link[href="${href}"]`)) {
    document.head.appendChild(Object.assign(document.createElement("link"), { rel: "stylesheet", href }));
  }
}

/** Without cross-origin isolation: explain, and keep files so switching back loses none. */
function mountUnavailable(root, host) {
  const files = new Map(host.files);
  const message = Object.assign(document.createElement("div"), { className: "classic-unavailable" });
  message.innerHTML = `<p>Classic mode needs a cross-origin-isolated page (for <code>SharedArrayBuffer</code>).</p>
    <p>Serve the page with <code>scripts/serve.py</code>, which sends the
    <code>Cross-Origin-Opener-Policy</code> and <code>Cross-Origin-Embedder-Policy</code> headers,
    then reload.</p>`;
  root.appendChild(message);
  const list = () => host.setFiles([...files].map(([name, data]) => ({ name, size: data.byteLength })));
  list();
  return {
    putFile(name, bytes) { files.set(name, bytes); list(); },
    getFile: async (name) => files.get(name) ?? null,
    snapshot: async () => files,
    note: (text) => host.setStatus(text),
    focus() {},
    unmount() {},
  };
}

export async function mount(root, host) {
  if (!globalThis.crossOriginIsolated) return mountUnavailable(root, host);
  loadStylesheet();
  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import("../vendor/xterm/xterm.mjs"),
    import("../vendor/xterm/addon-fit.mjs"),
  ]);

  const container = Object.assign(document.createElement("div"), { className: "classic-term" });
  root.appendChild(container);
  const term = new Terminal({ fontFamily: FONT, fontSize: 14, cursorBlink: true });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);
  fit.fit();

  const buffer = createChannelBuffer();
  const channel = new ChannelWriter(buffer);
  channel.setSize(term.cols, term.rows);
  term.onResize(({ cols, rows }) => channel.setSize(cols, rows));
  term.onData((data) => channel.writeInput(data));
  term.onBinary((data) => channel.writeInput(Uint8Array.from(data, (c) => c.charCodeAt(0))));
  const resizeObserver = new ResizeObserver(() => fit.fit());
  resizeObserver.observe(container);

  const worker = new Worker(new URL("../classic-worker.js", import.meta.url), { type: "module" });
  worker.postMessage({ type: "init", buffer, files: [...host.files] });

  // Mailbox requests go one at a time; GET and DUMP resolve on the reply.
  const queue = [];
  const waiting = new Map();
  let nextId = 1;
  function pumpMail() {
    while (queue.length && channel.mailboxIdle()) {
      const { op, name, data, resolve } = queue.shift();
      const id = nextId++;
      if (resolve) waiting.set(id, resolve);
      channel.sendMail(op, id, name, data);
    }
    if (queue.length) setTimeout(pumpMail, 5);
  }
  const mail = (op, name, data, resolve) => { queue.push({ op, name, data, resolve }); pumpMail(); };

  // A worker that fails to load reports only through `error`.
  let started = false;
  const startupTimer = setTimeout(() => {
    if (!started) term.write("\r\n\x1b[2mThe TUI has not started yet. If this persists, check the browser console.\x1b[0m\r\n");
  }, STARTUP_TIMEOUT_MS);
  worker.onerror = (event) => {
    event.preventDefault();
    clearTimeout(startupTimer);
    term.write(`\r\n\x1b[31mWorker failed: ${event.message || "could not load classic-worker.js (see the browser console)"}\x1b[0m\r\n`);
  };

  worker.onmessage = ({ data: message }) => {
    started = true;
    clearTimeout(startupTimer);
    switch (message.type) {
      case "tty":
        term.write(message.data);
        break;
      case "files":
        host.setFiles(message.files);
        break;
      case "file":
      case "dump":
        waiting.get(message.id)?.(message.type === "file" ? message.data : new Map(message.files));
        waiting.delete(message.id);
        break;
      case "exited":
        term.write("\r\n\x1b[2mSession ended. Switch mode or reload the page to start again.\x1b[0m\r\n");
        host.setStatus("session ended");
        break;
      case "fatal":
        term.write(`\r\n\x1b[31mInternal error: ${message.text.replace(/\n/g, "\r\n")}\x1b[0m\r\n`);
        host.setStatus("internal error");
        break;
    }
  };
  term.focus();

  return {
    putFile: (name, bytes) => mail(MAIL_PUT, name, bytes),
    getFile: (name) => new Promise((resolve) => mail(MAIL_GET, name, undefined, resolve)),
    snapshot: () => Promise.race([
      new Promise((resolve) => mail(MAIL_DUMP, "", undefined, resolve)),
      new Promise((resolve) => setTimeout(() => resolve(host.files), SNAPSHOT_TIMEOUT_MS)),
    ]),
    note: (text) => host.setStatus(text),
    focus: () => term.focus(),
    unmount() {
      worker.terminate();
      resizeObserver.disconnect();
      term.dispose();
    },
  };
}
