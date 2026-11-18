"""
Path resolution for trajectory-viz (Phase D: demo/universal defaults).

Out of the box the product points at the committed demo dataset under
``demo/`` — no Dropbox / PFLOW_HOME surprise. Lab workflows opt in via:

  - ``TRAJECTORY_VIZ_PROFILE=pflow`` (or ``kichijoji`` / ``gufm``), and/or
  - ``PFLOW_HOME`` / ``--pflow-home`` when using the PFLOW profile, and/or
  - explicit ``TRAJECTORY_VIZ_DB`` / ``PFLOW_VIZ_DB`` / ``*_SOURCES`` /
    ``*_OUTPUT_ROOT`` overrides (aliases kept for back-compat).

Standalone mode: set TRAJECTORY_VIZ_DB (or PFLOW_VIZ_DB) and the backend
never touches PFLOW_HOME.
"""

import os
from pathlib import Path

# This repo's root (backend/config.py -> repo). Tests point it into tmp_path.
_REPO_ROOT = Path(__file__).resolve().parents[1]
# A folder holding output/viz/ (where pflow.duckdb lives) is taken as the PFLOW
# workspace. Only consulted when the PFLOW profile (or explicit PFLOW_HOME)
# is opted in — never on the default demo path.
_WORKSPACE_MARKER = Path("output") / "viz"

# Lazy-resolved. Raises only if code actually needs PFLOW_HOME.
_pflow_home: Path | None = None
# Warn about a dangling PFLOW_HOME once per process. When neither the env
# path nor the fallback exists, resolution raises and nothing is cached, so
# without this flag every caller re-warns (CI saw one line per request).
_pflow_home_env_warned = False


def _find_enclosing_workspace(repo_root: Path) -> Path | None:
    """Return the nearest folder above repo_root that holds output/viz/, else None.

    The repo sits nested inside the PFLOW workspace, so its parent is the usual
    answer; walking further up also covers worktrees under .worktrees/<name>/.
    """
    for folder in repo_root.parents:
        if (folder / _WORKSPACE_MARKER).is_dir():
            return folder
    return None


def _wants_pflow_paths() -> bool:
    """True when path defaults should use the PFLOW monorepo layout.

    Opt-in signals (any one is enough):
      - TRAJECTORY_VIZ_PROFILE / PFLOW_VIZ_PROFILE in {pflow, kichijoji}
      - PFLOW_HOME set (lab shell already exports it)
    Explicit DB / OUTPUT_ROOT env vars short-circuit before this is consulted.
    """
    profile = (
        os.environ.get("TRAJECTORY_VIZ_PROFILE")
        or os.environ.get("PFLOW_VIZ_PROFILE")
        or ""
    ).strip().lower()
    if profile in ("pflow", "kichijoji"):
        return True
    if os.environ.get("PFLOW_HOME"):
        return True
    return False


def get_pflow_home() -> Path:
    """Resolve PFLOW project root directory (lazy + cached).

    Priority:
        1. PFLOW_HOME environment variable
        2. The nearest folder above this repo that holds output/viz/
        3. ~/Dropbox/PFLOW (default for the reference lab setup)

    Raises FileNotFoundError if none of the candidates exist.
    Only called when a PFLOW-shaped path is opted in (profile / PFLOW_HOME)
    and TRAJECTORY_VIZ_DB / PFLOW_VIZ_DB / OUTPUT_ROOT are not set.
    """
    global _pflow_home, _pflow_home_env_warned
    if _pflow_home is not None:
        return _pflow_home

    env = os.environ.get("PFLOW_HOME")
    if env:
        p = Path(env)
        if p.is_dir():
            _pflow_home = p
            return _pflow_home
        if not _pflow_home_env_warned:
            _pflow_home_env_warned = True
            print(f"[WARN] PFLOW_HOME={env} does not exist, falling back to auto-detect")

    workspace = _find_enclosing_workspace(_REPO_ROOT)
    if workspace is not None:
        _pflow_home = workspace
        return _pflow_home

    # Generic cross-platform default. Users on other disks/paths set PFLOW_HOME.
    candidates = [
        Path.home() / "Dropbox" / "PFLOW",
    ]

    for c in candidates:
        if c.is_dir():
            _pflow_home = c
            return _pflow_home

    raise FileNotFoundError(
        "Cannot locate PFLOW project root. "
        "Set PFLOW_HOME environment variable or ensure Dropbox is synced. "
        "For the default demo path, unset TRAJECTORY_VIZ_PROFILE / PFLOW_HOME "
        "and run `trajectory-viz-demo`. For standalone mode, set "
        "TRAJECTORY_VIZ_DB (or PFLOW_VIZ_DB) instead."
    )


