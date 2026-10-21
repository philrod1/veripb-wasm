# veripb-wasm

WebAssembly builds of veripb and the veripb-repl core. The upstream sources
are pinned git submodules and are not modified. Local changes are kept as
patch series and applied into `work/`.

| Target | What |
|---|---|
| `wasm32-unknown-unknown` | veripb library (browser), veripb-repl core without the TUI |
| `wasm32-wasip1` | veripb command-line binary, run under a WASI runtime; veripb-repl plain mode as a WASI reactor (`web-plain`) |

## Layout

| Path | Contents |
|---|---|
| `upstream/veripb` | submodule: `https://gitlab.com/MIAOresearch/software/VeriPB.git`, branch `main` |
| `upstream/veripb-repl` | submodule: `https://github.com/philrod1/veripb-repl.git`, branch `main` |
| `patches/<name>/` | local changes, one `git format-patch` file per change, applied in name order |
| `scripts/prepare.sh` | creates `work/<name>`: the submodule's checked-out commit plus local changes |
| `scripts/refresh-patches.sh` | regenerates `patches/<name>/` from the commits in `work/<name>` |
| `work/` | generated, not tracked: the patched trees that cargo builds |
| `veripb-wasm/` | wrapper crate for the veripb library; enables `getrandom`'s `wasm_js` backend |
| `repl-core/` | wrapper crate for the veripb-repl core; enables `getrandom`'s `wasm_js` backend |
| `wasi-run/` | Node.js `node:wasi` runners for the WASI binary and WASI test binaries |
| `bigint-probe/` | prints `malachite-bigint` and `i128` results, for diffing native against wasm |
| `web-plain/` | veripb-repl plain mode as a `wasm32-wasip1` reactor: `vr_init`, `vr_line`, `vr_alloc`, `vr_free` |
| `web/` | browser page running `web-plain` and veripb in a Web Worker |
| `scripts/build-web.sh` | builds `web/pkg/` (generated, not tracked) |

## Local changes

`patches/veripb/`:

| Patch | Change |
|---|---|
| `0001-parser-keep-pol-integers-as-i64` | Pol integer tokens hold an `i64`, not an `isize`. With `isize`, operands of 2^31 or more are truncated on 32-bit targets. |
| `0002-parser-make-zstd-and-xz-support-optional` | `zstd` and `xz2` (C code) are behind the default feature `native-compression`. Without it, `.zst` and `.xz` inputs return an "unsupported" error. |
| `0003-bin-use-mimalloc-on-native-targets-only` | `mimalloc` (C code) is used on non-wasm targets only. |

`work/veripb-repl` also gets a commit `local: strip TUI` made by
`prepare.sh`, ahead of `patches/veripb-repl/`. It removes `src/tui`,
`src/main.rs`, `pub mod tui;`, the `crossterm` dependency, `[[bin]]` and
`[dev-dependencies]`.

`patches/veripb-repl/`:

| Patch | Change |
|---|---|
| `0001-checker-run-veripb-through-a-host-import-on-WASI` | On `target_os = "wasi"`, `checker::invoke::run` calls the host import `veripb_host.run_veripb` instead of spawning `veripb`. |

In each `work/<name>`, the tag `patch-base` marks the commit the patch series
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

1. Run `scripts/prepare.sh <name>`.
2. Commit the change in `work/<name>`. To change an existing patch, use
   `git rebase -i patch-base` there.
3. Run `scripts/refresh-patches.sh <name>`.
4. Commit `patches/<name>/`.

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
| `classic` | the veripb-repl TUI in a terminal emulator | planned |
| `enhanced` | browser-native panes driven by session data | planned |

Switching modes starts a fresh REPL. Files are carried over; the proof
session is not (`:save` it first).

```
scripts/prepare.sh
scripts/build-web.sh
python3 -m http.server -d web 8000      # then open http://localhost:8000
```

Serve from the host if the container publishes no ports: `web/` is part of
the bind-mounted repo.

Plain mode:
- **Input:** one line per Enter. Up and Down step through command history.
- **Files:** "Load demo files" copies veripb-repl's `demos/files` into `/`,
  and "Upload" adds local files. Click a file name to download it, for
  example after `:save`.
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

Differences from `veripb-repl --plain`:
- A command error is printed and the session continues; plain mode exits.
- The prompt is always `edit> ` in edit mode, without the de-asserted
  constraint.
- No "Working…" line before `:source` and `:instance`.

How it works:
- **Shell:** `index.html`, `style.css` and `shell.js` provide the mode
  menu, status line and files panel. Each mode is a module in `web/modes/`
  with `mount(root, host)`; the interface is described in
  `web/modes/plain.js`.
- **Plain mode:** `modes/plain.js` sends input lines to `plain-worker.js`, a
  module Web Worker. The worker compiles `pkg/repl.wasm` and
  `pkg/veripb.wasm`, then runs the REPL through `host.js`.
- **Running veripb:** for each veripb invocation, `host.js` creates a fresh
  veripb instance on the same filesystem, with regular files as
  stdout/stderr. It copies those to `/tmp/.veripb-stdout` and
  `/tmp/.veripb-stderr`, and returns the exit code to the REPL.
- **WASI shim:** `@bjorn3/browser_wasi_shim` 0.4.2, vendored unmodified in
  `web/vendor/browser_wasi_shim/`.

Tests (Node.js, after `scripts/build-web.sh`):

```
web/test/compare.sh              # every web/test/scripts/*.txt: native veripb-repl --plain vs web/pkg
node web/test/transcript.mjs <files-dir> [<dump-dir>] < script.txt
```

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
