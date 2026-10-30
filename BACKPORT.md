# Backport candidates for veripb-repl

Ideas built or found in veripb-wasm that would suit veripb-repl (mostly the
TUI). Each entry says what it does, where it is here, and how it might map
onto the REPL. Bugs in veripb-repl itself are reported and fixed upstream,
not listed here. Ideas veripb-repl has taken up are listed at the end.

## Progress and feedback

- **Proof statuses as `:verify` goes.** veripb checks each line as it reads
  it, and asks for the next chunk only after checking what came before. So
  every complete line before its latest read has been accepted (or the run
  would have stopped). The web build marks those lines as checked during
  `:verify`, provisionally (a dimmer ✓), until the REPL's own statuses
  arrive. Here: `settled` in `web/host.js`; `live` in `web/modes/enhanced.js`.
  In the TUI, the Proof pane could tick lines off the same way, from the
  line count the progress pipe (`run_through_pipe`) already keeps.
- **Update the panes before the database.** After a command, show the proof
  statuses at once, and the database when its rebuild finishes, with "Updating
  the Database pane · line n of m". Here: `vr_state_quick` in
  `web-repl/src/state.rs`, and `postState` in `web/repl-worker.js`. Since
  `:verify` and `:step` fill the database cache from their own run, this
  matters only after edits and `:debug` steps.

## For veripb

- **A debug mode.** veripb checks a proof in one run, so veripb-repl
  replays the proof from the start for each `:step`, `:verify` after an
  edit, and database dump: 2.2 s per step at line 50,000 of the circuit
  proof, 24 s per replay of all 403,891 lines. An interactive mode would
  remove the replays:
  - **Incremental checking:** load the formula once, then take proof lines
    one at a time (stdin or a socket), checking each against the live
    database and replying with the verdict and the constraint IDs it added.
  - **Stepping back:** a checkpoint or undo log, so the last line can be
    undone without a replay, including deletions and `red`/`dom`
    subproofs.
  - **Database on request:** dump the whole database, one constraint, or
    the rows changed since the last dump.
  - **Optional:** run to line n (breakpoints); report the preserved set,
    objective bounds and open proof goals at the current line.

  In veripb-repl, `:debug` would drive this mode directly, and edits near
  the end of a verified proof would recheck only from the edit. The WASM
  build would need it compiled in too; its 4 GiB memory limit would then
  apply to veripb's state, not to a copy of the proof text.

## To check upstream

- **`:explain`'s "needed" hints may name the wrong constraints.** In
  `solution_satisfying_formula_but_missing_objective_vars` (veripb's test
  instances), `:explain 13` lists constraint 85 as needed, though line 13
  itself creates constraint 84. The hints come from the elaborated proof,
  whose constraint IDs may differ from the original's, and are looked up in
  the live database. Unconfirmed.

## Done in veripb-repl

On `dev`; the web build uses each of these from veripb-repl.

- **Large proofs:**
  - fill the database cache from `:verify`'s and `:step`'s own run (`e38d5c9`);
  - keep what each proof line derived (`0e4af8b`);
  - write the proof to veripb line by line (`fd2cc41`);
  - trace less, and read the trace as a stream (`4d57c54`, `5c8bf44`);
  - find a rejected line from the batch's own error (`4d57c54`);
  - draw only the TUI's visible rows (`45a18c7`);
  - cheaper bare `:check`, with `:check` and `:objective` kept per state
    (`19b93df`);
  - keep the proof's intended conclusion, tried first by bare `:check` and
    `:save`, and `:conclusion` (`9a367f0`);
  - cheaper debug stepping: steps fill the database cache, and `:back` trims
    it (`e38d5c9`, `db0b3c5`).
- **Progress:** the progress line, from a pipe that counts the proof lines
  veripb reads (`71b7b5a`).
- **Editing:**
  - join lines in Vim Insert mode (`a0c45de`);
  - retyping a comment or blank line keeps the proof checked (`a826e14`);
  - Vim Insert edits held until Esc (`8b86700`).
- **Explaining and learning:**
  - plain-English explanations and the glossary, with `:help <concept>`
    (`d0dbfd2`);
  - constraint references (`a826e14`);
  - jumps between a line and its constraints, and `:where` (`879a3e5`);
  - pane statistics, as `:stats` (`608a9c4`, `2855b70`);
  - `setlvl` and `wiplvl` in `:help` (`a826e14`).
- **Large output:** find in the Output pane (`b7c8a89`).
