#!/bin/sh
# Docker entrypoint — zero-friction first run.
#
# Default: ensure the configured DuckDB has demo trips, then serve API + UI.
# Set TRAJECTORY_VIZ_SEED_DEMO=0 to skip seeding (honest empty DB / custom mount).
set -eu

DB_PATH="${TRAJECTORY_VIZ_DB:-${PFLOW_VIZ_DB:-/app/demo/demo.duckdb}}"
SEED="${TRAJECTORY_VIZ_SEED_DEMO:-1}"

# Keep legacy aliases in sync for ingest/demo helpers.
export TRAJECTORY_VIZ_DB="$DB_PATH"
export PFLOW_VIZ_DB="$DB_PATH"
export TRAJECTORY_VIZ_SOURCES="${TRAJECTORY_VIZ_SOURCES:-${PFLOW_VIZ_SOURCES:-/app/demo/sources.demo.yaml}}"
export PFLOW_VIZ_SOURCES="$TRAJECTORY_VIZ_SOURCES"
export TRAJECTORY_VIZ_OUTPUT_ROOT="${TRAJECTORY_VIZ_OUTPUT_ROOT:-${PFLOW_VIZ_OUTPUT_ROOT:-/app/demo}}"
export PFLOW_VIZ_OUTPUT_ROOT="$TRAJECTORY_VIZ_OUTPUT_ROOT"
export TRAJECTORY_VIZ_PROFILE="${TRAJECTORY_VIZ_PROFILE:-demo}"

mkdir -p "$(dirname "$DB_PATH")"

if [ "$SEED" = "0" ] || [ "$SEED" = "false" ] || [ "$SEED" = "no" ]; then
  echo "[entrypoint] TRAJECTORY_VIZ_SEED_DEMO=$SEED — skipping demo seed ($DB_PATH)"
  python -m backend.demo --ensure --no-seed --db-path "$DB_PATH" || true
else
  echo "[entrypoint] Ensuring demo data at $DB_PATH"
  python -m backend.demo --ensure --db-path "$DB_PATH"
fi

exec "$@"
