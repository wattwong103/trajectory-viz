# QUICKSTART — trajectory-viz

**Default product path is demo/universal** (Phase D) — no Dropbox or
`PFLOW_HOME` required. PFLOW lab packs are an **opt-in profile** under
[`profiles/`](../profiles/README.md).

**Fastest first run:** Docker one-shot below (map + API + demo data on one
URL). Alternatives: native Vite stack, CLI demo, PFLOW profile, or standalone
DuckDB.

---

## Path 0: Docker one-shot (recommended — map in one command)

**Prerequisite**: Docker Desktop (or Engine + Compose).

```bash
docker compose up --build
# → http://localhost:8080
```

No host DuckDB, no separate frontend build. The image bakes
`demo/demo.duckdb` and the React UI; the entrypoint re-seeds only if the
configured DB path is missing or empty. Uploads persist under `./data/uploads`.

Custom / empty DB:

```bash
# Serve your own file (place it at ./data/my.duckdb)
TRAJECTORY_VIZ_DB=/data/my.duckdb TRAJECTORY_VIZ_SEED_DEMO=0 docker compose up --build

# Intentionally empty (upload-and-go only)
TRAJECTORY_VIZ_SEED_DEMO=0 TRAJECTORY_VIZ_DB=/data/empty.duckdb docker compose up --build
```

---

## Path 0b: Native demo CLI

A small synthetic day around Kichijōji, Tokyo is committed under
[`demo/`](../demo) and wired by the reference universal registry
[`demo/sources.demo.yaml`](../demo/sources.demo.yaml):

- bike couriers — GPX tracks (gap-split trips)
- city buses — GeoJSON LineStrings + `coordTimes`
- local OD arcs — trips-only CSV with string `mode` labels (`walk`/`bike`/`bus`)
- POIs — GeoJSON stations / malls / parks

```bash
pip install -e .
# Map UI — pick one:
cd frontend && npm install && npm run build && cd .. && trajectory-viz-demo --serve
#   → http://127.0.0.1:9999  (API + built UI)
# or one-command HMR stack (auto-ingests demo if needed):
cd frontend && npm run dev
#   → http://localhost:5173
```

The first ingest writes `demo/demo.duckdb` (subsequent runs reuse it;
`--reset` forces a fresh ingest; `--db-path` redirects it).

> `trajectory-viz-demo --serve` without a prior `npm run build` is **API-only**
> at `/` (JSON note, not the map). Prefer Path 0 Docker, `npm run build`, or
> `npm run dev`.

To regenerate the dataset deterministically: `python demo/generate_demo_data.py`.
To point the tool at **your own** GPX/GeoJSON/NDJSON/Parquet/CSV data, see
[`docs/DATA_FORMATS.md`](DATA_FORMATS.md).

---

## Drop a file (upload-and-go)

The fastest way to see **your own** data: drag any `.gpx`, `.geojson`, `.csv`,
`.ndjson`, or `.parquet` file (up to **200 MB**) onto the map — or use the
**⬆ Upload** button in the filter panel, or the drop area on the "No data yet"
empty state. No `sources.yaml` block, no CLI, no reload.

What happens:

1. The format is sniffed automatically (from the extension; `.json` files are
   content-sniffed as GeoJSON vs NDJSON).
2. For CSV/NDJSON/Parquet, lon/lat/time/id columns are identified by name
   heuristics; GeoJSON and GPX normalize automatically. If the columns can't
   be identified, you get a 422 with the exact reasons — rename the columns or
   write an explicit `sources.yaml` block instead (see below).
3. Trips are synthesized from the points (30-minute gap split) and ingest runs
   as a background job with a live progress card.
4. When the job finishes, the new source simply appears — **Sources** button,
   legend entry, toast ("Added 'couriers.gpx': 412 trips, 2 vehicles").

**Time anchoring on a fresh DB**: the first upload into an empty database pins
absolute time to midnight UTC of the data's first day. Later uploads reuse that
anchor, so mixed datasets stay on one clock.

Uploaded files land in `uploads/` next to the DB, and the auto-generated source
configs persist in **`sources.uploads.yaml` next to the DB** — your hand-written
`sources.yaml` is never modified. Re-uploading the same filename replaces that
source's data. For full control (custom column mappings, trip files, colors,
POI layers), write a `sources.yaml` block per
[`docs/DATA_FORMATS.md`](DATA_FORMATS.md).

---

## Path A: Native (Mac + Windows)

Best for development with Vite HMR. Two processes: backend on :9999, frontend dev server on :5173.

### Prerequisites

- Python ≥ 3.11
- Node.js ≥ 20
- `git`, `npm`

### Environment variables (optional)

All runtime config is driven by env vars. See [`env.example`](env.example) for
the full list with comments. To use Docker's auto-`.env` loading:

