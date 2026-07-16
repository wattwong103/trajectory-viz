# Changelog

All notable changes to **trajectory-viz** are documented in this file. Format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Phase 3 — Transport mode as a first-class dimension** (+ footfall, buildings UX, scenario). Grew out of the Kichijōji pedestrian-superblock analysis, which had to fake a mode filter by materializing per-mode sources (`kjwalk`/`kjcar`); those collapse back to filter states now.
  - **Phase 0 — shared `TripFilters` dependency** (`backend/filters.py`). The (vehicle_type, city, simulation_day, goods_type, hours, F1) parameter set was re-declared across 7 router files; now one Pydantic model + FastAPI dependency, zero behavior change (OpenAPI-diff verified). New shared dimensions are added in exactly one place.
  - **Transport-mode filter/color/legend.** `transport_modes` (comma-separated trip-mode ids) accepted by every endpoint; `trips.transport_mode` indexed (no re-ingest); trajectory metadata + trip rows surface the trip's mode; `/filter-options` lists modes with counts; `/insights` adds `by_transport_mode`. Frontend: multi-select mode chips, Source/Mode color-by toggle (`transportModes.ts` palette), mode in tooltips, transport-mode legend key, hash keys `tm`/`cb`. **Correctness invariant:** filter/color exclusively from the TRIP's mode via `(vehicle_key, trip_id)` scoping (`build_trip_pair_subquery`) — router-generated waypoint modes are uniform per source, and the per-vehicle subquery over-selects.
  - **Per-source legend toggles.** Legend rows click to hide/show a population (data-level filtering; hash key `hs=`). Stats-panel per-source colors now come from source styles instead of hardcoded truck/taxi hex.
  - **Pedestrian footfall layer.** `useFootfall` + `footfall-heatmap` (green "ground glow" ramp): walk-trip waypoint density at ~200 m grid; degrades to walk-trip OD density with an honest notice when a dataset has no walk waypoints. `waypoint-density`/`link-density` switch to trip-granular scoping when modes are set.
  - **Buildings by viewport + height exaggeration.** `pickBuildingSource` resolves the building set from the viewport center (smallest containing bbox wins — panning into Kichijōji auto-loads the baked set; city dropdown demoted to fallback); decoded PBLD sets cached per URL; `Height ×N` slider (0.5–5).
  - **Composite PNG export.** `utils/exportPng.ts` composites MapLibre basemap + deck layers (explicit stacking order — DOM order has deck first) with `preserveDrawingBuffer` on MapLibre; replaces the first-canvas-only screenshot that lost every deck layer.
  - **Before/after pedestrianization scenario.** `scenario=pedestrianize` + `sc_w/s/e/n` bbox on `TripFilters` (and trajectory queries) excludes car trips whose trajectories enter the zone — query-time, no schema change, every endpoint reflects it. `GET /api/stats/scenario-impact` reports −trips/−VKT; `/insights` materializes the excluded pair set per request to hold the 200 ms budget. UI: Zone tab "Pedestrianize this zone" button, red map bbox, live impact badge, hash key `sc=`.
  - **Fix:** `through-zone-bbox` joined waypoints on `(vehicle_id, trip_id)`, which collides across source_ids — now `(vehicle_key, trip_id)` (verified equal to a ground-truth join on the Kichijōji DB).
  - **Tests:** 36 vitest (hash round-trips for `tm/cb/hs/sc` + garbage rejection); backend suite at 95.

