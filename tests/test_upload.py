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
        {"filename": "track.gpx", "source_id": "track", "format": "gpx"}
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


# --- (c) Unmappable CSV → 422 with reasons --------------------------------------


def test_upload_csv_missing_columns_422(env, client):
    r = _upload(client, "mystery.csv", b"a,b,c\n1,2,3\n4,5,6\n")
    assert r.status_code == 422
    detail = r.json()["detail"]
    reasons = " ".join(detail["reasons"])
    assert "longitude/latitude" in reasons
    assert "timestamp" in reasons
    assert "vehicle/device id" in reasons
    # Nothing staged, nothing ingested.
    assert not (env.tmp / "uploads").exists() or not list((env.tmp / "uploads").iterdir())
    assert env.conn.execute("SELECT COUNT(*) FROM waypoints").fetchone()[0] == 0


# --- (d) Bad extension → 422 -----------------------------------------------------


def test_upload_rejected_extension(env, client):
    r = _upload(client, "evil.exe", b"MZ\x90\x00")
    assert r.status_code == 422
    assert "unsupported file type" in str(r.json()["detail"])


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
