"""TV-6 — scale & correctness CI fixtures (no live PFLOW).

Locks end-to-end contracts against tiny dual-fleet CSVs under
``tests/fixtures/scale/``:

1. Micro vs macro ``capabilities.scale`` + form defaults
2. ``agent_key`` / ``vehicle_key`` join invariants (colliding bare vehicle_id)
3. ``density_hourly`` / pulse only when the aggregate is built
4. Documented mega-sim / LOD thresholds + sample clamp
5. Cheap pedestrianize scenario-impact sanity
"""

from __future__ import annotations

import sys
from pathlib import Path

import duckdb
import pytest
from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import backend.db  # noqa: E402
import backend.lod as lod  # noqa: E402
from backend.app import app  # noqa: E402
from backend.db import _init_schema  # noqa: E402
from backend.ingest import (  # noqa: E402
    build_density_hourly,
    ingest_source_trajectories,
    ingest_source_trips,
)
from backend.sources_schema import load_sources  # noqa: E402

SCALE_FIXTURES = Path(__file__).resolve().parent / "fixtures" / "scale"
MICRO_SOURCES = SCALE_FIXTURES / "sources.micro.yaml"
MACRO_SOURCES = SCALE_FIXTURES / "sources.macro.yaml"

# Bbox covering fleet_a mid-point only (not fleet_b).
FLEET_A_BBOX = {"w": 139.702, "s": 35.682, "e": 139.708, "n": 35.688}


def _ingest_scale_fixture(conn: duckdb.DuckDBPyConnection, sources_path: Path) -> None:
    """Load both fleets from CSV fixtures into an empty schema."""
    _init_schema(conn)
    sf = load_sources(sources_path)
    for key, src in sf.sources.items():
        fleet_dir = SCALE_FIXTURES / src.source_id
        assert fleet_dir.is_dir(), f"missing fixture dir {fleet_dir}"
        n_trips = ingest_source_trips(conn, fleet_dir / "trips.csv", key, src)
        n_wp = ingest_source_trajectories(conn, fleet_dir / "waypoints.csv", key, src)
        assert n_trips >= 1, f"{key}: expected trips"
        assert n_wp >= 1, f"{key}: expected waypoints"


@pytest.fixture
def scale_db(tmp_path_factory):
    """Fresh in-memory DB per test (density / threshold monkeypatches mutate)."""
    conn = duckdb.connect(":memory:")
    _ingest_scale_fixture(conn, MICRO_SOURCES)
    yield conn
    conn.close()


@pytest.fixture
def client(scale_db, monkeypatch):
    monkeypatch.setattr(backend.db, "_connection", scale_db)
    monkeypatch.setenv("TRAJECTORY_VIZ_SOURCES", str(MICRO_SOURCES))
    return TestClient(app)


# ── 1. Micro vs macro scale detection / defaults ───────────────────────────


def test_micro_capabilities_scale_and_defaults(client):
    body = client.get("/api/stats/filter-options").json()
    caps = body["capabilities"]
    assert caps["scale"] == "micro"
    assert caps["scale_source"] == "config"
    assert caps["mega_sim"] is False
    assert caps["agent_count"] == 2
    assert caps["trip_count"] == 2
    assert caps["waypoint_count"] == 6
    assert caps["recommended_default_forms"] == ["trails", "agents"]
    assert caps["trails_default"] is True
    assert caps["form_defaults"]["trails"] is True
    assert caps["form_defaults"]["agents"] is True
    assert caps["form_defaults"]["arcs"] is False
    assert caps["form_defaults"]["pulse"] is False
    assert caps["lod"]["aggregate_first"] is False
    assert caps["agent_key_column"] == "vehicle_key"


def test_macro_override_forces_arcs_pulse_defaults(scale_db, monkeypatch):
    """Tiny N + sources.yaml scale: macro → capabilities look like mega-sim."""
    monkeypatch.setattr(backend.db, "_connection", scale_db)
    monkeypatch.setenv("TRAJECTORY_VIZ_SOURCES", str(MACRO_SOURCES))
    client = TestClient(app)
    caps = client.get("/api/stats/filter-options").json()["capabilities"]
    assert caps["scale"] == "macro"
    assert caps["scale_source"] == "config"
    assert caps["mega_sim"] is True
    assert caps["recommended_default_forms"] == ["arcs", "pulse"]
    assert caps["trails_default"] is False
    assert caps["form_defaults"]["arcs"] is True
    assert caps["form_defaults"]["pulse"] is True
    assert caps["lod"]["aggregate_first"] is True
    assert caps["lod"]["trajectory_sample_cap"] == lod.TRAJECTORY_RENDER_CAP


