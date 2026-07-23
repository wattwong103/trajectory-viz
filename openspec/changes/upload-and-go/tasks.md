# Tasks

## Phase 1 — backend upload service

- [x] 1. `backend/routers/ingest_api.py`: `POST /api/ingest/upload` — multipart,
      multi-file, extension whitelist + `.json` content-sniff (GeoJSON vs
      NDJSON), 200 MB/file cap enforced mid-stream (413), filename guard,
      staging to `<db dir>/uploads/`
- [x] 2. Background job orchestration (single-worker executor, inline mode for
      tests): waypoint ingest → epoch-anchor resolution → trip synthesis →
      derived metrics → density aggregate → uploads-registry write; idempotent
      re-upload replaces the source's waypoints
- [x] 3. `GET /api/ingest/jobs/{job_id}` (status/progress/result/error) +
      `GET /api/ingest/jobs` (last 20); 422 carries per-file human-friendly
      `reasons[]`
- [x] 4. `backend/config.py`: `uploads_dir()` + `uploads_registry_path()`
      resolution next to the DB (env override for the staging dir)

## Phase 2 — heuristics + auto source config

- [x] 5. `backend/upload_config.py` `sniff_columns`: CSV (encoding-aware) /
      NDJSON / Parquet sampling; lon/lat/time/id/name candidate matching;
      numeric + timestamp-kind validation (`iso` / `epoch_s` / `epoch_ms`)
- [x] 6. `generate_source_config`: slugified deduped source_id,
      `vehicle_key_template`, `gap_split` 30 min, deterministic palette color,
      Pydantic-validated `SourceConfig`; GeoJSON/GPX map canonical staging
      fields directly (no sniffing)
- [x] 7. Epoch anchor: fresh DB → midnight UTC of the data's first day
      (deferred until after waypoint ingest, pinned in `viz_meta`); non-fresh
      DB → existing anchor reused

## Phase 3 — registry merge

- [x] 8. `write_uploads_registry` / `load_uploads_registry_ids`: generated
      configs persist in `sources.uploads.yaml` next to the DB; the user's
      hand-written `sources.yaml` is never mutated
- [x] 9. Style/POI lookups merge the uploads registry at read time
      (`sources_schema.py`, `app.py`, `export.py`, `routers/pois.py`,
      `routers/stats.py`)

## Phase 4 — frontend

- [x] 10. `types.ts` + `api.ts`: upload/ingest contract types, `uploadFiles`
      (FormData, explicit 202/422/413), `fetchIngestJob`, `UploadRejectedError`
- [x] 11. `useUpload` hook: idle → uploading → processing → done/error state
      machine, job polling with cleanup, `notifyError`
- [x] 12. `UploadDropzone.tsx`: window-level drag overlay, ingest status card
      (determinate/indeterminate progress), success + error toasts
- [x] 13. FilterPanel ⬆ Upload button + hidden multi-file input; EmptyState
      drop affordance + click-to-browse feeding the shared uploader (drop
      handling stays global), docs link → `docs/DATA_FORMATS.md`
- [x] 14. `App.tsx`: on ingest completion refetch trajectories + filter options
      + stats — the new source appears (vehicle-type button, legend) with no
      reload; EmptyState swaps itself out

## Phase 5 — tests + docs

- [x] 15. Backend: `tests/test_upload.py` (endpoints, heuristics, registry,
      anchor, caps, idempotency) → **189 pytest green**
- [x] 16. Frontend: `useUpload` (7), `uploadUtils` (9), `EmptyState` (7,
      incl. drop-on-card → global dropzone) → **93 vitest green**;
      `npm run build` clean
- [x] 17. Docs: QUICKSTART "Drop a file" section, README endpoints line,
      DATA_FORMATS §7 upload heuristics
