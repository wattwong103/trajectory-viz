# Universal Trajectory Support — Design

## Guiding decisions

1. **Reuse the ColumnSpec machinery for all formats.** Non-CSV formats are parsed in
   Python into flat row dicts, staged into a TEMP DuckDB table, then run through the
   same `_select_clause` / `_column_expr` / `_vehicle_key_sql` pipeline as CSV. The
   `csv:` key in ColumnSpec is reinterpreted as "input field name" (renaming the YAML
   key was rejected — pure churn for existing files/fixtures).
2. **Always synthesize trips.** The trips table is load-bearing for every endpoint.
   A `trips: none` mode was rejected; points-only sources get trips synthesized from
   waypoints at ingest.
3. **Single epoch anchor per DB, stored in the DB.** `viz_meta['epoch_anchor']`
   replaces hardcoded `BASE_EPOCH_SEC` at read time; the config constant stays as the
   default seed. Mod-86400 animation model untouched.
4. **No new runtime dependencies.** GPX via `xml.etree.ElementTree.iterparse`;
   GeoJSON/NDJSON via stdlib `json`; Parquet via DuckDB built-in `read_parquet`.

## 1. `backend/sources_schema.py` — schema extensions (all optional; do NOT bump version)

```python
FormatType = Literal["csv", "geojson", "gpx", "ndjson", "parquet"]

class DiscoveryConfig(BaseModel):
    trips_glob: Optional[str] = None           # now optional (points-only sources)
    format: Optional[FormatType] = None        # auto-detect from extension if omitted
    trips_format: Optional[FormatType] = None  # per-side overrides
    trajectories_format: Optional[FormatType] = None

class TripsSynthesisConfig(BaseModel):  # extra="forbid"
    strategy: Literal["gap_split", "day", "single"] = "gap_split"
    gap_minutes: float = Field(default=30.0, gt=0, le=1440)

class TimeConfig(BaseModel):  # extra="forbid"
    epoch_anchor: Optional[str] = None        # ISO-8601, must be timezone-aware
    coord_times_prop: Optional[str] = None    # GeoJSON LineString per-coordinate time array prop

class SourceConfig(BaseModel):
    trips_synthesis: Optional[TripsSynthesisConfig] = None
    time: Optional[TimeConfig] = None

class PoiColumnsConfig(BaseModel):  # extra="forbid"
    name: Optional[ColumnSpec] = None
    category: Optional[ColumnSpec] = None
    lon: ColumnSpec   # required
    lat: ColumnSpec   # required

class PoiConfig(BaseModel):  # extra="forbid"
    label: str
    glob: str
    format: Optional[FormatType] = None
    columns: PoiColumnsConfig
    color: Optional[tuple[int, int, int]] = None  # same 0-255 validator as RenderConfig

class SourcesFile(BaseModel):
    version: int
    sources: dict[str, SourceConfig]
    pois: Optional[dict[str, PoiConfig]] = None
    time: Optional[TimeConfig] = None             # top-level default anchor
```

Validators:
- `discovery.trips_glob is None` ⇒ `trajectories_glob` required; auto-populate
  `trips_synthesis = TripsSynthesisConfig()`. Reject `trips_synthesis` + `trips_glob`
  together (mutually exclusive). At least one of trips/trajectories glob required.
- Format ambiguity: extension `.json` with no explicit `format:` → error (geojson vs
  ndjson undecidable). `.csv/.geojson/.gpx/.ndjson/.jsonl/.parquet/.pq` auto-detect.
- `epoch_anchor` must parse via `datetime.fromisoformat`; naive → error.
- At most one distinct `epoch_anchor` across top-level + all sources.
- When `trips_synthesis` set: skip REQUIRED_TRIP_COLUMNS, allow empty `columns.trips`,
  `trip_id_col` optional.

Also: `dryrun_discovery()` counts all matched files (any format) + POI globs; update
`_EXAMPLE_YAML` with a GPX + POI example.

## 2. NEW `backend/formats.py` — normalizers (~250 LOC)

```python
def detect_format(path, declared) -> FormatType          # explicit > extension; .json raises
def normalize_geojson(path, coord_times_prop) -> Iterator[dict]
def normalize_gpx(path) -> Iterator[dict]                # iterparse
def normalize_ndjson(path) -> Iterator[dict]
# parquet: NO normalizer — SQL path via read_parquet
```

