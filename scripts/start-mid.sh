#!/bin/bash
# Start mid-platform on Linux (Huawei Cloud DevEnv)
# Usage: ./scripts/start-mid.sh [options]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BRAIN_ROOT="$ROOT_DIR/brain"
RAG_DIR="$BRAIN_ROOT/rag-service"
LOG_DIR="$ROOT_DIR/memory"
PID_DIR="$LOG_DIR/pids"

# Parse args
SKIP_ADMIN=false
SKIP_OPEN_BROWSER=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --skip-admin) SKIP_ADMIN=true; shift ;;
    --no-browser) SKIP_OPEN_BROWSER=true; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

echo "=== OpenClaw CS Mid-Platform (Linux) ==="
echo "Root:   $ROOT_DIR"
echo "Brain:  $BRAIN_ROOT"
echo "RagDir: $RAG_DIR"
echo ""

# Check node
if ! command -v node &> /dev/null; then
  echo "ERROR: node not found. Install Node.js 18+ first."
  exit 1
fi
echo "Node: $(node --version)"
echo ""

# Load .env from brain/
if [ -f "$BRAIN_ROOT/.env" ]; then
  export $(grep -v '^#' "$BRAIN_ROOT/.env" | xargs)
  echo "Loaded .env from $BRAIN_ROOT"
else
  echo "WARNING: $BRAIN_ROOT/.env not found"
fi

# Ensure dist exists
if [ ! -f "$RAG_DIR/dist/main.js" ]; then
  echo "Building rag-service..."
  cd "$RAG_DIR"
  npm install --production
  npm run build
fi

# Create logs dir
mkdir -p "$LOG_DIR"
mkdir -p "$PID_DIR"

# Stop existing process
if [ -f "$PID_DIR/rag-service.pid" ]; then
  OLD_PID=$(cat "$PID_DIR/rag-service.pid")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping old rag-service (PID $OLD_PID)..."
    kill "$OLD_PID"
    sleep 1
  fi
  rm -f "$PID_DIR/rag-service.pid"
fi

# Start rag-service
echo "[1/2] Starting rag-service :8787 ..."
NODE_PATH=$(which node)
nohup $NODE_PATH "$RAG_DIR/dist/main.js" > "$LOG_DIR/rag-service-stdout.log" 2> "$LOG_DIR/rag-service-stderr.log" &
RAG_PID=$!
echo "$RAG_PID" > "$PID_DIR/rag-service.pid"
echo "  PID: $RAG_PID"

# Wait for health
echo "  Waiting for health check..."
for i in $(seq 1 30); do
  if curl -s http://localhost:8787/health 2>/dev/null | grep -q '"ok":true'; then
    echo "  OK  http://localhost:8787/health"
    break
  fi
  sleep 1
done

# Check IP
echo ""
echo "[2/2] Network info:"
IP=$(hostname -I | awk '{print $1}')
echo "  Local IP: $IP"
echo ""
echo "======== Edge client config ========"
echo "Set on edge .env:"
echo "  DEPLOY_ROLE=edge"
echo "  RAG_BASE_URL=http://${IP}:8787"
echo "  RAG_API_KEY=${RAG_API_KEY:-local-dev-key}"
echo ""
echo "Test from another PC:"
echo "  curl http://${IP}:8787/health"
echo ""
echo "Stop: kill $RAG_PID  or  ./scripts/stop-mid.sh"
