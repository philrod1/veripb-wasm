// Which words of a proof or formula line refer to constraints.
//
// constraintRefs(words) -> Map<index, { kind: "label" | "id" | "relative", value }>
//   words: the line split on whitespace (a trailing ";" is allowed on a word).
//   label: `@name` anywhere. id: a constraint ID; relative: a negative ID
//   (`-1` is the newest constraint at that point).
// IDs are recognised where the rule takes them:
//   pol: every integer operand except the scalar before `*`, `d`, `c`, `m`, `n`
//   rup, ia, i, e, conclusion, qed: integers after the `:`
//   del, delc, deld, core with `id`: the integers after `id`
//   proofgoal <n>: the constraint goal n (not `#n`)

const SCALAR_OPS = new Set(["*", "d", "c", "m", "n"]);
const HINT_RULES = new Set(["rup", "ia", "i", "e", "conclusion", "qed"]);
const ID_LIST_RULES = new Set(["del", "delc", "deld", "core"]);

export function constraintRefs(words) {
  const bare = words.map((w) => w.replace(/;+$/, ""));
  const refs = new Map();
  const integer = (i) => {
    const w = bare[i];
    if (!/^-?\d+$/.test(w ?? "")) return false;
    refs.set(i, w.startsWith("-") ? { kind: "relative", value: Number(w) } : { kind: "id", value: Number(w) });
    return true;
  };
  bare.forEach((w, i) => { if (w.startsWith("@") && w.length > 1) refs.set(i, { kind: "label", value: w }); });
  const k = bare.findIndex((w) => w && !w.startsWith("@"));
  if (k < 0) return refs;
  const rule = bare[k];
  if (rule === "pol") {
    for (let i = k + 1; i < bare.length; i++) {
      if (!SCALAR_OPS.has(bare[i + 1]) && /^-?\d+$/.test(bare[i]) && bare[i] !== "0") integer(i);
    }
  } else if (HINT_RULES.has(rule)) {
    const colon = bare.indexOf(":", k + 1);
    if (colon >= 0) for (let i = colon + 1; i < bare.length; i++) integer(i);
  } else if (ID_LIST_RULES.has(rule) && bare[k + 1] === "id") {
    for (let i = k + 2; i < bare.length; i++) integer(i);
  } else if (rule === "proofgoal" && /^\d+$/.test(bare[k + 1] ?? "")) {
    integer(k + 1);
  }
  return refs;
}
