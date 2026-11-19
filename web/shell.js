// Page shell: tab bar, status line and files panel.
//
// Two tabs, both mounted at start and kept while hidden: Solver
// (modes/solver.js) and Verify (enhanced mode, modes/enhanced.js). The
// Verify tab's worker holds the files panel's files.
//
// Verify (enhanced mode):
//   mount(root, host) -> instance
//     root: element to render into
//     host: { files: Map<name, Uint8Array>, setStatus(text), setFiles([{name, size}]) }
//   instance: { putFile(name, bytes), deleteFile(name), getFile(name) -> Promise<Uint8Array|null>,
//               snapshot() -> Promise<Map<name, Uint8Array>>, run(command), note(text), focus(), unmount(),
//               resources() -> Promise (see resources.js) }
//     run(command): runs a REPL line as if typed at the prompt.
// Solver: see modes/solver.js.
//
// Tab choice: `?mode=<name>` in the URL, else the last choice, else solver.

import { bytes, createResources } from "./resources.js";

const TABS = {
  solver: { label: "Solver", load: () => import("./modes/solver.js") },
  verify: { label: "Verify", load: () => import("./modes/enhanced.js") },
};

const STORAGE_KEY = "veripb-repl-mode";
const FILES_HIDDEN_KEY = "veripb-repl-files-hidden";

const modeRoot = document.getElementById("mode-root");
const tabBar = document.getElementById("tabs");
const statusText = document.getElementById("status");
const fileList = document.getElementById("files");

// The tabs' instances, roots, tab buttons and status lines.
const tabs = {};
let currentName = null;
let current = null;
let repl = null;
let solver = null;
let sessionHasFiles = false;
let fileListing = [];

for (const [name, { label }] of Object.entries(TABS)) {
  const root = Object.assign(document.createElement("div"), { className: `mode-tab mode-${name}`, hidden: true });
  const button = Object.assign(document.createElement("button"), { type: "button", textContent: label });
  button.setAttribute("role", "tab");
  button.setAttribute("aria-selected", "false");
  button.addEventListener("click", () => show(name));
  tabBar.append(button);
  modeRoot.append(root);
  tabs[name] = { root, button, status: "", instance: null };
}

function initialTab() {
  const fromUrl = new URLSearchParams(location.search).get("mode");
  let stored = null;
  try { stored = localStorage.getItem(STORAGE_KEY); } catch {}
  return [fromUrl, stored, "solver"].find((name) => TABS[name]);
}

/** Shows tab `name`; the other keeps its state. */
function show(name) {
  if (name === currentName || !tabs[name].instance) return;
  currentName = name;
  current = tabs[name].instance;
  for (const [key, tab] of Object.entries(tabs)) {
    tab.root.hidden = key !== name;
    tab.button.setAttribute("aria-selected", String(key === name));
  }
  statusText.textContent = tabs[name].status;
  try { localStorage.setItem(STORAGE_KEY, name); } catch {}
  const url = new URL(location.href);
  url.searchParams.set("mode", name);
  history.replaceState(null, "", url);
  current?.focus();
}

const setStatus = (name) => (text) => {
  tabs[name].status = text;
  if (currentName === name) statusText.textContent = text;
};

async function start() {
  const [verifyModule, solverModule] = await Promise.all([TABS.verify.load(), TABS.solver.load()]);
  repl = tabs.verify.instance = await verifyModule.mount(tabs.verify.root, {
    files: new Map(),
    setStatus: setStatus("verify"),
    setFiles: renderFiles,
  });
  solver = tabs.solver.instance = solverModule.mount(tabs.solver.root, {
    setStatus: setStatus("solver"),
    files: () => fileListing,
    getFile: (name) => repl.getFile(name),
    putFile: (name, data) => repl.putFile(name, data),
    download,
    // The model's OPB and proof, already put: load them into the REPL.
    verify(stem) {
      show("verify");
      repl.run(`:instance ${stem}`);
      repl.focus();
    },
  });
  show(initialTab());
}

// Files a double-click (or Enter) uses: models open in the Solver tab,
// formulas and proofs are loaded into the REPL.
const FILE_KINDS = [
  { pattern: /\.scp$/i, badge: "M", title: "Model (.scp)", action: (name) => `open ${name} in the Solver tab`,
    use(name) { show("solver"); solver.open(name); } },
  { pattern: /\.opb$/i, badge: "F", title: "Formula (.opb)", action: (name) => `run :load ${name}`,
    use(name) { show("verify"); repl.run(`:load ${name}`); repl.focus(); } },
  { pattern: /\.pbp$/i, badge: "P", title: "Proof (.pbp)", action: (name) => `run :source ${name}`,
    use(name) { show("verify"); repl.run(`:source ${name}`); repl.focus(); } },
];

function renderFiles(list) {
  fileListing = list;
  sessionHasFiles = list.length > 0;
  solver?.filesChanged();
  fileList.replaceChildren(...list.map(({ name, size }) => {
    const item = document.createElement("li");
    const kind = FILE_KINDS.find((k) => k.pattern.test(name));
    const badge = Object.assign(document.createElement("span"), {
      className: `file-kind${kind ? ` kind-${kind.badge.toLowerCase()}` : ""}`, textContent: kind?.badge ?? "",
      title: kind?.title ?? "",
    });
    badge.setAttribute("aria-hidden", "true");
    const label = Object.assign(document.createElement("button"), {
      type: "button", className: "file-name", textContent: name,
      title: `${name}, ${size} B${kind ? `. Double-click (or Enter) to ${kind.action(name)}` : ""}`,
    });
    if (kind) {
      label.addEventListener("dblclick", () => kind.use(name));
      label.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); kind.use(name); } });
    }
    const save = Object.assign(document.createElement("button"), {
      type: "button", className: "file-action", textContent: "↓", title: `Download ${name}`,
    });
    save.setAttribute("aria-label", `Download ${name}`);
    save.addEventListener("click", async () => {
      const data = await repl.getFile(name);
      if (data) download(name, data);
    });
    const remove = Object.assign(document.createElement("button"), {
      type: "button", className: "file-action delete", textContent: "×", title: `Delete ${name}`,
    });
    remove.setAttribute("aria-label", `Delete ${name}`);
    remove.addEventListener("click", () => {
      if (confirm(`Delete ${name}? Files exist only in this tab, so it cannot be recovered.`)) repl.deleteFile(name);
    });
    item.append(badge, label, save, remove);
    return item;
  }));
}

