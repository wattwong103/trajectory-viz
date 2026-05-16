# Contributing to trajectory-viz

Contributions welcome — particularly new ABM source configs, bug fixes, and analytical features. This doc covers (a) how to add a new source, (b) coding style, (c) testing.

---

## Adding a new ABM source

The v0.2 schema-driven design means a new ABM is added by writing a YAML block, not by editing backend code (unless the ABM needs a column the schema doesn't have).

### Step 1 — Inspect your ABM's output

You need two CSV formats (waypoints are optional):

| | Required columns | Optional columns |
|---|---|---|
| Trips | `id`, vehicle-id column (any name), `starttime`, `start_lon`, `start_lat`, `end_lon`, `end_lat` | `transport_mode`, `purpose`, `distance_km`, `simulation_day`, anything else |
| Waypoints | trip-foreign-key + vehicle-id columns, `unix_time_ms`, `lon`, `lat` | `link_id`, anything else |

### Step 2 — Add a block to `sources.yaml`

```yaml
sources:
  # ... existing entries ...
  my-abm-name:
    label: "My ABM (city/scope name)"
    source_id: my_abm                       # short identifier; can collide across scopes
    discovery:
      trips_glob: "trips/my_abm/run_*/trips.csv"          # relative to PFLOW_VIZ_OUTPUT_ROOT
      trajectories_glob: "trajectory/my_abm/**/wpt.csv"   # optional
      latest_only: true                                    # uses most recent run_*
      scope: { value: tokyo }                              # optional, per-city/region
    vehicle_key_template: "my_abm:{scope}:{vehicle_id}"   # or "my_abm:{vehicle_id}" without scope
    columns:
      trip_id_col: id                       # which CSV column → trips.trip_id
      vehicle_id_col: agent_id              # which CSV column → trips.vehicle_id
      trips:
        # Required core
        starttime:  { csv: starttime, type: int }
        start_lon:  { csv: start_lon, type: double }
        start_lat:  { csv: start_lat, type: double }
        end_lon:    { csv: end_lon,   type: double }
        end_lat:    { csv: end_lat,   type: double }
        # Optional
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
python -m backend.sources_schema --validate sources.yaml
```

Common errors:

- `vehicle_key_template '...' must include {vehicle_id} placeholder` — add `{vehicle_id}` somewhere in the template.
- `discovery.scope is set but vehicle_key_template does not use {scope}` — add `{scope}` to the template, or remove `scope` from discovery.
- `Missing required trip columns: ['end_lat', ...]` — every source must map the 5 core spatial-temporal columns.

### Step 4 — Dry-run the glob

```bash
python -m backend.sources_schema --discovery sources.yaml --output-root /path/to/output
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

Start the backend and open `/api/stats/filter-options`. Your new `source_id` should appear in `vehicle_types`. The frontend's Vehicle Type buttons populate from this list — so the dashboard now shows a new button for your ABM without any frontend code changes.

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

### Backend (pytest)

```bash
pytest tests/test_v0_2_parity.py -v
```

Add new tests for:

- Any change to `compute_derived_metrics()` (F1 logic)
- Any change to `_compute_segments()` or `_rows_to_trajectories()` (F3 logic)
- Any change to the `_select_clause` / `_vehicle_key_sql` SQL builders in `ingest.py`
- New endpoints — at minimum a happy-path call returns the expected shape

### Frontend (vitest)

```bash
cd frontend && npm test
```

(Vitest setup is included; see `vite.config.ts` and `src/__tests__/`.)

### Manual smoke

After non-trivial changes:

```bash
# Backend
curl http://127.0.0.1:9999/api/stats/filter-options
curl 'http://127.0.0.1:9999/api/trips/sample?n=5'

# Frontend
cd frontend && npm run build   # catches TS errors
```

### Cross-version parity (when changing ingest)

If you change the SQL builders in `backend/ingest.py`, the parity check confirms that a re-ingest produces equivalent rows to the previous version. See `tests/test_v0_2_parity.py:__main__` for the two-DB compare utility.

---

## What kinds of contributions are most valuable?

In rough priority order:

1. **New `sources.yaml` configs** for ABMs you actually use (MATSim, SUMO, AnyLogic, custom Python). Each one stress-tests the schema generalization.
2. **F2/F3 UI hookup** — the backend endpoints exist for `through-zone-bbox`, `multi-stop`, `route-similarity`; the dashboard UI for invoking them is deferred. Frontend contributions welcome.
3. **Performance improvements** — query plans, index tuning, JSON serialization caps.
4. **Bug fixes & ergonomics** — anything that bites you also bites the next user.
5. **Docs** — clarifications, additional examples, troubleshooting entries.

## Code of conduct

Be kind, be specific, attribute prior work. PFLOW research lineage is documented in [PFLOW/CLAUDE.md](https://github.com/...) — when extending a model, cite the original.
