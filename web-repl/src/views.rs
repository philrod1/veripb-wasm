//! Windowed views of the session for the page's enhanced mode, so a proof of
//! any size costs the page only the rows it shows: `vr_view` returns a range
//! of one pane's rows (filtered), `vr_find` one constraint. The summary that
//! goes with them is `state::vr_state`.
//!
//! Filtering matches the page's rule: a number matches a row's ID or line
//! (`ids` may be a range `1-2`); other text is a case-insensitive substring of
//! the row's text (labels included, in the Database pane). The matching rows
//! are cached per pane until the session, its buffer edits or the filter
//! change.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use serde_json::{Value, json};
use veripb_repl::checker::parse::{formula_line_constraints, rule_keyword};
use veripb_repl::session::Session;

use crate::STATE;
use crate::state::set_result;

/// One pane's filter and the positions (in its unfiltered rows) that match.
struct Matches {
    key: (u64, u64, String, bool, bool),
    positions: Vec<usize>,
}

thread_local! {
    static MATCHES: RefCell<HashMap<String, Matches>> = RefCell::new(HashMap::new());
    /// The Database rows and formula IDs, for the session generation they
    /// were built at.
    static DATABASE_ROWS: RefCell<Option<(u64, Rc<Vec<Value>>)>> = const { RefCell::new(None) };
    static FORMULA_IDS: RefCell<Option<(u64, Rc<Vec<String>>)>> = const { RefCell::new(None) };
}

/// Whether a row with `ids` (a number or a range `lo-hi`) and `text` matches
/// `query` (lower-cased, trimmed).
fn matches(query: &str, ids: &str, text: &str) -> bool {
    if query.is_empty() {
        return true;
    }
    if let Ok(n) = query.parse::<u64>() {
        let mut bounds = ids.split('-').map(|part| part.parse::<u64>().ok());
        return match (bounds.next().flatten(), bounds.next()) {
            (Some(lo), None) => n == lo,
            (Some(lo), Some(Some(hi))) => (lo..=hi).contains(&n),
            _ => false,
        };
    }
    text.to_lowercase().contains(query)
}

/// Each formula line's constraint IDs as text (`3` or `1-2`), cached per
/// session generation.
fn formula_ids(session: &Session) -> Rc<Vec<String>> {
    FORMULA_IDS.with_borrow_mut(|cache| {
        if let Some((generation, ids)) = cache.as_ref()
            && *generation == session.generation
        {
            return ids.clone();
        }
        let ids: Rc<Vec<String>> = Rc::new(
            session
                .formula
                .iter()
                .zip(session.formula_first_ids())
                .map(|(text, first)| {
                    let count = formula_line_constraints(text).max(1);
                    if count == 1 { first.to_string() } else { format!("{first}-{}", first + count - 1) }
                })
                .collect(),
        );
        *cache = Some((session.generation, ids.clone()));
        ids
    })
}

/// A pane's rows as positions 0..len, with what filtering and display need.
enum Rows<'a> {
    Formula { session: &'a Session, ids: Rc<Vec<String>>, meta: Vec<(&'static str, String)> },
    Proof { session: &'a Session, preamble: Vec<String> },
    Database { entries: Rc<Vec<Value>> },
}

impl Rows<'_> {
    fn len(&self) -> usize {
        match self {
            Rows::Formula { session, meta, .. } => meta.len() + session.formula.len(),
            Rows::Proof { session, preamble } => preamble.len() + session.buffer.len(),
            Rows::Database { entries } => entries.len(),
        }
    }

    /// The `(ids, text)` a filter sees at `pos`; `None` for rows a filter
    /// always hides (formula meta rows, proof preamble).
    fn filter_key(&self, pos: usize) -> Option<(String, String)> {
        match self {
            Rows::Formula { session, ids, meta } => {
                let i = pos.checked_sub(meta.len())?;
                Some((ids[i].clone(), session.formula[i].clone()))
            }
            Rows::Proof { session, preamble } => {
                let i = pos.checked_sub(preamble.len())?;
                Some((session.display_line(i).to_string(), session.buffer[i].clone()))
            }
            Rows::Database { entries } => {
                let entry = &entries[pos];
                let labels: Vec<&str> = entry["labels"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
                Some((entry["id"].to_string(), format!("{} {}", labels.join(" "), entry["text"].as_str().unwrap_or(""))))
            }
        }
    }

    fn row(&self, pos: usize) -> Value {
        match self {
            Rows::Formula { session, ids, meta } => match pos.checked_sub(meta.len()) {
                None => json!({ "meta": meta[pos].0, "text": meta[pos].1 }),
                Some(i) => json!({ "ids": ids[i], "text": session.formula[i] }),
            },
            Rows::Proof { session, preamble } => match pos.checked_sub(preamble.len()) {
                None => json!({ "preamble": true, "n": pos + 1, "text": preamble[pos] }),
                Some(i) => proof_row(session, i),
            },
            Rows::Database { entries } => entries[pos].clone(),
        }
    }
}

fn proof_row(session: &Session, i: usize) -> Value {
    let checked = session.checked_len;
    let text = &session.buffer[i];
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
}

/// The Database pane's rows if already built for this session generation;
/// never runs veripb.
pub(crate) fn known_database_rows(session: &Session) -> Option<Rc<Vec<Value>>> {
    DATABASE_ROWS.with_borrow(|cache| {
        cache.as_ref().filter(|(generation, _)| *generation == session.generation).map(|(_, rows)| rows.clone())
    })
}

