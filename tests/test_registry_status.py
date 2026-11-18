"""TV-19 — sources.yaml / discovery / ingest status for the UI.

`inspect_registry` + `/api/stats/filter-options` `registry` field so schema
and discovery failures show in the map, not only the console/CLI.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import duckdb
import pytest
import yaml
from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import backend.db  # noqa: E402
from backend.app import app  # noqa: E402
from backend.db import _init_schema  # noqa: E402
from backend.sources_schema import inspect_registry, load_sources  # noqa: E402

_ENV_KEYS = (
    "PFLOW_VIZ_DB",
    "PFLOW_VIZ_SOURCES",
    "PFLOW_VIZ_OUTPUT_ROOT",
    "TRAJECTORY_VIZ_DB",
    "TRAJECTORY_VIZ_SOURCES",
    "TRAJECTORY_VIZ_OUTPUT_ROOT",
    "TRAJECTORY_VIZ_PROFILE",
    "PFLOW_VIZ_PROFILE",
)


@pytest.fixture
def clean_env(monkeypatch, tmp_path):
    for key in _ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
    if backend.db._connection is not None:
        backend.db._connection.close()
        backend.db._connection = None
    db = tmp_path / "test.duckdb"
    conn = duckdb.connect(str(db))
    _init_schema(conn)
    conn.close()
    monkeypatch.setenv("TRAJECTORY_VIZ_DB", str(db))
    monkeypatch.setenv("PFLOW_VIZ_DB", str(db))
    yield tmp_path
    if backend.db._connection is not None:
        backend.db._connection.close()
        backend.db._connection = None
    for key in _ENV_KEYS:
        os.environ.pop(key, None)


def test_inspect_registry_ok_for_demo(clean_env, monkeypatch):
    """Healthy demo registry + empty DB may warn on discovery, but not error
    when demo files are present under demo/."""
    monkeypatch.setenv("TRAJECTORY_VIZ_PROFILE", "demo")
    monkeypatch.delenv("TRAJECTORY_VIZ_SOURCES", raising=False)
    status = inspect_registry(None)
    assert status["ok"] is True
    assert status["profile"] == "demo"
    assert status["path"] is not None
    assert status["source_count"] >= 1
    assert all(i["severity"] != "error" for i in status["issues"])


def test_inspect_registry_schema_invalid(clean_env, monkeypatch, tmp_path):
    bad = tmp_path / "bad-sources.yaml"
    bad.write_text(
        yaml.dump({
            "version": 1,
            "sources": {
                "broken": {
                    "label": "Broken",
                    "source_id": "broken",
                    # missing discovery + columns → ValidationError
                }
            },
        }),
        encoding="utf-8",
    )
    monkeypatch.setenv("TRAJECTORY_VIZ_SOURCES", str(bad))
    status = inspect_registry(None)
    assert status["ok"] is False
    codes = {i["code"] for i in status["issues"]}
    assert "schema_invalid" in codes
    issue = next(i for i in status["issues"] if i["code"] == "schema_invalid")
    assert "fix_it" in issue
    assert "--validate" in issue["fix_it"]


def test_inspect_registry_yaml_parse(clean_env, monkeypatch, tmp_path):
    bad = tmp_path / "broken.yaml"
    bad.write_text("sources: [\n  not: valid\n", encoding="utf-8")
    monkeypatch.setenv("TRAJECTORY_VIZ_SOURCES", str(bad))
    status = inspect_registry(None)
    assert status["ok"] is False
    assert any(i["code"] == "yaml_parse" for i in status["issues"])


def test_inspect_registry_missing_file(clean_env, monkeypatch, tmp_path):
    missing = tmp_path / "nope.yaml"
    monkeypatch.setenv("TRAJECTORY_VIZ_SOURCES", str(missing))
    status = inspect_registry(None)
    assert status["ok"] is False
    assert any(i["code"] == "sources_missing" for i in status["issues"])


def test_inspect_registry_discovery_empty(clean_env, monkeypatch, tmp_path):
    """Empty DB + globs that match nothing → discovery_empty warning."""
    root = tmp_path / "empty_out"
    root.mkdir()
    src = tmp_path / "sources.yaml"
    src.write_text(
        yaml.dump({
            "version": 1,
            "sources": {
                "ghost": {
                    "label": "Ghost",
                    "source_id": "ghost",
                    "discovery": {
                        "trips_glob": "trips/**/*.csv",
                        "latest_only": False,
                    },
                    "vehicle_key_template": "ghost:{vehicle_id}",
                    "columns": {
                        "trip_id_col": "id",
                        "vehicle_id_col": "vid",
                        "trips": {
                            "starttime": {"csv": "starttime", "type": "int"},
                            "start_lon": {"csv": "start_lon", "type": "double"},
                            "start_lat": {"csv": "start_lat", "type": "double"},
                            "end_lon": {"csv": "end_lon", "type": "double"},
                            "end_lat": {"csv": "end_lat", "type": "double"},
                        },
                    },
                }
            },
        }),
        encoding="utf-8",
    )
    monkeypatch.setenv("TRAJECTORY_VIZ_SOURCES", str(src))
    monkeypatch.setenv("TRAJECTORY_VIZ_OUTPUT_ROOT", str(root))
    conn = duckdb.connect(str(tmp_path / "test.duckdb"))
    status = inspect_registry(conn)
    conn.close()
    assert status["ok"] is True  # warnings only
    codes = {i["code"] for i in status["issues"]}
    assert "discovery_empty" in codes
    issue = next(i for i in status["issues"] if i["code"] == "discovery_empty")
    assert "--discovery" in issue["fix_it"]


def test_inspect_registry_skips_discovery_when_trips_exist(
    clean_env, monkeypatch, tmp_path,
):
    """Baked DB without source files on disk must not false-alarm."""
    root = tmp_path / "empty_out"
    root.mkdir()
    src = tmp_path / "sources.yaml"
    # Minimal valid registry pointing at missing globs.
    src.write_text(
        yaml.dump({
            "version": 1,
            "sources": {
                "ghost": {
                    "label": "Ghost",
                    "source_id": "ghost",
                    "discovery": {
                        "trips_glob": "missing/**/*.csv",
                        "latest_only": False,
                    },
                    "vehicle_key_template": "ghost:{vehicle_id}",
                    "columns": {
                        "trip_id_col": "id",
                        "vehicle_id_col": "vid",
                        "trips": {
                            "starttime": {"csv": "starttime", "type": "int"},
                            "start_lon": {"csv": "start_lon", "type": "double"},
                            "start_lat": {"csv": "start_lat", "type": "double"},
                            "end_lon": {"csv": "end_lon", "type": "double"},
                            "end_lat": {"csv": "end_lat", "type": "double"},
                        },
                    },
                }
            },
        }),
        encoding="utf-8",
    )
    monkeypatch.setenv("TRAJECTORY_VIZ_SOURCES", str(src))
    monkeypatch.setenv("TRAJECTORY_VIZ_OUTPUT_ROOT", str(root))
    conn = duckdb.connect(str(tmp_path / "test.duckdb"))
    conn.execute(
        """INSERT INTO trips (vehicle_id, trip_id, starttime, start_lon,
                              start_lat, end_lon, end_lat, vehicle_type,
                              vehicle_key, source_id)
           VALUES (1, 1, 36000, 139.0, 35.0, 139.1, 35.1,
                   'ghost', 'ghost:1', 'ghost')"""
    )
    status = inspect_registry(conn)
    conn.close()
    codes = {i["code"] for i in status["issues"]}
    assert "discovery_empty" not in codes
    assert "discovery_partial" not in codes


def test_inspect_registry_uncovered_and_ingest_failed(clean_env, monkeypatch, tmp_path):
    demo = PROJECT_ROOT / "demo" / "sources.demo.yaml"
    monkeypatch.setenv("TRAJECTORY_VIZ_SOURCES", str(demo))
    conn = duckdb.connect(str(tmp_path / "test.duckdb"))
    conn.execute(
        """INSERT INTO trips (vehicle_id, trip_id, starttime, start_lon,
                              start_lat, end_lon, end_lat, vehicle_type,
                              vehicle_key, source_id)
           VALUES (9, 1, 36000, 139.0, 35.0, 139.1, 35.1,
                   'ghost', 'ghost:9', 'ghost-fleet')"""
    )
    conn.execute(
        """INSERT INTO ingest_log (file_path, table_name, row_count)
           VALUES ('/tmp/bad.csv', 'trips', -1)"""
    )
    status = inspect_registry(conn)
    conn.close()
    codes = {i["code"] for i in status["issues"]}
    assert "uncovered_sources" in codes
    assert "ingest_failed" in codes
    uncovered = next(i for i in status["issues"] if i["code"] == "uncovered_sources")
    assert "ghost-fleet" in uncovered["message"]


def test_filter_options_includes_registry(clean_env, monkeypatch):
    monkeypatch.setenv("TRAJECTORY_VIZ_PROFILE", "demo")
    # Force fresh connection against the empty tmp DB.
    if backend.db._connection is not None:
        backend.db._connection.close()
        backend.db._connection = None
    client = TestClient(app)
    r = client.get("/api/stats/filter-options")
    assert r.status_code == 200
    body = r.json()
    assert "registry" in body
    reg = body["registry"]
    assert "ok" in reg
    assert "issues" in reg
    assert isinstance(reg["issues"], list)
    assert reg.get("profile") in (None, "demo") or isinstance(reg.get("profile"), str)


def test_filter_options_surfaces_uncovered_in_registry(clean_env, monkeypatch):
    """Uncovered fleets appear in registry.issues (UI), not only stdout."""
    demo = PROJECT_ROOT / "demo" / "sources.demo.yaml"
    # Ensure demo sources load — demo has courier/bus etc., not ghost-fleet.
    assert load_sources(demo)
    monkeypatch.setenv("TRAJECTORY_VIZ_SOURCES", str(demo))
    if backend.db._connection is not None:
        backend.db._connection.close()
        backend.db._connection = None
    client = TestClient(app)
    db = backend.db.get_connection()
    db.execute(
        """INSERT INTO trips (vehicle_id, trip_id, starttime, start_lon,
                              start_lat, end_lon, end_lat, vehicle_type,
                              vehicle_key, source_id)
           VALUES (777, 1, 36000, 139.0, 35.0, 139.1, 35.1,
                   'ghost', 'ghost:777', 'ghost-fleet')"""
    )
    try:
        body = client.get("/api/stats/filter-options").json()
        issues = body["registry"]["issues"]
        uncovered = [i for i in issues if i["code"] == "uncovered_sources"]
        assert uncovered, issues
        assert "ghost-fleet" in uncovered[0]["message"]
        assert "fix_it" in uncovered[0]
    finally:
        db.execute("DELETE FROM trips WHERE vehicle_key = 'ghost:777'")
