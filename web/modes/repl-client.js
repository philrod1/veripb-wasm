// Page-side connection to repl-worker.js, shared by plain and enhanced modes.
//
// connectReplWorker(host, options) starts the worker, sends host.files, and
// returns a client. `attach(view)` routes output, prompt modes and errors to
// an OutputView. `options.onState(state)` / `onPreserved` receive session
// views; `watch(on)` asks for state after every command.

const STARTUP_TIMEOUT_MS = 15000;

export function connectReplWorker(host, { what = "REPL", onState } = {}) {
  const worker = new Worker(new URL("../repl-worker.js", import.meta.url), { type: "module" });
  let view = null;
  let started = false;
  let nextId = 1;
  const waiting = new Map();
  const request = (message) => new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    worker.postMessage({ ...message, id });
  });

  // A worker that fails to load reports only through `error`; one that says
  // nothing at all leaves "Loading…" up, so say so after STARTUP_TIMEOUT_MS.
  const startupTimer = setTimeout(() => {
    if (!started) view?.append(`The ${what} has not started yet. If this persists, check the browser console.`, "note");
  }, STARTUP_TIMEOUT_MS);
  worker.onerror = (event) => {
    event.preventDefault();
    view?.append(`Worker failed: ${event.message || "could not load repl-worker.js (see the browser console)"}`, "error");
    view?.setReady(false);
  };
  worker.onmessageerror = () => view?.append("Worker message could not be read.", "error");

  worker.onmessage = ({ data: message }) => {
    if (message.type !== "out") {
      started = true;
      clearTimeout(startupTimer);
    }
    switch (message.type) {
      case "out":
        view?.append(message.lines, null, message.trace);
        break;
      case "mode":
        if (message.ms > 0) {
          host.setStatus(`${message.ms.toFixed(0)} ms · ${message.veripbRuns} veripb run${message.veripbRuns === 1 ? "" : "s"}`);
        }
        view?.setMode(message.mode);
        break;
      case "files":
        host.setFiles(message.files);
        break;
      case "state":
        if (message.id) {
          waiting.get(message.id)?.(message.state);
          waiting.delete(message.id);
        } else {
          onState?.(message.state);
        }
        break;
      case "file":
      case "dump":
      case "preserved":
      case "query":
        waiting.get(message.id)?.(
          message.type === "file" ? message.data
            : message.type === "dump" ? new Map(message.files)
            : message.type === "query" ? message.result
            : message.preserved,
        );
        waiting.delete(message.id);
        break;
      case "fatal":
        view?.append(`Internal error: ${message.text}\nReload the page to start again.`, "error");
        view?.setReady(false);
        break;
    }
  };

  const putFile = (name, bytes) => worker.postMessage({ type: "put", name, data: bytes });
  for (const [name, bytes] of host.files) putFile(name, bytes);

  return {
    attach(outputView) { view = outputView; },
    line: (text) => worker.postMessage({ type: "line", text }),
    watch: (on) => worker.postMessage({ type: "watch", on }),
    state: () => request({ type: "state" }),
    preserved: () => request({ type: "preserved" }),
    toggleBreakpoint: (index) => worker.postMessage({ type: "breakpoint", index }),
    complete: (text) => request({ type: "query", kind: "complete", text }),
    themes: () => request({ type: "query", kind: "themes" }),
    commands: () => request({ type: "query", kind: "commands" }),
    glossary: () => request({ type: "query", kind: "glossary" }),
    lineIds: () => request({ type: "query", kind: "lineIds" }),
    edit: (edit) => request({ type: "query", kind: "edit", edit }),
    extras: () => request({ type: "query", kind: "extras" }),
    explain: (line) => request({ type: "query", kind: "explain", line }),
    putFile,
    deleteFile: (name) => worker.postMessage({ type: "delete", name }),
    getFile: (name) => request({ type: "get", name }),
    snapshot: () => request({ type: "dump" }),
    terminate: () => worker.terminate(),
  };
}
