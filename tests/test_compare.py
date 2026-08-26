"""Fleet-comparison — /api/analysis/compare tests.

Session-scoped in-memory DuckDB (read-only endpoint) with two fleets,
'gufm' and 'pflow', mirroring the real workflow: overlapping vehicle_ids
(persons 1-3), a gufm-only person (4), a pflow-only person (5), one
out-of-range dep_hour (-2, as in the real GUFM DB), and two transport
modes. Singleton monkey-patched, TestClient pattern as in test_pois.py.
"""

from __future__ import annotations

import sys
from pathlib import Path

import duckdb
import pytest
from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import backend.db  # noqa: E402 — we monkey-patch its singleton
from backend.app import app  # noqa: E402
from backend.db import _init_schema  # noqa: E402

# (vehicle_id, dep_hour, transport_mode, distance_km)
_GUFM_ROWS = [
    (1, 8, 4, 5.0),
    (1, 9, 4, 10.0),
    (1, 10, 4, 15.0),
    (2, 8, 4, 2.0),
    (2, 12, 4, 3.0),
    (3, 7, 3, 20.0),
    (4, 9, 4, 1.0),
    (4, -2, 4, 4.0),   # out-of-range dep_hour — the GUFM DB really has one
]
_PFLOW_ROWS = [
    (1, 8, 4, 6.0),
    (2, 9, 4, 2.0),
    (2, 13, 4, 4.0),
    (3, 7, 4, 22.0),
    (5, 10, 3, 5.0),
    (5, 11, 3, 5.0),
]


