//! veripb-repl's line interface as a `wasm32-wasip1` reactor, for the
//! page's plain and enhanced modes.
//!
//! The host calls `vr_init` once, then `vr_line` for each input line. All
//! output goes to stdout. veripb itself runs through the host import
//! `veripb_host.run_veripb` (see `checker/invoke.rs`). `state.rs` adds
//! JSON views of the session for enhanced mode.
//!
//! The mode handling matches `veripb_repl::plain::run`, except that errors
//! are printed and the session continues.

mod check;
mod glossary;
mod state;
mod stats;
mod teach;
mod trace;
mod views;

use std::cell::RefCell;
use std::path::Path;

use veripb_repl::commands::{self, Flow, debug, edit, formula, help};
use veripb_repl::output::{self, Output, Stdout};
use veripb_repl::session::Session;

/// Prompt modes returned by `vr_init` and `vr_line`.
const MODE_PBP: i32 = 0;
const MODE_EDIT: i32 = 1;
const MODE_FORMULA: i32 = 2;
pub(crate) const MODE_DEBUG: i32 = 3;
const MODE_QUIT: i32 = 4;

/// Temp files go here; WASI has no default temp directory. A dot-directory,
/// so file completion does not offer it.
const TEMP_DIR: &str = "/.tmp";

#[derive(Default)]
pub(crate) struct State {
    session: Option<Session>,
    edit: Option<edit::EditState>,
    formula: Option<formula::FormulaEditState>,
    debug: Option<debug::DebugState>,
    /// The conclusion the last sourced proof file closes with (hint IDs
    /// dropped), for bare `:check` to try first; see `check::guesses`.
    pub(crate) conclusion: Option<String>,
}

impl State {
    pub(crate) fn mode(&self) -> i32 {
        if self.debug.is_some() {
            MODE_DEBUG
        } else if self.formula.is_some() {
            MODE_FORMULA
        } else if self.edit.is_some() {
            MODE_EDIT
        } else {
            MODE_PBP
        }
    }

    fn step(&mut self, line: &str) -> anyhow::Result<i32> {
        let out = &mut Stdout;

        // Edit and formula modes give a blank line a meaning ("keep
        // unchanged"), so they see every line.
        if let Some(state) = self.edit.as_mut() {
            let session = self.session.as_mut().expect("edit mode implies a loaded session");
            if let edit::EditFlow::Ended = edit::handle(session, state, line, out)? {
                self.edit = None;
            }
            return Ok(self.mode());
        }
        if let Some(state) = self.formula.as_mut() {
            let session = self.session.as_mut().expect("formula mode implies a loaded session");
            if let formula::FormulaEditFlow::Ended = formula::handle(session, state, line, out)? {
                self.formula = None;
            }
            return Ok(self.mode());
        }
        if let Some(state) = self.debug.as_mut() {
            let session = self.session.as_mut().expect("debug mode implies a loaded session");
            if let debug::DebugFlow::Ended = debug::handle(session, state, line, out)? {
                self.debug = None;
            }
            return Ok(self.mode());
        }

        if line.is_empty() {
            return Ok(self.mode());
        }
        // `:check` and `:objective` answer from the proof as it stands: asked
        // again before the session changes, the output they gave is shown
        // again rather than worked out anew (the same cache serves the
        // Extras tab). A bare `:check` or `:save` tries the likely
        // conclusions first (`check::guesses`). Otherwise output goes to stdout as ever; for
        // these commands and those that load a proof, a copy is kept.
        let name = command_name(line);
        let key = cached_command(line);
        if let (Some(key), Some(session)) = (&key, &self.session)
            && let Some(lines) = state::recall(key, state::stamp(session))
        {
            for text in &lines {
                out.line(text);
            }
            return Ok(self.mode());
        }
        let keep = key.is_some() || matches!(name, Some("source" | "instance" | "load"));
        let mut tee = Tee { out, lines: Vec::new(), keep };
        let save_path = (name == Some("save")).then(|| bare_save_path(line)).flatten();
        let flow = match (&key, &self.session, save_path) {
            (Some(key), Some(session), _) if key == "check " => {
                let guesses = check::guesses(session, self.conclusion.as_deref());
                let found = check::bare(session, &guesses, &mut tee)?;
                state::remember("check-conclusion", state::stamp(session), &found.into_iter().collect::<Vec<_>>());
                Flow::Continue
            }
            (_, Some(session), Some(path)) => {
                let guesses = check::guesses(session, self.conclusion.as_deref());
                check::bare_save(session, path, &guesses, &mut tee)?;
                Flow::Continue
            }
            _ => commands::dispatch(&mut self.session, line, &mut tee)?,
        };
        if let (Some(key), Some(session)) = (&key, &self.session) {
            state::remember(key, state::stamp(session), &tee.lines);
        }
        if matches!(name, Some("instance" | "load")) {
            state::new_session();
        }
        if matches!(name, Some("source" | "instance" | "load")) {
            self.note_loaded(&tee.lines);
        }
        match flow {
            Flow::Quit => return Ok(MODE_QUIT),
            Flow::Continue => {}
            Flow::StartEdit(state) => self.edit = Some(state),
            Flow::StartFormulaEdit(state) => self.formula = Some(state),
            Flow::StartDebug(state) => self.debug = Some(state),
        }
        Ok(self.mode())
    }
}

