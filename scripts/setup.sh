#!/usr/bin/env bash
# One-shot setup for macOS 12 (Monterey). Installs backend + frontend deps and
# applies the node-pty spawn-helper fix required on this platform.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> control_app setup"
echo "    node: $(node -v)   npm: $(npm -v)"

echo "==> Installing backend dependencies (server/)"
# --foreground-scripts so node-pty's build/postinstall actually run under npm 11.
npm --prefix server install --foreground-scripts

echo "==> Ensuring node-pty spawn-helper is executable (macOS fix)"
node server/scripts/fix-node-pty.js

echo "==> Installing frontend dependencies (web/)"
npm --prefix web install

echo "==> Building frontend (web/dist)"
npm --prefix web run build

echo ""
echo "==> Done. Start the dashboard with:"
echo "    ./scripts/start.sh          # production (backend serves built UI)"
echo "    npm run dev                 # dev (Vite + backend with hot reload)"
