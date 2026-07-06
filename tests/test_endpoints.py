"""
Sprint A2 — endpoint integration tests via FastAPI TestClient.

Pattern: build one in-memory DuckDB session-wide, populate it with synthetic
truck + taxi trips and waypoints (reusing fixtures from test_v0_2_parity.py),
monkey-patch `backend.db._connection` to that DB, then hit endpoints via
`TestClient(app)`. Each test asserts HTTP 200 + a few key response keys.

The endpoints DO NOT call FastAPI's Depends() pattern — they use the bare
`get_connection()` singleton — so monkeypatching `backend.db._connection`
is the override mechanism.
"""

from __future__ import annotations

import sys
from pathlib import Path

import duckdb
import pytest
from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import backend.db  # noqa: E402  — we need to monkey-patch its singleton
from backend.app import app  # noqa: E402
from backend.db import _init_schema  # noqa: E402
from backend.ingest import (  # noqa: E402
    build_density_hourly,
    compute_derived_metrics,
    ingest_source_trajectories,
    ingest_source_trips,
)
from backend.sources_schema import load_sources  # noqa: E402


# --- Fixtures ---------------------------------------------------------------


def _populate_db(conn: duckdb.DuckDBPyConnection, tmp_path: Path) -> None:
    """Synthesize a small mixed-source dataset.

    5 truck trips spanning multiple hours and a 3-waypoint trajectory for trip 1
    (so speed_avg_kmh populates for one truck row), plus 4 taxi trips in Tokyo.
    """
    _init_schema(conn)
    sources = load_sources(PROJECT_ROOT / "sources.yaml")

    # Truck trips — varied dep_hours so /temporal/* has data across hours
    truck_csv = tmp_path / "truck.csv"
    truck_csv.write_text(
        "id,sim_day,starttime,start_lon,start_lat,end_lon,end_lat,transport_mode,"
        "purpose,occupation,cargo_loaded,truck_id,distance_km,cargo_weight_tons,"
        "goods_type,vehicle_size,capacity_tons,status,starttime_h\n"
        "1,0,28800,139.60,35.60,139.65,35.62,1,1,2,true,1001,5.0,1.0,kibutsu,small,2.0,delivery,8\n"
        "2,0,36000,139.65,35.62,139.70,35.64,1,1,2,false,1001,5.5,0.0,kibutsu,small,2.0,empty,10\n"
        "3,0,43200,139.70,35.64,139.60,35.60,1,1,2,true,1002,12.3,1.5,nourinsuisanhin,medium,4.0,delivery,12\n"
        "4,0,50400,139.62,35.65,139.66,35.63,1,1,2,true,1002,4.2,0.5,kibutsu,small,2.0,delivery,14\n"
        "5,1,28800,139.55,35.58,139.72,35.66,1,1,2,true,1003,18.5,2.0,kibutsu,medium,4.0,delivery,8\n"
    )
    ingest_source_trips(conn, truck_csv, "pflow-truck", sources.sources["pflow-truck"])

    # Truck waypoints — give trip 1001/1 a 3-waypoint trajectory so speed_avg
    # populates for at least one row
    truck_wp_csv = tmp_path / "truck_wp.csv"
    truck_wp_csv.write_text(
        "truck_id,trip_id,unix_time_ms,datetime,lon,lat,transport_mode,purpose,"
        "goods_type,vehicle_size,link_id\n"
        "1001,1,1715817600000,2026-05-16T00:00:00,139.60,35.60,1,1,kibutsu,small,L100\n"
        "1001,1,1715817630000,2026-05-16T00:00:30,139.625,35.61,1,1,kibutsu,small,L101\n"
        "1001,1,1715817660000,2026-05-16T00:01:00,139.65,35.62,1,1,kibutsu,small,L102\n"
        # Second trip for 1001 (Phase 2A) — /trajectories/by-vehicle must return
        # the full-day chain (2 trajectories), not just one trip.
        "1001,2,1715824800000,2026-05-16T02:00:00,139.65,35.62,1,1,kibutsu,small,L103\n"
        "1001,2,1715824860000,2026-05-16T02:01:00,139.70,35.64,1,1,kibutsu,small,L104\n"
    )
    ingest_source_trajectories(
        conn, truck_wp_csv, "pflow-truck", sources.sources["pflow-truck"]
    )

    # Taxi trips — Tokyo scope, varied dep_hours
    taxi_csv = tmp_path / "taxi.csv"
    taxi_csv.write_text(
        "id,starttime,start_lon,start_lat,end_lon,end_lat,transport_mode,purpose,"
        "occupation,passenger_in,taxi_id,distance_km,fare_yen,is_night_trip,"
        "starttime_h,simulation_day\n"
        "1,28800,139.7,35.7,139.8,35.8,4,2,1,true,47,5.4,820.0,false,2026-05-16 08:00:00,0\n"
        "2,32400,139.71,35.7,139.78,35.71,4,2,1,true,47,3.2,540.0,false,2026-05-16 09:00:00,0\n"
        "3,72000,139.78,35.71,139.65,35.66,4,2,1,false,47,5.8,920.0,true,2026-05-16 20:00:00,0\n"
        "4,36000,139.7,35.7,139.6,35.6,4,2,1,true,99,7.1,1050.0,false,2026-05-16 10:00:00,0\n"
    )
    ingest_source_trips(conn, taxi_csv, "pflow-taxi-tokyo", sources.sources["pflow-taxi-tokyo"])

    # Compute F1 derived columns
    compute_derived_metrics(conn)

    # Phase 2B — pulse-heatmap aggregate (default 0.005° resolution)
    build_density_hourly(conn)


