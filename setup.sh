#!/usr/bin/env bash
# Bootstrap the trajectory-viz module: create .venv-viz, install Python and npm deps.
# Run once from the trajectory-viz/ directory (or any directory — script cd's to its own location).
set -e
cd "$(dirname "$0")"

# Probe for a usable Python ≥3.11. We try specific minor versions first (more
# predictable on systems with multiple Pythons), then the generic `python3`,
# then plain `python`. The first one found that reports ≥3.11 wins.
PYTHON_BIN=""
for candidate in python3.11 python3.12 python3.13 python3 python; do
    if command -v "$candidate" >/dev/null 2>&1; then
        # Confirm it's ≥3.11. `python -c` returns 0 if so, 1 otherwise.
        if "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null; then
            PYTHON_BIN="$candidate"
            break
        fi
    fi
done

if [ -z "$PYTHON_BIN" ]; then
    echo "[ERROR] No Python ≥3.11 found on PATH."
    echo "        Tried: python3.11, python3.12, python3.13, python3, python."
    echo "        Install Python 3.11+ from python.org or your package manager."
    exit 1
fi

echo "==> Using Python: $(command -v "$PYTHON_BIN") ($("$PYTHON_BIN" --version))"
echo "==> Creating Python virtual environment (.venv-viz)..."
"$PYTHON_BIN" -m venv .venv-viz

echo "==> Installing project (editable mode)..."
./.venv-viz/bin/pip install -e .

echo "==> Installing frontend npm dependencies..."
cd frontend && npm install
cd ..

# Sprint B2: ensure ./data/ exists (mount target for docker-compose.yml)
if [ ! -d "data" ]; then
    echo "==> Creating data/ directory (docker-compose mount target)..."
    mkdir -p data
    echo "Place your pre-ingested pflow.duckdb here for Docker deploys." > data/.gitkeep
fi

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
