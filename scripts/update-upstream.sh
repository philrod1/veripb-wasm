#!/usr/bin/env bash
# Moves an upstream submodule to the newest commit of its branch (or to
# <ref>), re-applies the local patches, rebuilds web/pkg/ and runs the
# tests. Stops before committing: it prints the commit command to run once
# you are happy with the result.
#
# Usage: scripts/update-upstream.sh <veripb|veripb-repl|crossterm> [<ref>]
#   <ref>: a commit, tag or branch of the submodule's origin (default: the
#   branch named in .gitmodules).
# Environment:
#   SKIP_PARITY=1  skip web/test/compare.sh and compare-tui.py (they build
#                  veripb and veripb-repl natively)
#   CHROME=<path>  also run web/test/browser-smoke.mjs, under scripts/serve.py
#                  on SMOKE_PORT (default 8790); PLAYWRIGHT_CORE as for that test
#
# If a patch no longer applies, the script stops with `git am` in progress
# in work/<tree> and says how to go on or go back.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
# Bind mounts can report a foreign owner intermittently; trust every repo these scripts touch.
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*'

name="${1:?usage: $0 <veripb|veripb-repl|crossterm> [<ref>]}"
case "$name" in
    veripb) trees="veripb" ;;
    veripb-repl) trees="veripb-repl veripb-repl-tui" ;;
    crossterm) trees="crossterm" ;;
    *) echo "unknown submodule $name (veripb, veripb-repl or crossterm)" >&2; exit 1 ;;
esac
sub="$root/upstream/$name"

if [ -n "$(git -C "$sub" status --porcelain)" ]; then
    echo "upstream/$name has local changes: commit or discard them first" >&2
    exit 1
fi

branch="$(git -C "$root" config -f .gitmodules --get "submodule.upstream/$name.branch" || echo main)"
ref="${2:-origin/$branch}"
old="$(git -C "$sub" rev-parse HEAD)"
git -C "$sub" fetch -q --tags origin
new="$(git -C "$sub" rev-parse --verify "$ref^{commit}")"

if [ "$old" = "$new" ]; then
    echo "upstream/$name is already at $ref ($(git -C "$sub" log --oneline -1 "$new"))."
    exit 0
fi

echo "== upstream/$name: $(git -C "$sub" rev-parse --short "$old") -> $(git -C "$sub" rev-parse --short "$new")"
if git -C "$sub" merge-base --is-ancestor "$new" "$old"; then
    echo "(moving back: $ref is an older commit)"
else
    git -C "$sub" log --oneline "$old..$new"
fi
git -C "$sub" checkout -q "$new"

go_back="git -C upstream/$name checkout $old && scripts/prepare.sh $trees"
# shellcheck disable=SC2086  # $trees is a word list
if ! "$root/scripts/prepare.sh" $trees; then
    echo >&2
    echo "A local patch no longer applies to upstream/$name." >&2
    echo "  To go on: fix it in work/<tree>, git am --continue, apply any later patches," >&2
    echo "  then scripts/refresh-patches.sh <tree> and run this script again." >&2
    echo "  To go back: $go_back" >&2
    exit 1
fi

echo "== Building web/pkg"
"$root/scripts/build-web.sh" > /dev/null

failed=""
run() {
    echo "== $*"
    if ! "$@"; then failed="$failed
  $*"; fi
}
run node "$root/web/test/state-check.mjs"
run node "$root/web/test/teach-check.mjs"
run node "$root/web/test/refs-check.mjs"
run node "$root/web/test/host-check.mjs"
if [ -z "${SKIP_PARITY:-}" ]; then
    run "$root/web/test/compare.sh"
    run python3 "$root/web/test/compare-tui.py"
else
    echo "== Parity tests skipped (SKIP_PARITY)"
fi
if [ -n "${CHROME:-}" ]; then
    port="${SMOKE_PORT:-8790}"
    python3 "$root/scripts/serve.py" "$port" > /dev/null 2>&1 &
    server=$!
    trap 'kill "$server" 2> /dev/null || true' EXIT
    sleep 1
    run node "$root/web/test/browser-smoke.mjs" "http://127.0.0.1:$port/"
else
    echo "== Browser smoke test skipped (set CHROME to run it)"
fi

echo
if [ -n "$failed" ]; then
    echo "upstream/$name is now at $(git -C "$sub" rev-parse --short "$new"), but these failed:$failed"
    echo "  To go back: $go_back"
    exit 1
fi
echo "upstream/$name is at $(git -C "$sub" rev-parse --short "$new") and every test passed. To keep it:"
echo "  git add upstream/$name && git commit -m \"Update $name to $(git -C "$sub" rev-parse --short "$new")\""
echo "  To go back instead: $go_back"
