#!/usr/bin/env bash
# Bootstrap the trajectory-viz module: create .venv-viz, install Python and npm deps.
# Run once from the trajectory-viz/ directory (or any directory — script cd's to its own location).
set -e
cd "$(dirname "$0")"

echo "==> Creating Python virtual environment (.venv-viz)..."
python3.11 -m venv .venv-viz

echo "==> Installing project (editable mode)..."
./.venv-viz/bin/pip install -e .

echo "==> Installing frontend npm dependencies..."
cd frontend && npm install

echo ""
echo "Bootstrap complete."
echo ""
echo "Start the backend (monorepo mode):"
echo "  ./.venv-viz/bin/trajectory-viz-serve"
echo "  (or: ./.venv-viz/bin/python -m uvicorn backend.app:app --host 127.0.0.1 --port 9999)"
echo ""
echo "Start the backend (standalone mode):"
echo "  PFLOW_VIZ_DB=/path/to/pflow.duckdb ./.venv-viz/bin/trajectory-viz-serve"
echo ""
echo "Ingest data:"
echo "  ./.venv-viz/bin/trajectory-viz-ingest --reset"
echo ""
echo "Start the frontend (from trajectory-viz/frontend/):"
echo "  npm run dev"
