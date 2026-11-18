#!/usr/bin/env python3
"""One-command MATSim + SUMO lab first view.

Converts the tiny adapter fixtures → demo/abm/ tabular outputs, ingests into
demo/abm.duckdb, and prints (or runs) the open-viz step.

No new FormatType — reuses scripts/matsim_events_to_csv.py and
scripts/sumo_fcd_to_ndjson.py plus demo/abm/sources.yaml.

Usage (from repo root, after ``pip install -e .``):

  python scripts/lab_abm_demo.py              # convert + ingest
  python scripts/lab_abm_demo.py --serve      # then API on :9999
  python scripts/lab_abm_demo.py --skip-convert  # reuse committed CSVs
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

# 2024-06-01T00:00:00+09:00 — must match demo/abm/sources.yaml time.epoch_anchor.
DEMO_EPOCH_MS = 1_717_167_600_000
ABM_DIR = REPO / "demo" / "abm"
SOURCES = ABM_DIR / "sources.yaml"
FIXTURES = REPO / "tests" / "fixtures" / "adapters"
# Also refresh CI golden output_root so docs/CI stay in lockstep.
CI_OUTPUT_ROOT = FIXTURES / "output_root"


def _load_script(name: str):
    path = REPO / "scripts" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def convert_seed(*, also_ci: bool = True) -> dict[str, int]:
    """Write MATSim CSV + SUMO CSV under demo/abm/ (and optionally CI output_root)."""
    matsim = _load_script("matsim_events_to_csv")
    sumo = _load_script("sumo_fcd_to_ndjson")

    targets = [ABM_DIR]
    if also_ci:
        targets.append(CI_OUTPUT_ROOT)

    counts: dict[str, int] = {}
    for root in targets:
        matsim_out = root / "matsim" / "berlin" / "iter_001"
        n_trips, n_geo = matsim.convert(
            FIXTURES / "matsim_events_tiny.xml",
            matsim_out,
            FIXTURES / "matsim_network_tiny.xml",
            epoch_ms=DEMO_EPOCH_MS,
        )
        sumo_out = root / "sumo" / "demo" / "fcd.csv"
        n_sumo = sumo.convert(
            FIXTURES / "sumo_fcd_tiny.xml",
            sumo_out,
            epoch_ms=DEMO_EPOCH_MS,
            fmt="csv",
        )
        # Keep NDJSON twin for the example YAML fallback path (CI only).
        if root is CI_OUTPUT_ROOT:
            sumo.convert(
                FIXTURES / "sumo_fcd_tiny.xml",
                root / "sumo" / "demo" / "fcd.ndjson",
                epoch_ms=DEMO_EPOCH_MS,
                fmt="ndjson",
            )
        label = "demo/abm" if root is ABM_DIR else "ci fixtures"
        print(f"[lab-abm] {label}: {n_trips} MATSim trips, {n_geo} geo, {n_sumo} SUMO pings")
        if root is ABM_DIR:
            counts = {"matsim_trips": n_trips, "matsim_geo": n_geo, "sumo_pings": n_sumo}
    return counts


def ingest_abm(*, reset: bool = True, db_path: Path | None = None) -> dict[str, int]:
    """Ingest demo/abm via the real trajectory-viz-ingest CLI wiring."""
    from backend import ingest as _ingest
    import backend.db as _db

    db_path = Path(db_path or (ABM_DIR / "abm.duckdb"))
    env = {
        "TRAJECTORY_VIZ_DB": str(db_path),
        "TRAJECTORY_VIZ_SOURCES": str(SOURCES),
        "TRAJECTORY_VIZ_OUTPUT_ROOT": str(ABM_DIR),
        "PFLOW_VIZ_DB": str(db_path),
        "PFLOW_VIZ_SOURCES": str(SOURCES),
        "PFLOW_VIZ_OUTPUT_ROOT": str(ABM_DIR),
    }
    os.environ.update(env)

    if _db._connection is not None:
        _db._connection.close()
        _db._connection = None

    argv = ["trajectory-viz-ingest"]
    if reset or not db_path.is_file():
        argv.append("--reset")
    saved = sys.argv
    sys.argv = argv
    try:
        _ingest.main()
    except SystemExit as e:
        if e.code not in (0, None):
            raise RuntimeError(f"lab ABM ingest failed (exit {e.code})") from e
    finally:
        sys.argv = saved

    from backend.db import get_connection

    conn = get_connection()
    return {
        "trips": int(conn.execute("SELECT COUNT(*) FROM trips").fetchone()[0]),
        "waypoints": int(conn.execute("SELECT COUNT(*) FROM waypoints").fetchone()[0]),
        "sources": int(
            conn.execute("SELECT COUNT(DISTINCT source_id) FROM trips").fetchone()[0]
        ),
    }


def _print_summary(counts: dict[str, int], db_path: Path) -> None:
    print()
    print("=" * 64)
    print("  trajectory-viz lab ABM demo — ready")
    print("=" * 64)
    print(f"  Trips:      {counts['trips']:>6,}  (MATSim car/walk + SUMO gap-split)")
    print(f"  Waypoints:  {counts['waypoints']:>6,}")
    print(f"  Sources:    {counts['sources']:>6,}  (expect matsim + sumo)")
    print(f"  Database:   {db_path}")
    print(f"  Registry:   {SOURCES}")


def _print_next_steps(db_path: Path) -> None:
    print()
    print("  Open the map (pick one):")
    print("    • Native HMR:")
    print(
        f"        PFLOW_VIZ_DB={db_path} \\"
    )
    print(
        f"        PFLOW_VIZ_SOURCES={SOURCES} \\"
    )
    print(
        f"        PFLOW_VIZ_OUTPUT_ROOT={ABM_DIR} \\"
    )
    print("          npm run --prefix frontend dev")
    print("          → http://localhost:5173")
    print("    • API + built UI:")
    print("        cd frontend && npm run build && cd ..")
    print("        python scripts/lab_abm_demo.py --serve")
    print("          → http://127.0.0.1:9999")
    print("    • Your own MATSim/SUMO XML: see docs/QUICKSTART.md Path L")
    print()


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--skip-convert",
        action="store_true",
        help="Reuse committed demo/abm CSVs (skip XML→tabular).",
    )
    p.add_argument(
        "--no-ci-refresh",
        action="store_true",
        help="Do not rewrite tests/fixtures/adapters/output_root when converting.",
    )
    p.add_argument("--reset", action="store_true", default=True)
    p.add_argument(
        "--db-path",
        type=Path,
        default=None,
        help="DuckDB path (default: demo/abm/abm.duckdb).",
    )
    p.add_argument(
        "--serve",
        action="store_true",
        help="Start uvicorn on 127.0.0.1:9999 after ingest.",
    )
    p.add_argument(
        "--convert-only",
        action="store_true",
        help="Only regenerate tabular seeds; skip ingest.",
    )
    args = p.parse_args()

    if not SOURCES.is_file():
        raise SystemExit(f"Missing {SOURCES} — are you in the trajectory-viz repo?")

    if not args.skip_convert:
        convert_seed(also_ci=not args.no_ci_refresh)
    else:
        print("[lab-abm] skipping convert — using committed demo/abm CSVs")

    if args.convert_only:
        return

    db_path = Path(args.db_path or (ABM_DIR / "abm.duckdb"))
    counts = ingest_abm(reset=True, db_path=db_path)
    _print_summary(counts, db_path)

    if args.serve:
        print()
        print("  Serving lab ABM — open http://127.0.0.1:9999 (Ctrl+C to stop)")
        from backend.app import serve

        serve()
    else:
        _print_next_steps(db_path)


if __name__ == "__main__":
    main()