/// The Database pane's rows: `{id, core, text, labels}` per live constraint,
/// cached per session generation. Runs veripb when the session's own
/// database cache is stale.
pub(crate) fn database_rows(session: &Session) -> Result<Rc<Vec<Value>>, String> {
    if let Some(rows) = DATABASE_ROWS.with_borrow(|cache| {
        cache.as_ref().filter(|(generation, _)| *generation == session.generation).map(|(_, rows)| rows.clone())
    }) {
        return Ok(rows);
    }
    let labels = session.labels_by_id();
    let database = session.database().map_err(|e| format!("{e:#}"))?;
    let rows: Rc<Vec<Value>> = Rc::new(
        database
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
            .collect(),
    );
    DATABASE_ROWS.with_borrow_mut(|cache| *cache = Some((session.generation, rows.clone())));
    Ok(rows)
}

/// A window of one pane's rows. `json` is `{pane: "formula" | "proof" |
/// "database", start, count, query?, core?, derived?}`: `start` and `count`
/// count matching rows; `query` filters (see the module docs); `core` and
/// `derived` (default true) keep those Database rows. Returns `{total, start,
/// rows, generation, edits}`, with `total` the number of matching rows and
/// `generation` and `edits` as in `vr_state`, or `{error}`; `null` without a
/// session.
///
/// Rows: Formula `{ids, text}`, or `{meta: "objective" | "preserved", text}`
/// above them when unfiltered; Proof `{n, index, text, status, breakpoint,
/// assertion}`, or `{preamble: true, n, text}` above them when unfiltered;
/// Database `{id, core, text, labels}`.
///
/// # Safety
/// `ptr` must point to `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vr_view(ptr: *const u8, len: usize) -> i32 {
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    let Ok(request) = serde_json::from_slice::<Value>(bytes) else {
        return set_result(json!({ "error": "malformed view request" }));
    };
    STATE.with_borrow(|state| {
        let Some(session) = &state.session else {
            return set_result(Value::Null);
        };
        let pane = request["pane"].as_str().unwrap_or("");
        let query = request["query"].as_str().unwrap_or("").trim().to_lowercase();
        let core = request["core"].as_bool().unwrap_or(true);
        let derived = request["derived"].as_bool().unwrap_or(true);
        let start = request["start"].as_u64().unwrap_or(0) as usize;
        let count = request["count"].as_u64().unwrap_or(0) as usize;
        let rows = match pane {
            "formula" => {
                let mut meta = Vec::new();
                if query.is_empty() {
                    if let Some(objective) = &session.objective {
                        meta.push(("objective", objective.clone()));
                    }
                    if let Some(preserved) = &session.preserved {
                        meta.push(("preserved", preserved.clone()));
                    }
                }
                Rows::Formula { session, ids: formula_ids(session), meta }
            }
            "proof" => {
                let preamble = if query.is_empty() { session.preamble_lines().to_vec() } else { Vec::new() };
                Rows::Proof { session, preamble }
            }
            "database" => match database_rows(session) {
                Ok(entries) => Rows::Database { entries },
                Err(error) => return set_result(json!({ "error": error })),
            },
            _ => return set_result(json!({ "error": format!("unknown pane {pane:?}") })),
        };

        let key = (session.generation, crate::state::edits(), query.clone(), core, derived);
        let unfiltered = query.is_empty() && core && derived;
        let positions = if unfiltered {
            None
        } else {
            Some(MATCHES.with_borrow_mut(|cache| {
                let fresh = cache.get(pane).is_some_and(|m| m.key == key);
                if !fresh {
                    let positions = (0..rows.len())
                        .filter(|&pos| {
                            if let Rows::Database { entries } = &rows {
                                let is_core = entries[pos]["core"].as_bool().unwrap_or(false);
                                if (is_core && !core) || (!is_core && !derived) {
                                    return false;
                                }
                            }
                            rows.filter_key(pos).is_some_and(|(ids, text)| matches(&query, &ids, &text))
                        })
                        .collect();
                    cache.insert(pane.to_string(), Matches { key: key.clone(), positions });
                }
                cache[pane].positions.clone()
            }))
        };

        let total = positions.as_ref().map_or(rows.len(), Vec::len);
        let end = start.saturating_add(count).min(total);
        let window: Vec<Value> = (start.min(end)..end)
            .map(|k| rows.row(positions.as_ref().map_or(k, |p| p[k])))
            .collect();
        set_result(json!({ "total": total, "start": start, "rows": window, "generation": session.generation, "edits": crate::state::edits() }))
    })
}

/// One constraint, by label or ID: `json` is `{label}` or `{id}`. Returns
/// `{id, core, text, labels, position}` (`position` among the unfiltered
/// Database rows) or `null` (no session, or not in the database).
///
/// # Safety
/// `ptr` must point to `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vr_find(ptr: *const u8, len: usize) -> i32 {
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    let request = serde_json::from_slice::<Value>(bytes).unwrap_or(Value::Null);
    STATE.with_borrow(|state| {
        let Some(session) = &state.session else {
            return set_result(Value::Null);
        };
        let Ok(entries) = database_rows(session) else {
            return set_result(Value::Null);
        };
        let found = entries.iter().position(|entry| match (&request["label"], &request["id"]) {
            (Value::String(label), _) => entry["labels"].as_array().is_some_and(|ls| ls.iter().any(|l| l == label)),
            (_, Value::Number(id)) => entry["id"] == Value::Number(id.clone()),
            _ => false,
        });
        set_result(match found {
            Some(position) => {
                let mut entry = entries[position].clone();
                entry["position"] = json!(position);
                entry
            }
            None => Value::Null,
        })
    })
}
