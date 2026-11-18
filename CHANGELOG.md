# Changelog

All notable changes to **trajectory-viz** are documented in this file. Format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- **Export / share polish (TV-8).** `viz-export` respects Phase D `forms:` on presets (gates pulse / buildings / agents); size-gate failures list actionable shrink steps; `--engine minimal` exits with an honest “not implemented” message (default remains deck.gl). `scripts/fetch_vendor.py` ships a real pinned SHA-256 (one-command fetch). Docs: vendor-fetch prerequisite, preset gallery, shareable URL hash table. README / QUICKSTART / CONTRIBUTING / EXPORT aligned.

- **Docs/reality sync (TV-4).** README / QUICKSTART / ARCHITECTURE / DATA_FORMATS / CONTRIBUTING aligned with shipped main after #12–#20: accurate ~320 pytest + ~150 vitest counts; demo/universal + Docker one-URL as the default path (no PFLOW-first surprise); DuckDB documented as a module-level singleton with performance budgets living in ARCHITECTURE + CONTRIBUTING (no cite of absent `.claude/rules`); `modes=` preferred over int `transport_modes=`; `TRAJECTORY_VIZ_DB` / `TRAJECTORY_VIZ_OUTPUT_ROOT` as canonical env names; GUFM path points at `profiles/gufm/sources.yaml`; universal-forms vocabulary + profile links surfaced from README / DATA_FORMATS / CONTRIBUTING.

### Added

- **Export preset gallery.** `presets/demo-paper.yaml` (trails-only, demo DB, paper/deck) + `presets/demo-deck.yaml` (trails + agents + pulse) + `presets/README.md`. Lab cinematic remains `presets/tokyo-night.yaml`. Tests: forms gating + engine rejection + size-gate copy in `tests/test_export.py`.

- **Scale & correctness CI fixtures (TV-6).** Tiny dual-fleet CSV pack under `tests/fixtures/scale/` (colliding bare `vehicle_id`, micro + macro `sources.yaml`) plus `tests/test_scale_correctness.py` locking `capabilities.scale` defaults, `vehicle_key`/`agent_key` joins, `density_hourly`/pulse gating, documented LOD thresholds + sample clamp, and cheap pedestrianize scenario-impact. Dedicated GitHub Actions job **Scale & correctness fixtures** (no live PFLOW).

- **Simulation scale modes — micro / meso / macro (TV-16).** First-class `capabilities.scale` for any sim type (evacuation, events, local agents, city/region ABM), not only mid-scale PFLOW. Auto-detect from agent/waypoint estimates (micro &lt;10k agents &amp; &lt;1M waypoints; macro = existing mega thresholds ≥1M agents / ≥10M waypoints; else meso); optional top-level `sources.yaml` `scale:` override (`mega`→macro, `standard`→meso aliases). Macro keeps aggregate-first arcs+pulse + sample caps (`mega_sim` remains a boolean alias); micro defaults to trails+agents and never forces arcs+pulse. Form defaults / `form_disable_reasons` / fix-its per scale; FE Micro + Macro presets; recipes `docs/examples/sources-evacuation-micro.yaml` + `scale: macro` on OD arcs. Docs: ARCHITECTURE / DATA_FORMATS §11 / QUICKSTART. Tests: `tests/test_lod.py`, schema scale field, lodPolicy / layerCatalog.



- **Zero-friction first run (TV-3).** `docker compose up --build` → http://localhost:8080 with baked `demo/demo.duckdb` + React UI (no host DuckDB, no forgotten frontend build). Docker entrypoint (`scripts/docker-entrypoint.sh`) re-seeds when the DB path is missing/empty unless `TRAJECTORY_VIZ_SEED_DEMO=0`. `/api/stats.empty_hint` + EmptyState/FilterPanel copy for honest empty DBs; `trajectory-viz-demo` warns when `frontend/dist` is missing. Docs: README/QUICKSTART lead with the one-URL path; CI Docker smoke asserts demo `trips > 0` and HTML at `/`, plus an empty-DB `empty_hint` check. Tests: `tests/test_first_run.py`.

