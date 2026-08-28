# Data Formats — universal trajectory ingest

trajectory-viz ingests **any** timestamped trajectory dataset — not just PFLOW
ABM output. This document is the field-level reference for every supported
input format and the `sources.yaml` cookbook for wiring your own data.

Supported formats: **CSV**, **GeoJSON**, **GPX**, **NDJSON**, **Parquet** —
plus static **POI layers** (any of the same formats). Format is auto-detected
from the file extension (`.csv`, `.geojson`, `.gpx`, `.ndjson`/`.jsonl`,
`.parquet`/`.pq`) or declared explicitly via `discovery.format:` /
`trips_format:` / `trajectories_format:`. `.json` is deliberately ambiguous
(GeoJSON vs NDJSON) and always requires an explicit `format:`.

---

## 1. Canonical staging shape

Non-CSV formats (GeoJSON / GPX / NDJSON) are normalized in Python
(`backend/formats.py`) into flat row dicts, staged into a per-file TEMP DuckDB
table (`backend/ingest._stage_rows`), and then flow through the **same**
column-map pipeline as CSV — same `ColumnSpec` CASTs, transforms, derived SQL,
and vehicle-key templates. CSV and Parquet are read natively by DuckDB
(`read_csv` / `read_parquet`) with no staging step.

The canonical staging fields (the `_` prefix avoids collisions with source
property names):

| Field | Type | Meaning |
|---|---|---|
| `_lon`, `_lat` | DOUBLE | Point coordinates |
| `_time_ms` | BIGINT | Epoch milliseconds (UTC), or NULL when the source has no per-point time |
| `_seq` | BIGINT | Intra-feature coordinate index (GeoJSON) / cumulative index (GPX) / line number (NDJSON) |
| `_feature_id` | mixed | GeoJSON feature index / `"{trk}:{seg}"` (GPX) / NDJSON line number |
| `_trk_name` | VARCHAR | GPX `<trk><name>` (fallback `trk{idx}`); absent elsewhere |
| `_props_json` | VARCHAR | JSON object string of properties not consumed above |

First-level **scalar** source properties (str/int/float/bool) are also
flattened as plain staging fields and can be referenced directly in
`ColumnSpec.csv` (e.g. `{ csv: bus_id }`). Nested objects/arrays survive only
inside `_props_json`.

Reference these fields in your column mapping like any CSV column:

```yaml
columns:
  vehicle_id_col: _trk_name
  waypoints:
    unix_time_ms: { csv: _time_ms, type: bigint }
    lon:          { csv: _lon,     type: double }
    lat:          { csv: _lat,     type: double }
```

---

## 2. Timestamp rules

All ingest time handling funnels through `parse_time_to_ms`:

- **ISO-8601 strings**: aware timestamps (`...Z`, `...+09:00`) convert to UTC
  epoch ms. **Naive timestamps are assumed UTC** (GPX mandates `Z`; GeoJSON
  producers vary — declare offsets if you can).
- **Numbers**: epoch **seconds** when `< 1e11`, epoch **milliseconds**
  otherwise.
- GeoJSON LineStrings resolve per-point time in this order:
  `coord_times_prop[i]` → feature-level `time` property → NULL.
- GPX track-point `<time>` values honor their UTC offset, so files mixing
  `Z` and `+09:00` land in the same absolute buckets.
- Waypoint `unix_time_ms` may also be produced by **derived SQL** when the
  staged value is a string, e.g.
  `{ derived: 'CAST(epoch_ms(CAST("ts" AS TIMESTAMPTZ)) AS BIGINT)' }`
  (`TIMESTAMPTZ` honors ISO offsets).

## 3. Epoch anchor & `viz_meta`

The animation model is anchor-relative: absolute epoch ms map into the
existing `starttime` (seconds-from-anchor-midnight) + `simulation_day` model
via `(unix_time_ms // 1000 - epoch_anchor) % 86400`.

- Declare the anchor **once per database**: top-level `time.epoch_anchor` in
  `sources.yaml` (or on a single source). It must be a timezone-aware
  ISO-8601 string, e.g. `"2024-03-01T00:00:00+09:00"`. At most one distinct
  anchor per sources file — the validator rejects mixed anchors.
- On first ingest the anchor (epoch seconds) is persisted into the
  **`viz_meta`** table (`key='epoch_anchor'`). All read paths
  (`/api/trajectories/*`, density-hourly buckets, HTML export) go through
  `db.get_epoch_anchor()`. DBs without `viz_meta` fall back to the historical
  PFLOW default `BASE_EPOCH_SEC = 1601478000` (2020-10-01 JST).
- A later ingest with a **different** anchor into the same DB is a hard error
  — re-run with `--reset` to rebuild.
- Derived SQL may use the `{epoch_anchor}` placeholder, substituted with the
  resolved DB anchor at ingest.

## 4. Trip synthesis (points-only sources)

Raw timestamped pings have no trip boundaries. Omit `discovery.trips_glob`
and trips are **synthesized at ingest** from the waypoints
(`trips_synthesis` block):