@pytest.fixture(scope="session")
def _populated_db(tmp_path_factory):
    conn = duckdb.connect(":memory:")
    _populate_db(conn, tmp_path_factory.mktemp("endpoint-fixture-data"))
    yield conn
    conn.close()


@pytest.fixture(autouse=True)
def _patch_singleton(_populated_db, monkeypatch):
    """Replace the module-global DuckDB singleton with our populated in-memory DB
    for the duration of each test."""
    monkeypatch.setattr(backend.db, "_connection", _populated_db)


@pytest.fixture
def client():
    return TestClient(app)


# --- Stats endpoints --------------------------------------------------------


def test_stats(client):
    r = client.get("/api/stats")
    assert r.status_code == 200
    body = r.json()
    assert "trips" in body and "waypoints" in body
    assert body["trips"]["row_count"] == 9  # 5 truck + 4 taxi


def test_stats_filter_options(client):
    r = client.get("/api/stats/filter-options")
    assert r.status_code == 200
    body = r.json()
    assert "vehicle_types" in body
    assert "truck" in body["vehicle_types"]
    assert "taxi" in body["vehicle_types"]
    assert "tokyo" in body["cities"]
    # Sprint B5 — per-source F1 metric availability map
    assert "metrics_available" in body
    assert "truck" in body["metrics_available"]
    assert "taxi" in body["metrics_available"]
    # Each entry has speed/dwell/detour booleans
    for src in ("truck", "taxi"):
        assert set(body["metrics_available"][src].keys()) == {"speed", "dwell", "detour"}


def test_stats_filter_options_metrics_truck_has_speed(client):
    """Synthetic truck data includes a 3-waypoint trajectory for trip 1001/1, so
    speed_avg_kmh is populated for at least one truck row → has_speed is true."""
    body = client.get("/api/stats/filter-options").json()
    assert body["metrics_available"]["truck"]["speed"] is True
    # Truck data spans 2 trips for truck 1001 → dwell populates
    assert body["metrics_available"]["truck"]["dwell"] is True


def test_stats_filter_options_metrics_taxi_no_trajectory(client):
    """No taxi waypoints in the fixture, so taxi speed_avg_kmh is all NULL."""
    body = client.get("/api/stats/filter-options").json()
    assert body["metrics_available"]["taxi"]["speed"] is False
    # Taxi 47 has 3 trips on sim_day=0 → dwell populates between them
    assert body["metrics_available"]["taxi"]["dwell"] is True


def test_stats_insights_includes_fare_for_taxi(client):
    r = client.get("/api/stats/insights", params={"vehicle_type": "taxi"})
    assert r.status_code == 200
    body = r.json()
    assert "core" in body
    assert body["fare"] is not None
    assert body["fare"]["avg_fare_yen"] > 0


def test_stats_insights_no_fare_for_truck_only(client):
    r = client.get("/api/stats/insights", params={"vehicle_type": "truck"})
    assert r.status_code == 200
    # Truck rows have fare_yen=NULL, so the fare_yen IS NOT NULL filter excludes
    # them all → fare is None (the source-agnostic refactor in Phase 2.2a)
    assert r.json()["fare"] is None


# --- Trips endpoints --------------------------------------------------------


def test_trips_sample(client):
    r = client.get("/api/trips/sample", params={"n": 3})
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body["trips"], list)
    assert len(body["trips"]) <= 3