thread_local! {
    pub(crate) static STATE: RefCell<State> = RefCell::default();
}

/// Passes each line on to `out`, keeping a copy if `keep`.
struct Tee<'a> {
    out: &'a mut dyn Output,
    lines: Vec<String>,
    keep: bool,
}

impl Output for Tee<'_> {
    fn line(&mut self, text: &str) {
        if self.keep {
            self.lines.push(text.to_string());
        }
        self.out.line(text);
    }
}

impl State {
    /// After `:source`, `:instance` or `:load`: keep the conclusion of the
    /// proof file just read (its "Loaded N line(s) from <path> into the
    /// buffer" line names it), or forget the old one when a new formula
    /// replaced the proof.
    fn note_loaded(&mut self, lines: &[String]) {
        for line in lines {
            if let Some(path) = line
                .strip_prefix("Loaded ")
                .and_then(|rest| rest.split_once(" line(s) from "))
                .and_then(|(_, rest)| rest.split_once(" into the buffer"))
                .map(|(path, _)| path)
            {
                self.conclusion = check::file_conclusion(Path::new(path));
                return;
            }
            if line.starts_with("Loaded ") && line.contains(" constraints from ") {
                self.conclusion = None;
            }
        }
    }
}

/// The file of a `:save <file>` with no conclusion; else `None`.
fn bare_save_path(line: &str) -> Option<&str> {
    let rest = line.trim().strip_prefix(':')?;
    let mut words = rest.split_whitespace();
    let (_, path) = (words.next()?, words.next()?);
    words.next().is_none().then_some(path)
}

/// The command `line` names, in full or by a unique prefix (as
/// `commands::dispatch` resolves it), if it is a command.
fn command_name(line: &str) -> Option<&'static str> {
    let rest = line.trim().strip_prefix(':')?;
    let name = rest.split_whitespace().next()?;
    let mut matches = help::COMMANDS.iter().filter(|t| t.name.starts_with(name));
    let topic = help::COMMANDS.iter().find(|t| t.name == name).or_else(|| {
        let first = matches.next()?;
        matches.next().is_none().then_some(first)
    })?;
    Some(topic.name)
}

/// The cache key (`state::OUTPUTS`) when `line` is `:check [<conclusion>]`
/// ("check <conclusion>") or `:objective` with no argument ("objective"),
/// the command named in full or by a unique prefix (as `commands::dispatch`
/// resolves it); else `None`.
fn cached_command(line: &str) -> Option<String> {
    let name = command_name(line)?;
    let rest = line.trim().strip_prefix(':')?;
    let args = rest.split_once(char::is_whitespace).map_or("", |(_, args)| args);
    let args = args.split_whitespace().collect::<Vec<_>>().join(" ");
    match name {
        "check" => Some(format!("check {args}")),
        "objective" if args.is_empty() => Some("objective".to_string()),
        _ => None,
    }
}

/// Sets up the temp directory and an empty session. Returns the prompt
/// mode, or -1 if startup failed (the error is printed).
#[unsafe(no_mangle)]
pub extern "C" fn vr_init() -> i32 {
    let _ = tempfile::env::override_temp_dir(Path::new(TEMP_DIR));
    match commands::startup(None, &mut Stdout) {
        Ok(session) => STATE.with_borrow_mut(|state| {
            *state = State {
                session,
                ..State::default()
            };
            state.mode()
        }),
        Err(e) => {
            output::error(&mut Stdout, &format!("{e:#}"));
            -1
        }
    }
}

/// Allocates `len` bytes for the host to write an input line into.
#[unsafe(no_mangle)]
pub extern "C" fn vr_alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len.max(1));
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// Frees a buffer returned by `vr_alloc`.
///
/// # Safety
/// `ptr` and `len` must come from one `vr_alloc(len)` call, freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vr_free(ptr: *mut u8, len: usize) {
    drop(unsafe { Vec::from_raw_parts(ptr, 0, len.max(1)) });
}

/// Runs one input line (UTF-8, `len` bytes at `ptr`; trailing whitespace is
/// ignored) and returns the next prompt mode.
///
/// # Safety
/// `ptr` must point to `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vr_line(ptr: *const u8, len: usize) -> i32 {
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    let text = String::from_utf8_lossy(bytes);
    let line = text.trim_end();
    STATE.with_borrow_mut(|state| match state.step(line) {
        Ok(mode) => mode,
        Err(e) => {
            output::error(&mut Stdout, &format!("{e:#}"));
            state.mode()
        }
    })
}
