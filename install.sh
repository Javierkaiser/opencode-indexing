#!/usr/bin/env sh
# Installs opencode-indexing into the global OpenCode config directory.
# Thin wrapper: the cross-platform logic lives in install.mjs.
#
# Usage:
#   sh install.sh [--skip-deps] [--no-restart]
set -eu

dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if command -v node >/dev/null 2>&1; then
  exec node "$dir/install.mjs" "$@"
fi

echo "Node.js >= 22.6 is required. Install it from https://nodejs.org and re-run." >&2
exit 1
