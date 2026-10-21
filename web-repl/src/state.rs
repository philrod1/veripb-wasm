//! JSON views of the session, and of the TUI's completion and palettes,
//! for the page's enhanced mode.
//!
//! Each `vr_*` query writes its JSON into a result buffer and returns the
//! length in bytes; `vr_result_ptr` gives the buffer's address. The buffer
//! is valid until the next query.

use std::cell::RefCell;

use crossterm::style::Color;
use serde_json::{Value, json};
use veripb_repl::checker::parse::{formula_line_constraints, rule_keyword};
use veripb_repl::commands::{debug, edit, formula, help};
use veripb_repl::session::Session;
use veripb_repl::tui::complete;
use veripb_repl::tui::theme::ThemeName;

use crate::{MODE_DEBUG, STATE, State};

thread_local! {
    static RESULT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn set_result(value: Value) -> i32 {
    let bytes = value.to_string().into_bytes();
    let len = bytes.len() as i32;
    RESULT.with_borrow_mut(|result| *result = bytes);
    len
}

/// Address of the last query's JSON.
#[unsafe(no_mangle)]
pub extern "C" fn vr_result_ptr() -> *const u8 {
    RESULT.with_borrow(|result| result.as_ptr())
}

/// The whole session view (see web/modes/enhanced.js for its use):
/// `{mode, formula, proof, database, variables}`; the last four are `null`
/// without a session. Runs veripb only when the database cache is stale.
#[unsafe(no_mangle)]
pub extern "C" fn vr_state() -> i32 {
    STATE.with_borrow(|state| set_result(state_json(state)))
}

/// The preserved set: `{declared, current, lastChange}` (`null` where
/// absent), `{error}`, or `null` without a session. May run veripb.
#[unsafe(no_mangle)]
pub extern "C" fn vr_preserved() -> i32 {
    STATE.with_borrow(|state| {
        let value = match &state.session {
            None => Value::Null,
            Some(session) => match session.preserved_set() {
                Ok(set) => json!({
                    "declared": set.declared,
                    "current": set.current,
                    "lastChange": set.last_change,
                }),
                Err(e) => json!({ "error": format!("{e:#}") }),
            },
        };
        set_result(value)
    })
}

/// Toggles the breakpoint on proof buffer line `index` (0-based). Returns 1
/// if there is a session, 0 otherwise.
#[unsafe(no_mangle)]
pub extern "C" fn vr_toggle_breakpoint(index: usize) -> i32 {
    STATE.with_borrow_mut(|state| match state.session.as_mut() {
        Some(session) if index < session.buffer.len() => {
            session.toggle_breakpoint(index);
            1
        }
        _ => 0,
    })
}

fn state_json(state: &State) -> Value {
    let mode = state.mode();
    let Some(session) = &state.session else {
        return json!({ "mode": mode, "formula": null, "proof": null, "database": null, "variables": null });
    };
    json!({
        "mode": mode,
        "formula": formula_json(session),
        "proof": proof_json(session, mode == MODE_DEBUG),
        "database": database_json(session),
        "variables": session.variables.names().collect::<Vec<_>>(),
    })
}

fn formula_json(session: &Session) -> Value {
    let first_ids = session.formula_first_ids();
    let lines: Vec<Value> = session
        .formula
        .iter()
        .zip(first_ids)
        .map(|(text, first)| {
            let count = formula_line_constraints(text).max(1);
            let ids = if count == 1 { first.to_string() } else { format!("{first}-{}", first + count - 1) };
            json!({ "ids": ids, "text": text })
        })
        .collect();
    let name = std::path::Path::new(&session.formula_path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| session.formula_path.clone());
    json!({
        "name": name,
        "path": session.formula_path,
        "count": session.formula_constraint_count(),
        "lines": lines,
        "objective": session.objective,
        "preserved": session.preserved,
    })
}

fn proof_json(session: &Session, debugging: bool) -> Value {
    let checked = session.checked_len;
    let lines: Vec<Value> = session
        .buffer
        .iter()
        .enumerate()
        .map(|(i, text)| {
            let status = if i < checked {
                "checked"
            } else if i == checked && session.known_bad.is_some() {
                "rejected"
            } else {
                "unchecked"
            };
            json!({
                "n": session.display_line(i),
                "index": i,
                "text": text,
                "status": status,
                "breakpoint": session.breakpoints.contains(&i),
                "assertion": rule_keyword(text) == Some("a"),
            })
        })
        .collect();
    let rejected = session.known_bad.as_ref().map(|message| {
        json!({ "n": session.display_line(checked), "message": message })
    });
    let debug_line = (debugging && !session.buffer.is_empty())
        .then(|| session.display_line(checked.min(session.buffer.len() - 1)));
    json!({
        "preamble": session.preamble_lines(),
        "lines": lines,
        "checked": checked,
        "unchecked": session.buffer.len() - checked,
        "rejected": rejected,
        "debugLine": debug_line,
        "lastStepIds": session.last_step_constraint_ids,
    })
}

fn database_json(session: &Session) -> Value {
    let labels = session.labels_by_id();
    match session.database() {
        Ok(database) => {
            let entries: Vec<Value> = database
                .entries
                .iter()
                .map(|entry| {
                    json!({
                        "id": entry.id,
                        "core": entry.is_core,
                        "text": entry.text,
                        "labels": labels.get(&(entry.id as isize)).cloned().unwrap_or_default(),
                    })
                })
                .collect();
            json!({ "entries": entries })
        }
        Err(e) => json!({ "error": format!("{e:#}") }),
    }
}

/// Tab-completion candidates for the input line `text` (UTF-8, `len` bytes
/// at `ptr`), from the TUI's completer (`tui::complete`), with the command
/// vocabulary of the current prompt mode as the TUI uses it:
/// `{candidates: [{line, left, right}], selected: index | null, common}`.
///
/// # Safety
/// `ptr` must point to `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vr_complete(ptr: *const u8, len: usize) -> i32 {
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    let text = String::from_utf8_lossy(bytes);
    STATE.with_borrow(|state| {
        // As the TUI's `App::refresh_candidates`: `:formula`'s own
        // vocabulary, or `:debug`'s plus the read-only commands every
        // edit-family mode allows; otherwise the normal registry.
        let vocabulary: Option<Vec<&help::Topic>> = if state.formula.is_some() {
            Some(formula::MODE_VOCABULARY.iter().collect())
        } else if state.debug.is_some() {
            Some(
                debug::MODE_VOCABULARY
                    .iter()
                    .chain(help::COMMANDS.iter().filter(|t| edit::READONLY_DURING_EDIT.contains(&t.name)))
                    .collect(),
            )
        } else {
            None
        };
        let candidates = complete::suggestions(&text, state.session.as_ref(), vocabulary.as_deref());
        set_result(json!({
            "candidates": candidates
                .iter()
                .map(|c| json!({ "line": c.line, "left": c.left, "right": c.right }))
                .collect::<Vec<_>>(),
            "selected": complete::default_selection(&candidates),
            "common": complete::common_line_prefix(&candidates),
        }))
    })
}

