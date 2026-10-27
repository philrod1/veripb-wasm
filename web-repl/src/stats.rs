//! Statistics for the Formula, Database and Proof panes (enhanced mode's
//! stats modal): `vr_pane_stats`.

use std::collections::HashMap;

use serde_json::{Value, json};
use veripb_repl::checker::parse::{formula_line_constraints, leading_labels, rule_keyword};
use veripb_repl::session::Session;

use crate::STATE;
use crate::state::set_result;

/// A constraint's shape, as `classify` finds it.
struct Shape {
    kind: &'static str,
    terms: usize,
    /// The largest absolute coefficient, as written (it may not fit an
    /// integer type).
    largest: Option<String>,
}

/// Classifies a constraint (`[@labels] <terms> <op> <degree> [;]`; formula
/// lines may also be implications): `clause` (any one literal satisfies
/// it), `cardinality` (equal coefficients), `general`, `equality`,
/// `implication`, `trivial` (always satisfied) or `contradiction` (no terms,
/// positive degree). Coefficients too large for `i128` count as `general`.
fn classify(text: &str) -> Shape {
    let tokens: Vec<&str> = text
        .split_whitespace()
        .skip_while(|t| t.starts_with('@'))
        .map(|t| t.trim_end_matches(';'))
        .filter(|t| !t.is_empty())
        .collect();
    if tokens.iter().any(|t| matches!(*t, "==>" | "<==" | "<==>")) {
        let terms = tokens.iter().filter(|t| !is_number(t) && !is_operator(t)).count();
        return Shape { kind: "implication", terms, largest: None };
    }
    let op = tokens.iter().position(|t| is_operator(t));
    let (lhs, op, rhs) = match op {
        Some(i) => (&tokens[..i], tokens[i], tokens.get(i + 1).copied()),
        None => (&tokens[..], "", None),
    };
    let mut coefficients: Vec<Option<i128>> = Vec::new();
    let mut largest: Option<&str> = None;
    let mut pending: Option<&str> = None;
    for token in lhs {
        if is_number(token) {
            pending = Some(token);
            continue;
        }
        let written = pending.take().unwrap_or("1");
        let magnitude = written.trim_start_matches(['+', '-']);
        if largest.is_none_or(|l| (magnitude.len(), magnitude) > (l.len(), l)) {
            largest = Some(magnitude);
        }
        coefficients.push(written.trim_start_matches('+').parse().ok());
    }
    let terms = coefficients.len();
    let largest = largest.map(str::to_string);
    let general = |largest| Shape { kind: "general", terms, largest };
    let Some(degree) = rhs.and_then(|r| r.trim_start_matches('+').parse::<i128>().ok()) else {
        return general(largest);
    };
    let Some(coefficients) = coefficients.into_iter().collect::<Option<Vec<i128>>>() else {
        return general(largest);
    };
    // As `>= degree` with positive coefficients.
    let (coefficients, degree): (Vec<i128>, i128) = match op {
        ">=" => (coefficients, degree),
        ">" => (coefficients, degree + 1),
        "<=" => (coefficients.iter().map(|c| -c).collect(), -degree),
        "<" => (coefficients.iter().map(|c| -c).collect(), 1 - degree),
        "=" => return Shape { kind: "equality", terms, largest },
        _ => return general(largest),
    };
    let degree = degree + coefficients.iter().filter(|&&c| c < 0).map(|c| -c).sum::<i128>();
    let magnitudes: Vec<i128> = coefficients.iter().map(|c| c.abs()).filter(|&c| c > 0).collect();
    let kind = if degree <= 0 {
        "trivial"
    } else if magnitudes.is_empty() {
        "contradiction"
    } else if magnitudes.iter().all(|&c| c >= degree) {
        "clause"
    } else if magnitudes.iter().all(|&c| c == magnitudes[0]) {
        "cardinality"
    } else {
        "general"
    };
    Shape { kind, terms, largest }
}

fn is_number(token: &str) -> bool {
    let digits = token.strip_prefix(['+', '-']).unwrap_or(token);
    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
}

fn is_operator(token: &str) -> bool {
    matches!(token, ">=" | "<=" | "=" | ">" | "<")
}

/// Counts by name, most frequent first (ties by name): `[{name, count}]`.
fn ranked(counts: HashMap<&str, usize>) -> Vec<(String, usize)> {
    let mut counts: Vec<(String, usize)> = counts.into_iter().map(|(name, count)| (name.to_string(), count)).collect();
    counts.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    counts
}

/// Kinds and sizes of a list of constraints: `{kinds: [{name, count}],
/// terms: {min, median, max, mean} | null, largestCoefficient}`.
fn shapes<'a>(texts: impl Iterator<Item = &'a str>) -> Value {
    let mut kinds: HashMap<&str, usize> = HashMap::new();
    let mut sizes: Vec<usize> = Vec::new();
    let mut largest: Option<String> = None;
    for text in texts {
        let shape = classify(text);
        *kinds.entry(shape.kind).or_default() += 1;
        sizes.push(shape.terms);
        if let Some(l) = shape.largest
            && largest.as_ref().is_none_or(|m| (l.len(), &l) > (m.len(), m))
        {
            largest = Some(l);
        }
    }
    sizes.sort_unstable();
    let terms = (!sizes.is_empty()).then(|| {
        json!({
            "min": sizes[0],
            "median": sizes[sizes.len() / 2],
            "max": sizes[sizes.len() - 1],
            "mean": sizes.iter().sum::<usize>() as f64 / sizes.len() as f64,
        })
    });
    json!({
        "kinds": ranked(kinds).into_iter().map(|(name, count)| json!({ "name": name, "count": count })).collect::<Vec<_>>(),
        "terms": terms,
        "largestCoefficient": largest,
    })
}

