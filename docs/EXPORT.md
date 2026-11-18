# Single-HTML Cinematic Export

`viz-export` packs a filtered sample of trajectories — plus optional animated
pulse heatmap, 3D buildings, and followed agents — into **one self-contained
HTML file**. It uses a dark ground plane instead of a basemap, so it makes
**zero network requests at runtime** and can be mailed to anyone or dropped
into a slide deck.

This is the article's "night grid" idea applied to trajectory data: send a
collaborator a single file, no server, no install.

## Choose a share path

| Goal | Path | Needs server? |
|------|------|---------------|
| Bookmark / paste the live view | **Share link** in the UI (URL hash) — [table below](#shareable-dashboard-urls) | Yes (same DuckDB) |
| Mail a small offline HTML | `presets/demo-paper.yaml` (`engine: minimal`) | No |
| Offline scene closer to the app | `presets/demo-deck.yaml` or `--engine deck` | No |
| Full cinematic (lab) | `presets/tokyo-night.yaml` + taxi/PFLOW DuckDB | No |

```bash
viz-export --list-presets          # gallery: workflow · engine · forms · use
```

Preset gallery details: [`presets/README.md`](../presets/README.md).

## One-time setup (vendor fetch — deck engine only)

`--engine deck` (default when no preset `engine:` is set) inlines deck.gl.
Fetch the UMD bundle once per machine; the export **never** downloads at
runtime:

```bash
python scripts/fetch_vendor.py        # downloads + verifies the pinned SHA-256
```

The bundle lands in `scripts/vendor/deck.gl.min.js` (gitignored; CI caches it).
To bump deck.gl: edit the URL in `scripts/fetch_vendor.py`, run with
`--update`, paste the printed hash into `SHA256`, then re-run without
`--update`.

Paper presets set `engine: minimal` and **skip** the vendor. If `viz-export`
exits with “vendor bundle not found”, either run `fetch_vendor.py` or use
`--engine minimal` / `presets/demo-paper.yaml`.

## Quick path (demo → paper HTML)

Default product path — no PFLOW / lab DB, no vendor fetch:

```bash
pip install -e .
trajectory-viz-demo --ensure

viz-export --preset presets/demo-paper.yaml --db demo/demo.duckdb \
           --out exports/demo-paper.html
# → engine=minimal from the preset (override with --engine deck)
```

## Export

```bash
viz-export --list-presets

# paper (minimal) · deck (deck.gl) — demo DB
viz-export --preset presets/demo-paper.yaml --db demo/demo.duckdb \
           --out exports/demo-paper.html
viz-export --preset presets/demo-deck.yaml  --db demo/demo.duckdb \
           --out exports/demo-deck.html

# lab cinematic (needs a taxi-ingested / PFLOW DuckDB + vendor for deck)
python scripts/fetch_vendor.py
viz-export --preset presets/tokyo-night.yaml --out exports/tokyo-night.html

# ad-hoc (engine defaults to deck without a preset)
viz-export --vehicle-type taxi --city tokyo --simulation-day 0 \
           --n 2000 --agents taxi:tokyo:47 --engine minimal --out exports/taxi.html
```

Open the resulting HTML in any browser — play/pause, scrub the 24h clock,
change speed, toggle pulse and buildings (when baked). No server needed.

## Preset schema (`presets/*.yaml`)

```yaml
title: "Tokyo Taxi — One Night"
workflow: cinematic            # cue: paper | deck | cinematic
engine: deck                   # default render engine (CLI --engine overrides)
use: "Lab cinematic night scene (buildings + pulse)"
forms: [trail, agents, pulse, buildings]   # Phase D — gates what gets baked
filters: { vehicle_type: taxi, city: tokyo, simulation_day: 0 }
sample_n: 2000                 # export exceeds the app's 500 cap on purpose:
agents: ["taxi:tokyo:47"]      #   static file, no per-frame fetch
include: { buildings: tokyo, pulse: true }
camera: { longitude: 139.76, latitude: 35.68, zoom: 11.5, pitch: 55, bearing: -15 }
loop: { speed: 120, trail_seconds: 1500 }
```

| Key | Role |
|-----|------|
| `workflow:` | Gallery cue (`paper` / `deck` / `cinematic`) — printed by `--list-presets` |
| `engine:` | Default `--engine` for this preset (`minimal` or `deck`) |
| `use:` | One-line gallery blurb |

### `forms:` (Phase D — respected by viz-export)

| Form id | Effect when listed |
|---------|--------------------|
| `trail` / `trails` | Trajectories (always the HTML base layer) |
| `agents` | Embed followed `agents:` highlights |
| `pulse` | Embed `density_hourly` pulse (if built) |
| `buildings` | Embed baked `.bin` from `include.buildings` / `--buildings` |

- When `forms:` is **set**, it **gates** pulse / buildings / agents. Omitting
  `pulse` skips the heatmap even if `include.pulse: true`. Same for buildings
  and agents.
- When `forms:` is **absent**, legacy `include.*` + CLI flags apply unchanged.
- Unknown ids (e.g. `od-arcs`, `heatmap`) print a note and are skipped — those
  are live-dashboard forms, not export engines.
- `--no-pulse` always wins over `forms:` / `include.pulse`.

> Tokyo-night is a **PFLOW/lab** preset — point `TRAJECTORY_VIZ_PROFILE=pflow`
> (and `PFLOW_HOME`) or `TRAJECTORY_VIZ_DB` at a taxi-ingested DuckDB first.
> Prefer `demo-paper` / `demo-deck` with `demo/demo.duckdb` for out-of-box runs.

### `include.*`

- `include.buildings: <city>` embeds `output/viz/buildings/<city>.bin` if it
  exists (bake it first with `scripts/build_buildings.py`; skipped with a note
  otherwise). Only used when `forms:` includes `buildings` (or `forms:` is absent).
- `include.pulse: true` embeds the `density_hourly` aggregate if built
  (`python -m backend.ingest --aggregates-only`; skipped with a note otherwise).
  Gated by `forms:` the same way.

## Size budget

| Component | Typical |
|-----------|--------:|
| deck.gl UMD bundle (9.0.38, `--engine deck`) | ~1.2 MB |
| Canvas shell (`--engine minimal`) | ~few KB |
| 200–500 trails (paper preset) | ~0.1–0.5 MB |
| 2000 trajectories (Int16 delta-packed) | ~1–2 MB |
| pulse (24h × top cells) | ~0.3 MB |
| buildings (`.bin`, embedded verbatim) | ~0.5–1.5 MB |
| **paper (`demo-paper`, deck)** | **~1.2–1.5 MB** |
| **paper (`demo-paper`, minimal)** | **~0.1–0.4 MB** |
| **cinematic (tokyo-night, deck)** | **~4–7 MB** |
| **cinematic (tokyo-night, minimal)** | **~3–6 MB** (same data, no vendor) |

The exporter **warns** when the data block exceeds 4 MB and **fails** above an
8 MB total unless you pass `--force`. On failure the message lists shrink
options:

1. Lower `--n` / `sample_n` (try 200–500 for paper/deck)
2. Use `presets/demo-paper.yaml` (demo DB, trails-only)
3. Drop buildings (omit from `forms:` / no `--buildings`)
4. Skip pulse (`--no-pulse` or omit `pulse` from `forms:`)
5. Pass `--engine minimal` (drops the ~1.2 MB deck.gl vendor)
6. Pass `--force` to write anyway (may be slow to open in browsers)

### `--engine minimal` — lightweight Canvas shell

| Engine | Bundle | Visuals | Vendor fetch |
|--------|--------|---------|--------------|
| `deck` (default) | ~1.2 MB deck.gl UMD | Matches the live app (TripsLayer, 3D buildings, heatmap) | Required (`scripts/fetch_vendor.py`) |
| `minimal` | ~0 (Canvas 2D) | Trails + agents + flat buildings + pulse dots; drag-pan / scroll-zoom | **Not required** |

```bash
# demo-paper already defaults to minimal; this is explicit:
viz-export --preset presets/demo-paper.yaml --db demo/demo.duckdb \
           --engine minimal --out exports/demo-paper.html

# force deck.gl visuals on a paper-sized sample
viz-export --preset presets/demo-paper.yaml --db demo/demo.duckdb \
           --engine deck --out exports/demo-paper-deck.html
```

Use `minimal` when you need the HTML under the size gate (or mailed as a
lighter attachment) and can accept a simpler night-grid scene. Same packed
payload / Int16 encoding as `deck`; only the HTML shell changes. Size gate
still warns at 4 MB data and fails above 8 MB total unless `--force`.
CLI resolution: **`--engine` flag > preset `engine:` > `deck`**.

## Shareable dashboard URLs

The **live** UI (not the offline HTML) persists view state in the URL hash so
you can bookmark or paste a link. Use **Share link** in the filter panel
(copies the current URL) or copy the address bar. Encoding lives in
`frontend/src/filterHash.ts` (round-trip tests under
`frontend/src/__tests__/filter-encoding.test.ts`).

| Key | Meaning |
|-----|---------|
| `vt` | Source id filter (`source_id`; key name kept for bookmark stability) |
| `city`, `day` | City / simulation day |
| `minh`, `maxh` | Hour window |
| `gt` | Goods type |
| `ms`, `xs`, `xd`, `mr`, `xr` | F1 advanced filters (speed / dwell / detour) |
| `tm` / `ml` | Mode ints / canonical mode labels |
| `cb=tm` | Color by transport mode |
| `hs` | Hidden source ids (legend toggles) |
| `sc=p:w,s,e,n` | Pedestrianize scenario bbox |
| `ag` | Followed agent `vehicle_key`s |
| `pc` | Disabled POI categories |

Example: `http://localhost:8080/#vt=courier&minh=8&maxh=18&ag=courier%3Acourier-01`

Hash links need the same DuckDB + server the author used. For an offline file
you can mail, use `viz-export` instead.

## How it stays offline

- Coordinates are quantized to 1e-5° (~1.1 m) relative to a data-derived
  origin, first vertex Int32 then Int16 deltas, base64 in a `<script
  type="application/json">` block — same packing as the buildings `.bin`.
- `--engine deck` inlines deck.gl as a `<script>` with a dark `PolygonLayer`
  ground quad (no tile basemap). `--engine minimal` draws the same packed
  data on a Canvas 2D night grid — still zero tile requests.
- The only URLs in the file are in the attribution/license footer
  (PLATEAU/PFLOW). CI asserts this with a regex.
