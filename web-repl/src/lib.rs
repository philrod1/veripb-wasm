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

mod state;

use std::cell::RefCell;
use std::path::Path;

use veripb_repl::commands::{self, Flow, debug, edit, formula};
use veripb_repl::output::{self, Stdout};
use veripb_repl::session::Session;

/// Prompt modes returned by `vr_init` and `vr_line`.
const MODE_PBP: i32 = 0;
const MODE_EDIT: i32 = 1;
const MODE_FORMULA: i32 = 2;
pub(crate) const MODE_DEBUG: i32 = 3;
const MODE_QUIT: i32 = 4;

/// Temp files go here; WASI has no default temp directory.
const TEMP_DIR: &str = "/tmp";

#[derive(Default)]
pub(crate) struct State {
    session: Option<Session>,
    edit: Option<edit::EditState>,
    formula: Option<formula::FormulaEditState>,
    debug: Option<debug::DebugState>,
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
        match commands::dispatch(&mut self.session, line, out)? {
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
