// Module worker for the Solver tab's diagnostics: runs pkg/scp-check.wasm
// (cp-solver's `lang::check_scp`) on the model, in a filesystem of its own,
// and hands back every error in it. Separate from solver-worker.js, so a
// long solve does not hold up checking.
//
// Page -> worker: {id, text}
// Worker -> page: {id, errors: [{kind, message, start: {line, column}, end}]}
//                 | {id, fatal}  scp-check.wasm could not be loaded or run

import { createRoot, runCommand, writeFile } from "./host.js";

let module = null;

async function check(text) {
  if (!module) {
    const response = await fetch("pkg/scp-check.wasm");
    if (!response.ok) throw new Error(`pkg/scp-check.wasm: HTTP ${response.status}`);
    module = await WebAssembly.compile(await response.arrayBuffer());
  }
  const root = createRoot();
  writeFile(root, "model.scp", text);
  const out = [];
  const err = [];
  const exit = runCommand(module, ["scp-check", "/model.scp"], root, {
    onStdout: (line) => out.push(line),
    onStderr: (line) => err.push(line),
  });
  if (exit !== 0) throw new Error(err.join("\n") || `exit ${exit}`);
  return JSON.parse(out.join("\n"));
}

onmessage = async ({ data: { id, text } }) => {
  try {
    postMessage({ id, errors: await check(text) });
  } catch (e) {
    postMessage({ id, fatal: String(e) });
  }
};
