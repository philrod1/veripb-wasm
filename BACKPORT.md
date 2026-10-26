# Backport candidates for veripb-repl

Ideas built or found in veripb-wasm that would suit veripb-repl (mostly the
TUI). Each entry says what it does, where it is here, and how it might map
onto the REPL. Bugs in veripb-repl itself are reported and fixed upstream,
not listed here.

## Performance on large proofs

Measured on a 403,891-line circuit proof (62 MB) in the web build.

- **Fill the database cache from `:verify`'s own run.** After `:verify`,
  `Session::database()` replays the whole checked proof again, traced, to
  rebuild the database and label map: a second full veripb run (here 22 s
  after a 24 s verify) before the panes are current, and the first of
  `:check`'s five runs. `:verify` already makes a traced run over the same
  lines; recording its database dump and `constraint_ids_by_line` there would
  remove the second run.
- **Stream the proof to the temp file.** To call veripb, the REPL builds the
  whole proof as one `String` (`preamble_and_lines`) next to the buffer it
  already holds; as that string grows, its buffer doubles, briefly needing
  about twice the proof's size again. Writing the lines straight to the temp
  file would cut peak memory a lot. In the browser, which has a hard 4 GiB
  limit, this is what decides the largest proof that can be verified (about
  1 GB of proof failed).
- **The TUI hangs loading a large proof.** Reported with a 1.1M-line,
  456 MB proof; not investigated. The web build shows only the rows on screen
  (below), which suggests the TUI may be doing per-line work for the whole
  buffer on each draw.

- **Make `:check` cheaper on optimisation proofs.** Bare `:check` replays the
  proof once for the objective bounds, then tries `UNSAT`, `SAT` and
  `BOUNDS v v` in that order, a full veripb run each. On a proof with an
  objective the first two fail before `BOUNDS` succeeds: 4 runs, 81 s on the
  circuit proof. Trying `BOUNDS v v` first when there is an objective, and
  sharing the bounds with `:objective` (each currently computes them), would
  roughly halve it. A per-generation cache of `objective_bounds()` in
  `Session` would serve both.
- **Cache `:check` and `:objective` per session state.** The web build keeps
  their output per generation, `:check` per conclusion (`OUTPUTS` in
  `web-repl/src/state.rs`, filled through a tee in `State::step` in
  `web-repl/src/lib.rs`). Typed again before the session changes, a command
  replays its output instead of running veripb, and the Extras tab reads
  the same cache. In the REPL, the same cache would make a repeated `:check`
  instant in both frontends.

## Progress and feedback

