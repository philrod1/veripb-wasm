# veripb-wasm

WebAssembly builds of veripb and veripb-repl, and a browser page that runs
them. The upstream sources are pinned git submodules and are not modified. Local changes are kept as
patch series and applied into `work/`.

| Target | What |
|---|---|
| `wasm32-unknown-unknown` | veripb library (browser), veripb-repl core without the TUI |
| `wasm32-wasip1` | veripb command-line binary, run under a WASI runtime; veripb-repl's line interface as a WASI reactor (`web-repl`, plain and enhanced modes); the veripb-repl TUI as a WASI command (`web-tui`) |

## Layout

| Path | Contents |
|---|---|
| `upstream/veripb` | submodule: `https://gitlab.com/MIAOresearch/software/VeriPB.git`, branch `main` |
| `upstream/veripb-repl` | submodule: `https://github.com/philrod1/veripb-repl.git`, branch `dev` |
| `upstream/crossterm` | submodule: `https://github.com/crossterm-rs/crossterm.git`, tag `0.29` (the crates.io 0.29.0 release) |
| `patches/<name>/` | local changes, one `git format-patch` file per change, applied in name order |
| `scripts/prepare.sh` | creates the trees in `work/` (table below) |
| `scripts/refresh-patches.sh` | regenerates a patch series from the commits in a `work/` tree |
| `work/` | generated, not tracked: the patched trees that cargo builds |
| `veripb-wasm/` | wrapper crate for the veripb library; enables `getrandom`'s `wasm_js` backend |
| `repl-core/` | wrapper crate for the veripb-repl core; enables `getrandom`'s `wasm_js` backend |
| `wasi-run/` | Node.js `node:wasi` runners for the WASI binary and WASI test binaries |
| `bigint-probe/` | prints `malachite-bigint` and `i128` results, for diffing native against wasm |
| `web-repl/` | veripb-repl's line interface as a `wasm32-wasip1` reactor, built against `work/veripb-repl-tui` and `work/crossterm`: `vr_init`, `vr_line`, `vr_alloc`, `vr_free`; JSON views `vr_state` (a session summary; `vr_state_quick` without the database), `vr_view` (a window of a pane's rows, filtered; `src/views.rs`), `vr_find` (one constraint by label or ID), `vr_preserved`, `vr_explain` (`:explain <n>`'s checker output, and the plain-English explanation from veripb-repl's `teach`, as JSON by `src/teach.rs`), `vr_extras` (`:check` and `:objective` output, bounds), `vr_complete` (the TUI's completer), `vr_themes` (the TUI's palettes), `vr_commands`, `vr_glossary` (veripb-repl's `teach::glossary`), `vr_line_ids` (the constraint IDs checked proof lines in a range derived, from one streamed trace; `src/trace.rs`), `vr_buffer_edit` (one undoable proof-line edit), plus `vr_toggle_breakpoint` and `vr_result_ptr` |
| `web-tui/` | the veripb-repl TUI as a `wasm32-wasip1` command, built against `work/crossterm` |
| `web/` | browser page: mode menu, plain and classic modes, veripb in Web Workers |
| `scripts/build-web.sh` | builds `web/pkg/` (generated, not tracked) |
| `scripts/serve.py` | serves `web/` with the headers classic mode needs |

Trees in `work/`:

| Tree | Upstream | Patches | Used by |
|---|---|---|---|
| `veripb` | `upstream/veripb` | `patches/veripb/` | all builds |
| `veripb-repl` | `upstream/veripb-repl` | `patches/veripb-repl/`, then TUI stripped | `repl-core` |
| `veripb-repl-tui` | `upstream/veripb-repl` | `patches/veripb-repl/`, TUI kept | `web-repl`, `web-tui` |
| `crossterm` | `upstream/crossterm` | `patches/crossterm/` | `web-tui` (`[patch.crates-io]`) |

## Local changes

`patches/veripb/`:

| Patch | Change |
|---|---|
| `0001-parser-keep-pol-integers-as-i64` | Pol integer tokens hold an `i64`, not an `isize`. With `isize`, operands of 2^31 or more are truncated on 32-bit targets. |
| `0002-parser-make-zstd-and-xz-support-optional` | `zstd` and `xz2` (C code) are behind the default feature `native-compression`. Without it, `.zst` and `.xz` inputs return an "unsupported" error. |
| `0003-bin-use-mimalloc-on-native-targets-only` | `mimalloc` (C code) is used on non-wasm targets only. |

`work/veripb-repl` also gets a commit `local: strip TUI` made by
`prepare.sh`, after `patches/veripb-repl/`. It removes `src/tui`,
`src/main.rs`, `pub mod tui;`, the `crossterm` dependency, `[[bin]]` and
`[dev-dependencies]`. Patches for `patches/veripb-repl/` are made in
`work/veripb-repl-tui`, which has the full source.

`patches/veripb-repl/`:

| Patch | Change |
|---|---|
| `0001-checker-run-veripb-through-a-host-import-on-WASI` | On `target_os = "wasi"`, `checker::invoke::run_veripb` calls the host import `veripb_host.run_veripb` instead of spawning `veripb`; veripb's stdout and stderr are read from `/.tmp/.veripb-stdout` and `/.tmp/.veripb-stderr`. A watched file and its size limit (as for `:explain`'s elaboration, 256 MiB) go to the host, which stops veripb once the file passes the limit. |
| `0002-Make-completion-themes-and-mode-vocabularies-public` | Visibility only: `tui::complete` and `tui::theme` become `pub mod`; `formula::MODE_VOCABULARY`, `debug::MODE_VOCABULARY` and `edit::READONLY_DURING_EDIT` become `pub`. |
| `0003-Make-the-session-s-undo-points-public` | Visibility only: `Session::begin_undo_point` and `Session::end_undo_point` become `pub`, so a frontend can record buffer edits as one undoable action. |
| `0004-Make-the-session-s-formula-temp-file-public` | Visibility only: `Session::formula_temp_file` becomes `pub`, for a traced run of the checked lines (`web-repl/src/trace.rs`). |
| `0005-Make-explain-s-parts-public` | Visibility only: `commands::explain::target`, `print_checker` and `print_rejection` become `pub`, so the explain modal's Checker view shows the checker's account without the plain-English part. |