fn formula_stats(session: &Session) -> Value {
    let mut stats = shapes(session.formula.iter().map(String::as_str));
    stats["lines"] = json!(session.formula.len());
    stats["constraints"] = json!(session.formula_constraint_count());
    stats["twoConstraintLines"] = json!(session.formula.iter().filter(|l| formula_line_constraints(l) == 2).count());
    stats["labelled"] = json!(session.formula.iter().filter(|l| !leading_labels(l).is_empty()).count());
    stats["variables"] = json!(session.variables.names().count());
    stats["objectiveTerms"] = json!(session.objective.as_deref().map(|o| classify(o).terms));
    stats["preserved"] = json!(session.preserved.as_deref().map(|p| p.split_whitespace().filter(|t| *t != "preserved:" && !t.ends_with(';')).count()));
    stats
}

fn database_stats(session: &Session) -> Value {
    let rows = match crate::views::database_rows(session) {
        Ok(rows) => rows,
        Err(error) => return json!({ "error": error }),
    };
    let formula = session.formula_constraint_count();
    let id = |row: &Value| row["id"].as_u64().unwrap_or(0) as usize;
    let mut stats = shapes(rows.iter().map(|row| row["text"].as_str().unwrap_or("")));
    stats["count"] = json!(rows.len());
    stats["core"] = json!(rows.iter().filter(|row| row["core"] == true).count());
    stats["fromFormula"] = json!(rows.iter().filter(|row| id(row) <= formula).count());
    stats["formulaConstraints"] = json!(formula);
    stats["labelled"] = json!(rows.iter().filter(|row| row["labels"].as_array().is_some_and(|l| !l.is_empty())).count());
    stats["highestId"] = json!(rows.iter().map(id).max());
    stats
}

/// A proof line's rule for the counts: its keyword (without a `;`, as in
/// `qed;`), `comment` for `%` lines, `blank` for empty ones.
fn rule_name(line: &str) -> &str {
    match rule_keyword(line) {
        None => "blank",
        Some(keyword) if keyword.starts_with('%') => "comment",
        Some(keyword) => keyword.trim_end_matches(';'),
    }
}

fn proof_stats(session: &Session) -> Value {
    let checked_len = session.checked_len;
    let mut all: HashMap<&str, usize> = HashMap::new();
    let mut checked: HashMap<&str, usize> = HashMap::new();
    for (i, line) in session.buffer.iter().enumerate() {
        let rule = rule_name(line);
        *all.entry(rule).or_default() += 1;
        if i < checked_len {
            *checked.entry(rule).or_default() += 1;
        }
    }
    let rules: Vec<Value> = ranked(all)
        .into_iter()
        .map(|(name, count)| {
            let done = checked.get(name.as_str()).copied().unwrap_or(0);
            json!({ "name": name, "count": count, "checked": done })
        })
        .collect();
    json!({
        "lines": session.buffer.len(),
        "checked": checked_len,
        "rejected": session.known_bad.is_some(),
        "labelled": session.buffer.iter().filter(|l| !leading_labels(l).is_empty()).count(),
        "breakpoints": session.breakpoints.len(),
        "preamble": session.preamble_lines().len(),
        "rules": rules,
    })
}

/// Statistics for pane `pane` (0 Formula, 1 Database, 2 Proof), or `null`
/// without a session (or for another number).
///
/// - Formula: `{lines, constraints, twoConstraintLines, labelled,
///   variables, objectiveTerms, preserved, kinds, terms, largestCoefficient}`.
/// - Database: `{count, core, fromFormula, formulaConstraints, labelled,
///   highestId, kinds, terms, largestCoefficient}` or `{error}`; may run
///   veripb, as the Database pane does.
/// - Proof: `{lines, checked, rejected, labelled, breakpoints, preamble,
///   rules: [{name, count, checked}]}`, most frequent rule first.
///
/// `kinds` is `[{name, count}]` (see `classify`), most frequent first;
/// `terms` is `{min, median, max, mean}` terms per constraint, or `null`.
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

#[cfg(test)]
mod tests {
    use super::classify;

    #[test]
    fn kinds() {
        let kind = |text| classify(text).kind;
        assert_eq!(kind("1 x1 1 ~x2 >= 1 ;"), "clause");
        assert_eq!(kind("@c +2 x1 +2 x2 >= 1 ;"), "clause");
        assert_eq!(kind("1 x1 1 x2 1 x3 >= 2"), "cardinality");
        assert_eq!(kind("1 x1 2 x2 >= 2"), "general");
        assert_eq!(kind("-1 x1 -1 x2 >= -1"), "clause");
        assert_eq!(kind("1 x1 1 x2 1 x3 <= 1 ;"), "cardinality");
        assert_eq!(kind("1 x1 1 x2 = 1 ;"), "equality");
        assert_eq!(kind(">= 1"), "contradiction");
        assert_eq!(kind("1 x1 >= 0"), "trivial");
        assert_eq!(kind("1 x1 1 x2 >= 1 ==> 1 x3 >= 1 ;"), "implication");
        assert_eq!(kind("99999999999999999999999999999999999999999 x1 >= 1"), "general");
        assert_eq!(classify("3 x1 -12 x2 >= 1").largest.as_deref(), Some("12"));
        assert_eq!(classify("1 x1 1 x2 1 x3 >= 2").terms, 3);
    }
}
