#!/usr/bin/env bash
# Bootstrap the viz module: create .venv-viz, install Python and npm deps.
# Run once from the viz/ directory (or any directory — script cd's to its own location).
set -e
cd "$(dirname "$0")"

echo "==> Creating Python virtual environment (.venv-viz)..."
python3.11 -m venv .venv-viz

echo "==> Installing Python dependencies..."
./.venv-viz/bin/pip install --upgrade pip
./.venv-viz/bin/pip install fastapi uvicorn duckdb scikit-learn pydantic

echo "==> Installing frontend npm dependencies..."
cd frontend && npm install

echo ""
echo "Bootstrap complete."
echo ""
echo "Start the backend (monorepo mode):"
echo "  ./.venv-viz/bin/python -m uvicorn viz.backend.app:app --host 127.0.0.1 --port 9999"
echo ""
echo "Start the backend (standalone mode):"
echo "  PFLOW_VIZ_DB=/path/to/pflow.duckdb ./.venv-viz/bin/python -m uvicorn viz.backend.app:app --host 127.0.0.1 --port 9999"
echo ""
echo "Start the frontend (from viz/frontend/):"
echo "  npm run dev"
