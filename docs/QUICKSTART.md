# QUICKSTART — trajectory-viz

Two paths: **Docker** (fastest, one command) or **native** (Mac/Windows dev, with Vite HMR for frontend changes).

---

## Path A: Docker (recommended for first-time users)

**Prerequisite**: Docker Desktop installed.

1. Place a pre-ingested DuckDB file at `./data/pflow.duckdb` (relative to the repo root).
   - If you don't have one, see *Path B → Ingest* below, then come back.
2. Run:

   ```bash
   docker compose up --build
   ```

3. Visit **<http://localhost:8080>**. The dashboard loads; map renders; vehicle-type filter buttons populate from the DB.

The container serves both the FastAPI backend and the built React frontend from a single port. To rebuild after pulling new code: `docker compose up --build --force-recreate`.

---

## Path B: Native (Mac + Windows)

Best for development with Vite HMR. Two processes: backend on :9999, frontend dev server on :5173.

### Prerequisites

- Python ≥ 3.11
- Node.js ≥ 20
- `git`, `npm`

### One-time setup

```bash
# macOS / Linux
cd trajectory-viz
./setup.sh

# Windows
cd trajectory-viz
setup.bat
```

Each script creates `.venv-viz/`, installs the project in editable mode (`pip install -e .`), and runs `npm install` in `frontend/`.

> **Dropbox-sync caveat (cross-platform)**: `.venv-viz/` and `frontend/node_modules/` are platform-specific. If you sync the repo between Mac and Windows via Dropbox, both directories will sync as opaque blobs and break on the other OS. Add both to Dropbox **Selective Sync exclusions** (the same way `output/` is already excluded in the parent PFLOW repo), and re-run `setup.{sh,bat}` per machine.

### Ingest data

```bash
# macOS / Linux
./.venv-viz/bin/trajectory-viz-ingest --reset

# Windows
.venv-viz\Scripts\trajectory-viz-ingest --reset
```

What it does: reads `sources.yaml`, discovers matching CSVs under `$PFLOW_VIZ_OUTPUT_ROOT` (default: `$PFLOW_HOME/output`), and ingests into `pflow.duckdb`. Computes F1 derived metrics (`speed_avg_kmh`, `dwell_minutes`, `detour_ratio`) at the end.

### Run

Two terminals:

```bash
# Terminal 1 — backend (port 9999)
trajectory-viz-serve
# or, with reload for development:
./.venv-viz/bin/python -m uvicorn backend.app:app --host 127.0.0.1 --port 9999 --reload

# Terminal 2 — frontend (port 5173, proxies /api → :9999)
cd frontend && npm run dev
```

Visit **<http://localhost:5173>**.

---

## Path C: Standalone (DuckDB file only, no source CSVs)

If you already have a `pflow.duckdb` from someone else and just want to serve it:

```bash
export PFLOW_VIZ_DB=/absolute/path/to/pflow.duckdb
trajectory-viz-serve
# Open http://localhost:9999 (or :8080 if running via Docker)
```

In this mode `PFLOW_HOME` is never resolved, so the dashboard runs anywhere the DuckDB file exists.

---

## Adding a new ABM source

The whole point of v0.2 is that adding a new ABM (e.g. MATSim, SUMO, or a custom Python ABM) is a config change, not a code change. See [CONTRIBUTING.md → Adding a source](CONTRIBUTING.md#adding-a-new-abm-source) for the step-by-step. A sample MATSim-style config lives at [docs/examples/sources-matsim.yaml](examples/sources-matsim.yaml).

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `pip install -e .` fails with "ImportError: cannot import name '_log' from pip._internal.utils" | Dropbox locked a pip self-upgrade midway. Run `python -m ensurepip --upgrade` then re-run setup. |
| `npm run dev` errors with `'vite' is not recognized` | `node_modules/` was synced from a different OS. `rm -rf frontend/node_modules && cd frontend && npm install`. |
| Backend starts but `/api/stats/filter-options` returns empty arrays | DuckDB exists but no data ingested. Run `trajectory-viz-ingest --reset` (see *Ingest data* above). |
| `Cannot locate PFLOW project root` error | Either set `PFLOW_HOME=/path/to/PFLOW`, or use standalone mode (`PFLOW_VIZ_DB=...`). |
| Docker build fails on `npm ci` | Stale `package-lock.json` vs. registry. `npm install` (not ci) once locally to refresh, then re-build. |
| Dashboard shows "No data — run simulation then ingest" but ingest completed | Check `simulation_day` filter — it might be filtering to a day with no data. Click "All days" in the dropdown. |
