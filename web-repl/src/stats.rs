//! Statistics for the Formula, Database and Proof panes (enhanced mode's
//! stats modal), from veripb-repl's `stats`: `vr_pane_stats`.

use serde_json::{Value, json};
use veripb_repl::session::Session;
use veripb_repl::stats::{self, Shapes};

use crate::STATE;
use crate::state::set_result;

/// `{kinds: [{name, count}], terms: {min, median, max, mean} | null,
/// largestCoefficient}`, as fields to merge into a pane's statistics.
fn shapes(shapes: &Shapes) -> serde_json::Map<String, Value> {
    let terms = shapes.terms.as_ref().map(|t| json!({ "min": t.min, "median": t.median, "max": t.max, "mean": t.mean }));
    let kinds: Vec<Value> = shapes.kinds.iter().map(|(kind, count)| json!({ "name": kind.name(), "count": count })).collect();
    let Value::Object(fields) = json!({ "kinds": kinds, "terms": terms, "largestCoefficient": shapes.largest_coefficient }) else {
        unreachable!("an object")
    };
    fields
}

fn with_shapes(mut stats: Value, shape: &Shapes) -> Value {
    stats.as_object_mut().expect("an object").extend(shapes(shape));
    stats
}

fn formula_stats(session: &Session) -> Value {
    let s = stats::formula(session);
    let longest = s.longest.as_ref().map(|(ids, bytes)| json!({ "ids": ids, "bytes": bytes }));
    with_shapes(
        json!({
            "lines": s.lines, "bytes": s.bytes, "longest": longest, "constraints": s.constraints,
            "twoConstraintLines": s.two_constraint_lines, "labelled": s.labelled, "variables": s.variables,
            "objectiveTerms": s.objective_terms, "preserved": s.preserved,
        }),
        &s.shapes,
    )
}

fn database_stats(session: &Session) -> Value {
    let s = match stats::database(session) {
        Ok(s) => s,
        Err(error) => return json!({ "error": format!("{error:#}") }),
    };
    let longest = s.longest.map(|(id, bytes)| json!({ "id": id, "bytes": bytes }));
    with_shapes(
        json!({
            "count": s.constraints, "bytes": s.bytes, "longest": longest, "core": s.core,
            "fromFormula": s.from_formula, "formulaConstraints": s.formula_constraints,
            "labelled": s.labelled, "highestId": s.highest_id,
        }),
        &s.shapes,
    )
}

fn proof_stats(session: &Session) -> Value {
    let s = stats::proof(session);
    let rules: Vec<Value> = s
        .rules
        .iter()
        .map(|r| json!({ "name": r.rule, "count": r.lines, "bytes": r.bytes, "checked": r.checked }))
        .collect();
    json!({
        "lines": s.lines,
        "bytes": s.bytes,
        "longest": s.longest.map(|(line, bytes)| json!({ "line": line, "bytes": bytes })),
        "checked": s.checked,
        "rejected": s.rejected,
        "labelled": s.labelled,
        "breakpoints": s.breakpoints,
        "preamble": session.preamble_lines().len(),
        "rules": rules,
    })
}

/// Statistics for pane `pane` (0 Formula, 1 Database, 2 Proof), or `null`
/// without a session (or for another number). `bytes` count newlines;
/// `longest` is the longest line or constraint and its bytes.
///
/// - Formula: `{lines, bytes, longest: {ids, bytes}, constraints,
///   twoConstraintLines, labelled, variables, objectiveTerms, preserved,
///   kinds, terms, largestCoefficient}`, `ids` the line's constraint IDs
///   ("3" or "1-2").
/// - Database: `{count, bytes, longest: {id, bytes}, core, fromFormula,
///   formulaConstraints, labelled, highestId, kinds, terms,
///   largestCoefficient}` or `{error}`; may run veripb, as the Database pane
///   does.
/// - Proof: `{lines, bytes, longest: {line, bytes}, checked, rejected,
///   labelled, breakpoints, preamble, rules: [{name, count, bytes,
///   checked}]}`, most frequent rule first.
///
/// `kinds` is `[{name, count}]` (see `stats::classify`), most frequent
/// first; `terms` is `{min, median, max, mean}` terms per constraint, or
/// `null`. `longest` is `null` when there are no lines.
#[unsafe(no_mangle)]
pub extern "C" fn vr_pane_stats(pane: i32) -> i32 {
    STATE.with_borrow(|state| {
        let Some(session) = &state.session else {
            return set_result(Value::Null);
        };
        set_result(match pane {
            0 => formula_stats(session),
            1 => database_stats(session),
            2 => proof_stats(session),
            _ => Value::Null,
        })
    })
}
