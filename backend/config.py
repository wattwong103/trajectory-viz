"""
PFLOW_HOME resolution — mirrors Java's PathResolver.java logic.

Auto-detects the PFLOW project root based on OS conventions,
with PFLOW_HOME env var override.

Standalone mode: set PFLOW_VIZ_DB (and optionally PFLOW_VIZ_OUTPUT_ROOT)
to run without the PFLOW monorepo. PFLOW_HOME is never touched in that case.
"""

import os
from pathlib import Path

# Lazy-resolved. Raises only if code actually needs PFLOW_HOME.
_pflow_home: Path | None = None


def get_pflow_home() -> Path:
    """Resolve PFLOW project root directory (lazy + cached).

    Priority:
        1. PFLOW_HOME environment variable
        2. ~/Dropbox/PFLOW (default for the reference setup)

    Raises FileNotFoundError if none of the candidates exist.
    Only called when PFLOW_VIZ_DB / PFLOW_VIZ_OUTPUT_ROOT are not set.
    """
    global _pflow_home
    if _pflow_home is not None:
        return _pflow_home

    env = os.environ.get("PFLOW_HOME")
    if env:
        p = Path(env)
        if p.is_dir():
            _pflow_home = p
            return _pflow_home
        print(f"[WARN] PFLOW_HOME={env} does not exist, falling back to auto-detect")

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
        "For standalone mode, set PFLOW_VIZ_DB instead."
    )


def get_viz_db_path() -> Path:
    """Return the DuckDB database file path.

    Priority:
      1. PFLOW_VIZ_DB env var (absolute path to .duckdb file)
      2. PFLOW_HOME/output/viz/pflow.duckdb (monorepo mode)

    In standalone mode (PFLOW_VIZ_DB set), the backend serves from
    wherever that path points and never touches PFLOW_HOME.
    """
    env = os.environ.get("PFLOW_VIZ_DB")
    if env:
        p = Path(env)
        p.parent.mkdir(parents=True, exist_ok=True)
        return p
    # Fall through to monorepo mode
    db_dir = get_pflow_home() / "output" / "viz"
    db_dir.mkdir(parents=True, exist_ok=True)
    return db_dir / "pflow.duckdb"


def get_output_root() -> Path:
    """Return the output root — where ingest scans for trips/ and trajectory/.

    Priority:
      1. PFLOW_VIZ_OUTPUT_ROOT env var
      2. PFLOW_HOME/output (monorepo mode)
    """
    env = os.environ.get("PFLOW_VIZ_OUTPUT_ROOT")
    if env:
        return Path(env)
    return get_pflow_home() / "output"


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
