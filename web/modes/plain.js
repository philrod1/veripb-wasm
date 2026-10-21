// Plain mode: veripb-repl's `--plain` line interface, run by repl-worker.js.
//
// Mode interface (shared by all modes, see shell.js):
//   mount(root, host) -> instance, or a Promise of one
//     root: element to render into (emptied by the shell on unmount)
//     host: { files: Map<name, Uint8Array>, setStatus(text), setFiles([{name, size}]) }
//   instance: { putFile(name, bytes), deleteFile(name), getFile(name) -> Promise<Uint8Array|null>,
//               snapshot() -> Promise<Map<name, Uint8Array>>, note(text), focus(), unmount() }

import { OutputView } from "./output-view.js";
import { connectReplWorker } from "./repl-client.js";

export function mount(root, host) {
  root.classList.add("plain");
  const client = connectReplWorker(host, { what: "REPL" });
  const view = new OutputView({ onSubmit: (text) => client.line(text) });
  root.append(view.out, view.form);
  client.attach(view);

  return {
    putFile: client.putFile,
    deleteFile: client.deleteFile,
    getFile: client.getFile,
    snapshot: client.snapshot,
    note: (text) => view.append(text, "note"),
    focus: () => view.focus(),
    unmount() {
      client.terminate();
      root.classList.remove("plain");
    },
  };
}