`patches/crossterm/`:

| Patch | Change |
|---|---|
| `0001-Share-the-unix-input-parser-and-internal-events-with` | The ANSI input parser, its internal events and filters, `cursor::position` and the `KeyModifiers::CONTROL` display arm build on `any(unix, target_os = "wasi")`. |
| `0002-Add-a-WASI-backend` | On `target_os = "wasi"`, the terminal comes from the host imports `crossterm_host.terminal_size()` and `crossterm_host.read_input(buf, len, timeout_ms)` (bytes, 0 on timeout, -2 after a resize). Input bytes go through the unix parser; raw mode is a flag only. |

In each `work/<tree>`, the tag `patch-base` marks the commit the patch series
applies to.

## Requirements

- `rustup target add wasm32-unknown-unknown wasm32-wasip1`
- Node.js 22 or later
- A git identity (`user.name`, `user.email`) in this repo's config. It is
  copied to `work/<name>` and used for local commits.

## Build

```
git submodule update --init
scripts/prepare.sh

export CARGO_TARGET_DIR=~/.cache/veripb-wasm-target
(cd veripb-wasm && cargo build --release --target wasm32-unknown-unknown)
(cd work/veripb && cargo build --release --bin veripb --no-default-features --target wasm32-wasip1)
(cd repl-core && cargo check --target wasm32-unknown-unknown)
```

The WASI binary is
`$CARGO_TARGET_DIR/wasm32-wasip1/release/veripb.wasm`.

## Update an upstream

```
git submodule update --remote upstream/veripb
scripts/prepare.sh veripb
```

- **A patch fails to apply:** `prepare.sh` stops with `git am` in progress
  in `work/veripb`. Resolve it there, run `git am --continue`, then apply
  the remaining patches with `git am --3way <patch>`.
- **Upstream already contains a change:** `git am` reports the patch as
  empty or already applied. Run `git am --skip` and delete that patch file.

Then:

