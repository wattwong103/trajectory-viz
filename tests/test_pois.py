"""Universal-trajectory-support Phase 1 — /api/pois endpoint tests.

TestClient pattern mirrors test_endpoints.py: build one in-memory DuckDB with
5 POIs across 2 categories (ingested through the real ingest_pois path from
GeoJSON fixtures), monkey-patch the backend.db singleton, and point
PFLOW_VIZ_SOURCES at a tmp sources.yaml so the categories endpoint can join
label/color hints.
"""

from __future__ import annotations

import json
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
from backend.ingest import ingest_pois  # noqa: E402
from backend.sources_schema import PoiConfig  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures"

_POI_LAYER = {
    "label": "Amenities",
    "glob": "pois/*.geojson",
    "color": [90, 120, 255],
    "columns": {
        "name": {"csv": "name", "type": "varchar"},
        "category": {"csv": "category", "type": "varchar"},
        "lon": {"csv": "_lon", "type": "double"},
        "lat": {"csv": "_lat", "type": "double"},
    },
}

_SOURCES_YAML = """\
version: 1
sources: {}
pois:
  amenities:
    label: "Amenities"
    glob: "pois/*.geojson"
    color: [90, 120, 255]
    columns:
      name:     { csv: name,     type: varchar }
      category: { csv: category, type: varchar }
      lon:      { csv: _lon,     type: double }
      lat:      { csv: _lat,     type: double }
"""

_EXTRA_POIS = {
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [139.760, 35.730]},
            "properties": {"name": "Station Y", "category": "station"},
        },
        {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [139.770, 35.740]},
            "properties": {"name": "Station Z", "category": "station"},
        },
    ],
}


@pytest.fixture(scope="session")
def _populated_db(tmp_path_factory):
    conn = duckdb.connect(":memory:")
    _init_schema(conn)
    tmp = tmp_path_factory.mktemp("poi-fixtures")
    extra = tmp / "extra.geojson"
    extra.write_text(json.dumps(_EXTRA_POIS))
    cfg = PoiConfig.model_validate(_POI_LAYER)
    # points.geojson: 2 cafes + 1 station; extra.geojson: 2 stations.
    ingest_pois(conn, "amenities", cfg, FIXTURES / "points.geojson")
    ingest_pois(conn, "amenities", cfg, extra, replace=False)
    yield conn
    conn.close()


@pytest.fixture(autouse=True)
def _patch_singleton(_populated_db, monkeypatch, tmp_path):
    monkeypatch.setattr(backend.db, "_connection", _populated_db)
    sources_yaml = tmp_path / "sources.yaml"
    sources_yaml.write_text(_SOURCES_YAML)
    monkeypatch.setenv("PFLOW_VIZ_SOURCES", str(sources_yaml))


@pytest.fixture
def client():
    return TestClient(app)


# --- /api/pois -----------------------------------------------------------------


def test_pois_list_all(client):
    r = client.get("/api/pois")
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == 5
    assert body["truncated"] is False
    assert len(body["pois"]) == 5
    first = body["pois"][0]
    for key in ("poi_id", "source_key", "name", "category", "lon", "lat", "props"):
        assert key in first
    assert first["source_key"] == "amenities"


def test_pois_props_parsed_from_geojson(client):
    body = client.get("/api/pois").json()
    cafe_a = next(p for p in body["pois"] if p["name"] == "Cafe A")
    assert cafe_a["props"]["rating"] == 4.5
    assert cafe_a["props"]["tags"] == ["wifi", "outlet"]


def test_pois_category_filter(client):
    body = client.get("/api/pois", params={"category": "cafe"}).json()
    assert body["count"] == 2
    assert {p["name"] for p in body["pois"]} == {"Cafe A", "Cafe B"}
    body = client.get("/api/pois", params={"category": "station"}).json()
    assert body["count"] == 3


def test_pois_source_key_filter(client):
    body = client.get("/api/pois", params={"source_key": "amenities"}).json()
    assert body["count"] == 5
    body = client.get("/api/pois", params={"source_key": "nonexistent"}).json()
    assert body["count"] == 0


def test_pois_bbox_filter(client):
    # Box around Cafe A + Cafe B only (Station X sits at 139.720, outside).
    body = client.get("/api/pois", params={
        "bbox": "139.69,35.67,139.715,35.695",
    }).json()
    assert {p["name"] for p in body["pois"]} == {"Cafe A", "Cafe B"}


def test_pois_limit_and_truncated(client):
    body = client.get("/api/pois", params={"limit": 2}).json()
    assert body["count"] == 2
    assert len(body["pois"]) == 2
    assert body["truncated"] is True
    body = client.get("/api/pois", params={"limit": 5}).json()
    assert body["truncated"] is False


def test_pois_poi_ids_unique_within_layer(client):
    body = client.get("/api/pois").json()
    ids = [p["poi_id"] for p in body["pois"]]
    assert len(ids) == len(set(ids))


def test_pois_rejects_bad_category(client):
    r = client.get("/api/pois", params={"category": "cafe'; DROP TABLE pois;--"})
    assert r.status_code == 422


def test_pois_rejects_bad_source_key(client):
    r = client.get("/api/pois", params={"source_key": "UPPER Case"})
    assert r.status_code == 422


def test_pois_rejects_malformed_bbox(client):
    r = client.get("/api/pois", params={"bbox": "139.7,35.6"})
    assert r.status_code == 422


def test_pois_rejects_inverted_bbox(client):
    r = client.get("/api/pois", params={"bbox": "139.8,35.6,139.7,35.7"})
    assert r.status_code == 422
    assert "w < e" in r.json()["detail"]


def test_pois_rejects_out_of_range_limit(client):
    r = client.get("/api/pois", params={"limit": 100001})
    assert r.status_code == 422


# --- /api/pois/categories ---------------------------------------------------------


def test_poi_categories(client):
    r = client.get("/api/pois/categories")
    assert r.status_code == 200
    body = r.json()
    by_cat = {c["category"]: c for c in body["categories"]}
    assert by_cat["cafe"]["count"] == 2
    assert by_cat["station"]["count"] == 3
    # Label/color joined in from the (monkeypatched) sources.yaml.
    assert by_cat["cafe"]["label"] == "Amenities"
    assert by_cat["cafe"]["color"] == [90, 120, 255]
    assert by_cat["cafe"]["source_key"] == "amenities"


def test_poi_categories_degrades_without_sources_yaml(client, monkeypatch):
    """A missing sources.yaml must not break the endpoint — hints go null."""
    monkeypatch.setenv("PFLOW_VIZ_SOURCES", "/nonexistent/sources.yaml")
    r = client.get("/api/pois/categories")
    assert r.status_code == 200
    body = r.json()
    by_cat = {c["category"]: c for c in body["categories"]}
    assert by_cat["cafe"]["count"] == 2
    assert by_cat["cafe"]["color"] is None
    assert by_cat["cafe"]["label"] is None
