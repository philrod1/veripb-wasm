// Module worker: owns the filesystem and the REPL; the page sends input
// lines and file operations and receives output.
//
// Page -> worker: {type: "line", text} | {type: "put", name, data} | {type: "get", name}
// Worker -> page: {type: "out", text} | {type: "mode", mode} | {type: "files", files}
//                 | {type: "file", name, data} | {type: "fatal", text}

import { createRoot, startRepl, writeFile, readFile, listFiles } from "./host.js";

let root;
let repl;

const post = (message) => postMessage(message);
const postFiles = () => post({ type: "files", files: listFiles(root) });

async function compile(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return WebAssembly.compile(await response.arrayBuffer());
}

async function init() {
  const [replModule, veripbModule] = await Promise.all([
    compile("pkg/repl.wasm"),
    compile("pkg/veripb.wasm"),
  ]);
  root = createRoot();
  repl = startRepl({
    replModule,
    veripbModule,
    root,
    onLine: (text) => post({ type: "out", text }),
  });
  post({ type: "mode", mode: repl.mode });
  postFiles();
}

onmessage = ({ data: message }) => {
  try {
    switch (message.type) {
      case "line":
        post({ type: "mode", mode: repl.line(message.text) });
        postFiles();
        break;
      case "put":
        writeFile(root, message.name, new Uint8Array(message.data));
        postFiles();
        break;
      case "get":
        post({ type: "file", name: message.name, data: readFile(root, message.name) });
        break;
    }
  } catch (error) {
    post({ type: "fatal", text: String(error?.stack ?? error) });
  }
};

init().catch((error) => post({ type: "fatal", text: String(error?.stack ?? error) }));
