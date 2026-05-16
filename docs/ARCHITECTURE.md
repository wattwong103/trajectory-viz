# Architecture

trajectory-viz is a four-layer system: declarative source registry → DuckDB → FastAPI → React/DeckGL.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  sources.yaml  — declarative ABM source registry                         │
│    pflow-truck:       trips_glob, vehicle_key_template, columns map      │
│    pflow-taxi-tokyo:  ... (one block per ABM × scope)                    │
└──────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼  (backend/ingest.py reads sources.yaml,
                                  │   builds INSERT...SELECT from each
                                  │   source's columns map)
                                  ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  DuckDB  (output/viz/pflow.duckdb, ≈ 8 GB at PFLOW scale)                │
│    trips         — one row per trip, 26 cols + 3 F1 derived              │
│    waypoints     — one row per GPS-like sample, 16 cols                  │
│    validation_runs — per-metric calibration evidence                     │
│    ingest_log    — file-level row counts + error rows (row_count=-1)     │
└──────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼  (12 indexes on hot filter columns —
                                  │   see backend/db.py _index_statements)
                                  ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  FastAPI  (backend/app.py, uvicorn on :9999 native or :8080 Docker)      │
│    /api/stats/*            row counts, filter options, fare insights     │
│    /api/trips/*            sample, query (with F1 + zone filters)        │
│    /api/trajectories/*     sample, bbox, point, +include_segments=true   │
│    /api/analysis/temporal/*       hourly, peaks, duration, metrics-dist  │
│    /api/analysis/spatial/*        density, hotspots, link-density        │
│    /api/analysis/trip-chains/*    length, dwell, round-trip, commodity,  │
│                                   through-zone-bbox, multi-stop          │
│    /api/analysis/od-flows         grid OD + zone OD                      │
│    /api/analysis/clustering/*     run (OD features), route-similarity    │
│                                   (link-set Jaccard)                     │
└──────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼  (Vite dev proxy /api → :9999, or
                                  │   FastAPI StaticFiles in Docker)
                                  ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  React + DeckGL + MapLibre  (frontend/, Vite dev :5173 or built dist/)   │
│    MapView      — 11 DeckGL layers (trails, OD arcs, heatmap, link       │
│                   density, clusters, F3 speed-gradient, dwell markers)   │
│    FilterPanel  — vehicle type, time, city, day, goods + F1 advanced     │
│    AnalysisPanel — 8 tabs incl. Σ Summary, ⏰ Temporal, ƒ Metrics, ↗ OD,  │
│                    █ Density, ◎ Clusters, ⛓ Chains, ⊥ Links             │
│    TimeSlider   — 24h animation scrubber, speed control, trail length    │
└──────────────────────────────────────────────────────────────────────────┘
```

## sources.yaml schema (v0.2)

Each entry under `sources:` is one (ABM × scope) bundle. The full schema is defined by Pydantic models in [`backend/sources_schema.py`](../backend/sources_schema.py). Key knobs:

| Field | Purpose |
|---|---|
| `source_id` | Short label (e.g. `truck`, `taxi`) that goes into `trips.source_id` and `trips.vehicle_type` (back-compat alias). Multiple source keys may share the same `source_id`. |
| `discovery.trips_glob` | Glob pattern relative to `PFLOW_VIZ_OUTPUT_ROOT` matching this source's trip CSVs. |
| `discovery.trajectories_glob` | Optional — matches waypoint CSVs. When absent, F3 segment features stay NULL. |
| `discovery.scope.value` | Optional scope qualifier (e.g. city name). Drives the `city` column and the `{scope}` placeholder in `vehicle_key_template`. |
| `vehicle_key_template` | String template producing each row's cross-source-unique `vehicle_key`. Supports `{vehicle_id}` and `{scope}` placeholders. Examples: `truck:{vehicle_id}`, `taxi:{scope}:{vehicle_id}`. |
| `columns.trips` / `columns.waypoints` | Map from DB column name → spec. Spec is one of: `{csv: <csv_col>, type: <duckdb_type>}` (with optional `transform: <SQL>`), or `{derived: <SQL_expr>}`. |

Required trip columns (validated): `starttime`, `start_lon`, `start_lat`, `end_lon`, `end_lat`. Required waypoint columns when trajectories_glob is set: `unix_time_ms`, `lon`, `lat`. Everything else is optional.

## DuckDB schema highlights

- **Indexes (12)** on every hot filter column. Without them, the 4.43M-trip × 233M-waypoint PFLOW scale would blow past the p99 budgets (200ms/1s/500ms for stats/trips/trajectories).
- **`source_id`** is the v0.2 canonical ABM identifier; `vehicle_type` is a back-compat alias filled with the same value at ingest. v0.3 will drop the alias.
- **`vehicle_key`** is the cross-source-unique vehicle identifier (built from each source's `vehicle_key_template`). All grouping, distinct counts, and waypoint-to-trips joins MUST use `vehicle_key` — `vehicle_id` collides across taxi cities.
- **F1 derived columns** (`speed_avg_kmh`, `dwell_minutes`, `detour_ratio`) are computed in a post-ingest pass over the trips table. NULL when not computable (no waypoints → NULL speed; vehicle's last trip → NULL dwell; tiny haversine distance → NULL detour).

## Performance budgets (HARD)

Defined in `.claude/rules/trajectory-viz.md`:

1. `/api/stats/*` p99 < 200ms
2. `/api/trips/*` p99 < 1s for ≤10K-trip result sets
3. `/api/trajectories/*` < 500ms for a single trip; sample to ≤500 trajectories per render for multi-trip
4. DuckDB connection is per-request (no pool)

When designing new endpoints: profile against these budgets; add indexes for filter columns; avoid serializing >10K rows in one response without pagination.

## v0.2 changes vs v0.1

| | v0.1 | v0.2 |
|---|---|---|
| ABM sources | hardcoded truck + taxi | declarative `sources.yaml` |
| Schema migration | full re-ingest only | idempotent `ALTER TABLE ADD COLUMN IF NOT EXISTS` |
| DuckDB indexes | none (perf risk) | 12 |
| F1 trip metrics | none | speed_avg_kmh, dwell_minutes, detour_ratio |
| F2 trip-chain | length, dwell, round-trip, commodity | **+ through-zone-bbox, multi-stop, min_chain_length** |
| F3 trajectory detail | trip-level metadata | **+ per-segment link_id, speed_kmh, dwell_sec (opt-in)** |
| Frontend vehicle types | `'truck' \| 'taxi'` hardcoded | `string`, populated from `/api/stats/filter-options` |
| Filter UI | basic | + "Advanced filters" disclosure (F1 sliders) |
| Map overlays | 9 layers | + speed gradient + dwell markers (11 layers) |
| Deployment | dev-only (two processes) | + Docker (single port, single container) |
| Tests | none | 25 pytest unit tests |
| Citation | none | CITATION.cff |

## Code organization

```
trajectory-viz/
├── backend/
│   ├── app.py              FastAPI app + router registration
│   ├── config.py           PFLOW_HOME / PFLOW_VIZ_DB resolution
│   ├── db.py               DuckDB schema + connection + build_trip_filter
│   ├── ingest.py           sources.yaml → DuckDB INSERT...SELECT
│   ├── models.py           Pydantic request/response models
│   ├── sources_schema.py   Pydantic models + loader for sources.yaml
│   ├── routers/            stats.py, trips.py, trajectories.py
│   └── analysis/           temporal, spatial, trip_chains, od_flows, clustering
├── frontend/
│   ├── package.json        Vite + React + DeckGL + recharts + maplibre
│   ├── vite.config.ts      Dev proxy /api → :9999
│   └── src/
│       ├── api.ts                Client for all /api/* endpoints
│       ├── types.ts              TypeScript mirrors of Pydantic models
│       ├── hooks/                useTrajectories, useAnimation, useInsights
│       └── components/           MapView, FilterPanel, AnalysisPanel, TimeSlider
├── tests/
│   └── test_v0_2_parity.py F1/F2/F3 unit tests + cross-version DB parity
├── docs/
│   ├── QUICKSTART.md       This getting-started guide
│   ├── ARCHITECTURE.md     This file
│   ├── CONTRIBUTING.md     Adding a new ABM source, code style
│   └── examples/
│       └── sources-matsim.yaml  Example schema-driven config
├── sources.yaml            Live source registry
├── pyproject.toml          Project metadata + deps + entry points
├── Dockerfile              Multi-stage Docker build
├── docker-compose.yml      One-command deploy
├── setup.sh / setup.bat    Native dev bootstrap (Mac/Windows)
├── CITATION.cff            Citation metadata
├── LICENSE                 MIT
└── README.md               Landing page
```