```
scripts/refresh-patches.sh veripb
# build and run the checks below
git add upstream/veripb patches/veripb
git commit
```

## Add or change a local fix

1. Run `scripts/prepare.sh <tree>`. For veripb-repl patches the tree is
   `veripb-repl-tui`.
2. Commit the change in `work/<tree>`. To change an existing patch, use
   `git rebase -i patch-base` there. If git reports local changes that are
   not there (bind mounts), run `git update-index --refresh` and retry.
3. Run `scripts/refresh-patches.sh <tree>`. It refuses to run while a
   `git am` or rebase is in progress.
4. Commit `patches/<name>/`, then run `scripts/prepare.sh` again so
   `work/veripb-repl` picks up veripb-repl changes.

`refresh-patches.sh` writes no commit hashes or git version, so unchanged
commits produce unchanged patch files.

## Run

```
W=$CARGO_TARGET_DIR/wasm32-wasip1/release/veripb.wasm

# One proof; <dir> is mounted at /work
node --no-warnings wasi-run/run.mjs $W <dir> -- /work/foo.opb /work/foo.pbp --dump-database /work/foo.db

# A list of "opb pbp [outopb]" lines from stdin, paths relative to <root>;
# output goes to <outdir>/<n>.out, and stdout gets "<n> <exit code> <ms> <pbp>" per line
node --no-warnings wasi-run/batch.mjs $W <root> <outdir> <first n> < list.txt

# A test binary built with cargo test --no-run --target wasm32-wasip1
node --no-warnings wasi-run/runtest.mjs <test.wasm> --test-threads=1
```

Keep each `batch.mjs` run to about 30 lines (use `split -l 30`). Larger
batches crash Node.

## Browser version

`web/` runs veripb-repl in the browser. Nothing runs on a server; files
live in an in-memory filesystem in the tab and are lost on reload.

Modes, chosen in the header menu or with `?mode=<name>` in the URL (the last
choice is remembered):

| Mode | Interface | Status |
|---|---|---|
| `plain` | `veripb-repl --plain` line interface | available |
| `classic` | the veripb-repl TUI in a terminal emulator (xterm.js) | available |
| `enhanced` | browser-native panes driven by session data | available (first milestone) |

Switching modes starts a fresh REPL. Files are carried over; the proof
session is not (`:save` it first).

If the REPL crashes (for example, out of WebAssembly memory on a very
large proof) or after `:quit`, plain and enhanced modes offer **Restart the
REPL**: a new REPL in the same worker, on the same files (the proof session
is lost). web-repl's session count starts above the previous REPL's
(`vr_session_base`), so nothing the page cached for the old REPL is taken
for the new one's.

Leaving the page loses the session (files exist only in the tab), so
Backspace outside a text field does nothing, a horizontal trackpad swipe
does not go back (`overscroll-behavior-x`), and while there are files the
browser asks before leaving or reloading.

Resource usage (the gauge at the right of the header, every mode):
- **Memory:** the REPL's WebAssembly memory and the last veripb run's, each
  against the 4 GiB limit; the largest veripb run; the files; the page's
  JavaScript heap and the device memory, where the browser reports them.
- **Time:** commands and veripb runs, in all and the latest (elapsed times:
  browsers do not report CPU use), and the number of cores.
- **Files:** each file's size, and veripb's temporary files.

Refreshed every 2 s while open. A busy REPL cannot answer; the modal then
shows **Working now** (every second): the command or pane update and how
long it has run, the veripb run in progress with its memory and output, and
the REPL's memory, from the usage veripb's runs report as they go
(`onUsage` in `host.js`); the other figures are from before. In classic mode only the browser's figures and the files are shown.
`web/resources.js`, fed by the worker's `resources` message
(`repl-worker.js`).

Files panel (left; "Files" in the header hides and shows it, remembered):
- **Load demo files:** copies veripb-repl's `demos/files` into `/`.
- **Load example files:** copies veripb-repl's `examples` into `/`.
- **Upload:** adds local files.
- **Badges:** F marks a formula (`.opb`), P a proof (`.pbp`). Hover a name for its size.
- **Use a file:** double-click its name (or focus it and press Enter) to run
  `:load <name>` for a formula or `:source <name>` for a proof, as if typed
  at the prompt. In classic mode the command is typed at the TUI's prompt,
  replacing what is there.
