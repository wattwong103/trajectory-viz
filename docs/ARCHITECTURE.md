# Architecture

trajectory-viz is a four-layer system: declarative source registry → DuckDB → FastAPI → React/DeckGL.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Sources registry (default: demo/sources.demo.yaml)                      │
│    Opt-in lab packs: profiles/pflow/, profiles/gufm/, …                  │
│    sources:  trips/waypoint globs, per-format discovery (csv | geojson | │
│              gpx | ndjson | parquet), columns map, vehicle_key_template, │
│              trips_synthesis for points-only sources; optional forms:    │
│    pois:     static POI layers (name/category/lon/lat)                   │
│    zones:    static polygon layers                                       │
│    time:     per-DB epoch_anchor (absolute time)                         │
└──────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼  (backend/ingest.py reads the active
                                  │   registry; geojson/gpx/ndjson
                                  │   normalized in Python (formats.py) →
                                  │   TEMP staging; csv/parquet native;
                                  │   shared INSERT...SELECT. Points-only:
                                  │   synthesize_trips. Anchor → viz_meta;
                                  │   mixed-anchor re-ingest needs --reset.)
                                  ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  DuckDB  (default: demo/demo.duckdb; lab: pflow.duckdb ≈ 8 GB)           │
│    trips         — one row per trip (+ F1 derived, mode, agent_id, …)    │
│    waypoints     — one row per GPS-like sample                           │
│    pois          — static POI layers (/api/pois)                         │
│    zones         — static polygon layers (/api/zones; bbox precomputed)  │
│    density_hourly — 24h pulse-heatmap aggregate (Phase 2B)               │
│    viz_meta      — epoch_anchor + schema_version (0.3)                   │
│    validation_runs — per-metric calibration evidence                     │
│    ingest_log    — file-level row counts + error rows (row_count=-1)     │
└──────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼  (12 indexes on hot filter columns —
                                  │   see backend/db.py _index_statements)
                                  ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  FastAPI  (backend/app.py, uvicorn on :9999 native or :8080 Docker)      │
