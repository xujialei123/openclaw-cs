#!/bin/bash
# Stop all services on Linux (Huawei Cloud DevEnv)
# Usage: ./scripts/stop-all.sh

LOG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/memory"
PID_DIR="$LOG_DIR/pids"

echo "=== Stopping All Services ==="
echo ""

# Kill all node processes we manage
echo "[1] Stopping managed processes..."

for pidfile in "$PID_DIR"/*.pid; do
  [ -f "$pidfile" ] || continue
  PID=$(cat "$pidfile")
  NAME=$(basename "$pidfile" .pid)
  if kill -0 "$PID" 2>/dev/null; then
    echo "  Stopping $NAME (PID $PID)..."
    kill "$PID" 2>/dev/null
    sleep 1
    if ! kill -0 "$PID" 2>/dev/null; then
      echo "    OK"
    else
      echo "    Force killing..."
      kill -9 "$PID" 2>/dev/null
    fi
  else
    echo "  $NAME: not running (stale PID)"
  fi
  rm -f "$pidfile"
done

# Also kill by process name for any stragglers
echo ""
echo "[2] Cleaning up any remaining processes..."
pkill -f 'node.*rag-service' 2>/dev/null && echo "  rag-service cleaned" || true
pkill -f 'kb-admin-server' 2>/dev/null && echo "  console cleaned" || true
pkill -f 'cs-watch' 2>/dev/null && echo "  cs-watch cleaned" || true
pkill -f 'wecom-bridge' 2>/dev/null && echo "  wecom cleaned" || true

echo ""
echo "Done."
