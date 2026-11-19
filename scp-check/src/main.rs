//! cp-solver's `lang::check_scp` as a `wasm32-wasip1` command, for the
//! Solver tab's live diagnostics.
//!
//! `scp-check <model.scp>` prints every error in the model as one JSON
//! array, in text order: `[{kind, message, start, end}]`, `kind` being
//! "syntax", "malformed" or "unsupported", and `start`/`end` the span at
//! fault as `{line, column}` (from 1; columns count characters). An empty
//! array means `cps` accepts the model. Exit status 1 if the file cannot be
//! read.

use std::process::ExitCode;
use std::{env, fs};

use lang::sexpr::Position;
use lang::{ErrorKind, check_scp};
use serde_json::{Value, json};

fn position(p: Position) -> Value {
    json!({ "line": p.line, "column": p.column })
}

fn main() -> ExitCode {
    let Some(path) = env::args().nth(1) else {
        eprintln!("usage: scp-check <model.scp>");
        return ExitCode::FAILURE;
    };
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) => {
            eprintln!("scp-check: cannot read {path}: {e}");
            return ExitCode::FAILURE;
        }
    };
    let errors: Vec<Value> = check_scp(&text)
        .into_iter()
        .map(|e| {
            let kind = match e.kind {
                ErrorKind::Syntax => "syntax",
                ErrorKind::Malformed => "malformed",
                ErrorKind::Unsupported => "unsupported",
            };
            json!({
                "kind": kind,
                "message": e.message,
                "start": position(e.span.start),
                "end": position(e.span.end),
            })
        })
        .collect();
    println!("{}", Value::Array(errors));
    ExitCode::SUCCESS
}
