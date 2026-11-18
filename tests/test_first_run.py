"""Zero-friction first-run helpers (TV-3).

Covers demo DB readiness checks used by Docker entrypoint + demo CLI,
and the API empty-hint payload when the DB has no trips.
"""

from __future__ import annotations

import os
from pathlib import Path

import duckdb
import pytest
from fastapi.testclient import TestClient

import backend.db
import backend.demo
from backend.app import app
from backend.db import _init_schema
from backend.demo import (
    db_has_trips,
    ensure_demo_db,
    frontend_dist_ready,
    ui_serve_hint,
)

PROJECT_ROOT = Path(__file__).resolve().parent.parent

_DEMO_ENV_KEYS = (
    "PFLOW_VIZ_DB",
    "PFLOW_VIZ_SOURCES",
    "PFLOW_VIZ_OUTPUT_ROOT",
    "TRAJECTORY_VIZ_DB",
    "TRAJECTORY_VIZ_SOURCES",
    "TRAJECTORY_VIZ_OUTPUT_ROOT",
    "TRAJECTORY_VIZ_PROFILE",
)


@pytest.fixture
def clean_demo_env(monkeypatch):
    for key in _DEMO_ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
    if backend.db._connection is not None:
        backend.db._connection.close()
        backend.db._connection = None
    yield
    if backend.db._connection is not None:
        backend.db._connection.close()
        backend.db._connection = None
    for key in _DEMO_ENV_KEYS:
        os.environ.pop(key, None)


def test_db_has_trips_false_when_missing(tmp_path):
    assert db_has_trips(tmp_path / "missing.duckdb") is False


def test_db_has_trips_false_on_empty_schema(tmp_path):
    db = tmp_path / "empty.duckdb"
    conn = duckdb.connect(str(db))
    _init_schema(conn)
    conn.close()
    assert db_has_trips(db) is False


def test_ensure_demo_db_seeds_missing(tmp_path, clean_demo_env):
    db = tmp_path / "demo.duckdb"
    assert not db.is_file()
    counts = ensure_demo_db(db, seed=True)
    assert db.is_file()
    assert counts["trips"] > 0
    assert db_has_trips(db) is True


def test_ensure_demo_db_noop_when_seed_false_and_missing(tmp_path, clean_demo_env):
    db = tmp_path / "demo.duckdb"
    counts = ensure_demo_db(db, seed=False)
    assert counts["trips"] == 0
    assert not db.is_file() or not db_has_trips(db)


def test_ensure_demo_db_reuses_existing(tmp_path, clean_demo_env, monkeypatch):
    db = tmp_path / "demo.duckdb"
    first = ensure_demo_db(db, seed=True)
    resets: list[bool] = []
    real_run = backend.demo.run_demo

    def _wrap(path, reset=False):
        resets.append(reset)
        return real_run(path, reset=reset)

    monkeypatch.setattr(backend.demo, "run_demo", _wrap)
    second = ensure_demo_db(db, seed=True)
    assert second["trips"] == first["trips"]
    assert resets == [False]


def test_frontend_dist_ready_false_without_index(tmp_path, monkeypatch):
    missing = tmp_path / "dist"
    monkeypatch.setattr(backend.demo, "_FRONTEND_DIST", missing)
    assert frontend_dist_ready() is False


def test_ui_serve_hint_mentions_build_or_compose_when_no_dist(tmp_path, monkeypatch):
    monkeypatch.setattr(backend.demo, "_FRONTEND_DIST", tmp_path / "nope")
    hint = ui_serve_hint()
    assert "npm run build" in hint or "docker compose" in hint.lower()
    assert "5173" in hint or "compose" in hint.lower()


def test_stats_empty_hint_when_no_trips(tmp_path, monkeypatch, clean_demo_env):
    db = tmp_path / "empty.duckdb"
    conn = duckdb.connect(str(db))
    _init_schema(conn)
    conn.close()
    monkeypatch.setenv("TRAJECTORY_VIZ_DB", str(db))
    monkeypatch.setenv("PFLOW_VIZ_DB", str(db))
    # Force a fresh singleton against the empty DB.
    if backend.db._connection is not None:
        backend.db._connection.close()
        backend.db._connection = None
    client = TestClient(app)
    r = client.get("/api/stats")
    assert r.status_code == 200
    body = r.json()
    assert body["trips"]["row_count"] == 0
    assert "empty_hint" in body
    hint = body["empty_hint"]
    assert "upload" in hint.lower() or "demo" in hint.lower()
    assert "docker compose" in hint.lower() or "trajectory-viz-demo" in hint
