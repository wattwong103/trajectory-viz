"""Universal-trajectory-support Phase 1 — format normalizer tests.

Pins the canonical staging shape (the `_`-prefixed fields), epoch-ms
correctness across timezone offsets, seq/feature-id monotonicity, and the
naive→UTC timestamp contract against the committed fixtures in
tests/fixtures/.
"""

from __future__ import annotations

import json
import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from backend.formats import (  # noqa: E402
    detect_format,
    normalize_geojson,
    normalize_gpx,
    normalize_ndjson,
    parse_time_to_ms,
)

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def _ms(iso: str) -> int:
    """Expected epoch ms for an ISO string (naive → UTC, per the contract)."""
    dt = datetime.fromisoformat(iso)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return int(dt.timestamp() * 1000)


# --- detect_format ------------------------------------------------------------


@pytest.mark.parametrize(
    "filename, expected",
    [
        ("a.csv", "csv"),
        ("a.geojson", "geojson"),
        ("a.gpx", "gpx"),
        ("a.ndjson", "ndjson"),
        ("a.jsonl", "ndjson"),
        ("a.parquet", "parquet"),
        ("a.pq", "parquet"),
        ("A.GPX", "gpx"),
    ],
)
def test_detect_format_from_extension(filename, expected):
    assert detect_format(filename, None) == expected


def test_detect_format_declared_wins():
    assert detect_format("a.unknownext", "gpx") == "gpx"
    assert detect_format("a.json", "geojson") == "geojson"


def test_detect_format_json_ambiguous():
    with pytest.raises(ValueError, match="ambiguous"):
        detect_format("a.json", None)


def test_detect_format_unknown_extension():
    with pytest.raises(ValueError, match="unknown extension"):
        detect_format("a.shp", None)


# --- parse_time_to_ms ---------------------------------------------------------


def test_parse_time_naive_assumed_utc():
    assert parse_time_to_ms("2024-05-01T08:00:00") == parse_time_to_ms(
        "2024-05-01T08:00:00Z"
    )


def test_parse_time_offset_honored():
    assert parse_time_to_ms("2024-05-01T17:00:00+09:00") == parse_time_to_ms(
        "2024-05-01T08:00:00Z"
    )


def test_parse_time_numeric_epoch():
    # Seconds vs milliseconds auto-detection (threshold 1e11).
    assert parse_time_to_ms(1714550400) == 1714550400000
    assert parse_time_to_ms(1714550400000) == 1714550400000
    assert parse_time_to_ms(None) is None


# --- GeoJSON Points -----------------------------------------------------------


def test_points_geojson_canonical_fields():
    rows = list(normalize_geojson(FIXTURES / "points.geojson"))
    assert len(rows) == 3

    first = rows[0]
    assert first["_lon"] == pytest.approx(139.700)
    assert first["_lat"] == pytest.approx(35.680)
    assert first["_seq"] == 0
    assert first["_feature_id"] == 0
    assert first["_time_ms"] == _ms("2024-05-01T09:00:00+09:00")
    # First-level scalars flattened; nested arrays only in _props_json.
    assert first["name"] == "Cafe A"
    assert first["category"] == "cafe"
    assert first["rating"] == pytest.approx(4.5)
    assert "tags" not in first
    props = json.loads(first["_props_json"])
    assert props["tags"] == ["wifi", "outlet"]
    # The consumed time prop is surfaced as _time_ms, not duplicated.
    assert "time" not in props

    # No time property → NULL _time_ms.
    assert rows[1]["_time_ms"] is None
    # Z-suffix parses identically to the equivalent +09:00 instant.
    assert rows[2]["_time_ms"] == _ms("2024-05-01T09:00:00+09:00")


def test_points_geojson_feature_ids_monotonic():
    rows = list(normalize_geojson(FIXTURES / "points.geojson"))
    assert [r["_feature_id"] for r in rows] == [0, 1, 2]


# --- GeoJSON LineStrings -------------------------------------------------------


