#!/usr/bin/env bash
# Starts the pricing backend and the Angular dev server together for local testing.
# Ctrl-C stops both. If either process exits, the other is stopped too.
#
# Usage: scripts/dev.sh
# Env overrides: BACKEND_PORT (default 3001), FRONTEND_PORT (default 4200), FRONTEND_HOST (default 127.0.0.1)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Must match the /api target in frontend/proxy.conf.json.
BACKEND_PORT="${BACKEND_PORT:-3001}"
FRONTEND_PORT="${FRONTEND_PORT:-4200}"
# The package.json start script binds 0.0.0.0 (LAN-visible); default to loopback here.
FRONTEND_HOST="${FRONTEND_HOST:-127.0.0.1}"

fail() { echo "[dev] ✖ $*" >&2; exit 1; }

for dir in backend frontend; do
  [ -d "$ROOT/$dir/node_modules" ] || fail "Missing dependencies in $dir/. Run: npm ci --prefix $dir"
done

for port in "$BACKEND_PORT" "$FRONTEND_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    fail "Port $port is already in use. Stop that process or set BACKEND_PORT/FRONTEND_PORT."
  fi
done

[ -f "$ROOT/backend/.env" ] || echo "[dev] ℹ No backend/.env: only us-east-1 pricing (local file) will be available."

BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
  trap - INT TERM EXIT
  echo
  echo "[dev] Stopping..."
  for pid in "$FRONTEND_PID" "$BACKEND_PID"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap 'cleanup; exit 130' INT TERM
trap cleanup EXIT

echo "[dev] Starting backend on :$BACKEND_PORT"
# Process substitution (not a pipe) so $! is the server PID, not sed's.
(cd "$ROOT/backend" && PORT="$BACKEND_PORT" exec node server.js) > >(sed -l 's/^/[backend]  /') 2>&1 &
BACKEND_PID=$!

for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$BACKEND_PORT/api/status" >/dev/null 2>&1 && break
  kill -0 "$BACKEND_PID" 2>/dev/null || fail "Backend exited during startup."
  sleep 0.5
done
curl -fsS "http://127.0.0.1:$BACKEND_PORT/api/status" >/dev/null 2>&1 || fail "Backend did not respond on :$BACKEND_PORT."

echo "[dev] Starting frontend on http://$FRONTEND_HOST:$FRONTEND_PORT"
(cd "$ROOT/frontend" && exec ./node_modules/.bin/ng serve --host "$FRONTEND_HOST" --port "$FRONTEND_PORT") \
  > >(sed -l 's/^/[frontend] /') 2>&1 &
FRONTEND_PID=$!

# bash 3.2 on macOS has no `wait -n`; poll instead.
while kill -0 "$BACKEND_PID" 2>/dev/null && kill -0 "$FRONTEND_PID" 2>/dev/null; do
  sleep 1
done
echo "[dev] A process exited; shutting down the other."