- **Phase 2 — Cinematic expansion** (branch `phase-2-cinematic`). Four independently-shippable slices taking aesthetic cues from the "night grid" style: agent playback, multi-population rendering, an animated pulse heatmap, 3D buildings, and a self-contained HTML export.
  - **2A — Multi-population rendering + agent playback.**
    - `GET /api/trajectories/by-vehicle` returns the full-day trip chain for 1–20 `vehicle_key`s (parameterized SQL; 422 on malformed input). `GET /api/trips/vehicles` powers an agent search box (parameterized prefix `LIKE` with wildcard escaping).
    - `sources.yaml` gains an optional `render:` block (`mode: trails|points|arcs` + `color`) via new `RenderConfig`. `/api/stats/filter-options` exposes a `sources[]` list of rendering hints; the `pflow-person-shopping` source is committed.
    - Frontend: **Agents tab** (⚑) with debounced search + follow/unfollow chips (max 8); `agent-trails` + moving `agent-markers` layers; background trails dim while following. Person sources render as **moving dots**; trip-only sources as **±30 min time-windowed arcs** (`DataFilterExtension`). `SourceLegend` (bottom-left). Selection persists in the URL hash (`ag=`). `utils/interpolate.ts` (`positionAtTime`, `hourPhase`).
  - **2B — Animated pulse heatmap.** `density_hourly` aggregate (built at ingest or via `python -m backend.ingest --aggregates-only`) drives `GET /api/analysis/spatial/density-hourly` (24 hour buckets in one response, **409** with the fix command when unbuilt). Frontend crossfades two `HeatmapLayer`s by opacity uniform — density breathes with the clock, in sync with the trails (shared `BASE_EPOCH_SEC` in `backend/config.py`).
  - **2C — 3D buildings night scene.** `MVTLayer` streams PLATEAU Tokyo-23ku building tiles (extruded, height-ramp colored, CC-BY-4.0 attribution); `scripts/build_buildings.py` bakes a compact `PBLD` binary (`backend/buildings_io.py`) for other cities from PLATEAU GeoJSON or synthesized `city_tatemono.csv` squares, served by `GET /api/buildings/{city}`. Buildings memoized separately from the per-frame layers; `LightingEffect` + trails glowing through via `depthCompare:'always'`.
  - **2D — Single-HTML cinematic export.** `viz-export` (entry point `backend.export`) packs a filtered trajectory sample + pulse + buildings + agents with an inlined deck.gl bundle into one offline HTML (dark ground quad, no basemap, zero runtime network). Int16 delta-encoded + base64 payload; 4 MB warn / 8 MB fail size gate. `scripts/fetch_vendor.py` pins the deck.gl bundle by SHA-256; `presets/tokyo-night.yaml`; `docs/EXPORT.md`. Shared trajectory SQL extracted to `backend/trajectory_queries.py`.
  - **Tests**: +45 across `test_endpoints.py`, `test_sources_schema.py`, `test_buildings.py`, `test_export.py` (95 backend total); +11 vitest (`interpolate.test.ts`, agent-hash cases; 25 total). New dep `@deck.gl/extensions@~9.2.0`.
- **Sprint A (Tier 1 punch-list)** — closes the v0.2 advertised-but-unreachable-features gap.
  - F2/F3 UI hookup for the four endpoints landed in Phase 2:
    - 📍 **Trajectory Details** tab: click any trajectory on the map → side panel with speed histogram, dwell stats, longest-stop indicator, and top-5 link usage. Uses `segments[]` already attached when `include_segments=true` (default in `useTrajectories`).
    - ▭ **Zone** tab: W/S/E/N bbox form drives `/api/analysis/trip-chains/through-zone-bbox`; bbox renders as a translucent yellow `PolygonLayer`; results list shows up to 500 matching trips.
    - ⛓ **Chains tab → Multi-stop sub-section**: `min_stops` slider + collapsible per-vehicle cards showing the ordered trip sequence (`#seq`, time, distance, goods_type).
    - ◎ **Clusters tab → algorithm toggle**: "OD + distance" (existing) vs "Route similarity (F3)" (new — Jaccard distance on link-id sets via DBSCAN); per-algorithm sliders.
  - **Endpoint integration tests** (`tests/test_endpoints.py`): 25 tests covering 20+ endpoints via FastAPI's `TestClient` against a monkey-patched in-memory DuckDB singleton. Total runtime 1.32s.
  - **Real-data smoke runbook** (`docs/REAL_DATA_SMOKE.md`): executable curl-based verification recipes + failure-mode catalog for the user-driven step pytest can't cover (full ingest at PFLOW scale).
