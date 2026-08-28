# Tasks

## Phase 1 — backend

- [x] 1. `db.py`: `pois` + `viz_meta` tables, indexes, `get_epoch_anchor()`, reset drops
- [x] 2. `sources_schema.py`: FormatType, optional trips_glob, TripsSynthesisConfig,
      TimeConfig, PoiConfig, validators, dryrun/example updates
- [x] 3. `formats.py`: detect_format + geojson/gpx/ndjson normalizers + fixtures
- [x] 4. `ingest.py`: `_table_source` dispatch, `_stage_rows`, hash-fallback ids,
      `{epoch_anchor}` placeholder, `synthesize_trips`, `ingest_pois`, anchor
      persistence + mismatch error, summary logging
- [x] 5. `routers/pois.py` + `models.py` + `app.py` wiring
- [x] 6. Switch `BASE_EPOCH_SEC` read sites to `get_epoch_anchor()`
- [x] 7. Tests: test_formats, test_ingest_universal, test_pois, sources_schema
      additions, endpoint anchor assertion → `pytest` + `ruff check` green

## Phase 2 — frontend + demo + docs

- [x] 8. Frontend POI layer (api, hook, MapView layer, chips, `pc=` hash, tooltip)
- [x] 9. Demo dataset + `backend/demo.py` + `trajectory-viz-demo` script
- [x] 10. EmptyState component
- [x] 11. Docs: QUICKSTART, README matrix, DATA_FORMATS.md, ARCHITECTURE
- [x] 12. Tests: poiColors, pc= round-trip, test_demo → vitest + pytest green

## Phase 3+ (future changes)

- ~~Polygons/zones~~ — SHIPPED: `zones:` block in sources.yaml (GeoJSON
  Polygon/MultiPolygon), `zones` table + `/api/zones` + `/api/zones/contains`
  (ST_Under exact with PFLOW_VIZ_SPATIAL=1, bbox fallback), frontend
  PolygonLayer + Layers-panel toggle. See docs/DATA_FORMATS.md §6.7.
- ~~Upload UI~~ — shipped as the `upload-and-go` change.
- ~~Spatial extension opt-in~~ — SHIPPED: `PFLOW_VIZ_SPATIAL=1` loads duckdb
  `spatial` at schema init (`db.ensure_spatial`, per-connection LOAD, never
  raises); powers `/api/zones/contains` exact mode.
- ~~POI sprites~~ — SHIPPED: category→glyph mapping + runtime canvas sprite
  atlas (`frontend/src/poiSprites.ts`); MapView renders an IconLayer when the
  atlas builds, dot fallback in canvas-less environments.
- Multi-day playback — DEFERRED: touches the animation core
  (useAnimation/TimeSlider/day-offset interpolation) but no multi-day dataset
  exists to verify against (GUFM DB has simulation_days=[0] only). Revisit
  when a multi-day source is available.
- ~~Streaming parser~~ — SHIPPED: GeoJSON FeatureCollections stream via
  optional `ijson` (`pip install ".[speed]"`), one-feature peak memory;
  GPX/NDJSON already streamed; whole-doc fallback kept for bare Features.
- ~~Pyarrow fast paths~~ — RESOLVED OBSOLETE: csv/parquet ingest reads
  natively through DuckDB (`read_csv`/`read_parquet`, staged count 0), and
  the upload sniffer samples parquet the same way. There is no Python-side
  row loop for pyarrow to accelerate; adding it would be a dependency with
  no win.
- ~~Upload UI~~ — shipped as the `upload-and-go` change.