| Strategy | Boundary rule |
|---|---|
| `gap_split` (default) | New trip when consecutive pings of one vehicle are more than `gap_minutes` apart |
| `day` | New trip on every anchor-relative simulation-day boundary |
| `single` | Every vehicle gets exactly one trip |

Synthesized trips get 1-based ordinals as `trip_id` (backfilled onto their
waypoints, so the `(vehicle_key, trip_id)` join identity holds), anchor-math
`starttime`/`simulation_day`, endpoints from first/last ping, and
`distance_km` from summed segment lengths. `trips_synthesis` and
`discovery.trips_glob` are mutually exclusive.

## 5. String-ID hash fallback

`vehicle_id` / `trip_id` are integer columns (PFLOW legacy). For universal
sources with string IDs (GPX track names, NDJSON string ids), ingest applies
`TRY_CAST` first and falls back to a **deterministic positive hash** of the
string. `vehicle_key` remains the authoritative cross-source identity — the
integer columns are display/legacy only. Numeric strings cast exactly as
before.

---

## 6. YAML cookbook

Every recipe below is a complete, valid `version: 1` block. Globs resolve
relative to `PFLOW_VIZ_OUTPUT_ROOT`. Validate with:

```bash
python -m backend.sources_schema --validate sources.yaml
```

### 6.1 CSV trips + waypoints (classic PFLOW-style)

```yaml
version: 1
sources:
  trucks:
    label: "Trucks"
    source_id: truck
    discovery:
      trips_glob: "trips/*.csv"
      trajectories_glob: "trajectory/**/waypoints.csv"
      latest_only: false
    vehicle_key_template: "truck:{vehicle_id}"
    columns:
      trip_id_col: id
      vehicle_id_col: truck_id
      trips:
        starttime:      { csv: starttime,   type: int }
        start_lon:      { csv: start_lon,   type: double }
        start_lat:      { csv: start_lat,   type: double }
        end_lon:        { csv: end_lon,     type: double }
        end_lat:        { csv: end_lat,     type: double }
        distance_km:    { csv: distance_km, type: double }
        dep_hour:       { derived: "CAST(starttime / 3600 AS INTEGER)" }
        simulation_day: { csv: sim_day,     type: int }
      waypoints:
        unix_time_ms:   { csv: unix_time_ms, type: bigint }
        lon:            { csv: lon,          type: double }
        lat:            { csv: lat,          type: double }
```

### 6.2 GPX tracks (points-only → synthesized trips)

```yaml
sources:
  couriers:
    label: "Bike Couriers (GPX)"
    source_id: courier
    discovery:
      trajectories_glob: "gps/couriers/*.gpx"
      latest_only: false
    vehicle_key_template: "courier:{vehicle_id}"
    trips_synthesis: { strategy: gap_split, gap_minutes: 20 }
    columns:
      vehicle_id_col: _trk_name      # <trk><name>; string ids hash-fallback
      waypoints:
        unix_time_ms: { csv: _time_ms, type: bigint }
        lon:          { csv: _lon,     type: double }
        lat:          { csv: _lat,     type: double }
```

### 6.3 GeoJSON LineStrings with per-coordinate times

```yaml
sources:
  buses:
    label: "City Buses"
    source_id: bus
    discovery:
      trajectories_glob: "transit/buses.geojson"
      latest_only: false
    vehicle_key_template: "bus:{vehicle_id}"
    trips_synthesis: { strategy: gap_split, gap_minutes: 20 }
    time:
      coord_times_prop: coordTimes   # per-coord ISO/epoch array property
    columns:
      vehicle_id_col: bus_id         # flattened scalar property
      waypoints:
        unix_time_ms: { csv: _time_ms, type: bigint }
        lon:          { csv: _lon,     type: double }
        lat:          { csv: _lat,     type: double }
```

