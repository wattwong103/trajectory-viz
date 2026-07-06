# Single-HTML Cinematic Export

`viz-export` packs a filtered sample of trajectories — plus the animated pulse
heatmap, 3D buildings, and followed agents — with an inlined deck.gl bundle
into **one self-contained HTML file**. It has a dark ground plane instead of a
basemap, so it makes **zero network requests at runtime** and can be mailed to
anyone or dropped into a slide deck.

This is the article's "night grid" idea applied to PFLOW: send Sekimoto-lab or
a collaborator a single file, no server, no install.

## One-time setup

Fetch the deck.gl UMD bundle once per machine (the export itself never touches
the network):

```bash
# first run prints the SHA-256 and writes the bundle in --update mode
python scripts/fetch_vendor.py --update
# paste the printed hash into scripts/fetch_vendor.py (SHA256 = "..."), then:
python scripts/fetch_vendor.py        # verifies the pin
```

The bundle lands in `scripts/vendor/deck.gl.min.js` (gitignored; CI caches it).

## Export

```bash
# from a preset (recommended)
viz-export --preset presets/tokyo-night.yaml --out exports/tokyo-night.html

# ad-hoc
viz-export --vehicle-type taxi --city tokyo --simulation-day 0 \
           --n 2000 --agents taxi:tokyo:47 --out exports/taxi.html
```

Open the resulting HTML in any browser — play/pause, scrub the 24h clock,
change speed, toggle pulse and buildings. No server needed.

## Preset schema (`presets/*.yaml`)

```yaml
title: "Tokyo Taxi — One Night"
filters: { vehicle_type: taxi, city: tokyo, simulation_day: 0 }
sample_n: 2000                 # export exceeds the app's 500 cap on purpose:
agents: ["taxi:tokyo:47"]      #   static file, no per-frame fetch
include: { buildings: tokyo, pulse: true }
camera: { longitude: 139.76, latitude: 35.68, zoom: 11.5, pitch: 55, bearing: -15 }
loop: { speed: 120, trail_seconds: 1500 }
```

- `include.buildings: <city>` embeds `output/viz/buildings/<city>.bin` if it
  exists (bake it first with `scripts/build_buildings.py`; skipped with a note
  otherwise).
- `include.pulse: true` embeds the `density_hourly` aggregate if built
  (`python -m backend.ingest --aggregates-only`; skipped with a note otherwise).

## Size budget

| Component | Typical |
|-----------|--------:|
| deck.gl UMD bundle | ~3 MB |
| 2000 trajectories (Int16 delta-packed) | ~1–2 MB |
| pulse (24h × top cells) | ~0.3 MB |
| buildings (`.bin`, embedded verbatim) | ~0.5–1.5 MB |
| **total** | **~5–7 MB** |

The exporter **warns** when the data block exceeds 4 MB and **fails** above an
8 MB total unless you pass `--force`. To shrink: lower `--n`, drop
`--include-buildings`, or narrow the filters.

> The article's 4–5 MB target needs a hand-rolled WebGL engine; reusing deck.gl
> (so the export matches the app's exact visuals) costs ~3 MB of bundle. An
> `--engine minimal` flag is reserved for a future hand-rolled path.

## How it stays offline

- Coordinates are quantized to 1e-5° (~1.1 m) relative to a data-derived
  origin, first vertex Int32 then Int16 deltas, base64 in a `<script
  type="application/json">` block — same packing as the buildings `.bin`.
- deck.gl is inlined as a `<script>`; the scene uses a dark `PolygonLayer`
  ground quad, not a tile basemap, so there is no tile server to reach.
- The only URLs in the file are in the attribution/license footer
  (PLATEAU/PFLOW). CI asserts this with a regex.
