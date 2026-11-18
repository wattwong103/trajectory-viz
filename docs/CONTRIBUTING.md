# Contributing to trajectory-viz

Contributions welcome — particularly new ABM source configs, bug fixes, and analytical features. This doc covers (a) how to add a new source, (b) coding style, (c) testing, (d) performance budgets.

**Product defaults:** demo/universal (`demo/sources.demo.yaml`) is the out-of-box path. Lab packs live under [`profiles/`](../profiles/README.md). Public vocabulary is `source_id` / Sources, `agent_key`, string `mode`, and `agent_id` — see [ARCHITECTURE.md → Canonical vocabulary](ARCHITECTURE.md#canonical-vocabulary-universal-forms--phase-abc). Prefer those names in new code and docs; `vehicle_type=` remains a deprecated alias of `source_id=`.

---

## Adding a new ABM source

The v0.2 schema-driven design means a new ABM is added by writing a YAML block, not by editing backend code (unless the ABM needs a column the schema doesn't have). Put the block in `demo/sources.demo.yaml`, a profile under `profiles/`, or any registry pointed at by `TRAJECTORY_VIZ_SOURCES`.

### Step 1 — Inspect your ABM's output

You need two CSV formats (waypoints are optional):

| | Required columns | Optional columns |
|---|---|---|
| Trips | `id`, vehicle-id column (any name), `starttime`, `start_lon`, `start_lat`, `end_lon`, `end_lat` | `mode` / `transport_mode`, `purpose`, `distance_km`, `simulation_day`, anything else |
| Waypoints | trip-foreign-key + vehicle-id columns, `unix_time_ms`, `lon`, `lat` | `link_id`, `leg_id`, anything else |

GeoJSON / GPX / NDJSON / Parquet work too — see [DATA_FORMATS.md](DATA_FORMATS.md). Points-only sources synthesize trips at ingest.

### Step 2 — Add a block to a sources registry

```yaml
sources:
  # ... existing entries ...
  my-abm-name:
    label: "My ABM (city/scope name)"
    source_id: my_abm                       # short identifier; can collide across scopes
    discovery:
      trips_glob: "trips/my_abm/run_*/trips.csv"          # relative to TRAJECTORY_VIZ_OUTPUT_ROOT
      trajectories_glob: "trajectory/my_abm/**/wpt.csv"   # optional
      latest_only: true                                    # uses most recent run_*
      scope: { value: tokyo }                              # optional, per-city/region
    vehicle_key_template: "my_abm:{scope}:{vehicle_id}"   # or "my_abm:{vehicle_id}" without scope
    mode_map: { 0: walk, 1: bike, 2: bus, 3: car }       # optional; feeds trips.mode + UI chips
    columns:
      trip_id_col: id                       # which CSV column → trips.trip_id
      vehicle_id_col: agent_id              # which CSV column → trips.vehicle_id / agent_id
      trips:
        # Required core
        starttime:  { csv: starttime, type: int }
        start_lon:  { csv: start_lon, type: double }
        start_lat:  { csv: start_lat, type: double }
        end_lon:    { csv: end_lon,   type: double }
        end_lat:    { csv: end_lat,   type: double }
        # Optional
        mode:            { csv: mode,         type: varchar }  # prefer string labels
        distance_km:     { csv: distance_km, type: double }
        dep_hour:        { derived: "CAST(starttime / 3600 AS INTEGER)" }
        simulation_day:  { csv: day,          type: int }
        # ... add any source-specific columns the DB schema already has
        # (goods_type, vehicle_size, fare_yen, origin_zone, ...).
      waypoints:
        unix_time_ms:    { csv: timestamp_ms, type: bigint }
        lon:             { csv: lon,          type: double }
        lat:             { csv: lat,          type: double }
        link_id:         { csv: link_id,      type: varchar }
```

### Step 3 — Validate the YAML

```bash
python -m backend.sources_schema --validate demo/sources.demo.yaml
# or your profile / custom registry:
python -m backend.sources_schema --validate profiles/pflow/sources.yaml
```

Common errors:

- `vehicle_key_template '...' must include {vehicle_id} placeholder` — add `{vehicle_id}` somewhere in the template.
- `discovery.scope is set but vehicle_key_template does not use {scope}` — add `{scope}` to the template, or remove `scope` from discovery.
- `Missing required trip columns: ['end_lat', ...]` — every source must map the 5 core spatial-temporal columns.

### Step 4 — Dry-run the glob

```bash
python -m backend.sources_schema --discovery demo/sources.demo.yaml --output-root demo
# lab:
python -m backend.sources_schema --discovery profiles/pflow/sources.yaml --output-root /path/to/output
```

This counts files matching each source's glob without actually ingesting. A zero count means the glob doesn't match anything — fix the path.

### Step 5 — Ingest

```bash
trajectory-viz-ingest --reset
```

If your source adds columns that aren't in the existing DB schema (`backend/db.py`), the INSERT will fail. You have two options:

- **Recommended**: stick to the columns already in `trips`/`waypoints` (most ABMs map cleanly).
- **Schema extension**: edit `backend/db.py` to ADD the new columns to the CREATE TABLE blocks + add an entry to `_additive_columns` for the idempotent ALTER TABLE migration. Then re-ingest.

### Step 6 — Verify in the dashboard

Start the backend and open `/api/stats/filter-options`. Your new `source_id` should appear in `sources[]` (and the back-compat `vehicle_types` mirror). The frontend **Sources** buttons populate from this list — so the dashboard shows a new button for your ABM without frontend code changes.

---

## Coding style

### Python (backend)

- **Format**: `ruff format` (config in `pyproject.toml`); 100-char line length.
- **Lint**: `ruff check`. The config enables pycodestyle, pyflakes, isort, flake8-bugbear, pyupgrade.
- **Type hints**: required on all public APIs (router handlers, model classes). Internal helpers may skip them.
- **SQL injection safety**: any value substituted into an f-string SQL must either come from a Pydantic-validated field (with a pattern constraint that excludes quotes) or be cast through `int()`/`float()`. See the `build_trip_filter` docstring for the convention.
- **Print/log**: use `print()` for ingest output (CLI tool); use FastAPI's structured logger for request errors.

### TypeScript (frontend)

- **No new dependencies** without justification — the pinned set is Vite + React + DeckGL + recharts + maplibre. Adding a new charting lib duplicates recharts.
- **Filter state** lives in URL hash for shareability; encode/decode handlers in `App.tsx`.
- **DeckGL layer ordering** matters for z-fighting — see `MapView.tsx` for the established stack (heatmap → density → trips → origins → destinations → ...).
- **No DOM globals** — use React refs / state. DeckGL has its own picking system; route map clicks through it, not through `document.addEventListener`.

### Commit messages

Conventional Commits style: `feat:`, `fix:`, `chore:`, `docs:`, `perf:`, `refactor:`. The Phase 1 commits on `phase-1-foundation` are good examples.

---

## Testing

Current suite size (approximate — re-count with the commands below): **~320 pytest** across `tests/`, **~150 vitest** under `frontend/src/__tests__/`.

### Backend (pytest)

```bash
pip install -e ".[dev]"
pytest tests/ -v
# or collect only: pytest tests/ --collect-only -q
```

Key modules: `test_v0_2_parity.py`, `test_endpoints.py`, `test_sources_schema.py`, `test_demo.py`, `test_phase_d_defaults.py`, `test_schema_accommodation.py`, `test_lod.py`, `test_first_run.py`, plus format/zone/export coverage.

Add new tests for:

- Any change to `compute_derived_metrics()` (F1 logic)
- Any change to `_compute_segments()` or `_rows_to_trajectories()` (F3 logic)
- Any change to the `_select_clause` / `_vehicle_key_sql` SQL builders in `ingest.py`
- New endpoints — at minimum a happy-path call returns the expected shape
- Profile / default-path changes — extend `test_phase_d_defaults.py` / `test_first_run.py`

### Frontend (vitest)

```bash
cd frontend && npm test
```

(Vitest setup is included; see `vite.config.ts` and `src/__tests__/` — filter hash, LOD policy, layer catalog, upload, Compare tab, ….)

### Manual smoke

After non-trivial changes:

```bash
# Backend (demo DB by default)
curl http://127.0.0.1:9999/api/stats/filter-options
curl 'http://127.0.0.1:9999/api/trips/sample?n=5'

# Frontend
cd frontend && npm run build   # catches TS errors

# One-URL Docker path
docker compose up --build
# → http://localhost:8080  (map HTML + demo trips)
```

### Cross-version parity (when changing ingest)

If you change the SQL builders in `backend/ingest.py`, the parity check confirms that a re-ingest produces equivalent rows to the previous version. See `tests/test_v0_2_parity.py:__main__` for the two-DB compare utility.

---

## Performance budgets

These are the living API targets (same list as [ARCHITECTURE.md](ARCHITECTURE.md#performance-budgets-hard)):

1. `/api/stats/*` p99 < 200ms
2. `/api/trips/*` p99 < 1s for ≤10K-trip result sets
3. `/api/trajectories/*` < 500ms for a single trip; sample ≤500 trajectories per multi-trip render
4. DuckDB is a **module-level singleton** (`db.get_connection`) — design queries for one connection per process; do not assume per-request open/close

When adding endpoints: add indexes for new filter columns, cap JSON payloads, and respect mega-sim LOD clamps (`backend/lod.py`).

---

## What kinds of contributions are most valuable?

In rough priority order:

1. **New sources-registry configs** for ABMs you actually use (MATSim, SUMO, AnyLogic, custom Python) — preferably as `docs/examples/` or a `profiles/` pack. Each one stress-tests the schema generalization.
2. **Performance improvements** — query plans, index tuning, JSON serialization caps (stay within the budgets above).
3. **Bug fixes & ergonomics** — anything that bites you also bites the next user.
4. **Docs** — clarifications, additional examples, troubleshooting entries.

> Frontend modularization of `AnalysisPanel` / `MapView` / hash codec (TV-5) is deferred — prefer small, focused PRs over drive-by splits.

> The F2/F3 endpoints (`through-zone-bbox`, `multi-stop`, `route-similarity`)
> all have dashboard UI: Zone tab (bbox), Chains tab (multi-stop), and
> Clusters tab (route similarity).

## Code of conduct

Be kind, be specific, attribute prior work. When extending a mobility model, cite the original research (see README acknowledgements and [`CITATION.cff`](../CITATION.cff)).
