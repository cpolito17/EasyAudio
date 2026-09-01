#!/usr/bin/env bash
# Ensure dependencies are present so tests and builds run in a fresh session.
set -euo pipefail
cd "$(dirname "$0")/../.."
if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install --no-audit --no-fund
fi
echo "EasyAudio ready. npm test | npm run build | npm run e2e (needs npm run preview)"