def test_trips_query_with_f1_filters(client):
    """POST /api/trips/query with F1 derived-metric filters.

    Bounds match the Pydantic constraints in models.TripQuery (max_dwell_minutes
    is capped at 10080 = 1 week, max_detour_ratio at 20.0).
    """
    r = client.post("/api/trips/query", json={
        "vehicle_type": "truck",
        "min_speed": 0,
        "max_dwell_minutes": 10080,
        "max_detour_ratio": 20,
        "limit": 100,
    })
    assert r.status_code == 200
    body = r.json()
    assert "trips" in body
    # All returned trips are truck
    for t in body["trips"]:
        assert t["vehicle_type"] == "truck"


# --- Trajectories endpoints -------------------------------------------------


def test_trajectories_sample_with_segments(client):
    """Sprint A1a — include_segments=true populates segments[]."""
    r = client.get("/api/trajectories/sample", params={
        "n": 1,
        "include_segments": "true",
    })
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body["trajectories"], list)
    if body["trajectories"]:
        traj = body["trajectories"][0]
        assert "path" in traj and "timestamps" in traj
        assert traj["segments"] is not None
        assert len(traj["segments"]) == len(traj["path"]) - 1


def test_trajectories_query_bbox(client):
    """POST /api/trajectories/query-bbox — bbox around the truck waypoint trail."""
    r = client.post("/api/trajectories/query-bbox", json={
        "min_lon": 139.5, "min_lat": 35.55,
        "max_lon": 139.7, "max_lat": 35.65,
        "limit": 100,
    })
    assert r.status_code == 200
    assert "trajectories" in r.json()


def test_trajectories_query_point(client):
    """POST /api/trajectories/query-point — radius around the truck trail."""
    r = client.post("/api/trajectories/query-point", json={
        "lon": 139.625, "lat": 35.61, "radius_km": 5.0, "limit": 100,
    })
    assert r.status_code == 200
    assert "trajectories" in r.json()


# --- Trajectories: by-vehicle (Phase 2A agent playback) ----------------------


def test_by_vehicle_returns_full_day_chain(client):
    """truck:1001 has 2 waypoint trips in the fixture — both must come back."""
    r = client.get("/api/trajectories/by-vehicle", params={
        "vehicle_keys": "truck:1001",
    })
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == 2
    trip_ids = sorted(t["metadata"]["trip_id"] for t in body["trajectories"])
    assert trip_ids == [1, 2]
    for t in body["trajectories"]:
        assert t["metadata"]["vehicle_key"] == "truck:1001"
        # include_segments defaults to True on this endpoint
        assert t["segments"] is not None


def test_by_vehicle_multiple_keys(client):
    """Multiple keys — taxi has no waypoints in fixture, so only truck returns."""
    r = client.get("/api/trajectories/by-vehicle", params={
        "vehicle_keys": "truck:1001,taxi:tokyo:47",
    })
    assert r.status_code == 200
    keys = {t["metadata"]["vehicle_key"] for t in r.json()["trajectories"]}
    assert keys == {"truck:1001"}


def test_by_vehicle_simulation_day_filter(client):
    """truck:1001's trips are on sim_day=0 — day=1 must return nothing."""
    r = client.get("/api/trajectories/by-vehicle", params={
        "vehicle_keys": "truck:1001", "simulation_day": 1,
    })
    assert r.status_code == 200
    assert r.json()["count"] == 0


def test_by_vehicle_rejects_too_many_keys(client):
    keys = ",".join(f"truck:{i}" for i in range(21))
    r = client.get("/api/trajectories/by-vehicle", params={"vehicle_keys": keys})
    assert r.status_code == 422


def test_by_vehicle_rejects_malformed_key(client):
    """Quote-bearing keys must be rejected by the format check, and even if the
    regex were loosened the query is parameterized — never string-interpolated."""
    for bad in ("truck:1001'; DROP TABLE trips;--", "UPPER:1", "truck", ""):
        r = client.get("/api/trajectories/by-vehicle", params={"vehicle_keys": bad})
        assert r.status_code == 422, f"expected 422 for {bad!r}"


# --- Trips: vehicle search (Phase 2A agent search) ---------------------------