def test_lines_geojson_coord_times():
    rows = list(normalize_geojson(FIXTURES / "lines.geojson", "coordTimes"))
    # 3 + 2 + 4 coordinates across the three features.
    assert len(rows) == 9

    bus1 = [r for r in rows if r["vehicle"] == "bus-1"]
    assert [r["_seq"] for r in bus1] == [0, 1, 2]
    assert {r["_feature_id"] for r in bus1} == {0}
    assert [r["_time_ms"] for r in bus1] == [
        _ms("2024-05-01T08:00:00+09:00"),
        _ms("2024-05-01T08:01:00+09:00"),
        _ms("2024-05-01T08:02:00+09:00"),
    ]


def test_lines_geojson_feature_time_fallback():
    """LineString without coordTimes → every coordinate gets the feature's
    `time` property."""
    rows = list(normalize_geojson(FIXTURES / "lines.geojson", "coordTimes"))
    bus2 = [r for r in rows if r["vehicle"] == "bus-2"]
    assert len(bus2) == 2
    assert all(r["_time_ms"] == _ms("2024-05-01T09:00:00+09:00") for r in bus2)


def test_lines_geojson_no_coord_times_prop_declared():
    """Without coord_times_prop, per-coordinate time falls back to the
    feature `time` property (or NULL)."""
    rows = list(normalize_geojson(FIXTURES / "lines.geojson"))
    bus1 = [r for r in rows if r["vehicle"] == "bus-1"]
    assert all(r["_time_ms"] is None for r in bus1)


# --- GPX ------------------------------------------------------------------------


def test_gpx_canonical_fields():
    rows = list(normalize_gpx(FIXTURES / "track.gpx"))
    assert len(rows) == 5

    first = rows[0]
    assert first["_lon"] == pytest.approx(139.700)
    assert first["_lat"] == pytest.approx(35.680)
    assert first["_trk_name"] == "morning-run"
    assert first["_feature_id"] == "0:0"
    assert first["_time_ms"] == _ms("2024-05-01T08:00:00Z")
    props = json.loads(first["_props_json"])
    assert props["ele"] == pytest.approx(12.5)


def test_gpx_seq_cumulative_and_feature_ids():
    rows = list(normalize_gpx(FIXTURES / "track.gpx"))
    assert [r["_seq"] for r in rows] == [0, 1, 2, 3, 4]
    assert [r["_feature_id"] for r in rows] == ["0:0", "0:0", "1:0", "1:0", "1:1"]


def test_gpx_unnamed_track_fallback():
    rows = list(normalize_gpx(FIXTURES / "track.gpx"))
    assert rows[2]["_trk_name"] == "trk1"


def test_gpx_timezone_offsets_match_utc():
    """The 17:00:00+09:00 trkpt must land on the same epoch ms as 08:00:00Z."""
    rows = list(normalize_gpx(FIXTURES / "track.gpx"))
    assert rows[2]["_time_ms"] == rows[0]["_time_ms"] == _ms("2024-05-01T08:00:00Z")


def test_gpx_naive_time_assumed_utc():
    rows = list(normalize_gpx(FIXTURES / "track.gpx"))
    assert rows[4]["_time_ms"] == _ms("2024-05-01T18:00:00Z")


def test_gpx_extensions_in_props_json():
    rows = list(normalize_gpx(FIXTURES / "track.gpx"))
    props = json.loads(rows[1]["_props_json"])
    assert props["extensions"] == {"hr": "132"}


# --- NDJSON ---------------------------------------------------------------------


def test_ndjson_canonical_fields():
    rows = list(normalize_ndjson(FIXTURES / "pings.ndjson"))
    assert len(rows) == 4  # blank line skipped

    first = rows[0]
    assert first["vehicle"] == "veh-A"
    assert first["lon"] == pytest.approx(139.700)
    assert first["battery"] == pytest.approx(0.9)
    # Whole row preserved; nested objects NOT flattened.
    assert "meta" not in first
    assert json.loads(first["_props_json"])["meta"] == {"fw": 3}


def test_ndjson_seq_and_feature_id_are_line_numbers():
    rows = list(normalize_ndjson(FIXTURES / "pings.ndjson"))
    assert [r["_seq"] for r in rows] == [0, 1, 3, 4]
    assert [r["_feature_id"] for r in rows] == [0, 1, 3, 4]


def test_ndjson_rejects_non_object_line(tmp_path):
    p = tmp_path / "bad.ndjson"
    p.write_text('{"a": 1}\n[1, 2, 3]\n')
    with pytest.raises(ValueError, match="not a JSON object"):
        list(normalize_ndjson(p))
