//! veripb-repl's TUI as a `wasm32-wasip1` command. The host provides the
//! terminal (`crossterm_host` imports, see patches/crossterm/) and runs
//! veripb (`veripb_host.run_veripb`, see patches/veripb-repl/).
//!
//! Usage: `web-tui [<formula.opb>]`

use std::path::Path;

/// Temp files go here; WASI has no default temp directory. A dot-directory,
/// so file completion does not offer it.
const TEMP_DIR: &str = "/.tmp";

fn main() -> anyhow::Result<()> {
    let _ = tempfile::env::override_temp_dir(Path::new(TEMP_DIR));
    let formula_path = std::env::args().nth(1);
    veripb_repl::tui::run(formula_path.as_deref())
}
