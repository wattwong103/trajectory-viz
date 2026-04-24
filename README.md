# PFLOW Viz

Interactive visualization dashboard for PFLOW trip + trajectory data. FastAPI + DuckDB backend, React + DeckGL + MapLibre frontend.

## Architecture

```
viz/
├── backend/          FastAPI app serving /api/* from pflow.duckdb (≈ 8.4 GB)
│   ├── app.py        Uvicorn entry + router registration
│   ├── db.py         DuckDB connection + build_trip_filter helper
│   ├── ingest.py     CSV → DuckDB loader (re-runs via --reset)
│   ├── models.py     Pydantic models for request/response shapes
│   ├── routers/      stats.py · trips.py · trajectories.py
│   └── analysis/     temporal · spatial · trip_chains · od_flows · clustering
└── frontend/         Vite dev server (port 5173) with /api proxy → :9999
    └── src/          React 18 + DeckGL 9 + recharts
```

Database lives at `output/viz/pflow.duckdb` (not in git — regenerable via ingest).

## Prerequisites

- Python 3.11 in `.venv-viz/` (FastAPI, DuckDB, scikit-learn for clustering)
- Node 20+ (frontend)
- Populated DB: 4.43M trips + 233M waypoints (ingest from `output/trips/` and `output/trajectory/`)

## Run

Two processes — backend on 9999, frontend on 5173 (proxy to backend).

### Backend

```bash
# From the repo root (PFLOW monorepo or extracted viz/)
./.venv-viz/bin/python -m uvicorn viz.backend.app:app --host 127.0.0.1 --port 9999
# Windows: .venv-viz\Scripts\python.exe -m uvicorn ...
```

Verify: `curl http://127.0.0.1:9999/api/stats/filter-options`

### Frontend

```bash
cd viz/frontend
npm install    # first time only
npm run dev
```

Opens at `http://localhost:5173`. Vite proxies `/api/*` to `127.0.0.1:9999`.

## Filter trio

Every data endpoint (`/api/trips/*`, `/api/trajectories/*`, `/api/analysis/*`, `/api/stats/insights`) accepts three filter params:

| Param | Type | Values |
|---|---|---|
| `vehicle_type` | `^(truck\|taxi)$` | `truck`, `taxi` |
| `city` | `^[a-z_]+$` | `tokyo`, `osaka` (query `/api/stats/filter-options` for current set) |
| `simulation_day` | `int ≥ 0` | `0..4` |

Any subset can be omitted. Assembled internally via `db.build_trip_filter(vehicle_type, city, simulation_day, extra=[...])`.

## Cross-city correctness — `vehicle_key`

Taxi `vehicle_id`s restart from 1 per city — Tokyo taxi #47 and Osaka taxi #47 are distinct fleets sharing an integer ID. Any aggregation, join, or `COUNT DISTINCT` that uses `vehicle_id` silently merges them.

The DB materializes a globally-unique `vehicle_key` column (`taxi:tokyo:47`, `taxi:osaka:47`, `truck:500432`). **All server-side grouping, distinct counts, and waypoint-via-trips subqueries must use `vehicle_key`.** `vehicle_id` is retained only as an origin-system identifier.

Waypoint queries filter through the subquery pattern:

```sql
SELECT ... FROM waypoints
WHERE vehicle_key IN (SELECT DISTINCT vehicle_key FROM trips {build_trip_filter(...)})
```

## Ingest

```bash
.venv-viz/Scripts/python.exe -m viz.backend.ingest --reset
```

- `--reset` drops and recreates tables. Without it, re-runs **duplicate rows** (ingest is not idempotent).
- Reads most recent `output/trips/**/trips_pseudo_pflow.csv` per vehicle_type × city.
- Reads most recent `output/trajectory/**/waypoints.csv` per city.
- Populates `validation_runs` from each run's `validation.csv` (absent for Osaka taxi — logged, not an error).

## Known data gaps

- `trips.origin_zone` / `trips.dest_zone` are 100% NULL for all 2.73M truck rows. `/api/analysis/od-flows/zones` correctly returns empty. To populate, the truck CSV writer (`TruckTripWriter.java`) would need to emit zone columns, OR ingest would need to derive zones from coordinates via the 70-zone config.
- `output/trajectory/truck/` is empty — trajectory animation for trucks requires running the Java trajectory job against a sampled truck trip CSV.

## Endpoints reference

Stats
- `GET /api/stats` — trip/waypoint row counts, bounding boxes
- `GET /api/stats/insights?vehicle_type=&city=&simulation_day=` — core metrics, peak hours, fare summary (taxi)
- `GET /api/stats/filter-options` — available filter values + `city_centers: {city: [lon, lat]}` for frontend fly-to

Trips
- `GET /api/trips/sample?n=&vehicle_type=&city=&simulation_day=` — random trip points
- `POST /api/trips/query` — filtered query with hour/zone/goods_type

Trajectories (DeckGL TripsLayer-ready path + timestamps arrays)
- `GET /api/trajectories/sample` · `POST /api/trajectories/query-bbox` · `POST /api/trajectories/query-point`

Analysis
- `/api/analysis/temporal/{departures,peaks,duration}`
- `/api/analysis/spatial/{density-grid,waypoint-density,hotspots}`
- `/api/analysis/trip-chains/{length-distribution,dwell-times,round-trips,commodity-patterns}`
- `/api/analysis/od-flows` · `/api/analysis/od-flows/zones`
- `/api/analysis/clustering/status` · `POST /api/analysis/clustering/run`

## Standalone mode

The viz module can run against any pre-ingested `pflow.duckdb` file without needing the full PFLOW monorepo on disk. Set `PFLOW_VIZ_DB` to an absolute path and the backend will serve from that file without ever resolving `PFLOW_HOME`.

Quick start (DB already ingested):

```bash
export PFLOW_VIZ_DB=/path/to/pflow.duckdb
python -m uvicorn viz.backend.app:app --host 127.0.0.1 --port 9999
```

If you have the raw CSV outputs but not the monorepo, ingest them first using `--output-root` to point at the directory containing `trips/` and `trajectory/` subtrees:

```bash
python -m viz.backend.ingest \
  --db-path /path/to/out.duckdb \
  --output-root /path/to/pflow_output \
  --reset
```

For a persistent standalone setup without repeating CLI flags, export both env vars before starting the backend:

```bash
export PFLOW_VIZ_DB=/path/to/pflow.duckdb
export PFLOW_VIZ_OUTPUT_ROOT=/path/to/pflow_output
python -m viz.backend.ingest --reset
python -m uvicorn viz.backend.app:app --host 127.0.0.1 --port 9999
```

## Troubleshooting

- **Port 9999 has ghost listeners** (Windows) — check `Get-NetTCPConnection -LocalPort 9999`. If zombie listeners appear but don't respond, either reboot or run backend on an alternate port and update `vite.config.ts` proxy.
- **Vite binds only to `::1` on Windows** — `curl 127.0.0.1:5173` returns HTTP 000; use `localhost:5173` or IPv6 `[::1]`. Browsers handle `localhost` resolution automatically.
- **Clustering endpoint errors with "No clustering library"** — install `scikit-learn` into `.venv-viz`: `.venv-viz/Scripts/python.exe -m pip install scikit-learn`.
- **Ingest produced duplicate rows** — re-run with `--reset`. Check `ingest_log` table for suspicious timestamps.