def _insert(conn, source: str, rows: list[tuple]) -> None:
    for i, (vid, dep_hour, mode, dist) in enumerate(rows):
        conn.execute(
            """
            INSERT INTO trips (
                vehicle_id, trip_id, starttime,
                start_lon, start_lat, end_lon, end_lat,
                vehicle_type, vehicle_key, source_id,
                dep_hour, transport_mode, distance_km
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                vid, i + 1, dep_hour * 3600,
                139.0, 35.0, 139.1, 35.1,
                source, f"{source}:{vid}", source,
                dep_hour, mode, dist,
            ],
        )


@pytest.fixture(scope="session")
def _populated_db():
    conn = duckdb.connect(":memory:")
    _init_schema(conn)
    _insert(conn, "gufm", _GUFM_ROWS)
    _insert(conn, "pflow", _PFLOW_ROWS)
    yield conn
    conn.close()


@pytest.fixture(autouse=True)
def _patch_singleton(_populated_db, monkeypatch):
    monkeypatch.setattr(backend.db, "_connection", _populated_db)


@pytest.fixture
def client():
    return TestClient(app)


def _compare(client, **params) -> dict:
    r = client.get("/api/analysis/compare", params=params)
    assert r.status_code == 200, r.text
    return r.json()


# --- Fleet summaries -----------------------------------------------------------


def test_fleet_summaries(client):
    body = _compare(client, source_a="gufm", source_b="pflow")
    assert body["source_a"] == "gufm"
    assert body["source_b"] == "pflow"

    a, b = body["fleet_a"], body["fleet_b"]
    assert a["trips"] == 8
    assert a["vehicles"] == 4
    assert a["vkt_km"] == pytest.approx(60.0)
    assert a["avg_distance_km"] == pytest.approx(7.5)
    assert a["median_distance_km"] == pytest.approx(4.5)
    assert a["max_distance_km"] == pytest.approx(20.0)
    assert a["min_starttime"] == -7200
    assert a["max_starttime"] == 43200

    assert b["trips"] == 6
    assert b["vehicles"] == 4
    assert b["vkt_km"] == pytest.approx(44.0)
    assert b["median_distance_km"] == pytest.approx(5.0)
    assert b["max_distance_km"] == pytest.approx(22.0)


# --- Mode shares ----------------------------------------------------------------


def test_mode_shares_sum_to_one(client):
    body = _compare(client, source_a="gufm", source_b="pflow")
    shares = {m["mode"]: m for m in body["mode_shares"]}
    assert sum(m["a_share"] for m in body["mode_shares"]) == pytest.approx(1.0)
    assert sum(m["b_share"] for m in body["mode_shares"]) == pytest.approx(1.0)
    assert shares[4]["a_trips"] == 7
    assert shares[4]["b_trips"] == 4
    assert shares[4]["a_share"] == pytest.approx(0.875)
    assert shares[4]["b_share"] == pytest.approx(4 / 6, abs=1e-4)
    assert shares[4]["delta_pp"] == pytest.approx((4 / 6 - 7 / 8) * 100, abs=0.01)
    assert shares[3]["delta_pp"] == pytest.approx(-shares[4]["delta_pp"], abs=0.02)


# --- Hourly + out-of-range guard --------------------------------------------------


def test_hourly_buckets_and_out_of_range(client):
    body = _compare(client, source_a="gufm", source_b="pflow")
    hourly = body["hourly"]
    assert [h["hour"] for h in hourly] == list(range(24))
    by_hour = {h["hour"]: h for h in hourly}
    assert by_hour[8]["a"] == 2
    assert by_hour[9]["a"] == 2
    assert by_hour[12]["a"] == 1
    assert by_hour[7]["b"] == 1
    assert by_hour[13]["b"] == 1
    assert sum(h["a"] for h in hourly) == 7  # in-range only
    assert sum(h["b"] for h in hourly) == 6
    # The dep_hour=-2 trip lands in out_of_range, not a bucket.
    assert body["out_of_range"] == {"a": 1, "b": 0}


# --- Distance histogram ------------------------------------------------------------


def test_distance_hist_shared_edges(client):
    body = _compare(client, source_a="gufm", source_b="pflow")
    hist = body["distance_hist"]
    assert len(hist) == 20
    assert hist[0]["bucket_lo"] == 0.0
    # Combined max (22 km) is the top edge of the last bucket.
    assert hist[-1]["bucket_hi"] == pytest.approx(22.0)
    assert sum(h["a"] for h in hist) == 8
    assert sum(h["b"] for h in hist) == 6
    # Max-distance trips: gufm's 20 km lands in bucket 18 (width 1.1),
    # pflow's 22 km (exactly the combined max) clips into the last bucket.
    assert hist[18]["a"] == 1
    assert hist[-1]["b"] == 1


# --- Matched-person analysis ---------------------------------------------------------


def test_matched_block(client):
    body = _compare(client, source_a="gufm", source_b="pflow")
    m = body["matched"]
    assert m["matched_persons"] == 3
    assert m["trips_per_person_a"] == pytest.approx(2.0)
    assert m["trips_per_person_b"] == pytest.approx(1.5)
    assert m["delta"]["mean"] == pytest.approx(-0.4)
    assert m["delta"]["median"] == pytest.approx(0.0)
    assert m["delta"]["p90_abs"] == pytest.approx(2.0)
    assert m["delta"]["max_abs"] == 2

    top = m["top"]
    # Sorted by ABS(delta) DESC, vehicle_id tiebreak: 1, 4, 5, then 2, 3.
    assert [t["vehicle_id"] for t in top] == [1, 4, 5, 2, 3]
    by_id = {t["vehicle_id"]: t for t in top}
    assert (by_id[1]["trips_a"], by_id[1]["trips_b"], by_id[1]["delta"]) == (3, 1, -2)
    # One-side-only persons count 0 on the missing side.
    assert (by_id[4]["trips_a"], by_id[4]["trips_b"]) == (2, 0)
    assert (by_id[5]["trips_a"], by_id[5]["trips_b"]) == (0, 2)


def test_matched_top_n_limit(client):
    body = _compare(client, source_a="gufm", source_b="pflow", top_n=2)
    assert [t["vehicle_id"] for t in body["matched"]["top"]] == [1, 4]


# --- Guards ---------------------------------------------------------------------------


def test_same_source_422(client):
    r = client.get("/api/analysis/compare", params={"source_a": "gufm", "source_b": "gufm"})
    assert r.status_code == 422


def test_zero_trip_side_matched_null(client):
    # transport_modes=1 matches nothing in either fleet.
    body = _compare(client, source_a="gufm", source_b="pflow", transport_modes="1")
    assert body["fleet_a"]["trips"] == 0
    assert body["fleet_b"]["trips"] == 0
    assert body["fleet_a"]["vkt_km"] is None
    assert body["matched"] is None
    assert body["distance_hist"] == []
    assert sum(h["a"] + h["b"] for h in body["hourly"]) == 0


def test_hour_filter_applies_to_both_fleets(client):
    body = _compare(client, source_a="gufm", source_b="pflow",
                    min_hour=8, max_hour=10)
    assert body["fleet_a"]["trips"] == 5   # gufm h8,h9,h10 (dep_hour=-2 excluded)
    assert body["fleet_b"]["trips"] == 3   # pflow h8,h9,h10
    # Persons 1 and 2 still overlap under the hour filter.
    assert body["matched"]["matched_persons"] == 2