│    /api/stats/*            row counts, filter options (+ registry        │
│                            health), fare insights                        │
│    /api/trips/*            sample, query (with F1 + zone filters)        │
│    /api/trajectories/*     sample, bbox, point, +include_segments=true   │
│    /api/analysis/temporal/*       hourly, peaks, duration, metrics-dist  │
│    /api/analysis/spatial/*        density, hotspots, link-density        │
│    /api/analysis/trip-chains/*    length, dwell, round-trip, commodity,  │
│                                   through-zone-bbox, multi-stop          │
│    /api/analysis/od-flows         grid OD + zone OD                      │
│    /api/analysis/clustering/*     run (OD features), route-similarity    │
│                                   (link-set Jaccard)                     │
│    /api/analysis/compare          A/B fleets (+multi, +grid diff)        │
│    /api/pois, /api/zones          static layers; zones/contains          │
│                                   (exact w/ PFLOW_VIZ_SPATIAL=1)         │
│    /api/trajectories/by-vehicle   full-day chains (+include_stationary)  │
│    /api/ingest/*                  drag-and-drop upload + job polling     │
└──────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼  (Vite dev proxy /api → :9999, or
                                  │   FastAPI StaticFiles in Docker)
                                  ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  React + DeckGL + MapLibre  (frontend/, Vite dev :5173 or built dist/)   │
│    MapView      — ~25 DeckGL layers: trajectory trails + person dots,    │
│                   OD arcs, heatmaps (density/footfall/pulse), link       │
│                   density, cluster arcs, F3 speed-gradient + dwell       │
│                   markers, POIs (glyph sprites), zones, A/B grid-diff,   │
│                   agents, drill + scenario/zone bboxes, buildings        │
│    FilterPanel  — Sources, time, city, day, goods + F1 advanced          │
│    AnalysisPanel — 8 tabs incl. Σ Summary, ⏰ Temporal, ƒ Metrics, ↗ OD,  │
│                    █ Density, ◎ Clusters, ⛓ Chains, ⊥ Links             │
│    TimeSlider   — 24h animation scrubber, speed control, trail length    │
└──────────────────────────────────────────────────────────────────────────┘
```

## sources.yaml schema (v0.2)

Each entry under `sources:` is one (ABM × scope) bundle. The full schema is defined by Pydantic models in [`backend/sources_schema.py`](../backend/sources_schema.py). Key knobs:

| Field | Purpose |
|---|---|
| `source_id` | Canonical population / dataset id (e.g. `truck`, `taxi`, `courier`). Written to `trips.source_id` and mirrored into `trips.vehicle_type` for back-compat. Multiple source keys may share the same `source_id`. |
| `mode_map` | Optional map of raw `transport_mode` int codes → canonical string labels stored in `trips.mode` (also feeds `/api/stats/filter-options` `modes[]`). |
| `discovery.trips_glob` | Glob pattern relative to `TRAJECTORY_VIZ_OUTPUT_ROOT` (alias `PFLOW_VIZ_OUTPUT_ROOT`) matching this source's trip files. Optional for points-only sources (see `trips_synthesis`). |
| `discovery.trajectories_glob` | Optional — matches waypoint files (any format). When absent, F3 segment features stay NULL. |
| `discovery.format` (+ per-side overrides) | Optional ingest format (`csv`/`geojson`/`gpx`/`ndjson`/`parquet`); auto-detected from the extension when omitted. Non-CSV formats are normalized to a canonical staging shape (`_lon`/`_lat`/`_time_ms`/`_seq`/`_feature_id`/`_trk_name`/`_props_json`) — see [DATA_FORMATS.md](DATA_FORMATS.md). |
| `discovery.scope.value` | Optional scope qualifier (e.g. city name). Drives the `city` column and the `{scope}` placeholder in `vehicle_key_template`. |
| `vehicle_key_template` | String template producing each row's cross-source-unique `vehicle_key`. Supports `{vehicle_id}` and `{scope}` placeholders. Examples: `truck:{vehicle_id}`, `taxi:{scope}:{vehicle_id}`. |
| `columns.trips` / `columns.waypoints` | Map from DB column name → spec. Spec is one of: `{csv: <col>, type: <duckdb_type>}` (with optional `transform: <SQL>`), or `{derived: <SQL_expr>}`. String vehicle/trip IDs hash-fallback to integers; `vehicle_key` stays authoritative. |
| `trips_synthesis` | Points-only sources: synthesize trips from waypoints at ingest — `gap_split` (gap_minutes), `day`, or `single`. Mutually exclusive with `trips_glob`. |
| `time.epoch_anchor` / `time.coord_times_prop` | Absolute-time handling: anchor ISO timestamp (one per DB, persisted in `viz_meta`) / GeoJSON property holding per-coordinate times. |
| `pois:` (top-level) | Static POI layers — glob, `columns` (name/category/lon/lat), optional color → `pois` table, served via `/api/pois*`. |
| `zones:` (top-level) | Static polygon layers — GeoJSON Polygon/MultiPolygon glob, `columns` (name/category from properties), optional color → `zones` table (bbox precomputed), served via `/api/zones*`. |

Required trip columns (validated): `starttime`, `start_lon`, `start_lat`, `end_lon`, `end_lat`. Required waypoint columns when trajectories_glob is set: `unix_time_ms`, `lon`, `lat`. Everything else is optional.

## Canonical vocabulary (universal forms — Phase A/B/C)

Public API and docs use these names. Physical DuckDB columns may still use
legacy names during the transition — treat aliases as the *same concept*, not
a second dimension.

| Canonical | Physical today | Notes |
|---|---|---|
| **`source_id`** | `trips.source_id` (+ mirror `vehicle_type`) | Dataset / population. Query param `source_id=` preferred; `vehicle_type=` is a deprecated alias. UI label: **Sources**. |
| **`agent_key`** | `vehicle_key` | Cross-source join identity (`(agent_key, trip_id)`). Column rename deferred; API/docs say agent_key. |
| **`mode`** | `trips.mode` (VARCHAR) + optional `transport_mode` int | Canonical filter/language is the **string label**. PFLOW ints remain as optional `mode_code` via `mode_map` / `transport_modes=`. |
| **`agent_id`** | `trips.agent_id` (VARCHAR) | Native string id. `vehicle_id` (int + hash) kept as legacy fallback; join identity is still `vehicle_key`. |
| **`leg_id`** | `trips.leg_id` / `waypoints.leg_id` (INTEGER NULL) | PFLOW v3 / MATSim sub-trip leg — first-class attribute; join remains `(agent_key, trip_id)`. |

`viz_meta.schema_version` is `0.3` after Phase C init. `/api/stats/filter-options`
exposes `capabilities` (incl. `schema_version`, `agent_id_column`, `has_legs`,
`trip_count` / `waypoint_count` scale hooks for TV-16 micro/meso/macro) and
`modes: [{id, label, count}]` (`id` may be null for string-only datasets).
**Phase B:** the FilterPanel `LayerAvailabilityContext` consumes those flags —
layer groups follow the form taxonomy (core / analysis / scene / lab plugins);
goods / footfall / pedestrianize hide when attrs or modes are absent; pulse
disable reasons cite `has_density_hourly` + the ingest fix-it command.
**Phase C:** string `mode` + string `agent_id` storage; no JSON `attrs`
migration (lab columns stay sparse/nullable).
**Phase D:** demo/universal is the default product profile
(`demo/sources.demo.yaml` → `demo/demo.duckdb`); PFLOW lives under
`profiles/pflow/` and is opted in via `TRAJECTORY_VIZ_PROFILE=pflow` /
`PFLOW_HOME` / `--profile pflow`. No silent Dropbox/PFLOW_HOME path hijack.

**Deprecation:** do not treat `vehicle_type` as a concept distinct from
`source_id`. Ingest still dual-writes the mirror column; the public contract
is Sources / `source_id` only.

## DuckDB schema highlights

- **Indexes (12)** on every hot filter column. Without them, the 4.43M-trip × 233M-waypoint PFLOW scale would blow past the p99 budgets (200ms/1s/500ms for stats/trips/trajectories).
- **`source_id`** is the canonical population identifier; `vehicle_type` is a back-compat mirror filled with the same value at ingest (kept — not a distinct filter dimension).
- **`vehicle_key`** (= public **`agent_key`**) is the cross-source-unique agent identifier (built from each source's `vehicle_key_template`). All grouping, distinct counts, and waypoint-to-trips joins MUST use `vehicle_key` — `vehicle_id` collides across taxi cities.
- **`agent_id`** (VARCHAR) stores the native agent id string; **`vehicle_id`** remains the int/hash fallback for legacy consumers.
- **`mode`** (VARCHAR) is the canonical travel-mode label; **`transport_mode`** (INTEGER) is optional PFLOW `mode_code`.
- **`leg_id`** (INTEGER NULL) stores PFLOW v3 / MATSim sub-trip legs when mapped; NULL otherwise.
- **F1 derived columns** (`speed_avg_kmh`, `dwell_minutes`, `detour_ratio`) are computed in a post-ingest pass over the trips table. NULL when not computable (no waypoints → NULL speed; vehicle's last trip → NULL dwell; tiny haversine distance → NULL detour).

## Performance budgets (HARD)

Living targets for API design (also summarized in
[CONTRIBUTING.md → Performance budgets](CONTRIBUTING.md#performance-budgets)):

1. `/api/stats/*` p99 < 200ms
2. `/api/trips/*` p99 < 1s for ≤10K-trip result sets
3. `/api/trajectories/*` < 500ms for a single trip; sample to ≤500 trajectories per render for multi-trip (macro / mega-sim LOD clamps sample/bbox to 500 — see below)
4. **DuckDB connection** is a **process-wide module singleton** (`backend.db.get_connection`) — not per-request and not a connection pool. Tests replace `backend.db._connection`.

When designing new endpoints: profile against these budgets; add indexes for filter columns; avoid serializing >10K rows in one response without pagination.

## Simulation scale (micro / meso / macro)

Engine modes for any sim type (evacuation, events, local agents, city/region
ABM) — not only mid-scale PFLOW. Policy lives in `backend/lod.py` and the
frontend `lodPolicy.ts` / layer catalog. Product **demo vs lab** profiles are
orthogonal to scale.

| `capabilities.scale` | Typical use | Default forms | Notes |
|---|---|---|---|
| **micro** | Building / block / event / evacuation | trails + agents | Fine trails OK; **never** force arcs+pulse |
| **meso** | Mid-scale city ABM (classic PFLOW packs) | trails | Current mid-scale default |
| **macro** | City / region / nation | arcs + pulse | Aggregate-first; trails sampled |

Auto-detect (override with top-level `scale:` in `sources.yaml`):

| Signal | Threshold (default) | Effect |
|---|---|---|
| Unique agents | **&lt; 10,000** and waypoints **&lt; 1M** | → **micro** |
| Unique agents ≥ **1,000,000** *or* waypoints ≥ **10,000,000** | → **macro** (same mega-sim LOD thresholds as #18) |
| Otherwise | → **meso** |

Wire compat: `mega_sim=true` when scale is macro; config/wire aliases
`mega`→macro and `standard`→meso. `scale_source` is `auto` or `config`.

When scale is **macro**:

1. **Default UI:** arcs + pulse, trails off (Trajectories toggle / Trails preset — override sticks for the session).
2. **Query caps:** trajectory sample / bbox `limit` clamped to **500**; response may set `capped=true`.
3. **Fix-its / form_disable_reasons:** cite `python -m backend.ingest --aggregates-only` when `density_hourly` is missing; encourage mesh/link aggregates.
4. **Ingest:** prefer trips always; optional `--skip-waypoints`, `--max-waypoints-per-trip=N`, `--waypoint-sample-frac=FRAC`.

When scale is **micro**, UI keeps trails + agents; pulse disable copy is soft
(“optional”). Recipes: [evacuation micro](examples/sources-evacuation-micro.yaml),
[OD arcs macro](examples/sources-od-arcs.yaml).

See [DATA_FORMATS.md → Simulation scale](DATA_FORMATS.md#11-simulation-scale-micro--meso--macro).

## v0.2 changes vs v0.1

| | v0.1 | v0.2 |
|---|---|---|
| ABM sources | hardcoded truck + taxi | declarative `sources.yaml` |
| Schema migration | full re-ingest only | idempotent `ALTER TABLE ADD COLUMN IF NOT EXISTS` |
| DuckDB indexes | none (perf risk) | 12 |
| F1 trip metrics | none | speed_avg_kmh, dwell_minutes, detour_ratio |
| F2 trip-chain | length, dwell, round-trip, commodity | **+ through-zone-bbox, multi-stop, min_chain_length** |
| F3 trajectory detail | trip-level metadata | **+ per-segment link_id, speed_kmh, dwell_sec (opt-in)** |
| Frontend Sources filter | `'truck' \| 'taxi'` hardcoded | `string` source_id, populated from `/api/stats/filter-options` |
| Filter UI | basic | + "Advanced filters" disclosure (F1 sliders) |
| Map overlays | 9 layers | core trails/OD/heatmaps + F3 speed-gradient + dwell markers + POIs + zones + A/B grid-diff + agents + drill (~25 layers total) |
| Deployment | dev-only (two processes) | + Docker one-URL demo map (baked `demo.duckdb` + UI) |
| Defaults | PFLOW lab paths | demo/universal first; lab packs under `profiles/` |
| Tests | none | ~320 pytest + ~150 vitest |
| Citation | none | CITATION.cff |

## Code organization

```
trajectory-viz/
├── backend/
│   ├── app.py              FastAPI app + router registration
│   ├── config.py           demo-default paths; PFLOW_HOME only when opted in
│   ├── db.py               DuckDB schema + connection + build_trip_filter
│   ├── demo.py             trajectory-viz-demo: bundled demo ingest + serve
│   ├── formats.py          geojson/gpx/ndjson normalizers (staging shape)
│   ├── ingest.py           sources registry → staging → DuckDB INSERT...SELECT
│   ├── lod.py              micro/meso/macro scale + sample/ingest caps
│   ├── models.py           Pydantic request/response models
│   ├── sources_schema.py   Pydantic models + profile loader (demo|pflow|…)
│   ├── routers/            stats.py, trips.py, trajectories.py, pois.py
│   └── analysis/           temporal, spatial, trip_chains, od_flows, clustering
├── frontend/
│   ├── package.json        Vite + React + DeckGL + recharts + maplibre
│   ├── vite.config.ts      Dev proxy /api → :9999
│   └── src/
│       ├── api.ts                Client for all /api/* endpoints
│       ├── types.ts              TypeScript mirrors of Pydantic models
│       ├── lodPolicy.ts          Mega-sim auto arcs+pulse + override helpers
│       ├── layerCatalog.ts       Form taxonomy + capability gating
│       ├── hooks/                useTrajectories, useAnimation, useInsights
│       └── components/           MapView, FilterPanel, AnalysisPanel, TimeSlider
├── tests/
│   └── test_v0_2_parity.py F1/F2/F3 unit tests + cross-version DB parity
├── docs/
│   ├── QUICKSTART.md       Getting-started (Docker one-URL → native → lab)
│   ├── DATA_FORMATS.md     Universal ingest formats + YAML cookbook
│   ├── ARCHITECTURE.md     This file (vocabulary, budgets, scale LOD)
│   ├── CONTRIBUTING.md     Adding a source, style, tests, budgets
│   ├── EXPORT.md           Offline HTML export
│   └── examples/           MATSim, SUMO FCD, OD arcs, phone GPS, JoRAS v3, …
├── demo/                   Default universal dataset + sources.demo.yaml
├── profiles/               Opt-in lab packs (pflow, gufm, …) — see README
├── presets/                Export preset gallery (demo-paper / demo-deck / tokyo-night)
├── scripts/                docker-entrypoint, MATSim/SUMO adapters, vendor fetch
├── pyproject.toml          Project metadata + deps + entry points
├── Dockerfile              Multi-stage Docker build (bakes demo DB + UI)
├── docker-compose.yml      One-command first run → :8080
├── setup.sh / setup.bat    Native dev bootstrap (Mac/Windows)
├── CITATION.cff            Citation metadata
├── LICENSE                 MIT
└── README.md               Landing page
```
