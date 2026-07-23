# Universal Trajectory Support — Proposal

## Why

trajectory-viz today ingests only PFLOW-style ABM outputs: trips + waypoint CSVs,
declared in `sources.yaml`. The tool should visualize **any** trajectory dataset —
GPX tracks, GeoJSON lines/points, NDJSON pings, Parquet extracts — plus static
**POI layers**, and it should be **usable in minutes** by someone with no PFLOW data.

## What changes

1. **Universal ingest formats** — `csv` (existing) + `geojson`, `gpx`, `ndjson`,
   `parquet`. Non-CSV formats are normalized in Python to a canonical staging shape,
   then flow through the existing column-map pipeline (same transforms, derived SQL,
   vehicle-key templates).
2. **Points-only sources** — raw timestamped pings without trip boundaries get trips
   **synthesized** at ingest (`gap_split` / `day` / `single` strategies), so every
   downstream endpoint keeps working unchanged.
3. **Absolute time** — per-DB epoch anchor stored in a new `viz_meta` table
   (replaces hardcoded `BASE_EPOCH_SEC` at read time; the constant remains the
   default seed). ISO-8601 / epoch-ms timestamps map into the existing
   `starttime` + `simulation_day` model. Mixed-anchor DBs are rejected without `--reset`.
4. **POI support** — new `pois` table, `pois:` block in `sources.yaml`,
   `/api/pois` + `/api/pois/categories` endpoints, deck.gl layer with
   category toggles in the frontend.
5. **Ease of use** — committed demo dataset (GPX + GeoJSON + POIs) +
   `trajectory-viz-demo` one-command ingest/serve; frontend empty-state guidance;
   docs rewrite leading with the 2-minute demo path.

## Non-goals (Phase 3+)

Polygons/zones layers, upload UI, streaming ingest, DuckDB `spatial` extension,
pyarrow fast paths, multi-day wall-clock playback, IconLayer POI sprites.

## Impact

- Modified: `backend/sources_schema.py`, `backend/ingest.py`, `backend/db.py`,
  `backend/models.py`, `backend/app.py`, `backend/routers/trajectories.py`,
  `frontend/src/{App,api,types}.tsx/ts`, `MapView.tsx`, `FilterPanel.tsx`,
  `pyproject.toml`, docs.
- New: `backend/formats.py`, `backend/routers/pois.py`, `backend/demo.py`,
  `demo/` dataset, `docs/DATA_FORMATS.md`, tests (`test_formats.py`,
  `test_ingest_universal.py`, `test_pois.py`, `test_demo.py`).
- **No breaking changes**: all schema/YAML additions are optional; existing
  `version: 1` sources.yaml files validate unchanged; no trips/waypoints DDL
  changes (additive tables only). Perf budgets unaffected (request path unchanged
  except new indexed, limit-capped `/api/pois`).