def test_vehicles_search_prefix(client):
    r = client.get("/api/trips/vehicles", params={"q": "truck:100"})
    assert r.status_code == 200
    body = r.json()
    keys = {v["vehicle_key"] for v in body["vehicles"]}
    assert {"truck:1001", "truck:1002", "truck:1003"} <= keys
    by_key = {v["vehicle_key"]: v for v in body["vehicles"]}
    assert by_key["truck:1001"]["trip_count"] == 2
    assert by_key["truck:1001"]["source_id"] == "truck"
    assert by_key["truck:1001"]["total_km"] == 10.5  # 5.0 + 5.5


def test_vehicles_search_respects_filters(client):
    r = client.get("/api/trips/vehicles", params={"vehicle_type": "taxi"})
    assert r.status_code == 200
    for v in r.json()["vehicles"]:
        assert v["vehicle_key"].startswith("taxi:")


def test_vehicles_search_quote_input_is_safe(client):
    """Free-text q is SQL-parameterized — a quote must not 500 or match."""
    r = client.get("/api/trips/vehicles", params={"q": "tru'ck"})
    assert r.status_code == 200
    assert r.json()["count"] == 0


def test_vehicles_search_wildcard_is_literal(client):
    """LIKE wildcards in q are escaped — '%' must not match everything."""
    r = client.get("/api/trips/vehicles", params={"q": "%"})
    assert r.status_code == 200
    assert r.json()["count"] == 0


# --- Stats: filter-options sources (Phase 2A) --------------------------------


def test_filter_options_sources(client):
    """sources[] lists only ingested sources, with render mode/color hints."""
    body = client.get("/api/stats/filter-options").json()
    assert "sources" in body
    by_id = {s["source_id"]: s for s in body["sources"]}
    # person is declared in sources.yaml but not ingested in the fixture
    assert set(by_id.keys()) == {"truck", "taxi"}
    assert by_id["truck"]["mode"] == "trails"
    assert by_id["truck"]["color"] == [253, 128, 93]
    assert by_id["truck"]["has_waypoints"] is True
    assert by_id["taxi"]["has_waypoints"] is False
    assert by_id["taxi"]["label"] == "Tokyo Taxi"


# --- Analysis: temporal -----------------------------------------------------


def test_temporal_departures(client):
    r = client.get("/api/analysis/temporal/departures")
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body, list)
    assert len(body) == 24  # 24-hour histogram
    assert all("hour" in h for h in body)


def test_temporal_peaks(client):
    r = client.get("/api/analysis/temporal/peaks")
    assert r.status_code == 200
    assert "peaks" in r.json()


def test_temporal_duration(client):
    r = client.get("/api/analysis/temporal/duration")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


def test_temporal_metrics_distribution_speed(client):
    """Sprint 2.2b — F1 derived-metric histogram."""
    r = client.get("/api/analysis/temporal/metrics-distribution", params={
        "metric": "speed_avg_kmh", "bins": 10,
    })
    assert r.status_code == 200
    body = r.json()
    assert body["metric"] == "speed_avg_kmh"
    assert body["unit"] == "km/h"
    assert "histogram" in body


def test_temporal_metrics_distribution_detour(client):
    r = client.get("/api/analysis/temporal/metrics-distribution", params={
        "metric": "detour_ratio",
    })
    assert r.status_code == 200
    assert r.json()["metric"] == "detour_ratio"


# --- Analysis: spatial ------------------------------------------------------


def test_spatial_density_grid(client):
    r = client.get("/api/analysis/spatial/density-grid", params={"point_type": "origin"})
    assert r.status_code == 200
    assert "points" in r.json()


def test_spatial_hotspots(client):
    r = client.get("/api/analysis/spatial/hotspots", params={"top_n": 5})
    assert r.status_code == 200
    assert isinstance(r.json(), list)


def test_spatial_link_density(client):
    r = client.get("/api/analysis/spatial/link-density", params={"min_waypoints": 1})
    assert r.status_code == 200
    assert "links" in r.json()


# --- Analysis: density-hourly (Phase 2B pulse heatmap) ------------------------


def test_density_hourly_returns_24_buckets(client):
    r = client.get("/api/analysis/spatial/density-hourly")
    assert r.status_code == 200
    body = r.json()
    assert len(body["hours"]) == 24
    assert [h["hour"] for h in body["hours"]] == list(range(24))
    assert body["resolution_deg"] == 0.005
    assert body["global_max_weight"] >= 1


