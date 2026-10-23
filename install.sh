#!/usr/bin/env bash
# One command: clone Overhear and open its launcher menu.
#   curl -fsSL https://raw.githubusercontent.com/zkasuran/overhear-alexa/main/install.sh | bash
set -euo pipefail
DIR=${OVERHEAR_DIR:-overhear-alexa}
command -v git >/dev/null || { echo "git is required"; exit 1; }
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only -q; else git clone -q https://github.com/zkasuran/overhear-alexa "$DIR"; fi
cd "$DIR"
exec ./overhear.sh "${@:-menu}"
