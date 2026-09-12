"""Zone (polygon layer) tests — sources.yaml `zones:` block.

Covers: schema validation, polygon extraction (Polygon + MultiPolygon +
hole rings), ingest with bbox precompute and idempotent replace, the
/api/zones endpoint (source_key + bbox-intersection filters), and reset
dropping the table. Singleton monkey-patch pattern as in test_pois.py.
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
from backend.app import app  # noqa: E402
from backend.db import _init_schema, reset_db  # noqa: E402
from backend.formats import extract_geojson_polygons  # noqa: E402
from backend.sources_schema import (  # noqa: E402
    SourcesFile,
    load_sources,
)

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def _zone_cfg(tmp_path: Path, glob: str = "zones/*.geojson") -> tuple[SourcesFile, Path]:
    yaml_text = f"""
version: 1
sources: {{}}
zones:
  wards:
    label: "Service Wards"
    glob: "{glob}"
    color: [120, 200, 160]
    columns:
      name:     {{ csv: name, type: varchar }}
      category: {{ csv: category, type: varchar }}
"""
    p = tmp_path / "sources.yaml"
    p.write_text(yaml_text)
    return load_sources(str(p)), tmp_path


# --- Schema ---------------------------------------------------------------------


def test_zone_config_validates(tmp_path):
    sources, _ = _zone_cfg(tmp_path)
    z = sources.zones["wards"]
    assert z.label == "Service Wards"
    assert z.color == (120, 200, 160)


def test_zone_config_rejects_bad_color(tmp_path):
    p = tmp_path / "bad.yaml"
    p.write_text("""
version: 1
sources: {}
zones:
  x:
    label: "X"
    glob: "z.geojson"
    color: [300, 0, 0]
    columns: {}
""")
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        load_sources(str(p))


def test_zone_config_rejects_derived_columns(tmp_path):
    """derived:/transform: can't run on the zones' pure-Python ingest path —
    validation must fail loudly instead of silently dropping the mapping."""
    p = tmp_path / "derived.yaml"
    p.write_text("""
version: 1
sources: {}
zones:
  x:
    label: "X"
    glob: "z.geojson"
    columns:
      name: { derived: "'fixed'" }
""")
    from pydantic import ValidationError
    with pytest.raises(ValidationError, match="plain `csv:`"):
        load_sources(str(p))


def test_zones_merge_and_dryrun(tmp_path):
    """Uploads-registry merge path carries zones; dryrun reports zone: keys."""
    from backend.sources_schema import dryrun_discovery, load_sources_merged

    base = tmp_path / "base.yaml"
    up = tmp_path / "up.yaml"
    base.write_text("""
version: 1
sources: {}
zones:
  a:
    label: "A"
    glob: "a.geojson"
    columns: {}
""")
    up.write_text("""
version: 1
sources: {}
zones:
  b:
    label: "B"
    glob: "b.geojson"
    columns: {}
