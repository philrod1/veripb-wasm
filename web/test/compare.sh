#!/usr/bin/env bash
# Runs each web/test/scripts/*.txt through native `veripb-repl --plain`
# (built from the unpatched upstream submodules) and through web/pkg in
# Node, then diffs the transcripts and the files left in the working
# directory.
#
# Normalisation before the diff: prompts removed, "Working…" lines removed
# (the web frontend does not print them), temp-file names replaced by
# `.tmpXXXXXX`.
#
# Usage: web/test/compare.sh [script.txt ...]   (default: all scripts)
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
test="$root/web/test"
demos="$root/web/pkg/demos"
native_target="${NATIVE_TARGET_DIR:-$HOME/.cache/veripb-native}"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

[ -f "$root/web/pkg/repl.wasm" ] || { echo "web/pkg missing: run scripts/build-web.sh" >&2; exit 1; }

(cd "$root/upstream/veripb" && CARGO_TARGET_DIR="$native_target" cargo build -q --locked --release --bin veripb)
(cd "$root/upstream/veripb-repl" && CARGO_TARGET_DIR="$native_target" cargo build -q --locked --release)
native_veripb="$native_target/release/veripb"
native_repl="$native_target/release/veripb-repl"

normalise() {
    sed -E \
        -e ':a' -e 's/^(pbp|opb|debug|edit( \([^)]*\))?)> //' -e 'ta' \
        -e 's/\.tmp[A-Za-z0-9]{6}/.tmpXXXXXX/g' \
        | grep -v '^Working…$' | sed -e '${/^$/d;}'
}

scripts=("$@")
[ ${#scripts[@]} -gt 0 ] || scripts=("$test"/scripts/*.txt)

status=0
for script in "${scripts[@]}"; do
    name="$(basename "$script" .txt)"
    mkdir -p "$scratch/$name/native" "$scratch/$name/web-files"
    cp "$demos"/*.opb "$demos"/*.pbp "$scratch/$name/native/"

    (cd "$scratch/$name/native" && VERIPB_REPL_VERIPB_BIN="$native_veripb" "$native_repl" --plain < "$script" 2>&1) \
        | normalise > "$scratch/$name/native.txt"
    node --no-warnings "$test/transcript.mjs" "$demos" "$scratch/$name/web-files" < "$script" \
        2> "$scratch/$name/web.stats" | normalise > "$scratch/$name/web.txt"

    same=1
    diff -u "$scratch/$name/native.txt" "$scratch/$name/web.txt" > "$scratch/$name/diff" || same=0
    diff -r -x index.json "$scratch/$name/native" "$scratch/$name/web-files" > "$scratch/$name/files-diff" || same=0
    if [ $same = 1 ]; then
        echo "same   $name  ($(wc -l < "$scratch/$name/native.txt") lines, $(cat "$scratch/$name/web.stats"))"
    else
        status=1
        echo "DIFFER $name"
        cat "$scratch/$name/diff" "$scratch/$name/files-diff"
    fi
done
exit $status