- **Download:** ↓ next to a file.
- **Delete:** × next to a file, after a confirmation.
- **Drag and drop:** files dropped anywhere on the page are added, in every
  mode (base names only).

```
scripts/prepare.sh
scripts/build-web.sh
scripts/serve.py [port] [address]      # default 8000 127.0.0.1; then open http://localhost:8000
scripts/deploy.sh [dir]                # on a web server: submodules, prepare, build, copy web/ to dir (default /var/www/html)
scripts/update-upstream.sh <veripb|veripb-repl|crossterm> [ref]   # move a submodule to its branch head (or ref), re-apply patches, build, test; stops before committing
```

`serve.py` sends `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` (classic mode needs a
cross-origin-isolated page for `SharedArrayBuffer`) and `Cache-Control:
no-cache`. Without those headers plain mode works and classic mode shows
what is missing. Serve from the host if the container publishes no ports:
`web/` is part of the bind-mounted repo.

Plain mode:
- **Input:** one line per Enter. Up and Down step through command history.
- **Paths:** relative paths resolve against `/`, for example
  `:instance two-of-three`.
- **veripb output:** lines that veripb printed during the command (its
  version banner, traces, raw errors) are grouped into "veripb output · N
  lines" blocks that open and close on click. A block starts closed when it
  has more than 20 lines. For `:check`, `:show`, `:explain`, `:list`,
  `:objective`, `:preserved` and `:help` (or an unambiguous prefix of one),
  veripb's lines are shown in full and not grouped. veripb's status lines
  (`s VERIFIED …`) and all of the REPL's own lines are never grouped. A line
  counts as veripb output when it matches, exactly, a line of the stdout or
  stderr of a veripb run made during that command. A block is drawn only
  while open; one of more than 2000 lines scrolls as a virtual list, only
  the lines on screen in the DOM.
- **Progress:** while a command runs (after half a second), the command line
  shows it with the time so far, the veripb run if more than one, and the
  proof line veripb has read up to (in enhanced mode, "of N" and a
  percentage), updated about ten times a second. It comes from veripb's
  reads of the proof file, so every run reports it, `:check`'s too.
- **`:check` and `:objective`:** asked again before the session changes (the
  formula, the proof or its checked prefix), they show the output they gave
  last time rather than running veripb again; `:check` is kept per
  conclusion. The header then shows 0 veripb runs.
- **Bare `:check` and bare `:save`** try the proof's intended conclusion first (the one the sourced proof file closes with, or `:conclusion`'s), then veripb-repl's own candidates.
- **Timing:** the header shows the last command's duration and veripb run
  count.

Classic mode:
- **Interface:** the veripb-repl TUI, unchanged, in an xterm.js terminal
  that fills the mode area. Keys and mouse (hover, scroll, clicks) behave as
  in a terminal; the terminal size follows the window.
- **Starting:** the TUI starts without a formula; load one with
  `:instance`, `:load` or `:source` after adding files.
- **Keys the browser keeps:** some shortcuts never reach the page, for
  example Ctrl-W, Ctrl-T and Ctrl-N in Chrome.
- **Files:** uploads, demo files and downloads work while the TUI runs, up
  to 32 MiB per file.
- **Ending:** `:quit` or Ctrl-D on an empty line ends the session; switch
  mode or reload to start again.