```bash
cp docs/env.example .env
vim .env       # uncomment + edit the variables you need
docker compose up --build
```

Native demo users need no env vars. Lab users opt in with
`export TRAJECTORY_VIZ_PROFILE=pflow` and `export PFLOW_HOME=…`.

### One-time setup

```bash
# macOS / Linux
cd trajectory-viz
./setup.sh

# Windows
cd trajectory-viz
setup.bat
```

Each script creates `.venv-viz/`, installs the project in editable mode (`pip install -e .`), and runs `npm install` in `frontend/`.

> **Dropbox-sync caveat (cross-platform)**: `.venv-viz/` and `frontend/node_modules/` are platform-specific. If you sync the repo between Mac and Windows via Dropbox, both directories will sync as opaque blobs and break on the other OS. Add both to Dropbox **Selective Sync exclusions** (the same way `output/` is already excluded in the parent PFLOW repo), and re-run `setup.{sh,bat}` per machine.

### Ingest data

```bash
# Default (demo/universal registry → demo/demo.duckdb)
./.venv-viz/bin/trajectory-viz-ingest --reset

# Opt-in PFLOW lab profile (goods / fare / person packs)
export TRAJECTORY_VIZ_PROFILE=pflow
export PFLOW_HOME=/path/to/PFLOW
./.venv-viz/bin/trajectory-viz-ingest --profile pflow --reset
```

Default ingest reads `demo/sources.demo.yaml` under `demo/`. The PFLOW profile
reads [`profiles/pflow/sources.yaml`](../profiles/pflow/sources.yaml) and scans
`$PFLOW_HOME/output` into `pflow.duckdb`. Both paths compute F1 derived metrics
(`speed_avg_kmh`, `dwell_minutes`, `detour_ratio`) at the end.

### Run

Two terminals:

```bash
# Terminal 1 — backend (port 9999)
trajectory-viz-serve
# or, with reload for development:
./.venv-viz/bin/python -m uvicorn backend.app:app --host 127.0.0.1 --port 9999 --reload

# Terminal 2 — frontend (port 5173, proxies /api → :9999)
cd frontend && npm run dev
```

Visit **<http://localhost:5173>**.

---

## Path B: Standalone (DuckDB file only, no source CSVs)

If you already have a `pflow.duckdb` from someone else and just want to serve it:

```bash
export PFLOW_VIZ_DB=/absolute/path/to/pflow.duckdb
trajectory-viz-serve
# Open http://localhost:9999 (or :8080 if running via Docker)
```

In this mode `PFLOW_HOME` is never resolved, so the dashboard runs anywhere the DuckDB file exists.

---

## Path C: GUFM vs PFLOW ground-truth fleets

The `data/gufm/` dataset holds two fleets of the same 400 held-out persons
(ward 13101/Chiyoda): GUFM model-generated trips vs PFLOW ground truth — the
dataset the ⇄ Compare tab's matched-person workflow was built for. Launchers
at the repo root wire the three required env vars
([`profiles/gufm/sources.yaml`](../profiles/gufm/sources.yaml) +
`gufm.duckdb` + output root):

```bash
./start-gufm-viz.sh    # macOS / Linux
start-gufm-viz.bat     # Windows
# Dashboard: http://localhost:5173
```

Details and regeneration notes: [`data/gufm/README.md`](../data/gufm/README.md).
Caveats worth knowing before reading the map: 91% of GUFM trips are
same-mesh zero-distance hops (honest free-running model behavior — they
render as OD dots and stationary follow-dots, not trails); GT has
pre-midnight starttimes (the animation wraps them mod-86400).

---

## Adding a new ABM source

