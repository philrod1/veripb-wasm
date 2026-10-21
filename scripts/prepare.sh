#!/usr/bin/env bash
# Builds work/<name> for each upstream: the commit checked out in
# upstream/<name>, plus local changes, plus patches/<name>/*.patch.
#
# Usage: scripts/prepare.sh [veripb] [veripb-repl]   (default: both)
#
# work/<name> is a git repo. The tag `patch-base` marks the commit the
# patches apply to. On a patch conflict the script stops with `git am` in
# progress in work/<name>; fix, `git am --continue`, then run
# scripts/refresh-patches.sh <name>.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"

# Bind mounts can report a foreign owner intermittently; trust every repo these scripts touch.
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*'
names=("$@")
[ ${#names[@]} -gt 0 ] || names=(veripb veripb-repl)

# Committer identity for local commits: this repo's git config, else a fixed one.
export GIT_COMMITTER_NAME="$(git -C "$root" config user.name || echo veripb-wasm)"
export GIT_COMMITTER_EMAIL="$(git -C "$root" config user.email || echo veripb-wasm@localhost)"
export GIT_AUTHOR_NAME="$GIT_COMMITTER_NAME" GIT_AUTHOR_EMAIL="$GIT_COMMITTER_EMAIL"

# Rewrites <file> in place through `awk <program>` (portable; no sed -i).
awk_in_place() {
    local file="$1" program="$2"
    awk "$program" "$file" > "$file.new"
    mv "$file.new" "$file"
}

# veripb-repl without the TUI: no src/tui, no binary, no crossterm.
strip_tui() {
    local dir="$1"
    rm -rf "$dir/src/tui" "$dir/src/main.rs"
    awk_in_place "$dir/src/lib.rs" '!/^pub mod tui;/'
    awk_in_place "$dir/Cargo.toml" '
        /^\[/ { skip = ($0 == "[[bin]]" || $0 == "[dev-dependencies]") }
        skip { next }
        /^crossterm *=/ { next }
        { print }
    '
    if grep -q '^pub mod tui;' "$dir/src/lib.rs" || grep -q '^crossterm' "$dir/Cargo.toml"; then
        echo "strip_tui: TUI references left in $dir" >&2
        exit 1
    fi
}

for name in "${names[@]}"; do
    src="$root/upstream/$name"
    work="$root/work/$name"
    [ -e "$src/.git" ] || { echo "upstream/$name missing: run git submodule update --init" >&2; exit 1; }
    pin="$(git -C "$src" rev-parse HEAD)"
    echo "== $name @ ${pin:0:12}"

    if [ ! -d "$work/.git" ]; then
        rm -rf "$work"
        git init -q "$work"
    fi
    git -C "$work" config user.name "$GIT_COMMITTER_NAME"
    git -C "$work" config user.email "$GIT_COMMITTER_EMAIL"
    git -C "$work" am --abort 2>/dev/null || true
    git -C "$work" fetch -q --depth 1 --no-tags "$src" "$pin"
    git -C "$work" checkout -q --force --detach FETCH_HEAD
    git -C "$work" clean -q -fd

    if [ "$name" = veripb-repl ]; then
        strip_tui "$work"
        git -C "$work" add -A
        GIT_COMMITTER_DATE="@0 +0000" git -C "$work" commit -q --date="@0 +0000" -m "local: strip TUI"
    fi
    git -C "$work" tag -f patch-base > /dev/null

    shopt -s nullglob
    patches=("$root/patches/$name"/*.patch)
    shopt -u nullglob
    # One patch per `git am`, with an index refresh first: bind mounts can
    # leave stale stat data that makes `git am` report local changes.
    for patch in ${patches[@]+"${patches[@]}"}; do
        git -C "$work" update-index -q --refresh || true
        if ! git -C "$work" am -q --3way --committer-date-is-author-date "$patch"; then
            echo "patch failed in work/$name: $(basename "$patch")" >&2
            echo "fix, git am --continue, apply any later patches, then scripts/refresh-patches.sh $name" >&2
            exit 1
        fi
    done
    echo "   ${#patches[@]} patch(es) applied"
done
