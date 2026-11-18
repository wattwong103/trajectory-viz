# Export preset gallery

Presets are YAML recipes for [`viz-export`](../docs/EXPORT.md). Each declares
Phase D `forms:` so the exporter only bakes what you ask for, plus optional
`workflow:` / `engine:` / `use:` cues for the paper · deck · cinematic paths.

| Preset | Workflow | Engine (default) | Forms | Typical size | Use |
|--------|----------|------------------|-------|-------------:|-----|
| [`demo-paper.yaml`](demo-paper.yaml) | paper | **minimal** | trail | ~0.1–0.4 MB | Paper figures, email, light attachment |
| [`demo-deck.yaml`](demo-deck.yaml) | deck | deck | trail, agents, pulse | ~1.2–1.5 MB | Richer slide / collaborator hand-off |
| [`tokyo-night.yaml`](tokyo-night.yaml) | cinematic | deck | trail, agents, pulse, buildings | ~4–7 MB | Lab night scene (needs taxi DB) |

CLI listing (same table, machine-readable from YAML):

```bash
viz-export --list-presets
```

## Choose a share path

| Goal | Path |
|------|------|
| Bookmark / paste a live view | Copy the dashboard URL (hash keys) — **Share link** in the UI |
| Mail a small offline HTML | `demo-paper` (minimal engine; no vendor) |
| Offline scene closer to the app | `demo-deck` or `--engine deck` |
| Full cinematic (lab) | `tokyo-night` + PFLOW/taxi DuckDB |

Live share links need the same DuckDB + server. Offline HTML does not.

## Quick path (demo → paper HTML)

```bash
pip install -e .
trajectory-viz-demo --ensure

# paper (default engine:minimal — no vendor fetch)
viz-export --preset presets/demo-paper.yaml --db demo/demo.duckdb \
           --out exports/demo-paper.html

# deck visuals on the same preset
viz-export --preset presets/demo-paper.yaml --db demo/demo.duckdb \
           --engine deck --out exports/demo-paper-deck.html
# ↑ --engine deck needs: python scripts/fetch_vendor.py  (once)
```

Open the HTML in any browser — no server, no network.

## Preset metadata

| Key | Meaning |
|-----|---------|
| `workflow:` | Cue: `paper` · `deck` · `cinematic` (docs / `--list-presets`) |
| `engine:` | Default render engine (`minimal` or `deck`). CLI `--engine` overrides. |
| `use:` | One-line gallery blurb |
| `forms:` | Phase D bake gate (see below) |

## `forms:` contract

Bakeable today: `trail` / `trails`, `agents`, `pulse`, `buildings`.

- When `forms:` is **set**, it gates pulse / buildings / agents (and notes any
  include.* that would have baked something omitted).
- When `forms:` is **absent**, legacy `include.*` + CLI flags apply unchanged.
- Other viz-form ids (`od-arcs`, `heatmap`, …) print a note and are skipped —
  they are live-dashboard forms, not export engines.

`--engine minimal` drops the deck.gl vendor (Canvas 2D shell). Paper presets
default to it; deck / cinematic presets default to `--engine deck`. See
[`docs/EXPORT.md`](../docs/EXPORT.md).