The whole point of v0.2 is that adding a new ABM (e.g. MATSim, SUMO, or a custom Python ABM) is a config change, not a code change — and as of universal-trajectory support, the inputs can be CSV, GeoJSON, GPX, NDJSON, or Parquet (points-only sources get trips synthesized at ingest). See [CONTRIBUTING.md → Adding a source](CONTRIBUTING.md#adding-a-new-abm-source) for the step-by-step and [DATA_FORMATS.md](DATA_FORMATS.md) for the per-format cookbook plus external ABM recipes (§9). Worked examples: [MATSim](examples/sources-matsim.yaml), [SUMO FCD](examples/sources-sumo-fcd.yaml), [OD arcs](examples/sources-od-arcs.yaml), [evacuation micro](examples/sources-evacuation-micro.yaml), [phone GPS](examples/sources-phone-gps.yaml), [JoRAS v3](examples/sources-joras-v3.yaml). MATSim/SUMO XML → thin adapters under `scripts/` (no native XML FormatType).

**Simulation scale** (`capabilities.scale`: micro | meso | macro) — auto-detect from agent/waypoint counts, or set `scale:` in `sources.yaml`:

- **Micro** (evacuation / event / building): fine trails + agents; do not skip waypoints. See [DATA_FORMATS §11](DATA_FORMATS.md#11-simulation-scale-micro--meso--macro) + [evacuation recipe](examples/sources-evacuation-micro.yaml).
- **Macro** (city / region / ≫1M agents): ingest trips (+ `density_hourly`), skip or thin waypoints — aggregate-first arcs + pulse. UI auto-switches; re-enable Trajectories to override.

---

## Offline HTML export (paper / deck)

Mail a self-contained scene (no server) with `viz-export`. For the default
`--engine deck`, fetch the vendor once; `--engine minimal` needs no vendor:

```bash
trajectory-viz-demo --ensure
python scripts/fetch_vendor.py            # once; verifies pinned deck.gl SHA-256

viz-export --preset presets/demo-paper.yaml --db demo/demo.duckdb \
           --out exports/demo-paper.html

# lighter Canvas shell (no vendor fetch)
viz-export --preset presets/demo-paper.yaml --db demo/demo.duckdb \
           --engine minimal --out exports/demo-paper-minimal.html
```

Gallery + size tips: [`presets/README.md`](../presets/README.md), [`EXPORT.md`](EXPORT.md).

## Shareable live URLs

The running dashboard writes filters / agents / legend toggles into the URL
hash (e.g. `#vt=courier&ag=courier%3Acourier-01`). Copy the address bar to
share a view — same DuckDB + server required. Hash key table:
[`EXPORT.md` → Shareable dashboard URLs](EXPORT.md#shareable-dashboard-urls).
For an offline file, use export above instead.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `viz-export` says vendor bundle not found | Run `python scripts/fetch_vendor.py` (downloads + verifies the pinned SHA-256), or pass `--engine minimal`. See [`EXPORT.md`](EXPORT.md). |
| Export exceeds 8 MB budget | Lower `--n`, use `presets/demo-paper.yaml`, drop buildings / pulse, pass `--engine minimal`, or `--force`. |
| Dashboard shows a red "Backend unreachable" overlay | The frontend is up but the API isn't (or `PFLOW_VIZ_DB` points nowhere). Start the backend (`trajectory-viz-serve` or `npm run dev`, which launches both), then hit ↻ Retry. |
| Layers default to arcs + pulse / trails off | Dataset is **macro** scale (~1M agents or ~10M waypoints, or `scale: macro` in sources.yaml). Expected — toggle **Trajectories** or the Trails / Micro preset to override; build pulse with `python -m backend.ingest --aggregates-only` if the Pulse layer is disabled. |
| Small evacuation pack got arcs + pulse | Check `capabilities.scale` / `scale_source`. Tiny packs should auto-detect **micro**; set `scale: micro` in sources.yaml to force trails+agents defaults. |
| Map shows fleets without labels/colors, Compare tab lists cryptic ids | `PFLOW_VIZ_SOURCES` points at the wrong registry for the DB (e.g. demo registry while serving `gufm.duckdb`). The backend also prints a `[WARN] ... have no entry in the sources registry` line naming the culprits. For GUFM data use `./start-gufm-viz.sh` (or the `.bat`). |
| `npm run dev` errors with `'vite' is not recognized` | `node_modules/` was synced from a different OS. `rm -rf frontend/node_modules && cd frontend && npm install`. |
| Backend starts but `/api/stats/filter-options` returns empty arrays | DuckDB exists but no data ingested. Run `trajectory-viz-ingest --reset` (see *Ingest data* above). |
| `Cannot locate PFLOW project root` error | Only happens on the PFLOW profile. Set `PFLOW_HOME=/path/to/PFLOW`, switch back to demo (`unset TRAJECTORY_VIZ_PROFILE PFLOW_HOME`), or use standalone mode (`TRAJECTORY_VIZ_DB=...`). |
| Docker build fails on `npm ci` | Stale `package-lock.json` vs. registry. `npm install` (not ci) once locally to refresh, then re-build. |
| Dashboard shows "No data yet" / empty-hint but you expected demo trips | Docker: ensure `TRAJECTORY_VIZ_SEED_DEMO` is not `0` and you did not override `TRAJECTORY_VIZ_DB` to an empty file. Native: run `trajectory-viz-demo` (or `npm run dev`, which auto-ingests). |
| Opened :9999 and got JSON (`Frontend dist/ not bundled`) instead of the map | API-only serve — run `cd frontend && npm run build` once, or use `npm run dev` / `docker compose up --build`. |
| Dashboard shows empty day filter but ingest completed | Check `simulation_day` filter — it might be filtering to a day with no data. Click "All days" in the dropdown. |
