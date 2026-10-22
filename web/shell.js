// Page shell: mode menu, status line and files panel. Each mode is a module
// with `mount(root, host)` (interface described in modes/plain.js).
//
// Mode choice: `?mode=<name>` in the URL, else the last choice, else plain.
// Switching modes starts a fresh REPL; files are carried over, the proof
// session is not.

// `load` imports the mode's module on first use (classic pulls in xterm.js).
const MODES = {
  plain: { label: "Plain", load: () => import("./modes/plain.js") },
  classic: { label: "Classic (TUI)", load: () => import("./modes/classic.js") },
  enhanced: { label: "Enhanced", load: () => import("./modes/enhanced.js") },
};
const STORAGE_KEY = "veripb-repl-mode";
const FILES_HIDDEN_KEY = "veripb-repl-files-hidden";

const modeRoot = document.getElementById("mode-root");
const modeSelect = document.getElementById("mode");
const statusText = document.getElementById("status");
const fileList = document.getElementById("files");

let current = null;
let currentName = null;
let files = new Map();

for (const [name, { label, load }] of Object.entries(MODES)) {
  const option = Object.assign(document.createElement("option"), {
    value: name,
    textContent: load ? label : `${label} — planned`,
    disabled: !load,
  });
  modeSelect.appendChild(option);
}

function initialMode() {
  const fromUrl = new URLSearchParams(location.search).get("mode");
  let stored = null;
  try { stored = localStorage.getItem(STORAGE_KEY); } catch {}
  return [fromUrl, stored, "plain"].find((name) => MODES[name]?.load);
}

async function switchTo(name) {
  if (name === currentName) return;
  if (current) {
    files = await current.snapshot();
    current.unmount();
  }
  modeRoot.replaceChildren();
  statusText.textContent = "";
  fileList.replaceChildren();
  currentName = name;
  modeSelect.value = name;
  try { localStorage.setItem(STORAGE_KEY, name); } catch {}
  const url = new URL(location.href);
  url.searchParams.set("mode", name);
  history.replaceState(null, "", url);
  const module = await MODES[name].load();
  current = await module.mount(modeRoot, {
    files,
    setStatus: (text) => { statusText.textContent = text; },
    setFiles: renderFiles,
  });
}

// Formula and proof files: their badge, and the command a double-click runs.
const FILE_KINDS = [
  { pattern: /\.opb$/i, badge: "F", title: "Formula (.opb)", command: ":load" },
  { pattern: /\.pbp$/i, badge: "P", title: "Proof (.pbp)", command: ":source" },
];

function renderFiles(list) {
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
      title: `${name}, ${size} B${kind ? `. Double-click (or Enter) to run ${kind.command} ${name}` : ""}`,
    });
    if (kind) {
      const run = () => {
        current.run(`${kind.command} ${name}`);
        current.focus();
      };
      label.addEventListener("dblclick", run);
      label.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); run(); } });
    }
    const save = Object.assign(document.createElement("button"), {
      type: "button", className: "file-action", textContent: "↓", title: `Download ${name}`,
    });
    save.setAttribute("aria-label", `Download ${name}`);
    save.addEventListener("click", async () => {
      const data = await current.getFile(name);
      if (data) download(name, data);
    });
    const remove = Object.assign(document.createElement("button"), {
      type: "button", className: "file-action delete", textContent: "×", title: `Delete ${name}`,
    });
    remove.setAttribute("aria-label", `Delete ${name}`);
    remove.addEventListener("click", () => {
      if (confirm(`Delete ${name}? Files exist only in this tab, so it cannot be recovered.`)) current.deleteFile(name);
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

modeSelect.addEventListener("change", () => switchTo(modeSelect.value));

document.getElementById("upload").addEventListener("change", async (event) => {
  for (const file of event.target.files) current.putFile(file.name, new Uint8Array(await file.arrayBuffer()));
  event.target.value = "";
  current.focus();
});

// A file set from pkg/<dir>/ (veripb-repl's demos/files or examples).
async function loadSet(dir, what, hint) {
  const names = await (await fetch(`pkg/${dir}/index.json`)).json();
  for (const name of names) current.putFile(name, new Uint8Array(await (await fetch(`pkg/${dir}/${name}`)).arrayBuffer()));
  current.note(`Loaded ${what} files: ${names.join(", ")}. ${hint}`);
  current.focus();
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
  const added = [];
  for (const file of event.dataTransfer.files) {
    if (!file.size && !file.type) continue; // directories arrive as empty, typeless entries
    current.putFile(file.name, new Uint8Array(await file.arrayBuffer()));
    added.push(file.name);
  }
  if (added.length) current.note(`Added ${added.join(", ")}.`);
  current.focus();
});

switchTo(initialMode());
