#!/usr/bin/env bash

# ==============================================================================
# Franchise Expense System — Unified Startup Script
# ==============================================================================
# Starts both the PostgreSQL Backend (Port 4000) and Vite Frontend (Port 5173).
# Press Ctrl+C to cleanly stop both services.
#
# Usage:
#   ./start.sh              # Runs with production database (franchise_prod_db)
#   ./start.sh --dev        # Runs with development database (franchise_dev_db)
# ==============================================================================

set -e

ENV_MODE="production"
if [[ "$1" == "--dev" || "$1" == "-d" ]]; then
  ENV_MODE="development"
fi

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="${PROJECT_ROOT}/backend"

echo "=================================================================="
echo " Starting Franchise System in [${ENV_MODE^^}] mode"
echo "=================================================================="

# 1. Check PostgreSQL cluster on port 5432
echo "[1/3] Checking PostgreSQL cluster on port 5432..."
if command -v pg_isready >/dev/null 2>&1; then
  if ! pg_isready -p 5432 -q; then
    echo "⚠️  PostgreSQL port 5432 is not ready. Attempting to start service..."
    sudo systemctl start postgresql || true
  fi
fi

# 2. Configure Environment for Backend
if [[ "${ENV_MODE}" == "production" ]]; then
  ENV_FILE="${BACKEND_DIR}/.env.production"
  if [[ ! -f "${ENV_FILE}" ]]; then
    echo "❌ Error: ${ENV_FILE} not found."
    exit 1
  fi
  echo "[2/3] Using Production Database configuration (${ENV_FILE})"
  BACKEND_ENV_CMD="dotenv -e .env.production -- npm run dev"
else
  echo "[2/3] Using Development Database configuration (${BACKEND_DIR}/.env)"
  BACKEND_ENV_CMD="npm run dev"
fi

# 3. Clean shutdown handler for background jobs
cleanup() {
  echo ""
  echo "Shutting down Franchise services..."
  kill $(jobs -p) 2>/dev/null || true
  wait 2>/dev/null || true
  echo "All services stopped."
}
trap cleanup EXIT INT TERM

# 4. Start Backend Server (port 4000)
echo "[3/3] Starting Backend Server on http://localhost:4000..."
(
  cd "${BACKEND_DIR}"
  if [[ "${ENV_MODE}" == "production" ]]; then
    # Load .env.production variables directly
    set -a
    source "${BACKEND_DIR}/.env.production"
    set +a
    npm run dev
  else
    npm run dev
  fi
) &
BACKEND_PID=$!

# Wait a brief moment for backend to initialize
sleep 2

# 5. Start Frontend Server (port 5173)
echo "Starting Frontend Vite Server on http://localhost:5173..."
(
  cd "${PROJECT_ROOT}"
  npm run dev
) &
FRONTEND_PID=$!

# 6. Check and activate Tailscale Network
TAILSCALE_IP=$(tailscale ip -4 2>/dev/null || true)
TAILSCALE_DNS=$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName' 2>/dev/null | sed 's/\.$//' || true)
if [[ -n "${TAILSCALE_IP}" ]]; then
  tailscale serve --bg 5173 >/dev/null 2>&1 || true
fi

echo ""
echo "=================================================================="
echo " 🚀 Franchise System is UP AND RUNNING!"
echo " 🌐 Local Web UI     : http://localhost:5173"
if [[ -n "${TAILSCALE_DNS}" ]]; then
  echo " 🔒 Tailscale HTTPS  : https://${TAILSCALE_DNS}/ (Tailnet)"
fi
if [[ -n "${TAILSCALE_IP}" ]]; then
  echo " 🌐 Tailscale Direct : http://${TAILSCALE_IP}:5173/ (Tailnet)"
fi
echo " ⚙️  Backend API      : http://localhost:4000 (Proxy: /api -> :4000)"
echo " 🗄️  Database         : PostgreSQL port 5432 (${ENV_MODE})"
echo "=================================================================="
echo " Press [Ctrl+C] to stop all servers."
echo ""

# Wait for both processes
wait
