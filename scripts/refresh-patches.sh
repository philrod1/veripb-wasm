#!/usr/bin/env bash
# Regenerates patches/<name>/ from the commits in work/<name> after the
# `patch-base` tag. Output omits commit hashes and the git version trailer,
# so unchanged commits give unchanged patch files.
#
# Usage: scripts/refresh-patches.sh <veripb|veripb-repl>
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"

# Bind mounts can report a foreign owner intermittently; trust every repo these scripts touch.
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*'
name="${1:?usage: $0 <veripb|veripb-repl>}"
work="$root/work/$name"
out="$root/patches/$name"

git -C "$work" rev-parse -q --verify patch-base > /dev/null \
    || { echo "work/$name has no patch-base tag: run scripts/prepare.sh $name" >&2; exit 1; }
if [ -d "$work/.git/rebase-apply" ]; then
    echo "git am in progress in work/$name: finish it first" >&2
    exit 1
fi

mkdir -p "$out"
rm -f "$out"/*.patch
git -C "$work" format-patch -q --zero-commit --no-signature -o "$out" patch-base..HEAD
ls "$out"
