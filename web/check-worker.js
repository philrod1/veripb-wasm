// Module worker for the Solver tab's editor: runs pkg/cps.wasm to check the
// model (`cps --check --json`) and to list the constraint kinds a model can
// use (`cps --constraints --json`), each in a filesystem of its own.
// Separate from solver-worker.js, so a long solve does not hold them up.
//
// Page -> worker: {type: "check", id, text} | {type: "constraints"}
// Worker -> page: {type: "check", id, errors: [{kind, message, start: {line, column}, end}]}
//                 | {type: "constraints", kinds: [{keyword, arguments, summary, example}]}
//                 | {type, id?, fatal, unsupported}  cps.wasm could not be loaded or
//                   run; `unsupported` if this cps has no such option (an older
//                   cp-solver)

import { createRoot, runCommand, writeFile } from "./host.js";

let module = null;

/** Runs cps with `args` on `root`: its JSON output. */
async function cps(args, root) {
  if (!module) {
    const response = await fetch("pkg/cps.wasm");
    if (!response.ok) throw new Error(`pkg/cps.wasm: HTTP ${response.status}`);
    module = await WebAssembly.compile(await response.arrayBuffer());
  }
  const out = [];
  const err = [];
  // Exit status 0: all went well; 1: the model has problems, listed; else
  // cps could not run.
  const exit = runCommand(module, ["cps", ...args], root, {
    onStdout: (line) => out.push(line),
    onStderr: (line) => err.push(line),
  });
  // An older cps rejects the option (with exit status 1 or 2).
  const unsupported = err.some((line) => line.includes("unknown option"));
  if (unsupported || (exit !== 0 && exit !== 1)) {
    const error = new Error(err.join("\n") || `exit ${exit}`);
    error.unsupported = unsupported;
    throw error;
  }
  return JSON.parse(out.join("\n"));
}

onmessage = async ({ data: { type, id, text } }) => {
  try {
    if (type === "constraints") {
      postMessage({ type, kinds: await cps(["--constraints", "--json"], createRoot()) });
    } else {
      const root = createRoot();
      writeFile(root, "model.scp", text);
      postMessage({ type, id, errors: await cps(["--check", "--json", "/model.scp"], root) });
    }
  } catch (e) {
    postMessage({ type, id, fatal: String(e), unsupported: !!e.unsupported });
  }
};
