// Page-side connection to repl-worker.js, shared by plain and enhanced modes.
//
// connectReplWorker(host, options) starts the worker, sends host.files, and
// returns a client. `attach(view)` routes output, prompt modes and errors to
// an OutputView. `options.onState(state)` / `onPreserved` receive session
// views; `watch(on)` asks for state after every command.
// `options.onUpdating()` runs when the worker starts computing a state to
// post, and `options.onProgress({run, line})` with veripb's progress at any
// time (also passed to the view). `options.onRestart()` runs when the page
// starts a new REPL on the same files (the view's restart button).

const STARTUP_TIMEOUT_MS = 15000;
// How long `resources()` waits before reporting the worker as busy.
const BUSY_MS = 400;

export function connectReplWorker(host, { what = "REPL", onState, onUpdating, onProgress, onRestart } = {}) {
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

  // What the worker is doing, for the resources view while it is busy (a
  // busy worker answers nothing, but posts veripb's usage as it runs).
  let activity = null; // {what, since}
  let usage = null; // the latest "usage" message, with `at`
  let lastResources = null;
  let resourcesPending = null;
  const startActivity = (what) => { activity = { what, since: performance.now() }; usage = null; };

  worker.onmessage = ({ data: message }) => {
    if (message.type !== "out") {
      started = true;
      clearTimeout(startupTimer);
    }
    switch (message.type) {
      case "out":
        view?.append(message.lines, null, message.trace);
        break;
      case "usage":
        usage = { ...message, at: performance.now() };
        break;
      case "mode":
        activity = null;
        if (message.ms > 0) {
          host.setStatus(`${message.ms.toFixed(0)} ms · ${message.veripbRuns} veripb run${message.veripbRuns === 1 ? "" : "s"}`);
        }
        view?.setMode(message.mode);
        break;
      case "progress":
        view?.setProgress(message);
        onProgress?.(message);
        break;
      case "updating":
        startActivity("updating the panes (the database may need a veripb run)");
        onUpdating?.();
        break;
      case "files":
        host.setFiles(message.files);
        break;
      case "state":
        if (!message.id && !message.state?.database?.pending) activity = null;
        if (message.id) {
          waiting.get(message.id)?.(message.state);
          waiting.delete(message.id);
        } else {
          onState?.(message.state);
        }
        break;
      case "file":
      case "resources":
      case "dump":
      case "preserved":
      case "query":
        waiting.get(message.id)?.(
          message.type === "file" ? message.data
            : message.type === "dump" ? new Map(message.files)
            : message.type === "query" ? message.result
            : message.type === "resources" ? message.resources
            : message.preserved,
        );
        waiting.delete(message.id);
        break;
      case "fatal":
        activity = null;
        view?.fail(`Internal error: ${message.text}`);
        break;
    }
  };

  // A new REPL on the same files, after a crash or :quit. Its banner and
  // prompt arrive as at startup.
  function restart() {
    started = false;
    worker.postMessage({ type: "restart" });
    onRestart?.();
  }

  const putFile = (name, bytes) => worker.postMessage({ type: "put", name, data: bytes });
  for (const [name, bytes] of host.files) putFile(name, bytes);

  return {
    attach(outputView) {
      view = outputView;
      view.onRestart = restart;
    },
    line: (text) => {
      startActivity(text);
      worker.postMessage({ type: "line", text });
    },
    watch: (on) => worker.postMessage({ type: "watch", on }),
    state: () => request({ type: "state" }),
    preserved: () => request({ type: "preserved" }),
    toggleBreakpoint: (index) => worker.postMessage({ type: "breakpoint", index }),
    complete: (text) => request({ type: "query", kind: "complete", text }),
    themes: () => request({ type: "query", kind: "themes" }),
    commands: () => request({ type: "query", kind: "commands" }),
    glossary: () => request({ type: "query", kind: "glossary" }),
    lineIds: (first, last) => request({ type: "query", kind: "lineIds", first, last }),
    source: (id) => request({ type: "query", kind: "source", line: id }),
    view: (req) => request({ type: "query", kind: "view", request: req }),
    find: (req) => request({ type: "query", kind: "find", request: req }),
    edit: (edit) => request({ type: "query", kind: "edit", edit }),
    extrasStatus: () => request({ type: "query", kind: "extrasStatus" }),
    extrasObjective: () => request({ type: "query", kind: "extrasObjective" }),
    explain: (line) => request({ type: "query", kind: "explain", line }),
    paneStats: (pane) => request({ type: "query", kind: "paneStats", pane }),
    putFile,
    deleteFile: (name) => worker.postMessage({ type: "delete", name }),
    getFile: (name) => request({ type: "get", name }),
    snapshot: () => request({ type: "dump" }),
    /**
     * The worker's resources (repl-worker.js's `resources()`); if it has not
     * answered within BUSY_MS, the last answer with `live: {what, since,
     * usage}`: what it is doing and veripb's latest usage report.
     */
    resources() {
      resourcesPending ??= request({ type: "resources" }).then((r) => {
        resourcesPending = null;
        lastResources = r;
        return r;
      });
      const live = () => ({ ...(lastResources ?? {}), live: { what: activity?.what ?? "working", since: activity?.since ?? null, usage } });
      return Promise.race([resourcesPending, new Promise((resolve) => setTimeout(() => resolve(live()), BUSY_MS))]);
    },
    terminate: () => worker.terminate(),
  };
}
