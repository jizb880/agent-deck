#!/usr/bin/env bash
# Start the dashboard in production mode: the backend serves the built UI and
# the WebSocket bridge on a single port (default 4173).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${PORT:-4173}"
HOST="${HOST:-127.0.0.1}"

# Preflight: if the port is already bound, decide whether it's a stale instance
# of THIS dashboard (safe to restart) or an unrelated process (bail with help).
EXISTING_PID="$(lsof -ti "tcp:${PORT}" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
if [ -n "$EXISTING_PID" ]; then
  CMD="$(ps -o command= -p "$EXISTING_PID" 2>/dev/null || true)"
  case "$CMD" in
    *server/src/index.js*|*control_app*)
      echo "==> Port ${PORT} held by a previous dashboard instance (PID ${EXISTING_PID}); stopping it."
      kill "$EXISTING_PID" 2>/dev/null || true
      # Wait up to ~3s for release, then force.
      for _ in 1 2 3 4 5 6; do
        lsof -ti "tcp:${PORT}" -sTCP:LISTEN >/dev/null 2>&1 || break
        sleep 0.5
      done
      lsof -ti "tcp:${PORT}" -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null || true
      ;;
    *)
      echo "!! Port ${PORT} is in use by another process (PID ${EXISTING_PID}):" >&2
      ps -o pid=,command= -p "$EXISTING_PID" >&2 || true
      echo "   Free it, or start on a different port:  PORT=4200 ./scripts/start.sh" >&2
      exit 1
      ;;
  esac
fi

if [ ! -d "web/dist" ]; then
  echo "web/dist not found — building frontend first..."
  npm --prefix web run build
fi

# Safety net: re-apply the node-pty helper fix (idempotent) in case node_modules
# was restored from cache without the executable bit.
node server/scripts/fix-node-pty.js || true

echo "==> Dashboard: http://${HOST}:${PORT}"
PORT="$PORT" HOST="$HOST" npm --prefix server run start
