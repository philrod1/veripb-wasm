//! JSON views of the session, and of the TUI's completion and palettes,
//! for the page's enhanced mode.
//!
//! Each `vr_*` query writes its JSON into a result buffer and returns the
//! length in bytes; `vr_result_ptr` gives the buffer's address. The buffer
//! is valid until the next query.

use std::cell::RefCell;

use crossterm::style::Color;
use serde_json::{Value, json};
use veripb_repl::checker::parse::constraint_ids_by_line;
use veripb_repl::checker::{self, CheckOutcome};
use veripb_repl::commands::{debug, edit, formula, help};
use veripb_repl::session::Session;
use veripb_repl::tui::complete;
use veripb_repl::tui::theme::ThemeName;

use crate::{MODE_DEBUG, STATE, State, views};

thread_local! {
    static RESULT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

pub(crate) fn set_result(value: Value) -> i32 {
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

/// The session summary (see web/modes/enhanced.js for its use), with the rows
/// themselves from `views::vr_view`: `{mode, generation, formula: {name, path,
/// count, lines, objective, preserved}, proof: {preamble, lines, checked,
/// unchecked, rejected: {n, message} | null, debugLine, lastStepIds,
/// breakpoints: [n]}, database: {count, core, labels} | {error}, variables}`; all but
/// `mode` are `null` without a session. `generation` changes whenever the
/// formula, proof or checked prefix does, `edits` with every buffer edit
/// through `vr_buffer_edit` (a comment edit changes only `edits`). Runs veripb only when the database
/// cache is stale.
#[unsafe(no_mangle)]
pub extern "C" fn vr_state() -> i32 {
    STATE.with_borrow(|state| set_result(state_json(state, true)))
}

/// `vr_state` without the database, which may need a veripb run (the REPL
/// replays the checked proof after it changes): `database` is
/// `{pending: true}`. Never runs veripb.
#[unsafe(no_mangle)]
pub extern "C" fn vr_state_quick() -> i32 {
    STATE.with_borrow(|state| set_result(state_json(state, false)))
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

fn state_json(state: &State, with_database: bool) -> Value {
    let mode = state.mode();
    let Some(session) = &state.session else {
        return json!({ "mode": mode, "generation": null, "formula": null, "proof": null, "database": null, "variables": null });
    };
    json!({
        "mode": mode,
        "generation": stamp(session),
        "edits": edits(),
        "formula": formula_json(session),
        "proof": proof_json(session, mode == MODE_DEBUG),
        "database": if with_database { database_json(session) } else { json!({ "pending": true }) },
        "variables": session.variables.names().collect::<Vec<_>>(),
    })
}

fn formula_json(session: &Session) -> Value {
    let name = std::path::Path::new(&session.formula_path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| session.formula_path.clone());
    json!({
        "name": name,
        "path": session.formula_path,
        "count": session.formula_constraint_count(),
        "lines": session.formula.len(),
        "objective": session.objective,
        "preserved": session.preserved,
    })
}

fn proof_json(session: &Session, debugging: bool) -> Value {
    let checked = session.checked_len;
    let rejected = session.known_bad.as_ref().map(|message| {
        json!({ "n": session.display_line(checked), "message": message })
    });
    let debug_line = (debugging && !session.buffer.is_empty())
        .then(|| session.display_line(checked.min(session.buffer.len() - 1)));
    let mut breakpoints: Vec<usize> = session.breakpoints.iter().map(|&i| session.display_line(i)).collect();
    breakpoints.sort_unstable();
    json!({
        "preamble": session.preamble_lines(),
        "lines": session.buffer.len(),
        "checked": checked,
        "unchecked": session.buffer.len() - checked,
        "rejected": rejected,
        "debugLine": debug_line,
        "lastStepIds": session.last_step_constraint_ids,
        "breakpoints": breakpoints,
    })
}

fn database_json(session: &Session) -> Value {
    match views::database_rows(session) {
        Ok(rows) => {
            let core = rows.iter().filter(|row| row["core"] == Value::Bool(true)).count();
            let labels: usize = session.labels_by_id().values().map(Vec::len).sum();
            json!({ "count": rows.len(), "core": core, "labels": labels })
        }
        Err(error) => json!({ "error": error }),
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

/// The REPL's `:` commands (`help::COMMANDS`), then the `:debug` mode's own
/// (`debug::MODE_VOCABULARY`, with `mode: "debug"`): `[{name, usage,
/// summary, mode?}]`.
#[unsafe(no_mangle)]
pub extern "C" fn vr_commands() -> i32 {
    let commands = help::COMMANDS.iter().map(|t| json!({ "name": t.name, "usage": t.usage, "summary": t.summary }));
    let debugging = debug::MODE_VOCABULARY
        .iter()
        .map(|t| json!({ "name": t.name, "usage": t.usage, "summary": t.summary, "mode": "debug" }));
    set_result(Value::Array(commands.chain(debugging).collect()))
}

thread_local! {
    /// How many buffer edits `vr_buffer_edit` has applied: with the session
    /// generation, which a comment edit leaves alone, it tells the page when
    /// to fetch rows again.
    static EDITS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

thread_local! {
    /// Bumped whenever a command may have replaced the session (`:load`,
    /// `:instance`; see `State::step`): a new session counts its generation
    /// from 0 again, so the generation alone does not tell sessions apart.
    static SESSIONS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// Marks that the session may have been replaced (see `SESSIONS`).
pub(crate) fn new_session() {
    SESSIONS.with(|n| n.set(n.get() + 1));
}

/// `session`'s state across sessions: the session count in the high bits,
/// its generation in the low 32. Every cache here is keyed by it, and the
/// page sees it as `generation`; it fits a JavaScript number.
pub(crate) fn stamp(session: &Session) -> u64 {
    (SESSIONS.with(std::cell::Cell::get) << 32) | (session.generation & 0xffff_ffff)
}

/// The count of buffer edits applied so far (see `EDITS`).
pub(crate) fn edits() -> u64 {
    EDITS.with(std::cell::Cell::get)
}

/// A whole-line comment: `%` first, after any spaces.
fn is_comment(text: &str) -> bool {
    text.trim_start().starts_with('%')
}

/// One edit to the proof buffer, recorded as one undoable action, as the
/// TUI's Vim mode records each commit. Retyping a comment as a comment keeps
/// the checked prefix, the rejection and the database (a comment changes
/// nothing veripb checks); `Session::set_line` would retract the prefix to
/// that line, as every other edit does. `json` is `{op, index, text?,
/// after?}`, with `index` a buffer index:
///   set: line `index` becomes `text` (no-op, and no undo entry, if equal)
///   insert: `text` becomes a new line before `index` (`index` = buffer
///     length appends)
///   delete: line `index` is removed
///   split: line `index` becomes `text` and `after` is inserted after it
///   join: line `index` becomes `text` and line `index + 1` is removed
/// Returns `{ok: true, generation, edits}` or `{error, generation, edits}`
/// (the session generation and edit count after it); `null` without a
/// session.
///
/// # Safety
/// `ptr` must point to `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vr_buffer_edit(ptr: *const u8, len: usize) -> i32 {
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    let Ok(edit) = serde_json::from_slice::<Value>(bytes) else {
        return set_result(json!({ "error": "malformed edit" }));
    };
    let text = edit["text"].as_str().unwrap_or("");
    let after = edit["after"].as_str().unwrap_or("");
    let Some(index) = edit["index"].as_u64().map(|i| i as usize) else {
        return set_result(json!({ "error": "edit without an index" }));
    };
    STATE.with_borrow_mut(|state| {
        let Some(session) = state.session.as_mut() else {
            return set_result(Value::Null);
        };
        let in_buffer = index < session.buffer.len();
        let before = (session.generation, session.buffer.len(), in_buffer.then(|| session.buffer[index].clone()));
        let result = match edit["op"].as_str() {
            Some("set") if in_buffer && session.buffer[index] == text => Ok(()),
            Some("set") if in_buffer && is_comment(&session.buffer[index]) && is_comment(text) => {
                let snapshot = session.snapshot();
                session.buffer[index] = text.to_string();
                session.push_undo(snapshot);
                Ok(())
            }
            Some("set" | "delete" | "split") if !in_buffer => Err(anyhow::anyhow!("no proof line at buffer index {index}")),
            Some("join") if index + 1 >= session.buffer.len() => Err(anyhow::anyhow!("no proof line after buffer index {index}")),
            Some("insert") if index > session.buffer.len() => Err(anyhow::anyhow!("no proof line at buffer index {index}")),
            Some(op @ ("set" | "insert" | "delete" | "split" | "join")) => {
                let (generation, snapshot) = (session.generation, session.snapshot());
                let result = match op {
                    "set" => session.set_line(index, text),
                    "insert" => session.insert_line(index, text),
                    "delete" => session.delete_line(index),
                    "join" => session.set_line(index, text).and_then(|()| session.delete_line(index + 1)),
                    _ => session.set_line(index, text).and_then(|()| session.insert_line(index + 1, after)),
                };
                if session.generation != generation {
                    session.push_undo(snapshot);
                }
                result
            }
            _ => Err(anyhow::anyhow!("unknown edit")),
        };
        let after = (session.generation, session.buffer.len(), in_buffer.then(|| session.buffer.get(index).cloned()).flatten());
        if before != after {
            EDITS.with(|n| n.set(n.get() + 1));
        }
        set_result(match result {
            Ok(()) => json!({ "ok": true, "generation": stamp(session), "edits": edits() }),
            Err(err) => json!({ "error": format!("{err:#}"), "generation": stamp(session), "edits": edits() }),
        })
    })
}

thread_local! {
    /// What each checked proof line derived, for the session generation it
    /// was traced at (`vr_line_ids`).
    static LINE_IDS: RefCell<Option<(u64, Result<std::collections::BTreeMap<usize, Vec<usize>>, String>)>> =
        const { RefCell::new(None) };
}

/// Runs `f` on what each checked proof line derived (display line -> IDs),
/// from a traced run of the checked lines, cached until the session changes.
fn with_line_ids<T>(session: &Session, f: impl FnOnce(&Result<std::collections::BTreeMap<usize, Vec<usize>>, String>) -> T) -> T {
    LINE_IDS.with_borrow_mut(|cache| {
        if cache.as_ref().is_none_or(|(generation, _)| *generation != stamp(session)) {
            let checked = session.checked_len;
            let traced = if checked == 0 {
                Ok(Default::default())
            } else {
                let text = session.preamble_and_lines(&session.buffer[..checked]);
                let from = session.preamble_lines().len() + 1;
                session
                    .formula_temp_file()
                    .and_then(|formula| checker::check(formula.path(), &text, Some((from, from + checked - 1))))
                    .map(|outcome| match outcome {
                        CheckOutcome::Accepted { trace } | CheckOutcome::Rejected { trace, .. } => constraint_ids_by_line(&trace),
                    })
                    .map_err(|err| format!("{err:#}"))
            };
            *cache = Some((stamp(session), traced));
        }
        f(&cache.as_ref().expect("just filled").1)
    })
}

/// The constraint IDs that checked proof lines `first..=last` (display lines)
/// derived, from a traced run of the checked lines: `{"<line>": [id, ...]}`,
/// `{error}`, or `null` without a session. The trace is cached until the
/// session changes.
#[unsafe(no_mangle)]
pub extern "C" fn vr_line_ids(first: usize, last: usize) -> i32 {
    STATE.with_borrow(|state| {
        let Some(session) = &state.session else {
            return set_result(Value::Null);
        };
        set_result(with_line_ids(session, |traced| match traced {
            Ok(by_line) => Value::Object(
                by_line.range(first..=last.max(first)).map(|(line, ids)| (line.to_string(), json!(ids))).collect(),
            ),
            Err(error) => json!({ "error": error }),
        }))
    })
}

/// Where constraint `id` came from: `{pane: "formula", position, line}` for a
/// formula constraint (`position` among the Formula pane's unfiltered rows,
/// `line` the formula line), `{pane: "proof", position, n}` for one a checked proof
/// line derived (`n` the display line; may run the traced replay of
/// `vr_line_ids`), or `null` (no session, or not found).
#[unsafe(no_mangle)]
pub extern "C" fn vr_source(id: usize) -> i32 {
    STATE.with_borrow(|state| {
        let Some(session) = &state.session else {
            return set_result(Value::Null);
        };
        if (1..=session.formula_constraint_count()).contains(&id) {
            let meta = usize::from(session.objective.is_some()) + usize::from(session.preserved.is_some());
            let found = session.formula.iter().zip(session.formula_first_ids()).position(|(text, first)| {
                (first..first + veripb_repl::checker::parse::formula_line_constraints(text).max(1)).contains(&id)
            });
            return set_result(match found {
                Some(i) => json!({ "pane": "formula", "position": meta + i, "line": i + 1 }),
                None => Value::Null,
            });
        }
        set_result(with_line_ids(session, |traced| match traced {
            Ok(by_line) => by_line
                .iter()
                .find(|(_, ids)| ids.contains(&id))
                .map_or(Value::Null, |(&n, _)| json!({ "pane": "proof", "position": n - 1, "n": n })),
            Err(_) => Value::Null,
        }))
    })
}

/// The glossary (`glossary::glossary`): concepts, and the proof rules from
/// `help::RULES`.
#[unsafe(no_mangle)]
pub extern "C" fn vr_glossary() -> i32 {
    set_result(crate::glossary::glossary())
}

/// Collects output lines, for running a command's own reporting.
struct Lines(Vec<String>);

impl veripb_repl::output::Output for Lines {
    fn line(&mut self, text: &str) {
        self.0.push(text.to_string());
    }
}

thread_local! {
    /// The output of `:check` (per conclusion) and `:objective`, for the
    /// session generation it was made at: typed at the prompt (`State::step`
    /// replays it when asked again) or worked out for the Extras tab.
    /// Command key ("check <args>", "objective") -> lines.
    static OUTPUTS: RefCell<Option<(u64, std::collections::HashMap<String, Vec<String>>)>> = const { RefCell::new(None) };
}

/// `:check`'s output as the Extras tab's Status: `{status, lines, version}`,
/// with `status` its verdict line (`s VERIFIED …` or `NOT YET CONCLUDED`).
fn status_json(lines: &[String]) -> Value {
    const BANNER: &str = "Running VeriPB version ";
    let version = lines.iter().find_map(|l| l.strip_prefix(BANNER)).map(str::to_string);
    let body: Vec<&String> = lines.iter().filter(|l| !l.starts_with(BANNER)).collect();
    json!({ "status": body.last(), "lines": body, "version": version })
}

/// Keeps a command's output (`key` as in `OUTPUTS`) for `generation`.
pub(crate) fn remember(key: &str, generation: u64, lines: &[String]) {
    OUTPUTS.with_borrow_mut(|cache| {
        if cache.as_ref().is_none_or(|(g, _)| *g != generation) {
            *cache = Some((generation, Default::default()));
        }
        cache.as_mut().expect("just set").1.insert(key.to_string(), lines.to_vec());
    });
}

/// A command's output kept for `generation`, if any.
pub(crate) fn recall(key: &str, generation: u64) -> Option<Vec<String>> {
    OUTPUTS.with_borrow(|cache| cache.as_ref().filter(|(g, _)| *g == generation).and_then(|(_, m)| m.get(key).cloned()))
}

/// The Extras tab's Status: bare `:check`'s output (`check::bare`)
/// as `{status, lines, version, conclusion, fileConclusion}` or `{error}`;
/// `null` without a session. `conclusion` is the one veripb accepted, when
/// known; `fileConclusion` the one the sourced proof file closes with.
/// Runs veripb (`:check`'s probes) unless this session generation's result
/// is known, from here or from `:check` at the prompt.
#[unsafe(no_mangle)]
pub extern "C" fn vr_extras_status() -> i32 {
    STATE.with_borrow(|state| {
        let Some(session) = &state.session else {
            return set_result(Value::Null);
        };
        let with_conclusions = |mut status: Value| {
            status["conclusion"] = json!(recall("check-conclusion", stamp(session)).and_then(|c| c.first().cloned()));
            status["fileConclusion"] = json!(state.conclusion);
            status
        };
        if let Some(lines) = recall("check ", stamp(session)) {
            return set_result(with_conclusions(status_json(&lines)));
        }
        let mut lines = Lines(Vec::new());
        let guesses = crate::check::guesses(session, state.conclusion.as_deref());
        set_result(match crate::check::bare(session, &guesses, &mut lines) {
            Ok(found) => {
                remember("check ", stamp(session), &lines.0);
                remember("check-conclusion", stamp(session), &found.into_iter().collect::<Vec<_>>());
                with_conclusions(status_json(&lines.0))
            }
            Err(e) => json!({ "error": format!("{e:#}") }),
        })
    })
}

/// The Extras tab's Objective: `:objective`'s output
/// (`commands::objective::run`) as `{lines}`; `null` without a session. Runs
/// veripb (for the bounds) unless this session generation's result is known,
/// from here or from `:objective` at the prompt.
#[unsafe(no_mangle)]
pub extern "C" fn vr_extras_objective() -> i32 {
    STATE.with_borrow(|state| {
        let Some(session) = &state.session else {
            return set_result(Value::Null);
        };
        let lines = recall("objective", stamp(session)).unwrap_or_else(|| {
            let mut lines = Lines(Vec::new());
            veripb_repl::commands::objective::run(session, &mut lines);
            remember("objective", stamp(session), &lines.0);
            lines.0
        });
        set_result(json!({ "lines": lines }))
    })
}

/// `:explain <line>`'s output (`commands::explain::run`) as `{lines, plain}`,
/// with `plain` the plain-English explanation (`teach::explain`) or `null`; or
/// `null` without a session. Read-only; runs veripb.
#[unsafe(no_mangle)]
pub extern "C" fn vr_explain(line: usize) -> i32 {
    STATE.with_borrow(|state| {
        let Some(session) = &state.session else {
            return set_result(Value::Null);
        };
        let mut lines = Lines(Vec::new());
        veripb_repl::commands::explain::run(session, &line.to_string(), &mut lines);
        set_result(json!({ "lines": lines.0, "plain": crate::teach::explain(session, line) }))
    })
}