def get_viz_db_path() -> Path:
    """Return the DuckDB database file path.

    Priority:
      1. TRAJECTORY_VIZ_DB env var (canonical standalone alias)
      2. PFLOW_VIZ_DB env var (legacy standalone alias — same semantics)
      3. PFLOW profile / PFLOW_HOME opted in → PFLOW_HOME/output/viz/pflow.duckdb
      4. Default (Phase D): <repo>/demo/demo.duckdb

    In standalone mode (either DB env set), the backend serves from
    wherever that path points and never touches PFLOW_HOME.
    """
    env = os.environ.get("TRAJECTORY_VIZ_DB") or os.environ.get("PFLOW_VIZ_DB")
    if env:
        p = Path(env)
        p.parent.mkdir(parents=True, exist_ok=True)
        return p
    if _wants_pflow_paths():
        db_dir = get_pflow_home() / "output" / "viz"
        db_dir.mkdir(parents=True, exist_ok=True)
        return db_dir / "pflow.duckdb"
    # Phase D default — committed demo dataset path (created on first ingest).
    demo_db = _REPO_ROOT / "demo" / "demo.duckdb"
    demo_db.parent.mkdir(parents=True, exist_ok=True)
    return demo_db


def get_output_root() -> Path:
    """Return the output root — where ingest scans for trips/ and trajectory/.

    Priority:
      1. TRAJECTORY_VIZ_OUTPUT_ROOT env var (canonical)
      2. PFLOW_VIZ_OUTPUT_ROOT env var (legacy alias)
      3. PFLOW profile / PFLOW_HOME opted in → PFLOW_HOME/output
      4. Default (Phase D): <repo>/demo
    """
    env = (
        os.environ.get("TRAJECTORY_VIZ_OUTPUT_ROOT")
        or os.environ.get("PFLOW_VIZ_OUTPUT_ROOT")
    )
    if env:
        return Path(env)
    if _wants_pflow_paths():
        return get_pflow_home() / "output"
    return _REPO_ROOT / "demo"


def get_output_dir() -> Path:
    """Alias for get_output_root() — retained for back-compat."""
    return get_output_root()


# Base date anchor used in VehicleTrajectoryGenerator.java: 2020-10-01 00:00:00
# JST = 1601478000 seconds since epoch (UTC+9). Waypoint unix_time_ms values
# convert to seconds-from-midnight via (unix_time_ms/1000 - BASE_EPOCH_SEC) % 86400.
# Shared by routers/trajectories.py (animation timestamps) and
# ingest.build_density_hourly (pulse-heatmap hour buckets) — the two MUST agree
# or the pulse would be offset from the trails.
BASE_EPOCH_SEC = 1601478000


def get_buildings_dir() -> Path:
    """Directory of baked per-city building binaries (Phase 2C).

    Priority:
      1. PFLOW_VIZ_BUILDINGS_DIR env var
      2. <viz db dir>/buildings — sits next to pflow.duckdb, so Docker's
         /data volume mount picks both up together.
    """
    env = os.environ.get("PFLOW_VIZ_BUILDINGS_DIR")
    if env:
        return Path(env)
    return get_viz_db_path().parent / "buildings"


def uploads_dir() -> Path:
    """Staging directory for uploaded trajectory files (upload-and-go).

    Priority:
      1. PFLOW_VIZ_UPLOADS_DIR env var
      2. <viz db dir>/uploads — next to the DB, so a Docker /data volume
         picks uploads up together with the database.
    Created lazily on first call.
    """
    env = os.environ.get("PFLOW_VIZ_UPLOADS_DIR")
    p = Path(env) if env else get_viz_db_path().parent / "uploads"
    p.mkdir(parents=True, exist_ok=True)
    return p


def uploads_registry_path() -> Path:
    """Path of the auto-generated uploads registry (sources.uploads.yaml).

    Lives next to the DB — the user's hand-written sources.yaml is never
    mutated by uploads; style/POI lookups merge this file in at read time.
    """
    return get_viz_db_path().parent / "sources.uploads.yaml"
