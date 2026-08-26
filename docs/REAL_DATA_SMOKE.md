# Real-data smoke + cross-version parity runbook

The pytest suite (`tests/test_v0_2_parity.py` + `tests/test_endpoints.py`, 50 tests) exercises every SQL builder, ingest path, and endpoint against synthetic CSVs. What it **cannot** verify:

- Wall-time of `compute_derived_metrics` against 4.43M trips (synthetic tests use ~10 rows).
- Whether the v0.2 ingest produces equivalent row counts and column values to the v0.1 ingest **on the same input CSVs**.
- DuckDB query plans on real index distributions.

This runbook covers those gaps. Expect **10–20 minutes** of wall time on a typical Sekimoto-lab dev machine with the reference 4.43M-trip / 233M-waypoint dataset.

---

## Prerequisites

- The PFLOW monorepo on disk with `output/trips/` and `output/trajectory/` populated.
- A v0.1 `output/viz/pflow.duckdb` to compare against (instructions below if you don't have one).
- `setup.sh` (or `setup.bat`) already run for both branches.

---

## Step 1 — Stash the v0.2 work, build a v0.1 baseline DB

If you already have a v0.1-era `output/viz/pflow.duckdb` on disk, skip to Step 2 and `cp` it to a side file.

```bash
# From the trajectory-viz directory, on branch phase-1-foundation
git stash push -m "v0.2 work for parity baseline"
git checkout main               # v0.1 baseline

# v0.1's ingest CLI (note: pre-pyproject.toml, so use the old form):
PFLOW_HOME=/path/to/PFLOW \
    ./.venv-viz/bin/python -m viz.backend.ingest --reset

# Set aside the v0.1 DB for comparison
cp $PFLOW_HOME/output/viz/pflow.duckdb $PFLOW_HOME/output/viz/pflow_v0_1.duckdb

# Restore v0.2 work
git checkout phase-1-foundation
git stash pop
```

If you don't have a v0.1 baseline and don't want to spend the time building one: skip the parity check (Step 4). Steps 2 and 3 still surface the perf and shape issues.

---

## Step 2 — Run the v0.2 ingest with timing

```bash
PFLOW_HOME=/path/to/PFLOW \
    time ./.venv-viz/bin/trajectory-viz-ingest --reset 2>&1 | tee /tmp/ingest-v0.2.log
```

What to watch in the log:

- Per-source row counts (look for `[trips]` and `[traj]` lines): should be 4.43M trips, 233M waypoints, both nonzero.
- **`[DERIVED] Done in N.Ns`** — the F1 derived-metrics pass time. Expected: 10-60s for the reference dataset.
  - If > 5 minutes: file as a Sprint C performance debt item. The three UPDATE statements (speed, dwell, detour) over 4.43M rows should be fast — anything slower means an index or query plan issue.
- **`[FAILED]`** section (at the end) — should be empty. If any source failed, the run exits 1; check `ingest_log WHERE row_count = -1` for details.

Sanity-check the F1 columns populated as expected:

```bash
PFLOW_HOME=/path/to/PFLOW ./.venv-viz/bin/python -c "
from backend.db import get_connection
conn = get_connection()

# Per-source row counts
print('Row counts by source_id:')
for row in conn.execute('SELECT source_id, COUNT(*) FROM trips GROUP BY source_id ORDER BY 1').fetchall():
    print(f'  {row[0]:10s} {row[1]:>10,}')

# F1 metric ranges — should look physical
print()
print('F1 metrics (truck):')
print(conn.execute(\"\"\"
    SELECT
        MIN(speed_avg_kmh) AS min_sp, MAX(speed_avg_kmh) AS max_sp, MEDIAN(speed_avg_kmh) AS med_sp,
        COUNT(speed_avg_kmh) AS n_speed,
        MIN(detour_ratio) AS min_dt, MAX(detour_ratio) AS max_dt, MEDIAN(detour_ratio) AS med_dt,
        COUNT(detour_ratio) AS n_detour
    FROM trips WHERE source_id='truck'
\"\"\").fetchone())

print('F1 metrics (taxi):')
print(conn.execute(\"\"\"
    SELECT
        MIN(speed_avg_kmh) AS min_sp, MAX(speed_avg_kmh) AS max_sp, MEDIAN(speed_avg_kmh) AS med_sp,
        COUNT(speed_avg_kmh) AS n_speed,
        MIN(dwell_minutes) AS min_dw, MAX(dwell_minutes) AS max_dw, MEDIAN(dwell_minutes) AS med_dw,
        COUNT(dwell_minutes) AS n_dwell
    FROM trips WHERE source_id='taxi'
\"\"\").fetchone())
"
```

Expected ranges (these are sanity checks, not validation gates):

| Metric | Truck | Taxi (Tokyo) |
|---|---|---|
| Median speed | 20–80 km/h | 15–40 km/h |
| Median detour | 1.1–1.8 | 1.2–2.0 |
| Median dwell | 30–600 min | 5–120 min |

If a metric's range looks wildly wrong (e.g., median speed = 500 km/h), it's almost certainly a unit-conversion bug. The most likely culprits:

- **Speed**: trip waypoints' `unix_time_ms` was misinterpreted as seconds, multiplying speed 1000×.
- **Detour**: haversine formula has a bug — re-check `compute_derived_metrics` in `backend/ingest.py`.

---

## Step 3 — Endpoint smoke against the real DB

Start the backend and verify each Phase 2 endpoint returns plausible data:

```bash
PFLOW_HOME=/path/to/PFLOW ./.venv-viz/bin/trajectory-viz-serve &
sleep 3

# Stats
curl -s http://127.0.0.1:9999/api/stats | jq '.trips.row_count'        # ~4.4M
curl -s http://127.0.0.1:9999/api/stats/filter-options | jq '.vehicle_types'

# F1 metrics distribution
curl -s 'http://127.0.0.1:9999/api/analysis/temporal/metrics-distribution?metric=speed_avg_kmh&bins=20' \
    | jq '{metric, total_rows, min, max}'

# F2 through-zone (Tokyo Station roughly)
curl -s 'http://127.0.0.1:9999/api/analysis/trip-chains/through-zone-bbox?w=139.760&s=35.675&e=139.785&n=35.692' \
    | jq '.count'

# F2 multi-stop
curl -s 'http://127.0.0.1:9999/api/analysis/trip-chains/multi-stop?min_stops=5&limit=10' \
    | jq '.count'

# F3 route-similarity
curl -s -X POST 'http://127.0.0.1:9999/api/analysis/clustering/route-similarity?sample_size=200&eps=0.3&min_samples=3' \
    | jq '{algorithm, num_clusters, total_trips, noise_count}'

kill %1
```

Check that:

- `trips.row_count` ≈ 4.4M (or whatever your ingest reported).
- `vehicle_types` contains both `truck` and `taxi`.
- `metrics-distribution` `total_rows` > 0; `min`/`max` are physical.
- `through-zone-bbox` `count` > 0 (Tokyo Station area is busy in PFLOW data).
- `multi-stop` returns vehicles with ≥5 trips.
- `route-similarity` returns 2-10 clusters in <10 seconds.

---

## Step 4 — Cross-version parity (only if you have a v0.1 DB)

```bash
PFLOW_HOME=/path/to/PFLOW ./.venv-viz/bin/python -m tests.test_v0_2_parity \
    --v1-db $PFLOW_HOME/output/viz/pflow_v0_1.duckdb \
    --v2-db $PFLOW_HOME/output/viz/pflow.duckdb
```

Pass criteria: exit code 0; the report says `PARITY OK`.

Expected per-source row count match table:

```
--- trips row counts by (vehicle_type, city, simulation_day) ---
  OK    ('truck', None, 0): 2,731,XXX
  OK    ('truck', None, 1): 2,731,XXX
  ...
  OK    ('taxi', 'tokyo', 0): 1,278,096
  ...
```

If any row shows `DIFF`: the v0.1 → v0.2 ingest rewrote a SQL builder in a way that changed semantics. Investigate the source's `sources.yaml` column map (especially `transform:` clauses) against the original `ingest_truck_trips` / `ingest_taxi_trips` to find the divergence.

A sample-row content diff also runs — if 1000 trips byte-match modulo the new `source_id` column, the rewrite preserved semantic equivalence.

---

## Failure mode catalog

| Symptom | Likely cause |
|---|---|
| Ingest log shows `row_count = -1` for some file | Per-file ingest exception; check the file_path and re-read it manually to spot CSV format drift |
| `[DERIVED]` pass > 5 min | Missing index, or sub-optimal query plan. Add as Sprint C item. |
| Speed median way out of range | Time-unit confusion in `compute_derived_metrics` — re-derive from `unix_time_ms` |
| Parity check shows DIFF on a specific source | Inspect that source's `transform:` clauses in `sources.yaml`; compare against the original hardcoded SQL |
| `through-zone-bbox` returns 0 trips for a known-busy area | bbox order wrong; verify `w < e` and `s < n` |
| `route-similarity` takes > 30s | N too large; cap `sample_size` lower in `clustering.py:Query` |

---

## When this runbook is "done"

Tier-1 Sprint A is **fully verified** when:

1. v0.2 ingest completes without errors against the real PFLOW DB.
2. F1 metric ranges are physical (no off-by-1000 unit bugs).
3. All 5 Phase 2 endpoints return plausible data via curl smoke.
4. Either parity check exits 0, OR parity check is deferred with an issue filed noting no v0.1 DB available.

Report the result of each step in the next session's status update. Findings inform whether Sprint B can start clean or whether one of the above turned into a real fix-list item.
