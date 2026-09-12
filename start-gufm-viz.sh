#!/usr/bin/env bash
# start-gufm-viz.sh -- launch trajectory-viz on the GUFM vs PFLOW
# ground-truth fleets (400 heldout ward-13101 persons). macOS/Linux
# counterpart of start-gufm-viz.bat.
#
# Isolation: uses ONLY env vars + our own files. The repo's sources.yaml
# and pflow.duckdb are never touched.
#
# Fleets:   gufm  = GUFM c100 checkpoint, greedy decode
#           pflow = PFLOW ground truth, same 400 person_ids
# Data:     data/gufm/ (converter: gufm repo,
#           scripts/data_prep/viz_export_gufm_fleets.py)
#
# Re-ingest after re-running the converter:
#   PFLOW_VIZ_SOURCES=<below> PFLOW_VIZ_DB=<below> \
#     PFLOW_VIZ_OUTPUT_ROOT=<below> ./.venv-viz/bin/trajectory-viz-ingest --reset
set -e
cd "$(dirname "$0")"

ROOT="$PWD"
export PFLOW_VIZ_SOURCES="$ROOT/sources.gufm.yaml"
export PFLOW_VIZ_DB="$ROOT/data/gufm/gufm.duckdb"
export PFLOW_VIZ_OUTPUT_ROOT="$ROOT/data/gufm/output"

if [ ! -f "$PFLOW_VIZ_DB" ]; then
  echo "[ERROR] database not found: $PFLOW_VIZ_DB"
  echo "        Run the converter first (see data/gufm/README.md), then:"
  echo "        PFLOW_VIZ_SOURCES=\"\$PWD/sources.gufm.yaml\" PFLOW_VIZ_DB=\"\$PWD/data/gufm/gufm.duckdb\" \\"
  echo "          PFLOW_VIZ_OUTPUT_ROOT=\"\$PWD/data/gufm/output\" ./.venv-viz/bin/trajectory-viz-ingest --reset"
  exit 1
fi

# Backend python: dev-stack.mjs prefers .venv-viz, then PFLOW_VIZ_PYTHON,
# then python3. Export PFLOW_VIZ_PYTHON here if your venv lives elsewhere
# (e.g. a Dropbox-synced Windows venv that can't run on this machine):
#   export PFLOW_VIZ_PYTHON="$ROOT/.venv-mac/bin/python"

echo "  Dashboard:  http://localhost:5173"
echo "  API docs:   http://127.0.0.1:9999/docs"
echo "  (Ctrl+C stops both the API and the dev server)"
echo ""
cd frontend
exec npm run dev