/// The TUI's colour palettes (`tui::theme`): `{default, themes: [{name,
/// colors: {slot: "#rrggbb"}}]}`, slots as in `tui::theme::Theme`.
#[unsafe(no_mangle)]
pub extern "C" fn vr_themes() -> i32 {
    let hex = |color: Color| match color {
        Color::Rgb { r, g, b } => format!("#{r:02x}{g:02x}{b:02x}"),
        other => format!("{other:?}"),
    };
    let themes: Vec<Value> = ThemeName::ALL
        .iter()
        .map(|name| {
            let t = name.theme();
            json!({
                "name": name.name(),
                "colors": {
                    "bg": hex(t.bg), "fg": hex(t.fg), "dim": hex(t.dim),
                    "variable": hex(t.variable), "label": hex(t.label),
                    "cursorAccent": hex(t.cursor_accent), "cursorBg": hex(t.cursor_bg),
                    "assertionBg": hex(t.assertion_bg), "coreBg": hex(t.core_bg),
                    "derivedBg": hex(t.derived_bg), "errorBg": hex(t.error_bg),
                    "breakpoint": hex(t.breakpoint), "errorFg": hex(t.error_fg), "okFg": hex(t.ok_fg),
                },
            })
        })
        .collect();
    set_result(json!({ "default": ThemeName::default().name(), "themes": themes }))
}

