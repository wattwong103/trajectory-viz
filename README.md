# trajectory-viz

> Interactive visualization dashboard for **agent-based mobility model** outputs. FastAPI + DuckDB backend, React + DeckGL + MapLibre frontend.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/python-3.11+-blue.svg)](https://www.python.org/downloads/)
[![Node 20+](https://img.shields.io/badge/node-20+-green.svg)](https://nodejs.org/)
[![Status: alpha](https://img.shields.io/badge/status-v0.2.0a1-orange.svg)](#whats-new-in-v02)

Originally built against PFLOW (Pseudo-PFLOW Truck + Taxi ABMs) at the University of Tokyo Sekimoto Lab / CSIS. As of **v0.2**, the dashboard is **ABM-generic**: a new mobility model is added by writing a `sources.yaml` config block, not by editing backend code.

---

## What's new in v0.2

| | v0.1 | **v0.2** |
|---|---|---|
| ABM sources | hardcoded truck + taxi | **declarative `sources.yaml`** (e.g. PFLOW, MATSim, SUMO via config) |
| F1 — trip-level filters | distance + hour only | **+ avg speed, dwell time, route detour ratio** |
| F2 — trip-chain queries | length, dwell, round-trip, commodity | **+ through-zone-bbox, multi-stop chains** |
| F3 — trajectory detail | trip-level metadata | **+ per-segment link / speed / dwell (opt-in)** |
| F3 — clustering | OD + distance features | **+ route-similarity (Jaccard on link sets)** |
| Map overlays | 9 DeckGL layers | 11 (added speed gradient + dwell markers) |
| Deployment | dev-only (two processes) | **+ Docker (one-command, single port)** |
| Backend perf | unindexed table scans | **12 DuckDB indexes on hot filter columns** |
| Tests | none | **25 pytest unit tests** |
| Distribution | none | `pyproject.toml`, `CITATION.cff`, `Dockerfile` |

Full design notes in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Full release history in [`CHANGELOG.md`](CHANGELOG.md).

---

## Quick start

### Docker (recommended for first-timers)

```bash
# 1. Place a pre-ingested DuckDB at ./data/pflow.duckdb
# 2. Build + run
docker compose up --build
# 3. Visit http://localhost:8080
```

### Native (Mac + Windows; with Vite HMR for dev)

```bash
# One-time setup
./setup.sh        # macOS / Linux
setup.bat         # Windows

# Ingest (reads sources.yaml; populates pflow.duckdb)
trajectory-viz-ingest --reset

# Run — two terminals
trajectory-viz-serve              # backend, port 9999
cd frontend && npm run dev        # frontend dev server, port 5173
```

Visit **<http://localhost:5173>**.

See [`docs/QUICKSTART.md`](docs/QUICKSTART.md) for prereqs, troubleshooting, and standalone-mode setup.

---

## Architecture (one paragraph)

A declarative source registry (`sources.yaml`) drives ingest from any ABM whose output is trip + waypoint CSVs. Trips and waypoints land in DuckDB (12 indexes on hot filter columns). FastAPI exposes ~28 endpoints under `/api/*`. The React frontend dynamically discovers vehicle types from `/api/stats/filter-options` — so new ABMs appear as new buttons without frontend code changes. F1/F2/F3 features (multi-dim filters, trip-chain queries, per-segment trajectory attrs) are surfaced through filter sliders, dedicated AnalysisPanel tabs, and toggleable DeckGL layers.

Full diagram: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Repo map

```
trajectory-viz/
├── backend/             FastAPI + DuckDB
├── frontend/            React + DeckGL + MapLibre
├── tests/               pytest unit tests
├── docs/                QUICKSTART, ARCHITECTURE, CONTRIBUTING, examples/
├── sources.yaml         Declarative source registry
├── pyproject.toml       Project metadata + deps + entry points
├── Dockerfile           Multi-stage build
├── docker-compose.yml   One-command deploy
├── setup.sh / setup.bat Native dev bootstrap (Mac/Windows)
├── CITATION.cff         How to cite
├── LICENSE              MIT
└── README.md            (this file)
```

---

## Filter trio

Every data endpoint (`/api/trips/*`, `/api/trajectories/*`, `/api/analysis/*`, `/api/stats/insights`) accepts three core filter params plus the v0.2 F1 dimensions:

| Param | Type | Values |
|---|---|---|
| `vehicle_type` | `^[a-z][a-z0-9_]*$` | Any source_id from `sources.yaml` (e.g. `truck`, `taxi`) |
| `city` | `^[a-z_]+$` | e.g. `tokyo`, `osaka`. Query `/api/stats/filter-options` for the live list. |
| `simulation_day` | `int ≥ 0` | Day index in the run |
| `min_speed` / `max_speed` | `float` km/h | F1 speed filter |
| `max_dwell_minutes` | `float` | F1 utilization filter (heavy users have low dwell) |
| `min_detour_ratio` / `max_detour_ratio` | `float` ≥ 1.0 | F1 route-shape filter |

Assembled internally via `db.build_trip_filter(...)`. All filter params are SQL-injection-safe (Pydantic patterns or explicit `int()`/`float()` casts).

---

## Cross-source correctness — `vehicle_key`

Taxi `vehicle_id`s restart from 1 per city — Tokyo taxi #47 and Osaka taxi #47 are distinct fleets sharing an integer ID. Any aggregation, join, or `COUNT DISTINCT` that uses `vehicle_id` silently merges them.

The DB materializes a globally-unique `vehicle_key` column (`taxi:tokyo:47`, `taxi:osaka:47`, `truck:500432`). **All server-side grouping, distinct counts, and waypoint-via-trips subqueries must use `vehicle_key`.** `vehicle_id` is retained only as an origin-system identifier.

Waypoint queries filter through the subquery pattern:

```sql
SELECT ... FROM waypoints
WHERE vehicle_key IN (SELECT DISTINCT vehicle_key FROM trips {build_trip_filter(...)})
```

---

## Adding a new ABM source

1. Add a block to `sources.yaml` declaring discovery globs, `vehicle_key_template`, and the column mapping.
2. `python -m backend.sources_schema --validate sources.yaml`
3. `trajectory-viz-ingest --reset`
4. The dashboard's Vehicle Type buttons populate from `/api/stats/filter-options` — your new source appears automatically.

Full step-by-step in [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md#adding-a-new-abm-source). A worked MATSim example lives at [`docs/examples/sources-matsim.yaml`](docs/examples/sources-matsim.yaml).

---

## Endpoints reference (summary)

**Stats** — `/api/stats`, `/api/stats/insights`, `/api/stats/filter-options`

**Trips** — `/api/trips/sample`, `POST /api/trips/query` (with F1 dims)

**Trajectories** (DeckGL TripsLayer-ready path + timestamps; F3 segments opt-in via `?include_segments=true`):
`/api/trajectories/sample`, `POST /api/trajectories/query-bbox`, `POST /api/trajectories/query-point`

**Analysis**:
- Temporal: `/departures`, `/peaks`, `/duration`, **`/metrics-distribution`** (F1 histogram)
- Spatial: `/density-grid`, `/waypoint-density`, `/hotspots`, `/link-density`
- Trip chains: `/length-distribution`, `/dwell-times`, `/round-trips`, `/commodity-patterns`, **`/through-zone-bbox`** (F2), **`/multi-stop`** (F2)
- OD: `/od-flows`, `/od-flows/zones`
- Clustering: `/clustering/status`, `POST /clustering/run`, **`POST /clustering/route-similarity`** (F3)

Bold = v0.2 additions. Full OpenAPI spec served at `/docs` when the backend is running.

---

## Standalone mode

The dashboard can run against any pre-ingested `pflow.duckdb` file without the PFLOW monorepo on disk. Set `PFLOW_VIZ_DB` to an absolute path and the backend serves from that file without ever resolving `PFLOW_HOME`.

```bash
export PFLOW_VIZ_DB=/path/to/pflow.duckdb
trajectory-viz-serve
```

---

## Known data gaps

- `trips.origin_zone` / `trips.dest_zone` are 100% NULL for the 2.73M truck rows in the reference PFLOW dataset. `/api/analysis/od-flows/zones` correctly returns empty. To populate, the truck CSV writer (`TruckTripWriter.java` in the parent PFLOW repo) would need to emit zone columns, OR ingest would need to derive zones from coordinates via the 70-zone config.
- `output/trajectory/truck/` is empty in the reference dataset — trajectory animation for trucks requires running the Java trajectory job against a sampled truck trip CSV.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Port 9999 has ghost listeners (Windows) | `Get-NetTCPConnection -LocalPort 9999`. Zombie? Reboot or run on alternate port + update `vite.config.ts` proxy. |
| Vite binds only to `::1` on Windows | `curl 127.0.0.1:5173` → HTTP 000; use `localhost:5173` or IPv6 `[::1]`. Browsers handle `localhost` automatically. |
| `No clustering library` | `.venv-viz/Scripts/python.exe -m pip install scikit-learn` |
| Ingest produced duplicate rows | Re-run with `--reset`. Check `ingest_log` for suspicious timestamps. |

More in [`docs/QUICKSTART.md#troubleshooting`](docs/QUICKSTART.md#troubleshooting).

---

## Cite this work

If you use trajectory-viz in academic work, please cite it via [`CITATION.cff`](CITATION.cff) (GitHub auto-renders a "Cite this repository" button on the right rail of this page).

```bibtex
@software{wongkaew_trajectory_viz_2026,
  title  = {trajectory-viz: Interactive visualization dashboard for agent-based mobility models},
  author = {Wongkaew, Watcharapong},
  year   = {2026},
  version= {0.2.0a1},
  url    = {https://github.com/wattwong103/trajectory-viz},
  license= {MIT}
}
```

---

## License

MIT — see [LICENSE](LICENSE).

---

## Acknowledgements

Built on the PFLOW research lineage (Kashiyama et al. 2024 [Pseudo-PFLOW], Zhang et al. 2023 [Truck Logistics ext.], OpenPFLOW 2017) at the Sekimoto Lab, Center for Spatial Information Science, The University of Tokyo. See [OpenPFLOW](https://github.com/sekilab/OpenPFLOW) for the original open dataset and queue-based ABM, and the parent `Pseudo-PFLOW` workspace (this fork's upstream) for the Java simulation that produces the trips + waypoint CSVs ingested here.