// Files panel visibility, remembered.
const filesToggle = document.getElementById("files-toggle");
function setFilesHidden(hidden) {
  document.body.classList.toggle("files-hidden", hidden);
  filesToggle.setAttribute("aria-pressed", String(!hidden));
  try { localStorage.setItem(FILES_HIDDEN_KEY, hidden ? "1" : "0"); } catch {}
}
filesToggle.addEventListener("click", () => {
  setFilesHidden(!document.body.classList.contains("files-hidden"));
  current?.focus();
});
let filesHidden = false;
try { filesHidden = localStorage.getItem(FILES_HIDDEN_KEY) === "1"; } catch {}
setFilesHidden(filesHidden);

function download(name, data) {
  const url = URL.createObjectURL(new Blob([data], { type: "text/plain" }));
  Object.assign(document.createElement("a"), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const resources = createResources({ source: () => repl?.resources() ?? null, files: () => fileListing });
document.getElementById("resources").addEventListener("click", () => resources.open());

// Files are read whole into this tab's memory, and the REPL's WebAssembly
// memory is limited to 4 GiB: a file past MAX_FILE_BYTES is not read at all,
// and one past LARGE_FILE_BYTES is added with a warning (a 220 MB proof took
// the REPL to about 1.1 GiB through :source, :verify and the database).
const MAX_FILE_BYTES = 2 * 1024 ** 3;
const LARGE_FILE_BYTES = 512 * 1024 ** 2;

/**
 * Reads `files` (File objects) and adds them to the files panel. Returns the
 * names added and notes for Output: files refused or unreadable, and
 * warnings for large ones.
 */
async function addFiles(files) {
  const added = [];
  const notes = [];
  for (const file of files) {
    const size = `${file.name} (${bytes(file.size)})`;
    if (file.size > MAX_FILE_BYTES) {
      notes.push(`Error: ${size} was not loaded: the web version supports files up to 2 GiB. The native veripb-repl supports larger ones.`);
      continue;
    }
    let data;
    try {
      data = new Uint8Array(await file.arrayBuffer());
    } catch (error) {
      notes.push(`Error: the browser could not read ${size}: ${error.message}`);
      continue;
    }
    repl.putFile(file.name, data);
    added.push(file.name);
    if (file.size > LARGE_FILE_BYTES) {
      notes.push(`Warning: ${size} is large: the web version may run out of memory loading or verifying it. The native veripb-repl supports larger proofs.`);
    }
  }
  return { added, notes };
}

document.getElementById("upload").addEventListener("change", async (event) => {
  const { notes } = await addFiles([...event.target.files]);
  event.target.value = "";
  for (const text of notes) current?.note(text);
  current?.focus();
});

// A file set from pkg/<dir>/ (veripb-repl's demos/files or examples).
async function loadSet(dir, what, hint) {
  const names = await (await fetch(`pkg/${dir}/index.json`)).json();
  for (const name of names) repl.putFile(name, new Uint8Array(await (await fetch(`pkg/${dir}/${name}`)).arrayBuffer()));
  current?.note(`Loaded ${what} files: ${names.join(", ")}. ${hint}`);
  current?.focus();
}
document.getElementById("demos").addEventListener("click", () => loadSet("demos", "demo", "Try :instance two-of-three"));
document.getElementById("examples").addEventListener("click", () =>
  loadSet("examples", "example", "Double-click a file to :load or :source it."));

// Files dropped anywhere on the page are added (base names only).
const dropOverlay = document.getElementById("drop-overlay");
let dragDepth = 0;
const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes("Files");
document.addEventListener("dragenter", (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth += 1;
  dropOverlay.hidden = false;
});
document.addEventListener("dragover", (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
});
document.addEventListener("dragleave", (event) => {
  if (!hasFiles(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropOverlay.hidden = true;
});
document.addEventListener("drop", async (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;
  // Directories arrive as empty, typeless entries.
  const { added, notes } = await addFiles([...event.dataTransfer.files].filter((file) => file.size || file.type));
  if (added.length) current?.note(`Added ${added.join(", ")}.`);
  for (const text of notes) current?.note(text);
  current?.focus();
});

// Leaving the page loses the session: its files exist only in this tab.
// Backspace outside a text field does nothing (some browsers go back), and
// with files present, or a model edited and not saved, the browser asks
// before navigating away (Alt+←, ⌘+[, reload, closing the tab). Trackpad
// swipes: style.css.
const editable = (target) => target instanceof HTMLElement
  && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
document.addEventListener("keydown", (event) => {
  if (event.key === "Backspace" && !editable(event.target)) event.preventDefault();
});
addEventListener("beforeunload", (event) => {
  if (!sessionHasFiles && !solver?.dirty()) return;
  event.preventDefault();
  event.returnValue = "";
});

start();
