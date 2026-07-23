# QUICKSTART — trajectory-viz

The fastest way to see the dashboard is the **2-minute demo** below — no data
of your own required. Then: **Docker** (one command), **native** (Mac/Windows
dev with Vite HMR), or **standalone** (serve an existing DuckDB file).

---

## Path 0: 2-minute demo (no data needed)

A small synthetic day of bike couriers, city buses, and POIs around Kichijōji,
Tokyo is committed under [`demo/`](../demo) — GPX tracks, a GeoJSON bus
LineString file, and a GeoJSON POI layer, wired by `demo/sources.demo.yaml`.

```bash
pip install -e .
trajectory-viz-demo --serve
```

The first run ingests the demo dataset into `demo/demo.duckdb` (subsequent
runs reuse it; `--reset` forces a fresh ingest; `--db-path` redirects it).
Then open **<http://127.0.0.1:9999>**.

> The API is fully functional on :9999 immediately (`/api/stats`, `/docs`).
> For the full map UI either build the frontend once
> (`cd frontend && npm install && npm run build`) or run the dev server
> (`npm run dev`, <http://localhost:5173>).

To regenerate the dataset deterministically: `python demo/generate_demo_data.py`.
To point the tool at **your own** GPX/GeoJSON/NDJSON/Parquet/CSV data, see
[`docs/DATA_FORMATS.md`](DATA_FORMATS.md).

---

## Path A: Docker (recommended for first-time users)

**Prerequisite**: Docker Desktop installed.

1. **Create the data mount directory** (one-time): `./data/` is the docker-compose
   volume mount target. `setup.sh` / `setup.bat` create it automatically; if you
   haven't run either yet, just `mkdir data`.
2. **Place a pre-ingested DuckDB file at `./data/pflow.duckdb`**.
   - If you don't have one, see *Path B → Ingest* below, then come back.
3. Run:

   ```bash
   docker compose up --build
   ```

4. Visit **<http://localhost:8080>**. The dashboard loads; map renders; vehicle-type filter buttons populate from the DB.

The container serves both the FastAPI backend and the built React frontend from a single port. To rebuild after pulling new code: `docker compose up --build --force-recreate`.

---

## Path B: Native (Mac + Windows)

Best for development with Vite HMR. Two processes: backend on :9999, frontend dev server on :5173.

### Prerequisites

- Python ≥ 3.11
- Node.js ≥ 20
- `git`, `npm`

### Environment variables (optional)

All runtime config is driven by env vars. See [`env.example`](env.example) for
the full list with comments. To use Docker's auto-`.env` loading:

```bash
cp docs/env.example .env
vim .env       # uncomment + edit the variables you need
docker compose up --build
```

Native dev users typically `export PFLOW_HOME=…` in their shell instead.

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

The whole point of v0.2 is that adding a new ABM (e.g. MATSim, SUMO, or a custom Python ABM) is a config change, not a code change — and as of universal-trajectory support, the inputs can be CSV, GeoJSON, GPX, NDJSON, or Parquet (points-only sources get trips synthesized at ingest). See [CONTRIBUTING.md → Adding a source](CONTRIBUTING.md#adding-a-new-abm-source) for the step-by-step, [DATA_FORMATS.md](DATA_FORMATS.md) for the per-format cookbook, and [docs/examples/sources-matsim.yaml](examples/sources-matsim.yaml) for a worked MATSim config.

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
