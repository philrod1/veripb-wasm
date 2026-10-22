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
| `upstream/veripb-repl` | submodule: `https://github.com/philrod1/veripb-repl.git`, branch `main` |
| `upstream/crossterm` | submodule: `https://github.com/crossterm-rs/crossterm.git`, tag `0.29` (the crates.io 0.29.0 release) |
| `patches/<name>/` | local changes, one `git format-patch` file per change, applied in name order |
| `scripts/prepare.sh` | creates the trees in `work/` (table below) |
| `scripts/refresh-patches.sh` | regenerates a patch series from the commits in a `work/` tree |
| `work/` | generated, not tracked: the patched trees that cargo builds |
| `veripb-wasm/` | wrapper crate for the veripb library; enables `getrandom`'s `wasm_js` backend |
| `repl-core/` | wrapper crate for the veripb-repl core; enables `getrandom`'s `wasm_js` backend |
| `wasi-run/` | Node.js `node:wasi` runners for the WASI binary and WASI test binaries |
| `bigint-probe/` | prints `malachite-bigint` and `i128` results, for diffing native against wasm |
| `web-repl/` | veripb-repl's line interface as a `wasm32-wasip1` reactor, built against `work/veripb-repl-tui` and `work/crossterm`: `vr_init`, `vr_line`, `vr_alloc`, `vr_free`; JSON views `vr_state`, `vr_preserved`, `vr_explain` (`:explain <n>`'s output), `vr_extras` (`:check` and `:objective` output, bounds), `vr_complete` (the TUI's completer), `vr_themes` (the TUI's palettes), `vr_commands`, plus `vr_toggle_breakpoint` and `vr_result_ptr` |
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
| `0001-checker-run-veripb-through-a-host-import-on-WASI` | On `target_os = "wasi"`, `checker::invoke::run` calls the host import `veripb_host.run_veripb` instead of spawning `veripb`; veripb's stdout and stderr are read from `/.tmp/.veripb-stdout` and `/.tmp/.veripb-stderr`. |
| `0002-Make-completion-themes-and-mode-vocabularies-public` | Visibility only: `tui::complete` and `tui::theme` become `pub mod`; `formula::MODE_VOCABULARY`, `debug::MODE_VOCABULARY` and `edit::READONLY_DURING_EDIT` become `pub`. |

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

Files panel (left; "Files" in the header hides and shows it, remembered):
- **Load demo files:** copies veripb-repl's `demos/files` into `/`.
- **Upload:** adds local files.
- **Download:** click a file name.
- **Delete:** × next to a file, after a confirmation.
- **Drag and drop:** files dropped anywhere on the page are added, in every
  mode (base names only).

```
scripts/prepare.sh
scripts/build-web.sh
scripts/serve.py [port] [address]      # default 8000 127.0.0.1; then open http://localhost:8000
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
  stderr of a veripb run made during that command.
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
  Preserved and Extras tabs and the command line below.
- **Filters:** each top pane has a filter box. A number matches that id
  (Formula, Database) or proof line; other text matches a case-insensitive
  substring of the row, labels included. The pane title shows "m of n"
  while filtering. Drag the splitters to resize
  (double-click resets); sizes and the open tab are remembered.
- **Formula:** each line with its constraint ids; `@labels` and variables
  highlighted; objective and `preserved:` lines on top.
- **Database:** the checked prefix's constraints with labels; a grey bar
  marks core constraints, a blue bar derived ones. The filter matches an id,
  label or text (see Filters); the core/derived boxes hide either kind. During `:debug`,
  the constraints derived by the last step are highlighted.
- **Proof:** ✓ checked, ○ unchecked, ✗ rejected (hover for the message).
  Click the gutter to toggle a breakpoint. Click a line to put `:edit <n>`
  in the command line (it is not run). Hover a line for "explain": a modal
  with `:explain <n>`'s output for that line, which leaves Output untouched
  (Copy; Esc, Close or a click outside closes it). `:explain` typed at the
  prompt prints to Output as usual.
- **Debug keys:** in `:debug` mode, as in the TUI, Shift+↓ runs `:step`,
  Shift+↑ `:back` and Esc `:done`; the typed text stays.
- **Output:** as in plain mode, with veripb's output folded.
- **Transcript:** every line of the session, input included and nothing
  folded; Copy and Download (`transcript.txt`).
- **Preserved:** the current and declared preserved sets, the proof line of
  the last change, and what was added or removed. Refreshed while the tab is
  open, whenever the formula or proof has changed (this runs veripb when the
  proof changes the set).
- **Extras:** refreshed in the same way. This runs veripb: `:check`'s probes
  and the objective bounds.
  - **Status:** `:check`'s verdict (`s VERIFIED …` or `NOT YET
    CONCLUDED`), the proof's checked and unchecked counts, a rejected
    line's reason, and the veripb version.
  - **Objective:** `:objective`'s report: the objective, the best value
    found so far, and the best value with checked-deletion guarantees.
  - **Summary:** formula constraints and variables; database size, core
    and derived; labels; breakpoints; the prompt mode.
- **Editing:** as in plain mode, through the command line (`:edit`,
  `:insert`, `:delete`, `:undo`).
- **Tab completion:** the TUI's completer (`tui::complete`) and its rules.
  - **The strip:** the suggestion strip above the command line updates as
    you type.
  - **Keys:** ↑/↓ move the highlight. Tab inserts the highlighted
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
  menu, status line and files panel. Each mode is a module in `web/modes/`
  with `mount(root, host)`; the interface is described in
  `web/modes/plain.js`.
- **Plain and enhanced modes:** `modes/repl-client.js` starts
  `repl-worker.js`, a module Web Worker. The worker compiles `pkg/repl.wasm`
  and `pkg/veripb.wasm`, then runs the REPL through `host.js`.
  - `modes/output-view.js` is the output pane and command line, shared by
    both modes.
  - Enhanced mode asks the worker to watch the session. After every command
    the worker then also posts `vr_state()`'s JSON, which `modes/enhanced.js`
    renders.
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
CHROME=<chrome> [PLAYWRIGHT_CORE=<dir>] node web/test/browser-smoke.mjs [url]   # all three modes in a browser
```

`state-check.mjs` runs the plain demo scripts and checks, at every `pbp>`
prompt:
- `vr_state()`'s proof statuses and breakpoints against `:list`
- its database against `:show`

It also checks `vr_preserved()` against `:preserved` on veripb's
`add_preserved_var*` test instances.

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