def test_density_hourly_matches_trajectory_hour_math(client):
    """The pulse must breathe in sync with the trails: a waypoint's density
    hour bucket == floor(trajectory timestamp / 3600) for the same waypoint."""
    traj = client.get("/api/trajectories/by-vehicle", params={
        "vehicle_keys": "truck:1001",
    }).json()["trajectories"]
    expected_hours = {ts // 3600 for t in traj for ts in t["timestamps"]}

    body = client.get("/api/analysis/spatial/density-hourly", params={
        "vehicle_type": "truck",
    }).json()
    density_hours = {h["hour"] for h in body["hours"] if h["points"]}
    assert expected_hours == density_hours


def test_density_hourly_weights_sum_to_waypoint_count(client):
    """5 truck waypoints in the fixture → total weight 5."""
    body = client.get("/api/analysis/spatial/density-hourly", params={
        "vehicle_type": "truck",
    }).json()
    total_weight = sum(p["weight"] for h in body["hours"] for p in h["points"])
    assert total_weight == 5


def test_density_hourly_409_when_not_built(client):
    """A resolution with no aggregate rows must 409 with the fix command —
    never fall back to GROUP-BYing raw waypoints at request time."""
    r = client.get("/api/analysis/spatial/density-hourly", params={
        "resolution": 0.05,
    })
    assert r.status_code == 409
    assert "--aggregates-only" in r.json()["detail"]


def test_density_hourly_source_filter(client):
    """Taxi has no waypoints in the fixture → empty buckets, zero max."""
    body = client.get("/api/analysis/spatial/density-hourly", params={
        "vehicle_type": "taxi",
    }).json()
    assert all(len(h["points"]) == 0 for h in body["hours"])
    assert body["global_max_weight"] == 0


# --- Analysis: OD flows -----------------------------------------------------


def test_od_flows(client):
    r = client.get("/api/analysis/od-flows", params={"top_n": 10})
    assert r.status_code == 200
    assert "flows" in r.json()


# --- Analysis: trip-chains --------------------------------------------------


def test_trip_chains_length_distribution(client):
    r = client.get("/api/analysis/trip-chains/length-distribution")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


def test_trip_chains_through_zone_bbox(client):
    """Sprint A1b — F2 endpoint test."""
    r = client.get("/api/analysis/trip-chains/through-zone-bbox", params={
        "w": 139.59, "s": 35.59, "e": 139.66, "n": 35.63,
    })
    assert r.status_code == 200
    body = r.json()
    assert "trips" in body
    assert "bbox" in body


def test_trip_chains_through_zone_bbox_rejects_bad_bounds(client):
    """w >= e should be rejected with an error message."""
    r = client.get("/api/analysis/trip-chains/through-zone-bbox", params={
        "w": 140.0, "s": 35.0, "e": 139.0, "n": 36.0,
    })
    assert r.status_code == 200
    assert "error" in r.json()


def test_trip_chains_multi_stop(client):
    """Sprint A1c — F2 endpoint test."""
    r = client.get("/api/analysis/trip-chains/multi-stop", params={"min_stops": 2})
    assert r.status_code == 200
    body = r.json()
    assert "vehicles" in body
    # Truck 1001 has 2 trips on sim_day=0 → matches min_stops=2
    assert any(v["vehicle_key"] == "truck:1001" for v in body["vehicles"])


# --- Analysis: clustering ---------------------------------------------------


def test_clustering_status(client):
    r = client.get("/api/analysis/clustering/status")
    assert r.status_code == 200
    body = r.json()
    assert "available" in body and "algorithm" in body


def test_clustering_run(client):
    """The OD+distance clusterer.

    The fixture has only 9 trips and the endpoint has a built-in min-trip
    threshold (40+), so we expect the endpoint to return an `error` shape
    rather than clusters. That graceful-fail behavior IS the test target —
    the endpoint shouldn't crash on small datasets.
    """
    r = client.post("/api/analysis/clustering/run", params={"sample_size": 100})
    assert r.status_code == 200
    body = r.json()
    # Either a real result (with `algorithm`) or a graceful error (with `error`).
    assert "algorithm" in body or "error" in body
    if "error" in body:
        assert "trips" in body["error"].lower() or "clustering" in body["error"].lower()


def test_clustering_route_similarity(client):
    """Sprint A1d — F3 route-similarity endpoint."""
    r = client.post("/api/analysis/clustering/route-similarity", params={
        "sample_size": 50, "eps": 0.5, "min_samples": 2,
    })
    assert r.status_code == 200
    body = r.json()
    # With only 1 trajectory in fixture (truck 1001 trip 1), expect 0-1 clusters.
    # The endpoint should still return a shapely correct response.
    assert "algorithm" in body
    assert body["algorithm"] in ("DBSCAN-Jaccard-on-links", "none")
