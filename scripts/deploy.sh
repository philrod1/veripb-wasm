#!/usr/bin/env bash
# Builds web/ from the checked-out sources and copies it to a web server's
# document root: updates the submodules, prepares work/ (resetting it),
# builds web/pkg/, then mirrors web/ (without web/test/) into <dir>,
# deleting files there that web/ does not have. Uses sudo for the copy when
# <dir> is not writable.
#
# Usage: scripts/deploy.sh [<dir>]   (default: /var/www/html)
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
dest="${1:-/var/www/html}"

git -C "$root" submodule update --init
"$root/scripts/prepare.sh"
"$root/scripts/build-web.sh"

sudo=""
[ -w "$dest" ] || sudo="sudo"
$sudo rsync -a --delete --exclude test/ "$root/web/" "$dest/"
$sudo chmod -R a+rX "$dest"
echo "Deployed $root/web to $dest"
