#!/bin/bash
# Start all services on Linux (Huawei Cloud DevEnv)
# Usage: ./scripts/start-all.sh [options]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BRAIN_ROOT="$ROOT_DIR/brain"
RAG_DIR="$BRAIN_ROOT/rag-service"
LOG_DIR="$ROOT_DIR/memory"
PID_DIR="$LOG_DIR/pids"

echo "=== OpenClaw CS All-in-One (Linux) ==="
echo "Root: $ROOT_DIR"
echo ""

# Check node
if ! command -v node &> /dev/null; then
  echo "ERROR: node not found"
  exit 1
fi
echo "Node: $(node --version)"
echo ""

# Load .env
if [ -f "$BRAIN_ROOT/.env" ]; then
  export $(grep -v '^#' "$BRAIN_ROOT/.env" | xargs)
fi

# Ensure dist exists
if [ ! -f "$RAG_DIR/dist/main.js" ]; then
  echo "Building rag-service..."
  cd "$RAG_DIR"
  npm install --production
  npm run build
fi

mkdir -p "$LOG_DIR" "$PID_DIR"

# Step 1: DB schema
echo "[1/4] DB schema..."
if [ -f "$ROOT_DIR/scripts/init-remote-db.js" ]; then
  node "$ROOT_DIR/scripts/init-remote-db.js"
fi
echo "  OK"
echo ""

# Step 2: rag-service
echo "[2/4] Starting rag-service :8787 ..."
if ! curl -s http://localhost:8787/health 2>/dev/null | grep -q '"ok":true'; then
  nohup node "$RAG_DIR/dist/main.js" > "$LOG_DIR/rag-service-stdout.log" 2> "$LOG_DIR/rag-service-stderr.log" &
  echo $! > "$PID_DIR/rag-service.pid"
  for i in $(seq 1 30); do
    if curl -s http://localhost:8787/health 2>/dev/null | grep -q '"ok":true'; then
      echo "  OK  http://localhost:8787/health"
      break
    fi
    sleep 1
  done
else
  echo "  Already running"
fi
echo ""

# Step 3: Console
echo "[3/4] Admin console :18790 ..."
if ! curl -s http://localhost:18790/api/status 2>/dev/null | grep -q 'ok'; then
  nohup node "$ROOT_DIR/scripts/kb-admin-server.js" --config "$ROOT_DIR/config/cs-runtime.json" --port 18790 \
    > "$LOG_DIR/console-stdout.log" 2> "$LOG_DIR/console-stderr.log" &
  echo $! > "$PID_DIR/console.pid"
  sleep 2
  if curl -s http://localhost:18790/api/status 2>/dev/null | grep -q 'ok'; then
    echo "  OK  http://localhost:18790/"
  else
    echo "  WARNING: Admin console not ready"
  fi
else
  echo "  Already running"
fi
echo ""

# Step 4: Network info
echo "[4/4] Network config:"
IP=$(hostname -I | awk '{print $1}')
echo "  RAG_BASE_URL=http://${IP}:8787"
echo "  ADMIN_URL=http://${IP}:18790"
echo ""
echo "======== Done ========"
echo "Services:"
echo "  - RAG Service:  http://localhost:8787"
echo "  - Admin:        http://localhost:18790"
echo ""
echo "Stop: ./scripts/stop-all.sh"
