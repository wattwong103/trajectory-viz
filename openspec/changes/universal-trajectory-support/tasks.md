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

- Polygons/zones, upload UI, streaming, pyarrow fast paths, spatial extension
  opt-in, multi-day playback, POI sprites
