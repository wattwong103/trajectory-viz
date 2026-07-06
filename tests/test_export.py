"""Phase 2D — single-HTML cinematic export tests.

Reuses test_endpoints.py's synthetic DB builder against an in-memory DuckDB,
a stub vendor bundle, and the real export_template.html. Asserts:
 - the packing round-trips within the 1.2 m quantization bound
 - the emitted HTML has no external URLs (except the license-comment
   allowlist) and no unsubstituted placeholders
 - trajectory count == what the DB holds; size gate + graceful skips behave
"""

from __future__ import annotations

import base64
import math
import re
import struct
import sys
from pathlib import Path

import duckdb
import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import backend.export as export  # noqa: E402

# Reuse the endpoint fixture's data builder verbatim.
from tests.test_endpoints import _populate_db  # noqa: E402

STUB_VENDOR = "window.deck = window.deck || {}; /* stub deck.gl bundle */"

# Hosts allowed to appear (only inside the attribution/license text/comments).
_URL_RE = re.compile(r"https?://[^\s\"'<>)]+")
_ALLOWED_URL_SUBSTR = ("plateau", "gsi.go.jp", "mlit.go.jp")


@pytest.fixture
def conn(tmp_path):
    c = duckdb.connect(":memory:")
    _populate_db(c, tmp_path)
    return c


def test_pack_round_trip():
    trajectories = [{
        "path": [(139.700, 35.600), (139.7123, 35.6100), (139.8000, 35.7000)],
        "timestamps": [28800, 28830, 28900],
        "source_id": "taxi", "vehicle_key": "taxi:tokyo:47", "agent": False,
    }]
    sources = [{"id": "taxi", "label": "Taxi", "color": [23, 184, 190], "mode": "trails"}]
    block, meta = export.pack_trajectories(trajectories, sources)
    olon, olat = meta["origin"]
    s = meta["scale"]

    counts = struct.unpack("<1H", base64.b64decode(block["counts"]))
    starts = struct.unpack("<2i", base64.b64decode(block["starts"]))
    deltas = struct.unpack(f"<{(counts[0]-1)*2}h", base64.b64decode(block["deltas"]))

    # Reconstruct and compare to the original coordinates.
    pts = [(olon + starts[0] * s, olat + starts[1] * s)]
    x, y = starts
    for i in range(counts[0] - 1):
        x += deltas[i * 2]
        y += deltas[i * 2 + 1]
        pts.append((olon + x * s, olat + y * s))
    for (lo, la), (ro, ra) in zip(trajectories[0]["path"], pts, strict=True):
        assert math.isclose(lo, ro, abs_tol=1.2 / 111_320)
        assert math.isclose(la, ra, abs_tol=1.2 / 111_320)


def test_export_html_is_self_contained(conn):
    html = export.export_html(
        conn, STUB_VENDOR, title="Test", vehicle_type="truck",
        sample_n=10, include_pulse=True,
    )
    # No unsubstituted placeholders.
    assert "{{" not in html
    # Every URL in the file must be in the license allowlist.
    for url in _URL_RE.findall(html):
        assert any(sub in url.lower() for sub in _ALLOWED_URL_SUBSTR), \
            f"unexpected external URL in export: {url}"
    # Stub bundle + payload made it in.
    assert "stub deck.gl bundle" in html
    assert 'id="payload"' in html


def test_export_trajectory_count_matches_db(conn):
    # Fixture has one truck trajectory-trip with waypoints (truck 1001 trip 1 & 2).
    html = export.export_html(conn, STUB_VENDOR, vehicle_type="truck", sample_n=50,
                              include_pulse=False)
    import json
    payload = json.loads(re.search(
        r'id="payload"[^>]*>(.*?)</script>', html, re.S).group(1))
    n = payload["meta"]["nTraj"]
    db_n = conn.execute(
        "SELECT COUNT(*) FROM (SELECT DISTINCT vehicle_id, trip_id FROM waypoints "
        "WHERE vehicle_type = 'truck')"
    ).fetchone()[0]
    assert n == db_n


def test_export_includes_agents(conn):
    import json
    html = export.export_html(conn, STUB_VENDOR, vehicle_type="truck", sample_n=1,
                              agents=["truck:1001"], include_pulse=False)
    payload = json.loads(re.search(
        r'id="payload"[^>]*>(.*?)</script>', html, re.S).group(1))
    assert "truck:1001" in payload["meta"]["agentKeys"]


def test_export_pulse_graceful_skip_when_not_built(conn, capsys):
    # Clear the aggregate the fixture built → pulse should be skipped, not crash.
    conn.execute("DELETE FROM density_hourly")
    html = export.export_html(conn, STUB_VENDOR, vehicle_type="truck", sample_n=10,
                              include_pulse=True)
    import json
    payload = json.loads(re.search(
        r'id="payload"[^>]*>(.*?)</script>', html, re.S).group(1))
    assert payload["pulse"] is None
    assert "density_hourly aggregate not built" in capsys.readouterr().out


def test_export_size_gate(conn, monkeypatch):
    monkeypatch.setattr(export, "TOTAL_BUDGET_FAIL_MB", 0.0001)
    monkeypatch.setattr(export, "_FORCE", False)
    with pytest.raises(SystemExit):
        export.export_html(conn, STUB_VENDOR, vehicle_type="truck", sample_n=10)


def test_export_raises_on_empty(conn):
    with pytest.raises(ValueError):
        export.export_html(conn, STUB_VENDOR, vehicle_type="nonexistent", sample_n=10)
