#!/bin/bash
# Stop mid-platform services on Linux
# Usage: ./scripts/stop-mid.sh

LOG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/memory"
PID_DIR="$LOG_DIR/pids"

echo "=== Stopping Mid-Platform ==="
echo ""

# Stop rag-service
if [ -f "$PID_DIR/rag-service.pid" ]; then
  PID=$(cat "$PID_DIR/rag-service.pid")
  if kill -0 "$PID" 2>/dev/null; then
    echo "Stopping rag-service (PID $PID)..."
    kill "$PID"
    sleep 2
    if ! kill -0 "$PID" 2>/dev/null; then
      echo "  OK"
    else
      echo "  Force killing..."
      kill -9 "$PID" 2>/dev/null
    fi
  else
    echo "rag-service not running (stale PID)"
  fi
  rm -f "$PID_DIR/rag-service.pid"
else
  echo "rag-service: no PID file"
  # Try by process name
  pkill -f 'node.*rag-service.*dist/main.js' 2>/dev/null && echo "  Killed by name" || echo "  Not running"
fi

# Stop console
if [ -f "$PID_DIR/console.pid" ]; then
  PID=$(cat "$PID_DIR/console.pid")
  if kill -0 "$PID" 2>/dev/null; then
    echo "Stopping admin console (PID $PID)..."
    kill "$PID"
    sleep 1
  fi
  rm -f "$PID_DIR/console.pid"
else
  pkill -f 'kb-admin-server' 2>/dev/null && echo "  Console killed by name" || true
fi

echo ""
echo "Done."