""")
    merged = load_sources_merged(base, up)
    assert sorted(merged.zones or {}) == ["a", "b"]
    assert dryrun_discovery(merged, tmp_path) == {"zone:a": 0, "zone:b": 0}


# --- Polygon extraction ------------------------------------------------------------


def test_extract_polygons_polygon_and_multipolygon():
    recs = list(extract_geojson_polygons(FIXTURES / "zones.geojson"))
    assert len(recs) == 2
    a, b = recs
    assert a["_geometry"]["type"] == "Polygon"
    # Outer ring + one hole.
    assert len(a["_geometry"]["coordinates"]) == 2
    assert a["name"] == "Ward A"
    assert b["_geometry"]["type"] == "MultiPolygon"
    assert b["_props_json"].count("Islands") == 1


# --- Ingest -------------------------------------------------------------------------


@pytest.fixture
def zone_db(tmp_path):
    """Fresh DB with the two fixture zones already ingested."""
    conn = duckdb.connect(":memory:")
    _init_schema(conn)
    sources, root = _zone_cfg(tmp_path)
    from backend.ingest import ingest_zones

    ingest_zones(conn, "wards", sources.zones["wards"], FIXTURES / "zones.geojson")
    yield conn, sources, root
    conn.close()


def test_ingest_zones_rows_bbox_and_replace(zone_db):
    conn, sources, _root = zone_db
    from backend.ingest import ingest_zones

    # Fixture ingest happened once; re-ingesting must replace, not append.
    path = FIXTURES / "zones.geojson"
    n = ingest_zones(conn, "wards", sources.zones["wards"], path, replace=True)
    assert n == 2

    rows = conn.execute(
        "SELECT zone_id, source_key, name, min_lon, max_lon FROM zones ORDER BY zone_id"
    ).fetchall()
    assert [(r[0], r[1], r[2]) for r in rows] == [(0, "wards", "Ward A"), (1, "wards", "Islands B")]
    assert rows[0][3] == pytest.approx(139.0)
    assert rows[0][4] == pytest.approx(139.1)

    # Idempotent replace: same file again → still 2 rows, not 4.
    n2 = ingest_zones(conn, "wards", sources.zones["wards"], path)
    assert n2 == 2
    assert conn.execute("SELECT COUNT(*) FROM zones").fetchone()[0] == 2


# --- Endpoint ------------------------------------------------------------------------


@pytest.fixture
def client(zone_db, monkeypatch):
    conn, sources, root = zone_db
    monkeypatch.setattr(backend.db, "_connection", conn)
    return TestClient(app)


def test_zones_endpoint_returns_geometry(client):
    body = client.get("/api/zones").json()
    assert body["count"] == 2
    z = body["zones"][0]
    assert z["geometry"]["type"] == "Polygon"
    assert z["bbox"]["w"] == pytest.approx(139.0)
    assert z["name"] == "Ward A"
    assert z["category"] == "service"


def test_zones_endpoint_bbox_intersects(client):
    # Overlaps Ward A's bbox only.
    body = client.get("/api/zones", params={"bbox": "138.95,34.95,139.05,35.05"}).json()
    assert body["count"] == 1
    assert body["zones"][0]["name"] == "Ward A"
    # Far away → nothing.
    body = client.get("/api/zones", params={"bbox": "150,40,151,41"}).json()
    assert body["count"] == 0


def test_zones_endpoint_source_filter_and_bad_bbox(client):
    assert client.get("/api/zones", params={"source_key": "nope"}).json()["count"] == 0
    r = client.get("/api/zones", params={"bbox": "5,5,1,1"})   # w > e → 422
    assert r.status_code == 422


def test_zone_styles_endpoint(client):
    """Render hints come from the sources registry (label; color may be null)."""
    body = client.get("/api/zones/styles").json()
    assert "styles" in body


def test_zone_styles_degrades_without_registry(client, monkeypatch):
    """Unusable sources.yaml → {} styles, endpoint still 200."""
    import backend.sources_schema as schema_mod

    def _boom(*a, **k):
        raise FileNotFoundError("no registry")
    # _zone_styles imports load_sources_merged lazily from sources_schema,
    # so the patch belongs on that module.
    monkeypatch.setattr(schema_mod, "load_sources_merged", _boom)
    body = client.get("/api/zones/styles").json()
    assert body == {"styles": {}}


def test_zones_skips_unparseable_geometry(client, zone_db):
    """Corrupt geometry_json rows are skipped, not fatal to the response."""
    conn, _, _ = zone_db
    conn.execute(
        "INSERT INTO zones (zone_id, source_key, name, geometry_json) "
        "VALUES (99, 'wards', 'Broken', 'not-json{{{')"
    )
    try:
        body = client.get("/api/zones").json()
        assert body["count"] == 2
        assert {z["name"] for z in body["zones"]} == {"Ward A", "Islands B"}
    finally:
        conn.execute("DELETE FROM zones WHERE zone_id = 99")


def test_zones_tolerates_unparseable_props(client, zone_db):
    """Corrupt props_json degrades to props=null on that zone only."""
    conn, _, _ = zone_db
    conn.execute(
        "UPDATE zones SET props_json = 'not-json{{{' WHERE zone_id = 0"
    )
    try:
        body = client.get("/api/zones").json()
        assert body["count"] == 2
        ward_a = next(z for z in body["zones"] if z["name"] == "Ward A")
        assert ward_a["props"] is None
    finally:
        conn.execute("UPDATE zones SET props_json = NULL WHERE zone_id = 0")


def test_reset_drops_zones(zone_db, monkeypatch):
    conn, _, _ = zone_db
    monkeypatch.setattr(backend.db, "_connection", conn)

    # Minimal smoke: table exists pre-reset, gone post-reset via re-init.
    assert conn.execute(
        "SELECT COUNT(*) FROM information_schema.tables WHERE table_name='zones'"
    ).fetchone()[0] == 1
    reset_db()
    assert conn.execute(
        "SELECT COUNT(*) FROM information_schema.tables WHERE table_name='zones'"
    ).fetchone()[0] == 1   # recreated by _init_schema
    assert conn.execute("SELECT COUNT(*) FROM zones").fetchone()[0] == 0


# --- Point-in-zone lookup (/api/zones/contains) ----------------------------------

from backend.db import ensure_spatial, spatial_available  # noqa: E402

_SPATIAL_OK = ensure_spatial(duckdb.connect(":memory:"))


def test_contains_bbox_fallback(client, monkeypatch):
    """Without the spatial extension the endpoint degrades to bbox mode."""
    monkeypatch.setattr("backend.db._spatial_loaded", False)
    body = client.get("/api/zones/contains", params={"lon": 139.05, "lat": 35.02}).json()
    assert body["mode"] == "bbox"
    names = {z["name"] for z in body["zones"]}
    assert names == {"Ward A"}   # Islands B is far away


def test_contains_spatial_exact(monkeypatch, tmp_path):
    """With spatial loaded, holes exclude points and MultiPolygons still hit."""
    if not _SPATIAL_OK:
        pytest.skip("duckdb spatial extension unavailable")
    conn = duckdb.connect(":memory:")
    try:
        # Spatial loads are per-connection: load it on THIS connection.
        assert ensure_spatial(conn)
        assert spatial_available()
        _init_schema(conn)
        from backend.ingest import ingest_zones
        from backend.sources_schema import load_sources

        yaml_text = """
version: 1
sources: {}
zones:
  wards:
    label: "Service Wards"
    glob: "zones/*.geojson"
    columns:
      name: { csv: name, type: varchar }
"""
        p = tmp_path / "zone_sources.yaml"
        p.write_text(yaml_text)
        sources = load_sources(str(p))
        ingest_zones(conn, "wards", sources.zones["wards"], FIXTURES / "zones.geojson")

        monkeypatch.setattr("backend.db._connection", conn)
        client2 = TestClient(app)

        # Inside Ward A's outer ring.
        body = client2.get("/api/zones/contains", params={"lon": 139.01, "lat": 35.01}).json()
        assert body["mode"] == "spatial"
        assert [z["name"] for z in body["zones"]] == ["Ward A"]
        # Inside the hole → NOT within the polygon (exact vs bbox!).
        body = client2.get("/api/zones/contains", params={"lon": 139.05, "lat": 35.05}).json()
        assert body["count"] == 0
        # MultiPolygon member.
        body = client2.get("/api/zones/contains", params={"lon": 140.05, "lat": 36.05}).json()
        assert [z["name"] for z in body["zones"]] == ["Islands B"]
    finally:
        conn.close()