def test_auto_detect_micro_without_config_scale(scale_db, monkeypatch, tmp_path):
    """Dropping top-level scale: still auto-detects micro for this tiny pack."""
    yaml_text = MICRO_SOURCES.read_text(encoding="utf-8")
    yaml_text = yaml_text.replace("scale: micro\n", "", 1)
    auto_path = tmp_path / "sources.auto.yaml"
    auto_path.write_text(yaml_text, encoding="utf-8")
    monkeypatch.setattr(backend.db, "_connection", scale_db)
    monkeypatch.setenv("TRAJECTORY_VIZ_SOURCES", str(auto_path))
    caps = TestClient(app).get("/api/stats/filter-options").json()["capabilities"]
    assert caps["scale"] == "micro"
    assert caps["scale_source"] == "auto"
    assert caps["mega_sim"] is False


# ── 2. agent_key / vehicle_key join invariants ─────────────────────────────


def test_vehicle_keys_distinct_despite_colliding_vehicle_id(scale_db):
    rows = scale_db.execute(
        "SELECT vehicle_id, vehicle_key, source_id FROM trips ORDER BY vehicle_key"
    ).fetchall()
    assert len(rows) == 2
    assert rows[0][0] == rows[1][0] == 1  # bare vehicle_id collides
    assert {r[1] for r in rows} == {"fleet_a:1", "fleet_b:1"}
    # Waypoint join identity matches trips on vehicle_key, not vehicle_id alone.
    orphans = scale_db.execute("""
        SELECT COUNT(*) FROM waypoints w
        WHERE NOT EXISTS (
            SELECT 1 FROM trips t
            WHERE t.vehicle_key = w.vehicle_key AND t.trip_id = w.trip_id
        )
    """).fetchone()[0]
    assert orphans == 0


def test_through_zone_bbox_joins_on_vehicle_key_not_vehicle_id(client):
    """fleet_a mid-point bbox must not pull fleet_b via colliding vehicle_id=1."""
    r = client.get("/api/analysis/trip-chains/through-zone-bbox", params=FLEET_A_BBOX)
    assert r.status_code == 200
    trips = r.json()["trips"]
    assert len(trips) == 1
    assert trips[0]["vehicle_id"] == 1
    assert trips[0]["vehicle_type"] == "fleet_a"

    # Filtering to fleet_b under the same bbox: a bare (vehicle_id, trip_id)
    # join would incorrectly attach fleet_a's in-bbox waypoints to fleet_b's
    # trip 1. vehicle_key scoping must yield zero.
    colliding = client.get(
        "/api/analysis/trip-chains/through-zone-bbox",
        params={**FLEET_A_BBOX, "source_id": "fleet_b"},
    )
    assert colliding.status_code == 200
    assert colliding.json()["trips"] == []


def test_by_vehicle_scoped_to_agent_key(client):
    body = client.get(
        "/api/trajectories/by-vehicle",
        params={"vehicle_keys": "fleet_a:1"},
    ).json()
    assert body["count"] == 1
    meta = body["trajectories"][0]["metadata"]
    assert meta["vehicle_key"] == "fleet_a:1"
    assert meta["vehicle_id"] == 1


# ── 3. density_hourly / pulse only when flagged ────────────────────────────


def test_pulse_gated_until_density_hourly_built(client, scale_db):
    caps = client.get("/api/stats/filter-options").json()["capabilities"]
    assert caps["has_density_hourly"] is False
    # Micro: soft "optional" disable copy until the aggregate exists.
    assert "pulse" in caps["form_disable_reasons"]
    assert "optional" in caps["form_disable_reasons"]["pulse"].lower()

    r = client.get("/api/analysis/spatial/density-hourly")
    assert r.status_code == 409
    assert "--aggregates-only" in r.json()["detail"]

    n = build_density_hourly(scale_db)
    assert n > 0

    caps2 = client.get("/api/stats/filter-options").json()["capabilities"]
    assert caps2["has_density_hourly"] is True
    assert "pulse" not in caps2.get("form_disable_reasons", {})

    ok = client.get("/api/analysis/spatial/density-hourly")
    assert ok.status_code == 200
    body = ok.json()
    assert len(body["hours"]) == 24
    total_weight = sum(p["weight"] for h in body["hours"] for p in h["points"])
    assert total_weight == 6  # 3 + 3 waypoints


