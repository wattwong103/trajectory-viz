# Product profiles

trajectory-viz ships **demo/universal** as the default product path
(`demo/sources.demo.yaml`). Lab and experiment packs live here as **opt-in
profiles** — they are not the default discovery path.

| Profile | Registry | When to use |
|---|---|---|
| `demo` (default) | [`../demo/sources.demo.yaml`](../demo/sources.demo.yaml) | Fresh clones, tutorials, CI smoke, any non-PFLOW dataset |
| `pflow` | [`pflow/sources.yaml`](pflow/sources.yaml) | Sekimoto-lab truck/taxi/person ABMs (goods, fare, mode_map, …) |
| `kichijoji` | [`pflow/sources.kichijoji.yaml`](pflow/sources.kichijoji.yaml) | Kichijōji pedestrian-superblock person packs |
| `gufm` | [`gufm/sources.yaml`](gufm/sources.yaml) | GUFM vs PFLOW ground-truth compare fleets |

## Opt in

```bash
# Lab PFLOW monorepo (Dropbox / PFLOW_HOME)
export TRAJECTORY_VIZ_PROFILE=pflow
export PFLOW_HOME=/path/to/PFLOW          # or rely on workspace / Dropbox once opted in
trajectory-viz-ingest --reset
# equivalent:
trajectory-viz-ingest --profile pflow --reset

# Explicit registry path (aliases TRAJECTORY_VIZ_SOURCES ≡ PFLOW_VIZ_SOURCES)
export TRAJECTORY_VIZ_SOURCES=$PWD/profiles/pflow/sources.yaml
```

Setting `PFLOW_HOME` alone also selects PFLOW-shaped DB/output defaults so
existing lab shells keep working. Unset profile + `PFLOW_HOME` → demo paths
(no silent Dropbox hijack).

GUFM launcher scripts (`start-gufm-viz.sh` / `.bat`) set sources/DB/output
explicitly and do not depend on the default profile.
