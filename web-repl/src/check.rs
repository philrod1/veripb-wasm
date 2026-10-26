//! Bare `:check` with the likely conclusion tried first. veripb-repl's
//! `commands::check::run` tries `UNSAT`, `SAT` and `BOUNDS v v` in that
//! order, a full veripb run each (after one for the bounds), and shows the
//! first veripb accepts. Here, conclusions the session already points to are
//! tried first, the same way (`Session::dry_run_conclusion`, its output
//! printed as `check::run` prints a success), then the rest of
//! `check::run`'s own candidates, each conclusion once. The verdict is
//! veripb's either way; only the number of runs changes. A bare `:save`
//! finds its conclusion the same way.
//!
//! The guesses, in order:
//! - the conclusion the sourced proof file closes with (`:source` drops it);
//! - `UNSAT` if the checked database holds a contradiction (`>= k`, k > 0,
//!   with nothing on the left), when the database is already known;
//! - `SAT` if a solution is logged and the formula has no objective.

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use veripb_repl::checker::parse::rule_keyword;
use veripb_repl::output::{self, Output};
use veripb_repl::session::Session;

/// The bytes at the end of a proof file searched for its conclusion.
const TAIL_BYTES: u64 = 64 * 1024;

/// The conclusion the proof file at `path` closes with, without hint IDs
/// (`UNSAT : -1` gives `UNSAT`, which they would not fit once the proof is
/// cut short); `None` for none, `NONE`, or an unreadable file.
pub(crate) fn file_conclusion(path: &Path) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(length.saturating_sub(TAIL_BYTES))).ok()?;
    let mut tail = Vec::new();
    file.read_to_end(&mut tail).ok()?;
    let tail = String::from_utf8_lossy(&tail);
    let line = tail.lines().rev().map(str::trim).find(|line| line.starts_with("conclusion"))?;
    let conclusion = line.strip_prefix("conclusion")?.trim().trim_end_matches(';');
    let conclusion = conclusion.split(':').next()?.split_whitespace().collect::<Vec<_>>().join(" ");
    (!conclusion.is_empty() && conclusion != "NONE").then_some(conclusion)
}

/// The conclusions to try before `check::run`'s own order, most likely first.
pub(crate) fn guesses(session: &Session, sourced: Option<&str>) -> Vec<String> {
    let mut guesses: Vec<String> = sourced.into_iter().map(str::to_string).collect();
    let mut add = |guess: &str| {
        if !guesses.iter().any(|g| g == guess) {
            guesses.push(guess.to_string());
        }
    };
    if crate::views::known_database_rows(session).is_some_and(|rows| {
        rows.iter().any(|row| {
            let text = row["text"].as_str().unwrap_or("").trim();
            text.strip_prefix(">=").is_some_and(|k| k.trim().trim_end_matches(';').trim().parse::<i64>().is_ok_and(|k| k > 0))
        })
    }) {
        add("UNSAT");
    }
    if session.objective.is_none()
        && session.buffer[..session.checked_len].iter().any(|line| matches!(rule_keyword(line), Some("sol" | "soli" | "solx")))
    {
        add("SAT");
    }
    guesses
}

/// The first conclusion veripb accepts: each guess in turn, then the rest of
/// `check::run`'s own candidates (`UNSAT`, `SAT`, and `BOUNDS v v` for an
/// objective with a best value known safe), each once, in `check::run`'s
/// order; with the checker's output for it. Keep in step with
/// `auto_detect_candidates` in veripb-repl's `commands/check.rs`.
pub(crate) fn detect(session: &Session, guesses: &[String]) -> anyhow::Result<Option<(String, String)>> {
    let mut tried: Vec<String> = Vec::new();
    let mut attempt = |conclusion: &str| -> anyhow::Result<Option<(String, String)>> {
        if tried.iter().any(|t| t == conclusion) {
            return Ok(None);
        }
        tried.push(conclusion.to_string());
        let (captured, result) = session.dry_run_conclusion(conclusion)?;
        Ok(result.is_ok().then(|| (conclusion.to_string(), captured)))
    };
    for guess in guesses {
        if let Some(found) = attempt(guess)? {
            return Ok(Some(found));
        }
    }
    for conclusion in ["UNSAT", "SAT"] {
        if let Some(found) = attempt(conclusion)? {
            return Ok(Some(found));
        }
    }
    if session.objective.is_some()
        && let Ok(bounds) = session.objective_bounds()
        && let Some(value) = bounds.best_valid
    {
        return attempt(&format!("BOUNDS {value} {value}"));
    }
    Ok(None)
}

/// Bare `:check`, as `check::run` reports it; returns the conclusion found.
pub(crate) fn bare(session: &Session, guesses: &[String], out: &mut dyn Output) -> anyhow::Result<Option<String>> {
    Ok(match detect(session, guesses)? {
        Some((conclusion, captured)) => {
            output::text(out, &captured);
            Some(conclusion)
        }
        None => {
            out.line("NOT YET CONCLUDED");
            None
        }
    })
}

/// `:save <path>` with no conclusion, as `save::run` does it but finding the
/// conclusion with `detect`; keep in step with veripb-repl's
/// `commands/save.rs` (its warnings, messages and listing).
pub(crate) fn bare_save(session: &Session, path: &str, guesses: &[String], out: &mut dyn Output) -> anyhow::Result<()> {
    let pending = session.buffer.len() - session.checked_len;
    if pending > 0 {
        out.line(&format!("Warning: {pending} line(s) in the buffer haven't been checked yet — saving as-is."));
    }
    if let Some(reason) = &session.known_bad {
        out.line(&format!(
            "Warning: line {} does not verify: {reason}",
            session.display_line(session.checked_len)
        ));
    }
    let conclusion = match detect(session, guesses)? {
        Some((conclusion, captured)) => {
            output::text(out, &captured);
            conclusion
        }
        None => {
            out.line(
                "No conclusion auto-detected; saving with `conclusion NONE;` (a real \
                 no-op — see `conclusion NONE` in the guide for why that isn't a verified \
                 result). Pass an explicit conclusion to :save to claim one.",
            );
            "NONE".to_string()
        }
    };
    let text = session.listing(&conclusion);
    match std::fs::write(path, text) {
        Ok(()) => out.line(&format!(
            "Saved {} line(s) to {path} (conclusion {conclusion}).",
            session.buffer.len()
        )),
        Err(err) => out.line(&format!("Error: failed to write {path}: {err}")),
    }
    Ok(())
}
