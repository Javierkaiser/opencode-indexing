#!/usr/bin/env sh
# Installs opencode-indexing into the global OpenCode config directory.
# Thin wrapper: the cross-platform logic lives in install.mjs.
#
# The preferred form from npm is:
#   npx @javierkaiser/opencode-indexing --with-codegraph
# and, for a machine that never ran Kilo, everything at once:
#   npx @javierkaiser/opencode-indexing --aio
# This wrapper forwards to the same install.mjs, so it accepts the same flags.
#
# Usage:
#   sh install.sh [--aio] [--local|--package] [spec] [--skip-deps] [--no-restart] [--with-codegraph]
set -eu

dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if command -v node >/dev/null 2>&1; then
  exec node "$dir/install.mjs" "$@"
fi

echo "Node.js >= 22.6 is required. Install it from https://nodejs.org and re-run." >&2
exit 1
