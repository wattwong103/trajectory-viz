# Upload & Go (drag-and-drop ingest) — Proposal

## Why

Everything needed to visualize any trajectory file exists — but using it still
requires writing a `sources.yaml` block and running a CLI. Casual users should be
able to **drop a file onto the map** and see their data. This is the flagship
"easy to use" feature.

## What changes

1. **Backend upload service** — `POST /api/ingest/upload` (multipart, one or more
   files) saves to a staging dir, sniffs format, **auto-generates a source config**
   (column heuristics), and runs ingest as a **background job** into the current DB.
   `GET /api/ingest/jobs/{id}` reports status/progress/error. `GET /api/ingest/jobs`
   lists recent jobs.
2. **Column heuristics** — for CSV/NDJSON/Parquet: detect lon/lat/time/id columns by
   name (lon|lng|longitude|x …; time|timestamp|datetime|epoch …; vehicle|track|device|
   agent|id …). GeoJSON/GPX already normalize to `_lon/_lat/_time_ms/_trk_name`.
   Ambiguity → 422 with a helpful message (user can still use YAML for full control).
3. **Auto source config** — source_id slugified from filename; `vehicle_key_template`
   `{source_id}:{vehicle_id}`; `trips_synthesis: gap_split` default; epoch anchor =
   existing DB anchor, or midnight UTC of the data's first day for a fresh DB.
   Generated blocks are persisted in `sources.uploads.yaml` **next to the DB** (the
   user's hand-written registry is never mutated) and merged into style/POI lookups.
4. **Frontend drop zone** — drag file(s) anywhere over the map → overlay; upload with
   progress polling; success toast ("Added 'couriers.gpx': 412 trips, 2 vehicles")
   → app refetches stats/filter-options/trajectories so the new source just appears
   (vehicle-type button, legend, auto-fit). Discoverable "Upload data" button in the
   FilterPanel header. Friendly errors for unsupported formats / missing columns.

## Non-goals

Multi-file trip+waypoint pairing via UI, per-upload YAML editing UI, deleting
uploaded sources from the UI, auth/multi-user concerns (local tool), resumable
chunked uploads (files up to a sane cap, e.g. 200 MB).

## Impact

- New: `backend/routers/ingest_api.py`, `backend/upload_config.py` (heuristics +
  config generation), `tests/test_upload.py`; frontend `UploadDropzone.tsx`,
  `useUpload.ts`, api additions, FilterPanel button.
- Modified: `backend/app.py`, `backend/config.py` (uploads dir + uploads-registry
  path resolution), sources-style loading (merge uploads registry), `frontend/App.tsx`.
- No changes to the ingest pipeline itself — uploads reuse it verbatim.
