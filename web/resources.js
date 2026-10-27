// Resource usage modal (the top bar's gauge button): memory, time and files
// for the REPL worker (repl-worker.js's `resources`), plus what the browser
// reports about the page and device. Refreshed every 2 s while open; a busy
// REPL answers when its command finishes.
//
// createResources({ source, files }) -> { open() }
//   source(): the current mode's `resources()` Promise, or null if the mode
//   has none (classic); files(): the files panel's list, used then.

// One WebAssembly memory (the REPL's, or a veripb run's) can grow to 4 GiB.
const WASM_LIMIT = 4 * 1024 ** 3;
const REFRESH_MS = 2000;
const BUSY_NOTE_MS = 400;

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

export function bytes(n) {
  if (n == null) return "–";
  const units = ["B", "KiB", "MiB", "GiB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${i ? n.toFixed(n < 10 ? 2 : n < 100 ? 1 : 0) : n} ${units[i]}`;
}

function duration(ms) {
  if (ms == null) return "–";
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ${Math.floor(s % 60)} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

const section = (title, ...body) => el("section", { className: "stats-section" }, el("h3", { textContent: title }), ...body);
const facts = (...pairs) => el("dl", {}, ...pairs.filter(Boolean).flatMap(([term, value]) =>
  [el("dt", { textContent: term }), value instanceof Node ? el("dd", {}, value) : el("dd", { textContent: value })]));

/** A meter of `used` against `limit`, with its share. */
function meter(used, limit) {
  const fill = el("div", { className: "meter-fill" });
  fill.style.width = `${Math.min(100, (100 * used) / limit)}%`;
  const bar = el("div", { className: "meter", role: "meter" }, fill);
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", String(limit));
  bar.setAttribute("aria-valuenow", String(used));
  return el("div", { className: "meter-row" }, bar,
    el("span", { className: "meter-text", textContent: `${bytes(used)} of ${bytes(limit)} (${((100 * used) / limit).toFixed(1)}%)` }));
}

function render(r, files) {
  const page = performance.memory;
  const parts = [];
  const memory = [];
  if (r?.repl) memory.push(["REPL", meter(r.repl.memoryBytes, WASM_LIMIT)]);
  if (r?.veripb?.last) memory.push(["veripb, last run", meter(r.veripb.last.memoryBytes, WASM_LIMIT)]);
  if (r?.veripb?.peakMemoryBytes) memory.push(["veripb, largest run", bytes(r.veripb.peakMemoryBytes)]);
  if (r) memory.push(["Files", `${bytes(r.filesystem.bytes)} (${bytes(r.filesystem.allocated)} allocated)`]);
  if (page) memory.push(["Page JavaScript heap", `${bytes(page.usedJSHeapSize)} of ${bytes(page.jsHeapSizeLimit)}`]);
  if (navigator.deviceMemory) memory.push(["Device memory", `at least ${navigator.deviceMemory} GiB`]);
  parts.push(section("Memory", ...(r ? [] : [el("p", { className: "muted stats-note", textContent: "The REPL's own figures are shown in Plain and Enhanced modes." })]),
    facts(...memory),
    el("p", { className: "muted stats-note", textContent: "Each WebAssembly memory (the REPL's, and each veripb run's) can grow to 4 GiB and never shrinks." })));

  if (r) {
    const last = r.commands.last;
    parts.push(section("Time", facts(
      ["Since the REPL started", duration(r.uptimeMs)],
      ["Commands", `${r.commands.count.toLocaleString()}, ${duration(r.commands.ms)} in all`],
      last && ["Last command", `${last.command} · ${duration(last.ms)}${last.veripbRuns ? ` · ${last.veripbRuns} veripb run${last.veripbRuns === 1 ? "" : "s"}` : ""}`],
      ["veripb runs", `${r.veripb.runs.toLocaleString()}, ${duration(r.veripb.ms)} in all`],
      r.veripb.last && ["Last veripb run", duration(r.veripb.last.ms)],
      ["Processor", `${navigator.hardwareConcurrency ?? "?"} logical cores; the REPL and veripb run on one`],
    ), el("p", { className: "muted stats-note", textContent: "Browsers do not report CPU use; these are elapsed times." })));
  }

  const list = r?.files ?? files;
  const table = el("table", { className: "stats-table" },
    el("thead", {}, el("tr", {}, el("th", { textContent: "File" }), el("th", { textContent: "Size" }))),
    el("tbody", {}, ...list.map(({ name, size }) => el("tr", {}, el("td", { textContent: name }), el("td", { textContent: bytes(size) })))));
  parts.push(section("Files", list.length ? table : el("p", { className: "muted", textContent: "No files." }),
    ...(r ? [facts(
      ["In all", `${list.length} file${list.length === 1 ? "" : "s"}, ${bytes(list.reduce((n, f) => n + f.size, 0))}`],
      ["Temporary", `${r.temp.files} file${r.temp.files === 1 ? "" : "s"}, ${bytes(r.temp.bytes)} (veripb's working files)`],
    )] : []),
    el("p", { className: "muted stats-note", textContent: "Files are held in this tab's memory only." })));
  return parts;
}

export function createResources({ source, files }) {
  const body = el("div", { className: "stats-body" });
  const busy = el("span", { className: "muted resources-busy", hidden: true, textContent: "REPL busy: figures update when it finishes" });
  const close = el("button", { type: "button", textContent: "Close", autofocus: true });
  const dialog = el("dialog", { className: "explain-modal stats-modal resources-modal" },
    el("header", {}, el("h2", { textContent: "Resource usage" }), busy, el("div", { className: "explain-tools" }, close)), body);
  document.body.append(dialog);
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });

  let timer = null;
  let asking = false;
  async function refresh() {
    if (asking) return;
    const pending = source();
    if (!pending) {
      body.replaceChildren(...render(null, files()));
      return;
    }
    asking = true;
    const note = setTimeout(() => { busy.hidden = false; }, BUSY_NOTE_MS);
    try {
      const r = await pending;
      if (dialog.open) body.replaceChildren(...render(r, files()));
    } finally {
      clearTimeout(note);
      busy.hidden = true;
      asking = false;
    }
  }
  dialog.addEventListener("close", () => clearInterval(timer));
  return {
    open() {
      body.replaceChildren(el("p", { className: "muted", textContent: "Measuring…" }));
      if (!dialog.open) dialog.showModal();
      refresh();
      clearInterval(timer);
      timer = setInterval(refresh, REFRESH_MS);
    },
  };
}