- **Sprint B (Tier 2 polish)** — first-time-user / public-release polish.
  - `docs/env.example` documenting every `PFLOW_*` and `TRAJECTORY_VIZ_*` env variable, with one-line citations to where each is consumed in the code.
  - `setup.sh` and `setup.bat` now auto-create `./data/` (the docker-compose mount target) so first-time `docker compose up` doesn't fail on a missing host directory.
  - `CHANGELOG.md` (this file).

### Changed

- **`setup.sh` Python detection** now probes `python3.11 → python3.12 → python3.13 → python3 → python` and rejects any binary reporting `<3.11`. Fixes failure on macOS where Python 3.11 isn't directly on PATH but `python3` is.
- **F1 URL hash encoding**: `encodeHash`/`decodeHash` in `App.tsx` now persist all five F1 derived-metric filters (`minSpeed`, `maxSpeed`, `maxDwellMinutes`, `minDetourRatio`, `maxDetourRatio`). Shareable URLs now preserve Advanced Filter state. 5 new vitest cases cover round-trip + garbage-value handling.
- **README acknowledgements URL** corrected to point at the live [`sekilab/OpenPFLOW`](https://github.com/sekilab/OpenPFLOW) repo (formerly an org-root link that 404'd).

### Fixed

- (no defect fixes in this slice — all changes are additive)

---

## [0.2.0a1] — 2026-05-16

Baseline v0.2 alpha. Massive refactor from the v0.1 hardcoded truck+taxi dashboard to a generic, declarative-schema ABM visualization tool.

### Added

- **Declarative `sources.yaml`** schema (Pydantic-validated via `backend/sources_schema.py`). Adding a new ABM = writing a YAML block, not editing code. Worked example: [`docs/examples/sources-matsim.yaml`](docs/examples/sources-matsim.yaml) validates against the live schema, proving the design is generic.
- **F1 derived metrics at ingest** (`backend/ingest.py:compute_derived_metrics`):
  - `speed_avg_kmh` — `distance_km / (max(unix_time_ms) - min(unix_time_ms))/1000/3600` from waypoints
  - `dwell_minutes` — `LEAD(starttime) - starttime` partitioned by `(vehicle_key, simulation_day)`
  - `detour_ratio` — `distance_km / haversine(start, end)`, NULL when haversine < 100m (GPS-noise guard, configurable via `DETOUR_MIN_HAVERSINE_KM`)
- **F1 filter UI**: extended `TripQuery` + `build_trip_filter` with `min_speed`/`max_speed`/`max_dwell_minutes`/`min_detour_ratio`/`max_detour_ratio`. FilterPanel "Advanced filters" disclosure with 3 sliders. AnalysisPanel "ƒ" Metrics tab with 3 Recharts histograms backed by new `/api/analysis/temporal/metrics-distribution` endpoint.
- **F2 trip-chain queries**:
  - `/api/analysis/trip-chains/through-zone-bbox` — finds trips whose trajectories pass through an axis-aligned bbox (composite-IN subquery against waypoints).
  - `/api/analysis/trip-chains/multi-stop` — vehicles with ≥`min_stops` trips, each with its full ordered trip list.
  - `min_chain_length` parameter extension on `/length-distribution` to focus the histogram on multi-stop tail.
- **F3 per-segment trajectory attributes**: `TrajectorySegment` model (`link_id`, `speed_kmh`, `dwell_sec`); `_compute_segments` helper. Opt-in via `include_segments=true` on the 3 trajectory endpoints. `useTrajectories` sets it to `true` by default.
- **F3 route-similarity clustering**: `/api/analysis/clustering/route-similarity` — Jaccard distance on link-id sets, DBSCAN with `metric='precomputed'`. Capped at `sample_size=2000` (O(N²) pairwise).
- **F3 frontend overlays**: speed-gradient `PathLayer` (red→orange→yellow→green→blue by km/h) and dwell-markers `ScatterplotLayer` (log-scaled radius). Two new layer toggles, default off.
- **12 DuckDB indexes** on hot filter columns (vehicle_type, vehicle_key, city+simulation_day, dep_hour, distance_km, link_id, (lon,lat), source_id, speed_avg_kmh, dwell_minutes, detour_ratio, run_id). Without these, scans on the 4.43M-trip / 233M-waypoint PFLOW dataset would blow the p99 budgets in `.claude/rules/trajectory-viz.md`.
- **Docker deployment**: multi-stage `Dockerfile` (node:20-alpine builds frontend, python:3.11-slim runtime); FastAPI's `StaticFiles` serves the built React app at `/`; single port 8080. `docker compose up --build` is one-command first-time setup.
- **GitHub Actions CI** (`.github/workflows/ci.yml`): 4 jobs — backend pytest + ruff (py3.11/3.12), frontend build, Docker image build + smoke, sources.yaml example validation.
- **Vitest scaffold** + 1 smoke test for URL filter encoding (round-trip + SQL-injection defense).
- **Docs**: `QUICKSTART.md`, `ARCHITECTURE.md` (with v0.1→v0.2 change table and code organization map), `CONTRIBUTING.md` (with add-a-new-source recipe).
- **CITATION.cff** for citable software metadata. GitHub auto-renders a "Cite this repository" button.

### Changed

- **Frontend vehicle types** populate dynamically from `/api/stats/filter-options` instead of being hardcoded as `'truck' | 'taxi'`. `FilterState.vehicleType` is now `string` (empty = all).
- **Validators across 11 backend files** relaxed from `^(truck|taxi)$` to `^[a-z][a-z0-9_]*$` so any v0.2 source_id is accepted.
- **`backend/ingest.py` rewritten** — unified `ingest_source_trips` + `ingest_source_trajectories` driven by `sources.yaml` column maps; one path replaces the two hardcoded `ingest_truck_trips` and `ingest_taxi_trips`.
- **`build_trip_filter` extended** with keyword-only `source_id`, F1 metric ranges, while keeping `vehicle_type` as a back-compat positional alias.
- **`stats.py` fare conditional** generalized: was `if vehicle_type != 'truck'`, now `WHERE fare_yen IS NOT NULL` — source-agnostic, works for any future source declaring fare_yen.

### Fixed

- **Idempotent schema migration**: pre-v0.2 DuckDB files get `source_id` and F1 derived columns added via `ALTER TABLE ADD COLUMN IF NOT EXISTS` on first connection. No `--reset` required to upgrade an existing 8 GB DB.
- **Boolean transform robustness**: DuckDB's `read_csv(auto_detect=true)` infers `'true'`/`'false'` as BOOLEAN; the v0.2 transform `lower(CAST(value AS VARCHAR)) = 'true'` handles both varchar and BOOLEAN auto-detect outcomes.
- **Waypoint trip_id mapping**: waypoint CSVs carry `trip_id` directly (not via `trip_id_col` which is the trip CSV's `id` column). `_select_clause` now detects waypoint context and uses the literal column.

---

## [0.1.0] — 2026-04-25

Initial extraction from the PFLOW workspace into a standalone repo. Documented in `report/2026-W17.md`.

### Added

- FastAPI + DuckDB backend with hardcoded truck + taxi ingest paths.
- React + DeckGL + MapLibre frontend with 9 layers (trails, OD arcs, heatmap, link density, cluster arcs, drill).
- Manual `setup.sh` / `setup.bat` for dev bootstrap. `output/viz/pflow.duckdb` lives outside the repo (~8.4 GB).
- Standalone-mode support via `PFLOW_VIZ_DB` env var.

---

[Unreleased]: https://github.com/wattwong103/trajectory-viz/compare/v0.2.0a1...HEAD
[0.2.0a1]: https://github.com/wattwong103/trajectory-viz/releases/tag/v0.2.0a1
[0.1.0]: https://github.com/wattwong103/trajectory-viz/releases/tag/v0.1.0