Canonical staging fields (`_` prefix avoids property collisions):

| field | geojson Point | geojson LineString | gpx trkpt | ndjson |
|---|---|---|---|---|
| `_lon`,`_lat` | coords | each coordinate | `@lon`/`@lat` | user-declared |
| `_time_ms` | time prop→epoch ms | `coord_times_prop[i]`, else feature time, else NULL | `<time>` ISO→epoch ms (offsets honored) | user-declared |
| `_seq` | 0 | coordinate index | cumulative idx | line number |
| `_feature_id` | feature idx | feature idx | `"{trk}:{seg}"` | line number |
| `_trk_name` | — | — | `<name>` else `"trk{idx}"` | — |
| `_props_json` | remaining props JSON | same | name/ele/extensions JSON | whole row |

Plus first-level scalar properties flattened as plain fields (nested → `_props_json` only).

Timestamp contract: `datetime.fromisoformat`; naive → assume UTC (documented);
aware → convert to UTC epoch ms.

Known limit: GeoJSON uses whole-file `json.load` (ingest-time only; batched staging
keeps post-parse memory flat; streaming parser = Phase 3).

## 3. `backend/ingest.py` — dispatch, staging, synthesis, anchor

a) `_table_source(conn, path, fmt, **normalizer_kwargs) -> str` — returns a SQL table
expression: `read_csv(...)` / `read_parquet(...)` / staged TEMP table from normalizer
rows. `_stage_rows`: column union inferred lazily in 10k batches (`ALTER TABLE ADD COLUMN`
for new keys), `executemany` in 50k batches, light type inference (int→BIGINT,
float→DOUBLE, else VARCHAR; ColumnSpec CASTs do final typing). TEMP dropped per file.

b) String vehicle/trip IDs — hash fallback in `_select_clause`:
```sql
COALESCE(TRY_CAST("{col}" AS INTEGER),
         CAST(hash("{col}") % 2000000000 AS INTEGER) + 1) AS vehicle_id
```
(same pattern for trip_id with BIGINT space). `vehicle_key` stays authoritative.
⚠ Smoke-test DuckDB `hash()` return type/modulo behavior first; adjust if needed.

c) `{epoch_anchor}` placeholder substitution in `_column_expr` derived SQL, e.g.:
```yaml
starttime:      { derived: "CAST((_time_ms // 1000 - {epoch_anchor}) % 86400 AS INTEGER)" }
simulation_day: { derived: "CAST((_time_ms // 1000 - {epoch_anchor}) // 86400 AS INTEGER)" }
```

d) `synthesize_trips(conn, src, anchor_sec) -> int` — pure SQL over
`waypoints WHERE source_id=?`: window `LAG(unix_time_ms)` per vehicle → new-trip marks
(gap > gap_minutes, or day change for `day` strategy; `single` ⇒ one ordinal) →
cumulative SUM ordinal = trip_id → GROUP BY (vehicle_key, ordinal): starttime/
simulation_day from anchor math, first/last lon/lat (arg_min/arg_max), distance_km =
SUM haversine of consecutive pairs, dep_hour, vehicle_type, city, source_id,
ANY_VALUE for transport_mode/purpose/goods_type when non-NULL.

e) Anchor persistence: resolve top-level → per-source (uniqueness validated) →
`config.BASE_EPOCH_SEC`. First ingest writes `viz_meta`; different existing anchor
without `--reset` ⇒ hard error. `--aggregates-only`/`build_density_hourly` use
`db.get_epoch_anchor(conn)`. Per-source summary log lines (`fmt=gpx, 3 files,
12,304 waypoints, 412 trips synthesized`); failing record number in `_log_failure`.

f) `ingest_pois(conn, poi_key, cfg, path)` — same `_table_source` dispatch; columns via
`_column_expr`; `props_json` from staging `_props_json` (NULL for csv/parquet);
`poi_id = row_number() OVER ()`; idempotent `DELETE FROM pois WHERE source_key=?`
first; logged to `ingest_log` (table_name `pois`).

## 4. `backend/db.py` — DDL