Enhanced mode:
- **Panes:** Formula | Database | Proof on top; Output, Transcript,
  Preserved and Extras tabs and the command line below. Each top pane draws
  only the rows on screen plus a screen either side, fetched from the REPL
  as you scroll, so proofs of a million lines and more stay responsive.
  After a command or an edit the panes update in two steps: at once from a
  summary without the database (`vr_state_quick`), then the Database pane,
  which may need the REPL to replay the proof to rebuild its database; while
  it does, that pane is dimmed under "Updating the Database pane", with the
  time and the proof line reached. During `:verify` the proof lines veripb
  has certainly accepted show as checked as it goes (a dimmer ✓, "checked
  (verifying…)"), before the REPL's own statuses arrive.
- **Filters:** each top pane has a filter box. A number matches that id
  (Formula, Database) or proof line; other text matches a case-insensitive
  substring of the row, labels included. The pane title shows "m of n"
  while filtering. Drag the splitters to resize
  (double-click resets); sizes and the open tab are remembered.
- **Zoom:** as in the TUI, each pane header (and the tab bar, for the bottom
  area) has ▭ and ⛶ buttons. A top pane's ▭ gives it the whole top row and ⛶
  also shrinks the bottom area; the bottom area's ▭ squeezes the panes above
  and ⛶ hides them. Click the pressed button again, or press Esc, to
  restore. A zoomed layout follows `:edit` to Proof and `:formula` to Formula.
- **Formula:** each line with its constraint ids; `@labels` and variables
  highlighted; objective and `preserved:` lines on top.
- **Database:** the checked prefix's constraints with labels; a grey bar
  marks core constraints, a blue bar derived ones. The filter matches an id,
  label or text (see Filters); the core/derived boxes hide either kind. During `:debug`,
  the constraints derived by the last step are highlighted.
- **Proof:** ✓ checked, ○ unchecked, ✗ rejected (hover the ✗ for the
  message). Click the gutter to toggle a breakpoint. Click a line to put
  `:edit <n>` in the command line (it is not run). In the REPL's own edit
  mode (`:deassert`), the input starts with the text of the line being
  edited (the REPL's `Line <n>:` echo), to change in place.
- **Vim-style editing** (the TUI's key set, `modes/vim.js`): double-click a
  proof line, or run `:edit [<n>]` (default: the last line) or `:insert
  <n>`, to edit the Proof pane in place; the pane title shows `-- NORMAL --`
  or `-- INSERT --`.
  - Normal: `h`/`l`/←/→ and `j`/`k`/↑/↓ move, Ctrl/Alt+←/→ by word; `i`/`a`
    insert at/after the cursor, `o`/`O` open a line below/above; `x` deletes
    a character, `dd` the line; `b` toggles a breakpoint; `:` goes to the
    prompt; Esc leaves. A click moves the cursor; double-click another line
    to move there.
  - Insert: type to edit the line; Enter splits it; Backspace at its start
    joins it to the line above, Delete at its end pulls up the line below
    (not in the TUI); ↑/↓, and ←/→ at either end, move to the neighbouring
    line; Esc returns to Normal.
  - Insert mode holds edited lines (marked in the pane, italic) and commits
    them on Esc, or before a split or join: moving between lines commits
    nothing, and a line edited back to what it was is not committed at all.
  - Each commit (`x`, `dd`, `o`/`O`, Enter, a join, and each changed line on
    Esc) is one `:undo` action and marks the line and those after it
    unchecked, as in the TUI (`vr_buffer_edit`), except that retyping a `%`
    comment or blank line as one keeps every line checked. Hover a line for "explain": a modal
  for that line, which leaves Output untouched (Copy; Esc, Close or a click
  outside closes it). `:explain` typed at the prompt prints to Output as usual.
- **Explain modal:** for a checked `rup`, `pol`, `red`, `a`, `setlvl` or `wiplvl` line, "Plain
  English" explains the rule and then the line step by step, written for
  students: for `rup`, the forced values that lead to the contradiction;
  for `pol`, each cutting-planes operation and why it is sound; for `red`,
  the witness and each proof goal with how it was proved; for `a`, what an
  unchecked assertion means; for `setlvl`, the level before it and the
  `wiplvl` that deletes it; for `wiplvl`, the `setlvl` lines it covers and
  the constraints it deleted (the database before and after the line, two
  veripb runs). The text comes from veripb-repl's `teach`; its links open
  a Glossary entry, show a constraint, or explain another line. "Checker"
  shows the checker's part of `:explain <n>`'s output. The
  choice is remembered. Other rules, rejected lines and implication syntax
  (`==>`, `<==`) show the checker view only.
- **Command buttons** above the prompt: Verify, Check, Undo and Debug at the
  `pbp>` prompt (with a formula loaded); in `:debug` mode, Step, Back,
  Continue and Done instead. Each runs its command as if typed (echoed, in
  history and the transcript), only while the REPL is idle; tooltips are the
  commands' usage and summary from veripb-repl (`help::COMMANDS`,
  `debug::MODE_VOCABULARY`, sent by `vr_commands`).
- **Statistics:** click a pane's title (or focus it and press Enter):
  - **Proof:** lines by rule as a donut (the five most frequent, the rest
    as "other"; hover a slice or legend row for its share), and every rule
    with its count, share and how many are checked; rule names open the
    Glossary.
  - **Database:** core and derived, and from the formula and from the
    proof, as bars.
  - **Formula:** counts of constraints, variables, lines and labels, the
    objective's terms and the preserved set.

  The Formula and Database statistics also count constraints by kind
  (clause, cardinality, general, equality, implication, trivial,
  contradiction) and give the terms per constraint and the largest
  coefficient, and each pane's size in bytes with its longest line or
  constraint. The counts come from veripb-repl's `stats`, through
  `vr_pane_stats` (`web-repl/src/stats.rs`);
  the Database's need its rows, as the pane does.
- **Jumps:** click a Formula or Proof line's number to scroll the Database
  pane to the constraints it gave rise to (they flash); click a Database
  row's ID to scroll to the formula line or proof line it came from. The
  pane jumped to is unzoomed and unfiltered if need be. A proof line's
  constraints need a traced replay of the checked proof the first time after
  it changes (the page says "Finding line n's constraints…"); after that,
  jumps are instant. A line not checked yet, or whose constraints were
  deleted, says so.
- **Constraint refs:** labels (`@name`) and constraint IDs in the Formula
  and Proof panes, the explain modal's line and its plain-English text are
  dotted-underlined. Hover one to see the constraint (ID, core or derived,
  labels, text). Click one to scroll the Database pane to it, which unzooms
  and clears a filter that hides it; in the Proof pane, where a click
  edits the line, use Ctrl+click (⌘+click on a Mac). IDs are recognised where a rule takes
  them (`modes/refs.js`): `pol` operands (not the scalar before `*`, `d`,
  `c`, `m`, `n`), the hints after `:` of `rup`, `ia`, `i`, `e`,
  `conclusion` and `qed`, `del`/`delc`/`deld`/`core id …`, and
  `proofgoal <n>`. A negative ID is relative (`-1`: the newest constraint
  at that point) and is described, not resolved.
- **Links** (in the tab bar: off, hovered row or all; remembered, off by
  default): a curve from each formula line and each checked proof line to
  the Database rows it created, while they are still there. "Hovered row"
  draws only the curves of the row under the pointer, in any of the three
  panes. The gutters between the top panes widen to
  carry them. A curve to a row scrolled out of view is dashed to the pane's
  edge; hovering a row highlights its curves. The proof lines' IDs come from
  `vr_line_ids`, one traced veripb run per change to the checked proof,
  only while links are on.
- **Debug keys:** in `:debug` mode, as in the TUI, Shift+↓ runs `:step`,
  Shift+↑ `:back` and Esc `:done`; the typed text stays. While stepping,
  the Proof pane updates after each command and the Database pane once
  stepping pauses (0.6 s with no new command), so each `:step` costs one
  veripb run and `:back` none.
- **Output:** as in plain mode, with veripb's output folded.
- **Transcript:** every line of the session, input included and nothing
  folded, as a virtual list (only the lines on screen are in the DOM, so a
  session of 800k lines opens at once); a filter box shows only the lines
  containing its text, in place of the browser's find; Copy and Download
  (`transcript.txt`) take everything.
- **Preserved:** the current and declared preserved sets, the proof line of
  the last change, and what was added or removed. Refreshed while the tab is
  open, whenever the formula or proof has changed (this runs veripb when the
  proof changes the set).
- **Extras:** refreshed in the same way. Status and Objective run veripb
  (`:check`'s probes, the objective bounds), so the tab shows at once with
  the Summary, and each fills in as it arrives (Objective first), showing
  veripb's progress meanwhile. The REPL caches both per session state, and a
  bare `:check` or `:objective` typed at the prompt fills the same cache, so
  reopening the tab, or opening it after those commands, runs nothing.
  - **Status:** `:check`'s verdict (`s VERIFIED …` or `NOT YET
    CONCLUDED`), the proof's checked and unchecked counts, a rejected
    line's reason, the intended conclusion (the sourced proof file's, or
    `:conclusion`'s; verified or not yet), and the veripb version.
  - **Objective:** `:objective`'s report: the objective, the best value
    found so far, and the best value with checked-deletion guarantees.
  - **Summary:** formula constraints and variables; database size, core
    and derived; labels; breakpoints; the prompt mode.
- **Glossary:** concepts for students new to pseudo-Boolean proofs
  (constraints, literals, unit propagation, slack, cutting planes, witness,
  proof goals, levels, …) and every proof rule from veripb-repl's `:help`
  topics, from veripb-repl's `teach::glossary`. Search matches terms and text;
  entries link to each other ("See also"). Underlined terms in a plain-English
  explanation open their entry, and the modal's "? <rule>" button opens the
  line's rule.
- **Editing:** as in plain mode, through the command line (`:edit`,
  `:insert`, `:delete`, `:undo`).
- **Tab completion:** the TUI's completer (`tui::complete`) and its rules.
  - **The strip:** the suggestion strip above the command line updates as
    you type.
  - **Keys:** ↑/↓ move the highlight. Past the completer's limit, the
    last row counts the candidates left out. Tab inserts the highlighted
    candidate, or the only one, or the candidates' longest common prefix;
    it never submits. Esc hides the strip.
  - **What it completes:** commands and rule names, files for
    `:load`/`:source`/`:save`/`:instance`, `:help` topics, `:theme` names,
    and constraint IDs, labels and variables inside rule lines.
  - **Modes:** in `:debug` and `opb>` mode it offers that mode's own
    commands.
- **`:theme [<name>]`:** the TUI's palettes, read from veripb-repl
  (`tui::theme`), for the whole page while enhanced mode is open;
  remembered. Without a choice the page uses the REPL's `light` or `dark`
  palette following the browser's colour scheme.

Differences from `veripb-repl --plain` (plain and enhanced):
- A command error is printed and the session continues; plain mode exits.
- The prompt is always `edit> ` in edit mode, without the de-asserted
  constraint.
- No "Working…" line before `:source` and `:instance`.

How it works:
- **Shell:** `index.html`, `style.css` and `shell.js` provide the mode
  menu, status line, resource usage and files panel. Each mode is a module in `web/modes/`
  with `mount(root, host)`; the interface is described in
  `web/modes/plain.js`.
- **Plain and enhanced modes:** `modes/repl-client.js` starts
  `repl-worker.js`, a module Web Worker. The worker compiles `pkg/repl.wasm`
  and `pkg/veripb.wasm`, then runs the REPL through `host.js`.
  - `modes/output-view.js` is the output pane and command line, shared by
    both modes.
  - Enhanced mode asks the worker to watch the session. After every command
    the worker then also posts `vr_state()`'s summary (counts, mode,
    breakpoints, the rejected line, a `generation` that changes with the
    session). Each top pane is a virtual list (`modes/vlist.js`) that asks for
    the rows it shows with `vr_view(pane, start, count, filter)`, in chunks of
    200, kept until the session or filter changes; filtering runs in the REPL
    (`src/views.rs`). Tooltips and jumps look a constraint up with
    `vr_find`; Links asks `vr_line_ids` for the lines on screen; the Vim
    editor reads lines from the Proof pane's rows, plus its own edits until
    a fetch includes them.
- **Classic mode:**
  - **Startup:** `modes/classic.js` starts `classic-worker.js`, which runs
    `pkg/tui.wasm` until the TUI exits.
  - **Waiting for input:** the TUI blocks in crossterm's `event::read()`.
    The `crossterm_host.read_input` import waits with `Atomics.wait` on a
    `SharedArrayBuffer` (`tty-channel.js`).
  - **Page to worker:** terminal input from xterm.js `onData`, the terminal
    size, and file requests (a mailbox) all go through that buffer.
  - **Worker to page:** terminal output and replies to file requests come
    back by `postMessage`.
- **Running veripb:** for each veripb invocation, `host.js` creates a fresh
  veripb instance on the same filesystem, with regular files as
  stdout/stderr. It copies those to `/.tmp/.veripb-stdout` and
  `/.tmp/.veripb-stderr`, and returns the exit code to the REPL. Temp files
  live in `/.tmp`, a dot-directory, so file completion does not offer it.
- **Vendored code:**
  - `@bjorn3/browser_wasi_shim` 0.4.2 in `web/vendor/browser_wasi_shim/`
  - `@xterm/xterm` 6.0.0 and `@xterm/addon-fit` 0.11.0 in
    `web/vendor/xterm/`

  All unmodified, each with its licence.

Tests (Node.js, after `scripts/build-web.sh`):

```
web/test/compare.sh              # every web/test/scripts/*.txt: native veripb-repl --plain vs web/pkg
node web/test/transcript.mjs <files-dir> [<dump-dir>] < script.txt
web/test/compare-tui.py          # veripb-repl's demos/tools/*.json: native TUI vs pkg/tui.wasm, screen by screen
node web/test/state-check.mjs    # web-repl's JSON views vs the REPL's own :list, :show and :preserved output
node --max-old-space-size=6000 web/test/large-check.mjs   # opt-in, ~7 GB RAM: a 1.1M-line proof through the views
node web/test/host-check.mjs     # host.js's fixes to the WASI shim's in-memory files (linear-time writes)
node web/test/refs-check.mjs     # which words of a proof line are constraint refs (modes/refs.js)
node web/test/teach-check.mjs    # plain-English explanations: sample lines, and a sweep of veripb's correct instances
CHROME=<chrome> [PLAYWRIGHT_CORE=<dir>] node web/test/browser-smoke.mjs [url]   # all three modes in a browser
```

`state-check.mjs` runs the plain demo scripts and checks, at every `pbp>`
prompt:
- `vr_state()`'s proof statuses and breakpoints against `:list`
- its database against `:show`

It also checks `vr_preserved()` against `:preserved` on veripb's
`add_preserved_var*` test instances.

`teach-check.mjs` checks the plain-English explanations of sample `rup`,
`pol`, `red` and `a` lines, then explains every checked line of those rules
in veripb's `tests/instances/correct/version3` and fails if one has no
explanation, a `rup` replay does not reach its conflict, or a glossary link
has no entry. It also checks that every link and see-also in the glossary
exists.

`browser-smoke.mjs` needs the `playwright-core` npm package and a Chrome or
`chrome-headless-shell` executable, and a running `scripts/serve.py`
(default URL `http://127.0.0.1:8000/`). It drives each mode: dropped files,
a verify run, carry-over of files between modes, and in enhanced mode the
pane titles and statuses, the database filter, breakpoints, a splitter drag
remembered across a reload, Tab completion, `:theme`, the transcript, and the Extras
tab (objective bounds, `:check` verdict), the Preserved tab, and the pane filters.

`compare-tui.py` replays each demo screenshot script, including its typed
keys, clicks and snapshots, against two targets:
- the native TUI in a pseudo-terminal
- `web/test/tui-bridge.mjs`, which runs `classic-worker.js` in a Node worker
  thread with the same `SharedArrayBuffer` channel

Both are rendered with the scripts' own screen emulator
(`demos/tools/tuishot.py`). It compares the screen text at every snapshot,
with temp-file names normalised.

`compare.sh` builds native veripb and veripb-repl from the unpatched
submodules. It removes prompts, "Working…" lines and temp-file names from
both transcripts, then diffs them and the files each run leaves behind. The
scripts are the four veripb-repl demo walkthroughs in plain-mode form.

## Checks

Compare the WASI binary with a native build of unpatched `upstream/veripb`
on veripb's own test instances (`work/veripb/tests/instances`, 387 proofs at `f41ce91`).
Exit codes match on every instance. Two instances under `incorrect/`
(`version2` and `version3` `solution_not_propagating`) have several
violations, and the two builds report a different one first.
