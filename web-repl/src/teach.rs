//! Plain-English explanations and the glossary from veripb-repl's `teach`,
//! as JSON. Text is sent as markup runs (`teach::markup::parse`):
//! `[{t: "text" | "code", text} | {t: "term", text, id} | {t: "constraint",
//! text, id} | {t: "line", text, line}]`, `term` linking to a glossary
//! entry, `constraint` to a constraint ID and `line` to a proof line (a
//! display line).

use serde_json::{Value, json};
use veripb_repl::session::Session;
use veripb_repl::teach::explain::{self, Block, Explanation};
use veripb_repl::teach::glossary::{self, Group};
use veripb_repl::teach::markup::{self, Inline};

/// `text`'s markup runs.
fn runs(text: &str) -> Value {
    Value::Array(
        markup::parse(text)
            .into_iter()
            .map(|run| match run {
                Inline::Text(text) => json!({ "t": "text", "text": text }),
                Inline::Code(text) => json!({ "t": "code", "text": text }),
                Inline::Term { text, id } => json!({ "t": "term", "text": text, "id": id }),
                Inline::Constraint { text, id } => json!({ "t": "constraint", "text": text, "id": id }),
                Inline::Line { text, line } => json!({ "t": "line", "text": text, "line": line }),
            })
            .collect(),
    )
}

/// The plain-English explanation of checked display line `n`
/// (`teach::explain::explain`), and its JSON: `{title, blocks}`, each block
/// `{kind: "p" | "note", text: runs}` or `{kind: "steps", items: [runs]}`.
/// `None` for a line it doesn't cover. Runs veripb (the database before the
/// line).
pub(crate) fn explain(session: &Session, n: usize) -> Option<(Explanation, Value)> {
    let explanation = explain::explain(session, n)?;
    let blocks: Vec<Value> = explanation
        .blocks
        .iter()
        .map(|block| match block {
            Block::Paragraph(text) => json!({ "kind": "p", "text": runs(text) }),
            Block::Note(text) => json!({ "kind": "note", "text": runs(text) }),
            Block::Steps(items) => json!({ "kind": "steps", "items": items.iter().map(|i| runs(i)).collect::<Vec<_>>() }),
        })
        .collect();
    let json = json!({ "title": explanation.title, "blocks": blocks });
    Some((explanation, json))
}

/// The glossary (`teach::glossary::entries`): `[{id, term, group: "concept"
/// | "rule", body: [runs], example: runs | null, usage, details: [line], see:
/// [id], search}]`, `search` being the entry's text without markup, in
/// lower case.
pub(crate) fn glossary() -> Value {
    Value::Array(
        glossary::entries()
            .into_iter()
            .map(|entry| {
                let search = [entry.term]
                    .into_iter()
                    .chain(entry.usage)
                    .chain(entry.body.iter().copied())
                    .chain(entry.example)
                    .chain(entry.details.iter().copied())
                    .map(markup::plain)
                    .collect::<Vec<_>>()
                    .join(" ")
                    .to_lowercase();
                json!({
                    "id": entry.id,
                    "term": entry.term,
                    "group": match entry.group { Group::Concept => "concept", Group::Rule => "rule" },
                    "body": entry.body.iter().map(|text| runs(text)).collect::<Vec<_>>(),
                    "example": entry.example.map(runs),
                    "usage": entry.usage,
                    "details": entry.details,
                    "see": entry.see,
                    "search": search,
                })
            })
            .collect(),
    )
}
