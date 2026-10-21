#!/usr/bin/env bash
# Builds web/pkg/: veripb.wasm (WASI command), repl.wasm (web-plain WASI
# reactor) and the veripb-repl demo files. Needs work/ from
# scripts/prepare.sh; does not run it, since that resets work/.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/veripb-wasm-target}"
out="$CARGO_TARGET_DIR/wasm32-wasip1/release"
pkg="$root/web/pkg"

for name in veripb veripb-repl; do
    [ -d "$root/work/$name" ] || { echo "work/$name missing: run scripts/prepare.sh" >&2; exit 1; }
done

(cd "$root/work/veripb" && cargo build --release --bin veripb --no-default-features --target wasm32-wasip1)
(cd "$root/web-plain" && cargo build --release --target wasm32-wasip1)

rm -rf "$pkg"
mkdir -p "$pkg/demos"
cp "$out/veripb.wasm" "$pkg/veripb.wasm"
cp "$out/web_plain.wasm" "$pkg/repl.wasm"
cp "$root/work/veripb-repl/demos/files/"* "$pkg/demos/"
(cd "$pkg/demos" && ls | grep -v '^index.json$' | sed 's/.*/"&"/' | paste -sd, - | sed 's/.*/[&]/') > "$pkg/demos/index.json"

ls -l "$pkg" "$pkg/demos"
