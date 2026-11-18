"""Upload-and-go — /api/ingest/upload endpoint tests.

Pattern mirrors test_pois.py but is function-scoped (jobs mutate DB state):
each test gets a fresh in-memory DuckDB with the singleton monkey-patched,
PFLOW_VIZ_DB pointed at a tmp file (so uploads_dir()/uploads_registry_path()
land under tmp_path), PFLOW_VIZ_SOURCES at a minimal tmp yaml, and
ingest_api._RUN_JOBS_INLINE=True so jobs run synchronously in-request.
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import duckdb
import pytest
import yaml
from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import backend.db  # noqa: E402 — we monkey-patch its singleton
from backend.app import app  # noqa: E402
from backend.db import _init_schema, get_epoch_anchor  # noqa: E402
from backend.routers import ingest_api  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures"

# Midnight UTC of 2024-05-01 — track.gpx's earliest fix is 08:00Z that day.
EXPECTED_FRESH_ANCHOR = 1714521600

_CSV = (
    "lon,lat,timestamp,vehicle_id\n"
    "139.700,35.680,2024-05-01T00:00:00Z,v1\n"
    "139.710,35.681,2024-05-01T00:05:00Z,v1\n"
    "139.720,35.682,2024-05-01T00:10:00Z,v1\n"
    "139.700,35.680,2024-05-01T00:00:30Z,v2\n"
    "139.710,35.681,2024-05-01T00:06:00Z,v2\n"
)


@pytest.fixture
def env(monkeypatch, tmp_path):
    conn = duckdb.connect(":memory:")
    _init_schema(conn)
    monkeypatch.setattr(backend.db, "_connection", conn)
    monkeypatch.setenv("PFLOW_VIZ_DB", str(tmp_path / "viz.duckdb"))
    sources_yaml = tmp_path / "sources.yaml"
    sources_yaml.write_text("version: 1\nsources: {}\n")
    monkeypatch.setenv("PFLOW_VIZ_SOURCES", str(sources_yaml))
    monkeypatch.setattr(ingest_api, "_RUN_JOBS_INLINE", True)
    yield SimpleNamespace(conn=conn, tmp=tmp_path)
    conn.close()


@pytest.fixture
def client():
    return TestClient(app)


def _upload(client, name: str, data: bytes):
    return client.post("/api/ingest/upload", files=[("files", (name, data))])


def _gpx_bytes() -> bytes:
    return (FIXTURES / "track.gpx").read_bytes()


# --- (a) GPX end-to-end on a fresh DB -----------------------------------------


def test_upload_gpx_end_to_end(env, client):
    r = _upload(client, "track.gpx", _gpx_bytes())
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["files"] == [
        {
            "filename": "track.gpx",
            "source_id": "track",
            "format": "gpx",
            "role": "trajectories",
        }
    ]

    job = client.get(f"/api/ingest/jobs/{body['job_id']}").json()
    assert job["status"] == "done", job["error"]
    assert job["result"]["trips"] > 0
    assert job["result"]["waypoints"] > 0
    assert job["result"]["source_ids"] == ["track"]

    n_waypoints = env.conn.execute(
        "SELECT COUNT(*) FROM waypoints WHERE source_id = 'track'"
    ).fetchone()[0]
    assert n_waypoints == job["result"]["waypoints"]

    # Fresh DB: anchor = midnight UTC of the data's first day.
    assert get_epoch_anchor(env.conn) == EXPECTED_FRESH_ANCHOR

    # The new source just appears in filter-options with its style hints.
    opts = client.get("/api/stats/filter-options").json()
    sources = {s["source_id"]: s for s in opts["sources"]}
    assert "track" in sources
    assert sources["track"]["has_waypoints"] is True


# --- (b) CSV with ISO timestamps -----------------------------------------------


def test_upload_csv_iso_timestamps(env, client):
    r = _upload(client, "fleet.csv", _CSV.encode())
    assert r.status_code == 202, r.text
    job = client.get(f"/api/ingest/jobs/{r.json()['job_id']}").json()
    assert job["status"] == "done", job["error"]
    assert job["result"]["waypoints"] == 5
    # Two vehicles, each one contiguous run → one synthesized trip each.
    assert job["result"]["trips"] == 2
    keys = {
        row[0]
        for row in env.conn.execute(
            "SELECT DISTINCT vehicle_key FROM trips WHERE source_id = 'fleet'"
        ).fetchall()
    }
    assert keys == {"fleet:v1", "fleet:v2"}


# --- (c) Unmappable CSV → 422 with mapping census (staged kept) ---------------


def test_upload_csv_missing_columns_422_with_census(env, client):
    r = _upload(client, "mystery.csv", b"a,b,c\n1,2,3\n4,5,6\n")
    assert r.status_code == 422
    detail = r.json()["detail"]
    reasons = " ".join(detail["reasons"])
    assert "longitude/latitude" in reasons
    assert "timestamp" in reasons
    assert "vehicle/device id" in reasons
    assert detail["mapping_required"] is True
    assert len(detail["files"]) == 1
    census = detail["files"][0]
    assert census["filename"] == "mystery.csv"
    assert census["staged_name"] == "mystery.csv"
    assert {c["name"] for c in census["columns"]} == {"a", "b", "c"}
    assert "lon" in census["tried_candidates"]
    # Staged for confirm; nothing ingested yet.
    assert (env.tmp / "uploads" / "mystery.csv").is_file()
    assert env.conn.execute("SELECT COUNT(*) FROM waypoints").fetchone()[0] == 0


# --- (c2) Interactive mapping confirm → ingest ---------------------------------


def test_upload_confirm_opaque_columns(env, client):
    opaque = (
        "xpos,ypos,when,device,travel_mode\n"
        "139.700,35.680,2024-05-01T00:00:00Z,v1,Walk\n"
        "139.710,35.681,2024-05-01T00:05:00Z,v1,Walk\n"
        "139.720,35.682,2024-05-01T00:10:00Z,v1,Walk\n"
        "139.700,35.680,2024-05-01T00:00:30Z,v2,Car\n"
        "139.710,35.681,2024-05-01T00:06:00Z,v2,Car\n"
    )
    r = _upload(client, "opaque.csv", opaque.encode())
    assert r.status_code == 422, r.text
    detail = r.json()["detail"]
    assert detail["mapping_required"] is True
    staged = detail["files"][0]["staged_name"]
    assert detail["files"][0]["source_id"] == "opaque"

    confirm = client.post(
        "/api/ingest/upload/confirm",
        json={
            "files": [{
                "staged_name": staged,
                "source_id": "opaque",
                "filename": "opaque.csv",
                "mapping": {
                    "lon": "xpos",
                    "lat": "ypos",
                    "time": "when",
                    "vehicle_id": "device",
                    "mode": "travel_mode",
                    "time_kind": "iso",
                },
            }],
        },
    )
    assert confirm.status_code == 202, confirm.text
    job = client.get(f"/api/ingest/jobs/{confirm.json()['job_id']}").json()
    assert job["status"] == "done", job["error"]
    assert job["result"]["waypoints"] == 5
    assert job["result"]["trips"] == 2

    modes = {
        row[0]
        for row in env.conn.execute(
            "SELECT DISTINCT mode FROM trips WHERE source_id = 'opaque'"
        ).fetchall()
    }
    assert modes == {"Walk", "Car"}

    registry = yaml.safe_load(
        (env.tmp / "sources.uploads.yaml").read_text(encoding="utf-8")
    )
    entry = registry["sources"]["opaque"]
    assert entry["columns"]["waypoints"]["lon"]["csv"] == "xpos"
    assert entry["columns"]["waypoints"]["mode"]["csv"] == "travel_mode"
    assert entry["columns"]["waypoints"]["mode"]["type"] == "varchar"


def test_upload_confirm_mode_map_int_codes(env, client):
    opaque = (
        "xpos,ypos,when,device,mcode\n"
        "139.700,35.680,2024-05-01T00:00:00Z,v1,0\n"
        "139.710,35.681,2024-05-01T00:05:00Z,v1,0\n"
        "139.700,35.680,2024-05-01T00:00:30Z,v2,1\n"
        "139.710,35.681,2024-05-01T00:06:00Z,v2,1\n"
    )
    r = _upload(client, "codes.csv", opaque.encode())
    assert r.status_code == 422
    staged = r.json()["detail"]["files"][0]["staged_name"]
    confirm = client.post(
        "/api/ingest/upload/confirm",
        json={
            "files": [{
                "staged_name": staged,
                "source_id": "codes",
                "filename": "codes.csv",
                "mapping": {
                    "lon": "xpos",
                    "lat": "ypos",
                    "time": "when",
                    "agent_id": "device",
                    "mode": "mcode",
                    "time_kind": "iso",
                    "mode_map": {"0": "Walk", "1": "Car"},
                },
            }],
        },
    )
    assert confirm.status_code == 202, confirm.text
    job = client.get(f"/api/ingest/jobs/{confirm.json()['job_id']}").json()
    assert job["status"] == "done", job["error"]
    modes = {
        row[0]
        for row in env.conn.execute(
            "SELECT DISTINCT mode FROM trips WHERE source_id = 'codes'"
        ).fetchall()
    }
    assert modes == {"Walk", "Car"}
    registry = yaml.safe_load(
        (env.tmp / "sources.uploads.yaml").read_text(encoding="utf-8")
    )
    assert registry["sources"]["codes"]["mode_map"] == {"0": "Walk", "1": "Car"}
    assert (
        registry["sources"]["codes"]["columns"]["waypoints"]["transport_mode"]["csv"]
        == "mcode"
    )


def test_upload_confirm_missing_staged_422(env, client):
    r = client.post(
        "/api/ingest/upload/confirm",
        json={
            "files": [{
                "staged_name": "nope.csv",
                "mapping": {
                    "lon": "x", "lat": "y", "time": "t", "vehicle_id": "id",
                },
            }],
        },
    )
    assert r.status_code == 422
    assert "not found" in str(r.json()["detail"])


# --- (d) Bad extension → 422 -----------------------------------------------------


def test_upload_rejected_extension(env, client):
    r = _upload(client, "evil.exe", b"MZ\x90\x00")
    assert r.status_code == 422
    assert "unsupported file type" in str(r.json()["detail"])


# --- (d2) Polygon GeoJSON → zones overlay (TV-29 S2) ---------------------------


def test_upload_polygon_geojson_as_zones(env, client):
    """Polygon layers auto-ingest as zones without editing sources.yaml."""
    import json as _json

    doc = {
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "properties": {"name": "Ward A", "category": "ward"},
            "geometry": {"type": "Polygon", "coordinates": [
                [[139.0, 35.0], [139.1, 35.0], [139.1, 35.1], [139.0, 35.1], [139.0, 35.0]],
            ]},
        }],
    }
    r = _upload(client, "wards.geojson", _json.dumps(doc).encode())
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["files"][0]["role"] == "zones"
    job = client.get(f"/api/ingest/jobs/{body['job_id']}").json()
    assert job["status"] == "done", job["error"]
    assert job["result"]["zones"] == 1
    assert job["result"]["trips"] == 0
    n = env.conn.execute(
        "SELECT COUNT(*) FROM zones WHERE source_key = 'wards'"
    ).fetchone()[0]
    assert n == 1
    styles = client.get("/api/zones/styles").json()
    assert "wards" in styles["styles"]
    assert styles["styles"]["wards"]["label"] == "wards"

    registry = yaml.safe_load(
        (env.tmp / "sources.uploads.yaml").read_text(encoding="utf-8")
    )
    assert "wards" in registry["zones"]
    assert registry["zones"]["wards"]["format"] == "geojson"


def test_upload_point_geojson_passes_census(env, client):
    """Point GeoJSON with time props still uploads as trajectories (one-click)."""
    import json as _json

    doc = {
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "properties": {"name": "p1", "time": "2024-05-01T09:00:00+09:00"},
            "geometry": {"type": "Point", "coordinates": [139.5, 35.5]},
        }],
    }
    r = _upload(client, "points.geojson", _json.dumps(doc).encode())
    assert r.status_code == 202, r.text
    assert r.json()["files"][0]["role"] == "trajectories"


def test_upload_point_geojson_as_pois(env, client):
    """Point GeoJSON without time auto-ingests as POIs; chips/styles update."""
    import json as _json

    doc = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"name": "Cafe A", "category": "cafe"},
                "geometry": {"type": "Point", "coordinates": [139.7, 35.68]},
            },
            {
                "type": "Feature",
                "properties": {"name": "Station X", "category": "station"},
                "geometry": {"type": "Point", "coordinates": [139.72, 35.70]},
            },
        ],
    }
    r = _upload(client, "amenities.geojson", _json.dumps(doc).encode())
    assert r.status_code == 202, r.text
    assert r.json()["files"][0]["role"] == "pois"
    job = client.get(f"/api/ingest/jobs/{r.json()['job_id']}").json()
    assert job["status"] == "done", job["error"]
    assert job["result"]["pois"] == 2
    cats = client.get("/api/pois/categories").json()["categories"]
    names = {c["category"] for c in cats}
    assert "cafe" in names and "station" in names
    opts = client.get("/api/stats/filter-options").json()
    # Overlay-only upload on empty DB: no trips, but POI API works.
    assert opts["capabilities"] is not None


def test_upload_point_geojson_role_pois_override(env, client):
    """roles form field forces Point+time GeoJSON into POIs (not trajectories)."""
    import json as _json

    doc = {
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "properties": {
                "name": "Cafe A", "category": "cafe",
                "time": "2024-05-01T09:00:00+09:00",
            },
            "geometry": {"type": "Point", "coordinates": [139.7, 35.68]},
        }],
    }
    r = client.post(
        "/api/ingest/upload",
        data={"roles": _json.dumps({"cafes.geojson": "pois"})},
        files=[("files", ("cafes.geojson", _json.dumps(doc).encode()))],
    )
    assert r.status_code == 202, r.text
    assert r.json()["files"][0]["role"] == "pois"
    job = client.get(f"/api/ingest/jobs/{r.json()['job_id']}").json()
    assert job["status"] == "done", job["error"]
    assert job["result"]["pois"] == 1
    assert env.conn.execute("SELECT COUNT(*) FROM waypoints").fetchone()[0] == 0


# --- (e) Uploads registry written + style lookup merge ----------------------------


def test_uploads_registry_written_and_merged(env, client):
    r = _upload(client, "track.gpx", _gpx_bytes())
    assert r.status_code == 202, r.text

    registry = env.tmp / "sources.uploads.yaml"
    assert registry.is_file()
    data = yaml.safe_load(registry.read_text(encoding="utf-8"))
    assert data["version"] == 1
    entry = data["sources"]["track"]
    assert entry["label"] == "track"
    assert entry["source_id"] == "track"
    assert entry["render"]["mode"] == "trails"
    assert entry["time"]["epoch_anchor"].startswith("2024-05-01T00:00:00")

    opts = client.get("/api/stats/filter-options").json()
    labels = {s["source_id"]: s["label"] for s in opts["sources"]}
    assert labels.get("track") == "track"


# --- (f) Second upload reuses the pinned anchor -----------------------------------


def test_second_upload_reuses_anchor(env, client):
    r1 = _upload(client, "track.gpx", _gpx_bytes())
    assert client.get(f"/api/ingest/jobs/{r1.json()['job_id']}").json()["status"] == "done"
    anchor_before = get_epoch_anchor(env.conn)

    r2 = _upload(client, "fleet.csv", _CSV.encode())
    job2 = client.get(f"/api/ingest/jobs/{r2.json()['job_id']}").json()
    assert job2["status"] == "done", job2["error"]
    assert get_epoch_anchor(env.conn) == anchor_before == EXPECTED_FRESH_ANCHOR

    # Both sources now live side by side.
    ids = {
        row[0]
        for row in env.conn.execute("SELECT DISTINCT source_id FROM trips").fetchall()
    }
    assert ids == {"track", "fleet"}


# --- Job bookkeeping --------------------------------------------------------------


def test_unknown_job_404(env, client):
    assert client.get("/api/ingest/jobs/nope").status_code == 404


def test_jobs_list_newest_first(env, client):
    _upload(client, "track.gpx", _gpx_bytes())
    _upload(client, "fleet.csv", _CSV.encode())
    body = client.get("/api/ingest/jobs").json()
    assert len(body["jobs"]) >= 2
    created = [j["created_at"] for j in body["jobs"]]
    assert created == sorted(created, reverse=True)
    assert all(j["status"] == "done" for j in body["jobs"])


# --- Re-upload is idempotent --------------------------------------------------------


def test_reupload_replaces_source(env, client):
    r1 = _upload(client, "track.gpx", _gpx_bytes())
    job1 = client.get(f"/api/ingest/jobs/{r1.json()['job_id']}").json()
    n1 = job1["result"]["waypoints"]

    r2 = _upload(client, "track.gpx", _gpx_bytes())
    job2 = client.get(f"/api/ingest/jobs/{r2.json()['job_id']}").json()
    assert job2["status"] == "done", job2["error"]
    n2 = env.conn.execute(
        "SELECT COUNT(*) FROM waypoints WHERE source_id = 'track'"
    ).fetchone()[0]
    assert n2 == n1  # replaced, not duplicated


# --- (S3) Trips-only / OD arcs upload ----------------------------------------------


_OD_CSV = (
    "trip_id,agent_id,starttime,start_lon,start_lat,end_lon,end_lat,mode\n"
    "1,a1,3600,139.70,35.68,139.75,35.70,walk\n"
    "2,a1,7200,139.75,35.70,139.72,35.69,bike\n"
    "3,a2,4000,139.71,35.681,139.73,35.685,bus\n"
)


def test_upload_od_trips_csv_arcs_no_waypoints(env, client):
    r = _upload(client, "flows.csv", _OD_CSV.encode())
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["files"][0]["role"] == "trips"
    job = client.get(f"/api/ingest/jobs/{body['job_id']}").json()
    assert job["status"] == "done", job["error"]
    assert job["result"]["trips"] == 3
    assert job["result"]["waypoints"] == 0
    assert env.conn.execute(
        "SELECT COUNT(*) FROM waypoints WHERE source_id = 'flows'"
    ).fetchone()[0] == 0
    assert env.conn.execute(
        "SELECT COUNT(*) FROM trips WHERE source_id = 'flows'"
    ).fetchone()[0] == 3

    opts = client.get("/api/stats/filter-options").json()
    sources = {s["source_id"]: s for s in opts["sources"]}
    assert sources["flows"]["has_waypoints"] is False
    assert sources["flows"]["mode"] == "arcs"

    # Registry block matches sources-od-arcs semantics (trips_glob + arcs).
    reg = yaml.safe_load((env.tmp / "sources.uploads.yaml").read_text())
    cfg = reg["sources"]["flows"]
    assert "trips_glob" in cfg["discovery"]
    assert cfg["discovery"].get("trajectories_glob") in (None, "")
    assert cfg["render"]["mode"] == "arcs"
    assert cfg.get("trips_synthesis") is None


def test_upload_od_confirm_opaque_columns(env, client):
    opaque = (
        "o_x,o_y,d_x,d_y,dep,aid,tid,m\n"
        "139.70,35.68,139.75,35.70,3600,a1,1,walk\n"
        "139.75,35.70,139.72,35.69,7200,a1,2,bike\n"
    )
    r = _upload(client, "opaque_od.csv", opaque.encode())
    assert r.status_code == 422, r.text
    detail = r.json()["detail"]
    assert detail["mapping_required"] is True
    census = detail["files"][0]
    # Not OD-shaped headers → tracks sheet by default; confirm as trips.
    assert census["kind"] in ("tracks", "trips")
    staged = census["staged_name"]

    confirm = client.post(
        "/api/ingest/upload/confirm",
        json={
            "files": [{
                "staged_name": staged,
                "source_id": "opaque_od",
                "filename": "opaque_od.csv",
                "kind": "trips",
                "mapping": {
                    "kind": "trips",
                    "start_lon": "o_x",
                    "start_lat": "o_y",
                    "end_lon": "d_x",
                    "end_lat": "d_y",
                    "starttime": "dep",
                    "vehicle_id": "aid",
                    "trip_id": "tid",
                    "mode": "m",
                    "time_kind": "day_seconds",
                },
            }]
        },
    )
    assert confirm.status_code == 202, confirm.text
    job = client.get(f"/api/ingest/jobs/{confirm.json()['job_id']}").json()
    assert job["status"] == "done", job["error"]
    assert job["result"]["trips"] == 2
    assert job["result"]["waypoints"] == 0
    modes = {
        row[0]
        for row in env.conn.execute(
            "SELECT DISTINCT mode FROM trips WHERE source_id = 'opaque_od'"
        ).fetchall()
    }
    assert modes == {"walk", "bike"}


def test_upload_tracks_still_works_beside_od(env, client):
    """Points-only synthesis path must remain intact after OD support."""
    r = _upload(client, "fleet.csv", _CSV.encode())
    assert r.status_code == 202, r.text
    job = client.get(f"/api/ingest/jobs/{r.json()['job_id']}").json()
    assert job["status"] == "done", job["error"]
    assert job["result"]["waypoints"] == 5
    assert job["result"]["trips"] == 2


# --- (TV-30) Upload source style PATCH -----------------------------------------


def test_patch_upload_source_style(env, client):
    r = _upload(client, "fleet.csv", _CSV.encode())
    assert r.status_code == 202, r.text
    job = client.get(f"/api/ingest/jobs/{r.json()['job_id']}").json()
    assert job["status"] == "done", job["error"]

    patch = client.patch(
        "/api/ingest/sources/fleet/style",
        json={"mode": "arcs", "color": [10, 20, 30]},
    )
    assert patch.status_code == 200, patch.text
    body = patch.json()
    assert body["mode"] == "arcs"
    assert body["color"] == [10, 20, 30]

    reg = yaml.safe_load((env.tmp / "sources.uploads.yaml").read_text())
    assert reg["sources"]["fleet"]["render"]["mode"] == "arcs"
    assert reg["sources"]["fleet"]["render"]["color"] == [10, 20, 30]

    opts = client.get("/api/stats/filter-options").json()
    sources = {s["source_id"]: s for s in opts["sources"]}
    assert sources["fleet"]["mode"] == "arcs"
    assert sources["fleet"]["color"] == [10, 20, 30]
    assert sources["fleet"]["editable"] is True


def test_patch_non_upload_source_422(env, client):
    r = client.patch(
        "/api/ingest/sources/not_an_upload/style",
        json={"mode": "points"},
    )
    assert r.status_code == 422
    reasons = " ".join(r.json()["detail"]["reasons"])
    assert "uploads registry" in reasons.lower() or "not in the uploads" in reasons.lower()
