"""Phase 2C — building binary format + endpoint tests.

Covers the PBLD pack/unpack round-trip (quantization error bound), tatemono
square synthesis, skyline-preserving sampling, and the /api/buildings routes.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from backend.app import app  # noqa: E402
from backend.buildings_io import (  # noqa: E402
    Building,
    BuildingSet,
    clip_bbox,
    pack,
    ring_area_m2,
    sample_buildings,
    synthesize_from_tatemono,
    unpack,
)

# Quantization unit is 1e-5° ≈ 1.11 m; worst-case rounding error is half a
# unit per axis → ~0.8 m diagonal. 1.2 m is the acceptance bound.
MAX_ERR_DEG = 1.2 / 111_320.0


def _square(lon: float, lat: float, half: float) -> list[tuple[float, float]]:
    return [
        (lon - half, lat - half), (lon + half, lat - half),
        (lon + half, lat + half), (lon - half, lat + half),
    ]


@pytest.fixture
def sample_set() -> BuildingSet:
    return BuildingSet(
        buildings=[
            Building(rings=[_square(139.76, 35.68, 0.0002)], height_m=120.0),
            Building(  # with a courtyard hole
                rings=[_square(139.70, 35.65, 0.0004), _square(139.70, 35.65, 0.0001)],
                height_m=15.5,
            ),
            Building(rings=[_square(139.80, 35.70, 0.0001)], height_m=8.0),
        ],
        city="tokyo", source="test", heights_synthesized=False,
    )


# --- pack/unpack round-trip ---------------------------------------------------


def test_pack_unpack_round_trip(sample_set):
    out = unpack(pack(sample_set))
    assert len(out.buildings) == 3
    assert out.city == "tokyo"
    assert out.heights_synthesized is False
    for orig, dec in zip(sample_set.buildings, out.buildings, strict=True):
        assert len(dec.rings) == len(orig.rings)
        assert dec.height_m == pytest.approx(orig.height_m, abs=0.05)  # dm rounding
        for r_orig, r_dec in zip(orig.rings, dec.rings, strict=True):
            assert len(r_dec) == len(r_orig)
            for (lon1, lat1), (lon2, lat2) in zip(r_orig, r_dec, strict=True):
                assert abs(lon1 - lon2) < MAX_ERR_DEG
                assert abs(lat1 - lat2) < MAX_ERR_DEG


def test_pack_rejects_empty_and_degenerate():
    with pytest.raises(ValueError):
        pack(BuildingSet(buildings=[]))
    with pytest.raises(ValueError):
        pack(BuildingSet(buildings=[
            Building(rings=[[(139.7, 35.6), (139.8, 35.7)]], height_m=10),
        ]))


# --- tatemono synthesis -------------------------------------------------------


def test_synthesize_from_tatemono():
    # 400 m² footprint at Tokyo latitude, expressed in deg² as the CSV does
    area_deg2 = 400 / (111_320.0 * 111_320.0 * 0.813)  # cos(35.6°) ≈ 0.813
    out = synthesize_from_tatemono([(139.7, 35.6, area_deg2)])
    assert len(out) == 1
    b = out[0]
    assert len(b.rings) == 1 and len(b.rings[0]) == 4
    assert ring_area_m2(b.outer()) == pytest.approx(400, rel=0.05)
    assert 6.0 <= b.height_m <= 60.0


def test_synthesize_drops_tiny_footprints():
    tiny_deg2 = 10 / (111_320.0 ** 2)  # 10 m² < 25 m² floor
    assert synthesize_from_tatemono([(139.7, 35.6, tiny_deg2)]) == []


def test_synthesize_is_deterministic():
    area = 400 / (111_320.0 ** 2)
    a = synthesize_from_tatemono([(139.7, 35.6, area)])
    b = synthesize_from_tatemono([(139.7, 35.6, area)])
    assert a[0].height_m == b[0].height_m


def test_synthesize_splits_dissolved_blocks_into_low_rise_grid():
    # 43,000 m² row = a dissolved shotengai block (Kichijoji station area),
    # NOT one building. Must become many low-rise cells, never one 60 m slab.
    area_deg2 = 43_000 / (111_320.0 * 111_320.0 * 0.813)
    out = synthesize_from_tatemono([(139.58, 35.6, area_deg2)])
    assert len(out) > 20                                  # gridded, not one square
    assert all(b.height_m <= 16.0 for b in out)           # low-rise arcade heights
    # each cell is small and the cells tile the original extent with gaps
    assert all(ring_area_m2(b.outer()) < 1000 for b in out)
    total_cell_area = sum(ring_area_m2(b.outer()) for b in out)
    assert total_cell_area < 43_000                        # gaps exist


# --- sampling -----------------------------------------------------------------


def test_sample_keeps_all_tall_buildings():
    tall = [Building(rings=[_square(139.7 + i * 0.001, 35.6, 0.0001)], height_m=80)
            for i in range(5)]
    low = [Building(rings=[_square(139.8 + i * 0.001, 35.6, 0.0001)], height_m=10)
           for i in range(50)]
    out = sample_buildings(tall + low, max_buildings=20)
    assert len(out) == 20
    assert sum(1 for b in out if b.height_m >= 25) == 5   # skyline intact


def test_sample_noop_under_cap():
    b = [Building(rings=[_square(139.7, 35.6, 0.0001)], height_m=10)]
    assert sample_buildings(b, max_buildings=10) == b


def test_clip_bbox():
    inside = Building(rings=[_square(139.7, 35.6, 0.0001)], height_m=10)
    outside = Building(rings=[_square(140.5, 36.5, 0.0001)], height_m=10)
    out = clip_bbox([inside, outside], 139.5, 35.5, 139.9, 35.8)
    assert out == [inside]


# --- endpoints ----------------------------------------------------------------


@pytest.fixture
def client(tmp_path, monkeypatch, sample_set):
    monkeypatch.setenv("PFLOW_VIZ_BUILDINGS_DIR", str(tmp_path))
    (tmp_path / "tokyo.bin").write_bytes(pack(sample_set))
    return TestClient(app)


def test_buildings_list(client):
    r = client.get("/api/buildings")
    assert r.status_code == 200
    cities = r.json()["cities"]
    assert len(cities) == 1
    assert cities[0]["city"] == "tokyo"
    assert cities[0]["n_buildings"] == 3
    assert cities[0]["synthesized"] is False


def test_buildings_get_city(client):
    r = client.get("/api/buildings/tokyo")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/octet-stream")
    decoded = unpack(r.content)
    assert len(decoded.buildings) == 3


def test_buildings_404_unknown_city(client):
    assert client.get("/api/buildings/osaka").status_code == 404


def test_buildings_rejects_path_traversal(client):
    # '..' and separators fail the ^[a-z_]+$ pattern → 422, never a file read
    for bad in ("..%2F..%2Fetc", "..", "a.b"):
        r = client.get(f"/api/buildings/{bad}")
        assert r.status_code in (404, 422)


def test_buildings_list_empty_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("PFLOW_VIZ_BUILDINGS_DIR", str(tmp_path / "nope"))
    r = TestClient(app).get("/api/buildings")
    assert r.status_code == 200
    assert r.json()["cities"] == []
