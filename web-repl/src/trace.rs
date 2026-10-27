//! What each checked proof line derived, from a traced veripb run whose
//! trace is read a piece at a time. veripb's trace runs to several times the
//! proof's size (about 2 GB for a 220 MB proof); `checker::check` reads it
//! whole, which a large proof cannot afford in 4 GiB of WebAssembly memory.
//! Here the proof is written straight to its temp file and the trace is parsed
//! in chunks by `constraint_ids_by_line`, each starting at a line marker.

use std::collections::BTreeMap;
#[cfg(target_os = "wasi")]
use std::io::{BufRead as _, BufReader, BufWriter, Write as _};

use veripb_repl::session::Session;

/// Trace text parsed at a time; a chunk ends at the first line marker after
/// this many bytes.
#[cfg(target_os = "wasi")]
const CHUNK_BYTES: usize = 4 << 20;

#[cfg(target_os = "wasi")]
#[link(wasm_import_module = "veripb_host")]
unsafe extern "C" {
    /// The host's veripb (patches/veripb-repl, `checker::invoke::host`):
    /// NUL-terminated arguments without `argv[0]`; the exit code, or a
    /// negative value if veripb could not be run. Writes veripb's stdout to
    /// `STDOUT_PATH`.
    fn run_veripb(args_ptr: *const u8, args_len: usize) -> i32;
}

#[cfg(target_os = "wasi")]
const STDOUT_PATH: &str = "/.tmp/.veripb-stdout";

/// Display line -> the constraint IDs it derived, for the checked lines.
pub(crate) fn line_ids(session: &Session) -> anyhow::Result<BTreeMap<usize, Vec<usize>>> {
    let checked = session.checked_len;
    if checked == 0 {
        return Ok(BTreeMap::new());
    }
    let from = session.preamble_lines().len() + 1;
    let range = (from, from + checked - 1);
    #[cfg(target_os = "wasi")]
    {
        traced_run(session, range)
    }
    #[cfg(not(target_os = "wasi"))]
    {
        use veripb_repl::checker::{self, CheckOutcome};
        let text = session.preamble_and_lines(&session.buffer[..checked]);
        let formula = session.formula_temp_file()?;
        Ok(match checker::check(formula.path(), &text, Some(range))? {
            CheckOutcome::Accepted { trace } | CheckOutcome::Rejected { trace, .. } => {
                veripb_repl::checker::parse::constraint_ids_by_line(&trace)
            }
        })
    }
}

#[cfg(target_os = "wasi")]
fn traced_run(session: &Session, (from, to): (usize, usize)) -> anyhow::Result<BTreeMap<usize, Vec<usize>>> {
    use anyhow::Context as _;
    use veripb_repl::checker::parse::constraint_ids_by_line;

    let mut proof = tempfile::Builder::new().suffix(".pbp").tempfile().context("failed to create the proof's temp file")?;
    {
        let mut writer = BufWriter::new(proof.as_file_mut());
        for line in session.preamble_lines().iter().chain(&session.buffer[..session.checked_len]) {
            writer.write_all(line.as_bytes())?;
            writer.write_all(b"\n")?;
        }
        writer.flush()?;
    }
    let formula = session.formula_temp_file()?;
    let args = [
        formula.path().to_str().context("non-UTF-8 temp path")?.to_string(),
        proof.path().to_str().context("non-UTF-8 temp path")?.to_string(),
        "--trace-lines".to_string(),
        format!("{from}..={to}"),
    ];
    let mut argv = Vec::new();
    for arg in &args {
        argv.extend_from_slice(arg.as_bytes());
        argv.push(0);
    }
    let code = unsafe { run_veripb(argv.as_ptr(), argv.len()) };
    anyhow::ensure!(code >= 0, "the host could not run veripb (code {code})");

    let mut by_line: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    let mut merge = |chunk: &str| {
        for (line, ids) in constraint_ids_by_line(chunk) {
            by_line.entry(line).or_default().extend(ids);
        }
    };
    let reader = BufReader::new(std::fs::File::open(STDOUT_PATH).context("failed to read veripb's stdout")?);
    let mut chunk = String::new();
    for line in reader.lines() {
        let line = line?;
        if chunk.len() >= CHUNK_BYTES && line.starts_with("line ") {
            merge(&chunk);
            chunk.clear();
        }
        chunk.push_str(&line);
        chunk.push('\n');
    }
    merge(&chunk);
    Ok(by_line)
}
