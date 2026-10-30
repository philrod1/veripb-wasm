//! What each checked proof line derived, from one traced veripb run of the
//! checked lines. veripb's trace runs to several times the proof's size
//! (about 2 GB for a 220 MB proof), so it is parsed line by line as it is
//! read (`checker::invoke::run_streaming`, `parse::ConstraintIdsByLine`)
//! rather than held.

use std::collections::BTreeMap;

use veripb_repl::checker::{ProofText, invoke, parse::ConstraintIdsByLine};
use veripb_repl::session::Session;

/// Display line -> the constraint IDs it derived, for the checked lines.
pub(crate) fn line_ids(session: &Session) -> anyhow::Result<BTreeMap<usize, Vec<usize>>> {
    let checked = session.checked_len;
    if checked == 0 {
        return Ok(BTreeMap::new());
    }
    let preamble = session.preamble_lines();
    let from = preamble.len() + 1;
    let to = from + checked - 1;
    let proof = ProofText::Lines { preamble: &preamble, body: &session.buffer[..checked], tail: &[] };
    let formula = session.formula_temp_file()?;
    let mut traced = ConstraintIdsByLine::new(|n| (from..=to).contains(&n));
    invoke::run_streaming(formula.path(), proof, ["--trace-lines".to_string(), format!("{from}..={to}")], |line| {
        traced.feed(line)
    })?;
    Ok(traced.finish())
}