GeoJSON **Point** features also work as trajectories sources (one waypoint per
feature; time from the feature's `time` property).

### 6.4 NDJSON pings (producer-defined field names)

```yaml
sources:
  fleet:
    label: "Fleet Pings"
    source_id: fleet
    discovery:
      trajectories_glob: "pings/*.ndjson"
      latest_only: false
    vehicle_key_template: "fleet:{vehicle_id}"
    trips_synthesis: { strategy: gap_split, gap_minutes: 30 }
    columns:
      vehicle_id_col: vehicle
      waypoints:
        # ISO strings → epoch ms via derived SQL (TIMESTAMPTZ honors offsets)
        unix_time_ms: { derived: 'CAST(epoch_ms(CAST("ts" AS TIMESTAMPTZ)) AS BIGINT)' }
        lon:          { csv: lon, type: double }
        lat:          { csv: lat, type: double }
```

### 6.5 Parquet (native DuckDB read — same mapping as CSV)

```yaml
sources:
  trucks:
    label: "Trucks (Parquet)"
    source_id: truck
    discovery:
      trips_glob: "trips/*.parquet"   # format auto-detected from extension
      latest_only: false
    vehicle_key_template: "truck:{vehicle_id}"
    columns:
      trip_id_col: id
      vehicle_id_col: truck_id
      trips:
        starttime:      { csv: starttime, type: int }
        start_lon:      { csv: start_lon, type: double }
        start_lat:      { csv: start_lat, type: double }
        end_lon:        { csv: end_lon,   type: double }
        end_lat:        { csv: end_lat,   type: double }
```

### 6.6 Static POI layer

```yaml
pois:
  places:
    label: "Places"
    glob: "pois/*.geojson"
    color: [120, 220, 140]
    columns:
      name:     { csv: name,     type: varchar }   # optional
      category: { csv: category, type: varchar }   # optional; drives /api/pois/categories
      lon:      { csv: _lon,     type: double }    # required
      lat:      { csv: _lat,     type: double }    # required
```

POI layers ingest into the `pois` table under the block key (`source_key`),
are re-ingested idempotently per layer, and are served via `/api/pois` +
`/api/pois/categories`. Remaining source properties ride along in
`props_json` and surface in the `props` field of `/api/pois`.

### 6.7 Zone / polygon layer

```yaml
zones:
  wards:
    label: "Service Wards"
    glob: "zones/*.geojson"          # GeoJSON Polygon / MultiPolygon
    color: [120, 200, 160]           # optional render hint
    columns:
      name:     { csv: name,     type: varchar }   # optional
      category: { csv: category, type: varchar }   # optional
```

Zones ingest into the `zones` table (bbox precomputed per feature), render
as translucent map fills via the Layers panel's **Zones** toggle, and serve
`/api/zones` + `/api/zones/contains?lon=&lat=` point lookups. With
`PFLOW_VIZ_SPATIAL=1`, contains uses exact ST_Within (holes honored);
without it, a bbox approximation. See Known limits.

### 6.8 Absolute time (top-level anchor)

```yaml
time:
  epoch_anchor: "2024-03-01T00:00:00+09:00"   # one anchor per database
```

---

## 7. Upload path — column heuristics (no YAML needed)

> **This section applies ONLY to the upload-and-go path** (`POST /api/ingest/upload`
> — drag-and-drop, the ⬆ Upload button, the empty-state drop area). It describes
> how the backend *guesses* a source config when you don't write one. An explicit
> `sources.yaml` mapping (section 6) always gives full control and is unaffected
> by these heuristics.

GeoJSON and GPX uploads need no guessing — they normalize to the canonical
staging fields of section 1 (`_lon`/`_lat`/`_time_ms`/`_trk_name`/`_feature_id`).
For **CSV, NDJSON, and Parquet** uploads, the first ~100 rows are sampled and
columns are matched **case-insensitively** against these candidates (first match
wins; the file's original casing is used downstream):

| Role | Candidate names |
|---|---|
| Longitude | `lon`, `lng`, `longitude`, `x`, `gps_lon` |
| Latitude | `lat`, `latitude`, `y`, `gps_lat` |
| Timestamp | `timestamp`, `time`, `ts`, `datetime`, `epoch`, `created_at` |
| Vehicle/device id | `vehicle_id`, `device_id`, `track_id`, `agent_id`, `objectid`, `id`, `mmsi`, `trip_id`, `entity_id`, `vehicle` |
| Name (optional) | `vehicle_name`, `name`, `label` |

Matches are validated against the sampled values:

- **lon/lat** must look numeric (≥ half the samples parse as floats), else the
  match is dropped.
- **Timestamp kind** is inferred from samples: all ISO-8601 date strings →
  `iso` (parsed as TIMESTAMPTZ); all-numeric within the 2000–2100 epoch range →
  `epoch_s` or `epoch_ms` by magnitude. Anything else → the column is rejected.

If lon/lat, time, or id can't be identified, the upload fails with **422 and a
per-file list of reasons** naming exactly the candidates that were tried — fix
by renaming the columns, or by writing an explicit YAML block (section 6).

Generated defaults for accepted uploads: `source_id` slugified from the filename
stem, `vehicle_key_template` `{source_id}:{vehicle_id}`, `gap_split` trip
synthesis at 30 minutes, a deterministic palette color, and the epoch anchor of
section 3 (existing DB anchor; midnight UTC of the data's first day on a fresh
DB). The generated config is persisted in `sources.uploads.yaml` **next to the
DB** — your hand-written `sources.yaml` is never modified.

---

## Known limits (Phase 3+)

- Geometry types beyond Point/LineString are rejected for trajectory sources.
  Polygon layers have a dedicated path: declare them under `zones:` (GeoJSON
  Polygon/MultiPolygon, same `columns:` mapping style as POIs) and they ingest
  into the `zones` table, render as translucent map fills, and answer
  `/api/zones/contains` point lookups. Set `PFLOW_VIZ_SPATIAL=1` to make that
  lookup exact (duckdb `spatial` extension, ST_Within with hole support)
  instead of the default bbox approximation.
- GeoJSON FeatureCollections stream feature-by-feature when the optional
  `ijson` package is installed (`pip install "trajectory-viz[speed]"`), giving
  one-feature peak memory regardless of file size. Without it, ingest falls
  back to whole-file `json.load` — same rows, higher peak memory. GPX
  (`iterparse`) and NDJSON (line-by-line) always stream.
- `.json` files always need an explicit `format:` declaration (the upload path
  content-sniffs them instead — section 7).