/// The REPL's `:` commands (`help::COMMANDS`): `[{name, usage, summary}]`.
#[unsafe(no_mangle)]
pub extern "C" fn vr_commands() -> i32 {
    set_result(Value::Array(
        help::COMMANDS
            .iter()
            .map(|t| json!({ "name": t.name, "usage": t.usage, "summary": t.summary }))
            .collect(),
    ))
}

/// Collects output lines, for running a command's own reporting.
struct Lines(Vec<String>);

impl veripb_repl::output::Output for Lines {
    fn line(&mut self, text: &str) {
        self.0.push(text.to_string());
    }
}

/// The Extras tab's views, or `null` without a session. Runs veripb (for
/// the objective bounds, the preserved set and `:check`'s probes).
/// ```text
/// { conclusion: {status, lines, version} | {error},
///   objective: {lines, objective, best, bestValid} | {lines, error},
///   preserved: as vr_preserved }
/// ```
/// `conclusion` is `:check` without arguments (`commands::check::run`):
/// `status` is its verdict line (`s VERIFIED …` or `NOT YET CONCLUDED`).
/// `objective.lines` is `:objective`'s output (`commands::objective::run`);
/// the bound fields are absent for a formula without an objective.
#[unsafe(no_mangle)]
pub extern "C" fn vr_extras() -> i32 {
    STATE.with_borrow(|state| {
        let Some(session) = &state.session else {
            return set_result(Value::Null);
        };
        let mut lines = Lines(Vec::new());
        let conclusion = match veripb_repl::commands::check::run(session, "", &mut lines) {
            Ok(()) => {
                const BANNER: &str = "Running VeriPB version ";
                let version = lines.0.iter().find_map(|l| l.strip_prefix(BANNER)).map(str::to_string);
                let body: Vec<&String> = lines.0.iter().filter(|l| !l.starts_with(BANNER)).collect();
                json!({ "status": body.last(), "lines": body, "version": version })
            }
            Err(e) => json!({ "error": format!("{e:#}") }),
        };
        let mut objective_lines = Lines(Vec::new());
        veripb_repl::commands::objective::run(session, &mut objective_lines);
        let objective = match session.objective.as_ref().map(|_| session.objective_bounds()) {
            None => json!({ "lines": objective_lines.0 }),
            Some(Ok(bounds)) => json!({
                "lines": objective_lines.0,
                "objective": bounds.objective,
                "best": bounds.best,
                "bestValid": bounds.best_valid,
            }),
            Some(Err(e)) => json!({ "lines": objective_lines.0, "error": format!("{e:#}") }),
        };
        let preserved = match session.preserved_set() {
            Ok(set) => json!({ "declared": set.declared, "current": set.current, "lastChange": set.last_change }),
            Err(e) => json!({ "error": format!("{e:#}") }),
        };
        set_result(json!({ "conclusion": conclusion, "objective": objective, "preserved": preserved }))
    })
}

/// `:explain <line>`'s output (`commands::explain::run`) as `{lines}`, or
/// `null` without a session. Read-only; runs veripb.
#[unsafe(no_mangle)]
pub extern "C" fn vr_explain(line: usize) -> i32 {
    STATE.with_borrow(|state| {
        let Some(session) = &state.session else {
            return set_result(Value::Null);
        };
        let mut lines = Lines(Vec::new());
        veripb_repl::commands::explain::run(session, &line.to_string(), &mut lines);
        set_result(json!({ "lines": lines.0 }))
    })
}