def test_macro_pulse_fixit_when_density_missing(scale_db, monkeypatch):
    monkeypatch.setattr(backend.db, "_connection", scale_db)
    monkeypatch.setenv("TRAJECTORY_VIZ_SOURCES", str(MACRO_SOURCES))
    caps = TestClient(app).get("/api/stats/filter-options").json()["capabilities"]
    assert caps["has_density_hourly"] is False
    assert any("density_hourly" in tip for tip in caps["fix_its"])
    assert "pulse" in caps["form_disable_reasons"]
    assert "aggregates-only" in caps["form_disable_reasons"]["pulse"]


# ── 4. mega_sim / LOD thresholds as documented ─────────────────────────────


def test_documented_lod_thresholds():
    """ARCHITECTURE.md / DATA_FORMATS.md numbers must stay wired in lod.py."""
    assert lod.MICRO_AGENT_MAX == 10_000
    assert lod.MICRO_WAYPOINT_MAX == 1_000_000
    assert lod.MEGA_AGENT_THRESHOLD == 1_000_000
    assert lod.MEGA_WAYPOINT_THRESHOLD == 10_000_000
    assert lod.TRAJECTORY_RENDER_CAP == 500
    assert lod.detect_scale(50, 5_000) == (lod.SCALE_MICRO, "auto")
    assert lod.detect_scale(lod.MICRO_AGENT_MAX, 50_000) == (lod.SCALE_MESO, "auto")
    assert lod.detect_scale(lod.MEGA_AGENT_THRESHOLD, 0) == (lod.SCALE_MACRO, "auto")
    assert lod.detect_scale(0, lod.MEGA_WAYPOINT_THRESHOLD) == (lod.SCALE_MACRO, "auto")


def test_trajectory_sample_clamps_when_mega_threshold_hit(client, monkeypatch):
    """Lower agent threshold so the 2-agent fixture trips mega sample clamp."""
    monkeypatch.setattr(lod, "MEGA_AGENT_THRESHOLD", 2)
    r = client.get("/api/trajectories/sample", params={"n": 5000})
    assert r.status_code == 200
    body = r.json()
    assert body["capped"] is True
    assert body["sample_cap"] == lod.TRAJECTORY_RENDER_CAP
    assert body["count"] <= lod.TRAJECTORY_RENDER_CAP


def test_capabilities_lod_block_exposes_thresholds(client):
    caps = client.get("/api/stats/filter-options").json()["capabilities"]
    assert caps["lod"]["agent_threshold"] == lod.MEGA_AGENT_THRESHOLD
    assert caps["lod"]["waypoint_threshold"] == lod.MEGA_WAYPOINT_THRESHOLD
    assert caps["lod"]["micro_agent_max"] == lod.MICRO_AGENT_MAX
    assert caps["lod"]["micro_waypoint_max"] == lod.MICRO_WAYPOINT_MAX
    assert caps["lod"]["trajectory_sample_cap"] == lod.TRAJECTORY_API_MAX  # non-macro


# ── 5. Scenario-impact sanity (cheap) ──────────────────────────────────────


def test_scenario_impact_excludes_car_in_bbox(client):
    """fleet_a car path enters FLEET_A_BBOX → excluded_trips == 1."""
    r = client.get(
        "/api/stats/scenario-impact",
        params={
            "scenario": "pedestrianize",
            "sc_w": FLEET_A_BBOX["w"],
            "sc_s": FLEET_A_BBOX["s"],
            "sc_e": FLEET_A_BBOX["e"],
            "sc_n": FLEET_A_BBOX["n"],
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["excluded_trips"] == 1
    assert body["excluded_mode"] == 3
    assert body["excluded_vkt_km"] == pytest.approx(1.2)

    # fleet_b walk trip is outside the bbox → still present under scenario.
    with_sc = client.get(
        "/api/trips/sample",
        params={
            "n": 50,
            "scenario": "pedestrianize",
            "sc_w": FLEET_A_BBOX["w"],
            "sc_s": FLEET_A_BBOX["s"],
            "sc_e": FLEET_A_BBOX["e"],
            "sc_n": FLEET_A_BBOX["n"],
        },
    )
    assert with_sc.status_code == 200
    types = {t["vehicle_type"] for t in with_sc.json()["trips"]}
    assert "fleet_b" in types
    assert "fleet_a" not in types


def test_scale_fixture_sources_yaml_validates():
    """Registries stay parseable under the live schema (CI also validates)."""
    from backend.sources_schema import SourcesFile

    for path in (MICRO_SOURCES, MACRO_SOURCES):
        sf = load_sources(path)
        assert isinstance(sf, SourcesFile)
        assert set(sf.sources) == {"scale-fleet-a", "scale-fleet-b"}