- **Universal forms Phase D — demo/universal as the default product profile.** Out-of-box discovery is `demo/sources.demo.yaml` → `demo/demo.duckdb` (no Dropbox / `PFLOW_HOME` surprise). PFLOW lab packs move to `profiles/pflow/` (goods, fare, person, Kichijōji) and GUFM to `profiles/gufm/`; opt in with `TRAJECTORY_VIZ_PROFILE=pflow` / `--profile pflow` / `PFLOW_HOME`. Env aliases: `TRAJECTORY_VIZ_SOURCES` + `TRAJECTORY_VIZ_OUTPUT_ROOT` beside the `PFLOW_VIZ_*` names. Demo registry gains trips-only OD CSV with string `mode` (arcs) alongside GPX/GeoJSON; optional `forms:` on sources + export presets (`presets/tokyo-night.yaml`). Docs: QUICKSTART/README/env.example/ARCHITECTURE/EXPORT + `profiles/README.md`. Tests: `tests/test_phase_d_defaults.py`. (TV-3 Docker one-URL bake and TV-8 full export polish left as hooks/notes.)

- **Mega-sim LOD (≫1M agents).** Scale estimates (`agent_count`, `waypoint_count`) on `/api/stats/filter-options` capabilities; `mega_sim` / `scale` + `fix_its` when over threshold (1M agents or 10M waypoints). UI auto-switches to **arcs + pulse** (hides trails) with session override via Trajectories toggle / Trails preset / Mega preset. Trajectory sample & bbox clamp to 500 when mega (`capped` on response). Ingest flags `--skip-waypoints`, `--max-waypoints-per-trip`, `--waypoint-sample-frac`. Docs: ARCHITECTURE mega-sim section + DATA_FORMATS §11.

- **Schema accommodation (survey P0/P1 + legs).** Shared PFLOW `mode_map` on person/taxi/GUFM/Kichijōji packs; example YAMLs for SUMO FCD, OD arcs, phone GPS, and canonical JoRAS truck/taxi v3.0 (MFS/THTA kept as legacy in `profiles/pflow/sources.yaml`). Thin adapters `scripts/matsim_events_to_csv.py` + `scripts/sumo_fcd_to_ndjson.py` with tiny fixtures (no new `FormatType`). Additive `leg_id` on trips/waypoints + API/capabilities (`has_legs`). DATA_FORMATS §8–10 document legs, external ABM recipes, and GeoParquet/MF-JSON flatten-first. Tests: `tests/test_schema_accommodation.py`.

- **Universal forms Phase C — schema v0.3 (string mode + agent_id).** `viz_meta.schema_version=0.3`. Additive columns `trips/waypoints.mode` (VARCHAR canonical labels) and `agent_id` (VARCHAR native id); `vehicle_id` int/hash fallback and `vehicle_type`↔`source_id` dual-write kept. Ingest derives `mode` from int `transport_mode` via `mode_map` / defaults; varchar `transport_mode` maps into `mode`. Filters accept canonical `modes=` labels (prefer over `transport_modes=` ints). `/api/stats/filter-options` modes prefer `trips.mode`; capabilities expose `schema_version` + `agent_id_column`. Env alias `TRAJECTORY_VIZ_DB` beside `PFLOW_VIZ_DB`. No JSON attrs migration (lab columns stay sparse). Docs: ARCHITECTURE/DATA_FORMATS/env.example + MATSim example `mode:` column. Frontend: `modeLabels` / hash `ml=` with light chip wiring.

- **Universal forms Phase B — capability-driven forms.** `LayerAvailabilityContext` seeds from Phase A `capabilities` (`has_trajectories`, `has_density_hourly`, `attr_keys`, `modes` labels). FilterPanel layers regrouped by form taxonomy (core / analysis / scene / lab plugins); footfall, goods filter, commodity patterns, and pedestrianize hide when attrs/modes are absent. Mode chips prefer string labels from `modes[]` (ints still on the wire for PFLOW). Pulse disable reasons use `has_density_hourly` + ingest fix-it (no silent empty / cryptic 409). Light frontend-only change — AnalysisPanel/MapView modularization deferred to TV-5.

