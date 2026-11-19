#!/usr/bin/env bash
# Builds web/pkg/: veripb.wasm (WASI command), repl.wasm (web-repl WASI
# reactor, the Verify tab), cps.wasm (cp-solver's CLI, a WASI command: the
# Solver tab's solving and checking), the veripb-repl demo files and
# cp-solver's example models. Needs work/ from scripts/prepare.sh; does not
# run it, since that resets work/.
#
# Usage: scripts/build-web.sh [--release]
#   cp-solver comes from the newest commit of its dev branch, fetched into
#   work/cp-solver-dev (if the fetch fails, the commit already there is
#   used); with --release, from upstream/cp-solver, the submodule commit on
#   its main branch. pkg/build.json records which: {"cpSolver": {"branch",
#   "commit", "url"}}.
set -euo pipefail

release=""
case "${1:-}" in
    "") ;;
    --release) release=1 ;;
    *) echo "usage: $0 [--release]" >&2; exit 1 ;;
esac

root="$(cd "$(dirname "$0")/.." && pwd)"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/veripb-wasm-target}"
out="$CARGO_TARGET_DIR/wasm32-wasip1/release"
pkg="$root/web/pkg"

# work/<name> must be fully prepared: patch-base tag present, no `git am` in
# progress, and (veripb-repl) no TUI left.
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*'
for name in veripb veripb-repl veripb-repl-tui crossterm; do
    work="$root/work/$name"
    if [ ! -d "$work/.git" ] || ! git -C "$work" rev-parse -q --verify patch-base > /dev/null \
        || [ -d "$work/.git/rebase-apply" ]; then
        echo "work/$name is not fully prepared: run scripts/prepare.sh $name" >&2
        exit 1
    fi
done
if grep -q '^crossterm' "$root/work/veripb-repl/Cargo.toml"; then
    echo "work/veripb-repl still has the TUI: run scripts/prepare.sh veripb-repl" >&2
    exit 1
fi

# cp-solver: the submodule (main) for a release, else dev's newest commit.
cp_url="$(git -C "$root" config -f .gitmodules --get submodule.upstream/cp-solver.url)"
if [ -n "$release" ]; then
    cp_solver="$root/upstream/cp-solver"
    cp_branch=main
    [ -e "$cp_solver/.git" ] || { echo "upstream/cp-solver missing: run git submodule update --init" >&2; exit 1; }
else
    cp_solver="$root/work/cp-solver-dev"
    cp_branch=dev
    [ -d "$cp_solver/.git" ] || git init -q "$cp_solver"
    if git -C "$cp_solver" fetch -q --depth 1 --no-tags "$cp_url" dev; then
        git -C "$cp_solver" checkout -q --force --detach FETCH_HEAD
    elif git -C "$cp_solver" rev-parse -q --verify HEAD > /dev/null; then
        echo "could not fetch cp-solver's dev branch: building the commit in work/cp-solver-dev" >&2
    else
        echo "could not fetch cp-solver's dev branch, and work/cp-solver-dev is empty" >&2
        exit 1
    fi
fi
cp_commit="$(git -C "$cp_solver" rev-parse --short=7 HEAD)"
echo "== cp-solver: $cp_branch @ $cp_commit"

(cd "$root/work/veripb" && cargo build --release --bin veripb --no-default-features --target wasm32-wasip1)
(cd "$root/web-repl" && cargo build --release --target wasm32-wasip1)
(cd "$cp_solver" && cargo build --release -p cli --bin cps --target wasm32-wasip1)

rm -rf "$pkg"
mkdir -p "$pkg/demos"
cp "$out/veripb.wasm" "$pkg/veripb.wasm"
cp "$out/web_repl.wasm" "$pkg/repl.wasm"
cp "$out/cps.wasm" "$pkg/cps.wasm"
cp "$root/work/veripb-repl/demos/files/"* "$pkg/demos/"
mkdir -p "$pkg/examples"
cp "$root/work/veripb-repl/examples/"* "$pkg/examples/"
mkdir -p "$pkg/models"
cp "$cp_solver/examples/"*.scp "$pkg/models/"
for set in demos examples models; do
    (cd "$pkg/$set" && ls | grep -v '^index.json$' | sed 's/.*/"&"/' | paste -sd, - | sed 's/.*/[&]/') > "$pkg/$set/index.json"
done

printf '{"cpSolver": {"branch": "%s", "commit": "%s", "url": "%s"}}\n' "$cp_branch" "$cp_commit" "${cp_url%.git}" > "$pkg/build.json"

ls -l "$pkg" "$pkg/demos"
