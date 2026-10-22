// Checks modes/refs.js: which words of a proof line refer to constraints.
//
// Usage: node web/test/refs-check.mjs
// Exit status 1 on any failure.

import { constraintRefs } from "../modes/refs.js";

let failures = 0;
const CASES = [
  ["@x3 rup 1 x3 >= 1 : @x1_or_x2 @x1_imp_x3 2 ;", "@x3 @x1_or_x2 @x1_imp_x3 2"],
  ["rup 1 x3 >= 1 : ~ 5 7 ;", "5 7"],
  ["rup >= 1 ;", ""],
  ["pol 9 2 d ;", "9"],
  ["pol 8 2 + 3 + ;", "8 2 3"],
  ["pol 42 3 * 43 + s 2 d ;", "42 43"],
  ["pol -1 -2 + 5 + 6 +;", "-1 -2 5 6"],
  ["pol -1 x6 + ;", "-1"],
  ["@a pol @b @c + ;", "@a @b @c"],
  ["red 1 x1 >= 1 : x1 -> 0 ;", ""],
  ["red 1 x1 1 ~x2 >= 1 : x1 -> x2 x2 -> x1;", ""],
  ["del id 3 4 ;", "3 4"],
  ["core id 7 ;", "7"],
  ["e 1 ~x1 >= 1 : 2;", "2"],
  ["ia 1 x1 >= 1 : 4 ;", "4"],
  ["conclusion UNSAT : -1 ;", "-1"],
  ["conclusion UNSAT : @contradiction;", "@contradiction"],
  ["qed : -1;", "-1"],
  ["proofgoal 1", "1"],
  ["proofgoal #1", ""],
  ["a 1 ~x1 >= 1 ;", ""],
  ["@x1_or_x2 1 x1 1 x2 >= 1", "@x1_or_x2"],
];
for (const [line, expected] of CASES) {
  const words = line.split(/\s+/).filter(Boolean);
  const refs = constraintRefs(words);
  const got = [...refs.keys()].sort((a, b) => a - b).map((i) => words[i].replace(/;+$/, "")).join(" ");
  const ok = got === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${line}${ok ? "" : `  (got "${got}", expected "${expected}")`}`);
}
console.log(`${CASES.length} checks, ${failures} failures`);
process.exit(failures ? 1 : 0);