- **Universal forms Phase A — contract & vocabulary.** Public language is `source_id` / **Sources** (not “vehicle type”); `agent_key` documents today’s `vehicle_key`; modes expose string **labels** via `/api/stats/filter-options` `modes[{id,label,count}]` (from `sources.yaml` `mode_map` or PFLOW defaults) plus dataset `capabilities`. Query param `source_id=` accepted everywhere `vehicle_type=` worked (alias kept). UI Sources rename; URL hash still uses `vt=` temporarily. Docs: ARCHITECTURE canonical vocabulary + DATA_FORMATS pointer. **Deprecation:** do not treat `vehicle_type` as a distinct concept from `source_id` (mirror column remains for compat; no schema drop in this phase). String `agent_id` widen deferred to Phase C / v0.3.

- **Phase 3 — Transport mode as a first-class dimension** (+ footfall, buildings UX, scenario). Grew out of the Kichijōji pedestrian-superblock analysis, which had to fake a mode filter by materializing per-mode sources (`kjwalk`/`kjcar`); those collapse back to filter states now.
  - **Phase 0 — shared `TripFilters` dependency** (`backend/filters.py`). The (vehicle_type, city, simulation_day, goods_type, hours, F1) parameter set was re-declared across 7 router files; now one Pydantic model + FastAPI dependency, zero behavior change (OpenAPI-diff verified). New shared dimensions are added in exactly one place.
  - **Transport-mode filter/color/legend.** `transport_modes` (comma-separated trip-mode ids) accepted by every endpoint; `trips.transport_mode` indexed (no re-ingest); trajectory metadata + trip rows surface the trip's mode; `/filter-options` lists modes with counts; `/insights` adds `by_transport_mode`. Frontend: multi-select mode chips, Source/Mode color-by toggle (`transportModes.ts` palette), mode in tooltips, transport-mode legend key, hash keys `tm`/`cb`. **Correctness invariant:** filter/color exclusively from the TRIP's mode via `(vehicle_key, trip_id)` scoping (`build_trip_pair_subquery`) — router-generated waypoint modes are uniform per source, and the per-vehicle subquery over-selects.
  - **Per-source legend toggles.** Legend rows click to hide/show a population (data-level filtering; hash key `hs=`). Stats-panel per-source colors now come from source styles instead of hardcoded truck/taxi hex.
  - **Pedestrian footfall layer.** `useFootfall` + `footfall-heatmap` (green "ground glow" ramp): walk-trip waypoint density at ~200 m grid; degrades to walk-trip OD density with an honest notice when a dataset has no walk waypoints. `waypoint-density`/`link-density` switch to trip-granular scoping when modes are set.
  - **Buildings by viewport + height exaggeration.** `pickBuildingSource` resolves the building set from the viewport center (smallest containing bbox wins — panning into Kichijōji auto-loads the baked set; city dropdown demoted to fallback); decoded PBLD sets cached per URL; `Height ×N` slider (0.5–5).
  - **Composite PNG export.** `utils/exportPng.ts` composites MapLibre basemap + deck layers (explicit stacking order — DOM order has deck first) with `preserveDrawingBuffer` on MapLibre; replaces the first-canvas-only screenshot that lost every deck layer.
  - **Before/after pedestrianization scenario.** `scenario=pedestrianize` + `sc_w/s/e/n` bbox on `TripFilters` (and trajectory queries) excludes car trips whose trajectories enter the zone — query-time, no schema change, every endpoint reflects it. `GET /api/stats/scenario-impact` reports −trips/−VKT; `/insights` materializes the excluded pair set per request to hold the 200 ms budget. UI: Zone tab "Pedestrianize this zone" button, red map bbox, live impact badge, hash key `sc=`.
  - **Fix:** `through-zone-bbox` joined waypoints on `(vehicle_id, trip_id)`, which collides across source_ids — now `(vehicle_key, trip_id)` (verified equal to a ground-truth join on the Kichijōji DB).
  - **Fix — buildings looked "random" at Kichijōji:** two causes. (1) `city_tatemono.csv` rows around the station are *dissolved blocks* (merged wall-to-wall shōtengai polygons up to 43,000 m² per row), which the tatemono synthesis turned into overlapping ~200 m squares — and the log₂ height rule made the biggest areas the *tallest* (60 m) monolith slabs. Rows > 3,000 m² now split into gapped low-rise grids (8–16 m). (2) Replaced the synthesized kichijoji set entirely with **real PLATEAU footprints**: new `scripts/citygml_to_geojson.py` extracts lod0RoofEdge + measuredHeight from PLATEAU CityGML (EPSG:6697); baked from the 13203 Musashino 2023 dataset → 27,029 real buildings, `synthesized: false`.
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

