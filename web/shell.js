// Page shell: mode menu, status line and files panel. Each mode is a module
// with `mount(root, host)` (interface described in modes/plain.js).
//
// Mode choice: `?mode=<name>` in the URL, else the last choice, else plain.
// Switching modes starts a fresh REPL; files are carried over, the proof
// session is not.

import * as plain from "./modes/plain.js";

const MODES = {
  plain: { label: "Plain", module: plain },
  classic: { label: "Classic (TUI)", module: null },
  enhanced: { label: "Enhanced", module: null },
};
const STORAGE_KEY = "veripb-repl-mode";

const modeRoot = document.getElementById("mode-root");
const modeSelect = document.getElementById("mode");
const statusText = document.getElementById("status");
const fileList = document.getElementById("files");

let current = null;
let currentName = null;
let files = new Map();

for (const [name, { label, module }] of Object.entries(MODES)) {
  const option = Object.assign(document.createElement("option"), {
    value: name,
    textContent: module ? label : `${label} — planned`,
    disabled: !module,
  });
  modeSelect.appendChild(option);
}

function initialMode() {
  const fromUrl = new URLSearchParams(location.search).get("mode");
  let stored = null;
  try { stored = localStorage.getItem(STORAGE_KEY); } catch {}
  return [fromUrl, stored, "plain"].find((name) => MODES[name]?.module);
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
  current = MODES[name].module.mount(modeRoot, {
    files,
    setStatus: (text) => { statusText.textContent = text; },
    setFiles: renderFiles,
  });
}

function renderFiles(list) {
  fileList.replaceChildren(...list.map(({ name, size }) => {
    const item = document.createElement("li");
    const link = Object.assign(document.createElement("a"), { href: "#", textContent: name, title: `Download ${name}` });
    link.addEventListener("click", async (event) => {
      event.preventDefault();
      const data = await current.getFile(name);
      if (data) download(name, data);
    });
    item.append(link, Object.assign(document.createElement("span"), { textContent: `${size} B` }));
    return item;
  }));
}

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

document.getElementById("demos").addEventListener("click", async () => {
  const names = await (await fetch("pkg/demos/index.json")).json();
  for (const name of names) current.putFile(name, new Uint8Array(await (await fetch(`pkg/demos/${name}`)).arrayBuffer()));
  current.note(`Loaded demo files: ${names.join(", ")}. Try :instance two-of-three`);
  current.focus();
});

switchTo(initialMode());
