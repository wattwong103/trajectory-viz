"""Universal-trajectory-support Phase 2 — end-to-end demo dataset tests.

Slow-marked: runs the real demo ingest path (backend.demo.run_demo →
backend.ingest.main) into a temp DuckDB, then asserts both the DB contents
(gap-split synthesis produced ≥2 trips for at least one courier) and the API
surface (/api/pois categories, /api/stats) served from that DB.

The module fixture cleans up the backend.db singleton and the PFLOW_VIZ_* env
vars afterwards so other tests in the same session are unaffected.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import backend.db  # noqa: E402 — singleton we reset in teardown
import backend.demo  # noqa: E402
from backend.app import app  # noqa: E402

pytestmark = pytest.mark.slow

_DEMO_ENV_KEYS = ("PFLOW_VIZ_DB", "PFLOW_VIZ_SOURCES", "PFLOW_VIZ_OUTPUT_ROOT")


@pytest.fixture(scope="module")
def demo_run(tmp_path_factory):
    db_path = tmp_path_factory.mktemp("demo-db") / "demo.duckdb"
    counts = backend.demo.run_demo(db_path, reset=True)
    yield db_path, counts
    # Teardown: release the singleton connection and demo env vars so
    # subsequent test modules see a pristine environment.
    if backend.db._connection is not None:
        backend.db._connection.close()
        backend.db._connection = None
    for key in _DEMO_ENV_KEYS:
        os.environ.pop(key, None)


def test_demo_summary_counts(demo_run):
    _, counts = demo_run
    assert counts["trips"] > 0
    assert counts["waypoints"] > 0
    assert counts["pois"] > 0


def test_demo_gap_split_yields_multiple_trips_per_courier(demo_run):
    """Each courier's >25 min lunch break must split into ≥2 trips under
    gap_split(gap_minutes=20) — at least one courier must show it."""
    conn = backend.db.get_connection()
    max_trips = conn.execute("""
        SELECT MAX(n) FROM (
            SELECT COUNT(*) AS n FROM trips
            WHERE source_id = 'courier' GROUP BY vehicle_key
        )
    """).fetchone()[0]
    assert max_trips is not None and max_trips >= 2


def test_demo_both_sources_ingested(demo_run):
    conn = backend.db.get_connection()
    by_source = dict(conn.execute(
        "SELECT source_id, COUNT(*) FROM waypoints GROUP BY source_id"
    ).fetchall())
    assert by_source.get("courier", 0) > 0
    assert by_source.get("bus", 0) > 0


def test_demo_pois_three_categories(demo_run):
    client = TestClient(app)
    r = client.get("/api/pois")
    assert r.status_code == 200
    body = r.json()
    categories = {p["category"] for p in body["pois"]}
    assert categories == {"station", "mall", "park"}


def test_demo_stats_non_empty(demo_run):
    client = TestClient(app)
    r = client.get("/api/stats")
    assert r.status_code == 200
    body = r.json()
    assert body["trips"]["row_count"] > 0
    assert body["waypoints"]["row_count"] > 0
    assert body["has_trajectories"] is True