- **Progress line during long commands.** While a command runs, show the
  command, the time so far, which veripb run (if more than one) and "line n of
  m (p%)". Here: `web/modes/output-view.js` (`#startBusy`), fed by
  `web/host.js` (`createVeripbRunner`'s `onProgress`). In the TUI, the
  prompt row or a status line could show the same.
- **Where the progress comes from.** veripb buffers its trace and writes it in
  a few large chunks, so the trace is no use for progress. It does stream the
  proof file in 8 KB reads; the newlines read so far give the line it has
  reached, about ten updates a second, for every run (`:check`'s probes
  too). The web build counts them in the WASI read hook. Natively, one way is
  to give veripb the proof through a pipe the REPL writes (a FIFO, or stdin
  if veripb accepts it), counting the lines written. The pipe's small
  buffer keeps that close to what veripb has read.
- **Proof statuses as `:verify` goes.** veripb checks each line as it reads
  it, and asks for the next chunk only after checking what came before. So
  every complete line before its latest read has been accepted (or the run
  would have stopped). The web build marks those lines as checked during
  `:verify`, provisionally (a dimmer ✓), until the REPL's own statuses
  arrive. Here: `settled` in `web/host.js`; `live` in `web/modes/enhanced.js`.
  In the TUI, the Proof pane could tick lines off the same way, from the
  pipe above.
- **Update the panes before the database.** After a command, show the proof
  statuses at once, and the database when its rebuild finishes, with "Updating
  the Database pane · line n of m". Here: `vr_state_quick` in
  `web-repl/src/state.rs`, and `postState` in `web/repl-worker.js`. If the
  database cache is filled by `:verify` (above), this matters only after
  edits.

## Editing

- **Join lines in Vim Insert mode.** Backspace at a line's start joins it
  onto the line above, and Delete at its end pulls the next line up: the
  reverse of Enter's split, as one undoable action. Here:
  `joinLines` in `web/modes/vim.js`, and the `join` op of `vr_buffer_edit`.
  In the TUI: two arms in `run`'s key match next to the other Insert-mode
  arms (Backspace when `editor.cursor() == 0`, Delete when the cursor is at
  the end), calling a `vim_insert_join(backward)` modelled on
  `vim_insert_newline` (`set_line` then `delete_line` under one snapshot and
  `push_undo`). Docs: `VimState`'s comment, and `USER_GUIDE.md` around the
  Insert-mode description.

- **Editing a comment keeps the proof checked.** `Session::set_line` retracts
  the checked prefix to the edited line for any edit. A `%` comment retyped
  as a comment changes nothing veripb checks (constraint IDs, database,
  labels), so the web build replaces the text directly under one undo
  snapshot, without bumping `generation` (which would also make the REPL
  rebuild its database). Here: `is_comment` in `vr_buffer_edit`,
  `web-repl/src/state.rs`. Blank lines are left out: veripb rejected one
  in a proof. In the REPL this belongs in `set_line` itself, or in the
  TUI's commit, and in plain `:edit`.
- **Insert mode commits on Esc, not on leaving a line.** The TUI commits the
  current line whenever the cursor leaves it (`vim_insert_move_to`), so
  moving off an accidentally edited line unchecks it and everything after,
  even if it is then changed back. The web build holds each edited line's
  text until Esc (or a split or join, which commit the held lines first),
  marks held lines in the pane, and skips any line whose text is back to
  what it was. Here: `held`, `holdCurrent` and `commitHeld` in
  `web/modes/vim.js`.

## Explaining and learning

- **Plain-English explanations.** For a checked `rup`, `pol`, `red` or `a`
  line: what the rule means, then the line step by step, for students. For
  `rup`, the forced values leading to the conflict come from a replay of unit
  propagation over the database before the line (not veripb's elaborated hint
  IDs, which can be numbered differently), keeping only the steps the
  conflict depends on. Here: `web-repl/src/teach.rs`, tested by
  `web/test/teach-check.mjs` over veripb's correct test instances. In the
  REPL: perhaps `:explain --plain <n>`, or a second section of `:explain`.
- **Glossary.** About 24 concepts, written for students new to pseudo-Boolean
  proofs (constraints, literals, slack, unit propagation, cutting-planes
  operations, witness, proof goals, …), plus every rule from `help::RULES`,
  with see-also links. Here: `web-repl/src/glossary.rs`. In the REPL: a
  `:glossary [<term>]` command, or `:help <concept>`.
- **Constraint references.** Labels and constraint IDs in proof lines,
  recognised per rule: `pol` operands but not the scalar before `*`, `d`,
  `c`, `m` or `n`; the hints after `:`; `del`/`core id` lists;
  `proofgoal <n>`. Hovering one shows the constraint, and clicking jumps to
  it in the Database pane. Here: `web/modes/refs.js` (with
  `web/test/refs-check.mjs`) and `vr_find`. In the TUI, a click on an ID
  could scroll the Database pane to it.

## Large output

- **Search the scrollback.** The web Transcript tab filters 800k lines to
  the ones containing some text, in about 50 ms, since its virtual list hides
  the rest from the browser's own find. A `/`-style search in the TUI's
  Output pane would serve the same purpose.

## To check upstream

- **`:explain`'s "needed" hints may name the wrong constraints.** In
  `solution_satisfying_formula_but_missing_objective_vars` (veripb's test
  instances), `:explain 13` lists constraint 85 as needed, though line 13
  itself creates constraint 84. The hints come from the elaborated proof,
  whose constraint IDs may differ from the original's, and are looked up in
  the live database. Unconfirmed.