```sql
CREATE TABLE IF NOT EXISTS pois (
    poi_id BIGINT NOT NULL, source_key VARCHAR NOT NULL,
    name VARCHAR, category VARCHAR,
    lon DOUBLE NOT NULL, lat DOUBLE NOT NULL, props_json VARCHAR);
CREATE TABLE IF NOT EXISTS viz_meta (key VARCHAR PRIMARY KEY, value VARCHAR NOT NULL);
CREATE INDEX IF NOT EXISTS idx_pois_category ON pois(category);
CREATE INDEX IF NOT EXISTS idx_pois_lonlat ON pois(lon, lat);
```
`reset_db()` drops both. NEW `get_epoch_anchor(conn=None) -> int` — single read path
(viz_meta else `config.BASE_EPOCH_SEC`). No trips/waypoints DDL changes.

Update all `BASE_EPOCH_SEC` read sites (grep: routers/trajectories.py,
build_density_hourly, possibly backend/export.py) → `get_epoch_anchor()`.

## 5. POI API — NEW `backend/routers/pois.py`, models, app wiring

```python
GET /api/pois?category&source_key&bbox=w,s,e,n&limit=20000(le=100000)
    -> {pois: [{poi_id, source_key, name, category, lon, lat, props}], count, truncated}
GET /api/pois/categories
    -> {categories: [{category, count, color, label, source_key}]}
```
Query patterns: category `^[A-Za-z0-9_ \-]{1,40}$`, source_key `^[a-z][a-z0-9_\-]*$`,
bbox `^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$` (+ w<e, s<n check → 422). color/label joined
in Python from sources.yaml with try/except-[] degradation (same as `_source_styles`).
POI filters independent of TripFilters. models.py: `Poi`, `PoiListResponse`,
`PoiCategoriesResponse`. app.py: include router, prefix `/api`, tag `pois`.

## 6. Phase-1 tests

- `tests/test_formats.py` + committed fixtures (`points.geojson`, `lines.geojson`
  w/ coordTimes, `track.gpx` w/ UTC + `+09:00` cases, `pings.ndjson`): canonical
  fields, epoch-ms correctness, seq/feature-id monotonicity, naive→UTC.
- `tests/test_ingest_universal.py` (in-memory DuckDB monkeypatch pattern):
  GeoJSON end-to-end + gap-split yields exactly 2 trips for 25-min hole @ gap=20;
  GPX anchor math (`+09:00` vs `Z` same bucket); Parquet ≡ CSV same mapping;
  string vehicle id hash fallback, vehicle_key intact; mixed-anchor ingest → error.
- `tests/test_pois.py`: TestClient; 5 POIs / 2 categories → list, category filter,
  bbox, limit/truncated, categories counts, 422s.
- `tests/test_sources_schema.py`: auto-detect table, `.json` ambiguity, synthesis
  mutual exclusion, multi-anchor rejection, POI block, naive anchor.
- `tests/test_endpoints.py`: add non-default-anchor assertion on trajectories sample.

## 7. Risks

Large GeoJSON whole-file parse (ingest-only; docs recommend Parquet for big data) ·
timezone confusion (single parser contract + fixtures) · hash collisions (vehicle_key
authoritative; display-only impact) · anchor drift (single read path + hard error) ·
staging throughput ~1–3M rows/min (acceptable; pyarrow fast-path Phase 3) · perf
budgets safe (no request-path changes; `/api/pois` indexed + limit-capped).

## 8. Phase 2 (after Phase 1 lands)

- Frontend POI: types + `fetchPois`/`fetchPoiCategories` in api.ts; `usePois` hook;
  ScatterplotLayer group in MapView (before origins/destinations; deterministic hash
  palette + YAML color override; pickable tooltip branch); `DEFAULT_LAYER_VIS.pois=true`;
  hash key `pc=` (enabled categories); category chips in FilterPanel/SourceLegend.
- Demo: `demo/generate_demo_data.py` (seeded; output committed, <2MB) — 20 courier
  GPX tracks (lunch-break gap-split), 8 bus LineStrings w/ coordTimes, ~40 POIs
  (3 categories); `demo/sources.demo.yaml`; `backend/demo.py` + `trajectory-viz-demo`
  script (env setup → ingest --reset on first run → summary; `--serve` starts uvicorn).
- EmptyState component when stats trip_count=0 (demo command + docs link).
- Docs: QUICKSTART leads with demo; README universal positioning + format matrix;
  NEW docs/DATA_FORMATS.md cookbook; ARCHITECTURE ingest diagram update.
- Tests: poiColors, `pc=` hash round-trip, `tests/test_demo.py` (slow-marked).
