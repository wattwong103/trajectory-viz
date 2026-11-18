# Export preset gallery

Presets are YAML recipes for [`viz-export`](../docs/EXPORT.md). Each declares
Phase D `forms:` so the exporter only bakes what you ask for.

| Preset | DB | Forms | Typical size | Use |
|--------|----|-------|-------------:|-----|
| [`demo-paper.yaml`](demo-paper.yaml) | `demo/demo.duckdb` | trail | ~1.2–1.5 MB | Paper figures, email, minimal deck slide |
| [`demo-deck.yaml`](demo-deck.yaml) | `demo/demo.duckdb` | trail, agents, pulse | ~1.2–1.5 MB | Richer slide / collaborator hand-off |
| [`tokyo-night.yaml`](tokyo-night.yaml) | PFLOW/lab taxi DB | trail, agents, pulse, buildings | ~4–7 MB | Cinematic night scene (lab) |

## Quick path (demo → HTML)

```bash
pip install -e .
trajectory-viz-demo --ensure
python scripts/fetch_vendor.py            # once per machine; verifies pinned SHA

viz-export --preset presets/demo-paper.yaml --db demo/demo.duckdb \
           --out exports/demo-paper.html
```

Open the HTML in any browser — no server, no network.

## `forms:` contract

Bakeable today: `trail` / `trails`, `agents`, `pulse`, `buildings`.

- When `forms:` is **set**, it gates pulse / buildings / agents (and notes any
  include.* that would have baked something omitted).
- When `forms:` is **absent**, legacy `include.*` + CLI flags apply unchanged.
- Other viz-form ids (`od-arcs`, `heatmap`, …) print a note and are skipped —
  they are live-dashboard forms, not export engines.

`--engine minimal` is **reserved / unimplemented**; use the default deck.gl
engine and a small preset (above) when you need a lighter file.
