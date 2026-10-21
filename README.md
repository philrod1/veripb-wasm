# veripb-wasm

WebAssembly builds of veripb and the veripb-repl core. The upstream sources
are pinned git submodules and are not modified. Local changes are kept as
patch series and applied into `work/`.

| Target | What |
|---|---|
| `wasm32-unknown-unknown` | veripb library (browser), veripb-repl core without the TUI |
| `wasm32-wasip1` | veripb command-line binary, run under a WASI runtime |

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

## Checks

Compare the WASI binary with a native build of unpatched `upstream/veripb`
on veripb's own test instances (`work/veripb/tests/instances`, 387 proofs at `f41ce91`).
Exit codes match on every instance. Two instances under `incorrect/`
(`version2` and `version3` `solution_not_propagating`) have several
violations, and the two builds report a different one first.