- **Upload-and-go** — drag-and-drop trajectory ingestion. `POST /api/ingest/upload` (multipart, ≤ 200 MB/file) with extension whitelist + `.json` content-sniffing; background single-worker job orchestration (waypoint ingest → epoch anchor → trip synthesis → derived metrics → density aggregate) with `GET /api/ingest/jobs[/{id}]` progress polling; heuristic column sniffing (CSV/NDJSON/Parquet) generating validated `SourceConfig`s persisted to `sources.uploads.yaml` (hand-written `sources.yaml` never mutated). Frontend: window-level drop overlay, `useUpload` state machine, ingest-status toasts, auto-refetch on completion. Tests: 189 pytest + 93 vitest at ship time.

- **Universal trajectory support** — any trajectory dataset, not just PFLOW ABMs. Declarative `sources.yaml` with five formats (CSV, GeoJSON, GPX, NDJSON, Parquet) + static POI layers; `FormatType` detection, points-only trip synthesis (`gap_split`/`day`/`single`), per-DB epoch anchor in `viz_meta`. Frontend POI layer (chips, `pc=` hash, tooltips), committed Kichijōji demo dataset (`trajectory-viz-demo --serve`), EmptyState. Follow-ups: GeoJSON FeatureCollections stream via optional `ijson` (`pip install ".[speed]"`); pyarrow fast paths resolved obsolete (DuckDB reads csv/parquet natively); **zones/polygon layers** (`zones:` block → `zones` table → `/api/zones` + `/api/zones/contains`, exact `ST_Within` under `PFLOW_VIZ_SPATIAL=1` with bbox fallback, translucent map fills); POI category-glyph sprite atlas with dot fallback.

- **Fleet comparison (⇄ tab)** — A/B fleet reports under symmetric shared filters: summaries with B−A chips, mode-share divergences, hourly overlays, shared-edge distance histogram, matched-person analysis (union join, Follow-pair). Later additions: F1-range pass-through, auto-insight header line, two-proportion z + Wilcoxon significance, 2–4 fleet rollup (`/api/analysis/compare-multi`, chip picker), rank-paired per-trip alignment scoring, map-canvas grid-diff overlay (`/api/analysis/compare/grid`, "⬚ Diff on map" toggle).
- **Stationary agent follow** — `GET /api/trajectories/by-vehicle?include_stationary=true` synthesizes 60-second stationary trajectories for waypoint-less trips (e.g. GUFM zero-distance hops) so followed agents always render; midnight-seam clamped. Followed-agent fetches opt in; sampling/export keep the waypoints-only contract.

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
- **12 DuckDB indexes** on hot filter columns (vehicle_type, vehicle_key, city+simulation_day, dep_hour, distance_km, link_id, (lon,lat), source_id, speed_avg_kmh, dwell_minutes, detour_ratio, run_id). Without these, scans on the 4.43M-trip / 233M-waypoint PFLOW dataset would blow the p99 budgets documented in `docs/ARCHITECTURE.md` (stats < 200ms / trips < 1s / trajectories < 500ms).
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
