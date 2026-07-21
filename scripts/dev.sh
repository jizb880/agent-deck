#!/usr/bin/env bash
# Dev mode: backend (hot reload) + Vite dev server with HMR. Vite proxies
# /api and /ws to the backend, so open http://127.0.0.1:5173
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

node server/scripts/fix-node-pty.js || true

PORT="${PORT:-4173}"
# Tell Vite where the backend actually is, so a PORT override still proxies
# /api and /ws correctly (vite.config.js reads $BACKEND).
export BACKEND="http://127.0.0.1:${PORT}"

# Start the backend in its own process group so the trap can reap the whole
# tree (npm -> node --watch -> app -> node-pty children), not just the npm PID.
# `setsid` may be absent on stock macOS; fall back to a plain background job.
if command -v setsid >/dev/null 2>&1; then
  setsid env PORT="$PORT" npm --prefix server run dev &
  SERVER_PID=$!
  trap 'kill -- -"$SERVER_PID" 2>/dev/null || kill "$SERVER_PID" 2>/dev/null || true' EXIT INT TERM
else
  PORT="$PORT" npm --prefix server run dev &
  SERVER_PID=$!
  # Best-effort: signal the job's group via negative PID.
  trap 'kill -- -"$SERVER_PID" 2>/dev/null || kill "$SERVER_PID" 2>/dev/null || true' EXIT INT TERM
fi

echo "==> Backend PID $SERVER_PID (http://127.0.0.1:${PORT})"
echo "==> Open the UI at http://127.0.0.1:5173"
npm --prefix web run dev
